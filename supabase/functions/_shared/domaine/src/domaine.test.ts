/**
 * Tests unitaires du cœur métier (exécutables : `node --test`).
 * Vérifient la FIDÉLITÉ à la v3.6 : moteur d'étapes, normalisation, permissions.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  STATUTS, OPERATIONS, ROLES,
  etatCellules, etapesEnAttente, prochaineEtape, estOui, aFait,
  tcValide, maj, alphaNumMaj, normAlphaNum, declKey, normaliserDeclaration,
  parseConteneursDetails, parseDateImport, tailleBucket, evpDeTaille, trancheAge,
  verifierPermission, PERMISSIONS, TYPES_DECLARATION,
} from './index.ts';

/* ------------------------------ Moteur workflow ------------------------ */

test('camion vide → étape CFS', () => {
  assert.deepEqual(etapesEnAttente({ statut: STATUTS.CAMION }), ['CFS']);
  assert.deepEqual(etapesEnAttente({ statut: STATUTS.CHARGEMENT }), ['CFS']);
  assert.deepEqual(etapesEnAttente({ statut: STATUTS.VEHICULE_OUILLAGE }), ['CFS']);
});

test('après CFS (Créée) → VALIDATION avant T1', () => {
  assert.deepEqual(etapesEnAttente({ statut: STATUTS.CREEE }), ['VALIDATION']);
});

test('validé mais pas T1 → T1', () => {
  assert.deepEqual(etapesEnAttente({ statut: STATUTS.CREEE, dateValidation: '2026-01-01' }), ['T1']);
});

test('après T1 → BALISE et BS EN PARALLÈLE', () => {
  const c = { statut: STATUTS.T1, dateValidation: 'x', dateT1: 'x' };
  assert.deepEqual(etapesEnAttente(c), ['BALISE', 'BS']);
});

test('balise faite, BS pas encore → BS seul (pas PP)', () => {
  const c = { statut: STATUTS.T1, dateValidation: 'x', dateT1: 'x', datePoseGps: 'x' };
  assert.deepEqual(etapesEnAttente(c), ['BS']);
});

test('balise ET bs faits → PP', () => {
  const c = { statut: STATUTS.T1, dateValidation: 'x', dateT1: 'x', datePoseGps: 'x', bonSortieNumero: 'BS1' };
  assert.deepEqual(etapesEnAttente(c), ['PP']);
});

test('sorti → aucune étape', () => {
  assert.deepEqual(etapesEnAttente({ statut: STATUTS.SORTIE }), []);
});

test('véhicule saute la balise (parallèle = BS seul puis PP)', () => {
  const c = { statut: STATUTS.T1, estVehicule: 'Oui', dateValidation: 'x', dateT1: 'x' };
  assert.deepEqual(etapesEnAttente(c), ['BS']);
});

test('conso non balisée : sauts T1 + Balise', () => {
  const c = { statut: STATUTS.CREEE, dateValidation: 'x', sauteT1: 'Oui', sauteBalise: 'Oui' };
  assert.deepEqual(etapesEnAttente(c), ['BS']);
});

test('ouillage saute le BS', () => {
  const c = { statut: STATUTS.T1, dateValidation: 'x', dateT1: 'x', sauteBalise: 'Oui', sauteBS: 'Oui' };
  assert.deepEqual(etapesEnAttente(c), ['PP']);
});

test('prochaineEtape = 1re en attente', () => {
  assert.equal(prochaineEtape({ statut: STATUTS.CREEE }), 'VALIDATION');
  assert.equal(prochaineEtape({ statut: STATUTS.SORTIE }), null);
});

test('estOui / aFait acceptent booléens et chaînes', () => {
  assert.equal(estOui('Oui'), true);
  assert.equal(estOui(true), true);
  assert.equal(estOui('Non'), false);
  assert.equal(estOui(''), false);
  assert.equal(aFait(''), false);
  assert.equal(aFait(false), false);
  assert.equal(aFait('2026'), true);
});

/* ------------------------------ Normalisation -------------------------- */

test('tcValide : ISO 6346', () => {
  assert.equal(tcValide('MSKU1234567'), true);
  assert.equal(tcValide('msku 123 4567'), true); // normalisé
  assert.equal(tcValide('MSK1234567'), false); // 3 lettres
  assert.equal(tcValide('MSKU123456'), false); // 6 chiffres
});

test('maj / alphaNumMaj / normAlphaNum', () => {
  assert.equal(maj('  abc '), 'ABC');
  assert.equal(alphaNumMaj('ab-12/cd!'), 'AB-12/CD');
  assert.equal(normAlphaNum('ab 12-cd'), 'AB12CD');
});

test('declKey = année|bureau|type|numéro', () => {
  assert.equal(
    declKey({ anneeDeclaration: '2026', bureauDeclaration: 'TG120', typeDeclaration: 'T', numeroDeclaration: '123' }),
    '2026|TG120|T|123',
  );
});

test('normaliserDeclaration exige les champs obligatoires', () => {
  assert.throws(() => normaliserDeclaration({}, OPERATIONS.ENLEVEMENT), /Déclarant/);
  const ok = normaliserDeclaration(
    {
      declarant: 'sté x', contactDeclarant: '90 12 34 56', destinationMarchandise: 'lomé',
      bureauDeclaration: 'tg120', typeDeclaration: 't', numeroDeclaration: '77', anneeDeclaration: '2026',
      descriptionMarchandise: 'riz',
    },
    OPERATIONS.ENLEVEMENT,
  );
  assert.equal(ok.declarant, 'STÉ X');
  assert.equal(ok.contactDeclarant, '90 12 34 56');
});

test('normaliserDeclaration : véhicule sans description', () => {
  const ok = normaliserDeclaration(
    { declarant: 'x', contactDeclarant: '901234', destinationMarchandise: 'd', bureauDeclaration: 'b', typeDeclaration: 't', numeroDeclaration: '1', anneeDeclaration: '2026' },
    OPERATIONS.VEHICULE,
  );
  assert.equal(ok.descriptionMarchandise, '');
});

test('normaliserDeclaration : téléphone trop court rejeté', () => {
  assert.throws(
    () => normaliserDeclaration(
      { declarant: 'x', contactDeclarant: '123', destinationMarchandise: 'd', bureauDeclaration: 'b', typeDeclaration: 't', numeroDeclaration: '1', anneeDeclaration: '2026', descriptionMarchandise: 'r' },
      OPERATIONS.ENLEVEMENT,
    ),
    /téléphone invalide/,
  );
});

test('parseConteneursDetails gère les 2 formes', () => {
  const a = parseConteneursDetails('[{"num":"MSKU1234567"}]');
  assert.equal(a.conteneurs.length, 1);
  assert.deepEqual(a.scellesCamion, []);
  const b = parseConteneursDetails('{"conteneurs":[{"num":"X"}],"scellesCamion":["S1","S2"]}');
  assert.equal(b.conteneurs.length, 1);
  assert.deepEqual(b.scellesCamion, ['S1', 'S2']);
  const c = parseConteneursDetails('');
  assert.deepEqual(c, { conteneurs: [], scellesCamion: [] });
});

test('parseDateImport : formats variés', () => {
  assert.equal(parseDateImport('2026-07-15')?.getFullYear(), 2026);
  assert.equal(parseDateImport('15/07/2026')?.getMonth(), 6);
  assert.equal(parseDateImport(''), null);
});

test('tailleBucket / evp', () => {
  assert.equal(tailleBucket("20'"), 't20');
  assert.equal(tailleBucket('40 HC'), 't40');
  assert.equal(tailleBucket('45'), 't45');
  assert.equal(tailleBucket('autre'), 'autres');
  assert.equal(evpDeTaille('t20'), 1);
  assert.equal(evpDeTaille('t40'), 2);
  assert.equal(evpDeTaille('t45'), 2);
});

test('trancheAge', () => {
  assert.equal(trancheAge(0), '0-7');
  assert.equal(trancheAge(30), '16-30');
  assert.equal(trancheAge(200), '90+');
});

/* ------------------------------ Permissions ---------------------------- */

test('verifierPermission : accès refusé pour un rôle non listé', () => {
  assert.throws(() => verifierPermission(ROLES.T1, 'cargo.cfs'), /Accès refusé pour votre profil\./);
  assert.throws(() => verifierPermission(ROLES.CFS, 'action.inexistante'), /Action inconnue/);
});

test('verifierPermission : CFS peut faire cargo.cfs', () => {
  assert.doesNotThrow(() => verifierPermission(ROLES.CFS, 'cargo.cfs'));
  assert.doesNotThrow(() => verifierPermission(ROLES.ADMIN, 'cargo.gpsedit'));
  assert.throws(() => verifierPermission(ROLES.PP, 'cargo.gpsedit'), /Accès refusé/);
});

test('matrice PERMISSIONS complète (60 actions + resetmfa)', () => {
  assert.ok(Object.keys(PERMISSIONS).length >= 60);
  assert.ok(PERMISSIONS['user.resetmfa']);
});

test('TYPES_DECLARATION = T,C,S,A,E', () => {
  assert.deepEqual([...TYPES_DECLARATION], ['T', 'C', 'S', 'A', 'E']);
});
