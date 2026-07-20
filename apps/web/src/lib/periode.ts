/**
 * Périodes de rapport — les 4 périodes glissantes usuelles PLUS une PLAGE
 * PERSONNALISÉE (décision utilisateur 2026-07-20) : les périodes calendaires ne
 * couvrent pas les questions réelles (« du 3 au 17 », une campagne, un mois
 * écoulé à cheval sur deux mois).
 *
 * Calcul de dates isolé du composant et testé directement (`periode.test.ts`) :
 * c'est là que se cachent les erreurs classiques (début de semaine, dernier jour
 * du mois, année bissextile, plage saisie à l'envers).
 */

export type ModePeriode = 'jour' | 'semaine' | 'mois' | 'annee' | 'perso';

/**
 * Date LOCALE au format ISO court `YYYY-MM-DD`. Volontairement pas
 * `toISOString()`, qui bascule en UTC et peut décaler d'un jour : le Togo est à
 * UTC+0 donc l'effet est nul aujourd'hui, mais le jour affiché à l'agent doit
 * rester son jour, quel que soit le fuseau de l'appareil.
 */
export const isoDate = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/**
 * Bornes [du, au] INCLUSES d'une période glissante, calées sur `reference`.
 * La semaine commence le LUNDI (usage local, pas le dimanche par défaut de JS).
 * `perso` n'a pas de bornes calculables : la journée de référence est renvoyée,
 * l'appelant fournit ses propres dates.
 */
export function bornesDe(m: ModePeriode, reference: Date = new Date()): [string, string] {
  const a = reference.getFullYear();
  const mois = reference.getMonth();
  if (m === 'mois') return [isoDate(new Date(a, mois, 1)), isoDate(new Date(a, mois + 1, 0))];
  if (m === 'annee') return [isoDate(new Date(a, 0, 1)), isoDate(new Date(a, 11, 31))];
  if (m === 'semaine') {
    const depuisLundi = (reference.getDay() + 6) % 7; // dimanche (0) → 6
    const lundi = new Date(a, mois, reference.getDate() - depuisLundi);
    const dimanche = new Date(a, mois, reference.getDate() - depuisLundi + 6);
    return [isoDate(lundi), isoDate(dimanche)];
  }
  return [isoDate(reference), isoDate(reference)];
}

/**
 * Remet une plage à l'endroit. Saisir « du 17 au 3 » ne renverrait rien : plutôt
 * qu'un tableau vide inexplicable, on inverse et on le signale à l'écran.
 */
export function normaliserPlage(du: string, au: string): { du: string; au: string; inversee: boolean } {
  const inversee = !!du && !!au && du > au;
  return inversee ? { du: au, au: du, inversee } : { du, au, inversee };
}
