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
  db.store['engagement_declarations_c'] = [];
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
    { designation: 'Tissus polyester imprimés', quantiteDepart: 84 },
    { designation: 'Tissus dentelles', quantiteDepart: 20 },
  ],
};
// La déclaration du Burkina de l'exemple utilisateur : « C 14985 » du 11/07/2026, 84 colis.
const C1 = { numeroC: 'C 14985', dateC: '2026-07-11', designation: 'Tissus polyester imprimés', quantite: 84 };
const C2 = { numeroC: 'C 15002', dateC: '2026-07-14', designation: 'Tissus dentelles', quantite: 18 };
const cargo = (db: FakeDB) => db.store['cargaisons'].find((x) => x['id'] === 'ENG-1')!;

/* ------------------------------ Le depart ------------------------------- */

test('transmission : le depart enregistre la fiche mais N APURE PAS l engagement', async () => {
  /* 2026-10-30, decision utilisateur : transmettre ne prouve pas que la
     marchandise est arrivee. C'est le premier C qui apure. */
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
  assert.equal(cargo(db)['engagement_effectue_le'], null, 'l engagement reste en cours');
  assert.match(traces.join(' '), /informations transmises/);
});

test('transmission : le depart refuse une fiche incomplete, et n ecrit RIEN', async () => {
  const db = base();
  await assert.rejects(() => transmissionDepart(ctxDe(db), { ...DEPART, paysDestination: '' }), /pays de destination/);
  await assert.rejects(() => transmissionDepart(ctxDe(db), { ...DEPART, numeroIm4: '' }), /IM4/);
  await assert.rejects(() => transmissionDepart(ctxDe(db), { ...DEPART, marchandises: [] }), /au moins une marchandise/);
  assert.equal(db.store['engagement_transmission']!.length, 0);
});

test('transmission : corriger le depart garde une seule fiche', async () => {
  const db = base();
  await transmissionDepart(ctxDe(db), DEPART);
  await transmissionDepart(ctxDe(db), { ...DEPART, numeroIm4: 'IM4-2026-885' });
  assert.equal(db.store['engagement_transmission']!.length, 1, 'une seule fiche par cargaison');
  assert.equal(db.store['engagement_transmission']![0]!['numero_im4'], 'IM4-2026-885');
});

test('transmission : une cargaison sans suivi d engagement est refusee', async () => {
  const db = base();
  db.store['cargaisons'][0]!['suivi_engagement'] = false;
  await assert.rejects(() => transmissionDepart(ctxDe(db), DEPART), /pas sous suivi d'engagement/);
});

/* ------------------------- L'arrivee : les C ----------------------------- */

test('transmission : les C ne se saisissent pas avant le depart', async () => {
  const db = base();
  await assert.rejects(() => transmissionArrivee(ctxDe(db), { id: 'ENG-1', declarationsC: [C1] }),
    /départ n'a pas encore été transmis/);
});

test('transmission : le PREMIER C apure l engagement, plusieurs C par engagement', async () => {
  const db = base();
  const traces: string[] = [];
  await transmissionDepart(ctxDe(db), DEPART);
  const r = await transmissionArrivee(ctxDe(db, traces), { id: 'ENG-1', declarationsC: [C1, C2] }) as {
    totaux: { depart: number; arrivee: number; ecart: number | null; nbC: number };
  };
  assert.deepEqual([r.totaux.depart, r.totaux.arrivee, r.totaux.ecart, r.totaux.nbC], [104, 102, -2, 2]);

  const lignes = db.store['engagement_declarations_c']!;
  assert.deepEqual(lignes.map((l) => [l['rang'], l['numero_c'], l['date_c'], l['quantite']]),
    [[1, 'C 14985', '2026-07-11', 84], [2, 'C 15002', '2026-07-14', 18]]);
  assert.ok(db.store['engagement_transmission']![0]!['arrivee_le'], 'la date d arrivee est posee');
  assert.ok(cargo(db)['engagement_effectue_le'], 'l engagement est apure');
  assert.equal(cargo(db)['engagement_effectue_par'], 'Chef Brigade');
  assert.match(traces.join(' '), /Engagement apuré · C 14985 du 2026-07-11, C 15002 du 2026-07-14/);
});

test('transmission : ajouter un C plus tard NE DEPLACE PAS la date d apurement', async () => {
  /* La date dit QUAND l'engagement a ete apure, pas quand on a relu la fiche. */
  const db = base();
  await transmissionDepart(ctxDe(db), DEPART);
  await transmissionArrivee(ctxDe(db), { id: 'ENG-1', declarationsC: [C1] });
  const apureLe = cargo(db)['engagement_effectue_le'];
  const traces: string[] = [];
  await transmissionArrivee(ctxDe(db, traces), { id: 'ENG-1', declarationsC: [C1, C2] });
  assert.equal(cargo(db)['engagement_effectue_le'], apureLe);
  assert.equal(db.store['engagement_declarations_c']!.length, 2, 'la liste est remplacee, sans doublon');
  assert.match(traces.join(' '), /déclarations C corrigées/);
});

test('transmission : les C incomplets, en double, datés du futur ou vides sont refuses, rien n est apure', async () => {
  const db = base();
  await transmissionDepart(ctxDe(db), DEPART);
  const essai = (declarationsC: unknown[]) => transmissionArrivee(ctxDe(db), { id: 'ENG-1', declarationsC });
  await assert.rejects(() => essai([]), /au moins une déclaration C/);
  await assert.rejects(() => essai([{ ...C1, numeroC: '' }]), /numéro du C/);
  await assert.rejects(() => essai([{ ...C1, dateC: '' }]), /date du C/);
  await assert.rejects(() => essai([{ ...C1, dateC: '2026-06-31' }]), /n'est pas valide/);
  await assert.rejects(() => essai([{ ...C1, dateC: '2999-01-01' }]), /futur/);
  await assert.rejects(() => essai([{ ...C1, designation: ' ' }]), /désignation/);
  await assert.rejects(() => essai([{ ...C1, quantite: '' }]), /quantité/);
  await assert.rejects(() => essai([{ ...C1, quantite: 0 }]), /supérieure à zéro/);
  await assert.rejects(() => essai([C1, { ...C2, numeroC: 'c-14985' }]), /saisi deux fois/);
  assert.equal(db.store['engagement_declarations_c']!.length, 0);
  assert.equal(cargo(db)['engagement_effectue_le'], null);
});

test('transmission : sans la table des C (00218 pas passee), refus clair et pas d apurement', async () => {
  const db = base();
  await transmissionDepart(ctxDe(db), DEPART);
  delete (db.store as Record<string, unknown>)['engagement_declarations_c'];
  // deno-lint-ignore no-explicit-any
  const from = db.from.bind(db); (db as any).from = (t: string) => t === 'engagement_declarations_c'
    ? { delete: () => ({ eq: async () => ({ error: { message: 'relation "engagement_declarations_c" does not exist' } }) }) }
    : from(t);
  await assert.rejects(() => transmissionArrivee(ctxDe(db), { id: 'ENG-1', declarationsC: [C1] }), /migration 00218/);
  assert.equal(cargo(db)['engagement_effectue_le'], null);
});

/* ------------------------------- La lecture ----------------------------- */

test('transmission : la lecture rend la fiche, ses marchandises, ses C et les totaux', async () => {
  const db = base();
  await transmissionDepart(ctxDe(db), DEPART);
  await transmissionArrivee(ctxDe(db), { id: 'ENG-1', declarationsC: [C1, { ...C2, quantite: 20 }] });
  const r = await transmissionLire(ctxDe(db), { id: 'ENG-1' }) as {
    transmission: Record<string, unknown> | null;
    marchandises: { designation: string }[];
    declarationsC: { numeroC: string; dateC: string; quantite: number }[];
    totaux: { ecart: number | null; nbC: number };
  };
  assert.equal(r.transmission?.['numero_im4'], 'IM4-2026-884');
  assert.deepEqual(r.marchandises.map((m) => m.designation), ['Tissus polyester imprimés', 'Tissus dentelles']);
  assert.deepEqual(r.declarationsC.map((c) => [c.numeroC, c.dateC, c.quantite]), [['C 14985', '2026-07-11', 84], ['C 15002', '2026-07-14', 20]]);
  assert.equal(r.totaux.ecart, 0);
  assert.equal(r.totaux.nbC, 2);
});

test('transmission : une cargaison sans fiche se lit sans erreur', async () => {
  const db = base();
  const r = await transmissionLire(ctxDe(db), { id: 'ENG-1' }) as { transmission: null; marchandises: unknown[]; declarationsC: unknown[] };
  assert.equal(r.transmission, null);
  assert.deepEqual(r.marchandises, []);
  assert.deepEqual(r.declarationsC, []);
});

test('transmission : les marchandises sont REMPLACEES en bloc, sans doublon', async () => {
  const db = base();
  await transmissionDepart(ctxDe(db), DEPART);
  assert.equal(db.store['engagement_marchandises']!.length, 2);
  await transmissionDepart(ctxDe(db), { ...DEPART, marchandises: [{ designation: 'Tissus polyester imprimés', quantiteDepart: 120 }] });
  assert.equal(db.store['engagement_marchandises']!.length, 1, 'la ligne retiree disparait');
  assert.equal(db.store['engagement_marchandises']![0]!['quantite_depart'], 120);
});
