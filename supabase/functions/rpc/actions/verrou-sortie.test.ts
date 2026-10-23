/**
 * Verrou après sortie (2026-10-09, décision utilisateur « option 2 ») : un
 * dossier sorti est figé pour les agents ; l'administrateur le corrige encore,
 * mais toujours avec un motif, inscrit au journal.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Ctx } from '../ctx.ts';
import { FakeDB } from './fake-db.ts';
import { PERMISSIONS } from '../../_shared/domaine/src/index.ts';
import { ACTIONS_FIGEES_APRES_SORTIE, controlerApresSortie } from './verrou-sortie.ts';

function base(): FakeDB {
  const db = new FakeDB();
  db.store['cargaisons'].push(
    { id: 'CT-SORTI', numero_camion: 'TG1234AB', statut: 'Sortie Enregistrée', date_sortie: '2026-10-05T14:32:00.000Z' },
    { id: 'CT-ENCOURS', numero_camion: 'TG5678CD', statut: 'Créée', date_sortie: null },
    // Statut resté intermédiaire, mais date de sortie posée : il EST sorti.
    { id: 'CT-DATE', numero_camion: 'TG9999EF', statut: 'GPS Installé', date_sortie: '2026-10-06T08:00:00.000Z' },
  );
  return db;
}

function ctx(db: FakeDB, role: string) {
  const journal: { action: string; cible: string; detail: string }[] = [];
  const c: Ctx = {
    db: db as never,
    session: { userId: 'u', username: 'u', nomComplet: 'U', role: role as never },
    log: async (action: string, cible: string, detail: string) => { journal.push({ action, cible, detail }); },
  };
  return { c, journal };
}

test('agent : un dossier sorti ne se modifie plus, quelle que soit l\'action', async () => {
  for (const action of ['cargo.editdecl', 'cargo.t1edit', 'cargo.bsedit', 'cargo.visite', 'cargo.editconteneur']) {
    const { c } = ctx(base(), 'CFS');
    await assert.rejects(() => controlerApresSortie(c, action, { id: 'CT-SORTI', motif: 'peu importe' }),
      /est sorti le 05\/10\/2026 : son dossier ne peut plus être modifié/, action);
  }
});

test('agent : la date de sortie suffit, même si le statut est resté intermédiaire', async () => {
  const { c } = ctx(base(), 'T1');
  await assert.rejects(() => controlerApresSortie(c, 'cargo.t1edit', { id: 'CT-DATE' }), /ne peut plus être modifié/);
});

test('administrateur SANS motif : refusé, avec le signal « motif requis » pour le front', async () => {
  const { c, journal } = ctx(base(), 'ADMIN');
  await assert.rejects(() => controlerApresSortie(c, 'cargo.editdecl', { id: 'CT-SORTI' }),
    (e: Error & { motifRequis?: boolean }) => e.motifRequis === true && /exige un MOTIF/.test(e.message));
  assert.equal(journal.length, 0);
});

test('administrateur AVEC motif : accepté, et inscrit au journal comme correction après sortie', async () => {
  const { c, journal } = ctx(base(), 'ADMIN');
  await controlerApresSortie(c, 'cargo.bsedit', { id: 'CT-SORTI', motif: 'n° de bon mal recopié' });
  assert.equal(journal.length, 1);
  assert.equal(journal[0]!.action, '⚠ Correction après sortie');
  assert.equal(journal[0]!.cible, 'CT-SORTI');
  assert.match(journal[0]!.detail, /cargo\.bsedit · motif : n° de bon mal recopié/);
});

test('rôle technique (INFO) : mêmes pouvoirs que l\'administrateur, même exigence de motif', async () => {
  const { c } = ctx(base(), 'INFO');
  await assert.rejects(() => controlerApresSortie(c, 'cargo.delete', { id: 'CT-SORTI' }), /exige un MOTIF/);
  await controlerApresSortie(c, 'cargo.delete', { id: 'CT-SORTI', motif: 'doublon' });
});

test('dossier NON sorti : aucun changement, l\'agent travaille normalement', async () => {
  const { c, journal } = ctx(base(), 'CFS');
  await controlerApresSortie(c, 'cargo.editdecl', { id: 'CT-ENCOURS' });
  assert.equal(journal.length, 0);
});

test('restent libres après la sortie : engagements, arrivée au bureau, archivage', async () => {
  const { c } = ctx(base(), 'CHEF_BRIGADE');
  for (const action of ['cargo.engagementfait', 'cargo.engagementedit', 'cargo.arriveebureau', 'cargo.archiver', 'cargo.get'])
    await controlerApresSortie(c, action, { id: 'CT-SORTI' });
});

test('validation EN LOT : refusée dès qu\'un des dossiers est sorti', async () => {
  const { c } = ctx(base(), 'CHEF_BRIGADE');
  await assert.rejects(() => controlerApresSortie(c, 'cargo.validerlot', { ids: ['CT-ENCOURS', 'CT-SORTI'] }),
    /TG1234AB/);
  await controlerApresSortie(c, 'cargo.validerlot', { ids: ['CT-ENCOURS'] });
});

// PERMISSIONS et le routeur ont exactement les mêmes clés (registry-complete.test.ts) ;
// on lit PERMISSIONS pour ne pas importer le runtime Deno.
test('chaque action du verrou existe : une faute de frappe le rendrait muet', () => {
  for (const a of ACTIONS_FIGEES_APRES_SORTIE) assert.ok(a in PERMISSIONS, a);
});
