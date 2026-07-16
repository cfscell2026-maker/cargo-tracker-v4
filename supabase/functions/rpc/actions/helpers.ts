/**
 * ============================================================================
 *  Helpers d'accès aux données pour les actions d'écriture.
 *  Concurrence : les LockService de la v3.6 sont remplacés par une
 *  CONCURRENCE OPTIMISTE sur derniere_maj (relire → valider → écrire si inchangé).
 *  Les compteurs (fn_next_ref) et l'apurement (fn_apurer_inc) sont atomiques en SQL.
 * ============================================================================
 */
import type { Ctx } from '../ctx.ts';
import { versCamel } from '../ctx.ts';
import {
  APP, DEFAUTS, STOCK_STATUTS,
  declKey, maj, type Declaration,
} from '../../_shared/domaine/src/index.ts';

/** Ligne cargaison brute (snake_case) + accès camelCase pour la logique. */
export interface CargoRow {
  raw: Record<string, unknown>;
  o: Record<string, unknown>; // camelCase (dates ISO)
}

/** Génère un ID/rapport séquentiel atomique (CT-YYYY-000123 / RPT-YYYY-000045). */
export async function nextRef(ctx: Ctx, cle: 'SEQ' | 'SEQ_RPT', prefix: string): Promise<string> {
  const { data, error } = await ctx.db.rpc('fn_next_ref', { p_cle: cle, p_prefix: prefix });
  if (error) throw new Error(error.message);
  return String(data);
}
export const nextId = (ctx: Ctx) => nextRef(ctx, 'SEQ', APP.ID_PREFIX);
export const nextRapportId = (ctx: Ctx) => nextRef(ctx, 'SEQ_RPT', APP.RPT_PREFIX);

/**
 * v4 — Récupère TOUTES les lignes d'une table/vue en paginant par blocs.
 * PostgREST plafonne une requête à ~1000 lignes ; au-delà (données migrées :
 * 5000+ cargaisons, 6000+ conteneurs) un simple `.select('*')` est SILENCIEUSEMENT
 * tronqué — et les listes, stats et rapports qui en dérivent aussi. On boucle
 * donc sur `.range()` jusqu'à épuisement.
 */
export async function fetchAll(
  ctx: Ctx,
  table: string,
  select = '*',
  order?: { colonne: string; ascendant?: boolean },
): Promise<Record<string, unknown>[]> {
  const BLOC = 1000;
  const out: Record<string, unknown>[] = [];
  for (let debut = 0; ; debut += BLOC) {
    let q = ctx.db.from(table).select(select);
    if (order) q = q.order(order.colonne, { ascending: order.ascendant !== false });
    const { data, error } = await q.range(debut, debut + BLOC - 1);
    if (error) throw new Error(error.message);
    const lot = (data ?? []) as Record<string, unknown>[];
    out.push(...lot);
    if (lot.length < BLOC) break;
  }
  return out;
}

/** Lecture d'une cargaison ; lève « Cargaison introuvable : id » (v3.6). */
export async function getCargo(ctx: Ctx, id: string): Promise<CargoRow> {
  const { data, error } = await ctx.db.from('cargaisons').select('*').eq('id', id).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error('Cargaison introuvable : ' + id);
  return { raw: data, o: versCamel(data) };
}

/**
 * Écrit un patch (snake_case) sur une cargaison avec concurrence optimiste :
 * l'écriture n'aboutit que si derniere_maj n'a pas changé depuis la lecture.
 * Positionne derniere_maj = now(). Lève si un autre agent a modifié entre-temps.
 */
export async function patchCargo(
  ctx: Ctx,
  cargo: CargoRow,
  patch: Record<string, unknown>,
): Promise<void> {
  const now = new Date().toISOString();
  const prev = cargo.raw['derniere_maj'];
  const q = ctx.db.from('cargaisons').update({ ...patch, derniere_maj: now }).eq('id', cargo.raw['id']);
  const { data, error } = (prev == null
    ? await q.is('derniere_maj', null).select('id')
    : await q.eq('derniere_maj', prev).select('id'));
  if (error) throw new Error(error.message);
  if (!data || data.length === 0)
    throw new Error('Modification concurrente détectée. Rechargez la cargaison et réessayez.');
  cargo.raw['derniere_maj'] = now;
}

/** Insère une ou plusieurs lignes dans la table normalisée « Conteneurs ». */
export async function ajouterConteneurs(
  ctx: Ctx,
  rapportId: string,
  cargaisonId: string,
  numeroCamion: string,
  type: string,
  conteneurs: { num: string; plomb?: string; taille?: string; type?: string; poids?: string; extra?: { nom: string; valeur: string }[] }[],
  ordreDepart = 1,
): Promise<void> {
  if (!conteneurs.length) return;
  const now = new Date().toISOString();
  const rows = conteneurs.map((ct, i) => ({
    rapport_id: rapportId,
    cargaison_id: cargaisonId,
    numero_camion: numeroCamion,
    type_operation: type,
    ordre: ordreDepart + i,
    conteneur: ct.num,
    scelle: ct.plomb ?? '',
    taille: ct.taille ?? '',
    type_conteneur: ct.type ?? '',
    poids: ct.poids ?? '',
    champs_libres: (ct.extra ?? []).map((e) => e.nom + '=' + e.valeur).join(' ; '),
    date_creation: now,
  }));
  const { error } = await ctx.db.from('conteneurs').insert(rows);
  if (error) throw new Error(error.message);
}

export async function supprimerConteneursDe(ctx: Ctx, cargaisonId: string): Promise<void> {
  const { error } = await ctx.db.from('conteneurs').delete().eq('cargaison_id', cargaisonId);
  if (error) throw new Error(error.message);
}

export async function renommerCamionConteneurs(ctx: Ctx, cargaisonId: string, nouveau: string): Promise<void> {
  const { error } = await ctx.db.from('conteneurs').update({ numero_camion: nouveau }).eq('cargaison_id', cargaisonId);
  if (error) throw new Error(error.message);
}

/** Marque un TC du stock « Dépoté » et le lie à la cargaison (_lierStock_). */
export async function lierStock(ctx: Ctx, tc: string, cargaisonId: string): Promise<void> {
  const { error } = await ctx.db.rpc('fn_lier_stock', { p_tc: tc, p_cargaison_id: cargaisonId });
  if (error) throw new Error(error.message);
}

/** Conteneur du stock UTILISABLE (présent, pas encore dépoté) → objet ou null. */
export async function stockDisponible(ctx: Ctx, numeroTC: string): Promise<Record<string, unknown> | null> {
  const tc = String(numeroTC || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const { data, error } = await ctx.db.from('stock').select('*').eq('numero_tc', tc).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return null;
  return data.statut === STOCK_STATUTS.DEPOTE ? null : versCamel(data);
}

/* -------------------------- Déclarations / apurement ------------------- */

export interface LookupDecl {
  exists: boolean;
  cle: string;
  declarant?: string;
  nombreConteneurs: number;
  apures: number;
  restant: number;
}

export async function lookupDeclaration(ctx: Ctx, decl: Partial<Declaration>): Promise<LookupDecl> {
  const cle = declKey(decl);
  const { data, error } = await ctx.db.from('declarations').select('*').eq('cle', cle).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return { exists: false, cle, nombreConteneurs: 0, apures: 0, restant: 0 };
  const nb = Number(data.nombre_conteneurs || 0);
  const ap = Number(data.conteneurs_apures || 0);
  return { exists: true, cle, declarant: data.declarant, nombreConteneurs: nb, apures: ap, restant: Math.max(0, nb - ap) };
}

/**
 * Crée/incrémente l'apurement d'une déclaration ; renvoie le restant.
 * 1re fois : exige `nombreConteneurs` (payload). Ensuite : incrément atomique.
 */
export async function majApurement(
  ctx: Ctx,
  decl: Partial<Declaration>,
  payloadNb: number | undefined,
  nbAjout: number,
): Promise<number> {
  const cle = declKey(decl);
  const found = await lookupDeclaration(ctx, decl);
  if (!found.exists) {
    const nbDecl = Number(payloadNb || 0);
    if (!nbDecl || nbDecl < 1) throw new Error('Nouvelle déclaration : indiquez le « nombre de conteneurs » déclarés.');
    const now = new Date().toISOString();
    const { error } = await ctx.db.from('declarations').insert({
      cle,
      annee_declaration: decl.anneeDeclaration ?? '',
      bureau_declaration: decl.bureauDeclaration ?? '',
      type_declaration: decl.typeDeclaration ?? '',
      numero_declaration: decl.numeroDeclaration ?? '',
      declarant: decl.declarant ?? '',
      nombre_conteneurs: nbDecl,
      conteneurs_apures: nbAjout,
      date_creation: now,
      derniere_maj: now,
    });
    if (error) throw new Error(error.message);
    return Math.max(0, nbDecl - nbAjout);
  }
  const { data, error } = await ctx.db.rpc('fn_apurer_inc', { p_cle: cle, p_nb: nbAjout });
  if (error) throw new Error(error.message);
  return Number(data ?? 0);
}

/** Apurement best-effort (v2.7) : n'interrompt jamais le flux. */
export async function majApurementSafe(ctx: Ctx, declLike: Partial<Declaration>, nbAjout: number): Promise<void> {
  try {
    if (!declLike || !declLike.numeroDeclaration) return;
    const found = await lookupDeclaration(ctx, declLike);
    if (found.exists) await majApurement(ctx, declLike, undefined, nbAjout);
    else await majApurement(ctx, declLike, nbAjout, nbAjout);
  } catch {
    /* best-effort */
  }
}

/** Déclaration de référence d'un conteneur (LOT D : n° par conteneur). */
export function declCont(src: Record<string, unknown> | undefined, parDefaut: Record<string, unknown>) {
  const s = src ?? {};
  return {
    numeroDeclaration: maj(s['numeroDeclaration'], 40) || maj(parDefaut['numeroDeclaration'], 40),
    anneeDeclaration: maj(s['anneeDeclaration'], 10) || maj(parDefaut['anneeDeclaration'], 10),
    bureauDeclaration: maj(s['bureauDeclaration'], 20) || maj(parDefaut['bureauDeclaration'], 20) || DEFAUTS.BUREAU_DECLARATION,
    typeDeclaration: maj(s['typeDeclaration'], 10) || maj(parDefaut['typeDeclaration'], 10) || DEFAUTS.TYPE_DECLARATION,
    declarant: maj(parDefaut['declarant'], 120),
  };
}

/* -------------------------------- Signature ---------------------------- */

/** Empreinte courte (SHA-256, 16 hex MAJ) faisant office de signature (v3.0). */
export async function signature(base: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(base));
  const hex = Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
  return hex.slice(0, 16).toUpperCase();
}
