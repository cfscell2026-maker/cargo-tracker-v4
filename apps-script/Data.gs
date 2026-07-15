/**
 * ============================================================================
 *  Data.gs : Accès données Cargaisons (CRUD), recherche, listes, statistiques
 * ============================================================================
 *  Stratégie de PERFORMANCE (classeur volumineux) :
 *   - Recherche d'un ID : TextFinder (recherche serveur native, très rapide,
 *     ne charge pas toute la feuille en mémoire).
 *   - Listes : lecture des SEULES colonnes utiles (pas toute la ligne),
 *     filtrage en mémoire, tri, pagination -> on ne renvoie qu'une page.
 *   - Écritures : appendRow (atomique) + LockService pour les mises à jour
 *     d'une même ligne, afin d'éviter les conditions de course.
 *   - Cache court (CacheService) sur les vues de liste, invalidé à chaque écriture.
 * ============================================================================
 */

/* --------------------------- Utilitaires bas niveau -------------------- */

function _sheet_(name) {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (!sh) throw new Error('Feuille introuvable : ' + name + '. Lancez initialiserApplication().');
  return sh;
}

/** Génère un ID séquentiel atomique : CT-YYYY-000001 */
function _genererId_() {
  return _genererSeq_('SEQ', APP.ID_PREFIX);
}
/** Génère un identifiant de rapport atomique : RPT-YYYY-000001 */
function _genererRapportId_() {
  return _genererSeq_('SEQ_RPT', APP.RPT_PREFIX);
}
/** Compteur séquentiel atomique générique (préfixe + année + 6 chiffres). */
function _genererSeq_(propKey, prefix) {
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const props = PropertiesService.getScriptProperties();
    const n = Number(props.getProperty(propKey) || '0') + 1;
    props.setProperty(propKey, String(n));
    const annee = new Date().getFullYear();
    return prefix + '-' + annee + '-' + ('000000' + n).slice(-6);
  } finally {
    lock.releaseLock();
  }
}

/** Trouve le n° de ligne d'une cargaison par son ID (TextFinder = rapide). */
function _rowById_(id) {
  const sh = _sheet_(SHEETS.CARGOS);
  const last = sh.getLastRow();
  if (last < 2) return -1;
  const finder = sh.getRange(2, COL.id + 1, last - 1, 1)
    .createTextFinder(String(id).trim()).matchEntireCell(true);
  const cell = finder.findNext();
  return cell ? cell.getRow() : -1;
}

/** Convertit une ligne (array) en objet {key: valeur}. */
function _rowToObj_(row) {
  const o = {};
  COLS.forEach((c, i) => (o[c.key] = row[i]));
  return o;
}

/** Normalise dates -> ISO pour le transport vers le client. */
function _serialiser_(o) {
  const out = {};
  Object.keys(o).forEach(k => {
    const v = o[k];
    out[k] = (v instanceof Date) ? v.toISOString() : v;
  });
  return out;
}

function _invaliderCacheListes_() {
  // On versionne les listes : un simple incrément invalide tous les caches de liste.
  const props = PropertiesService.getScriptProperties();
  const v = Number(props.getProperty('LIST_VER') || '0') + 1;
  props.setProperty('LIST_VER', String(v));
}
function _versionListe_() {
  return PropertiesService.getScriptProperties().getProperty('LIST_VER') || '0';
}

/* ------------------------------ Lecture -------------------------------- */

/** Renvoie une cargaison complète (objet) par ID, ou null. */
function _getCargo_(id) {
  const row = _rowById_(id);
  if (row < 0) return null;
  const vals = _sheet_(SHEETS.CARGOS).getRange(row, 1, 1, COLS.length).getValues()[0];
  const o = _rowToObj_(vals);
  o._row = row;
  return o;
}

/**
 * Recherche LIMITÉE au N° de camion, volontairement TRÈS FLEXIBLE.
 * On normalise la requête ET chaque N° de camion (MAJUSCULES + suppression de
 * tout caractère non alphanumérique), puis on teste l'inclusion. Ainsi
 * « ab 12 », « AB-12 », « ab12 » retrouvent tous le camion « AB12CD ».
 * (Le paramètre `critere` est ignoré, conservé pour compatibilité du routeur.)
 * Retourne au plus 200 résultats (résumé), du plus récent au plus ancien.
 */
function _rechercher_(critere, valeur) {
  const q = String(valeur || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!q) return [];

  const sh = _sheet_(SHEETS.CARGOS);
  const last = sh.getLastRow();
  if (last < 2) return [];

  const data = _resumeListeCachee_(sh, last);
  const res = [];
  for (let i = 0; i < data.length; i++) {
    const norm = String(data[i].numeroCamion || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (norm && norm.indexOf(q) > -1) res.push(data[i]);
    if (res.length >= 200) break;
  }
  res.sort((a, b) => _ts_(b.dateCreation) - _ts_(a.dateCreation));
  return res;
}

/** Lecture des seules colonnes utiles aux listes/recherches (rapide). */
function _lireColonnesResume_(sh, last) {
  // On lit le bloc complet une fois, mais on ne conserve que les colonnes résumé.
  // getValues d'un bloc est bien plus rapide que des lectures cellule par cellule.
  const vals = sh.getRange(2, 1, last - 1, COLS.length).getValues();
  return vals.map(row => _resumeRow_(row));
}

const RESUME_KEYS = ['id','reference','dateCreation','numeroCamion','typeOperation',
  'conteneur1','conteneur2','conteneur3','conteneur4','statut','numeroGPS',
  'dateSortie','agentCFS','rapportId','estVehicule','conteneurOrigine',
  'sauteT1','sauteBalise','baliseRequise','arriveeBureau',
  // v2.7 : nécessaires au calcul des étapes PARALLÈLES (Balise ∥ Bon de Sortie) dans les files.
  'dateT1','datePoseGPS','bonSortieNumero',
  // v3.0 : nécessaire pour que le moteur place l'étape VALIDATION dans les files / stats.
  'dateValidation',
  // v3.5 : état du camion à la sortie de la zone CFS (traçabilité site).
  'etatSortie',
  // v3.6 : ouillage véhicule (saut du bon de sortie calculé par le moteur).
  'sauteBS'];

/* ----------------------- Moteur de workflow (étapes) ------------------- */
/**
 * Modèle PARALLÈLE (v2.7) : CFS (fin de chargement) → T1 → { BALISE ∥ BON DE SORTIE } → PP.
 * Après le T1, la Balise et le Bon de Sortie travaillent EN PARALLÈLE (indépendamment) ;
 * la PP ne peut clôturer que lorsque les DEUX sont faits. Les sauts (conso/magasin/véhicule)
 * marquent la cellule concernée comme déjà « faite ».
 */
function _aFait_(v) { return v !== '' && v !== null && v !== undefined; }
/** État de chaque cellule pour une cargaison (objet complet OU résumé sérialisé). */
function _etatCellules_(c) {
  // v3.6 : « Véhicule ouillage créé » = déclaration pas encore renseignée -> encore côté CFS.
  const enCharge = (c.statut === STATUTS.CAMION || c.statut === STATUTS.CHARGEMENT ||
                    c.statut === STATUTS.VEHICULE_OUILLAGE);
  return {
    cfs:    !enCharge,                                   // fin de chargement atteinte (≥ « Créée »)
    valide: String(c.sauteValidation) === 'Oui' || _aFait_(c.dateValidation), // v3.0 : signature du chef brigade
    t1:     String(c.sauteT1) === 'Oui' || _aFait_(c.dateT1),
    balise: String(c.sauteBalise) === 'Oui' || String(c.estVehicule) === 'Oui' || _aFait_(c.datePoseGPS),
    bs:     String(c.sauteBS) === 'Oui' || _aFait_(c.bonSortieNumero),  // v3.6 : ouillage saute le bon de sortie
    sorti:  c.statut === STATUTS.SORTIE,
  };
}
/** Étapes ENCORE EN ATTENTE (parallèle Balise/Bon de Sortie). Tableau parmi CFS/VALIDATION/T1/BALISE/BS/PP. */
function _etapesEnAttente_(c) {
  const e = _etatCellules_(c);
  if (e.sorti) return [];
  if (!e.cfs) return ['CFS'];           // camion vide / en cours -> à compléter par le CFS
  if (!e.valide) return ['VALIDATION']; // v3.0 : validation chef brigade AVANT T1/Balise/Bon de sortie
  if (!e.t1) return ['T1'];             // puis la cellule T1
  const p = [];
  if (!e.balise) p.push('BALISE');     // après le T1 : Balise et Bon de Sortie EN PARALLÈLE
  if (!e.bs) p.push('BS');
  if (e.balise && e.bs) p.push('PP');  // PP seulement quand les DEUX sont faits
  return p;
}
/** Compat : 1re étape en attente (ou null si terminé). */
function _prochaineEtape_(c) {
  const p = _etapesEnAttente_(c);
  return p.length ? p[0] : null;
}

function _resumeRow_(row) {
  const r = {};
  RESUME_KEYS.forEach(k => (r[k] = row[COL[k]]));
  return r;
}
function _resume_(o) {
  const r = {};
  RESUME_KEYS.forEach(k => (r[k] = o[k]));
  return r;
}

/**
 * Liste paginée filtrée par statut (ou 'tous'), avec recherche libre optionnelle.
 * Cache court (45 s) par (statut, version) pour les vues fréquentes.
 */
function _listerCargaisons_(opts) {
  opts = opts || {};
  const statut = opts.statut || 'tous';
  const etape = opts.etape || '';                 // file d'attente par ÉTAPE attendue (gère conso/véhicule)
  const categorie = opts.categorie || 'camion';   // 'camion' (défaut, exclut les véhicules) | 'vehicule'
  const page = Math.max(1, Number(opts.page || 1));
  const pageSize = Math.min(200, Number(opts.pageSize || APP.PAGE_SIZE));
  const search = String(opts.search || '').trim().toLowerCase();

  const sh = _sheet_(SHEETS.CARGOS);
  const last = sh.getLastRow();
  if (last < 2) return { rows: [], total: 0, page: 1, pages: 1 };

  let all = _resumeListeCachee_(sh, last);

  if (etape) {
    // File d'attente d'une cellule : on filtre sur les étapes EN ATTENTE (modèle
    // parallèle : un camion post-T1 figure À LA FOIS dans la file Balise et Bon de Sortie).
    all = all.filter(r => _etapesEnAttente_(r).indexOf(etape) >= 0);
    if (etape === 'BALISE') all = all.filter(r => r.estVehicule !== 'Oui');
  } else {
    // Les véhicules sont suivis à part : on ne les mélange pas aux camions.
    all = all.filter(r => categorie === 'vehicule' ? r.estVehicule === 'Oui' : r.estVehicule !== 'Oui');
  }
  if (statut !== 'tous') all = all.filter(r => r.statut === statut);
  if (search) {
    all = all.filter(r =>
      [r.id, r.reference, r.rapportId, r.numeroCamion, r.conteneur1, r.numeroGPS]
        .some(x => String(x).toLowerCase().indexOf(search) > -1));
  }
  all.sort((a, b) => _ts_(b.dateCreation) - _ts_(a.dateCreation));

  const total = all.length;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const start = (page - 1) * pageSize;
  const rows = all.slice(start, start + pageSize).map(_serialiser_);
  return { rows: rows, total: total, page: page, pages: pages };
}

/** Lecture résumé avec cache court versionné. */
function _resumeListeCachee_(sh, last) {
  const cache = CacheService.getScriptCache();
  const key = 'list_' + _versionListe_() + '_' + last;
  const raw = cache.get(key);
  if (raw) { try { return JSON.parse(raw); } catch (e) {} }
  const data = _lireColonnesResume_(sh, last).map(_serialiser_);
  // Cache 45 s ; chunk si > 95KB
  const json = JSON.stringify(data);
  if (json.length < 95000) cache.put(key, json, 45);
  return data;
}

/* ------------------------------ Écritures ------------------------------ */

/**
 * Étape 1 — Création par l'agent CFS.
 * Un appel = 1 RAPPORT regroupant 1..N camions partageant les mêmes infos de
 * déclaration. Chaque camion devient sa propre ligne (cargaison) avec son ID et
 * son propre parcours (GPS → Sortie). Les camions sont reliés par `rapportId`.
 *
 * Payload attendu :
 * {
 *   typeOperation: 'Dépotage' | 'Enlèvement',
 *   declaration: { declarant, contactDeclarant, destinationMarchandise,
 *                  bureauDeclaration, typeDeclaration, numeroDeclaration,
 *                  anneeDeclaration, descriptionMarchandise },
 *   observationsCFS: '...',
 *   camions: [ {
 *      numeroCamion,
 *      conteneurs: [ {num, plomb, taille, type, poids, extra:[{nom,valeur}]} ]
 *                  // nombre LIBRE ; `plomb` = scellé propre au conteneur
 *   } ]
 * }
 */
function _creerRapport_(session, p) {
  p = p || {};
  const type = p.typeOperation;
  if (type === OPERATIONS.VEHICULE) return _creerRapportVehicule_(session, p);   // parcours dédié
  if (type === OPERATIONS.MAGASIN)  return _creerRapportMagasin_(session, p);    // sortie vrac (sans conteneur)
  if ([OPERATIONS.DEPOTAGE, OPERATIONS.ENLEVEMENT, OPERATIONS.CONSO].indexOf(type) === -1)
    throw new Error("Type d'opération invalide.");

  const camions = Array.isArray(p.camions) ? p.camions : [];
  if (!camions.length) throw new Error('Au moins un camion est requis.');

  // Sauts de cellule : Conso saute toujours le T1 ; « non balisée » saute aussi la Balise.
  const estConso = (type === OPERATIONS.CONSO);
  const sauteBalise = (estConso && String(p.consoMode) === 'sansbalise') ? 'Oui' : 'Non';
  const sauteT1 = estConso ? 'Oui' : 'Non';

  const decl = _normaliserDeclaration_(p.declaration || {}, type);
  const obsCFS = _maj_(p.observationsCFS, 1000);

  // Chargement terminé (scellés posés) ? Sinon « En cours de chargement » (scellés optionnels).
  const chargementTermine = !(p.chargementTermine === false);
  const statutInitial = chargementTermine ? STATUTS.CREEE : STATUTS.CHARGEMENT;

  // Pré-validation de TOUS les camions avant toute écriture (atomicité logique).
  const lignes = camions.map(cam => _construireCamion_(cam, type, chargementTermine));
  const nbTotal = lignes.reduce(function (n, cam) { return n + (cam.conteneurs || []).length; }, 0);

  // Apurement : une nouvelle déclaration EXIGE le nombre de conteneurs (avant toute écriture).
  if (!_lookupDeclaration_({ declaration: decl }).exists && !(Number((p.declaration || {}).nombreConteneurs) >= 1))
    throw new Error('Nouvelle déclaration : indiquez le « nombre de conteneurs » déclarés.');

  const rapportId = _genererRapportId_();
  const now = new Date();
  const sh = _sheet_(SHEETS.CARGOS);
  const cree = [];
  const contRows = [];

  lignes.forEach(cam => {
    const id = _genererId_();
    const obj = _objCamion_(id, rapportId, now, cam, type, decl, obsCFS, session, sauteT1, sauteBalise, statutInitial);
    sh.appendRow(COLS.map(c => obj[c.key] === undefined ? '' : obj[c.key]));
    cam.conteneurs.forEach((ct, idx) =>
      contRows.push(_ligneConteneur_(rapportId, id, cam.numeroCamion, type, idx + 1, ct, now)));
    cree.push({ id: id, numeroCamion: cam.numeroCamion });
  });

  _ajouterConteneurs_(contRows);          // table normalisée (traitement Excel)
  const restant = _majApurement_(decl, p.declaration, nbTotal, session);   // suivi d'apurement
  _invaliderCacheListes_();
  _log_(session, 'Création rapport', rapportId,
    type + ' / ' + cree.length + ' camion(s) : ' + cree.map(c => c.id).join(', '));
  return { rapportId: rapportId, camions: cree, apurementRestant: restant };
}

/** Construit l'objet ligne d'un CAMION (parcours CFS → [T1] → [Balise] → BS → PP). */
function _objCamion_(id, rapportId, now, cam, type, decl, obsCFS, session, sauteT1, sauteBalise, statutInitial) {
  return {
    id: id, reference: id, dateCreation: now,
    numeroCamion: cam.numeroCamion, typeOperation: type, twins: cam.twins,
    conteneur1: cam.conteneur1, plomb1: cam.plomb1, conteneur2: cam.conteneur2, plomb2: cam.plomb2,
    conteneur3: cam.conteneur3, plomb3: cam.plomb3,
    declarant: decl.declarant, contactDeclarant: decl.contactDeclarant,
    destinationMarchandise: decl.destinationMarchandise, bureauDeclaration: decl.bureauDeclaration,
    typeDeclaration: decl.typeDeclaration, numeroDeclaration: decl.numeroDeclaration,
    anneeDeclaration: decl.anneeDeclaration, descriptionMarchandise: decl.descriptionMarchandise,
    observationsCFS: obsCFS, agentCFS: session.nomComplet, statut: statutInitial || STATUTS.CREEE,
    numeroGPS: '', datePoseGPS: '', agentBalise: '', observationsBalise: '',
    infosValidees: '', dateSortie: '', agentPP: '', observationsPP: '',
    derniereMaj: now, rapportId: rapportId,
    conteneur4: cam.conteneur4, conteneursDetails: cam.conteneursDetails,
    plomb4: cam.plomb4, nbConteneurs: cam.nbConteneurs,
    baliseRequise: '', chargementMixte: '', mixteDetails: '',
    estVehicule: '', vehiculeDetails: '', conteneurOrigine: '',
    sauteT1: sauteT1 || 'Non', sauteBalise: sauteBalise || 'Non', arriveeBureau: '',
  };
}

/**
 * Module Magasin / MAD — TEMPS 2 : sortie de marchandise en VRAC (aucun conteneur lié).
 * Crée une cargaison « camion » sans conteneur qui suit CFS → [Balise] → Bon de Sortie → PP
 * (saute toujours le T1). Choix baliser / non balisée comme la Conso.
 * Payload : { typeOperation:'Sortie Magasin / MAD', declaration, observationsCFS?,
 *             numeroCamion, consoMode?('balise'|'sansbalise') }
 */
function _creerRapportMagasin_(session, p) {
  const numeroCamion = _alphaNumMaj_(p.numeroCamion);
  if (!numeroCamion) throw new Error('N° camion requis pour la sortie magasin.');
  const decl = _normaliserDeclaration_(p.declaration || {}, OPERATIONS.MAGASIN);
  const obsCFS = _maj_(p.observationsCFS, 1000);
  const sauteBalise = (String(p.consoMode) === 'sansbalise') ? 'Oui' : 'Non';

  const rapportId = _genererRapportId_();
  const id = _genererId_();
  const now = new Date();
  const cam = {
    numeroCamion: numeroCamion, twins: 'No',
    conteneur1: '', plomb1: '', conteneur2: '', plomb2: '', conteneur3: '', plomb3: '',
    conteneur4: '', plomb4: '', nbConteneurs: 0, conteneursDetails: '',
  };
  const obj = _objCamion_(id, rapportId, now, cam, OPERATIONS.MAGASIN, decl, obsCFS, session, 'Oui', sauteBalise);
  _sheet_(SHEETS.CARGOS).appendRow(COLS.map(c => obj[c.key] === undefined ? '' : obj[c.key]));
  _majApurement_(decl, p.declaration, 0, session);
  _invaliderCacheListes_();
  _log_(session, 'Sortie Magasin/MAD (vrac)', id, numeroCamion);
  return { rapportId: rapportId, camions: [{ id: id, numeroCamion: numeroCamion }] };
}

/**
 * Étape 1 bis — Création d'un rapport DÉPOTAGE / VÉHICULE.
 * Chaque véhicule devient une ligne créée DIRECTEMENT au statut « GPS Installé »
 * (= en attente de sortie) : il SAUTE l'étape Balise (`baliseRequise='Non'`) et
 * n'est JAMAIS compté comme un camion (`estVehicule='Oui'`). On peut en plus
 * ajouter des camions (effets divers du conteneur) qui suivent le parcours normal.
 * Payload : { typeOperation:'Dépotage / Véhicule', declaration, conteneurOrigine?,
 *             observationsCFS?, vehicules:[{chassis,marque,modele,couleur,extra[]}],
 *             camions?:[ ... même format qu'un dépotage ... ] }
 */
function _creerRapportVehicule_(session, p) {
  // v3.6 — régime : 'declaration' (défaut, flux existant) ou 'ouillage' (permis d'examiner :
  // on dépote AVANT la déclaration ; n° + date d'ouillage seuls, déclaration renseignée après, PAR véhicule).
  const estOuillage = (String(p.regime || '').toLowerCase() === 'ouillage');
  let decl = null, ouillageNumero = '', ouillageDate = null;
  if (estOuillage) {
    ouillageNumero = _maj_(p.ouillageNumero, 60);
    ouillageDate = _parseDateImport_(p.ouillageDate);
    if (!ouillageNumero) throw new Error("Ouillage : le numéro du permis d'examiner est obligatoire.");
    if (!ouillageDate) throw new Error("Ouillage : la date du permis d'examiner est obligatoire.");
    if (Array.isArray(p.camions) && p.camions.length)
      throw new Error('Ouillage : pas de camions d\'effets divers à ce stade (la déclaration n\'existe pas encore).');
  } else {
    decl = _normaliserDeclaration_(p.declaration || {}, OPERATIONS.VEHICULE);
  }
  // Ouillage : pas encore de déclaration -> champs déclaration vides sur la ligne.
  if (!decl) decl = { declarant: '', contactDeclarant: '', destinationMarchandise: '',
    bureauDeclaration: '', typeDeclaration: '', numeroDeclaration: '', anneeDeclaration: '', descriptionMarchandise: '' };
  const obsCFS = _maj_(p.observationsCFS, 1000);
  const conteneurOrigine = _maj_(p.conteneurOrigine, 20).replace(/[^A-Z0-9]/g, '');
  if (conteneurOrigine && !_tcValide_(conteneurOrigine))
    throw new Error("N° conteneur d'origine invalide. Format attendu : 4 lettres + 7 chiffres (ex. MSKU1234567).");

  const vehicules = (Array.isArray(p.vehicules) ? p.vehicules : []).map(_construireVehicule_);
  if (!vehicules.length) throw new Error('Au moins un véhicule est requis.');
  const camions = estOuillage ? [] : (Array.isArray(p.camions) ? p.camions : [])
    .map(function (cam) { return _construireCamion_(cam, OPERATIONS.DEPOTAGE); });

  // Le conteneur dépoté ne doit être compté QU'UNE fois :
  //  - s'il est porté par un camion ajouté (effets divers) -> compté côté camion (dépotage) ;
  //  - sinon -> compté une seule fois côté véhicule, sur la 1re ligne véhicule (« porteuse »).
  const numsCamions = [];
  camions.forEach(function (cam) { cam.conteneurs.forEach(function (ct) { numsCamions.push(ct.num); }); });
  const compteSurVehicule = !!conteneurOrigine && numsCamions.indexOf(conteneurOrigine) === -1;

  const rapportId = _genererRapportId_();
  const now = new Date();
  const sh = _sheet_(SHEETS.CARGOS);
  const creeV = [], creeC = [], contRows = [];

  vehicules.forEach(function (v, i) {
    const id = _genererId_();
    // Seule la 1re ligne véhicule « porte » le conteneur dépoté (compté une fois).
    const porteur = (i === 0 && compteSurVehicule);
    const obj = _objVehicule_(id, rapportId, now, v, decl, conteneurOrigine, obsCFS, session, porteur);
    if (estOuillage) {                                 // v3.6 : ouillage = pas de déclaration, statut dédié
      obj.statut = STATUTS.VEHICULE_OUILLAGE;
      obj.ouillageNumero = ouillageNumero; obj.ouillageDate = ouillageDate;
    }
    sh.appendRow(COLS.map(c => obj[c.key] === undefined ? '' : obj[c.key]));
    if (porteur) {
      contRows.push(_ligneConteneur_(rapportId, id, v.chassis, OPERATIONS.VEHICULE, 1,
        { num: conteneurOrigine, plomb: '', taille: '', type: '', poids: '', extra: [] }, now));
      _lierStock_(conteneurOrigine, id);            // v3.6 : décompte du stock journalier (Positionné → Dépoté)
    }
    creeV.push({ id: id, chassis: v.chassis });
  });
  camions.forEach(function (cam) {
    const id = _genererId_();
    const obj = _objCamion_(id, rapportId, now, cam, OPERATIONS.DEPOTAGE, decl, obsCFS, session);
    obj.conteneurOrigine = conteneurOrigine;
    sh.appendRow(COLS.map(c => obj[c.key] === undefined ? '' : obj[c.key]));
    cam.conteneurs.forEach(function (ct, idx) {
      contRows.push(_ligneConteneur_(rapportId, id, cam.numeroCamion, OPERATIONS.DEPOTAGE, idx + 1, ct, now));
      _lierStock_(ct.num, id);                       // v3.6 : décompte du stock journalier pour chaque conteneur d'effets divers
    });
    creeC.push({ id: id, numeroCamion: cam.numeroCamion });
  });

  _ajouterConteneurs_(contRows);
  _invaliderCacheListes_();
  _log_(session, 'Création rapport véhicule' + (estOuillage ? ' (OUILLAGE ' + ouillageNumero + ')' : ''), rapportId,
    creeV.length + ' véhicule(s)' + (creeC.length ? ' + ' + creeC.length + ' camion(s)' : '') +
    (conteneurOrigine ? ' · conteneur ' + conteneurOrigine : ''));
  return { rapportId: rapportId, vehicules: creeV, camions: creeC, ouillage: estOuillage };
}

/**
 * v3.6 — OUILLAGE : compléter la déclaration d'UN véhicule dépoté sous permis d'examiner.
 * « Véhicule ouillage créé » → « Créée ». Le régime déclaré fixe le parcours :
 *   - type 'T' (Transit) : passe par la cellule T1, SAUTE Balise + Bon de sortie → sortie PP ;
 *   - autres régimes (Conso, MAD…) : saute T1 + Balise + Bon de sortie → directement PP.
 * (La validation chef brigade reste requise avant la suite, comme pour toute opération.)
 * Payload : { id, declaration:{declarant, contactDeclarant, destinationMarchandise,
 *             bureauDeclaration, typeDeclaration, numeroDeclaration, anneeDeclaration, descriptionMarchandise?} }
 */
function _ouillageDeclaration_(session, p) {
  const id = String(p.id || '').trim();
  const decl = _normaliserDeclaration_(p.declaration || {}, OPERATIONS.VEHICULE);
  const estTransit = (decl.typeDeclaration === 'T');
  const now = new Date();
  const lock = LockService.getScriptLock(); lock.waitLock(15000);
  try {
    const c = _getCargo_(id);
    if (!c) throw new Error('Cargaison introuvable : ' + id);
    if (c.estVehicule !== 'Oui') throw new Error('Action réservée aux véhicules.');
    if (session.role !== ROLES.ADMIN && c.statut !== STATUTS.VEHICULE_OUILLAGE)
      throw new Error('Déclaration impossible : le véhicule doit être au statut « Véhicule ouillage créé » (statut « ' + c.statut + ' »).');
    const sh = _sheet_(SHEETS.CARGOS);
    const setD = (k, v) => sh.getRange(c._row, COL[k] + 1).setValue(v);
    setD('declarant', decl.declarant); setD('contactDeclarant', decl.contactDeclarant);
    setD('destinationMarchandise', decl.destinationMarchandise); setD('bureauDeclaration', decl.bureauDeclaration);
    setD('typeDeclaration', decl.typeDeclaration); setD('numeroDeclaration', decl.numeroDeclaration);
    setD('anneeDeclaration', decl.anneeDeclaration);
    if (decl.descriptionMarchandise) setD('descriptionMarchandise', decl.descriptionMarchandise);
    // Parcours selon le régime : Transit → T1 ; autres → directement PP. Balise + BS sautés dans les 2 cas.
    setD('sauteT1', estTransit ? 'Non' : 'Oui');
    setD('sauteBalise', 'Oui');
    setD('sauteBS', 'Oui');
    setD('statut', STATUTS.CREEE);
    setD('derniereMaj', now);
  } finally { lock.releaseLock(); }
  _invaliderCacheListes_();
  _log_(session, 'Ouillage — déclaration véhicule', id,
    decl.numeroDeclaration + ' (' + decl.typeDeclaration + (estTransit ? ' → T1' : ' → PP') + ')');
  return { id: id, transit: estTransit };
}

/** Valide + normalise un véhicule (châssis VIN + destination obligatoires). */
function _construireVehicule_(v) {
  v = v || {};
  const chassis = _alphaNumMaj_(v.chassis);
  if (!chassis) throw new Error('Véhicule : le N° de châssis (VIN) est obligatoire.');
  const destination = _txt_(v.destination, 40);
  if (!destination) throw new Error('Véhicule ' + chassis + ' : la Destination est obligatoire.');
  if (VEHICULE_DESTINATIONS.indexOf(destination) === -1)
    throw new Error('Véhicule ' + chassis + ' : destination invalide (' + VEHICULE_DESTINATIONS.join(', ') + ').');
  const extra = (Array.isArray(v.extra) ? v.extra : [])
    .map(e => ({ nom: _maj_(e && e.nom, 40), valeur: _maj_(e && e.valeur, 120) }))
    .filter(e => e.nom || e.valeur);
  return {
    chassis: chassis,
    marque: _maj_(v.marque, 40),
    modele: _maj_(v.modele, 40),
    couleur: _maj_(v.couleur, 30),
    destination: destination,
    extra: extra,
  };
}

/** Construit l'objet ligne d'un VÉHICULE (créé en attente de sortie, sans balise).
 *  `porteur` = cette ligne porte le conteneur dépoté compté (1 seule par rapport). */
function _objVehicule_(id, rapportId, now, v, decl, conteneurOrigine, obsCFS, session, porteur) {
  return {
    id: id, reference: id, dateCreation: now,
    numeroCamion: v.chassis,                      // le châssis sert d'identifiant (recherche/listes)
    typeOperation: OPERATIONS.VEHICULE, twins: 'No',
    // Le N° conteneur d'aperçu n'est rempli QUE sur la ligne porteuse -> compté une seule fois.
    conteneur1: porteur ? conteneurOrigine : '', plomb1: '', conteneur2: '', plomb2: '', conteneur3: '', plomb3: '',
    declarant: decl.declarant, contactDeclarant: decl.contactDeclarant,
    destinationMarchandise: decl.destinationMarchandise, bureauDeclaration: decl.bureauDeclaration,
    typeDeclaration: decl.typeDeclaration, numeroDeclaration: decl.numeroDeclaration,
    anneeDeclaration: decl.anneeDeclaration, descriptionMarchandise: decl.descriptionMarchandise,
    observationsCFS: obsCFS, agentCFS: session.nomComplet,
    statut: STATUTS.CREEE,                         // entre dans le flux : CFS → T1 → Bon de Sortie → PP (saute la Balise)
    numeroGPS: '', datePoseGPS: '', agentBalise: '', observationsBalise: '',
    baliseRequise: 'Non',
    infosValidees: '', dateSortie: '', agentPP: '', observationsPP: '',
    derniereMaj: now, rapportId: rapportId,
    conteneur4: '',
    conteneursDetails: porteur ? JSON.stringify({ conteneurs: [{ num: conteneurOrigine, plomb: '', taille: '', type: '', poids: '', extra: [] }], scellesCamion: [] }) : '',
    plomb4: '', nbConteneurs: porteur ? 1 : 0,
    chargementMixte: '', mixteDetails: '',
    // conteneurOrigine TOUJOURS renseigné (référence/affichage), même hors ligne porteuse.
    estVehicule: 'Oui', vehiculeDetails: JSON.stringify(v), conteneurOrigine: conteneurOrigine,
    // Le véhicule passe par T1 et Bon de Sortie mais saute la Balise (cahier 4.1).
    sauteT1: 'Non', sauteBalise: 'Oui', arriveeBureau: '',
  };
}

/**
 * Valide + normalise un camion ; renvoie les champs prêts pour la ligne Cargaison.
 * Modèle v1.2 : nombre de conteneurs LIBRE (1..CONTENEURS_MAX), chacun avec son
 * propre scellé — pour dépotage ET enlèvement. Les 4 premiers conteneurs sont
 * recopiés en aperçu (conteneur1..4 / plomb1..4) ; la liste complète part dans
 * `conteneurs` (-> feuille Conteneurs) et `conteneursDetails` (JSON).
 */
function _construireCamion_(cam, type, exigerScelles) {
  cam = cam || {};
  if (exigerScelles === undefined) exigerScelles = true;   // « en cours de chargement » => false
  const numeroCamion = _alphaNumMaj_(cam.numeroCamion);
  if (!numeroCamion) throw new Error('N° camion invalide (alphanumérique, majuscules).');

  const estDepotage = (type === OPERATIONS.DEPOTAGE);

  const conteneurs = (Array.isArray(cam.conteneurs) ? cam.conteneurs : [])
    .map(_normaliserConteneur_)
    .filter(c => c.num);                       // on ignore les conteneurs vides
  if (!conteneurs.length)
    throw new Error('Camion ' + numeroCamion + ' : au moins un conteneur est requis.');
  if (conteneurs.length > CONTENEURS_MAX)
    throw new Error('Camion ' + numeroCamion + ' : trop de conteneurs (max ' + CONTENEURS_MAX + ').');
  // Taille et Type sont OBLIGATOIRES pour chaque conteneur ; en enlèvement, le
  // scellé l'est aussi (en dépotage les scellés sont au niveau du camion).
  conteneurs.forEach(function (c, i) {
    if (!_tcValide_(c.num))
      throw new Error('Camion ' + numeroCamion + ' · Conteneur ' + (i + 1) + ' : N° de conteneur invalide. Format attendu : 4 lettres + 7 chiffres (ex. MSKU1234567).');
    if (!c.taille) throw new Error('Camion ' + numeroCamion + ' · Conteneur ' + (i + 1) + ' : la Taille est obligatoire.');
    if (!c.type)   throw new Error('Camion ' + numeroCamion + ' · Conteneur ' + (i + 1) + ' : le Type est obligatoire.');
    if (exigerScelles && type === OPERATIONS.ENLEVEMENT && !c.plomb)   // scellé obligatoire (fin de chargement)
      throw new Error('Camion ' + numeroCamion + ' · Conteneur ' + (i + 1) + ' : le Scellé / Plomb est obligatoire.');
  });

  // --- Scellés ---
  // DÉPOTAGE : le scellé appartient au CAMION (2 obligatoires, 3 maximum).
  //            Rangés dans plomb1/2/3 ; les conteneurs n'ont pas de scellé.
  // ENLÈVEMENT : le scellé appartient au CONTENEUR (chacun le sien) — inchangé.
  let scellesCamion = [];
  if (estDepotage) {
    scellesCamion = (Array.isArray(cam.scellesCamion) ? cam.scellesCamion : [])
      .map(s => _maj_(s, 30))
      .filter(s => s);                         // on retire les champs vides
    if (exigerScelles && scellesCamion.length < 2)
      throw new Error('Camion ' + numeroCamion + ' : au moins 2 scellés sont requis en dépotage.');
    if (scellesCamion.length > 3)
      throw new Error('Camion ' + numeroCamion + ' : 3 scellés maximum en dépotage.');
    // En dépotage, les conteneurs ne portent pas de scellé.
    conteneurs.forEach(c => { c.plomb = ''; });
  }

  const out = {
    numeroCamion: numeroCamion,
    // TWINS = enlèvement avec au moins 2 conteneurs sur le même camion (déduit).
    twins: (type === OPERATIONS.ENLEVEMENT && conteneurs.length >= 2) ? 'Yes' : 'No',
    conteneurs: conteneurs,
    nbConteneurs: conteneurs.length,
    conteneur1: '', plomb1: '', conteneur2: '', plomb2: '',
    conteneur3: '', plomb3: '', conteneur4: '', plomb4: '',
  };

  // Aperçu des numéros de conteneurs (toujours, quel que soit le type).
  for (let i = 0; i < CONTENEURS_APERCU && i < conteneurs.length; i++) {
    out['conteneur' + (i + 1)] = conteneurs[i].num;
  }

  if (estDepotage) {
    // plomb1/2/3 = scellés du CAMION ; plomb4 reste vide.
    for (let i = 0; i < scellesCamion.length && i < 3; i++) {
      out['plomb' + (i + 1)] = scellesCamion[i];
    }
    out.scellesCamion = scellesCamion;         // conservé dans le JSON de détail
  } else {
    // Enlèvement : plombN = scellé du conteneur N (comportement d'origine).
    for (let i = 0; i < CONTENEURS_APERCU && i < conteneurs.length; i++) {
      out['plomb' + (i + 1)] = conteneurs[i].plomb;
    }
  }

  out.conteneursDetails = JSON.stringify({
    conteneurs: conteneurs,
    scellesCamion: estDepotage ? scellesCamion : [],
  });
  return out;
}

/** Construit une ligne de la feuille « Conteneurs » (1 conteneur). */
function _ligneConteneur_(rapportId, cargaisonId, numeroCamion, type, ordre, ct, now) {
  const o = {
    rapportId: rapportId, cargaisonId: cargaisonId, numeroCamion: numeroCamion,
    typeOperation: type, ordre: ordre,
    conteneur: ct.num, scelle: ct.plomb, taille: ct.taille,
    typeConteneur: ct.type, poids: ct.poids,
    champsLibres: (ct.extra || []).map(e => e.nom + '=' + e.valeur).join(' ; '),
    dateCreation: now,
  };
  return CONT_COLS.map(c => o[c.key] === undefined ? '' : o[c.key]);
}

/** Ajoute en bloc des lignes à la feuille « Conteneurs » (atomique). */
function _ajouterConteneurs_(rows) {
  if (!rows || !rows.length) return;
  const sh = _sheet_(SHEETS.CONTENEURS);
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const start = sh.getLastRow() + 1;
    sh.getRange(start, 1, rows.length, CONT_COLS.length).setValues(rows);
  } finally {
    lock.releaseLock();
  }
}

/** Supprime toutes les lignes « Conteneurs » d'une cargaison (avant ré-écriture). */
function _supprimerConteneursDe_(cargaisonId) {
  const sh = _sheet_(SHEETS.CONTENEURS);
  const last = sh.getLastRow();
  if (last < 2) return;
  const ids = sh.getRange(2, CCOL.cargaisonId + 1, last - 1, 1).getValues();
  for (let i = ids.length - 1; i >= 0; i--) {            // du bas vers le haut
    if (String(ids[i][0]) === String(cargaisonId)) sh.deleteRow(i + 2);
  }
}

/** Normalise un conteneur (MAJUSCULES) + ses champs additionnels. */
function _normaliserConteneur_(c) {
  c = c || {};
  const extra = (Array.isArray(c.extra) ? c.extra : [])
    .map(e => ({ nom: _maj_(e && e.nom, 40), valeur: _maj_(e && e.valeur, 120) }))
    .filter(e => e.nom || e.valeur);
  return {
    num:    _maj_(c.num, 20).replace(/[^A-Z0-9]/g, ''),   // N° conteneur sans caractères spéciaux
    plomb:  _maj_(c.plomb, 30),
    taille: _maj_(c.taille, 10),
    type:   _maj_(c.type, 30),
    poids:  _maj_(c.poids, 20),
    extra:  extra,
  };
}

/** Valide un N° de conteneur au format ISO 6346 : 4 lettres + 7 chiffres. */
function _tcValide_(num) {
  return /^[A-Z]{4}[0-9]{7}$/.test(String(num || '').toUpperCase().replace(/[^A-Z0-9]/g, ''));
}

/**
 * Normalise les champs de déclaration (MAJUSCULES, défauts, longueurs).
 * TOUS les champs sont OBLIGATOIRES (informations générales sur la déclaration).
 */
function _normaliserDeclaration_(d, type) {
  d = d || {};
  if (d.descriptionMarchandise && String(d.descriptionMarchandise).length > 600)
    throw new Error('Description trop longue (max 600 caractères).');
  // Contact = numéro de téléphone : on ne garde que chiffres, espaces et un « + » en tête.
  const contact = _txt_(d.contactDeclarant, 30).replace(/[^\d+ ]/g, '').replace(/(?!^)\+/g, '').trim();
  const out = {
    declarant:              _maj_(d.declarant),
    contactDeclarant:       contact,
    destinationMarchandise: _maj_(d.destinationMarchandise),
    bureauDeclaration:      _maj_(d.bureauDeclaration) || DEFAUTS.BUREAU_DECLARATION,
    typeDeclaration:        _maj_(d.typeDeclaration) || DEFAUTS.TYPE_DECLARATION,
    numeroDeclaration:      _maj_(d.numeroDeclaration),
    anneeDeclaration:       _maj_(d.anneeDeclaration),
    descriptionMarchandise: _maj_(d.descriptionMarchandise, 600),
  };
  const requis = [['declarant', 'Déclarant'], ['contactDeclarant', 'Contact déclarant'],
   ['destinationMarchandise', 'Destination marchandise'], ['bureauDeclaration', 'Bureau de déclaration'],
   ['typeDeclaration', 'Type de déclaration'], ['numeroDeclaration', 'N° de déclaration'],
   ['anneeDeclaration', 'Année de déclaration']];
  // v3.6 — VÉHICULE : la désignation de la marchandise n'est PAS dans la déclaration
  // (elle est portée par les effets divers). Elle reste obligatoire pour Enlèvement/Dépotage.
  if (type !== OPERATIONS.VEHICULE) requis.push(['descriptionMarchandise', 'Description marchandise']);
  requis.forEach(function (r) { if (!out[r[0]]) throw new Error('Champ de déclaration obligatoire : ' + r[1] + '.'); });
  if (contact.replace(/\D/g, '').length < 6)
    throw new Error('Contact déclarant : numéro de téléphone invalide (au moins 6 chiffres).');
  return out;
}

/**
 * Édition d'une cargaison existante (champs CFS uniquement).
 * Droits : ADMIN toujours ; CFS uniquement tant que statut = « Créée ».
 * Ne touche JAMAIS aux champs Balise / PP / audit.
 */
function _majCargo_(session, p) {
  const id = String(p.id || '').trim();
  const type = p.typeOperation;
  if ([OPERATIONS.DEPOTAGE, OPERATIONS.ENLEVEMENT].indexOf(type) === -1)
    throw new Error("Type d'opération invalide.");

  const decl = _normaliserDeclaration_(p.declaration || {}, type);
  const obsCFS = _maj_(p.observationsCFS, 1000);
  const cam = _construireCamion_({
    numeroCamion: p.numeroCamion, conteneurs: p.conteneurs, scellesCamion: p.scellesCamion,
  }, type);

  let rapportId = '';
  const now = new Date();
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const c = _getCargo_(id);
    if (!c) throw new Error('Cargaison introuvable : ' + id);
    if (session.role !== ROLES.ADMIN && c.statut !== STATUTS.CREEE)
      throw new Error('Modification impossible : la cargaison n\'est plus au statut « Créée ».');
    rapportId = c.rapportId || '';

    const sh = _sheet_(SHEETS.CARGOS);
    const set = (key, val) => sh.getRange(c._row, COL[key] + 1).setValue(val);
    set('numeroCamion', cam.numeroCamion);
    set('typeOperation', type);
    set('twins', cam.twins);
    set('conteneur1', cam.conteneur1); set('plomb1', cam.plomb1);
    set('conteneur2', cam.conteneur2); set('plomb2', cam.plomb2);
    set('conteneur3', cam.conteneur3); set('plomb3', cam.plomb3);
    set('conteneur4', cam.conteneur4); set('plomb4', cam.plomb4);
    set('nbConteneurs', cam.nbConteneurs);
    set('conteneursDetails', cam.conteneursDetails);
    set('declarant', decl.declarant);
    set('contactDeclarant', decl.contactDeclarant);
    set('destinationMarchandise', decl.destinationMarchandise);
    set('bureauDeclaration', decl.bureauDeclaration);
    set('typeDeclaration', decl.typeDeclaration);
    set('numeroDeclaration', decl.numeroDeclaration);
    set('anneeDeclaration', decl.anneeDeclaration);
    set('descriptionMarchandise', decl.descriptionMarchandise);
    set('observationsCFS', obsCFS);
    set('derniereMaj', now);
  } finally {
    lock.releaseLock();
  }
  // Réécriture de la table normalisée des conteneurs pour cette cargaison.
  _supprimerConteneursDe_(id);
  _ajouterConteneurs_(cam.conteneurs.map((ct, idx) =>
    _ligneConteneur_(rapportId, id, cam.numeroCamion, type, idx + 1, ct, now)));
  _invaliderCacheListes_();
  _log_(session, 'Modification cargaison', id, type);
  return { id: id };
}

/* ============ Nouveau flux d'entrée (camion vide → CFS associe) ======== */

/**
 * Cherche une cargaison ACTIVE (non sortie) portant ce N° de camion.
 * Renvoie le résumé de la 1re trouvée, ou null. Sert à empêcher la création
 * d'un camion en double : un même N° ne peut réapparaître que si l'occurrence
 * précédente est « Sortie Enregistrée » (le camion est ressorti, il peut revenir).
 */
function _camionActif_(numeroCamion) {
  const q = String(numeroCamion || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!q) return null;
  const sh = _sheet_(SHEETS.CARGOS);
  const last = sh.getLastRow();
  if (last < 2) return null;
  const data = _resumeListeCachee_(sh, last);
  for (let i = 0; i < data.length; i++) {
    const norm = String(data[i].numeroCamion || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (norm && norm === q && data[i].statut !== STATUTS.SORTIE) return data[i];
  }
  return null;
}

/** Étape 0 — la Porte CFS crée le camion VIDE (juste le N° camion). Statut « Camion créé ». */
function _creerCamionVide_(session, p) {
  const numeroCamion = _alphaNumMaj_(p.numeroCamion);
  if (!numeroCamion) throw new Error('N° camion requis.');
  // v3.3 — le CFS crée le camion et choisit le TYPE d'opération (Enlèvement / Dépotage).
  const routage = String(p.routage || p.typeOperation || '').trim();
  if ([OPERATIONS.ENLEVEMENT, OPERATIONS.DEPOTAGE].indexOf(routage) === -1)
    throw new Error('Type d\'opération requis : Enlèvement ou Dépotage.');
  const typeOp = _typeDeRoutage_(routage);
  // Anti-doublon : interdit de recréer un camion tant qu'il n'est pas ressorti.
  const actif = _camionActif_(numeroCamion);
  if (actif)
    throw new Error('Le camion « ' + numeroCamion + ' » existe déjà (statut « ' + actif.statut +
      ' », ' + actif.id + '). Il ne pourra être recréé qu\'après sa sortie.');
  const id = _genererId_();
  const now = new Date();
  const obj = {};
  COLS.forEach(c => (obj[c.key] = ''));
  obj.id = id; obj.reference = id; obj.dateCreation = now; obj.numeroCamion = numeroCamion;
  obj.typeOperation = typeOp; obj.routageEntree = routage; obj.agentEntree = session.nomComplet;
  obj.twins = 'No'; obj.statut = STATUTS.CAMION;
  obj.derniereMaj = now;
  obj.rapportId = _genererRapportId_(); obj.nbConteneurs = 0;
  obj.sauteT1 = 'Non'; obj.sauteBalise = 'Non';
  _sheet_(SHEETS.CARGOS).appendRow(COLS.map(c => obj[c.key] === undefined ? '' : obj[c.key]));
  _invaliderCacheListes_();
  _log_(session, 'Entrée camion (vide)', id, numeroCamion + ' · ' + routage);
  return { id: id, numeroCamion: numeroCamion, typeOperation: typeOp, routage: routage };
}

/** Reconstruit l'objet déclaration depuis une ligne cargaison (pour l'apurement). */
function _declDeCargo_(c) {
  return { anneeDeclaration: c.anneeDeclaration, bureauDeclaration: c.bureauDeclaration,
           typeDeclaration: c.typeDeclaration, numeroDeclaration: c.numeroDeclaration, declarant: c.declarant };
}
/** Lie un conteneur du stock à une cargaison et le marque « Dépoté ». */
function _lierStock_(tc, cargaisonId) {
  const row = _stockRow_(tc);
  if (row < 0) return;
  const sh = _sheet_(SHEETS.STOCK);
  sh.getRange(row, SCOL.statut + 1).setValue(STOCK_STATUTS.DEPOTE);
  sh.getRange(row, SCOL.dateDepote + 1).setValue(new Date());
  sh.getRange(row, SCOL.cargaisonId + 1).setValue(cargaisonId);
}

/** Déclaration de référence d'un conteneur (LOT D : n° par conteneur, chargement mixte). */
function _declCont_(src, parDefaut) {
  src = src || {}; parDefaut = parDefaut || {};
  return {
    numeroDeclaration: _maj_(src.numeroDeclaration, 40) || _maj_(parDefaut.numeroDeclaration, 40),
    anneeDeclaration:  _maj_(src.anneeDeclaration, 10) || _maj_(parDefaut.anneeDeclaration, 10),
    bureauDeclaration: _maj_(src.bureauDeclaration, 20) || _maj_(parDefaut.bureauDeclaration, 20) || DEFAUTS.BUREAU_DECLARATION,
    typeDeclaration:   _maj_(src.typeDeclaration, 10) || _maj_(parDefaut.typeDeclaration, 10) || DEFAUTS.TYPE_DECLARATION,
    declarant:         _maj_(parDefaut.declarant, 120),
  };
}

/**
 * v2.7 — Saisie d'entrée par la Porte CFS (et CFS/ADMIN). Appel ITÉRATIF (un conteneur à la fois).
 *   - ENLÈVEMENT : la Porte CFS saisit TOUT (déclaration complète au 1er conteneur + scellé
 *     obligatoire) → statut « Créée ». Binôme : 2e conteneur seulement si les DEUX sont des 20'.
 *   - DÉPOTAGE   : la Porte CFS enregistre les conteneurs (sans scellé, sans déclaration complète)
 *     → statut « En cours de chargement » ; le CFS complétera la déclaration + scellés ensuite.
 *   - LOT C : seuls les conteneurs présents au STOCK sont utilisables.
 *   - LOT D : on capture le N° de déclaration PAR conteneur (chargement mixte = 2 déclarations / camion).
 * Payload : { id, typeOperation?, declaration?, observationsCFS?,
 *             conteneur:{ num,taille,type,poids,plomb, numeroDeclaration?,anneeDeclaration?,bureauDeclaration?,typeDeclaration? } }
 */
function _associerCFS_(session, p) {
  const id = String(p.id || '').trim();
  const ct = _normaliserConteneur_(p.conteneur || {});
  // v2.8 — conteneur PARTAGÉ entre deux camions (dépotage) : saisi manuellement car déjà
  // consommé du stock par l'autre camion. On bypasse alors la contrainte de stock.
  const manuel = !!(p.conteneur && p.conteneur.manuel);
  if (!_tcValide_(ct.num)) throw new Error('N° conteneur invalide. Format : 4 lettres + 7 chiffres (ex. MSKU1234567).');
  if (!ct.taille) throw new Error('Taille du conteneur obligatoire.');
  // v3.1 — le TYPE de conteneur est saisi à la main et N'EST PLUS obligatoire (le stock ne le fournit pas).

  // LOT C : seuls les conteneurs présents au STOCK (En stock / Positionné) sont utilisables,
  // SAUF en saisie manuelle (conteneur partagé déjà dépoté par un premier camion).
  const stk = manuel ? null : _stockDisponible_(ct.num);
  if (!manuel && !stk)
    throw new Error('Conteneur « ' + ct.num + ' » introuvable dans le stock (ou déjà dépoté). Importez / pointez-le d\'abord, ou cochez « saisie manuelle » s\'il est partagé.');

  const now = new Date();
  let resultStatut = '', typeOut = '', mixte = false;
  const lock = LockService.getScriptLock(); lock.waitLock(15000);
  try {
    const c = _getCargo_(id);
    if (!c) throw new Error('Cargaison introuvable : ' + id);
    if ([STATUTS.CAMION, STATUTS.CHARGEMENT, STATUTS.CREEE].indexOf(c.statut) === -1)
      throw new Error('Ajout impossible : statut « ' + c.statut + ' ».');

    const premier = (c.statut === STATUTS.CAMION);
    // v2.9 : le type d'opération est fixé par la PP à l'entrée (routage) ; fallback p.typeOperation pour compat.
    const type = c.typeOperation || (premier ? p.typeOperation : c.typeOperation);
    if ([OPERATIONS.ENLEVEMENT, OPERATIONS.DEPOTAGE].indexOf(type) === -1)
      throw new Error("Type d'opération invalide (Enlèvement ou Dépotage).");
    const estEnl = (type === OPERATIONS.ENLEVEMENT);
    if (estEnl && !ct.plomb) throw new Error('Enlèvement : le scellé (plomb) du conteneur est obligatoire.');
    else if (!estEnl) ct.plomb = '';
    // v2.9 — DÉPOTAGE : le conteneur doit appartenir au « stock CFS journalier » = pointé le matin
    // (statut Positionné). On ne peut dépoter que ce qui a été positionné. (Saisie manuelle = partagé, exempté.)
    if (!estEnl && !manuel && stk && stk.statut !== STOCK_STATUTS.POSITIONNE)
      throw new Error('Dépotage : le conteneur « ' + ct.num + ' » n\'est pas POSITIONNÉ. Pointez-le au pointage matinal (stock CFS journalier) avant de le rattacher.');

    let pd; try { pd = JSON.parse(c.conteneursDetails || '[]'); } catch (e) { pd = []; }
    let conts = Array.isArray(pd) ? pd : (pd.conteneurs || []);
    const scellesCamion = Array.isArray(pd) ? [] : (pd.scellesCamion || []);

    if (conts.some(x => _normaliserConteneur_(x).num === ct.num))
      throw new Error('Ce conteneur est déjà sur ce camion.');

    if (estEnl) {
      // Règle binôme : 40'/45' = 1 seul ; 20' = max 2 (tous 20').
      if (conts.length >= 2) throw new Error("Enlèvement : 2 conteneurs maximum (binôme 20').");
      if (conts.length === 1) {
        const tousVingt = conts.every(x => _tailleBucket_(x.taille) === 't20') && _tailleBucket_(ct.taille) === 't20';
        if (!tousVingt) throw new Error("Binôme autorisé uniquement pour DEUX conteneurs 20'. (40'/45' = 1 seul)");
      }
    } else if (conts.length >= CONTENEURS_MAX) {
      throw new Error('Trop de conteneurs (max ' + CONTENEURS_MAX + ').');
    }

    // Déclaration COMPLÈTE :
    //  - ENLÈVEMENT : saisie au 1er conteneur (la déclaration vaut pour tout le camion).
    //  - DÉPOTAGE (v3.2) : saisie POUR CHAQUE conteneur — chaque conteneur peut porter SA PROPRE
    //    déclaration (déclarant / numéro différents).
    // v3.3 — une déclaration complète est saisie pour CHAQUE conteneur (1er ET suivants).
    let declRef = null;
    if (p.declaration && String(p.declaration.declarant || '').trim()) {
      declRef = _normaliserDeclaration_(p.declaration, type);
      if (!_lookupDeclaration_({ declaration: declRef }).exists && !(Number((p.declaration || {}).nombreConteneurs) >= 1))
        throw new Error('Nouvelle déclaration : indiquez le « nombre de conteneurs » déclarés.');
    }

    // Déclaration de référence CAMION (1ʳᵉ déclaration) — pour défaut + détection mixte.
    const declRefCamion = {
      numeroDeclaration: c.numeroDeclaration, anneeDeclaration: c.anneeDeclaration,
      bureauDeclaration: c.bureauDeclaration, typeDeclaration: c.typeDeclaration, declarant: c.declarant,
    };
    if (premier && declRef) {
      declRefCamion.numeroDeclaration = declRef.numeroDeclaration; declRefCamion.anneeDeclaration = declRef.anneeDeclaration;
      declRefCamion.bureauDeclaration = declRef.bureauDeclaration; declRefCamion.typeDeclaration = declRef.typeDeclaration;
      declRefCamion.declarant = declRef.declarant;
    }
    // N° de déclaration PROPRE au conteneur (→ chargement mixte si différent de la réf. camion).
    const dc = declRef
      ? { numeroDeclaration: declRef.numeroDeclaration, anneeDeclaration: declRef.anneeDeclaration,
          bureauDeclaration: declRef.bureauDeclaration, typeDeclaration: declRef.typeDeclaration, declarant: declRef.declarant }
      : _declCont_(p.conteneur, declRefCamion);
    ct.numeroDeclaration = dc.numeroDeclaration; ct.anneeDeclaration = dc.anneeDeclaration;
    ct.bureauDeclaration = dc.bureauDeclaration; ct.typeDeclaration = dc.typeDeclaration;
    // La déclaration COMPLÈTE est mémorisée dans le détail du conteneur (déclaration propre à chaque conteneur).
    if (declRef) {
      ct.declarant = declRef.declarant; ct.contactDeclarant = declRef.contactDeclarant;
      ct.destinationMarchandise = declRef.destinationMarchandise; ct.descriptionMarchandise = declRef.descriptionMarchandise;
      ct.nombreConteneurs = (p.declaration || {}).nombreConteneurs || '';
    }
    if (declRefCamion.numeroDeclaration && dc.numeroDeclaration && _declKey_(dc) !== _declKey_(declRefCamion))
      mixte = true;

    conts.push(ct);

    const sh = _sheet_(SHEETS.CARGOS);
    if (premier) {
      sh.getRange(c._row, COL.typeOperation + 1).setValue(type);
      sh.getRange(c._row, COL.agentCFS + 1).setValue(session.nomComplet);
      // Nombre de colis : enlèvement = ici ; dépotage = saisi à l'étape « hauteur + colis » avant scellés.
      if (estEnl && p.nbColis !== undefined && p.nbColis !== '') sh.getRange(c._row, COL.nbColis + 1).setValue(_txt_(p.nbColis, 20));
      if (p.observationsCFS) sh.getRange(c._row, COL.observationsCFS + 1).setValue(_maj_(p.observationsCFS, 1000));
      if (declRef) {
        const setD = (k, v) => sh.getRange(c._row, COL[k] + 1).setValue(v);
        setD('declarant', declRef.declarant); setD('contactDeclarant', declRef.contactDeclarant);
        setD('destinationMarchandise', declRef.destinationMarchandise); setD('bureauDeclaration', declRef.bureauDeclaration);
        setD('typeDeclaration', declRef.typeDeclaration); setD('numeroDeclaration', declRef.numeroDeclaration);
        setD('anneeDeclaration', declRef.anneeDeclaration); setD('descriptionMarchandise', declRef.descriptionMarchandise);
      }
    }
    sh.getRange(c._row, COL.nbConteneurs + 1).setValue(conts.length);
    sh.getRange(c._row, COL.conteneursDetails + 1).setValue(JSON.stringify({ conteneurs: conts, scellesCamion: scellesCamion }));
    for (let i = 0; i < CONTENEURS_APERCU; i++) {
      const cc = conts[i];
      sh.getRange(c._row, COL['conteneur' + (i + 1)] + 1).setValue(cc ? cc.num : '');
      sh.getRange(c._row, COL['plomb' + (i + 1)] + 1).setValue(cc ? (cc.plomb || '') : '');
    }
    sh.getRange(c._row, COL.twins + 1).setValue((estEnl && conts.length >= 2) ? 'Yes' : 'No');
    if (mixte) sh.getRange(c._row, COL.chargementMixte + 1).setValue('Oui');
    // Enlèvement = tout saisi → « Créée » ; Dépotage = en attente (hauteur+colis+scellés CFS).
    resultStatut = estEnl ? STATUTS.CREEE : STATUTS.CHARGEMENT;
    sh.getRange(c._row, COL.statut + 1).setValue(resultStatut);
    sh.getRange(c._row, COL.derniereMaj + 1).setValue(now);
    typeOut = type;

    _ajouterConteneurs_([_ligneConteneur_(c.rapportId, id, c.numeroCamion, type, conts.length, ct, now)]);
    // Apurement PAR conteneur sur SA déclaration (déclaration complète disponible → strict ; sinon best-effort).
    if (declRef) _majApurement_(declRef, p.declaration, 1, session);
    else _majApurementSafe_(dc, 1, session);
    if (!manuel) _lierStock_(ct.num, id);   // conteneur partagé : déjà dépoté par le 1er camion, on ne reconsomme pas
  } finally { lock.releaseLock(); }
  _invaliderCacheListes_();
  _log_(session, 'CFS — ajout conteneur', id, ct.num + ' (' + typeOut + (manuel ? ', partagé/manuel' : '') + (mixte ? ', mixte' : '') + ')');
  return { id: id, statut: resultStatut, conteneur: ct.num, mixte: mixte, manuel: manuel };
}

/**
 * v3.2 — DÉPOTAGE : finalisation par le CFS. La déclaration a déjà été saisie PAR CONTENEUR
 * à l'ajout ; ici on saisit la HAUTEUR du chargement + le NOMBRE DE COLIS, puis on pose les
 * scellés camion (2-3) → « Créée » (attente validation chef brigade).
 * RÈGLE HORS GABARIT (auto) : hauteur > 4,5 m ⇒ horsGabarit = 'Oui' (signalé au chef brigade).
 * Payload : { id, hauteurChargement, nbColis, scellesCamion:[...], observationsCFS? }
 */
function _completerDeclaration_(session, p) {
  const id = String(p.id || '').trim();
  const now = new Date();
  let horsGab = false;
  const lock = LockService.getScriptLock(); lock.waitLock(15000);
  try {
    const c = _getCargo_(id);
    if (!c) throw new Error('Cargaison introuvable : ' + id);
    if (c.typeOperation !== OPERATIONS.DEPOTAGE) throw new Error('Action réservée au dépotage.');
    if (session.role !== ROLES.ADMIN && c.statut !== STATUTS.CHARGEMENT)
      throw new Error('Finalisation impossible : le camion doit être « En cours de chargement » (statut « ' + c.statut + ' »).');
    const sh = _sheet_(SHEETS.CARGOS);

    // Scellés camion (2-3).
    const sc = (Array.isArray(p.scellesCamion) ? p.scellesCamion : [])
      .map(function (s) { return _maj_(s, 30); }).filter(function (s) { return s; });
    if (sc.length < 2) throw new Error('Au moins 2 scellés camion sont requis (dépotage).');
    if (sc.length > 3) throw new Error('3 scellés camion maximum.');
    let pd; try { pd = JSON.parse(c.conteneursDetails || '[]'); } catch (e) { pd = []; }
    const conts = Array.isArray(pd) ? pd : (pd.conteneurs || []);
    for (let i = 0; i < 3; i++) sh.getRange(c._row, COL['plomb' + (i + 1)] + 1).setValue(sc[i] || '');
    sh.getRange(c._row, COL.conteneursDetails + 1).setValue(JSON.stringify({ conteneurs: conts, scellesCamion: sc }));

    // Hauteur du chargement + nombre de colis (saisis AVANT les scellés). Hors gabarit AUTO.
    const hauteurStr = _txt_(p.hauteurChargement, 30);
    const hauteurNum = parseFloat(String(p.hauteurChargement || '').replace(',', '.').replace(/[^0-9.]/g, ''));
    horsGab = (!isNaN(hauteurNum) && hauteurNum > HAUTEUR_HORS_GABARIT);
    sh.getRange(c._row, COL.hauteurChargement + 1).setValue(hauteurStr);
    sh.getRange(c._row, COL.horsGabarit + 1).setValue(horsGab ? 'Oui' : '');
    if (p.nbColis !== undefined && p.nbColis !== '') sh.getRange(c._row, COL.nbColis + 1).setValue(_txt_(p.nbColis, 20));
    if (p.observationsCFS) sh.getRange(c._row, COL.observationsCFS + 1).setValue(_maj_(p.observationsCFS, 1000));
    sh.getRange(c._row, COL.agentCFS + 1).setValue(session.nomComplet);
    sh.getRange(c._row, COL.statut + 1).setValue(STATUTS.CREEE);
    sh.getRange(c._row, COL.derniereMaj + 1).setValue(now);
  } finally { lock.releaseLock(); }
  _invaliderCacheListes_();
  _log_(session, 'CFS — finalisation dépotage' + (horsGab ? ' (HORS GABARIT)' : ''), id, '');
  return { id: id, statut: STATUTS.CREEE, horsGabarit: horsGab };
}

/**
 * Fin de chargement — pose des scellés sur une cargaison « En cours de chargement ».
 * Dépotage : `scellesCamion` (2-3). Enlèvement / Conso : `plombs` (1 par conteneur).
 * Fait passer « En cours de chargement » → « Créée » (fin de chargement).
 */
function _poserScelles_(session, p) {
  const id = String(p.id || '').trim();
  const now = new Date();
  const lock = LockService.getScriptLock(); lock.waitLock(15000);
  try {
    const c = _getCargo_(id);
    if (!c) throw new Error('Cargaison introuvable : ' + id);
    if (session.role !== ROLES.ADMIN && c.statut !== STATUTS.CHARGEMENT)
      throw new Error("Pose de scellés impossible : la cargaison n'est pas « En cours de chargement ».");
    const type = c.typeOperation;
    const sh = _sheet_(SHEETS.CARGOS);
    let pd; try { pd = JSON.parse(c.conteneursDetails || '[]'); } catch (e) { pd = []; }
    let conts = Array.isArray(pd) ? pd : (pd.conteneurs || []);
    let scellesCamion = Array.isArray(pd) ? [] : (pd.scellesCamion || []);
    if (type === OPERATIONS.DEPOTAGE) {
      const sc = (Array.isArray(p.scellesCamion) ? p.scellesCamion : []).map(function (s) { return _maj_(s, 30); }).filter(function (s) { return s; });
      if (sc.length < 2) throw new Error('Au moins 2 scellés requis (dépotage).');
      if (sc.length > 3) throw new Error('3 scellés maximum.');
      scellesCamion = sc;
      for (let i = 0; i < 3; i++) sh.getRange(c._row, COL['plomb' + (i + 1)] + 1).setValue(sc[i] || '');
    } else {
      const pls = (Array.isArray(p.plombs) ? p.plombs : []).map(function (s) { return _maj_(s, 30); });
      conts.forEach(function (ct, i) { ct.plomb = pls[i] || ct.plomb || ''; });
      if (conts.some(function (ct) { return !ct.plomb; })) throw new Error('Chaque conteneur doit avoir un scellé.');
      for (let i = 0; i < CONTENEURS_APERCU; i++) sh.getRange(c._row, COL['plomb' + (i + 1)] + 1).setValue(conts[i] ? conts[i].plomb : '');
    }
    sh.getRange(c._row, COL.conteneursDetails + 1).setValue(JSON.stringify({ conteneurs: conts, scellesCamion: scellesCamion }));
    sh.getRange(c._row, COL.statut + 1).setValue(STATUTS.CREEE);
    sh.getRange(c._row, COL.derniereMaj + 1).setValue(now);
  } finally { lock.releaseLock(); }
  _invaliderCacheListes_();
  _log_(session, 'Pose des scellés (fin de chargement)', id, '');
  return { id: id };
}

/**
 * Sous-module Visite (cahier 3.2) — modifie le scellé d'un conteneur après une
 * inspection douanière. Met à jour conteneursDetails + l'aperçu plombN.
 */
function _visiteScelle_(session, p) {
  const id = String(p.id || '').trim();
  const norm = function (v) { return String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); };
  const conteneur = norm(p.conteneur);
  const nouveau = _maj_(p.nouveauScelle, 30);
  if (!conteneur || !nouveau) throw new Error('Conteneur et nouveau scellé requis.');
  const now = new Date();
  const lock = LockService.getScriptLock(); lock.waitLock(15000);
  try {
    const c = _getCargo_(id);
    if (!c) throw new Error('Cargaison introuvable : ' + id);
    const sh = _sheet_(SHEETS.CARGOS);
    let pd; try { pd = JSON.parse(c.conteneursDetails || '[]'); } catch (e) { pd = []; }
    let conts = Array.isArray(pd) ? pd : (pd.conteneurs || []);
    let sc = Array.isArray(pd) ? [] : (pd.scellesCamion || []);
    let found = false;
    conts.forEach(function (ct, i) {
      if (norm(ct.num) === conteneur) {
        ct.plomb = nouveau; found = true;
        if (i < CONTENEURS_APERCU) sh.getRange(c._row, COL['plomb' + (i + 1)] + 1).setValue(nouveau);
      }
    });
    if (!found) throw new Error('Conteneur introuvable dans la cargaison.');
    sh.getRange(c._row, COL.conteneursDetails + 1).setValue(JSON.stringify({ conteneurs: conts, scellesCamion: sc }));
    sh.getRange(c._row, COL.derniereMaj + 1).setValue(now);
  } finally { lock.releaseLock(); }
  _invaliderCacheListes_();
  _log_(session, 'Visite — modification scellé', id, conteneur + ' → ' + nouveau);
  return { id: id };
}

/**
 * Cellule T1 — saisie du/des numéro(s) de document de transit + bureau de
 * destination. Enlèvement : règle 1:1 (un T1 par conteneur, ≥ nbConteneurs).
 * Dépotage : 1:N (au moins un T1). Fait passer « Créée » → « T1 saisi ».
 * ADMIN peut (ré)enregistrer le T1 à tout statut sans faire reculer la cargaison.
 */
/* =================== Validation chef brigade (v3.0) ===================== */

/** Empreinte courte (SHA-256, 16 hex) faisant office de signature numérique. */
function _signature_(base) {
  const raw = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(base), Utilities.Charset.UTF_8);
  let hex = '';
  for (let i = 0; i < raw.length; i++) { const b = (raw[i] + 256) % 256; hex += ('0' + b.toString(16)).slice(-2); }
  return hex.slice(0, 16).toUpperCase();
}

/**
 * v3.0 — Validation (signature) du CHEF BRIGADE. Maillon obligatoire APRÈS le CFS et
 * AVANT le T1/Balise/Bon de sortie (le moteur d'étapes bloque ces cellules tant que
 * dateValidation n'est pas posée). Le chef peut renseigner ici « Hors gabarit » (confidentiel).
 * Payload : { id, horsGabarit?, hauteurChargement?, observations? }
 */
function _validerChefBrigade_(session, p) {
  const id = String(p.id || '').trim();
  const now = new Date();
  const lock = LockService.getScriptLock(); lock.waitLock(15000);
  try {
    const c = _getCargo_(id);
    if (!c) throw new Error('Cargaison introuvable : ' + id);
    if (c.statut === STATUTS.CAMION || c.statut === STATUTS.CHARGEMENT || c.statut === STATUTS.VEHICULE_OUILLAGE)
      throw new Error('Validation impossible : le CFS doit d\'abord terminer (statut « ' + c.statut + ' »).');
    if (_aFait_(c.dateValidation) && session.role !== ROLES.ADMIN)
      throw new Error('Cargaison déjà validée le ' + _fmtDate_(c.dateValidation, Session.getScriptTimeZone()) + '.');
    const sh = _sheet_(SHEETS.CARGOS);
    const sig = _signature_(id + '|' + session.username + '|' + now.toISOString());
    sh.getRange(c._row, COL.dateValidation + 1).setValue(now);
    sh.getRange(c._row, COL.agentValidation + 1).setValue(session.nomComplet);
    sh.getRange(c._row, COL.signatureValidation + 1).setValue(sig);
    // v3.2 — le « hors gabarit » est désormais AUTOMATIQUE (hauteur CFS > 4,5 m), pas saisi par le chef.
    sh.getRange(c._row, COL.derniereMaj + 1).setValue(now);
  } finally { lock.releaseLock(); }
  _invaliderCacheListes_();
  _log_(session, 'Validation chef brigade', id, '');
  return { id: id };
}

/**
 * v3.0 — Saisie / mise à jour du champ CONFIDENTIEL « Hors gabarit » (+ hauteur).
 * Réservé aux chefs (brigade/adjoint/visite/division) + admin. Indépendant de la validation.
 */
function _majHorsGabarit_(session, p) {
  const id = String(p.id || '').trim();
  const hg = (p.horsGabarit === true || String(p.horsGabarit).toLowerCase() === 'oui');
  const lock = LockService.getScriptLock(); lock.waitLock(15000);
  try {
    const c = _getCargo_(id);
    if (!c) throw new Error('Cargaison introuvable : ' + id);
    const sh = _sheet_(SHEETS.CARGOS);
    sh.getRange(c._row, COL.horsGabarit + 1).setValue(hg ? 'Oui' : '');
    sh.getRange(c._row, COL.hauteurChargement + 1).setValue(hg ? _txt_(p.hauteurChargement, 30) : '');
    sh.getRange(c._row, COL.derniereMaj + 1).setValue(new Date());
  } finally { lock.releaseLock(); }
  _invaliderCacheListes_();
  _log_(session, 'Hors gabarit', id, hg ? ('Oui · ' + _txt_(p.hauteurChargement, 30)) : 'Non');
  return { id: id };
}

/** v3.0 — Retire les champs CONFIDENTIELS (Hors gabarit) si la session n'est pas un chef habilité. */
function _filtrerConfidentiel_(obj, session) {
  if (!obj || !session) return obj;
  if (VOIENT_HORSGABARIT.indexOf(session.role) === -1) {   // v3.2 : CFS + chefs voient ; T1/Balise/BS/PP non
    delete obj.horsGabarit;
    delete obj.hauteurChargement;
  }
  return obj;
}

function _saisirT1_(session, p) {
  const id = String(p.id || '').trim();
  const bureau = _maj_(p.bureauDestination, 60);
  if (!bureau) throw new Error('Bureau de destination obligatoire.');
  // v2.8 — chaque T1 peut être LIÉ à un conteneur (enlèvement). On accepte donc soit une
  // liste de chaînes (dépotage : 1:N), soit une liste d'objets {conteneur, numero} (enlèvement : 1:1).
  const items = (Array.isArray(p.t1Numeros) ? p.t1Numeros : []).map(function (o) {
    if (o && typeof o === 'object') return { conteneur: _maj_(o.conteneur, 20), numero: _maj_(o.numero, 40) };
    return { conteneur: '', numero: _maj_(o, 40) };
  }).filter(function (o) { return o.numero; });
  if (!items.length) throw new Error('Au moins un numéro de document T1 est requis.');
  const numeros = items.map(function (o) { return o.numero; });
  if (new Set(numeros).size !== numeros.length) throw new Error('Les numéros T1 doivent être distincts (1 par conteneur).');

  const now = new Date();
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const c = _getCargo_(id);
    if (!c) throw new Error('Cargaison introuvable : ' + id);
    if (session.role !== ROLES.ADMIN && _prochaineEtape_(c) !== 'T1')
      throw new Error('Cellule T1 impossible : étape non attendue (statut « ' + c.statut + ' »).');
    if (c.typeOperation === OPERATIONS.ENLEVEMENT) {
      const nb = Number(c.nbConteneurs || 0) || 1;       // 1 T1 par conteneur
      if (items.length < nb) throw new Error('Enlèvement : un T1 par conteneur (≥ ' + nb + ' attendus).');
      // Conteneurs réellement présents sur la cargaison (pour valider la liaison).
      let pd; try { pd = JSON.parse(c.conteneursDetails || '[]'); } catch (e) { pd = []; }
      const conts = Array.isArray(pd) ? pd : (pd.conteneurs || []);
      const dispo = conts.map(function (o) { return String(o.num || o.conteneur || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); }).filter(String);
      const lies = [];
      items.forEach(function (o) {
        if (!o.conteneur) throw new Error('Enlèvement : associez chaque T1 à un conteneur.');
        if (dispo.length && dispo.indexOf(o.conteneur) < 0) throw new Error('Conteneur « ' + o.conteneur + ' » absent de cette cargaison.');
        if (lies.indexOf(o.conteneur) >= 0) throw new Error('Chaque conteneur ne peut recevoir qu\'un seul T1.');
        lies.push(o.conteneur);
      });
    }
    const avancer = (_prochaineEtape_(c) === 'T1');
    const sh = _sheet_(SHEETS.CARGOS);
    sh.getRange(c._row, COL.bureauDestination + 1).setValue(bureau);
    sh.getRange(c._row, COL.t1Numeros + 1).setValue(JSON.stringify(items));
    sh.getRange(c._row, COL.dateT1 + 1).setValue(now);
    sh.getRange(c._row, COL.agentT1 + 1).setValue(session.nomComplet);
    sh.getRange(c._row, COL.observationsT1 + 1).setValue(_txt_(p.observations, 1000));
    if (avancer) sh.getRange(c._row, COL.statut + 1).setValue(STATUTS.T1);
    sh.getRange(c._row, COL.derniereMaj + 1).setValue(now);
  } finally {
    lock.releaseLock();
  }
  _invaliderCacheListes_();
  _log_(session, 'Saisie T1', id, numeros.join(', ') + ' · ' + bureau);
  return { id: id };
}

/**
 * Cellule Balise — par l'agent Balise. Le client envoie :
 *   - `t1Correct` (case « Numéro T1 correct » — obligatoire avant validation) ;
 *   - `baliseRequise` : 'Oui' (N° balise requis) ou 'Non' = DISPENSE
 *     (numeroDispense requis ; la cargaison saute la pose réelle).
 * Fait passer « T1 saisi » → « GPS Installé » (balisé ou dispensé).
 */
function _poserGPS_(session, p) {
  const id = String(p.id || '').trim();
  const requise = !(p.baliseRequise === false || String(p.baliseRequise).toLowerCase() === 'non');
  const t1Correct = (p.t1Correct === true || String(p.t1Correct).toLowerCase() === 'oui');
  const numeroGPS = _txt_(p.numeroGPS);
  const numeroDispense = _maj_(p.numeroDispense, 60);
  if (!t1Correct) throw new Error('Cochez « Numéro T1 correct » avant de valider la balise.');
  if (requise && !numeroGPS) throw new Error('Numéro de balise requis.');
  if (!requise && !numeroDispense) throw new Error("Numéro d'autorisation de dispense requis.");

  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const c = _getCargo_(id);
    if (!c) throw new Error('Cargaison introuvable : ' + id);
    if (c.estVehicule === 'Oui') throw new Error('Les véhicules ne passent pas par la cellule Balise.');
    if (session.role !== ROLES.ADMIN && _etapesEnAttente_(c).indexOf('BALISE') < 0)
      throw new Error('Étape Balise impossible : faites d\'abord le T1 (statut « ' + c.statut + ' »).');
    const avancer = (_etapesEnAttente_(c).indexOf('BALISE') >= 0);

    const now = new Date();
    const sh = _sheet_(SHEETS.CARGOS);
    sh.getRange(c._row, COL.numeroGPS + 1).setValue(requise ? numeroGPS : '');
    sh.getRange(c._row, COL.datePoseGPS + 1).setValue(now);
    sh.getRange(c._row, COL.agentBalise + 1).setValue(session.nomComplet);
    sh.getRange(c._row, COL.observationsBalise + 1).setValue(_txt_(p.observations, 1000));
    sh.getRange(c._row, COL.baliseRequise + 1).setValue(requise ? 'Oui' : 'Non');
    sh.getRange(c._row, COL.t1Correct + 1).setValue('Oui');
    sh.getRange(c._row, COL.numeroDispense + 1).setValue(requise ? '' : numeroDispense);
    if (avancer) sh.getRange(c._row, COL.statut + 1).setValue(STATUTS.GPS);
    sh.getRange(c._row, COL.derniereMaj + 1).setValue(now);
  } finally {
    lock.releaseLock();
  }
  _invaliderCacheListes_();
  if (requise) _log_(session, 'Pose balise', id, 'Balise ' + numeroGPS);
  else         _log_(session, 'Dispense de balise', id, 'Dispense ' + numeroDispense);
  return { id: id, baliseRequise: requise ? 'Oui' : 'Non' };
}

/* ------------- Doublons / correction camion / chargement mixte --------- */

/**
 * Détection de doublons (AVERTISSEMENT, jamais bloquant) à la saisie.
 * Payload : { numeroCamion?, conteneurs?:[...], excludeId? }
 * Renvoie { camion:[matches], conteneurs:{ 'NUM':[matches], ... } } où chaque
 * match = { id, statut, dateCreation, numeroCamion, conteneur?, actif }.
 * `actif` = true tant que la cargaison n'est pas sortie : un doublon ACTIF est
 * une vraie anomalie (un même camion/conteneur ne peut pas être en transit deux fois).
 */
function _verifierDoublons_(p) {
  p = p || {};
  const norm = function (v) { return String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); };
  const exclude = String(p.excludeId || '').trim();
  const numCam = norm(p.numeroCamion);
  const conts = (Array.isArray(p.conteneurs) ? p.conteneurs : []).map(norm).filter(function (x) { return x; });

  const res = { camion: [], conteneurs: {} };
  conts.forEach(function (k) { res.conteneurs[k] = []; });

  const sh = _sheet_(SHEETS.CARGOS);
  const last = sh.getLastRow();
  if (last < 2) return res;

  // Index statut/date par cargaison via le résumé caché (rapide).
  const resume = _resumeListeCachee_(sh, last);
  const infoById = {};
  resume.forEach(function (r) {
    infoById[r.id] = {
      id: r.id, statut: r.statut, dateCreation: r.dateCreation,
      numeroCamion: r.numeroCamion, actif: r.statut !== STATUTS.SORTIE,
    };
    if (r.id === exclude || !numCam) return;
    if (norm(r.numeroCamion) === numCam) res.camion.push(infoById[r.id]);
  });

  // Conteneurs : balayage de la feuille « Conteneurs » (liste COMPLÈTE, pas l'aperçu).
  if (conts.length) {
    const csh = _sheet_(SHEETS.CONTENEURS);
    const clast = csh.getLastRow();
    if (clast >= 2) {
      const cv = csh.getRange(2, 1, clast - 1, CONT_COLS.length).getValues();
      cv.forEach(function (row) {
        const cid = String(row[CCOL.cargaisonId]);
        if (cid === exclude) return;
        const cn = norm(row[CCOL.conteneur]);
        if (!cn || res.conteneurs[cn] === undefined) return;
        const info = infoById[cid] ||
          { id: cid, statut: '', dateCreation: '', numeroCamion: row[CCOL.numeroCamion], actif: false };
        res.conteneurs[cn].push({
          id: info.id, statut: info.statut, dateCreation: info.dateCreation,
          numeroCamion: info.numeroCamion, conteneur: row[CCOL.conteneur], actif: info.actif,
        });
      });
    }
  }

  // Tri du plus récent au plus ancien.
  res.camion.sort(function (a, b) { return _ts_(b.dateCreation) - _ts_(a.dateCreation); });
  Object.keys(res.conteneurs).forEach(function (k) {
    res.conteneurs[k].sort(function (a, b) { return _ts_(b.dateCreation) - _ts_(a.dateCreation); });
  });
  return res;
}

/**
 * Correction CIBLÉE du N° de camion — autorisée à TOUS les rôles, à TOUT statut
 * (y compris après la pose de balise / la sortie). Ne touche QUE le N° camion ;
 * répercute la correction sur la feuille « Conteneurs » ; journalisée.
 */
function _corrigerCamion_(session, p) {
  const id = String(p.id || '').trim();
  const nouveau = _alphaNumMaj_(p.numeroCamion);
  if (!nouveau) throw new Error('N° camion invalide (alphanumérique, majuscules).');

  let ancien = '';
  const now = new Date();
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const c = _getCargo_(id);
    if (!c) throw new Error('Cargaison introuvable : ' + id);
    ancien = c.numeroCamion || '';
    if (nouveau === ancien) return { id: id, numeroCamion: nouveau, inchange: true };
    const sh = _sheet_(SHEETS.CARGOS);
    sh.getRange(c._row, COL.numeroCamion + 1).setValue(nouveau);
    sh.getRange(c._row, COL.derniereMaj + 1).setValue(now);
  } finally {
    lock.releaseLock();
  }
  _renommerCamionConteneurs_(id, nouveau);
  _invaliderCacheListes_();
  _log_(session, 'Correction N° camion', id, ancien + ' → ' + nouveau);
  return { id: id, numeroCamion: nouveau, ancien: ancien };
}

/** Répercute un nouveau N° camion sur toutes les lignes « Conteneurs » d'une cargaison. */
function _renommerCamionConteneurs_(cargaisonId, nouveau) {
  const sh = _sheet_(SHEETS.CONTENEURS);
  const last = sh.getLastRow();
  if (last < 2) return;
  const ids = sh.getRange(2, CCOL.cargaisonId + 1, last - 1, 1).getValues();
  for (let i = 0; i < ids.length; i++) {
    if (String(ids[i][0]) === String(cargaisonId)) sh.getRange(i + 2, CCOL.numeroCamion + 1).setValue(nouveau);
  }
}

/**
 * Chargement mixte — COMPLÈTE une cargaison existante (camion/conteneur portant
 * les marchandises de plusieurs déclarations) plutôt que de créer un doublon.
 * Payload : { id, note?, infosSupplementaires?, conteneurs?:[...] }
 *   - note / infosSupplementaires : texte libre (ex. autre N° de déclaration) ;
 *   - conteneurs : conteneurs additionnels (même format qu'à la création).
 * Marque `chargementMixte`='Oui' et empile un historique horodaté dans `mixteDetails`.
 */
function _completerMixte_(session, p) {
  const id = String(p.id || '').trim();
  const note = _maj_(p.note, 1000);
  const infosSupp = _maj_(p.infosSupplementaires, 2000);
  const ajout = (Array.isArray(p.conteneurs) ? p.conteneurs : [])
    .map(_normaliserConteneur_).filter(function (c) { return c.num; });
  if (!note && !infosSupp && !ajout.length)
    throw new Error('Aucune information à ajouter au chargement mixte.');

  const now = new Date();
  let rapportId = '', type = '', numeroCamion = '', total = 0;
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const c = _getCargo_(id);
    if (!c) throw new Error('Cargaison introuvable : ' + id);
    rapportId = c.rapportId || ''; type = c.typeOperation; numeroCamion = c.numeroCamion;
    const estDepotage = (type === OPERATIONS.DEPOTAGE);
    if (ajout.length) {
      // En enlèvement, le scellé du conteneur est obligatoire ; en dépotage il n'y en a pas.
      ajout.forEach(function (ct, i) {
        if (!_tcValide_(ct.num)) throw new Error('Conteneur ajouté ' + (i + 1) + ' : N° invalide. Format : 4 lettres + 7 chiffres (ex. MSKU1234567).');
        if (!ct.taille) throw new Error('Conteneur ajouté ' + (i + 1) + ' : la Taille est obligatoire.');
        if (!ct.type)   throw new Error('Conteneur ajouté ' + (i + 1) + ' : le Type est obligatoire.');
        if (estDepotage) ct.plomb = '';
        else if (!ct.plomb) throw new Error('Conteneur ajouté ' + (i + 1) + ' : le Scellé / Plomb est obligatoire.');
      });
    }
    const sh = _sheet_(SHEETS.CARGOS);

    let hist = [];
    try { const h = JSON.parse(c.mixteDetails || '[]'); if (Array.isArray(h)) hist = h; } catch (e) {}
    hist.push({
      date: now.toISOString(), agent: session.nomComplet, note: note, infos: infosSupp,
      conteneursAjoutes: ajout.map(function (x) { return x.num; }),
    });
    sh.getRange(c._row, COL.chargementMixte + 1).setValue('Oui');
    sh.getRange(c._row, COL.mixteDetails + 1).setValue(JSON.stringify(hist));

    if (ajout.length) {
      // Fusion dans la liste complète (conteneursDetails) + aperçu + feuille Conteneurs.
      let pd; try { pd = JSON.parse(c.conteneursDetails || '[]'); } catch (e) { pd = []; }
      let conts, scellesCamion = [];
      if (Array.isArray(pd)) { conts = pd; } else { conts = (pd && pd.conteneurs) || []; scellesCamion = (pd && pd.scellesCamion) || []; }
      // Repli sur l'aperçu si le JSON était vide (anciennes cargaisons).
      if (!conts.length) {
        [[c.conteneur1, c.plomb1], [c.conteneur2, c.plomb2], [c.conteneur3, c.plomb3], [c.conteneur4, c.plomb4]]
          .forEach(function (r) { if (r[0]) conts.push(estDepotage ? { num: r[0] } : { num: r[0], plomb: r[1] || '' }); });
        if (estDepotage && !scellesCamion.length)
          scellesCamion = [c.plomb1, c.plomb2, c.plomb3].filter(function (s) { return s; });
      }
      const base = conts.length;
      conts = conts.concat(ajout);
      total = conts.length;
      sh.getRange(c._row, COL.nbConteneurs + 1).setValue(total);
      sh.getRange(c._row, COL.conteneursDetails + 1).setValue(JSON.stringify({ conteneurs: conts, scellesCamion: scellesCamion }));
      // Rafraîchit l'aperçu (4 premiers conteneurs ; plombN seulement en enlèvement).
      for (let i = 0; i < CONTENEURS_APERCU; i++) {
        const ct = conts[i];
        sh.getRange(c._row, COL['conteneur' + (i + 1)] + 1).setValue(ct ? ct.num : '');
        if (!estDepotage) sh.getRange(c._row, COL['plomb' + (i + 1)] + 1).setValue(ct ? (ct.plomb || '') : '');
      }
      _ajouterConteneurs_(ajout.map(function (ct, idx) {
        return _ligneConteneur_(rapportId, id, numeroCamion, type, base + idx + 1, ct, now);
      }));
    }
    sh.getRange(c._row, COL.derniereMaj + 1).setValue(now);
  } finally {
    lock.releaseLock();
  }
  _invaliderCacheListes_();
  _log_(session, 'Chargement mixte', id,
    (ajout.length ? ajout.length + ' conteneur(s) ajouté(s). ' : '') + (note || infosSupp || ''));
  return { id: id, total: total };
}
/** Remplacement d'un GPS défectueux par l'agent Balise.
 *  Autorisé UNIQUEMENT au statut « GPS Installé » (posé mais pas encore sorti).
 *  Ne change PAS le statut, ne touche ni au CFS ni à la PP.
 *  Met à jour le numéro, la date de pose et l'agent ; observations facultatives. */
function _modifierGPS_(session, p) {
  const id = String(p.id || '').trim();
  const numeroGPS = _txt_(p.numeroGPS);
  if (!numeroGPS) throw new Error('Numéro de GPS requis.');

  let ancien = '';
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const c = _getCargo_(id);
    if (!c) throw new Error('Cargaison introuvable : ' + id);
    if (c.statut !== STATUTS.GPS)
      throw new Error('Remplacement impossible : la cargaison doit être au statut « ' + STATUTS.GPS + ' » (statut actuel « ' + c.statut + ' »).');
    ancien = c.numeroGPS || '';

    const now = new Date();
    const sh = _sheet_(SHEETS.CARGOS);
    sh.getRange(c._row, COL.numeroGPS + 1).setValue(numeroGPS);
    sh.getRange(c._row, COL.datePoseGPS + 1).setValue(now);
    sh.getRange(c._row, COL.agentBalise + 1).setValue(session.nomComplet);
    if (p.observations) sh.getRange(c._row, COL.observationsBalise + 1).setValue(_txt_(p.observations, 1000));
    sh.getRange(c._row, COL.derniereMaj + 1).setValue(now);
  } finally {
    lock.releaseLock();
  }
  _invaliderCacheListes_();
  _log_(session, 'Remplacement GPS', id, 'Ancien ' + ancien + ' → nouveau ' + numeroGPS);
  return { id: id };
}

/**
 * Cellule Bon de Sortie — émission du n° de bon de sortie. Enlèvement : 1:1
 * (conteneur = T1 = bon). Dépotage : 1 bon par déclaration. N'exige PAS de
 * vérification de balise (cahier 3.5). Fait passer « GPS Installé » → « Bon de sortie émis ».
 */
function _emettreBonSortie_(session, p) {
  const id = String(p.id || '').trim();
  // v2.8 — en ENLÈVEMENT, le bon de sortie peut être LIÉ au conteneur / T1 : on accepte
  // soit une chaîne (dépotage : 1 bon par déclaration), soit une liste d'objets {conteneur,t1,numero}.
  let stored = '', numeros = [];
  if (Array.isArray(p.bonSortieNumero)) {
    const items = p.bonSortieNumero.map(function (o) {
      return (o && typeof o === 'object')
        ? { conteneur: _maj_(o.conteneur, 20), t1: _maj_(o.t1, 40), numero: _maj_(o.numero, 60) }
        : { conteneur: '', t1: '', numero: _maj_(o, 60) };
    }).filter(function (o) { return o.numero; });
    if (!items.length) throw new Error('Numéro de bon de sortie requis.');
    numeros = items.map(function (o) { return o.numero; });
    stored = JSON.stringify(items);
  } else {
    stored = _maj_(p.bonSortieNumero, 60);
    if (!stored) throw new Error('Numéro de bon de sortie requis.');
    numeros = [stored];
  }

  const now = new Date();
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const c = _getCargo_(id);
    if (!c) throw new Error('Cargaison introuvable : ' + id);
    if (session.role !== ROLES.ADMIN && _etapesEnAttente_(c).indexOf('BS') < 0)
      throw new Error('Bon de sortie impossible : faites d\'abord le T1 (statut « ' + c.statut + ' »).');
    const avancer = (_etapesEnAttente_(c).indexOf('BS') >= 0);
    const sh = _sheet_(SHEETS.CARGOS);
    sh.getRange(c._row, COL.bonSortieNumero + 1).setValue(stored);
    sh.getRange(c._row, COL.dateBonSortie + 1).setValue(now);
    sh.getRange(c._row, COL.agentBonSortie + 1).setValue(session.nomComplet);
    sh.getRange(c._row, COL.observationsBonSortie + 1).setValue(_txt_(p.observations, 1000));
    if (avancer) sh.getRange(c._row, COL.statut + 1).setValue(STATUTS.BS);
    sh.getRange(c._row, COL.derniereMaj + 1).setValue(now);
  } finally {
    lock.releaseLock();
  }
  _invaliderCacheListes_();
  _log_(session, 'Bon de sortie', id, numeros.join(', '));
  return { id: id };
}

/**
 * Porte de Sortie (PP) — contrôle final par CHECKLIST (cahier 3.6) :
 *   CFS conforme, T1 valide(s), Balise vérifiée, Bon de sortie vérifié.
 * Toutes les cases sont obligatoires. Fait passer « Bon de sortie émis » → « Sortie ».
 * Cas VÉHICULE : pas de T1/Balise/Bon de sortie -> sortie directe depuis « GPS Installé »
 * avec une simple validation « infos validées ».
 */
function _enregistrerSortie_(session, p) {
  const id = String(p.id || '').trim();

  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const c = _getCargo_(id);
    if (!c) throw new Error('Cargaison introuvable : ' + id);
    const estVeh = (c.estVehicule === 'Oui');
    if (session.role !== ROLES.ADMIN && _etapesEnAttente_(c).indexOf('PP') < 0)
      throw new Error('Sortie impossible : la Balise ET le Bon de Sortie doivent être faits (statut « ' + c.statut + ' »).');

    let checklist = {};
    if (estVeh) {
      if (p.infosValidees !== true) throw new Error('Veuillez cocher « Informations validées ».');
    } else {
      checklist = {
        cfs: p.ckCfs === true, t1: p.ckT1 === true,
        balise: p.ckBalise === true, bs: p.ckBs === true,
      };
      if (!(checklist.cfs && checklist.t1 && checklist.balise && checklist.bs))
        throw new Error('Cochez les 4 contrôles (CFS, T1, Balise, Bon de sortie) avant la sortie.');
    }

    // v3.5 — l'état du camion n'est plus saisi ici (PP) : il est géré par le CFS à la sortie de la zone CFS.
    const now = new Date();
    const sh = _sheet_(SHEETS.CARGOS);
    sh.getRange(c._row, COL.infosValidees + 1).setValue('Oui');
    sh.getRange(c._row, COL.ppChecklist + 1).setValue(estVeh ? '' : JSON.stringify(checklist));
    sh.getRange(c._row, COL.dateSortie + 1).setValue(now);
    sh.getRange(c._row, COL.agentPP + 1).setValue(session.nomComplet);
    sh.getRange(c._row, COL.observationsPP + 1).setValue(_txt_(p.observations, 1000));
    sh.getRange(c._row, COL.statut + 1).setValue(STATUTS.SORTIE);
    sh.getRange(c._row, COL.derniereMaj + 1).setValue(now);
  } finally {
    lock.releaseLock();
  }
  _invaliderCacheListes_();
  _log_(session, 'Enregistrement sortie', id, '');
  return { id: id };
}

/**
 * v3.5 — État du camion à la SORTIE DE LA ZONE CFS (saisi par le CFS, pour la traçabilité sur site).
 * Trois indications : « En cours de chargement » / « Fin de chargement » / « Vide ».
 */
function _etatSortieCFS_(session, p) {
  const id = String(p.id || '').trim();
  const etat = String(p.etatSortie || '').trim();
  if (ETATS_SORTIE.indexOf(etat) === -1)
    throw new Error('État invalide. Choisissez : ' + ETATS_SORTIE.join(' / ') + '.');
  const lock = LockService.getScriptLock(); lock.waitLock(15000);
  try {
    const c = _getCargo_(id);
    if (!c) throw new Error('Cargaison introuvable : ' + id);
    const sh = _sheet_(SHEETS.CARGOS);
    sh.getRange(c._row, COL.etatSortie + 1).setValue(etat);
    sh.getRange(c._row, COL.derniereMaj + 1).setValue(new Date());
  } finally { lock.releaseLock(); }
  _invaliderCacheListes_();
  _log_(session, 'État sortie CFS', id, etat);
  return { id: id, etatSortie: etat };
}

/** v3.5 — Traçabilité : camions présents sur le site (non sortis) avec leur état de sortie CFS + compteurs. */
function _listerEtatCFS_() {
  const sh = _sheet_(SHEETS.CARGOS);
  const last = sh.getLastRow();
  const out = { rows: [], compte: { total: 0, enCours: 0, fin: 0, vide: 0, np: 0 } };
  if (last < 2) return out;
  const data = _resumeListeCachee_(sh, last);
  data.forEach(function (r) {
    if (r.estVehicule === 'Oui') return;            // les véhicules ne sont pas des camions de chargement
    if (r.statut === STATUTS.SORTIE) return;        // déjà sortis du site
    out.compte.total++;
    const e = r.etatSortie || '';
    if (e === 'En cours de chargement') out.compte.enCours++;
    else if (e === 'Fin de chargement') out.compte.fin++;
    else if (e === 'Vide') out.compte.vide++;
    else out.compte.np++;
    out.rows.push({ id: r.id, numeroCamion: r.numeroCamion, typeOperation: r.typeOperation, statut: r.statut, etatSortie: e });
  });
  return out;
}

/* ===================== Déclarations & apurement ======================= */

/** Clé unique d'une déclaration : année|bureau|type|numéro (espaces retirés). */
function _declKey_(d) {
  d = d || {};
  return [d.anneeDeclaration, d.bureauDeclaration, d.typeDeclaration, d.numeroDeclaration]
    .map(function (x) { return String(x || '').toUpperCase().replace(/\s+/g, ''); }).join('|');
}
/** Ligne d'une déclaration par clé → {row, obj} ou null. */
function _declRow_(cle) {
  const sh = _sheet_(SHEETS.DECLARATIONS);
  const last = sh.getLastRow();
  if (last < 2) return null;
  const cell = sh.getRange(2, DCOL.cle + 1, last - 1, 1)
    .createTextFinder(cle).matchEntireCell(true).findNext();
  if (!cell) return null;
  const row = cell.getRow();
  const vals = sh.getRange(row, 1, 1, DECL_COLS.length).getValues()[0];
  const o = {}; DECL_COLS.forEach(function (c, i) { o[c.key] = vals[i]; });
  return { row: row, obj: o };
}
/** Recherche déclaration (client) → {exists, nombreConteneurs, apures, restant}. */
function _lookupDeclaration_(p) {
  const cle = _declKey_(p.declaration || p);
  const found = _declRow_(cle);
  if (!found) return { exists: false, cle: cle, nombreConteneurs: 0, apures: 0, restant: 0 };
  const o = found.obj;
  const nb = Number(o.nombreConteneurs || 0), ap = Number(o.conteneursApures || 0);
  return { exists: true, cle: cle, declarant: o.declarant, nombreConteneurs: nb, apures: ap, restant: Math.max(0, nb - ap) };
}
/**
 * Crée / met à jour l'apurement d'une déclaration.
 *  - 1re fois : exige `nombreConteneurs` (payload) et crée la ligne ;
 *  - ensuite  : incrémente `conteneursApures` de nbAjout.
 * Renvoie le restant à apurer.
 */
function _majApurement_(decl, payloadDecl, nbAjout, session) {
  const cle = _declKey_(decl);
  const lock = LockService.getScriptLock(); lock.waitLock(15000);
  try {
    const sh = _sheet_(SHEETS.DECLARATIONS);
    const found = _declRow_(cle);
    const now = new Date();
    if (!found) {
      const nbDecl = Number((payloadDecl && payloadDecl.nombreConteneurs) || 0);
      if (!nbDecl || nbDecl < 1)
        throw new Error('Nouvelle déclaration : indiquez le « nombre de conteneurs » déclarés.');
      const o = { cle: cle, anneeDeclaration: decl.anneeDeclaration, bureauDeclaration: decl.bureauDeclaration,
        typeDeclaration: decl.typeDeclaration, numeroDeclaration: decl.numeroDeclaration, declarant: decl.declarant,
        nombreConteneurs: nbDecl, conteneursApures: nbAjout, dateCreation: now, derniereMaj: now };
      sh.appendRow(DECL_COLS.map(function (c) { return o[c.key] === undefined ? '' : o[c.key]; }));
      return Math.max(0, nbDecl - nbAjout);
    }
    const nbDecl = Number(found.obj.nombreConteneurs || 0);
    const ap = Number(found.obj.conteneursApures || 0) + nbAjout;
    sh.getRange(found.row, DCOL.conteneursApures + 1).setValue(ap);
    sh.getRange(found.row, DCOL.derniereMaj + 1).setValue(now);
    return Math.max(0, nbDecl - ap);
  } finally { lock.releaseLock(); }
}

/**
 * Apurement BEST-EFFORT (v2.7) : incrémente l'apuré de la déclaration d'un conteneur
 * SANS bloquer le flux d'entrée. Si la déclaration n'existe pas encore, on la crée
 * avec un nombre déclaré provisoire (= nbAjout), que le CFS rectifiera via la déclaration.
 */
function _majApurementSafe_(declLike, nbAjout, session) {
  try {
    if (!declLike || !declLike.numeroDeclaration) return;     // aucune déclaration renseignée
    const found = _declRow_(_declKey_(declLike));
    if (found) _majApurement_(declLike, null, nbAjout, session);
    else _majApurement_(declLike, { nombreConteneurs: nbAjout }, nbAjout, session);
  } catch (e) { /* best-effort */ }
}

/** Fixe le nombre de conteneurs DÉCLARÉS d'une déclaration (sans toucher à l'apuré). */
function _fixerNombreDeclare_(decl, nb, session) {
  if (!decl || !decl.numeroDeclaration || !(Number(nb) >= 1)) return;
  const cle = _declKey_(decl);
  const lock = LockService.getScriptLock(); lock.waitLock(15000);
  try {
    const sh = _sheet_(SHEETS.DECLARATIONS);
    const found = _declRow_(cle);
    const now = new Date();
    if (found) {
      sh.getRange(found.row, DCOL.nombreConteneurs + 1).setValue(Number(nb));
      sh.getRange(found.row, DCOL.derniereMaj + 1).setValue(now);
    } else {
      const o = { cle: cle, anneeDeclaration: decl.anneeDeclaration, bureauDeclaration: decl.bureauDeclaration,
        typeDeclaration: decl.typeDeclaration, numeroDeclaration: decl.numeroDeclaration, declarant: decl.declarant,
        nombreConteneurs: Number(nb), conteneursApures: 0, dateCreation: now, derniereMaj: now };
      sh.appendRow(DECL_COLS.map(function (c) { return o[c.key] === undefined ? '' : o[c.key]; }));
    }
  } finally { lock.releaseLock(); }
}

/** Dispense — confirmer l'arrivée au bureau de destination (solde la dispense). */
function _arriveeBureau_(session, p) {
  const id = String(p.id || '').trim();
  const now = new Date();
  const lock = LockService.getScriptLock(); lock.waitLock(15000);
  try {
    const c = _getCargo_(id);
    if (!c) throw new Error('Cargaison introuvable : ' + id);
    if (String(c.baliseRequise) !== 'Non' && String(c.sauteBalise) !== 'Oui')
      throw new Error("Cette cargaison n'est pas une dispense.");
    if (c.statut !== STATUTS.SORTIE) throw new Error("La cargaison doit d'abord être sortie.");
    const sh = _sheet_(SHEETS.CARGOS);
    sh.getRange(c._row, COL.arriveeBureau + 1).setValue('Oui');
    sh.getRange(c._row, COL.dateArriveeBureau + 1).setValue(now);
    sh.getRange(c._row, COL.agentArriveeBureau + 1).setValue(session.nomComplet);
    sh.getRange(c._row, COL.derniereMaj + 1).setValue(now);
  } finally { lock.releaseLock(); }
  _invaliderCacheListes_();
  _log_(session, 'Arrivée bureau destination (dispense soldée)', id, '');
  return { id: id };
}

/* ============================ Stock physique ========================== */

function _stockObj_(row) { const o = {}; STOCK_COLS.forEach(function (c, i) { o[c.key] = row[i]; }); return o; }
function _stockRow_(numeroTC) {
  const sh = _sheet_(SHEETS.STOCK);
  const last = sh.getLastRow();
  if (last < 2) return -1;
  const cell = sh.getRange(2, SCOL.numeroTC + 1, last - 1, 1)
    .createTextFinder(String(numeroTC).trim()).matchEntireCell(true).findNext();
  return cell ? cell.getRow() : -1;
}

/** v2.7 — Conteneur du stock UTILISABLE (présent et pas encore dépoté) → objet stock ou null. */
function _stockDisponible_(numeroTC) {
  const tc = String(numeroTC || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const row = _stockRow_(tc);
  if (row < 0) return null;
  const o = _stockObj_(_sheet_(SHEETS.STOCK).getRange(row, 1, 1, STOCK_COLS.length).getValues()[0]);
  return (o.statut === STOCK_STATUTS.DEPOTE) ? null : o;   // déjà consommé -> indisponible
}

/** Parse une date d'import (Date, sérial Excel, dd/MM/yyyy, yyyy-MM-dd). → Date ou null. */
function _parseDateImport_(v) {
  if (!v) return null;
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
  const s = String(v).trim();
  if (!s) return null;
  if (/^\d+(\.\d+)?$/.test(s)) {                       // sérial Excel (jours depuis 1899-12-30)
    const n = Number(s);
    if (n > 59 && n < 60000) return new Date(Math.round((n - 25569) * 86400000));
  }
  let m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/);   // dd/MM/yyyy
  if (m) { let y = Number(m[3]); if (y < 100) y += 2000; return new Date(y, Number(m[2]) - 1, Number(m[1])); }
  m = s.match(/^(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})$/);          // yyyy-MM-dd
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

/** Liste du stock + compteurs (EVP, pointés, séjour moyen, tranches d'âge). */
function _listerStock_(opts) {
  opts = opts || {};
  const statut = opts.statut || 'tous';
  const sh = _sheet_(SHEETS.STOCK);
  const last = sh.getLastRow();
  const tz = Session.getScriptTimeZone();
  const now = new Date();
  const rows = [];
  const compte = { total: 0, stock: 0, positionne: 0, depote: 0, pointes: 0, evp: 0,
                   t20: 0, t40: 0, t45: 0, autres: 0, sejourMoyen: 0 };
  const dist = {}; TRANCHES_SEJOUR.forEach(function (t) { dist[t] = 0; });
  let sommeJ = 0, nJ = 0;
  if (last >= 2) {
    const vals = sh.getRange(2, 1, last - 1, STOCK_COLS.length).getValues();
    vals.forEach(function (r) {
      const o = _stockObj_(r);
      if (!o.numeroTC) return;
      compte.total++;
      const b = _tailleBucket_(o.taille); compte[b]++; compte.evp += evpDeTaille(b);
      if (o.statut === STOCK_STATUTS.STOCK) compte.stock++;
      else if (o.statut === STOCK_STATUTS.POSITIONNE) compte.positionne++;
      else if (o.statut === STOCK_STATUTS.DEPOTE) compte.depote++;
      if (o.datePointage) compte.pointes++;
      // Séjour (v2.7) = jours écoulés depuis l'entrée (sinon nb séjours importé).
      const jours = (o.dateEntree instanceof Date)
        ? Math.max(0, Math.floor((now - o.dateEntree) / 86400000))
        : (Number(o.nbSejoursImport || 0) || 0);
      if (o.statut !== STOCK_STATUTS.DEPOTE) { dist[_trancheAge_(jours)]++; sommeJ += jours; nJ++; }
      if (statut !== 'tous' && o.statut !== statut) return;
      rows.push({ numeroTC: o.numeroTC, taille: o.taille, typeConteneur: o.typeConteneur,
        provenance: o.provenance, statut: o.statut, dateEntree: _fmtDate_(o.dateEntree, tz),
        datePointage: _fmtDate_(o.datePointage, tz), pointePar: o.pointePar, cargaisonId: o.cargaisonId,
        joursSejour: jours });
    });
  }
  compte.sejourMoyen = nJ ? Math.round(sommeJ / nJ) : 0;
  compte.tranches = TRANCHES_SEJOUR.map(function (t) { return { tranche: t, n: dist[t] }; });
  return { rows: rows, compte: compte };
}

/**
 * Import / mise à jour du stock depuis un fichier Excel (lu côté client via SheetJS).
 * Payload : { items:[{ numeroTC, taille, nbSejours, dateEntree, typeConteneur?, provenance? }] }.
 * Un TC déjà présent est MIS À JOUR (import journalier : taille / date d'entrée / nb séjours).
 */
function _importerStock_(session, p) {
  const items = (Array.isArray(p.items) ? p.items : []);
  if (!items.length) throw new Error('Aucune ligne à importer.');
  const sh = _sheet_(SHEETS.STOCK);
  const now = new Date();
  const provDef = _maj_(p.provenanceDefaut || 'PORT SEC', 40);
  const nCol = STOCK_COLS.length;
  let ajoutes = 0, maj = 0, ignores = 0;
  // Lock COURT et non bloquant : tout le travail se fait en mémoire (un seul
  // getValues + deux setValues), donc la section verrouillée est très brève.
  // Évite l'« Expiration de la demande de verrouillage » des imports volumineux.
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) throw new Error('Un import est déjà en cours. Réessayez dans quelques secondes.');
  try {
    const last = sh.getLastRow();
    const data = last >= 2 ? sh.getRange(2, 1, last - 1, nCol).getValues() : [];
    const ref = {};        // TC normalisé -> ligne (référence, dans data ou nouveaux)
    const preexist = {};   // TC déjà présents AVANT l'import (pour distinguer maj vs ajout)
    for (let i = 0; i < data.length; i++) {
      const tc = String(data[i][SCOL.numeroTC] || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (tc) { ref[tc] = data[i]; preexist[tc] = true; }
    }
    const nouveaux = [];
    items.forEach(function (it) {
      const tc = String(it.numeroTC || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (!tc || !_tcValide_(tc)) { ignores++; return; }
      const taille = _maj_(it.taille, 10);
      const nbSej = Number(it.nbSejours || it.nbSejoursImport || 0) || 0;
      const dEnt = _parseDateImport_(it.dateEntree) || now;
      if (ref[tc]) {                                    // déjà présent : import journalier (statut conservé)
        const r = ref[tc];
        if (taille) r[SCOL.taille] = taille;
        r[SCOL.dateEntree] = dEnt;
        r[SCOL.nbSejoursImport] = nbSej;
        if (preexist[tc]) maj++;                        // doublon interne au fichier : on rafraîchit sans recompter
        return;
      }
      const o = { numeroTC: tc, taille: taille, typeConteneur: _maj_(it.typeConteneur, 30),
        provenance: _maj_(it.provenance, 40) || provDef, dateEntree: dEnt,
        statut: STOCK_STATUTS.STOCK, datePositionne: '', datePointage: '', pointePar: '', dateDepote: '',
        cargaisonId: '', observations: '', nbSejoursImport: nbSej };
      const row = STOCK_COLS.map(function (c) { return o[c.key] === undefined ? '' : o[c.key]; });
      ref[tc] = row; nouveaux.push(row); ajoutes++;
    });
    if (data.length)     sh.getRange(2, 1, data.length, nCol).setValues(data);
    if (nouveaux.length) sh.getRange(sh.getLastRow() + 1, 1, nouveaux.length, nCol).setValues(nouveaux);
  } finally { lock.releaseLock(); }
  _log_(session, 'Import stock', '', ajoutes + ' ajouté(s), ' + maj + ' mis à jour, ' + ignores + ' ignoré(s)');
  return { ajoutes: ajoutes, maj: maj, ignores: ignores };
}

/** Pointage matinal : positionne un TC pour dépotage. Bloque si déjà pointé. */
function _pointerStock_(session, p) {
  const tc = String(p.numeroTC || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!tc) throw new Error('N° conteneur requis.');
  const tz = Session.getScriptTimeZone();
  const lock = LockService.getScriptLock(); lock.waitLock(15000);
  try {
    const sh = _sheet_(SHEETS.STOCK);
    const row = _stockRow_(tc);
    if (row < 0) throw new Error('Conteneur « ' + tc + " » absent du stock. Importez-le d'abord.");
    const o = _stockObj_(sh.getRange(row, 1, 1, STOCK_COLS.length).getValues()[0]);
    if (o.statut === STOCK_STATUTS.POSITIONNE || o.datePointage) {
      const dp = (o.datePointage instanceof Date) ? Utilities.formatDate(o.datePointage, tz, 'dd/MM/yyyy') : String(o.datePointage);
      throw new Error('Conteneur « ' + tc + ' » DÉJÀ POINTÉ le ' + dp + ' (par ' + (o.pointePar || '?') + '). Pointage bloqué.');
    }
    if (o.statut === STOCK_STATUTS.DEPOTE) throw new Error('Conteneur déjà dépoté.');
    const now = new Date();
    sh.getRange(row, SCOL.statut + 1).setValue(STOCK_STATUTS.POSITIONNE);
    sh.getRange(row, SCOL.datePositionne + 1).setValue(now);
    sh.getRange(row, SCOL.datePointage + 1).setValue(now);
    sh.getRange(row, SCOL.pointePar + 1).setValue(session.nomComplet);
  } finally { lock.releaseLock(); }
  _log_(session, 'Pointage matinal', tc, '');
  const s = _listerStock_({ statut: 'tous' }).compte;
  return { numeroTC: tc, positionne: s.positionne, depote: s.depote, restantAOuvrir: s.positionne };
}

/** Magasin/MAD temps 1 : marque un conteneur dépoté / sorti du yard. */
function _entreeMagasin_(session, p) {
  const tc = String(p.numeroTC || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!tc) throw new Error('N° conteneur requis.');
  const lock = LockService.getScriptLock(); lock.waitLock(15000);
  try {
    const sh = _sheet_(SHEETS.STOCK);
    const row = _stockRow_(tc);
    const now = new Date();
    if (row < 0) {
      const o = { numeroTC: tc, taille: _maj_(p.taille, 10), typeConteneur: _maj_(p.typeConteneur, 30),
        provenance: _maj_(p.provenance || 'PORT SEC', 40), dateEntree: now, statut: STOCK_STATUTS.DEPOTE,
        datePositionne: '', datePointage: '', pointePar: '', dateDepote: now, cargaisonId: '',
        observations: 'Entrée magasin/MAD' };
      sh.appendRow(STOCK_COLS.map(function (c) { return o[c.key] === undefined ? '' : o[c.key]; }));
    } else {
      sh.getRange(row, SCOL.statut + 1).setValue(STOCK_STATUTS.DEPOTE);
      sh.getRange(row, SCOL.dateDepote + 1).setValue(now);
      sh.getRange(row, SCOL.observations + 1).setValue('Entrée magasin/MAD');
    }
  } finally { lock.releaseLock(); }
  _log_(session, 'Entrée Magasin/MAD — conteneur dépoté', tc, '');
  return { numeroTC: tc };
}

/* =========================== Stock ANNONCÉ (v2.8) ========================
 * Annonce de transfert Port Autonome → Port Sec : l'admin importe la veille la
 * liste des TC ; la Porte Principale les POINTE à l'arrivée → ajout au stock.
 * ======================================================================== */

function _annonceObj_(row) { const o = {}; STOCK_ANNONCE_COLS.forEach(function (c, i) { o[c.key] = row[i]; }); return o; }
function _annonceRow_(numeroTC) {
  const sh = _sheet_(SHEETS.STOCK_ANNONCE);
  const last = sh.getLastRow();
  if (last < 2) return -1;
  const cell = sh.getRange(2, ANCOL.numeroTC + 1, last - 1, 1)
    .createTextFinder(String(numeroTC).trim()).matchEntireCell(true).findNext();
  return cell ? cell.getRow() : -1;
}

/** Import de l'annonce de transfert (ADMIN). 7 colonnes. Lock court + écriture groupée. */
function _importerStockAnnonce_(session, p) {
  const items = (Array.isArray(p.items) ? p.items : []);
  if (!items.length) throw new Error('Aucune ligne à importer.');
  const sh = _sheet_(SHEETS.STOCK_ANNONCE);
  const now = new Date();
  const nCol = STOCK_ANNONCE_COLS.length;
  let ajoutes = 0, maj = 0, ignores = 0;
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) throw new Error('Un import est déjà en cours. Réessayez dans quelques secondes.');
  try {
    const last = sh.getLastRow();
    const data = last >= 2 ? sh.getRange(2, 1, last - 1, nCol).getValues() : [];
    const ref = {}, preexist = {};
    for (let i = 0; i < data.length; i++) {
      const tc = String(data[i][ANCOL.numeroTC] || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (tc) { ref[tc] = data[i]; preexist[tc] = true; }
    }
    const nouveaux = [];
    items.forEach(function (it) {
      const tc = String(it.numeroTC || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (!tc || !_tcValide_(tc)) { ignores++; return; }
      const champs = {
        taille: _maj_(it.taille, 10),
        dateEntree: _parseDateImport_(it.dateEntree) || now,
        anneeDeclaration: _maj_(it.anneeDeclaration, 6),
        bureauDeclaration: _maj_(it.bureauDeclaration, 20),
        typeDeclaration: _maj_(it.typeDeclaration, 6),
        numeroDeclaration: _maj_(it.numeroDeclaration, 30),
      };
      if (ref[tc]) {                                   // déjà annoncé : on rafraîchit, SAUF si déjà pointé
        const r = ref[tc];
        if (r[ANCOL.statut] !== ANNONCE_STATUTS.POINTE) {
          if (champs.taille) r[ANCOL.taille] = champs.taille;
          r[ANCOL.dateEntree] = champs.dateEntree;
          r[ANCOL.anneeDeclaration] = champs.anneeDeclaration;
          r[ANCOL.bureauDeclaration] = champs.bureauDeclaration;
          r[ANCOL.typeDeclaration] = champs.typeDeclaration;
          r[ANCOL.numeroDeclaration] = champs.numeroDeclaration;
        }
        if (preexist[tc]) maj++;
        return;
      }
      const o = { numeroTC: tc, taille: champs.taille, dateEntree: champs.dateEntree,
        anneeDeclaration: champs.anneeDeclaration, bureauDeclaration: champs.bureauDeclaration,
        typeDeclaration: champs.typeDeclaration, numeroDeclaration: champs.numeroDeclaration,
        statut: ANNONCE_STATUTS.ANNONCE, dateAnnonce: now, datePointage: '', pointePar: '', observations: '' };
      const row = STOCK_ANNONCE_COLS.map(function (c) { return o[c.key] === undefined ? '' : o[c.key]; });
      ref[tc] = row; nouveaux.push(row); ajoutes++;
    });
    if (data.length)     sh.getRange(2, 1, data.length, nCol).setValues(data);
    if (nouveaux.length) sh.getRange(sh.getLastRow() + 1, 1, nouveaux.length, nCol).setValues(nouveaux);
  } finally { lock.releaseLock(); }
  _log_(session, 'Import annonce de transfert', '', ajoutes + ' annoncé(s), ' + maj + ' mis à jour, ' + ignores + ' ignoré(s)');
  return { ajoutes: ajoutes, maj: maj, ignores: ignores };
}

/** Liste du stock annoncé + compteurs (annoncés / pointés / taux / délai moyen de transfert). */
function _listerStockAnnonce_(opts) {
  opts = opts || {};
  const statut = opts.statut || 'tous';
  const sh = _sheet_(SHEETS.STOCK_ANNONCE);
  const last = sh.getLastRow();
  const tz = Session.getScriptTimeZone();
  const now = new Date();
  const rows = [];
  // v3.1 — 3 états : Annoncé (non pointé) → Pointé (à confirmer par le CFS) → Confirmé (entré au stock).
  const compte = { total: 0, annonces: 0, aConfirmer: 0, confirmes: 0, pointes: 0, tauxTransfert: 0,
                   delaiMoyen: 0, instanceMax: 0 };
  let sommeDelai = 0, nDelai = 0;
  if (last >= 2) {
    const vals = sh.getRange(2, 1, last - 1, STOCK_ANNONCE_COLS.length).getValues();
    vals.forEach(function (r) {
      const o = _annonceObj_(r);
      if (!o.numeroTC) return;
      compte.total++;
      const estConfirme = (o.statut === ANNONCE_STATUTS.CONFIRME);
      const estPointe = (o.statut === ANNONCE_STATUTS.POINTE);
      if (estConfirme) compte.confirmes++;
      else if (estPointe) compte.aConfirmer++;
      else compte.annonces++;
      // Délai de transfert EFFECTIF = confirmation − annonce ; instance = attente d'un non-confirmé.
      let jours = 0;
      if (estConfirme && (o.dateConfirmation instanceof Date) && (o.dateAnnonce instanceof Date)) {
        jours = Math.max(0, Math.floor((o.dateConfirmation - o.dateAnnonce) / 86400000));
        sommeDelai += jours; nDelai++;
      } else if (!estConfirme && (o.dateAnnonce instanceof Date)) {
        jours = Math.max(0, Math.floor((now - o.dateAnnonce) / 86400000));
        if (jours > compte.instanceMax) compte.instanceMax = jours;
      }
      if (statut !== 'tous' && o.statut !== statut) return;
      rows.push({ numeroTC: o.numeroTC, taille: o.taille, statut: o.statut,
        anneeDeclaration: o.anneeDeclaration, bureauDeclaration: o.bureauDeclaration,
        typeDeclaration: o.typeDeclaration, numeroDeclaration: o.numeroDeclaration,
        dateEntree: _fmtDate_(o.dateEntree, tz), dateAnnonce: _fmtDate_(o.dateAnnonce, tz),
        datePointage: _fmtDate_(o.datePointage, tz), pointePar: o.pointePar,
        dateConfirmation: _fmtDate_(o.dateConfirmation, tz), confirmePar: o.confirmePar, jours: jours });
    });
  }
  compte.pointes = compte.aConfirmer + compte.confirmes;                       // « pointés » au total (à confirmer + confirmés)
  compte.tauxTransfert = compte.total ? Math.round((compte.confirmes / compte.total) * 100) : 0; // transfert EFFECTIF = confirmés
  compte.delaiMoyen = nDelai ? Math.round(sommeDelai / nDelai) : 0;
  return { rows: rows, compte: compte };
}

/**
 * v3.1 — Pointage à l'entrée (Porte Principale) : le TC annoncé ARRIVE au port sec.
 * Passe de « Annoncé » à « Pointé ». N'entre PAS encore au stock : le CFS doit CONFIRMER.
 */
function _pointerStockAnnonce_(session, p) {
  const tc = String(p.numeroTC || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!tc) throw new Error('N° conteneur requis.');
  const tz = Session.getScriptTimeZone();
  const now = new Date();
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) throw new Error('Opération en cours, réessayez.');
  try {
    const sh = _sheet_(SHEETS.STOCK_ANNONCE);
    const row = _annonceRow_(tc);
    if (row < 0) throw new Error('Conteneur « ' + tc + ' » introuvable dans le stock annoncé.');
    const o = _annonceObj_(sh.getRange(row, 1, 1, STOCK_ANNONCE_COLS.length).getValues()[0]);
    if (o.statut === ANNONCE_STATUTS.POINTE || o.statut === ANNONCE_STATUTS.CONFIRME) {
      const dp = (o.datePointage instanceof Date) ? Utilities.formatDate(o.datePointage, tz, 'dd/MM/yyyy HH:mm') : String(o.datePointage);
      throw new Error('Conteneur « ' + tc + ' » DÉJÀ POINTÉ le ' + dp + ' (par ' + (o.pointePar || '?') + ').');
    }
    sh.getRange(row, ANCOL.statut + 1).setValue(ANNONCE_STATUTS.POINTE);
    sh.getRange(row, ANCOL.datePointage + 1).setValue(now);
    sh.getRange(row, ANCOL.pointePar + 1).setValue(session.nomComplet);
  } finally { lock.releaseLock(); }
  _log_(session, 'Pointage entrée (stock annoncé)', tc, '');
  const s = _listerStockAnnonce_({ statut: 'tous' }).compte;
  return { numeroTC: tc, annonces: s.annonces, aConfirmer: s.aConfirmer, confirmes: s.confirmes, tauxTransfert: s.tauxTransfert };
}

/**
 * v3.1 — Confirmation par le CFS : un TC POINTÉ par la PP entre EFFECTIVEMENT au stock du port sec.
 * Passe de « Pointé » à « Confirmé » et alimente la feuille Stock (provenance Port autonome).
 */
function _confirmerStockAnnonce_(session, p) {
  const tc = String(p.numeroTC || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!tc) throw new Error('N° conteneur requis.');
  const tz = Session.getScriptTimeZone();
  const now = new Date();
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) throw new Error('Opération en cours, réessayez.');
  try {
    const sh = _sheet_(SHEETS.STOCK_ANNONCE);
    const row = _annonceRow_(tc);
    if (row < 0) throw new Error('Conteneur « ' + tc + ' » introuvable dans le stock annoncé.');
    const o = _annonceObj_(sh.getRange(row, 1, 1, STOCK_ANNONCE_COLS.length).getValues()[0]);
    if (o.statut === ANNONCE_STATUTS.CONFIRME) throw new Error('Conteneur « ' + tc + ' » déjà confirmé / entré au stock.');
    if (o.statut !== ANNONCE_STATUTS.POINTE) throw new Error('Conteneur « ' + tc + ' » pas encore pointé par la Porte Principale.');
    sh.getRange(row, ANCOL.statut + 1).setValue(ANNONCE_STATUTS.CONFIRME);
    sh.getRange(row, ANCOL.dateConfirmation + 1).setValue(now);
    sh.getRange(row, ANCOL.confirmePar + 1).setValue(session.nomComplet);
    // Entrée EFFECTIVE au stock du port sec (provenance = Port autonome).
    const st = _sheet_(SHEETS.STOCK);
    const sr = _stockRow_(tc);
    if (sr > 0) {
      st.getRange(sr, SCOL.dateEntree + 1).setValue(o.dateEntree || now);
    } else {
      const so = { numeroTC: tc, taille: o.taille, typeConteneur: '', provenance: 'PORT AUTONOME',
        dateEntree: o.dateEntree || now, statut: STOCK_STATUTS.STOCK, datePositionne: '',
        datePointage: '', pointePar: '', dateDepote: '', cargaisonId: '',
        observations: 'Transfert annoncé confirmé le ' + Utilities.formatDate(now, tz, 'dd/MM/yyyy'), nbSejoursImport: 0 };
      st.appendRow(STOCK_COLS.map(function (c) { return so[c.key] === undefined ? '' : so[c.key]; }));
    }
  } finally { lock.releaseLock(); }
  _log_(session, 'Confirmation entrée stock (annoncé)', tc, '');
  const s = _listerStockAnnonce_({ statut: 'tous' }).compte;
  return { numeroTC: tc, aConfirmer: s.aConfirmer, confirmes: s.confirmes, tauxTransfert: s.tauxTransfert };
}

/* ------------------------- Statistiques tableau ------------------------ */

function _statistiques_(opts) {
  opts = opts || {};
  const sh = _sheet_(SHEETS.CARGOS);
  const last = sh.getLastRow();
  const stats = { total: 0, camion: 0, chargement: 0, sortie: 0, aujourdHui: 0,
                  attValidation: 0, attT1: 0, attBalise: 0, attBs: 0, attPP: 0,
                  creee: 0, t1: 0, gps: 0, bs: 0,             // alias compat libellés client
                  vehiculesAttente: 0, vehiculesSortis: 0 };
  if (last < 2) return stats;

  // v3.6 — filtre temporel (sur la date de création). du/au au format yyyy-MM-dd (inclus).
  const du = opts.du ? _parseDateImport_(opts.du) : null;
  const auJ = opts.au ? _parseDateImport_(opts.au) : null;
  const auEx = auJ ? new Date(auJ.getTime() + 86400000) : null;   // borne haute exclusive (fin de journée)

  // Cache 60 s, invalidé automatiquement à chaque écriture (LIST_VER).
  const cache = CacheService.getScriptCache();
  const key = 'stats_' + _versionListe_() + '_' + last + '_' + (opts.du || '') + '_' + (opts.au || '');
  const cached = cache.get(key);
  if (cached) { try { return JSON.parse(cached); } catch (e) {} }

  // On lit le résumé (qui contient dateT1/datePoseGPS/bonSortieNumero) pour calculer les
  // étapes EN ATTENTE — modèle parallèle Balise ∥ Bon de Sortie.
  const data = _resumeListeCachee_(sh, last);
  const today = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  data.forEach(function (r) {
    if (du || auEx) {
      const d = r.dateCreation ? new Date(r.dateCreation) : null;
      if (!d || isNaN(d.getTime())) return;
      if (du && d < du) return;
      if (auEx && d >= auEx) return;
    }
    if (r.estVehicule === 'Oui') {
      if (r.statut === STATUTS.SORTIE) stats.vehiculesSortis++; else stats.vehiculesAttente++;
      return;
    }
    stats.total++;
    if (r.statut === STATUTS.CAMION) stats.camion++;
    else if (r.statut === STATUTS.CHARGEMENT) stats.chargement++;
    else if (r.statut === STATUTS.SORTIE) stats.sortie++;
    const pend = _etapesEnAttente_(r);
    if (pend.indexOf('VALIDATION') >= 0) stats.attValidation++;
    if (pend.indexOf('T1') >= 0) stats.attT1++;
    if (pend.indexOf('BALISE') >= 0) stats.attBalise++;
    if (pend.indexOf('BS') >= 0) stats.attBs++;
    if (pend.indexOf('PP') >= 0) stats.attPP++;
    if (_memeJour_(r.dateCreation, today)) stats.aujourdHui++;
  });
  stats.creee = stats.attT1; stats.t1 = stats.attBalise; stats.gps = stats.attBs; stats.bs = stats.attPP;
  try { cache.put(key, JSON.stringify(stats), 60); } catch (e) {}
  return stats;
}

/* ------------------------------ Helpers -------------------------------- */

function _txt_(v, max) {
  let s = (v === null || v === undefined) ? '' : String(v).trim();
  if (max && s.length > max) s = s.slice(0, max);
  return s;
}
function _maj_(v, max) { return _txt_(v, max).toUpperCase(); }
function _alphaNumMaj_(v) {
  const s = _txt_(v).toUpperCase().replace(/[^A-Z0-9\/-]/g, '');
  return s;
}
function _ts_(v) {
  if (!v) return 0;
  const d = (v instanceof Date) ? v : new Date(v);
  return isNaN(d.getTime()) ? 0 : d.getTime();
}
function _memeJour_(v, ymd) {
  if (!v) return false;
  const d = (v instanceof Date) ? v : new Date(v);
  if (isNaN(d.getTime())) return false;
  return Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM-dd') === ymd;
}
