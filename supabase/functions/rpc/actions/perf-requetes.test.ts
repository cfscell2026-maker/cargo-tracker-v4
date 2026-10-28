/**
 * Lenteur (2026-10-19) : recherche, contrôle anti-doublon et rapports
 * interrogent désormais la base de façon CIBLÉE au lieu de tout rapatrier.
 *
 * Le danger d'un pré-filtre n'est pas la lenteur, c'est le dossier qui
 * disparaît en silence. Ces tests fixent les cas limites : un camion entré
 * il y a longtemps mais sorti (ou balisé) dans la période, un doublon exact
 * déjà sorti, un conteneur vu sur un dossier sorti.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Ctx } from '../ctx.ts';
import { FakeDB } from './fake-db.ts';
import * as lec from './lecture.ts';
import * as rap from './rapports.ts';

const cts = (...n: string[]) => ({ conteneurs: n.map((num) => ({ num, taille: "20'" })), scellesCamion: [] });

function base(rows: Record<string, unknown>[], conteneurs: Record<string, unknown>[] = []) {
  const db = new FakeDB();
  for (const r of rows) db.store['cargaisons'].push(r);
  for (const r of conteneurs) db.store['conteneurs'].push(r);
  const ctx: Ctx = {
    db: db as never,
    session: { userId: 'u', username: 'chef', nomComplet: 'Chef', role: 'ADMIN' as never },
    log: async () => {},
  };
  return ctx;
}

/* ------------------------------ recherche ------------------------------ */

test('recherche : plaque saisie avec espaces et tirets, dossiers annulés exclus', async () => {
  const ctx = base([
    { id: 'A', numero_camion: 'TG 1234-AB', statut: 'Créée', date_creation: '2026-10-01T08:00:00Z', annule: false, archive: false },
    { id: 'B', numero_camion: 'TG1234AB', statut: 'Sortie Enregistrée', date_creation: '2026-09-01T08:00:00Z', annule: false, archive: false },
    { id: 'C', numero_camion: 'TG1234AB', statut: 'Créée', date_creation: '2026-10-02T08:00:00Z', annule: true, archive: false },
    { id: 'D', numero_camion: 'TG9999ZZ', statut: 'Créée', date_creation: '2026-10-03T08:00:00Z', annule: false, archive: false },
  ]);
  const r = (await lec.cargoSearch(ctx, { valeur: '1234 ab' })) as Record<string, unknown>[];
  assert.deepEqual(r.map((x) => x['id']), ['A', 'B']);
});

/* --------------------------- anti-doublon ------------------------------ */

test('anti-doublon : le N° identique est signalé même sorti ; quasi-doublons parmi les seuls actifs', async () => {
  const ctx = base([
    { id: 'S', numero_camion: 'TG1234AB', statut: 'Sortie Enregistrée', date_creation: '2026-09-01T08:00:00Z', annule: false, archive: false },
    { id: 'Q', numero_camion: 'TG1243AB', statut: 'Créée', date_creation: '2026-10-01T08:00:00Z', annule: false, archive: false },
    { id: 'QS', numero_camion: 'TG1243AB', statut: 'Sortie Enregistrée', date_creation: '2026-08-01T08:00:00Z', annule: false, archive: false },
  ]);
  const r = (await lec.cargoCheckdup(ctx, { numeroCamion: 'tg-1234-ab' })) as { camion: { id: string }[]; similaires: { id: string }[] };
  assert.deepEqual(r.camion.map((x) => x.id), ['S']);
  assert.deepEqual(r.similaires.map((x) => x.id), ['Q'], 'le quasi-doublon déjà sorti n\'est pas proposé');
});

test('anti-doublon : un conteneur déjà vu sur un dossier sorti remonte avec son statut', async () => {
  const ctx = base(
    [{ id: 'OLD', numero_camion: 'TG5555CC', statut: 'Sortie Enregistrée', date_creation: '2026-01-05T08:00:00Z', annule: false, archive: false }],
    [{ cargaison_id: 'OLD', conteneur: 'MSKU1234565', numero_camion: 'TG5555CC' }],
  );
  const r = (await lec.cargoCheckdup(ctx, { numeroCamion: 'TG7777DD', conteneurs: ['MSKU1234565'] })) as {
    conteneurs: Record<string, { id: string; statut: string }[]>;
  };
  assert.deepEqual(r.conteneurs['MSKU1234565']!.map((x) => [x.id, x.statut]), [['OLD', 'Sortie Enregistrée']]);
});

/* ------------------------------ rapports ------------------------------- */

const OCT = { du: '2026-10-01', au: '2026-10-31' };

test('rapports : annulés et archivés écartés, une ligne sans ces champs (NULL) gardée', async () => {
  const ctx = base([
    { id: 'OK', type_operation: 'Enlèvement', statut: 'Créée', date_creation: '2026-10-05T08:00:00Z', destination_marchandise: 'KARA', conteneurs_details: cts('A') },
    { id: 'ANN', type_operation: 'Enlèvement', statut: 'Créée', date_creation: '2026-10-05T08:00:00Z', annule: true, destination_marchandise: 'KARA', conteneurs_details: cts('B') },
    { id: 'ARC', type_operation: 'Enlèvement', statut: 'Créée', date_creation: '2026-10-05T08:00:00Z', archive: true, destination_marchandise: 'KARA', conteneurs_details: cts('C') },
  ]);
  const r = (await rap.rapportControles(ctx, OCT)) as { transitNational: { camions: number } };
  assert.equal(r.transitNational.camions, 0);
  const f = (await rap.rapportFlux(ctx, { ...OCT, granularite: 'mois' })) as { totaux: { tc: number } };
  assert.equal(f.totaux.tc, 1, 'seul OK compte');
});

test('flux : un camion entré en juin mais balisé et sorti en octobre compte en octobre', async () => {
  const ctx = base([{
    id: 'VIEUX', type_operation: 'Enlèvement', statut: 'Sortie Enregistrée', annule: false, archive: false,
    date_creation: '2026-06-01T08:00:00Z', date_pose_gps: '2026-10-03T08:00:00Z', date_sortie: '2026-10-04T08:00:00Z',
    conteneurs_details: cts('A'),
  }, {
    id: 'TROP-VIEUX', type_operation: 'Enlèvement', statut: 'Sortie Enregistrée', annule: false, archive: false,
    date_creation: '2026-05-01T08:00:00Z', date_pose_gps: '2026-05-03T08:00:00Z', date_sortie: '2026-05-04T08:00:00Z',
    conteneurs_details: cts('B'),
  }]);
  const f = (await rap.rapportFlux(ctx, { ...OCT, granularite: 'mois' })) as { totaux: Record<string, number> };
  assert.deepEqual([f.totaux['baliseC'], f.totaux['ppC'], f.totaux['tc']], [1, 1, 0]);
});

test('destinations : comptées à la date de SORTIE, un vieux camion sorti en octobre y figure', async () => {
  const ctx = base([{
    id: 'X', type_operation: 'Enlèvement', statut: 'Sortie Enregistrée', annule: false, archive: false, est_vehicule: false,
    date_creation: '2026-03-01T08:00:00Z', date_sortie: '2026-10-10T08:00:00Z', destination_marchandise: 'OUAGADOUGOU',
  }, {
    id: 'Y', type_operation: 'Enlèvement', statut: 'Sortie Enregistrée', annule: false, archive: false, est_vehicule: false,
    date_creation: '2026-10-01T08:00:00Z', date_sortie: '2026-09-30T08:00:00Z', destination_marchandise: 'OUAGADOUGOU',
  }]);
  const r = (await rap.rapportDestinations(ctx, { ...OCT, granularite: 'mois' })) as { total: number };
  assert.equal(r.total, 1);
});

test('véhicules : entré avant la période et sorti dedans, compté ; les camions ignorés', async () => {
  const ctx = base([
    { id: 'V1', est_vehicule: true, statut: 'Sortie Enregistrée', annule: false, archive: false,
      date_creation: '2026-08-01T08:00:00Z', date_sortie: '2026-10-02T08:00:00Z', vehicule_details: { destination: 'BURKINA' } },
    { id: 'V2', est_vehicule: true, statut: 'Créée', annule: false, archive: false, date_creation: '2026-10-05T08:00:00Z' },
    { id: 'V3', est_vehicule: true, statut: 'Sortie Enregistrée', annule: false, archive: false,
      date_creation: '2026-07-01T08:00:00Z', date_sortie: '2026-07-02T08:00:00Z' },
    { id: 'C1', est_vehicule: false, statut: 'Créée', annule: false, archive: false, date_creation: '2026-10-05T08:00:00Z' },
  ]);
  const r = (await rap.rapportVehicules(ctx, OCT)) as { compte: Record<string, number> };
  assert.deepEqual([r.compte['total'], r.compte['sortis'], r.compte['attente']], [2, 1, 1]);
});
