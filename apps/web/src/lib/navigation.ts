/**
 * Pile de navigation — « Retour » remonte d'un cran au lieu de retomber sur un
 * écran fixe (avant : le détail renvoyait toujours vers « Cargaisons », ce qui
 * faisait perdre sa file d'attente ou son dossier de validation).
 *
 * Logique PURE et isolée du composant : c'est elle qui porte les cas limites
 * (re-clic sur l'écran courant, pile vide, profondeur bornée), donc elle est
 * testée directement (`navigation.test.ts`).
 */

/** Une vue = un écran + son argument (id de cargaison, filtre, déclaration…). */
export interface Vue { screen: string; arg: unknown }
export interface EtatNav { vue: Vue; pile: Vue[] }

/** Profondeur d'historique conservée — au-delà, plus personne ne remonte. */
export const PILE_MAX = 25;

export const memeVue = (a: Vue, b: Vue): boolean =>
  a.screen === b.screen && JSON.stringify(a.arg ?? null) === JSON.stringify(b.arg ?? null);

export const vueInitiale = (): EtatNav => ({ vue: { screen: 'dash', arg: null }, pile: [] });

/**
 * Aller à un écran. Re-cliquer sur l'écran où l'on est déjà n'empile rien :
 * sinon « Retour » demanderait autant de clics que de fois où l'on a cliqué le
 * même bouton de menu.
 */
export function empiler(etat: EtatNav, screen: string, arg?: unknown): EtatNav {
  const suivant: Vue = { screen, arg: arg ?? null };
  if (memeVue(etat.vue, suivant)) return etat;
  return { vue: suivant, pile: [...etat.pile, etat.vue].slice(-PILE_MAX) };
}

/** Revenir d'un cran. À la racine (pile vide), l'état est inchangé. */
export function depiler(etat: EtatNav): EtatNav {
  if (!etat.pile.length) return etat;
  return { vue: etat.pile[etat.pile.length - 1]!, pile: etat.pile.slice(0, -1) };
}

/** Écran vers lequel « Retour » ramènerait, ou null si on est à la racine. */
export const ecranPrecedentDe = (etat: EtatNav): string | null =>
  etat.pile[etat.pile.length - 1]?.screen ?? null;
