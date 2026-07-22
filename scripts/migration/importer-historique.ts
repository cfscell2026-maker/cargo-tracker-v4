/**
 * ============================================================================
 *  Import ponctuel du JOURNAL D'AUDIT historique (feuille « Historique » du
 *  Google Sheet) → table audit_log (Supabase).
 *
 *  ⚠ audit_log est APPEND-ONLY et INVIOLABLE (aucune suppression possible même
 *  en service_role : le trigger audit_no_update bloque). Donc :
 *    - garde-fou anti-doublon (refuse si l'historique est déjà présent),
 *    - insertion via la fonction SQL fn_import_audit (chaîne de hachage OK).
 *
 *  Utilisation :
 *    1) export.xlsx en place + .env (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
 *    2) npm run historique
 * ============================================================================
 */
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import * as XLSX from 'xlsx';

const argv = process.argv.slice(2);
const arg = (n: string, d = '') => argv.find((a) => a.startsWith(`--${n}=`))?.split('=')[1] ?? d;
const FICHIER = arg('fichier', 'export.xlsx');

const URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL || !KEY) {
  console.error('⛔  Renseignez SUPABASE_URL et SUPABASE_SERVICE_ROLE_KEY (fichier .env).');
  process.exit(1);
}
const db = createClient(URL, KEY, { auth: { persistSession: false } });

function toISO(v: unknown): string {
  if (v instanceof Date && !isNaN(v.getTime())) return v.toISOString();
  const d = new Date(String(v ?? ''));
  return isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

async function main() {
  console.log(`\n🧾  CARGO TRACKER — import de l'historique depuis « ${FICHIER} »`);
  const wb = XLSX.read(readFileSync(FICHIER), { cellDates: true });
  const sh = wb.Sheets['Historique'];
  if (!sh) {
    console.error("⛔  Feuille « Historique » absente de l'export.");
    process.exit(1);
  }
  const lignes = XLSX.utils.sheet_to_json<Record<string, unknown>>(sh, { defval: '', raw: true });
  console.log(`   ${lignes.length} lignes à importer.`);

  // Import INCRÉMENTAL (ré-exécutable) : les lignes importées ont user_id NULL
  // (l'appli, elle, renseigne toujours l'UUID). On repère la dernière déjà
  // importée et on n'ajoute QUE les entrées postérieures → aucun doublon, même
  // si l'ancien système continue de tourner et qu'on réimporte un export plus récent.
  const { data: borne } = await db
    .from('audit_log')
    .select('ts')
    .is('user_id', null)
    .order('ts', { ascending: false })
    .limit(1)
    .maybeSingle();
  const dernier = borne?.ts ? new Date(borne.ts).toISOString() : null;
  if (dernier) console.log(`   Historique déjà présent jusqu'à ${dernier} → ajout des entrées postérieures uniquement.`);

  // Connexions / déconnexions = bruit : jamais importées (elles resteraient
  // définitivement dans la table append-only et polluent le journal métier).
  const utiles = lignes.filter((l) => !/connexion/i.test(String(l['action'] ?? '')));
  console.log(`   ${lignes.length - utiles.length} connexion(s)/déconnexion(s) ignorée(s) → ${utiles.length} à importer.`);

  // Ordre chronologique (la feuille l'est déjà, on s'en assure), puis on ne
  // garde que les entrées postérieures à la dernière déjà importée.
  const rows = utiles
    .map((l) => ({
      ts: toISO(l['timestamp']),
      username: String(l['username'] ?? '').toLowerCase(),
      nom_complet: String(l['nomComplet'] ?? ''),
      role: String(l['role'] ?? ''),
      action: String(l['action'] ?? ''),
      cargaison_id: String(l['cargaisonId'] ?? ''),
      details: String(l['details'] ?? ''),
    }))
    .filter((r) => !dernier || r.ts > dernier)
    .sort((a, b) => a.ts.localeCompare(b.ts));

  if (!rows.length) {
    console.log('✅  Rien de nouveau à importer — l\'historique est déjà à jour.');
    return;
  }
  console.log(`   ${rows.length} nouvelle(s) entrée(s) à ajouter.`);

  // Envoi par paquets à la fonction SQL (boucle serveur = chaîne de hachage OK).
  const paquet = 1000;
  let total = 0;
  for (let i = 0; i < rows.length; i += paquet) {
    const bloc = rows.slice(i, i + paquet);
    const { data, error } = await db.rpc('fn_import_audit', { p_rows: bloc });
    if (error) {
      console.error(`\n⛔  Échec sur le paquet ${i}-${i + bloc.length} : ${error.message}`);
      console.error(`   ${total} ligne(s) importée(s) avant l'échec.`);
      process.exit(1);
    }
    total += Number(data ?? bloc.length);
    process.stdout.write(`\r   → ${total}/${rows.length} importées…`);
  }
  console.log(`\n✅  ${total} entrée(s) d'historique importée(s).`);

  // Vérifie l'intégrité de la chaîne de hachage.
  const { data: rupture, error: eV } = await db.rpc('fn_audit_verifier');
  if (eV) console.warn(`⚠  Vérification chaîne impossible : ${eV.message}`);
  else if (rupture) console.error(`❌  Rupture de chaîne détectée à l'id ${rupture} — À EXAMINER.`);
  else console.log('🔒  Chaîne de hachage vérifiée : intègre de bout en bout.');
}

main().catch((e) => {
  console.error('\n⛔  Import interrompu :', e.message);
  process.exit(1);
});
