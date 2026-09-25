/**
 * Entrées et sorties des files (2026-09-13), `passagesDesFiles`.
 * L'invariant décisif : sur une période couvrant toute la vie des dossiers,
 * entrées − sorties de chaque file = le nombre de dossiers que `fileAttente` y range.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { passagesDesFiles, fileAttente, ORDRE_FILES, STATUTS } from './index.ts';

const h = (heure: string) => `2026-09-10T${heure}:00Z`;
const t = (heure: string) => new Date(h(heure)).getTime();

test('parcours complet : chaque sortie est l\'entrée de la file suivante', () => {
  const p = passagesDesFiles({
    statut: STATUTS.SORTIE, typeDeclaration: 'T',
    dateCreation: h('08:00'), dateFinChargement: h('09:00'), dateValidation: h('10:00'),
    dateT1: h('11:00'), bonSortieNumero: 'BS1', dateBonSortie: h('12:00'), datePoseGps: h('13:00'), dateSortie: h('14:00'),
  });
  assert.deepEqual(p.CFS, { entree: t('08:00'), sortie: t('09:00') });
  assert.deepEqual(p.VALIDATION, { entree: t('09:00'), sortie: t('10:00') });
  assert.deepEqual(p.T1, { entree: t('10:00'), sortie: t('11:00') });
  assert.deepEqual(p.BS, { entree: t('11:00'), sortie: t('12:00') });
  assert.deepEqual(p.BALISE, { entree: t('12:00'), sortie: t('13:00') });
  assert.deepEqual(p.PP, { entree: t('13:00'), sortie: t('14:00') });
});

test('un dossier en attente est dans UNE file, sans sortie, et nulle part après', () => {
  const c = { statut: STATUTS.CREEE, typeDeclaration: 'T', dateCreation: h('08:00'), dateFinChargement: h('09:00'), dateValidation: h('10:00') };
  const p = passagesDesFiles(c);
  assert.equal(fileAttente(c as never), 'T1');
  assert.deepEqual(p.T1, { entree: t('10:00'), sortie: null });
  assert.equal(p.BALISE, undefined);
});

test("type C : pas de file T1, le dossier passe de la validation au bon de sortie", () => {
  const p = passagesDesFiles({ statut: STATUTS.CREEE, typeDeclaration: 'C', dateCreation: h('08:00'), dateFinChargement: h('09:00'), dateValidation: h('10:00') });
  assert.equal(p.T1, undefined);
  assert.deepEqual(p.BS, { entree: t('10:00'), sortie: null });
});

test("balise posee AVANT le bon de sortie (dossier d'avant le 25/09) : traversee a l'arrivee", () => {
  // L'ordre d'hier laisse des dossiers balises avant leur bon. La file BALISE
  // est alors franchie a l'instant ou le dossier l'atteint, sans duree negative.
  const p = passagesDesFiles({ statut: STATUTS.BS, typeDeclaration: 'T', dateCreation: h('08:00'), dateFinChargement: h('09:00'),
    dateValidation: h('10:00'), dateT1: h('11:00'), datePoseGps: h('11:30'), bonSortieNumero: 'BS1', dateBonSortie: h('12:00') });
  assert.deepEqual(p.BS, { entree: t('11:00'), sortie: t('12:00') });
  assert.deepEqual(p.BALISE, { entree: t('12:00'), sortie: t('12:00') });
  assert.deepEqual(p.PP, { entree: t('12:00'), sortie: null });
});

test('camion sorti sans date de balise : il quitte les files à sa sortie du port', () => {
  const p = passagesDesFiles({ statut: STATUTS.SORTIE, typeDeclaration: 'T', dateCreation: h('08:00'), dateFinChargement: h('09:00'),
    dateValidation: h('10:00'), dateT1: h('11:00'), dateSortie: h('15:00') });
  assert.deepEqual(p.BS, { entree: t('11:00'), sortie: t('15:00') });
  assert.deepEqual(p.BALISE, { entree: t('15:00'), sortie: t('15:00') });
  assert.deepEqual(p.PP, { entree: t('15:00'), sortie: t('15:00') });
});

test('INVARIANT : entrées − sorties = taille de chaque file (dossiers variés)', () => {
  const dossiers = [
    { statut: STATUTS.CAMION, dateCreation: h('08:00') },
    { statut: STATUTS.CHARGEMENT, dateCreation: h('08:10') },
    { statut: STATUTS.CREEE, typeDeclaration: 'T', dateCreation: h('08:00'), dateFinChargement: h('08:30') },
    { statut: STATUTS.CREEE, typeDeclaration: 'T', dateCreation: h('08:00'), dateFinChargement: h('08:30'), dateValidation: h('09:00') },
    { statut: STATUTS.CREEE, typeDeclaration: 'C', dateCreation: h('08:00'), dateFinChargement: h('08:30'), dateValidation: h('09:00') },
    { statut: STATUTS.T1, typeDeclaration: 'T', dateCreation: h('08:00'), dateFinChargement: h('08:30'), dateValidation: h('09:00'), dateT1: h('10:00') },
    { statut: STATUTS.GPS, typeDeclaration: 'T', dateCreation: h('08:00'), dateFinChargement: h('08:30'), dateValidation: h('09:00'), dateT1: h('10:00'), datePoseGps: h('11:00') },
    { statut: STATUTS.GPS, typeDeclaration: 'T', sauteBalise: true, dateCreation: h('08:00'), dateFinChargement: h('08:30'), dateT1: h('10:00') },
    { statut: STATUTS.BS, typeDeclaration: 'T', dateCreation: h('08:00'), dateFinChargement: h('08:30'), dateValidation: h('09:00'), dateT1: h('10:00'), datePoseGps: h('11:00'), bonSortieNumero: 'X', dateBonSortie: h('12:00') },
    { statut: STATUTS.BS, typeDeclaration: 'T', dateCreation: h('08:00'), dateFinChargement: h('08:30'), dateValidation: h('09:00'), bonSortieNumero: 'X', dateBonSortie: h('09:30') },
    { statut: STATUTS.SORTIE, typeDeclaration: 'T', dateCreation: h('08:00'), dateFinChargement: h('08:30'), dateSortie: h('16:00') },
    { statut: STATUTS.CREEE, typeDeclaration: 'T', dateCreation: h('08:00') }, // ancien dossier sans fin de chargement
    { statut: STATUTS.CREEE, typeDeclaration: 'T', dateCreation: h('08:00'), dateSortie: h('17:00') }, // sorti, statut resté intermédiaire
  ];
  const entres: Record<string, number> = {}, sortis: Record<string, number> = {}, taille: Record<string, number> = {};
  for (const k of ORDRE_FILES) { entres[k] = 0; sortis[k] = 0; taille[k] = 0; }
  for (const d of dossiers) {
    const f = fileAttente(d as never);
    if (f) taille[f]!++;
    const p = passagesDesFiles(d);
    const ouverts = ORDRE_FILES.filter((k) => p[k] && p[k]!.sortie === null);
    assert.deepEqual(ouverts, f ? [f] : [], `dossier ${JSON.stringify(d)}`);
    for (const k of ORDRE_FILES) { if (!p[k]) continue; entres[k]!++; if (p[k]!.sortie !== null) sortis[k]!++; }
  }
  for (const k of ORDRE_FILES) assert.equal(entres[k]! - sortis[k]!, taille[k], `file ${k}`);
});
