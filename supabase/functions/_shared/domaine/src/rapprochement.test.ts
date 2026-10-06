import test from 'node:test';
import assert from 'node:assert/strict';
import { extraireNumerosTC, rapprocher, type LigneParc } from './rapprochement.ts';

/* ------------------------- Lire le fichier reçu ------------------------- */

test("extraction : le numero est trouve quelle que soit son ecriture", () => {
  const r = extraireNumerosTC(['MSKU1234567', 'msku 765432-1', ' TGHU0000001 ']);
  assert.deepEqual(r.numeros, ['MSKU1234567', 'MSKU7654321', 'TGHU0000001']);
  assert.deepEqual(r.illisibles, []);
});

test("extraction : la colonne et l'ordre n'ont aucune importance", () => {
  // Le fichier recu : des entetes, une ligne de titre, des colonnes melangees.
  const cellules = [
    'LISTE ACP DU 06/10/2026', '', 'N° Conteneur', 'Taille', 'Observation',
    '40', 'MSKU1234567', 'RAS',
    'TGHU7654321', '20', '',
  ];
  assert.deepEqual(extraireNumerosTC(cellules).numeros, ['MSKU1234567', 'TGHU7654321']);
});

test('extraction : une cellule peut porter plusieurs numeros', () => {
  const r = extraireNumerosTC(['MSKU1234567 / TGHU7654321']);
  assert.deepEqual(r.numeros, ['MSKU1234567', 'TGHU7654321']);
});

test("extraction : un numero repete n'est compte qu'une fois, et il est signale", () => {
  const r = extraireNumerosTC(['MSKU1234567', 'MSKU 1234567', 'TGHU7654321']);
  assert.deepEqual(r.numeros, ['MSKU1234567', 'TGHU7654321']);
  assert.deepEqual(r.doublons, ['MSKU1234567']);
});

test("extraction : ce qui ressemble a un numero sans en etre un est RENDU, pas jete", () => {
  // Six chiffres au lieu de sept : le cas courant du chiffre oublie.
  const r = extraireNumerosTC(['MSKU123456', 'TGHU76543210000']);
  assert.deepEqual(r.numeros, []);
  assert.deepEqual(r.illisibles, ['MSKU123456', 'TGHU76543210000']);
});

test("extraction : dates, tailles et numeros de declaration ne sont pas pris pour des conteneurs", () => {
  const r = extraireNumerosTC(['06/10/2026', '40', 'C 12345', '2026', 'Dépotage', '']);
  assert.deepEqual(r.numeros, []);
  assert.deepEqual(r.illisibles, []);
});

/* --------------------------- Le rapprochement --------------------------- */

const parc = (): LigneParc[] => [
  { numeroTC: 'MSKU1234567', statut: 'En stock',   depote: false },
  { numeroTC: 'TGHU7654321', statut: 'Positionné', depote: false },
  { numeroTC: 'CMAU1111111', statut: 'En stock',   depote: false },
  { numeroTC: 'HLXU2222222', statut: 'Dépoté',     depote: true  },
];

test('rapprochement : chaque conteneur tombe dans une seule case', () => {
  const r = rapprocher(['MSKU1234567', 'TGHU7654321', 'HLXU2222222', 'ZZZU9999999'], parc());
  assert.deepEqual(r.concordants.map((l) => l.numeroTC), ['MSKU1234567', 'TGHU7654321']);
  assert.deepEqual(r.auParcHorsListe.map((l) => l.numeroTC), ['CMAU1111111']);
  assert.deepEqual(r.listeDejaDepotes.map((l) => l.numeroTC), ['HLXU2222222']);
  assert.deepEqual(r.listeInconnus.map((l) => l.numeroTC), ['ZZZU9999999']);
});

test('rapprochement : LE POSITIONNE EST AU PARC, il concorde comme les autres', () => {
  /* La regle qui compte. « Positionné » = pointe le matin pour le depotage du
     jour, mais toujours sur le site. Le tenir pour absent ferait apparaitre
     chaque matin des ecarts qui n'existent pas. */
  const r = rapprocher(['TGHU7654321'], parc());
  assert.deepEqual(r.concordants.map((l) => l.numeroTC), ['TGHU7654321']);
  assert.equal(r.listeInconnus.length, 0);
  assert.equal(r.compte.parc, 3);   // les 3 non depotes, quel que soit leur statut
});

test("rapprochement : « deja depote chez nous » ne se confond pas avec « jamais vu »", () => {
  const r = rapprocher(['HLXU2222222', 'ZZZU9999999'], parc());
  assert.deepEqual(r.listeDejaDepotes.map((l) => l.numeroTC), ['HLXU2222222']);
  assert.deepEqual(r.listeInconnus.map((l) => l.numeroTC), ['ZZZU9999999']);
});

test("rapprochement : l'ecriture du numero recu n'empeche pas la correspondance", () => {
  const r = rapprocher(['msku 123456-7'], parc());
  assert.deepEqual(r.concordants.map((l) => l.numeroTC), ['MSKU1234567']);
});

test('rapprochement : une liste vide laisse TOUT le parc hors liste', () => {
  const r = rapprocher([], parc());
  assert.equal(r.concordants.length, 0);
  assert.equal(r.auParcHorsListe.length, 3);
  assert.equal(r.compte.lus, 0);
});

test('rapprochement : les comptes rendus sont ceux des listes rendues', () => {
  const r = rapprocher(['MSKU1234567', 'HLXU2222222', 'ZZZU9999999'], parc());
  assert.equal(r.compte.concordants, r.concordants.length);
  assert.equal(r.compte.auParcHorsListe, r.auParcHorsListe.length);
  assert.equal(r.compte.listeDejaDepotes, r.listeDejaDepotes.length);
  assert.equal(r.compte.listeInconnus, r.listeInconnus.length);
  // Tout conteneur du parc est soit concordant, soit hors liste : jamais les deux.
  assert.equal(r.compte.concordants + r.compte.auParcHorsListe, r.compte.parc);
});

test('rapprochement : un doublon dans la liste recue ne compte pas deux fois', () => {
  const r = rapprocher(['MSKU1234567', 'MSKU1234567'], parc());
  assert.equal(r.compte.lus, 1);
  assert.equal(r.concordants.length, 1);
});
