import test from 'node:test';
import assert from 'node:assert/strict';
import { FakeDB } from './fake-db.ts';
import type { Ctx } from '../ctx.ts';
import { transmissionLire, transmissionDepart, transmissionArrivee } from './transmission.ts';

function ctxDe(db: FakeDB, traces: string[] = []): Ctx {
  return {
    db: db as never,
    session: { userId: 'u-cb', username: 'cb', nomComplet: 'Chef Brigade', role: 'CHEF_BRIGADE' as never },
    log: async (a: string, _c?: string, d?: string) => { traces.push(a + ' · ' + (d ?? '')); },
  };
}

function base(): FakeDB {
  const db = new FakeDB();
  db.store['engagement_transmission'] = [];
  db.store['engagement_marchandises'] = [];
  db.store['cargaisons'].push({
    id: 'ENG-1', numero_camion: 'TG1000AA', suivi_engagement: true,
    engagement_type: 'BFE 03 Sinkase', engagement_delai: '2026-11-06',
    engagement_effectue_le: null, engagement_effectue_par: '', derniere_maj: null,
  });
  return db;
}
const DEPART = {
  id: 'ENG-1', paysDestination: 'Burkina Faso', numeroIm4: 'IM4-2026-884',
  marchandises: [
    { designation: 'Riz 50 kg', quantiteDepart: 100 },
    { designation: 'Sucre', quantiteDepart: 40 },
  ],
};

/* ------------------------------ Le depart ------------------------------- */

test('transmission : le depart enregistre la fiche ET solde l engagement', async () => {
  const db = base();
  const traces: string[] = [];
  await transmissionDepart(ctxDe(db, traces), DEPART);

  const t = db.store['engagement_transmission']![0]!;
  assert.equal(t['cargaison_id'], 'ENG-1');
  assert.equal(t['pays_destination'], 'Burkina Faso');
  assert.equal(t['numero_im4'], 'IM4-2026-884');
  assert.equal(t['transmis_par'], 'Chef Brigade');
  assert.equal(t['arrivee_le'], undefined, 'l arrivee n est pas encore connue');
  assert.equal(db.store['engagement_marchandises']!.length, 2);

  // C'est ce geste qui remplace l'ancien bouton « Effectue ».
  const c = db.store['cargaisons'].find((x) => x['id'] === 'ENG-1')!;
  assert.ok(c['engagement_effectue_le'], 'l engagement est solde');
  assert.equal(c['engagement_effectue_par'], 'Chef Brigade');
  assert.match(traces.join(' '), /informations transmises/);
});

test('transmission : le depart refuse une fiche incomplete, et n ecrit RIEN', async () => {
  const db = base();
  await assert.rejects(() => transmissionDepart(ctxDe(db), { ...DEPART, paysDestination: '' }), /pays de destination/);
  await assert.rejects(() => transmissionDepart(ctxDe(db), { ...DEPART, numeroIm4: '' }), /IM4/);
  await assert.rejects(() => transmissionDepart(ctxDe(db), { ...DEPART, marchandises: [] }), /au moins une marchandise/);
  assert.equal(db.store['engagement_transmission']!.length, 0);
  assert.equal(db.store['cargaisons'][0]!['engagement_effectue_le'], null, 'et ne solde pas');
});

test('transmission : corriger le depart NE REECRIT PAS la date du solde', async () => {
  /* La date dit QUAND les informations sont parties, pas quand on les a
     relues. Une faute de frappe sur le numero IM4 se corrige sans deplacer
     cette date, sans quoi un engagement transmis a l'heure paraitrait tardif. */
  const db = base();
  await transmissionDepart(ctxDe(db), DEPART);
  const soldeInitial = db.store['cargaisons'][0]!['engagement_effectue_le'];

  await transmissionDepart(ctxDe(db), { ...DEPART, numeroIm4: 'IM4-2026-885' });
  assert.equal(db.store['engagement_transmission']!.length, 1, 'une seule fiche par cargaison');
  assert.equal(db.store['engagement_transmission']![0]!['numero_im4'], 'IM4-2026-885');
  assert.equal(db.store['cargaisons'][0]!['engagement_effectue_le'], soldeInitial);
});

test('transmission : une cargaison sans suivi d engagement est refusee', async () => {
  const db = base();
  db.store['cargaisons'][0]!['suivi_engagement'] = false;
  await assert.rejects(() => transmissionDepart(ctxDe(db), DEPART), /pas sous suivi d'engagement/);
});

/* ------------------------------ L'arrivee ------------------------------- */

test('transmission : l arrivee ne se saisit pas avant le depart', async () => {
  const db = base();
  await assert.rejects(
    () => transmissionArrivee(ctxDe(db), { id: 'ENG-1', marchandises: [] }),
    /départ n'a pas encore été transmis/);
});

test('transmission : l arrivee complete la fiche et calcule l ecart', async () => {
  const db = base();
  const traces: string[] = [];
  await transmissionDepart(ctxDe(db), DEPART);
  const r = await transmissionArrivee(ctxDe(db, traces), {
    id: 'ENG-1',
    marchandises: [
      { designation: 'Riz 50 kg', quantiteDepart: 100, quantiteArrivee: 92 },
      { designation: 'Sucre', quantiteDepart: 40, quantiteArrivee: 40 },
    ],
  }) as { totaux: { depart: number; arrivee: number; ecart: number | null; enAttente: number } };

  assert.deepEqual([r.totaux.depart, r.totaux.arrivee, r.totaux.ecart], [140, 132, -8]);
  assert.ok(db.store['engagement_transmission']![0]!['arrivee_le'], 'la date d arrivee est posee');
  assert.match(traces.join(' '), /arrivée constatée/);
});

test("transmission : une arrivee PARTIELLE laisse les autres lignes en attente", async () => {
  /* Le pays de destination repond parfois marchandise par marchandise. L'ecart
     ne doit porter que sur ce qui est constate : compter le depart d'une ligne
     sans reponse ferait un manquant imaginaire. */
  const db = base();
  await transmissionDepart(ctxDe(db), DEPART);
  const r = await transmissionArrivee(ctxDe(db), {
    id: 'ENG-1',
    marchandises: [
      { designation: 'Riz 50 kg', quantiteDepart: 100, quantiteArrivee: 92 },
      { designation: 'Sucre', quantiteDepart: 40 },
    ],
  }) as { totaux: { ecart: number | null; enAttente: number } };
  assert.equal(r.totaux.ecart, -8, 'et non -48');
  assert.equal(r.totaux.enAttente, 1);
});

test('transmission : une quantite d arrivee negative est refusee', async () => {
  const db = base();
  await transmissionDepart(ctxDe(db), DEPART);
  await assert.rejects(() => transmissionArrivee(ctxDe(db), {
    id: 'ENG-1', marchandises: [{ designation: 'Riz 50 kg', quantiteDepart: 100, quantiteArrivee: -5 }],
  }), /négative/);
});

/* ------------------------------- La lecture ----------------------------- */

test('transmission : la lecture rend la fiche, ses lignes et ses totaux', async () => {
  const db = base();
  await transmissionDepart(ctxDe(db), DEPART);
  await transmissionArrivee(ctxDe(db), {
    id: 'ENG-1',
    marchandises: [
      { designation: 'Riz 50 kg', quantiteDepart: 100, quantiteArrivee: 92 },
      { designation: 'Sucre', quantiteDepart: 40, quantiteArrivee: 41 },
    ],
  });
  const r = await transmissionLire(ctxDe(db), { id: 'ENG-1' }) as {
    transmission: Record<string, unknown> | null;
    marchandises: { designation: string; quantiteArrivee: number | null }[];
    totaux: { ecart: number | null };
  };
  assert.equal(r.transmission?.['numero_im4'], 'IM4-2026-884');
  assert.deepEqual(r.marchandises.map((m) => m.designation), ['Riz 50 kg', 'Sucre']);
  assert.equal(r.totaux.ecart, -7);
});

test('transmission : une cargaison sans fiche se lit sans erreur', async () => {
  const db = base();
  const r = await transmissionLire(ctxDe(db), { id: 'ENG-1' }) as { transmission: null; marchandises: unknown[] };
  assert.equal(r.transmission, null);
  assert.deepEqual(r.marchandises, []);
});

test('transmission : les marchandises sont REMPLACEES en bloc, sans doublon', async () => {
  /* Comparer ligne a ligne demanderait des identifiants stables cote ecran, et
     se tromperait au premier deplacement de ligne. */
  const db = base();
  await transmissionDepart(ctxDe(db), DEPART);
  assert.equal(db.store['engagement_marchandises']!.length, 2);
  await transmissionDepart(ctxDe(db), { ...DEPART, marchandises: [{ designation: 'Riz 50 kg', quantiteDepart: 120 }] });
  assert.equal(db.store['engagement_marchandises']!.length, 1, 'la ligne retiree disparait');
  assert.equal(db.store['engagement_marchandises']![0]!['quantite_depart'], 120);
});
