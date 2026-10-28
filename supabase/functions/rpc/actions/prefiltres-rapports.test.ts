/**
 * Filtres SQL des rapports lourds (2026-10-25) : chaque rapport doit rendre
 * EXACTEMENT le même résultat avec ses filtres SQL et sans aucun filtre (le
 * double de test les ignore alors tous, sauf la reprise de pagination). Les
 * données contiennent tout ce que ces filtres écartent : sortis, véhicules,
 * archivés, annulés, hors période, balise requise, stock hors magasin.
 */
process.env.TZ = 'UTC';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Ctx } from '../ctx.ts';
import { FakeDB } from './fake-db.ts';
import * as rap from './rapports.ts';

function alea(graine: number) { let x = graine; return () => (x = (x * 1103515245 + 12345) % 2147483648) / 2147483648; }

function jeu(n = 400): { cargaisons: Record<string, unknown>[]; stock: Record<string, unknown>[] } {
  const r = alea(11);
  const pick = <T,>(a: T[]) => a[Math.floor(r() * a.length)]!;
  const apres = (iso: string, j: number) => new Date(Date.parse(iso) + j * 86400000).toISOString();
  const cargaisons: Record<string, unknown>[] = [];
  for (let i = 0; i < n; i++) {
    const creation = new Date(Date.UTC(2026, 5, 1) + r() * 200 * 86400000).toISOString();
    const sorti = r() < 0.7;
    const vf = () => (r() < 0.75 ? apres(creation, r() * 6) : null);
    cargaisons.push({
      id: 'CT-' + String(i).padStart(5, '0'), numero_camion: 'TG' + i + 'AA', numero_camion_norm: 'TG' + i + 'AA',
      type_operation: pick(['Enlèvement', 'Dépotage', 'Sortie Magasin / MAD', 'Conso (type C)', 'Dépotage / Véhicule']),
      statut: sorti ? 'Sortie Enregistrée' : pick(['Créée', 'T1 Saisi', 'GPS Posé', 'Camion créé']),
      est_vehicule: r() < 0.12, balise_requise: pick([null, true, false, false]), numero_dispense: pick(['', 'D 1', 'ESCORTE 2']),
      type_exemption: pick([null, 'dispense', 'escorte']), type_declaration: pick(['T', 'C']), saute_t1: r() < 0.2, saute_balise: r() < 0.2,
      arrivee_bureau: r() < 0.3, bureau_destination: pick(['TG120', 'BF OUAGA']), bon_sortie_numero: r() < 0.6 ? 'BS' + i : null,
      date_creation: creation, date_fin_chargement: vf(), date_validation: vf(), date_t1: vf(), date_bon_sortie: vf(), date_pose_gps: vf(),
      date_sortie: sorti ? apres(creation, 2 + r() * 10) : null, agent_cfs: 'A' + (i % 4), agent_entree: 'E', agent_validation: 'V',
      agent_t1: 'T', agent_bon_sortie: 'B', agent_balise: 'G', agent_pp: 'P', nb_conteneurs: 1,
      conteneurs_details: { conteneurs: [{ num: 'MSKU' + String(i % 300).padStart(7, '0'), taille: pick(["20'", "40'", '45']), partage: r() < 0.05 }], scellesCamion: [] },
      annule: r() < 0.03, archive: r() < 0.06, archive_le: null, archive_par: '', archive_motif: '',
    });
  }
  const stock = Array.from({ length: 200 }, (_, i) => ({
    numero_tc: 'TCLU' + String(i).padStart(7, '0'), taille: pick(["20'", "40'"]), statut: pick(['En stock', 'Dépoté']),
    date_depote: new Date(Date.UTC(2026, 5, 1) + r() * 200 * 86400000).toISOString(), observations: pick(['Entrée magasin 2D', 'RAS', 'MAGASIN 3', '']),
  }));
  return { cargaisons, stock };
}

function base(sansFiltres: boolean) {
  const db = new FakeDB();
  db.vueStats = true;
  const { cargaisons, stock } = jeu();
  for (const c of cargaisons) db.store['cargaisons'].push(c);
  for (const s of stock) db.store['stock'].push(s);
  if (sansFiltres) (db.store as unknown as { __sansFiltres: boolean }).__sansFiltres = true;
  const ctx: Ctx = { db: db as never, session: { userId: 'u', username: 'a', nomComplet: 'A', role: 'ADMIN' as never }, log: async () => {} };
  return ctx;
}

const P = { du: '2026-08-01', au: '2026-09-30' };
const RAPPORTS: [string, (ctx: Ctx) => Promise<unknown>][] = [
  ['goulots', (ctx) => rap.rapportGoulots(ctx, {})],
  ['dispenses', (ctx) => rap.rapportDispenses(ctx, {})],
  ['délai & instance', (ctx) => rap.rapportSejour(ctx, {})],
  ['temps de passage (période)', (ctx) => rap.rapportTemps(ctx, P)],
  ['heures d\'activité (période)', (ctx) => rap.rapportHorodatage(ctx, P)],
  ['fiche du tableau de bord (période)', (ctx) => rap.ficheBord(ctx, P)],
  ['KPI', (ctx) => rap.rapportKPI(ctx, {})],
  ['archives', (ctx) => rap.rapportArchives(ctx, {})],
];

for (const [nom, f] of RAPPORTS)
  test(`filtres SQL sans effet sur le résultat : ${nom}`, async () => {
    const avec = await f(base(false));
    const sans = await f(base(true));
    assert.deepEqual(avec, sans);
  });

test('le jeu contient bien ce que les filtres écartent', () => {
  const { cargaisons } = jeu();
  assert.ok(cargaisons.some((c) => c['statut'] === 'Sortie Enregistrée'));
  assert.ok(cargaisons.some((c) => c['est_vehicule'] === true));
  assert.ok(cargaisons.some((c) => c['archive'] === true));
  assert.ok(cargaisons.some((c) => c['balise_requise'] === true));
  assert.ok(cargaisons.some((c) => String(c['date_creation']) < '2026-08-01'));
});
