/**
 * Extraction sur mesure (2026-10-09). L'exemple de l'utilisateur sert de premier
 * test : « les enlèvements engagés vers le bureau BF ». Le cas qui se trompe en
 * silence est le chargement MIXTE : les filtres doivent porter sur la
 * déclaration de CHAQUE conteneur, pas sur celle du camion.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Ctx } from '../ctx.ts';
import { FakeDB } from './fake-db.ts';
import { versCamel } from '../ctx.ts';
import { extraire, designationCorrespond, resumeFiltres } from './extraction.ts';
import * as rap from './rapports.ts';

const BRUTS: Record<string, unknown>[] = [
  { // A : enlèvement mixte, engagé BFE 03, T1 vers BF, sorti
    id: 'CT-A', numero_camion: 'TG1111AA', type_operation: 'Enlèvement', statut: 'Sortie Enregistrée',
    date_creation: '2026-10-02T08:00:00.000Z', date_sortie: '2026-10-05T14:00:00.000Z',
    declarant: 'STE CAMION', numero_declaration: '100', annee_declaration: '2026', bureau_declaration: 'TG120', type_declaration: 'T',
    description_marchandise: 'MARCHANDISES DIVERSES', destination_marchandise: 'OUAGADOUGOU', bureau_destination: 'BF OUAGA',
    suivi_engagement: true, engagement_type: 'BFE 03 Sinkase', numero_gps: 'GPS-9', est_vehicule: false,
    conteneurs_details: { conteneurs: [
      { num: 'MSKU1111111', taille: "20'", declarant: 'STE A', numeroDeclaration: '200', anneeDeclaration: '2026', bureauDeclaration: 'TG120', typeDeclaration: 'T', descriptionMarchandise: 'RIZ BLANC' },
      { num: 'TCLU2222222', taille: "20'", declarant: 'STE B', numeroDeclaration: '300', anneeDeclaration: '2026', bureauDeclaration: 'TG120', typeDeclaration: 'T', descriptionMarchandise: 'Sucre en poudre' },
    ], scellesCamion: [] },
    t1_numeros: [{ conteneur: 'MSKU1111111', numero: 'T1-A' }, { conteneur: 'TCLU2222222', numero: 'T1-B' }],
  },
  { // B : dépotage, non engagé, en cours
    id: 'CT-B', numero_camion: 'TG2222BB', type_operation: 'Dépotage', statut: 'Créée',
    date_creation: '2026-10-03T08:00:00.000Z', declarant: 'STE C', numero_declaration: '400', annee_declaration: '2026',
    bureau_declaration: 'TG120', type_declaration: 'C', description_marchandise: 'CIMENT', destination_marchandise: 'LOME',
    bureau_destination: '', suivi_engagement: false, est_vehicule: false,
    conteneurs_details: { conteneurs: [{ num: 'GLDU3333333', taille: "40'" }], scellesCamion: [] },
  },
  { // C : véhicule
    id: 'CT-C', numero_camion: 'VIN123', type_operation: 'Dépotage', statut: 'Créée', date_creation: '2026-10-04T08:00:00.000Z',
    declarant: 'STE V', numero_declaration: '500', type_declaration: 'T', description_marchandise: 'VEHICULE TOYOTA', est_vehicule: true,
    conteneurs_details: { conteneurs: [], scellesCamion: [] },
  },
];
const CARGOS = BRUTS.map((r) => versCamel(structuredClone(r)));
const ids = (r: { lignes: Record<string, string>[] }, col = 'ID') => r.lignes.map((l) => l[col]);

test('l\'exemple : les enlèvements engagés vers le bureau BF', () => {
  const r = extraire(CARGOS, { operation: 'Enlèvement', engagement: 'oui', bureauDestination: 'bf' }, { voitBalise: true });
  assert.deepEqual(ids(r), ['CT-A']);
  assert.equal(r.lignes[0]!['Engagement'], 'BFE 03 Sinkase');
  assert.equal(r.lignes[0]!['Bureau de destination (T1)'], 'BF OUAGA');
});

test('nature d\'engagement : « bfe 03 » retrouve « BFE 03 Sinkase »', () => {
  assert.deepEqual(ids(extraire(CARGOS, { natureEngagement: 'bfe 03' }, { voitBalise: true })), ['CT-A']);
});

test('désignation, par conteneur : « sucre » ne garde que le conteneur concerné, avec SA déclaration', () => {
  const r = extraire(CARGOS, { niveau: 'conteneurs', designation: 'sucre' }, { voitBalise: true });
  assert.deepEqual(ids(r, 'Conteneur'), ['TCLU2222222']);
  assert.equal(r.lignes[0]!['N° déclaration'], '300');
  assert.equal(r.lignes[0]!['Désignation'], 'Sucre en poudre');
  assert.equal(r.lignes[0]!['T1'], 'T1-B');
});

test('niveau camions : le camion mixte ne porte que les déclarations RETENUES par le filtre', () => {
  const r = extraire(CARGOS, { designation: 'riz' }, { voitBalise: true });
  assert.deepEqual(ids(r), ['CT-A']);
  assert.equal(r.lignes[0]!['N° déclaration'], '200');
  assert.equal(r.lignes[0]!['Nb conteneurs'], '1');
  assert.equal(r.lignes[0]!['Conteneurs'], 'MSKU1111111');
});

test('plusieurs termes de désignation : « riz ; ciment » retient l\'un OU l\'autre', () => {
  assert.deepEqual(ids(extraire(CARGOS, { designation: 'riz ; ciment' }, { voitBalise: true })), ['CT-B', 'CT-A']);
  assert.equal(designationCorrespond('Riz blanc', ' ; '), true, 'aucun terme : tout passe');
  assert.equal(designationCorrespond('Ciment', 'RIZ'), false);
});

test('niveau déclarations : une ligne par déclaration, camions et conteneurs listés', () => {
  const r = extraire(CARGOS, { niveau: 'declarations' }, { voitBalise: true });
  assert.deepEqual(r.lignes.map((l) => l['N° déclaration']).sort(), ['200', '300', '400']);
  const d400 = r.lignes.find((l) => l['N° déclaration'] === '400')!;
  assert.equal(d400['Nb camions'], '1');
  assert.equal(d400['Conteneurs'], 'GLDU3333333');
  assert.equal(d400['Type décl.'], 'C · Mise en conso');
  assert.equal(d400['Camions sortis'], '0 / 1');
});

test('véhicules : exclus par défaut, seuls sur demande', () => {
  assert.ok(!ids(extraire(CARGOS, {}, { voitBalise: true })).includes('CT-C'));
  assert.deepEqual(ids(extraire(CARGOS, { vehicules: 'seulement' }, { voitBalise: true })), ['CT-C']);
});

test('période sur la date de SORTIE : seuls les camions sortis ce jour-là', () => {
  const r = extraire(CARGOS, { dateRef: 'sortie', du: '2026-10-05', au: '2026-10-05' }, { voitBalise: true });
  assert.deepEqual(ids(r), ['CT-A']);
});

test('état « en cours » / « sortis »', () => {
  assert.deepEqual(ids(extraire(CARGOS, { etat: 'sortis' }, { voitBalise: true })), ['CT-A']);
  assert.deepEqual(ids(extraire(CARGOS, { etat: 'encours' }, { voitBalise: true })), ['CT-B']);
});

test('recherche par conteneur, espaces et tirets ignorés', () => {
  assert.deepEqual(ids(extraire(CARGOS, { recherche: 'gldu 333-3333' }, { voitBalise: true })), ['CT-B']);
});

test('RGPD-01 : le n° de balise n\'apparaît pas pour un profil qui ne le voit pas', () => {
  const r = extraire(CARGOS, {}, { voitBalise: false });
  assert.ok(!r.colonnes.includes('N° balise'));
  assert.ok(extraire(CARGOS, {}, { voitBalise: true }).colonnes.includes('N° balise'));
});

test('action serveur : filtre appliqué, et l\'export (et lui seul) est journalisé', async () => {
  const db = new FakeDB();
  for (const r of BRUTS) db.store['cargaisons'].push(structuredClone(r));
  const journal: string[] = [];
  const ctx: Ctx = {
    db: db as never,
    session: { userId: 'u', username: 'chef', nomComplet: 'Chef', role: 'CHEF_BRIGADE' as never },
    log: async (_a: string, _c: string, d: string) => { journal.push(d); },
  };
  const apercu = (await rap.rapportExtraction(ctx, { operation: 'Enlèvement', engagement: 'oui' })) as { total: number };
  assert.equal(apercu.total, 1);
  assert.equal(journal.length, 0, 'un simple aperçu ne laisse pas de trace');
  await rap.rapportExtraction(ctx, { operation: 'Enlèvement', engagement: 'oui', pourExport: true });
  assert.equal(journal.length, 1);
  assert.match(journal[0]!, /1 ligne\(s\) · camions · Enlèvement · engagés/);
});

test('résumé des filtres : lisible, et « aucun filtre » quand rien n\'est choisi', () => {
  assert.equal(resumeFiltres({}), 'aucun filtre');
  assert.equal(resumeFiltres({ dateRef: 'sortie', du: '2026-10-01', au: '2026-10-09', bureauDestination: 'BF' }),
    'Sortie du 2026-10-01 au 2026-10-09 · bureau dest. BF');
});
