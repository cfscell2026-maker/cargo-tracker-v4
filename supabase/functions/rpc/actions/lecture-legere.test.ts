/**
 * Lecture légère des rapports (2026-10-25) : sans les blocs JSON qu'ils
 * n'ouvrent pas. Deux garanties :
 *   1. la liste des colonnes est EXACTEMENT celle des migrations ;
 *   2. chaque rapport rend le MÊME résultat en lecture légère et en lecture
 *      complète (forcée en faisant échouer la lecture légère), sur des dossiers
 *      dont tous les champs sont renseignés. Le double de test ne rend que les
 *      colonnes demandées : un champ oublié se verrait.
 */
process.env.TZ = 'UTC';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import type { Ctx } from '../ctx.ts';
import { FakeDB } from './fake-db.ts';
import * as rap from './rapports.ts';

test('COLONNES_CARGAISONS = les colonnes déclarées par les migrations', () => {
  const dossier = new URL('../../../migrations/', import.meta.url);
  const cols = new Set<string>();
  for (const f of readdirSync(dossier).filter((x) => x.endsWith('.sql')).sort()) {
    const sql = readFileSync(new URL(f, dossier), 'utf8').replace(/--[^\n]*/g, '');
    const t = /create table cargaisons \(([\s\S]*?)\n\);/.exec(sql);
    if (t) for (const l of t[1]!.split('\n')) { const m = /^\s*([a-z_0-9]+)\s+[a-z]/.exec(l); if (m && m[1] !== 'constraint') cols.add(m[1]!); }
    for (const a of sql.matchAll(/alter table (?:if exists )?cargaisons([\s\S]*?);/g))
      for (const m of a[1]!.matchAll(/add column (?:if not exists )?([a-z_0-9]+)/g)) cols.add(m[1]!);
  }
  assert.deepEqual([...rap.COLONNES_CARGAISONS].sort(), [...cols].sort());
});

function alea(graine: number) { let x = graine; return () => (x = (x * 1103515245 + 12345) % 2147483648) / 2147483648; }

function jeu(n = 180): Record<string, unknown>[] {
  const r = alea(7);
  const pick = <T,>(a: T[]) => a[Math.floor(r() * a.length)]!;
  const d = (j0: number, j: number) => r() < 0.25 ? null : new Date(Date.UTC(2026, 8, 1) + (j0 + r() * j) * 86400000).toISOString();
  const rows: Record<string, unknown>[] = [];
  for (let i = 0; i < n; i++) {
    const creation = new Date(Date.UTC(2025, 9, 1) + r() * 420 * 86400000).toISOString();
    rows.push({
      id: 'CT-' + String(i).padStart(5, '0'), reference: 'R' + i, numero_camion: 'TG' + i + 'AB', numero_camion_norm: 'TG' + i + 'AB',
      type_operation: pick(['Enlèvement', 'Dépotage', 'Sortie Magasin / MAD', 'Conso (type C)', 'Dépotage / Véhicule']),
      twins: r() < 0.1, statut: pick(['Camion créé', 'En cours de chargement', 'Créée', 'T1 Saisi', 'GPS Posé', 'Sortie Enregistrée']),
      declarant: 'STE ' + (i % 7), numero_declaration: String(1000 + (i % 40)), annee_declaration: '2026', bureau_declaration: 'TG120',
      type_declaration: pick(['T', 'C', 'S', 'A', 'E']), destination_marchandise: pick(['KARA', 'OUAGADOUGOU', 'NIAMEY', 'TG']),
      description_marchandise: 'MARCHANDISE ' + i, agent_cfs: 'Agent ' + (i % 3), numero_gps: r() < 0.5 ? 'GPS' + i : '',
      numero_dispense: pick(['', 'DISP-' + i, 'ESC-' + i, 'escorte ' + i]), type_exemption: pick([null, 'dispense', 'escorte']),
      balise_requise: pick([null, true, false]), saute_t1: r() < 0.3, saute_balise: r() < 0.3, saute_bs: r() < 0.2,
      arrivee_bureau: r() < 0.3, date_arrivee_bureau: d(20, 60), est_vehicule: r() < 0.15,
      date_creation: creation, date_fin_chargement: d(0, 60), date_validation: d(1, 60), date_t1: d(2, 60), date_bon_sortie: d(3, 60),
      date_pose_gps: d(4, 60), date_sortie: d(5, 60), hors_gabarit: pick([null, true]), en_surcharge: pick([null, true, false]),
      agent_validation: 'Chef', agent_t1: 'T1', agent_balise: 'Balise', agent_pp: 'PP', agent_bon_sortie: 'BS',
      t1_numeros: [{ conteneur: '', numero: 'T1-' + i }], bon_sortie_numero: 'BS-' + i, bureau_destination: 'BF OUAGA',
      suivi_engagement: r() < 0.2, engagement_type: 'BFE 03 Sinkase',
      conteneurs_details: { conteneurs: [{ num: 'MSKU' + String(i).padStart(7, '0'), taille: pick(["20'", "40'", '45']), type: 'DRY', plomb: 'P' + i,
        numeroDeclaration: String(2000 + i), declarant: 'STE X', typeDeclaration: 'T' }], scellesCamion: ['S1'] },
      mixte_details: [{ note: 'x' }], vehicule_details: { chassis: 'VIN' + i, destination: 'BURKINA' }, pp_checklist: { cfs: true },
      annule: r() < 0.04, archive: r() < 0.04,
    });
  }
  return rows;
}

function base(legere: boolean) {
  const db = new FakeDB();
  for (const c of jeu()) db.store['cargaisons'].push(c);
  if (!legere) {
    // Lecture légère rendue impossible : le chargeur retombe sur la lecture complète.
    const origine = db.from.bind(db);
    (db as unknown as { from: (t: string) => unknown }).from = (t: string) => {
      const q = origine(t) as unknown as { select: (c?: string, o?: unknown) => unknown };
      if (t === 'cargaisons') {
        const sel = q.select.bind(q);
        q.select = (c?: string, o?: unknown) => {
          if (c && c.includes('engagement_pose_le')) throw new Error('lecture légère refusée (test)');
          return sel(c, o);
        };
      }
      return q;
    };
  }
  const ctx: Ctx = { db: db as never, session: { userId: 'u', username: 'a', nomComplet: 'A', role: 'ADMIN' as never }, log: async () => {} };
  return ctx;
}

const RAPPORTS: [string, (ctx: Ctx) => Promise<unknown>][] = [
  ['goulots', (ctx) => rap.rapportGoulots(ctx, {})],
  ['dispenses', (ctx) => rap.rapportDispenses(ctx, {})],
  ['délai & instance', (ctx) => rap.rapportSejour(ctx, {})],
  ['temps de passage', (ctx) => rap.rapportTemps(ctx, { du: '2026-09-01', au: '2026-12-31' })],
  ['temps de passage (tout)', (ctx) => rap.rapportTemps(ctx, {})],
  ...(['t1', 'balise', 'pp', 'bonsortie'] as const).map((kind) =>
    [`activité ${kind}`, (ctx: Ctx) => rap.rapportActivite(ctx, { kind, du: '2026-09-01', au: '2026-12-31' })] as [string, (ctx: Ctx) => Promise<unknown>]),
];

for (const [nom, f] of RAPPORTS)
  test(`lecture légère : ${nom} identique à la lecture complète`, async () => {
    const legere = await f(base(true));
    const complete = await f(base(false));
    assert.deepEqual(legere, complete);
  });
