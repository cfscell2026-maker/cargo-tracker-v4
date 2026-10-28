/**
 * Colonnes lues par Temps de passage et Heures d'activité (2026-10-25) : le
 * résultat doit être EXACTEMENT celui de la lecture de la ligne entière, sur la
 * table, sans aucun filtre SQL. Une colonne oubliée fait échouer ces tests.
 */
process.env.TZ = 'UTC';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Ctx } from '../ctx.ts';
import { FakeDB } from './fake-db.ts';
import * as rap from './rapports.ts';

function alea(graine: number) { let x = graine; return () => (x = (x * 1103515245 + 12345) % 2147483648) / 2147483648; }

function jeu(n = 400): Record<string, unknown>[] {
  const r = alea(21);
  const pick = <T,>(a: T[]) => a[Math.floor(r() * a.length)]!;
  const apres = (iso: string, h: number) => new Date(Date.parse(iso) + h * 3600000).toISOString();
  return Array.from({ length: n }, (_, i) => {
    const creation = new Date(Date.UTC(2026, 6, 1) + r() * 120 * 86400000).toISOString();
    const vf = (h: number) => (r() < 0.8 ? apres(creation, r() * h) : null);
    const conts = Array.from({ length: Math.floor(r() * 3) }, () => ({ num: 'MSKU' + String(Math.floor(r() * 1e6)).padStart(7, '0'), taille: pick(["20'", "40'"]), plomb: 'S', poids: 12000 }));
    return {
      id: 'CT-' + String(i).padStart(5, '0'), numero_camion: 'TG' + i, type_operation: pick(['Enlèvement', 'Dépotage', 'Sortie Magasin / MAD']),
      statut: pick(['Sortie Enregistrée', 'Créée', 'T1 Saisi']), est_vehicule: r() < 0.1,
      date_creation: creation, date_fin_chargement: r() < 0.6 ? vf(5) : null, date_validation: vf(10), date_t1: vf(20),
      date_pose_gps: vf(30), date_bon_sortie: vf(25), date_sortie: vf(60),
      saute_t1: r() < 0.15, saute_balise: r() < 0.15, saute_bs: r() < 0.1,
      numero_declaration: pick(['', 'D' + i]), annee_declaration: pick(['', '2026']), bureau_declaration: pick(['', 'TG120']), type_declaration: pick(['', 'T', 'C']),
      agent_cfs: pick(['', 'A1', 'A2']), agent_entree: pick(['', 'E1']), agent_validation: pick(['', 'V1']), agent_t1: pick(['', 'T1']),
      agent_bon_sortie: pick(['', 'B1']), agent_balise: pick(['', 'G1']), agent_pp: pick(['', 'P1']), nb_conteneurs: Math.floor(r() * 3),
      conteneurs_details: r() < 0.9 ? { conteneurs: conts, scellesCamion: [{ n: 'X' }] } : null,
      hors_gabarit: false, en_surcharge: false, destination_marchandise: 'BF', annule: r() < 0.03, archive: r() < 0.04,
    };
  });
}

/** `entiere` : table seule (pas de vue), ligne complète, filtres ignorés. */
function base(entiere: boolean): Ctx {
  const db = new FakeDB();
  for (const c of jeu()) db.store['cargaisons'].push(c);
  if (entiere) {
    (db.store as unknown as { __sansFiltres: boolean }).__sansFiltres = true;
    const from = db.from.bind(db);
    // deno-lint-ignore no-explicit-any
    (db as any).from = (t: string) => { const q = from(t); const sel = q.select.bind(q); q.select = (_c?: string, o?: { head?: boolean }) => sel('*', o); return q; };
  } else db.vueStats = true;
  return { db: db as never, session: { userId: 'u', username: 'a', nomComplet: 'A', role: 'ADMIN' as never }, log: async () => {} };
}

for (const p of [{ du: '2026-08-01', au: '2026-08-31' }, { du: '2026-07-01', au: '2026-10-31', vehicules: false }])
  test(`Temps de passage ${JSON.stringify(p)} : colonnes lues suffisantes`, async () => {
    const attendu = await rap.rapportTemps(base(true), p) as Record<string, unknown>;
    assert.ok((attendu['lignes'] as unknown[]).length > 0);
    assert.deepEqual(await rap.rapportTemps(base(false), p), attendu);
  });

for (const p of [{ du: '2026-08-01', au: '2026-08-31' }, { du: '2026-07-01', au: '2026-10-31', cellule: 'PP' }])
  test(`Heures d'activité ${JSON.stringify(p)} : vue allégée = table entière`, async () => {
    const attendu = await rap.rapportHorodatage(base(true), p) as { rows: { conteneurs: number }[] };
    assert.ok(attendu.rows.length > 0 && attendu.rows.some((r) => r.conteneurs > 0));
    assert.deepEqual(await rap.rapportHorodatage(base(false), p), attendu);
  });
