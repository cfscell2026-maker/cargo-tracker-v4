/**
 * REPRISE DES PANNES DE PLATEFORME : 2026-09-11.
 *
 * ── Le problème observé ────────────────────────────────────────────────────
 * L'écran « À valider » affichait « Erreur inconnue. » par intermittence ; en
 * recliquant plusieurs fois, l'appel finissait par passer. La capture réseau a
 * donné la réponse exacte :
 *
 *     HTTP 546 · {"code":"WORKER_RESOURCE_LIMIT",
 *                 "message":"Function failed due to not having enough
 *                            compute resources (please check logs)"}
 *
 * C'est l'hébergeur qui répond, PAS notre fonction : le worker Deno a été tué
 * faute de ressources avant d'avoir pu produire une réponse.
 *
 * ── Pourquoi le message était illisible ────────────────────────────────────
 * Notre fonction répond TOUJOURS par une enveloppe `{ ok, data | error }`,
 * y compris en 400 et en 429 (voir `rpc/index.ts`). Le corps ci-dessus n'a ni
 * `ok` ni `error` : le client retombait donc sur son texte par défaut,
 * « Erreur inconnue. », qui ne dit rien et ne se corrèle à rien.
 *
 * D'où la règle de détection, sûre par construction : UNE RÉPONSE SANS `ok`
 * N'EST PAS DE NOUS. C'est une panne d'infrastructure.
 *
 * ── Pourquoi on ne rejoue pas tout ─────────────────────────────────────────
 * Un worker tué faute de ressources a pu l'être AVANT ou APRÈS avoir écrit en
 * base : rien dans la réponse ne permet de trancher. Rejouer une écriture,
 * c'est risquer une double validation ou un doublon, sur un outil douanier,
 * c'est inacceptable.
 *
 * On ne rejoue donc QUE les actions sans effet (lectures), énumérées ici une à
 * une. Toute action non listée est traitée comme une écriture : le défaut est
 * de NE PAS rejouer, de sorte qu'une action ajoutée demain au registre sans
 * être ajoutée ici reste du bon côté du risque.
 */

/**
 * Actions de LECTURE, hors préfixe `report.` qui l'est en entier.
 *
 * ⚠ N'ajouter ici qu'une action dont on a VÉRIFIÉ qu'elle n'écrit rien. Deux
 * pièges déjà rencontrés dans le registre : `cargo.lotcamions` vit dans
 * `ecriture.ts` malgré son nom, et `cargo.ouillagedecl` dans `speciaux.ts`,
 * les deux sont volontairement absentes de cette liste.
 */
const SANS_EFFET: ReadonlySet<string> = new Set([
  'dashboard.stats', 'dashboard.fiche',
  'cargo.search', 'cargo.get', 'cargo.list', 'cargo.checkdup',
  'cargo.historique', 'cargo.passages',
  'vehicule.list', 'etatcfs.list', 'log.list', 'user.list',
  'entrepot.list', 'entrepot.entrees', 'entrepot.sorties', 'entrepot.stats',
  'decl.lookup', 'stock.list', 'stock.lookup', 'stockannonce.list',
  'account.me',
]);

/** Vrai si l'action ne modifie rien, donc si la rejouer est sans danger. */
export function estSansEffet(action: string): boolean {
  return action.startsWith('report.') || SANS_EFFET.has(action);
}

/**
 * Statuts qui signalent une panne PASSAGÈRE de l'hébergeur.
 *
 * `0` est notre code interne pour « le `fetch` lui-même a échoué » : coupure
 * réseau, Wi-Fi qui saute, tunnel qui se referme. Le cas est fréquent sur le
 * site et se rattrape exactement pareil.
 *
 * 546 est le statut propre à Supabase Edge Functions (worker tué). Les 502,
 * 503 et 504 sont les pannes de passerelle habituelles.
 *
 * ⚠ 429 (trop de requêtes) n'y est PAS : il arrive dans une enveloppe normale,
 * porte son propre message, et le rejouer ne ferait qu'aggraver la limite.
 */
const TRANSITOIRES: ReadonlySet<number> = new Set([0, 502, 503, 504, 546]);

export function estTransitoire(statut: number): boolean {
  return TRANSITOIRES.has(statut);
}

/** Nombre de reprises AUTOMATIQUES après le premier essai. */
export const REPRISES_MAX = 2;

/**
 * Attente avant la reprise n° `essai` (1 = première reprise), en millisecondes.
 *
 * Croissante : un worker saturé a besoin qu'on le laisse respirer, et réessayer
 * tout de suite ne ferait qu'ajouter à la charge qui vient de le tuer. Le total
 * reste sous la seconde et demie, pour que l'agent n'ait pas l'impression que
 * l'écran s'est figé.
 */
export function attenteAvantReprise(essai: number): number {
  return essai <= 1 ? 400 : 1000;
}

/** Corps de réponse d'une panne de plateforme : forme libre, jamais la nôtre. */
type CorpsTechnique = { code?: unknown; message?: unknown; msg?: unknown; error_description?: unknown } | null;

function texteDuCorps(corps: CorpsTechnique): string {
  if (!corps || typeof corps !== 'object') return '';
  for (const champ of [corps.message, corps.msg, corps.error_description]) {
    if (typeof champ === 'string' && champ.trim()) return champ.trim();
  }
  return '';
}

/**
 * Message destiné à l'AGENT quand l'hébergeur a flanché.
 *
 * Deux textes différents selon la nature de l'action, et c'est le point
 * important : après une lecture ratée, on peut relancer sans réfléchir ; après
 * une ÉCRITURE ratée, l'opération a peut-être abouti quand même, et recommencer
 * à l'aveugle créerait un doublon. Le message doit dire lequel des deux cas
 * s'applique, sans quoi l'agent recommence toujours, et se trompe une fois sur
 * deux.
 */
/**
 * EXTRACTION SANS AUCUN CRITERE - 2026-09-12.
 *
 * MESURÉ en production le jour du déploiement : `report.cargaisons` repond en
 * 1,1 s avec un statut, 1,3 s avec une étape, 3,3 s sur une période, et échoue
 * en 546 quand on lui demande TOUTE la base. Ce n'est pas une saturation
 * passagère : sortir 14 450 dossiers avec le détail de leurs conteneurs dépasse
 * la mémoire du worker, et réessayer échouera toujours.
 *
 * Dire « patientez quelques secondes puis relancez » dans ce cas est FAUX, et
 * c'est le genre de message qui fait recliquer un agent dix fois avant qu'il
 * n'appelle à l'aide. On nomme donc la vraie cause et le geste qui débloque.
 */
const EXPORTS_VOLUMINEUX = new Set(['report.cargaisons', 'report.conteneurs']);

function extractionSansCritere(action: string, data: Record<string, unknown>): boolean {
  if (!EXPORTS_VOLUMINEUX.has(action)) return false;
  // Un seul critère suffit à ramener la demande dans les clous.
  return !['du', 'au', 'statut', 'etape', 'search'].some(
    (c) => String(data?.[c] ?? '').trim() !== '',
  );
}

export function messageTechnique(
  statut: number,
  corps: CorpsTechnique,
  sansEffet: boolean,
  /** L'appel qui a échoué, sert à distinguer une saturation d'une demande trop vaste. */
  origine?: { action: string; data: Record<string, unknown> },
): string {
  if (statut === 0) {
    return sansEffet
      ? 'Connexion au serveur impossible. Vérifiez le réseau du site, puis relancez l\'écran.'
      : 'Connexion au serveur impossible : l\'opération n\'est pas partie. '
        + 'Vérifiez le réseau du site, puis recommencez.';
  }

  const sature = statut === 546 || String((corps || {}).code ?? '').includes('WORKER');
  if (sature) {
    // La demande est-elle trop vaste PAR NATURE ? Alors patienter ne sert à rien.
    if (origine && extractionSansCritere(origine.action, origine.data)) {
      return "Extraction trop volumineuse pour le serveur : vous avez demandé TOUTE "
        + "la base en une fois. Réessayer ne changera rien. Restreignez l'extraction "
        + ": cochez « Limiter à une période », ou choisissez un statut ou une étape, "
        + "puis relancez.";
    }
    return sansEffet
      ? 'Le serveur est momentanément saturé (erreur 546). Les tentatives automatiques '
        + 'n\'ont pas suffi : patientez quelques secondes, puis relancez l\'écran.'
      : 'Le serveur a été interrompu faute de ressources (erreur 546). '
        + '⚠ L\'opération a PEUT-ÊTRE été enregistrée : ouvrez la fiche pour vérifier '
        + 'AVANT de recommencer, sinon vous risquez de la saisir deux fois.';
  }

  const detail = texteDuCorps(corps);
  const suite = sansEffet
    ? 'Relancez l\'écran ; si cela persiste, signalez ce code à l\'administrateur.'
    : '⚠ Vérifiez si l\'opération a été enregistrée avant de recommencer, '
      + 'et signalez ce code à l\'administrateur.';
  return `Le serveur a répondu ${statut}${detail ? ` : ${detail}` : ' sans message exploitable'}. ${suite}`;
}
