/**
 * Lectures du stock allégées (2026-10-25, audit des requêtes) : la liste, le
 * séjour des conteneurs et l'export ne lisent plus que les colonnes qu'ils
 * emploient, et les écrans de saisie ne reçoivent que le statut demandé.
 * Chaque rapport doit rendre EXACTEMENT ce qu'il rendait en lisant la ligne
 * entière et sans filtre SQL.
 */
process.env.TZ = 'UTC';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Ctx } from '../ctx.ts';
import { FakeDB } from './fake-db.ts';
import * as stk from './stock.ts';
import * as rap from './rapports.ts';

function alea(graine: number) { let x = graine; return () => (x = (x * 1103515245 + 12345) % 2147483648) / 2147483648; }

const AUJOURDHUI = new Date().toISOString();
function jeu(n = 300): Record<string, unknown>[] {
  const r = alea(7);
  const pick = <T,>(a: T[]) => a[Math.floor(r() * a.length)]!;
  const date = () => (r() < 0.9 ? new Date(Date.UTC(2026, 3, 1) + r() * 200 * 86400000).toISOString() : null);
  return Array.from({ length: n }, (_, i) => ({
    numero_tc: 'TCLU' + String(i).padStart(7, '0'), taille: pick(["20'", "40'", '45', '']), type_conteneur: pick(['DRY', 'REEFER', '']),
    provenance: pick(['PAL', 'LCT', '']), date_entree: date(), statut: pick(['En stock', 'Positionné', 'Dépoté']),
    date_positionne: date(), date_pointage: r() < 0.5 ? date() : (r() < 0.5 ? AUJOURDHUI : null), pointe_par: pick(['', 'agent1']),
    date_depote: date(), cargaison_id: r() < 0.3 ? 'CT-' + i : null, observations: pick(['Entrée magasin', 'RAS', '']),
    nb_sejours_import: Math.floor(r() * 40), annee_declaration: pick(['', '2026']), type_declaration: pick(['', 'T', 'C']), numero_declaration: pick(['', 'D' + i]),
  }));
}

/** `ligneEntiere` : chaque lecture rend la ligne complète et ignore les filtres (sauf la pagination). */
function base(ligneEntiere: boolean): Ctx {
  const db = new FakeDB();
  for (const s of jeu()) db.store['stock'].push(s);
  if (ligneEntiere) {
    (db.store as unknown as { __sansFiltres: boolean }).__sansFiltres = true;
    const from = db.from.bind(db);
    // deno-lint-ignore no-explicit-any
    (db as any).from = (t: string) => { const q = from(t); const sel = q.select.bind(q); q.select = (_c?: string, o?: { head?: boolean }) => sel('*', o); return q; };
  }
  return { db: db as never, session: { userId: 'u', username: 'a', nomComplet: 'A', role: 'ADMIN' as never }, log: async () => {} };
}

for (const statut of ['tous', 'En stock', 'Positionné', 'Dépoté'])
  test(`liste du stock (${statut}) : colonnes lues suffisantes`, async () => {
    assert.deepEqual(await stk.stockList(base(false), { statut }), await stk.stockList(base(true), { statut }));
  });

for (const statut of ['En stock', 'Positionné'])
  test(`liste du stock, lignes seules (${statut}) : mêmes conteneurs que la liste complète`, async () => {
    const seules = await stk.stockList(base(false), { statut, lignesSeules: true }) as { rows: unknown[]; compte?: unknown };
    const complet = await stk.stockList(base(true), { statut });
    assert.ok(seules.rows.length > 0);
    assert.deepEqual(seules.rows, complet.rows);
    assert.equal(seules.compte, undefined, 'aucun compteur partiel');
  });

test('lignes seules sans statut précis : liste et compteurs complets', async () => {
  assert.deepEqual(await stk.stockList(base(false), { statut: 'tous', lignesSeules: true }), await stk.stockList(base(true), { statut: 'tous' }));
});

for (const p of [{}, { du: '2026-05-01', au: '2026-07-31' }])
  test(`séjour des conteneurs ${JSON.stringify(p)} : colonnes lues suffisantes`, async () => {
    // Les bornes de période sont un filtre SQL voulu : on ne compare que les colonnes.
    const db = (lignes: boolean) => { const c = base(false); if (lignes) { const d = c.db as unknown as FakeDB; const from = d.from.bind(d);
      // deno-lint-ignore no-explicit-any
      (d as any).from = (t: string) => { const q = from(t); const sel = q.select.bind(q); q.select = (_c?: string, o?: { head?: boolean }) => sel('*', o); return q; }; } return c; };
    assert.deepEqual(await stk.rapportStock(db(false), p), await stk.rapportStock(db(true), p));
  });

for (const statut of ['', 'En stock', 'Positionné', 'Dépoté'])
  test(`export des conteneurs (${statut || 'tous'}) : colonnes et statut SQL sans effet`, async () => {
    const p = { statut, du: '2026-05-01', au: '2026-09-30' };
    assert.deepEqual(await rap.rapportConteneurs(base(false), p), await rap.rapportConteneurs(base(true), p));
  });

const CHAMPS_ECRAN_STOCK = ['numeroTC', 'taille', 'statut', 'provenance', 'numeroDeclaration', 'joursSejour'];
for (const statut of ['tous', 'En stock', 'Dépoté'])
  test(`liste allégée de l'écran Stock (${statut}) : les champs affichés, mêmes compteurs`, async () => {
    const legere = await stk.stockList(base(false), { statut, allege: true }) as { rows: Record<string, unknown>[]; compte: unknown };
    const complete = await stk.stockList(base(true), { statut }) as { rows: Record<string, unknown>[]; compte: unknown };
    assert.ok(legere.rows.length > 0);
    assert.deepEqual(legere.compte, complete.compte);
    assert.deepEqual(legere.rows, complete.rows.map((r) => Object.fromEntries(CHAMPS_ECRAN_STOCK.map((k) => [k, r[k]]))));
  });
