/**
 * Liste « Cargaisons » lue page par page en SQL (2026-10-24). Pour chaque
 * combinaison de critères et chaque page, le résultat doit être IDENTIQUE à
 * l'ancienne lecture complète (forcée ici en faisant échouer le chemin direct).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Ctx } from '../ctx.ts';
import { FakeDB } from './fake-db.ts';
import * as lec from './lecture.ts';

const STATUTS_POSSIBLES = ['Créée', 'Sortie Enregistrée', 'T1 Saisi', 'Camion créé'];

function base(forcerRepli: boolean) {
  const db = new FakeDB();
  for (let i = 1; i <= 40; i++) {
    db.store['cargaisons'].push({
      id: 'CT-' + String(i).padStart(4, '0'), numero_camion: 'TG' + i + 'AA',
      // Dates en double : le départage par identifiant doit être le même.
      date_creation: `2026-10-${String((i % 9) + 1).padStart(2, '0')}T08:00:00Z`,
      statut: STATUTS_POSSIBLES[i % 4], est_vehicule: i % 5 === 0,
      suivi_engagement: i % 3 === 0 ? true : i % 3 === 1 ? false : null,
      annule: i === 7, archive: i === 8,
    });
  }
  if (forcerRepli) {
    const origine = db.from.bind(db);
    (db as unknown as { from: (t: string) => unknown }).from = (t: string) => {
      const q = origine(t) as unknown as { range: unknown };
      if (t === 'v_cargaisons_resume')
        q.range = () => ({ then: (f: (v: unknown) => unknown) => f({ data: null, error: { message: 'repli forcé' } }) });
      return q;
    };
  }
  const ctx: Ctx = { db: db as never, session: { userId: 'u', username: 'a', nomComplet: 'A', role: 'ADMIN' as never }, log: async () => {} };
  return ctx;
}

test('liste directe en SQL : identique à la lecture complète, pour chaque critère et chaque page', async () => {
  const cas: Record<string, unknown>[] = [];
  for (const categorie of ['camion', 'vehicule', 'tous'])
    for (const actifs of [false, true])
      for (const statut of ['tous', 'Créée'])
        for (const engagement of ['', 'avec', 'sans'])
          for (const page of [1, 2, 3, 9]) cas.push({ categorie, actifs, statut, engagement, page, pageSize: 7 });
  for (const opts of cas) {
    const direct = await lec.cargoList(base(false), opts as never);
    const complet = await lec.cargoList(base(true), opts as never);
    assert.deepEqual(direct, complet, JSON.stringify(opts));
  }
  assert.ok(cas.length > 100);
});

test('liste directe : la base ne renvoie que la page demandée', async () => {
  const r = await lec.cargoList(base(false), { categorie: 'tous', pageSize: 7, page: 1 }) as { rows: unknown[]; total: number; pages: number };
  assert.deepEqual([r.rows.length, r.total, r.pages], [7, 38, 6], '40 dossiers, moins un annulé et un archivé');
});
