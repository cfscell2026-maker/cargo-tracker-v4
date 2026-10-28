import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CachePartage, estLecture } from './cache-partage.ts';

test('cache partagé : deux chefs, un seul calcul du tableau de bord', async () => {
  let t = 0, calculs = 0;
  const c = new CachePartage(() => t);
  const calc = async () => { calculs++; return { n: calculs }; };
  const [a, b] = await Promise.all([c.servir('dashboard.stats', { du: '2026-10-01' }, calc), c.servir('dashboard.stats', { du: '2026-10-01' }, calc)]);
  assert.deepEqual([a, b, calculs], [{ n: 1 }, { n: 1 }, 1]);
  t = 25_000;
  assert.deepEqual(await c.servir('dashboard.stats', { du: '2026-10-01' }, calc), { n: 2 }, 'expiré : recalculé');
});

test('cache partagé : une autre période est un autre calcul ; une action non listée n\'est jamais mise en cache', async () => {
  let calculs = 0;
  const c = new CachePartage(() => 0);
  const calc = async () => ++calculs;
  await c.servir('dashboard.stats', { du: '2026-10-01' }, calc);
  await c.servir('dashboard.stats', { du: '2026-09-01' }, calc);
  await c.servir('cargo.list', {}, calc);
  await c.servir('cargo.list', {}, calc);
  assert.equal(calculs, 4);
});

test('cache partagé : une écriture le vide, une lecture non', async () => {
  let calculs = 0;
  const c = new CachePartage(() => 0);
  const calc = async () => ++calculs;
  await c.servir('dashboard.stats', {}, calc);
  c.apres('report.flux');
  await c.servir('dashboard.stats', {}, calc);
  assert.equal(calculs, 1, 'une lecture ne vide pas');
  c.apres('cargo.valider');
  await c.servir('dashboard.stats', {}, calc);
  assert.equal(calculs, 2, 'une validation vide le cache');
  assert.equal(estLecture('cargo.sortie'), false);
});

test('cache partagé : un calcul en échec n\'est pas resservi', async () => {
  const c = new CachePartage(() => 0);
  await assert.rejects(() => c.servir('dashboard.stats', {}, async () => { throw new Error('base indisponible'); }));
  assert.equal(await c.servir('dashboard.stats', {}, async () => 'ok'), 'ok');
});
