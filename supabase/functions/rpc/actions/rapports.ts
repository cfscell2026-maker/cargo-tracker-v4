/**
 * ============================================================================
 *  RAPPORTS — transcription fidèle de Reports.gs (v3.6).
 *  Chaque rapport renvoie des AGRÉGATS (format 'view') identiques à l'ancien,
 *  avec cartes cliquables → détail. Exports XLSX via SheetJS (base64) ; le bon
 *  de chargement + les PDF sont renvoyés en HTML (impression → PDF côté client).
 * ============================================================================
 */
import type { Ctx } from '../ctx.ts';
import { versCamel } from '../ctx.ts';
// ⚠ xlsx (SheetJS) est importé PARESSEUSEMENT dans xlsxBase64 : son chargement
// au niveau module fait planter le démarrage de l'Edge Function (Deno) →
// BOOT_ERROR / 503 sur toutes les requêtes. Chargé seulement lors d'un export.
import {
  ROLES, STATUTS, OPERATIONS, DEFAUTS, DESTINATION_CODES, codeDestination, TRANCHES_SEJOUR, SEUIL_ALERTE_SEJOUR,
  tailleBucket, evpDeTaille, trancheAge, parseConteneursDetails, estOui, aFait, normAlphaNum,
  groupesDeclaration, estChargementMixte, libelleDeclaration,
  etapesEnAttente, etatCellules, estDispenseBalise,
  // v4.2 — temps de passage par poste
  delaisDe, agreger, dureeLisible, enHeures, POSTES, LIBELLE_POSTE,
} from '../../_shared/domaine/src/index.ts';
import { fetchAll, lookupDeclaration } from './helpers.ts';
import { filtrerConfidentiel } from './lecture.ts';

/* ------------------------------- Helpers ------------------------------- */

/**
 * RGPD-01 — Le N° de balise n'est servi qu'aux profils qui le voient déjà sur la
 * fiche (cf. `filtrerConfidentiel`). Sans ce garde-fou, le filtrage de
 * `cargo.get` serait contourné par un export Excel ouvert à tous les rôles.
 */
const ROLES_VOIENT_BALISE: string[] = [
  ROLES.BALISE, ROLES.PP, ROLES.CFS, ROLES.CHEF_BRIGADE, ROLES.CHEF_BRIGADE_ADJOINT,
  ROLES.CHEF_VISITE, ROLES.CHEF_DIVISION, ROLES.ADMIN,
];
const voitBalise = (ctx: Ctx) => ROLES_VOIENT_BALISE.indexOf(ctx.session.role) >= 0;

async function loadCargos(ctx: Ctx): Promise<Record<string, unknown>[]> {
  // fetchAll : pagine (5000+ cargaisons migrées) sinon les rapports sous-comptent.
  const data = await fetchAll(ctx, 'cargaisons', '*');
  // SEC-12 — une cargaison annulée (doublon écarté) reste en base pour l'audit
  // mais ne doit compter dans AUCUN rapport, sinon elle fausse tous les totaux.
  return data.filter((r) => r['annule'] !== true).map((r) => versCamel(r));
}
const lc = (v: unknown) => String(v ?? '').toLowerCase();
const inRange = (v: unknown, du?: string, au?: string): boolean => {
  if (!v) return false;
  const d = new Date(String(v));
  if (isNaN(d.getTime())) return false;
  if (du && d < new Date(du + 'T00:00:00')) return false;
  if (au && d >= new Date(new Date(au + 'T00:00:00').getTime() + 86400000)) return false;
  return true;
};
function detsDeRow(c: Record<string, unknown>) {
  return parseConteneursDetails(c['conteneursDetails']).conteneurs;
}
/**
 * v4.1 — Filtre agent d'un rapport de cellule (décision utilisateur 2026-07-27).
 * PLUS de restriction « chaque agent ne voit que la sienne » : les agents d'une
 * cellule travaillent à plusieurs et doivent voir le rapport COMPLET de leur
 * cellule, sans passer par le compte admin. On applique donc seulement le filtre
 * EXPLICITEMENT demandé (`pAgent`, envoyé par l'écran admin) ; vide = toute la
 * cellule. `cfgRole` n'est plus utilisé mais conservé pour la signature.
 */
function agentForce(_ctx: Ctx, _cfgRole: Role, pAgent: unknown): string {
  return lc(pAgent);
}

/** Excel (base64) à partir de feuilles {nom, aoa:[[...]]}.
 *  Import DYNAMIQUE de xlsx (voir note en tête de fichier) : chargé ici, à la
 *  demande, pour ne pas casser le démarrage de l'Edge Function. */
async function xlsxBase64(feuilles: { nom: string; aoa: unknown[][] }[]): Promise<string> {
  // deno-lint-ignore no-explicit-any
  const mod: any = await import('npm:xlsx@0.18.5');
  // deno-lint-ignore no-explicit-any
  const XLSX: any = mod.default ?? mod;
  const wb = XLSX.utils.book_new();
  for (const f of feuilles) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(f.aoa), f.nom.slice(0, 31));
  const b64 = XLSX.write(wb, { type: 'base64', bookType: 'xlsx' });
  return b64 as string;
}
async function fichier(nomBase: string, format: string, feuilles: { nom: string; aoa: unknown[][] }[]) {
  return { filename: `${nomBase}.xlsx`, mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', base64: await xlsxBase64(feuilles), format };
}
const libTaille: Record<string, string> = { t20: "20'", t40: "40'", t45: "45'", autres: 'Autre / non précisé' };

/** Date courte fr pour les exports (vide si absente/illisible). */
const fmtJ = (v: unknown) => { if (!v) return ''; const d = new Date(String(v)); return isNaN(d.getTime()) ? String(v) : d.toLocaleDateString('fr-FR'); };

/**
 * v4.1 — Tableau IMPRIMABLE (PDF côté client via imprimerHtml). Trame sobre A4
 * paysage ; le client ouvre le HTML et lance l'impression → PDF.
 */
function htmlTableau(titre: string, sousTitre: string, entetes: string[], lignes: unknown[][]): { html: string } {
  const esc = (v: unknown) => String(v ?? '').replace(/[&<>]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[ch] ?? ch));
  const th = entetes.map((h) => `<th>${esc(h)}</th>`).join('');
  const tr = lignes.map((l) => `<tr>${l.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('');
  const html = `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>${esc(titre)}</title>` +
    `<style>@page{size:A4 landscape;margin:14mm}body{font-family:Georgia,'Liberation Serif',serif;color:#111;font-size:11pt}` +
    `h1{font-size:15pt;margin:0 0 2mm}.sub{color:#444;font-size:10pt;margin:0 0 4mm}` +
    `table{border-collapse:collapse;width:100%}th,td{border:1px solid #999;padding:3px 6px;text-align:left}` +
    `th{background:#f0f0f0}tr{page-break-inside:avoid}thead{display:table-header-group}</style></head><body>` +
    `<h1>${esc(titre)}</h1><div class="sub">${esc(sousTitre)} — ${lignes.length} ligne(s)</div>` +
    `<table><thead><tr>${th}</tr></thead><tbody>${tr}</tbody></table></body></html>`;
  return { html };
}

/* ============================== CFS ==================================== */

interface AggCFS { camions: number; t20: number; t40: number; t45: number; autres: number; evp: number; conteneurs: number }
function aggVide(): AggCFS { return { camions: 0, t20: 0, t40: 0, t45: 0, autres: 0, evp: 0, conteneurs: 0 }; }

function collecteCFS(cargos: Record<string, unknown>[], du?: string, au?: string, agentLc?: string) {
  const parOp: Record<string, AggCFS> = { [OPERATIONS.ENLEVEMENT]: aggVide(), [OPERATIONS.DEPOTAGE]: aggVide() };
  const total = aggVide();
  const camions: Record<string, unknown>[] = [];
  const conteneurs: Record<string, unknown>[] = [];
  // Conteneurs PARTAGÉS (saisie manuelle sur plusieurs camions) : comptés UNE
  // fois par n° (décision client 2026-07-30). Les N° normaux étant uniques, seuls
  // les partagés se regroupent — camions comptés normalement, conteneurs dédupés.
  const vus = new Set<string>();
  for (const c of cargos) {
    if (estOui(c['estVehicule'])) continue;
    if (!inRange(c['dateCreation'], du, au)) continue;
    if (agentLc && lc(c['agentCfs']) !== agentLc) continue;
    const op = String(c['typeOperation']);
    if (op !== OPERATIONS.ENLEVEMENT && op !== OPERATIONS.DEPOTAGE) continue;
    const a = parOp[op]!;
    const dets = detsDeRow(c);
    a.camions++; total.camions++;
    camions.push({ id: c['id'], numeroCamion: c['numeroCamion'], typeOperation: op, statut: c['statut'], dateCreation: c['dateCreation'], nbConteneurs: dets.length, agentCfs: c['agentCfs'] });
    for (const ct of dets) {
      if (ct.num && vus.has(ct.num)) continue; // conteneur partagé : déjà compté
      if (ct.num) vus.add(ct.num);
      const bk = tailleBucket(ct.taille); const ev = evpDeTaille(bk);
      (a as Record<string, number>)[bk]++; a.conteneurs++; a.evp += ev;
      (total as Record<string, number>)[bk]++; total.conteneurs++; total.evp += ev;
      conteneurs.push({ id: c['id'], cargaisonId: c['id'], numeroCamion: c['numeroCamion'], typeOperation: op, conteneur: ct.num, taille: ct.taille, type: ct.type, scelle: ct.plomb, bucket: bk, dateCreation: c['dateCreation'] });
    }
  }
  return { parOp, total, camions, conteneurs };
}

export async function rapportCFS(ctx: Ctx, p: Record<string, unknown>) {
  const agentLc = agentForce(ctx, ROLES.CFS, p['agentCFS']);
  const r = collecteCFS(await loadCargos(ctx), p['du'] as string, p['au'] as string, agentLc || undefined);
  const data = { periode: p['periode'], du: p['du'], au: p['au'], parOp: r.parOp, total: r.total };
  if (p['format'] === 'xlsx' || p['format'] === 'pdf') {
    const recap: unknown[][] = [['Opération', 'Camions', "20'", "40'", "45'", 'Autres', 'Conteneurs', 'EVP']];
    for (const op of [OPERATIONS.ENLEVEMENT, OPERATIONS.DEPOTAGE]) {
      const a = r.parOp[op]!; recap.push([op, a.camions, a.t20, a.t40, a.t45, a.autres, a.conteneurs, a.evp]);
    }
    recap.push(['TOTAL', r.total.camions, r.total.t20, r.total.t40, r.total.t45, r.total.autres, r.total.conteneurs, r.total.evp]);
    const det: unknown[][] = [['ID', 'Camion', 'Opération', 'Conteneur', 'Taille']];
    r.conteneurs.forEach((x) => det.push([x['id'], x['numeroCamion'], x['typeOperation'], x['conteneur'], x['taille']]));
    return fichier('Rapport_CFS', String(p['format']), [{ nom: 'Récapitulatif', aoa: recap }, { nom: 'Détails conteneurs', aoa: det }]);
  }
  return data;
}

export async function rapportCFSDetail(ctx: Ctx, p: Record<string, unknown>) {
  const agentLc = agentForce(ctx, ROLES.CFS, p['agentCFS']);
  const r = collecteCFS(await loadCargos(ctx), p['du'] as string, p['au'] as string, agentLc || undefined);
  const op = String(p['operation'] ?? '');
  const metric = String(p['metric'] ?? 'camions');
  const filtreOp = (x: Record<string, unknown>) => !op || x['typeOperation'] === op;
  if (metric === 'camions') return { titre: 'Camions', rows: r.camions.filter(filtreOp) };
  const conts = r.conteneurs.filter(filtreOp).filter((x) => ['t20', 't40', 't45', 'autres'].indexOf(metric) < 0 || x['bucket'] === metric);
  return { titre: metric in libTaille ? libTaille[metric] : 'Conteneurs', rows: conts };
}

/* ============================== Véhicules ============================== */

const VEH_BUCKETS = ['Transit', 'Conso', 'MAD', 'Véhicule abandonné'];
function destBucket(d: unknown) { const s = String(d ?? ''); return VEH_BUCKETS.indexOf(s) >= 0 ? s : 'Autres'; }

/**
 * v4.2 — correctif 2026-08-19 (demande utilisateur). Un véhicule est compté à LA
 * DATE DE SON PASSAGE, pas à sa seule date de création : un véhicule SORTI dans
 * la période mais entré avant compte bien dans « Sortis » de la période. On
 * retient donc un véhicule dès qu'il a un événement dans la période — entrée
 * (dateCreation) OU sortie (dateSortie) — et on le classe par cet événement :
 *   · SORTIS  = sortie effective dans la période ;
 *   · ATTENTE = entré dans la période et pas (encore) sorti dans la période.
 * L'ancienne version filtrait tout sur la date de création : une sortie du jour
 * pour un véhicule entré la veille n'apparaissait jamais.
 */
function collecteVehicules(cargos: Record<string, unknown>[], du?: string, au?: string, agentLc?: string) {
  const compte = { total: 0, attente: 0, sortis: 0, conteneurs: 0 } as Record<string, number>;
  const parDest: Record<string, number> = {}; [...VEH_BUCKETS, 'Autres'].forEach((d) => (parDest[d] = 0));
  const vehicules: Record<string, unknown>[] = [];
  for (const c of cargos) {
    if (!estOui(c['estVehicule'])) continue;
    if (agentLc && lc(c['agentCfs']) !== agentLc) continue;
    const sortiEnPeriode = c['statut'] === STATUTS.SORTIE && inRange(c['dateSortie'], du, au);
    const entreEnPeriode = inRange(c['dateCreation'], du, au);
    if (!sortiEnPeriode && !entreEnPeriode) continue; // aucun événement dans la période
    compte.total++;
    if (sortiEnPeriode) compte.sortis++; else compte.attente++;
    const vd = (c['vehiculeDetails'] ?? {}) as Record<string, unknown>;
    parDest[destBucket(vd['destination'])]++;
    if (Number(c['nbConteneurs'] || 0) > 0) compte.conteneurs++;
    vehicules.push({ id: c['id'], chassis: c['numeroCamion'], destination: vd['destination'], statut: c['statut'], dateCreation: c['dateCreation'], dateSortie: c['dateSortie'] });
  }
  return { compte, parDest, vehicules };
}

export async function rapportVehicules(ctx: Ctx, p: Record<string, unknown>) {
  const agentLc = agentForce(ctx, ROLES.CFS, p['agentCFS']);
  const r = collecteVehicules(await loadCargos(ctx), p['du'] as string, p['au'] as string, agentLc || undefined);
  if (p['format'] === 'xlsx' || p['format'] === 'pdf') {
    const aoa: unknown[][] = [['ID', 'Châssis', 'Destination', 'Statut', 'Créé le']];
    r.vehicules.forEach((v) => aoa.push([v['id'], v['chassis'], v['destination'], v['statut'], v['dateCreation']]));
    return fichier('Rapport_vehicules', String(p['format']), [{ nom: 'Véhicules', aoa }]);
  }
  return { periode: p['periode'], du: p['du'], au: p['au'], compte: r.compte, parDest: r.parDest };
}

export async function rapportVehiculesDetail(ctx: Ctx, p: Record<string, unknown>) {
  const agentLc = agentForce(ctx, ROLES.CFS, p['agentCFS']);
  const r = collecteVehicules(await loadCargos(ctx), p['du'] as string, p['au'] as string, agentLc || undefined);
  const bucket = String(p['bucket'] ?? 'total');
  let rows = r.vehicules;
  if (bucket === 'attente') rows = rows.filter((v) => v['statut'] !== STATUTS.SORTIE);
  else if (bucket === 'sortis') rows = rows.filter((v) => v['statut'] === STATUTS.SORTIE);
  else if (VEH_BUCKETS.indexOf(bucket) >= 0 || bucket === 'Autres') rows = rows.filter((v) => destBucket(v['destination']) === bucket);
  return { titre: bucket, rows };
}

/* ========================= Activité Balise / PP ======================= */

function cfgActivite(kind: string) {
  return kind === 'pp'
    ? { dateCol: 'dateSortie', agentCol: 'agentPp', role: ROLES.PP }
    : { dateCol: 'datePoseGps', agentCol: 'agentBalise', role: ROLES.BALISE };
}
function collecteActivite(cargos: Record<string, unknown>[], dateCol: string, agentCol: string, du?: string, au?: string, agentLc?: string) {
  const parOp: Record<string, AggCFS & { twins: number; sansBalise: number }> = {
    [OPERATIONS.ENLEVEMENT]: { ...aggVide(), twins: 0, sansBalise: 0 },
    [OPERATIONS.DEPOTAGE]: { ...aggVide(), twins: 0, sansBalise: 0 },
  };
  const total = { ...aggVide(), twins: 0, sansBalise: 0 };
  const camions: Record<string, unknown>[] = [];
  const conteneurs: Record<string, unknown>[] = [];
  for (const c of cargos) {
    if (estOui(c['estVehicule'])) continue;
    if (!inRange(c[dateCol], du, au)) continue; // ne compte QUE les balisés/sortis
    if (agentLc && lc(c[agentCol]) !== agentLc) continue;
    const op = String(c['typeOperation']);
    if (op !== OPERATIONS.ENLEVEMENT && op !== OPERATIONS.DEPOTAGE) continue;
    const a = parOp[op]!;
    const dets = detsDeRow(c);
    a.camions++; total.camions++;
    if (estOui(c['twins']) || c['twins'] === 'Yes') { a.twins++; total.twins++; }
    if (String(c['baliseRequise']) === 'Non' || c['baliseRequise'] === false) { a.sansBalise++; total.sansBalise++; }
    camions.push({ id: c['id'], numeroCamion: c['numeroCamion'], typeOperation: op, statut: c['statut'], date: c[dateCol], numeroGps: c['numeroGps'], nbConteneurs: dets.length, twins: c['twins'] });
    for (const ct of dets) {
      const bk = tailleBucket(ct.taille); const ev = evpDeTaille(bk);
      (a as Record<string, number>)[bk]++; a.conteneurs++; a.evp += ev;
      (total as Record<string, number>)[bk]++; total.conteneurs++; total.evp += ev;
      conteneurs.push({ id: c['id'], cargaisonId: c['id'], numeroCamion: c['numeroCamion'], typeOperation: op, conteneur: ct.num, taille: ct.taille, type: ct.type, scelle: ct.plomb, bucket: bk, numeroGps: c['numeroGps'], date: c[dateCol] });
    }
  }
  return { parOp, total, camions, conteneurs };
}

export async function rapportActivite(ctx: Ctx, p: Record<string, unknown>) {
  const cfg = cfgActivite(String(p['kind']));
  const agentLc = agentForce(ctx, cfg.role, p['agent']);
  const r = collecteActivite(await loadCargos(ctx), cfg.dateCol, cfg.agentCol, p['du'] as string, p['au'] as string, agentLc || undefined);
  if (p['format'] === 'xlsx' || p['format'] === 'pdf') {
    // v4.1 — détail par taille ajouté à l'export (comme le rapport CFS).
    const recap: unknown[][] = [['Opération', 'Camions', 'Twins', 'Sans balise', "20'", "40'", "45'", 'Autres', 'Conteneurs', 'EVP']];
    for (const op of [OPERATIONS.ENLEVEMENT, OPERATIONS.DEPOTAGE]) {
      const a = r.parOp[op]!; recap.push([op, a.camions, a.twins, a.sansBalise, a.t20, a.t40, a.t45, a.autres, a.conteneurs, a.evp]);
    }
    const t = r.total;
    recap.push(['TOTAL', t.camions, t.twins, t.sansBalise, t.t20, t.t40, t.t45, t.autres, t.conteneurs, t.evp]);
    return fichier('Rapport_' + p['kind'], String(p['format']), [{ nom: 'Récapitulatif', aoa: recap }]);
  }
  return { kind: p['kind'], periode: p['periode'], du: p['du'], au: p['au'], parOp: r.parOp, total: r.total };
}

export async function rapportActiviteDetail(ctx: Ctx, p: Record<string, unknown>) {
  const cfg = cfgActivite(String(p['kind']));
  const agentLc = agentForce(ctx, cfg.role, p['agent']);
  const r = collecteActivite(await loadCargos(ctx), cfg.dateCol, cfg.agentCol, p['du'] as string, p['au'] as string, agentLc || undefined);
  const op = String(p['operation'] ?? '');
  const metric = String(p['metric'] ?? 'camions');
  const filtreOp = (x: Record<string, unknown>) => !op || x['typeOperation'] === op;
  // Camions / TWINS → liste de CAMIONS (twins : seulement les jumelés).
  if (metric === 'camions' || metric === 'twins') {
    let rows = r.camions.filter(filtreOp);
    if (metric === 'twins') rows = rows.filter((x) => estOui(x['twins']) || x['twins'] === 'Yes');
    return { kind: 'camions', titre: metric === 'twins' ? 'TWINS' : 'Camions', rows };
  }
  const conts = r.conteneurs.filter(filtreOp).filter((x) => ['t20', 't40', 't45', 'autres'].indexOf(metric) < 0 || x['bucket'] === metric);
  return { kind: 'conteneurs', titre: metric in libTaille ? libTaille[metric] : 'Conteneurs', rows: conts };
}

/* ==================== Fiche « tableau de bord » ======================== */
/**
 * v4.1 — FICHE DE SYNTHÈSE reprenant, bloc par bloc, la fiche papier du chef
 * (« TABLEAU DE BORD — SEMAINE EN COURS ») : CFS, T1, BALISE, BON DE SORTIE,
 * PP. Elle se replie sous le tableau de bord de l'appli (décision utilisateur
 * 2026-07-22), de sorte que le chef retrouve EXACTEMENT sa mise en page.
 *
 * Chaque bloc est compté à LA DATE DE SA PROPRE CELLULE — le CFS à la création
 * du camion, le T1 à la saisie du T1, la Balise à la pose, le bon de sortie à
 * son émission, la PP à la sortie. Compter tout à la date de création ferait
 * mentir la fiche dès qu'un camion chevauche deux semaines.
 *
 * Deux compteurs ne dépendent PAS de la période, parce qu'ils décrivent une
 * situation instantanée et non un flux :
 *   - « Camions au parking » : ce qui est encore là, maintenant ;
 *   - rien d'autre.
 */
interface Tailles { t20: number; t40: number; t45: number; autres: number; conteneurs: number; evp: number }
const taillesVides = (): Tailles => ({ t20: 0, t40: 0, t45: 0, autres: 0, conteneurs: 0, evp: 0 });
function ajouterTaille(t: Tailles, taille: unknown) {
  const bk = tailleBucket(taille);
  (t as unknown as Record<string, number>)[bk]++;
  t.conteneurs++; t.evp += evpDeTaille(bk);
}
const taux = (fait: number, total: number) => (total ? Math.round((fait / total) * 1000) / 10 : 0);

export async function ficheBord(ctx: Ctx, p: Record<string, unknown>) {
  const du = p['du'] as string | undefined;
  const au = p['au'] as string | undefined;
  const cargos = await loadCargos(ctx);

  const cfs = {
    enlevement: taillesVides(), depotage: taillesVides(), mad: taillesVides(), total: taillesVides(),
    camionsEnlevement: 0, camionsDepotage: 0, camionsCfs: 0, camionsConso: 0, camionsMad: 0,
  };
  const t1 = { emis: 0, emisApures: 0, emisNonApures: 0, tauxEmis: 0, arrives: 0, arrivesApures: 0, arrivesNonApures: 0, tauxArrives: 0 };
  const balise = { total: 0, camions: 0, mad: 0, parking: 0, dispenses: 0, camionsCfs: 0, ecart: 0 };
  const bs = { total: 0 };
  const pp = {
    total: 0, enlevement: 0, depotage: 0, mad: 0, conso: 0, vehicules: 0, transferts: 0,
    empotages: null as number | null, // non suivi par l'application (voir plus bas)
    tailles: taillesVides(),
  };

  // Bureau « local » : un T1 dont la destination est notre propre bureau est un
  // T1 REÇU (arrivée), pas un T1 émis vers l'extérieur.
  const bureauLocal = normAlphaNum(DEFAUTS.BUREAU_DECLARATION);

  // Conteneurs PARTAGÉS (saisie manuelle, dispatchés sur plusieurs camions) :
  // comptés UNE SEULE fois par n° (décision client 2026-07-30). Les conteneurs
  // normaux ayant des N° uniques, seuls les partagés se regroupent.
  const vusCfs = new Set<string>();
  const vusPp = new Set<string>();

  for (const c of cargos) {
    const op = String(c['typeOperation'] ?? '');
    const veh = estOui(c['estVehicule']);
    const conts = detsDeRow(c);
    // CONSO = déclaration de TYPE C (mise à la consommation), quel que soit le
    // type d'opération (correctif 2026-07-22). Un enlèvement ou un dépotage sous
    // déclaration C EST une conso — c'est le type C qui décide, pas l'opération.
    // On garde l'opération dédiée « Conso (type C) » comme second déclencheur.
    const estConso = String(c['typeDeclaration'] ?? '').toUpperCase() === 'C' || op === OPERATIONS.CONSO;

    /* --- CFS : à la date de création du camion --- */
    if (!veh && inRange(c['dateCreation'], du, au)) {
      const cible = op === OPERATIONS.ENLEVEMENT ? cfs.enlevement
        : op === OPERATIONS.DEPOTAGE ? cfs.depotage
          : op === OPERATIONS.MAGASIN ? cfs.mad : null;
      if (op === OPERATIONS.ENLEVEMENT) { cfs.camionsEnlevement++; cfs.camionsCfs++; }
      else if (op === OPERATIONS.DEPOTAGE) { cfs.camionsDepotage++; cfs.camionsCfs++; }
      else if (op === OPERATIONS.MAGASIN) cfs.camionsMad++;
      if (estConso) cfs.camionsConso++; // cross-cut : compté au type C, en plus du bucket d'opération
      for (const ct of conts) {
        if (ct.num && vusCfs.has(ct.num)) continue; // conteneur partagé : compté une seule fois
        if (ct.num) vusCfs.add(ct.num);
        if (cible) ajouterTaille(cible, ct.taille);
        ajouterTaille(cfs.total, ct.taille);
      }
    }

    /* --- T1 : à la date de saisie du T1 --- */
    if (inRange(c['dateT1'], du, au)) {
      const recu = normAlphaNum(c['bureauDestination']) === bureauLocal;
      const apure = estOui(c['arriveeBureau']);
      if (recu) { t1.arrives++; if (apure) t1.arrivesApures++; }
      else { t1.emis++; if (apure) t1.emisApures++; }
    }

    /* --- BALISE : à la date de pose de la balise --- */
    if (inRange(c['datePoseGps'], du, au)) {
      balise.total++;
      if (op === OPERATIONS.ENLEVEMENT || op === OPERATIONS.DEPOTAGE) balise.camions++;
      if (op === OPERATIONS.MAGASIN) balise.mad++;
    }
    // Dispense = décision prise à la Balise avec numéro d'autorisation (v4.1).
    // On NE compte PAS les type C/A/E qui sautent la balise par nature. Rattachée
    // à la date d'entrée (une dispense n'a pas de date de pose de balise).
    if (inRange(c['dateCreation'], du, au) && estDispenseBalise(c as never)) balise.dispenses++;
    // Parking = camions RÉELLEMENT EN ATTENTE DE BALISE (correctif 2026-07-22).
    // L'ancienne règle « ni sorti, ni balisé » gonflait le chiffre : elle
    // comptait AUSSI les véhicules (qui ne prennent pas de balise), les dispenses
    // et conso non balisées (jamais de balise à prendre), les camions encore en
    // chargement au CFS, et toute la base migrée restée à un statut intermédiaire.
    // « En attente de balise » = l'étape BALISE figure dans les étapes restantes,
    // ce qui exclut d'office véhicules / dispensés / balisés / sortis / pré-CFS.
    if (etapesEnAttente(c as never).indexOf('BALISE') >= 0) balise.parking++;

    /* --- BON DE SORTIE : à la date d'émission --- */
    if (inRange(c['dateBonSortie'], du, au) && aFait(c['bonSortieNumero'])) bs.total++;

    /* --- PP : à la date de sortie --- */
    if (inRange(c['dateSortie'], du, au)) {
      if (veh) {
        pp.vehicules++; // véhicules à nu : suivis à part, HORS du total des sorties PP
      } else {
        // Buckets MUTUELLEMENT EXCLUSIFS, conso prioritaire (décision client
        // 2026-07-30) : une sortie de type C est une CONSO, pas un enlèvement /
        // dépotage. Le total PP = somme de ces quatre (calculée après la boucle).
        if (estConso) pp.conso++;
        else if (op === OPERATIONS.ENLEVEMENT) pp.enlevement++;
        else if (op === OPERATIONS.DEPOTAGE) pp.depotage++;
        else if (op === OPERATIONS.MAGASIN) pp.mad++;
        for (const ct of conts) {
          if (ct.num && vusPp.has(ct.num)) continue; // conteneur partagé : compté une fois
          if (ct.num) vusPp.add(ct.num);
          ajouterTaille(pp.tailles, ct.taille);
        }
      }
    }
  }

  // --- CONTENEURS MAD : la VRAIE source (correctif 2026-07-22) ---
  // « Conteneurs MAD » ne vient PAS des cargaisons de type « Sortie Magasin /
  // MAD » (celles-ci sont du VRAC, 0 conteneur → la case restait à 0). Elle
  // vient de l'écran « Entrée Magasin / MAD » (stock.entreemagasin), qui marque
  // un conteneur du parc comme dépoté vers le magasin. On les compte au stock,
  // à leur date de dépotage, reconnus à l'observation posée par cet écran.
  const stock = await fetchAll(ctx, 'stock', 'taille, statut, date_depote, observations');
  for (const s of stock) {
    if (!String(s['observations'] ?? '').toLowerCase().includes('magasin')) continue;
    if (!inRange(s['date_depote'], du, au)) continue;
    ajouterTaille(cfs.mad, s['taille']);
    ajouterTaille(cfs.total, s['taille']); // le total CFS inclut le MAD (comme la fiche papier)
  }

  t1.emisNonApures = t1.emis - t1.emisApures;
  t1.tauxEmis = taux(t1.emisApures, t1.emis);
  t1.arrivesNonApures = t1.arrives - t1.arrivesApures;
  t1.tauxArrives = taux(t1.arrivesApures, t1.arrives);
  balise.camionsCfs = cfs.camionsCfs;
  balise.ecart = cfs.camionsCfs - balise.camions;
  // Total sorties PP = somme des quatre flux (enlèvement + dépotage + MAD +
  // conso), véhicules à nu EXCLUS (décision client 2026-07-30).
  pp.total = pp.enlevement + pp.depotage + pp.mad + pp.conso;

  // TRANSFERTS = conteneurs annoncés par le Port Autonome et CONFIRMÉS entrés
  // au port sec sur la période (c'est le transfert qui s'achève).
  const annonces = await fetchAll(ctx, 'stock_annonce', 'date_confirmation, statut');
  for (const a of annonces) if (inRange(a['date_confirmation'], du, au)) pp.transferts++;

  return { du, au, cfs, t1, balise, bs, pp };
}

/* ================================ KPI ================================= */

export async function rapportKPI(ctx: Ctx, p: Record<string, unknown>) {
  const cargos = await loadCargos(ctx);
  const kpi = { videsDepotage: 0, sortisScelles: 0, camionsActifs: 0, camionsSortis: 0, evpVides: 0, evpSortis: 0, evpStock: 0, stock: { t20: 0, t40: 0, t45: 0, autres: 0 } };
  for (const c of cargos) {
    if (estOui(c['estVehicule'])) continue;
    if (!inRange(c['dateCreation'], p['du'] as string, p['au'] as string)) continue;
    const sorti = c['statut'] === STATUTS.SORTIE;
    if (sorti) kpi.camionsSortis++; else kpi.camionsActifs++;
    const op = c['typeOperation'];
    for (const ct of detsDeRow(c)) {
      const bk = tailleBucket(ct.taille); const ev = evpDeTaille(bk);
      if (op === OPERATIONS.DEPOTAGE) { kpi.videsDepotage++; kpi.evpVides += ev; }
      if (op === OPERATIONS.ENLEVEMENT && sorti) { kpi.sortisScelles++; kpi.evpSortis += ev; }
    }
  }
  const stock = await fetchAll(ctx, 'stock', 'taille, statut');
  for (const s of stock) {
    if (s.statut === 'Dépoté') continue;
    const bk = tailleBucket(s.taille); (kpi.stock as Record<string, number>)[bk]++; kpi.evpStock += evpDeTaille(bk);
  }
  return kpi;
}

/* ===================== Contrôles (hors gabarit / surcharge / transit) === */
/**
 * v4.1 — Statistiques de contrôle (décision utilisateur 2026-07-27) : nombre de
 * CAMIONS et de CONTENEURS hors gabarit, en surcharge, et en transit national
 * (destination TG), sur la période (date de création). Chiffres croisés avec
 * le détail par taille pour rester cohérents avec les autres rapports.
 */
export async function rapportControles(ctx: Ctx, p: Record<string, unknown>) {
  const du = p['du'] as string | undefined;
  const au = p['au'] as string | undefined;
  const cargos = await loadCargos(ctx);
  const vide = () => ({ camions: 0, conteneurs: 0 });
  const r = { horsGabarit: vide(), surcharge: vide(), transitNational: vide() };
  for (const c of cargos) {
    if (estOui(c['estVehicule'])) continue;
    if (!inRange(c['dateCreation'], du, au)) continue;
    const nbC = detsDeRow(c).length;
    if (estOui(c['horsGabarit']) || c['horsGabarit'] === true) { r.horsGabarit.camions++; r.horsGabarit.conteneurs += nbC; }
    if (c['enSurcharge'] === true || String(c['enSurcharge']) === 'true' || String(c['enSurcharge']) === 'Oui') { r.surcharge.camions++; r.surcharge.conteneurs += nbC; }
    if (codeDestination(c['destinationMarchandise']) === 'TG') { r.transitNational.camions++; r.transitNational.conteneurs += nbC; }
  }
  return { du, au, ...r };
}

/* ==================== Export CARGAISONS (statut/période) ============== */
/**
 * v4.1 — Onglet « Cargaisons » de l'Apps Script rétabli en EXPORT : choisir un
 * statut (ou une étape en attente) + une période, extraire en Excel ou PDF.
 * Répond au capitaine qui « n'a pas la main » pour sortir ces listes.
 */
export async function rapportCargaisons(ctx: Ctx, p: Record<string, unknown>) {
  const cargos = await loadCargos(ctx);
  const du = p['du'] as string | undefined, au = p['au'] as string | undefined;
  const statut = String(p['statut'] ?? '').trim();  // valeur exacte de statut ('' = tous)
  const etape = String(p['etape'] ?? '').trim();     // étape en attente (VALIDATION/T1/BALISE/BS/PP/CFS)
  const sansVeh = p['vehicules'] === false;
  // v4.2 — 2026-08-19 : l'extraction reçoit désormais AUSSI le texte recherché
  // dans la liste, pour que « extraire » sorte EXACTEMENT ce qui est affiché
  // (même recherche tolérante que cargo.list : brut alphanumérique en plus).
  const search = String(p['search'] ?? '').trim().toLowerCase();
  const searchBrut = search ? normAlphaNum(search) : '';
  const correspond = (c: Record<string, unknown>): boolean => {
    if (!search) return true;
    const champs = [c['id'], c['reference'], c['rapportId'], c['numeroCamion'], c['numeroGps'], c['numeroDeclaration']];
    for (const ct of detsDeRow(c)) champs.push(ct.num);
    return champs.some((x) => {
      const v = String(x ?? '');
      if (v.toLowerCase().indexOf(search) > -1) return true;
      return !!searchBrut && normAlphaNum(v).indexOf(searchBrut) > -1;
    });
  };
  const rows = cargos.filter((c) => {
    if (sansVeh && estOui(c['estVehicule'])) return false;
    if (!inRange(c['dateCreation'], du, au)) return false;
    if (statut && String(c['statut']) !== statut) return false;
    if (etape && etapesEnAttente(c as never).indexOf(etape as never) < 0) return false;
    if (!correspond(c)) return false;
    return true;
  }).map((c) => ({
    id: c['id'], numeroCamion: c['numeroCamion'], typeOperation: c['typeOperation'], statut: c['statut'],
    dateCreation: c['dateCreation'], declarant: c['declarant'], numeroDeclaration: c['numeroDeclaration'],
    // RGPD-01 — cet export est ouvert à TOUS_ROLES. Le N° de balise n'y figure
    // que pour les profils qui le voient déjà sur la fiche : sans quoi le
    // filtrage de `cargo.get` serait contourné par un simple export Excel.
    numeroGps: voitBalise(ctx) ? c['numeroGps'] : '',
    dateSortie: c['dateSortie'], agentCfs: c['agentCfs'], estVehicule: estOui(c['estVehicule']),
  }));
  const filtreTxt = (statut ? `statut : ${statut}` : etape ? `étape : ${etape}` : 'tous statuts')
    + (search ? ` · recherche « ${search} »` : '');
  const sousTitre = `Du ${p['du'] || '…'} au ${p['au'] || '…'} · ${filtreTxt}`;
  const entetes = ['ID', 'Camion / Châssis', 'Opération', 'Statut', 'Créé le', 'Déclarant', 'N° décl.', 'N° GPS', 'Sorti le', 'Agent CFS'];
  const ligne = (r: Record<string, unknown>) => [r['id'], r['numeroCamion'], r['typeOperation'], r['statut'], fmtJ(r['dateCreation']), r['declarant'], r['numeroDeclaration'], r['numeroGps'], fmtJ(r['dateSortie']), r['agentCfs']];
  if (p['format'] === 'xlsx' || p['format'] === 'pdf') {
    // RGPD-01 — un export nominatif quitte l'application : il est tracé.
    await ctx.log('Export cargaisons', '', `${rows.length} ligne(s) · ${filtreTxt} · ${p['format']}`);
  }
  if (p['format'] === 'xlsx') {
    const aoa: unknown[][] = [entetes]; rows.forEach((r) => aoa.push(ligne(r)));
    return fichier('Cargaisons', 'xlsx', [{ nom: 'Cargaisons', aoa }]);
  }
  if (p['format'] === 'pdf') return htmlTableau('Cargaisons', sousTitre, entetes, rows.map(ligne));
  return { rows, compte: { total: rows.length } };
}

/* ==================== Export CONTENEURS (stock/période) =============== */
/**
 * v4.1 — Extraction de la LISTE DES CONTENEURS du stock (positionnés non
 * dépotés, etc.), par statut + période, en Excel ou PDF. La période porte sur
 * la date de pointage (positionné) ou, à défaut, la date d'entrée.
 */
export async function rapportConteneurs(ctx: Ctx, p: Record<string, unknown>) {
  const statut = String(p['statut'] ?? '').trim();  // '', 'En stock', 'Positionné', 'Dépoté'
  const du = p['du'] as string | undefined, au = p['au'] as string | undefined;
  const now = new Date();
  const data = await fetchAll(ctx, 'stock', '*');
  const rows: Record<string, unknown>[] = [];
  for (const r of data) {
    const o = versCamel(r);
    if (!o['numeroTc']) continue;
    if (statut && String(o['statut']) !== statut) continue;
    const dateRef = o['datePointage'] || o['dateEntree'];
    if ((du || au) && !inRange(dateRef, du, au)) continue;
    const j = o['dateEntree'] ? Math.max(0, Math.floor((now.getTime() - new Date(String(o['dateEntree'])).getTime()) / 86400000)) : 0;
    rows.push({
      numeroTC: o['numeroTc'], taille: o['taille'], statut: o['statut'], provenance: o['provenance'],
      dateEntree: o['dateEntree'], datePointage: o['datePointage'], pointePar: o['pointePar'],
      numeroDeclaration: o['numeroDeclaration'], anneeDeclaration: o['anneeDeclaration'], typeDeclaration: o['typeDeclaration'],
      joursSejour: j, cargaisonId: o['cargaisonId'],
    });
  }
  const sousTitre = `${statut || 'tous statuts'} · Du ${p['du'] || '…'} au ${p['au'] || '…'}`;
  const entetes = ['Conteneur', 'Taille', 'Statut', 'Provenance', 'Entré le', 'Pointé le', 'Pointé par', 'N° décl.', 'Année', 'Type', 'Séjour (j)'];
  const ligne = (r: Record<string, unknown>) => [r['numeroTC'], r['taille'], r['statut'], r['provenance'], fmtJ(r['dateEntree']), fmtJ(r['datePointage']), r['pointePar'], r['numeroDeclaration'], r['anneeDeclaration'], r['typeDeclaration'], r['joursSejour']];
  if (p['format'] === 'xlsx') {
    const aoa: unknown[][] = [entetes]; rows.forEach((r) => aoa.push(ligne(r)));
    return fichier('Conteneurs', 'xlsx', [{ nom: 'Conteneurs', aoa }]);
  }
  if (p['format'] === 'pdf') return htmlTableau('Liste des conteneurs', sousTitre, entetes, rows.map(ligne));
  return { rows, compte: { total: rows.length } };
}

/* ============================= Dispenses ============================== */

export async function rapportDispenses(ctx: Ctx, p: Record<string, unknown>) {
  const cargos = await loadCargos(ctx);
  const rows: Record<string, unknown>[] = [];
  let total = 0, enCours = 0, terminees = 0;
  for (const c of cargos) {
    // v4.1 — une dispense = exemption prise à la Balise + numéro d'autorisation ;
    // les type C/A/E « saute-balise » ne sont PAS des dispenses.
    if (!estDispenseBalise(c as never)) continue;
    total++;
    if (estOui(c['arriveeBureau'])) terminees++; else enCours++;
    rows.push({ id: c['id'], numeroCamion: c['numeroCamion'], numeroDispense: c['numeroDispense'], statut: c['statut'], arriveeBureau: c['arriveeBureau'], dateArriveeBureau: c['dateArriveeBureau'] });
  }
  if (p['format'] === 'xlsx' || p['format'] === 'pdf') {
    const aoa: unknown[][] = [['ID', 'Camion', 'N° dispense', 'Statut', 'Arrivée bureau']];
    rows.forEach((r) => aoa.push([r['id'], r['numeroCamion'], r['numeroDispense'], r['statut'], estOui(r['arriveeBureau']) ? 'Oui' : 'Non']));
    return fichier('Dispenses', String(p['format']), [{ nom: 'Dispenses', aoa }]);
  }
  return { compte: { total, enCours, terminees }, rows };
}

/* =============================== Flux ================================= */

function lundiDe(d: Date) { const x = new Date(d); const j = (x.getDay() + 6) % 7; x.setDate(x.getDate() - j); x.setHours(0, 0, 0, 0); return x; }
function periodeKey(v: unknown, gran: string): string | null {
  if (!v) return null;
  const d = new Date(String(v));
  if (isNaN(d.getTime())) return null;
  if (gran === 'annee') return String(d.getFullYear());
  if (gran === 'mois') return d.toISOString().slice(0, 7);
  if (gran === 'semaine') return lundiDe(d).toISOString().slice(0, 10);
  return d.toISOString().slice(0, 10);
}

interface FluxLigne {
  periode: string; enlevesC: number; depotesC: number; tc: number; evp: number; baliseC: number; ppC: number;
}
function fluxVide(k: string): FluxLigne { return { periode: k, enlevesC: 0, depotesC: 0, tc: 0, evp: 0, baliseC: 0, ppC: 0 }; }

export async function rapportFlux(ctx: Ctx, p: Record<string, unknown>) {
  const gran = String(p['granularite'] || 'mois');
  // v4 — bornes de période FACULTATIVES (absentes = toute la base). Chaque
  // passage est daté SÉPARÉMENT : un camion entré en juin et sorti en juillet
  // compte à l'enlèvement/dépotage de juin et à la sortie de juillet.
  const du = String(p['du'] ?? '') || undefined;
  const au = String(p['au'] ?? '') || undefined;
  const dansPeriode = (v: unknown) => (!du && !au) || inRange(v, du, au);
  const cargos = await loadCargos(ctx);
  const map: Record<string, FluxLigne> = {};
  const bump = (k: string | null) => { if (!k) return null; if (!map[k]) map[k] = fluxVide(k); return map[k]; };
  const tot = fluxVide('');
  for (const c of cargos) {
    if (estOui(c['estVehicule'])) continue;
    const op = String(c['typeOperation']);
    const dets = detsDeRow(c);
    let evp = 0; for (const ct of dets) evp += evpDeTaille(tailleBucket(ct.taille));
    // Enlèvement / dépotage : comptés à l'entrée CFS.
    const kC = dansPeriode(c['dateCreation']) ? bump(periodeKey(c['dateCreation'], gran)) : null;
    if (kC) {
      if (op === OPERATIONS.ENLEVEMENT) { kC.enlevesC += dets.length; tot.enlevesC += dets.length; }
      else if (op === OPERATIONS.DEPOTAGE) { kC.depotesC += dets.length; tot.depotesC += dets.length; }
      kC.tc += dets.length; tot.tc += dets.length;
      kC.evp += evp; tot.evp += evp;
    }
    // Camions balisés : à la pose de balise.
    if (c['datePoseGps'] && dansPeriode(c['datePoseGps'])) { const k = bump(periodeKey(c['datePoseGps'], gran)); if (k) { k.baliseC++; tot.baliseC++; } }
    // Camions sortis : à la sortie PP.
    if (c['dateSortie'] && dansPeriode(c['dateSortie'])) { const k = bump(periodeKey(c['dateSortie'], gran)); if (k) { k.ppC++; tot.ppC++; } }
  }
  const rows = Object.values(map).sort((a, b) => a.periode.localeCompare(b.periode));
  if (p['format'] === 'xlsx' || p['format'] === 'pdf') {
    const aoa: unknown[][] = [['Période', 'Conteneurs enlevés', 'Conteneurs dépotés', 'Total conteneurs (TC)', 'EVP', 'Camions balisés', 'Camions sortis']];
    rows.forEach((r) => aoa.push([r.periode, r.enlevesC, r.depotesC, r.tc, r.evp, r.baliseC, r.ppC]));
    aoa.push(['TOTAL', tot.enlevesC, tot.depotesC, tot.tc, tot.evp, tot.baliseC, tot.ppC]);
    return fichier('Analyse_flux', String(p['format']), [{ nom: 'Flux', aoa }]);
  }
  return { granularite: gran, du, au, rows, totaux: tot };
}

/* ===================== Répartition par destination =================== */
/**
 * v4.1 — Camions SORTIS par DESTINATION (décision utilisateur 2026-07-27), avec
 * évolution périodique pour le graphique. `parDest` = totaux sur la période ;
 * `series` = un point par bucket de période, une valeur par destination.
 */
export async function rapportDestinations(ctx: Ctx, p: Record<string, unknown>) {
  const gran = String(p['granularite'] || 'mois');
  const du = String(p['du'] ?? '') || undefined;
  const au = String(p['au'] ?? '') || undefined;
  const dansPeriode = (v: unknown) => (!du && !au) || inRange(v, du, au);
  const codes = [...DESTINATION_CODES, 'Autres'];
  const cargos = await loadCargos(ctx);
  const parDest: Record<string, number> = {}; codes.forEach((c) => (parDest[c] = 0));
  const map: Record<string, Record<string, unknown>> = {};
  let total = 0;
  for (const c of cargos) {
    if (estOui(c['estVehicule'])) continue; // camions uniquement
    if (!c['dateSortie'] || !dansPeriode(c['dateSortie'])) continue;
    const code = codeDestination(c['destinationMarchandise']);
    parDest[code]++; total++;
    const k = periodeKey(c['dateSortie'], gran);
    if (!k) continue;
    if (!map[k]) { map[k] = { periode: k }; codes.forEach((cc) => (map[k]![cc] = 0)); }
    map[k]![code] = Number(map[k]![code] ?? 0) + 1;
  }
  const series = Object.values(map).sort((a, b) => String(a['periode']).localeCompare(String(b['periode'])));
  if (p['format'] === 'xlsx' || p['format'] === 'pdf') {
    const aoa: unknown[][] = [['Période', ...codes]];
    series.forEach((r) => aoa.push([r['periode'], ...codes.map((c) => r[c])]));
    aoa.push(['TOTAL', ...codes.map((c) => parDest[c])]);
    return fichier('Repartition_destinations', String(p['format']), [{ nom: 'Destinations', aoa }]);
  }
  return { granularite: gran, du, au, codes, parDest, total, series };
}

export async function rapportFluxDetail(ctx: Ctx, p: Record<string, unknown>) {
  const gran = String(p['granularite'] || 'jour');
  const point = String(p['point'] ?? 'cfs');
  const periode = String(p['periodKey'] ?? '');
  const col = point === 'balise' || point === 'sansbalise' ? 'datePoseGps' : point === 'pp' ? 'dateSortie' : 'dateCreation';
  const cargos = await loadCargos(ctx);
  const rows: Record<string, unknown>[] = [];
  for (const c of cargos) {
    if (estOui(c['estVehicule'])) continue;
    if (!c[col]) continue;
    if (periode && periodeKey(c[col], gran) !== periode) continue;
    if (point === 'sansbalise' && !(String(c['baliseRequise']) === 'Non' || c['baliseRequise'] === false)) continue;
    rows.push({ id: c['id'], numeroCamion: c['numeroCamion'], typeOperation: c['typeOperation'], statut: c['statut'], date: c[col] });
  }
  return { titre: point, rows };
}

/* ======================== Séjour & instance (dwell) =================== */

export async function rapportSejour(ctx: Ctx, p: Record<string, unknown>) {
  const cargos = await loadCargos(ctx);
  const now = new Date();
  const dist: Record<string, { tranche: string; instance: number; sortis: number }> = {};
  TRANCHES_SEJOUR.forEach((t) => (dist[t] = { tranche: t, instance: 0, sortis: 0 }));
  const instance: Record<string, unknown>[] = [];
  let totInstance = 0, totSortis = 0, sommeDelai = 0, nDelai = 0, alerte = 0;
  for (const c of cargos) {
    if (estOui(c['estVehicule'])) continue;
    const dc = c['dateCreation'] ? new Date(String(c['dateCreation'])) : null;
    if (!dc || isNaN(dc.getTime())) continue;
    if (c['statut'] === STATUTS.SORTIE && c['dateSortie']) {
      const j = Math.max(0, Math.floor((new Date(String(c['dateSortie'])).getTime() - dc.getTime()) / 86400000));
      dist[trancheAge(j)]!.sortis++; totSortis++; sommeDelai += j; nDelai++;
    } else {
      const j = Math.max(0, Math.floor((now.getTime() - dc.getTime()) / 86400000));
      dist[trancheAge(j)]!.instance++; totInstance++;
      if (j >= SEUIL_ALERTE_SEJOUR) alerte++;
      instance.push({ id: c['id'], numeroCamion: c['numeroCamion'], typeOperation: c['typeOperation'], statut: c['statut'], age: j });
    }
  }
  instance.sort((a, b) => (b['age'] as number) - (a['age'] as number));
  const data = { compte: { totInstance, totSortis, delaiMoyen: nDelai ? Math.round(sommeDelai / nDelai) : 0, alerte }, tranches: TRANCHES_SEJOUR.map((t) => dist[t]), instance, seuil: SEUIL_ALERTE_SEJOUR };
  if (p['format'] === 'xlsx' || p['format'] === 'pdf') {
    const aoa: unknown[][] = [['ID', 'Camion', 'Opération', 'Statut', 'Âge (j)']];
    instance.forEach((r) => aoa.push([r['id'], r['numeroCamion'], r['typeOperation'], r['statut'], r['age']]));
    return fichier('Delai_sejour', String(p['format']), [{ nom: 'Camions en instance', aoa }]);
  }
  return data;
}

export async function rapportSejourDetail(ctx: Ctx, p: Record<string, unknown>) {
  const r = await rapportSejour(ctx, {}) as { instance: Record<string, unknown>[] };
  const bucket = String(p['bucket'] ?? 'instance');
  const tranche = String(p['tranche'] ?? '');
  let rows = r.instance;
  if (bucket === 'alerte') rows = rows.filter((x) => (x['age'] as number) >= SEUIL_ALERTE_SEJOUR);
  if (tranche) rows = rows.filter((x) => trancheAge(x['age'] as number) === tranche);
  return { titre: bucket + (tranche ? ' · ' + tranche : ''), rows };
}

/* ================= Temps de passage par poste (v4.2) ================== */

/**
 * TEMPS DE PASSAGE — demande utilisateur du 2026-08-10.
 *
 * Trois lectures d'une même donnée :
 *   · GLOBAL   — entrée du camion → sortie à la Porte Principale. La performance
 *     de bout en bout, la seule qui se compare d'un mois sur l'autre.
 *   · PAR POSTE — combien de temps le dossier a attendu à chaque cellule.
 *   · PAR JOUR  — la moyenne de chaque poste, jour par jour, pour le graphique.
 *
 * COHORTE PAR JOUR D'ENTRÉE. Un dossier est rattaché au jour où le camion est
 * entré, pas au jour où il est sorti. C'est la lecture que demande l'exploitant
 * (« les déclarations de la journée ») et la seule qui permette de dire « les
 * camions entrés mardi ont mis en moyenne tant ». Conséquence assumée et
 * affichée : pour la journée en cours, la moyenne ne porte que sur les dossiers
 * DÉJÀ sortis — d'où l'effectif `n` publié à côté de chaque moyenne.
 *
 * Les durées non mesurables restent `null` et sont exclues des moyennes ; elles
 * ne sont jamais comptées zéro (voir delais.ts).
 */
export async function rapportTemps(ctx: Ctx, p: Record<string, unknown>) {
  const cargos = await loadCargos(ctx);
  const du = p['du'] as string | undefined;
  const au = p['au'] as string | undefined;
  const sansVeh = p['vehicules'] === false;

  const lignes: Record<string, unknown>[] = [];
  let avecFin = 0, sansFin = 0, incoherents = 0, sortis = 0;

  for (const c of cargos) {
    if (sansVeh && estOui(c['estVehicule'])) continue;
    if (!inRange(c['dateCreation'], du, au)) continue;
    const d = delaisDe(c as never);
    if (d.approx) sansFin++; else avecFin++;
    if (d.incoherent) incoherents++;
    if (c['statut'] === STATUTS.SORTIE) sortis++;
    lignes.push({
      id: c['id'], numeroCamion: c['numeroCamion'], typeOperation: c['typeOperation'],
      statut: c['statut'], estVehicule: estOui(c['estVehicule']),
      declaration: libelleDeclaration(c as never),
      jour: String(c['dateCreation'] ?? '').slice(0, 10),
      dateCreation: c['dateCreation'], dateSortie: c['dateSortie'],
      cfs: d.cfs, validation: d.validation, t1: d.t1, balise: d.balise, bs: d.bs, pp: d.pp,
      global: d.global, approx: d.approx, incoherent: d.incoherent,
    });
  }
  lignes.sort((a, b) => String(b['dateCreation'] ?? '').localeCompare(String(a['dateCreation'] ?? '')));

  // --- Synthèse par poste + global -----------------------------------------
  const postes = POSTES.map((poste) => ({
    poste, libelle: LIBELLE_POSTE[poste],
    ...agreger(lignes.map((l) => l[poste] as number | null)),
  }));
  const global = agreger(lignes.map((l) => l['global'] as number | null));

  // --- Moyennes par jour (unité du graphique : heures décimales) ------------
  const parJourMap = new Map<string, Record<string, unknown>[]>();
  for (const l of lignes) {
    const j = String(l['jour'] ?? '');
    if (!j) continue;
    (parJourMap.get(j) ?? parJourMap.set(j, []).get(j)!).push(l);
  }
  const parJour = [...parJourMap.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([jour, ls]) => {
      const ligne: Record<string, unknown> = { jour, dossiers: ls.length };
      for (const poste of POSTES) {
        const a = agreger(ls.map((l) => l[poste] as number | null));
        ligne[poste] = enHeures(a.moyenne);
        ligne['n_' + poste] = a.n;
      }
      const g = agreger(ls.map((l) => l['global'] as number | null));
      ligne['global'] = enHeures(g.moyenne);
      ligne['n_global'] = g.n;
      return ligne;
    });

  const data = {
    compte: { dossiers: lignes.length, sortis, incoherents, avecFin, sansFin },
    global, postes, parJour, lignes,
  };

  /* ------------------------------- Exports ------------------------------- */
  if (p['format'] === 'xlsx' || p['format'] === 'pdf') {
    const periode = `Du ${du || '…'} au ${au || '…'}`;
    const entetesPoste = ['Poste', 'Dossiers mesurés', 'Moyenne', 'Médiane', '90e centile', 'Mini', 'Maxi'];
    const lignesPoste = [
      ...postes.map((x) => [x.libelle, x.n, dureeLisible(x.moyenne), dureeLisible(x.mediane), dureeLisible(x.p90), dureeLisible(x.min), dureeLisible(x.max)]),
      ['GLOBAL — entrée du camion → sortie PP', global.n, dureeLisible(global.moyenne), dureeLisible(global.mediane), dureeLisible(global.p90), dureeLisible(global.min), dureeLisible(global.max)],
    ];
    await ctx.log('Export temps de passage', '', `${lignes.length} dossier(s) · ${periode} · ${p['format']}`);

    if (p['format'] === 'pdf') return htmlTableau('Temps de passage par poste', periode, entetesPoste, lignesPoste);

    const aoaJour: unknown[][] = [['Jour', 'Dossiers', ...POSTES.map((x) => LIBELLE_POSTE[x] + ' (h)'), 'Global (h)']];
    parJour.forEach((j) => aoaJour.push([fmtJ(j['jour']), j['dossiers'], ...POSTES.map((x) => j[x] ?? ''), j['global'] ?? '']));

    const aoaDetail: unknown[][] = [[
      'ID', 'Camion / Châssis', 'Opération', 'Déclaration', 'Entré le', 'Sorti le',
      ...POSTES.map((x) => LIBELLE_POSTE[x]), 'GLOBAL', 'Détail par poste disponible', 'Dates incohérentes',
    ]];
    lignes.forEach((l) => aoaDetail.push([
      l['id'], l['numeroCamion'], l['typeOperation'], l['declaration'],
      fmtJ(l['dateCreation']), fmtJ(l['dateSortie']),
      ...POSTES.map((x) => dureeLisible(l[x] as number | null)),
      dureeLisible(l['global'] as number | null),
      l['approx'] ? 'non' : 'oui', l['incoherent'] ? 'OUI' : '',
    ]));

    return fichier('Temps_de_passage', 'xlsx', [
      { nom: 'Synthèse par poste', aoa: [[periode], [], ...[entetesPoste], ...lignesPoste] },
      { nom: 'Moyennes par jour', aoa: aoaJour },
      { nom: 'Détail par dossier', aoa: aoaDetail },
    ]);
  }
  return data;
}

/* ===================== Bon de chargement / listes ===================== */

export async function rapportChargement(ctx: Ctx, id: string) {
  const { data, error } = await ctx.db.from('cargaisons').select('*').eq('id', id).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error('Cargaison introuvable : ' + id);
  const c = versCamel(data);
  const pd = parseConteneursDetails(c['conteneursDetails']);
  const conts = pd.conteneurs;
  const esc = (v: unknown) => String(v ?? '').replace(/[&<>]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[m]!));
  const estDep = c['typeOperation'] === OPERATIONS.DEPOTAGE;
  const groupes = groupesDeclaration(conts, c);
  const mixte = groupes.length > 1;
  const dt = c['dateCreation'] ? new Date(String(c['dateCreation'])) : null;
  const dateFr = dt && !isNaN(dt.getTime())
    ? dt.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' })
      + ' à ' + dt.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })
    : '—';
  const val = (v: unknown) => esc(v) || '—';

  // En chargement MIXTE, le tableau est scindé par déclaration : sans cela, le bon
  // laissait croire que tous les conteneurs relevaient de la même déclaration.
  const tableau = (liste: typeof conts) => `<table>
    <thead><tr><th style="width:10%">#</th><th style="width:34%">Conteneur</th><th style="width:16%">Taille</th><th style="width:16%">Type</th>${estDep ? '' : '<th style="width:24%">Scellé</th>'}</tr></thead>
    <tbody>${liste.map((ct) => {
      const i = conts.indexOf(ct) + 1;
      return `<tr><td>${i}</td><td class="tc">${esc(ct.num)}</td><td>${val(ct.taille)}</td><td>${val(ct.type)}</td>${estDep ? '' : `<td>${val(ct.plomb)}</td>`}</tr>`;
    }).join('')}</tbody></table>`;

  const corpsConteneurs = !conts.length
    ? `<div class="l">Aucun conteneur — ${val(c['descriptionMarchandise'])}</div>`
    : mixte
      ? groupes.map((g) => `<div class="grp"><div class="grp-t">Déclaration ${esc(libelleDeclaration(g))}${g.declarant ? ' — ' + esc(g.declarant) : ''}</div>${tableau(g.conteneurs)}</div>`).join('')
      : tableau(conts);

  const html = `<!doctype html><html lang="fr"><meta charset="utf-8">
<title>Bon de chargement — ${esc(c['numeroCamion'])}</title>
<style>
  /* Même trame typographique que l'ordre d'exécution : ce bon est présenté au
     poste de contrôle, il doit être lisible d'un coup d'œil et tenir sur une page. */
  @page { size: A4; margin: 15mm 20mm; }
  body { font-family: "Times New Roman", "Liberation Serif", Georgia, serif; color: #000;
         font-size: 11pt; line-height: 1.65; margin: 0; }
  .head { text-align: center; margin-bottom: 6mm; }
  .head .g { font-size: 8.5pt; font-weight: bold; text-transform: uppercase; letter-spacing: .04em; line-height: 1.5; }
  h1 { text-align: center; font-size: 13.5pt; letter-spacing: .18em; margin: 4mm 0 1mm;
       text-decoration: underline; text-underline-offset: 4pt; page-break-after: avoid; }
  .ref { text-align: center; font-size: 9.5pt; margin-bottom: 6mm; }
  /* Identité du camion : deux colonnes de couples libellé / valeur alignés. */
  .fiche { display: grid; grid-template-columns: 1fr 1fr; gap: 0 10mm; margin-bottom: 5mm; }
  .fiche div { border-bottom: .4pt dotted #000; padding: 1.4mm 0; font-size: 10.5pt; }
  .fiche b { display: inline-block; min-width: 34mm; font-weight: bold; }
  .l { margin: 0 0 3mm; font-size: 10.5pt; }
  .grp { margin-bottom: 4mm; page-break-inside: avoid; }
  .grp-t { font-weight: bold; font-size: 10pt; text-decoration: underline;
           text-underline-offset: 3pt; margin-bottom: 1.5mm; }
  table { border-collapse: collapse; width: 100%; margin-bottom: 4mm; }
  thead { display: table-header-group; }
  tr { page-break-inside: avoid; }
  th, td { border: .6pt solid #000; padding: 1.8mm 2mm; font-size: 10pt; text-align: center; }
  th { font-weight: bold; }
  td.tc { font-family: "Courier New", monospace; font-size: 9.5pt; letter-spacing: .04em; }
  .avert { border: .6pt solid #000; padding: 2mm 3mm; margin-bottom: 4mm; font-size: 10pt; }
  .signatures { display: flex; justify-content: space-around; gap: 12mm; margin-top: 10mm; page-break-inside: avoid; }
  .signatures div { flex: 1; text-align: center; }
  .signatures .rule { border-top: .6pt solid #000; margin-top: 20mm; padding-top: 1.5mm; font-size: 9.5pt; }
</style>
<div class="head"><div class="g">République Togolaise — Commissariat des Douanes et Droits Indirects<br>Division des Opérations Douanières Lomé-Port 4 — Section Brigade PIA</div></div>
<h1>BON DE CHARGEMENT</h1>
<div class="ref">N° ${val(c['rapportId'] ?? c['id'])} — établi le ${dateFr}</div>

<div class="fiche">
  <div><b>N° camion</b>${val(c['numeroCamion'])}</div>
  <div><b>Opération</b>${val(c['typeOperation'])}</div>
  <div><b>Déclarant</b>${val(c['declarant'])}</div>
  <div><b>Contact</b>${val(c['contactDeclarant'])}</div>
  <div><b>Déclaration</b>${mixte ? esc(groupes.length) + ' déclarations (chargement mixte)' : esc(libelleDeclaration(groupes[0] ?? c))}</div>
  <div><b>Destination</b>${val(c['destinationMarchandise'])}</div>
  <div><b>Marchandise</b>${val(c['descriptionMarchandise'])}</div>
  <div><b>Nombre de colis</b>${val(c['nbColis'])}</div>
</div>

${estDep ? `<div class="l"><b>Scellés du camion :</b> ${val(pd.scellesCamion.join(' · '))}</div>` : ''}
${mixte ? '<div class="avert"><b>CHARGEMENT MIXTE</b> — ce camion emporte des conteneurs relevant de plusieurs déclarations. Les conteneurs sont présentés ci-dessous groupés par déclaration.</div>' : ''}

${corpsConteneurs}

<div class="l"><b>Agent CFS :</b> ${val(c['agentCfs'])}</div>
<div class="signatures">
  <div><div class="rule">L'agent CFS</div></div>
  <div><div class="rule">Le chauffeur</div></div>
  <div><div class="rule">Le Chef de Brigade</div></div>
</div>
</html>`;
  return { html, filename: 'BonChargement_' + c['id'] + '.html' };
}

/**
 * v4 — BON DE CHARGEMENT PAR DÉCLARATION (décision utilisateur 2026-07-16).
 * Recherche par N° de déclaration → remonte TOUS les camions ET véhicules ayant
 * chargé des conteneurs de cette déclaration, au statut « Créée » (= fin de
 * chargement). Filtres facultatifs année/bureau/type pour lever une ambiguïté
 * si le même numéro existe sur plusieurs déclarations.
 *
 * ⚠ La déclaration est lue depuis `conteneursDetails` (déclaration PAR conteneur
 * → gère les chargements MIXTES) avec repli sur la déclaration du camion. On
 * n'utilise PAS les colonnes déclaration de la table `conteneurs` : elles
 * existent au schéma mais ne sont jamais alimentées par ajouterConteneurs.
 *
 * ⚠ FORMAT D'ÉDITION À FOURNIR : la sortie est PROVISOIRE (données brutes
 * structurées). La mise en page définitive se branchera dessus sans retoucher
 * cette collecte.
 */
export async function rapportChargementDecl(ctx: Ctx, p: Record<string, unknown>) {
  // Bon de chargement : fin de chargement UNIQUEMENT.
  return await collecterParDeclaration(ctx, p, (c) => c['statut'] === STATUTS.CREEE);
}

/**
 * Collecte partagée « tout ce qui relève d'une déclaration ».
 *
 * Le bon de chargement et la VALIDATION du chef brigade posent la même question
 * (« que contient cette déclaration ? ») mais ne retiennent pas les mêmes
 * cargaisons : le bon veut la fin de chargement, la validation veut ce qui
 * attend encore une signature — d'où le prédicat `garder`.
 */
async function collecterParDeclaration(
  ctx: Ctx,
  p: Record<string, unknown>,
  garder: (c: Record<string, unknown>) => boolean,
) {
  const cle = (v: unknown) => String(v ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const num = cle(p['numeroDeclaration']);
  if (!num) throw new Error('Indiquez le N° de déclaration.');
  const annee = String(p['anneeDeclaration'] ?? '').trim();
  const bureau = cle(p['bureauDeclaration']);
  const typeD = cle(p['typeDeclaration']);

  /** La déclaration portée par un objet (conteneur OU camion) correspond-elle ? */
  const concorde = (o: Record<string, unknown>): boolean => {
    if (cle(o['numeroDeclaration']) !== num) return false;
    if (annee && String(o['anneeDeclaration'] ?? '').trim() !== annee) return false;
    if (bureau && cle(o['bureauDeclaration']) !== bureau) return false;
    if (typeD && cle(o['typeDeclaration']) !== typeD) return false;
    return true;
  };

  const camions: Record<string, unknown>[] = [];
  const vehicules: Record<string, unknown>[] = [];
  let totalConteneurs = 0;

  for (const c of await loadCargos(ctx)) {
    if (!garder(c)) continue;
    const pd = parseConteneursDetails(c['conteneursDetails']);
    const retenus = pd.conteneurs.filter((ct) => concorde(ct as never));
    // Repli : conteneurs sans déclaration propre (données migrées) → déclaration du camion.
    const parCamion = concorde(c);
    if (!retenus.length && !parCamion) continue;
    const conts = retenus.length ? retenus : pd.conteneurs;
    totalConteneurs += conts.length;
    const ligne: Record<string, unknown> = {
      id: c['id'], rapportId: c['rapportId'], dateCreation: c['dateCreation'],
      numeroCamion: c['numeroCamion'], typeOperation: c['typeOperation'], statut: c['statut'],
      declarant: c['declarant'], contactDeclarant: c['contactDeclarant'],
      destinationMarchandise: c['destinationMarchandise'], descriptionMarchandise: c['descriptionMarchandise'],
      numeroDeclaration: c['numeroDeclaration'], anneeDeclaration: c['anneeDeclaration'],
      bureauDeclaration: c['bureauDeclaration'], typeDeclaration: c['typeDeclaration'],
      agentCfs: c['agentCfs'], nbColis: c['nbColis'], etatSortie: c['etatSortie'],
      observationsCfs: c['observationsCfs'],
      // Éléments que le chef brigade doit voir AVANT de signer : ce qui reste dû
      // sur le parcours, et le hors gabarit (champ confidentiel, filtré plus bas
      // pour les rôles qui n'y ont pas droit).
      dateValidation: c['dateValidation'], agentValidation: c['agentValidation'], roleValidation: c['roleValidation'],
      etapesEnAttente: etapesEnAttente(c as never),
      horsGabarit: estOui(c['horsGabarit']), hauteurChargement: c['hauteurChargement'],
      // Mixte DÉDUIT des déclarations portées par les conteneurs (le drapeau
      // hérité de l'Apps Script n'est plus alimenté et manque sur les données
      // migrées). Calculé sur TOUS les conteneurs du camion, pas seulement sur
      // ceux retenus pour la déclaration éditée.
      chargementMixte: estChargementMixte(pd.conteneurs, c) || estOui(c['chargementMixte']),
      // Les autres déclarations du camion : ce que l'agent doit savoir en lisant
      // le bon, puisque le camion emporte aussi des conteneurs qui n'y figurent pas.
      autresDeclarations: groupesDeclaration(pd.conteneurs, c)
        .filter((g) => !concorde(g as never))
        .map((g) => ({ libelle: libelleDeclaration(g), nbConteneurs: g.conteneurs.length })),
      scellesCamion: pd.scellesCamion,
      nbConteneurs: conts.length,
      conteneurs: conts.map((ct) => ({
        num: ct.num, plomb: ct.plomb, taille: ct.taille, type: ct.type, poids: ct.poids,
      })),
    };
    // Hors gabarit = confidentiel : mêmes règles que cargo.get, sinon le bon de
    // chargement deviendrait une fuite pour les rôles qui n'y ont pas accès.
    filtrerConfidentiel(ligne, ctx.session.role);
    if (estOui(c['estVehicule'])) {
      ligne['vehicule'] = c['vehiculeDetails'];
      ligne['conteneurOrigine'] = c['conteneurOrigine'];
      vehicules.push(ligne);
    } else camions.push(ligne);
  }

  const parDate = (a: Record<string, unknown>, b: Record<string, unknown>) =>
    new Date(String(a['dateCreation'] ?? '')).getTime() - new Date(String(b['dateCreation'] ?? '')).getTime();
  camions.sort(parDate);
  vehicules.sort(parDate);

  // En-tête : apurement de la déclaration (clé reprise du 1er résultat trouvé).
  const ref = camions[0] ?? vehicules[0];
  const declaration = ref
    ? {
        numeroDeclaration: ref['numeroDeclaration'], anneeDeclaration: ref['anneeDeclaration'],
        bureauDeclaration: ref['bureauDeclaration'], typeDeclaration: ref['typeDeclaration'],
        declarant: ref['declarant'],
      }
    : { numeroDeclaration: num, anneeDeclaration: annee, bureauDeclaration: bureau, typeDeclaration: typeD, declarant: '' };
  const apurement = ref ? await lookupDeclaration(ctx, declaration as never) : null;

  return {
    declaration, apurement,
    camions, vehicules,
    compte: {
      camions: camions.length, vehicules: vehicules.length,
      conteneurs: totalConteneurs, total: camions.length + vehicules.length,
    },
  };
}

/* ==================== Validation du chef brigade ====================== */

/**
 * v4 — VALIDATION PAR DÉCLARATION (décision utilisateur 2026-07-19).
 *
 * Le chef brigade ne valide plus camion par camion : il ouvre une déclaration,
 * voit TOUT ce qu'elle contient (camions, véhicules, conteneurs, scellés, colis,
 * hors gabarit, chargements mixtes) et signe l'ensemble d'un seul geste. Valider
 * à l'unité obligeait à rouvrir dix fiches pour une seule opération de dépotage,
 * et rien ne montrait l'ensemble avant de signer.
 *
 * Sans N° de déclaration, renvoie la LISTE des déclarations en attente : le chef
 * n'a pas à connaître les numéros par cœur pour commencer sa tournée.
 */
export async function validationParDeclaration(ctx: Ctx, p: Record<string, unknown>) {
  const enAttente = (c: Record<string, unknown>) =>
    etapesEnAttente(c as never).indexOf('VALIDATION') >= 0;

  if (!String(p['numeroDeclaration'] ?? '').trim()) return await declarationsAValider(ctx);

  // Tout ce qui relève de la déclaration ET a fini le chargement — y compris ce
  // qui est DÉJÀ validé, pour que le chef voie l'ensemble et non un reliquat.
  const r = await collecterParDeclaration(ctx, p, (c) =>
    etatCellules(c as never).cfs && c['statut'] !== STATUTS.SORTIE);
  const lignes = [...r.camions, ...r.vehicules];
  // « À valider » = réellement encore en attente de validation. On s'appuie sur
  // le moteur (etapesEnAttente 'VALIDATION') et non sur `dateValidation` seul :
  // ainsi la CASCADE (T1 fait ou camion sorti ⇒ validation réputée acquise) ne
  // laisse plus de camions déjà avancés dans le lot à signer.
  const aValider = lignes.filter((l) => enAttente(l));
  return {
    ...r,
    aValider: aValider.map((l) => l['id']),
    compte: {
      ...r.compte,
      aValider: aValider.length,
      dejaValidees: lignes.length - aValider.length,
      conteneursAValider: aValider.reduce((n, l) => n + Number(l['nbConteneurs'] ?? 0), 0),
    },
  };
}

/** Déclarations ayant au moins une cargaison en attente de signature. */
async function declarationsAValider(ctx: Ctx) {
  const parCle: Record<string, Record<string, unknown>> = {};
  for (const c of await loadCargos(ctx)) {
    if (etapesEnAttente(c as never).indexOf('VALIDATION') < 0) continue;
    const pd = parseConteneursDetails(c['conteneursDetails']);
    // Un camion en chargement MIXTE alimente CHACUNE de ses déclarations : sinon
    // il resterait invisible dans la file de la seconde.
    for (const g of groupesDeclaration(pd.conteneurs, c)) {
      if (!g.numeroDeclaration) continue;
      const e = parCle[g.cle] ?? (parCle[g.cle] = {
        cle: g.cle, numeroDeclaration: g.numeroDeclaration, anneeDeclaration: g.anneeDeclaration,
        bureauDeclaration: g.bureauDeclaration, typeDeclaration: g.typeDeclaration,
        declarant: g.declarant, libelle: libelleDeclaration(g),
        camions: 0, vehicules: 0, conteneurs: 0, plusAncienne: c['dateCreation'],
      });
      if (estOui(c['estVehicule'])) e['vehicules'] = Number(e['vehicules']) + 1;
      else e['camions'] = Number(e['camions']) + 1;
      e['conteneurs'] = Number(e['conteneurs']) + g.conteneurs.length;
      if (new Date(String(c['dateCreation'])) < new Date(String(e['plusAncienne']))) e['plusAncienne'] = c['dateCreation'];
    }
  }
  const rows = Object.values(parCle).sort((a, b) =>
    new Date(String(a['plusAncienne'])).getTime() - new Date(String(b['plusAncienne'])).getTime());
  return { declarations: rows, total: rows.length };
}

/**
 * v4 — ORDRE D'EXÉCUTION (imprimable) — trame officielle OTR / Section Brigade PIA,
 * reproduite d'après le formulaire papier fourni (2026-07-16).
 *
 * UN ordre PAR DÉCLARATION (décision utilisateur), listant tous les camions et
 * conteneurs de la déclaration au statut « Créée ». Le n° d'ordre = le/les
 * rapportId de l'appli (décision utilisateur) ; si la déclaration a été saisie en
 * plusieurs rapports, ils sont tous listés.
 *
 * Pré-remplissage (décision utilisateur) : agents CFS, date/heure d'opération et
 * observations CFS. Les SIGNATURES et les mentions manuscrites (« Il est ordonné
 * aux agents », heures d'exécution) restent VIERGES — elles se remplissent à la main.
 *
 * ⚠ Colonne « Type » du tableau papier = la TAILLE du conteneur (40, 20…), pas le
 * type ISO (DRY/RF). C'est bien `taille` qui y est imprimée.
 * ⚠ Colonne « Plombs » : en DÉPOTAGE les scellés sont au niveau CAMION
 * (scellesCamion) ; en ENLÈVEMENT ils sont portés PAR conteneur (plomb).
 */
export async function ordreExecution(ctx: Ctx, p: Record<string, unknown>) {
  const r = await rapportChargementDecl(ctx, p);
  const d = r.declaration as Record<string, unknown>;
  const lignes = [...(r.camions as Record<string, unknown>[]), ...(r.vehicules as Record<string, unknown>[])];
  if (!lignes.length) throw new Error('Aucun camion au statut « Créée » pour cette déclaration : rien à éditer.');

  const esc = (v: unknown) => String(v ?? '').replace(/[&<>]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[m]!));
  const jour = (v: unknown) => {
    const dt = v ? new Date(String(v)) : null;
    if (!dt || isNaN(dt.getTime())) return '';
    const p2 = (n: number) => String(n).padStart(2, '0');
    return p2(dt.getDate()) + '/' + p2(dt.getMonth() + 1) + '/' + String(dt.getFullYear()).slice(2);
  };
  const pointille = (v: unknown, n = 30) => (String(v ?? '').trim() ? `<u>&nbsp;${esc(v)}&nbsp;</u>` : '.'.repeat(n));

  // Opération dominante → coche la bonne case (dépotage / enlèvement / autres).
  const ops = new Set(lignes.map((l) => String(l['typeOperation'] ?? '')));
  const coche = (actif: boolean) => (actif ? '☒' : '☐');
  const estDep = ops.has(OPERATIONS.DEPOTAGE) || ops.has(OPERATIONS.VEHICULE);
  const estEnl = ops.has(OPERATIONS.ENLEVEMENT);

  // Récapitulatif des conteneurs par taille : « … de 2 TC de 40' et 1 TC de 20' ».
  const parTaille: Record<string, number> = {};
  let nbTC = 0;
  for (const l of lignes) {
    for (const ct of (l['conteneurs'] as Record<string, unknown>[]) ?? []) {
      const t = String(ct['taille'] ?? '?').replace(/['’\s]/g, '') || '?';
      parTaille[t] = (parTaille[t] ?? 0) + 1;
      nbTC++;
    }
  }
  const recapTC = Object.entries(parTaille).map(([t, n]) => `${n} TC de ${t}`).join(' et ') || '—';

  // Marchandise dénombrée : colis + désignation (dédupliqués sur l'ensemble).
  const colis = lignes.map((l) => String(l['nbColis'] ?? '').trim()).filter(Boolean);
  const desig = [...new Set(lignes.map((l) => String(l['descriptionMarchandise'] ?? '').trim()).filter(Boolean))];
  const denombre = [colis.join(' + '), desig.join(' / ')].filter(Boolean).join(' ');

  // CHARGEMENT MIXTE — l'agent qui contrôle le camion sur le terrain y trouvera
  // des conteneurs ABSENTS de ce tableau (ils relèvent d'une autre déclaration).
  // Le signaler sur l'acte évite de faire constater un écart qui n'en est pas un.
  const mixtes = lignes
    .filter((l) => ((l['autresDeclarations'] as Record<string, unknown>[]) ?? []).length)
    .map((l) => {
      const a = (l['autresDeclarations'] as Record<string, unknown>[]).map(
        (x) => `${String(x['libelle'])} (${String(x['nbConteneurs'])} TC)`).join(', ');
      return `${String(l['numeroCamion'])} — ${a}`;
    });

  const rapports = [...new Set(lignes.map((l) => String(l['rapportId'] ?? '')).filter(Boolean))].join(' / ');
  const agents = [...new Set(lignes.map((l) => String(l['agentCfs'] ?? '').trim()).filter(Boolean))].join(', ');
  const dateOp = jour(lignes[0]?.['dateCreation']);

  // Tableau : une ligne PAR CONTENEUR (le n° de camion se répète).
  const rows = lignes.flatMap((l) => {
    const conts = (l['conteneurs'] as Record<string, unknown>[]) ?? [];
    const scam = (l['scellesCamion'] as string[]) ?? [];
    // v4 — camion d'EFFETS DIVERS : pas de conteneur propre → une ligne avec la
    // désignation à la place du n° de TC (les véhicules sans TC restent hors tableau).
    if (!conts.length && !l['vehicule'] && (String(l['descriptionMarchandise'] ?? '').trim() || scam.length))
      return [`<tr><td>${esc(String(l['descriptionMarchandise'] ?? '').trim() || 'EFFETS DIVERS')}</td><td>—</td><td>${esc(l['numeroCamion'])}</td><td>${esc(scam.join(' · '))}</td></tr>`];
    return conts.map((ct, i) => {
      // Dépotage : scellés au camion (affichés sur la 1re ligne). Enlèvement : par conteneur.
      const plombs = String(l['typeOperation']) === OPERATIONS.ENLEVEMENT
        ? String(ct['plomb'] ?? '')
        : (i === 0 ? scam.join(' · ') : '');
      return `<tr><td class="tc">${esc(ct['num'])}</td><td>${esc(ct['taille']) || '—'}</td><td>${esc(l['numeroCamion'])}</td><td>${esc(plombs) || '—'}</td></tr>`;
    });
  }).join('');

  const html = `<!doctype html><html lang="fr"><meta charset="utf-8">
<title>Ordre d'exécution — déclaration ${esc(d['numeroDeclaration'])}</title>
<style>
  /* ------------------------------------------------------------------
     Mise en page d'un ACTE ADMINISTRATIF : pas de couleur, un seul corps
     de texte sérif, une graisse pour hiérarchiser, et des interlignes
     assez larges pour que les mentions manuscrites tiennent à la main.
     Les unités sont en POINTS (pt) : à l'impression, un mm reste un mm,
     alors qu'un px dépend du zoom du navigateur.
     ------------------------------------------------------------------ */
  /* Mesuré : le gabarit tient sur UNE page jusqu'à ~7 conteneurs (~5 quand la
     mention de chargement mixte s'ajoute). Au-delà, le tableau déborde
     proprement sur la page suivante, entêtes répétées. Les valeurs de corps et
     d'interligne sont calées là-dessus — les réduire nuirait à la lisibilité
     d'un acte administratif, les augmenter ferait déborder un ordre ordinaire. */
  @page { size: A4; margin: 13mm 18mm 12mm; }
  html { -webkit-print-color-adjust: exact; }
  body {
    font-family: "Times New Roman", "Liberation Serif", Georgia, serif;
    color: #000; font-size: 10.5pt; line-height: 1.45; margin: 0;
    text-align: justify; text-justify: inter-word;
  }

  /* En-tête : timbre de l'administration à gauche, État à droite, tous
     deux centrés dans leur colonne et alignés sur la même ligne de base. */
  .head { display: flex; justify-content: space-between; align-items: flex-start; gap: 10mm; margin-bottom: 3mm; }
  .head > div { flex: 1; }
  .head .g { text-align: center; font-size: 8pt; font-weight: bold; text-transform: uppercase; line-height: 1.3; letter-spacing: .02em; }
  .head .g hr { border: 0; border-top: .6pt solid #000; width: 44%; margin: .8mm auto; }
  .head .d { text-align: center; font-size: 9.5pt; line-height: 1.4; }
  .head .d b { font-size: 11pt; letter-spacing: .06em; display: block; }
  .head .d i { font-size: 9pt; }

  /* Intitulé de l'acte : centré, espacé, souligné — jamais coupé d'une page. */
  h1 { text-align: center; font-size: 13.5pt; font-weight: bold; letter-spacing: .2em;
       margin: 3mm 0 1mm; text-decoration: underline; text-underline-offset: 4pt;
       page-break-after: avoid; }
  .num { text-align: center; font-size: 9.5pt; margin: 0 0 4.5mm; letter-spacing: .02em; }

  /* Corps : chaque mention est une ligne aérée, jamais coupée en fin de page. */
  .l { margin: 0 0 2.3mm; page-break-inside: avoid; }
  .l.center { text-align: center; }
  .sec { font-weight: bold; text-decoration: underline; text-underline-offset: 3pt;
         letter-spacing: .04em; font-size: 10pt; }
  .sig { display: flex; justify-content: space-between; gap: 10mm; margin: 3.5mm 0 1.5mm; }

  /* Observations & signature du chef brigade : espace LIBRE, sans cadre
     (décision utilisateur) — la mention manuscrite et le cachet se posent à
     main levée, un cadre imprimé les contraignait. */
  .zone { min-height: 16mm; padding: 1.6mm 0; margin-bottom: 3mm; }

  /* Tableau des conteneurs : centré, entêtes répétées à chaque page. */
  table { border-collapse: collapse; width: 100%; margin: 3mm 0 2.5mm; page-break-inside: auto; }
  thead { display: table-header-group; }
  tr { page-break-inside: avoid; }
  th, td { border: .6pt solid #000; padding: 1.3mm 2mm; font-size: 10pt;
           text-align: center; vertical-align: middle; }
  th { font-weight: bold; letter-spacing: .03em; }
  td.tc { font-family: "Courier New", monospace; font-size: 9.5pt; letter-spacing: .04em; }

  /* Emplacements de signature : de la place, et un trait pour signer. */
  .signatures { display: flex; justify-content: space-around; gap: 12mm; margin-top: 3mm; page-break-inside: avoid; }
  .signatures div { flex: 1; text-align: center; }
  .signatures .rule { border-top: .6pt solid #000; margin-top: 15mm; padding-top: 1.2mm; font-size: 9.5pt; }

  .blank { display: inline-block; border-bottom: .6pt dotted #000; min-width: 18mm; }
  .nb { font-size: 8.5pt; font-style: italic; margin-top: 3mm; text-align: left; }
</style>
<div class="head">
  <div class="g">
    Commissariat Général<hr>
    Commissariat des Douanes<br>et Droits Indirects<hr>
    Direction des Opérations<br>Douanières de Lomé Port<hr>
    Division des Opérations<br>Douanières Lomé-Port 4<hr>
    Section Brigade PIA
  </div>
  <div class="d"><b>REPUBLIQUE TOGOLAISE</b><i>Travail — Liberté — Patrie</i></div>
</div>

<h1>ORDRE D'EXÉCUTION</h1>
<div class="num">N° ${pointille(rapports, 14)}/${esc(String(d['anneeDeclaration'] ?? new Date().getFullYear()))}/OTR/CG/CDDI/DODLP/DODLP 4</div>

<div class="l">Il est ordonné aux agents <span class="blank" style="min-width:65%"></span></div>
<div class="l">Avec toutes responsabilités d'assister effectivement à l'opération ci-après : ${pointille(estDep ? 'Dépotage' : 'Enlèvement', 24)}</div>
<div class="l">Date : ${pointille(dateOp, 10)} &nbsp; Lieu : <u>&nbsp;PIA&nbsp;</u> &nbsp; Déclaration : Type ${pointille(d['typeDeclaration'], 6)} &nbsp; N° ${pointille(d['numeroDeclaration'], 12)} du ${pointille(jour((r.apurement as Record<string, unknown> | null)?.['dateDeclaration']), 10)}</div>
<div class="l">Déclarant : ${pointille(d['declarant'], 22)} &nbsp; Tél : ${pointille(lignes[0]?.['contactDeclarant'], 14)} &nbsp; Destination m/ses : ${pointille(lignes[0]?.['destinationMarchandise'], 14)}</div>

<div class="sig"><span class="sec">OBSERVATIONS OU CONSIGNES</span><span class="sec">LE CHEF BRIGADE PIA</span></div>
<div class="zone">${esc([...new Set(lignes.map((l) => String(l['observationsCfs'] ?? '').trim()).filter(Boolean))].join(' · '))}</div>

<div class="l">Le <span class="blank"></span> de <span class="blank" style="min-width:9mm"></span> h <span class="blank" style="min-width:9mm"></span> à <span class="blank" style="min-width:9mm"></span> h <span class="blank" style="min-width:9mm"></span></div>
<div class="l">Nous soussignés ${pointille(agents, 60)}</div>
<div class="l">En service à la Section de la Brigade des Douanes de Lomé-Port,</div>
<div class="l">Reconnaissons avoir exécuté l'ordre ci-dessus. Nous faisons état de ce qui suit :</div>
<div class="l">Avons suivi ${coche(estDep)} le dépotage &nbsp; ${coche(estEnl)} l'enlèvement &nbsp; ${coche(!estDep && !estEnl)} autres : <span class="blank"></span> de ${pointille(recapTC, 22)}</div>
<div class="l">et avons dénombré / disant contenir : ${pointille(denombre, 60)}</div>

<table>
  <thead><tr><th style="width:30%">Numéros TC</th><th style="width:12%">Type</th><th style="width:30%">Numéro du camion</th><th style="width:28%">Plombs</th></tr></thead>
  <tbody>${rows}</tbody>
</table>

${mixtes.length ? `<div class="l"><b>Chargement mixte</b> — les camions suivants portent également des conteneurs relevant d'une autre déclaration, non repris au tableau ci-dessus : ${esc(mixtes.join(' ; '))}.</div>` : ''}
<div class="l">Autres mentions : <span class="blank" style="min-width:66%"></span></div>

<div class="sec" style="display:block; text-align:center; margin-top:7mm">Noms et signatures des agents</div>
<div class="signatures">
  <div><div class="rule">Agent</div></div>
  <div><div class="rule">Agent</div></div>
  <div><div class="rule">Le Chef de Brigade</div></div>
</div>

<div class="nb">NB : Biffer les mentions inutiles.</div>
</html>`;

  return {
    html,
    filename: 'OrdreExecution_' + String(d['numeroDeclaration'] ?? '') + '.html',
    compte: { ...(r.compte as Record<string, unknown>), conteneurs: nbTC },
  };
}

export async function rapportListe(ctx: Ctx, p: Record<string, unknown>) {
  const cargos = await loadCargos(ctx);
  const aoa: unknown[][] = [['ID', 'Date', 'Camion', 'Opération', 'Statut', 'N° GPS', 'Agent CFS', 'Date sortie']];
  for (const c of cargos) {
    if (p['statut'] && c['statut'] !== p['statut']) continue;
    aoa.push([c['id'], c['dateCreation'], c['numeroCamion'], c['typeOperation'], c['statut'], c['numeroGps'], c['agentCfs'], c['dateSortie']]);
  }
  return fichier('Cargaisons', String(p['format'] || 'xlsx'), [{ nom: 'Cargaisons', aoa }]);
}

/* ============================== Historique ============================ */

export async function listerHistorique(ctx: Ctx, opts: Record<string, unknown>) {
  const page = Math.max(1, Number(opts['page'] || 1));
  const pageSize = Math.min(200, Number(opts['pageSize'] || 50));
  let q = ctx.db.from('audit_log').select('*', { count: 'exact' });
  // SEC-05 — Les connexions étaient TOUJOURS exclues (« bruit »), ce qui rendait
  // impossible de répondre à « qui s'est connecté cette nuit, depuis quelle
  // adresse ». Elles restent masquées PAR DÉFAUT pour ne pas noyer la lecture
  // métier, mais l'administrateur peut désormais les afficher.
  if (opts['avecConnexions'] !== true) q = q.not('action', 'ilike', '%connexion%');
  if (opts['username']) q = q.eq('username', String(opts['username']).toLowerCase());
  if (opts['action']) q = q.eq('action', String(opts['action'])); // filtre par événement
  if (opts['du']) q = q.gte('ts', String(opts['du']) + 'T00:00:00');
  if (opts['au']) q = q.lte('ts', String(opts['au']) + 'T23:59:59');
  // Tri par horodatage réel (puis id) : les entrées historiques importées
  // s'intercalent à leur vraie date, pas à leur ordre d'insertion.
  q = q.order('ts', { ascending: false }).order('id', { ascending: false }).range((page - 1) * pageSize, page * pageSize - 1);
  const { data, error, count } = await q;
  if (error) throw new Error(error.message);
  const rows = (data ?? []).map((r) => ({
    timestamp: new Date(r.ts).toISOString().slice(0, 19).replace('T', ' '),
    username: r.username, nomComplet: r.nom_complet, role: r.role, action: r.action, cargaisonId: r.cargaison_id, details: r.details,
  }));
  const total = count ?? rows.length;
  return { rows, total, page, pages: Math.max(1, Math.ceil(total / pageSize)) };
}

/**
 * Export du journal d'audit.
 *
 * ⚠ Corrigé le 2026-08-10 : l'appel demandait `pageSize: 100000`, mais
 * `listerHistorique` plafonne à 200 (`Math.min(200, …)`). L'export ne contenait
 * donc QUE LES 200 DERNIÈRES LIGNES, en silence — pour un journal d'audit dont
 * l'archivage hors base est justement la parade au risque de réécriture
 * (SEC-04), c'était le pire endroit où tronquer. On pagine désormais réellement.
 */
export async function rapportHistorique(ctx: Ctx, p: Record<string, unknown>) {
  const aoa: unknown[][] = [['Horodatage', 'Utilisateur', 'Nom', 'Rôle', 'Action', 'Cargaison', 'Détails']];
  const BLOC = 200; // plafond dur de listerHistorique
  const MAX_LIGNES = 200_000; // garde-fou mémoire (l'Edge Function n'est pas extensible)
  for (let page = 1; aoa.length <= MAX_LIGNES; page++) {
    const lot = await listerHistorique(ctx, { ...p, pageSize: BLOC, page });
    const rows = lot.rows as Record<string, unknown>[];
    rows.forEach((r) => aoa.push([r['timestamp'], r['username'], r['nomComplet'], r['role'], r['action'], r['cargaisonId'], r['details']]));
    if (rows.length < BLOC || page >= lot.pages) break;
  }
  await ctx.log('Export historique', '', `${aoa.length - 1} ligne(s)`);
  return fichier('Historique', String(p['format'] || 'xlsx'), [{ nom: 'Historique', aoa }]);
}
