/** Extraction du détail d'un rapport de cellule (2026-10-09). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lignesExportCellule, nomFichierCellule, dateHeureFr } from './export-cellule.ts';

const camion = {
  id: 'CT-1', numeroCamion: 'TG1234AB', typeOperation: 'Enlèvement', statut: 'Sortie Enregistrée',
  numeroGps: 'GPS-1', nbConteneurs: 2, declarant: 'STE A / STE B', numeroDeclaration: '200 / 300',
  anneeDeclaration: '2026', bureauDeclaration: 'TG120', typeDeclaration: 'T', destination: 'OUAGA',
  t1: 'T1-A, T1-B', bonSortie: 'BS-1, BS-2', dateCreation: '2026-10-05T08:00:00.000Z', dateSortie: '2026-10-05T14:32:00.000Z',
};

test('camions : déclaration, pièces et dates de cellule, dans l\'ordre affiché', () => {
  const rows = lignesExportCellule([camion, { ...camion, id: 'CT-2', numeroCamion: 'TG9' }], true);
  assert.deepEqual(rows.map((r) => r['ID']), ['CT-1', 'CT-2']);
  const r = rows[0]!;
  assert.equal(r['N° déclaration'], '200 / 300');
  assert.equal(r['Déclarant'], 'STE A / STE B');
  assert.equal(r['T1'], 'T1-A, T1-B');
  assert.equal(r['Bon de sortie'], 'BS-1, BS-2');
  assert.equal(r['Entré le'], '05/10/2026 08:00');
  assert.equal(r['Sorti le'], '05/10/2026 14:32');
  assert.equal(r['Validé le'], '', 'cellule non renseignée : case vide');
});

test('conteneurs : une ligne par conteneur, cargaison retrouvable', () => {
  const [r] = lignesExportCellule([{ conteneur: 'TCLU2222222', taille: "20'", scelle: 'S2', cargaisonId: 'CT-1', numeroCamion: 'TG1234AB', numeroDeclaration: '300', t1: 'T1-B' }], false);
  assert.equal(r!['Conteneur'], 'TCLU2222222');
  assert.equal(r!['ID'], 'CT-1');
  assert.equal(r!['N° déclaration'], '300');
  assert.equal(r!['T1'], 'T1-B');
});

test('dates : jour seul, date et heure, ou vide', () => {
  assert.equal(dateHeureFr('2026-10-05'), '05/10/2026');
  assert.equal(dateHeureFr('2026-10-05T14:32:10Z'), '05/10/2026 14:32');
  assert.equal(dateHeureFr(null), '');
});

test('nom du fichier : rapport, opération, carte et période, sans accents', () => {
  assert.equal(nomFichierCellule('pp', 'Enlèvement', 'Camions', '2026-10-01', '2026-10-09'),
    'rapport-pp-Enlevement-Camions-2026-10-01-au-2026-10-09.xlsx');
  assert.equal(nomFichierCellule('cfs', '', "20'", '', ''), 'rapport-cfs-toutes-operations-20.xlsx');
});
