/**
 * LA NAVIGATION, MISE À DISPOSITION DE TOUT L'ARBRE — 2026-09-12.
 *
 * Le bandeau de module porte désormais le bouton « Retour », et il est posé sur
 * une vingtaine d'écrans. Lui passer la navigation en propriété aurait obligé à
 * modifier chacun de ces appels — et à recommencer au suivant.
 *
 * Ce contexte vit dans SON PROPRE fichier, et non dans `App.tsx`, pour une
 * raison précise : `App.tsx` importe déjà `screens.tsx`. Un import de valeur en
 * sens inverse formerait un cycle à l'exécution, et le contexte pourrait valoir
 * `undefined` selon l'ordre d'évaluation des modules. Ici, les deux importent le
 * même tiers : aucun cycle possible.
 *
 * `null` par défaut : un composant rendu hors de l'application (un test, par
 * exemple) doit pouvoir s'afficher sans navigation — le bouton s'efface alors,
 * au lieu de lever une exception.
 */
import { createContext, useContext } from 'react';
import type { Nav } from '../App.tsx';

export const ContexteNav = createContext<Nav | null>(null);

/** La navigation courante, ou `null` hors de l'application. */
export function useNav(): Nav | null {
  return useContext(ContexteNav);
}
