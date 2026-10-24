/**
 * Vue allégée des statistiques (00208, 2026-10-24). La seule chose qui compte :
 * Flux et Contrôles rendent EXACTEMENT les mêmes chiffres avec la vue et sans
 * elle (repli sur la table), conteneurs partagés et anciennes saisies compris.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Ctx } from '../ctx.ts';
import { FakeDB } from './fake-db.ts';
import * as rap from './rapports.ts';

const lourd = (num: string, taille: string, extra: Record<string, unknown> = {}) => ({
  num, taille, type: 'DRY', plomb: 'SC-' + num, poids: '24000', champsLibres: 'X=1 ; Y=2',
  numeroDeclaration: '100', anneeDeclaration: '2026', bureauDeclaration: 'TG120', typeDeclaration: 'T',
  descriptionMarchandise: 'MARCHANDISES DIVERSES '.repeat(10), ...extra,
});

function base(vue: boolean) {
  const db = new FakeDB();
  db.vueStats = vue;
  const rows: Record<string, unknown>[] = [
    { id: 'A', type_operation: 'Enlèvement', est_vehicule: false, date_creation: '2026-10-02T08:00:00Z', date_pose_gps: '2026-10-03T08:00:00Z',
      date_sortie: '2026-10-04T08:00:00Z', destination_marchandise: 'KARA', en_surcharge: false, hors_gabarit: null,
      conteneurs_details: { conteneurs: [lourd('MSKU0000001', "20'"), lourd('MSKU0000002', "20'")], scellesCamion: ['S1'] } },
    { id: 'B', type_operation: 'Dépotage', est_vehicule: false, date_creation: '2026-10-05T08:00:00Z', en_surcharge: true, hors_gabarit: true,
      destination_marchandise: 'OUAGADOUGOU',
      conteneurs_details: { conteneurs: [lourd('TCLU0000003', "40'"), lourd('MSKU0000001', "20'", { partage: true })], scellesCamion: [] } },
    // Ancienne saisie : une simple liste, sans enveloppe.
    { id: 'C', type_operation: 'Enlèvement', est_vehicule: false, date_creation: '2026-10-06T08:00:00Z', destination_marchandise: 'TG',
      conteneurs_details: [lourd('GLDU0000004', "45'")] },
    { id: 'D', type_operation: 'Enlèvement', est_vehicule: false, date_creation: '2026-10-07T08:00:00Z', annule: true,
      conteneurs_details: { conteneurs: [lourd('GLDU0000005', "20'")], scellesCamion: [] } },
    { id: 'V', type_operation: 'Dépotage', est_vehicule: true, date_creation: '2026-10-08T08:00:00Z', conteneurs_details: { conteneurs: [], scellesCamion: [] } },
  ];
  for (const r of rows) db.store['cargaisons'].push(structuredClone(r));
  const ctx: Ctx = { db: db as never, session: { userId: 'u', username: 'c', nomComplet: 'C', role: 'ADMIN' as never }, log: async () => {} };
  return ctx;
}

const P = { du: '2026-10-01', au: '2026-10-31', granularite: 'mois' };

test('vue allégée : Analyse des flux identique avec et sans la vue', async () => {
  const sans = await rap.rapportFlux(base(false), P);
  const avec = await rap.rapportFlux(base(true), P);
  assert.deepEqual(avec, sans);
  assert.equal((sans as { totaux: { tc: number } }).totaux.tc, 4, 'A (2) + B (1, le partagé exclu) + C (1) ; D annulé');
});

test('vue allégée : Contrôles identiques avec et sans la vue', async () => {
  const sans = await rap.rapportControles(base(false), P);
  const avec = await rap.rapportControles(base(true), P);
  assert.deepEqual(avec, sans);
  assert.deepEqual((sans as { surcharge: unknown }).surcharge, { camions: 1, conteneurs: 2 });
});

test('vue allégée : ce qu\'elle transmet est bien réduit', async () => {
  const ctx = base(true);
  const { data } = await (ctx.db as never as FakeDB).from('v_cargaisons_stats').select('*').eq('id', 'A') as unknown as { data: Record<string, unknown>[] };
  const ct = (data[0]!['conteneurs_details'] as { conteneurs: Record<string, unknown>[] }).conteneurs[0]!;
  assert.deepEqual(Object.keys(ct).sort(), ['num', 'taille', 'type']);
});
