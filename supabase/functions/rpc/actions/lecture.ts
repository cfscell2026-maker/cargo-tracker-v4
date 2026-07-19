/**
 * ============================================================================
 *  Actions de LECTURE — transcription fidèle de Data.gs (v3.6) :
 *  _rechercher_, _getCargo_/cargo.get (+_filtrerConfidentiel_), _listerCargaisons_,
 *  _verifierDoublons_, _statistiques_, _listerEtatCFS_.
 * ============================================================================
 */
import type { Ctx } from '../ctx.ts';
import { versCamel } from '../ctx.ts';
import { fetchAll } from './helpers.ts';
import {
  STATUTS,
  APP,
  VOIENT_HORSGABARIT,
  etapesEnAttente,
  estOui,
  aFait,
  normAlphaNum,
  type Role,
} from '../../_shared/domaine/src/index.ts';

/** Résumé (v_cargaisons_resume) en camelCase — équivalent RESUME_KEYS. */
async function chargerResume(ctx: Ctx): Promise<Record<string, unknown>[]> {
  // fetchAll : pagine pour ne PAS tronquer au-delà de ~1000 lignes (5000+ migrées).
  const data = await fetchAll(ctx, 'v_cargaisons_resume', '*', { colonne: 'date_creation', ascendant: false });
  return data.map((r) => versCamel(r));
}

function ts(v: unknown): number {
  if (!v) return 0;
  const d = v instanceof Date ? v : new Date(String(v));
  return isNaN(d.getTime()) ? 0 : d.getTime();
}

/* ------------------------------ cargo.get ------------------------------ */

/** v3.0/v3.2 — retire les champs CONFIDENTIELS si la session n'y a pas droit. */
export function filtrerConfidentiel<T extends Record<string, unknown>>(obj: T, role: Role): T {
  if (VOIENT_HORSGABARIT.indexOf(role) === -1) {
    delete (obj as Record<string, unknown>)['horsGabarit'];
    delete (obj as Record<string, unknown>)['hauteurChargement'];
  }
  return obj;
}

export async function cargoGet(ctx: Ctx, data: { id?: string }) {
  const id = String(data.id ?? '').trim();
  const { data: row, error } = await ctx.db.from('cargaisons').select('*').eq('id', id).maybeSingle();
  if (error) throw new Error(error.message);
  if (!row) throw new Error('Cargaison introuvable : ' + id);
  return filtrerConfidentiel(versCamel(row), ctx.session.role);
}

/* ----------------------------- cargo.search ---------------------------- */

/** Recherche LIMITÉE au N° de camion, très flexible (normalisation des 2 côtés). */
export async function cargoSearch(ctx: Ctx, data: { valeur?: string }) {
  const q = normAlphaNum(data.valeur);
  if (!q) return [];
  const all = await chargerResume(ctx);
  const res: Record<string, unknown>[] = [];
  for (const r of all) {
    const norm = normAlphaNum(r['numeroCamion']);
    if (norm && norm.indexOf(q) > -1) res.push(r);
    if (res.length >= 200) break;
  }
  res.sort((a, b) => ts(b['dateCreation']) - ts(a['dateCreation']));
  return res;
}

/* ------------------------------ cargo.list ----------------------------- */

export async function cargoList(
  ctx: Ctx,
  opts: { statut?: string; etape?: string; categorie?: string; page?: number; pageSize?: number; search?: string },
) {
  const statut = opts.statut || 'tous';
  const etape = opts.etape || '';
  const categorie = opts.categorie || 'camion';
  const page = Math.max(1, Number(opts.page || 1));
  const pageSize = Math.min(200, Number(opts.pageSize || APP.PAGE_SIZE));
  const search = String(opts.search ?? '').trim().toLowerCase();

  let all = await chargerResume(ctx);

  if (etape) {
    // File d'attente d'une cellule (modèle parallèle : un camion post-T1 figure
    // À LA FOIS dans la file Balise et Bon de Sortie).
    all = all.filter((r) => etapesEnAttente(r as never).indexOf(etape as never) >= 0);
    if (etape === 'BALISE') all = all.filter((r) => !estOui(r['estVehicule']));
  } else {
    // Les véhicules sont suivis à part : on ne les mélange pas aux camions.
    all = all.filter((r) => (categorie === 'vehicule' ? estOui(r['estVehicule']) : !estOui(r['estVehicule'])));
  }
  if (statut !== 'tous') all = all.filter((r) => r['statut'] === statut);
  if (search) {
    all = all.filter((r) =>
      [r['id'], r['reference'], r['rapportId'], r['numeroCamion'],
        r['conteneur1'], r['conteneur2'], r['conteneur3'], r['conteneur4'], r['numeroGps']]
        .some((x) => String(x ?? '').toLowerCase().indexOf(search) > -1),
    );
  }
  all.sort((a, b) => ts(b['dateCreation']) - ts(a['dateCreation']));

  const total = all.length;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const start = (page - 1) * pageSize;
  return { rows: all.slice(start, start + pageSize), total, page, pages };
}

/* ---------------------------- cargo.checkdup --------------------------- */

/** Détection de doublons (AVERTISSEMENT, jamais bloquant) à la saisie. */
export async function cargoCheckdup(
  ctx: Ctx,
  p: { numeroCamion?: string; conteneurs?: string[]; excludeId?: string },
) {
  const exclude = String(p.excludeId ?? '').trim();
  const numCam = normAlphaNum(p.numeroCamion);
  const conts = (Array.isArray(p.conteneurs) ? p.conteneurs : []).map(normAlphaNum).filter(Boolean);

  const res: { camion: unknown[]; conteneurs: Record<string, unknown[]> } = { camion: [], conteneurs: {} };
  for (const k of conts) res.conteneurs[k] = [];

  const resume = await chargerResume(ctx);
  const infoById: Record<string, { id: string; statut: string; dateCreation: unknown; numeroCamion: string; actif: boolean }> = {};
  for (const r of resume) {
    const id = String(r['id']);
    infoById[id] = {
      id,
      statut: String(r['statut'] ?? ''),
      dateCreation: r['dateCreation'],
      numeroCamion: String(r['numeroCamion'] ?? ''),
      actif: r['statut'] !== STATUTS.SORTIE,
    };
    if (id === exclude || !numCam) continue;
    if (normAlphaNum(r['numeroCamion']) === numCam) res.camion.push(infoById[id]);
  }

  if (conts.length) {
    const { data, error } = await ctx.db
      .from('conteneurs')
      .select('cargaison_id, conteneur, numero_camion')
      .in('conteneur', conts);
    if (error) throw new Error(error.message);
    for (const row of data ?? []) {
      const cid = String(row.cargaison_id);
      if (cid === exclude) continue;
      const cn = normAlphaNum(row.conteneur);
      if (!cn || res.conteneurs[cn] === undefined) continue;
      const info = infoById[cid] ?? {
        id: cid, statut: '', dateCreation: '', numeroCamion: row.numero_camion, actif: false,
      };
      res.conteneurs[cn].push({ ...info, conteneur: row.conteneur });
    }
  }

  res.camion.sort((a, b) => ts((b as Record<string, unknown>)['dateCreation']) - ts((a as Record<string, unknown>)['dateCreation']));
  for (const k of Object.keys(res.conteneurs))
    res.conteneurs[k]!.sort((a, b) => ts((b as Record<string, unknown>)['dateCreation']) - ts((a as Record<string, unknown>)['dateCreation']));
  return res;
}

/* --------------------------- dashboard.stats --------------------------- */

function memeJourLocal(v: unknown, ref: Date): boolean {
  if (!v) return false;
  const d = v instanceof Date ? v : new Date(String(v));
  if (isNaN(d.getTime())) return false;
  return d.getFullYear() === ref.getFullYear() && d.getMonth() === ref.getMonth() && d.getDate() === ref.getDate();
}

export async function dashboardStats(ctx: Ctx, opts: { du?: string; au?: string }) {
  const stats = {
    total: 0, camion: 0, chargement: 0, sortie: 0, aujourdHui: 0,
    attValidation: 0, attT1: 0, attBalise: 0, attBs: 0, attPP: 0,
    creee: 0, t1: 0, gps: 0, bs: 0, // alias compat libellés client
    vehiculesAttente: 0, vehiculesSortis: 0,
  };
  const du = opts.du ? new Date(opts.du + 'T00:00:00') : null;
  const auJ = opts.au ? new Date(opts.au + 'T00:00:00') : null;
  const auEx = auJ ? new Date(auJ.getTime() + 86400000) : null; // borne haute exclusive

  const data = await chargerResume(ctx);
  const today = new Date();
  for (const r of data) {
    if (du || auEx) {
      const d = r['dateCreation'] ? new Date(String(r['dateCreation'])) : null;
      if (!d || isNaN(d.getTime())) continue;
      if (du && d < du) continue;
      if (auEx && d >= auEx) continue;
    }
    if (estOui(r['estVehicule'])) {
      if (r['statut'] === STATUTS.SORTIE) stats.vehiculesSortis++;
      else stats.vehiculesAttente++;
      continue;
    }
    stats.total++;
    if (r['statut'] === STATUTS.CAMION) stats.camion++;
    else if (r['statut'] === STATUTS.CHARGEMENT) stats.chargement++;
    else if (r['statut'] === STATUTS.SORTIE) stats.sortie++;
    const pend = etapesEnAttente(r as never);
    if (pend.indexOf('VALIDATION') >= 0) stats.attValidation++;
    if (pend.indexOf('T1') >= 0) stats.attT1++;
    if (pend.indexOf('BALISE') >= 0) stats.attBalise++;
    if (pend.indexOf('BS') >= 0) stats.attBs++;
    if (pend.indexOf('PP') >= 0) stats.attPP++;
    if (memeJourLocal(r['dateCreation'], today)) stats.aujourdHui++;
  }
  stats.creee = stats.attT1; stats.t1 = stats.attBalise; stats.gps = stats.attBs; stats.bs = stats.attPP;
  return stats;
}

/* ----------------------------- etatcfs.list ---------------------------- */

/**
 * v4 — POINTAGE DES CAMIONS À LA SORTIE (ex-« état des camions », v3.5).
 * Situation du PARKING : camions ET véhicules-châssis encore présents, en
 * DÉFALQUANT (décision utilisateur 2026-07-16) :
 *   - ceux qui ont déjà PRIS LA BALISE (datePoseGps renseignée) ;
 *   - ceux SORTIS à la PP (statut « Sortie Enregistrée »).
 * NB : on teste datePoseGps (acte physique de prise de balise) et NON
 * etatCellules().balise, qui compte les véhicules et les dispenses comme
 * « faits » alors qu'ils sont toujours au parking.
 */
export async function etatCfsList(ctx: Ctx) {
  const out = {
    rows: [] as unknown[],
    compte: { total: 0, camions: 0, vehicules: 0, enCours: 0, fin: 0, vide: 0, np: 0 },
  };
  const data = await chargerResume(ctx);
  for (const r of data) {
    if (r['statut'] === STATUTS.SORTIE) continue; // sorti à la PP → défalqué
    if (aFait(r['datePoseGps'])) continue; // a déjà pris la balise → défalqué
    out.compte.total++;
    const veh = estOui(r['estVehicule']);
    if (veh) out.compte.vehicules++;
    else out.compte.camions++;
    const e = String(r['etatSortie'] ?? '');
    if (e === 'En cours de chargement') out.compte.enCours++;
    else if (e === 'Fin de chargement') out.compte.fin++;
    else if (e === 'Vide') out.compte.vide++;
    else out.compte.np++;
    out.rows.push({
      id: r['id'], numeroCamion: r['numeroCamion'], typeOperation: r['typeOperation'],
      statut: r['statut'], etatSortie: e, estVehicule: veh,
    });
  }
  return out;
}
