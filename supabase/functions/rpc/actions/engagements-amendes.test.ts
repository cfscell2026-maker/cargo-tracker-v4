/**
 * Engagements par période et amendes pour effets non déclarés (2026-10-19).
 *
 * Ce qui se tromperait en silence :
 *   · un engagement compté à la date d'ENTRÉE du camion au lieu du moment où il
 *     a été posé ;
 *   · une amende de lot recopiée sur chaque camion, donc comptée N fois ;
 *   · une amende demandée hors enlèvement, ou exigée d'un écran qui ne connaît
 *     pas encore la question.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Ctx } from '../ctx.ts';
import { FakeDB } from './fake-db.ts';
import { versCamel } from '../ctx.ts';
import * as ecr from './ecriture.ts';
import * as rap from './rapports.ts';
import * as lec from './lecture.ts';
import { calculerEngagements } from './engagements-amendes.ts';
import { controlerApresSortie } from './verrou-sortie.ts';
import { natureRapportEngagement, verifierPermission, AMENDE_EFFETS_FORFAIT } from '../../_shared/domaine/src/index.ts';

const dansNJours = (n: number) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const moisCle = (v: unknown) => String(v ?? '').slice(0, 7) || null;

function base(cargos: Record<string, unknown>[]) {
  const db = new FakeDB();
  for (const c of cargos) db.store['cargaisons'].push({ annule: false, archive: false, ...c });
  db.store['profils'].push({ id: 'u-chef', nom_complet: 'Chef A' });
  const journal: { action: string; detail: string }[] = [];
  const ctx: Ctx = {
    db: db as never,
    session: { userId: 'u-chef', username: 'chef', nomComplet: 'Chef A', role: 'CHEF_BRIGADE' as never },
    log: async (action: string, _c: string, detail: string) => { journal.push({ action, detail }); },
  };
  return { db, ctx, journal };
}

const conteneurs = (...nums: string[]) => ({ conteneurs: nums.map((num) => ({ num, taille: "20'" })), scellesCamion: [] });
const aValider = (id: string, op = 'Enlèvement', extra: Record<string, unknown> = {}) => ({
  id, numero_camion: 'TG' + id.replace(/\D/g, '') + 'AA', type_operation: op, statut: 'Créée',
  date_creation: '2026-10-01T08:00:00.000Z', conteneurs_details: conteneurs('MSKU' + id.replace(/\D/g, '').padStart(7, '0')),
  ...extra,
});
const NON_ENG = { suiviEngagement: false };

/* ------------------------------ natures -------------------------------- */

test('nature : les saisies libres tombent dans la bonne case', () => {
  assert.equal(natureRapportEngagement('BFE 03 Sinkase'), 'BFE 03 Sinkase');
  assert.equal(natureRapportEngagement('bfe03'), 'BFE 03 Sinkase');
  assert.equal(natureRapportEngagement('TRANSIT NATIONAL'), 'Transit national');
  assert.equal(natureRapportEngagement('Transit cotier'), 'Transit côtier');
  assert.equal(natureRapportEngagement('Transit côtier'), 'Transit côtier');
  assert.equal(natureRapportEngagement('TRANSIT SPÉCIAL'), 'Autres');
});

/* --------------------------- engagements ------------------------------- */

test('engagements : comptés à la date de POSE, en camions et en conteneurs, par nature', () => {
  const C = [
    { id: 'A', suiviEngagement: true, engagementType: 'BFE 03 Sinkase', dateCreation: '2026-09-28T08:00:00Z',
      engagementPoseLe: '2026-10-02T09:00:00Z', conteneursDetails: conteneurs('MSKU0000001', 'MSKU0000002') },
    { id: 'B', suiviEngagement: true, engagementType: 'Transit national', engagementPoseLe: '2026-10-05T09:00:00Z',
      engagementEffectueLe: '2026-10-06T09:00:00Z', conteneursDetails: conteneurs('MSKU0000003') },
    // Posé en septembre : hors de la période d'octobre, même si entré en octobre.
    { id: 'C', suiviEngagement: true, engagementType: 'Transit côtier', dateCreation: '2026-10-03T08:00:00Z',
      engagementPoseLe: '2026-09-30T09:00:00Z', conteneursDetails: conteneurs('MSKU0000004') },
    // Ancien engagement sans date de pose : repli sur la validation.
    { id: 'D', suiviEngagement: true, engagementType: 'Transit cotier', dateValidation: '2026-10-07T09:00:00Z',
      conteneursDetails: conteneurs('MSKU0000005') },
    { id: 'E', suiviEngagement: false, engagementPoseLe: '2026-10-05T09:00:00Z' },
  ];
  const r = calculerEngagements(C, { du: '2026-10-01', au: '2026-10-31', cle: moisCle });
  const n = Object.fromEntries(r.natures.map((x) => [x.nature, x]));
  assert.deepEqual([n['BFE 03 Sinkase']!.camions, n['BFE 03 Sinkase']!.conteneurs], [1, 2]);
  assert.deepEqual([n['Transit national']!.camions, n['Transit national']!.soldes], [1, 1]);
  assert.deepEqual([n['Transit côtier']!.camions, n['Transit côtier']!.conteneurs], [1, 1], 'seul D (C est de septembre)');
  assert.deepEqual(r.lignes.map((l) => l['ID']), ['D', 'B', 'A'], 'du plus récent au plus ancien');
  assert.deepEqual(r.seriesCamions, [{ periode: '2026-10', 'BFE 03 Sinkase': 1, 'Transit national': 1, 'Transit côtier': 1, 'Autres': 0 }]);
  assert.equal(r.seriesConteneurs[0]!['BFE 03 Sinkase'], 2);
});

test('engagements : la date de pose est écrite à la signature, gardée en re-validation, effacée au retrait', async () => {
  const { db, ctx } = base([aValider('CT-1', 'Dépotage')]);
  await ecr.valider(ctx, { id: 'CT-1', enSurcharge: false, suiviEngagement: true, engagementType: 'BFE 03 Sinkase', engagementDelai: dansNJours(4) });
  const c = db.store['cargaisons'][0]!;
  const pose = String(c['engagement_pose_le']);
  assert.match(pose, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(pose, c['date_validation']);

  const admin: Ctx = { ...ctx, session: { ...ctx.session, role: 'ADMIN' as never } };
  await new Promise((r) => setTimeout(r, 5));
  await ecr.valider(admin, { id: 'CT-1', enSurcharge: false, suiviEngagement: true, engagementType: 'BFE 03 Sinkase', engagementDelai: dansNJours(4) });
  assert.equal(db.store['cargaisons'][0]!['engagement_pose_le'], pose, 'la re-validation ne déplace pas la date de pose');

  await ecr.engagementRetirer(admin, { id: 'CT-1', motif: 'erreur' });
  assert.equal(db.store['cargaisons'][0]!['engagement_pose_le'], null);
});

test('engagements : un ajout après validation est daté de l\'ajout, et le rapport le compte', async () => {
  const { db, ctx } = base([aValider('CT-2', 'Enlèvement', { date_validation: '2026-09-01T08:00:00.000Z', suivi_engagement: false })]);
  await ecr.engagementAjouter(ctx, { id: 'CT-2', engagementType: 'Transit national', engagementDelai: dansNJours(3), motif: 'oubli' });
  const pose = String(db.store['cargaisons'][0]!['engagement_pose_le']);
  assert.equal(pose.slice(0, 10), new Date().toISOString().slice(0, 10));
  const jour = pose.slice(0, 10);
  const r = (await rap.rapportEngagementsPeriode(ctx, { du: jour, au: jour })) as { natures: { nature: string; camions: number }[] };
  assert.equal(r.natures.find((x) => x.nature === 'Transit national')!.camions, 1);
});

/* ------------------------------ amendes -------------------------------- */

test('amende : enregistrée à la validation d\'un enlèvement (forfait), visible sur la fiche et au journal', async () => {
  const { db, ctx, journal } = base([aValider('CT-3')]);
  await ecr.valider(ctx, { id: 'CT-3', ...NON_ENG, amendeEffets: true, amendeMontant: '150 000' });
  assert.deepEqual(db.store['amendes_effets']!.map((a) => [a['cargaison_id'], a['montant'], a['saisie_par']]), [['CT-3', AMENDE_EFFETS_FORFAIT, 'u-chef']]);
  assert.match(journal.at(-1)!.detail, /amende effets non déclarés : forfait 150 000 FCFA/);
  const fiche = await lec.cargoGet(ctx, { id: 'CT-3' });
  assert.equal(fiche['amendeEffets'], AMENDE_EFFETS_FORFAIT);
});

test('amende : « Non » n\'écrit rien ; champ absent (ancien écran) ne bloque pas ; hors enlèvement ignorée', async () => {
  const { db, ctx } = base([aValider('CT-4'), aValider('CT-5'), aValider('CT-6', 'Dépotage')]);
  await ecr.valider(ctx, { id: 'CT-4', ...NON_ENG, amendeEffets: false });
  await ecr.valider(ctx, { id: 'CT-5', ...NON_ENG });
  await ecr.valider(ctx, { id: 'CT-6', ...NON_ENG, enSurcharge: false, amendeEffets: true, amendeMontant: 250000 });
  assert.deepEqual(db.store['amendes_effets'] ?? [], []);
});

test('amende : « Oui » sans montant est refusé', async () => {
  const { ctx } = base([aValider('CT-7')]);
  await assert.rejects(() => ecr.valider(ctx, { id: 'CT-7', ...NON_ENG, amendeEffets: true, amendeMontant: '' }), /indiquez le montant/);
});

test('amende en LOT : une par camion, jamais recopiée sur tout le lot', async () => {
  const { db, ctx } = base([aValider('CT-8'), aValider('CT-9')]);
  const r = await ecr.validerLot(ctx, {
    ids: ['CT-8', 'CT-9'], ...NON_ENG,
    amendes: { 'CT-8': { amendeEffets: true, amendeMontant: 400000 }, 'CT-9': { amendeEffets: false } },
  });
  assert.equal(r.compte.validees, 2);
  assert.deepEqual(db.store['amendes_effets']!.map((a) => [a['cargaison_id'], a['montant']]), [['CT-8', 400000]]);
});

test('statistiques : camions, conteneurs, total, forfaits et autres, sur la période', async () => {
  const { db, ctx } = base([
    aValider('CT-10', 'Enlèvement', { conteneurs_details: conteneurs('MSKU0000010', 'MSKU0000011') }),
    aValider('CT-11'), aValider('CT-12'),
  ]);
  await ecr.validerLot(ctx, {
    ids: ['CT-10', 'CT-11', 'CT-12'], ...NON_ENG,
    amendes: { 'CT-10': { amendeEffets: true, amendeMontant: AMENDE_EFFETS_FORFAIT }, 'CT-11': { amendeEffets: true, amendeMontant: 600000 } },
  });
  // Une amende saisie l'an dernier ne compte pas cette année.
  db.store['cargaisons'].push({ id: 'CT-OLD', annule: false, archive: false, numero_camion: 'X', type_operation: 'Enlèvement',
    statut: 'Créée', conteneurs_details: conteneurs('MSKU0000099') });
  db.store['amendes_effets']!.push({ cargaison_id: 'CT-OLD', montant: AMENDE_EFFETS_FORFAIT, saisie_le: '2025-01-05T08:00:00.000Z', saisie_par: 'u-chef' });

  const an = new Date().toISOString().slice(0, 4);
  const r = (await rap.rapportAmendes(ctx, { du: `${an}-01-01`, au: `${an}-12-31`, granularite: 'mois' })) as {
    compte: Record<string, number>; lignes: Record<string, string>[]; series: Record<string, unknown>[];
  };
  assert.deepEqual(r.compte, { camions: 2, conteneurs: 3, montantTotal: AMENDE_EFFETS_FORFAIT + 600000, forfaits: 1, autres: 1, montantForfaits: AMENDE_EFFETS_FORFAIT, montantAutres: 600000 });
  assert.deepEqual(r.lignes.map((l) => l['ID']).sort(), ['CT-10', 'CT-11']);
  assert.equal(r.lignes.find((l) => l['ID'] === 'CT-10')!['Saisie par'], 'Chef A');
  assert.equal(r.series.length, 1);
});

test('correction après validation : ajout, changement, retrait, motif obligatoire, permise après sortie', async () => {
  const { db, ctx, journal } = base([aValider('CT-13', 'Enlèvement', {
    date_validation: '2026-10-02T08:00:00.000Z', statut: 'Sortie Enregistrée', date_sortie: '2026-10-03T08:00:00.000Z',
  })]);
  await assert.rejects(() => ecr.amendeDefinir(ctx, { id: 'CT-13', amendeEffets: true, amendeMontant: AMENDE_EFFETS_FORFAIT }), /motif/);
  await controlerApresSortie(ctx, 'cargo.amende', { id: 'CT-13' });
  await ecr.amendeDefinir(ctx, { id: 'CT-13', amendeEffets: true, amendeMontant: AMENDE_EFFETS_FORFAIT, motif: 'constatée à la visite' });
  await ecr.amendeDefinir(ctx, { id: 'CT-13', amendeEffets: true, amendeMontant: 300000, motif: 'reçu complémentaire' });
  assert.deepEqual(db.store['amendes_effets']!.map((a) => a['montant']), [300000]);
  assert.match(journal.at(-1)!.detail, /Avant : forfait 150 000 FCFA → après : 300 000 FCFA/);
  await ecr.amendeDefinir(ctx, { id: 'CT-13', amendeEffets: false, motif: 'saisie en double' });
  assert.deepEqual(db.store['amendes_effets'], []);
});

test('correction : refusée hors enlèvement et avant validation', async () => {
  const { ctx } = base([aValider('CT-14', 'Dépotage', { date_validation: '2026-10-02T08:00:00.000Z' }), aValider('CT-15')]);
  await assert.rejects(() => ecr.amendeDefinir(ctx, { id: 'CT-14', amendeEffets: true, amendeMontant: 1, motif: 'x' }), /que l'enlèvement/);
  await assert.rejects(() => ecr.amendeDefinir(ctx, { id: 'CT-15', amendeEffets: true, amendeMontant: 1, motif: 'x' }), /pas encore validé/);
});

test('droits : chefs et administrateur ; pas les cellules', () => {
  for (const a of ['cargo.amende', 'report.amendes', 'report.engagementsperiode']) {
    for (const r of ['CHEF_BRIGADE', 'CHEF_BRIGADE_ADJOINT', 'CHEF_VISITE', 'CHEF_DIVISION', 'ADMIN'])
      assert.doesNotThrow(() => verifierPermission(r as never, a), `${r} · ${a}`);
    for (const r of ['CFS', 'T1', 'BALISE', 'PP'])
      assert.throws(() => verifierPermission(r as never, a), `${r} · ${a}`);
  }
});

test('versCamel : la colonne de pose arrive bien sous le nom attendu par le rapport', () => {
  assert.equal(versCamel({ engagement_pose_le: 'x' })['engagementPoseLe'], 'x');
});
