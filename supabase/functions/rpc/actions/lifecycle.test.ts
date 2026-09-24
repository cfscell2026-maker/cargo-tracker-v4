/**
 * Test d'intégration : cycle de vie COMPLET d'un enlèvement à travers les
 * handlers serveur réels (createcamion → cfs → valider → t1 → gps → bonsortie
 * → sortie) sur une base en mémoire. Vérifie les transitions de statut, le
 * parallélisme Balise/Bon de sortie, l'apurement et le décompte du stock.
 * Exécutable : `node --test`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STATUTS, etapesEnAttente, fileAttente, groupesDeclaration, verifierPermission } from '../../_shared/domaine/src/index.ts';
import { versCamel, type Ctx } from '../ctx.ts';
import { FakeDB } from './fake-db.ts';
import * as ecr from './ecriture.ts';
import * as spe from './speciaux.ts';
import * as stk from './stock.ts';
import * as rap from './rapports.ts';
import * as lec from './lecture.ts';
import * as prm from './parametres.ts';
import * as prk from './parking.ts';

function ctxAvec(db: FakeDB): Ctx {
  return {
    db: db as never,
    session: { userId: 'u-cfs', username: 'cfs1', nomComplet: 'Agent CFS Un', role: 'CFS' as never },
    log: async () => {},
  };
}
function ctxRole(db: FakeDB, role: string, nom: string): Ctx {
  return { db: db as never, session: { userId: 'u-' + role, username: role.toLowerCase(), nomComplet: nom, role: role as never }, log: async () => {} };
}
const statutDe = (db: FakeDB, id: string) => db.store['cargaisons'].find((c) => c['id'] === id)?.['statut'];

test('cycle de vie complet — ENLÈVEMENT (2 conteneurs 20\', binôme)', async () => {
  const db = new FakeDB();
  // Stock : deux conteneurs 20' disponibles.
  db.store['stock'].push(
    { numero_tc: 'MSKU1234567', taille: "20'", statut: 'En stock' },
    { numero_tc: 'TCLU7654321', taille: "20'", statut: 'En stock' },
  );
  const cfs = ctxAvec(db);

  // 1) La PP/CFS crée le camion vide.
  const cree = (await ecr.createcamion(cfs, { numeroCamion: 'AB1234CD/RM01', routage: 'Enlèvement' })) as { id: string };
  const id = cree.id;
  assert.equal(statutDe(db, id), STATUTS.CAMION);

  // 2) CFS associe le 1er conteneur + déclaration complète. Le camion RESTE
  //    ENLÈVEMENT : le scellé est posé par conteneur → « Créée » d'emblée (v4.1).
  const decl = {
    declarant: 'STE X', contactDeclarant: '90123456', destinationMarchandise: 'LOME',
    bureauDeclaration: 'TG120', typeDeclaration: 'T', numeroDeclaration: '777', anneeDeclaration: '2026',
    dateDeclaration: '2026-06-24', descriptionMarchandise: 'RIZ', nombreConteneurs: 2,
  };
  await ecr.cfs(cfs, { id, conteneur: { num: 'MSKU1234567', taille: "20'", type: 'DRY', plomb: 'SEAL1' }, declaration: decl });
  assert.equal(statutDe(db, id), STATUTS.CREEE);
  // Stock du 1er conteneur marqué « Dépoté ».
  assert.equal(db.store['stock'].find((s) => s['numero_tc'] === 'MSKU1234567')?.['statut'], 'Dépoté');
  // Déclaration créée avec apurement 1/2.
  assert.equal(db.store['declarations'][0]?.['conteneurs_apures'], 1);

  // 2b) Binôme : 2e conteneur 20'.
  await ecr.cfs(cfs, { id, conteneur: { num: 'TCLU7654321', taille: "20'", type: 'DRY', plomb: 'SEAL2' } });
  const apres2 = versCamel(db.store['cargaisons'][0]!);
  assert.equal(apres2['nbConteneurs'], 2);
  assert.equal(apres2['twins'], true);

  // 3) Chef brigade valide (signature).
  await ecr.valider(ctxRole(db, 'CHEF_BRIGADE', 'Chef Brigade'), { id, enSurcharge: false, suiviEngagement: false });
  assert.ok(db.store['cargaisons'][0]!['date_validation']);
  assert.deepEqual(etapesEnAttente(versCamel(db.store['cargaisons'][0]!) as never), ['T1', 'BALISE', 'BS']);

  // 4) Cellule T1 (1 T1 par conteneur).
  await ecr.t1(ctxRole(db, 'T1', 'Agent T1'), {
    id, bureauDestination: 'TG120',
    t1Numeros: [{ conteneur: 'MSKU1234567', numero: 'T1-A' }, { conteneur: 'TCLU7654321', numero: 'T1-B' }],
  });
  assert.equal(statutDe(db, id), STATUTS.T1);
  // Après T1 : Balise ET Bon de sortie en attente (parallèle).
  assert.deepEqual(etapesEnAttente(versCamel(db.store['cargaisons'][0]!) as never), ['BALISE', 'BS']);

  // 5) Balise posée (le statut avance à « GPS Installé »).
  await ecr.gps(ctxRole(db, 'BALISE', 'Agent Balise'), { id, baliseRequise: 'Oui', t1Correct: 'Oui', numeroGPS: 'GPS-1' });
  assert.equal(statutDe(db, id), STATUTS.GPS);
  assert.deepEqual(etapesEnAttente(versCamel(db.store['cargaisons'][0]!) as never), ['BS', 'PP']);

  // 6) Bon de sortie (le PP devient possible).
  await ecr.bonsortie(ctxRole(db, 'BON_SORTIE', 'Agent BS'), {
    id, bonSortieNumero: [{ conteneur: 'MSKU1234567', t1: 'T1-A', numero: 'BS-1' }],
  });
  assert.equal(statutDe(db, id), STATUTS.BS);
  assert.deepEqual(etapesEnAttente(versCamel(db.store['cargaisons'][0]!) as never), ['PP']);

  // 7) Sortie PP (checklist 4 cases).
  await ecr.sortie(ctxRole(db, 'PP', 'Agent PP'), { id, ckCfs: true, ckT1: true, ckBalise: true, ckBs: true });
  assert.equal(statutDe(db, id), STATUTS.SORTIE);
  assert.deepEqual(etapesEnAttente(versCamel(db.store['cargaisons'][0]!) as never), []);
});

test('déclaration type C balisée : saute le T1, garde la Balise', async () => {
  const db = new FakeDB();
  db.store['stock'].push({ numero_tc: 'MSKU1234567', taille: "40'", statut: 'En stock' });
  const cfs = ctxAvec(db);
  const { id } = (await ecr.createcamion(cfs, { numeroCamion: 'CONSO1/RM01', routage: 'Enlèvement' })) as { id: string };
  await ecr.cfs(cfs, {
    id, conteneur: { num: 'MSKU1234567', taille: "40'", type: 'DRY', plomb: 'S1' },
    declaration: { declarant: 'A', contactDeclarant: '901234', destinationMarchandise: 'D', bureauDeclaration: 'TG120', typeDeclaration: 'C', numeroDeclaration: '1', anneeDeclaration: '2026', dateDeclaration: '2026-06-24', descriptionMarchandise: 'X', nombreConteneurs: 1 },
    consoMode: 'balise',
  });
  const c = versCamel(db.store['cargaisons'][0]!);
  assert.equal(c['sauteT1'], true);
  assert.equal(c['sauteBalise'], false);
  // Après validation : le T1 est sauté → Balise ET Bon de sortie en attente.
  await ecr.valider(ctxRole(db, 'CHEF_BRIGADE', 'CB'), { id, enSurcharge: false, suiviEngagement: false });
  assert.deepEqual(etapesEnAttente(versCamel(db.store['cargaisons'][0]!) as never), ['BALISE', 'BS']);
});

test('déclaration type C non balisée : saute le T1 ET la Balise', async () => {
  const db = new FakeDB();
  db.store['stock'].push({ numero_tc: 'MSKU1234567', taille: "40'", statut: 'En stock' });
  const cfs = ctxAvec(db);
  const { id } = (await ecr.createcamion(cfs, { numeroCamion: 'CONSO2/RM01', routage: 'Enlèvement' })) as { id: string };
  await ecr.cfs(cfs, {
    id, conteneur: { num: 'MSKU1234567', taille: "40'", type: 'DRY', plomb: 'S1' },
    declaration: { declarant: 'A', contactDeclarant: '901234', destinationMarchandise: 'D', bureauDeclaration: 'TG120', typeDeclaration: 'C', numeroDeclaration: '2', anneeDeclaration: '2026', dateDeclaration: '2026-06-24', descriptionMarchandise: 'X', nombreConteneurs: 1 },
    consoMode: 'sansbalise',
  });
  const c = versCamel(db.store['cargaisons'][0]!);
  assert.equal(c['sauteT1'], true);
  assert.equal(c['sauteBalise'], true);
  // Après validation : T1 et Balise sautés → Bon de sortie + PP disponibles.
  await ecr.valider(ctxRole(db, 'CHEF_BRIGADE', 'CB'), { id, enSurcharge: false, suiviEngagement: false });
  assert.deepEqual(etapesEnAttente(versCamel(db.store['cargaisons'][0]!) as never), ['BS', 'PP']);
});

test('déclaration : date et nombre de conteneurs FACULTATIFS (dépotage)', async () => {
  const db = new FakeDB();
  db.store['stock'].push({ numero_tc: 'MSKU1234567', taille: "40'", statut: 'Positionné' });
  const cfs = ctxAvec(db);
  const { id } = (await ecr.createcamion(cfs, { numeroCamion: 'FAC1/RM01', routage: 'Dépotage' })) as { id: string };
  // Nouvelle déclaration SANS date NI nombre de conteneurs : accepté.
  await ecr.cfs(cfs, {
    id, conteneur: { num: 'MSKU1234567', taille: "40'", type: 'DRY' },
    declaration: { declarant: 'A', contactDeclarant: '901234', destinationMarchandise: 'D', bureauDeclaration: 'TG120', typeDeclaration: 'T', numeroDeclaration: '4242', anneeDeclaration: '2026', descriptionMarchandise: 'X' },
  });
  assert.equal(statutDe(db, id), STATUTS.CHARGEMENT);
  assert.equal(db.store['declarations'][0]?.['numero_declaration'], '4242');
  assert.equal(Number(db.store['declarations'][0]?.['nombre_conteneurs']), 0); // inconnu = 0
});

test('annulation de doublon (ADMIN) : suppression LOGIQUE, stock libéré, pièces conservées (SEC-12)', async () => {
  const db = new FakeDB();
  db.store['stock'].push({ numero_tc: 'MSKU1234567', taille: "40'", statut: 'Positionné' });
  const cfs = ctxAvec(db);
  const { id } = (await ecr.createcamion(cfs, { numeroCamion: 'DUP99/RM01', routage: 'Dépotage' })) as { id: string };
  await ecr.cfs(cfs, {
    id, conteneur: { num: 'MSKU1234567', taille: "40'", type: 'DRY' },
    declaration: { declarant: 'A', contactDeclarant: '901234', destinationMarchandise: 'D', bureauDeclaration: 'TG120', typeDeclaration: 'T', numeroDeclaration: '70', anneeDeclaration: '2026', descriptionMarchandise: 'X' },
  });
  assert.equal(db.store['stock'][0]?.['statut'], 'Dépoté'); // conteneur lié

  // Le motif est obligatoire : sans lui, l'audit ne dit pas POURQUOI la pièce
  // a été écartée, et la trace ne vaut rien.
  await assert.rejects(
    () => ecr.supprimerCargo(ctxRole(db, 'ADMIN', 'Admin'), { id }),
    /motif de l'annulation/,
  );

  await ecr.supprimerCargo(ctxRole(db, 'ADMIN', 'Admin'), { id, motif: 'doublon de saisie du 12/08' });
  // La cargaison et ses conteneurs RESTENT en base : on n'efface pas une
  // écriture douanière, on la marque annulée.
  assert.equal(db.store['cargaisons'].length, 1);
  assert.equal(db.store['cargaisons'][0]?.['annule'], true);
  assert.equal(db.store['cargaisons'][0]?.['annule_motif'], 'doublon de saisie du 12/08');
  assert.equal(db.store['conteneurs'].length, 1);
  assert.equal(db.store['stock'][0]?.['statut'], 'En stock'); // stock libéré

  // Plus aucune écriture n'est possible sur une cargaison annulée.
  await assert.rejects(
    () => ecr.editcamion(ctxRole(db, 'CFS', 'C'), { id, numeroCamion: 'AUTRE1/RM01', motif: 'test' }),
    /annulée/,
  );
});

test('annulation APRÈS validation : autorisée à l\'ADMIN, signalée comme écriture engagée (2026-09-10)', async () => {
  const db = new FakeDB();
  db.store['stock'].push({ numero_tc: 'MSKU7654321', taille: "40'", statut: 'En stock' });
  const cfs = ctxAvec(db);
  // Enlèvement : la saisie du conteneur scellé vaut fin de chargement (« Créée »),
  // donc la validation du chef de brigade est possible dans la foulée.
  const { id } = (await ecr.createcamion(cfs, { numeroCamion: 'DUP98/RM01', routage: 'Enlèvement' })) as { id: string };
  await ecr.cfs(cfs, {
    id, conteneur: { num: 'MSKU7654321', taille: "40'", type: 'DRY', plomb: 'S1' },
    declaration: { declarant: 'A', contactDeclarant: '901234', destinationMarchandise: 'D', bureauDeclaration: 'TG120', typeDeclaration: 'T', numeroDeclaration: '71', anneeDeclaration: '2026', descriptionMarchandise: 'X', nombreConteneurs: 1 },
  });
  await ecr.valider(ctxRole(db, 'CHEF_BRIGADE', 'Chef'), { id, enSurcharge: 'Non', suiviEngagement: false });

  // L'annulation n'est PLUS refusée après signature (décision 2026-09-10) : elle
  // reste réservée à l'ADMIN, elle est logique, et le journal la signale.
  const r = (await ecr.supprimerCargo(ctxRole(db, 'ADMIN', 'Admin'), { id, motif: 'erreur de saisie' })) as
    { annule: boolean; engagee: string[] };
  assert.equal(r.annule, true);
  assert.ok(r.engagee.some((x) => /VALIDÉE ET SIGNÉE/.test(x)),
    'le retrait d\'une cargaison signée doit être marqué comme écriture engagée');

  // SEC-12 tient toujours : la pièce n'est pas détruite, seulement marquée.
  const c = versCamel(db.store['cargaisons'][0]!);
  assert.equal(c['annule'], true);
  assert.equal(c['annuleMotif'], 'erreur de saisie');
  assert.ok(c['dateValidation'], 'la validation reste inscrite sur la pièce annulée');
  // Le motif est toujours exigé, même à ce stade.
  await assert.rejects(
    () => ecr.supprimerCargo(ctxRole(db, 'ADMIN', 'Admin'), { id: 'CT-INEXISTANT', motif: '' }),
    /motif de l'annulation/i,
  );

  // Et le stock rattaché est bien libéré.
  assert.equal(db.store['stock'][0]!['statut'], 'En stock');
});

test('véhicule : le conteneur d\'origine (TC) est obligatoire', async () => {
  const db = new FakeDB();
  const cfs = ctxAvec(db);
  const decl = { declarant: 'A', contactDeclarant: '901234', destinationMarchandise: 'D', bureauDeclaration: 'TG120', typeDeclaration: 'T', numeroDeclaration: '9', anneeDeclaration: '2026', dateDeclaration: '2026-06-24', descriptionMarchandise: 'X', nombreConteneurs: 1 };
  await assert.rejects(
    () => spe.create(cfs, {
      typeOperation: 'Dépotage / Véhicule', declaration: decl,
      vehicules: [{ chassis: 'VIN123', destination: 'Transit' }],
    }),
    /conteneur d'origine \(TC\) est obligatoire/,
  );
});

test('véhicule : « chargement terminé » est porté PAR camion d\'effets divers', async () => {
  const db = new FakeDB();
  db.store['stock'].push({ numero_tc: 'MSKU1234567', taille: "40'", statut: 'Positionné' });
  const cfs = ctxAvec(db);
  const decl = { declarant: 'A', contactDeclarant: '901234', destinationMarchandise: 'D', bureauDeclaration: 'TG120', typeDeclaration: 'T', numeroDeclaration: '10', anneeDeclaration: '2026', dateDeclaration: '2026-06-24', descriptionMarchandise: 'X', nombreConteneurs: 3 };
  await spe.create(cfs, {
    typeOperation: 'Dépotage / Véhicule', declaration: decl, conteneurOrigine: 'MSKU1234567',
    vehicules: [{ chassis: 'VIN123', destination: 'Transit' }],
    camions: [
      // terminé → scellés exigés, statut « Créée »
      { numeroCamion: 'CAM-FINI/RM01', chargementTermine: true, designation: 'Cartons d\'effets personnels', scellesCamion: ['S1', 'S2'] },
      // pas terminé → scellés NON exigés, statut « En cours de chargement »
      { numeroCamion: 'CAM-ENCOURS/RM01', chargementTermine: false, designation: 'Colis divers', scellesCamion: [] },
    ],
  });
  const fini = db.store['cargaisons'].find((c) => c['numero_camion'] === 'CAM-FINI/RM01');
  const enCours = db.store['cargaisons'].find((c) => c['numero_camion'] === 'CAM-ENCOURS/RM01');
  assert.equal(fini?.['statut'], STATUTS.CREEE);
  assert.equal(enCours?.['statut'], STATUTS.CHARGEMENT);
  // v4 — le camion d'effets divers porte sa DÉSIGNATION, pas de conteneur propre.
  assert.equal(fini?.['description_marchandise'], 'CARTONS D\'EFFETS PERSONNELS');
  assert.equal(fini?.['nb_conteneurs'], 0);
});

test('effets divers : la désignation est obligatoire', async () => {
  const db = new FakeDB();
  db.store['stock'].push({ numero_tc: 'MSKU1234567', taille: "40'", statut: 'Positionné' });
  const cfs = ctxAvec(db);
  const decl = { declarant: 'A', contactDeclarant: '901234', destinationMarchandise: 'D', bureauDeclaration: 'TG120', typeDeclaration: 'T', numeroDeclaration: '11', anneeDeclaration: '2026', dateDeclaration: '2026-06-24', descriptionMarchandise: 'X', nombreConteneurs: 1 };
  await assert.rejects(
    () => spe.create(cfs, {
      typeOperation: 'Dépotage / Véhicule', declaration: decl, conteneurOrigine: 'MSKU1234567',
      vehicules: [{ chassis: 'VIN123', destination: 'Transit' }],
      camions: [{ numeroCamion: 'CAM-X/RM01', chargementTermine: true, scellesCamion: ['S1', 'S2'] }],
    }),
    /désignation des effets divers est obligatoire/,
  );
});

test('conso MAD (cargo.create) : type T = parcours complet (T1 + Balise), comme un dépotage', async () => {
  const db = new FakeDB();
  const cfs = ctxAvec(db);
  const decl = { declarant: 'A', contactDeclarant: '901234', destinationMarchandise: 'D', bureauDeclaration: 'TG120', typeDeclaration: 'T', numeroDeclaration: '20', anneeDeclaration: '2026', dateDeclaration: '2026-06-24', descriptionMarchandise: 'RIZ', nombreConteneurs: 1 };
  await spe.create(cfs, {
    typeOperation: 'Conso (type C)', consoMode: 'balise', declaration: decl,
    camions: [{ numeroCamion: 'MADT1/RM01', conteneurs: [{ num: 'MSKU1234567', taille: "40'", type: 'DRY', plomb: 'S1' }] }],
  });
  const c = db.store['cargaisons'][0]!;
  assert.equal(c['saute_t1'], false);
  assert.equal(c['saute_balise'], false);
});

test('conso MAD (cargo.create) : type C non balisée = saute T1 ET Balise', async () => {
  const db = new FakeDB();
  const cfs = ctxAvec(db);
  const decl = { declarant: 'A', contactDeclarant: '901234', destinationMarchandise: 'D', bureauDeclaration: 'TG120', typeDeclaration: 'C', numeroDeclaration: '21', anneeDeclaration: '2026', dateDeclaration: '2026-06-24', descriptionMarchandise: 'RIZ', nombreConteneurs: 1 };
  await spe.create(cfs, {
    typeOperation: 'Conso (type C)', consoMode: 'sansbalise', declaration: decl,
    camions: [{ numeroCamion: 'MADC1/RM01', conteneurs: [{ num: 'MSKU1234567', taille: "40'", type: 'DRY', plomb: 'S1' }] }],
  });
  const c = db.store['cargaisons'][0]!;
  assert.equal(c['saute_t1'], true);
  assert.equal(c['saute_balise'], true);
});

test('sortie Magasin/MAD : type T garde le T1, type C le saute', async () => {
  const db = new FakeDB();
  const cfs = ctxAvec(db);
  const base = { declarant: 'A', contactDeclarant: '901234', destinationMarchandise: 'D', bureauDeclaration: 'TG120', anneeDeclaration: '2026', dateDeclaration: '2026-06-24', descriptionMarchandise: 'VRAC', nombreConteneurs: 1 };
  const sc = { chargementTermine: true, scellesCamion: ['SC1', 'SC2'] };
  await spe.create(cfs, { typeOperation: 'Sortie Magasin / MAD', numeroCamion: 'MAG-T/RM01', consoMode: 'balise', declaration: { ...base, typeDeclaration: 'T', numeroDeclaration: '30' }, ...sc });
  await spe.create(cfs, { typeOperation: 'Sortie Magasin / MAD', numeroCamion: 'MAG-C/RM01', consoMode: 'sansbalise', declaration: { ...base, typeDeclaration: 'C', numeroDeclaration: '31' }, ...sc });
  const magT = db.store['cargaisons'].find((c) => c['numero_camion'] === 'MAG-T/RM01');
  const magC = db.store['cargaisons'].find((c) => c['numero_camion'] === 'MAG-C/RM01');
  assert.equal(magT?.['saute_t1'], false);
  assert.equal(magT?.['saute_balise'], false);
  assert.equal(magC?.['saute_t1'], true);
  assert.equal(magC?.['saute_balise'], true);
});

test('sortie Magasin/MAD : scellés camion posés → « Créée » d\'emblée', async () => {
  const db = new FakeDB();
  const cfs = ctxAvec(db);
  const base = { declarant: 'A', contactDeclarant: '901234', destinationMarchandise: 'D', bureauDeclaration: 'TG120', anneeDeclaration: '2026', descriptionMarchandise: 'SACS DE RIZ', typeDeclaration: 'C', numeroDeclaration: '40' };
  const r = (await spe.create(cfs, {
    typeOperation: 'Sortie Magasin / MAD', numeroCamion: 'MAG-S/RM01', consoMode: 'balise', declaration: base,
    chargementTermine: true, scellesCamion: ['SC1', 'SC2'],
  })) as { camions: { id: string }[] };
  const cargo = db.store['cargaisons'].find((c) => c['id'] === r.camions[0]!.id)!;
  assert.equal(cargo['statut'], STATUTS.CREEE);
  assert.deepEqual((cargo['conteneurs_details'] as { scellesCamion: string[] }).scellesCamion, ['SC1', 'SC2']);
});

test('sortie Magasin/MAD : « chargement terminé » exige ≥ 2 scellés', async () => {
  const db = new FakeDB();
  const cfs = ctxAvec(db);
  const base = { declarant: 'A', contactDeclarant: '901234', destinationMarchandise: 'D', bureauDeclaration: 'TG120', anneeDeclaration: '2026', descriptionMarchandise: 'RIZ', typeDeclaration: 'C', numeroDeclaration: '41' };
  await assert.rejects(
    spe.create(cfs, { typeOperation: 'Sortie Magasin / MAD', numeroCamion: 'MAG-X/RM01', consoMode: 'balise', declaration: base, chargementTermine: true, scellesCamion: ['SEUL'] }),
    /2 scellés/,
  );
});

test('sortie Magasin/MAD : sans « chargement terminé » → « En cours de chargement », finalisée par cargo.sceller', async () => {
  const db = new FakeDB();
  const cfs = ctxAvec(db);
  const base = { declarant: 'A', contactDeclarant: '901234', destinationMarchandise: 'D', bureauDeclaration: 'TG120', anneeDeclaration: '2026', descriptionMarchandise: 'RIZ', typeDeclaration: 'C', numeroDeclaration: '42' };
  const r = (await spe.create(cfs, {
    typeOperation: 'Sortie Magasin / MAD', numeroCamion: 'MAG-P/RM01', consoMode: 'balise', declaration: base, chargementTermine: false,
  })) as { camions: { id: string }[] };
  const id = r.camions[0]!.id;
  assert.equal(statutDe(db, id), STATUTS.CHARGEMENT);
  // Finalisation : pose des scellés camion → « Créée ».
  await ecr.sceller(cfs, { id, scellesCamion: ['S1', 'S2', 'S3'] });
  assert.equal(statutDe(db, id), STATUTS.CREEE);
  const cargo = db.store['cargaisons'].find((c) => c['id'] === id)!;
  assert.deepEqual((cargo['conteneurs_details'] as { scellesCamion: string[] }).scellesCamion, ['S1', 'S2', 'S3']);
});

test('confirmation entrée port sec EN LOT : confirme les pointés cochés, ignore le reste', async () => {
  const db = new FakeDB();
  // 3 conteneurs annoncés : 2 déjà pointés par la PP, 1 encore juste annoncé.
  db.store['stock_annonce'].push(
    { numero_tc: 'MSKU1234567', taille: "40'", statut: 'Pointé', date_pointage: '2026-07-16T08:00:00.000Z', pointe_par: 'Agent PP' },
    { numero_tc: 'TCLU7654321', taille: "20'", statut: 'Pointé', date_pointage: '2026-07-16T08:05:00.000Z', pointe_par: 'Agent PP' },
    { numero_tc: 'ABCU1111111', taille: "20'", statut: 'Annoncé' },
  );
  const cfs = ctxRole(db, 'CFS', 'Agent Port Sec');
  // On coche les 2 pointés + 1 non-pointé + 1 inexistant.
  const r = (await stk.annonceConfirmerLot(cfs, {
    numerosTC: ['MSKU1234567', 'TCLU7654321', 'ABCU1111111', 'ZZZU9999999'],
  })) as { confirmes: string[]; ignores: { numeroTC: string }[] };

  assert.deepEqual(r.confirmes.sort(), ['MSKU1234567', 'TCLU7654321']);
  assert.equal(r.ignores.length, 2); // le non-pointé + l'inexistant
  // Les deux pointés passent « Confirmé »…
  const a1 = db.store['stock_annonce'].find((x) => x['numero_tc'] === 'MSKU1234567');
  assert.equal(a1?.['statut'], 'Confirmé');
  assert.equal(a1?.['confirme_par'], 'Agent Port Sec');
  // …et entrent EFFECTIVEMENT au stock du port sec (provenance Port autonome).
  const s1 = db.store['stock'].find((x) => x['numero_tc'] === 'MSKU1234567');
  assert.equal(s1?.['statut'], 'En stock');
  assert.equal(s1?.['provenance'], 'PORT AUTONOME');
  // L'annoncé non pointé n'a pas bougé.
  assert.equal(db.store['stock_annonce'].find((x) => x['numero_tc'] === 'ABCU1111111')?.['statut'], 'Annoncé');
  assert.equal(db.store['stock'].length, 2);
});

test('validation non bloquante : T1 / Balise / sortie possibles sans validation', async () => {
  const db = new FakeDB();
  db.store['stock'].push({ numero_tc: 'MSKU1234567', taille: "40'", statut: 'En stock' });
  const cfs = ctxAvec(db);
  const { id } = (await ecr.createcamion(cfs, { numeroCamion: 'NOVAL1/RM01', routage: 'Enlèvement' })) as { id: string };
  await ecr.cfs(cfs, {
    id, conteneur: { num: 'MSKU1234567', taille: "40'", type: 'DRY', plomb: 'S1' },
    declaration: { declarant: 'A', contactDeclarant: '901234', destinationMarchandise: 'D', bureauDeclaration: 'TG120', typeDeclaration: 'T', numeroDeclaration: '60', anneeDeclaration: '2026', descriptionMarchandise: 'X', nombreConteneurs: 1 },
  });
  // AUCUNE validation chef brigade — le process continue quand même.
  await ecr.t1(ctxRole(db, 'T1', 'T1'), { id, bureauDestination: 'TG120', t1Numeros: [{ conteneur: 'MSKU1234567', numero: 'T1' }] });
  await ecr.gps(ctxRole(db, 'BALISE', 'B'), { id, baliseRequise: 'Oui', t1Correct: 'Oui', numeroGPS: 'G' });
  await ecr.sortie(ctxRole(db, 'PP', 'PP'), { id, ckCfs: true, ckT1: true, ckBalise: true, ckBs: true });
  assert.equal(statutDe(db, id), STATUTS.SORTIE);
});

test('correction du type : dépotage → enlèvement (scellés camion → plombs conteneur)', async () => {
  const db = new FakeDB();
  db.store['stock'].push({ numero_tc: 'MSKU1234567', taille: "40'", statut: 'Positionné' });
  const cfs = ctxAvec(db);
  const { id } = (await ecr.createcamion(cfs, { numeroCamion: 'CORR1/RM01', routage: 'Dépotage' })) as { id: string };
  await ecr.cfs(cfs, {
    id, conteneur: { num: 'MSKU1234567', taille: "40'", type: 'DRY' },
    declaration: { declarant: 'A', contactDeclarant: '901234', destinationMarchandise: 'D', bureauDeclaration: 'TG120', typeDeclaration: 'T', numeroDeclaration: '50', anneeDeclaration: '2026', dateDeclaration: '2026-06-24', descriptionMarchandise: 'X', nombreConteneurs: 1 },
  });
  await ecr.declaration(cfs, { id, hauteurChargement: '3', nbColis: '10', scellesCamion: ['S1', 'S2'] });
  // Correction du type → enlèvement.
  await ecr.edittype(cfs, { id, typeOperation: 'Enlèvement' });
  const c = versCamel(db.store['cargaisons'][0]!);
  assert.equal(c['typeOperation'], 'Enlèvement');
  // Enlèvement : scellés par conteneur → « Créée ».
  assert.equal(c['statut'], STATUTS.CREEE);
  const pd = c['conteneursDetails'] as { conteneurs: { plomb: string }[]; scellesCamion: string[] };
  assert.deepEqual(pd.scellesCamion, []); // plus de scellés camion
  assert.equal(pd.conteneurs[0]!.plomb, 'S1'); // 1er scellé camion repris comme plomb conteneur
});

test('correction du type refusée après validation (hors ADMIN)', async () => {
  const db = new FakeDB();
  db.store['stock'].push({ numero_tc: 'MSKU1234567', taille: "40'", statut: 'En stock' });
  const cfs = ctxAvec(db);
  const { id } = (await ecr.createcamion(cfs, { numeroCamion: 'CORR2/RM01', routage: 'Enlèvement' })) as { id: string };
  await ecr.cfs(cfs, {
    id, conteneur: { num: 'MSKU1234567', taille: "40'", type: 'DRY', plomb: 'S1' },
    declaration: { declarant: 'A', contactDeclarant: '901234', destinationMarchandise: 'D', bureauDeclaration: 'TG120', typeDeclaration: 'T', numeroDeclaration: '51', anneeDeclaration: '2026', dateDeclaration: '2026-06-24', descriptionMarchandise: 'X', nombreConteneurs: 1 },
  });
  await ecr.valider(ctxRole(db, 'CHEF_BRIGADE', 'CB'), { id, enSurcharge: false, suiviEngagement: false });
  await assert.rejects(() => ecr.edittype(cfs, { id, typeOperation: 'Dépotage' }), /déjà validée/);
});

test('confirmation en lot : refuse une sélection vide', async () => {
  const db = new FakeDB();
  const cfs = ctxRole(db, 'CFS', 'Agent Port Sec');
  await assert.rejects(() => stk.annonceConfirmerLot(cfs, { numerosTC: [] }), /Sélectionnez au moins un conteneur/);
});

test('import stock : format annoncé sans bureau + N° décl. réduit aux chiffres', async () => {
  const db = new FakeDB();
  const cfs = ctxRole(db, 'CFS', 'Agent CFS');
  const r = (await stk.stockImport(cfs, {
    items: [
      { numeroTC: 'MSKU1234567', taille: "40'", dateEntree: '2026-07-01', anneeDeclaration: '2026', typeDeclaration: 'C', numeroDeclaration: 'N° 18178/2026' },
      { numeroTC: 'TCLU7654321', taille: "20'", dateEntree: '2026-07-02', anneeDeclaration: '2026', typeDeclaration: 'T', numeroDeclaration: '  9 000 ' },
    ],
  })) as { ajoutes: number };
  assert.equal(r.ajoutes, 2);
  const a = db.store['stock'].find((x) => x['numero_tc'] === 'MSKU1234567');
  // N° de déclaration : chiffres uniquement (le « N° », l'espace et le « /2026 » sautent).
  assert.equal(a?.['numero_declaration'], '181782026');
  assert.equal(a?.['type_declaration'], 'C');
  assert.equal(a?.['annee_declaration'], '2026');
  const b = db.store['stock'].find((x) => x['numero_tc'] === 'TCLU7654321');
  assert.equal(b?.['numero_declaration'], '9000'); // espaces retirés
  // Aucune colonne « bureau » n'est écrite pour le stock.
  assert.equal('bureau_declaration' in (a ?? {}), false);
});

test('garde-fou : sortie refusée tant que la Balise n\'est pas posée', async () => {
  const db = new FakeDB();
  db.store['stock'].push({ numero_tc: 'MSKU1234567', taille: "40'", statut: 'En stock' });
  const cfs = ctxAvec(db);
  const { id } = (await ecr.createcamion(cfs, { numeroCamion: 'ZZ99/RM01', routage: 'Enlèvement' })) as { id: string };
  await ecr.cfs(cfs, {
    id, conteneur: { num: 'MSKU1234567', taille: "40'", type: 'DRY', plomb: 'S1' },
    declaration: { declarant: 'A', contactDeclarant: '901234', destinationMarchandise: 'D', bureauDeclaration: 'TG120', typeDeclaration: 'T', numeroDeclaration: '1', anneeDeclaration: '2026', dateDeclaration: '2026-06-24', descriptionMarchandise: 'X', nombreConteneurs: 1 },
  });
  await ecr.valider(ctxRole(db, 'CHEF_BRIGADE', 'CB'), { id, enSurcharge: false, suiviEngagement: false });
  // v4.1 — VERROU RÉACTIVÉ : ni T1 ni Balise → la PP ne peut pas clôturer.
  await assert.rejects(
    () => ecr.sortie(ctxRole(db, 'PP', 'PP'), { id, ckCfs: true, ckT1: true, ckBalise: true, ckBs: true }),
    /le T1 et la Balise/,
  );
  // Balise posée mais T1 pas encore fait → toujours refusé (transit).
  await ecr.gps(ctxRole(db, 'BALISE', 'B'), { id, baliseRequise: 'Oui', t1Correct: 'Oui', numeroGPS: 'G' });
  await assert.rejects(
    () => ecr.sortie(ctxRole(db, 'PP', 'PP'), { id, ckCfs: true, ckT1: true, ckBalise: true, ckBs: true }),
    /le T1 et la Balise/,
  );
  // T1 fait → la sortie passe enfin.
  await ecr.t1(ctxRole(db, 'T1', 'T1'), { id, bureauDestination: 'TG120', t1Numeros: [{ conteneur: 'MSKU1234567', numero: 'T1-Z' }] });
  await ecr.sortie(ctxRole(db, 'PP', 'PP'), { id, ckCfs: true, ckT1: true, ckBalise: true, ckBs: true });
  assert.equal(statutDe(db, id), STATUTS.SORTIE);
});

test('anti-doublon : recréer un camion actif est refusé', async () => {
  const db = new FakeDB();
  const cfs = ctxAvec(db);
  await ecr.createcamion(cfs, { numeroCamion: 'DUP1/RM01', routage: 'Dépotage' });
  // `numero_camion_norm` est désormais CALCULÉE par FakeDB, comme la colonne
  // générée l'est en base : plus besoin de la poser à la main ici.
  await assert.rejects(() => ecr.createcamion(cfs, { numeroCamion: 'DUP 1/RM01', routage: 'Dépotage' }), /existe déjà/);
});

/* ------------------------------------------------------------------------
 * v4 — Saisie en lot (1 déclaration → N camions) et CORRECTIONS de saisie.
 * ---------------------------------------------------------------------- */

const DECL_OK = {
  declarant: 'STE Y', contactDeclarant: '90112233', destinationMarchandise: 'KARA',
  bureauDeclaration: 'TG120', typeDeclaration: 'T', numeroDeclaration: '4242', anneeDeclaration: '2026',
  dateDeclaration: '2026-06-24', descriptionMarchandise: 'CIMENT', nombreConteneurs: 4,
};

test('lot camions : une seule déclaration reportée sur plusieurs camions', async () => {
  const db = new FakeDB();
  db.store['stock'].push(
    { numero_tc: 'MSKU1111111', taille: "40'", statut: 'En stock' },
    { numero_tc: 'TCLU2222222', taille: "40'", statut: 'En stock' },
  );
  const cfs = ctxAvec(db);
  const r = (await ecr.lotcamions(cfs, {
    typeOperation: 'Enlèvement', declaration: DECL_OK,
    camions: [
      { numeroCamion: 'LOT001/RM01', conteneurs: [{ num: 'MSKU1111111', taille: "40'", type: 'DRY', plomb: 'S1' }] },
      { numeroCamion: 'LOT002/RM01', conteneurs: [{ num: 'TCLU2222222', taille: "40'", type: 'DRY', plomb: 'S2' }] },
    ],
  })) as { crees: Record<string, unknown>[]; erreurs: unknown[] };

  assert.equal(r.crees.length, 2);
  assert.equal(r.erreurs.length, 0);
  // Les DEUX camions portent la même déclaration, saisie une seule fois.
  const cargos = db.store['cargaisons'];
  assert.equal(cargos.length, 2);
  for (const c of cargos) {
    assert.equal(c['declarant'], 'STE Y');
    assert.equal(c['numero_declaration'], '4242');
    assert.equal(c['description_marchandise'], 'CIMENT');
    assert.equal(c['statut'], STATUTS.CREEE);
  }
  // Une seule déclaration en base, apurée de 2 conteneurs.
  assert.equal(db.store['declarations'].length, 1);
  assert.equal(db.store['declarations'][0]?.['conteneurs_apures'], 2);
});

test("lot camions : un camion en erreur n'annule pas les autres", async () => {
  const db = new FakeDB();
  db.store['stock'].push({ numero_tc: 'MSKU1111111', taille: "40'", statut: 'En stock' });
  const cfs = ctxAvec(db);
  const r = (await ecr.lotcamions(cfs, {
    typeOperation: 'Enlèvement', declaration: DECL_OK,
    camions: [
      { numeroCamion: 'LOT001/RM01', conteneurs: [{ num: 'MSKU1111111', taille: "40'", type: 'DRY', plomb: 'S1' }] },
      // TC absent du stock → cette ligne seule échoue.
      { numeroCamion: 'LOT002/RM01', conteneurs: [{ num: 'ZZZZ9999999', taille: "40'", type: 'DRY', plomb: 'S2' }] },
    ],
  })) as { crees: unknown[]; erreurs: Record<string, unknown>[] };

  assert.equal(r.crees.length, 1);
  assert.equal(r.erreurs.length, 1);
  assert.equal(r.erreurs[0]?.['numeroCamion'], 'LOT002/RM01');
  assert.match(String(r.erreurs[0]?.['message']), /introuvable dans le stock/);
});

test('correction conteneur : le mauvais N° est remplacé et rendu au stock', async () => {
  const db = new FakeDB();
  db.store['stock'].push(
    { numero_tc: 'MSKU1111111', taille: "40'", statut: 'En stock' }, // saisi par erreur
    { numero_tc: 'TCLU2222222', taille: "40'", statut: 'En stock' }, // le vrai conteneur
  );
  const cfs = ctxAvec(db);
  const { id } = (await ecr.createcamion(cfs, { numeroCamion: 'FIX001/RM01', routage: 'Enlèvement' })) as { id: string };
  await ecr.cfs(cfs, { id, conteneur: { num: 'MSKU1111111', taille: "40'", type: 'DRY', plomb: 'S1' }, declaration: DECL_OK });
  assert.equal(db.store['stock'].find((s) => s['numero_tc'] === 'MSKU1111111')?.['statut'], 'Dépoté');

  await ecr.editconteneur(cfs, { id, index: 0, num: 'TCLU2222222', taille: "40'", type: 'DRY', plomb: 'S1' });

  const c = versCamel(db.store['cargaisons'][0]!);
  assert.equal((c['conteneursDetails'] as { conteneurs: { num: string }[] }).conteneurs[0]?.num, 'TCLU2222222');
  assert.equal(c['nbConteneurs'], 1);
  // Le conteneur saisi par erreur redevient disponible ; le bon est consommé.
  const errone = db.store['stock'].find((s) => s['numero_tc'] === 'MSKU1111111');
  assert.equal(errone?.['statut'], 'En stock');
  assert.equal(errone?.['cargaison_id'], null);
  assert.equal(db.store['stock'].find((s) => s['numero_tc'] === 'TCLU2222222')?.['statut'], 'Dépoté');
  // Table normalisée réalignée : une seule ligne, le bon N°.
  assert.equal(db.store['conteneurs'].length, 1);
  assert.equal(db.store['conteneurs'][0]?.['conteneur'], 'TCLU2222222');
});

test('correction conteneur : retrait de la ligne → camion revenu à « Camion créé »', async () => {
  const db = new FakeDB();
  db.store['stock'].push({ numero_tc: 'MSKU1111111', taille: "40'", statut: 'En stock' });
  const cfs = ctxAvec(db);
  const { id } = (await ecr.createcamion(cfs, { numeroCamion: 'FIX002/RM01', routage: 'Enlèvement' })) as { id: string };
  await ecr.cfs(cfs, { id, conteneur: { num: 'MSKU1111111', taille: "40'", type: 'DRY', plomb: 'S1' }, declaration: DECL_OK });

  await ecr.editconteneur(cfs, { id, index: 0, supprimer: true });

  assert.equal(statutDe(db, id), STATUTS.CAMION);
  assert.equal(db.store['conteneurs'].length, 0);
  assert.equal(db.store['stock'].find((s) => s['numero_tc'] === 'MSKU1111111')?.['statut'], 'En stock');
});

test('correction conteneur refusée après validation (hors ADMIN)', async () => {
  const db = new FakeDB();
  db.store['stock'].push({ numero_tc: 'MSKU1111111', taille: "40'", statut: 'En stock' });
  const cfs = ctxAvec(db);
  const { id } = (await ecr.createcamion(cfs, { numeroCamion: 'FIX003/RM01', routage: 'Enlèvement' })) as { id: string };
  await ecr.cfs(cfs, { id, conteneur: { num: 'MSKU1111111', taille: "40'", type: 'DRY', plomb: 'S1' }, declaration: DECL_OK });
  await ecr.valider(ctxRole(db, 'CHEF_BRIGADE', 'CB'), { id, enSurcharge: false, suiviEngagement: false });
  await ecr.gps(ctxRole(db, 'BALISE', 'B'), { id, baliseRequise: 'Oui', t1Correct: 'Oui', numeroGPS: 'G' });

  await assert.rejects(() => ecr.editconteneur(cfs, { id, index: 0, supprimer: true }), /a déjà avancé/);
  // L'ADMIN, lui, peut toujours corriger un historique.
  await ecr.editconteneur(ctxRole(db, 'ADMIN', 'Admin'), { id, index: 0, num: 'MSKU1111111', taille: "20'", type: 'DRY', plomb: 'S9' });
  const c = versCamel(db.store['cargaisons'][0]!);
  assert.equal((c['conteneursDetails'] as { conteneurs: { taille: string }[] }).conteneurs[0]?.taille, "20'");
});

test('correction déclaration : camion ET conteneurs réalignés', async () => {
  const db = new FakeDB();
  db.store['stock'].push({ numero_tc: 'MSKU1111111', taille: "40'", statut: 'En stock' });
  const cfs = ctxAvec(db);
  const { id } = (await ecr.createcamion(cfs, { numeroCamion: 'FIX004/RM01', routage: 'Enlèvement' })) as { id: string };
  await ecr.cfs(cfs, { id, conteneur: { num: 'MSKU1111111', taille: "40'", type: 'DRY', plomb: 'S1' }, declaration: DECL_OK });

  await ecr.editdecl(cfs, { id, declaration: { ...DECL_OK, numeroDeclaration: '9999', declarant: 'STE Z' } });

  const c = versCamel(db.store['cargaisons'][0]!);
  assert.equal(c['numeroDeclaration'], '9999');
  assert.equal(c['declarant'], 'STE Z');
  // chargement_mixte est NOT NULL en base : la correction doit écrire false, pas
  // null (sinon « violates not-null constraint » et la correction échoue).
  assert.equal(c['chargementMixte'], false);
  // La ligne conteneur porte la même déclaration corrigée (LOT D).
  const ct = (c['conteneursDetails'] as { conteneurs: Record<string, unknown>[] }).conteneurs[0]!;
  assert.equal(ct['numeroDeclaration'], '9999');
  assert.equal(ct['declarant'], 'STE Z');
});

/* ---------- Validation du chef brigade PAR DÉCLARATION (v4) ----------- */

test('validation par déclaration : le chef voit tout puis signe en une fois', async () => {
  const db = new FakeDB();
  db.store['stock'].push(
    { numero_tc: 'MSKU1111111', taille: "40'", statut: 'En stock' },
    { numero_tc: 'TCLU2222222', taille: "20'", statut: 'En stock' },
    { numero_tc: 'GLDU3333333', taille: "20'", statut: 'En stock' },
  );
  const cfs = ctxAvec(db);
  const chef = ctxRole(db, 'CHEF_BRIGADE', 'Chef Brigade');

  // Deux camions sur la déclaration 4242, un troisième sur une AUTRE déclaration.
  const a = (await ecr.createcamion(cfs, { numeroCamion: 'VAL001/RM01', routage: 'Enlèvement' })) as { id: string };
  await ecr.cfs(cfs, { id: a.id, conteneur: { num: 'MSKU1111111', taille: "40'", type: 'DRY', plomb: 'S1' }, declaration: DECL_OK });
  const b = (await ecr.createcamion(cfs, { numeroCamion: 'VAL002/RM01', routage: 'Enlèvement' })) as { id: string };
  await ecr.cfs(cfs, { id: b.id, conteneur: { num: 'TCLU2222222', taille: "20'", type: 'DRY', plomb: 'S2' }, declaration: DECL_OK });
  const autre = (await ecr.createcamion(cfs, { numeroCamion: 'VAL003/RM01', routage: 'Enlèvement' })) as { id: string };
  await ecr.cfs(cfs, { id: autre.id, conteneur: { num: 'GLDU3333333', taille: "20'", type: 'DRY', plomb: 'S3' },
    declaration: { ...DECL_OK, numeroDeclaration: '5555' } });

  // Sans numéro : la FILE des déclarations en attente, la plus ancienne en tête.
  const file = (await rap.validationParDeclaration(chef, {})) as { declarations: Record<string, unknown>[]; total: number };
  assert.equal(file.total, 2);
  const d4242 = file.declarations.find((x) => x['numeroDeclaration'] === '4242')!;
  assert.equal(d4242['camions'], 2);
  assert.equal(d4242['conteneurs'], 2);

  // Avec numéro : le dossier complet de la déclaration, et elle seule.
  const dossier = (await rap.validationParDeclaration(chef, { numeroDeclaration: '4242' })) as {
    camions: Record<string, unknown>[]; aValider: string[]; compte: Record<string, number>;
  };
  assert.equal(dossier.compte['camions'], 2);
  assert.equal(dossier.compte['conteneurs'], 2);
  assert.equal(dossier.compte['aValider'], 2);
  assert.equal(dossier.compte['dejaValidees'], 0);
  assert.deepEqual([...dossier.aValider].sort(), [a.id, b.id].sort());
  // Le camion de la déclaration 5555 n'est PAS embarqué dans le lot.
  assert.ok(!dossier.aValider.includes(autre.id));

  // Signature en lot : les deux cargaisons sont validées d'un geste.
  const res = (await ecr.validerLot(chef, { ids: dossier.aValider, pesees: Object.fromEntries((dossier.aValider as string[]).map((x) => [x, { enSurcharge: false }])), suiviEngagement: false })) as {
    validees: string[]; erreurs: unknown[]; compte: Record<string, number>;
  };
  assert.equal(res.compte['validees'], 2);
  assert.equal(res.compte['erreurs'], 0);

  // Chaque cargaison porte SA propre signature (valeur probante à l'unité).
  const lignes = db.store['cargaisons'].filter((c) => [a.id, b.id].includes(String(c['id'])));
  assert.equal(lignes.length, 2);
  for (const l of lignes) {
    assert.ok(l['date_validation'], 'date de validation posée');
    assert.equal(l['agent_validation'], 'Chef Brigade');
    assert.ok(l['signature_validation'], 'signature posée');
  }
  assert.notEqual(lignes[0]!['signature_validation'], lignes[1]!['signature_validation']);
  // Le camion de l'autre déclaration reste intact.
  assert.ok(!db.store['cargaisons'].find((c) => c['id'] === autre.id)!['date_validation']);

  // Rouvrir la déclaration : plus rien à valider, tout est signé.
  const apres = (await rap.validationParDeclaration(chef, { numeroDeclaration: '4242' })) as {
    aValider: string[]; compte: Record<string, number>;
  };
  assert.equal(apres.compte['aValider'], 0);
  assert.equal(apres.compte['dejaValidees'], 2);
  assert.deepEqual(apres.aValider, []);
  // La file ne retient plus que l'autre déclaration.
  const file2 = (await rap.validationParDeclaration(chef, {})) as { total: number; declarations: Record<string, unknown>[] };
  assert.equal(file2.total, 1);
  assert.equal(file2.declarations[0]!['numeroDeclaration'], '5555');
});

test('validation en lot : une cargaison en erreur n\'annule pas les autres', async () => {
  const db = new FakeDB();
  db.store['stock'].push({ numero_tc: 'MSKU1111111', taille: "40'", statut: 'En stock' });
  const cfs = ctxAvec(db);
  const chef = ctxRole(db, 'CHEF_BRIGADE', 'Chef Brigade');

  const ok = (await ecr.createcamion(cfs, { numeroCamion: 'VAL010/RM01', routage: 'Enlèvement' })) as { id: string };
  await ecr.cfs(cfs, { id: ok.id, conteneur: { num: 'MSKU1111111', taille: "40'", type: 'DRY', plomb: 'S1' }, declaration: DECL_OK });
  // Camion encore EN CHARGEMENT : le CFS n'a pas fini, il ne peut pas être validé.
  const pasPret = (await ecr.createcamion(cfs, { numeroCamion: 'VAL011/RM01', routage: 'Enlèvement' })) as { id: string };

  const res = (await ecr.validerLot(chef, { ids: [ok.id, pasPret.id, 'INEXISTANT'], pesees: { [ok.id]: { enSurcharge: false }, [pasPret.id]: { enSurcharge: false } }, suiviEngagement: false })) as {
    validees: string[]; erreurs: Record<string, unknown>[];
  };
  assert.deepEqual(res.validees, [ok.id]);
  assert.equal(res.erreurs.length, 2);
  assert.match(String(res.erreurs[0]!['message']), /le CFS doit d'abord terminer/);
  assert.match(String(res.erreurs[1]!['message']), /introuvable/);
  // Le camion valide est bien passé malgré les deux échecs.
  assert.ok(db.store['cargaisons'].find((c) => c['id'] === ok.id)!['date_validation']);
});

test('validation en lot : refuse un appel sans identifiants', async () => {
  const db = new FakeDB();
  await assert.rejects(
    () => ecr.validerLot(ctxRole(db, 'CHEF_BRIGADE', 'CB'), { ids: [] }),
    /Aucune cargaison à valider/,
  );
});

/* ------- Corrections en cellule : plaque (tous) & balise (Balise) ------ */

/** Contexte qui CAPTURE les écritures d'audit, pour vérifier la traçabilité. */
function ctxTrace(db: FakeDB, role: string, nom: string) {
  const traces: { action: string; cible: string; detail: string }[] = [];
  const ctx = { ...ctxRole(db, role, nom), log: async (action: string, cible: string, detail: string) => { traces.push({ action, cible, detail }); } };
  return { ctx: ctx as never as Ctx, traces };
}

/** Camion balisé, prêt pour les corrections d'aval. */
async function camionBalise(db: FakeDB, plaque = 'COR001/RM01') {
  const cfs = ctxAvec(db);
  const { id } = (await ecr.createcamion(cfs, { numeroCamion: plaque, routage: 'Enlèvement' })) as { id: string };
  await ecr.cfs(cfs, { id, conteneur: { num: 'MSKU1111111', taille: "40'", type: 'DRY', plomb: 'S1' }, declaration: DECL_OK });
  await ecr.gps(ctxRole(db, 'BALISE', 'Agent Balise'), { id, baliseRequise: 'Oui', t1Correct: 'Oui', numeroGPS: 'GPS-AAA' });
  return id;
}

test('cellule Balise : corrige son propre N° de balise, correction tracée', async () => {
  const db = new FakeDB();
  db.store['stock'].push({ numero_tc: 'MSKU1111111', taille: "40'", statut: 'En stock' });
  const id = await camionBalise(db);
  const { ctx, traces } = ctxTrace(db, 'BALISE', 'Agent Balise');

  await ecr.gpsedit(ctx, { id, numeroGPS: 'GPS-BBB', observations: 'Erreur de frappe' });

  const c = versCamel(db.store['cargaisons'][0]!);
  assert.equal(c['numeroGps'], 'GPS-BBB');
  // L'agent qui corrige est enregistré comme poseur : la fiche reste cohérente.
  assert.equal(c['agentBalise'], 'Agent Balise');
  assert.equal(c['observationsBalise'], 'Erreur de frappe');
  // Traçabilité : l'ancien numéro ne disparaît pas silencieusement.
  assert.equal(traces.length, 1);
  assert.match(traces[0]!.detail, /GPS-AAA/);
  assert.match(traces[0]!.detail, /GPS-BBB/);
});

test('correction de balise impossible une fois le camion sorti', async () => {
  const db = new FakeDB();
  db.store['stock'].push({ numero_tc: 'MSKU1111111', taille: "40'", statut: 'En stock' });
  const id = await camionBalise(db);
  // v4.1 — la PP exige le T1 avant la sortie (transit).
  await ecr.t1(ctxRole(db, 'T1', 'Agent T1'), { id, bureauDestination: 'TG120', t1Numeros: [{ conteneur: 'MSKU1111111', numero: 'T1-Q' }] });
  await ecr.bonsortie(ctxRole(db, 'BON_SORTIE', 'Agent BS'), { id, bonSortieNumero: 'BS-1' });
  await ecr.sortie(ctxRole(db, 'PP', 'Agent PP'), { id, ckCfs: true, ckT1: true, ckBalise: true, ckBs: true });

  // Garde-fou conservé : passé la sortie, plus personne ne réécrit la balise.
  await assert.rejects(
    () => ecr.gpsedit(ctxRole(db, 'BALISE', 'Agent Balise'), { id, numeroGPS: 'GPS-ZZZ' }),
    /Remplacement impossible/,
  );
});

test('plaque : le CFS corrige avec motif, et la correction suit les conteneurs (SEC-11)', async () => {
  const db = new FakeDB();
  db.store['stock'].push({ numero_tc: 'MSKU1111111', taille: "40'", statut: 'En stock' });
  const id = await camionBalise(db, 'MAUVAISE1/RM01');

  // Le motif est obligatoire : c'est lui qui rend l'audit exploitable. 638
  // corrections de plaque figurent dans l'historique de production, sans qu'on
  // puisse dire laquelle est une coquille et laquelle est une substitution.
  const c = ctxTrace(db, 'CFS', 'Agent CFS');
  await assert.rejects(
    () => ecr.editcamion(c.ctx, { id, numeroCamion: 'BONNE2/RM01' }),
    /motif de la correction/,
  );

  await ecr.editcamion(c.ctx, { id, numeroCamion: 'BONNE2/RM01', motif: 'plaque illisible à l\'entrée' });
  assert.equal(versCamel(db.store['cargaisons'][0]!)['numeroCamion'], 'BONNE2/RM01');
  assert.match(c.traces.at(-1)!.detail, /MAUVAISE1\/RM01 → BONNE2\/RM01 · motif : plaque illisible/);

  // La correction suit le camion sur ses conteneurs, pas seulement sur la fiche.
  const ct = db.store['conteneurs'].find((x) => x['cargaison_id'] === id);
  if (ct) assert.equal(ct['numero_camion'], 'BONNE2/RM01');
});

test('plaque : verrouillée après validation, puis après la sortie (SEC-11)', async () => {
  const db = new FakeDB();
  db.store['stock'].push({ numero_tc: 'MSKU1111111', taille: "40'", statut: 'En stock' });
  const id = await camionBalise(db, 'VERROU1/RM01');

  // Une fois le chef de brigade passé, la plaque n'appartient plus au CFS.
  await ecr.valider(ctxRole(db, 'CHEF_BRIGADE', 'Chef'), { id, enSurcharge: 'Non', suiviEngagement: false });
  await assert.rejects(
    () => ecr.editcamion(ctxRole(db, 'CFS', 'C'), { id, numeroCamion: 'APRES2/RM01', motif: 'coquille' }),
    /relève de l'administrateur/,
  );
  // L'ADMIN reste capable de dépanner tant que le camion est dans l'enceinte.
  await ecr.editcamion(ctxRole(db, 'ADMIN', 'Admin'), { id, numeroCamion: 'APRES2/RM01', motif: 'coquille avérée' });
  assert.equal(versCamel(db.store['cargaisons'][0]!)['numeroCamion'], 'APRES2/RM01');

  // Après la sortie, plus personne — pas même l'ADMIN : le camion est parti
  // avec un bon de sortie portant cette plaque. (Le T1 conditionne la sortie.)
  await ecr.t1(ctxRole(db, 'T1', 'T1'), { id, bureauDestination: 'TG120', t1Numeros: [{ conteneur: 'MSKU1111111', numero: 'T1-1' }] });
  await ecr.sortie(ctxRole(db, 'PP', 'PP'), { id, ckCfs: true, ckT1: true, ckBalise: true, ckBs: true });
  await assert.rejects(
    () => ecr.editcamion(ctxRole(db, 'ADMIN', 'Admin'), { id, numeroCamion: 'APRES3/RM01', motif: 'x' }),
    /déjà sorti/,
  );
});

test('checklist PP : une case cochée ne crée pas la pièce manquante (SEC-13)', async () => {
  const db = new FakeDB();
  db.store['stock'].push({ numero_tc: 'MSKU1111111', taille: "40'", statut: 'En stock' });
  const id = await camionBalise(db, 'CHKPP1/RM01');
  await ecr.t1(ctxRole(db, 'T1', 'T1'), { id, bureauDestination: 'TG120', t1Numeros: [{ conteneur: 'MSKU1111111', numero: 'T1-9' }] });

  // L'agent coche les 4 contrôles alors qu'AUCUN bon de sortie n'a été émis.
  const pp = ctxTrace(db, 'PP', 'Agent PP');
  const res = (await ecr.sortie(pp.ctx, { id, ckCfs: true, ckT1: true, ckBalise: true, ckBs: true })) as { ecart?: string[] };

  const ck = versCamel(db.store['cargaisons'][0]!)['ppChecklist'] as Record<string, unknown>;
  // Ce que la base retient, c'est l'ÉTAT RÉEL — pas la case cochée.
  assert.equal(ck['bs'], false, 'le bon de sortie ne doit pas être consigné comme fait');
  assert.equal((ck['declare'] as Record<string, unknown>)['bs'], true, 'la déclaration de l\'agent est conservée à part');
  assert.deepEqual(ck['ecart'], ['bon de sortie']);
  assert.deepEqual(res.ecart, ['bon de sortie']);
  // …et l'écart part au journal, il ne reste pas enfoui dans une colonne JSON.
  assert.match(pp.traces.at(-1)!.action, /Sortie sans pièce complète/);
});

/* ------- v4.1 : enlèvement = fin de chargement à la saisie ------------- */

test('enlèvement : la saisie du conteneur (scellé) passe SEULE en « Créée »', async () => {
  const db = new FakeDB();
  db.store['stock'].push({ numero_tc: 'MSKU1111111', taille: "40'", statut: 'En stock' });
  const cfs = ctxAvec(db);
  const { id } = (await ecr.createcamion(cfs, { numeroCamion: 'FIN001/RM01', routage: 'Enlèvement' })) as { id: string };
  await ecr.cfs(cfs, { id, conteneur: { num: 'MSKU1111111', taille: "40'", type: 'DRY', plomb: 'S1' }, declaration: DECL_OK });
  // Aucune confirmation : l'étape CFS est franchie d'emblée.
  assert.equal(statutDe(db, id), STATUTS.CREEE);
  assert.deepEqual(etapesEnAttente(versCamel(db.store['cargaisons'][0]!) as never), ['VALIDATION', 'T1', 'BALISE', 'BS']);
});

test('rattrapage : un enlèvement resté « En cours de chargement » se termine en un clic', async () => {
  const db = new FakeDB();
  db.store['stock'].push({ numero_tc: 'MSKU1111111', taille: "40'", statut: 'En stock' });
  const cfs = ctxAvec(db);
  const { id } = (await ecr.createcamion(cfs, { numeroCamion: 'FIN002/RM01', routage: 'Enlèvement' })) as { id: string };
  await ecr.cfs(cfs, { id, conteneur: { num: 'MSKU1111111', taille: "40'", type: 'DRY', plomb: 'S1' }, declaration: DECL_OK });
  // Simule un camion LEGACY bloqué (créé quand l'enlèvement restait au chargement).
  db.store['cargaisons'].find((c) => c['id'] === id)!['statut'] = STATUTS.CHARGEMENT;
  await ecr.finChargement(cfs, { id });
  assert.equal(statutDe(db, id), STATUTS.CREEE);
  // Non rejouable : déjà terminé.
  await assert.rejects(() => ecr.finChargement(cfs, { id }), /déjà terminé/);
});

test('rattrapage refusé sur un camion vide', async () => {
  const db = new FakeDB();
  const cfs = ctxAvec(db);
  const { id } = (await ecr.createcamion(cfs, { numeroCamion: 'FIN003/RM01', routage: 'Enlèvement' })) as { id: string };
  await assert.rejects(() => ecr.finChargement(cfs, { id }), /Rien à clôturer/);
});

test('le dépotage garde sa propre clôture (scellés camion), pas fincharge', async () => {
  const db = new FakeDB();
  db.store['stock'].push({ numero_tc: 'TCLU7654321', taille: "40'", statut: 'Positionné' });
  const cfs = ctxAvec(db);
  const { id } = (await ecr.createcamion(cfs, { numeroCamion: 'FIN005/RM01', routage: 'Dépotage' })) as { id: string };
  await ecr.cfs(cfs, { id, conteneur: { num: 'TCLU7654321', taille: "40'", type: 'DRY' }, declaration: DECL_OK });
  // Le dépotage reste « En cours de chargement » et se termine par la finalisation.
  assert.equal(statutDe(db, id), STATUTS.CHARGEMENT);
  await assert.rejects(() => ecr.finChargement(cfs, { id }), /finalisation/);
  await ecr.declaration(cfs, { id, hauteurChargement: '3', nbColis: '10', scellesCamion: ['S1', 'S2'] });
  assert.equal(statutDe(db, id), STATUTS.CREEE);
});

/* ---- v4.1 : ré-import du stock, conflits annoncés avant d'écrire -------- */

/** Stock contenant un TC saisi À LA MAIN et déjà engagé dans une opération. */
function stockAvecSaisieManuelle(db: FakeDB) {
  db.store['stock'].push({
    numero_tc: 'MSKU1234567', taille: "40'", statut: 'Positionné', cargaison_id: 'CT-2026-000001',
    date_entree: '2026-06-01T00:00:00.000Z', numero_declaration: '111', annee_declaration: '2026', type_declaration: 'T',
  });
}
const FICHIER_REIMPORT = [
  { numeroTC: 'MSKU1234567', taille: "20'", dateEntree: '2026-07-10', anneeDeclaration: '2026', typeDeclaration: 'C', numeroDeclaration: '999' },
  { numeroTC: 'TCLU7654321', taille: "40'", dateEntree: '2026-07-10', anneeDeclaration: '2026', typeDeclaration: 'T', numeroDeclaration: '222' },
];

test('ré-import stock : l’analyse annonce les doublons SANS rien écrire', async () => {
  const db = new FakeDB();
  stockAvecSaisieManuelle(db);
  const r = (await stk.stockImport(ctxRole(db, 'CFS', 'Agent CFS'), { items: FICHIER_REIMPORT, analyser: true })) as
    { analyse: boolean; nouveaux: number; engages: number; doublons: Record<string, unknown>[] };
  assert.equal(r.analyse, true);
  assert.equal(r.nouveaux, 1); // TCLU7654321
  assert.equal(r.doublons.length, 1);
  assert.equal(r.doublons[0]!['numeroTC'], 'MSKU1234567');
  // « Engagé » : positionné + rattaché à un camion → l’écraser touche une opération.
  assert.equal(r.doublons[0]!['engage'], true);
  assert.equal(r.doublons[0]!['declarationExistante'], '111 · 2026 · T');
  assert.equal(r.doublons[0]!['declarationFichier'], '999 · 2026 · C');
  // RIEN n’a bougé : ni le nouveau ajouté, ni l’existant modifié.
  assert.equal(db.store['stock'].length, 1);
  assert.equal(db.store['stock'][0]!['numero_declaration'], '111');
});

test('ré-import stock : « ignorer » ajoute les nouveaux et laisse les doublons intacts', async () => {
  const db = new FakeDB();
  stockAvecSaisieManuelle(db);
  const r = (await stk.stockImport(ctxRole(db, 'CFS', 'Agent CFS'), { items: FICHIER_REIMPORT, surDoublon: 'ignorer' })) as
    { ajoutes: number; maj: number; ignores: number };
  assert.equal(r.ajoutes, 1);
  assert.equal(r.maj, 0);
  assert.equal(r.ignores, 1);
  const ancien = db.store['stock'].find((x) => x['numero_tc'] === 'MSKU1234567')!;
  assert.equal(ancien['numero_declaration'], '111'); // pas écrasé
  assert.equal(ancien['taille'], "40'");
  assert.equal(ancien['statut'], 'Positionné');
  assert.ok(db.store['stock'].find((x) => x['numero_tc'] === 'TCLU7654321'));
});

test('ré-import stock : « remplacer » met à jour SANS jamais toucher au statut', async () => {
  const db = new FakeDB();
  stockAvecSaisieManuelle(db);
  const r = (await stk.stockImport(ctxRole(db, 'CFS', 'Agent CFS'), { items: FICHIER_REIMPORT, surDoublon: 'remplacer' })) as
    { ajoutes: number; maj: number };
  assert.equal(r.ajoutes, 1);
  assert.equal(r.maj, 1);
  const ancien = db.store['stock'].find((x) => x['numero_tc'] === 'MSKU1234567')!;
  assert.equal(ancien['numero_declaration'], '999');
  assert.equal(ancien['taille'], "20'");
  // Un conteneur positionné ne redevient pas « En stock » parce qu’il est dans un fichier.
  assert.equal(ancien['statut'], 'Positionné');
});

test('ré-import stock : par défaut, aucun doublon n’est écrasé', async () => {
  const db = new FakeDB();
  stockAvecSaisieManuelle(db);
  await stk.stockImport(ctxRole(db, 'CFS', 'Agent CFS'), { items: FICHIER_REIMPORT });
  assert.equal(db.store['stock'].find((x) => x['numero_tc'] === 'MSKU1234567')!['numero_declaration'], '111');
});

/* ---- v4.1 : « Éditer » débloqué sur les données incomplètes ------------- */

test('correction déclaration : possible même sans contact ni destination (migrées)', async () => {
  const db = new FakeDB();
  db.store['stock'].push({ numero_tc: 'MSKU1111111', taille: "40'", statut: 'En stock' });
  const cfs = ctxAvec(db);
  const { id } = (await ecr.createcamion(cfs, { numeroCamion: 'MIG001/RM01', routage: 'Enlèvement' })) as { id: string };
  await ecr.cfs(cfs, { id, conteneur: { num: 'MSKU1111111', taille: "40'", type: 'DRY', plomb: 'S1' }, declaration: DECL_OK });
  // On simule une cargaison MIGRÉE : contact / destination / désignation absents.
  const ligne = db.store['cargaisons'].find((x) => x['id'] === id)!;
  ligne['contact_declarant'] = ''; ligne['destination_marchandise'] = ''; ligne['description_marchandise'] = '';

  // L’agent ne corrige QUE le numéro : refusé avant, accepté maintenant.
  await ecr.editdecl(cfs, {
    id,
    declaration: { declarant: 'STE X', bureauDeclaration: 'TG120', typeDeclaration: 'T', numeroDeclaration: '4321', anneeDeclaration: '2026' },
  });
  assert.equal(versCamel(db.store['cargaisons'][0]!)['numeroDeclaration'], '4321');
  // Un téléphone FAUX reste refusé : on assouplit l’absence, pas la validité.
  await assert.rejects(() => ecr.editdecl(cfs, {
    id,
    declaration: { declarant: 'STE X', contactDeclarant: '12', bureauDeclaration: 'TG120', typeDeclaration: 'T', numeroDeclaration: '4321', anneeDeclaration: '2026' },
  }), /téléphone invalide/);
});

test('correction déclaration : un champ vide ne vide pas ce qui existe', async () => {
  const db = new FakeDB();
  db.store['stock'].push({ numero_tc: 'MSKU1111111', taille: "40'", statut: 'En stock' });
  const cfs = ctxAvec(db);
  const { id } = (await ecr.createcamion(cfs, { numeroCamion: 'MIG002/RM01', routage: 'Enlèvement' })) as { id: string };
  await ecr.cfs(cfs, { id, conteneur: { num: 'MSKU1111111', taille: "40'", type: 'DRY', plomb: 'S1' }, declaration: DECL_OK });
  await ecr.editdecl(cfs, {
    id,
    declaration: { declarant: 'STE X', bureauDeclaration: 'TG120', typeDeclaration: 'T', numeroDeclaration: '5555', anneeDeclaration: '2026' },
  });
  const c = versCamel(db.store['cargaisons'][0]!);
  assert.equal(c['numeroDeclaration'], '5555');
  assert.equal(c['contactDeclarant'], DECL_OK.contactDeclarant); // conservé
  assert.equal(c['destinationMarchandise'], DECL_OK.destinationMarchandise);
});

test('correction conteneur : la déclaration se change LIGNE PAR LIGNE (mixte préservé)', async () => {
  const db = new FakeDB();
  db.store['stock'].push(
    { numero_tc: 'MSKU1111111', taille: "20'", statut: 'En stock' },
    { numero_tc: 'TCLU2222222', taille: "20'", statut: 'En stock' },
  );
  const cfs = ctxAvec(db);
  const { id } = (await ecr.createcamion(cfs, { numeroCamion: 'MIX001/RM01', routage: 'Enlèvement' })) as { id: string };
  await ecr.cfs(cfs, { id, conteneur: { num: 'MSKU1111111', taille: "20'", type: 'DRY', plomb: 'S1' }, declaration: DECL_OK });
  await ecr.cfs(cfs, { id, conteneur: { num: 'TCLU2222222', taille: "20'", type: 'DRY', plomb: 'S2' } });

  // On rattache la 2e ligne à une AUTRE déclaration.
  await ecr.editconteneur(cfs, {
    id, index: 1, num: 'TCLU2222222', taille: "20'", type: 'DRY', plomb: 'S2',
    declaration: { numeroDeclaration: '8888', anneeDeclaration: '2026', bureauDeclaration: 'TG120', typeDeclaration: 'C' },
  });
  const cargo = versCamel(db.store['cargaisons'][0]!);
  const dets = cargo['conteneursDetails'] as { conteneurs: Record<string, unknown>[] };
  assert.equal(dets.conteneurs[0]!['numeroDeclaration'], DECL_OK.numeroDeclaration); // ligne 1 intacte
  assert.equal(dets.conteneurs[1]!['numeroDeclaration'], '8888');
  assert.equal(dets.conteneurs[1]!['typeDeclaration'], 'C');
  // Le camion devient donc un chargement MIXTE, reconnu par le domaine.
  assert.equal(groupesDeclaration(dets.conteneurs as never, cargo as never).length, 2);

  // Un champ de déclaration vide = « ne touche pas », pas « efface ».
  await ecr.editconteneur(cfs, {
    id, index: 1, num: 'TCLU2222222', taille: "20'", type: 'DRY', plomb: 'S2',
    declaration: { numeroDeclaration: '', anneeDeclaration: '', bureauDeclaration: '', typeDeclaration: '' },
  });
  const dets2 = versCamel(db.store['cargaisons'][0]!)['conteneursDetails'] as { conteneurs: Record<string, unknown>[] };
  assert.equal(dets2.conteneurs[1]!['numeroDeclaration'], '8888');
});

/* ---- v4.1 : ré-import — les SAISIES MANUELLES sont reconnues ------------ */

/**
 * Crée un enlèvement dont le conteneur a été SAISI À LA MAIN (case « hors
 * stock ») : il est donc sur un camion (table conteneurs) mais ABSENT de la
 * table stock — exactement le cas que l'import doit rattraper.
 */
async function enlevementSaisieManuelle(db: FakeDB, tc = 'MSKU1234567', plaque = 'MAN001/RM01') {
  const cfs = ctxAvec(db);
  const { id } = (await ecr.createcamion(cfs, { numeroCamion: plaque, routage: 'Enlèvement' })) as { id: string };
  await ecr.cfs(cfs, {
    id, conteneur: { num: tc, taille: "40'", type: 'DRY', plomb: 'S1', manuel: true },
    declaration: DECL_OK,
  });
  return id;
}

test('saisie manuelle : bien absente du stock, mais présente sur le camion', async () => {
  const db = new FakeDB();
  await enlevementSaisieManuelle(db);
  // C'est TOUT le problème : rien dans la table stock…
  assert.equal(db.store['stock'].length, 0);
  // …mais le conteneur existe sur le camion.
  assert.equal(db.store['conteneurs'].some((c) => c['conteneur'] === 'MSKU1234567'), true);
});

test('ré-import : une saisie manuelle est repérée comme doublon, pas comme nouveau', async () => {
  const db = new FakeDB();
  await enlevementSaisieManuelle(db);
  const fichier = [
    { numeroTC: 'MSKU1234567', taille: "40'", dateEntree: '2026-07-10', anneeDeclaration: '2026', typeDeclaration: 'T', numeroDeclaration: '333' },
    { numeroTC: 'TCLU7654321', taille: "20'", dateEntree: '2026-07-10', anneeDeclaration: '2026', typeDeclaration: 'T', numeroDeclaration: '444' },
  ];
  const r = (await stk.stockImport(ctxRole(db, 'CFS', 'Agent CFS'), { items: fichier, analyser: true })) as
    { nouveaux: number; manuels: number; doublons: Record<string, unknown>[] };
  // Le TC saisi à la main n'est PAS compté comme nouveau.
  assert.equal(r.nouveaux, 1); // seul TCLU7654321
  assert.equal(r.manuels, 1);
  const d = r.doublons.find((x) => x['numeroTC'] === 'MSKU1234567')!;
  assert.equal(d['source'], 'manuel');
  assert.equal(d['engage'], true);
  assert.match(String(d['statut']), /manuelle/i);
});

test('ré-import « ignorer » : la saisie manuelle N\'EST PAS recréée en stock', async () => {
  const db = new FakeDB();
  await enlevementSaisieManuelle(db);
  const fichier = [{ numeroTC: 'MSKU1234567', taille: "40'", dateEntree: '2026-07-10', anneeDeclaration: '2026', typeDeclaration: 'T', numeroDeclaration: '333' }];
  const r = (await stk.stockImport(ctxRole(db, 'CFS', 'Agent CFS'), { items: fichier, surDoublon: 'ignorer' })) as { ajoutes: number; regularises: number };
  assert.equal(r.ajoutes, 0);
  assert.equal(r.regularises, 0);
  // Surtout : aucune fiche « En stock » créée qui le rendrait re-sélectionnable.
  assert.equal(db.store['stock'].length, 0);
});

test('ré-import « remplacer » : la saisie manuelle est RÉGULARISÉE (dépotée, liée, jamais En stock)', async () => {
  const db = new FakeDB();
  const cargoId = await enlevementSaisieManuelle(db);
  const fichier = [{ numeroTC: 'MSKU1234567', taille: "40'", dateEntree: '2026-07-10', anneeDeclaration: '2026', typeDeclaration: 'C', numeroDeclaration: '333' }];
  const r = (await stk.stockImport(ctxRole(db, 'CFS', 'Agent CFS'), { items: fichier, surDoublon: 'remplacer' })) as { regularises: number };
  assert.equal(r.regularises, 1);
  const s = db.store['stock'].find((x) => x['numero_tc'] === 'MSKU1234567')!;
  assert.ok(s, 'une fiche stock a été créée');
  assert.equal(s['statut'], 'Dépoté');       // jamais « En stock »
  assert.equal(s['cargaison_id'], cargoId);   // liée à son camion
  assert.equal(s['numero_declaration'], '333');
});

/* ---- v4.1 : fiche de synthèse — le champ « Conteneurs MAD » --------------- */

test('fiche : « Conteneurs MAD » compte les entrées Magasin/MAD (stock), pas le vrac', async () => {
  const db = new FakeDB();
  const cfs = ctxRole(db, 'CFS', 'Agent CFS');
  // 4 conteneurs du parc entrés au magasin via l'écran « Entrée Magasin/MAD ».
  for (const tc of ['MSKU1000001', 'MSKU1000002', 'MSKU1000003', 'MSKU1000004']) {
    db.store['stock'].push({ numero_tc: tc, taille: "40'", statut: 'En stock' });
    await stk.stockEntreeMagasin(cfs, { numeroTC: tc, taille: "40'" });
  }
  const f = (await rap.ficheBord(cfs, {})) as { cfs: { mad: { conteneurs: number }; total: { conteneurs: number } } };
  // AVANT le correctif : restait à 0 (on comptait les cargaisons de type MAGASIN,
  // qui sont du vrac à 0 conteneur). Désormais : les 4 conteneurs sont comptés.
  assert.equal(f.cfs.mad.conteneurs, 4);
  // Et le total CFS les inclut.
  assert.equal(f.cfs.total.conteneurs, 4);
});

/* ---- v4.1 : fiche — la CONSO se compte au TYPE DE DÉCLARATION C ---------- */

test('fiche : « conso » = camions dont la déclaration est de type C (pas l’opération)', async () => {
  const db = new FakeDB();
  db.store['stock'].push(
    { numero_tc: 'MSKU1000001', taille: "40'", statut: 'En stock' },
    { numero_tc: 'MSKU1000002', taille: "40'", statut: 'En stock' },
  );
  const cfs = ctxAvec(db);
  const base = { declarant: 'A', contactDeclarant: '901234', destinationMarchandise: 'D', bureauDeclaration: 'TG120', descriptionMarchandise: 'X', anneeDeclaration: '2026' };

  // (a) un ENLÈVEMENT dont la DÉCLARATION est de type C → doit compter en conso.
  const e1 = (await ecr.createcamion(cfs, { numeroCamion: 'CONSO-ENL/RM01', routage: 'Enlèvement' })) as { id: string };
  await ecr.cfs(cfs, { id: e1.id, conteneur: { num: 'MSKU1000001', taille: "40'", type: 'DRY', plomb: 'S1' },
    declaration: { ...base, typeDeclaration: 'C', numeroDeclaration: '100' }, consoMode: 'balise' });

  // (b) un enlèvement de type T (transit) → NE compte PAS en conso.
  const e2 = (await ecr.createcamion(cfs, { numeroCamion: 'TRANSIT/RM01', routage: 'Enlèvement' })) as { id: string };
  await ecr.cfs(cfs, { id: e2.id, conteneur: { num: 'MSKU1000002', taille: "40'", type: 'DRY', plomb: 'S2' },
    declaration: { ...base, typeDeclaration: 'T', numeroDeclaration: '101' } });

  const f = (await rap.ficheBord(cfs, {})) as { cfs: { camionsConso: number } };
  assert.equal(f.cfs.camionsConso, 1); // seul l'enlèvement type C
});

test('fiche : la « Sortie conso » compte les sorties de type C', async () => {
  const db = new FakeDB();
  db.store['stock'].push({ numero_tc: 'MSKU1000003', taille: "40'", statut: 'En stock' });
  const cfs = ctxAvec(db);
  const base = { declarant: 'A', contactDeclarant: '901234', destinationMarchandise: 'D', bureauDeclaration: 'TG120', descriptionMarchandise: 'X', anneeDeclaration: '2026' };
  const e = (await ecr.createcamion(cfs, { numeroCamion: 'CONSO-OUT/RM01', routage: 'Enlèvement' })) as { id: string };
  await ecr.cfs(cfs, { id: e.id, conteneur: { num: 'MSKU1000003', taille: "40'", type: 'DRY', plomb: 'S1' },
    declaration: { ...base, typeDeclaration: 'C', numeroDeclaration: '102' }, consoMode: 'sansbalise' });
  // type C non balisé → saute T1 et Balise ; on émet le bon de sortie puis on sort.
  await ecr.bonsortie(ctxRole(db, 'BON_SORTIE', 'BS'), { id: e.id, bonSortieNumero: [{ conteneur: 'MSKU1000003', t1: '', numero: 'BS-1' }] });
  await ecr.sortie(ctxRole(db, 'PP', 'PP'), { id: e.id, ckCfs: true, ckT1: true, ckBalise: true, ckBs: true });
  const f = (await rap.ficheBord(cfs, {})) as { pp: { conso: number; total: number } };
  assert.equal(f.pp.conso, 1);
  assert.equal(f.pp.total, 1);
});

/* ---- v4.1 : « Camions au parking » = en attente de balise SEULEMENT ------- */

test('fiche : le parking ne compte QUE les camions en attente de balise', async () => {
  const db = new FakeDB();
  const cfs = ctxAvec(db);
  db.store['stock'].push(
    { numero_tc: 'MSKU2000001', taille: "40'", statut: 'En stock' },
    { numero_tc: 'MSKU2000002', taille: "40'", statut: 'En stock' },
  );
  const base = { declarant: 'A', contactDeclarant: '901234', destinationMarchandise: 'D', bureauDeclaration: 'TG120', descriptionMarchandise: 'X', anneeDeclaration: '2026' };

  // (a) enlèvement transit balise requise, PAS encore balisé → compte.
  const a = (await ecr.createcamion(cfs, { numeroCamion: 'PK-WAIT/RM01', routage: 'Enlèvement' })) as { id: string };
  await ecr.cfs(cfs, { id: a.id, conteneur: { num: 'MSKU2000001', taille: "40'", type: 'DRY', plomb: 'S1' },
    declaration: { ...base, typeDeclaration: 'T', numeroDeclaration: '200' } });

  // (b) camion encore EN CHARGEMENT au CFS (dépotage non finalisé) → ne compte PAS.
  db.store['stock'].push({ numero_tc: 'TCLU2000003', taille: "40'", statut: 'Positionné' });
  const b = (await ecr.createcamion(cfs, { numeroCamion: 'PK-LOAD/RM01', routage: 'Dépotage' })) as { id: string };
  await ecr.cfs(cfs, { id: b.id, conteneur: { num: 'TCLU2000003', taille: "40'", type: 'DRY' },
    declaration: { ...base, typeDeclaration: 'T', numeroDeclaration: '201' } });

  // (c) conso NON balisée (dispense) → jamais de balise → ne compte PAS.
  const cc = (await ecr.createcamion(cfs, { numeroCamion: 'PK-DISP/RM01', routage: 'Enlèvement' })) as { id: string };
  await ecr.cfs(cfs, { id: cc.id, conteneur: { num: 'MSKU2000002', taille: "40'", type: 'DRY', plomb: 'S2' },
    declaration: { ...base, typeDeclaration: 'C', numeroDeclaration: '202' }, consoMode: 'sansbalise' });

  // (d) véhicule → saute la balise → ne compte PAS.
  await spe.create(cfs, { typeOperation: 'Dépotage / Véhicule', conteneurOrigine: 'MSKU2000009',
    declaration: { ...base, typeDeclaration: 'T', numeroDeclaration: '203' },
    vehicules: [{ chassis: 'VIN123', marque: 'X', modele: 'Y', couleur: 'Z', destination: 'Transit' }] });

  const f = (await rap.ficheBord(cfs, {})) as { balise: { parking: number } };
  assert.equal(f.balise.parking, 1); // seul (a)
});

/* ---- v4.1 : rapport « répartition par destination » + totaux flux ------- */

/** Crée un enlèvement puis le fait sortir, avec une destination donnée. */
async function enlevementSorti(db: FakeDB, plaque: string, tc: string, dest: string, num: string) {
  db.store['stock'].push({ numero_tc: tc, taille: "40'", statut: 'En stock' });
  const cfs = ctxAvec(db);
  const { id } = (await ecr.createcamion(cfs, { numeroCamion: plaque, routage: 'Enlèvement' })) as { id: string };
  await ecr.cfs(cfs, { id, conteneur: { num: tc, taille: "40'", type: 'DRY', plomb: 'S1' },
    declaration: { declarant: 'A', contactDeclarant: '901234', destinationMarchandise: dest, bureauDeclaration: 'TG120', typeDeclaration: 'T', numeroDeclaration: num, anneeDeclaration: '2026', descriptionMarchandise: 'X' } });
  await ecr.valider(ctxRole(db, 'CHEF_BRIGADE', 'CB'), { id, enSurcharge: false, suiviEngagement: false });
  await ecr.t1(ctxRole(db, 'T1', 'T1'), { id, bureauDestination: 'BF', t1Numeros: [{ conteneur: tc, numero: 'T1-' + num }] });
  await ecr.gps(ctxRole(db, 'BALISE', 'B'), { id, baliseRequise: 'Oui', t1Correct: 'Oui', numeroGPS: 'G-' + num });
  await ecr.bonsortie(ctxRole(db, 'BON_SORTIE', 'BS'), { id, bonSortieNumero: [{ conteneur: tc, t1: 'T1-' + num, numero: 'BS-' + num }] });
  await ecr.sortie(ctxRole(db, 'PP', 'PP'), { id, ckCfs: true, ckT1: true, ckBalise: true, ckBs: true });
  return id;
}

test('rapport destinations : compte les camions SORTIS par destination', async () => {
  const db = new FakeDB();
  await enlevementSorti(db, 'D-BF1/RM01', 'MSKU3000001', 'BF', '300');
  await enlevementSorti(db, 'D-BF2/RM01', 'MSKU3000002', 'BF', '301');
  await enlevementSorti(db, 'D-NE1/RM01', 'MSKU3000003', 'NE', '302');
  const r = (await rap.rapportDestinations(ctxAvec(db), { granularite: 'mois' })) as
    { total: number; parDest: Record<string, number>; series: Record<string, unknown>[] };
  assert.equal(r.total, 3);
  assert.equal(r.parDest['BF'], 2);
  assert.equal(r.parDest['NE'], 1);
  assert.equal(r.parDest['TG'], 0);
  assert.ok(r.series.length >= 1); // au moins un bucket de période
});

test('analyse des flux : les totaux agrègent enlevés / balisés / sortis', async () => {
  const db = new FakeDB();
  await enlevementSorti(db, 'F1/RM01', 'MSKU4000001', 'BF', '400');
  await enlevementSorti(db, 'F2/RM01', 'MSKU4000002', 'NE', '401');
  const r = (await rap.rapportFlux(ctxAvec(db), { granularite: 'mois' })) as
    { totaux: { enlevesC: number; tc: number; baliseC: number; ppC: number } };
  assert.equal(r.totaux.enlevesC, 2);
  assert.equal(r.totaux.tc, 2);
  assert.equal(r.totaux.baliseC, 2);
  assert.equal(r.totaux.ppC, 2);
});

/* ---- v4.1 : rapport de cellule = TOUTE la cellule, pas seulement soi ------ */

test('rapport CFS : un agent voit l\'activité de TOUS les agents CFS', async () => {
  const db = new FakeDB();
  db.store['stock'].push(
    { numero_tc: 'MSKU3000001', taille: "40'", statut: 'En stock' },
    { numero_tc: 'MSKU3000002', taille: "40'", statut: 'En stock' },
  );
  // Deux enlèvements saisis par DEUX agents CFS différents.
  const a = ctxRole(db, 'CFS', 'Agent A');
  const ida = (await ecr.createcamion(a, { numeroCamion: 'RA/RM01', routage: 'Enlèvement' })) as { id: string };
  await ecr.cfs(a, { id: ida.id, conteneur: { num: 'MSKU3000001', taille: "40'", type: 'DRY', plomb: 'S1' }, declaration: DECL_OK });
  const b = ctxRole(db, 'CFS', 'Agent B');
  const idb = (await ecr.createcamion(b, { numeroCamion: 'RB/RM01', routage: 'Enlèvement' })) as { id: string };
  await ecr.cfs(b, { id: idb.id, conteneur: { num: 'MSKU3000002', taille: "40'", type: 'DRY', plomb: 'S2' }, declaration: DECL_OK });

  // Agent A ouvre le rapport CFS SANS filtre : il voit les DEUX camions.
  const r = (await rap.rapportCFS(a, {})) as { total: { camions: number } };
  assert.equal(r.total.camions, 2);
});

/* ---- v4.1 : pesée obligatoire avant la validation chef ------------------ */

async function camionAValider(db: FakeDB, plaque = 'PES001/RM01') {
  db.store['stock'].push({ numero_tc: 'MSKU7777777', taille: "40'", statut: 'En stock' });
  const cfs = ctxAvec(db);
  const { id } = (await ecr.createcamion(cfs, { numeroCamion: plaque, routage: 'Enlèvement' })) as { id: string };
  await ecr.cfs(cfs, { id, conteneur: { num: 'MSKU7777777', taille: "40'", type: 'DRY', plomb: 'S1' }, declaration: DECL_OK });
  return id;
}

// v4.3 — DÉPOTAGE prêt à valider : la pesée (surcharge) ne concerne QUE le
// dépotage (2026-08-19), donc les tests de pesée doivent partir d'un dépotage.
async function depotageAValider(db: FakeDB, plaque = 'DEP001/RM01', tc = 'MSKU8888888') {
  db.store['stock'].push({ numero_tc: tc, taille: "40'", statut: 'Positionné' });
  const cfs = ctxAvec(db);
  const { id } = (await ecr.createcamion(cfs, { numeroCamion: plaque, routage: 'Dépotage' })) as { id: string };
  await ecr.cfs(cfs, { id, conteneur: { num: tc, taille: "40'", type: 'DRY' }, declaration: DECL_OK });
  await ecr.declaration(cfs, { id, hauteurChargement: '3', nbColis: '10', scellesCamion: ['S1', 'S2'] });
  return id;
}

test('validation refusée sans pesée renseignée (dépotage)', async () => {
  const db = new FakeDB();
  const id = await depotageAValider(db);
  await assert.rejects(() => ecr.valider(ctxRole(db, 'CHEF_BRIGADE', 'CB'), { id }), /Renseignez la pesée/);
});

/** Date ISO à N jours d'aujourd'hui — les délais d'engagement doivent être à venir. */
const dansNJours = (n: number) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

test('00180 — suivi des engagements : OUI exige de préciser, puis enregistre', async () => {
  const db = new FakeDB();
  const id = await depotageAValider(db, 'ENG001/RM01', 'MSKU9999001');
  const chef = ctxRole(db, 'CHEF_BRIGADE', 'CB');
  // OUI sans précision : refusé.
  await assert.rejects(
    () => ecr.valider(chef, { id, enSurcharge: false, suiviEngagement: true }),
    /précisez l'engagement/i,
  );
  // Type fourni mais SANS délai : refusé aussi — le délai est obligatoire.
  await assert.rejects(
    () => ecr.valider(chef, { id, enSurcharge: false, suiviEngagement: true, engagementType: 'Transit côtier' }),
    /indiquez le délai/i,
  );
  // Délai DÉJÀ PASSÉ : refusé — ce serait en retard dès la signature.
  await assert.rejects(
    () => ecr.valider(chef, {
      id, enSurcharge: false, suiviEngagement: true,
      engagementType: 'Transit côtier', engagementDelai: dansNJours(-2),
    }),
    /déjà passé/i,
  );
  await ecr.valider(chef, {
    id, enSurcharge: false, suiviEngagement: true,
    engagementType: 'Transit côtier', engagementDelai: dansNJours(5),
  });
  const c = versCamel(db.store['cargaisons'][0]!);
  assert.equal(c['suiviEngagement'], true);
  assert.equal(c['engagementType'], 'Transit côtier');
  assert.equal(c['engagementDelai'], dansNJours(5));
  assert.equal(c['engagementEffectueLe'], undefined); // encore dû
});

test('00180 — échéancier : ne remonte qu\'à partir de J-1, et disparaît une fois soldé', async () => {
  const db = new FakeDB();
  const chef = ctxRole(db, 'CHEF_BRIGADE', 'CB');

  const loin = await depotageAValider(db, 'ENG010/RM01', 'MSKU9999010');
  await ecr.valider(chef, { id: loin, enSurcharge: false, suiviEngagement: true,
    engagementType: 'Transit national', engagementDelai: dansNJours(10) });

  const demain = await depotageAValider(db, 'ENG011/RM01', 'MSKU9999011');
  await ecr.valider(chef, { id: demain, enSurcharge: false, suiviEngagement: true,
    engagementType: 'BFE 03 Sinkase', engagementDelai: dansNJours(1) });

  // Seule l'échéance de demain doit remonter ; celle à 10 jours est encore muette.
  const av = (await lec.engagementsDus(chef)) as { lignes: Record<string, unknown>[]; compte: Record<string, number> };
  assert.equal(av.lignes.length, 1);
  assert.equal(av.lignes[0]!['id'], demain);
  assert.equal(av.compte['demain'], 1);

  // Une fois soldée, elle sort de l'échéancier.
  await ecr.engagementFait(chef, { id: demain });
  const ap = (await lec.engagementsDus(chef)) as { lignes: unknown[] };
  assert.equal(ap.lignes.length, 0);

  // Et on ne solde pas deux fois.
  await assert.rejects(() => ecr.engagementFait(chef, { id: demain }), /déjà soldé/i);
});

test('00180 — solder refusé sur une cargaison sans suivi d\'engagement', async () => {
  const db = new FakeDB();
  const id = await depotageAValider(db, 'ENG012/RM01', 'MSKU9999012');
  const chef = ctxRole(db, 'CHEF_BRIGADE', 'CB');
  await ecr.valider(chef, { id, enSurcharge: false, suiviEngagement: false });
  await assert.rejects(() => ecr.engagementFait(chef, { id }), /pas sous suivi d'engagement/i);
});

/* 2026-09-12 — CE TEST DISAIT L'INVERSE, et il avait tort.
 *
 * La garde exigeait `suiviEngagement` côté serveur. Déployée avant l'écran qui
 * sait l'envoyer, elle a bloqué TOUTE signature en production : le front alors
 * en ligne ignorait ce champ. Un serveur ne peut pas exiger ce qu'un client
 * déjà déployé n'a aucun moyen de fournir — entre deux déploiements, les deux
 * versions coexistent toujours.
 *
 * L'exigence n'est pas abandonnée : elle vit dans l'écran, dont le bouton de
 * signature reste inerte tant qu'on n'a pas répondu. Le serveur, lui, tolère
 * l'absence et vérifie intégralement ce qui lui est fourni — c'est l'objet des
 * deux tests suivants. */
test('00180 — engagement ABSENT : la validation passe, sans rien enregistrer', async () => {
  const db = new FakeDB();
  const id = await depotageAValider(db, 'ENG002/RM01', 'MSKU9999002');
  await ecr.valider(ctxRole(db, 'CHEF_BRIGADE', 'CB'), { id, enSurcharge: false });
  const c = db.store['cargaisons'].find((x) => x['id'] === id)!;
  assert.ok(c['date_validation'], 'la signature doit aboutir');
  assert.equal(c['suivi_engagement'] ?? null, null,
    'rien ne doit être inventé : le champ reste vide, pas « non »');
});

test('00180 — engagement FOURNI mais incomplet : toujours refusé', async () => {
  const db = new FakeDB();
  const id = await depotageAValider(db, 'ENG004/RM01', 'MSKU9999004');
  // OUI sans type : la vérification complète s'applique dès qu'on répond.
  await assert.rejects(
    () => ecr.valider(ctxRole(db, 'CHEF_BRIGADE', 'CB'),
      { id, enSurcharge: false, suiviEngagement: true }),
    /précisez l'engagement/i,
  );
});

test('00180 — suivi des engagements : NON laisse le type vide, même si un type est envoyé', async () => {
  const db = new FakeDB();
  const id = await depotageAValider(db, 'ENG003/RM01', 'MSKU9999003');
  await ecr.valider(ctxRole(db, 'CHEF_BRIGADE', 'CB'),
    { id, enSurcharge: false, suiviEngagement: false, engagementType: 'Transit national' });
  const c = versCamel(db.store['cargaisons'][0]!);
  assert.equal(c['suiviEngagement'], false);
  // Le type ne doit PAS être conservé quand la réponse est NON : sinon la fiche
  // afficherait un engagement sur une cargaison déclarée sans suivi.
  assert.equal(c['engagementType'], '');
});

test('00180 — suivi des engagements : saisie libre hors liste acceptée', async () => {
  const db = new FakeDB();
  const id = await depotageAValider(db, 'ENG004/RM01', 'MSKU9999004');
  await ecr.valider(ctxRole(db, 'CHEF_BRIGADE', 'CB'),
    { id, enSurcharge: false, suiviEngagement: true, engagementType: 'RÉGIME EXCEPTIONNEL 2026', engagementDelai: dansNJours(4) });
  const c = versCamel(db.store['cargaisons'][0]!);
  assert.equal(c['engagementType'], 'RÉGIME EXCEPTIONNEL 2026');
});

test('pesée EN SURCHARGE : le poids est obligatoire puis enregistré (dépotage)', async () => {
  const db = new FakeDB();
  const id = await depotageAValider(db, 'PES002/RM01', 'MSKU8888802');
  await assert.rejects(() => ecr.valider(ctxRole(db, 'CHEF_BRIGADE', 'CB'), { id, enSurcharge: true }), /poids en surcharge/);
  await ecr.valider(ctxRole(db, 'CHEF_BRIGADE', 'CB'), { id, enSurcharge: true, poidsSurcharge: '1200', suiviEngagement: false });
  const c = versCamel(db.store['cargaisons'][0]!);
  assert.equal(c['enSurcharge'], true);
  assert.equal(c['poidsSurcharge'], '1200');
  assert.ok(c['dateValidation']);
});

test('pesée HORS SURCHARGE : validé sans poids, poids resté vide (dépotage)', async () => {
  const db = new FakeDB();
  const id = await depotageAValider(db, 'PES003/RM01', 'MSKU8888803');
  await ecr.valider(ctxRole(db, 'CHEF_BRIGADE', 'CB'), { id, enSurcharge: false, suiviEngagement: false });
  const c = versCamel(db.store['cargaisons'][0]!);
  assert.equal(c['enSurcharge'], false);
  assert.equal(c['poidsSurcharge'], '');
});

test('ENLÈVEMENT : validé SANS pesée (hors gabarit/surcharge = dépotage only, 2026-08-19)', async () => {
  const db = new FakeDB();
  const id = await camionAValider(db, 'ENL001/RM01'); // enlèvement
  // Aucune pesée fournie : la validation passe quand même, hors surcharge.
  await ecr.valider(ctxRole(db, 'CHEF_BRIGADE', 'CB'), { id, suiviEngagement: false });
  const c = versCamel(db.store['cargaisons'][0]!);
  assert.ok(c['dateValidation']);
  assert.equal(c['enSurcharge'], false);
  assert.equal(c['poidsSurcharge'], '');
});

test('horodatage : plage d\'activité par cellule/agent (2026-08-19)', async () => {
  const db = new FakeDB();
  const cfs = ctxAvec(db); // agent « Agent CFS Un »
  db.store['stock'].push({ numero_tc: 'MSKU5000001', taille: "40'", statut: 'En stock' });
  const a = (await ecr.createcamion(cfs, { numeroCamion: 'HORO1/RM01', routage: 'Enlèvement' })) as { id: string };
  await ecr.cfs(cfs, { id: a.id, conteneur: { num: 'MSKU5000001', taille: "40'", type: 'DRY', plomb: 'S1' }, declaration: DECL_OK });
  const r = (await rap.rapportHorodatage(cfs, {})) as { rows: { cellule: string; agent: string; camions: number; debut: string; fin: string }[] };
  const cfsRow = r.rows.find((x) => x.cellule === 'CFS');
  assert.ok(cfsRow, 'une ligne d\'activité CFS est attendue');
  assert.equal(cfsRow!.agent, 'Agent CFS Un');
  assert.ok(cfsRow!.camions >= 1);
  assert.match(cfsRow!.debut, /^\d\d:\d\d$/); // heure « HH:MM »
});

test('archivage goulots : analyse, archive (réversible) sort des rapports (2026-08-19)', async () => {
  const db = new FakeDB();
  const cfs = ctxAvec(db);
  const admin = ctxRole(db, 'ADMIN', 'Admin');
  const a = (await ecr.createcamion(cfs, { numeroCamion: 'GOULOT1/RM01', routage: 'Dépotage' })) as { id: string };
  // Reste au statut « Camion créé » = goulot. L'analyse le voit (seuil 0 j).
  let g = (await rap.rapportGoulots(cfs, { joursMin: 0 })) as { total: number; rows: O[] };
  assert.ok(g.rows.some((r) => r['id'] === a.id), 'le goulot doit apparaître dans l\'analyse');
  // Archivage (ADMIN) — motif obligatoire.
  await assert.rejects(() => ecr.archiverGoulots(admin, { ids: [a.id], motif: '' }), /motif/i);
  const r = (await ecr.archiverGoulots(admin, { ids: [a.id], motif: 'vieux dossier migré' })) as { compte: O };
  assert.equal(Number(r.compte['archives']), 1);
  assert.equal(db.store['cargaisons'].find((c) => c['id'] === a.id)!['archive'], true);
  // Exclu des rapports/files ; listé dans les archives.
  g = (await rap.rapportGoulots(cfs, { joursMin: 0 })) as { total: number; rows: O[] };
  assert.equal(g.rows.find((x) => x['id'] === a.id), undefined);
  const arch = (await rap.rapportArchives(cfs, {})) as { rows: O[] };
  assert.ok(arch.rows.some((x) => x['id'] === a.id));
  // Réversible.
  await ecr.desarchiverGoulots(admin, { ids: [a.id] });
  assert.equal(db.store['cargaisons'].find((c) => c['id'] === a.id)!['archive'], false);
});

test('rapport de cellule T1 : compte les T1 saisis, datés au T1 (2026-08-19)', async () => {
  const db = new FakeDB();
  const cfs = ctxAvec(db);
  db.store['stock'].push({ numero_tc: 'MSKU7000001', taille: "40'", statut: 'En stock' });
  const a = (await ecr.createcamion(cfs, { numeroCamion: 'T1REP/RM01', routage: 'Enlèvement' })) as { id: string };
  await ecr.cfs(cfs, { id: a.id, conteneur: { num: 'MSKU7000001', taille: "40'", type: 'DRY', plomb: 'S1' }, declaration: DECL_OK });
  await ecr.valider(ctxRole(db, 'CHEF_BRIGADE', 'CB'), { id: a.id, suiviEngagement: false }); // enlèvement : sans pesée
  await ecr.t1(ctxRole(db, 'T1', 'Agent T1'), { id: a.id, bureauDestination: 'TG120', t1Numeros: [{ conteneur: 'MSKU7000001', numero: 'T1-X' }] });
  const r = (await rap.rapportActivite(cfs, { kind: 't1' })) as { total: { camions: number } };
  assert.ok(r.total.camions >= 1, 'le T1 saisi doit être compté dans le rapport de la cellule T1');
});

/* ---- v4.1 : entrepôts MAD & industriel (entrées / sorties / stats) ------- */
import * as entrepot from './entrepots.ts';

function chef(db: FakeDB) { return ctxRole(db, 'CHEF_BRIGADE', 'Chef'); }

test('MAD : entrée à articles, sortie apure les colis, restant cohérent', async () => {
  const db = new FakeDB();
  const cfs = ctxAvec(db);
  await entrepot.entrepotCreate(chef(db), { code: 'MAD-01', nom: 'MAGASIN CENTRAL', type: 'MAD' });
  // Entrée : une déclaration, 2 articles (100 + 50 colis).
  const e = (await entrepot.entrepotEntree(cfs, {
    entrepotCode: 'MAD-01',
    declaration: { numeroDeclaration: '500', anneeDeclaration: '2026', bureauDeclaration: 'TG120', typeDeclaration: 'C', declarant: 'ACME' },
    articles: [{ designation: 'RIZ', nbColis: '100' }, { designation: 'SUCRE', nbColis: '50' }],
  })) as { id: string };

  // Restant initial de l'article 1 = 100.
  const av = (await entrepot.entrepotEntrees(cfs, { entrepotCode: 'MAD-01' })) as { unite: string; rows: Record<string, unknown>[] };
  assert.equal(av.unite, 'colis');
  assert.equal((av.rows[0]!['articles'] as Record<string, unknown>[])[0]!['restant'], 100);

  // Sortie : apure 30 colis de l'article 1, déclaration d'apurement différente.
  const s = (await entrepot.entrepotSortie(cfs, {
    entreeId: e.id, numeroArticle: 1, nbColis: '30',
    declarationApurement: { numeroDeclaration: '999', anneeDeclaration: '2026', bureauDeclaration: 'TG120', typeDeclaration: 'C' },
    vehicules: [{ chassis: 'VIN1', marque: 'X' }],
  })) as { restantApres: number };
  assert.equal(s.restantApres, 70);

  // On n'apure jamais plus que le restant.
  await assert.rejects(() => entrepot.entrepotSortie(cfs, { entreeId: e.id, numeroArticle: 1, nbColis: '80' }), /supérieur au restant/);

  // Stats : entrées 150, sorties 30, restant 120 sur cette déclaration.
  const st = (await entrepot.entrepotStats(cfs, { type: 'MAD' })) as { parDeclaration: Record<string, unknown>[]; entrepots: Record<string, unknown>[] };
  const g = st.parDeclaration.find((x) => String(x['libelle']).includes('500'))!;
  assert.equal(g['entrees'], 150);
  assert.equal(g['sorties'], 30);
  assert.equal(g['restant'], 120);
  assert.equal(st.entrepots[0]!['restant'], 120);
});

test('MAD sortie : crée le camion dans le parcours selon le régime (2026-08-19)', async () => {
  const db = new FakeDB();
  const cfs = ctxAvec(db);
  await entrepot.entrepotCreate(chef(db), { code: 'MAD-02', nom: 'MAGASIN 2', type: 'MAD' });
  const e = (await entrepot.entrepotEntree(cfs, {
    entrepotCode: 'MAD-02',
    declaration: { numeroDeclaration: '600', anneeDeclaration: '2026', bureauDeclaration: 'TG120', typeDeclaration: 'C', declarant: 'ACME' },
    articles: [{ designation: 'RIZ', nbColis: '100' }],
  })) as { id: string };

  // Sortie en TRANSIT (T) avec un camion : la cargaison créée doit prendre le
  // T1 et la balise, mais attendre d'abord la validation du chef de brigade.
  const st = (await entrepot.entrepotSortie(cfs, {
    entreeId: e.id, numeroArticle: 1, nbColis: '10',
    declarationApurement: { numeroDeclaration: '900', anneeDeclaration: '2026', bureauDeclaration: 'TG120', typeDeclaration: 'T' },
    numeroCamion: 'MADT001/RM01', scelles: ['P1', 'P2'],
  })) as { cargaisonId: string };
  assert.ok(st.cargaisonId, 'une cargaison doit être créée pour le camion');
  const cargoT = versCamel(db.store['cargaisons'].find((c) => c['id'] === st.cargaisonId)!);
  assert.equal(cargoT['statut'], STATUTS.CREEE);          // attend la validation
  assert.equal(cargoT['typeOperation'], 'Sortie Magasin / MAD');
  assert.equal(cargoT['sauteT1'], false);                 // transit → prend le T1
  assert.equal(cargoT['sauteBalise'], false);             // transit → prend la balise
  // File d'attente unique : d'abord la VALIDATION.
  assert.equal(fileAttente(cargoT as never), 'VALIDATION');
  // Concordance : ce camion n'est PAS compté comme une entrée CFS.
  const rc = (await rap.rapportCFS(cfs, {})) as { total: { camions: number } };
  assert.equal(rc.total.camions, 0);

  // Sortie en CONSO (C) sans balise : la cargaison saute T1 ET balise.
  const sc = (await entrepot.entrepotSortie(cfs, {
    entreeId: e.id, numeroArticle: 1, nbColis: '10',
    declarationApurement: { numeroDeclaration: '901', anneeDeclaration: '2026', bureauDeclaration: 'TG120', typeDeclaration: 'C' },
    numeroCamion: 'MADC001/RM01', scelles: ['P3'], baliseRequise: false,
  })) as { cargaisonId: string };
  const cargoC = versCamel(db.store['cargaisons'].find((c) => c['id'] === sc.cargaisonId)!);
  assert.equal(cargoC['sauteT1'], true);
  assert.equal(cargoC['sauteBalise'], true);
  assert.equal(fileAttente(cargoC as never), 'VALIDATION'); // validation TOUJOURS requise
});

test('Entrepôt industriel : apurement au POIDS (kg)', async () => {
  const db = new FakeDB();
  const cfs = ctxAvec(db);
  await entrepot.entrepotCreate(ctxRole(db, 'ADMIN', 'Adm'), { code: 'IND-01', nom: 'ENTREPOT NORD', type: 'INDUSTRIEL' });
  const e = (await entrepot.entrepotEntree(cfs, {
    entrepotCode: 'IND-01',
    declaration: { numeroDeclaration: '700', anneeDeclaration: '2026', bureauDeclaration: 'TG120', typeDeclaration: 'E', declarant: 'B' },
    articles: [{ designation: 'CIMENT', nbColis: '10', poids: '5000' }],
  })) as { id: string };
  const av = (await entrepot.entrepotEntrees(cfs, { entrepotCode: 'IND-01' })) as { unite: string; rows: Record<string, unknown>[] };
  assert.equal(av.unite, 'poids');
  assert.equal((av.rows[0]!['articles'] as Record<string, unknown>[])[0]!['restant'], 5000);
  const s = (await entrepot.entrepotSortie(cfs, { entreeId: e.id, numeroArticle: 1, poids: '1500' })) as { restantApres: number };
  assert.equal(s.restantApres, 3500);
  const st = (await entrepot.entrepotStats(cfs, { type: 'INDUSTRIEL' })) as { unite: string; entrepots: Record<string, unknown>[] };
  assert.equal(st.unite, 'poids');
  assert.equal(st.entrepots[0]!['entrees'], 5000);
  assert.equal(st.entrepots[0]!['sorties'], 1500);
  assert.equal(st.entrepots[0]!['restant'], 3500);
});

test('entrepôt : au plus 11 articles ; code unique', async () => {
  const db = new FakeDB();
  await entrepot.entrepotCreate(chef(db), { code: 'MAD-9', nom: 'X', type: 'MAD' });
  await assert.rejects(() => entrepot.entrepotCreate(chef(db), { code: 'MAD-9', nom: 'Y', type: 'MAD' }), /déjà le code/);
  const arts = Array.from({ length: 12 }, (_, i) => ({ designation: 'A' + i, nbColis: '1' }));
  await assert.rejects(() => entrepot.entrepotEntree(ctxAvec(db), {
    entrepotCode: 'MAD-9', declaration: { numeroDeclaration: '1' }, articles: arts,
  }), /11 articles/);
});

/* ---- v4.1 (2026-07-30) : total PP, conteneur partagé, détail apurements ---- */

function cargoSortie(over: Record<string, unknown>) {
  const now = new Date().toISOString();
  return {
    reference: over['id'], numero_camion: over['id'], statut: 'Sortie Enregistrée',
    date_creation: now, date_sortie: now, rapport_id: 'R',
    conteneurs_details: { conteneurs: [], scellesCamion: [] }, nb_conteneurs: 0, ...over,
  };
}

test('fiche PP : total = enl+dép+MAD+conso, véhicules à nu EXCLUS, conso exclusive', async () => {
  const db = new FakeDB();
  const cfs = ctxRole(db, 'CFS', 'A');
  db.store['cargaisons'].push(
    cargoSortie({ id: 'E1', type_operation: 'Enlèvement', type_declaration: 'T' }),
    cargoSortie({ id: 'D1', type_operation: 'Dépotage', type_declaration: 'T' }),
    cargoSortie({ id: 'C1', type_operation: 'Enlèvement', type_declaration: 'C' }), // conso (type C)
    cargoSortie({ id: 'V1', type_operation: 'Dépotage / Véhicule', est_vehicule: true, type_declaration: 'T' }),
  );
  const f = (await rap.ficheBord(cfs, {})) as { pp: { total: number; enlevement: number; depotage: number; conso: number; vehicules: number } };
  assert.equal(f.pp.enlevement, 1); // E1 seulement (le type C ne compte PAS ici)
  assert.equal(f.pp.depotage, 1);
  assert.equal(f.pp.conso, 1);      // C1
  assert.equal(f.pp.vehicules, 1);  // V1, hors total
  assert.equal(f.pp.total, 3);      // enl+dép+MAD+conso, sans le véhicule
});

test('fiche CFS : un conteneur partagé sur 2 camions compté une seule fois', async () => {
  const db = new FakeDB();
  const cfs = ctxRole(db, 'CFS', 'A');
  const now = new Date().toISOString();
  const dets = { conteneurs: [{ num: 'MSKU1234567', taille: "40'", plomb: 'S', type: 'DRY' }], scellesCamion: [] };
  const camion = (id: string) => ({
    id, reference: id, numero_camion: id, statut: 'Créée', date_creation: now, rapport_id: 'R',
    type_operation: 'Enlèvement', type_declaration: 'T', conteneurs_details: dets, nb_conteneurs: 1,
  });
  db.store['cargaisons'].push(camion('A'), camion('B')); // MÊME conteneur sur 2 camions (saisie manuelle)
  const f = (await rap.ficheBord(cfs, {})) as { cfs: { camionsCfs: number; total: { conteneurs: number } } };
  assert.equal(f.cfs.camionsCfs, 2);       // 2 camions bien comptés
  assert.equal(f.cfs.total.conteneurs, 1); // mais 1 seul conteneur (partagé)
});

test('rapport cellule (balise) : conteneur partagé sur 2 camions compté une seule fois', async () => {
  const db = new FakeDB();
  const cfs = ctxRole(db, 'CFS', 'A');
  const now = new Date().toISOString();
  // Un même 40′ éclaté sur deux camions (le 2ᵉ pris en saisie manuelle). Les deux
  // camions sont balisés → deux passages Balise, mais UN SEUL conteneur physique.
  const dets = { conteneurs: [{ num: 'TCLU7654321', taille: "40'", plomb: 'S', type: 'DRY' }], scellesCamion: [] };
  const camion = (id: string) => ({
    id, reference: id, numero_camion: id, statut: 'Balise posée', date_creation: now, rapport_id: 'R',
    type_operation: 'Dépotage', type_declaration: 'T', conteneurs_details: dets, nb_conteneurs: 1,
    date_pose_gps: now, agent_balise: 'Agent Balise', numero_gps: 'G-' + id,
  });
  db.store['cargaisons'].push(camion('A'), camion('B'));
  const r = (await rap.rapportActivite(cfs, { kind: 'balise' })) as
    { total: { camions: number; conteneurs: number; t40: number; evp: number } };
  assert.equal(r.total.camions, 2);      // 2 camions balisés bien comptés
  assert.equal(r.total.conteneurs, 1);   // mais 1 seul conteneur (partagé)
  assert.equal(r.total.t40, 1);          // un seul 40′
  assert.equal(r.total.evp, 2);          // = 2 EVP, compté une fois
});

test('analyse des flux : conteneur partagé sur 2 camions compté une fois par période', async () => {
  const db = new FakeDB();
  const cfs = ctxRole(db, 'CFS', 'A');
  const jour = '2026-09-10T08:00:00Z'; // même mois → même période
  const dets = { conteneurs: [{ num: 'HLXU9990001', taille: "40'", plomb: '', type: 'DRY' }], scellesCamion: [] };
  const camion = (id: string) => ({
    id, reference: id, numero_camion: id, statut: 'Créée', date_creation: jour, rapport_id: 'R',
    type_operation: 'Dépotage', type_declaration: 'T', conteneurs_details: dets, nb_conteneurs: 1,
  });
  db.store['cargaisons'].push(camion('A'), camion('B'));
  const r = (await rap.rapportFlux(cfs, { granularite: 'mois' })) as { totaux: { depotesC: number; tc: number; evp: number } };
  assert.equal(r.totaux.tc, 1);        // 1 seul TC sur la période
  assert.equal(r.totaux.depotesC, 1);  // pas 2
  assert.equal(r.totaux.evp, 2);       // 1 × 40′ = 2 EVP
});

test('entrepot.sorties : détail des apurements d\'un article avec la déclaration', async () => {
  const db = new FakeDB();
  const cfs = ctxRole(db, 'CFS', 'A');
  db.store['entrepot_sorties'] = [
    { id: 'SOR-1', entrepot_code: 'MAD-01', entree_id: 'ENT-1', numero_article: 1, numero_declaration: '999', annee_declaration: '2026', bureau_declaration: 'TG120', type_declaration: 'C', designation: 'RIZ', nb_colis: 10, poids: 0, vehicules: [{ chassis: 'VIN1', marque: 'X' }], date_sortie: '2026-07-02T00:00:00Z', agent: 'A' },
    { id: 'SOR-2', entrepot_code: 'MAD-01', entree_id: 'ENT-1', numero_article: 1, numero_declaration: '777', annee_declaration: '2026', bureau_declaration: 'TG120', type_declaration: 'C', designation: 'RIZ', nb_colis: 5, poids: 0, vehicules: [], date_sortie: '2026-07-01T00:00:00Z', agent: 'A' },
    { id: 'SOR-3', entrepot_code: 'MAD-01', entree_id: 'ENT-1', numero_article: 2, numero_declaration: '111', annee_declaration: '2026', bureau_declaration: 'TG120', type_declaration: 'C', designation: 'MIL', nb_colis: 3, poids: 0, vehicules: [], date_sortie: '2026-07-03T00:00:00Z', agent: 'A' },
  ];
  const r = (await entrepot.entrepotSortiesDetail(cfs, { entrepotCode: 'MAD-01', entreeId: 'ENT-1', numeroArticle: 1 })) as { rows: Record<string, unknown>[] };
  assert.equal(r.rows.length, 2);                       // article 1 seulement
  assert.equal(r.rows[0]!['declaration'], '999 · 2026 · TG120 · C'); // trié par date desc
  assert.equal(r.rows[0]!['nbColis'], 10);
});

/* ---- v4.1 (2026-07-31) : pointage journalier + exports ------------------ */

test('pointage journalier : re-pointable un jour suivant, bloqué le jour même', async () => {
  const db = new FakeDB();
  const cfs = ctxRole(db, 'CFS', 'Agent CFS');
  db.store['stock'].push({ numero_tc: 'MSKU1234567', taille: "40'", statut: 'En stock' });

  // 1er pointage : passe En stock → Positionné, date = aujourd'hui.
  await stk.stockPointage(cfs, { numeroTC: 'MSKU1234567' });
  const s1 = db.store['stock'][0]!;
  assert.equal(s1['statut'], 'Positionné');

  // Re-pointer LE MÊME JOUR : refusé.
  await assert.rejects(() => stk.stockPointage(cfs, { numeroTC: 'MSKU1234567' }), /DÉJÀ POINTÉ aujourd'hui/);

  // Simule un reste : la date de pointage passe à HIER.
  const hier = new Date(Date.now() - 86400000).toISOString();
  s1['date_pointage'] = hier; s1['date_positionne'] = hier;

  // Re-pointage le lendemain : accepté, la date repasse à aujourd'hui.
  const r = (await stk.stockPointage(cfs, { numeroTC: 'MSKU1234567' })) as { repointage: boolean };
  assert.equal(r.repointage, true);
  assert.equal(db.store['stock'][0]!['date_pointage']!.toString().slice(0, 10), new Date().toISOString().slice(0, 10));
});

test('stock.list : positionneJour vs restes séparés', async () => {
  const db = new FakeDB();
  const cfs = ctxRole(db, 'CFS', 'Agent CFS');
  const today = new Date().toISOString();
  const hier = new Date(Date.now() - 86400000).toISOString();
  db.store['stock'].push(
    { numero_tc: 'MSKU1111111', taille: "40'", statut: 'Positionné', date_pointage: today },
    { numero_tc: 'MSKU2222222', taille: "40'", statut: 'Positionné', date_pointage: hier },
    { numero_tc: 'MSKU3333333', taille: "40'", statut: 'En stock' },
  );
  const { compte, rows } = (await stk.stockList(cfs, { statut: 'Positionné' })) as { compte: Record<string, number>; rows: Record<string, unknown>[] };
  assert.equal(compte.positionne, 2);
  assert.equal(compte.positionneJour, 1); // MSKU1111111
  assert.equal(compte.restes, 1);         // MSKU2222222
  assert.equal(rows.find((r) => r['numeroTC'] === 'MSKU1111111')!['duJour'], true);
  assert.equal(rows.find((r) => r['numeroTC'] === 'MSKU2222222')!['duJour'], false);
});

test('export cargaisons : filtre par statut + xlsx', async () => {
  const db = new FakeDB();
  const cfs = ctxRole(db, 'CFS', 'Agent CFS');
  const now = new Date().toISOString();
  db.store['cargaisons'].push(
    { id: 'A', reference: 'A', numero_camion: 'A', statut: 'Créée', date_creation: now, type_operation: 'Enlèvement', conteneurs_details: { conteneurs: [], scellesCamion: [] } },
    { id: 'B', reference: 'B', numero_camion: 'B', statut: 'Sortie Enregistrée', date_creation: now, date_sortie: now, type_operation: 'Enlèvement', conteneurs_details: { conteneurs: [], scellesCamion: [] } },
  );
  const view = (await rap.rapportCargaisons(cfs, { statut: 'Créée' })) as { compte: { total: number }; rows: Record<string, unknown>[] };
  assert.equal(view.compte.total, 1);
  assert.equal(view.rows[0]!['id'], 'A');
  // (xlsx = import npm:xlsx, testé côté Deno seulement ; ici on valide le PDF pur JS.)
  const pdf = (await rap.rapportCargaisons(cfs, { format: 'pdf' })) as { html: string };
  assert.match(pdf.html, /<table>/);
});

test('export conteneurs : positionnés + pdf', async () => {
  const db = new FakeDB();
  const cfs = ctxRole(db, 'CFS', 'Agent CFS');
  db.store['stock'].push(
    { numero_tc: 'MSKU1111111', taille: "40'", statut: 'Positionné', date_pointage: new Date().toISOString() },
    { numero_tc: 'MSKU2222222', taille: "20'", statut: 'En stock' },
  );
  const view = (await rap.rapportConteneurs(cfs, { statut: 'Positionné' })) as { compte: { total: number } };
  assert.equal(view.compte.total, 1);
  const pdf = (await rap.rapportConteneurs(cfs, { statut: 'Positionné', format: 'pdf' })) as { html: string };
  assert.match(pdf.html, /MSKU1111111/);
});

/* --------- v4.2 : conteneur au parc mais pas pointé « Positionné » ------ */

test('dépotage : un conteneur au parc non pointé est refusé, puis pointé à la volée', async () => {
  const db = new FakeDB();
  // Le cas réel : positionné dans la journée, APRÈS le pointage matinal. Il est
  // donc au parc, mais son statut est resté « En stock ».
  db.store['stock'].push({ numero_tc: 'MSKU2222222', taille: "40'", type_conteneur: 'DRY', statut: 'En stock' });
  const cfs = ctxAvec(db);
  const { id } = (await ecr.createcamion(cfs, { numeroCamion: 'TARDIF1/RM01', routage: 'Dépotage' })) as { id: string };
  const conteneur = { num: 'MSKU2222222', taille: "40'", type: 'DRY' };
  const declaration = { declarant: 'A', contactDeclarant: '901234', destinationMarchandise: 'D', bureauDeclaration: 'TG120', typeDeclaration: 'T', numeroDeclaration: '90', anneeDeclaration: '2026', descriptionMarchandise: 'X', nombreConteneurs: 1 };

  // Sans confirmation : refus, mais le message dit que le conteneur EST au parc
  // — c'est ce qui évite le réflexe « saisie manuelle ».
  await assert.rejects(
    () => ecr.cfs(cfs, { id, conteneur, declaration }),
    /est au parc .* n'a pas été pointé comme POSITIONNÉ/s,
  );

  // Avec confirmation : on le pointe au passage, puis le dépotage suit son cours.
  const trace = ctxTrace(db, 'CFS', 'Agent CFS');
  await ecr.cfs(trace.ctx, { id, conteneur, declaration, pointerSiNonPositionne: true });

  const stock = db.store['stock'][0]!;
  // Le conteneur reste RATTACHÉ à sa fiche de parc — c'est tout l'enjeu : la
  // saisie manuelle, elle, l'aurait laissé « En stock » indéfiniment.
  assert.equal(stock['statut'], 'Dépoté');
  assert.equal(stock['cargaison_id'], id);
  assert.equal(stock['pointe_par'], 'Agent CFS');
  assert.ok(stock['date_pointage'], 'le pointage à la volée doit être horodaté');
  // …et il est tracé à part du pointage matinal.
  assert.ok(trace.traces.some((t) => t.action === 'Pointage à la volée (dépotage)'),
    'le pointage à la volée doit apparaître au journal');
});

test('dépotage : un conteneur déjà POSITIONNÉ passe sans confirmation', async () => {
  const db = new FakeDB();
  db.store['stock'].push({ numero_tc: 'MSKU3333333', taille: "40'", statut: 'Positionné' });
  const cfs = ctxAvec(db);
  const { id } = (await ecr.createcamion(cfs, { numeroCamion: 'NORMAL1/RM01', routage: 'Dépotage' })) as { id: string };
  await ecr.cfs(cfs, {
    id, conteneur: { num: 'MSKU3333333', taille: "40'", type: 'DRY' },
    declaration: { declarant: 'A', contactDeclarant: '901234', destinationMarchandise: 'D', bureauDeclaration: 'TG120', typeDeclaration: 'T', numeroDeclaration: '91', anneeDeclaration: '2026', descriptionMarchandise: 'X', nombreConteneurs: 1 },
  });
  assert.equal(db.store['stock'][0]!['statut'], 'Dépoté');
});

test('statistiques de dépotage : positionnés, dépotés et RESTANT en fin de journée', async () => {
  const db = new FakeDB();
  // Trois conteneurs pointés le 10, un seul dépoté le 10 ; un quatrième pointé
  // le 11 et dépoté le 12. Un cinquième au parc jamais pointé.
  db.store['stock'].push(
    { numero_tc: 'MSKU0000001', taille: "40'", statut: 'Dépoté', date_pointage: '2026-08-10T06:00:00Z', date_depote: '2026-08-10T14:00:00Z' },
    { numero_tc: 'MSKU0000002', taille: "40'", statut: 'Positionné', date_pointage: '2026-08-10T06:00:00Z' },
    { numero_tc: 'MSKU0000003', taille: "20'", statut: 'Positionné', date_pointage: '2026-08-10T06:00:00Z' },
    { numero_tc: 'MSKU0000004', taille: "40'", statut: 'Dépoté', date_pointage: '2026-08-11T06:00:00Z', date_depote: '2026-08-12T09:00:00Z' },
    { numero_tc: 'MSKU0000005', taille: "40'", statut: 'En stock' },
  );
  const r = (await stk.rapportDepotage(ctxAvec(db), { du: '2026-08-10', au: '2026-08-12' })) as
    { rows: Record<string, unknown>[]; compte: Record<string, number> };
  const jour = (j: string) => r.rows.find((x) => x['jour'] === j)!;

  assert.equal(jour('2026-08-10')['positionnes'], 3);
  assert.equal(jour('2026-08-10')['depotes'], 1);
  // Fin du 10 : 3 pointés, 1 dépoté → 2 se reportent au lendemain.
  assert.equal(jour('2026-08-10')['restant'], 2);

  assert.equal(jour('2026-08-11')['positionnes'], 1);
  // Fin du 11 : les 2 restes du 10 + celui du 11, pas encore dépoté.
  assert.equal(jour('2026-08-11')['restant'], 3);

  assert.equal(jour('2026-08-12')['depotes'], 1);
  assert.equal(jour('2026-08-12')['restant'], 2);

  assert.equal(r.compte['pointes'], 4);
  assert.equal(r.compte['depotes'], 2);
  assert.equal(r.compte['restant'], 2); // statut « Positionné » aujourd'hui
  // Le conteneur au parc jamais pointé : celui qui échappe au suivi.
  assert.equal(r.compte['jamaisPointes'], 1);
});

test('stock.lookup : distingue absent, au parc non pointé, positionné et dépoté', async () => {
  const db = new FakeDB();
  db.store['stock'].push(
    { numero_tc: 'MSKU1000001', taille: "40'", statut: 'En stock' },
    { numero_tc: 'MSKU1000002', taille: "40'", statut: 'Positionné', date_pointage: new Date().toISOString() },
    { numero_tc: 'MSKU1000003', taille: "40'", statut: 'Dépoté', cargaison_id: 'CT-2026-000001' },
  );
  const ctx = ctxAvec(db);
  const absent = (await stk.stockLookup(ctx, { numeroTC: 'MSKU9999999' })) as Record<string, unknown>;
  assert.equal(absent['existe'], false);

  const aRegulariser = (await stk.stockLookup(ctx, { numeroTC: 'MSKU1000001' })) as Record<string, unknown>;
  assert.equal(aRegulariser['existe'], true);
  assert.equal(aRegulariser['aRegulariser'], true, 'au parc mais pas pointé → à signaler');

  const ok = (await stk.stockLookup(ctx, { numeroTC: 'MSKU1000002' })) as Record<string, unknown>;
  assert.equal(ok['aRegulariser'], false);
  assert.equal(ok['pointeAujourdhui'], true);

  const depote = (await stk.stockLookup(ctx, { numeroTC: 'MSKU1000003' })) as Record<string, unknown>;
  assert.equal(depote['depote'], true);
  assert.equal(depote['cargaisonId'], 'CT-2026-000001');
});

/* ---------------- v4.2 : temps de passage par poste -------------------- */

/**
 * ⚠ La base en mémoire n'a pas de déclencheur SQL : `date_fin_chargement` est
 * posée en production par `fn_marquer_fin_chargement` (migration 00110). On la
 * renseigne donc explicitement ici, comme le ferait la base — sinon tous les
 * dossiers de test seraient « détail par poste indisponible » et le test ne
 * vérifierait rien de ce qui compte.
 */
function semerDossier(db: FakeDB, id: string, jour: string, heures: Record<string, number | null>) {
  const t = (h: number | null) => (h === null ? null : new Date(`${jour}T06:00:00Z`).getTime() + h * 3600000);
  const iso = (h: number | null) => { const v = t(h); return v === null ? null : new Date(v).toISOString(); };
  db.store['cargaisons'].push({
    id, numero_camion: 'TPS' + id.slice(-2), type_operation: 'Enlèvement', statut: heures['sortie'] === null ? 'GPS Installé' : 'Sortie Enregistrée',
    date_creation: iso(0), date_fin_chargement: iso(heures['fin'] ?? 0),
    date_validation: iso(heures['validation'] ?? null), date_t1: iso(heures['t1'] ?? null),
    date_pose_gps: iso(heures['balise'] ?? null), date_bon_sortie: iso(heures['bs'] ?? null),
    date_sortie: iso(heures['sortie'] ?? null),
    annule: false, est_vehicule: false, conteneurs_details: { conteneurs: [], scellesCamion: [] },
    numero_declaration: '12345', annee_declaration: '2026', bureau_declaration: 'TG120', type_declaration: 'T',
  });
}

test('temps de passage : moyennes par poste, global, et cohorte par jour d\'entrée', async () => {
  const db = new FakeDB();
  // Deux dossiers le même jour : CFS 2 h et 4 h → moyenne 3 h.
  semerDossier(db, 'CT-2026-900001', '2026-08-10', { fin: 2, validation: 3, t1: 5, balise: 6, bs: 4, sortie: 7 });
  semerDossier(db, 'CT-2026-900002', '2026-08-10', { fin: 4, validation: 5, t1: 6, balise: 7, bs: 5, sortie: 9 });
  // Un dossier le lendemain, encore dans l'enceinte : compte dans l'effectif,
  // mais ne pèse pas sur les moyennes de sortie.
  semerDossier(db, 'CT-2026-900003', '2026-08-11', { fin: 1, validation: null, t1: 2, balise: 3, bs: null, sortie: null });

  const r = await rap.rapportTemps(ctxRole(db, 'CHEF_BRIGADE', 'Chef'), { du: '2026-08-10', au: '2026-08-11' }) as {
    compte: Record<string, number>;
    global: { n: number; moyenne: number | null };
    postes: { poste: string; n: number; moyenne: number | null }[];
    parJour: Record<string, unknown>[];
    lignes: Record<string, unknown>[];
  };

  assert.equal(r.compte['dossiers'], 3);
  assert.equal(r.compte['sortis'], 2);
  assert.equal(r.compte['sansFin'], 0, 'la date de fin de chargement est renseignée sur les trois');

  // CFS : 2 h et 4 h et 1 h → moyenne 140 min.
  const cfs = r.postes.find((x) => x.poste === 'cfs')!;
  assert.equal(cfs.n, 3);
  assert.equal(cfs.moyenne, 140);

  // GLOBAL : seuls les DEUX dossiers sortis sont mesurables (7 h et 9 h → 8 h).
  assert.equal(r.global.n, 2, 'un dossier non sorti ne fausse pas la moyenne globale');
  assert.equal(r.global.moyenne, 480);

  // Porte Principale : depuis le dernier jalon exigé (balise à 6 h → sortie 7 h
  // = 1 h ; balise à 7 h → sortie 9 h = 2 h) → moyenne 90 min.
  const pp = r.postes.find((x) => x.poste === 'pp')!;
  assert.equal(pp.n, 2);
  assert.equal(pp.moyenne, 90);

  // Cohorte : deux jours, le dossier du 11 rattaché à SON jour d'entrée.
  assert.equal(r.parJour.length, 2);
  assert.equal(r.parJour[0]!['jour'], '2026-08-10');
  assert.equal(r.parJour[0]!['dossiers'], 2);
  assert.equal(r.parJour[0]!['cfs'], 3, 'moyenne CFS du 10 août en heures décimales');
  assert.equal(r.parJour[1]!['n_global'], 0, 'le 11 août : aucun dossier encore sorti');
});

test('temps de passage : export imprimable (synthèse par poste)', async () => {
  const db = new FakeDB();
  semerDossier(db, 'CT-2026-900010', '2026-08-10', { fin: 1, validation: 2, t1: 3, balise: 4, bs: 2, sortie: 5 });
  // (xlsx = import npm:xlsx, testable côté Deno seulement ; ici on valide le PDF pur JS.)
  const r = await rap.rapportTemps(ctxRole(db, 'ADMIN', 'Admin'),
    { du: '2026-08-10', au: '2026-08-10', format: 'pdf' }) as { html: string };
  assert.match(r.html, /Temps de passage par poste/);
  assert.match(r.html, /CFS \(chargement\)/);
  assert.match(r.html, /GLOBAL — entrée du camion → sortie PP/);
  assert.match(r.html, /1 h/, 'les durées sortent en clair, pas en minutes brutes');
});

test('temps de passage : sans fin de chargement, le global reste exact', async () => {
  const db = new FakeDB();
  // Cargaison migrée : pas de date_fin_chargement (le déclencheur n'existait pas).
  db.store['cargaisons'].push({
    id: 'CT-2026-800001', numero_camion: 'OLD01', type_operation: 'Enlèvement', statut: 'Sortie Enregistrée',
    date_creation: '2026-08-10T06:00:00.000Z', date_fin_chargement: null,
    date_t1: '2026-08-10T09:00:00.000Z', date_pose_gps: '2026-08-10T10:00:00.000Z',
    date_sortie: '2026-08-10T12:00:00.000Z', annule: false, est_vehicule: false,
    conteneurs_details: { conteneurs: [], scellesCamion: [] },
  });
  const r = await rap.rapportTemps(ctxRole(db, 'ADMIN', 'Admin'), { du: '2026-08-10', au: '2026-08-10' }) as {
    compte: Record<string, number>; global: { moyenne: number | null }; postes: { poste: string; n: number }[];
  };
  assert.equal(r.compte['sansFin'], 1, 'le dossier est compté comme « détail par poste indisponible »');
  assert.equal(r.global.moyenne, 360, 'entrée → sortie PP = 6 h, mesurable sans fin de chargement');
  assert.equal(r.postes.find((x) => x.poste === 'cfs')!.n, 0, 'le temps CFS n\'est pas inventé');
  assert.equal(r.postes.find((x) => x.poste === 'pp')!.n, 1, 'la PP reste mesurable : elle part du dernier jalon');
});

/* ==========================================================================
 *  00170 — LA FUITE D'APUREMENT
 *
 *  Le compteur ne pouvait que MONTER : majApurement n'était appelé que sur
 *  l'ajout d'un conteneur, et fn_apurer_inc refuse tout décrément (garde-fou
 *  anti-fraude, migration 00090). Tout conteneur retiré, remplacé ou réaffecté
 *  laissait donc son +1 collé à sa déclaration d'origine.
 *
 *  Mesuré en production le 2026-09-09 : 34 des 121 déclarations portant un
 *  nombre déclaré étaient sur-apurées, jusqu'à +8 conteneurs.
 *
 *  Ces trois tests couvrent les trois chemins de fuite.
 * ========================================================================== */

const apuresDe = (db: FakeDB, numero: string) =>
  Number(db.store['declarations'].find((d) => d['numero_declaration'] === numero)?.['conteneurs_apures'] ?? -1);

/** Camion d'enlèvement avec deux conteneurs sur la même déclaration. */
async function camionDeuxConteneurs(db: FakeDB, numeroDecl: string) {
  db.store['stock'].push(
    { numero_tc: 'MSKU1111111', taille: "20'", statut: 'En stock' },
    { numero_tc: 'TCLU2222222', taille: "20'", statut: 'En stock' },
  );
  const cfs = ctxAvec(db);
  const { id } = (await ecr.createcamion(cfs, { numeroCamion: 'FUITE01/RM01', routage: 'Enlèvement' })) as { id: string };
  await ecr.cfs(cfs, {
    id,
    conteneur: { num: 'MSKU1111111', taille: "20'", type: 'DRY', plomb: 'S1' },
    declaration: {
      declarant: 'STE F', contactDeclarant: '90000000', destinationMarchandise: 'LOME',
      bureauDeclaration: 'TG120', typeDeclaration: 'T', numeroDeclaration: numeroDecl,
      anneeDeclaration: '2026', descriptionMarchandise: 'RIZ', nombreConteneurs: 2,
    },
  });
  await ecr.cfs(cfs, { id, conteneur: { num: 'TCLU2222222', taille: "20'", type: 'DRY', plomb: 'S2' } });
  return { id, cfs };
}

test('00170 — retirer un conteneur DÉCRÉMENTE son apurement', async () => {
  const db = new FakeDB();
  const { id, cfs } = await camionDeuxConteneurs(db, '5001');
  assert.equal(apuresDe(db, '5001'), 2, 'deux conteneurs ajoutés = deux apurés');

  await ecr.editconteneur(cfs, { id, index: 1, supprimer: true });

  assert.equal(apuresDe(db, '5001'), 1, 'le conteneur retiré ne doit plus être apuré');
});

test('00170 — réaffecter un conteneur TRANSFÈRE son apurement', async () => {
  const db = new FakeDB();
  const { id, cfs } = await camionDeuxConteneurs(db, '5002');
  assert.equal(apuresDe(db, '5002'), 2);

  // Même conteneur, déclaration différente : seule la ligne visée change.
  await ecr.editconteneur(cfs, {
    id, index: 0,
    num: 'MSKU1111111', taille: "20'", type: 'DRY', plomb: 'S1',
    declaration: { numeroDeclaration: '5003', anneeDeclaration: '2026', bureauDeclaration: 'TG120', typeDeclaration: 'T' },
  });

  assert.equal(apuresDe(db, '5002'), 1, 'la déclaration quittée perd son conteneur');
  assert.equal(apuresDe(db, '5003'), 1, 'la déclaration rejointe le récupère');
});

test('00170 — annuler une cargaison DÉCRÉMENTE tous ses conteneurs (effet de bord SEC-12)', async () => {
  const db = new FakeDB();
  const { id } = await camionDeuxConteneurs(db, '5004');
  assert.equal(apuresDe(db, '5004'), 2);

  const admin = ctxRole(db, 'ADMIN', 'Administrateur');
  await ecr.supprimerCargo(admin, { id, motif: 'doublon de saisie' });

  assert.equal(apuresDe(db, '5004'), 0, 'un doublon écarté ne doit plus apurer la déclaration');
});

test('00170 — le décrément ne descend jamais sous zéro', async () => {
  const db = new FakeDB();
  const { id, cfs } = await camionDeuxConteneurs(db, '5005');

  await ecr.editconteneur(cfs, { id, index: 1, supprimer: true });
  await ecr.editconteneur(cfs, { id, index: 0, supprimer: true });

  assert.equal(apuresDe(db, '5005'), 0, 'plus aucun conteneur : apurement à zéro');

  // Une annulation par-dessus ne doit pas rendre le compteur négatif : un
  // apurement négatif serait un dédouanement falsifié (cf. 00090).
  const admin = ctxRole(db, 'ADMIN', 'Administrateur');
  await ecr.supprimerCargo(admin, { id, motif: 'doublon de saisie' });

  assert.equal(apuresDe(db, '5005'), 0, 'borné à zéro, jamais négatif');
});

/* ============== ANTI-DOUBLONS — gardes ajoutées le 2026-09-10 ============= */

test('doublons — I-4 : les flux spéciaux refusent un camion déjà dans le système', async () => {
  const db = new FakeDB();
  const cfs = ctxAvec(db);
  // Un camion entre par le flux principal.
  await ecr.createcamion(cfs, { numeroCamion: 'DBL100/RM01', routage: 'Enlèvement' });

  // Le MÊME camion, par un flux spécial (Conso) : refusé désormais.
  await assert.rejects(
    () => spe.create(cfs, {
      typeOperation: 'Conso (type C)',
      declaration: { declarant: 'A', contactDeclarant: '90000000', destinationMarchandise: 'TG', bureauDeclaration: 'TG120', typeDeclaration: 'C', numeroDeclaration: '900', anneeDeclaration: '2026', descriptionMarchandise: 'X' },
      camions: [{ numeroCamion: 'DBL100/RM01', conteneurs: [{ num: 'MSKU1110001', taille: "20'", plomb: 'S1', type: 'DRY' }] }],
    }),
    /déjà dans le système/i,
  );
});

test('doublons — I-4 : la même plaque deux fois dans une seule saisie est refusée', async () => {
  const db = new FakeDB();
  const cfs = ctxAvec(db);
  await assert.rejects(
    () => spe.create(cfs, {
      typeOperation: 'Conso (type C)',
      declaration: { declarant: 'A', contactDeclarant: '90000000', destinationMarchandise: 'TG', bureauDeclaration: 'TG120', typeDeclaration: 'C', numeroDeclaration: '901', anneeDeclaration: '2026', descriptionMarchandise: 'X' },
      camions: [
        { numeroCamion: 'DBL200/RM01', conteneurs: [{ num: 'MSKU2220001', taille: "20'", plomb: 'S1', type: 'DRY' }] },
        { numeroCamion: 'DBL200/RM01', conteneurs: [{ num: 'MSKU2220002', taille: "20'", plomb: 'S2', type: 'DRY' }] },
      ],
    }),
    /figure deux fois/i,
  );
});

test('doublons — I-4 : un camion SORTI peut être ressaisi (la garde ne bloque pas à vie)', async () => {
  const db = new FakeDB();
  const cfs = ctxAvec(db);
  // On simule un camion déjà sorti : la garde ne doit pas s'y opposer.
  db.store['cargaisons'].push({
    id: 'CT-ANCIEN', numero_camion: 'DBL300', numero_camion_norm: 'DBL300',
    statut: 'Sortie Enregistrée', annule: false,
  });
  const r = (await spe.create(cfs, {
    typeOperation: 'Conso (type C)',
    declaration: { declarant: 'A', contactDeclarant: '90000000', destinationMarchandise: 'TG', bureauDeclaration: 'TG120', typeDeclaration: 'C', numeroDeclaration: '902', anneeDeclaration: '2026', descriptionMarchandise: 'X' },
    camions: [{ numeroCamion: 'DBL300/RM01', conteneurs: [{ num: 'MSKU3330001', taille: "20'", plomb: 'S1', type: 'DRY' }] }],
  })) as { rapportId?: string };
  assert.ok(r, 'un camion déjà sorti doit pouvoir revenir');
});

test('doublons — DAT-05 : le même conteneur deux fois sur un camion est refusé', async () => {
  const db = new FakeDB();
  const cfs = ctxAvec(db);
  await assert.rejects(
    () => spe.create(cfs, {
      typeOperation: 'Conso (type C)',
      declaration: { declarant: 'A', contactDeclarant: '90000000', destinationMarchandise: 'TG', bureauDeclaration: 'TG120', typeDeclaration: 'C', numeroDeclaration: '903', anneeDeclaration: '2026', descriptionMarchandise: 'X' },
      camions: [{ numeroCamion: 'DBL400/RM01', conteneurs: [
        { num: 'MSKU4440001', taille: "20'", plomb: 'S1', type: 'DRY' },
        { num: 'MSKU4440001', taille: "20'", plomb: 'S2', type: 'DRY' },
      ] }],
    }),
    /figure deux fois dans cette saisie/i,
  );
});

test('doublons — DAT-05 : un conteneur déjà rattaché au camion ne peut pas être rajouté', async () => {
  const db = new FakeDB();
  const cfs = ctxAvec(db);
  // ENLÈVEMENT : le conteneur arrive scellé, sans passer par le stock — c'est le
  // flux où le même numéro peut être ressaisi par erreur sur le même camion.
  const { id } = (await ecr.createcamion(cfs, { numeroCamion: 'DBL500/RM01', routage: 'Enlèvement' })) as { id: string };
  const decl = { declarant: 'A', contactDeclarant: '90000000', destinationMarchandise: 'TG', bureauDeclaration: 'TG120', typeDeclaration: 'C', numeroDeclaration: '904', anneeDeclaration: '2026', descriptionMarchandise: 'X', nombreConteneurs: 2 };
  await ecr.cfs(cfs, { id, conteneur: { num: 'MSKU5550001', taille: "20'", type: 'DRY', plomb: 'S1', manuel: true }, declaration: decl });

  /* Le même conteneur, une seconde fois sur ce camion : refusé.
   *
   * DEUX gardes le couvrent désormais, et c'est voulu. `cargo.cfs` en avait déjà
   * une, propre à ce flux ; celle de `ajouterConteneurs` (2026-09-10) est plus
   * profonde et attrape les chemins que `cfs` ne traverse pas — la saisie en lot
   * des flux spéciaux, notamment (cf. le test précédent). Le test accepte donc
   * l'un ou l'autre message : ce qui compte est que le doublon ne passe pas. */
  await assert.rejects(
    () => ecr.cfs(cfs, { id, conteneur: { num: 'MSKU5550001', taille: "20'", type: 'DRY', plomb: 'S2', manuel: true }, declaration: decl }),
    /déjà (sur|enregistré sur) ce camion/i,
  );
});

/* ========== MAGASIN / MAD — format + anti-doublon (2026-09-10) ============ */

/** Déclaration minimale d'une sortie Magasin / MAD. */
const DECL_MAG = {
  declarant: 'A', contactDeclarant: '90000000', destinationMarchandise: 'TG',
  bureauDeclaration: 'TG120', typeDeclaration: 'C', numeroDeclaration: '950',
  anneeDeclaration: '2026', descriptionMarchandise: 'SACS DE RIZ',
};

const sortieMagasin = (plaque: string, decl: Record<string, unknown> = DECL_MAG) => ({
  typeOperation: 'Sortie Magasin / MAD', numeroCamion: plaque,
  declaration: decl, chargementTermine: true, scellesCamion: ['S1', 'S2'],
});

/* 2026-09-12 — la barre oblique n'est plus obligatoire (décision utilisateur).
 * Ce qui reste vérifié ici : le flux MAGASIN/MAD passe bien par le contrôle de
 * format — il en sortait trop tôt à une époque — et refuse toujours une saisie
 * avortée. */
test('MAGASIN/MAD — une plaque seule est désormais acceptée', async () => {
  const db = new FakeDB();
  const cfs = ctxAvec(db);
  await spe.create(cfs, sortieMagasin('MAG900'));
  const cree = db.store['cargaisons'].find((c) => String(c['numero_camion']) === 'MAG900');
  assert.ok(cree, 'un porteur unique doit pouvoir être enregistré');
});

test('MAGASIN/MAD — une saisie avortée reste refusée', async () => {
  const db = new FakeDB();
  const cfs = ctxAvec(db);
  await assert.rejects(
    () => spe.create(cfs, sortieMagasin('AB')),
    /non exploitable/i,
  );
});

test('MAGASIN/MAD — un camion déjà dans le système est refusé, et le mixte est proposé', async () => {
  const db = new FakeDB();
  const cfs = ctxAvec(db);
  // Le camion entre d'abord par le flux principal.
  const { id } = (await ecr.createcamion(cfs, { numeroCamion: 'MAG901/RM01', routage: 'Dépotage' })) as { id: string };

  // La même plaque en sortie magasin : refusée.
  await assert.rejects(
    () => spe.create(cfs, sortieMagasin('MAG901/RM01')),
    /déjà dans le système/i,
  );
  // Le message doit NOMMER le dossier existant et ORIENTER vers le mixte,
  // sinon l'agent bloqué invente une plaque pour passer outre.
  await assert.rejects(
    () => spe.create(cfs, sortieMagasin('MAG901/RM01')),
    (e: Error) => e.message.includes(id) && /CHARGEMENT MIXTE/i.test(e.message),
  );
});

test('MAGASIN/MAD — un camion DÉJÀ SORTI peut revenir en sortie magasin', async () => {
  const db = new FakeDB();
  const cfs = ctxAvec(db);
  // Camion d'un passage précédent, déjà sorti : ce n'est pas un doublon.
  db.store['cargaisons'].push({
    id: 'CT-VIEUX', numero_camion: 'MAG902/RM01', numero_camion_norm: 'MAG902RM01',
    statut: 'Sortie Enregistrée', annule: false,
  });
  const r = await spe.create(cfs, sortieMagasin('MAG902/RM01'));
  assert.ok(r, 'un camion sorti doit pouvoir revenir pour une sortie magasin');
});

/* ===== DÉPOTAGE : pointage obligatoire, sans échappatoire (2026-09-10) ===== */

/** Prépare un camion en DÉPOTAGE prêt à recevoir un conteneur. */
async function depotagePret(db: FakeDB, plaque = 'PNT001/RM01') {
  const cfs = ctxAvec(db);
  const { id } = (await ecr.createcamion(cfs, { numeroCamion: plaque, routage: 'Dépotage' })) as { id: string };
  return { cfs, id };
}
const DECL_PNT = {
  declarant: 'A', contactDeclarant: '90000000', destinationMarchandise: 'TG',
  bureauDeclaration: 'TG120', typeDeclaration: 'C', numeroDeclaration: '960',
  anneeDeclaration: '2026', descriptionMarchandise: 'X',
};

test('dépotage — un conteneur NON pointé est refusé, sauf régularisation explicite', async () => {
  const db = new FakeDB();
  // Présent au parc mais « En stock » : jamais pointé positionné.
  db.store['stock'].push({ numero_tc: 'MSKU6660001', taille: "20'", statut: 'En stock' });
  const { cfs, id } = await depotagePret(db);
  const cont = { num: 'MSKU6660001', taille: "20'", type: 'DRY' };

  await assert.rejects(
    () => ecr.cfs(cfs, { id, conteneur: cont, declaration: DECL_PNT }),
    /n'a pas été pointé comme POSITIONNÉ/i,
  );

  // Avec la confirmation explicite, il passe ET il est pointé au passage.
  await ecr.cfs(cfs, { id, conteneur: cont, declaration: DECL_PNT, pointerSiNonPositionne: true });
  const s = db.store['stock'].find((x) => x['numero_tc'] === 'MSKU6660001')!;
  assert.equal(s['statut'], 'Dépoté', 'le conteneur doit finir dépoté, donc rattaché à sa fiche');
  assert.ok(s['date_pointage'], 'le pointage à la volée doit être horodaté');
});

/* 2026-09-14 — RÈGLE MODIFIÉE (demande utilisateur). Ce test vérifiait le refus.
 * La saisie manuelle d'un conteneur au parc non pointé est désormais permise ;
 * ce qui protégeait le parc est conservé autrement : la fiche est RATTACHÉE et
 * passe à « Dépoté », elle ne reste plus « En stock » pour toujours. */
test('dépotage — saisie manuelle d\'un conteneur AU PARC : permise, et rattachée à sa fiche (2026-09-14)', async () => {
  const db = new FakeDB();
  db.store['stock'].push({ numero_tc: 'MSKU6660002', taille: "20'", statut: 'En stock' });
  const { cfs, id } = await depotagePret(db, 'PNT002/RM01');
  // Aucun pointage exigé : l'agent a choisi la saisie manuelle.
  await ecr.cfs(cfs, {
    id, declaration: DECL_PNT,
    conteneur: { num: 'MSKU6660002', taille: "20'", type: 'DRY', manuel: true },
  });
  const s = db.store['stock'].find((x) => x['numero_tc'] === 'MSKU6660002')!;
  assert.equal(s['statut'], 'Dépoté', 'le conteneur ne doit pas rester « En stock » au parc');
  assert.equal(s['cargaison_id'], id, 'la fiche est rattachée au camion');
  assert.ok(!s['date_pointage'], 'aucune date de pointage inventée');
});

/* 2026-09-12 — CE TEST DISAIT L'INVERSE, et la production a tranché.
 *
 * La règle du 10 septembre posait que « tout conteneur dépoté au port sec figure
 * au parc ». C'est faux : « CCLU7731903 », physiquement présent, n'existait dans
 * aucune fiche — et l'agent n'avait alors AUCUNE issue. La saisie manuelle
 * retrouve donc sa raison d'être d'origine, les conteneurs ABSENTS du parc, et
 * elle crée la fiche au passage : le grief qui l'avait fait fermer était
 * justement qu'elle laissait des conteneurs sans fiche. */
test('dépotage — un conteneur ABSENT du stock passe en saisie manuelle, et sa fiche est créée', async () => {
  const db = new FakeDB();
  const { cfs, id } = await depotagePret(db, 'PNT003/RM01');
  await ecr.cfs(cfs, {
    id, declaration: DECL_PNT,
    conteneur: { num: 'MSKU6660003', taille: "20'", type: 'DRY', manuel: true },
  });
  const c = db.store['cargaisons'].find((x) => x['id'] === id)!;
  assert.match(JSON.stringify(c['conteneurs_details']), /MSKU6660003/, 'le conteneur est rattaché');

  const fiche = db.store['stock'].find((x) => x['numero_tc'] === 'MSKU6660003');
  assert.ok(fiche, 'LE POINT ESSENTIEL : une fiche de stock doit exister, sinon on recrée '
    + 'le défaut qui avait fait fermer la saisie manuelle');
  // 2026-09-14 : la fiche créée est aussi rattachée au camion — un conteneur dépoté
  // ne reste plus « Positionné » au parc.
  assert.equal(fiche!['statut'], 'Dépoté');
});

test('enlèvement — la saisie manuelle reste REFUSÉE pour un conteneur présent au stock (2026-09-14)', async () => {
  const db = new FakeDB();
  db.store['stock'].push({ numero_tc: 'MSKU6660004', taille: "20'", statut: 'En stock' });
  const cfs = ctxAvec(db);
  const { id } = (await ecr.createcamion(cfs, { numeroCamion: 'PNT005/RM01', routage: 'Enlèvement' })) as { id: string };
  await assert.rejects(
    () => ecr.cfs(cfs, {
      id, declaration: DECL_PNT,
      conteneur: { num: 'MSKU6660004', taille: "20'", type: 'DRY', plomb: 'S1', manuel: true },
    }),
    /EST au stock/i,
  );
});
test("enlèvement — la saisie manuelle reste permise : le conteneur part scellé, hors parc", async () => {
  const db = new FakeDB();
  const cfs = ctxAvec(db);
  const { id } = (await ecr.createcamion(cfs, { numeroCamion: 'PNT004/RM01', routage: 'Enlèvement' })) as { id: string };
  await ecr.cfs(cfs, {
    id, declaration: DECL_PNT,
    conteneur: { num: 'MSKU6660004', taille: "20'", type: 'DRY', plomb: 'S1', manuel: true },
  });
  const c = versCamel(db.store['cargaisons'][0]!);
  assert.equal(Number(c['nbConteneurs']), 1, "l'enlèvement n'est pas concerné par la règle de pointage");
});

/* ---- 2026-09-11 : modification et suppression d'un magasin --------------- */

test('magasin : renommer, désactiver, réactiver', async () => {
  const db = new FakeDB();
  await entrepot.entrepotCreate(chef(db), { code: 'MAD-09', nom: 'MAGASIN NRD', type: 'MAD' });

  await entrepot.entrepotEdit(chef(db), { code: 'MAD-09', nom: 'MAGASIN NORD' });
  const apres = db.store['entrepots'].find((e) => e['code'] === 'MAD-09')!;
  assert.equal(apres['nom'], 'MAGASIN NORD');

  // Désactivé : il sort des listes de saisie, mais reste visible avec `tous`.
  await entrepot.entrepotEdit(chef(db), { code: 'MAD-09', actif: false });
  const saisie = (await entrepot.entrepotList(chef(db), { type: 'MAD' })) as { rows: Record<string, unknown>[] };
  assert.equal(saisie.rows.length, 0, 'un magasin désactivé quitte les écrans de saisie');
  const gestion = (await entrepot.entrepotList(chef(db), { type: 'MAD', tous: true })) as { rows: Record<string, unknown>[] };
  assert.equal(gestion.rows.length, 1, 'il reste visible en gestion, sinon on ne pourrait plus le réactiver');

  await entrepot.entrepotEdit(chef(db), { code: 'MAD-09', actif: true });
  const revenu = (await entrepot.entrepotList(chef(db), { type: 'MAD' })) as { rows: Record<string, unknown>[] };
  assert.equal(revenu.rows.length, 1);
});

test('magasin : une modification sans changement est refusée, pas silencieuse', async () => {
  const db = new FakeDB();
  await entrepot.entrepotCreate(chef(db), { code: 'MAD-10', nom: 'MAGASIN SUD', type: 'MAD' });
  await assert.rejects(
    () => entrepot.entrepotEdit(chef(db), { code: 'MAD-10', nom: 'MAGASIN SUD' }),
    /Aucune modification/);
  await assert.rejects(() => entrepot.entrepotEdit(chef(db), { code: 'INCONNU', nom: 'X' }), /introuvable/);
});

test('magasin : le type ne change plus dès qu\'il y a une entrée', async () => {
  const db = new FakeDB();
  const cfs = ctxAvec(db);
  await entrepot.entrepotCreate(chef(db), { code: 'MAD-11', nom: 'MAGASIN EST', type: 'MAD' });
  // Encore vierge : le type se corrige.
  await entrepot.entrepotEdit(chef(db), { code: 'MAD-11', type: 'INDUSTRIEL' });
  assert.equal(db.store['entrepots'].find((e) => e['code'] === 'MAD-11')!['type'], 'INDUSTRIEL');

  await entrepot.entrepotEntree(cfs, {
    entrepotCode: 'MAD-11',
    declaration: { numeroDeclaration: '900', anneeDeclaration: '2026', bureauDeclaration: 'TG120', typeDeclaration: 'C', declarant: 'ACME' },
    articles: [{ designation: 'CIMENT', poids: '1000' }],
  });
  // Garni : bascule refusée — MAD compte des colis, INDUSTRIEL des kilos.
  await assert.rejects(
    () => entrepot.entrepotEdit(chef(db), { code: 'MAD-11', type: 'MAD' }),
    /Type non modifiable/);
});

test('magasin : suppression refusée s\'il contient une entrée, motif obligatoire', async () => {
  const db = new FakeDB();
  const cfs = ctxAvec(db);
  const admin = ctxRole(db, 'ADMIN', 'Admin');
  await entrepot.entrepotCreate(chef(db), { code: 'MAD-12', nom: 'MAGASIN OUEST', type: 'MAD' });

  await assert.rejects(() => entrepot.entrepotSupprimer(admin, { code: 'MAD-12' }), /Motif obligatoire/);

  await entrepot.entrepotEntree(cfs, {
    entrepotCode: 'MAD-12',
    declaration: { numeroDeclaration: '901', anneeDeclaration: '2026', bureauDeclaration: 'TG120', typeDeclaration: 'C', declarant: 'ACME' },
    articles: [{ designation: 'RIZ', nbColis: '10' }],
  });
  await assert.rejects(
    () => entrepot.entrepotSupprimer(admin, { code: 'MAD-12', motif: 'doublon' }),
    /Suppression impossible/);
  assert.equal(db.store['entrepots'].filter((e) => e['code'] === 'MAD-12').length, 1, 'le magasin est intact');
});

test('magasin : un magasin vierge se supprime pour de bon', async () => {
  const db = new FakeDB();
  const admin = ctxRole(db, 'ADMIN', 'Admin');
  await entrepot.entrepotCreate(chef(db), { code: 'MAD-13', nom: 'ERREUR DE SAISIE', type: 'MAD' });
  await entrepot.entrepotSupprimer(admin, { code: 'MAD-13', motif: 'créé par erreur' });
  assert.equal(db.store['entrepots'].filter((e) => e['code'] === 'MAD-13').length, 0);
  await assert.rejects(() => entrepot.entrepotSupprimer(admin, { code: 'MAD-13', motif: 'encore' }), /introuvable/);
});

test('magasin : supprimer est réservé à l\'ADMIN, modifier ne l\'est pas', () => {
  // La matrice serveur est l'AUTORITÉ ; l'écran ne fait que masquer le bouton.
  const permis = (role: string, action: string) => {
    try { verifierPermission(role, action); return true; } catch { return false; }
  };
  assert.equal(permis('ADMIN', 'entrepot.delete'), true);
  for (const r of ['CHEF_BRIGADE', 'CHEF_DIVISION', 'CFS', 'PP', 'T1']) {
    assert.equal(permis(r, 'entrepot.delete'), false, r + ' ne doit pas supprimer un magasin');
  }
  for (const r of ['ADMIN', 'CHEF_BRIGADE', 'CHEF_DIVISION']) {
    assert.equal(permis(r, 'entrepot.edit'), true, r + ' doit pouvoir modifier');
  }
  for (const r of ['CFS', 'PP', 'BALISE']) {
    assert.equal(permis(r, 'entrepot.edit'), false, r + ' ne doit pas modifier un magasin');
  }
});

/* ---- 2026-09-11 : le n° de déclaration se saisit à toutes les étapes ----- */

/** Contexte dont on peut RELIRE le journal, pour vérifier la trace laissée. */
function ctxJournal(db: FakeDB, role: string, nom: string) {
  const journal: string[] = [];
  const ctx = {
    db: db as never,
    session: { userId: 'u-' + role, username: role.toLowerCase(), nomComplet: nom, role: role as never },
    log: async (a: string, c: string, d: string) => { journal.push(a + ' | ' + c + ' | ' + d); },
  } as unknown as Ctx;
  return { ctx, journal };
}

/** Camion mené jusqu'au T1 : à ce stade, la correction était autrefois refusée. */
async function camionJusquAuT1(db: FakeDB): Promise<string> {
  db.store['stock'].push({ numero_tc: 'MSKU4444444', taille: "20'", statut: 'En stock' });
  const cfs = ctxAvec(db);
  const cree = (await ecr.createcamion(cfs, { numeroCamion: 'DECL01/RM01', routage: 'Enlèvement' })) as { id: string };
  await ecr.cfs(cfs, {
    id: cree.id, conteneur: { num: 'MSKU4444444', taille: "20'", type: 'DRY', plomb: 'S1' },
    declaration: {
      declarant: 'STE X', contactDeclarant: '90123456', destinationMarchandise: 'LOME',
      bureauDeclaration: 'TG120', typeDeclaration: 'T', numeroDeclaration: '777', anneeDeclaration: '2026',
      descriptionMarchandise: 'RIZ', nombreConteneurs: 1,
    },
  });
  await ecr.valider(ctxRole(db, 'CHEF_BRIGADE', 'Chef Brigade'), { id: cree.id, enSurcharge: false, suiviEngagement: false });
  await ecr.t1(ctxRole(db, 'T1', 'Agent T1'), {
    id: cree.id, bureauDestination: 'TG120', t1Numeros: [{ conteneur: 'MSKU4444444', numero: 'T1-A' }],
  });
  assert.equal(statutDe(db, cree.id), STATUTS.T1, 'le camion a bien dépassé « Créée »');
  return cree.id;
}

const declCorrigee = {
  declarant: 'STE X', bureauDeclaration: 'TG120', typeDeclaration: 'T',
  numeroDeclaration: '888', anneeDeclaration: '2026',
};

test('déclaration : le CFS corrige APRÈS le T1, à condition de motiver', async () => {
  const db = new FakeDB();
  const id = await camionJusquAuT1(db);
  const cfs = ctxAvec(db);

  // Sans motif : refus, et le message dit quoi faire.
  await assert.rejects(
    () => ecr.editdecl(cfs, { id, declaration: declCorrigee }),
    /indiquez le MOTIF/);
  assert.equal(db.store['cargaisons'][0]!['numero_declaration'], '777', 'rien n\'a bougé');

  // Avec motif : la correction passe — c'est la porte qu'on vient d'ouvrir.
  await ecr.editdecl(cfs, { id, declaration: declCorrigee, motif: 'numéro saisi à l\'envers' });
  assert.equal(db.store['cargaisons'][0]!['numero_declaration'], '888');
});

test('déclaration : la correction tardive laisse motif et mention de signature au journal', async () => {
  const db = new FakeDB();
  const id = await camionJusquAuT1(db);
  const { ctx, journal } = ctxJournal(db, 'CFS', 'Agent CFS Un');

  await ecr.editdecl(ctx, { id, declaration: declCorrigee, motif: 'erreur de frappe' });
  const ligne = journal.find((l) => l.startsWith('Correction déclaration'))!;
  assert.ok(ligne, 'la correction est journalisée');
  assert.match(ligne, /777\|2026\|TG120\|T → /);
  assert.match(ligne, /motif : erreur de frappe/);
  // La cargaison était signée : le journal doit le dire, sinon personne ne
  // saura plus tard pourquoi l'empreinte de validation ne concorde plus.
  assert.match(ligne, /APRÈS VALIDATION/);
});

test('déclaration : avant « Créée », aucun motif n\'est réclamé', async () => {
  const db = new FakeDB();
  const cfs = ctxAvec(db);
  const cree = (await ecr.createcamion(cfs, { numeroCamion: 'DECL02/RM01', routage: 'Enlèvement' })) as { id: string };
  // Statut « Camion créé » : la correction reste un geste courant.
  await ecr.editdecl(cfs, { id: cree.id, declaration: declCorrigee });
  assert.equal(db.store['cargaisons'][0]!['numero_declaration'], '888');
});

test('déclaration : l\'ADMIN garde exactement son comportement d\'avant', async () => {
  const db = new FakeDB();
  const id = await camionJusquAuT1(db);
  const { ctx, journal } = ctxJournal(db, 'ADMIN', 'Admin');
  // Aucun motif fourni, et pourtant ça passe : rien n'a changé pour lui.
  await ecr.editdecl(ctx, { id, declaration: declCorrigee });
  assert.equal(db.store['cargaisons'][0]!['numero_declaration'], '888');
  assert.match(journal.find((l) => l.startsWith('Correction déclaration'))!, /correction ADMIN/);
});

test('conteneur : la correction tardive suit la même règle que la déclaration', async () => {
  const db = new FakeDB();
  const id = await camionJusquAuT1(db);
  const cfs = ctxAvec(db);
  await assert.rejects(
    () => ecr.editconteneur(cfs, { id, index: 0, num: 'MSKU4444444', taille: "20'", type: 'DRY', plomb: 'S9', manuel: true }),
    /indiquez le MOTIF/);
  await ecr.editconteneur(cfs, {
    id, index: 0, num: 'MSKU4444444', taille: "20'", type: 'DRY', plomb: 'S9', manuel: true,
    motif: 'plomb relevé à tort',
  });
  const dets = versCamel(db.store['cargaisons'][0]!)['conteneursDetails'] as { conteneurs: Record<string, unknown>[] };
  assert.equal(dets.conteneurs[0]!['plomb'], 'S9');
});

/* ===== CONTENEUR PARTAGÉ ENTRE PLUSIEURS CAMIONS — 2026-09-12 ============
 *
 * Signalé en production : un conteneur dépoté au port sec alimente souvent
 * PLUSIEURS camions, sa marchandise étant répartie entre eux. Le premier le
 * fait passer à « Dépoté » ; pour le deuxième, la règle de pointage réclamait
 * alors un pointage sur un conteneur DÉJÀ pointé et DÉJÀ dépoté. Les agents
 * contournaient par la « saisie manuelle », qui détache le conteneur de sa
 * fiche de stock — précisément ce que cette règle devait empêcher.
 */
test('dépotage — un conteneur DÉJÀ DÉPOTÉ se rattache à un camion supplémentaire', async () => {
  const db = new FakeDB();
  // Le conteneur a déjà servi : il est sorti du parc, statut « Dépoté ».
  db.store['stock'].push({ numero_tc: 'MSKU7770001', taille: "20'", statut: 'Dépoté' });
  const { cfs, id } = await depotagePret(db, 'PART001/RM01');

  await ecr.cfs(cfs, {
    id, declaration: DECL_PNT,
    conteneur: { num: 'MSKU7770001', taille: "20'", type: 'DRY' },
  });

  const c = db.store['cargaisons'].find((x) => x['id'] === id)!;
  // JSON.stringify, et non String() : `conteneurs_details` est un objet, dont
  // String() ne rend que « [object Object] » — le test passait à côté.
  assert.match(JSON.stringify(c['conteneurs_details']), /MSKU7770001/,
    'le conteneur partagé doit être rattaché au second camion');
});

test('dépotage — un conteneur partagé NE redevient PAS « positionné »', async () => {
  const db = new FakeDB();
  db.store['stock'].push({ numero_tc: 'MSKU7770002', taille: "20'", statut: 'Dépoté' });
  const { cfs, id } = await depotagePret(db, 'PART002/RM01');

  await ecr.cfs(cfs, {
    id, declaration: DECL_PNT,
    conteneur: { num: 'MSKU7770002', taille: "20'", type: 'DRY' },
  });

  const stk = db.store['stock'].find((x) => x['numero_tc'] === 'MSKU7770002')!;
  assert.equal(stk['statut'], 'Dépoté',
    'le re-pointage ferait réapparaître au parc un conteneur déjà parti');
});

test('dépotage — le conteneur NON dépoté garde sa règle de pointage', async () => {
  const db = new FakeDB();
  // « En stock » : le garde-fou d'origine doit rester intact.
  db.store['stock'].push({ numero_tc: 'MSKU7770003', taille: "20'", statut: 'En stock' });
  const { cfs, id } = await depotagePret(db, 'PART003/RM01');
  await assert.rejects(
    () => ecr.cfs(cfs, {
      id, declaration: DECL_PNT,
      conteneur: { num: 'MSKU7770003', taille: "20'", type: 'DRY' },
    }),
    /pas été pointé comme POSITIONNÉ/i,
  );
});

/* ===== UNE BALISE NE SUIT QU'UN CAMION À LA FOIS — 2026-09-12 ============
 *
 * La migration 00170 pose un index unique qui l'impose. Ce test couvre le
 * contrôle applicatif qui le PRÉCÈDE : sans lui, l'agent verrait un refus
 * technique générique, sans savoir que c'est le numéro de balise qui est en
 * cause ni sur quel camion il est déjà posé.
 */
test('balise — un numéro déjà posé sur un camion non sorti est refusé, en le nommant', async () => {
  const db = new FakeDB();
  db.store['cargaisons'].push({
    id: 'CT-2026-900001', numero_camion: 'BAL001/RM01', statut: 'T1 Saisi',
    numero_gps: 'GPS-777', date_creation: '2026-09-01T08:00:00Z',
  });
  const id = await depotageAValider(db, 'BAL002/RM02', 'MSKU8880001');
  await ecr.valider(ctxRole(db, 'CHEF_BRIGADE', 'CB'), { id, enSurcharge: false });
  await ecr.t1(ctxRole(db, 'T1', 'Agent T1'), { id, bureauDestination: 'TG120',
    t1Numeros: [{ conteneur: 'MSKU8880001', numero: 'T1-9001' }] });

  await assert.rejects(
    () => ecr.gps(ctxRole(db, 'BALISE', 'Agent Balise'),
      { id, baliseRequise: 'Oui', t1Correct: 'Oui', numeroGPS: 'GPS-777' }),
    (e: Error) => /BAL001\/RM01/.test(e.message) && /d\u00e9j\u00e0 pos\u00e9e/i.test(e.message),
  );
});

test('balise — le même numéro est libre une fois l\'autre camion SORTI', async () => {
  const db = new FakeDB();
  db.store['cargaisons'].push({
    id: 'CT-2026-900002', numero_camion: 'BAL003/RM03', statut: 'Sortie Enregistrée',
    numero_gps: 'GPS-778', date_sortie: '2026-09-02T10:00:00Z',
    date_creation: '2026-09-01T08:00:00Z',
  });
  const id = await depotageAValider(db, 'BAL004/RM04', 'MSKU8880002');
  await ecr.valider(ctxRole(db, 'CHEF_BRIGADE', 'CB'), { id, enSurcharge: false });
  await ecr.t1(ctxRole(db, 'T1', 'Agent T1'), { id, bureauDestination: 'TG120',
    t1Numeros: [{ conteneur: 'MSKU8880002', numero: 'T1-9002' }] });

  await ecr.gps(ctxRole(db, 'BALISE', 'Agent Balise'),
    { id, baliseRequise: 'Oui', t1Correct: 'Oui', numeroGPS: 'GPS-778' });
  const c = db.store['cargaisons'].find((x) => x['id'] === id)!;
  assert.equal(c['numero_gps'], 'GPS-778', 'une balise se repose sur un autre camion après la sortie');
});

/* ===== LES TROIS RÈGLES DU DOUANIER — 2026-09-12 =========================
 *
 * Dictées après trois blocages successifs en production. Elles ne se déduisent
 * pas du code : c'est une décision métier, et c'est à ce titre qu'elles sont
 * verrouillées ici.
 */
test('douanier 1 (modifiée le 2026-09-14) — AU PARC mais NON POINTÉ : saisie manuelle PERMISE', async () => {
  const db = new FakeDB();
  db.store['stock'].push({ numero_tc: 'MSKU5550001', taille: "20'", statut: 'En stock' });
  const { cfs, id } = await depotagePret(db, 'DOU001/RM01');
  await ecr.cfs(cfs, {
    id, declaration: DECL_PNT,
    conteneur: { num: 'MSKU5550001', taille: "20'", type: 'DRY', manuel: true },
  });
  const c = db.store['cargaisons'].find((x) => x['id'] === id)!;
  assert.match(JSON.stringify(c['conteneurs_details']), /MSKU5550001/);
  assert.equal(db.store['stock'].find((x) => x['numero_tc'] === 'MSKU5550001')!['statut'], 'Dépoté');
});

test('douanier 2 — DÉJÀ RATTACHÉ à un camion : saisie manuelle AUTORISÉE', async () => {
  const db = new FakeDB();
  db.store['stock'].push({ numero_tc: 'MSKU5550002', taille: "20'", statut: 'Dépoté' });
  const { cfs, id } = await depotagePret(db, 'DOU002/RM01');
  await ecr.cfs(cfs, {
    id, declaration: DECL_PNT,
    conteneur: { num: 'MSKU5550002', taille: "20'", type: 'DRY', manuel: true },
  });
  const c = db.store['cargaisons'].find((x) => x['id'] === id)!;
  assert.match(JSON.stringify(c['conteneurs_details']), /MSKU5550002/);
  // Et le stock n'est PAS ramené au parc : le conteneur en est parti.
  const stk = db.store['stock'].find((x) => x['numero_tc'] === 'MSKU5550002')!;
  assert.equal(stk['statut'], 'Dépoté');
});

test('douanier 3 — ABSENT du parc : saisie manuelle autorisée, fiche créée', async () => {
  const db = new FakeDB();
  const { cfs, id } = await depotagePret(db, 'DOU003/RM01');
  await ecr.cfs(cfs, {
    id, declaration: DECL_PNT,
    conteneur: { num: 'MSKU5550003', taille: "20'", type: 'DRY', manuel: true },
  });
  assert.ok(db.store['stock'].find((x) => x['numero_tc'] === 'MSKU5550003'),
    'la fiche doit être créée, sinon le conteneur échappe au parc et à l\'apurement');
});

test('tableau de bord : un camion QUITTE une file et ENTRE dans la suivante (2026-09-12)', async () => {
  // Demande utilisateur : quand le camion passe du CFS à la validation puis au
  // T1, la tuile qu'il quitte doit décompter et la suivante s'incrémenter.
  // La file CFS n'était comptée nulle part : le camion en chargement était invisible.
  const db = new FakeDB();
  db.store['stock'].push({ numero_tc: 'MSKU1234567', taille: "40'", statut: 'En stock' });
  const cfs = ctxAvec(db);
  const files = async () => {
    const s = (await lec.dashboardStats(cfs, {})) as Record<string, number>;
    return [s['attCFS'], s['attValidation'], s['attT1'], s['attBalise'], s['attBs'], s['attPP']];
  };
  const { id } = (await ecr.createcamion(cfs, { numeroCamion: 'TG1111AA', routage: 'Enlèvement' })) as { id: string };
  assert.deepEqual(await files(), [1, 0, 0, 0, 0, 0]);
  const decl = {
    declarant: 'STE X', contactDeclarant: '90123456', destinationMarchandise: 'LOME',
    bureauDeclaration: 'TG120', typeDeclaration: 'T', numeroDeclaration: '4242', anneeDeclaration: '2026',
    dateDeclaration: '2026-06-24', descriptionMarchandise: 'RIZ', nombreConteneurs: 1,
  };
  await ecr.cfs(cfs, { id, conteneur: { num: 'MSKU1234567', taille: "40'", type: 'DRY', plomb: 'SEAL1' }, declaration: decl });
  assert.deepEqual(await files(), [0, 1, 0, 0, 0, 0], 'CFS → validation');
  await ecr.valider(ctxRole(db, 'CHEF_BRIGADE', 'CB'), { id, enSurcharge: false, suiviEngagement: false });
  assert.deepEqual(await files(), [0, 0, 1, 0, 0, 0], 'validation → T1');
  await ecr.t1(ctxRole(db, 'T1', 'Agent T1'), { id, bureauDestination: 'TG120', t1Numeros: [{ conteneur: 'MSKU1234567', numero: 'T1-X' }] });
  const [c, v, t] = await files();
  assert.deepEqual([c, v, t], [0, 0, 0], 'T1 → étape suivante');
  // Invariant : un dossier actif est dans UNE file et une seule.
  assert.equal((await files()).reduce((a, b) => a + b, 0), 1);
});

test('véhicule : le même châssis ne peut pas être créé deux fois (732382 ×3, 2026-09-12)', async () => {
  const db = new FakeDB();
  db.store['stock'].push({ numero_tc: 'MSKU1234567', taille: "40'", statut: 'Positionné' },
    { numero_tc: 'TCLU7654321', taille: "40'", statut: 'Positionné' });
  const cfs = ctxAvec(db);
  const decl = { declarant: 'A', contactDeclarant: '901234', destinationMarchandise: 'D', bureauDeclaration: 'TG120', typeDeclaration: 'T', numeroDeclaration: '12', anneeDeclaration: '2026', dateDeclaration: '2026-06-24', descriptionMarchandise: 'X', nombreConteneurs: 2 };
  const creer = (tc: string, vehicules: unknown[]) => spe.create(cfs, { typeOperation: 'Dépotage / Véhicule', declaration: decl, conteneurOrigine: tc, vehicules });
  // Deux fois dans la même saisie : refusé, rien d'écrit.
  await assert.rejects(() => creer('MSKU1234567', [{ chassis: '732382', destination: 'Transit' }, { chassis: '732382', destination: 'Transit' }]),
    /figure deux fois/);
  assert.equal(db.store['cargaisons'].length, 0);
  // Le premier passe ; le second clic est refusé et nomme le dossier existant.
  await creer('MSKU1234567', [{ chassis: '732382', destination: 'Transit' }]);
  await assert.rejects(() => creer('TCLU7654321', [{ chassis: '732382', destination: 'Transit' }]), /déjà dans le système/);
  assert.equal(db.store['cargaisons'].length, 1);
});

test('véhicule : un châssis égal à la plaque d\'un CAMION présent n\'est pas un doublon (2026-09-12)', async () => {
  // Cas réels TG2944BI et TG6866BS/5821BE : le véhicule a été saisi avec la plaque
  // du camion porteur. Ce n'est pas le même dossier : on ne refuse pas.
  const db = new FakeDB();
  db.store['stock'].push({ numero_tc: 'MSKU1234567', taille: "40'", statut: 'Positionné' });
  const cfs = ctxAvec(db);
  await ecr.createcamion(cfs, { numeroCamion: 'TG2944BI', routage: 'Dépotage' });
  const decl = { declarant: 'A', contactDeclarant: '901234', destinationMarchandise: 'D', bureauDeclaration: 'TG120', typeDeclaration: 'T', numeroDeclaration: '13', anneeDeclaration: '2026', dateDeclaration: '2026-06-24', descriptionMarchandise: 'X', nombreConteneurs: 1 };
  await spe.create(cfs, { typeOperation: 'Dépotage / Véhicule', declaration: decl, conteneurOrigine: 'MSKU1234567',
    vehicules: [{ chassis: 'TG2944BI', destination: 'Transit' }] });
  assert.equal(db.store['cargaisons'].filter((c) => c['numero_camion'] === 'TG2944BI').length, 2);
});

test('tableau de bord : ↑ entrés / ↓ sortis de chaque file sur la période (2026-09-13)', async () => {
  const db = new FakeDB();
  db.store['stock'].push({ numero_tc: 'MSKU1234567', taille: "40'", statut: 'En stock' });
  const cfs = ctxAvec(db);
  const j = new Date();
  const aujourdhui = `${j.getFullYear()}-${String(j.getMonth() + 1).padStart(2, '0')}-${String(j.getDate()).padStart(2, '0')}`;
  const { id } = (await ecr.createcamion(cfs, { numeroCamion: 'TG2222BB', routage: 'Enlèvement' })) as { id: string };
  const decl = { declarant: 'STE X', contactDeclarant: '90123456', destinationMarchandise: 'LOME', bureauDeclaration: 'TG120', typeDeclaration: 'T', numeroDeclaration: '5151', anneeDeclaration: '2026', dateDeclaration: '2026-06-24', descriptionMarchandise: 'RIZ', nombreConteneurs: 1 };
  await ecr.cfs(cfs, { id, conteneur: { num: 'MSKU1234567', taille: "40'", type: 'DRY', plomb: 'SEAL1' }, declaration: decl });
  // Le déclencheur 00110 n'existe pas dans le double : on pose la date qu'il écrirait.
  db.store['cargaisons'].find((c) => c['id'] === id)!['date_fin_chargement'] = new Date().toISOString();
  await ecr.valider(ctxRole(db, 'CHEF_BRIGADE', 'CB'), { id, enSurcharge: false, suiviEngagement: false });

  const s = (await lec.dashboardStats(cfs, { du: aujourdhui, au: aujourdhui })) as { flux: Record<string, { entres: number; sortis: number }>; attT1: number };
  assert.deepEqual(s.flux['CFS'], { entres: 1, sortis: 1 }, 'a quitté le CFS');
  assert.deepEqual(s.flux['VALIDATION'], { entres: 1, sortis: 1 }, 'est passé par la validation');
  assert.deepEqual(s.flux['T1'], { entres: 1, sortis: 0 }, 'est entré au T1, pas encore sorti');
  assert.deepEqual(s.flux['BALISE'], { entres: 0, sortis: 0 });
  assert.equal(s.attT1, 1);
  // Période d'hier : rien ne s'y est passé.
  const hier = new Date(j.getTime() - 86400000);
  const h = `${hier.getFullYear()}-${String(hier.getMonth() + 1).padStart(2, '0')}-${String(hier.getDate()).padStart(2, '0')}`;
  const s2 = (await lec.dashboardStats(cfs, { du: h, au: h })) as { flux: Record<string, { entres: number; sortis: number }> };
  assert.deepEqual(s2.flux['T1'], { entres: 0, sortis: 0 });
});

/* ===== CONTENEUR PARTAGÉ : NON COMPTÉ — 2026-09-14 (demande utilisateur) ===== */
const lignes = (db: FakeDB, id: string) =>
  (db.store['cargaisons'].find((x) => x['id'] === id)!['conteneurs_details'] as { conteneurs: Record<string, unknown>[] }).conteneurs;

test('partagé — marqué sur le 2e camion, et compté UNE fois (fiche CFS, KPI, flux)', async () => {
  const db = new FakeDB();
  db.store['stock'].push({ numero_tc: 'MSKU5550009', taille: "40'", statut: 'Positionné' });
  // 1er camion : dépotage normal.
  const a = await depotagePret(db, 'DOU009/RM01');
  await ecr.cfs(a.cfs, { id: a.id, declaration: DECL_PNT, conteneur: { num: 'MSKU5550009', taille: "40'", type: 'DRY' } });
  const lienAvant = db.store['stock'].find((x) => x['numero_tc'] === 'MSKU5550009')!['cargaison_id'];
  // 2e camion : même conteneur, en saisie manuelle.
  const b = await depotagePret(db, 'DOU010/RM01');
  await ecr.cfs(b.cfs, { id: b.id, declaration: DECL_PNT, conteneur: { num: 'MSKU5550009', taille: "40'", type: 'DRY', manuel: true } });

  assert.equal(lignes(db, b.id)[0]!['partage'], true, 'la ligne du 2e camion est marquée partagée');
  assert.ok(!lignes(db, a.id)[0]!['partage'], 'le premier dépotage reste compté');
  assert.equal(db.store['stock'].find((x) => x['numero_tc'] === 'MSKU5550009')!['cargaison_id'], lienAvant,
    'la fiche garde son premier camion');

  const f = (await rap.ficheBord(a.cfs, {})) as { cfs: { total: { conteneurs: number } } };
  assert.equal(f.cfs.total.conteneurs, 1, 'une seule boîte dépotée');
  const kpi = (await rap.rapportKPI(a.cfs, {})) as { videsDepotage: number; evpVides: number };
  assert.equal(kpi.videsDepotage, 1, 'KPI : le partagé comptait deux fois avant le 14/09');
  assert.equal(kpi.evpVides, 2);
  const flux = (await rap.rapportFlux(a.cfs, {})) as { totaux: { depotesC: number; evp: number } };
  assert.equal(flux.totaux.depotesC, 1, 'flux : le partagé comptait deux fois avant le 14/09');
  assert.equal(flux.totaux.evp, 2);
});

test('partagé — compté NULLE PART, même quand le premier dépotage tombe dans une autre période', async () => {
  // Le repérage par numéro ne voyait que la période choisie : ce cas lui échappait.
  const db = new FakeDB();
  const cfs = ctxRole(db, 'CFS', 'A');
  const j = new Date();
  const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const du = iso(new Date(j.getTime() - 86400000)), au = iso(new Date(j.getTime() + 86400000));
  const now = j.toISOString();
  db.store['cargaisons'].push({
    id: 'P1', reference: 'P1', numero_camion: 'P1', statut: 'Balisée', date_creation: now, date_pose_gps: now, rapport_id: 'R',
    type_operation: 'Dépotage', type_declaration: 'T', agent_balise: 'B', nb_conteneurs: 1,
    conteneurs_details: { conteneurs: [{ num: 'MSKU5550010', taille: "40'", type: 'DRY', plomb: '', partage: true }], scellesCamion: [] },
  });
  const f = (await rap.ficheBord(cfs, { du, au })) as { cfs: { camionsCfs: number; total: { conteneurs: number } } };
  assert.equal(f.cfs.camionsCfs, 1, 'le camion, lui, est bien compté');
  assert.equal(f.cfs.total.conteneurs, 0);
  const r = (await rap.rapportActivite(cfs, { kind: 'balise', du, au })) as { total: { camions: number; conteneurs: number; evp: number } };
  assert.equal(r.total.camions, 1);
  assert.equal(r.total.conteneurs, 0);
  assert.equal(r.total.evp, 0);
});

test('engagement — la correction reste possible APRÈS « Effectué » (2026-09-17)', async () => {
  // Demande utilisateur : un clic de trop sur « Effectué » figeait l'erreur.
  const db = new FakeDB();
  const chef = ctxRole(db, 'CHEF_BRIGADE', 'Chef Brigade');
  const traces: { action: string; detail: string }[] = [];
  const chefTrace = { ...chef, log: async (action: string, _cible: string, detail: string) => { traces.push({ action, detail }); } };
  db.store['cargaisons'].push({
    id: 'ENG-1', reference: 'ENG-1', numero_camion: 'TG1234AB', statut: 'Créée', rapport_id: 'R',
    date_creation: new Date().toISOString(), type_operation: 'Dépotage', nb_conteneurs: 0,
    conteneurs_details: { conteneurs: [], scellesCamion: [] },
    suivi_engagement: true, engagement_type: 'BFE 03 Sinkase', engagement_delai: '2026-10-01',
    date_validation: new Date().toISOString(),
  });
  await ecr.engagementFait(chef, { id: 'ENG-1' });
  const apresSolde = db.store['cargaisons'].find((x) => x['id'] === 'ENG-1')!;
  assert.ok(apresSolde['engagement_effectue_le'], 'le solde est bien enregistré');

  await ecr.engagementEdit(chefTrace as never, {
    id: 'ENG-1', engagementType: 'Transit national', engagementDelai: '2026-10-05',
    motif: 'erreur de saisie : BFE 03 au lieu de Transit national',
  });
  const c = db.store['cargaisons'].find((x) => x['id'] === 'ENG-1')!;
  assert.equal(c['engagement_type'], 'Transit national');
  assert.equal(String(c['engagement_delai']).slice(0, 10), '2026-10-05');
  assert.ok(c['engagement_effectue_le'], 'le solde reste : corriger n\'est pas rouvrir');
  assert.match(traces.map((t) => t.action).join(' '), /APRÈS SOLDE/, 'le journal signale la correction après solde');
  assert.match(traces.map((t) => t.detail).join(' '), /déjà soldé le/);
});

/* ===== RETRAIT D'UN ENGAGEMENT — 2026-09-17 (demande utilisateur) ========== */
function cargoEngage(db: FakeDB, id: string, over: Record<string, unknown> = {}) {
  db.store['cargaisons'].push({
    id, reference: id, numero_camion: 'TG' + id, statut: 'Créée', rapport_id: 'R',
    date_creation: new Date().toISOString(), type_operation: 'Dépotage', nb_conteneurs: 0,
    conteneurs_details: { conteneurs: [], scellesCamion: [] },
    suivi_engagement: true, engagement_type: 'BFE 03 Sinkase', engagement_delai: '2026-10-01',
    date_validation: new Date().toISOString(), ...over,
  });
}

test('engagement — RETRAIT : le suivi disparaît, et le journal garde ce qui a été retiré', async () => {
  const db = new FakeDB();
  const traces: { action: string; detail: string }[] = [];
  const chef = { ...ctxRole(db, 'CHEF_BRIGADE', 'Chef Brigade'),
    log: async (action: string, _c: string, detail: string) => { traces.push({ action, detail }); } };
  cargoEngage(db, 'ENG-R1');
  await ecr.engagementRetirer(chef as never, { id: 'ENG-R1', motif: 'coché par erreur : ce camion n\'a pas d\'engagement' });
  const c = db.store['cargaisons'].find((x) => x['id'] === 'ENG-R1')!;
  assert.equal(c['suivi_engagement'], false);
  assert.equal(c['engagement_type'], null);
  assert.equal(c['engagement_delai'], null);
  assert.match(traces.map((t) => t.action).join(' '), /Retrait du suivi d'engagement/);
  assert.match(traces.map((t) => t.detail).join(' '), /BFE 03 Sinkase/, 'le journal garde l\'engagement retiré');
  assert.match(traces.map((t) => t.detail).join(' '), /motif : coché par erreur/);
});

test('engagement — RETRAIT : motif obligatoire, et rien à retirer sans engagement', async () => {
  const db = new FakeDB();
  const chef = ctxRole(db, 'CHEF_BRIGADE', 'Chef Brigade');
  cargoEngage(db, 'ENG-R2');
  await assert.rejects(() => ecr.engagementRetirer(chef, { id: 'ENG-R2' }), /motif du retrait/i);
  assert.equal(db.store['cargaisons'].find((x) => x['id'] === 'ENG-R2')!['suivi_engagement'], true,
    'un refus ne doit rien écrire');
  cargoEngage(db, 'ENG-R3', { suivi_engagement: false, engagement_type: null, engagement_delai: null });
  await assert.rejects(() => ecr.engagementRetirer(chef, { id: 'ENG-R3', motif: 'x' }), /pas sous suivi d'engagement/i);
});

test('engagement — RETRAIT : possible aussi après « Effectué », le solde est efface avec le reste', async () => {
  const db = new FakeDB();
  const chef = ctxRole(db, 'CHEF_BRIGADE', 'Chef Brigade');
  cargoEngage(db, 'ENG-R4');
  await ecr.engagementFait(chef, { id: 'ENG-R4' });
  await ecr.engagementRetirer(chef, { id: 'ENG-R4', motif: 'engagement saisi sur le mauvais camion' });
  const c = db.store['cargaisons'].find((x) => x['id'] === 'ENG-R4')!;
  assert.equal(c['suivi_engagement'], false);
  assert.equal(c['engagement_effectue_le'], null);
});

test('volet Engagements — le filtre sert les deux ecrans sans changer le tableau de bord', async () => {
  const db = new FakeDB();
  const chef = ctxRole(db, 'CHEF_BRIGADE', 'Chef Brigade');
  const jour = (n: number) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
  cargoEngage(db, 'E-RETARD', { engagement_delai: jour(-3) });
  cargoEngage(db, 'E-DEMAIN', { engagement_delai: jour(1) });
  cargoEngage(db, 'E-LOIN', { engagement_delai: jour(20) });
  cargoEngage(db, 'E-SOLDE', { engagement_delai: jour(5), engagement_effectue_le: new Date().toISOString() });

  const ids = async (filtre?: string) => {
    const r = (await lec.engagementsDus(chef, filtre ? { filtre } : {})) as { lignes: { id: string }[] };
    return r.lignes.map((l) => l.id).sort();
  };
  // Sans parametre : comportement d'avant — seules les alertes, soldes exclus.
  assert.deepEqual(await ids(), ['E-DEMAIN', 'E-RETARD'], 'le tableau de bord ne doit pas changer');
  assert.deepEqual(await ids('encours'), ['E-DEMAIN', 'E-LOIN', 'E-RETARD'], 'les echeances lointaines aussi');
  assert.deepEqual(await ids('retard'), ['E-RETARD']);
  assert.deepEqual(await ids('solde'), ['E-SOLDE']);
  assert.deepEqual(await ids('tous'), ['E-DEMAIN', 'E-LOIN', 'E-RETARD', 'E-SOLDE']);

  const tous = (await lec.engagementsDus(chef, { filtre: 'tous' })) as { compte: Record<string, number>; lignes: { etat: string }[] };
  assert.equal(tous.compte['total'], 4);
  assert.equal(tous.compte['solde'], 1);
  assert.equal(tous.compte['retard'], 1);
  assert.equal(tous.lignes.filter((l) => l.etat === 'solde').length, 1, 'un engagement solde est marque comme tel');
});

test('engagements — compteurs : le total baisse quand un engagement est soldé (2026-09-17)', async () => {
  const db = new FakeDB();
  const chef = ctxRole(db, 'CHEF_BRIGADE', 'Chef Brigade');
  const jour = (n: number) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
  cargoEngage(db, 'K-1', { engagement_delai: jour(-1) });
  cargoEngage(db, 'K-2', { engagement_delai: jour(2) });
  cargoEngage(db, 'K-3', { engagement_delai: jour(30) });

  const dash = async () => ((await lec.dashboardStats(chef, {})) as Record<string, number>)['engagementsEnCours'];
  const volet = async () => ((await lec.engagementsDus(chef, { filtre: 'encours' })) as { global: Record<string, number> }).global;

  assert.equal(await dash(), 3, 'les trois engagements sont en cours');
  assert.deepEqual(await volet(), { encours: 3, soldes: 0, total: 3 });

  await ecr.engagementFait(chef, { id: 'K-2' });
  assert.equal(await dash(), 2, 'le tableau de bord baisse d\'un cran');
  assert.deepEqual(await volet(), { encours: 2, soldes: 1, total: 3 }, 'les deux compteurs du volet se repondent');

  // Les compteurs du volet ne dependent PAS de la vue affichee.
  const enSolde = (await lec.engagementsDus(chef, { filtre: 'solde' })) as { global: Record<string, number>; lignes: unknown[] };
  assert.deepEqual(enSolde.global, { encours: 2, soldes: 1, total: 3 });
  assert.equal(enSolde.lignes.length, 1, 'mais la liste affichee, elle, suit le filtre');

  // Retire : l'engagement quitte les deux compteurs.
  await ecr.engagementRetirer(ctxRole(db, 'ADMIN', 'Admin'), { id: 'K-1', motif: 'coche par erreur' });
  assert.equal(await dash(), 1);
  assert.deepEqual(await volet(), { encours: 1, soldes: 1, total: 2 });
});

test('tableau de bord — arrivées / départs des engagements sur la période (2026-09-21)', async () => {
  const db = new FakeDB();
  const chef = ctxRole(db, 'CHEF_BRIGADE', 'Chef Brigade');
  const j = new Date();
  const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const aujourdhui = iso(j);
  const ilYA10j = new Date(j.getTime() - 10 * 86400000).toISOString();
  // Deux engagements signés aujourd'hui, un signé il y a 10 jours.
  cargoEngage(db, 'F-1', { date_validation: j.toISOString() });
  cargoEngage(db, 'F-2', { date_validation: j.toISOString() });
  cargoEngage(db, 'F-3', { date_validation: ilYA10j });
  const flux = async () => ((await lec.dashboardStats(chef, { du: aujourdhui, au: aujourdhui })) as { flux: Record<string, { entres: number; sortis: number }> }).flux['ENGAGEMENTS'];

  assert.deepEqual(await flux(), { entres: 2, sortis: 0 }, 'deux engagements posés aujourd\'hui');
  // Solder aujourd'hui l'engagement ancien : un départ, aucune arrivée de plus.
  await ecr.engagementFait(chef, { id: 'F-3' });
  assert.deepEqual(await flux(), { entres: 2, sortis: 1 });
  // Un retrait efface l'engagement : il ne compte plus comme arrivé.
  await ecr.engagementRetirer(ctxRole(db, 'ADMIN', 'Admin'), { id: 'F-1', motif: 'coche par erreur' });
  assert.deepEqual(await flux(), { entres: 1, sortis: 1 });
});

/* ===================== PARAMÈTRES — 2026-09-21 ============================ */
test('paramètres — défauts tant que rien n\'est réglé, puis valeurs enregistrées et tracées', async () => {
  const db = new FakeDB();
  const traces: string[] = [];
  const admin = { ...ctxRole(db, 'ADMIN', 'Admin'), log: async (a: string, _c?: string, d?: string) => { traces.push(a + ' ' + d); } };
  const g = (await prm.paramsGet(admin)) as { valeurs: Record<string, unknown>; active: boolean };
  assert.equal(g.valeurs['sejourAlerteJours'], 90);
  assert.equal(g.active, true);

  await prm.paramsSet(admin, { valeurs: { sejourAlerteJours: 30, engagementsProposes: 'Transit national\nNouveau regime' } });
  const g2 = (await prm.paramsGet(admin)) as { valeurs: Record<string, unknown>; modifs: Record<string, { majPar: string }> };
  assert.equal(g2.valeurs['sejourAlerteJours'], 30);
  assert.deepEqual(g2.valeurs['engagementsProposes'], ['Transit national', 'Nouveau regime']);
  assert.equal(g2.modifs['sejourAlerteJours']?.majPar, 'Admin');
  assert.match(traces.join(' | '), /Paramètre modifié .*90 → 30/);

  // Valeur fausse : le LOT entier est refusé, rien n'est écrit.
  await assert.rejects(() => prm.paramsSet(admin, { valeurs: { sejourAlerteJours: 5, archiveMois: 24 } }), /entre 7 et 365/);
  const g3 = (await prm.paramsGet(admin)) as { valeurs: Record<string, unknown> };
  assert.equal(g3.valeurs['sejourAlerteJours'], 30);
  assert.equal(g3.valeurs['archiveMois'], 12, 'la valeur juste du lot refusé n\'a pas été écrite');

  // Rétablir le défaut.
  await prm.paramsSet(admin, { valeurs: { sejourAlerteJours: null } });
  assert.equal(((await prm.paramsGet(admin)) as { valeurs: Record<string, unknown> }).valeurs['sejourAlerteJours'], 90);
});

test('paramètres — table absente : défauts appliqués, enregistrement refusé avec explication', async () => {
  const base = new FakeDB();
  const db = {
    from: (t: string) => t === 'parametres_app'
      ? { select: () => Promise.resolve({ data: null, error: { message: 'relation "parametres_app" does not exist' } }) }
      : base.from(t),
  };
  const admin = { ...ctxRole(base, 'ADMIN', 'Admin'), db: db as never };
  const g = (await prm.paramsGet(admin)) as { valeurs: Record<string, unknown>; active: boolean };
  assert.equal(g.active, false);
  assert.equal(g.valeurs['conteneursMaxCamion'], 50, 'le comportement d\'avant s\'applique');
  await assert.rejects(() => prm.paramsSet(admin, { valeurs: { archiveMois: 24 } }), /pas encore activés/);
});

test('paramètres — le seuil de séjour change le nombre de conteneurs en alerte', async () => {
  const db = new FakeDB();
  const il40j = new Date(Date.now() - 40 * 86400000).toISOString();
  db.store['stock'].push({ numero_tc: 'MSKU0000001', taille: "20'", statut: 'En stock', date_entree: il40j });
  const admin = ctxRole(db, 'ADMIN', 'Admin');
  assert.equal(((await stk.rapportStock(ctxRole(db, 'CFS', 'A'))) as { compte: { alerte: number } }).compte.alerte, 0, '40 j < 90 j');
  await prm.paramsSet(admin, { valeurs: { sejourAlerteJours: 30 } });
  const r = (await stk.rapportStock(ctxRole(db, 'CFS', 'A'))) as { compte: { alerte: number }; seuil: number };
  assert.equal(r.compte.alerte, 1, '40 j >= 30 j');
  assert.equal(r.seuil, 30);
});

test('paramètres — plafond de conteneurs par camion en dépotage', async () => {
  const db = new FakeDB();
  db.store['stock'].push({ numero_tc: 'MSKU6660011', taille: "20'", statut: 'Positionné' }, { numero_tc: 'MSKU6660012', taille: "20'", statut: 'Positionné' });
  await prm.paramsSet(ctxRole(db, 'ADMIN', 'Admin'), { valeurs: { conteneursMaxCamion: 1 } });
  const { cfs, id } = await depotagePret(db, 'PRM001/RM01');
  await ecr.cfs(cfs, { id, declaration: DECL_PNT, conteneur: { num: 'MSKU6660011', taille: "20'", type: 'DRY' } });
  await assert.rejects(() => ecr.cfs(cfs, { id, declaration: DECL_PNT, conteneur: { num: 'MSKU6660012', taille: "20'", type: 'DRY' } }), /max 1/);
});

test('paramètres — l\'alerte d\'engagement remonte N jours avant l\'échéance', async () => {
  const db = new FakeDB();
  const jour = (n: number) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
  cargoEngage(db, 'P-3J', { engagement_delai: jour(3) });
  const ids = async () => ((await lec.engagementsDus(ctxRole(db, 'CHEF_BRIGADE', 'CB'))) as { lignes: { id: string }[] }).lignes.map((l) => l.id);
  assert.deepEqual(await ids(), [], 'la veille par défaut : J-3 ne remonte pas encore');
  await prm.paramsSet(ctxRole(db, 'ADMIN', 'Admin'), { valeurs: { engagementAlerteJours: 3 } });
  assert.deepEqual(await ids(), ['P-3J'], 'réglé à 3 jours : il remonte');
});

test('paramètres — seuil hors gabarit : 4,2 m passe à 4,0 m réglé', async () => {
  const db = new FakeDB();
  db.store['stock'].push({ numero_tc: 'MSKU6660021', taille: "20'", statut: 'Positionné' }, { numero_tc: 'MSKU6660022', taille: "20'", statut: 'Positionné' });
  const gab = (id: string) => db.store['cargaisons'].find((c) => c['id'] === id)?.['hors_gabarit'];
  const a = await depotagePret(db, 'GAB001/RM01');
  await ecr.cfs(a.cfs, { id: a.id, declaration: DECL_PNT, conteneur: { num: 'MSKU6660021', taille: "20'", type: 'DRY' } });
  await ecr.declaration(a.cfs, { id: a.id, hauteurChargement: '4,2', nbColis: '10', scellesCamion: ['S1', 'S2'] });
  assert.equal(gab(a.id), null, 'défaut 4,5 m : 4,2 m reste dans le gabarit');
  await prm.paramsSet(ctxRole(db, 'ADMIN', 'Admin'), { valeurs: { hauteurHorsGabarit: 4 } });
  const b = await depotagePret(db, 'GAB002/RM01');
  await ecr.cfs(b.cfs, { id: b.id, declaration: { ...DECL_PNT, numeroDeclaration: '961' }, conteneur: { num: 'MSKU6660022', taille: "20'", type: 'DRY' } });
  await ecr.declaration(b.cfs, { id: b.id, hauteurChargement: '4,2', nbColis: '10', scellesCamion: ['S3', 'S4'] });
  assert.equal(gab(b.id), true, 'réglé à 4,0 m : 4,2 m est hors gabarit');
});

test("paramètres — ancienneté par défaut de l'archive", async () => {
  const db = new FakeDB();
  const ilYa = (m: number) => { const d = new Date(); d.setMonth(d.getMonth() - m); return d.toISOString(); };
  db.store['cargaisons'].push(
    { id: 'A8', numero_camion: 'A8', date_creation: ilYa(8), statut: 'Sortie' },
    { id: 'A14', numero_camion: 'A14', date_creation: ilYa(14), statut: 'Sortie' },
  );
  const admin = ctxRole(db, 'ADMIN', 'Admin');
  const ids = async (p: Record<string, unknown> = {}) =>
    ((await lec.archiveAncienne(admin, p)) as { lignes?: { id: string }[]; mois: number });
  const r1 = await ids();
  assert.equal(r1.mois, 12);
  await prm.paramsSet(admin, { valeurs: { archiveMois: 6 } });
  const r2 = await ids();
  assert.equal(r2.mois, 6, "sans choix explicite, le réglage s'applique");
  assert.equal((await ids({ mois: 24 })).mois, 24, "un choix explicite l'emporte");
});

test('paramètres — plafond de conteneurs aussi à la création groupée et à la correction', async () => {
  const db = new FakeDB();
  await prm.paramsSet(ctxRole(db, 'ADMIN', 'Admin'), { valeurs: { conteneursMaxCamion: 1 } });
  const conts = [{ num: 'MSKU6660031', taille: "20'", type: 'DRY', plomb: 'P1' }, { num: 'MSKU6660032', taille: "20'", type: 'DRY', plomb: 'P2' }];
  await assert.rejects(() => spe.create(ctxAvec(db), {
    typeOperation: 'Enlèvement', declaration: DECL_OK, camions: [{ numeroCamion: 'MAX001/RM01', conteneurs: conts }],
  }), /max 1/);
  await assert.rejects(() => ecr.update(ctxRole(db, 'ADMIN', 'Admin'), {
    id: 'X', typeOperation: 'Enlèvement', declaration: DECL_OK, numeroCamion: 'MAX002/RM01', conteneurs: conts, scellesCamion: [],
  }), /max 1/);
});

/* ------------------------------- PARKING -------------------------------- */

test('parking : ajout + pointage du jour, un seul par jour', async () => {
  const db = new FakeDB();
  const agent = ctxRole(db, 'BALISE', 'Agent Balise');
  const r = (await prk.parkingAdd(agent, { numeroCamion: 'TG1234AB/RM01', numeroConteneur: 'MSKU1234567', plomb: 'PL-77' })) as { id: string; pointe: boolean };
  assert.equal(r.pointe, true, "l'ajout pointe le camion dans la foulée");
  assert.equal(db.store['parking_pointages'].length, 1);
  // Deuxième pointage le même jour : refusé.
  await assert.rejects(() => prk.parkingPointer(agent, { id: r.id }), /DÉJÀ POINTÉ/);
  assert.equal(db.store['parking_pointages'].length, 1);
  // Et le même camion ne peut pas être ajouté deux fois tant qu'il est présent.
  await assert.rejects(() => prk.parkingAdd(agent, { numeroCamion: 'tg1234ab/rm01' }), /DÉJÀ au parking/);
});

test('parking : ajout sans pointer, puis pointage le lendemain', async () => {
  const db = new FakeDB();
  const agent = ctxRole(db, 'T1', 'Agent T1');
  const r = (await prk.parkingAdd(agent, { numeroCamion: 'TG2222CD/RM02', pointer: false })) as { id: string; pointe: boolean };
  assert.equal(r.pointe, false);
  const l1 = (await prk.parkingList(agent, {})) as { lignes: { pointeAujourdhui: boolean }[]; compte: { presents: number; pointes: number; restants: number } };
  assert.deepEqual(l1.compte, { presents: 1, pointes: 0, restants: 1 });
  assert.equal(l1.lignes[0]?.pointeAujourdhui, false);
  await prk.parkingPointer(agent, { id: r.id });
  const l2 = (await prk.parkingList(agent, {})) as { lignes: { pointeAujourdhui: boolean }[]; compte: { pointes: number; restants: number } };
  assert.equal(l2.lignes[0]?.pointeAujourdhui, true, 'le bouton « Pointer » disparaît ensuite');
  assert.deepEqual(l2.compte.pointes, 1);
  assert.deepEqual(l2.compte.restants, 0);
  // Un pointage de la veille ne bloque pas celui du jour : la ligne existe par jour.
  db.store['parking_pointages'].push({ id: r.id + '#2026-09-23', parking_id: r.id, jour: '2026-09-23', pointe_par: 'Hier' });
  const d = (await prk.parkingDetail(agent, { id: r.id })) as { pointages: unknown[] };
  assert.equal(d.pointages.length, 2, "l'historique garde chaque jour pointé");
});

test('parking : recherche au fil de la frappe sur la plaque', async () => {
  const db = new FakeDB();
  const agent = ctxRole(db, 'CFS', 'Agent CFS');
  await prk.parkingAdd(agent, { numeroCamion: 'TG2489BK/2725BP' });
  await prk.parkingAdd(agent, { numeroCamion: 'TG7777ZZ/RM09' });
  const plaques = async (q: string) =>
    ((await prk.parkingList(agent, { recherche: q })) as { lignes: { numeroCamion: string }[] }).lignes.map((l) => l.numeroCamion);
  assert.deepEqual(await plaques('2'), ['TG7777ZZ/RM09', 'TG2489BK/2725BP'].filter((p) => p.replace(/[^A-Z0-9]/g, '').includes('2')));
  assert.deepEqual(await plaques('248'), ['TG2489BK/2725BP']);
  assert.deepEqual(await plaques('tg 2489 bk'), ['TG2489BK/2725BP'], 'espaces et minuscules ignorés');
  assert.deepEqual(await plaques('9999'), []);
});

test('parking : plaque obligatoire et format contrôlé', async () => {
  const db = new FakeDB();
  const agent = ctxRole(db, 'PP', 'Agent PP');
  await assert.rejects(() => prk.parkingAdd(agent, { numeroCamion: '' }), /N° camion requis/);
  await assert.rejects(() => prk.parkingAdd(agent, { numeroCamion: 'AB' }), /camion/i);
});

test('parking : le camion signalé à la Porte Principale sort du parking', async () => {
  const db = new FakeDB();
  db.store['stock'].push({ numero_tc: 'MSKU7000001', taille: "20'", statut: 'En stock' });
  const cfs = ctxAvec(db);
  const agent = ctxRole(db, 'PP', 'Agent PP');
  const plaque = 'TG5555EE/RM05';
  await prk.parkingAdd(agent, { numeroCamion: plaque });
  const avant = (await prk.parkingCheck(cfs, { numeroCamion: 'tg5555ee/rm05' })) as { present: boolean };
  assert.equal(avant.present, true, 'la saisie CFS est prévenue que le camion est au parking');

  // Un dossier complet pour ce camion, jusqu'à la sortie PP.
  const r = (await spe.create(cfs, {
    typeOperation: 'Enlèvement', declaration: DECL_OK,
    camions: [{ numeroCamion: plaque, conteneurs: [{ num: 'MSKU7000001', taille: "20'", type: 'DRY', plomb: 'S1' }] }],
  })) as { camions: { id: string }[] };
  const id = r.camions[0]!.id;
  await ecr.t1(ctxRole(db, 'T1', 'Agent T1'), {
    id, bureauDestination: 'TG120', t1Numeros: [{ conteneur: 'MSKU7000001', numero: 'T1-A' }],
  });
  await ecr.gps(ctxRole(db, 'BALISE', 'Agent Balise'), { id, baliseRequise: 'Oui', t1Correct: 'Oui', numeroGPS: 'GPS-1' });
  await ecr.bonsortie(ctxRole(db, 'BON_SORTIE', 'Agent BS'), {
    id, bonSortieNumero: [{ conteneur: 'MSKU7000001', t1: 'T1-A', numero: 'BS-1' }],
  });
  await ecr.sortie(agent, { id, ckCfs: true, ckT1: true, ckBalise: true, ckBs: true });

  const apres = (await prk.parkingCheck(cfs, { numeroCamion: plaque })) as { present: boolean };
  assert.equal(apres.present, false, 'sorti du parking une fois signalé à la PP');
  const ligne = db.store['parking_camions'][0]!;
  assert.equal(ligne['statut'], 'Sorti');
  assert.equal(ligne['sortie_cargaison'], id);
  // Et il ne se pointe plus.
  await assert.rejects(() => prk.parkingPointer(agent, { id: String(ligne['id']) }), /sorti du parking/);
});

test("parking : sortie manuelle réservée à l'ADMIN, motif obligatoire", async () => {
  const db = new FakeDB();
  const admin = ctxRole(db, 'ADMIN', 'Admin');
  const { id } = (await prk.parkingAdd(admin, { numeroCamion: 'TG9999YY/RM07' })) as { id: string };
  await assert.rejects(() => prk.parkingSortie(admin, { id }), /Motif/);
  await prk.parkingSortie(admin, { id, motif: 'Reparti à vide' });
  assert.equal(db.store['parking_camions'][0]?.['statut'], 'Sorti');
  const permis = (role: string, action: string) => {
    try { verifierPermission(role, action); return true; } catch { return false; }
  };
  assert.equal(permis('CFS', 'parking.sortie'), false, 'un agent ne sort pas un camion à la main');
  assert.equal(permis('CFS', 'parking.point'), true, 'mais tout agent pointe');
  assert.equal(permis('BALISE', 'parking.add'), true);
  assert.equal(permis('PP', 'parking.list'), true);
});
