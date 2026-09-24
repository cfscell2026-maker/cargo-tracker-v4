/**
 * Découpage du menu en deux blocs (2026-09-10), vérifie qu'il RÉORDONNE
 * seulement, et n'ouvre aucun accès.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MENUS, iconeDeLEcran, menuSections } from './menu.ts';

test('menu, le découpage ne crée ni ne perd aucune entrée', () => {
  for (const role of Object.keys(MENUS)) {
    const attendu = (MENUS[role] ?? []).map((m) => m[0]).sort();
    const { general, navigation } = menuSections(role);
    const obtenu = [...general, ...navigation].map((m) => m[0]).sort();
    assert.deepEqual(obtenu, attendu, `rôle ${role} : le menu doit être conservé à l'identique`);
  }
});

test('menu, un rôle sans écran d’administration n’en reçoit pas', () => {
  // Les cellules d'exécution n'ont ni Utilisateurs, ni Historique, ni Archive.
  for (const role of ['T1', 'BALISE', 'BON_SORTIE', 'PP', 'CBPI']) {
    const { general } = menuSections(role);
    const cles = general.map((m) => m[0]);
    for (const interdit of ['users', 'history', 'archive', 'goulots'])
      assert.equal(cles.includes(interdit), false, `${role} ne doit pas voir « ${interdit} »`);
  }
});

test('menu, l’ADMIN retrouve bien ses écrans d’administration dans le bloc général', () => {
  const cles = menuSections('ADMIN').general.map((m) => m[0]);
  for (const attendu of ['dash', 'users', 'history', 'archive', 'account'])
    assert.equal(cles.includes(attendu), true, `ADMIN doit voir « ${attendu} » en haut`);
  // Et l'ordre est celui, fixe, du bloc général, pas celui du menu d'origine.
  assert.equal(cles[0], 'dash');
  assert.equal(cles.at(-1), 'account');
});

test('menu, « Mon compte » est le seul écran général commun à tous les rôles', () => {
  for (const role of Object.keys(MENUS)) {
    const cles = menuSections(role).general.map((m) => m[0]);
    assert.equal(cles.includes('account'), true, `${role} doit garder « Mon compte »`);
  }
});

/* ---- 2026-09-11 : icône de l'écran courant (barre supérieure) ----------- */

test('l\'icône de la barre est celle du menu, pour le rôle en cours', () => {
  assert.equal(iconeDeLEcran('ADMIN', 'creercamion'), 'camionPlus');
  assert.equal(iconeDeLEcran('ADMIN', 'controles'), 'balance');
  assert.equal(iconeDeLEcran('T1', 't1'), 't1');
  assert.equal(iconeDeLEcran('BALISE', 'gps'), 'balise');
});

test('un écran absent du menu retombe sur une icône neutre', () => {
  // On arrive sur la fiche d'un camion par un clic dans une liste : elle ne
  // figure dans aucun menu, la barre ne doit pas rester sans icône.
  assert.equal(iconeDeLEcran('ADMIN', 'detail'), 'tableau');
  assert.equal(iconeDeLEcran('ADMIN', 'ecran-inexistant'), 'tableau');
  assert.equal(iconeDeLEcran('ROLE_INCONNU', 'dash'), 'tableau');
});

test('chaque rôle voit l\'icône de SON menu, jamais celle d\'un autre', () => {
  // `wait_valid` n'existe pas pour le CFS : il ne doit pas hériter de l'icône
  // du chef brigade par un repli trop large.
  assert.equal(iconeDeLEcran('CHEF_BRIGADE', 'wait_valid'), 'valider');
  assert.equal(iconeDeLEcran('CFS', 'wait_valid'), 'tableau');
});
