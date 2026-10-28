/**
 * Stock en un aller-retour et KPI calculés par la base (00212, 2026-10-25) :
 * sur un VRAI PostgreSQL (PGlite), mêmes résultats que la lecture paginée et le
 * calcul JavaScript. Cas délicats : dates d'entrée absentes ou pile sur les
 * bornes, statuts, tailles écrites de toutes les façons, conteneurs partagés,
 * anciennes saisies (liste nue, texte JSON, texte illisible), statut vide,
 * véhicules, annulés, archivés. La vue allégée enrichie doit aussi passer.
 */
process.env.TZ = 'UTC';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import type { Ctx } from '../ctx.ts';
import { FakeDB } from './fake-db.ts';
import * as rap from './rapports.ts';
import * as stk from './stock.ts';

const lire = (f: string) => readFileSync(new URL('../../../migrations/' + f, import.meta.url), 'utf8');
function alea(graine: number) { let x = graine; return () => (x = (x * 1103515245 + 12345) % 2147483648) / 2147483648; }

const TAILLES: unknown[] = ["20'", "40'", '45', "40' HC", ' 20', '’40', 'X', null, 20, '', "20 '"];
const PARTAGE: unknown[] = [undefined, true, false, 'false', 0, 1, ''];

function cargaisons(n = 240): Record<string, unknown>[] {
  const r = alea(9);
  const pick = <T,>(a: T[]) => a[Math.floor(r() * a.length)]!;
  return Array.from({ length: n }, (_, i) => {
    const conts = Array.from({ length: Math.floor(r() * 4) }, () => {
      const ct: Record<string, unknown> = { num: 'MSKU' + String(Math.floor(r() * 80)).padStart(7, '0'), taille: pick(TAILLES), type: 'DRY', plomb: 'S' };
      const p = pick(PARTAGE); if (p !== undefined) ct['partage'] = p;
      return ct;
    });
    const f = r();
    return {
      id: 'CT-' + String(i).padStart(5, '0'), type_operation: pick(['Enlèvement', 'Dépotage', 'Sortie Magasin / MAD']),
      statut: pick(['Sortie Enregistrée', 'Sortie Enregistrée', 'Créée', 'T1 Saisi', '']), est_vehicule: r() < 0.08,
      date_creation: new Date(Date.UTC(2026, 6, 1) + r() * 110 * 86400000).toISOString(),
      conteneurs_details: f < 0.8 ? { conteneurs: conts, scellesCamion: [] } : f < 0.9 ? conts : f < 0.97 ? JSON.stringify({ conteneurs: conts }) : 'pas du json',
      annule: r() < 0.04, archive: r() < 0.04,
    };
  });
}

function stock(n = 260): Record<string, unknown>[] {
  const r = alea(3);
  const pick = <T,>(a: T[]) => a[Math.floor(r() * a.length)]!;
  const date = () => (r() < 0.9 ? new Date(Date.UTC(2026, 3, 1) + Math.floor(r() * 200) * 86400000 + Math.floor(r() * 86400) * 1000).toISOString() : null);
  const lignes = Array.from({ length: n }, (_, i) => ({
    numero_tc: 'TCLU' + String((i * 7919) % 10000000).padStart(7, '0'), taille: pick(["20'", "40'", '45', "40' HC", '', 'X']),
    type_conteneur: pick(['DRY', '']), provenance: pick(['PAL', '']), date_entree: date(), statut: pick(['En stock', 'Positionné', 'Dépoté']),
    date_pointage: r() < 0.5 ? date() : null, pointe_par: pick(['', 'agent1']), date_depote: date(), cargaison_id: null,
    observations: pick(['', 'RAS']), nb_sejours_import: Math.floor(r() * 40),
    annee_declaration: pick(['', '2026']), type_declaration: pick(['', 'T']), numero_declaration: pick(['', 'D' + i]),
  }));
  // Pile sur les bornes testées plus bas.
  lignes.push({ ...lignes[0]!, numero_tc: 'BORD0000001', date_entree: '2026-05-01T00:00:00.000Z' });
  lignes.push({ ...lignes[0]!, numero_tc: 'BORD0000002', date_entree: '2026-07-31T23:59:59.000Z' });
  lignes.push({ ...lignes[0]!, numero_tc: 'BORD0000003', date_entree: '2026-04-30T23:59:59.000Z' });
  return lignes;
}

async function bases() {
  const pg = new PGlite();
  await pg.exec(`
    create role anon; create role authenticated; create role service_role;
    create table cargaisons (id text primary key, numero_camion text not null default '', type_operation text, statut text,
      est_vehicule boolean not null default false, agent_cfs text not null default '', date_creation timestamptz not null,
      date_validation timestamptz, date_t1 timestamptz, date_bon_sortie timestamptz, date_pose_gps timestamptz, date_sortie timestamptz,
      hors_gabarit boolean, en_surcharge boolean, destination_marchandise text, conteneurs_details jsonb,
      annule boolean not null default false, archive boolean not null default false,
      agent_entree text not null default '', agent_validation text not null default '', agent_t1 text not null default '',
      agent_bon_sortie text not null default '', agent_balise text not null default '', agent_pp text not null default '',
      nb_conteneurs integer not null default 0);
    create table stock (numero_tc text primary key, taille text not null default '', type_conteneur text not null default '',
      provenance text not null default '', date_entree timestamptz, statut text not null default 'En stock',
      date_positionne timestamptz, date_pointage timestamptz, pointe_par text not null default '', date_depote timestamptz,
      cargaison_id text, observations text not null default '', nb_sejours_import integer not null default 0,
      annee_declaration text not null default '', type_declaration text not null default '', numero_declaration text not null default '');`);
  await pg.exec(lire('00208_vue_cargaisons_stats.sql'));
  await pg.exec(lire('00209_rapports_calcules_en_base.sql'));
  await pg.exec(lire('00212_stock_kpi_horodatage_en_base.sql'));
  const cs = cargaisons();
  for (const c of cs)
    await pg.query('insert into cargaisons (id, type_operation, statut, est_vehicule, date_creation, conteneurs_details, annule, archive) values ($1,$2,$3,$4,$5,$6::jsonb,$7,$8)',
      [c['id'], c['type_operation'], c['statut'], c['est_vehicule'], c['date_creation'], JSON.stringify(c['conteneurs_details']), c['annule'], c['archive']]);
  for (const s of stock())
    await pg.query(`insert into stock select * from jsonb_populate_record(null::stock, $1::jsonb)`, [JSON.stringify(s)]);
  // Les lignes du stock telles que PostgREST les rend (mêmes formats de date).
  const canon = (await pg.query<{ r: Record<string, unknown> }>('select to_jsonb(s) as r from stock s')).rows.map((x) => x.r);

  const ctxDe = (sql: boolean): Ctx => {
    const db = new FakeDB();
    for (const c of cs) db.store['cargaisons'].push(structuredClone(c));
    for (const s of canon) db.store['stock'].push(structuredClone(s));
    if (sql) {
      const rpc = db.rpc.bind(db);
      // deno-lint-ignore no-explicit-any
      (db as any).rpc = async (nom: string, a: Record<string, unknown>) => {
        if (nom === 'fn_stock_lignes')
          return { data: (await pg.query<{ r: unknown }>('select fn_stock_lignes($1::timestamptz, $2::timestamptz, $3) as r', [a['p_du'], a['p_au'], a['p_statut']])).rows[0]!.r, error: null };
        if (nom === 'fn_rapport_kpi')
          return { data: (await pg.query<{ r: unknown }>('select fn_rapport_kpi($1::date, $2::date) as r', [a['p_du'], a['p_au']])).rows[0]!.r, error: null };
        return rpc(nom, a);
      };
    }
    return { db: db as never, session: { userId: 'u', username: 'a', nomComplet: 'A', role: 'ADMIN' as never }, log: async () => {} };
  };
  return { pg, sql: ctxDe(true), js: ctxDe(false) };
}

test('stock en un aller-retour (00212) = lecture paginée : liste, séjour, export', async () => {
  const { pg, sql, js } = await bases();
  for (const statut of ['tous', 'En stock', 'Positionné', 'Dépoté']) {
    assert.deepEqual(await stk.stockList(sql, { statut }), await stk.stockList(js, { statut }), `liste ${statut}`);
    assert.deepEqual(await stk.stockList(sql, { statut, lignesSeules: true }), await stk.stockList(js, { statut, lignesSeules: true }), `lignes seules ${statut}`);
  }
  for (const p of [{}, { du: '2026-05-01', au: '2026-07-31' }, { du: '2026-05-01' }, { au: '2026-04-30' }])
    assert.deepEqual(await stk.rapportStock(sql, p), await stk.rapportStock(js, p), `séjour ${JSON.stringify(p)}`);
  for (const statut of ['', 'Positionné'])
    assert.deepEqual(await rap.rapportConteneurs(sql, { statut }), await rap.rapportConteneurs(js, { statut }), `export ${statut}`);
  await pg.close();
});

test('la fonction rend bien les lignes : bornes incluses, dates absentes écartées dès qu\'une borne est posée', async () => {
  const { pg } = await bases();
  const n = async (du: string | null, au: string | null) =>
    ((await pg.query<{ r: unknown[] }>('select fn_stock_lignes($1::timestamptz, $2::timestamptz, null) as r', [du, au])).rows[0]!.r).length;
  const tout = await n(null, null);
  assert.equal(tout, 263);
  const dans = await n('2026-05-01T00:00:00', '2026-07-31T23:59:59.999');
  assert.ok(dans > 0 && dans < tout);
  const r = (await pg.query<{ r: { numero_tc: string }[] }>("select fn_stock_lignes('2026-05-01T00:00:00', '2026-07-31T23:59:59.999', null) as r")).rows[0]!.r.map((x) => x.numero_tc);
  assert.ok(r.includes('BORD0000001') && r.includes('BORD0000002') && !r.includes('BORD0000003'));
  await pg.close();
});

test('KPI (00212) = JavaScript, sans période et sur des périodes', async () => {
  const { pg, sql, js } = await bases();
  for (const p of [{}, { du: '2026-07-01', au: '2026-07-31' }, { du: '2026-08-15', au: '2026-10-31' }]) {
    const attendu = await rap.rapportKPI(js, p) as Record<string, unknown>;
    assert.ok(Number(attendu['camionsSortis']) > 0 && Number(attendu['videsDepotage']) > 0, 'jeu significatif');
    assert.deepEqual(await rap.rapportKPI(sql, p), attendu, `KPI ${JSON.stringify(p)}`);
  }
  await pg.close();
});

test('la vue allégée enrichie (00212) garde ses colonnes et ajoute agents et nombre de conteneurs', async () => {
  const { pg } = await bases();
  const cols = (await pg.query<{ column_name: string }>("select column_name from information_schema.columns where table_name = 'v_cargaisons_stats' order by ordinal_position")).rows.map((x) => x.column_name);
  assert.deepEqual(cols.slice(0, 18), ['id', 'numero_camion', 'type_operation', 'statut', 'est_vehicule', 'agent_cfs', 'date_creation',
    'date_validation', 'date_t1', 'date_bon_sortie', 'date_pose_gps', 'date_sortie', 'hors_gabarit', 'en_surcharge',
    'destination_marchandise', 'annule', 'archive', 'conteneurs_details']);
  assert.deepEqual(cols.slice(18), ['agent_entree', 'agent_validation', 'agent_t1', 'agent_bon_sortie', 'agent_balise', 'agent_pp', 'nb_conteneurs']);
  await pg.close();
});
