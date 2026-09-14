/**
 * ÉQUIVALENCE DES PRÉ-FILTRES SQL DES LISTES — 2026-09-12.
 *
 * `cargoList` ne rapatrie plus toute la table : une partie du tri est passée en
 * SQL pour tenir le temps de réponse (mesuré : 3,7 s quel que soit le nombre de
 * lignes rendues, parce que tout était chargé avant d'être trié).
 *
 * Ce qui est vérifié ici n'est PAS que c'est plus rapide — une base en mémoire
 * ne dirait rien de la vitesse. C'est qu'AUCUN DOSSIER NE DISPARAÎT. Un filtre
 * trop étroit sortirait un camion de sa file d'attente sans que personne s'en
 * aperçoive, et un camion qu'on ne voit plus est un camion qu'on ne traite pas.
 *
 * La référence n'est pas l'ancienne implémentation mais l'AUTORITÉ du domaine :
 * `fileAttente`, la règle qui dit dans quelle file vit un dossier.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STATUTS, fileAttente } from '../../_shared/domaine/src/index.ts';
import { versCamel, type Ctx } from '../ctx.ts';
import { FakeDB } from './fake-db.ts';
import * as lec from './lecture.ts';

function ctx(db: FakeDB): Ctx {
  return {
    db: db as never,
    session: { userId: 'u', username: 'admin', nomComplet: 'Admin', role: 'ADMIN' as never },
    log: async () => {},
  };
}

/** Un jeu de dossiers qui couvre tous les cas limites du filtre. */
function baseDeTest(): FakeDB {
  const db = new FakeDB();
  db.store['cargaisons'].push(
    // En attente de T1 : doit apparaître dans la file T1.
    { id: 'A-T1', statut: STATUTS.CREEE, date_creation: '2026-09-01T08:00:00Z',
      numero_camion: 'AA1111AA/R1', date_validation: '2026-09-01T09:00:00Z' },
    // Sorti par la PP, statut terminal : dans AUCUNE file.
    { id: 'B-SORTI', statut: STATUTS.SORTIE, date_creation: '2026-09-02T08:00:00Z',
      numero_camion: 'BB2222BB/R2', date_sortie: '2026-09-03T10:00:00Z' },
    /* LE CAS PIÈGE. Réellement sorti — `date_sortie` renseignée — mais son
       statut est resté à une valeur intermédiaire. `etatCellules` le tient pour
       sorti ; il ne doit donc figurer dans aucune file. Un pré-filtre qui
       n'aurait regardé QUE le statut l'aurait laissé passer. */
    { id: 'C-SORTI-SANS-STATUT', statut: STATUTS.CREEE, date_creation: '2026-09-02T09:00:00Z',
      numero_camion: 'CC3333CC/R3', date_sortie: '2026-09-04T11:00:00Z' },
    // Camion à peine créé : encore côté CFS.
    { id: 'D-CFS', statut: STATUTS.CAMION, date_creation: '2026-09-05T08:00:00Z',
      numero_camion: 'DD4444DD/R4' },
  );
  return db;
}

/** Ce que le DOMAINE dit de la file d'un dossier — la référence. */
function filesAttendues(db: FakeDB, etape: string): string[] {
  return db.store['cargaisons']
    .map((c) => versCamel(c))
    .filter((c) => fileAttente(c as never) === etape)
    .map((c) => String(c['id']))
    .sort();
}

const idsDe = (r: unknown) => ((r as { rows: Record<string, unknown>[] }).rows)
  .map((x) => String(x['id'])).sort();

test('file T1 : le pré-filtre rend EXACTEMENT ce que dit `fileAttente`', async () => {
  const db = baseDeTest();
  const res = await lec.cargoList(ctx(db), { etape: 'T1', categorie: 'tous' });
  assert.deepEqual(idsDe(res), filesAttendues(db, 'T1'));
  assert.deepEqual(idsDe(res), ['A-T1'], 'le dossier en attente de T1 est bien là');
});

test('file CFS : idem, et le camion à peine créé y figure', async () => {
  const db = baseDeTest();
  const res = await lec.cargoList(ctx(db), { etape: 'CFS', categorie: 'tous' });
  assert.deepEqual(idsDe(res), filesAttendues(db, 'CFS'));
  assert.deepEqual(idsDe(res), ['D-CFS']);
});

test('un dossier SORTI ne figure dans AUCUNE file', async () => {
  const db = baseDeTest();
  for (const etape of ['CFS', 'VALIDATION', 'T1', 'BALISE', 'BS', 'PP']) {
    const ids = idsDe(await lec.cargoList(ctx(db), { etape, categorie: 'tous' }));
    assert.equal(ids.includes('B-SORTI'), false, `B-SORTI ne doit pas être dans ${etape}`);
    assert.equal(ids.includes('C-SORTI-SANS-STATUT'), false,
      `C-SORTI-SANS-STATUT (date de sortie, statut intermédiaire) ne doit pas être dans ${etape}`);
  }
});

test('TOUTES les files réunies rendent les mêmes dossiers que le domaine', async () => {
  const db = baseDeTest();
  const vus: string[] = [];
  for (const etape of ['CFS', 'VALIDATION', 'T1', 'BALISE', 'BS', 'PP']) {
    vus.push(...idsDe(await lec.cargoList(ctx(db), { etape, categorie: 'tous' })));
  }
  const attendus = db.store['cargaisons']
    .map((c) => versCamel(c))
    .filter((c) => fileAttente(c as never) !== null)
    .map((c) => String(c['id'])).sort();
  assert.deepEqual(vus.sort(), attendus,
    'aucun dossier en attente ne doit se perdre entre les six files');
});

test('« actifs » écarte les sortis, et eux seuls', async () => {
  const db = baseDeTest();
  const ids = idsDe(await lec.cargoList(ctx(db), { categorie: 'tous', actifs: true }));
  assert.equal(ids.includes('B-SORTI'), false);
  // C garde un statut intermédiaire : « actifs » ne regarde QUE le statut, et le
  // tri JS d'origine faisait déjà exactement cela. L'équivalence est respectée.
  assert.deepEqual(ids, ['A-T1', 'C-SORTI-SANS-STATUT', 'D-CFS']);
});

test('un statut exact rend ce statut, et rien d\'autre', async () => {
  const db = baseDeTest();
  const ids = idsDe(await lec.cargoList(ctx(db), { categorie: 'tous', statut: STATUTS.CAMION }));
  assert.deepEqual(ids, ['D-CFS']);
});

test('sans filtre, la liste rend TOUT — le pré-filtre ne s\'applique pas', async () => {
  const db = baseDeTest();
  const res = await lec.cargoList(ctx(db), { categorie: 'tous' });
  assert.equal((res as { total: number }).total, 4);
});

/**
 * LE TEST QUI COMPTE VRAIMENT.
 *
 * Les sept précédents passeraient encore si le pré-filtre SQL ne filtrait
 * RIEN : le tri JS qui suit rendrait le même résultat, simplement après avoir
 * tout téléchargé — c'est-à-dire sans rien corriger au problème qu'on cherche
 * à résoudre. Celui-ci observe ce que la base a réellement RENVOYÉ.
 */
test('le pré-filtre agit : la base ne renvoie plus que les lignes utiles', async () => {
  const db = baseDeTest();
  const lignesRenvoyees: number[] = [];
  const origine = db.from.bind(db);
  (db as unknown as { from: (t: string) => unknown }).from = (t: string) => {
    const q = origine(t) as { range: (a: number, b: number) => Promise<{ data: unknown[] }> };
    if (t === 'v_cargaisons_resume') {
      const range = q.range.bind(q);
      q.range = async (a: number, b: number) => {
        const r = await range(a, b);
        lignesRenvoyees.push((r.data ?? []).length);
        return r;
      };
    }
    return q;
  };

  lignesRenvoyees.length = 0;
  await lec.cargoList(ctx(db), { etape: 'T1', categorie: 'tous' });
  const avecFiltre = lignesRenvoyees[0];

  lignesRenvoyees.length = 0;
  await lec.cargoList(ctx(db), { categorie: 'tous' });
  const sansFiltre = lignesRenvoyees[0];

  assert.equal(sansFiltre, 4, 'sans critère, la vue rend les 4 dossiers');
  assert.equal(avecFiltre, 2,
    'avec le filtre, la base n\'envoie que les 2 dossiers non sortis — '
    + 'les 2 sortis ne franchissent plus le fil');
  assert.ok(avecFiltre < sansFiltre, 'le filtre doit réduire ce qui transite');
});

/* ===== FILTRE « SUIVI DES ENGAGEMENTS » — 2026-09-12 =====================
 *
 * Demandé pour qu'un chef puisse ne demander que les camions engagés. Le point
 * délicat n'est pas le tri lui-même : c'est qu'il doit RESTER SANS EFFET tant
 * que la migration 00190 n'expose pas la colonne. Une liste vide parce qu'une
 * migration manque serait prise pour « aucun dossier », et c'est bien pire
 * qu'un filtre qui ne filtre pas encore.
 */
test('engagement « avec » ne rend que les dossiers engagés', async () => {
  const db = baseDeTest();
  db.store['cargaisons'][0]!['suivi_engagement'] = true;
  const ids = idsDe(await lec.cargoList(ctx(db), { categorie: 'tous', engagement: 'avec' }));
  assert.deepEqual(ids, ['A-T1']);
});

test('engagement « sans » rend tout le reste', async () => {
  const db = baseDeTest();
  db.store['cargaisons'][0]!['suivi_engagement'] = true;
  const ids = idsDe(await lec.cargoList(ctx(db), { categorie: 'tous', engagement: 'sans' }));
  assert.equal(ids.includes('A-T1'), false);
  assert.equal(ids.length, 3);
});

test('sans filtre, les dossiers engagés restent dans la liste', async () => {
  const db = baseDeTest();
  db.store['cargaisons'][0]!['suivi_engagement'] = true;
  assert.equal((await lec.cargoList(ctx(db), { categorie: 'tous' }) as { total: number }).total, 4);
});

test('COLONNE ABSENTE : la liste ne casse pas, elle rend tout', async () => {
  // Aucune cargaison ne porte `suivi_engagement` — l'état exact de la base
  // tant que la 00190 n'est pas appliquée.
  const db = baseDeTest();
  const sans = idsDe(await lec.cargoList(ctx(db), { categorie: 'tous', engagement: 'sans' }));
  assert.equal(sans.length, 4, 'sans engagement connu, tout est « sans »');
  const avec = idsDe(await lec.cargoList(ctx(db), { categorie: 'tous', engagement: 'avec' }));
  assert.deepEqual(avec, [], 'et « avec » rend une liste vide, pas une erreur');
});

/* ===== UN CONTENEUR PARTAGÉ NE COMPTE QU'UNE FOIS — 2026-09-12 ===========
 *
 * Règle dictée par le douanier. Un conteneur dont la marchandise se répartit
 * sur plusieurs camions apparaît sur chacun d'eux ; le compter à chaque fois
 * gonflerait les totaux et les EVP — on déclarerait plusieurs fois la même
 * boîte. Le CAMION, lui, reste compté à chaque passage : ce sont bien deux
 * passages distincts au poste.
 */
import * as rap from './rapports.ts';

function deuxCamionsUnConteneur(): FakeDB {
  const db = new FakeDB();
  const details = JSON.stringify({
    conteneurs: [{ num: 'MSKU4440001', taille: "20'", type: 'DRY', plomb: '' }],
    scellesCamion: [],
  });
  for (const [id, plaque] of [['CT-2026-700001', 'PAR001/RM01'], ['CT-2026-700002', 'PAR002/RM02']]) {
    db.store['cargaisons'].push({
      id, numero_camion: plaque, statut: 'Balisée', type_operation: 'Dépotage',
      date_creation: '2026-09-10T08:00:00Z', date_pose_gps: '2026-09-10T09:00:00Z',
      agent_balise: 'Agent Balise', conteneurs_details: JSON.parse(details),
    });
  }
  return db;
}

test('rapport Balise — le conteneur partagé compte UNE fois, les camions DEUX', async () => {
  const db = deuxCamionsUnConteneur();
  const r = await rap.rapportActivite(ctx(db), {
    kind: 'balise', du: '2026-09-01', au: '2026-09-30',
  }) as { total: { camions: number; conteneurs: number; evp: number } };
  assert.equal(r.total.camions, 2, 'deux passages au poste Balise : deux camions');
  assert.equal(r.total.conteneurs, 1, 'une seule boîte physique');
  assert.equal(r.total.evp, 1, "et un seul EVP — sinon on déclare deux fois le même conteneur");
});
