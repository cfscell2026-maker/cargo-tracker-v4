import test from 'node:test';
import assert from 'node:assert/strict';
import { FakeDB } from './fake-db.ts';
import type { Ctx } from '../ctx.ts';
import { rapprochementACP, rapprochementHistorique } from './rapprochement.ts';

function ctxDe(db: FakeDB, traces: string[] = []): Ctx {
  return {
    db: db as never,
    session: { userId: 'u-cb', username: 'cb', nomComplet: 'Chef Brigade', role: 'CHEF_BRIGADE' as never },
    log: async (action: string, _cible?: string, detail?: string) => { traces.push(action + ' · ' + detail); },
  };
}

function baseGarnie(): FakeDB {
  const db = new FakeDB();
  db.store['rapprochement_acp'] = [];
  db.store['stock'].push(
    { numero_tc: 'MSKU1234567', taille: "40'", statut: 'En stock', date_entree: '2026-09-01T08:00:00Z' },
    { numero_tc: 'TGHU7654321', taille: "20'", statut: 'Positionné', date_entree: '2026-09-15T08:00:00Z' },
    { numero_tc: 'CMAU1111111', taille: "20'", statut: 'En stock', date_entree: '2026-08-01T08:00:00Z' },
    { numero_tc: 'HLXU2222222', taille: "40'", statut: 'Dépoté', date_entree: '2026-07-01T08:00:00Z' },
  );
  return db;
}

test('ACP : le rapprochement classe la liste recue et rend les quatre listes', async () => {
  const db = baseGarnie();
  const r = await rapprochementACP(ctxDe(db), {
    numeros: ['MSKU1234567', 'TGHU7654321', 'HLXU2222222', 'ZZZU9999999'],
    nomFichier: 'liste-acp-06-10.xlsx',
  }) as Record<string, never>;
  const n = (c: string) => (r['compte'] as Record<string, number>)[c];
  assert.equal(n('concordants'), 2);        // dont le « Positionné », encore au parc
  assert.equal(n('auParcHorsListe'), 1);    // CMAU1111111
  assert.equal(n('listeDejaDepotes'), 1);   // HLXU2222222
  assert.equal(n('listeInconnus'), 1);      // ZZZU9999999
  assert.equal(n('parc'), 3);
});

test('ACP : le controle est ENREGISTRE, avec ses comptes et son auteur', async () => {
  const db = baseGarnie();
  await rapprochementACP(ctxDe(db), {
    numeros: ['MSKU1234567', 'ZZZU9999999'], nomFichier: 'liste.xlsx', illisibles: ['MSKU12345'],
  });
  const lignes = db.store['rapprochement_acp']!;
  assert.equal(lignes.length, 1);
  const l = lignes[0]!;
  assert.equal(l['fait_par'], 'Chef Brigade');
  assert.equal(l['nom_fichier'], 'liste.xlsx');
  assert.equal(l['nb_lus'], 2);
  assert.equal(l['nb_illisibles'], 1);
  assert.equal(l['nb_concordants'], 1);
  assert.equal(l['nb_inconnus'], 1);
  assert.equal(l['nb_parc'], 3);
  assert.ok(String(l['id']).startsWith('ACP-'));
});

test("ACP : les CONCORDANTS ne sont pas stockes, les ECARTS si", async () => {
  /* Garder les concordants doublerait le poids de chaque trace sans rien
     apprendre : ce sont precisement les lignes qui ne posent pas de question. */
  const db = baseGarnie();
  await rapprochementACP(ctxDe(db), { numeros: ['MSKU1234567', 'ZZZU9999999'] });
  const detail = db.store['rapprochement_acp']![0]!['detail'] as Record<string, unknown[]>;
  assert.equal(detail['concordants'], undefined);
  assert.deepEqual((detail['listeInconnus'] as Record<string, string>[]).map((x) => x['numeroTC']), ['ZZZU9999999']);
  // Ordre ALPHABETIQUE, et non celui de la saisie : fetchAll trie par cle
  // primaire pour que deux lectures successives rendent la meme suite.
  assert.deepEqual((detail['auParcHorsListe'] as Record<string, string>[]).map((x) => x['numeroTC']),
    ['CMAU1111111', 'TGHU7654321']);
});

test("ACP : un fichier sans aucun numero lisible est refuse, et rien n'est ecrit", async () => {
  const db = baseGarnie();
  await assert.rejects(() => rapprochementACP(ctxDe(db), { numeros: [] }), /Aucun num/);
  assert.equal(db.store['rapprochement_acp']!.length, 0);
});

test('ACP : le journal garde la trace du controle', async () => {
  const db = baseGarnie();
  const traces: string[] = [];
  await rapprochementACP(ctxDe(db, traces), { numeros: ['MSKU1234567', 'ZZZU9999999'] });
  assert.equal(traces.length, 1);
  assert.match(traces[0]!, /Rapprochement ACP/);
  assert.match(traces[0]!, /1 inconnu/);
});

test("ACP : l'historique rend les controles passes, du plus recent au plus ancien", async () => {
  const db = baseGarnie();
  await rapprochementACP(ctxDe(db), { numeros: ['MSKU1234567'], nomFichier: 'premier.xlsx' });
  db.store['rapprochement_acp']![0]!['fait_le'] = '2026-10-01T08:00:00Z';
  await rapprochementACP(ctxDe(db), { numeros: ['ZZZU9999999'], nomFichier: 'second.xlsx' });
  db.store['rapprochement_acp']![1]!['fait_le'] = '2026-10-06T08:00:00Z';
  const h = await rapprochementHistorique(ctxDe(db)) as { lignes: Record<string, string>[]; active: boolean };
  assert.equal(h.active, true);
  assert.deepEqual(h.lignes.map((l) => l['nom_fichier']), ['second.xlsx', 'premier.xlsx']);
});

test("ACP : le parc est lu en ENTIER, au-dela du plafond de 1000 lignes", async () => {
  /* fetchAll pagine ; une lecture simple serait tronquee a 1000 et le
     rapprochement declarerait « inconnus » des conteneurs bien presents. */
  const db = baseGarnie();
  const recus: string[] = [];
  for (let i = 0; i < 1500; i++) {
    const tc = 'ABCU' + String(1000000 + i);
    db.store['stock'].push({ numero_tc: tc, taille: "20'", statut: 'En stock', date_entree: '2026-09-01T08:00:00Z' });
    recus.push(tc);
  }
  const r = await rapprochementACP(ctxDe(db), { numeros: recus }) as Record<string, never>;
  assert.equal((r['compte'] as Record<string, number>)['concordants'], 1500);
  assert.equal((r['compte'] as Record<string, number>)['listeInconnus'], 0);
});
