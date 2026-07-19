/**
 * Tests de l'historique de navigation. Comportement visé : « Retour » ramène là
 * où l'on était (jamais sur un écran fixe), et « Suivant » refait le chemin.
 * Exécutable : `node --test`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { empiler, allerA, vueInitiale, vueCourante, ecranPrecedentDe, PILE_MAX } from './navigation.ts';

/**
 * Reculer / avancer comme le fait la PRODUCTION : le navigateur nous rend
 * l'index de l'entrée atteinte, on s'y aligne via `allerA`.
 */
const reculer = (e: Parameters<typeof allerA>[0]) => allerA(e, e.index - 1);
const avancer = (e: Parameters<typeof allerA>[0]) => allerA(e, e.index + 1);

test('retour ramène à l\'écran précédent, pas à un écran fixe', () => {
  // Le chef part de sa file d'attente, ouvre une fiche : retour = la file.
  let e = vueInitiale();
  e = empiler(e, 'wait_valid');
  e = empiler(e, 'detail', 'CT-2026-000123');
  assert.equal(ecranPrecedentDe(e), 'wait_valid');
  e = reculer(e);
  assert.equal(vueCourante(e).screen, 'wait_valid');
  // Et non 'list', qui était la destination codée en dur auparavant.
  assert.notEqual(vueCourante(e).screen, 'list');
});

test('retours successifs : on remonte le chemin réellement parcouru', () => {
  let e = vueInitiale();
  for (const s of ['search', 'detail', 'chargement']) e = empiler(e, s);
  e = reculer(e); assert.equal(vueCourante(e).screen, 'detail');
  e = reculer(e); assert.equal(vueCourante(e).screen, 'search');
  e = reculer(e); assert.equal(vueCourante(e).screen, 'dash');
});

test('au début de l\'historique, retour ne fait rien (et ne casse pas)', () => {
  const e = vueInitiale();
  assert.equal(ecranPrecedentDe(e), null);
  const apres = reculer(e);
  assert.equal(vueCourante(apres).screen, 'dash');
  assert.equal(apres, e, 'état inchangé, même référence');
});

test('« Suivant » refait le chemin après un retour', () => {
  let e = vueInitiale();
  e = empiler(e, 'list');
  e = empiler(e, 'detail', 'CT-7');
  e = reculer(e);
  assert.equal(vueCourante(e).screen, 'list');
  e = avancer(e);
  assert.equal(vueCourante(e).screen, 'detail');
  assert.equal(vueCourante(e).arg, 'CT-7');
  // À la fin de l'historique, avancer ne fait rien.
  const fin = avancer(e);
  assert.equal(fin, e);
});

test('naviguer après un retour tronque l\'avant (comme un navigateur)', () => {
  let e = vueInitiale();
  e = empiler(e, 'list');
  e = empiler(e, 'detail', 'CT-7');
  e = reculer(e);                    // on est sur 'list', 'detail' est devant
  e = empiler(e, 'chargement');      // nouvelle branche
  assert.equal(vueCourante(e).screen, 'chargement');
  assert.equal(avancer(e), e, 'plus rien devant');
  assert.deepEqual(e.vues.map((v) => v.screen), ['dash', 'list', 'chargement']);
});

test('re-cliquer le même écran ne crée pas d\'entrée', () => {
  let e = vueInitiale();
  e = empiler(e, 'list');
  const apres3Clics = empiler(empiler(empiler(e, 'list'), 'list'), 'list');
  assert.equal(apres3Clics, e, 'aucun changement d\'état');
  // Un seul retour suffit à quitter la liste.
  assert.equal(vueCourante(reculer(apres3Clics)).screen, 'dash');
});

test('même écran mais argument différent = deux vues distinctes', () => {
  // Deux fiches de cargaison : passer de l'une à l'autre doit être empilé.
  let e = vueInitiale();
  e = empiler(e, 'detail', 'CT-1');
  e = empiler(e, 'detail', 'CT-2');
  assert.equal(e.vues.length, 3);
  assert.equal(vueCourante(reculer(e)).arg, 'CT-1');
});

test('argument objet : comparé par contenu, pas par référence', () => {
  // Cas réel : la déclaration ouverte du dossier de validation.
  let e = empiler(vueInitiale(), 'wait_valid', { numeroDeclaration: '4242' });
  const avant = e.vues.length;
  e = empiler(e, 'wait_valid', { numeroDeclaration: '4242' });
  assert.equal(e.vues.length, avant, 'même déclaration : pas de doublon');
  e = empiler(e, 'wait_valid', { numeroDeclaration: '5555' });
  assert.equal(e.vues.length, avant + 1);
});

test('allerA borne la cible : un index étranger ne sort jamais de la liste', () => {
  let e = vueInitiale();
  e = empiler(e, 'list');
  e = empiler(e, 'detail', 'CT-1');
  assert.equal(allerA(e, 99).index, 2, 'plafonné à la dernière vue');
  assert.equal(allerA(e, -5).index, 0, 'planché à la première');
  assert.equal(allerA(e, 1.9).index, 1, 'index non entier tronqué');
  assert.equal(allerA(e, 2), e, 'cible = position courante : état inchangé');
});

test('l\'historique est borné : les vues les plus anciennes tombent', () => {
  let e = vueInitiale();
  for (let i = 0; i < PILE_MAX + 10; i++) e = empiler(e, 'detail', 'CT-' + i);
  assert.equal(e.vues.length, PILE_MAX);
  assert.equal(e.index, PILE_MAX - 1, 'le curseur reste sur la vue courante');
  assert.equal(vueCourante(e).arg, 'CT-' + (PILE_MAX + 9));
});

test('undefined et null d\'argument sont la même vue', () => {
  const e = empiler(vueInitiale(), 'list');
  assert.equal(empiler(e, 'list', null), e);
  assert.equal(empiler(e, 'list', undefined), e);
});
