/**
 * ============================================================================
 *  RAPPROCHEMENT DES LISTES ACP (2026-10-06, demande utilisateur).
 *
 *  L'écran envoie les numéros lus dans le fichier reçu ; le serveur les
 *  confronte au parc et CONSERVE le résultat.
 *
 *  Le classement lui-même est dans le domaine partagé (`rapprochement.ts`) :
 *  il ne touche ni à la base ni au réseau, et se teste entier. Ce fichier-ci
 *  ne fait que lire la base, appeler le domaine, et écrire la trace.
 * ============================================================================
 */
import type { Ctx } from '../ctx.ts';
import { ErreurMetier } from '../ctx.ts';
import { fetchAll, nextRef } from './helpers.ts';
import { rapprocher, STOCK_STATUTS, normAlphaNum, type LigneParc } from '../../_shared/domaine/src/index.ts';

/** Message unique quand la table manque : l'agent doit savoir quoi demander. */
const TABLE_ABSENTE =
  'Le rapprochement ACP n\'est pas encore activé : la table « rapprochement_acp » '
  + '(migration 00204) n\'existe pas en base.';

function estTableAbsente(message: string): boolean {
  return /rapprochement_acp/.test(message) && /does not exist|relation/i.test(message);
}

/** Les listes gardées en base, bornées : une trace, pas une archive. */
const MAX_DETAIL = 5000;
const borner = (l: unknown[]) => l.slice(0, MAX_DETAIL);

/**
 * Confronte une liste reçue au parc, et garde la trace du contrôle.
 *
 * TOUTE LA BASE EST LUE, dépotés compris : c'est ce qui permet de distinguer
 * « déjà sorti chez nous » de « jamais vu ». Quatre colonnes suffisent, on ne
 * rapatrie pas les quinze autres.
 */
export async function rapprochementACP(ctx: Ctx, p: Record<string, unknown>) {
  const recus = Array.isArray(p['numeros']) ? (p['numeros'] as unknown[]).map((n) => normAlphaNum(n)).filter(Boolean) : [];
  if (!recus.length) throw new ErreurMetier('Aucun numéro de conteneur lisible dans ce fichier.');

  const lignes = await fetchAll(ctx, 'stock', 'numero_tc, statut, taille, date_entree');
  const base: LigneParc[] = lignes.map((r) => ({
    numeroTC: String(r['numero_tc'] ?? ''),
    statut: String(r['statut'] ?? ''),
    taille: String(r['taille'] ?? ''),
    dateEntree: r['date_entree'] ? String(r['date_entree']) : undefined,
    depote: r['statut'] === STOCK_STATUTS.DEPOTE,
  }));

  const r = rapprocher(recus, base);
  const illisibles = Array.isArray(p['illisibles']) ? (p['illisibles'] as unknown[]).map(String) : [];
  const doublons = Array.isArray(p['doublons']) ? (p['doublons'] as unknown[]).map(String) : [];
  const nomFichier = String(p['nomFichier'] ?? '').slice(0, 200);

  const id = await nextRef(ctx, 'SEQ_ACP', 'ACP');
  const { error } = await ctx.db.from('rapprochement_acp').insert({
    id, fait_le: new Date().toISOString(), fait_par: ctx.session.nomComplet, nom_fichier: nomFichier,
    nb_lus: r.compte.lus, nb_illisibles: illisibles.length, nb_doublons: doublons.length,
    nb_concordants: r.compte.concordants, nb_au_parc_hors_liste: r.compte.auParcHorsListe,
    nb_deja_depotes: r.compte.listeDejaDepotes, nb_inconnus: r.compte.listeInconnus,
    nb_parc: r.compte.parc,
    // Les concordants ne sont PAS gardés : ils ne posent aucune question, et
    // ils pèsent à eux seuls plus que les trois autres listes réunies.
    detail: {
      auParcHorsListe: borner(r.auParcHorsListe),
      listeDejaDepotes: borner(r.listeDejaDepotes),
      listeInconnus: borner(r.listeInconnus),
      illisibles: borner(illisibles), doublons: borner(doublons),
    },
  });
  if (error) throw new Error(estTableAbsente(error.message) ? TABLE_ABSENTE : error.message);

  await ctx.log('Rapprochement ACP', id,
    `${r.compte.lus} lu(s) · ${r.compte.concordants} concordant(s) · `
    + `${r.compte.auParcHorsListe} hors liste · ${r.compte.listeDejaDepotes} déjà dépoté(s) · `
    + `${r.compte.listeInconnus} inconnu(s)`);

  return { id, ...r, illisibles, doublons, nomFichier };
}

/** Les rapprochements passés, du plus récent au plus ancien, sans leur détail. */
export async function rapprochementHistorique(ctx: Ctx, _p: Record<string, unknown> = {}) {
  const { data, error } = await ctx.db.from('rapprochement_acp')
    .select('id, fait_le, fait_par, nom_fichier, nb_lus, nb_illisibles, nb_doublons,'
      + ' nb_concordants, nb_au_parc_hors_liste, nb_deja_depotes, nb_inconnus, nb_parc')
    .order('fait_le', { ascending: false }).limit(100);
  if (error) {
    // La table absente n'est pas une panne : l'écran s'ouvre, simplement vide.
    if (estTableAbsente(error.message)) return { lignes: [], active: false };
    throw new Error(error.message);
  }
  return { lignes: data ?? [], active: true };
}

/** Le détail figé d'un rapprochement passé. */
export async function rapprochementDetail(ctx: Ctx, p: Record<string, unknown>) {
  const id = String(p['id'] ?? '').trim();
  if (!id) throw new ErreurMetier('Rapprochement non précisé.');
  const { data, error } = await ctx.db.from('rapprochement_acp').select('*').eq('id', id).maybeSingle();
  if (error) throw new Error(estTableAbsente(error.message) ? TABLE_ABSENTE : error.message);
  if (!data) throw new ErreurMetier('Rapprochement introuvable : ' + id);
  return data;
}
