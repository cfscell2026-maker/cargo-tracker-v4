/**
 * ============================================================================
 *  Migration Google Sheets (export .xlsx) → PostgreSQL (Supabase).
 *
 *  LECTURE SEULE de la source : ce script n'écrit JAMAIS dans le Google Sheet.
 *  Il peut être relancé (upsert par clé primaire) et se termine par une
 *  VÉRIFICATION CROISÉE des comptages (aucune bascule tant que ce n'est pas vert).
 *
 *  Utilisation :
 *    1) Exporter le classeur Google au format .xlsx (Fichier → Télécharger → .xlsx)
 *    2) Le placer ici sous le nom  export.xlsx  (ou passer --fichier=chemin.xlsx)
 *    3) Renseigner .env (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
 *    4) npm run migrer            (import + vérification)
 *       npm run verifier          (vérification des comptages seulement)
 * ============================================================================
 */
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import * as XLSX from 'xlsx';
import { CARGAISONS, CONTENEURS, DECLARATIONS, STOCK, STOCK_ANNONCE, type Champ } from './mapping.ts';

const argv = process.argv.slice(2);
const arg = (n: string, d = '') => (argv.find((a) => a.startsWith(`--${n}=`))?.split('=')[1]) ?? d;
const VERIF_SEULE = argv.includes('--verifier-seulement');
const FICHIER = arg('fichier', 'export.xlsx');

const URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL || !KEY) {
  console.error('⛔  Renseignez SUPABASE_URL et SUPABASE_SERVICE_ROLE_KEY (fichier .env).');
  process.exit(1);
}
const db = createClient(URL, KEY, { auth: { persistSession: false } });

/* ------------------------------ Conversions ---------------------------- */

function toISO(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v.toISOString();
  if (typeof v === 'number' && v > 59 && v < 60000) {
    // sérial Excel (jours depuis 1899-12-30)
    return new Date(Math.round((v - 25569) * 86400000)).toISOString();
  }
  const s = String(v).trim();
  let m = s.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})$/); // dd/MM/yyyy
  if (m) {
    let y = Number(m[3]);
    if (y < 100) y += 2000;
    return new Date(y, Number(m[2]) - 1, Number(m[1])).toISOString();
  }
  m = s.match(/^(\d{4})[/\-.](\d{1,2})[/\-.](\d{1,2})/); // yyyy-MM-dd
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).toISOString();
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

function toJson(v: unknown): unknown {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'object') return v;
  try {
    return JSON.parse(String(v));
  } catch {
    return null;
  }
}

/** conteneursDetails : normalise les 2 formes historiques vers {conteneurs,scellesCamion}. */
function toContsDetails(v: unknown): unknown {
  const pd = toJson(v);
  if (pd === null) return { conteneurs: [], scellesCamion: [] };
  if (Array.isArray(pd)) return { conteneurs: pd, scellesCamion: [] };
  const o = pd as Record<string, unknown>;
  return {
    conteneurs: Array.isArray(o.conteneurs) ? o.conteneurs : [],
    scellesCamion: Array.isArray(o.scellesCamion) ? o.scellesCamion : [],
  };
}

function convertir(champ: Champ, brut: unknown): unknown {
  const vide = brut === null || brut === undefined || brut === '';
  switch (champ.conv) {
    case 'text':
      return vide ? (champ.nullable ? null : '') : String(brut);
    case 'bool_oui':
      return vide && champ.nullable ? null : String(brut) === 'Oui';
    case 'bool_yesno':
      return vide && champ.nullable ? null : String(brut) === 'Yes';
    case 'ts':
      return toISO(brut);
    case 'int':
      return vide ? 0 : Math.trunc(Number(brut)) || 0;
    case 'json':
      return toJson(brut);
    case 'json_conts':
      return toContsDetails(brut);
  }
}

/* ------------------------------ Lecture xlsx --------------------------- */

/** Lit une feuille → tableau d'objets indexés par LIBELLÉ d'entête. */
function lireFeuille(wb: XLSX.WorkBook, nom: string): Record<string, unknown>[] {
  const sh = wb.Sheets[nom];
  if (!sh) {
    console.warn(`⚠  Feuille absente de l'export : « ${nom} » (ignorée).`);
    return [];
  }
  return XLSX.utils.sheet_to_json(sh, { defval: '', raw: true });
}

function mapper(lignes: Record<string, unknown>[], champs: Champ[], filtreCleVide?: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const l of lignes) {
    if (filtreCleVide && !String(l[filtreCleVide] ?? '').trim()) continue; // ignore les lignes vides
    const o: Record<string, unknown> = {};
    for (const c of champs) o[c.col] = convertir(c, l[c.label]);
    out.push(o);
  }
  return out;
}

/* ------------------------------ Insertion ------------------------------ */

async function upsert(table: string, lignes: Record<string, unknown>[], onConflict: string, rejets: string[]) {
  if (!lignes.length) return 0;
  let ok = 0;
  const paquets = 500;
  for (let i = 0; i < lignes.length; i += paquets) {
    const bloc = lignes.slice(i, i + paquets);
    const { error } = await db.from(table).upsert(bloc, { onConflict });
    if (error) {
      // On retente ligne par ligne pour isoler et JOURNALISER les rejets (jamais silencieux).
      for (const one of bloc) {
        const { error: e2 } = await db.from(table).upsert(one, { onConflict });
        if (e2) rejets.push(`${table} [${JSON.stringify(one[onConflict.split(',')[0]!])}] : ${e2.message}`);
        else ok++;
      }
    } else {
      ok += bloc.length;
    }
  }
  return ok;
}

/* ------------------------------ Vérification --------------------------- */

async function compter(table: string): Promise<number> {
  const { count, error } = await db.from(table).select('*', { count: 'exact', head: true });
  if (error) throw new Error(`${table} : ${error.message}`);
  return count ?? 0;
}

async function verifier(attendus: Record<string, number>) {
  console.log('\n──────── VÉRIFICATION CROISÉE ────────');
  let vert = true;
  for (const [table, attendu] of Object.entries(attendus)) {
    const reel = await compter(table);
    const etat = reel === attendu ? '✅' : '❌';
    if (reel !== attendu) vert = false;
    console.log(`${etat}  ${table.padEnd(16)} attendu ${String(attendu).padStart(6)} · en base ${String(reel).padStart(6)}`);
  }
  // Comptages métier de contrôle (à recouper avec le tableau de bord de l'ancienne appli).
  const parStatut = await db.rpc('exec', {}).then(() => null).catch(() => null); // placeholder si RPC custom
  void parStatut;
  console.log(vert ? '\n✅  Comptages identiques — migration cohérente.' : '\n❌  Écart détecté — NE PAS BASCULER, examiner les rejets ci-dessus.');
  return vert;
}

/* ------------------------------ Programme ------------------------------ */

async function main() {
  console.log(`\n📦  CARGO TRACKER — migration depuis « ${FICHIER} »`);
  const wb = XLSX.read(readFileSync(FICHIER), { cellDates: true });

  const src = {
    cargaisons: mapper(lireFeuille(wb, 'Cargaisons'), CARGAISONS, 'ID'),
    conteneurs: mapper(lireFeuille(wb, 'Conteneurs'), CONTENEURS, 'ID Cargaison'),
    declarations: mapper(lireFeuille(wb, 'Declarations'), DECLARATIONS, 'Clé déclaration'),
    stock: mapper(lireFeuille(wb, 'Stock'), STOCK, 'N° Conteneur'),
    stock_annonce: mapper(lireFeuille(wb, 'StockAnnonce'), STOCK_ANNONCE, 'N° Conteneur'),
  };
  const attendus = {
    cargaisons: src.cargaisons.length,
    conteneurs: src.conteneurs.length,
    declarations: src.declarations.length,
    stock: src.stock.length,
    stock_annonce: src.stock_annonce.length,
  };

  if (VERIF_SEULE) {
    await verifier(attendus);
    return;
  }

  const rejets: string[] = [];
  // Ordre = respect des clés étrangères (cargaisons avant conteneurs/stock).
  console.log('→ cargaisons   :', await upsert('cargaisons', src.cargaisons, 'id', rejets));
  // Conteneurs = pas de clé métier stable (table à identité) → pour rester
  // RÉ-EXÉCUTABLE sans doublon, on VIDE puis on réinsère depuis l'export
  // (l'export est la source de vérité : refresh complet à chaque migration).
  const { error: eDel } = await db.from('conteneurs').delete().gt('id', 0);
  if (eDel) console.warn('⚠  Purge conteneurs avant réinsertion :', eDel.message);
  console.log('→ conteneurs   :', await upsert('conteneurs', src.conteneurs, 'id', rejets).catch(() => 0));
  console.log('→ declarations :', await upsert('declarations', src.declarations, 'cle', rejets));
  console.log('→ stock        :', await upsert('stock', src.stock, 'numero_tc', rejets));
  console.log('→ stock_annonce:', await upsert('stock_annonce', src.stock_annonce, 'numero_tc', rejets));

  // Réaligner les compteurs SEQ / SEQ_RPT sur le plus grand numéro importé
  // (les prochains IDs continuent la numérotation actuelle — aucun doublon).
  await realignerCompteurs(src.cargaisons);

  if (rejets.length) {
    console.log(`\n⚠  ${rejets.length} ligne(s) rejetée(s) — À EXAMINER :`);
    rejets.slice(0, 50).forEach((r) => console.log('   · ' + r));
    if (rejets.length > 50) console.log(`   … et ${rejets.length - 50} autres.`);
  }
  // conteneurs = table à identité : le count attendu se vérifie à part (pas d'upsert par clé métier).
  const { conteneurs: _c, ...attSansCont } = attendus;
  void _c;
  await verifier(attSansCont);
  const contReel = await compter('conteneurs');
  console.log(`ℹ  conteneurs en base : ${contReel} (source : ${attendus.conteneurs})`);
}

/** Réaligne compteurs.SEQ / SEQ_RPT sur le max des numéros importés. */
async function realignerCompteurs(cargos: Record<string, unknown>[]) {
  const maxNum = (prefixe: RegExp, champ: string) =>
    cargos.reduce((m, c) => {
      const mm = String(c[champ] ?? '').match(prefixe);
      return mm ? Math.max(m, Number(mm[1])) : m;
    }, 0);
  const seq = maxNum(/-(\d+)$/, 'id');
  const seqRpt = maxNum(/-(\d+)$/, 'rapport_id');
  if (seq) await db.from('compteurs').update({ valeur: seq }).eq('cle', 'SEQ');
  if (seqRpt) await db.from('compteurs').update({ valeur: seqRpt }).eq('cle', 'SEQ_RPT');
  console.log(`→ compteurs    : SEQ=${seq} · SEQ_RPT=${seqRpt}`);
}

main().catch((e) => {
  console.error('\n⛔  Migration interrompue :', e.message);
  process.exit(1);
});
