/**
 * Ajout d'un engagement après la validation (2026-10-09) : le chef voulait
 * « Oui » et a signé « Non ». Chefs et administrateur, motif obligatoire,
 * mêmes règles qu'à la validation, et permis après la sortie.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Ctx } from '../ctx.ts';
import { FakeDB } from './fake-db.ts';
import * as ecr from './ecriture.ts';
import * as lec from './lecture.ts';
import { controlerApresSortie } from './verrou-sortie.ts';
import { verifierPermission } from '../../_shared/domaine/src/index.ts';

const dansNJours = (n: number) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

function base(extra: Record<string, unknown> = {}) {
  const db = new FakeDB();
  db.store['cargaisons'].push({
    id: 'CT-1', numero_camion: 'TG1234AB', type_operation: 'Dépotage', statut: 'Créée',
    date_creation: '2026-10-08T08:00:00.000Z', date_validation: '2026-10-08T09:00:00.000Z',
    agent_validation: 'Chef A', suivi_engagement: false, annule: false, archive: false, ...extra,
  });
  const journal: { action: string; detail: string }[] = [];
  const ctx: Ctx = {
    db: db as never,
    session: { userId: 'u', username: 'chef', nomComplet: 'Chef A', role: 'CHEF_BRIGADE' as never },
    log: async (action: string, _c: string, detail: string) => { journal.push({ action, detail }); },
  };
  return { db, ctx, journal };
}
const OK = { id: 'CT-1', engagementType: 'BFE 03 Sinkase', engagementDelai: dansNJours(3), motif: '« Non » coché par erreur' };

test('ajout : le camion passe sous suivi, avec sa nature et son échéance, et c\'est tracé', async () => {
  const { db, ctx, journal } = base();
  await ecr.engagementAjouter(ctx, OK);
  const c = db.store['cargaisons'][0]!;
  assert.equal(c['suivi_engagement'], true);
  assert.equal(c['engagement_type'], 'BFE 03 Sinkase');
  assert.equal(c['engagement_delai'], dansNJours(3));
  assert.equal(journal[0]!.action, 'Engagement ajouté après validation');
  assert.match(journal[0]!.detail, /BFE 03 Sinkase · échéance .* · motif : « Non » coché par erreur/);
  // Et il apparaît désormais dans le volet Engagements.
  const v = (await lec.engagementsDus(ctx, { filtre: 'tous' })) as { lignes: Record<string, unknown>[] };
  assert.deepEqual(v.lignes.map((l) => l['id']), ['CT-1']);
});

test('refus : sans motif', async () => {
  const { ctx } = base();
  await assert.rejects(() => ecr.engagementAjouter(ctx, { ...OK, motif: '' }), /motif de l'ajout/);
});

test('refus : camion pas encore validé, l\'engagement se choisit à la validation', async () => {
  const { ctx } = base({ date_validation: null });
  await assert.rejects(() => ecr.engagementAjouter(ctx, OK), /pas encore validé/);
});

test('refus : camion déjà sous suivi, on corrige au lieu d\'ajouter', async () => {
  const { ctx } = base({ suivi_engagement: true, engagement_type: 'Transit national', engagement_delai: dansNJours(5) });
  await assert.rejects(() => ecr.engagementAjouter(ctx, OK), /déjà sous suivi/);
});

test('mêmes règles qu\'à la validation : nature et délai obligatoires, délai à venir', async () => {
  const { ctx } = base();
  await assert.rejects(() => ecr.engagementAjouter(ctx, { ...OK, engagementType: '' }), /précisez l'engagement/);
  await assert.rejects(() => ecr.engagementAjouter(ctx, { ...OK, engagementDelai: '' }), /indiquez le délai/);
  await assert.rejects(() => ecr.engagementAjouter(ctx, { ...OK, engagementDelai: dansNJours(-2) }), /déjà passé/);
});

test('permis APRÈS la sortie : le verrou de sortie ne bloque pas l\'ajout', async () => {
  const { db, ctx } = base({ statut: 'Sortie Enregistrée', date_sortie: '2026-10-08T15:00:00.000Z' });
  await controlerApresSortie(ctx, 'cargo.engagementajouter', OK);
  await ecr.engagementAjouter(ctx, OK);
  assert.equal(db.store['cargaisons'][0]!['suivi_engagement'], true);
});

test('droits : les chefs et l\'administrateur, pas les agents', () => {
  for (const r of ['CHEF_BRIGADE', 'CHEF_BRIGADE_ADJOINT', 'CHEF_VISITE', 'CHEF_DIVISION', 'ADMIN'])
    assert.doesNotThrow(() => verifierPermission(r as never, 'cargo.engagementajouter'), r);
  for (const r of ['CFS', 'T1', 'PP'])
    assert.throws(() => verifierPermission(r as never, 'cargo.engagementajouter'), r);
});
