/**
 * Tests des bornes de période. Le calcul de dates est l'endroit où se cachent
 * les erreurs discrètes : début de semaine, dernier jour du mois, bissextile,
 * plage saisie à l'envers. Exécutable : `node --test`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bornesDe, isoDate, normaliserPlage } from './periode.ts';

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
