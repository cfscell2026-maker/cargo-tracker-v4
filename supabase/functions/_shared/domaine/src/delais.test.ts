/**
 * Tests du calcul des TEMPS DE PASSAGE (delais.ts).
 * Ce sont des indicateurs de performance : une erreur ici ne casse rien à
 * l'écran, elle produit un chiffre faux que personne ne peut recouper. D'où
 * une couverture serrée des cas tordus : cellules sautées, dates manquantes,
 * dates incohérentes, parcours parallèle.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { delaisDe, agreger, dureeLisible, enHeures, POSTES, LIBELLE_POSTE } from './delais.ts';

/** Repère temporel fixe : 10 août 2026, 06:00. */
const T0 = new Date('2026-08-10T06:00:00Z').getTime();
const h = (n: number) => new Date(T0 + n * 3600000).toISOString();

test('parcours nominal : chaque poste mesuré depuis la fin de chargement', () => {
  const d = delaisDe({
    dateCreation: h(0),        // entrée du camion
    dateFinChargement: h(2),   // CFS : 2 h
    dateValidation: h(3),      // +1 h après la fin de chargement
    dateT1: h(5),              // +3 h
    datePoseGps: h(6),         // +4 h
    dateBonSortie: h(4),       // +2 h  (le BS peut passer AVANT le T1 : parallèle)
    dateSortie: h(7),          // éligible à h(6) (dernier des jalons) → PP = 1 h
  });
  assert.equal(d.cfs, 120);
  assert.equal(d.validation, 60);
  assert.equal(d.t1, 180);
  assert.equal(d.balise, 240);
  assert.equal(d.bs, 120);
  assert.equal(d.pp, 60, 'la PP se mesure depuis le DERNIER jalon exigé, pas depuis la fin de chargement');
  assert.equal(d.global, 420);
  assert.equal(d.approx, false);
  assert.equal(d.incoherent, false);
});

test('cellule sautée = non mesurée (null), surtout pas zéro', () => {
  // Type C non balisé : saute le T1 ET la Balise. Les compter 0 min ferait
  // chuter artificiellement les moyennes de ces deux cellules.
  const d = delaisDe({
    dateCreation: h(0), dateFinChargement: h(1),
    sauteT1: true, sauteBalise: true,
    dateT1: h(9), datePoseGps: h(9), // dates résiduelles : ignorées
    dateBonSortie: h(2), dateSortie: h(3),
  });
  assert.equal(d.t1, null);
  assert.equal(d.balise, null);
  assert.equal(d.bs, 60);
  // Aucun jalon exigé → l'éligibilité PP retombe sur la fin de chargement.
  assert.equal(d.pp, 120);
});

test('véhicule : pas de cellule Balise', () => {
  const d = delaisDe({
    dateCreation: h(0), dateFinChargement: h(1),
    estVehicule: true, datePoseGps: h(5),
    dateT1: h(2), dateSortie: h(4),
  });
  assert.equal(d.balise, null);
  assert.equal(d.pp, 120, 'éligible dès le T1 puisque la balise ne le concerne pas');
});

test("saut du bon de sortie : les deux orthographes sont honorées", () => {
  // `sauteBs` vient de la colonne SQL, `sauteBS` des payloads client.
  const base = { dateCreation: h(0), dateFinChargement: h(1), dateBonSortie: h(3) };
  assert.equal(delaisDe({ ...base, sauteBs: true }).bs, null);
  assert.equal(delaisDe({ ...base, sauteBS: 'Oui' }).bs, null);
  assert.equal(delaisDe(base).bs, 120, 'sans saut, le BS est bien mesuré');
});

test('cargaison antérieure (fin de chargement inconnue) : amont non mesurable, global exact', () => {
  const d = delaisDe({
    dateCreation: h(0), dateT1: h(3), datePoseGps: h(4), dateSortie: h(6),
  });
  assert.equal(d.approx, true);
  assert.equal(d.cfs, null);
  assert.equal(d.validation, null);
  assert.equal(d.t1, null);
  assert.equal(d.balise, null);
  // La PP reste mesurable : son point de départ est le dernier jalon, pas la
  // fin de chargement. C'est ce qui rend l'historique exploitable.
  assert.equal(d.pp, 120);
  assert.equal(d.global, 360, 'entrée → sortie reste exact même sans fin de chargement');
});

test('dates incohérentes : écartées et signalées, jamais comptées 0', () => {
  const d = delaisDe({
    dateCreation: h(5), dateFinChargement: h(2), // fin AVANT l'entrée
    dateSortie: h(8),
  });
  assert.equal(d.cfs, null);
  assert.equal(d.incoherent, true);
});

test('cargaison non sortie : global et PP encore ouverts', () => {
  const d = delaisDe({ dateCreation: h(0), dateFinChargement: h(1), dateT1: h(2), datePoseGps: h(3) });
  assert.equal(d.global, null);
  assert.equal(d.pp, null);
  assert.equal(d.t1, 60);
});

test('agreger : ignore les non-mesurés, médiane et p90 corrects', () => {
  const a = agreger([10, null, 20, 30, null, 40, 50, 60, 70, 80, 90, 100]);
  assert.equal(a.n, 10, 'les null ne comptent pas dans l\'effectif');
  assert.equal(a.moyenne, 55);
  assert.equal(a.mediane, 55, 'effectif pair → moyenne des deux valeurs centrales');
  assert.equal(a.p90, 90);
  assert.equal(a.min, 10);
  assert.equal(a.max, 100);
});

test('agreger : série vide = aucun chiffre inventé', () => {
  const a = agreger([null, null]);
  assert.deepEqual(a, { n: 0, moyenne: null, mediane: null, p90: null, min: null, max: null });
});

test('agreger : médiane sur effectif impair', () => {
  assert.equal(agreger([10, 20, 90]).mediane, 20);
});

test('dureeLisible : lisible par un agent, pas par une calculette', () => {
  assert.equal(dureeLisible(45), '45 min');
  assert.equal(dureeLisible(60), '1 h');
  assert.equal(dureeLisible(155), '2 h 35');
  assert.equal(dureeLisible(1440), '1 j');
  assert.equal(dureeLisible(1500), '1 j 1 h');
  assert.equal(dureeLisible(null), '—');
});

test('enHeures : une décimale pour les graphiques', () => {
  assert.equal(enHeures(90), 1.5);
  assert.equal(enHeures(155), 2.6);
  assert.equal(enHeures(null), null);
});

test('les six postes ont un libellé', () => {
  assert.equal(POSTES.length, 6);
  for (const p of POSTES) assert.ok(LIBELLE_POSTE[p], `libellé manquant pour ${p}`);
});
