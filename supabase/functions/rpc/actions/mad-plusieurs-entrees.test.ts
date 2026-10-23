/**
 * Un camion, plusieurs entrées MAD (2026-10-21, inquiétude du client).
 *
 * Le cas réel : le camion 8505H103/8627G903BF charge 113 cartons de la T 23228
 * et 51 cartons de la T 23246 dans l'entrepôt 2D. Il doit en sortir UN dossier
 * camion, pas deux lignes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Ctx } from '../ctx.ts';
import { FakeDB } from './fake-db.ts';
import { entrepotSortie } from './entrepots.ts';

const CAMION = '8505H103/8627G903BF';

function base(extra: Record<string, unknown>[] = []) {
  const db = new FakeDB();
  db.store['entrepots'] = [{ code: '2D', nom: 'Entrepôt 2D', type: 'MAD' }];
  db.store['entrepot_entrees'] = [
    { id: 'ENT-1', entrepot_code: '2D', numero_declaration: '23228', annee_declaration: '2026', bureau_declaration: 'TG120',
      type_declaration: 'T', declarant: 'KOMBATRANS', articles: [{ designation: 'CONGELATEUR VERTICAL', nbColis: 720, poids: 0 }] },
    { id: 'ENT-2', entrepot_code: '2D', numero_declaration: '23246', annee_declaration: '2026', bureau_declaration: 'TG120',
      type_declaration: 'C', declarant: 'KOMBATRANS', articles: [{ designation: 'CONGELATEUR VERTICAL', nbColis: 215, poids: 0 }] },
  ];
  db.store['entrepot_sorties'] = [];
  for (const c of extra) db.store['cargaisons'].push(c);
  const journal: { action: string; detail: string }[] = [];
  const ctx: Ctx = {
    db: db as never,
    session: { userId: 'u', username: 'mad', nomComplet: 'Agent MAD', role: 'CFS' as never },
    log: async (action: string, _c: string, detail: string) => { journal.push({ action, detail }); },
  };
  return { db, ctx, journal };
}

const sortie = (entreeId: string, nbColis: number, typeDeclaration: string, numero: string, extra: Record<string, unknown> = {}) => ({
  entreeId, numeroArticle: 1, nbColis, numeroCamion: CAMION, scelles: ['1024996'],
  declarationApurement: { typeDeclaration, numeroDeclaration: numero, anneeDeclaration: '2026', bureauDeclaration: 'TG120' },
  ...extra,
});

test('le cas du client : deux entrées, un seul camion, UN seul dossier', async () => {
  const { db, ctx, journal } = base();
  const r1 = await entrepotSortie(ctx, sortie('ENT-1', 113, 'T', '23228'));
  const r2 = await entrepotSortie(ctx, sortie('ENT-2', 51, 'C', '23246', { scelles: ['1024996', '1024997'], baliseRequise: false }));

  assert.equal(db.store['cargaisons'].length, 1, 'un seul dossier camion');
  assert.equal(r2.rattache, true);
  assert.equal(r2.cargaisonId, r1.cargaisonId);
  // Les deux sorties pointent sur ce dossier, et l'apurement de chaque entrée est juste.
  assert.deepEqual(db.store['entrepot_sorties']!.map((s) => [s['entree_id'], s['nb_colis'], s['cargaison_id']]),
    [['ENT-1', 113, r1.cargaisonId], ['ENT-2', 51, r1.cargaisonId]]);
  assert.equal(r1.restantApres, 607, 'reste 607 cartons à charger sur la T 23228');
  assert.equal(r2.restantApres, 164);

  const c = db.store['cargaisons'][0]!;
  assert.equal(c['chargement_mixte'], true);
  const hist = c['mixte_details'] as Record<string, unknown>[];
  assert.equal(hist.length, 1);
  assert.deepEqual([(hist[0]!['declaration'] as Record<string, unknown>)['numero'], hist[0]!['quantite'], hist[0]!['unite']], ['23246', 51, 'colis']);
  assert.deepEqual((c['conteneurs_details'] as { scellesCamion: string[] }).scellesCamion, ['1024996', '1024997']);
  // La première déclaration est un transit : le T1 reste dû, même si la seconde (C) ne le demande pas.
  assert.equal(c['saute_t1'], false);
  assert.ok(journal.some((j) => j.action === 'Chargement sur plusieurs entrées MAD'));
});

test('régime : un transit ajouté à une conso remet le T1 et la balise dus', async () => {
  const { db, ctx } = base();
  await entrepotSortie(ctx, sortie('ENT-2', 10, 'C', '23246', { baliseRequise: false }));
  const avant = db.store['cargaisons'][0]!;
  assert.deepEqual([avant['saute_t1'], avant['saute_balise']], [true, true]);
  await entrepotSortie(ctx, sortie('ENT-1', 20, 'T', '23228'));
  const apres = db.store['cargaisons'][0]!;
  assert.deepEqual([apres['saute_t1'], apres['saute_balise']], [false, false]);
});

test('camion déjà ouvert pour une AUTRE opération : refus, et rien n\'est enregistré', async () => {
  const { db, ctx } = base([{
    id: 'CT-ENL', numero_camion: CAMION, numero_camion_norm: '8505H1038627G903BF', type_operation: 'Enlèvement',
    statut: 'Créée', annule: false, archive: false,
  }]);
  await assert.rejects(() => entrepotSortie(ctx, sortie('ENT-1', 113, 'T', '23228')), /autre opération : CT-ENL/);
  assert.equal(db.store['entrepot_sorties']!.length, 0, 'la sortie n\'est pas enregistrée');
  assert.equal(db.store['cargaisons'].length, 1);
});

test('camion déjà SORTI : une nouvelle sortie MAD ouvre bien un nouveau dossier', async () => {
  const { db, ctx } = base([{
    id: 'CT-VIEUX', numero_camion: CAMION, numero_camion_norm: '8505H1038627G903BF', type_operation: 'Sortie Magasin / MAD',
    statut: 'Sortie Enregistrée', annule: false, archive: false,
  }]);
  const r = await entrepotSortie(ctx, sortie('ENT-1', 5, 'T', '23228'));
  assert.equal(r.rattache, false);
  assert.equal(db.store['cargaisons'].length, 2);
});
