/**
 * Test d'intégration : cycle de vie COMPLET d'un enlèvement à travers les
 * handlers serveur réels (createcamion → cfs → valider → t1 → gps → bonsortie
 * → sortie) sur une base en mémoire. Vérifie les transitions de statut, le
 * parallélisme Balise/Bon de sortie, l'apurement et le décompte du stock.
 * Exécutable : `node --test`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STATUTS, etapesEnAttente, groupesDeclaration } from '../../_shared/domaine/src/index.ts';
import { versCamel, type Ctx } from '../ctx.ts';
import { FakeDB } from './fake-db.ts';
import * as ecr from './ecriture.ts';
import * as spe from './speciaux.ts';
import * as stk from './stock.ts';
import * as rap from './rapports.ts';

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
  await ecr.valider(ctxRole(db, 'CHEF_BRIGADE', 'Chef Brigade'), { id, enSurcharge: false });
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
  const { id } = (await ecr.createcamion(cfs, { numeroCamion: 'CONSO1', routage: 'Enlèvement' })) as { id: string };
  await ecr.cfs(cfs, {
    id, conteneur: { num: 'MSKU1234567', taille: "40'", type: 'DRY', plomb: 'S1' },
    declaration: { declarant: 'A', contactDeclarant: '901234', destinationMarchandise: 'D', bureauDeclaration: 'TG120', typeDeclaration: 'C', numeroDeclaration: '1', anneeDeclaration: '2026', dateDeclaration: '2026-06-24', descriptionMarchandise: 'X', nombreConteneurs: 1 },
    consoMode: 'balise',
  });
  const c = versCamel(db.store['cargaisons'][0]!);
  assert.equal(c['sauteT1'], true);
  assert.equal(c['sauteBalise'], false);
  // Après validation : le T1 est sauté → Balise ET Bon de sortie en attente.
  await ecr.valider(ctxRole(db, 'CHEF_BRIGADE', 'CB'), { id, enSurcharge: false });
  assert.deepEqual(etapesEnAttente(versCamel(db.store['cargaisons'][0]!) as never), ['BALISE', 'BS']);
});

test('déclaration type C non balisée : saute le T1 ET la Balise', async () => {
  const db = new FakeDB();
  db.store['stock'].push({ numero_tc: 'MSKU1234567', taille: "40'", statut: 'En stock' });
  const cfs = ctxAvec(db);
  const { id } = (await ecr.createcamion(cfs, { numeroCamion: 'CONSO2', routage: 'Enlèvement' })) as { id: string };
  await ecr.cfs(cfs, {
    id, conteneur: { num: 'MSKU1234567', taille: "40'", type: 'DRY', plomb: 'S1' },
    declaration: { declarant: 'A', contactDeclarant: '901234', destinationMarchandise: 'D', bureauDeclaration: 'TG120', typeDeclaration: 'C', numeroDeclaration: '2', anneeDeclaration: '2026', dateDeclaration: '2026-06-24', descriptionMarchandise: 'X', nombreConteneurs: 1 },
    consoMode: 'sansbalise',
  });
  const c = versCamel(db.store['cargaisons'][0]!);
  assert.equal(c['sauteT1'], true);
  assert.equal(c['sauteBalise'], true);
  // Après validation : T1 et Balise sautés → Bon de sortie + PP disponibles.
  await ecr.valider(ctxRole(db, 'CHEF_BRIGADE', 'CB'), { id, enSurcharge: false });
  assert.deepEqual(etapesEnAttente(versCamel(db.store['cargaisons'][0]!) as never), ['BS', 'PP']);
});

test('déclaration : date et nombre de conteneurs FACULTATIFS (dépotage)', async () => {
  const db = new FakeDB();
  db.store['stock'].push({ numero_tc: 'MSKU1234567', taille: "40'", statut: 'Positionné' });
  const cfs = ctxAvec(db);
  const { id } = (await ecr.createcamion(cfs, { numeroCamion: 'FAC1', routage: 'Dépotage' })) as { id: string };
  // Nouvelle déclaration SANS date NI nombre de conteneurs : accepté.
  await ecr.cfs(cfs, {
    id, conteneur: { num: 'MSKU1234567', taille: "40'", type: 'DRY' },
    declaration: { declarant: 'A', contactDeclarant: '901234', destinationMarchandise: 'D', bureauDeclaration: 'TG120', typeDeclaration: 'T', numeroDeclaration: '4242', anneeDeclaration: '2026', descriptionMarchandise: 'X' },
  });
  assert.equal(statutDe(db, id), STATUTS.CHARGEMENT);
  assert.equal(db.store['declarations'][0]?.['numero_declaration'], '4242');
  assert.equal(Number(db.store['declarations'][0]?.['nombre_conteneurs']), 0); // inconnu = 0
});

test('suppression de doublon (ADMIN) : retire la cargaison et libère le stock', async () => {
  const db = new FakeDB();
  db.store['stock'].push({ numero_tc: 'MSKU1234567', taille: "40'", statut: 'Positionné' });
  const cfs = ctxAvec(db);
  const { id } = (await ecr.createcamion(cfs, { numeroCamion: 'DUP99', routage: 'Dépotage' })) as { id: string };
  await ecr.cfs(cfs, {
    id, conteneur: { num: 'MSKU1234567', taille: "40'", type: 'DRY' },
    declaration: { declarant: 'A', contactDeclarant: '901234', destinationMarchandise: 'D', bureauDeclaration: 'TG120', typeDeclaration: 'T', numeroDeclaration: '70', anneeDeclaration: '2026', descriptionMarchandise: 'X' },
  });
  assert.equal(db.store['stock'][0]?.['statut'], 'Dépoté'); // conteneur lié
  await ecr.supprimerCargo(ctxRole(db, 'ADMIN', 'Admin'), { id });
  assert.equal(db.store['cargaisons'].length, 0);
  assert.equal(db.store['conteneurs'].length, 0);
  assert.equal(db.store['stock'][0]?.['statut'], 'En stock'); // stock libéré
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
      { numeroCamion: 'CAM-FINI', chargementTermine: true, designation: 'Cartons d\'effets personnels', scellesCamion: ['S1', 'S2'] },
      // pas terminé → scellés NON exigés, statut « En cours de chargement »
      { numeroCamion: 'CAM-ENCOURS', chargementTermine: false, designation: 'Colis divers', scellesCamion: [] },
    ],
  });
  const fini = db.store['cargaisons'].find((c) => c['numero_camion'] === 'CAM-FINI');
  const enCours = db.store['cargaisons'].find((c) => c['numero_camion'] === 'CAM-ENCOURS');
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
      camions: [{ numeroCamion: 'CAM-X', chargementTermine: true, scellesCamion: ['S1', 'S2'] }],
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
    camions: [{ numeroCamion: 'MADT1', conteneurs: [{ num: 'MSKU1234567', taille: "40'", type: 'DRY', plomb: 'S1' }] }],
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
    camions: [{ numeroCamion: 'MADC1', conteneurs: [{ num: 'MSKU1234567', taille: "40'", type: 'DRY', plomb: 'S1' }] }],
  });
  const c = db.store['cargaisons'][0]!;
  assert.equal(c['saute_t1'], true);
  assert.equal(c['saute_balise'], true);
});

test('sortie Magasin/MAD : type T garde le T1, type C le saute', async () => {
  const db = new FakeDB();
  const cfs = ctxAvec(db);
  const base = { declarant: 'A', contactDeclarant: '901234', destinationMarchandise: 'D', bureauDeclaration: 'TG120', anneeDeclaration: '2026', dateDeclaration: '2026-06-24', descriptionMarchandise: 'VRAC', nombreConteneurs: 1 };
  await spe.create(cfs, { typeOperation: 'Sortie Magasin / MAD', numeroCamion: 'MAG-T', consoMode: 'balise', declaration: { ...base, typeDeclaration: 'T', numeroDeclaration: '30' } });
  await spe.create(cfs, { typeOperation: 'Sortie Magasin / MAD', numeroCamion: 'MAG-C', consoMode: 'sansbalise', declaration: { ...base, typeDeclaration: 'C', numeroDeclaration: '31' } });
  const magT = db.store['cargaisons'].find((c) => c['numero_camion'] === 'MAG-T');
  const magC = db.store['cargaisons'].find((c) => c['numero_camion'] === 'MAG-C');
  assert.equal(magT?.['saute_t1'], false);
  assert.equal(magT?.['saute_balise'], false);
  assert.equal(magC?.['saute_t1'], true);
  assert.equal(magC?.['saute_balise'], true);
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
  const { id } = (await ecr.createcamion(cfs, { numeroCamion: 'NOVAL1', routage: 'Enlèvement' })) as { id: string };
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
  const { id } = (await ecr.createcamion(cfs, { numeroCamion: 'CORR1', routage: 'Dépotage' })) as { id: string };
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
  const { id } = (await ecr.createcamion(cfs, { numeroCamion: 'CORR2', routage: 'Enlèvement' })) as { id: string };
  await ecr.cfs(cfs, {
    id, conteneur: { num: 'MSKU1234567', taille: "40'", type: 'DRY', plomb: 'S1' },
    declaration: { declarant: 'A', contactDeclarant: '901234', destinationMarchandise: 'D', bureauDeclaration: 'TG120', typeDeclaration: 'T', numeroDeclaration: '51', anneeDeclaration: '2026', dateDeclaration: '2026-06-24', descriptionMarchandise: 'X', nombreConteneurs: 1 },
  });
  await ecr.valider(ctxRole(db, 'CHEF_BRIGADE', 'CB'), { id, enSurcharge: false });
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
  const { id } = (await ecr.createcamion(cfs, { numeroCamion: 'ZZ99', routage: 'Enlèvement' })) as { id: string };
  await ecr.cfs(cfs, {
    id, conteneur: { num: 'MSKU1234567', taille: "40'", type: 'DRY', plomb: 'S1' },
    declaration: { declarant: 'A', contactDeclarant: '901234', destinationMarchandise: 'D', bureauDeclaration: 'TG120', typeDeclaration: 'T', numeroDeclaration: '1', anneeDeclaration: '2026', dateDeclaration: '2026-06-24', descriptionMarchandise: 'X', nombreConteneurs: 1 },
  });
  await ecr.valider(ctxRole(db, 'CHEF_BRIGADE', 'CB'), { id, enSurcharge: false });
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
  await ecr.createcamion(cfs, { numeroCamion: 'DUP1', routage: 'Dépotage' });
  // numero_camion_norm est une colonne générée en base ; on la simule ici.
  db.store['cargaisons'][0]!['numero_camion_norm'] = 'DUP1';
  await assert.rejects(() => ecr.createcamion(cfs, { numeroCamion: 'DUP 1', routage: 'Dépotage' }), /existe déjà/);
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
      { numeroCamion: 'LOT001', conteneurs: [{ num: 'MSKU1111111', taille: "40'", type: 'DRY', plomb: 'S1' }] },
      { numeroCamion: 'LOT002', conteneurs: [{ num: 'TCLU2222222', taille: "40'", type: 'DRY', plomb: 'S2' }] },
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
      { numeroCamion: 'LOT001', conteneurs: [{ num: 'MSKU1111111', taille: "40'", type: 'DRY', plomb: 'S1' }] },
      // TC absent du stock → cette ligne seule échoue.
      { numeroCamion: 'LOT002', conteneurs: [{ num: 'ZZZZ9999999', taille: "40'", type: 'DRY', plomb: 'S2' }] },
    ],
  })) as { crees: unknown[]; erreurs: Record<string, unknown>[] };

  assert.equal(r.crees.length, 1);
  assert.equal(r.erreurs.length, 1);
  assert.equal(r.erreurs[0]?.['numeroCamion'], 'LOT002');
  assert.match(String(r.erreurs[0]?.['message']), /introuvable dans le stock/);
});

test('correction conteneur : le mauvais N° est remplacé et rendu au stock', async () => {
  const db = new FakeDB();
  db.store['stock'].push(
    { numero_tc: 'MSKU1111111', taille: "40'", statut: 'En stock' }, // saisi par erreur
    { numero_tc: 'TCLU2222222', taille: "40'", statut: 'En stock' }, // le vrai conteneur
  );
  const cfs = ctxAvec(db);
  const { id } = (await ecr.createcamion(cfs, { numeroCamion: 'FIX001', routage: 'Enlèvement' })) as { id: string };
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
  const { id } = (await ecr.createcamion(cfs, { numeroCamion: 'FIX002', routage: 'Enlèvement' })) as { id: string };
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
  const { id } = (await ecr.createcamion(cfs, { numeroCamion: 'FIX003', routage: 'Enlèvement' })) as { id: string };
  await ecr.cfs(cfs, { id, conteneur: { num: 'MSKU1111111', taille: "40'", type: 'DRY', plomb: 'S1' }, declaration: DECL_OK });
  await ecr.valider(ctxRole(db, 'CHEF_BRIGADE', 'CB'), { id, enSurcharge: false });
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
  const { id } = (await ecr.createcamion(cfs, { numeroCamion: 'FIX004', routage: 'Enlèvement' })) as { id: string };
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
  const a = (await ecr.createcamion(cfs, { numeroCamion: 'VAL001', routage: 'Enlèvement' })) as { id: string };
  await ecr.cfs(cfs, { id: a.id, conteneur: { num: 'MSKU1111111', taille: "40'", type: 'DRY', plomb: 'S1' }, declaration: DECL_OK });
  const b = (await ecr.createcamion(cfs, { numeroCamion: 'VAL002', routage: 'Enlèvement' })) as { id: string };
  await ecr.cfs(cfs, { id: b.id, conteneur: { num: 'TCLU2222222', taille: "20'", type: 'DRY', plomb: 'S2' }, declaration: DECL_OK });
  const autre = (await ecr.createcamion(cfs, { numeroCamion: 'VAL003', routage: 'Enlèvement' })) as { id: string };
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
  const res = (await ecr.validerLot(chef, { ids: dossier.aValider, pesees: Object.fromEntries((dossier.aValider as string[]).map((x) => [x, { enSurcharge: false }])) })) as {
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

  const ok = (await ecr.createcamion(cfs, { numeroCamion: 'VAL010', routage: 'Enlèvement' })) as { id: string };
  await ecr.cfs(cfs, { id: ok.id, conteneur: { num: 'MSKU1111111', taille: "40'", type: 'DRY', plomb: 'S1' }, declaration: DECL_OK });
  // Camion encore EN CHARGEMENT : le CFS n'a pas fini, il ne peut pas être validé.
  const pasPret = (await ecr.createcamion(cfs, { numeroCamion: 'VAL011', routage: 'Enlèvement' })) as { id: string };

  const res = (await ecr.validerLot(chef, { ids: [ok.id, pasPret.id, 'INEXISTANT'], pesees: { [ok.id]: { enSurcharge: false }, [pasPret.id]: { enSurcharge: false } } })) as {
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
async function camionBalise(db: FakeDB, plaque = 'COR001') {
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

test('plaque : Balise et PP corrigent le N° de camion en aval', async () => {
  const db = new FakeDB();
  db.store['stock'].push({ numero_tc: 'MSKU1111111', taille: "40'", statut: 'En stock' });
  const id = await camionBalise(db, 'MAUVAISE1');

  // La Balise rectifie la plaque relevée au passage…
  const b = ctxTrace(db, 'BALISE', 'Agent Balise');
  await ecr.editcamion(b.ctx, { id, numeroCamion: 'BONNE2' });
  assert.equal(versCamel(db.store['cargaisons'][0]!)['numeroCamion'], 'BONNE2');
  assert.match(b.traces[0]!.detail, /MAUVAISE1 → BONNE2/);

  // …et la Porte Principale peut encore le faire au moment de la sortie.
  const p = ctxTrace(db, 'PP', 'Agent PP');
  await ecr.editcamion(p.ctx, { id, numeroCamion: 'BONNE3' });
  assert.equal(versCamel(db.store['cargaisons'][0]!)['numeroCamion'], 'BONNE3');

  // La correction suit le camion sur ses conteneurs, pas seulement sur la fiche.
  const ct = db.store['conteneurs'].find((x) => x['cargaison_id'] === id);
  if (ct) assert.equal(ct['numero_camion'], 'BONNE3');
});

/* ------- v4.1 : enlèvement = fin de chargement à la saisie ------------- */

test('enlèvement : la saisie du conteneur (scellé) passe SEULE en « Créée »', async () => {
  const db = new FakeDB();
  db.store['stock'].push({ numero_tc: 'MSKU1111111', taille: "40'", statut: 'En stock' });
  const cfs = ctxAvec(db);
  const { id } = (await ecr.createcamion(cfs, { numeroCamion: 'FIN001', routage: 'Enlèvement' })) as { id: string };
  await ecr.cfs(cfs, { id, conteneur: { num: 'MSKU1111111', taille: "40'", type: 'DRY', plomb: 'S1' }, declaration: DECL_OK });
  // Aucune confirmation : l'étape CFS est franchie d'emblée.
  assert.equal(statutDe(db, id), STATUTS.CREEE);
  assert.deepEqual(etapesEnAttente(versCamel(db.store['cargaisons'][0]!) as never), ['VALIDATION', 'T1', 'BALISE', 'BS']);
});

test('rattrapage : un enlèvement resté « En cours de chargement » se termine en un clic', async () => {
  const db = new FakeDB();
  db.store['stock'].push({ numero_tc: 'MSKU1111111', taille: "40'", statut: 'En stock' });
  const cfs = ctxAvec(db);
  const { id } = (await ecr.createcamion(cfs, { numeroCamion: 'FIN002', routage: 'Enlèvement' })) as { id: string };
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
  const { id } = (await ecr.createcamion(cfs, { numeroCamion: 'FIN003', routage: 'Enlèvement' })) as { id: string };
  await assert.rejects(() => ecr.finChargement(cfs, { id }), /Rien à clôturer/);
});

test('le dépotage garde sa propre clôture (scellés camion), pas fincharge', async () => {
  const db = new FakeDB();
  db.store['stock'].push({ numero_tc: 'TCLU7654321', taille: "40'", statut: 'Positionné' });
  const cfs = ctxAvec(db);
  const { id } = (await ecr.createcamion(cfs, { numeroCamion: 'FIN005', routage: 'Dépotage' })) as { id: string };
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
  const { id } = (await ecr.createcamion(cfs, { numeroCamion: 'MIG001', routage: 'Enlèvement' })) as { id: string };
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
  const { id } = (await ecr.createcamion(cfs, { numeroCamion: 'MIG002', routage: 'Enlèvement' })) as { id: string };
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
  const { id } = (await ecr.createcamion(cfs, { numeroCamion: 'MIX001', routage: 'Enlèvement' })) as { id: string };
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
async function enlevementSaisieManuelle(db: FakeDB, tc = 'MSKU1234567', plaque = 'MAN001') {
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
  const e1 = (await ecr.createcamion(cfs, { numeroCamion: 'CONSO-ENL', routage: 'Enlèvement' })) as { id: string };
  await ecr.cfs(cfs, { id: e1.id, conteneur: { num: 'MSKU1000001', taille: "40'", type: 'DRY', plomb: 'S1' },
    declaration: { ...base, typeDeclaration: 'C', numeroDeclaration: '100' }, consoMode: 'balise' });

  // (b) un enlèvement de type T (transit) → NE compte PAS en conso.
  const e2 = (await ecr.createcamion(cfs, { numeroCamion: 'TRANSIT', routage: 'Enlèvement' })) as { id: string };
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
  const e = (await ecr.createcamion(cfs, { numeroCamion: 'CONSO-OUT', routage: 'Enlèvement' })) as { id: string };
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
  const a = (await ecr.createcamion(cfs, { numeroCamion: 'PK-WAIT', routage: 'Enlèvement' })) as { id: string };
  await ecr.cfs(cfs, { id: a.id, conteneur: { num: 'MSKU2000001', taille: "40'", type: 'DRY', plomb: 'S1' },
    declaration: { ...base, typeDeclaration: 'T', numeroDeclaration: '200' } });

  // (b) camion encore EN CHARGEMENT au CFS (dépotage non finalisé) → ne compte PAS.
  db.store['stock'].push({ numero_tc: 'TCLU2000003', taille: "40'", statut: 'Positionné' });
  const b = (await ecr.createcamion(cfs, { numeroCamion: 'PK-LOAD', routage: 'Dépotage' })) as { id: string };
  await ecr.cfs(cfs, { id: b.id, conteneur: { num: 'TCLU2000003', taille: "40'", type: 'DRY' },
    declaration: { ...base, typeDeclaration: 'T', numeroDeclaration: '201' } });

  // (c) conso NON balisée (dispense) → jamais de balise → ne compte PAS.
  const cc = (await ecr.createcamion(cfs, { numeroCamion: 'PK-DISP', routage: 'Enlèvement' })) as { id: string };
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
  await ecr.valider(ctxRole(db, 'CHEF_BRIGADE', 'CB'), { id, enSurcharge: false });
  await ecr.t1(ctxRole(db, 'T1', 'T1'), { id, bureauDestination: 'BF', t1Numeros: [{ conteneur: tc, numero: 'T1-' + num }] });
  await ecr.gps(ctxRole(db, 'BALISE', 'B'), { id, baliseRequise: 'Oui', t1Correct: 'Oui', numeroGPS: 'G-' + num });
  await ecr.bonsortie(ctxRole(db, 'BON_SORTIE', 'BS'), { id, bonSortieNumero: [{ conteneur: tc, t1: 'T1-' + num, numero: 'BS-' + num }] });
  await ecr.sortie(ctxRole(db, 'PP', 'PP'), { id, ckCfs: true, ckT1: true, ckBalise: true, ckBs: true });
  return id;
}

test('rapport destinations : compte les camions SORTIS par destination', async () => {
  const db = new FakeDB();
  await enlevementSorti(db, 'D-BF1', 'MSKU3000001', 'BF', '300');
  await enlevementSorti(db, 'D-BF2', 'MSKU3000002', 'BF', '301');
  await enlevementSorti(db, 'D-NE1', 'MSKU3000003', 'NE', '302');
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
  await enlevementSorti(db, 'F1', 'MSKU4000001', 'BF', '400');
  await enlevementSorti(db, 'F2', 'MSKU4000002', 'NE', '401');
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
  const ida = (await ecr.createcamion(a, { numeroCamion: 'RA', routage: 'Enlèvement' })) as { id: string };
  await ecr.cfs(a, { id: ida.id, conteneur: { num: 'MSKU3000001', taille: "40'", type: 'DRY', plomb: 'S1' }, declaration: DECL_OK });
  const b = ctxRole(db, 'CFS', 'Agent B');
  const idb = (await ecr.createcamion(b, { numeroCamion: 'RB', routage: 'Enlèvement' })) as { id: string };
  await ecr.cfs(b, { id: idb.id, conteneur: { num: 'MSKU3000002', taille: "40'", type: 'DRY', plomb: 'S2' }, declaration: DECL_OK });

  // Agent A ouvre le rapport CFS SANS filtre : il voit les DEUX camions.
  const r = (await rap.rapportCFS(a, {})) as { total: { camions: number } };
  assert.equal(r.total.camions, 2);
});

/* ---- v4.1 : pesée obligatoire avant la validation chef ------------------ */

async function camionAValider(db: FakeDB, plaque = 'PES001') {
  db.store['stock'].push({ numero_tc: 'MSKU7777777', taille: "40'", statut: 'En stock' });
  const cfs = ctxAvec(db);
  const { id } = (await ecr.createcamion(cfs, { numeroCamion: plaque, routage: 'Enlèvement' })) as { id: string };
  await ecr.cfs(cfs, { id, conteneur: { num: 'MSKU7777777', taille: "40'", type: 'DRY', plomb: 'S1' }, declaration: DECL_OK });
  return id;
}

test('validation refusée sans pesée renseignée', async () => {
  const db = new FakeDB();
  const id = await camionAValider(db);
  await assert.rejects(() => ecr.valider(ctxRole(db, 'CHEF_BRIGADE', 'CB'), { id }), /Renseignez la pesée/);
});

test('pesée EN SURCHARGE : le poids est obligatoire puis enregistré', async () => {
  const db = new FakeDB();
  const id = await camionAValider(db, 'PES002');
  await assert.rejects(() => ecr.valider(ctxRole(db, 'CHEF_BRIGADE', 'CB'), { id, enSurcharge: true }), /poids en surcharge/);
  await ecr.valider(ctxRole(db, 'CHEF_BRIGADE', 'CB'), { id, enSurcharge: true, poidsSurcharge: '1200' });
  const c = versCamel(db.store['cargaisons'][0]!);
  assert.equal(c['enSurcharge'], true);
  assert.equal(c['poidsSurcharge'], '1200');
  assert.ok(c['dateValidation']);
});

test('pesée HORS SURCHARGE : validé sans poids, poids resté vide', async () => {
  const db = new FakeDB();
  const id = await camionAValider(db, 'PES003');
  await ecr.valider(ctxRole(db, 'CHEF_BRIGADE', 'CB'), { id, enSurcharge: false });
  const c = versCamel(db.store['cargaisons'][0]!);
  assert.equal(c['enSurcharge'], false);
  assert.equal(c['poidsSurcharge'], '');
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
