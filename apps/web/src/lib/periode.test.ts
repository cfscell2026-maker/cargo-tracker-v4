/**
 * Tests des bornes de période. Le calcul de dates est l'endroit où se cachent
 * les erreurs discrètes : début de semaine, dernier jour du mois, bissextile,
 * plage saisie à l'envers. Exécutable : `node --test`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bornesDe, comparer, fenetreComparaison, isoDate, normaliserPlage, periodePrecedente } from './periode.ts';

/** Date LOCALE (le module raisonne en local, pas en UTC). */
const jour = (a: number, m: number, j: number) => new Date(a, m - 1, j);

test('journalier : la borne est le jour même, des deux côtés', () => {
  assert.deepEqual(bornesDe('jour', jour(2026, 7, 20)), ['2026-07-20', '2026-07-20']);
});

test('hebdomadaire : la semaine va du LUNDI au dimanche', () => {
  // 2026-07-20 est un lundi → il est sa propre borne basse.
  assert.deepEqual(bornesDe('semaine', jour(2026, 7, 20)), ['2026-07-20', '2026-07-26']);
  // Un mercredi retombe sur la même semaine.
  assert.deepEqual(bornesDe('semaine', jour(2026, 7, 22)), ['2026-07-20', '2026-07-26']);
  // Le DIMANCHE appartient à la semaine qui s'achève, pas à celle qui s'ouvre :
  // c'est le piège du `getDay()` de JS, où dimanche vaut 0.
  assert.deepEqual(bornesDe('semaine', jour(2026, 7, 26)), ['2026-07-20', '2026-07-26']);
});

test('hebdomadaire : une semaine à cheval sur deux mois reste continue', () => {
  // Mercredi 1er juillet 2026 → la semaine commence le lundi 29 juin.
  assert.deepEqual(bornesDe('semaine', jour(2026, 7, 1)), ['2026-06-29', '2026-07-05']);
});

test('mensuel : du 1er au DERNIER jour, quelle que soit la longueur du mois', () => {
  assert.deepEqual(bornesDe('mois', jour(2026, 7, 15)), ['2026-07-01', '2026-07-31']);
  assert.deepEqual(bornesDe('mois', jour(2026, 4, 3)), ['2026-04-01', '2026-04-30']);
  // Février d'une année NON bissextile…
  assert.deepEqual(bornesDe('mois', jour(2026, 2, 10)), ['2026-02-01', '2026-02-28']);
  // …et d'une année bissextile.
  assert.deepEqual(bornesDe('mois', jour(2028, 2, 10)), ['2028-02-01', '2028-02-29']);
});

test('annuel : du 1er janvier au 31 décembre', () => {
  assert.deepEqual(bornesDe('annee', jour(2026, 7, 20)), ['2026-01-01', '2026-12-31']);
  // Le 31 décembre reste dans son année (pas de débordement sur la suivante).
  assert.deepEqual(bornesDe('annee', jour(2026, 12, 31)), ['2026-01-01', '2026-12-31']);
});

test('isoDate reste sur le jour LOCAL, même tard le soir', () => {
  // 23 h 30 : `toISOString()` aurait basculé au lendemain dans les fuseaux
  // à l'est de Greenwich. Le jour affiché doit rester celui de l'agent.
  assert.equal(isoDate(new Date(2026, 6, 20, 23, 30)), '2026-07-20');
  assert.equal(isoDate(new Date(2026, 0, 1, 0, 5)), '2026-01-01');
});

test('plage inversée : remise à l\'endroit et signalée', () => {
  const r = normaliserPlage('2026-07-17', '2026-07-03');
  assert.deepEqual(r, { du: '2026-07-03', au: '2026-07-17', inversee: true });
});

test('plage à l\'endroit ou incomplète : laissée telle quelle', () => {
  assert.deepEqual(normaliserPlage('2026-07-03', '2026-07-17'),
    { du: '2026-07-03', au: '2026-07-17', inversee: false });
  // Même jour des deux côtés = une seule journée, pas une inversion.
  assert.deepEqual(normaliserPlage('2026-07-03', '2026-07-03'),
    { du: '2026-07-03', au: '2026-07-03', inversee: false });
  // Bornes vides (« toute la période » de l'historique) : aucune contrainte.
  assert.deepEqual(normaliserPlage('', ''), { du: '', au: '', inversee: false });
  assert.deepEqual(normaliserPlage('2026-07-03', ''), { du: '2026-07-03', au: '', inversee: false });
});

/* ---- 2026-09-11 : comparaison avec la période précédente ---------------- */

test('la période précédente a la même longueur et finit la veille', () => {
  // Une semaine (7 jours) → les 7 jours d'avant.
  assert.deepEqual(periodePrecedente('2026-09-07', '2026-09-13'), { du: '2026-08-31', au: '2026-09-06' });
  // Un seul jour → la veille.
  assert.deepEqual(periodePrecedente('2026-09-11', '2026-09-11'), { du: '2026-09-10', au: '2026-09-10' });
  // Une plage libre de 9 jours → les 9 jours d'avant.
  assert.deepEqual(periodePrecedente('2026-09-03', '2026-09-11'), { du: '2026-08-25', au: '2026-09-02' });
});

test('la période précédente franchit les mois et les années', () => {
  assert.deepEqual(periodePrecedente('2026-03-01', '2026-03-31'), { du: '2026-01-29', au: '2026-02-28' });
  // Janvier compte 31 jours : les 31 précédents couvrent tout décembre.
  assert.deepEqual(periodePrecedente('2026-01-01', '2026-01-31'), { du: '2025-12-01', au: '2025-12-31' });
});

test('une comparaison à partir de zéro ne produit PAS un pourcentage', () => {
  // On ne divise pas par zéro, et « +∞ % » n'informe personne.
  assert.equal(comparer(40, 0), null);
  assert.equal(comparer(0, 0), null);
  assert.equal(comparer(5, -3), null);
});

test('hausse, baisse et stabilité', () => {
  assert.deepEqual(comparer(120, 100), { sens: 'hausse', pourcent: 20 });
  assert.deepEqual(comparer(80, 100), { sens: 'baisse', pourcent: 20 });
  assert.deepEqual(comparer(100, 100), { sens: 'stable', pourcent: 0 });
  // Un écart infime est une stabilité, pas un mouvement.
  assert.deepEqual(comparer(1000, 1003), { sens: 'stable', pourcent: 0 });
});

test('une chute à zéro reste lisible', () => {
  assert.deepEqual(comparer(0, 50), { sens: 'baisse', pourcent: 100 });
});

test('une période EN COURS se compare à durée écoulée égale', () => {
  // Vendredi 11, semaine du 07 au 13 : cinq jours écoulés, pas sept.
  // On regarde donc les cinq jours d'avant le 07, soit du 02 au 06.
  assert.deepEqual(
    fenetreComparaison('2026-09-07', '2026-09-13', new Date(2026, 8, 11)),
    { du: '2026-09-02', au: '2026-09-06' });
});

test('une période ACHEVÉE se compare à sa jumelle entière', () => {
  // La semaine est finie : sept jours contre sept jours.
  assert.deepEqual(
    fenetreComparaison('2026-09-07', '2026-09-13', new Date(2026, 8, 20)),
    { du: '2026-08-31', au: '2026-09-06' });
});

test('le jour même se compare à la veille', () => {
  assert.deepEqual(
    fenetreComparaison('2026-09-11', '2026-09-11', new Date(2026, 8, 11)),
    { du: '2026-09-10', au: '2026-09-10' });
});

test('une période entièrement à venir retombe sur la période pleine', () => {
  // Rien n'est écoulé : aucune fenêtre partielle n'a de sens.
  assert.deepEqual(
    fenetreComparaison('2026-10-01', '2026-10-07', new Date(2026, 8, 11)),
    { du: '2026-09-24', au: '2026-09-30' });
});
