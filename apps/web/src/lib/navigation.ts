/**
 * Historique de navigation — « Retour » ramène là où l'on était, jamais sur un
 * écran fixe (avant : le détail renvoyait toujours vers « Cargaisons », ce qui
 * faisait perdre sa file d'attente ou son dossier de validation).
 *
 * Modèle = LISTE de vues + CURSEUR (et non simple pile), pour que le bouton
 * « Suivant » du navigateur/téléphone fonctionne aussi : reculer ne détruit pas
 * les vues suivantes, il déplace seulement le curseur. Naviguer vers un nouvel
 * écran depuis une position reculée tronque l'avant — comportement d'un
 * navigateur, celui que les agents connaissent déjà.
 *
 * Logique PURE et isolée du composant : elle porte tous les cas limites
 * (re-clic sur l'écran courant, bornes, bornage mémoire), donc elle est testée
 * directement (`navigation.test.ts`).
 */

/** Une vue = un écran + son argument (id de cargaison, filtre, déclaration…). */
export interface Vue { screen: string; arg: unknown }
export interface EtatNav { vues: Vue[]; index: number }

/**
 * Profondeur d'historique conservée. Généreuse À DESSEIN : au-delà, les vues
 * les plus anciennes tombent et les index ne correspondent plus exactement aux
 * entrées d'historique du navigateur (décalage d'un cran en remontant très
 * loin). `allerA` borne la cible, donc rien ne casse ; 200 met simplement ce
 * cas hors de portée d'une session réelle.
 */
export const PILE_MAX = 200;

export const memeVue = (a: Vue, b: Vue): boolean =>
  a.screen === b.screen && JSON.stringify(a.arg ?? null) === JSON.stringify(b.arg ?? null);

export const vueInitiale = (): EtatNav => ({ vues: [{ screen: 'dash', arg: null }], index: 0 });

/** Vue affichée actuellement. */
export const vueCourante = (etat: EtatNav): Vue => etat.vues[etat.index]!;

/**
 * Aller à un écran. Re-cliquer sur l'écran où l'on est déjà ne crée pas
 * d'entrée : sinon « Retour » demanderait autant de clics que de fois où l'on a
 * cliqué le même bouton de menu.
 */
export function empiler(etat: EtatNav, screen: string, arg?: unknown): EtatNav {
  const suivant: Vue = { screen, arg: arg ?? null };
  if (memeVue(vueCourante(etat), suivant)) return etat;
  const vues = [...etat.vues.slice(0, etat.index + 1), suivant].slice(-PILE_MAX);
  return { vues, index: vues.length - 1 };
}

/**
 * Sauter à une position donnée. C'est l'UNIQUE façon de se déplacer dans
 * l'historique en production : reculer comme avancer passent par le navigateur
 * (`history.back()` / bouton Suivant), qui nous rend l'index atteint via
 * `popstate`. Pas de second chemin, donc pas de désynchronisation possible
 * entre notre historique et celui du navigateur.
 *
 * La cible est BORNÉE : un état d'historique périmé (session précédente) ou
 * étranger ne doit jamais sortir de la liste.
 */
export function allerA(etat: EtatNav, index: number): EtatNav {
  const cible = Math.max(0, Math.min(etat.vues.length - 1, Math.trunc(index)));
  return cible === etat.index ? etat : { vues: etat.vues, index: cible };
}

/** Écran vers lequel « Retour » ramènerait, ou null si on est au début. */
export const ecranPrecedentDe = (etat: EtatNav): string | null =>
  etat.index > 0 ? etat.vues[etat.index - 1]!.screen : null;
