/**
 * `fetchAll` — lecture par blocs EN PARALLÈLE (2026-09-24, lenteur).
 *
 * Ce qui compte ici n'est pas la vitesse — un double en mémoire ne la mesure
 * pas — mais que la lecture parallèle rende EXACTEMENT les mêmes lignes que la
 * lecture bloc par bloc : ni manquante, ni en double, dans un ordre stable.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Ctx } from '../ctx.ts';
import { FakeDB } from './fake-db.ts';
import { fetchAll } from './helpers.ts';
import * as stk from './stock.ts';

const ctxAvec = (db: unknown): Ctx => ({
  db: db as never,
  session: { userId: 'u', username: 'u', nomComplet: 'U', role: 'ADMIN' as never },
  log: async () => {},
});

/** 3 500 cargaisons, insérées dans le désordre, avec des dates en double. */
function base(n = 3500): FakeDB {
  const db = new FakeDB();
  for (let i = n; i >= 1; i--) {
    db.store['cargaisons'].push({
      id: 'CT-' + String(i).padStart(6, '0'),
      date_creation: '2026-09-' + String((i % 20) + 1).padStart(2, '0') + 'T08:00:00Z',
    });
  }
  return db;
}

test('fetchAll : 3 500 lignes, toutes lues une seule fois, triées par clé', async () => {
  const lignes = await fetchAll(ctxAvec(base()), 'cargaisons', 'id');
  assert.equal(lignes.length, 3500);
  const ids = lignes.map((r) => String(r['id']));
  assert.equal(new Set(ids).size, 3500, 'aucune ligne en double');
  assert.deepEqual(ids, [...ids].sort(), 'ordre stable : la clé primaire');
});

test('fetchAll : un tri sur une colonne à doublons est départagé par la clé', async () => {
  const lignes = await fetchAll(ctxAvec(base()), 'cargaisons', 'id, date_creation', { colonne: 'date_creation', ascendant: false });
  assert.equal(new Set(lignes.map((r) => r['id'])).size, 3500);
  for (let i = 1; i < lignes.length; i++) {
    const [a, b] = [lignes[i - 1]!, lignes[i]!];
    const da = String(a['date_creation']), dbb = String(b['date_creation']);
    assert.ok(da > dbb || (da === dbb && String(a['id']) < String(b['id'])), 'date décroissante, puis id croissant');
  }
});

test('fetchAll : filtre SQL conservé sur chaque bloc', async () => {
  const lignes = await fetchAll(ctxAvec(base()), 'cargaisons', 'id', undefined, (q) => q.gte('id', 'CT-001001'));
  assert.equal(lignes.length, 2500);
});

test('fetchAll : sans nombre total (ancien serveur), la lecture bloc par bloc prend le relais', async () => {
  const db = base(2500);
  const sansCompte = {
    from: (t: string) => {
      const q = db.from(t);
      const then = q.then.bind(q);
      (q as unknown as { then: unknown }).then = (f: (v: unknown) => unknown) =>
        then((v) => f({ ...v, count: undefined }));
      return q;
    },
  };
  const lignes = await fetchAll(ctxAvec(sansCompte), 'cargaisons', 'id');
  assert.equal(lignes.length, 2500);
});

test('fetchAll : des lignes ajoutées APRÈS le comptage sont quand même lues', async () => {
  const db = base(2000);
  let appels = 0;
  const vivante = {
    from: (t: string) => {
      // Un agent crée 1 500 dossiers juste après le premier bloc.
      if (++appels === 2) {
        for (let i = 2001; i <= 3500; i++) db.store['cargaisons'].push({ id: 'CT-' + String(i).padStart(6, '0') });
      }
      return db.from(t);
    },
  };
  const lignes = await fetchAll(ctxAvec(vivante), 'cargaisons', 'id');
  assert.equal(lignes.length, 3500);
  assert.equal(new Set(lignes.map((r) => r['id'])).size, 3500);
});

/* ---- Compteurs après pointage : comptés par la base, identiques à la liste ---- */
test('pointage : les compteurs rendus sont ceux de la liste du stock, sans la recharger', async () => {
  const db = new FakeDB();
  const aujourdhui = new Date().toISOString();
  db.store['stock'].push(
    { numero_tc: 'MSKU0000001', statut: 'En stock' },
    { numero_tc: 'MSKU0000002', statut: 'Positionné', date_pointage: '2026-01-10T09:00:00.000Z' }, // reste
    { numero_tc: 'MSKU0000003', statut: 'Positionné', date_pointage: aujourdhui },                 // du jour
    { numero_tc: 'MSKU0000004', statut: 'Dépoté', date_pointage: aujourdhui },
    { numero_tc: 'MSKU0000005', statut: 'Dépoté' },
  );
  const ctx = ctxAvec(db);
  const r = (await stk.stockPointage(ctx, { numeroTC: 'MSKU0000001' })) as Record<string, number>;
  const liste = (await stk.stockList(ctx, { statut: 'tous' })).compte;
  for (const k of ['positionne', 'positionneJour', 'restes', 'depote'] as const) assert.equal(r[k], liste[k], k);
  assert.deepEqual([r['positionne'], r['positionneJour'], r['restes'], r['depote']], [3, 2, 1, 2]);
});

test('annonce : les compteurs rendus sont ceux de la liste des annonces', async () => {
  const db = new FakeDB();
  db.store['stock_annonce'].push(
    { numero_tc: 'ABCU0000001', statut: 'Annoncé' },
    { numero_tc: 'ABCU0000002', statut: 'Annoncé' },
    { numero_tc: 'ABCU0000003', statut: 'Pointé' },
    { numero_tc: 'ABCU0000004', statut: 'Confirmé' },
  );
  const ctx = ctxAvec(db);
  const r = (await stk.annoncePointage(ctx, { numeroTC: 'ABCU0000001' })) as Record<string, number>;
  const liste = (await stk.annonceList(ctx, { statut: 'tous' })).compte;
  for (const k of ['annonces', 'aConfirmer', 'confirmes', 'tauxTransfert'] as const) assert.equal(r[k], liste[k], k);
  assert.deepEqual([r['annonces'], r['aConfirmer'], r['confirmes'], r['tauxTransfert']], [1, 2, 1, 25]);
});
