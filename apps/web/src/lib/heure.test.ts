/** Salutation et heure de la barre supérieure. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { heureCourte, salutation } from './heure.ts';

const a = (h: number, m = 0) => new Date(2026, 8, 11, h, m);

test('la salutation suit l\'usage français, pas un découpage arithmétique', () => {
  assert.equal(salutation(a(2)), 'Bonne nuit');
  assert.equal(salutation(a(6)), 'Bonjour');
  assert.equal(salutation(a(11, 59)), 'Bonjour');
  assert.equal(salutation(a(12)), 'Bon après-midi');
  assert.equal(salutation(a(16, 59)), 'Bon après-midi');
  // « Bonsoir » se dit dès la fin d'après-midi, bien avant la nuit.
  assert.equal(salutation(a(17)), 'Bonsoir');
  assert.equal(salutation(a(23, 59)), 'Bonsoir');
});

test('la relève de nuit n\'est pas saluée d\'un « bonjour »', () => {
  assert.equal(salutation(a(0)), 'Bonne nuit');
  assert.equal(salutation(a(4, 59)), 'Bonne nuit');
});

test('l\'heure est toujours sur deux chiffres', () => {
  assert.equal(heureCourte(a(8, 5)), '08:05');
  assert.equal(heureCourte(a(0, 0)), '00:00');
  assert.equal(heureCourte(a(23, 9)), '23:09');
});
