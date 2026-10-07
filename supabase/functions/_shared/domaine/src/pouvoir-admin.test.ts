import test from 'node:test';
import assert from 'node:assert/strict';
import { aPouvoirAdmin, estRoleTechnique, ROLES } from './constantes.ts';
import { aLeDroit, PERMISSIONS } from './permissions.ts';

test("pouvoir admin : l'ADMIN et les deux roles techniques l'ont", () => {
  for (const r of ['ADMIN', 'SUPER_ADMIN', 'INFO']) assert.equal(aPouvoirAdmin(r), true, r);
});

test("pouvoir admin : aucune cellule d'etape ne l'a", () => {
  for (const r of ['CFS', 'CHEF_BRIGADE', 'CHEF_BRIGADE_ADJOINT', 'CHEF_VISITE', 'CHEF_DIVISION',
    'CBPI', 'T1', 'BALISE', 'BON_SORTIE', 'PP']) assert.equal(aPouvoirAdmin(r), false, r);
});

test('pouvoir admin : rien ne passe sur du vide ou un role invente', () => {
  for (const r of ['', null, undefined, 'admin', 'Administrateur', 'INFO ']) assert.equal(aPouvoirAdmin(r), false, String(r));
});

test("pouvoir admin : l'INFO peut OUVRIR ET REGLER les parametres", () => {
  /* Le symptome qui a revele le defaut (07/10/2026) : le volet Parametres
     s'ouvrait sur « reserve a l'administrateur » pour un compte INFO, alors
     que la matrice lui accordait l'action. */
  for (const r of ['INFO', 'SUPER_ADMIN']) {
    assert.equal(aLeDroit(r, 'params.get'), true, r);
    assert.equal(aLeDroit(r, 'params.set'), true, r);
    assert.equal(aPouvoirAdmin(r), true, r);   // et l'ecran le laisse entrer
  }
});

test("pouvoir admin : TOUTE action ouverte a l'ADMIN l'est aux roles techniques", () => {
  /* La verification qui compte : elle parcourt la matrice ENTIERE, de sorte
     qu'une action ajoutee demain soit couverte sans qu'on y pense. */
  const manquantes: string[] = [];
  for (const [action, roles] of Object.entries(PERMISSIONS)) {
    if (roles.indexOf(ROLES.ADMIN) < 0) continue;
    for (const r of ['SUPER_ADMIN', 'INFO']) if (!aLeDroit(r, action)) manquantes.push(r + ' / ' + action);
  }
  assert.deepEqual(manquantes, []);
});

test('pouvoir admin : le verdict suit la liste des roles techniques', () => {
  // Si un troisieme role technique apparait, il herite sans retouche ici.
  for (const r of ['SUPER_ADMIN', 'INFO'])
    assert.equal(aPouvoirAdmin(r), estRoleTechnique(r) || r === ROLES.ADMIN, r);
});
