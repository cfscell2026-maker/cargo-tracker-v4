/**
 * Test d'intégration : cycle de vie COMPLET d'un enlèvement à travers les
 * handlers serveur réels (createcamion → cfs → valider → t1 → gps → bonsortie
 * → sortie) sur une base en mémoire. Vérifie les transitions de statut, le
 * parallélisme Balise/Bon de sortie, l'apurement et le décompte du stock.
 * Exécutable : `node --test`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STATUTS, etapesEnAttente } from '../../_shared/domaine/src/index.ts';
import { versCamel, type Ctx } from '../ctx.ts';
import { FakeDB } from './fake-db.ts';
import * as ecr from './ecriture.ts';
import * as spe from './speciaux.ts';

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
  const cree = (await ecr.createcamion(cfs, { numeroCamion: 'AB1234CD', routage: 'Enlèvement' })) as { id: string };
  const id = cree.id;
  assert.equal(statutDe(db, id), STATUTS.CAMION);

  // 2) CFS associe le 1er conteneur + déclaration complète → « Créée ».
  const decl = {
    declarant: 'STE X', contactDeclarant: '90123456', destinationMarchandise: 'LOME',
    bureauDeclaration: 'TG120', typeDeclaration: 'T', numeroDeclaration: '777', anneeDeclaration: '2026',
    descriptionMarchandise: 'RIZ', nombreConteneurs: 2,
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
  await ecr.valider(ctxRole(db, 'CHEF_BRIGADE', 'Chef Brigade'), { id });
  assert.ok(db.store['cargaisons'][0]!['date_validation']);
  assert.deepEqual(etapesEnAttente(versCamel(db.store['cargaisons'][0]!) as never), ['T1']);

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
  assert.deepEqual(etapesEnAttente(versCamel(db.store['cargaisons'][0]!) as never), ['BS']);

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
  const { id } = (await ecr.createcamion(cfs, { numeroCamion: 'CONSO1', routage: 'Enlèvement' })) as { id: string };
  await ecr.cfs(cfs, {
    id, conteneur: { num: 'MSKU1234567', taille: "40'", type: 'DRY', plomb: 'S1' },
    declaration: { declarant: 'A', contactDeclarant: '901234', destinationMarchandise: 'D', bureauDeclaration: 'TG120', typeDeclaration: 'C', numeroDeclaration: '1', anneeDeclaration: '2026', descriptionMarchandise: 'X', nombreConteneurs: 1 },
    consoMode: 'balise',
  });
  const c = versCamel(db.store['cargaisons'][0]!);
  assert.equal(c['sauteT1'], true);
  assert.equal(c['sauteBalise'], false);
  // Après validation : le T1 est sauté → Balise ET Bon de sortie en attente.
  await ecr.valider(ctxRole(db, 'CHEF_BRIGADE', 'CB'), { id });
  assert.deepEqual(etapesEnAttente(versCamel(db.store['cargaisons'][0]!) as never), ['BALISE', 'BS']);
});

test('déclaration type C non balisée : saute le T1 ET la Balise', async () => {
  const db = new FakeDB();
  db.store['stock'].push({ numero_tc: 'MSKU1234567', taille: "40'", statut: 'En stock' });
  const cfs = ctxAvec(db);
  const { id } = (await ecr.createcamion(cfs, { numeroCamion: 'CONSO2', routage: 'Enlèvement' })) as { id: string };
  await ecr.cfs(cfs, {
    id, conteneur: { num: 'MSKU1234567', taille: "40'", type: 'DRY', plomb: 'S1' },
    declaration: { declarant: 'A', contactDeclarant: '901234', destinationMarchandise: 'D', bureauDeclaration: 'TG120', typeDeclaration: 'C', numeroDeclaration: '2', anneeDeclaration: '2026', descriptionMarchandise: 'X', nombreConteneurs: 1 },
    consoMode: 'sansbalise',
  });
  const c = versCamel(db.store['cargaisons'][0]!);
  assert.equal(c['sauteT1'], true);
  assert.equal(c['sauteBalise'], true);
  // Après validation : T1 et Balise sautés → seul le Bon de sortie reste.
  await ecr.valider(ctxRole(db, 'CHEF_BRIGADE', 'CB'), { id });
  assert.deepEqual(etapesEnAttente(versCamel(db.store['cargaisons'][0]!) as never), ['BS']);
});

test('véhicule : le conteneur d\'origine (TC) est obligatoire', async () => {
  const db = new FakeDB();
  const cfs = ctxAvec(db);
  const decl = { declarant: 'A', contactDeclarant: '901234', destinationMarchandise: 'D', bureauDeclaration: 'TG120', typeDeclaration: 'T', numeroDeclaration: '9', anneeDeclaration: '2026', descriptionMarchandise: 'X', nombreConteneurs: 1 };
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
  const decl = { declarant: 'A', contactDeclarant: '901234', destinationMarchandise: 'D', bureauDeclaration: 'TG120', typeDeclaration: 'T', numeroDeclaration: '10', anneeDeclaration: '2026', descriptionMarchandise: 'X', nombreConteneurs: 3 };
  await spe.create(cfs, {
    typeOperation: 'Dépotage / Véhicule', declaration: decl, conteneurOrigine: 'MSKU1234567',
    vehicules: [{ chassis: 'VIN123', destination: 'Transit' }],
    camions: [
      // terminé → scellés exigés, statut « Créée »
      { numeroCamion: 'CAM-FINI', chargementTermine: true, conteneurs: [{ num: 'TCLU7654321', taille: "20'", type: 'DRY' }], scellesCamion: ['S1', 'S2'] },
      // pas terminé → scellés NON exigés, statut « En cours de chargement »
      { numeroCamion: 'CAM-ENCOURS', chargementTermine: false, conteneurs: [{ num: 'ABCU1111111', taille: "20'", type: 'DRY' }], scellesCamion: [] },
    ],
  });
  const fini = db.store['cargaisons'].find((c) => c['numero_camion'] === 'CAM-FINI');
  const enCours = db.store['cargaisons'].find((c) => c['numero_camion'] === 'CAM-ENCOURS');
  assert.equal(fini?.['statut'], STATUTS.CREEE);
  assert.equal(enCours?.['statut'], STATUTS.CHARGEMENT);
});

test('garde-fou : sortie refusée si le Bon de sortie manque', async () => {
  const db = new FakeDB();
  db.store['stock'].push({ numero_tc: 'MSKU1234567', taille: "40'", statut: 'En stock' });
  const cfs = ctxAvec(db);
  const { id } = (await ecr.createcamion(cfs, { numeroCamion: 'ZZ99', routage: 'Enlèvement' })) as { id: string };
  await ecr.cfs(cfs, {
    id, conteneur: { num: 'MSKU1234567', taille: "40'", type: 'DRY', plomb: 'S1' },
    declaration: { declarant: 'A', contactDeclarant: '901234', destinationMarchandise: 'D', bureauDeclaration: 'TG120', typeDeclaration: 'T', numeroDeclaration: '1', anneeDeclaration: '2026', descriptionMarchandise: 'X', nombreConteneurs: 1 },
  });
  await ecr.valider(ctxRole(db, 'CHEF_BRIGADE', 'CB'), { id });
  await ecr.t1(ctxRole(db, 'T1', 'T1'), { id, bureauDestination: 'TG120', t1Numeros: [{ conteneur: 'MSKU1234567', numero: 'T1' }] });
  await ecr.gps(ctxRole(db, 'BALISE', 'B'), { id, baliseRequise: 'Oui', t1Correct: 'Oui', numeroGPS: 'G' });
  // BS pas encore fait → sortie refusée avec le message v3.6.
  await assert.rejects(
    () => ecr.sortie(ctxRole(db, 'PP', 'PP'), { id, ckCfs: true, ckT1: true, ckBalise: true, ckBs: true }),
    /la Balise ET le Bon de Sortie doivent être faits/,
  );
});

test('anti-doublon : recréer un camion actif est refusé', async () => {
  const db = new FakeDB();
  const cfs = ctxAvec(db);
  await ecr.createcamion(cfs, { numeroCamion: 'DUP1', routage: 'Dépotage' });
  // numero_camion_norm est une colonne générée en base ; on la simule ici.
  db.store['cargaisons'][0]!['numero_camion_norm'] = 'DUP1';
  await assert.rejects(() => ecr.createcamion(cfs, { numeroCamion: 'DUP 1', routage: 'Dépotage' }), /existe déjà/);
});
