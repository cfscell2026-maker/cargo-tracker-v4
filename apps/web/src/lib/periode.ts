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

/* ============ COMPARAISON AVEC LA PÉRIODE PRÉCÉDENTE — 2026-09-11 ==========
 *
 * Le tableau de bord affiche désormais une flèche de hausse ou de baisse sur
 * les tuiles d'ÉVÉNEMENTS. Elle suppose un point de comparaison : la période de
 * MÊME LONGUEUR qui précède immédiatement celle affichée. Une semaine se compare
 * à la semaine d'avant, un mois au mois d'avant, une plage libre de 9 jours aux
 * 9 jours qui la précèdent.
 *
 * ⚠ Réservé aux tuiles de période. Les compteurs « Attente » sont INSTANTANÉS
 * (voir `dashboardStats` côté serveur : ils ignorent `du`/`au`) — leur coller
 * une variation afficherait un écart qui n'existe pas.
 * ====================================================================== */

/** La période de même longueur qui précède immédiatement `du`…`au`. */
export function periodePrecedente(du: string, au: string): { du: string; au: string } {
  const d = new Date(du + 'T00:00:00');
  const a = new Date(au + 'T00:00:00');
  const jours = Math.round((a.getTime() - d.getTime()) / 86400000) + 1; // bornes incluses
  // On recule par `setDate`, et NON en soustrayant des millisecondes : sous un
  // fuseau à heure d'été, un jour ne dure pas toujours 86 400 000 ms, et le
  // calcul tomberait à côté d'une journée deux fois l'an. Le Togo n'en change
  // pas, mais le code ne doit pas en dépendre.
  const finAvant = new Date(d);
  finAvant.setDate(finAvant.getDate() - 1);
  const debutAvant = new Date(finAvant);
  debutAvant.setDate(debutAvant.getDate() - (jours - 1));
  return { du: isoDate(debutAvant), au: isoDate(finAvant) };
}

/** Sens et ampleur d'une évolution. `null` quand elle ne veut rien dire. */
export type Variation = { sens: 'hausse' | 'baisse' | 'stable'; pourcent: number };

/**
 * Compare deux valeurs.
 *
 * Renvoie `null` quand la période précédente est à ZÉRO : un pourcentage de
 * variation n'a alors aucun sens — on ne divise pas par zéro, et « +∞ % »
 * n'informe personne. Le cas est fréquent au démarrage d'une cellule ou après
 * une semaine chômée ; l'écran affichera « nouveau » plutôt qu'un faux calcul.
 */
export function comparer(actuel: number, precedent: number): Variation | null {
  if (!isFinite(actuel) || !isFinite(precedent) || precedent <= 0) return null;
  const ecart = ((actuel - precedent) / precedent) * 100;
  // Sous 0,5 %, on parle de stabilité : afficher « +0 % » avec une flèche
  // laisserait croire à un mouvement qui n'a pas eu lieu.
  if (Math.abs(ecart) < 0.5) return { sens: 'stable', pourcent: 0 };
  return { sens: ecart > 0 ? 'hausse' : 'baisse', pourcent: Math.round(Math.abs(ecart)) };
}

/**
 * FENÊTRE DE COMPARAISON HONNÊTE — 2026-09-11, corrigée le 2026-09-12.
 *
 * Comparer une période EN COURS à une période ACHEVÉE fausse tout. Un vendredi,
 * la semaine du lundi au dimanche ne compte que cinq jours de travail ; la
 * comparer aux sept jours de la semaine précédente affiche une chute de 30 %
 * qui n'a jamais eu lieu. On compare donc à DURÉE ÉCOULÉE ÉGALE.
 *
 * DÉFAUT CORRIGÉ LE 2026-09-12. La première version prenait les N jours qui
 * précèdent IMMÉDIATEMENT la période, et non les N MÊMES jours de la période
 * précédente. Mesuré un samedi 12/09 :
 *   · semaine lun 07 → sam 12 comparée à mar 01 → dim 06 (au lieu de lun 31/08 → sam 05/09) ;
 *   · un jeudi, lundi-jeudi se mesurait à jeudi-DIMANCHE : un week-end dans la référence ;
 *   · mois 01 → 12 sept. comparé à 20 → 31 août (au lieu de 01 → 12 août).
 * La longueur était la bonne, les jours ne l'étaient pas — et le trafic d'un port
 * sec ne pèse pas la même chose un dimanche et un lundi.
 *
 * Désormais, selon la période choisie :
 *   · jour    : le MÊME JOUR de la semaine d'avant — lundi contre lundi
 *               (décision utilisateur 2026-09-12). Contre la veille, un lundi se
 *               mesurait à un dimanche calme et affichait une hausse factice ;
 *   · semaine : les mêmes jours de la semaine d'avant (lundi → même jour) ;
 *   · mois    : du 1er au même quantième du mois d'avant (plafonné à sa fin :
 *               le 30 mars se compare au 28 février) ; mois achevé → mois entier ;
 *   · année   : du 1er janvier au même jour de l'année d'avant (29 février plafonné) ;
 *   · plage personnalisée : la plage de même longueur juste avant — pour une
 *     plage libre, il n'existe pas d'autre « période jumelle ».
 *
 * Les chiffres AFFICHÉS sur les tuiles ne bougent pas : seule la fenêtre de
 * référence change.
 */
export function fenetreComparaison(
  du: string, au: string, aujourdhui: Date = new Date(), mode: ModePeriode = 'perso',
): { du: string; au: string } {
  const auJour = isoDate(aujourdhui);
  // La période déborde-t-elle sur l'avenir ? Si oui, on s'arrête à aujourd'hui.
  const finReelle = auJour < au ? auJour : au;
  // Une période entièrement à venir n'a rien à comparer : on retombe alors sur
  // la période précédente pleine, faute de mieux.
  if (finReelle < du) return periodePrecedente(du, au);
  const jour = (iso: string) => new Date(iso + 'T00:00:00');

  // Jour et semaine reculent de sept jours : mêmes jours de la semaine.
  if (mode === 'semaine' || mode === 'jour') {
    const recule = (iso: string) => { const d = jour(iso); d.setDate(d.getDate() - 7); return isoDate(d); };
    return { du: recule(du), au: recule(finReelle) };
  }
  if (mode === 'mois' || mode === 'annee') {
    const mois = mode === 'mois' ? 1 : 0;
    const ans = mode === 'annee' ? 1 : 0;
    const d = jour(du);
    const f = jour(finReelle);
    // `new Date(a, m, 1)` normalise seul un mois négatif : janvier recule en décembre.
    const debutAvant = new Date(d.getFullYear() - ans, d.getMonth() - mois, d.getDate());
    const a = f.getFullYear() - ans;
    const m = f.getMonth() - mois;
    const dernierJour = new Date(a, m + 1, 0).getDate();
    // Période achevée : la jumelle entière. En cours : même quantième, plafonné.
    const quantieme = finReelle === au ? dernierJour : Math.min(f.getDate(), dernierJour);
    return { du: isoDate(debutAvant), au: isoDate(new Date(a, m, quantieme)) };
  }
  return periodePrecedente(du, finReelle);
}
