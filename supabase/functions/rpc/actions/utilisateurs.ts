/**
 * ============================================================================
 *  Administration des UTILISATEURS + compte courant.
 *  Équivalents Audit.gs : _listerUtilisateurs_, _creerUtilisateur_,
 *  _majUtilisateur_, _basculerUtilisateur_, _reinitMotDePasse_, _changerMonMotDePasse_.
 *  L'authentification est déléguée à Supabase Auth (bcrypt + 2FA TOTP).
 *  Identifiants internes → e-mail technique <username>@agents.cargo-pia.local.
 *
 *  Durcissement du 2026-08-10 :
 *   · SEC-03 — politique de mot de passe (12 caractères, 3 familles) et
 *     changement IMPOSÉ à la première connexion après attribution ;
 *   · SEC-09 — cloisonnement entre ADMIN : un administrateur ne peut plus
 *     réinitialiser, désactiver ni reclasser un autre administrateur.
 * ============================================================================
 */
import { ErreurMetier, type Ctx } from '../ctx.ts';
import { createClient } from 'npm:@supabase/supabase-js@2';
import { ROLES, type Role } from '../../_shared/domaine/src/index.ts';

const DOMAINE_TECH = 'agents.cargo-pia.local';
const emailDe = (username: string) => `${username}@${DOMAINE_TECH}`;
const ROLES_VALIDES = Object.values(ROLES) as string[];

/* ------------------------- SEC-03 · mot de passe ------------------------- */

/** Longueur minimale. 6 auparavant — indéfendable pour des données douanières. */
export const MDP_LONGUEUR_MIN = 12;

/**
 * Mots de passe notoirement compromis sur cette installation : le provisoire
 * commun distribué à la migration et ses variantes évidentes. Les refuser
 * explicitement évite le « changement » qui n'en est pas un.
 */
const MDP_INTERDITS = [
  'cargopia2026', 'cargopia', 'cargotracker', 'motdepasse', 'password',
  'azerty123456', '123456789012', 'pia2026', 'douane2026',
];

/**
 * Vérifie la robustesse d'un mot de passe. Volontairement fondée sur la
 * LONGUEUR et la variété plutôt que sur une soupe de caractères obligatoires :
 * une phrase de passe longue est plus solide et plus facile à retenir pour un
 * agent de terrain qu'un « Xy7$ » impossible à taper sur un téléphone.
 */
export function verifierMotDePasse(pwd: string, username = ''): void {
  const p = String(pwd ?? '');
  if (p.length < MDP_LONGUEUR_MIN)
    throw new ErreurMetier(`Mot de passe : ${MDP_LONGUEUR_MIN} caractères minimum.`);
  if (p.length > 200) throw new ErreurMetier('Mot de passe : 200 caractères maximum.');

  const familles = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((r) => r.test(p)).length;
  if (familles < 3)
    throw new ErreurMetier(
      'Mot de passe : combinez au moins trois familles de caractères (minuscules, majuscules, chiffres, signes).',
    );

  const bas = p.toLowerCase();
  if (MDP_INTERDITS.some((m) => bas.includes(m)))
    throw new ErreurMetier('Ce mot de passe est trop courant ou déjà connu. Choisissez-en un autre.');
  if (username && bas.includes(String(username).toLowerCase()))
    throw new ErreurMetier('Le mot de passe ne doit pas contenir votre identifiant.');
  if (/^(.)\1+$/.test(p)) throw new ErreurMetier('Mot de passe trop simple.');
}

/* ------------------------ SEC-09 · cloisonnement ------------------------ */

/**
 * Un ADMIN peut réinitialiser le mot de passe et le 2FA de n'importe qui, puis
 * se connecter sous cette identité et poser une signature de validation, un T1
 * ou une balise. Tant que la cible est un agent de cellule, c'est le prix de
 * l'exploitation courante — et la réinitialisation est tracée, l'agent s'en
 * aperçoit à sa prochaine connexion.
 *
 * Entre ADMIN, en revanche, l'opération est refusée : elle permettrait à un
 * administrateur d'effacer discrètement le contrôle exercé par son pair. La
 * reprise en main d'un compte ADMIN passe par la console Supabase — un autre
 * chemin, d'autres droits, une autre trace (voir EXPLOITATION.md).
 */
function refuserSiAdmin(cible: { role?: unknown; username?: unknown }, operation: string): void {
  if (String(cible.role) === ROLES.ADMIN)
    throw new ErreurMetier(
      `${operation} impossible sur un compte ADMIN (« ${String(cible.username)} »). ` +
        'Cette opération relève de la console Supabase, avec double contrôle — voir EXPLOITATION.md.',
    );
}

/* --------------------------------- liste -------------------------------- */

export async function userList(ctx: Ctx) {
  const { data, error } = await ctx.db
    .from('profils')
    .select('username, nom_complet, role, actif, date_creation, derniere_connexion, doit_changer_mdp')
    .order('username');
  if (error) throw new Error(error.message);
  return (data ?? []).map((r) => ({
    username: r.username, nomComplet: r.nom_complet, role: r.role, actif: r.actif,
    dateCreation: r.date_creation ? new Date(r.date_creation).toISOString().slice(0, 10) : '',
    derniereConnexion: r.derniere_connexion ? new Date(r.derniere_connexion).toISOString().slice(0, 16).replace('T', ' ') : '',
    // Rend visible, dans l'écran d'administration, les comptes encore sur leur
    // mot de passe d'attribution — c'est exactement la population à risque.
    motDePasseAChanger: r.doit_changer_mdp === true,
  }));
}

/* -------------------------------- création ------------------------------ */

export async function userCreate(ctx: Ctx, p: Record<string, unknown>) {
  const username = String(p['username'] ?? '').toLowerCase().replace(/\s+/g, '');
  if (!/^[a-z0-9._-]{3,30}$/.test(username))
    throw new ErreurMetier('Identifiant invalide (3-30 caractères : lettres, chiffres, . _ -).');
  const { data: exist } = await ctx.db.from('profils').select('username').eq('username', username).maybeSingle();
  if (exist) throw new ErreurMetier('Cet identifiant existe déjà.');
  if (ROLES_VALIDES.indexOf(String(p['role'])) === -1) throw new ErreurMetier('Rôle invalide.');
  const pwd = String(p['password'] ?? '');
  verifierMotDePasse(pwd, username);
  const nom = String(p['nomComplet'] ?? '').trim() || username;

  const { data: u, error: eAuth } = await ctx.db.auth.admin.createUser({
    email: emailDe(username), password: pwd, email_confirm: true,
  });
  if (eAuth || !u?.user) throw new Error(eAuth?.message ?? 'Création du compte impossible.');
  const { error: eProf } = await ctx.db.from('profils').insert({
    id: u.user.id, username, nom_complet: nom, role: p['role'] as Role, actif: true,
    // SEC-03 : le mot de passe est choisi par l'administrateur, donc connu de
    // lui. Il n'engage l'agent qu'une fois remplacé par le sien.
    doit_changer_mdp: true,
  });
  if (eProf) {
    await ctx.db.auth.admin.deleteUser(u.user.id); // rollback si le profil échoue
    throw new Error(eProf.message);
  }
  await ctx.log('Création utilisateur', '', username + ' (' + p['role'] + ')');
  return { ok: true, motDePasseAChanger: true };
}

/* ------------------------------ modification ---------------------------- */

export async function userUpdate(ctx: Ctx, p: Record<string, unknown>) {
  const username = String(p['username'] ?? '');
  const { data: u, error } = await ctx.db.from('profils').select('id, username, role').eq('username', username).maybeSingle();
  if (error) throw new Error(error.message);
  if (!u) throw new ErreurMetier('Utilisateur introuvable.');

  const patch: Record<string, unknown> = {};
  if (p['nomComplet'] !== undefined) patch['nom_complet'] = String(p['nomComplet']).trim();

  if (p['role'] !== undefined && String(p['role']) !== String(u.role)) {
    if (ROLES_VALIDES.indexOf(String(p['role'])) === -1) throw new ErreurMetier('Rôle invalide.');
    // SEC-09 — on ne reclasse pas un pair administrateur, ni soi-même.
    refuserSiAdmin(u, 'Changement de rôle');
    if (u.id === ctx.session.userId) throw new ErreurMetier('Vous ne pouvez pas changer votre propre rôle.');
    // Promouvoir quelqu'un ADMIN reste possible, mais c'est un acte majeur :
    // il est tracé distinctement pour être repérable dans l'historique.
    if (String(p['role']) === ROLES.ADMIN)
      await ctx.log('⚠ PROMOTION ADMIN', '', `${u.username} : ${u.role} → ADMIN`);
    patch['role'] = p['role'];
  }

  if (Object.keys(patch).length) {
    const { error: eMaj } = await ctx.db.from('profils').update(patch).eq('id', u.id);
    if (eMaj) throw new Error(eMaj.message);
  }
  await ctx.log('Modification utilisateur', '', u.username);
  return { ok: true };
}

/* ------------------------- activation / blocage ------------------------- */

export async function userToggle(ctx: Ctx, p: Record<string, unknown>) {
  const username = String(p['username'] ?? '');
  const { data: u, error } = await ctx.db.from('profils').select('id, username, actif, role').eq('username', username).maybeSingle();
  if (error) throw new Error(error.message);
  if (!u) throw new ErreurMetier('Utilisateur introuvable.');
  if (u.username.toLowerCase() === ctx.session.username.toLowerCase())
    throw new ErreurMetier('Vous ne pouvez pas désactiver votre propre compte.');
  const nouveau = !u.actif;
  // SEC-09 — désactiver un pair administrateur reviendrait à évincer le contrôle
  // mutuel. Réactiver reste possible (c'est un retour à la normale, jamais une
  // prise de pouvoir).
  if (!nouveau) refuserSiAdmin(u, 'Désactivation');

  const { error: eMaj } = await ctx.db.from('profils').update({ actif: nouveau }).eq('id', u.id);
  if (eMaj) throw new Error(eMaj.message);
  // Un compte désactivé est aussi banni côté Auth (empêche toute connexion).
  await ctx.db.auth.admin.updateUserById(u.id, { ban_duration: nouveau ? 'none' : '876000h' });
  await ctx.log(nouveau ? 'Activation compte' : 'Désactivation compte', '', u.username);
  return { ok: true, actif: nouveau };
}

/* -------------------------- réinitialisations --------------------------- */

export async function userResetpwd(ctx: Ctx, p: Record<string, unknown>) {
  const username = String(p['username'] ?? '');
  const { data: u, error } = await ctx.db.from('profils').select('id, username, role').eq('username', username).maybeSingle();
  if (error) throw new Error(error.message);
  if (!u) throw new ErreurMetier('Utilisateur introuvable.');
  refuserSiAdmin(u, 'Réinitialisation du mot de passe'); // SEC-09
  const pwd = String(p['password'] ?? '');
  verifierMotDePasse(pwd, u.username);

  const { error: eAuth } = await ctx.db.auth.admin.updateUserById(u.id, { password: pwd });
  if (eAuth) throw new Error(eAuth.message);
  // SEC-03 — le mot de passe est connu de l'administrateur : il ne vaut que
  // jusqu'à la prochaine connexion de l'agent, qui devra le remplacer.
  const { error: eProf } = await ctx.db.from('profils').update({ doit_changer_mdp: true }).eq('id', u.id);
  if (eProf) throw new Error(eProf.message);
  await ctx.log('Réinitialisation mot de passe', '', u.username);
  return { ok: true, motDePasseAChanger: true };
}

/** v4 — Réinitialisation du 2FA d'un agent (retire ses facteurs TOTP → ré-enrôlement). */
export async function userResetmfa(ctx: Ctx, p: Record<string, unknown>) {
  const username = String(p['username'] ?? '');
  const { data: u, error } = await ctx.db.from('profils').select('id, username, role').eq('username', username).maybeSingle();
  if (error) throw new Error(error.message);
  if (!u) throw new ErreurMetier('Utilisateur introuvable.');
  refuserSiAdmin(u, 'Réinitialisation du 2FA'); // SEC-09
  const { data: facteurs } = await ctx.db.auth.admin.mfa.listFactors({ userId: u.id });
  for (const f of facteurs?.factors ?? []) {
    await ctx.db.auth.admin.mfa.deleteFactor({ id: f.id, userId: u.id });
  }
  await ctx.log('Réinitialisation 2FA', '', u.username);
  return { ok: true };
}

/* ----------------------------- compte courant --------------------------- */

export async function accountChangepwd(ctx: Ctx, p: Record<string, unknown>) {
  const ancien = String(p['ancien'] ?? '');
  const nouveau = String(p['nouveau'] ?? '');
  if (nouveau === ancien) throw new ErreurMetier('Le nouveau mot de passe doit être différent de l\'ancien.');
  verifierMotDePasse(nouveau, ctx.session.username);

  // Vérifie l'ancien mot de passe via une connexion isolée (client anon éphémère).
  const anon = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, { auth: { persistSession: false } });
  const { error: eLog } = await anon.auth.signInWithPassword({ email: emailDe(ctx.session.username), password: ancien });
  if (eLog) {
    // Une tentative ratée sur son propre mot de passe est un signal : elle peut
    // trahir une session volée dont le porteur ignore le mot de passe.
    await ctx.log('Échec changement mot de passe', '', 'ancien mot de passe incorrect');
    throw new ErreurMetier('Ancien mot de passe incorrect.');
  }

  const { error: eAuth } = await ctx.db.auth.admin.updateUserById(ctx.session.userId, { password: nouveau });
  if (eAuth) throw new Error(eAuth.message);
  const { error: eProf } = await ctx.db.from('profils').update({ doit_changer_mdp: false }).eq('id', ctx.session.userId);
  if (eProf) throw new Error(eProf.message);
  await ctx.log('Changement mot de passe', '', '');
  return { ok: true };
}

/**
 * SEC-05 — Trace de CONNEXION.
 *
 * La v3.6 journalisait les connexions (1 224 entrées dans l'historique repris) ;
 * la v4 avait perdu cette trace en déléguant l'authentification à Supabase Auth,
 * et `listerHistorique` filtrait même activement les lignes « connexion ». On ne
 * pouvait donc plus répondre à « qui s'est connecté cette nuit, depuis où ».
 *
 * Le client appelle cette action une fois, juste après l'ouverture de session.
 * L'IP est ajoutée par le journaliseur (voir supa.ts).
 */
export async function accountSignin(ctx: Ctx) {
  const agent = ctx.requete?.agent ? ' · ' + ctx.requete.agent : '';
  await ctx.log('Connexion', '', ctx.session.role + agent);
  return { ok: true };
}
