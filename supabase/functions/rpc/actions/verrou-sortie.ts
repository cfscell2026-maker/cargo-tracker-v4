/**
 * ============================================================================
 *  VERROU APRÈS SORTIE : 2026-10-09 (décision utilisateur, « option 2 »).
 *
 *  Une fois la sortie enregistrée à la Porte Principale, le dossier est FIGÉ :
 *    · aucun agent ne peut plus le modifier ni l'annuler ;
 *    · l'ADMINISTRATEUR (et les rôles techniques qui en ont les pouvoirs) peut
 *      encore corriger, mais TOUJOURS avec un motif, inscrit au journal sous
 *      « ⚠ Correction après sortie ».
 *
 *  Le contrôle est posé à l'ENTRÉE du serveur (index.ts), comme le verrou de
 *  l'application, et non action par action : un garde posé dans chaque action
 *  finit toujours par en oublier une. Il remplace, pour un dossier sorti, la
 *  règle du 2026-09-10 qui ouvrait l'annulation à tous les stades sans
 *  distinction : elle reste ouverte à l'administrateur, motif à l'appui.
 *
 *  RESTENT LIBRES après la sortie, parce qu'ils se font PAR NATURE après elle
 *  ou ne touchent pas au contenu du dossier :
 *    · le suivi des engagements (solder, corriger l'échéance, retirer) ;
 *    · l'arrivée au bureau de destination (dispenses) ;
 *    · l'archivage et le désarchivage.
 * ============================================================================
 */
import type { Ctx } from '../ctx.ts';
import { MotifRequis, ErreurMetier } from '../ctx.ts';
import { STATUTS, aPouvoirAdmin, txt } from '../../_shared/domaine/src/index.ts';

/** Actions qui MODIFIENT un dossier existant, désigné par `id` (ou `ids` pour la validation en lot). */
export const ACTIONS_FIGEES_APRES_SORTIE: ReadonlySet<string> = new Set([
  'cargo.cfs', 'cargo.declaration', 'cargo.fincharge', 'cargo.sceller', 'cargo.visite',
  'cargo.valider', 'cargo.validerlot',
  'cargo.t1', 'cargo.t1edit', 'cargo.horsgabarit',
  'cargo.gps', 'cargo.gpsedit',
  'cargo.bonsortie', 'cargo.bsedit',
  'cargo.sortie', 'cargo.etatcfs',
  'cargo.editcamion', 'cargo.edittype', 'cargo.editconteneur', 'cargo.editdecl',
  'cargo.update', 'cargo.mixte', 'cargo.ouillagedecl',
  'cargo.delete',
]);

const jourFr = (v: unknown) => {
  const s = String(v ?? '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s.slice(8, 10)}/${s.slice(5, 7)}/${s.slice(0, 4)}` : '';
};

/**
 * Lève si l'action vise un dossier sorti et que la règle n'est pas respectée ;
 * sinon, pour une correction d'administrateur, l'inscrit au journal.
 */
export async function controlerApresSortie(ctx: Ctx, action: string, data: Record<string, unknown>): Promise<void> {
  if (!ACTIONS_FIGEES_APRES_SORTIE.has(action)) return;
  const ids = (action === 'cargo.validerlot'
    ? (Array.isArray(data['ids']) ? data['ids'] as unknown[] : [])
    : [data['id']]).map((v) => String(v ?? '').trim()).filter(Boolean);
  if (!ids.length) return; // l'action elle-même refusera une demande sans dossier

  const { data: lignes, error } = await ctx.db
    .from('cargaisons').select('id, numero_camion, statut, date_sortie').in('id', ids);
  if (error) throw new Error(error.message);
  const sortis = (lignes ?? []).filter((c: Record<string, unknown>) =>
    c['statut'] === STATUTS.SORTIE || !!c['date_sortie']);
  if (!sortis.length) return;

  const premier = sortis[0] as Record<string, unknown>;
  const qui = 'Le camion « ' + String(premier['numero_camion'] || premier['id']) + ' »'
    + (sortis.length > 1 ? ' (et ' + (sortis.length - 1) + ' autre(s))' : '')
    + ' est sorti' + (jourFr(premier['date_sortie']) ? ' le ' + jourFr(premier['date_sortie']) : '');

  if (!aPouvoirAdmin(ctx.session.role))
    throw new ErreurMetier(qui + ' : son dossier ne peut plus être modifié. '
      + "Seul l'administrateur peut le corriger, avec un motif.");

  const motif = txt(data['motif'], 300).trim();
  if (!motif)
    throw new MotifRequis(qui + " : la correction d'un dossier sorti exige un MOTIF, "
      + "inscrit au journal d'audit.");

  for (const c of sortis as Record<string, unknown>[])
    await ctx.log('⚠ Correction après sortie', String(c['id']), action + ' · motif : ' + motif);
}
