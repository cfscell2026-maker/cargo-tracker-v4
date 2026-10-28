import test from 'node:test';
import assert from 'node:assert/strict';
import { aPouvoirAdmin, aRoleParmi, estRoleTechnique, ROLES, SUIVENT_ENGAGEMENTS } from './constantes.ts';
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

/* ---- Appartenance a une liste de roles : meme heritage que le serveur ---- */

test('roles : ADMIN, SUPER_ADMIN et INFO suivent TOUS les engagements', () => {
  /* 28/10/2026, demande utilisateur : « les info et les super admin doivent
     voir, et aussi les admin ». SUIVENT_ENGAGEMENTS a ete ecrite avant les
     roles techniques et ne les nomme pas : un `includes` brut repondait NON a
     un INFO, la ou `verifierPermission` repond OUI. L'echeancier du tableau de
     bord disparaissait donc pour lui. */
  for (const r of [ROLES.ADMIN, ROLES.SUPER_ADMIN, ROLES.INFO])
    assert.equal(aRoleParmi(r, SUIVENT_ENGAGEMENTS), true, String(r));
});

test('roles : les chefs qui suivaient les engagements les suivent toujours', () => {
  for (const r of [ROLES.CHEF_BRIGADE, ROLES.CHEF_BRIGADE_ADJOINT, ROLES.CHEF_VISITE, ROLES.CHEF_DIVISION])
    assert.equal(aRoleParmi(r, SUIVENT_ENGAGEMENTS), true, String(r));
});

test("roles : les cellules d'execution ne suivent toujours PAS les engagements", () => {
  /* L'elargissement ne doit profiter qu'aux roles techniques : la relance d'un
     engagement n'est pas du ressort des cellules, c'est deja la regle. */
  for (const r of [ROLES.CFS, ROLES.T1, ROLES.BALISE, ROLES.BON_SORTIE, ROLES.PP, ROLES.CBPI])
    assert.equal(aRoleParmi(r, SUIVENT_ENGAGEMENTS), false, String(r));
});

test("roles : sans ADMIN dans la liste, les roles techniques n'heritent de rien", () => {
  /* La regle est un HERITAGE DE L'ADMIN, pas un passe-droit general. C'est ce
     qui laisse le verrou de l'application ferme au SUPER_ADMIN. */
  const sansAdmin = [ROLES.CFS, ROLES.T1];
  for (const r of [ROLES.SUPER_ADMIN, ROLES.INFO])
    assert.equal(aRoleParmi(r, sansAdmin), false, String(r));
  assert.equal(aRoleParmi(ROLES.INFO, [ROLES.INFO]), true, 'nomme explicitement, il en est');
});

test('roles : aRoleParmi et la matrice des droits disent la meme chose', () => {
  /* La garantie qui compte : l'ECRAN ne doit jamais cacher ce que le SERVEUR
     autorise. On confronte les deux sur les actions portees par cette liste. */
  for (const action of ['report.engagements', 'cargo.engagementfait', 'cargo.engagementedit'])
    for (const r of [ROLES.ADMIN, ROLES.SUPER_ADMIN, ROLES.INFO, ROLES.CHEF_BRIGADE, ROLES.CFS, ROLES.PP])
      assert.equal(aRoleParmi(r, SUIVENT_ENGAGEMENTS), aLeDroit(r, action),
        `${r} / ${action} : l'ecran et le serveur divergent`);
});

/* ------- Qui est prevenu des engagements en retard (2026-10-28) --------- */

test('alerte retards : prevenue, l administration ; epargnees, les cellules', () => {
  /* Le rappel s'adresse a ceux qui PEUVENT agir. Relancer une cellule
     d'execution sur un engagement dont elle n'a pas la charge, toutes les cinq
     heures, apprendrait seulement a ignorer les alertes. */
  for (const r of [ROLES.ADMIN, ROLES.SUPER_ADMIN, ROLES.INFO,
    ROLES.CHEF_BRIGADE, ROLES.CHEF_BRIGADE_ADJOINT, ROLES.CHEF_VISITE, ROLES.CHEF_DIVISION])
    assert.equal(aRoleParmi(r, SUIVENT_ENGAGEMENTS), true, String(r));
  for (const r of [ROLES.CFS, ROLES.T1, ROLES.BALISE, ROLES.BON_SORTIE, ROLES.PP, ROLES.CBPI])
    assert.equal(aRoleParmi(r, SUIVENT_ENGAGEMENTS), false, String(r));
});
