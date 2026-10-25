/**
 * Délai & instance et Par destination calculés par la base (00211,
 * 2026-10-25) : sur un VRAI PostgreSQL (PGlite), mêmes résultats que le calcul
 * JavaScript, cas délicats compris (statut « Sortie » sans date de sortie,
 * véhicules, annulés, archivés, destinations écrites de toutes les façons,
 * anciens textes libres, bornes de période).
 */
process.env.TZ = 'UTC';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import type { Ctx } from '../ctx.ts';
import { FakeDB } from './fake-db.ts';
import * as rap from './rapports.ts';
import { DESTINATION_CODES } from '../../_shared/domaine/src/index.ts';

const lire = (f: string) => readFileSync(new URL('../../../migrations/' + f, import.meta.url), 'utf8');

function alea(graine: number) { let x = graine; return () => (x = (x * 1103515245 + 12345) % 2147483648) / 2147483648; }
const DEST = ['OUAGADOUGOU', 'ouaga', 'Niamey', 'BAMAKO', 'TG', 'Lomé', '', null, 'BF', 'b.f.', 'NIGER - NIAMEY', 'XYZ', ...DESTINATION_CODES];

function jeu(n = 300): Record<string, unknown>[] {
  const r = alea(5);
  const pick = <T,>(a: T[]) => a[Math.floor(r() * a.length)]!;
  const rows: Record<string, unknown>[] = [];
  for (let i = 0; i < n; i++) {
    const creation = new Date(Date.UTC(2026, 0, 1) + r() * 290 * 86400000).toISOString();
    const statut = pick(['Sortie Enregistrée', 'Sortie Enregistrée', 'Sortie Enregistrée', 'Créée', 'T1 Saisi']);
    const avecSortie = statut === 'Sortie Enregistrée' ? r() < 0.95 : r() < 0.05; // incohérences volontaires
    rows.push({
      id: 'CT-' + String(i).padStart(5, '0'), numero_camion: 'TG' + i, type_operation: pick(['Enlèvement', 'Dépotage', 'Sortie Magasin / MAD']),
      statut, est_vehicule: r() < 0.1, destination_marchandise: pick(DEST), date_creation: creation,
      date_sortie: avecSortie ? new Date(Date.parse(creation) + (r() * 120 - 5) * 86400000).toISOString() : null,
      annule: r() < 0.03, archive: r() < 0.04,
    });
  }
  return rows;
}

async function base(rows: Record<string, unknown>[]) {
  const pg = new PGlite();
  await pg.exec(`
    create role anon; create role authenticated; create role service_role;
    create table cargaisons (id text primary key, numero_camion text, type_operation text, statut text,
      est_vehicule boolean not null default false, destination_marchandise text, date_creation timestamptz not null,
      date_sortie timestamptz, date_pose_gps timestamptz, conteneurs_details jsonb,
      annule boolean not null default false, archive boolean not null default false);`);
  await pg.exec(lire('00209_rapports_calcules_en_base.sql'));
  await pg.exec(lire('00211_rapports_sejour_destinations_en_base.sql'));
  for (const c of rows)
    await pg.query('insert into cargaisons (id, numero_camion, type_operation, statut, est_vehicule, destination_marchandise, date_creation, date_sortie, annule, archive) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
      [c['id'], c['numero_camion'], c['type_operation'], c['statut'], c['est_vehicule'], c['destination_marchandise'], c['date_creation'], c['date_sortie'], c['annule'], c['archive']]);
  const db = new FakeDB();
  db.vueStats = true;
  for (const c of rows) db.store['cargaisons'].push(structuredClone(c));
  const ctx: Ctx = { db: db as never, session: { userId: 'u', username: 'a', nomComplet: 'A', role: 'ADMIN' as never }, log: async () => {} };
  return { pg, ctx };
}

test('Délai & instance : SQL (00211) = JavaScript', async () => {
  const { pg, ctx } = await base(jeu());
  const maintenant = new Date().toISOString();
  const js = await rap.rapportSejour(ctx, {}) as Record<string, unknown>;
  const { rows } = await pg.query<{ r: Record<string, unknown> }>('select fn_rapport_sejour($1::timestamptz, $2) as r', [maintenant, js['seuil']]);
  assert.deepEqual(rows[0]!.r['compte'], js['compte'], 'comptes');
  assert.deepEqual(rows[0]!.r['tranches'], js['tranches'], 'tranches');
  assert.deepEqual(rows[0]!.r['instance'], js['instance'], 'dossiers en instance, dans le même ordre');
  await pg.close();
});

test('Par destination : SQL (00211) = JavaScript, chaque granularité et période', async () => {
  const { pg, ctx } = await base(jeu());
  for (const gran of ['mois', 'semaine', 'annee'])
    for (const [du, au] of [[null, null], ['2026-01-01', '2026-12-31'], ['2026-03-15', '2026-06-30']] as [string | null, string | null][]) {
      const js = await rap.rapportDestinations(ctx, { du: du ?? '', au: au ?? '', granularite: gran }) as Record<string, unknown>;
      const { rows } = await pg.query<{ r: Record<string, unknown> }>('select fn_rapport_destinations($1::date, $2::date, $3, $4::text[]) as r', [du, au, gran, [...DESTINATION_CODES]]);
      assert.deepEqual(rows[0]!.r['parDest'], js['parDest'], `parDest ${gran} ${du}`);
      assert.equal(rows[0]!.r['total'], js['total'], `total ${gran} ${du}`);
      assert.deepEqual(rows[0]!.r['series'], js['series'], `series ${gran} ${du}`);
    }
  await pg.close();
});
