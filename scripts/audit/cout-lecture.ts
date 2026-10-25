/**
 * AUDIT DU COÛT DE LECTURE DE CHAQUE ACTION (2026-10-25)
 *
 * Mesure, HORS PRODUCTION, ce que chaque action de lecture du serveur demande à
 * la base : nombre de requêtes, lignes et octets rapatriés, temps de calcul du
 * serveur. Sur une base de test de la taille réelle (22 000 dossiers, 17 000
 * conteneurs au parc, 60 000 lignes de journal…), avec le vrai code des actions.
 *
 * Pourquoi hors production : le 25/10, deux parcours de tous les écrans en
 * production ont contribué à saturer une base déjà trop petite. On ne recommence
 * pas : on mesure ici, on corrige, on remesure.
 *
 * Lancement (depuis la racine du dépôt) :
 *   TZ=UTC node --experimental-strip-types scripts/audit/cout-lecture.ts [filtre]
 */
import { readFileSync } from 'node:fs';
import { FakeDB } from '../../supabase/functions/rpc/actions/fake-db.ts';
import * as lecture from '../../supabase/functions/rpc/actions/lecture.ts';
import * as ecr from '../../supabase/functions/rpc/actions/ecriture.ts';
import * as stk from '../../supabase/functions/rpc/actions/stock.ts';
import * as spe from '../../supabase/functions/rpc/actions/speciaux.ts';
import * as rap from '../../supabase/functions/rpc/actions/rapports.ts';
import * as entrepot from '../../supabase/functions/rpc/actions/entrepots.ts';
import * as prm from '../../supabase/functions/rpc/actions/parametres.ts';
import * as prk from '../../supabase/functions/rpc/actions/parking.ts';
import * as acp from '../../supabase/functions/rpc/actions/rapprochement.ts';
import * as vrr from '../../supabase/functions/rpc/actions/verrou.ts';

type Row = Record<string, unknown>;
const filtre = process.argv[2] ?? '';

/* --------------------------- jeu de données ---------------------------- */
function alea(graine: number) { let x = graine; return () => (x = (x * 1103515245 + 12345) % 2147483648) / 2147483648; }
const r = alea(2026);
const pick = <T,>(a: T[]) => a[Math.floor(r() * a.length)]!;
const jour = (debut: number, etendue: number) => new Date(Date.UTC(2025, 9, 25) + (debut + r() * etendue) * 86400000).toISOString();
// Réaliste : ~1,5 % de dossiers encore présents (319 non sortis mesurés en production, 30/09).
const ACTIFS = ['Créée', 'T1 Saisi', 'GPS Posé', 'Camion créé', 'En cours de chargement'];
const statutAuHasard = () => (r() < 0.015 ? pick(ACTIFS) : 'Sortie Enregistrée');

const N = Number(process.env['N_CARGAISONS'] ?? 22000);
const db = new FakeDB();
(db as unknown as { vueStats: boolean }).vueStats = true; // les vues 00208 existent en production
const cargaisons = db.store['cargaisons'];
const conteneurs = db.store['conteneurs'];
for (let i = 0; i < N; i++) {
  const id = 'CT-' + String(i).padStart(6, '0');
  const creation = jour(0, 365);
  const statut = statutAuHasard();
  const apres = (j: number) => new Date(Date.parse(creation) + j * 86400000).toISOString();
  const sorti = statut === 'Sortie Enregistrée';
  const nb = 1 + Math.floor(r() * 2);
  const conts = Array.from({ length: nb }, (_, k) => ({
    num: 'MSKU' + String((i * 2 + k) % 9999999).padStart(7, '0'), taille: pick(["20'", "40'", "40' HC", '45']), type: pick(['DRY', 'HC', 'RF']),
    plomb: 'PL' + i + k, poids: String(10000 + Math.floor(r() * 20000)), champsLibres: 'BL=BL' + i + ' ; NAVIRE=MSC ' + (i % 50),
    numeroDeclaration: String(10000 + (i % 9000)), anneeDeclaration: '2026', bureauDeclaration: 'TG120', typeDeclaration: pick(['T', 'C', 'S']),
    declarant: 'SOCIETE DE TRANSIT ' + (i % 300), descriptionMarchandise: pick(['CONGELATEUR VERTICAL', 'VEHICULES USAGES', 'RIZ BLANC 25KG', 'CIMENT CPJ 42.5', 'EFFETS PERSONNELS']),
  }));
  const c: Row = {
    id, reference: id, rapport_id: 'RPT-' + (i >> 1), numero_camion: 'TG' + (1000 + (i % 8999)) + 'AB/' + (2000 + i % 7000) + 'BF',
    numero_camion_norm: 'TG' + (1000 + (i % 8999)) + 'AB' + (2000 + i % 7000) + 'BF', type_operation: pick(['Enlèvement', 'Enlèvement', 'Dépotage', 'Sortie Magasin / MAD', 'Conso (type C)', 'Dépotage / Véhicule']),
    twins: r() < 0.2, declarant: 'SOCIETE DE TRANSIT ' + (i % 300), contact_declarant: '90000000', destination_marchandise: pick(['OUAGADOUGOU', 'NIAMEY', 'KARA', 'TG', 'BAMAKO']),
    bureau_declaration: 'TG120', type_declaration: pick(['T', 'C', 'S', 'A']), numero_declaration: String(10000 + (i % 9000)), annee_declaration: '2026',
    description_marchandise: conts[0]!.descriptionMarchandise, observations_cfs: 'RAS', agent_cfs: 'Agent CFS ' + (i % 12), statut,
    numero_gps: r() < 0.7 ? 'GPS' + i : '', date_pose_gps: r() < 0.8 ? apres(r() * 4) : null, agent_balise: 'Agent Balise',
    balise_requise: pick([null, true, false]), numero_dispense: r() < 0.1 ? 'DISP-' + i : '', date_sortie: sorti ? apres(1 + r() * 8) : null,
    agent_pp: sorti ? 'Agent PP' : '', pp_checklist: { cfs: true, t1: true, balise: true, bs: true }, derniere_maj: creation,
    conteneurs_details: { conteneurs: conts, scellesCamion: ['S' + i, 'S' + (i + 1)] }, nb_conteneurs: nb, chargement_mixte: r() < 0.05,
    mixte_details: r() < 0.05 ? [{ note: 'complément', date: creation }] : null, est_vehicule: r() < 0.06,
    vehicule_details: r() < 0.06 ? { chassis: 'VIN' + i, marque: 'TOYOTA', modele: 'COROLLA', couleur: 'BLANC', destination: 'BURKINA' } : null,
    conteneur_origine: '', bureau_destination: 'BF OUAGA', t1_numeros: conts.map((ct) => ({ conteneur: ct.num, numero: 'T1-' + i })),
    date_t1: r() < 0.8 ? apres(r() * 3) : null, agent_t1: 'Agent T1', bon_sortie_numero: 'BS-' + i, date_bon_sortie: r() < 0.8 ? apres(r() * 4) : null,
    saute_t1: r() < 0.2, saute_balise: r() < 0.2, saute_bs: false, arrivee_bureau: r() < 0.1, date_validation: r() < 0.9 ? apres(r() * 2) : null,
    agent_validation: 'Chef', signature_validation: 'abc' + i, en_surcharge: pick([null, false, true]), hors_gabarit: pick([null, true]),
    annule: r() < 0.01, archive: r() < 0.05, date_creation: creation, date_fin_chargement: apres(r()), suivi_engagement: r() < 0.05,
    engagement_type: 'BFE 03 Sinkase', engagement_delai: '2026-11-01', type_exemption: pick([null, 'dispense', 'escorte']),
  };
  cargaisons.push(c);
  conts.forEach((ct, k) => conteneurs.push({ id: i * 3 + k, rapport_id: c['rapport_id'], cargaison_id: id, numero_camion: c['numero_camion'],
    type_operation: c['type_operation'], ordre: k + 1, conteneur: ct.num, scelle: ct.plomb, taille: ct.taille, type_conteneur: ct.type }));
}
for (let i = 0; i < 17000; i++) db.store['stock'].push({ numero_tc: 'TCLU' + String(i).padStart(7, '0'), taille: pick(["20'", "40'"]), type_conteneur: 'DRY',
  provenance: 'PAL', date_entree: jour(0, 365), date_positionne: null, date_pointage: r() < 0.5 ? jour(0, 365) : null, pointe_par: 'agent', date_depote: r() < 0.5 ? jour(0, 365) : null,
  cargaison_id: null, annee_declaration: '2026', type_declaration: 'T', numero_declaration: 'D ' + i,
  // Ordre de grandeur réel : quelques centaines de positionnés pour des milliers en stock et dépotés.
  statut: r() < 0.02 ? 'Positionné' : pick(['En stock', 'Dépoté']), observations: r() < 0.2 ? 'Entrée magasin 2D, conteneur ouvert pour visite' : '', nb_sejours_import: 0 });
for (let i = 0; i < 3000; i++) db.store['stock_annonce'].push({ numero_tc: 'ANNU' + String(i).padStart(7, '0'), taille: "20'", statut: pick(['Annoncé', 'Pointé', 'Confirmé']), date_annonce: jour(0, 365) });
db.store['audit_log'] = Array.from({ length: 60000 }, (_, i) => ({ id: i + 1, ts: jour(0, 365), username: 'agent' + (i % 30), nom_complet: 'Agent ' + (i % 30),
  role: 'CFS', action: pick(['Validation chef brigade', 'Entrée camion (vide)', 'T1', 'Sortie PP']), cargaison_id: 'CT-' + String(i % N).padStart(6, '0'), details: 'détail ' + i, prev_hash: 'x', hash: 'y' }));
db.store['profils'] = Array.from({ length: 34 }, (_, i) => ({ id: 'u' + i, username: 'agent' + i, nom_complet: 'Agent ' + i, role: 'CFS', actif: true }));
db.store['parking_camions'] = Array.from({ length: 2600 }, (_, i) => ({ id: 'PK-' + i, numero_camion: 'TG' + i, numero_camion_norm: 'TG' + i, statut: r() < 0.2 ? 'Présent' : 'Sorti', date_entree: jour(0, 365) }));
db.store['parking_pointages'] = Array.from({ length: 30000 }, (_, i) => ({ id: 'PP-' + i, parking_id: 'PK-' + (i % 2600), jour: jour(0, 365).slice(0, 10), pointe_par: 'A' }));
db.store['declarations'] = Array.from({ length: 9000 }, (_, i) => ({ cle: '2026|TG120|T|' + (10000 + i), annee_declaration: '2026', bureau_declaration: 'TG120', type_declaration: 'T',
  numero_declaration: String(10000 + i), declarant: 'SOCIETE', nombre_conteneurs: 3, conteneurs_apures: 1 }));
db.store['entrepots'] = [{ code: '2D', nom: 'Entrepôt 2D', type: 'MAD' }, { code: 'IND1', nom: 'Industriel', type: 'INDUSTRIEL' }];
db.store['entrepot_entrees'] = Array.from({ length: 1500 }, (_, i) => ({ id: 'ENT-' + i, entrepot_code: i % 2 ? '2D' : 'IND1', numero_declaration: String(i), articles: [{ designation: 'ARTICLE', nbColis: 100, poids: 1000 }] }));
db.store['entrepot_sorties'] = Array.from({ length: 4000 }, (_, i) => ({ id: 'SOR-' + i, entrepot_code: i % 2 ? '2D' : 'IND1', entree_id: 'ENT-' + (i % 1500), numero_article: 1, nb_colis: 5, poids: 50 }));

/* ------------------------------ mesure ---------------------------------- */
let requetes = 0, lignes = 0, octets = 0;
const parTable: Record<string, { requetes: number; lignes: number; octets: number }> = {};
const origine = db.from.bind(db);
(db as unknown as { from: (t: string) => unknown }).from = (t: string) => {
  const q = origine(t) as unknown as { then?: (f: (v: { data: unknown }) => unknown, g?: unknown) => unknown };
  if (typeof q.then !== 'function') return q;
  const suite = q.then.bind(q);
  q.then = (f, g) => suite((v) => {
    const d = v?.data;
    const n = Array.isArray(d) ? d.length : d ? 1 : 0;
    const o = d ? JSON.stringify(d).length : 0;
    requetes++; lignes += n; octets += o;
    const k = (parTable[t] ??= { requetes: 0, lignes: 0, octets: 0 }); k.requetes++; k.lignes += n; k.octets += o;
    return f(v);
  }, g);
  return q;
};
const origineRpc = db.rpc.bind(db);
let appelsSql = 0;
(db as unknown as { rpc: (n: string, a: Row) => unknown }).rpc = (n: string, a: Row) => { if (n.startsWith('fn_rapport')) appelsSql++; return origineRpc(n, a); };

const ctx = { db, session: { userId: 'u0', username: 'admin', nomComplet: 'Admin', role: 'ADMIN' }, log: async () => {} } as never;
const MOIS = { du: '2026-10-01', au: '2026-10-31' };
const AN = { du: '2026-01-01', au: '2026-12-31' };

/* Les actions de LECTURE, avec les paramètres que leur envoie l'écran. */
const ACTIONS: [string, () => Promise<unknown>][] = [
  ['account.me (session)', async () => vrr.etatVerrou(ctx)],
  ['dashboard.stats', () => lecture.dashboardStats(ctx, MOIS)],
  ['dashboard.fiche', () => rap.ficheBord(ctx, MOIS)],
  ['cargo.list (Cargaisons)', () => lecture.cargoList(ctx, { categorie: 'camion' })],
  ['cargo.list (Recherche en cours)', () => lecture.cargoList(ctx, { categorie: 'tous', actifs: true, pageSize: 100 })],
  ['cargo.list (recherche texte)', () => lecture.cargoList(ctx, { categorie: 'tous', actifs: true, search: 'TG1234', pageSize: 100 })],
  ['cargo.list (file À valider)', () => lecture.cargoList(ctx, { etape: 'VALIDATION', categorie: 'tous' })],
  ['cargo.list (file T1)', () => lecture.cargoList(ctx, { etape: 'T1', categorie: 'tous' })],
  ['cargo.search', () => lecture.cargoSearch(ctx, { valeur: 'TG1234' })],
  ['cargo.checkdup', () => lecture.cargoCheckdup(ctx, { numeroCamion: 'TG1234AB/2000BF', conteneurs: ['MSKU0000001'] })],
  ['cargo.get', () => lecture.cargoGet(ctx, { id: 'CT-000123' })],
  ['vehicule.list', () => lecture.vehiculeList(ctx, {} as never)],
  ['etatcfs.list', () => lecture.etatCfsList(ctx)],
  ['report.engagements (échéancier)', () => lecture.engagementsDus(ctx)],
  ['report.engagements (volet)', () => lecture.engagementsDus(ctx, { filtre: 'tous' })],
  ['report.engagementsperiode', () => rap.rapportEngagementsPeriode(ctx, MOIS)],
  ['report.amendes', () => rap.rapportAmendes(ctx, MOIS)],
  ['report.validationdecl', () => rap.validationParDeclaration(ctx, { numeroDeclaration: '10123', anneeDeclaration: '2026', bureauDeclaration: 'TG120', typeDeclaration: 'T' })],
  ['report.cfs', () => rap.rapportCFS(ctx, MOIS)],
  ['report.vehicule', () => rap.rapportVehicules(ctx, MOIS)],
  ['report.balise', () => rap.rapportActivite(ctx, { ...MOIS, kind: 'balise' })],
  ['report.pp', () => rap.rapportActivite(ctx, { ...MOIS, kind: 'pp' })],
  ['report.t1', () => rap.rapportActivite(ctx, { ...MOIS, kind: 't1' })],
  ['report.bonsortie', () => rap.rapportActivite(ctx, { ...MOIS, kind: 'bonsortie' })],
  ['report.kpi', () => rap.rapportKPI(ctx, {})],
  ['report.dispenses', () => rap.rapportDispenses(ctx, {})],
  ['report.flux (année)', () => rap.rapportFlux(ctx, { ...AN, granularite: 'mois' })],
  ['report.destinations (année)', () => rap.rapportDestinations(ctx, { ...AN, granularite: 'mois' })],
  ['report.controles', () => rap.rapportControles(ctx, MOIS)],
  ['report.temps', () => rap.rapportTemps(ctx, MOIS)],
  ['report.horodatage', () => rap.rapportHorodatage(ctx, MOIS)],
  ['report.goulots', () => rap.rapportGoulots(ctx, {})],
  ['report.archives', () => rap.rapportArchives(ctx, {})],
  ['report.dwell (Délai & instance)', () => rap.rapportSejour(ctx, {})],
  ['report.stock (Séjour conteneurs)', () => stk.rapportStock(ctx, {} as never)],
  ['stock.list', () => stk.stockList(ctx, {} as never)],
  ['stock.list (saisie, positionnés)', () => stk.stockList(ctx, { statut: 'Positionné', lignesSeules: true })],
  ['stockannonce.list', () => stk.annonceList(ctx, {} as never)],
  ['report.extraction', () => rap.rapportExtraction(ctx, { niveau: 'camions', ...MOIS })],
  ['entrepot.list', () => entrepot.entrepotList(ctx, {} as never)],
  ['entrepot.entrees', () => entrepot.entrepotEntrees(ctx, { entrepotCode: '2D' })],
  ['entrepot.stats', () => entrepot.entrepotStats(ctx, { type: 'MAD' } as never)],
  ['parking.list', () => prk.parkingList(ctx, { statut: 'presents' })],
  ['params.get', () => prm.paramsGet(ctx)],
  ['log.list (Historique)', () => rap.listerHistorique(ctx, {})],
  ['acp.historique', () => acp.rapprochementHistorique(ctx, {} as never)],
];

const lignesRes: string[] = [];
const ko = (n: number) => (n / 1024).toFixed(0).padStart(7);
for (const [nom, f] of ACTIONS) {
  if (filtre && !nom.includes(filtre)) continue;
  requetes = 0; lignes = 0; octets = 0; appelsSql = 0;
  for (const k of Object.keys(parTable)) delete parTable[k];
  const t = performance.now();
  let erreur = '';
  try { await f(); } catch (e) { erreur = (e as Error).message.slice(0, 60); }
  const ms = performance.now() - t;
  const tables = Object.entries(parTable).sort((a, b) => b[1].octets - a[1].octets).slice(0, 2)
    .map(([t2, v]) => `${t2}:${v.lignes}`).join(' ');
  lignesRes.push(`${nom.padEnd(34)} ${String(requetes).padStart(4)} req ${String(lignes).padStart(7)} lignes ${ko(octets)} Ko ${ms.toFixed(0).padStart(6)} ms${appelsSql ? ' [SQL]' : ''}  ${tables}${erreur ? '  ⚠ ' + erreur : ''}`);
  console.log(lignesRes.at(-1));
}
void readFileSync; void ecr; void spe;
