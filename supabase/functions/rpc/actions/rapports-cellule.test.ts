/**
 * Détail des rapports de cellule : la déclaration, le T1 et le bon de sortie de
 * chaque ligne (2026-10-09, demande utilisateur : « extraire les déclarations »).
 *
 * Le cas qui se trompe en silence est le CHARGEMENT MIXTE : un camion, deux
 * déclarations. La ligne camion doit les porter toutes les deux, chaque ligne
 * conteneur la SIENNE, avec SON T1.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Ctx } from '../ctx.ts';
import { FakeDB } from './fake-db.ts';
import * as rap from './rapports.ts';

const ctx = (db: FakeDB): Ctx => ({
  db: db as never,
  session: { userId: 'u', username: 'admin', nomComplet: 'Admin', role: 'ADMIN' as never },
  log: async () => {},
});

function camionMixte(): FakeDB {
  const db = new FakeDB();
  db.store['cargaisons'].push({
    id: 'CT-2026-000001', numero_camion: 'TG1234AB', type_operation: 'Enlèvement', statut: 'Sortie Enregistrée',
    date_creation: '2026-10-05T08:00:00.000Z', date_validation: '2026-10-05T09:00:00.000Z',
    date_t1: '2026-10-05T10:00:00.000Z', date_bon_sortie: '2026-10-05T11:00:00.000Z',
    date_pose_gps: '2026-10-05T12:00:00.000Z', date_sortie: '2026-10-05T14:32:00.000Z',
    declarant: 'STE CAMION', numero_declaration: '100', annee_declaration: '2026', bureau_declaration: 'TG120', type_declaration: 'T',
    destination_marchandise: 'OUAGA', numero_gps: 'GPS-1', twins: true, est_vehicule: false,
    conteneurs_details: { conteneurs: [
      { num: 'MSKU1111111', taille: "20'", type: 'DRY', plomb: 'S1', declarant: 'STE A', numeroDeclaration: '200', anneeDeclaration: '2026', bureauDeclaration: 'TG120', typeDeclaration: 'T' },
      { num: 'TCLU2222222', taille: "20'", type: 'DRY', plomb: 'S2', declarant: 'STE B', numeroDeclaration: '300', anneeDeclaration: '2026', bureauDeclaration: 'TG120', typeDeclaration: 'T' },
    ], scellesCamion: [] },
    t1_numeros: [{ conteneur: 'MSKU1111111', numero: 'T1-A' }, { conteneur: 'TCLU2222222', numero: 'T1-B' }],
    bon_sortie_numero: [{ conteneur: 'MSKU1111111', t1: 'T1-A', numero: 'BS-1' }, { conteneur: 'TCLU2222222', t1: 'T1-B', numero: 'BS-2' }],
  });
  return db;
}

const periode = { du: '2026-10-01', au: '2026-10-09' };

test('PP, ligne camion : les DEUX déclarations du chargement mixte, tous ses T1 et bons', async () => {
  const r = (await rap.rapportActiviteDetail(ctx(camionMixte()), { kind: 'pp', ...periode, metric: 'camions' })) as { rows: Record<string, unknown>[] };
  assert.equal(r.rows.length, 1);
  const l = r.rows[0]!;
  assert.equal(l['numeroDeclaration'], '200 / 300');
  assert.equal(l['declarant'], 'STE A / STE B');
  assert.equal(l['t1'], 'T1-A, T1-B');
  assert.equal(l['bonSortie'], 'BS-1, BS-2');
  assert.equal(l['destination'], 'OUAGA');
  assert.equal(l['dateSortie'], '2026-10-05T14:32:00.000Z');
});

test('PP, ligne conteneur : SA déclaration, SON T1 et SON bon de sortie', async () => {
  const r = (await rap.rapportActiviteDetail(ctx(camionMixte()), { kind: 'pp', ...periode, metric: 'conteneurs' })) as { rows: Record<string, unknown>[] };
  const b = r.rows.find((x) => x['conteneur'] === 'TCLU2222222')!;
  assert.equal(b['numeroDeclaration'], '300');
  assert.equal(b['declarant'], 'STE B');
  assert.equal(b['t1'], 'T1-B');
  assert.equal(b['bonSortie'], 'BS-2');
});

test('CFS : un conteneur SANS déclaration propre relève de celle du camion', async () => {
  const db = camionMixte();
  const c = db.store['cargaisons'][0]!;
  c['conteneurs_details'] = { conteneurs: [{ num: 'MSKU1111111', taille: "20'", type: 'DRY', plomb: 'S1' }], scellesCamion: [] };
  c['t1_numeros'] = ['T1-SEUL'];
  c['bon_sortie_numero'] = 'BS-UNIQUE';
  const r = (await rap.rapportCFSDetail(ctx(db), { ...periode, metric: 'conteneurs' })) as { rows: Record<string, unknown>[] };
  const l = r.rows[0]!;
  assert.equal(l['numeroDeclaration'], '100');
  assert.equal(l['declarant'], 'STE CAMION');
  assert.equal(l['t1'], 'T1-SEUL', 'un T1 saisi sans conteneur vaut pour tout le camion');
  assert.equal(l['bonSortie'], 'BS-UNIQUE');
});
