/**
 * CACHE PARTAGÉ DES LECTURES COMMUNES (2026-10-24, E/S disque).
 *
 * Le tableau de bord ne dépend pas de la personne connectée : cinq chefs qui
 * l'ont ouvert demandent EXACTEMENT les mêmes chiffres, et chacun relisait la
 * base. Une instance du serveur garde donc la réponse quelques secondes et la
 * sert à tous ; deux demandes simultanées partagent même le calcul en cours.
 *
 * Garde-fous :
 *   · liste FERMÉE d'actions, celles dont la réponse est identique pour tous
 *     les rôles qui y ont droit (la permission est vérifiée AVANT, par le
 *     routeur, à chaque appel) ;
 *   · durée courte ;
 *   · toute action qui n'est pas une lecture connue VIDE le cache : une
 *     validation, une sortie… et le chiffre suivant est recalculé.
 * Ce cache vit dans une instance : deux instances ont chacune le leur, ce qui
 * ne change rien à la justesse, seulement au nombre de recalculs.
 */
export const PARTAGEABLES: Readonly<Record<string, number>> = {
  'dashboard.stats': 20_000,
};

/** Lectures sans effet : elles ne vident pas le cache. Tout le reste le vide. */
const LECTURES = new Set([
  'cargo.get', 'cargo.list', 'cargo.search', 'cargo.checkdup', 'vehicule.list',
  'dashboard.stats', 'dashboard.fiche', 'etatcfs.list', 'account.me', 'account.signin',
]);
export const estLecture = (action: string) => LECTURES.has(action) || action.startsWith('report.');

export class CachePartage {
  private entrees = new Map<string, { expire: number; valeur: Promise<unknown> }>();
  private maintenant: () => number;
  constructor(maintenant: () => number = () => Date.now()) { this.maintenant = maintenant; }

  /** Réponse partagée si l'action s'y prête, sinon calcul direct. */
  async servir(action: string, data: unknown, calculer: () => Promise<unknown>): Promise<unknown> {
    const duree = PARTAGEABLES[action];
    if (!duree) return calculer();
    const cle = action + '|' + JSON.stringify(data ?? {});
    const t = this.maintenant();
    const e = this.entrees.get(cle);
    if (e && e.expire > t) return e.valeur;
    const valeur = calculer();
    this.entrees.set(cle, { expire: t + duree, valeur });
    // Un calcul en échec ne doit pas être resservi.
    valeur.catch(() => { if (this.entrees.get(cle)?.valeur === valeur) this.entrees.delete(cle); });
    return valeur;
  }

  /** À appeler après toute action qui n'est pas une lecture connue. */
  apres(action: string): void {
    if (!estLecture(action)) this.entrees.clear();
  }
}
