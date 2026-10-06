import test from 'node:test';
import assert from 'node:assert/strict';
import { extraireNumerosTC, rapprocher, type LigneParc } from './rapprochement.ts';
import { aLeDroit } from './permissions.ts';

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

/* ---------------- Qui voit quel onglet (volet Sejour conteneurs) --------- */

test('ACP : le CFS tient le parc, il ne le controle pas', () => {
  /* L'interet d'un controle tient a ce qu'il ne soit pas fait par le controle.
     Le CFS garde le rapport de stock, mais pas le rapprochement : il verra
     donc l'onglet « Parc » seul, sans barre d'onglets. */
  assert.equal(aLeDroit('CFS', 'report.stock'), true);
  assert.equal(aLeDroit('CFS', 'acp.rapprocher'), false);
});

test("ACP : le chef de division a le rapprochement SANS le rapport de stock", () => {
  /* C'est ce qui justifie de ne demander `report.stock` qu'a qui y a droit :
     sans cette precaution, ouvrir le volet lui renverrait une erreur avant
     meme qu'il ait vu un onglet. */
  assert.equal(aLeDroit('CHEF_DIVISION', 'acp.rapprocher'), true);
  assert.equal(aLeDroit('CHEF_DIVISION', 'report.stock'), false);
});

test('ACP : le chef de brigade et ADMIN voient les DEUX onglets', () => {
  for (const r of ['CHEF_BRIGADE', 'ADMIN']) {
    assert.equal(aLeDroit(r, 'report.stock'), true, r);
    assert.equal(aLeDroit(r, 'acp.rapprocher'), true, r);
  }
});

test('ACP : les roles techniques heritent de l’ADMIN, ici comme ailleurs', () => {
  for (const r of ['SUPER_ADMIN', 'INFO']) {
    assert.equal(aLeDroit(r, 'acp.rapprocher'), true, r);
    assert.equal(aLeDroit(r, 'acp.historique'), true, r);
  }
});

test("ACP : aucune cellule d'etape n'a le rapprochement", () => {
  for (const r of ['T1', 'BALISE', 'BON_SORTIE', 'PP', 'CHEF_VISITE', 'CBPI'])
    assert.equal(aLeDroit(r, 'acp.rapprocher'), false, r);
});

/* --------------------- Restreindre le perimetre ------------------------- */

test('perimetre : restreint, le rapprochement ne juge que ce qui en releve', () => {
  const r = rapprocher(['MSKU1234567', 'TGHU7654321'], parc(),
    (l) => l.statut === 'En stock');
  // TGHU est « Positionné » : hors perimetre, donc NI concordant NI inconnu.
  assert.deepEqual(r.concordants.map((l) => l.numeroTC), ['MSKU1234567']);
  assert.deepEqual(r.horsPerimetre.map((l) => l.numeroTC), ['TGHU7654321']);
  assert.equal(r.listeInconnus.length, 0);
  assert.equal(r.compte.parc, 2);   // les deux « En stock » seulement
});

test("perimetre : UN CONTENEUR PRESENT N'EST JAMAIS DECLARE INCONNU", () => {
  /* La raison d'etre de la cinquieme case. Sans elle, comparer sur « En
     stock » ferait reclamer a l'ACP un conteneur simplement « Positionné »,
     qu'on a sous les yeux. */
  const r = rapprocher(['TGHU7654321'], parc(), (l) => l.statut === 'En stock');
  assert.equal(r.listeInconnus.length, 0);
  assert.deepEqual(r.horsPerimetre.map((l) => l.numeroTC), ['TGHU7654321']);
});

test('perimetre : par defaut il ne restreint rien, et la cinquieme case reste vide', () => {
  const r = rapprocher(['MSKU1234567', 'TGHU7654321'], parc());
  assert.equal(r.horsPerimetre.length, 0);
  assert.equal(r.compte.concordants, 2);
});

test('perimetre : le depote reste depote, meme hors perimetre', () => {
  /* Un conteneur sorti ne doit jamais glisser dans « hors perimetre » : la
     question qu'il pose (leur liste est-elle en retard ?) est tout autre. */
  const r = rapprocher(['HLXU2222222'], parc(), (l) => l.statut === 'En stock');
  assert.deepEqual(r.listeDejaDepotes.map((l) => l.numeroTC), ['HLXU2222222']);
  assert.equal(r.horsPerimetre.length, 0);
});
