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
import * as stk from './stock.ts';

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
  await ecr.valider(ctxRole(db, 'CHEF_BRIGADE', 'Chef Brigade'), { id });
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
    declaration: { declarant: 'A', contactDeclarant: '901234', destinationMarchandise: 'D', bureauDeclaration: 'TG120', typeDeclaration: 'C', numeroDeclaration: '2', anneeDeclaration: '2026', dateDeclaration: '2026-06-24', descriptionMarchandise: 'X', nombreConteneurs: 1 },
    consoMode: 'sansbalise',
  });
  const c = versCamel(db.store['cargaisons'][0]!);
  assert.equal(c['sauteT1'], true);
  assert.equal(c['sauteBalise'], true);
  // Après validation : T1 et Balise sautés → Bon de sortie + PP disponibles.
  await ecr.valider(ctxRole(db, 'CHEF_BRIGADE', 'CB'), { id });
  assert.deepEqual(etapesEnAttente(versCamel(db.store['cargaisons'][0]!) as never), ['BS', 'PP']);
});

test('nouvelle déclaration (dépotage) : la date en douane est exigée (ordre d\'exécution)', async () => {
  const db = new FakeDB();
  db.store['stock'].push({ numero_tc: 'MSKU1234567', taille: "40'", statut: 'Positionné' });
  const cfs = ctxAvec(db);
  const { id } = (await ecr.createcamion(cfs, { numeroCamion: 'SANSDATE', routage: 'Dépotage' })) as { id: string };
  const sansDate = { declarant: 'A', contactDeclarant: '901234', destinationMarchandise: 'D', bureauDeclaration: 'TG120', typeDeclaration: 'T', numeroDeclaration: '4242', anneeDeclaration: '2026', descriptionMarchandise: 'X', nombreConteneurs: 1 };
  await assert.rejects(
    () => ecr.cfs(cfs, { id, conteneur: { num: 'MSKU1234567', taille: "40'", type: 'DRY' }, declaration: sansDate }),
    /indiquez la « date de la déclaration »/,
  );
  // Avec la date : la déclaration passe et la date est stockée en base.
  await ecr.cfs(cfs, {
    id, conteneur: { num: 'MSKU1234567', taille: "40'", type: 'DRY' },
    declaration: { ...sansDate, dateDeclaration: '24/06/2026' }, // format jj/mm/aaaa accepté
  });
  assert.equal(db.store['declarations'][0]?.['date_declaration'], '2026-06-24');
});

test('enlèvement : la date en douane n\'est PAS exigée', async () => {
  const db = new FakeDB();
  db.store['stock'].push({ numero_tc: 'MSKU1234567', taille: "40'", statut: 'En stock' });
  const cfs = ctxAvec(db);
  const { id } = (await ecr.createcamion(cfs, { numeroCamion: 'ENLSANSDATE', routage: 'Enlèvement' })) as { id: string };
  // Nouvelle déclaration sans date : accepté en enlèvement.
  await ecr.cfs(cfs, {
    id, conteneur: { num: 'MSKU1234567', taille: "40'", type: 'DRY', plomb: 'S1' },
    declaration: { declarant: 'A', contactDeclarant: '901234', destinationMarchandise: 'D', bureauDeclaration: 'TG120', typeDeclaration: 'T', numeroDeclaration: '7777', anneeDeclaration: '2026', descriptionMarchandise: 'X', nombreConteneurs: 1 },
  });
  assert.equal(statutDe(db, id), STATUTS.CREEE);
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
  await ecr.valider(ctxRole(db, 'CHEF_BRIGADE', 'CB'), { id });
  // Balise pas encore posée → la PP ne peut pas clôturer.
  await assert.rejects(
    () => ecr.sortie(ctxRole(db, 'PP', 'PP'), { id, ckCfs: true, ckT1: true, ckBalise: true, ckBs: true }),
    /la Balise doit être posée/,
  );
  // Une fois la Balise posée, la sortie passe (les autres cellules travaillent en parallèle).
  await ecr.gps(ctxRole(db, 'BALISE', 'B'), { id, baliseRequise: 'Oui', t1Correct: 'Oui', numeroGPS: 'G' });
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
