/**
 * Tests unitaires du cœur métier (exécutables : `node --test`).
 * Vérifient la FIDÉLITÉ à la v3.6 : moteur d'étapes, normalisation, permissions.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  STATUTS, OPERATIONS, ROLES,
  etatCellules, etapesEnAttente, fileAttente, prochaineEtape, estOui, aFait, exigeControlePoids,
  tcValide, maj, alphaNumMaj, normAlphaNum, declKey, normaliserDeclaration,
  parseConteneursDetails, parseDateImport, tailleBucket, evpDeTaille, trancheAge,
  verifierPermission, PERMISSIONS, TYPES_DECLARATION,
  groupesDeclaration, estChargementMixte, libelleDeclaration,
  sautsTypeC, estTypeSansT1, DESTINATION_CODES, estDispenseBalise, codeDestination,
  distanceOSA, similariteNum, numeroQuasiDoublon,
  dateDansNJours, etatEngagement, libelleEngagement, engagementAlerte,
  camionValide, messageCamionFormat,
} from './index.ts';

/* ------------------------------ Moteur workflow ------------------------ */

test('camion vide → étape CFS', () => {
  assert.deepEqual(etapesEnAttente({ statut: STATUTS.CAMION }), ['CFS']);
  assert.deepEqual(etapesEnAttente({ statut: STATUTS.CHARGEMENT }), ['CFS']);
  assert.deepEqual(etapesEnAttente({ statut: STATUTS.VEHICULE_OUILLAGE }), ['CFS']);
});

test('après CFS (Créée) → validation + cellules en parallèle', () => {
  assert.deepEqual(etapesEnAttente({ statut: STATUTS.CREEE }), ['VALIDATION', 'T1', 'BALISE', 'BS']);
});

test('validé → T1 / Balise / Bon de sortie en parallèle', () => {
  assert.deepEqual(etapesEnAttente({ statut: STATUTS.CREEE, dateValidation: '2026-01-01' }), ['T1', 'BALISE', 'BS']);
});

test('après T1 → BALISE et BS EN PARALLÈLE', () => {
  const c = { statut: STATUTS.T1, dateValidation: 'x', dateT1: 'x' };
  assert.deepEqual(etapesEnAttente(c), ['BALISE', 'BS']);
});

test('balise posée → Bon de sortie ouvert + PP possible', () => {
  const c = { statut: STATUTS.T1, dateValidation: 'x', dateT1: 'x', datePoseGps: 'x' };
  assert.deepEqual(etapesEnAttente(c), ['BS', 'PP']);
});

test('balise ET bs faits → PP', () => {
  const c = { statut: STATUTS.T1, dateValidation: 'x', dateT1: 'x', datePoseGps: 'x', bonSortieNumero: 'BS1' };
  assert.deepEqual(etapesEnAttente(c), ['PP']);
});

test('sorti → aucune étape', () => {
  assert.deepEqual(etapesEnAttente({ statut: STATUTS.SORTIE }), []);
});

test('véhicule saute la balise → Bon de sortie + PP', () => {
  const c = { statut: STATUTS.T1, estVehicule: 'Oui', dateValidation: 'x', dateT1: 'x' };
  assert.deepEqual(etapesEnAttente(c), ['BS', 'PP']);
});

test('conso non balisée : sauts T1 + Balise → Bon de sortie + PP', () => {
  const c = { statut: STATUTS.CREEE, dateValidation: 'x', sauteT1: 'Oui', sauteBalise: 'Oui' };
  assert.deepEqual(etapesEnAttente(c), ['BS', 'PP']);
});

test('type A/C SANS flag saute_t1 : le T1 est sauté PAR NATURE (régression 2026-08-15)', () => {
  // Données migrées / type corrigé après coup : le flag n'a pas été écrit.
  const a = { statut: STATUTS.CREEE, dateValidation: 'x', typeDeclaration: 'A' };
  assert.equal(etatCellules(a).t1, true);
  assert.equal(etapesEnAttente(a).includes('T1'), false);
  const c = { statut: STATUTS.CREEE, dateValidation: 'x', typeDeclaration: 'C' };
  assert.equal(etapesEnAttente(c).includes('T1'), false);
  // Le transit, lui, garde le T1.
  const t = { statut: STATUTS.CREEE, dateValidation: 'x', typeDeclaration: 'T' };
  assert.equal(etapesEnAttente(t).includes('T1'), true);
});

test('cascade : T1 fait ⇒ validation chef brigade réputée acquise (2026-08-15)', () => {
  // T1 saisi mais chef brigade jamais passé : la validation ne doit plus être
  // réclamée (cascade descendante), sans qu'aucune signature n'ait été écrite.
  const c = { statut: STATUTS.T1, dateT1: 'x', datePoseGps: 'x' };
  assert.equal(etatCellules(c).valide, true);
  assert.equal(etapesEnAttente(c).includes('VALIDATION'), false);
});

test('cascade : camion sorti ⇒ validation ET bon de sortie réputés acquis (2026-08-15)', () => {
  // Camion déjà passé à la PP sans validation ni bon de sortie enregistrés :
  // il ne doit plus figurer dans AUCUNE file d'attente.
  const c = { statut: STATUTS.SORTIE };
  const e = etatCellules(c);
  assert.equal(e.valide, true);
  assert.equal(e.bs, true);
  assert.deepEqual(etapesEnAttente(c), []);
});

test('cascade : un camion NON sorti et sans T1 attend TOUJOURS sa validation', () => {
  // La cascade ne doit pas dispenser un camion encore sur site et non avancé.
  const c = { statut: STATUTS.CREEE, typeDeclaration: 'T' };
  assert.equal(etatCellules(c).valide, false);
  assert.equal(etapesEnAttente(c).includes('VALIDATION'), true);
});

test('ouillage saute le BS', () => {
  const c = { statut: STATUTS.T1, dateValidation: 'x', dateT1: 'x', sauteBalise: 'Oui', sauteBS: 'Oui' };
  assert.deepEqual(etapesEnAttente(c), ['PP']);
});

test('fileAttente : file UNIQUE et séquentielle (2026-08-19)', () => {
  // Un dossier ne figure QUE dans une file = sa prochaine étape, dans l'ordre
  // CFS → VALIDATION → T1 → BALISE → BS → PP.
  assert.equal(fileAttente({ statut: STATUTS.CAMION }), 'CFS');
  assert.equal(fileAttente({ statut: STATUTS.CREEE, typeDeclaration: 'T' }), 'VALIDATION');
  assert.equal(fileAttente({ statut: STATUTS.CREEE, dateValidation: 'x', typeDeclaration: 'T' }), 'T1');
  assert.equal(fileAttente({ statut: STATUTS.T1, dateValidation: 'x', dateT1: 'x' }), 'BALISE');
  // Balise faite mais bon de sortie PAS émis → il attend le BON DE SORTIE (pas la PP).
  assert.equal(fileAttente({ statut: STATUTS.T1, dateValidation: 'x', dateT1: 'x', datePoseGps: 'x' }), 'BS');
  // Bon de sortie émis → et seulement là, il attend la SORTIE.
  assert.equal(fileAttente({ statut: STATUTS.T1, dateValidation: 'x', dateT1: 'x', datePoseGps: 'x', bonSortieNumero: 'BS1' }), 'PP');
  // Étapes sautées franchies automatiquement (conso non balisée → BS directement).
  assert.equal(fileAttente({ statut: STATUTS.CREEE, dateValidation: 'x', sauteT1: 'Oui', sauteBalise: 'Oui' }), 'BS');
  // Sorti → aucune file.
  assert.equal(fileAttente({ statut: STATUTS.SORTIE }), null);
});

test('sorti = terminal même si le statut est resté intermédiaire (dateSortie)', () => {
  // Donnée incohérente : date de sortie posée mais statut jamais passé à « Sortie ».
  // Le dossier est SORTI : plus aucune file, plus aucune étape en attente.
  const c = { statut: STATUTS.T1, dateSortie: '2026-08-19T10:00:00Z' };
  assert.equal(etatCellules(c).sorti, true);
  assert.deepEqual(etapesEnAttente(c), []);
  assert.equal(fileAttente(c), null);
});

test('hors gabarit / surcharge : dépotage uniquement (2026-08-19)', () => {
  assert.equal(exigeControlePoids(OPERATIONS.DEPOTAGE), true);
  for (const op of [OPERATIONS.ENLEVEMENT, OPERATIONS.VEHICULE, OPERATIONS.CONSO, OPERATIONS.MAGASIN, '', undefined])
    assert.equal(exigeControlePoids(op), false);
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

test('chargement mixte : reconnu dès que les conteneurs portent 2 déclarations', () => {
  const camion = { numeroDeclaration: '111', anneeDeclaration: '2026', bureauDeclaration: 'TG120', typeDeclaration: 'T', declarant: 'ACME' };
  const ct = (num: string, decl?: string) => ({
    num, plomb: '', taille: "20'", type: '', poids: '', extra: [],
    ...(decl ? { numeroDeclaration: decl, anneeDeclaration: '2026', bureauDeclaration: 'TG120', typeDeclaration: 'T' } : {}),
  });

  // Homogène : conteneurs sans déclaration propre → celle du camion.
  const homo = groupesDeclaration([ct('AAAU1111111'), ct('AAAU2222222')], camion);
  assert.equal(homo.length, 1);
  assert.equal(estChargementMixte([ct('AAAU1111111'), ct('AAAU2222222')], camion), false);

  // Mixte : le 2e conteneur relève d'une autre déclaration.
  const conts = [ct('AAAU1111111', '111'), ct('BBBU2222222', '222')];
  const g = groupesDeclaration(conts, camion);
  assert.equal(g.length, 2);
  assert.equal(estChargementMixte(conts, camion), true);
  assert.deepEqual(g[0]!.rangs, [1]);
  assert.deepEqual(g[1]!.rangs, [2]);
  assert.equal(g[1]!.numeroDeclaration, '222');
  // Le déclarant du camion sert de repli quand le conteneur ne le porte pas.
  assert.equal(g[1]!.declarant, 'ACME');
  assert.equal(libelleDeclaration(g[0]!), '111 · 2026 · TG120 · T');

  // Même déclaration écrite différemment (casse / ponctuation) = un seul groupe.
  assert.equal(estChargementMixte([ct('AAAU1111111', '111'), ct('BBBU2222222', ' 1-1-1 ')], camion), false);
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

test('matrice PERMISSIONS complète (72 actions + resetmfa)', () => {
  assert.ok(Object.keys(PERMISSIONS).length >= 72);
  assert.ok(PERMISSIONS['user.resetmfa']);
  // La validation en lot est réservée au chef brigade : si elle s'ouvrait au CFS,
  // le même agent chargerait ET signerait — la règle « 1 cellule = 1 rôle » tombe.
  assert.deepEqual(PERMISSIONS['cargo.validerlot'], PERMISSIONS['cargo.valider']);
  assert.ok(!PERMISSIONS['cargo.validerlot']!.includes(ROLES.CFS));
});

test('CBPI (chef brigade par intérim) : UNIQUEMENT valider + compte (2026-08-19)', () => {
  // Il peut signer, ouvrir la fiche à signer et gérer son compte.
  for (const a of ['cargo.valider', 'cargo.validerlot', 'report.validationdecl', 'cargo.get',
    'account.me', 'account.changepwd', 'account.signin'])
    assert.doesNotThrow(() => verifierPermission(ROLES.CBPI, a), `CBPI devrait pouvoir ${a}`);
  // Il ne voit RIEN d'autre : ni saisie, ni autres cellules, ni listes/recherche,
  // ni tableau de bord, ni administration.
  for (const a of ['cargo.cfs', 'cargo.createcamion', 'cargo.t1', 'cargo.gps', 'cargo.bonsortie',
    'cargo.sortie', 'cargo.list', 'cargo.search', 'dashboard.stats', 'report.cfs', 'user.list'])
    assert.throws(() => verifierPermission(ROLES.CBPI, a), /Accès refusé/, `CBPI ne devrait pas pouvoir ${a}`);
});

test('correction de plaque : ouverte à tous les rôles, suppression ADMIN seul (2026-09-12)', () => {
  // Décision utilisateur : tout poste qui repère une coquille ou un doublon doit
  // pouvoir corriger (motif tracé). Retirer un dossier reste l'affaire de l'ADMIN.
  for (const r of [ROLES.CFS, ROLES.CHEF_BRIGADE, ROLES.ADMIN, ROLES.BALISE, ROLES.PP, ROLES.T1, ROLES.BON_SORTIE])
    assert.doesNotThrow(() => verifierPermission(r, 'cargo.editcamion'));
  for (const r of [ROLES.CFS, ROLES.CHEF_BRIGADE, ROLES.BALISE, ROLES.PP, ROLES.T1, ROLES.BON_SORTIE])
    assert.throws(() => verifierPermission(r, 'cargo.delete'), /Accès refusé/);
  assert.doesNotThrow(() => verifierPermission(ROLES.ADMIN, 'cargo.delete'));
});

test('trace de connexion : ouverte à tous les rôles (SEC-05)', () => {
  // Sans cette action, la v4 n'enregistrait plus AUCUNE connexion : impossible
  // de savoir qui s'est connecté, quand, depuis quelle adresse.
  for (const r of [ROLES.CFS, ROLES.BALISE, ROLES.PP, ROLES.T1, ROLES.ADMIN])
    assert.doesNotThrow(() => verifierPermission(r, 'account.signin'));
});

test('correction de balise : cellule Balise + ADMIN, personne d\'autre', () => {
  assert.doesNotThrow(() => verifierPermission(ROLES.BALISE, 'cargo.gpsedit'));
  assert.doesNotThrow(() => verifierPermission(ROLES.ADMIN, 'cargo.gpsedit'));
  // Le numéro de balise reste la responsabilité de la cellule qui la pose :
  // aucune autre cellule ne peut le réécrire après coup.
  for (const r of [ROLES.CFS, ROLES.PP, ROLES.T1, ROLES.BON_SORTIE, ROLES.CHEF_BRIGADE])
    assert.throws(() => verifierPermission(r, 'cargo.gpsedit'), /Accès refusé/);
});

test('TYPES_DECLARATION = T,C,S,A,E', () => {
  assert.deepEqual([...TYPES_DECLARATION], ['T', 'C', 'S', 'A', 'E']);
});

test('hors transit (C, A, S) : sautent le T1, balise au choix ; seuls T et E prennent le T1', () => {
  // Décision utilisateur 2026-07-22 : « le type A se comporte comme la conso ».
  // Décision utilisateur 2026-08-19 : « seules les déclarations de type T et E
  // prennent les T1 » → le type S rejoint C/A dans les types qui sautent le T1.
  for (const t of ['C', 'A', 'a', 'S', 's']) {
    assert.deepEqual(sautsTypeC(t, 'balise'), { sauteT1: true, sauteBalise: false });
    assert.deepEqual(sautsTypeC(t, 'sansbalise'), { sauteT1: true, sauteBalise: true });
    assert.equal(estTypeSansT1(t), true);
  }
  // Le transit (T) et le type E gardent le parcours T1 → Balise. Un type ENCORE
  // VIDE reste aussi dans la file T1 (pas de saut tant que le type est inconnu).
  for (const t of ['T', 'E', '']) {
    assert.deepEqual(sautsTypeC(t, 'sansbalise'), { sauteT1: false, sauteBalise: false });
    assert.equal(estTypeSansT1(t), false);
  }
});

test('similitude de N° : distance, ratio, quasi-doublon (2026-08-19)', () => {
  // Distance OSA : substitution / insertion / suppression = 1 ; interversion
  // de deux caractères adjacents = 1 (et non 2 comme en Levenshtein pur).
  assert.equal(distanceOSA('ABC1234', 'ABC1234'), 0);
  assert.equal(distanceOSA('ABC1234', 'ABC1235'), 1); // substitution
  assert.equal(distanceOSA('ABC1234', 'ABC12345'), 1); // insertion
  assert.equal(distanceOSA('AB1234', 'BA1234'), 1);    // interversion adjacente

  // Normalisation : ponctuation / casse ignorées → identiques.
  assert.equal(similariteNum('AB-12-CD', 'ab12cd'), 1);
  assert.equal(numeroQuasiDoublon('AB-12-CD', 'ab12cd'), false); // identique ≠ quasi-doublon

  // Quasi-doublons à AVERTIR : une faute d'un caractère, une interversion.
  assert.equal(numeroQuasiDoublon('TG1234A', 'TG1234B'), true); // 1 caractère faux
  assert.equal(numeroQuasiDoublon('TG1234A', 'TG124A'), true);  // 1 caractère en moins
  assert.equal(numeroQuasiDoublon('AB1234CD', 'BA1234CD'), true); // interversion
  // Trop différents : pas d'alerte (vrais camions distincts).
  assert.equal(numeroQuasiDoublon('AB1234CD', 'XY9876ZZ'), false);
  assert.equal(numeroQuasiDoublon('TG1234A', ''), false); // rien à comparer
});

test('codeDestination : codes reconnus, texte libre → Autres', () => {
  assert.equal(codeDestination('TG'), 'TG');
  assert.equal(codeDestination('bf'), 'BF');
  assert.equal(codeDestination('TG (Transit National)'), 'TG');
  assert.equal(codeDestination('NIGER'), 'Autres'); // ancien texte libre migré
  assert.equal(codeDestination(''), 'Autres');
});

test('tableau de bord réservé aux chefs (brigade/visite/division) + ADMIN', () => {
  for (const r of [ROLES.CHEF_BRIGADE, ROLES.CHEF_VISITE, ROLES.CHEF_DIVISION, ROLES.ADMIN])
    assert.doesNotThrow(() => verifierPermission(r, 'dashboard.stats'));
  // Agents de cellule + adjoint : plus de tableau de bord (décision client 2026-07-27).
  for (const r of [ROLES.CFS, ROLES.CHEF_BRIGADE_ADJOINT, ROLES.T1, ROLES.BALISE, ROLES.BON_SORTIE, ROLES.PP])
    assert.throws(() => verifierPermission(r, 'dashboard.fiche'), /Accès refusé/);
});

test('DESTINATIONS incluent NG', () => {
  assert.ok(DESTINATION_CODES.includes('NG'));
});

test('estDispenseBalise : seules les vraies dispenses (numéro d’autorisation) comptent', () => {
  // Vraie dispense : la Balise a exempté + numéro d'autorisation.
  assert.equal(estDispenseBalise({ baliseRequise: false, numeroDispense: 'AUT-12' }), true);
  assert.equal(estDispenseBalise({ baliseRequise: 'Non', numeroDispense: 'AUT-12' }), true);
  // Type C/A/E qui saute la balise PAR NATURE : PAS une dispense (bug des 59).
  assert.equal(estDispenseBalise({ sauteBalise: true }), false);
  assert.equal(estDispenseBalise({ baliseRequise: false, numeroDispense: '' }), false);
  // Balise requise, ou véhicule : jamais une dispense.
  assert.equal(estDispenseBalise({ baliseRequise: true, numeroDispense: 'AUT-9' }), false);
  assert.equal(estDispenseBalise({ estVehicule: true, baliseRequise: false, numeroDispense: 'AUT-9' }), false);
});

test('verrou PP : la sortie attend T1 ET Balise (transit)', () => {
  // Transit après CFS : ni T1 ni balise faits → PP absente des étapes.
  const base = { statut: STATUTS.CREEE };
  assert.equal(etapesEnAttente(base).includes('PP'), false);
  // Balise seule (T1 pas fait) → PP toujours absente.
  assert.equal(etapesEnAttente({ ...base, datePoseGps: '2026-07-27' }).includes('PP'), false);
  // T1 + Balise faits → PP ouverte.
  assert.equal(etapesEnAttente({ ...base, dateT1: '2026-07-27', datePoseGps: '2026-07-27' }).includes('PP'), true);
  // Type C qui saute le T1 + balise posée → PP ouverte (le saut vaut « fait »).
  assert.equal(etapesEnAttente({ ...base, sauteT1: true, datePoseGps: '2026-07-27' }).includes('PP'), true);
});

test('engagements — le délai en jours devient une date, à compter du jour de saisie', () => {
  const ref = new Date(2026, 8, 10); // 10 septembre 2026, heure locale
  assert.equal(dateDansNJours(1, ref), '2026-09-11');
  assert.equal(dateDansNJours(5, ref), '2026-09-15');
  // Franchit une fin de mois sans qu'on ait à s'en occuper.
  assert.equal(dateDansNJours(21, ref), '2026-10-01');
  // Entrées qui n'ont pas de sens pour un envoi de pièces.
  assert.equal(dateDansNJours(0, ref), '');
  assert.equal(dateDansNJours(-3, ref), '');
  assert.equal(dateDansNJours('', ref), '');
  assert.equal(dateDansNJours('abc', ref), '');
  assert.equal(dateDansNJours(2.5, ref), '');
});

test('engagements — état et libellé selon l’échéance', () => {
  const ref = new Date(2026, 8, 10);
  assert.equal(etatEngagement('2026-09-11', null, ref).etat, 'demain');
  assert.equal(etatEngagement('2026-09-10', null, ref).etat, 'aujourdhui');
  assert.equal(etatEngagement('2026-09-07', null, ref).etat, 'retard');
  assert.equal(etatEngagement('2026-09-07', null, ref).joursRestants, -3);
  assert.equal(etatEngagement('2026-09-20', null, ref).etat, 'a_venir');
  // Soldé : plus aucune alerte, quelle que soit l'échéance passée.
  assert.equal(etatEngagement('2026-09-01', '2026-09-02T10:00:00Z', ref).etat, 'solde');

  assert.equal(libelleEngagement('2026-09-07', null, ref), 'En retard de 3 jours');
  assert.equal(libelleEngagement('2026-09-09', null, ref), 'En retard de 1 jour');
  assert.equal(libelleEngagement('2026-09-11', null, ref), 'À envoyer demain');

  // Seules les échéances à J-1 et au-delà remontent au tableau de bord.
  assert.equal(engagementAlerte('2026-09-11', null, ref), true);
  assert.equal(engagementAlerte('2026-09-20', null, ref), false);
  assert.equal(engagementAlerte('2026-09-01', '2026-09-02T10:00:00Z', ref), false);
});

test("format camion — la barre oblique n'est PLUS obligatoire (2026-09-12)", () => {
  // L'ensemble reste accepté, sous toutes ses graphies.
  assert.equal(camionValide('TG2489BK/2725BP'), true);
  assert.equal(camionValide('tg2489bk / 2725bp'), true); // espaces et minuscules normalisés

  // NOUVEAU : une plaque seule passe — tout ce qui se présente au port n'est
  // pas un ensemble tracteur + remorque, et un agent bloqué devant un porteur
  // unique ne pouvait plus rien enregistrer.
  assert.equal(camionValide('TG2489BK'), true);
  assert.equal(camionValide('tg 2489 bk'), true);

  // Ce qui reste refusé : les saisies avortées, pas les formats légitimes.
  assert.equal(camionValide('ABC'), false, 'moins de 4 caractères');
  assert.equal(camionValide('TG2489BK/'), false, 'un côté vide');
  assert.equal(camionValide('/2725BP'), false);
  assert.equal(camionValide('A/B'), false, 'moins de 2 caractères de chaque côté');
  assert.equal(camionValide('AB/CD/EF'), false, 'deux séparateurs');
  assert.equal(camionValide(''), false);
  assert.equal(camionValide(null), false);

  // Le message ne réclame plus la barre oblique, mais la propose encore.
  const m = messageCamionFormat('AB');
  assert.doesNotMatch(m, /séparés par une barre oblique/, "ne doit plus l'exiger");
  assert.match(m, /TG2489BK/); // un exemple de plaque seule
  assert.match(m, /TG2489BK\/2725BP/); // et un exemple d'ensemble
  assert.match(m, /N° de camion/); // le champ à corriger
  assert.match(messageCamionFormat('X', 'Nouveau n° de camion'), /Nouveau n° de camion/);
});
test('engagements — corriger : tout l\'encadrement ; RETIRER : administrateur seul (2026-09-17)', () => {
  // Décision utilisateur : le retrait efface l'engagement, son échéance et son
  // solde — plus lourd que la correction, donc plus étroit.
  for (const r of [ROLES.CHEF_BRIGADE, ROLES.CHEF_BRIGADE_ADJOINT, ROLES.CHEF_VISITE, ROLES.CHEF_DIVISION, ROLES.ADMIN]) {
    assert.doesNotThrow(() => verifierPermission(r, 'cargo.engagementedit'));
    assert.doesNotThrow(() => verifierPermission(r, 'cargo.engagementfait'));
  }
  assert.doesNotThrow(() => verifierPermission(ROLES.ADMIN, 'cargo.engagementretirer'));
  for (const r of [ROLES.CHEF_BRIGADE, ROLES.CHEF_BRIGADE_ADJOINT, ROLES.CHEF_VISITE, ROLES.CHEF_DIVISION, ROLES.CFS, ROLES.BALISE])
    assert.throws(() => verifierPermission(r, 'cargo.engagementretirer'), /Accès refusé/);
});
