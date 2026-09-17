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

/* ---- Recherche par camion et filtre par délai (2026-09-17) ---- */
import { filtrerEngagements, joursAvantEcheance } from './tri-engagements.ts';

const AUJ = new Date(2026, 8, 17); // 17/09/2026
const E = [
  { numeroCamion: 'TG 1234 BK', engagementDelai: '2026-09-15' }, // dépassé de 2 jours
  { numeroCamion: 'TG5678AB', engagementDelai: '2026-09-20' },   // dans 3 jours
  { numeroCamion: 'BF9999ZZ', engagementDelai: '2026-10-30' },   // dans 43 jours
  { numeroCamion: 'TG1234BX', engagementDelai: '' },             // sans échéance
];
const noms = (l: Record<string, unknown>[]) => l.map((x) => x['numeroCamion']);

test('délai : « dans au plus N jours » inclut les échéances DÉPASSÉES', () => {
  // Un dépassé est déjà dans le délai : l'oublier ferait manquer l'urgent.
  assert.deepEqual(noms(filtrerEngagements(E, { joursMax: 3 }, AUJ)), ['TG 1234 BK', 'TG5678AB']);
  assert.deepEqual(noms(filtrerEngagements(E, { joursMax: 0 }, AUJ)), ['TG 1234 BK']);
  assert.deepEqual(noms(filtrerEngagements(E, { joursMax: 60 }, AUJ)), ['TG 1234 BK', 'TG5678AB', 'BF9999ZZ']);
});

test('délai : une ligne sans échéance ne répond pas à une question de délai', () => {
  assert.equal(noms(filtrerEngagements(E, { joursMax: 60 }, AUJ)).includes('TG1234BX'), false);
  // Sans filtre de délai, elle reste bien dans la liste.
  assert.equal(noms(filtrerEngagements(E, {}, AUJ)).length, 4);
});

test('recherche camion : espaces, tirets et casse ignorés, recherche partielle', () => {
  assert.deepEqual(noms(filtrerEngagements(E, { camion: 'tg1234bk' }, AUJ)), ['TG 1234 BK']);
  assert.deepEqual(noms(filtrerEngagements(E, { camion: 'TG-1234' }, AUJ)), ['TG 1234 BK', 'TG1234BX']);
  assert.deepEqual(noms(filtrerEngagements(E, { camion: '9999' }, AUJ)), ['BF9999ZZ']);
  assert.deepEqual(noms(filtrerEngagements(E, { camion: 'introuvable' }, AUJ)), []);
});

test('les deux filtres se combinent', () => {
  assert.deepEqual(noms(filtrerEngagements(E, { camion: 'TG', joursMax: 3 }, AUJ)), ['TG 1234 BK', 'TG5678AB']);
});

test('joursAvantEcheance : négatif si dépassé, null si illisible', () => {
  assert.equal(joursAvantEcheance('2026-09-15', AUJ), -2);
  assert.equal(joursAvantEcheance('2026-09-17', AUJ), 0);
  assert.equal(joursAvantEcheance('', AUJ), null);
  assert.equal(joursAvantEcheance('pas une date', AUJ), null);
});
