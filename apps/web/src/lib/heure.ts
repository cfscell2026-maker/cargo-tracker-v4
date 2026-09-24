/**
 * Salutation et heure de la barre supérieure, 2026-09-11.
 *
 * Deux fonctions PURES, isolées ici pour être testables : elles prennent la
 * date en paramètre plutôt que d'appeler `new Date()` elles-mêmes. Une fonction
 * qui lit l'horloge en interne ne peut pas se tester autrement qu'en attendant
 * la bonne heure.
 */

/**
 * Le mot d'accueil qui convient à l'heure indiquée.
 *
 * Les bornes suivent l'usage courant en français, et non un découpage
 * arithmétique : « bonsoir » se dit dès la fin d'après-midi, bien avant la
 * nuit. Le port travaille tôt, d'où une salutation distincte avant 5 h, qui
 * évite de souhaiter « bonjour » à un agent de la relève de nuit.
 */
export function salutation(d: Date): string {
  const h = d.getHours();
  if (h < 5) return 'Bonne nuit';
  if (h < 12) return 'Bonjour';
  if (h < 17) return 'Bon après-midi';
  return 'Bonsoir';
}

/** L'heure au format « 08:05 », sur deux chiffres, sans les secondes. */
export function heureCourte(d: Date): string {
  const p2 = (n: number) => String(n).padStart(2, '0');
  return p2(d.getHours()) + ':' + p2(d.getMinutes());
}
