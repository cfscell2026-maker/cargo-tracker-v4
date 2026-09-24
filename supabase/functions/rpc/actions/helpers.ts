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
export async function nextRef(ctx: Ctx, cle: string, prefix: string): Promise<string> {
  const { data, error } = await ctx.db.rpc('fn_next_ref', { p_cle: cle, p_prefix: prefix });
  if (error) throw new Error(error.message);
  return String(data);
}
export const nextId = (ctx: Ctx) => nextRef(ctx, 'SEQ', APP.ID_PREFIX);
export const nextRapportId = (ctx: Ctx) => nextRef(ctx, 'SEQ_RPT', APP.RPT_PREFIX);

/**
 * v4, Récupère TOUTES les lignes d'une table/vue en paginant par blocs.
 * PostgREST plafonne une requête à ~1000 lignes ; au-delà (données migrées :
 * 5000+ cargaisons, 6000+ conteneurs) un simple `.select('*')` est SILENCIEUSEMENT
 * tronqué, et les listes, stats et rapports qui en dérivent aussi. On boucle
 * donc sur `.range()` jusqu'à épuisement.
 */
export async function fetchAll(
  ctx: Ctx,
  table: string,
  select = '*',
  order?: { colonne: string; ascendant?: boolean },
  // 2026-09-11 : FILTRE SQL OPTIONNEL. Certains rapports chargeaient la table
  // ENTIÈRE pour n'en garder qu'une poignée de lignes, ce qui faisait tuer le
  // worker par l'hébergeur (HTTP 546, « WORKER_RESOURCE_LIMIT »). Quand le tri
  // se laisse traduire en SQL, autant ne pas rapatrier le reste.
  //
  // ⚠ Un filtre passé ici doit être ÉQUIVALENT au tri JS qu'il précède, jamais
  // plus restrictif, sinon il fait disparaître des dossiers en silence, ce qui
  // est bien pire qu'une lenteur. Un filtre plus LARGE reste sans danger : le
  // tri JS qui suit tranche.
  // deno-lint-ignore no-explicit-any
  affiner?: (q: any) => any,
): Promise<Record<string, unknown>[]> {
  /* LENTEUR — 2026-09-24. Les blocs partaient UN PAR UN : quinze allers-retours
   * enchaînés pour 14 000 dossiers, soit l'essentiel des ~3,7 s mesurées sur
   * chaque liste. Le premier bloc rapporte le nombre total de lignes ; les
   * suivants partent alors EN PARALLÈLE, par vagues de EN_PARALLELE.
   *
   * ORDRE STABLE — condition de justesse, pas de confort. Sans `order by`,
   * PostgreSQL ne garantit pas le même ordre d'un bloc à l'autre : une ligne
   * modifiée par un agent PENDANT la pagination peut changer de place, et être
   * comptée deux fois ou pas du tout. On trie donc toujours, en dernier ressort,
   * sur la clé primaire. Paralléliser sans cela aggraverait le risque. */
  const BLOC = 1000;
  const EN_PARALLELE = 5;
  const cle = CLE_PRIMAIRE[table];
  const bloc = async (debut: number, avecCompte: boolean): Promise<{ lot: Record<string, unknown>[]; total: number | null }> => {
    // deno-lint-ignore no-explicit-any
    let q: any = ctx.db.from(table).select(select, avecCompte ? { count: 'exact' } : undefined);
    if (affiner) q = affiner(q);
    if (order) q = q.order(order.colonne, { ascending: order.ascendant !== false });
    if (cle && cle !== order?.colonne) q = q.order(cle, { ascending: true });
    const { data, error, count } = await q.range(debut, debut + BLOC - 1);
    if (error) throw new Error(error.message);
    return { lot: (data ?? []) as Record<string, unknown>[], total: typeof count === 'number' ? count : null };
  };

  const premier = await bloc(0, true);
  const out = [...premier.lot];
  if (premier.lot.length < BLOC) return out;

  let suivant = BLOC;
  if (premier.total !== null) {
    const debuts: number[] = [];
    for (let d = BLOC; d < premier.total; d += BLOC) debuts.push(d);
    for (let i = 0; i < debuts.length; i += EN_PARALLELE) {
      const vague = await Promise.all(debuts.slice(i, i + EN_PARALLELE).map((d) => bloc(d, false)));
      for (const v of vague) out.push(...v.lot);
    }
    suivant = BLOC * (debuts.length + 1);
    // Le dernier bloc n'était pas plein : tout est lu.
    if (out.length < suivant) return out;
  }
  // Total inconnu, ou lignes ajoutées depuis le comptage : on finit un par un.
  for (let debut = suivant; ; debut += BLOC) {
    const { lot } = await bloc(debut, false);
    out.push(...lot);
    if (lot.length < BLOC) break;
  }
  return out;
}

/**
 * Nombre de lignes d'une table, compté PAR LA BASE (`count` sans rapatrier une
 * seule ligne). À préférer à `fetchAll(...).length` dès qu'on ne veut qu'un total.
 */
export async function compter(
  ctx: Ctx,
  table: string,
  // deno-lint-ignore no-explicit-any
  affiner?: (q: any) => any,
): Promise<number> {
  // deno-lint-ignore no-explicit-any
  let q: any = ctx.db.from(table).select('*', { count: 'exact', head: true });
  if (affiner) q = affiner(q);
  const { count, error } = await q;
  if (error) throw new Error(error.message);
  return Number(count ?? 0);
}

/** Clé primaire des tables lues par `fetchAll` : dernier critère de tri, pour un ordre stable. */
const CLE_PRIMAIRE: Record<string, string> = {
  cargaisons: 'id', v_cargaisons_resume: 'id', conteneurs: 'id', declarations: 'cle',
  stock: 'numero_tc', stock_annonce: 'numero_tc',
  entrepots: 'code', entrepot_entrees: 'id', entrepot_sorties: 'id',
};

/**
 * Lecture d'une cargaison ; lève « Cargaison introuvable : id » (v3.6).
 *
 * SEC-12 : Une cargaison ANNULÉE (doublon de saisie retiré par un ADMIN) est
 * conservée en base pour ne pas détruire de pièce, mais elle n'est plus une
 * écriture vivante : toutes les actions d'écriture passant par ce point d'entrée
 * la refusent. La relecture pour consultation/audit passe par `cargoGet`.
 */
export async function getCargo(ctx: Ctx, id: string): Promise<CargoRow> {
  const { data, error } = await ctx.db.from('cargaisons').select('*').eq('id', id).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error('Cargaison introuvable : ' + id);
  if (data['annule'] === true)
    throw new Error('Cargaison annulée le ' + String(data['annule_le'] ?? '').slice(0, 10) + ' : plus aucune saisie possible.');
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

  /* ANTI-DOUBLON DE CONTENEUR : DAT-05, garde applicative posée le 2026-09-10.
   *
   * Le diagnostic du 2026-09-09 a compté 19 couples (cargaison, conteneur)
   * dupliqués en base : un même conteneur enregistré deux fois sur un camion
   * fausse le nombre de conteneurs, l'apurement et tous les rapports.
   *
   * La contrainte SQL `unique (cargaison_id, conteneur)` serait la vraie
   * réponse, mais un index unique NE PEUT PAS être créé tant que ces 19 lignes
   * existent, et les arbitrer est une décision métier, pas un déploiement.
   * Ce contrôle-ci ferme la porte AUX NOUVEAUX doublons sans toucher à
   * l'historique : la contrainte pourra être posée une fois la base nettoyée.
   *
   * Deux passes, car les deux cas se produisent :
   *  · le même numéro deux fois dans la MÊME saisie ;
   *  · un numéro déjà rattaché à cette cargaison par une saisie précédente.
   */
  const vus = new Set<string>();
  for (const ct of conteneurs) {
    const n = String(ct.num ?? '').toUpperCase().trim();
    if (!n) continue;
    if (vus.has(n))
      throw new Error(`Le conteneur « ${n} » figure deux fois dans cette saisie.`);
    vus.add(n);
  }
  const { data: deja, error: eDeja } = await ctx.db
    .from('conteneurs').select('conteneur').eq('cargaison_id', cargaisonId);
  if (eDeja) throw new Error(eDeja.message);
  const presents = new Set((deja ?? []).map((r) => String((r as { conteneur?: unknown }).conteneur ?? '').toUpperCase()));
  for (const n of vus) {
    if (presents.has(n))
      throw new Error(`Le conteneur « ${n} » est déjà enregistré sur ce camion.`);
  }

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

/**
 * v4, DÉLIE un TC d'une cargaison et le remet à disposition dans le stock.
 * Utilisé par la CORRECTION d'un conteneur mal saisi (cargo.editconteneur) :
 * le conteneur erroné doit redevenir sélectionnable, sinon la vraie saisie est
 * impossible. `statutRestore` = « Positionné » (dépotage, il était pointé du
 * jour) ou « En stock » (enlèvement). Best-effort : ne bloque jamais la
 * correction si le TC n'existe pas au stock (saisie manuelle / partagé).
 */
export async function delierStock(ctx: Ctx, tc: string, cargaisonId: string, statutRestore: string): Promise<void> {
  const num = String(tc || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!num) return;
  /* FUITE DES FANTÔMES DU PARC — 2026-09-24 (rapprochement PIA).
   *
   * Un conteneur PARTAGÉ est sur plusieurs camions, mais sa fiche ne pointe que
   * le premier. Annuler ou corriger ce premier camion remettait la fiche « En
   * stock » alors que le conteneur restait chargé sur un autre : il
   * réapparaissait au parc, pour toujours. S'il est encore sur un camion vivant,
   * la fiche passe à ce camion et reste « Dépotée ». */
  const autre = await autreCamionDuConteneur(ctx, num, cargaisonId);
  const patch = autre
    ? { cargaison_id: autre }
    : { statut: statutRestore, date_depote: null, cargaison_id: null };
  const { error } = await ctx.db
    .from('stock')
    .update(patch)
    .eq('numero_tc', num)
    .eq('cargaison_id', cargaisonId);
  if (error) throw new Error(error.message);
}

/**
 * Cargaison VIVANTE (ni annulée, ni archivée), autre que `sauf`, qui porte
 * encore ce conteneur — la plus récente — ou `null`.
 */
export async function autreCamionDuConteneur(ctx: Ctx, num: string, sauf: string): Promise<string | null> {
  const { data: lignes, error } = await ctx.db
    .from('conteneurs').select('cargaison_id').eq('conteneur', num).neq('cargaison_id', sauf);
  if (error) throw new Error(error.message);
  const ids = [...new Set((lignes ?? []).map((r) => String((r as { cargaison_id?: unknown }).cargaison_id ?? '')))].filter(Boolean);
  if (!ids.length) return null;
  const { data: cargos, error: e2 } = await ctx.db
    .from('cargaisons').select('id, date_creation, annule, archive').in('id', ids);
  if (e2) throw new Error(e2.message);
  const vivants = (cargos ?? [])
    .filter((c) => c['annule'] !== true && c['archive'] !== true)
    .sort((a, b) => String(b['date_creation'] ?? '').localeCompare(String(a['date_creation'] ?? '')));
  return vivants.length ? String(vivants[0]!['id']) : null;
}

/** Conteneur du stock UTILISABLE (présent, pas encore dépoté) → objet ou null. */
/**
 * La fiche de stock d'un conteneur, QUEL QUE SOIT son statut, 2026-09-12.
 *
 * `stockDisponible` masque volontairement les conteneurs déjà dépotés : ils ne
 * sont plus « disponibles ». Mais un conteneur dépoté au port sec alimente
 * souvent PLUSIEURS camions, et le deuxième doit pouvoir s'y rattacher. Il faut
 * donc pouvoir constater son existence sans le déclarer disponible, les deux
 * questions sont distinctes, elles méritent deux fonctions.
 */
export async function stockFiche(ctx: Ctx, numeroTC: string): Promise<Record<string, unknown> | null> {
  const tc = String(numeroTC || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const { data, error } = await ctx.db.from('stock').select('*').eq('numero_tc', tc).maybeSingle();
  if (error) throw new Error(error.message);
  return data ? versCamel(data) : null;
}

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
  dateDeclaration?: string; // v4 : date en douane (ISO 'yyyy-MM-dd'), '' si inconnue
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
  return {
    exists: true, cle, declarant: data.declarant,
    dateDeclaration: data.date_declaration ? String(data.date_declaration).slice(0, 10) : '',
    nombreConteneurs: nb, apures: ap, restant: Math.max(0, nb - ap),
  };
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
    // Nb de conteneurs déclarés facultatif (décision user) : 0 = inconnu (apurement neutre).
    const nbDecl = Number(payloadNb || 0);
    const now = new Date().toISOString();
    const { error } = await ctx.db.from('declarations').insert({
      cle,
      annee_declaration: decl.anneeDeclaration ?? '',
      bureau_declaration: decl.bureauDeclaration ?? '',
      type_declaration: decl.typeDeclaration ?? '',
      numero_declaration: decl.numeroDeclaration ?? '',
      declarant: decl.declarant ?? '',
      // v4, date de la déclaration en douane (ordre d'exécution) ; NULL si inconnue.
      date_declaration: decl.dateDeclaration || null,
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

/**
 * Retire des conteneurs de l'apurement d'une déclaration (migration 00170).
 *
 * LE MANQUE QUE ÇA COMBLE. Jusqu'ici le compteur ne pouvait que MONTER :
 * `majApurement` n'est appelé que sur l'AJOUT d'un conteneur, et `fn_apurer_inc`
 * refuse tout décrément (garde-fou anti-fraude, migration 00090). Un conteneur
 * supprimé, remplacé ou réaffecté laissait donc son +1 collé à sa déclaration
 * d'origine. Mesuré en production le 2026-09-09 : 34 des 121 déclarations
 * portant un nombre déclaré étaient sur-apurées, jusqu'à +8 conteneurs.
 *
 * BEST-EFFORT, comme `majApurementSafe` : une correction de conteneur ne doit
 * jamais échouer parce que le rattrapage d'un compteur a échoué. Le décrément
 * est borné à zéro côté SQL (`fn_apurer_dec`).
 */
export async function majApurementDec(
  ctx: Ctx,
  declLike: Partial<Declaration>,
  nbRetrait: number,
): Promise<void> {
  try {
    if (!declLike || !declLike.numeroDeclaration || nbRetrait <= 0) return;
    const found = await lookupDeclaration(ctx, declLike);
    if (!found.exists) return; // rien à décrémenter : la déclaration n'existe pas
    await ctx.db.rpc('fn_apurer_dec', { p_cle: declKey(declLike), p_nb: nbRetrait });
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
