/**
 * Tests de la pile de navigation. Le comportement visé : « Retour » ramène là
 * où l'on était, jamais sur un écran fixe. Exécutable : `node --test`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { empiler, depiler, vueInitiale, ecranPrecedentDe, PILE_MAX } from './navigation.ts';

test('retour ramène à l\'écran précédent, pas à un écran fixe', () => {
  // Le chef part de sa file d'attente, ouvre une fiche : retour = la file.
  let e = vueInitiale();
  e = empiler(e, 'wait_valid');
  e = empiler(e, 'detail', 'CT-2026-000123');
  assert.equal(ecranPrecedentDe(e), 'wait_valid');
  e = depiler(e);
  assert.equal(e.vue.screen, 'wait_valid');
  // Et non 'list', qui était la destination codée en dur auparavant.
  assert.notEqual(e.vue.screen, 'list');
});

test('retour successifs : on remonte le chemin réellement parcouru', () => {
  let e = vueInitiale();
  for (const s of ['search', 'detail', 'chargement']) e = empiler(e, s);
  assert.deepEqual(e.pile.map((v) => v.screen), ['dash', 'search', 'detail']);
  e = depiler(e); assert.equal(e.vue.screen, 'detail');
  e = depiler(e); assert.equal(e.vue.screen, 'search');
  e = depiler(e); assert.equal(e.vue.screen, 'dash');
});

test('à la racine, retour ne fait rien (et ne casse pas)', () => {
  const e = vueInitiale();
  assert.equal(ecranPrecedentDe(e), null);
  const apres = depiler(e);
  assert.equal(apres.vue.screen, 'dash');
  assert.deepEqual(apres.pile, []);
  assert.equal(apres, e, 'état inchangé, même référence');
});

test('re-cliquer le même écran n\'empile rien', () => {
  let e = vueInitiale();
  e = empiler(e, 'list');
  const apres3Clics = empiler(empiler(empiler(e, 'list'), 'list'), 'list');
  assert.equal(apres3Clics.pile.length, 1, 'un seul cran à remonter');
  // Un seul retour suffit à quitter la liste.
  assert.equal(depiler(apres3Clics).vue.screen, 'dash');
});

test('même écran mais argument différent = deux vues distinctes', () => {
  // Deux fiches de cargaison : passer de l'une à l'autre doit être empilé.
  let e = vueInitiale();
  e = empiler(e, 'detail', 'CT-1');
  e = empiler(e, 'detail', 'CT-2');
  assert.equal(e.pile.length, 2);
  assert.equal(depiler(e).vue.arg, 'CT-1');
});

test('argument objet : comparé par contenu, pas par référence', () => {
  let e = empiler(vueInitiale(), 'wait_valid', { numeroDeclaration: '4242' });
  const avant = e.pile.length;
  // Même déclaration ré-ouverte (nouvel objet, contenu identique) → pas d'empilement.
  e = empiler(e, 'wait_valid', { numeroDeclaration: '4242' });
  assert.equal(e.pile.length, avant);
  // Déclaration différente → empilée.
  e = empiler(e, 'wait_valid', { numeroDeclaration: '5555' });
  assert.equal(e.pile.length, avant + 1);
});

test('la pile est bornée : les vues les plus anciennes tombent', () => {
  let e = vueInitiale();
  for (let i = 0; i < PILE_MAX + 10; i++) e = empiler(e, 'detail', 'CT-' + i);
  assert.equal(e.pile.length, PILE_MAX);
  // La plus ancienne conservée n'est plus le tableau de bord initial.
  assert.notEqual(e.pile[0]!.screen, 'dash');
});

test('undefined et null d\'argument sont la même vue', () => {
  const e = empiler(vueInitiale(), 'list');
  assert.equal(empiler(e, 'list', null).pile.length, e.pile.length);
  assert.equal(empiler(e, 'list', undefined).pile.length, e.pile.length);
});
