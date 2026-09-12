/**
 * Tests du cache de lecture.
 *
 * Ce qui est vérifié ici n'est pas « est-ce que ça va plus vite », mais
 * « est-ce que ça ne ment JAMAIS ». Un cache qui sert une valeur qu'il ne
 * devait plus avoir fait afficher à un agent un dossier déjà validé, ou une
 * file qu'un collègue vient de vider — un défaut bien plus coûteux que les
 * 3,7 s qu'on cherche à éviter.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CacheLecture, cleCache, PEREMPTION } from './cache-lecture.ts';

test('une valeur posée se relit à l\'identique', () => {
  const c = new CacheLecture();
  c.poser('k', { rows: [1, 2] }, 1000);
  assert.deepEqual(c.lire('k', 1000), { rows: [1, 2] });
});

test('une clé jamais posée ne renvoie rien', () => {
  assert.equal(new CacheLecture().lire('absente'), undefined);
});

test('la valeur EXPIRE à la péremption, pas après', () => {
  const c = new CacheLecture();
  c.poser('k', 'v', 0);
  assert.equal(c.lire('k', PEREMPTION - 1), 'v', 'encore valable une ms avant');
  assert.equal(c.lire('k', PEREMPTION), undefined, 'périmée pile à l\'échéance');
});

test('une entrée périmée est RETIRÉE, pas seulement ignorée', () => {
  const c = new CacheLecture();
  c.poser('k', 'v', 0);
  c.lire('k', PEREMPTION + 1);
  assert.equal(c.taille, 0, 'sinon le cache enfle sans fin au fil des écrans');
});

test('vider() efface TOUT — une écriture invalide toutes les lectures', () => {
  const c = new CacheLecture();
  c.poser('a', 1, 0); c.poser('b', 2, 0);
  c.vider();
  assert.equal(c.lire('a', 1), undefined);
  assert.equal(c.lire('b', 1), undefined);
});

test('deux lectures différentes ne partagent JAMAIS une clé', () => {
  const vues = new Set([
    cleCache('cargo.list', { statut: 'tous' }),
    cleCache('cargo.list', { statut: 'Créée' }),
    cleCache('cargo.list', {}),
    cleCache('report.cfs', { statut: 'tous' }),
    cleCache('cargo.get', { id: 'CT-1' }),
  ]);
  assert.equal(vues.size, 5);
});

test('une même lecture donne toujours la même clé', () => {
  assert.equal(
    cleCache('cargo.list', { statut: 'tous', page: 1 }),
    cleCache('cargo.list', { statut: 'tous', page: 1 }),
  );
});

test('la clé ne peut pas être fabriquée par un paramètre malicieux', () => {
  // Le séparateur est un octet nul : impossible dans un nom d'action, donc
  // aucun paramètre ne peut se faire passer pour une autre action.
  const a = cleCache('cargo.list', { x: 'report.cfs' });
  const b = cleCache('report.cfs', {});
  assert.notEqual(a, b);
});
