/**
 * CACHE DE LECTURE — 2026-09-12.
 *
 * MESURE, sur la base réelle : une liste qui renvoie 6 lignes coûte 3,73 s,
 * exactement autant que celle qui en renvoie 14 450 (3,85 s). Le temps ne
 * dépend PAS du résultat : il est pris à charger toute la table avant de la
 * trier en mémoire. Tant que ce tri n'est pas passé en SQL — ce qui exige un
 * déploiement — la seule marge côté navigateur est de NE PAS REDEMANDER ce
 * qu'on vient d'obtenir.
 *
 * Le mécanisme vit ICI, séparé de `rpc.ts`, pour une raison pratique : `rpc.ts`
 * dépend de `supabase.ts`, qui exige des variables d'environnement et ne
 * s'importe pas dans un test. Isolé, le cache se teste — et un cache qui n'est
 * pas testé finit toujours par répondre une valeur qu'il ne devait plus avoir.
 *
 * ⚠ DURÉE VOLONTAIREMENT COURTE. Un cache qui ment est pire qu'une lenteur : on
 * ne discute pas avec un agent qui affirme avoir vu un dossier « déjà validé ».
 * Quinze secondes couvrent l'aller-retour entre deux écrans — le cas qui coûte
 * — sans couvrir le temps qu'un collègue mette la base à jour.
 */

/** Au-delà, une valeur mise de côté n'est plus servie. */
export const PEREMPTION = 15000;

export interface EntreeCache { valeur: unknown; pose: number }

/**
 * Clé d'une lecture. Le `\u0000` sépare l'action de ses paramètres : c'est le
 * seul caractère qu'un nom d'action ne peut pas contenir, donc deux lectures
 * différentes ne peuvent pas se retrouver sous la même clé par collision.
 */
export function cleCache(action: string, data: Record<string, unknown>): string {
  return action + '\u0000' + JSON.stringify(data ?? {});
}

export class CacheLecture {
  private entrees = new Map<string, EntreeCache>();

  /** La valeur si elle existe ET n'est pas périmée ; `undefined` sinon. */
  lire(k: string, maintenant = Date.now()): unknown {
    const e = this.entrees.get(k);
    if (!e) return undefined;
    if (maintenant - e.pose >= PEREMPTION) {
      // Périmée : on la retire plutôt que de la laisser occuper la place.
      this.entrees.delete(k);
      return undefined;
    }
    return e.valeur;
  }

  poser(k: string, valeur: unknown, maintenant = Date.now()): void {
    this.entrees.set(k, { valeur, pose: maintenant });
  }

  /** Après une écriture, rien de ce qui a été lu avant n'est digne de foi. */
  vider(): void {
    this.entrees.clear();
  }

  get taille(): number { return this.entrees.size; }
}
