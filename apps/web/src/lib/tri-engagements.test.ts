/**
 * Tri du volet « Engagements » (2026-09-17). Ce qui se casse en silence : une
 * échéance vide qui passe pour la plus urgente, et des camions triés par code
 * ASCII plutôt que par lecture humaine.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { trierEngagements, numerosT1, numerosBonSortie, libelleDeclarationEngagement, lignesExportEngagements as exporter } from './tri-engagements.ts';

const L = [
  { numeroCamion: 'TG9999ZZ', engagementDelai: '2026-10-05' },
  { numeroCamion: 'tg1111aa', engagementDelai: '2026-09-15' },
  { numeroCamion: 'TG2222BB', engagementDelai: '' },
  { numeroCamion: 'TG10CC', engagementDelai: '2026-09-15' },
];
const cam = (l: Record<string, unknown>[]) => l.map((x) => x['numeroCamion']);

test('tri par délai : le plus urgent d\'abord, les échéances vides en dernier', () => {
  assert.deepEqual(cam(trierEngagements(L, 'delai')), ['TG10CC', 'tg1111aa', 'TG9999ZZ', 'TG2222BB']);
});

test('tri par délai décroissant : la vide reste en dernier, jamais en tête', () => {
  assert.deepEqual(cam(trierEngagements(L, 'delai', 'desc')), ['TG9999ZZ', 'TG10CC', 'tg1111aa', 'TG2222BB']);
});

test('tri par camion : casse ignorée et nombres lus comme des nombres', () => {
  // « TG10CC » avant « TG1111AA » : 10 < 1111. Un tri ASCII rendrait l'inverse.
  assert.deepEqual(cam(trierEngagements(L, 'camion')), ['TG10CC', 'tg1111aa', 'TG2222BB', 'TG9999ZZ']);
  assert.deepEqual(cam(trierEngagements(L, 'camion', 'desc')), ['TG9999ZZ', 'TG2222BB', 'tg1111aa', 'TG10CC']);
});

test('le tri ne modifie pas la liste reçue', () => {
  const avant = cam(L);
  trierEngagements(L, 'camion', 'desc');
  assert.deepEqual(cam(L), avant);
});

/* ---- Recherche par camion et filtre par délai (2026-09-17) ---- */
import { filtrerEngagements, joursAvantEcheance } from './tri-engagements.ts';

const AUJ = new Date(2026, 8, 17); // 17/09/2026
const E = [
  { numeroCamion: 'TG 1234 BK', engagementDelai: '2026-09-15' }, // dépassé de 2 jours
  { numeroCamion: 'TG5678AB', engagementDelai: '2026-09-20' },   // dans 3 jours
  { numeroCamion: 'BF9999ZZ', engagementDelai: '2026-10-30' },   // dans 43 jours
  { numeroCamion: 'TG1234BX', engagementDelai: '' },             // sans échéance
];
const noms = (l: Record<string, unknown>[]) => l.map((x) => x['numeroCamion']);

test('délai : « dans au plus N jours » inclut les échéances DÉPASSÉES', () => {
  // Un dépassé est déjà dans le délai : l'oublier ferait manquer l'urgent.
  assert.deepEqual(noms(filtrerEngagements(E, { joursMax: 3 }, AUJ)), ['TG 1234 BK', 'TG5678AB']);
  assert.deepEqual(noms(filtrerEngagements(E, { joursMax: 0 }, AUJ)), ['TG 1234 BK']);
  assert.deepEqual(noms(filtrerEngagements(E, { joursMax: 60 }, AUJ)), ['TG 1234 BK', 'TG5678AB', 'BF9999ZZ']);
});

test('délai : une ligne sans échéance ne répond pas à une question de délai', () => {
  assert.equal(noms(filtrerEngagements(E, { joursMax: 60 }, AUJ)).includes('TG1234BX'), false);
  // Sans filtre de délai, elle reste bien dans la liste.
  assert.equal(noms(filtrerEngagements(E, {}, AUJ)).length, 4);
});

test('recherche camion : espaces, tirets et casse ignorés, recherche partielle', () => {
  assert.deepEqual(noms(filtrerEngagements(E, { camion: 'tg1234bk' }, AUJ)), ['TG 1234 BK']);
  assert.deepEqual(noms(filtrerEngagements(E, { camion: 'TG-1234' }, AUJ)), ['TG 1234 BK', 'TG1234BX']);
  assert.deepEqual(noms(filtrerEngagements(E, { camion: '9999' }, AUJ)), ['BF9999ZZ']);
  assert.deepEqual(noms(filtrerEngagements(E, { camion: 'introuvable' }, AUJ)), []);
});

test('les deux filtres se combinent', () => {
  assert.deepEqual(noms(filtrerEngagements(E, { camion: 'TG', joursMax: 3 }, AUJ)), ['TG 1234 BK', 'TG5678AB']);
});

test('joursAvantEcheance : négatif si dépassé, null si illisible', () => {
  assert.equal(joursAvantEcheance('2026-09-15', AUJ), -2);
  assert.equal(joursAvantEcheance('2026-09-17', AUJ), 0);
  assert.equal(joursAvantEcheance('', AUJ), null);
  assert.equal(joursAvantEcheance('pas une date', AUJ), null);
});

/* ---- Nature de l'engagement et signataire : 2026-10-08, demande utilisateur ---- */

const engagements = (): Record<string, unknown>[] => [
  { numeroCamion: 'TG1111AA', engagementType: 'BFE 03 Sinkase', agentValidation: 'Cne MIAWONENE Edem' },
  { numeroCamion: 'TG2222BB', engagementType: 'BFE 03 Sinkase', agentValidation: 'AYIVI ODILON' },
  { numeroCamion: 'TG3333CC', engagementType: 'Transit national', agentValidation: 'Cne MIAWONENE Edem' },
  { numeroCamion: 'TG4444DD', engagementType: 'Transit côtier', agentValidation: 'Cne MIAWONENE Edem' },
  { numeroCamion: 'TG5555EE', engagementType: '', agentValidation: 'Cne MIAWONENE Edem' },
];

test('engagements : filtre par NATURE de l’engagement', () => {
  assert.deepEqual(cam(filtrerEngagements(engagements(), { type: 'BFE 03 Sinkase' })),
    ['TG1111AA', 'TG2222BB']);
});

test('engagements : filtre par SIGNATAIRE de la validation', () => {
  assert.deepEqual(cam(filtrerEngagements(engagements(), { signePar: 'Cne MIAWONENE Edem' })),
    ['TG1111AA', 'TG3333CC', 'TG4444DD', 'TG5555EE']);
});

test('engagements : LES DEUX ENSEMBLE, la question posee par le chef de brigade', () => {
  /* « Mes validations qui vont vers le BFE 03 ». C'est le CROISEMENT qui
     repond : ni la nature seule, ni le signataire seul. */
  const r = filtrerEngagements(engagements(), { type: 'BFE 03 Sinkase', signePar: 'Cne MIAWONENE Edem' });
  assert.deepEqual(cam(r), ['TG1111AA']);
});

test('engagements : casse, accents et espaces en trop ne font pas rater une ligne', () => {
  /* Le champ est du TEXTE LIBRE : le chef peut saisir autre chose que les trois
     propositions, et les variantes d'ecriture sont inevitables. */
  assert.deepEqual(cam(filtrerEngagements(engagements(), { type: 'bfe 03  sinkase' })),
    ['TG1111AA', 'TG2222BB']);
  assert.deepEqual(cam(filtrerEngagements(engagements(), { type: 'TRANSIT COTIER' })), ['TG4444DD']);
});

test('engagements : la comparaison est EXACTE, pas « contient »', () => {
  /* « Transit » ne doit pas ramener « Transit national » ET « Transit cotier » :
     ce sont deux engagements differents, et les confondre fausserait un compte
     qu'on presente ensuite a la hierarchie. */
  assert.deepEqual(cam(filtrerEngagements(engagements(), { type: 'Transit' })), []);
});

test('engagements : sans ces filtres, la liste est rendue telle quelle', () => {
  assert.equal(filtrerEngagements(engagements(), {}).length, 5);
  assert.equal(filtrerEngagements(engagements(), { type: '', signePar: '' }).length, 5);
});

test('engagements : les nouveaux filtres se CUMULENT avec la recherche camion', () => {
  const r = filtrerEngagements(engagements(), { type: 'BFE 03 Sinkase', camion: 'tg2222' });
  assert.deepEqual(cam(r), ['TG2222BB']);
});

/* ---- Extraction Excel (2026-10-08) ---- */
test('extraction : mêmes lignes, même ordre, dates lisibles', async () => {
  const { lignesExportEngagements } = await import('./tri-engagements.ts');
  const rows = lignesExportEngagements([
    { id: 'CT-2', numeroCamion: 'TG2', engagementType: 'BFE 03 Sinkase', engagementDelai: '2026-10-20',
      engagementEffectueLe: '2026-10-07T10:00:00Z', libelle: 'Effectué', agentValidation: 'Chef A' },
    { id: 'CT-1', numeroCamion: 'TG1', engagementType: 'BFE 03 Sinkase', engagementDelai: '2026-10-05', libelle: 'En retard' },
  ]);
  assert.deepEqual(rows.map((r) => r['ID']), ['CT-2', 'CT-1'], "l'ordre affiché est conservé");
  assert.equal(rows[0]!['Échéance'], '20/10/2026');
  assert.equal(rows[0]!['Effectué le'], '07/10/2026');
  assert.equal(rows[0]!['Signé par'], 'Chef A');
  assert.equal(rows[1]!['Effectué le'], '', 'pas encore effectué');
  assert.equal(rows[1]!['État'], 'En retard');
});

/* ---- Déclaration, T1 et bon de sortie (2026-10-09) ---- */
test('T1 : liste par conteneur, liste simple, doublons retirés, « Non requis » si sauté', () => {
  assert.equal(numerosT1({ t1Numeros: [{ conteneur: 'MSKU1', numero: 'T1-A' }, { conteneur: 'MSKU2', numero: 'T1-B' }] }), 'T1-A, T1-B');
  assert.equal(numerosT1({ t1Numeros: ['T1-A', 'T1-A', 'T1-C'] }), 'T1-A, T1-C');
  assert.equal(numerosT1({ t1Numeros: null, sauteT1: true }), 'Non requis');
  assert.equal(numerosT1({ t1Numeros: null }), '', 'pas encore saisi');
});

test('bon de sortie : numéro seul (dépotage) ou liste par conteneur (enlèvement)', () => {
  assert.equal(numerosBonSortie({ bonSortieNumero: 'BS-12' }), 'BS-12');
  assert.equal(numerosBonSortie({ bonSortieNumero: [{ conteneur: 'MSKU1', t1: 'T1-A', numero: 'BS-1' }] }), 'BS-1');
  assert.equal(numerosBonSortie({ bonSortieNumero: '', sauteBs: true }), 'Non requis');
  assert.equal(numerosBonSortie({}), '');
});

test('déclaration : libellé complet, champs vides ignorés', () => {
  assert.equal(libelleDeclarationEngagement({ numeroDeclaration: '12345', anneeDeclaration: '2026', bureauDeclaration: 'TG120', typeDeclaration: 'T' }), '12345 · 2026 · TG120 · T');
  assert.equal(libelleDeclarationEngagement({ numeroDeclaration: '12345' }), '12345');
});

test('extraction : déclarant, déclaration, T1 et bon de sortie présents', () => {
  const [r] = exporter([{ id: 'CT-1', declarant: 'STE X', numeroDeclaration: '12345', anneeDeclaration: '2026',
    bureauDeclaration: 'TG120', typeDeclaration: 'T', t1Numeros: [{ conteneur: 'MSKU1', numero: 'T1-A' }], bonSortieNumero: 'BS-9' }]);
  assert.equal(r!['Déclarant'], 'STE X');
  assert.equal(r!['N° déclaration'], '12345');
  assert.equal(r!['Bureau'], 'TG120');
  assert.equal(r!['T1'], 'T1-A');
  assert.equal(r!['Bon de sortie'], 'BS-9');
});

/* ---- Désignation (2026-10-09) ---- */
test('désignation : « riz ; sucre » garde l\'un OU l\'autre, sans tenir compte des accents', () => {
  const L2 = [
    { id: '1', descriptionMarchandise: 'Riz blanc' },
    { id: '2', descriptionMarchandise: 'SUCRE RAFFINÉ' },
    { id: '3', descriptionMarchandise: 'Ciment' },
  ];
  assert.deepEqual(filtrerEngagements(L2, { designation: 'riz ; sucre' }).map((l) => l['id']), ['1', '2']);
  assert.deepEqual(filtrerEngagements(L2, { designation: 'raffine' }).map((l) => l['id']), ['2']);
  assert.equal(filtrerEngagements(L2, { designation: ' ; ' }).length, 3, 'aucun terme : tout passe');
});

test('extraction des engagements : colonne Désignation', () => {
  const [r] = exporter([{ id: 'CT-1', descriptionMarchandise: '331 COLIS VÊTEMENTS' }]);
  assert.equal(r!['Désignation'], '331 COLIS VÊTEMENTS');
});
