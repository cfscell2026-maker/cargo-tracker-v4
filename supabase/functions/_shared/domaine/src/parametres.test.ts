/**
 * Paramètres de l'application (2026-09-21). Ce qui compte : les défauts sont
 * EXACTEMENT le comportement d'avant, une faute de frappe est refusée, et une
 * valeur abîmée en base ne fait jamais tomber l'application.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PARAMETRES, PARAMETRES_DEFAUT, validerParametre, valeursParametres } from './parametres.ts';
import { SEUIL_ALERTE_SEJOUR, CONTENEURS_MAX, HAUTEUR_HORS_GABARIT, ENGAGEMENTS } from './constantes.ts';

test('les défauts reproduisent le comportement d\'avant les paramètres', () => {
  assert.equal(PARAMETRES_DEFAUT.sejourAlerteJours, SEUIL_ALERTE_SEJOUR);
  assert.equal(PARAMETRES_DEFAUT.conteneursMaxCamion, CONTENEURS_MAX);
  assert.equal(PARAMETRES_DEFAUT.hauteurHorsGabarit, HAUTEUR_HORS_GABARIT);
  assert.deepEqual(PARAMETRES_DEFAUT.engagementsProposes, [...ENGAGEMENTS]);
  assert.equal(PARAMETRES_DEFAUT.engagementAlerteJours, 1, 'alerte la veille, comme avant');
  assert.equal(PARAMETRES_DEFAUT.engagementDelaiDefaut, 0, 'aucun délai imposé, comme avant');
  assert.equal(PARAMETRES_DEFAUT.actualisationSecondes, 60);
  assert.equal(PARAMETRES_DEFAUT.archiveMois, 12);
});

test('chaque paramètre a une aide et dit qui il concerne', () => {
  for (const d of PARAMETRES) {
    assert.ok(d.aide.length > 30, `aide trop courte : ${d.cle}`);
    assert.ok(d.concerne.length > 5, `« concerne » manquant : ${d.cle}`);
  }
});

test('bornes : une faute de frappe est refusée avec un message clair', () => {
  const r = validerParametre('sejourAlerteJours', 900);
  assert.equal(r.ok, false);
  assert.match((r as { erreur: string }).erreur, /entre 7 et 365 jours/);
  assert.equal(validerParametre('sejourAlerteJours', '45').ok, true);
  assert.equal(validerParametre('conteneursMaxCamion', 2.5).ok, false, 'un entier est attendu');
  assert.equal(validerParametre('sejourAlerteJours', '').ok, false);
  assert.equal(validerParametre('inconnu', 1).ok, false);
});

test('décimal : la virgule est acceptée et arrondie au centième', () => {
  const r = validerParametre('hauteurHorsGabarit', '4,257');
  assert.deepEqual(r, { ok: true, valeur: 4.26 });
});

test('liste : une ligne par choix, vides et doublons ignorés, au moins un choix', () => {
  const r = validerParametre('engagementsProposes', 'Transit national\n\n  transit national \nBFE 03 Sinkase');
  assert.deepEqual(r, { ok: true, valeur: ['Transit national', 'BFE 03 Sinkase'] });
  assert.equal(validerParametre('engagementsProposes', '\n  \n').ok, false);
});

test('valeurs effectives : une valeur abîmée en base reprend son défaut', () => {
  const v = valeursParametres({ sejourAlerteJours: 30, conteneursMaxCamion: 'n\'importe quoi', inconnu: 5 });
  assert.equal(v.sejourAlerteJours, 30, 'la bonne valeur est prise');
  assert.equal(v.conteneursMaxCamion, CONTENEURS_MAX, 'la mauvaise est ignorée');
  assert.deepEqual(valeursParametres(null), PARAMETRES_DEFAUT);
});
