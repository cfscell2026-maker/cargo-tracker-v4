/**
 * Tri du volet « Engagements » (2026-09-17). Ce qui se casse en silence : une
 * échéance vide qui passe pour la plus urgente, et des camions triés par code
 * ASCII plutôt que par lecture humaine.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { trierEngagements } from './tri-engagements.ts';

const L = [
  { numeroCamion: 'TG9999ZZ', engagementDelai: '2026-10-05' },
  { numeroCamion: 'tg1111aa', engagementDelai: '2026-09-15' },
  { numeroCamion: 'TG2222BB', engagementDelai: '' },
  { numeroCamion: 'TG10CC', engagementDelai: '2026-09-15' },
];
const cam = (l: Record<string, unknown>[]) => l.map((x) => x['numeroCamion']);

test('tri par délai : le plus urgent d\'abord, les échéances vides en dernier', () => {
  assert.deepEqual(cam(trierEngagements(L, 'delai')), ['TG10CC', 'tg1111aa', 'TG9999ZZ', 'TG2222BB']);
});

test('tri par délai décroissant : la vide reste en dernier, jamais en tête', () => {
  assert.deepEqual(cam(trierEngagements(L, 'delai', 'desc')), ['TG9999ZZ', 'TG10CC', 'tg1111aa', 'TG2222BB']);
});

test('tri par camion : casse ignorée et nombres lus comme des nombres', () => {
  // « TG10CC » avant « TG1111AA » : 10 < 1111. Un tri ASCII rendrait l'inverse.
  assert.deepEqual(cam(trierEngagements(L, 'camion')), ['TG10CC', 'tg1111aa', 'TG2222BB', 'TG9999ZZ']);
  assert.deepEqual(cam(trierEngagements(L, 'camion', 'desc')), ['TG9999ZZ', 'TG2222BB', 'tg1111aa', 'TG10CC']);
});

test('le tri ne modifie pas la liste reçue', () => {
  const avant = cam(L);
  trierEngagements(L, 'camion', 'desc');
  assert.deepEqual(cam(L), avant);
});
