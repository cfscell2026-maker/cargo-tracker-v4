import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ecartLigne, totauxTransmission, manqueAuDepart, manqueALArrivee, nombreOuNull,
  type MarchandiseTransmise,
} from './transmission.ts';

const m = (designation: string, dep: number, arr?: number | null): MarchandiseTransmise =>
  ({ designation, quantiteDepart: dep, quantiteArrivee: arr });

/* ------------- « pas encore connu » n'est pas « zero » ------------------ */

test("transmission : une arrivee INCONNUE ne produit aucun ecart", () => {
  /* La distinction qui porte tout ce module. Traiter l'absence comme un zero
     ferait apparaitre un manquant de 100 sur une marchandise dont on attend
     simplement la reponse du pays de destination. */
  assert.equal(ecartLigne(m('Riz', 100)), null);
  assert.equal(ecartLigne(m('Riz', 100, null)), null);
  assert.equal(ecartLigne(m('Riz', 100, undefined)), null);
});

test("transmission : une arrivee A ZERO est une information, et vaut un ecart", () => {
  assert.equal(ecartLigne(m('Riz', 100, 0)), -100);
});

test('transmission : l ecart est negatif quand il manque, positif quand il y a du surplus', () => {
  assert.equal(ecartLigne(m('Riz', 100, 92)), -8);
  assert.equal(ecartLigne(m('Riz', 100, 104)), 4);
  assert.equal(ecartLigne(m('Riz', 100, 100)), 0);
});

/* ----------------------------- Les totaux ------------------------------- */

test('transmission : l ecart total NE PORTE QUE sur les lignes renseignees', () => {
  /* Deux lignes connues, une en attente. Additionner le depart de la ligne en
     attente ferait un manquant imaginaire de 50, qui grossirait a chaque
     marchandise ajoutee. */
  const t = totauxTransmission([m('Riz', 100, 92), m('Sucre', 40, 40), m('Huile', 50)]);
  assert.equal(t.depart, 190, 'le depart total compte TOUTES les lignes');
  assert.equal(t.arrivee, 132);
  assert.equal(t.ecart, -8, 'et non -58 : la ligne en attente ne compte pas');
  assert.equal(t.enAttente, 1);
  assert.equal(t.lignes, 3);
});

test("transmission : tant qu'aucune arrivee n'est connue, l ecart reste indetermine", () => {
  const t = totauxTransmission([m('Riz', 100), m('Sucre', 40)]);
  assert.equal(t.ecart, null, 'pas de chiffre tant qu on n a rien constate');
  assert.equal(t.enAttente, 2);
  assert.equal(t.depart, 140);
});

test('transmission : aucune ligne, aucun total', () => {
  const t = totauxTransmission([]);
  assert.deepEqual([t.depart, t.arrivee, t.ecart, t.lignes, t.enAttente], [0, 0, null, 0, 0]);
});

test('transmission : la virgule decimale est acceptee, comme au clavier francais', () => {
  assert.equal(nombreOuNull('12,5'), 12.5);
  assert.equal(nombreOuNull('12.5'), 12.5);
  assert.equal(nombreOuNull(''), null);
  assert.equal(nombreOuNull('abc'), null);
  assert.equal(nombreOuNull(0), 0, 'zero est un nombre, pas un vide');
});

/* ---------------------------- Ce qui manque ----------------------------- */

test('transmission : le depart exige pays, IM4 et au moins une marchandise', () => {
  assert.match(manqueAuDepart({}, []) ?? '', /pays de destination/);
  assert.match(manqueAuDepart({ paysDestination: 'Burkina Faso' }, []) ?? '', /IM4/);
  assert.match(manqueAuDepart({ paysDestination: 'Burkina Faso', numeroIm4: 'IM4-99' }, []) ?? '', /au moins une marchandise/);
});

test('transmission : chaque marchandise exige sa designation et sa quantite', () => {
  const e = { paysDestination: 'Niger', numeroIm4: 'IM4-12' };
  assert.match(manqueAuDepart(e, [m('', 10)]) ?? '', /Marchandise 1 .*désignation/);
  assert.match(manqueAuDepart(e, [m('Riz', 10), { designation: 'Sucre', quantiteDepart: NaN }]) ?? '',
    /Marchandise 2 .*quantité/);
  assert.equal(manqueAuDepart(e, [m('Riz', 10), m('Sucre', 0)]), null, 'zero au depart est permis');
});

test('transmission : aucune quantite negative, ni au depart ni a l arrivee', () => {
  const e = { paysDestination: 'Niger', numeroIm4: 'IM4-12' };
  assert.match(manqueAuDepart(e, [m('Riz', -1)]) ?? '', /négative/);
  assert.match(manqueALArrivee([m('Riz', 10, -2)]) ?? '', /négative/);
  assert.equal(manqueALArrivee([m('Riz', 10, 0), m('Sucre', 5)]), null);
});
