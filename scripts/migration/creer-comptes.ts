/**
 * ============================================================================
 *  Migration des UTILISATEURS → Supabase Auth + table profils.
 *
 *  Les hachages SHA-256 de la v3.6 ne sont pas transposables : chaque agent
 *  reçoit un MOT DE PASSE PROVISOIRE (à changer + enrôler son 2FA à la 1ʳᵉ
 *  connexion). Les agents n'ayant pas d'e-mail, l'identifiant est converti en
 *  e-mail technique interne  <username>@agents.cargo-pia.local  (invisible pour eux).
 *
 *  Sortie : comptes-provisoires.csv  (identifiant ; nom ; rôle ; mot de passe)
 *  → à remettre en main propre à chaque agent, puis à DÉTRUIRE.
 *
 *  Utilisation :  npm run comptes   (lit la feuille « Utilisateurs » de export.xlsx)
 * ============================================================================
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import * as XLSX from 'xlsx';

const DOMAINE_TECH = 'agents.cargo-pia.local';
const FICHIER = process.argv.find((a) => a.startsWith('--fichier='))?.split('=')[1] ?? 'export.xlsx';

const URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL || !KEY) {
  console.error('⛔  Renseignez SUPABASE_URL et SUPABASE_SERVICE_ROLE_KEY (fichier .env).');
  process.exit(1);
}
const db = createClient(URL, KEY, { auth: { persistSession: false } });

const ROLES_VALIDES = ['CFS', 'CHEF_BRIGADE', 'CHEF_BRIGADE_ADJOINT', 'CHEF_VISITE', 'CHEF_DIVISION', 'T1', 'BALISE', 'BON_SORTIE', 'PP', 'ADMIN'];

/**
 * Mot de passe provisoire — SEC-03.
 *
 * ⚠ CORRECTIF DU 2026-08-10. Le défaut était un mot de passe FIXE, identique
 * pour tous les comptes (« CargoPia2026 »), sans changement imposé et avec la
 * 2FA désactivée. Comme les identifiants figurent en clair dans les rapports et
 * l'historique, il suffisait de connaître un nom d'agent pour entrer — y compris
 * sur un compte ADMIN. Toute la règle anti-fraude « 1 cellule = 1 rôle » repose
 * sur l'identité de l'agent : elle ne tenait donc sur rien.
 *
 * Le défaut est désormais ALÉATOIRE : chaque agent reçoit un mot de passe unique
 * de 16 caractères, remis en main propre, qu'il doit remplacer à sa première
 * connexion (`profils.doit_changer_mdp`, posé par ce script et imposé par
 * l'Edge Function).
 *
 * MOT_DE_PASSE_PROVISOIRE peut encore forcer une valeur commune (recette,
 * démonstration) — le script le signale alors bruyamment.
 */
const MDP_CONFIG = process.env.MOT_DE_PASSE_PROVISOIRE ?? 'ALEATOIRE';
const MDP_COMMUN = MDP_CONFIG.toUpperCase() !== 'ALEATOIRE';
function motDePasseProvisoire(): string {
  if (!MDP_COMMUN) {
    // 16 caractères sans I/l/1/O/0 : dictable au téléphone, illisible à deviner.
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789#@%+=?';
    const b = randomBytes(16);
    return Array.from(b, (x) => chars[x % chars.length]).join('');
  }
  return MDP_CONFIG;
}

async function main() {
  const wb = XLSX.read(readFileSync(FICHIER), { cellDates: true });
  const sh = wb.Sheets['Utilisateurs'];
  if (!sh) {
    console.error('⛔  Feuille « Utilisateurs » absente de l\'export.');
    process.exit(1);
  }
  const lignes = XLSX.utils.sheet_to_json<Record<string, unknown>>(sh, { defval: '', raw: true });
  const csv: string[] = ['identifiant;nom_complet;role;mot_de_passe_provisoire'];
  let crees = 0;
  let existants = 0;
  const rejets: string[] = [];

  for (const l of lignes) {
    const username = String(l['username'] ?? '').toLowerCase().trim();
    if (!username) continue;
    let role = String(l['role'] ?? '').trim();
    if (role === 'PORTE_CFS') role = 'CFS'; // migration de rôle v2.8
    if (!ROLES_VALIDES.includes(role)) {
      rejets.push(`${username} : rôle invalide « ${role} »`);
      continue;
    }
    // Ré-exécutable : un compte déjà présent est laissé INTACT (ni recréé, ni
    // réinitialisé). Seuls les nouveaux agents de l'export sont créés.
    const { data: deja } = await db.from('profils').select('username').eq('username', username).maybeSingle();
    if (deja) { existants++; continue; }
    const actif = l['actif'] === true || String(l['actif']).toUpperCase() === 'TRUE';
    const nom = String(l['nomComplet'] ?? l['nom_complet'] ?? username).trim() || username;
    const email = `${username}@${DOMAINE_TECH}`;
    const pwd = motDePasseProvisoire();

    // 1) Compte Auth (e-mail technique confirmé d'office, pas d'envoi de mail).
    const { data: u, error: eAuth } = await db.auth.admin.createUser({
      email,
      password: pwd,
      email_confirm: true,
      ban_duration: actif ? 'none' : '876000h', // compte désactivé = banni (~100 ans)
    });
    if (eAuth || !u?.user) {
      rejets.push(`${username} : ${eAuth?.message ?? 'création Auth impossible'}`);
      continue;
    }
    // 2) Profil métier lié.
    const { error: eProf } = await db.from('profils').upsert(
      // SEC-03 : `doit_changer_mdp` — le mot de passe créé ici est connu de
      // l'opérateur de la migration ; il n'engage l'agent qu'une fois remplacé.
      { id: u.user.id, username, nom_complet: nom, role, actif, doit_changer_mdp: true },
      { onConflict: 'id' },
    );
    if (eProf) {
      rejets.push(`${username} : profil — ${eProf.message}`);
      continue;
    }
    csv.push(`${username};${nom};${role};${pwd}`);
    crees++;
  }

  writeFileSync('comptes-provisoires.csv', csv.join('\n'), 'utf8');
  console.log(`✅  ${crees} compte(s) créé(s)${existants ? `, ${existants} déjà existant(s) laissé(s) intact(s)` : ''}. Mots de passe provisoires (nouveaux) → comptes-provisoires.csv`);
  if (MDP_COMMUN) {
    console.log('\n⛔  ATTENTION — MOT DE PASSE COMMUN À TOUS LES COMPTES.');
    console.log('   Les identifiants des agents figurent en clair dans les rapports et');
    console.log('   l\'historique : ce mode rend chaque compte accessible à quiconque connaît');
    console.log('   un nom d\'agent. À NE JAMAIS UTILISER EN PRODUCTION (recette uniquement).');
    console.log('   Retirez MOT_DE_PASSE_PROVISOIRE pour revenir à des mots de passe uniques.\n');
  }
  console.log('   ⚠  À remettre en main propre à chaque agent, puis DÉTRUIRE ce fichier.');
  console.log('   Chaque agent DEVRA changer son mot de passe à la 1ʳᵉ connexion (imposé par');
  console.log('   le serveur) et enrôler son 2FA.');
  if (rejets.length) {
    console.log(`\n⚠  ${rejets.length} rejet(s) :`);
    rejets.forEach((r) => console.log('   · ' + r));
  }
}

main().catch((e) => {
  console.error('⛔  Interrompu :', e.message);
  process.exit(1);
});
