/**
 * Repli de l'export Excel (2026-10-24) : avec `brut`, le serveur rend les
 * feuilles telles quelles, sans fabriquer le classeur ; le navigateur s'en
 * charge quand la fabrication côté serveur a dépassé son temps de calcul.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Ctx } from '../ctx.ts';
import { FakeDB } from './fake-db.ts';
import * as rap from './rapports.ts';

test('export brut : Rapport CFS en trois feuilles, sans fichier fabriqué', async () => {
  const db = new FakeDB();
  db.store['cargaisons'].push({
    id: 'CT-1', numero_camion: 'TG1AA', type_operation: 'Enlèvement', statut: 'Créée', est_vehicule: false,
    date_creation: '2026-10-05T08:00:00Z', agent_cfs: 'A', conteneurs_details: { conteneurs: [{ num: 'MSKU0000001', taille: "40'" }], scellesCamion: [] },
  });
  const ctx: Ctx = { db: db as never, session: { userId: 'u', username: 'a', nomComplet: 'A', role: 'ADMIN' as never }, log: async () => {} };
  const r = await rap.rapportCFS(ctx, { du: '2026-10-01', au: '2026-10-31', format: 'xlsx', brut: true }) as Record<string, unknown>;
  assert.equal(r['brut'], true);
  assert.equal(r['base64'], undefined, 'aucun classeur fabriqué côté serveur');
  const feuilles = r['feuilles'] as { nom: string; aoa: unknown[][] }[];
  assert.deepEqual(feuilles.map((f) => f.nom), ['Synthèse', 'Camions', 'Conteneurs']);
  assert.deepEqual(feuilles[2]!.aoa[1]!.slice(3, 5), ['MSKU0000001', "40'"]);
  assert.equal(r['filename'], 'Rapport_CFS.xlsx');
});
