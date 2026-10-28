/**
 * BIBLIOTHÈQUE EXCEL CHARGÉE À LA DEMANDE (2026-10-24, vitesse).
 *
 * `xlsx` pesait plus du tiers du code livré au navigateur (le bundle unique
 * faisait 1,2 Mo), alors qu'elle ne sert qu'au clic sur « Excel » et à
 * l'import d'un fichier. Tout téléphone la téléchargeait AVANT de pouvoir
 * afficher l'écran de connexion.
 *
 * Elle part désormais dans son propre fichier, chargé :
 *   · en arrière-plan, peu après l'ouverture (`prechargerExcel`), pour que le
 *     premier export reste instantané ;
 *   · au plus tard au premier export, si le préchargement n'a pas eu lieu.
 * Un seul téléchargement dans tous les cas : la promesse est partagée.
 */
type Excel = typeof import('xlsx');

let promesse: Promise<Excel> | null = null;

export function chargerExcel(): Promise<Excel> {
  promesse ??= import('xlsx');
  return promesse;
}

/** Préchargement discret, quand l'application a fini de démarrer. */
export function prechargerExcel(delaiMs = 8000): void {
  window.setTimeout(() => { chargerExcel().catch(() => { promesse = null; }); }, delaiMs);
}
