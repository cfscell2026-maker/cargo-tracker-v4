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
  ROLES, STATUTS, OPERATIONS, TRANCHES_SEJOUR, SEUIL_ALERTE_SEJOUR,
  tailleBucket, evpDeTaille, trancheAge, parseConteneursDetails, estOui,
} from '../../_shared/domaine/src/index.ts';
import { fetchAll, lookupDeclaration } from './helpers.ts';

/* ------------------------------- Helpers ------------------------------- */

async function loadCargos(ctx: Ctx): Promise<Record<string, unknown>[]> {
  // fetchAll : pagine (5000+ cargaisons migrées) sinon les rapports sous-comptent.
  const data = await fetchAll(ctx, 'cargaisons', '*');
  return data.map((r) => versCamel(r));
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
/** Agent forcé à soi si la session tient le rôle de la cellule (cahier 3.4). */
function agentForce(ctx: Ctx, cfgRole: Role, pAgent: unknown): string {
  if (ctx.session.role === cfgRole) return lc(ctx.session.nomComplet);
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

/* ============================== CFS ==================================== */

interface AggCFS { camions: number; t20: number; t40: number; t45: number; autres: number; evp: number; conteneurs: number }
function aggVide(): AggCFS { return { camions: 0, t20: 0, t40: 0, t45: 0, autres: 0, evp: 0, conteneurs: 0 }; }

function collecteCFS(cargos: Record<string, unknown>[], du?: string, au?: string, agentLc?: string) {
  const parOp: Record<string, AggCFS> = { [OPERATIONS.ENLEVEMENT]: aggVide(), [OPERATIONS.DEPOTAGE]: aggVide() };
  const total = aggVide();
  const camions: Record<string, unknown>[] = [];
  const conteneurs: Record<string, unknown>[] = [];
  for (const c of cargos) {
    if (estOui(c['estVehicule'])) continue;
    if (!inRange(c['dateCreation'], du, au)) continue;
    if (agentLc && lc(c['agentCfs']) !== agentLc) continue;
    const op = String(c['typeOperation']);
    if (op !== OPERATIONS.ENLEVEMENT && op !== OPERATIONS.DEPOTAGE) continue;
    const a = parOp[op]!;
    a.camions++; total.camions++;
    camions.push({ id: c['id'], numeroCamion: c['numeroCamion'], typeOperation: op, statut: c['statut'], dateCreation: c['dateCreation'] });
    for (const ct of detsDeRow(c)) {
      const bk = tailleBucket(ct.taille); const ev = evpDeTaille(bk);
      (a as Record<string, number>)[bk]++; a.conteneurs++; a.evp += ev;
      (total as Record<string, number>)[bk]++; total.conteneurs++; total.evp += ev;
      conteneurs.push({ id: c['id'], numeroCamion: c['numeroCamion'], typeOperation: op, conteneur: ct.num, taille: ct.taille, bucket: bk });
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

function collecteVehicules(cargos: Record<string, unknown>[], du?: string, au?: string, agentLc?: string) {
  const compte = { total: 0, attente: 0, sortis: 0, conteneurs: 0 } as Record<string, number>;
  const parDest: Record<string, number> = {}; [...VEH_BUCKETS, 'Autres'].forEach((d) => (parDest[d] = 0));
  const vehicules: Record<string, unknown>[] = [];
  for (const c of cargos) {
    if (!estOui(c['estVehicule'])) continue;
    if (!inRange(c['dateCreation'], du, au)) continue;
    if (agentLc && lc(c['agentCfs']) !== agentLc) continue;
    compte.total++;
    if (c['statut'] === STATUTS.SORTIE) compte.sortis++; else compte.attente++;
    const vd = (c['vehiculeDetails'] ?? {}) as Record<string, unknown>;
    parDest[destBucket(vd['destination'])]++;
    if (Number(c['nbConteneurs'] || 0) > 0) compte.conteneurs++;
    vehicules.push({ id: c['id'], chassis: c['numeroCamion'], destination: vd['destination'], statut: c['statut'], dateCreation: c['dateCreation'] });
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
    a.camions++; total.camions++;
    if (estOui(c['twins']) || c['twins'] === 'Yes') { a.twins++; total.twins++; }
    if (String(c['baliseRequise']) === 'Non' || c['baliseRequise'] === false) { a.sansBalise++; total.sansBalise++; }
    camions.push({ id: c['id'], numeroCamion: c['numeroCamion'], typeOperation: op, statut: c['statut'], date: c[dateCol] });
    for (const ct of detsDeRow(c)) {
      const bk = tailleBucket(ct.taille); const ev = evpDeTaille(bk);
      (a as Record<string, number>)[bk]++; a.conteneurs++; a.evp += ev;
      (total as Record<string, number>)[bk]++; total.conteneurs++; total.evp += ev;
      conteneurs.push({ id: c['id'], numeroCamion: c['numeroCamion'], typeOperation: op, conteneur: ct.num, taille: ct.taille, bucket: bk });
    }
  }
  return { parOp, total, camions, conteneurs };
}

export async function rapportActivite(ctx: Ctx, p: Record<string, unknown>) {
  const cfg = cfgActivite(String(p['kind']));
  const agentLc = agentForce(ctx, cfg.role, p['agent']);
  const r = collecteActivite(await loadCargos(ctx), cfg.dateCol, cfg.agentCol, p['du'] as string, p['au'] as string, agentLc || undefined);
  if (p['format'] === 'xlsx' || p['format'] === 'pdf') {
    const recap: unknown[][] = [['Opération', 'Camions', 'Twins', 'Sans balise', 'Conteneurs', 'EVP']];
    for (const op of [OPERATIONS.ENLEVEMENT, OPERATIONS.DEPOTAGE]) {
      const a = r.parOp[op]!; recap.push([op, a.camions, a.twins, a.sansBalise, a.conteneurs, a.evp]);
    }
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
  if (metric === 'camions') return { titre: 'Camions', rows: r.camions.filter(filtreOp) };
  const conts = r.conteneurs.filter(filtreOp).filter((x) => ['t20', 't40', 't45', 'autres'].indexOf(metric) < 0 || x['bucket'] === metric);
  return { titre: metric in libTaille ? libTaille[metric] : 'Conteneurs', rows: conts };
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

/* ============================= Dispenses ============================== */

export async function rapportDispenses(ctx: Ctx, p: Record<string, unknown>) {
  const cargos = await loadCargos(ctx);
  const rows: Record<string, unknown>[] = [];
  let total = 0, enCours = 0, terminees = 0;
  for (const c of cargos) {
    const dispense = String(c['baliseRequise']) === 'Non' || c['baliseRequise'] === false || estOui(c['sauteBalise']);
    if (!dispense) continue;
    if (c['statut'] !== STATUTS.SORTIE && c['statut'] !== STATUTS.GPS && c['statut'] !== STATUTS.BS) {
      // dispense pertinente dès qu'elle est engagée dans le flux
    }
    if (!c['numeroDispense'] && !estOui(c['sauteBalise'])) continue;
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
  if (gran === 'mois') return d.toISOString().slice(0, 7);
  if (gran === 'semaine') return lundiDe(d).toISOString().slice(0, 10);
  return d.toISOString().slice(0, 10);
}

export async function rapportFlux(ctx: Ctx, p: Record<string, unknown>) {
  const gran = String(p['granularite'] || 'jour');
  const cargos = await loadCargos(ctx);
  const map: Record<string, { periode: string; cfsC: number; cfsT: number; baliseC: number; baliseT: number; ppC: number; ppT: number; sansBalise: number }> = {};
  const bump = (k: string | null) => { if (!k) return null; if (!map[k]) map[k] = { periode: k, cfsC: 0, cfsT: 0, baliseC: 0, baliseT: 0, ppC: 0, ppT: 0, sansBalise: 0 }; return map[k]; };
  for (const c of cargos) {
    if (estOui(c['estVehicule'])) continue;
    const nbT = detsDeRow(c).length;
    const kC = bump(periodeKey(c['dateCreation'], gran)); if (kC) { kC.cfsC++; kC.cfsT += nbT; }
    if (c['datePoseGps']) { const kB = bump(periodeKey(c['datePoseGps'], gran)); if (kB) { kB.baliseC++; kB.baliseT += nbT; if (String(c['baliseRequise']) === 'Non' || c['baliseRequise'] === false) kB.sansBalise++; } }
    if (c['dateSortie']) { const kP = bump(periodeKey(c['dateSortie'], gran)); if (kP) { kP.ppC++; kP.ppT += nbT; } }
  }
  const rows = Object.values(map).sort((a, b) => a.periode.localeCompare(b.periode));
  if (p['format'] === 'xlsx' || p['format'] === 'pdf') {
    const aoa: unknown[][] = [['Période', 'CFS camions', 'CFS conteneurs', 'Balise camions', 'Balise conteneurs', 'PP camions', 'PP conteneurs', 'Sans balise']];
    rows.forEach((r) => aoa.push([r.periode, r.cfsC, r.cfsT, r.baliseC, r.baliseT, r.ppC, r.ppT, r.sansBalise]));
    return fichier('Analyse_flux', String(p['format']), [{ nom: 'Flux', aoa }]);
  }
  return { granularite: gran, rows };
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

/* ===================== Bon de chargement / listes ===================== */

export async function rapportChargement(ctx: Ctx, id: string) {
  const { data, error } = await ctx.db.from('cargaisons').select('*').eq('id', id).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error('Cargaison introuvable : ' + id);
  const c = versCamel(data);
  const conts = detsDeRow(c);
  const esc = (v: unknown) => String(v ?? '').replace(/[&<>]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[m]!));
  const lignes = conts.map((ct, i) => `<tr><td>${i + 1}</td><td>${esc(ct.num)}</td><td>${esc(ct.plomb)}</td><td>${esc(ct.taille)}</td><td>${esc(ct.type)}</td></tr>`).join('');
  const html = `<!doctype html><html lang="fr"><meta charset="utf-8"><title>Bon de chargement ${esc(c['id'])}</title>
  <style>body{font-family:system-ui;padding:24px;color:#111}h1{font-size:18px}table{border-collapse:collapse;width:100%;margin-top:12px}td,th{border:1px solid #999;padding:6px;font-size:13px;text-align:left}.kv{margin:4px 0}</style>
  <h1>Bon de chargement — ${esc(c['id'])}</h1>
  <div class="kv"><b>Camion :</b> ${esc(c['numeroCamion'])} &nbsp; <b>Opération :</b> ${esc(c['typeOperation'])}</div>
  <div class="kv"><b>Déclarant :</b> ${esc(c['declarant'])} &nbsp; <b>Déclaration :</b> ${esc(c['numeroDeclaration'])}/${esc(c['anneeDeclaration'])} ${esc(c['bureauDeclaration'])} ${esc(c['typeDeclaration'])}</div>
  <div class="kv"><b>Destination :</b> ${esc(c['destinationMarchandise'])}</div>
  <table><thead><tr><th>#</th><th>Conteneur</th><th>Scellé</th><th>Taille</th><th>Type</th></tr></thead><tbody>${lignes}</tbody></table>
  <p style="margin-top:24px">Agent CFS : ${esc(c['agentCfs'])}</p></html>`;
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
    if (c['statut'] !== STATUTS.CREEE) continue; // fin de chargement UNIQUEMENT
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
      chargementMixte: estOui(c['chargementMixte']),
      scellesCamion: pd.scellesCamion,
      nbConteneurs: conts.length,
      conteneurs: conts.map((ct) => ({
        num: ct.num, plomb: ct.plomb, taille: ct.taille, type: ct.type, poids: ct.poids,
      })),
    };
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
  // Connexions / déconnexions = bruit : toujours exclues de l'historique métier.
  q = q.not('action', 'ilike', '%connexion%');
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

export async function rapportHistorique(ctx: Ctx, p: Record<string, unknown>) {
  const all = await listerHistorique(ctx, { ...p, pageSize: 100000, page: 1 });
  const aoa: unknown[][] = [['Horodatage', 'Utilisateur', 'Nom', 'Rôle', 'Action', 'Cargaison', 'Détails']];
  (all.rows as Record<string, unknown>[]).forEach((r) => aoa.push([r['timestamp'], r['username'], r['nomComplet'], r['role'], r['action'], r['cargaisonId'], r['details']]));
  return fichier('Historique', String(p['format'] || 'xlsx'), [{ nom: 'Historique', aoa }]);
}
