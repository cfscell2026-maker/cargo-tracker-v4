/**
 * Rapports calculés par la base (00209, 2026-10-24) : sur un VRAI PostgreSQL
 * (PGlite), les fonctions SQL doivent rendre EXACTEMENT les chiffres du calcul
 * JavaScript, sur un jeu de données qui couvre chaque règle délicate :
 * conteneurs partagés (vrai, faux, "false"), N° en double dans et hors de la
 * période, N° vide, tailles écrites de toutes les façons, anciennes saisies
 * (liste nue, texte JSON, texte illisible), dossiers annulés, archivés,
 * véhicules, opérations autres qu'enlèvement / dépotage, minuit et lundi.
 *
 * Le serveur tourne en UTC : le test aussi.
 */
process.env.TZ = 'UTC';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import type { Ctx } from '../ctx.ts';
import { FakeDB } from './fake-db.ts';
import * as rap from './rapports.ts';

const sql00209 = readFileSync(new URL('../../../migrations/00209_rapports_calcules_en_base.sql', import.meta.url), 'utf8');

/* Générateur déterministe : le même jeu à chaque exécution. */
function alea(graine: number) { let x = graine; return () => (x = (x * 1103515245 + 12345) % 2147483648) / 2147483648; }

const TAILLES: unknown[] = ["20'", "40'", '45', "40' HC", ' 20', '’40', 'X', null, 20, 40, '4O', '', "20 '"];
const OPS = ['Enlèvement', 'Dépotage', 'Sortie Magasin / MAD', 'Conso (type C)'];
const PARTAGE: unknown[] = [undefined, true, false, 'false', 'true', 0, 1, ''];

function jeu(n = 260): Record<string, unknown>[] {
  const r = alea(42);
  const pick = <T,>(a: T[]) => a[Math.floor(r() * a.length)]!;
  const date = (jourMin: number, etendue: number) => {
    const d = new Date(Date.UTC(2026, 8, 1) + Math.floor(r() * etendue + jourMin) * 86400000 + Math.floor(r() * 86400) * 1000);
    return d.toISOString();
  };
  const rows: Record<string, unknown>[] = [];
  for (let i = 0; i < n; i++) {
    const nb = Math.floor(r() * 4);
    const conts = Array.from({ length: nb }, () => {
      const ct: Record<string, unknown> = { num: r() < 0.1 ? '' : 'MSKU' + String(Math.floor(r() * 60)).padStart(7, '0'), taille: pick(TAILLES), type: 'DRY', plomb: 'S' };
      const p = pick(PARTAGE); if (p !== undefined) ct['partage'] = p;
      return ct;
    });
    const forme = r();
    const cd = forme < 0.8 ? { conteneurs: conts, scellesCamion: [] } : forme < 0.9 ? conts : forme < 0.97 ? JSON.stringify({ conteneurs: conts }) : 'pas du json';
    rows.push({
      id: 'CT-' + String(i).padStart(5, '0'), type_operation: pick(OPS), est_vehicule: r() < 0.08,
      date_creation: date(0, 90), date_pose_gps: r() < 0.5 ? date(10, 90) : null, date_sortie: r() < 0.5 ? date(15, 90) : null,
      conteneurs_details: cd, annule: r() < 0.04, archive: r() < 0.04, agent_cfs: 'Agent ' + (i % 3),
    });
  }
  // Bornes exactes : minuit UTC, et dimanche soir / lundi matin.
  rows.push({ id: 'CT-Z1', type_operation: 'Enlèvement', est_vehicule: false, date_creation: '2026-10-01T00:00:00.000Z', conteneurs_details: { conteneurs: [{ num: 'BORD0000001', taille: "20'" }] }, annule: false, archive: false });
  rows.push({ id: 'CT-Z2', type_operation: 'Dépotage', est_vehicule: false, date_creation: '2026-10-31T23:59:59.000Z', conteneurs_details: { conteneurs: [{ num: 'BORD0000002', taille: "40'" }] }, annule: false, archive: false });
  rows.push({ id: 'CT-Z3', type_operation: 'Enlèvement', est_vehicule: false, date_creation: '2026-10-18T23:30:00.000Z', date_pose_gps: '2026-10-19T00:10:00.000Z', conteneurs_details: [], annule: false, archive: false });
  return rows;
}

async function base(rows: Record<string, unknown>[]) {
  const pg = new PGlite();
  await pg.exec(`
    create role anon; create role authenticated; create role service_role;
    create table cargaisons (
      id text primary key, type_operation text, est_vehicule boolean not null default false,
      date_creation timestamptz not null, date_pose_gps timestamptz, date_sortie timestamptz,
      conteneurs_details jsonb, annule boolean not null default false, archive boolean not null default false,
      agent_cfs text not null default '');`);
  await pg.exec(sql00209);
  for (const c of rows)
    await pg.query(
      `insert into cargaisons values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10)`,
      [c['id'], c['type_operation'], c['est_vehicule'] ?? false, c['date_creation'], c['date_pose_gps'] ?? null, c['date_sortie'] ?? null,
        JSON.stringify(c['conteneurs_details']), c['annule'] ?? false, c['archive'] ?? false, c['agent_cfs'] ?? ''],
    );
  const db = new FakeDB();
  for (const c of rows) db.store['cargaisons'].push(structuredClone(c));
  const ctx: Ctx = { db: db as never, session: { userId: 'u', username: 'a', nomComplet: 'A', role: 'ADMIN' as never }, log: async () => {} };
  return { pg, ctx };
}

const PERIODES: [string | null, string | null][] = [[null, null], ['2026-10-01', '2026-10-31'], ['2026-09-15', null], [null, '2026-10-19'], ['2026-10-19', '2026-10-19']];

test('Analyse des flux : SQL (00209) = JavaScript, chaque granularité, chaque période', async () => {
  const { pg, ctx } = await base(jeu());
  for (const gran of ['mois', 'semaine', 'annee', 'jour'])
    for (const [du, au] of PERIODES) {
      const js = await rap.rapportFlux(ctx, { du: du ?? '', au: au ?? '', granularite: gran }) as { rows: unknown[]; totaux: unknown };
      const { rows } = await pg.query<{ r: { rows: unknown[]; totaux: unknown } }>('select fn_rapport_flux($1::date, $2::date, $3) as r', [du, au, gran]);
      assert.deepEqual(rows[0]!.r.rows, js.rows, `flux ${gran} ${du}→${au} : lignes`);
      assert.deepEqual(rows[0]!.r.totaux, js.totaux, `flux ${gran} ${du}→${au} : totaux`);
    }
  await pg.close();
});

test('Rapport CFS : SQL (00209) = JavaScript, chaque période', async () => {
  const { pg, ctx } = await base(jeu());
  for (const [du, au] of PERIODES) {
    const js = await rap.rapportCFS(ctx, { du: du ?? undefined, au: au ?? undefined }) as { parOp: unknown; total: unknown };
    const { rows } = await pg.query<{ r: { parOp: unknown; total: unknown } }>('select fn_rapport_cfs($1::date, $2::date) as r', [du, au]);
    assert.deepEqual(rows[0]!.r.parOp, js.parOp, `cfs ${du}→${au} : par opération`);
    assert.deepEqual(rows[0]!.r.total, js.total, `cfs ${du}→${au} : total`);
  }
  await pg.close();
});

test('le jeu couvre bien les cas délicats', () => {
  const rows = jeu();
  const conts = rows.flatMap((c) => {
    const cd = c['conteneurs_details'];
    return Array.isArray(cd) ? cd : cd && typeof cd === 'object' ? ((cd as { conteneurs: unknown[] }).conteneurs ?? []) : [];
  }) as Record<string, unknown>[];
  const nums = conts.map((c) => c['num']).filter(Boolean);
  assert.ok(new Set(nums).size < nums.length, 'des N° en double');
  assert.ok(conts.some((c) => c['partage'] === 'false'), 'un partage écrit "false"');
  assert.ok(rows.some((c) => typeof c['conteneurs_details'] === 'string'), 'des anciennes saisies en texte');
});
