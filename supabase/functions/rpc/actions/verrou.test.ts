import test from 'node:test';
import assert from 'node:assert/strict';
import { FakeDB } from './fake-db.ts';
import type { Ctx } from '../ctx.ts';
import { verrouDefinir, verrouBloquer, verrouOuvrir, verrouEtat, etatVerrou } from './verrou.ts';
import { aLeDroit } from '../../_shared/domaine/src/permissions.ts';

function ctxDe(db: FakeDB, role = 'INFO', traces: string[] = []): Ctx {
  return {
    db: db as never,
    session: { userId: 'u-' + role, username: role.toLowerCase(), nomComplet: 'Sam', role: role as never },
    log: async (action: string, _c?: string, detail?: string) => { traces.push(action + ' · ' + (detail ?? '')); },
  };
}
const base = () => { const db = new FakeDB(); db.store['verrou_application'] = []; return db; };
const MDP = 'cadenas-du-port-2026';

async function avecMotDePasse(db: FakeDB) {
  await verrouDefinir(ctxDe(db), { nouveau: MDP, confirmation: MDP });
}

/* --------------------------- Le mot de passe ---------------------------- */

test('verrou : le mot de passe n’est JAMAIS stocke en clair', async () => {
  const db = base();
  await avecMotDePasse(db);
  const l = db.store['verrou_application']![0]!;
  assert.equal(String(l['mdp_hash']).includes(MDP), false);
  assert.ok(String(l['mdp_hash']).length > 20);
  assert.ok(String(l['mdp_sel']).length > 10);
  // Le sel est TIRE AU HASARD : deux bases ne partagent pas le meme derive.
  const db2 = base();
  await avecMotDePasse(db2);
  assert.notEqual(l['mdp_hash'], db2.store['verrou_application']![0]!['mdp_hash']);
});

test('verrou : le panneau ne rend ni le hash ni le sel', async () => {
  const db = base();
  await avecMotDePasse(db);
  const e = await verrouEtat(ctxDe(db)) as Record<string, unknown>;
  assert.equal(e['defini'], true);
  for (const interdit of ['mdp_hash', 'mdp_sel', 'hash', 'motDePasse'])
    assert.equal(e[interdit], undefined, interdit);
});

test('verrou : un mot de passe trop court est refuse', async () => {
  const db = base();
  await assert.rejects(() => verrouDefinir(ctxDe(db), { nouveau: 'court', confirmation: 'court' }), /8 caract/);
  assert.equal(db.store['verrou_application']!.length, 0);
});

test('verrou : la confirmation doit correspondre', async () => {
  const db = base();
  await assert.rejects(
    () => verrouDefinir(ctxDe(db), { nouveau: MDP, confirmation: MDP + 'x' }), /confirmation/);
});

test('verrou : changer le mot de passe exige l’ancien', async () => {
  const db = base();
  await avecMotDePasse(db);
  await assert.rejects(
    () => verrouDefinir(ctxDe(db), { ancien: 'faux-mot-de-passe', nouveau: 'nouveau-cadenas-2026', confirmation: 'nouveau-cadenas-2026' }),
    /incorrect/);
  await verrouDefinir(ctxDe(db), { ancien: MDP, nouveau: 'nouveau-cadenas-2026', confirmation: 'nouveau-cadenas-2026' });
  await verrouBloquer(ctxDe(db), { motDePasse: 'nouveau-cadenas-2026', message: 'Maintenance' });
  assert.equal(db.store['verrou_application']![0]!['actif'], true);
});

/* ------------------------- Bloquer et rouvrir --------------------------- */

test('verrou : bloquer exige le bon mot de passe', async () => {
  const db = base();
  await avecMotDePasse(db);
  await assert.rejects(() => verrouBloquer(ctxDe(db), { motDePasse: 'pas-le-bon-du-tout', message: 'M' }), /incorrect/);
  assert.equal((await etatVerrou(ctxDe(db))).actif, false);
});

test('verrou : bloquer exige un MESSAGE, c’est ce que les agents verront', async () => {
  const db = base();
  await avecMotDePasse(db);
  await assert.rejects(() => verrouBloquer(ctxDe(db), { motDePasse: MDP, message: '   ' }), /raison du blocage/);
  assert.equal((await etatVerrou(ctxDe(db))).actif, false);
});

test('verrou : bloquer puis rouvrir, avec la trace de qui et de quand', async () => {
  const db = base();
  const traces: string[] = [];
  await avecMotDePasse(db);
  await verrouBloquer(ctxDe(db, 'INFO', traces), { motDePasse: MDP, message: 'Inventaire jusqu’a 14 h' });
  const bloque = await etatVerrou(ctxDe(db));
  assert.equal(bloque.actif, true);
  assert.equal(bloque.message, 'Inventaire jusqu’a 14 h');
  assert.equal(db.store['verrou_application']![0]!['bloque_par'], 'Sam');
  assert.ok(db.store['verrou_application']![0]!['bloque_le']);

  await verrouOuvrir(ctxDe(db, 'INFO', traces), { motDePasse: MDP });
  assert.equal((await etatVerrou(ctxDe(db))).actif, false);
  assert.equal((await etatVerrou(ctxDe(db))).message, '');
  assert.ok(traces.some((t) => /APPLICATION BLOQU/.test(t)));
  assert.ok(traces.some((t) => /rouverte/.test(t)));
});

test('verrou : rouvrir exige aussi le mot de passe', async () => {
  const db = base();
  await avecMotDePasse(db);
  await verrouBloquer(ctxDe(db), { motDePasse: MDP, message: 'M' });
  await assert.rejects(() => verrouOuvrir(ctxDe(db), { motDePasse: 'autre-chose-ici' }), /incorrect/);
  assert.equal((await etatVerrou(ctxDe(db))).actif, true);
});

test('verrou : sans mot de passe defini, on ne peut rien bloquer', async () => {
  const db = base();
  await assert.rejects(() => verrouBloquer(ctxDe(db), { motDePasse: 'nimporte-quoi', message: 'M' }), /Aucun mot de passe/);
});

/* ------------------------------ Qui y touche ---------------------------- */

test('verrou : L’INFO SEUL, pas meme le SUPER_ADMIN ni l’ADMIN', async () => {
  /* La seule capacite du projet qui ne suit PAS l'heritage des roles
     techniques : bloquer l'outil de travail de tout le port n'est pas un
     pouvoir d'administration ordinaire. */
  const db = base();
  await avecMotDePasse(db);
  for (const role of ['SUPER_ADMIN', 'ADMIN', 'CHEF_BRIGADE', 'CFS']) {
    await assert.rejects(() => verrouEtat(ctxDe(db, role)), /réservé au rôle INFO/, role);
    await assert.rejects(() => verrouBloquer(ctxDe(db, role), { motDePasse: MDP, message: 'M' }), /réservé au rôle INFO/, role);
    await assert.rejects(() => verrouOuvrir(ctxDe(db, role), { motDePasse: MDP }), /réservé au rôle INFO/, role);
  }
});

test('verrou : la matrice des droits dit la meme chose que l’action', async () => {
  // Deux barrieres, et elles doivent s'accorder : la matrice refuse AVANT
  // meme d'entrer dans l'action, `exigerInfo` refuse une seconde fois.
  for (const a of ['verrou.etat', 'verrou.definir', 'verrou.bloquer', 'verrou.ouvrir']) {
    assert.equal(aLeDroit('INFO', a), true, a);
    for (const role of ['SUPER_ADMIN', 'ADMIN', 'CHEF_BRIGADE', 'CHEF_DIVISION', 'CFS', 'PP'])
      assert.equal(aLeDroit(role, a), false, role + ' / ' + a);
  }
});

/* ------------------------- Le refus de se verrouiller -------------------- */

test('verrou : si la base ne repond pas, l’application reste OUVERTE', async () => {
  /* Un verrou qui se refermerait sur une panne bloquerait tout le port sans
     que personne l'ait demande, et sans qu'on puisse rouvrir. */
  const casse = { from: () => { throw new Error('base injoignable'); } };
  const ctx = { db: casse as never, session: { userId: 'u', username: 'x', nomComplet: 'X', role: 'CFS' as never }, log: async () => {} };
  assert.deepEqual(await etatVerrou(ctx), { actif: false, message: '' });
});

test('verrou : table absente, aucun verrou et rien ne tombe', async () => {
  const db = new FakeDB();   // sans `verrou_application`
  assert.deepEqual(await etatVerrou(ctxDe(db)), { actif: false, message: '' });
});
