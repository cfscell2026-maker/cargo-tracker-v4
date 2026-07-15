/**
 * ============================================================================
 *  Reports.gs : Génération de rapports (PDF chargement, listes Excel/PDF,
 *               historique Excel/PDF)
 * ============================================================================
 *  Les rapports sont renvoyés au client en base64 -> téléchargement direct.
 *  Les exports Excel/PDF des listes passent par un classeur temporaire isolé
 *  (puis supprimé), ce qui garantit une mise en forme propre sans toucher aux
 *  données de production.
 * ============================================================================
 */

const MIME = {
  PDF: 'application/pdf',
  XLSX: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

/* --------------------- Rapport de chargement (1 cargaison) -------------- */

function _rapportChargement_(session, id) {
  const c = _getCargo_(id);
  if (!c) throw new Error('Cargaison introuvable : ' + id);
  const html = _htmlChargement_(c);
  const pdf = Utilities.newBlob(html, 'text/html', 'rapport.html').getAs(MIME.PDF);
  _log_(session, 'Rapport de chargement', id, '');
  return _blobVersClient_(pdf, 'Chargement_' + c.id + '.pdf', MIME.PDF);
}

function _htmlChargement_(c) {
  const tz = Session.getScriptTimeZone();
  const d = c.dateCreation instanceof Date
    ? Utilities.formatDate(c.dateCreation, tz, 'dd/MM/yyyy HH:mm') : c.dateCreation;
  const e = _esc_;
  function ligne(l, v) {
    if (v === '' || v === null || v === undefined) return '';
    return '<tr><td class="k">' + e(l) + '</td><td class="v">' + e(v) + '</td></tr>';
  }
  const estEnl = (c.typeOperation === OPERATIONS.ENLEVEMENT);
  const estDep = (c.typeOperation === OPERATIONS.DEPOTAGE);
  // Lecture compatible ancien format (tableau simple) ET nouveau ({conteneurs, scellesCamion}).
  let details = [], scellesCamion = [];
  try {
    const parsed = JSON.parse(c.conteneursDetails || '[]');
    if (Array.isArray(parsed)) {
      details = parsed;                                   // ancien format
    } else {
      details = (parsed && parsed.conteneurs) || [];
      scellesCamion = (parsed && parsed.scellesCamion) || [];
    }
  } catch (err) { details = []; }
  // Replie sur les colonnes plates si le détail JSON est absent.
  if (!details.length) {
    if (estDep) {
      [c.conteneur1, c.conteneur2, c.conteneur3, c.conteneur4].forEach(function (n) {
        if (n) details.push({ num: n });
      });
      if (!scellesCamion.length)
        scellesCamion = [c.plomb1, c.plomb2, c.plomb3].filter(function (s) { return s; });
    } else {
      [[c.conteneur1, c.plomb1], [c.conteneur2, c.plomb2],
       [c.conteneur3, c.plomb3], [c.conteneur4, '']].forEach(function (r) {
        if (r[0]) details.push({ num: r[0], plomb: r[1] || '' });
      });
    }
  }
  // Tableau des conteneurs.
  // - Enlèvement : colonne Scellé par conteneur (comportement d'origine).
  // - Dépotage : pas de colonne Scellé (le scellé est au niveau du camion, affiché à part).
  let conteneurs = '';
  details.forEach(function (d, i) {
    if (!d || !d.num) return;
    const sup = [];
    if (d.taille) sup.push('Taille : ' + d.taille);
    if (d.type)   sup.push('Type : ' + d.type);
    if (d.poids)  sup.push('Poids : ' + d.poids);
    (d.extra || []).forEach(function (x) { if (x && x.nom) sup.push(e(x.nom) + ' : ' + e(x.valeur || '')); });
    conteneurs +=
      '<tr><td>' + e('Conteneur ' + (i + 1)) + '</td><td>' + e(d.num) + '</td>' +
      (estDep ? '' : '<td>' + e(d.plomb || '') + '</td>') +
      '<td>' + (sup.length ? sup.join(' · ') : '—') + '</td></tr>';
  });
  // Bloc « Scellés du camion » (dépotage uniquement).
  let blocScellesCamion = '';
  if (estDep && scellesCamion.length) {
    blocScellesCamion = '<h2>Scellés du camion (' + scellesCamion.length + ')</h2><table><tr>' +
      scellesCamion.map(function (s) { return '<th>' + e(s) + '</th>'; }).join('') +
      '</tr></table>';
  }

  return '' +
  '<html><head><meta charset="utf-8"><style>' +
  'body{font-family:Arial,Helvetica,sans-serif;color:#26333d;margin:28px;}' +
  '.head{border-bottom:3px solid #2e6da4;padding-bottom:10px;margin-bottom:18px;}' +
  '.head h1{color:#2e6da4;margin:0;font-size:22px;}' +
  '.head .sub{color:#5b8db8;font-size:12px;}' +
  '.badge{display:inline-block;background:#2e6da4;color:#fff;padding:4px 12px;border-radius:4px;font-size:13px;}' +
  'h2{color:#2e6da4;font-size:14px;border-bottom:1px solid #d7e2ec;padding-bottom:4px;margin-top:22px;}' +
  'table{width:100%;border-collapse:collapse;font-size:12px;}' +
  'td{padding:5px 8px;border:1px solid #d7e2ec;vertical-align:top;}' +
  'td.k{background:#f4f6f9;font-weight:bold;width:34%;}' +
  'th{background:#e8edf2;padding:5px 8px;border:1px solid #d7e2ec;text-align:left;font-size:12px;}' +
  '.foot{margin-top:30px;font-size:10px;color:#8aa1b1;text-align:center;}' +
  '</style></head><body>' +
  '<div class="head"><h1>Suivi des Cargaisons — Rapport de chargement</h1>' +
  '<div class="sub">Document généré le ' +
    Utilities.formatDate(new Date(), tz, 'dd/MM/yyyy HH:mm') + '</div></div>' +
  '<p><span class="badge">' + e(c.id) + '</span>&nbsp;&nbsp;Statut : <b>' + e(c.statut) + '</b></p>' +
  '<h2>Informations générales</h2><table>' +
  ligne('N° Rapport', c.rapportId) +
  ligne('Date d\'enregistrement', d) +
  ligne('N° Camion', c.numeroCamion) +
  ligne('Type d\'opération', c.typeOperation) +
  (estEnl ? ligne('TWINS', c.twins) : '') +
  ligne('Agent CFS', c.agentCFS) +
  '</table>' +
  blocScellesCamion +
  (conteneurs ? '<h2>' + (estDep ? 'Conteneurs' : 'Conteneurs & scellés') + ' (' + details.length + ')</h2>' +
    '<table><tr><th>Conteneur</th><th>N°</th>' + (estDep ? '' : '<th>Scellé</th>') + '<th>Détails</th></tr>' +
    conteneurs + '</table>' : '') +
  (c.declarant || c.numeroDeclaration ? '<h2>Déclaration</h2><table>' +
    ligne('Déclarant', c.declarant) +
    ligne('Contact déclarant', c.contactDeclarant) +
    ligne('Destination marchandise', c.destinationMarchandise) +
    ligne('Bureau de déclaration', c.bureauDeclaration) +
    ligne('Type de déclaration', c.typeDeclaration) +
    ligne('N° de déclaration', c.numeroDeclaration) +
    ligne('Année de déclaration', c.anneeDeclaration) +
    ligne('Description marchandise', c.descriptionMarchandise) +
    '</table>' : '') +
  (c.observationsCFS ? '<h2>Observations</h2><table>' + ligne('Observations', c.observationsCFS) + '</table>' : '') +
  '<div class="foot">Suivi des Cargaisons — Document à conserver. ID : ' + e(c.id) + '</div>' +
  '</body></html>';
}

/* --------------------- Rapport d'activité CFS (synthèse) --------------- */
/**
 * Synthèse d'activité CFS sur une période, par type d'opération :
 *   - nombre de camions enregistrés,
 *   - nombre de conteneurs 20' / 40' / 45' (+ autres / non précisé).
 * Accès : ADMIN (tous ou filtré par agent) ; CFS (sa propre activité, forcé serveur).
 *
 * Payload : { du:'AAAA-MM-JJ', au:'AAAA-MM-JJ', periode, agentCFS?, format? }
 *   - format absent / 'view' -> renvoie les agrégats (affichage écran)
 *   - format 'pdf' | 'xlsx'  -> renvoie le fichier à télécharger
 * Agrégation en UNE passe sur « Cargaisons » (compte les camions + lit
 * `conteneursDetails` pour les tailles), robuste même sans la feuille Conteneurs.
 */
/** Extrait la liste des conteneurs d'une ligne Cargaison (JSON, sinon aperçu, sinon nb). */
function _detsDeRow_(row) {
  let dets = [];
  try {
    const parsed = JSON.parse(row[COL.conteneursDetails] || '[]');
    dets = Array.isArray(parsed) ? parsed : ((parsed && parsed.conteneurs) || []);
  } catch (e) { dets = []; }
  if (!dets.length) {
    [row[COL.conteneur1], row[COL.conteneur2], row[COL.conteneur3], row[COL.conteneur4]]
      .forEach(function (n) { if (n) dets.push({ num: n }); });
  }
  if (!dets.length) {
    const nb = Number(row[COL.nbConteneurs] || 0);
    for (let k = 0; k < nb; k++) dets.push({});
  }
  return dets;
}

/** Résout bornes de dates + agent (CFS = forcé à lui-même). */
function _bornesEtAgent_(session, p) {
  const du = p.du ? new Date(p.du + 'T00:00:00') : null;
  const au = p.au ? new Date(p.au + 'T23:59:59') : null;
  let agent = _txt_(p.agentCFS);
  // Cahier 3.4 NB : un compte voit/édite les rapports de TOUS les agents de sa cellule.
  return { du: du, au: au, agent: agent, agentLc: agent ? agent.toLowerCase() : '' };
}

/**
 * Passe UNIQUE sur « Cargaisons » : renvoie les agrégats + le détail ligne à
 * ligne (camions et conteneurs) pour la période/agent donnés. Sert à la fois à
 * la synthèse écran, au détail des cartes cliquables, et à l'export détaillé.
 */
function _collecteCFS_(du, au, agentLc) {
  const vide = function () { return { camions: 0, conteneurs: 0, t20: 0, t40: 0, t45: 0, autres: 0 }; };
  const agg = { enlevement: vide(), depotage: vide() };
  const camions = [], conteneurs = [];

  const sh = _sheet_(SHEETS.CARGOS);
  const last = sh.getLastRow();
  if (last >= 2) {
    const vals = sh.getRange(2, 1, last - 1, COLS.length).getValues();
    vals.forEach(function (row) {
      const d = row[COL.dateCreation];
      if (!(d instanceof Date)) return;
      if (du && d < du) return;
      if (au && d > au) return;
      if (agentLc && String(row[COL.agentCFS]).toLowerCase() !== agentLc) return;
      const op = row[COL.typeOperation];
      const bucket = (op === OPERATIONS.ENLEVEMENT) ? agg.enlevement
                   : (op === OPERATIONS.DEPOTAGE)   ? agg.depotage : null;
      if (!bucket) return;

      const dets = _detsDeRow_(row);
      const dISO = d.toISOString();
      bucket.camions++;
      camions.push({
        id: row[COL.id], numeroCamion: row[COL.numeroCamion], operation: op,
        statut: row[COL.statut], dateCreation: dISO, agentCFS: row[COL.agentCFS],
        rapportId: row[COL.rapportId], nbConteneurs: dets.length,
      });
      bucket.conteneurs += dets.length;
      dets.forEach(function (ct, idx) {
        const b = _tailleBucket_(ct && ct.taille);
        bucket[b]++;
        conteneurs.push({
          cargaisonId: row[COL.id], rapportId: row[COL.rapportId], numeroCamion: row[COL.numeroCamion],
          operation: op, ordre: idx + 1, conteneur: (ct && ct.num) || '', taille: (ct && ct.taille) || '',
          sizeBucket: b, typeConteneur: (ct && ct.type) || '', poids: (ct && ct.poids) || '',
          scelle: (ct && ct.plomb) || '', statut: row[COL.statut], dateCreation: dISO, agentCFS: row[COL.agentCFS],
        });
      });
    });
  }
  return { agg: agg, camions: camions, conteneurs: conteneurs };
}

function _rapportCFS_(session, p) {
  p = p || {};
  const b = _bornesEtAgent_(session, p);
  const col = _collecteCFS_(b.du, b.au, b.agentLc);
  const E = col.agg.enlevement, D = col.agg.depotage;
  const data = {
    periode: p.periode || 'personnalise',
    du: p.du || '', au: p.au || '',
    agent: b.agent || 'Tous les agents CFS',
    enlevement: E, depotage: D,
    totalCamions: E.camions + D.camions,
    totalConteneurs: E.conteneurs + D.conteneurs,
  };
  if (p.format === 'pdf' || p.format === 'xlsx')
    return _exporterCFS_(session, data, p.format, col.conteneurs, _txt_(p.operation));
  _log_(session, 'Rapport CFS (vue)', '', data.agent + ' · ' + (data.du || '…') + ' → ' + (data.au || '…'));
  return data;
}

/**
 * Détail derrière une carte cliquée : (operation, metric).
 *   metric = 'camions'                  -> liste des camions de l'opération
 *   metric = 'conteneurs'               -> tous les conteneurs de l'opération
 *   metric = 't20' | 't40' | 't45' | 'autres' -> conteneurs de cette taille
 */
function _rapportCFSDetail_(session, p) {
  p = p || {};
  const b = _bornesEtAgent_(session, p);
  const col = _collecteCFS_(b.du, b.au, b.agentLc);
  const op = p.operation, metric = p.metric;
  if (metric === 'camions') {
    return { kind: 'camions', operation: op, metric: metric,
             rows: col.camions.filter(function (c) { return !op || c.operation === op; }) };
  }
  let rows = col.conteneurs.filter(function (c) { return !op || c.operation === op; });
  if (metric && metric !== 'conteneurs') rows = rows.filter(function (c) { return c.sizeBucket === metric; });
  return { kind: 'conteneurs', operation: op, metric: metric, rows: rows };
}

/* ----------------------- Rapport Véhicules dépotés -------------------- */
/**
 * Synthèse des véhicules dépotés sur une période, ventilée par destination/régime
 * (Transit / Conso / MAD / Véhicule abandonné), + nb de conteneurs dépotés (1 par
 * rapport véhicule via la ligne porteuse) et séparation en attente / sortis.
 * Date de référence = création CFS. CFS = forcé à sa propre activité.
 */
function _destBucket_(d) {
  const s = String(d || '').toLowerCase();
  if (s.indexOf('transit') >= 0) return 'transit';
  if (s.indexOf('conso') >= 0) return 'conso';
  if (s.indexOf('mad') >= 0) return 'mad';
  if (s.indexOf('abandon') >= 0) return 'abandon';
  return 'autres';
}
function _libelleDest_(b) {
  return { transit: 'Transit', conso: 'Conso', mad: 'MAD', abandon: 'Véhicule abandonné',
           autres: 'Autre / non précisé' }[b] || b;
}

function _collecteVehicules_(du, au, agentLc) {
  const dist = { transit: 0, conso: 0, mad: 0, abandon: 0, autres: 0 };
  const vehicules = [];
  let total = 0, attente = 0, sortis = 0, conteneurs = 0;

  const sh = _sheet_(SHEETS.CARGOS);
  const last = sh.getLastRow();
  if (last >= 2) {
    const vals = sh.getRange(2, 1, last - 1, COLS.length).getValues();
    vals.forEach(function (row) {
      if (String(row[COL.estVehicule]) !== 'Oui') return;
      const d = row[COL.dateCreation];
      if (!(d instanceof Date)) return;
      if (du && d < du) return;
      if (au && d > au) return;
      if (agentLc && String(row[COL.agentCFS]).toLowerCase() !== agentLc) return;

      let v = {}; try { v = JSON.parse(row[COL.vehiculeDetails] || '{}') || {}; } catch (e) { v = {}; }
      const bucket = _destBucket_(v.destination);
      const statut = row[COL.statut];
      total++;
      dist[bucket]++;
      if (statut === STATUTS.SORTIE) sortis++; else attente++;
      conteneurs += _detsDeRow_(row).length;     // 1 sur la ligne porteuse, 0 sinon
      vehicules.push({
        id: row[COL.id], chassis: row[COL.numeroCamion], marque: v.marque || '', modele: v.modele || '',
        couleur: v.couleur || '', destination: v.destination || '', destBucket: bucket, statut: statut,
        dateCreation: d.toISOString(),
        dateSortie: (row[COL.dateSortie] instanceof Date) ? row[COL.dateSortie].toISOString() : '',
        conteneurOrigine: row[COL.conteneurOrigine] || '', agentCFS: row[COL.agentCFS],
      });
    });
  }
  return { total: total, attente: attente, sortis: sortis, conteneurs: conteneurs, dist: dist, vehicules: vehicules };
}

function _rapportVehicules_(session, p) {
  p = p || {};
  const du = p.du ? new Date(p.du + 'T00:00:00') : null;
  const au = p.au ? new Date(p.au + 'T23:59:59') : null;
  let agent = _txt_(p.agentCFS);
  // Cahier 3.4 NB : un compte voit/édite les rapports de TOUS les agents de sa cellule.
  const col = _collecteVehicules_(du, au, agent ? agent.toLowerCase() : '');
  const data = {
    periode: p.periode || 'personnalise', du: p.du || '', au: p.au || '',
    agent: agent || 'Tous les agents CFS',
    total: col.total, attente: col.attente, sortis: col.sortis, conteneurs: col.conteneurs, dist: col.dist,
  };
  if (p.format === 'pdf' || p.format === 'xlsx') return _exporterVehicules_(session, data, p.format, col.vehicules);
  _log_(session, 'Rapport véhicules (vue)', '', data.agent + ' · ' + (data.du || '…') + ' → ' + (data.au || '…'));
  return data;
}

function _rapportVehiculesDetail_(session, p) {
  p = p || {};
  const du = p.du ? new Date(p.du + 'T00:00:00') : null;
  const au = p.au ? new Date(p.au + 'T23:59:59') : null;
  let agent = _txt_(p.agentCFS);
  // Cahier 3.4 NB : un compte voit/édite les rapports de TOUS les agents de sa cellule.
  const col = _collecteVehicules_(du, au, agent ? agent.toLowerCase() : '');
  const m = p.metric;
  let rows = col.vehicules;
  if (m === 'attente') rows = rows.filter(function (r) { return r.statut !== STATUTS.SORTIE; });
  else if (m === 'sortis') rows = rows.filter(function (r) { return r.statut === STATUTS.SORTIE; });
  else if (m === 'conteneurs') rows = rows.filter(function (r) { return r.conteneurOrigine; });
  else if (['transit', 'conso', 'mad', 'abandon', 'autres'].indexOf(m) >= 0)
    rows = rows.filter(function (r) { return r.destBucket === m; });
  return { metric: m, rows: rows };
}

function _exporterVehicules_(session, data, format, vehicules) {
  const tz = Session.getScriptTimeZone();
  const recapEntetes = ['Indicateur', 'Valeur'];
  const recap = [
    ['Période', _libellePeriode_(data.periode)], ['Du', data.du || '—'], ['Au', data.au || '—'],
    ['Agent CFS', data.agent], ['', ''],
    ['Total véhicules', data.total], ['En attente de sortie', data.attente], ['Sortis', data.sortis],
    ['Conteneurs dépotés', data.conteneurs], ['', ''],
    ['Transit', data.dist.transit], ['Conso', data.dist.conso], ['MAD', data.dist.mad],
    ['Véhicule abandonné', data.dist.abandon], ['Autre / non précisé', data.dist.autres],
  ];
  const detEntetes = ['ID', 'N° Châssis (VIN)', 'Marque', 'Modèle', 'Couleur', 'Destination',
    'Statut', "Conteneur d'origine", 'Créé le', 'Sorti le', 'Agent CFS'];
  const det = (vehicules || []).map(function (r) {
    return [r.id, r.chassis, r.marque, r.modele, r.couleur, r.destination, r.statut,
      r.conteneurOrigine, _fmtDate_(r.dateCreation, tz), _fmtDate_(r.dateSortie, tz), r.agentCFS];
  });
  const titre = 'Rapport véhicules' + (data.agent && data.agent !== 'Tous les agents CFS' ? ' - ' + data.agent : '');
  _log_(session, 'Export véhicules ' + format.toUpperCase(), '', (data.du || '…') + ' → ' + (data.au || '…'));
  return _exporterClasseur_(titre, [
    { nom: 'Récapitulatif', titre: titre, entetes: recapEntetes, lignes: recap },
    { nom: 'Détails véhicules', titre: titre + ' — détails', entetes: detEntetes, lignes: det },
  ], format);
}

/* ------------- Rapports Balise & Porte Principale (génériques) --------- */
/**
 * Même logique que le rapport CFS, mais la date de référence et l'agent
 * dépendent du poste :
 *   - balise : date = pose GPS (datePoseGPS), agent = agentBalise
 *              -> ne compte QUE les camions effectivement balisés ;
 *   - pp     : date = sortie (dateSortie), agent = agentPP
 *              -> ne compte QUE les camions effectivement sortis.
 * En plus des tailles 20'/40'/45', on agrège le nombre de TWINS.
 */
function _activiteCfg_(kind) {
  const M = {
    balise: { dateKey: 'datePoseGPS', agentKey: 'agentBalise', role: ROLES.BALISE,
              titre: 'Rapport Balise', tous: 'Tous les agents Balise', dateLabel: 'pose GPS' },
    pp:     { dateKey: 'dateSortie',  agentKey: 'agentPP',     role: ROLES.PP,
              titre: 'Rapport PP',     tous: 'Tous les agents PP', dateLabel: 'sortie' },
  };
  return M[kind];
}

function _collecteActivite_(dateCol, agentCol, agentLc, du, au) {
  const vide = function () { return { camions: 0, conteneurs: 0, t20: 0, t40: 0, t45: 0, autres: 0, twins: 0, sansBalise: 0 }; };
  const agg = { enlevement: vide(), depotage: vide() };
  const camions = [], conteneurs = [];

  const sh = _sheet_(SHEETS.CARGOS);
  const last = sh.getLastRow();
  if (last >= 2) {
    const vals = sh.getRange(2, 1, last - 1, COLS.length).getValues();
    vals.forEach(function (row) {
      const d = row[dateCol];
      if (!(d instanceof Date)) return;            // étape non franchie -> ignoré
      if (du && d < du) return;
      if (au && d > au) return;
      if (agentLc && String(row[agentCol]).toLowerCase() !== agentLc) return;
      const op = row[COL.typeOperation];
      const bucket = (op === OPERATIONS.ENLEVEMENT) ? agg.enlevement
                   : (op === OPERATIONS.DEPOTAGE)   ? agg.depotage : null;
      if (!bucket) return;

      const dets = _detsDeRow_(row);
      const dISO = d.toISOString();
      const estTwins = String(row[COL.twins]) === 'Yes';
      const sansBalise = String(row[COL.baliseRequise]) === 'Non';
      bucket.camions++;
      if (estTwins) bucket.twins++;
      if (sansBalise) bucket.sansBalise++;
      camions.push({
        id: row[COL.id], numeroCamion: row[COL.numeroCamion], operation: op, statut: row[COL.statut],
        date: dISO, agent: row[agentCol], rapportId: row[COL.rapportId], numeroGPS: row[COL.numeroGPS],
        nbConteneurs: dets.length, twins: estTwins ? 'Yes' : 'No',
        baliseRequise: sansBalise ? 'Non' : 'Oui',
      });
      bucket.conteneurs += dets.length;
      dets.forEach(function (ct, idx) {
        const b = _tailleBucket_(ct && ct.taille);
        bucket[b]++;
        conteneurs.push({
          cargaisonId: row[COL.id], rapportId: row[COL.rapportId], numeroCamion: row[COL.numeroCamion],
          operation: op, ordre: idx + 1, conteneur: (ct && ct.num) || '', taille: (ct && ct.taille) || '',
          sizeBucket: b, typeConteneur: (ct && ct.type) || '', poids: (ct && ct.poids) || '',
          scelle: (ct && ct.plomb) || '', numeroGPS: row[COL.numeroGPS], statut: row[COL.statut],
          date: dISO, agent: row[agentCol],
        });
      });
    });
  }
  return { agg: agg, camions: camions, conteneurs: conteneurs };
}

/** Bornes + agent pour les rapports d'activité (poste = forcé à lui-même). */
function _bornesEtAgentAct_(session, cfg, p) {
  const du = p.du ? new Date(p.du + 'T00:00:00') : null;
  const au = p.au ? new Date(p.au + 'T23:59:59') : null;
  let agent = _txt_(p.agent);
  // Cahier 3.4 NB : un compte voit/édite les rapports de TOUS les agents de sa cellule.
  return { du: du, au: au, agent: agent, agentLc: agent ? agent.toLowerCase() : '' };
}

function _rapportActivite_(session, p) {
  p = p || {};
  const cfg = _activiteCfg_(p.kind);
  if (!cfg) throw new Error('Rapport inconnu.');
  const b = _bornesEtAgentAct_(session, cfg, p);
  const col = _collecteActivite_(COL[cfg.dateKey], COL[cfg.agentKey], b.agentLc, b.du, b.au);
  const E = col.agg.enlevement, D = col.agg.depotage;
  const data = {
    kind: p.kind, periode: p.periode || 'personnalise', du: p.du || '', au: p.au || '',
    agent: b.agent || cfg.tous, enlevement: E, depotage: D,
    totalCamions: E.camions + D.camions, totalConteneurs: E.conteneurs + D.conteneurs,
    totalTwins: E.twins + D.twins, totalSansBalise: E.sansBalise + D.sansBalise,
  };
  if (p.format === 'pdf' || p.format === 'xlsx')
    return _exporterActivite_(session, cfg, data, p.format, col.conteneurs, _txt_(p.operation));
  _log_(session, cfg.titre + ' (vue)', '', data.agent + ' · ' + (data.du || '…') + ' → ' + (data.au || '…'));
  return data;
}

function _rapportActiviteDetail_(session, p) {
  p = p || {};
  const cfg = _activiteCfg_(p.kind);
  if (!cfg) throw new Error('Rapport inconnu.');
  const b = _bornesEtAgentAct_(session, cfg, p);
  const col = _collecteActivite_(COL[cfg.dateKey], COL[cfg.agentKey], b.agentLc, b.du, b.au);
  const op = p.operation, metric = p.metric;
  if (metric === 'camions' || metric === 'twins') {
    let rows = col.camions;
    if (op) rows = rows.filter(function (c) { return c.operation === op; });
    if (metric === 'twins') rows = rows.filter(function (c) { return c.twins === 'Yes'; });
    return { kind: 'camions', operation: op, metric: metric, rows: rows };
  }
  let rows = col.conteneurs;
  if (op) rows = rows.filter(function (c) { return c.operation === op; });
  if (metric && metric !== 'conteneurs') rows = rows.filter(function (c) { return c.sizeBucket === metric; });
  return { kind: 'conteneurs', operation: op, metric: metric, rows: rows };
}

/** Bloc d'indicateurs d'une opération pour un rapport d'activité (avec TWINS). */
function _recapBlocAct_(nom, o) {
  const lignes = [
    [nom, ''],
    ['Camions', o.camions],
    ['TWINS', o.twins],
  ];
  if (o.sansBalise) lignes.push(['dont sans balise', o.sansBalise]);
  return lignes.concat([
    ["Conteneurs 20'", o.t20], ["Conteneurs 40'", o.t40], ["Conteneurs 45'", o.t45],
    ['Conteneurs autres / non précisé', o.autres],
    ['Total conteneurs', o.conteneurs],
    ['EVP', (o.t20 + 2 * (o.t40 + o.t45))],
  ]);
}

function _detailLignesAct_(detailConteneurs, operation, tz) {
  return (detailConteneurs || [])
    .filter(function (r) { return r.operation === operation; })
    .map(function (r) {
      return [r.rapportId, r.cargaisonId, r.numeroCamion, r.operation, r.ordre,
        r.conteneur, r.taille, _libelleTaille_(r.sizeBucket), r.typeConteneur, r.poids,
        r.scelle, r.numeroGPS, r.statut, _fmtDate_(r.date, tz), r.agent];
    });
}

/** Export DÉTAILLÉ (récap + détails) d'un rapport d'activité, séparé par opération. */
function _exporterActivite_(session, cfg, data, format, detailConteneurs, operation) {
  const E = data.enlevement, D = data.depotage;
  const recapEntetes = ['Indicateur', 'Valeur'];
  const detEntetes = ['N° Rapport', 'ID Cargaison', 'N° Camion', 'Opération', 'Ordre',
    'Conteneur', 'Taille', 'Catégorie', 'Type', 'Poids', 'Scellé', 'N° GPS', 'Statut',
    'Date ' + cfg.dateLabel, 'Agent'];
  const tz = Session.getScriptTimeZone();
  const cible = (operation === OPERATIONS.ENLEVEMENT || operation === OPERATIONS.DEPOTAGE) ? operation : '';
  const titre = cfg.titre + (cible ? ' ' + cible : '') +
    (data.agent && data.agent !== cfg.tous ? ' - ' + data.agent : '');
  const entete = _recapEnteteCFS_(data);   // période + agent

  let feuilles;
  if (cible) {
    const o = (cible === OPERATIONS.ENLEVEMENT) ? E : D;
    feuilles = [
      { nom: 'Récapitulatif', titre: titre, entetes: recapEntetes,
        lignes: entete.concat(_recapBlocAct_(cible.toUpperCase(), o)) },
      { nom: 'Détails ' + cible, titre: titre + ' — détails', entetes: detEntetes,
        lignes: _detailLignesAct_(detailConteneurs, cible, tz) },
    ];
  } else {
    const recap = entete
      .concat(_recapBlocAct_('ENLÈVEMENT', E)).concat([['', '']])
      .concat(_recapBlocAct_('DÉPOTAGE', D)).concat([['', ''],
        ['TOTAL camions', data.totalCamions], ['TOTAL TWINS', data.totalTwins],
        ['TOTAL conteneurs', data.totalConteneurs]]);
    feuilles = [
      { nom: 'Récapitulatif', titre: titre, entetes: recapEntetes, lignes: recap },
      { nom: 'Détails Enlèvement', titre: titre + ' — Enlèvement', entetes: detEntetes,
        lignes: _detailLignesAct_(detailConteneurs, OPERATIONS.ENLEVEMENT, tz) },
      { nom: 'Détails Dépotage', titre: titre + ' — Dépotage', entetes: detEntetes,
        lignes: _detailLignesAct_(detailConteneurs, OPERATIONS.DEPOTAGE, tz) },
    ];
  }
  _log_(session, 'Export ' + cfg.titre + ' ' + format.toUpperCase(), '',
    (cible || 'Tous') + ' · ' + data.agent + ' · ' + (data.du || '…') + ' → ' + (data.au || '…'));
  return _exporterClasseur_(titre, feuilles, format);
}

/** Classe une taille de conteneur dans 20 / 40 / 45 / autres. */
function _tailleBucket_(t) {
  const s = String(t || '').replace(/[''’\s]/g, '');
  if (s.indexOf('20') === 0) return 't20';
  if (s.indexOf('40') === 0) return 't40';
  if (s.indexOf('45') === 0) return 't45';
  return 'autres';
}

function _libellePeriode_(p) {
  return { jour: 'Journalier', semaine: 'Hebdomadaire', mois: 'Mensuel',
           personnalise: 'Plage personnalisée' }[p] || 'Plage personnalisée';
}

function _libelleTaille_(b) {
  return { t20: "20'", t40: "40'", t45: "45'", autres: 'Autre / non précisé' }[b] || b;
}

/** En-tête commun du récap (période + agent). */
function _recapEnteteCFS_(data) {
  return [
    ['Période', _libellePeriode_(data.periode)],
    ['Du', data.du || '—'], ['Au', data.au || '—'],
    ['Agent CFS', data.agent], ['', ''],
  ];
}
/** Bloc d'indicateurs d'une opération. */
function _recapBlocCFS_(nom, o) {
  return [
    [nom, ''],
    ['Camions', o.camions],
    ["Conteneurs 20'", o.t20], ["Conteneurs 40'", o.t40], ["Conteneurs 45'", o.t45],
    ['Conteneurs autres / non précisé', o.autres],
    ['Total conteneurs', o.conteneurs],
    ['EVP', (o.t20 + 2 * (o.t40 + o.t45))],
  ];
}
/** Lignes de détail (1 conteneur/ligne) pour une opération donnée. */
function _detailLignesCFS_(detailConteneurs, operation, tz) {
  return (detailConteneurs || [])
    .filter(function (r) { return r.operation === operation; })
    .map(function (r) {
      return [r.rapportId, r.cargaisonId, r.numeroCamion, r.operation, r.ordre,
        r.conteneur, r.taille, _libelleTaille_(r.sizeBucket), r.typeConteneur, r.poids,
        r.scelle, r.statut, _fmtDate_(r.dateCreation, tz), r.agentCFS];
    });
}

/**
 * Fichier (PDF/Excel) DÉTAILLÉ de la synthèse CFS, avec SÉPARATION par opération :
 *   - operation = 'Enlèvement' | 'Dépotage' -> Récap (cette op) + Détails (cette op)
 *   - operation = '' (Tous)                 -> Récap global + Détails Enlèvement
 *                                              + Détails Dépotage (feuilles séparées)
 */
function _exporterCFS_(session, data, format, detailConteneurs, operation) {
  const E = data.enlevement, D = data.depotage;
  const recapEntetes = ['Indicateur', 'Valeur'];
  const detEntetes = ['N° Rapport', 'ID Cargaison', 'N° Camion', 'Opération', 'Ordre',
    'Conteneur', 'Taille', 'Catégorie', 'Type', 'Poids', 'Scellé', 'Statut', 'Date création', 'Agent CFS'];
  const tz = Session.getScriptTimeZone();
  const cible = (operation === OPERATIONS.ENLEVEMENT || operation === OPERATIONS.DEPOTAGE) ? operation : '';
  const titre = 'Rapport CFS' + (cible ? ' ' + cible : '') +
    (data.agent && data.agent !== 'Tous les agents CFS' ? ' - ' + data.agent : '');

  let feuilles;
  if (cible) {
    const o = (cible === OPERATIONS.ENLEVEMENT) ? E : D;
    const recap = _recapEnteteCFS_(data).concat(_recapBlocCFS_(cible.toUpperCase(), o));
    feuilles = [
      { nom: 'Récapitulatif',       titre: titre,                 entetes: recapEntetes, lignes: recap },
      { nom: 'Détails ' + cible,    titre: titre + ' — détails',  entetes: detEntetes,
        lignes: _detailLignesCFS_(detailConteneurs, cible, tz) },
    ];
  } else {
    const recap = _recapEnteteCFS_(data)
      .concat(_recapBlocCFS_('ENLÈVEMENT', E)).concat([['', '']])
      .concat(_recapBlocCFS_('DÉPOTAGE', D)).concat([['', ''],
        ['TOTAL camions', data.totalCamions], ['TOTAL conteneurs', data.totalConteneurs]]);
    feuilles = [
      { nom: 'Récapitulatif',      titre: titre,                       entetes: recapEntetes, lignes: recap },
      { nom: 'Détails Enlèvement', titre: titre + ' — Enlèvement',     entetes: detEntetes,
        lignes: _detailLignesCFS_(detailConteneurs, OPERATIONS.ENLEVEMENT, tz) },
      { nom: 'Détails Dépotage',   titre: titre + ' — Dépotage',       entetes: detEntetes,
        lignes: _detailLignesCFS_(detailConteneurs, OPERATIONS.DEPOTAGE, tz) },
    ];
  }

  _log_(session, 'Export Rapport CFS ' + format.toUpperCase(), '',
    (cible || 'Tous') + ' · ' + data.agent + ' · ' + (data.du || '…') + ' → ' + (data.au || '…'));
  return _exporterClasseur_(titre, feuilles, format);
}

/* =========================== Analyse des flux ========================== */
/**
 * Throughput dans le temps aux 3 points de contrôle : ce qui ENTRE au CFS
 * (créations), ce qui SORT de la Balise (poses + sans balise), ce qui SORT de la
 * PP (sorties), en camions ET conteneurs, agrégé par jour / semaine / mois.
 * Une période vide reste affichée (zéros) pour comparer d'une période à l'autre.
 * Payload : { du, au, granularite:'jour'|'semaine'|'mois', format? }
 */
function _lundiDe_(d) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const day = (x.getDay() + 6) % 7;            // 0 = lundi
  x.setDate(x.getDate() - day);
  return x;
}
function _fluxPeriode_(d, gran, tz) {
  if (gran === 'mois')
    return { key: Utilities.formatDate(d, tz, 'yyyy-MM'), label: Utilities.formatDate(d, tz, 'MM/yyyy') };
  if (gran === 'semaine') {
    const mon = _lundiDe_(d);
    return { key: Utilities.formatDate(mon, tz, 'yyyy-MM-dd'), label: 'Sem. ' + Utilities.formatDate(mon, tz, 'dd/MM') };
  }
  return { key: Utilities.formatDate(d, tz, 'yyyy-MM-dd'), label: Utilities.formatDate(d, tz, 'dd/MM') };
}
/** Liste ordonnée des périodes entre du et au (incluant les périodes vides). */
function _genererPeriodes_(du, au, gran, tz) {
  const out = [], seen = {};
  let cur = new Date(du.getFullYear(), du.getMonth(), du.getDate());
  let guard = 0;
  while (cur <= au && guard < 1200) {
    guard++;
    const p = _fluxPeriode_(cur, gran, tz);
    if (!seen[p.key]) { seen[p.key] = true; out.push(p); }
    if (gran === 'mois') cur = new Date(cur.getFullYear(), cur.getMonth() + 1, 1);
    else if (gran === 'semaine') cur = new Date(cur.getFullYear(), cur.getMonth(), cur.getDate() + 7);
    else cur = new Date(cur.getFullYear(), cur.getMonth(), cur.getDate() + 1);
  }
  return out;
}
function _libelleGran_(g) { return { jour: 'journalier', semaine: 'hebdomadaire', mois: 'mensuel' }[g] || g; }

function _rapportFlux_(session, p) {
  p = p || {};
  const tz = Session.getScriptTimeZone();
  const gran = (['jour', 'semaine', 'mois'].indexOf(p.granularite) >= 0) ? p.granularite : 'jour';
  let du = p.du ? new Date(p.du + 'T00:00:00') : null;
  let au = p.au ? new Date(p.au + 'T23:59:59') : null;
  if (!du || !au) {                              // défaut : 30 derniers jours
    au = new Date();
    du = new Date(); du.setDate(du.getDate() - 29); du.setHours(0, 0, 0, 0);
  }
  const periodes = _genererPeriodes_(du, au, gran, tz);
  const map = {};
  periodes.forEach(function (pp) {
    map[pp.key] = { key: pp.key, label: pp.label, cfsCamions: 0, cfsCont: 0,
      baliseCamions: 0, baliseCont: 0, sansBalise: 0, ppCamions: 0, ppCont: 0 };
  });
  const within = function (d) { return d instanceof Date && d >= du && d <= au; };
  const bk = function (d) { return map[_fluxPeriode_(d, gran, tz).key]; };

  const sh = _sheet_(SHEETS.CARGOS);
  const last = sh.getLastRow();
  if (last >= 2) {
    const vals = sh.getRange(2, 1, last - 1, COLS.length).getValues();
    vals.forEach(function (row) {
      if (String(row[COL.estVehicule]) === 'Oui') return;   // véhicules suivis à part
      const nb = _detsDeRow_(row).length;
      const dc = row[COL.dateCreation], dg = row[COL.datePoseGPS], ds = row[COL.dateSortie];
      let m;
      if (within(dc) && (m = bk(dc))) { m.cfsCamions++; m.cfsCont += nb; }
      if (within(dg) && (m = bk(dg))) {
        m.baliseCamions++; m.baliseCont += nb;
        if (String(row[COL.baliseRequise]) === 'Non') m.sansBalise++;
      }
      if (within(ds) && (m = bk(ds))) { m.ppCamions++; m.ppCont += nb; }
    });
  }
  const lignes = periodes.map(function (pp) { return map[pp.key]; });
  const tot = lignes.reduce(function (a, m) {
    a.cfsCamions += m.cfsCamions; a.cfsCont += m.cfsCont;
    a.baliseCamions += m.baliseCamions; a.baliseCont += m.baliseCont; a.sansBalise += m.sansBalise;
    a.ppCamions += m.ppCamions; a.ppCont += m.ppCont; return a;
  }, { cfsCamions: 0, cfsCont: 0, baliseCamions: 0, baliseCont: 0, sansBalise: 0, ppCamions: 0, ppCont: 0 });

  const data = {
    granularite: gran,
    du: p.du || Utilities.formatDate(du, tz, 'yyyy-MM-dd'),
    au: p.au || Utilities.formatDate(au, tz, 'yyyy-MM-dd'),
    lignes: lignes, totaux: tot,
  };
  if (p.format === 'pdf' || p.format === 'xlsx') { data.format = p.format; return _exporterFlux_(session, data); }
  _log_(session, 'Rapport flux (vue)', '', gran + ' · ' + data.du + ' → ' + data.au);
  return data;
}

/**
 * Détail derrière une carte/cellule du rapport flux : liste des camions dont la
 * date au point de contrôle choisi tombe dans la période (ou toute la plage si
 * periodKey vide). point = 'cfs' | 'balise' | 'pp' | 'sansbalise'.
 */
function _rapportFluxDetail_(session, p) {
  p = p || {};
  const tz = Session.getScriptTimeZone();
  const gran = (['jour', 'semaine', 'mois'].indexOf(p.granularite) >= 0) ? p.granularite : 'jour';
  let du = p.du ? new Date(p.du + 'T00:00:00') : null;
  let au = p.au ? new Date(p.au + 'T23:59:59') : null;
  if (!du || !au) { au = new Date(); du = new Date(); du.setDate(du.getDate() - 29); du.setHours(0, 0, 0, 0); }
  const sansBalise = (p.point === 'sansbalise');
  const dateCol = COL[(p.point === 'balise' || sansBalise) ? 'datePoseGPS' : (p.point === 'pp' ? 'dateSortie' : 'dateCreation')];
  const key = p.periodKey || '';

  const rows = [];
  const sh = _sheet_(SHEETS.CARGOS);
  const last = sh.getLastRow();
  if (last >= 2) {
    const vals = sh.getRange(2, 1, last - 1, COLS.length).getValues();
    vals.forEach(function (row) {
      if (String(row[COL.estVehicule]) === 'Oui') return;   // véhicules suivis à part
      const d = row[dateCol];
      if (!(d instanceof Date) || d < du || d > au) return;
      if (sansBalise && String(row[COL.baliseRequise]) !== 'Non') return;
      if (key && _fluxPeriode_(d, gran, tz).key !== key) return;
      rows.push({
        id: row[COL.id], numeroCamion: row[COL.numeroCamion], operation: row[COL.typeOperation],
        statut: row[COL.statut], date: d.toISOString(), nbConteneurs: _detsDeRow_(row).length,
        numeroGPS: row[COL.numeroGPS], baliseRequise: row[COL.baliseRequise] || '',
      });
    });
  }
  rows.sort(function (a, b) { return _ts_(b.date) - _ts_(a.date); });
  return { point: p.point, periodKey: key, rows: rows };
}

function _exporterFlux_(session, data) {
  const entetes = ['Période', 'Camions créés (CFS)', 'Conteneurs CFS', 'Camions balisés',
    'Conteneurs Balise', 'dont sans balise', 'Camions sortis (PP)', 'Conteneurs PP'];
  const lignes = data.lignes.map(function (m) {
    return [m.label, m.cfsCamions, m.cfsCont, m.baliseCamions, m.baliseCont, m.sansBalise, m.ppCamions, m.ppCont];
  });
  const t = data.totaux;
  lignes.push(['TOTAL', t.cfsCamions, t.cfsCont, t.baliseCamions, t.baliseCont, t.sansBalise, t.ppCamions, t.ppCont]);
  const titre = 'Analyse des flux (' + _libelleGran_(data.granularite) + ') ' + data.du + ' au ' + data.au;
  _log_(session, 'Export flux', '', data.du + ' → ' + data.au);
  return _exporter_(titre, entetes, lignes, data.format === 'pdf' ? 'pdf' : 'xlsx');
}

/* =============== Délai de séjour & camions en instance ================= */
/**
 * Aide à la décision : pour chaque camion, délai = sortie − création (s'il est
 * sorti) sinon âge = aujourd'hui − création (camion EN INSTANCE). Répartition par
 * tranches de jours + liste des camions non sortis (du plus vieux au plus récent),
 * alerte au-delà de SEUIL jours (« 90 jours, pourquoi pas sorti ? on va le chercher »).
 * Payload : { format? }
 */
const TRANCHES_SEJOUR = ['0-7', '8-15', '16-30', '31-60', '61-90', '90+'];
function _trancheAge_(j) {
  if (j <= 7) return '0-7';
  if (j <= 15) return '8-15';
  if (j <= 30) return '16-30';
  if (j <= 60) return '31-60';
  if (j <= 90) return '61-90';
  return '90+';
}

function _rapportSejour_(session, p) {
  p = p || {};
  const SEUIL = 90;
  const now = new Date();
  const jours = function (a, b) { return Math.floor((b - a) / 86400000); };
  const dist = {};
  TRANCHES_SEJOUR.forEach(function (t) { dist[t] = { tranche: t, instance: 0, sortis: 0 }; });
  const instance = [];
  let totInstance = 0, totSortis = 0, sommeDelai = 0, nDelai = 0, alerte = 0;

  const sh = _sheet_(SHEETS.CARGOS);
  const last = sh.getLastRow();
  if (last >= 2) {
    const vals = sh.getRange(2, 1, last - 1, COLS.length).getValues();
    vals.forEach(function (row) {
      if (String(row[COL.estVehicule]) === 'Oui') return;   // véhicules suivis à part
      const dc = row[COL.dateCreation];
      if (!(dc instanceof Date)) return;
      const statut = row[COL.statut];
      const ds = row[COL.dateSortie];
      if (statut === STATUTS.SORTIE && ds instanceof Date) {
        const j = Math.max(0, jours(dc, ds));
        dist[_trancheAge_(j)].sortis++; totSortis++; sommeDelai += j; nDelai++;
      } else {
        const j = Math.max(0, jours(dc, now));
        const tr = _trancheAge_(j);
        dist[tr].instance++; totInstance++;
        if (j >= SEUIL) alerte++;
        instance.push({
          id: row[COL.id], numeroCamion: row[COL.numeroCamion], operation: row[COL.typeOperation],
          statut: statut, dateCreation: dc.toISOString(), ageJours: j, tranche: tr,
          numeroGPS: row[COL.numeroGPS], agentCFS: row[COL.agentCFS], rapportId: row[COL.rapportId],
        });
      }
    });
  }
  instance.sort(function (a, b) { return b.ageJours - a.ageJours; });  // plus vieux d'abord
  const data = {
    seuilAlerte: SEUIL,
    tranches: TRANCHES_SEJOUR.map(function (t) { return dist[t]; }),
    instance: instance, totalInstance: totInstance, totalSortis: totSortis,
    alerte: alerte, delaiMoyen: nDelai ? Math.round(sommeDelai / nDelai) : 0,
  };
  if (p.format === 'pdf' || p.format === 'xlsx') return _exporterSejour_(session, data, p.format);
  _log_(session, 'Rapport séjour (vue)', '', totInstance + ' en instance · ' + alerte + ' ≥ ' + SEUIL + 'j');
  return data;
}

/**
 * Détail derrière une carte/tranche du rapport séjour.
 *   bucket = 'instance' (non sortis) | 'sortis' | 'alerte' (non sortis ≥ SEUIL j)
 *   tranche (optionnel) = '0-7' … '90+' pour ne garder qu'une tranche.
 */
function _rapportSejourDetail_(session, p) {
  p = p || {};
  const bucket = p.bucket || 'instance';
  const tranche = p.tranche || '';
  const SEUIL = 90;
  const now = new Date();
  const jours = function (a, b) { return Math.floor((b - a) / 86400000); };

  const rows = [];
  const sh = _sheet_(SHEETS.CARGOS);
  const last = sh.getLastRow();
  if (last >= 2) {
    const vals = sh.getRange(2, 1, last - 1, COLS.length).getValues();
    vals.forEach(function (row) {
      if (String(row[COL.estVehicule]) === 'Oui') return;   // véhicules suivis à part
      const dc = row[COL.dateCreation];
      if (!(dc instanceof Date)) return;
      const statut = row[COL.statut];
      const ds = row[COL.dateSortie];
      const estSorti = (statut === STATUTS.SORTIE && ds instanceof Date);
      const j = estSorti ? Math.max(0, jours(dc, ds)) : Math.max(0, jours(dc, now));
      const tr = _trancheAge_(j);
      if (bucket === 'instance' && estSorti) return;
      if (bucket === 'sortis' && !estSorti) return;
      if (bucket === 'alerte' && (estSorti || j < SEUIL)) return;
      if (tranche && tr !== tranche) return;
      rows.push({
        id: row[COL.id], numeroCamion: row[COL.numeroCamion], operation: row[COL.typeOperation],
        statut: statut, dateCreation: dc.toISOString(), dateSortie: estSorti ? ds.toISOString() : '',
        ageJours: j, tranche: tr, sorti: estSorti, numeroGPS: row[COL.numeroGPS], agentCFS: row[COL.agentCFS],
      });
    });
  }
  rows.sort(function (a, b) { return b.ageJours - a.ageJours; });
  return { bucket: bucket, tranche: tranche, rows: rows };
}

function _exporterSejour_(session, data, format) {
  const tz = Session.getScriptTimeZone();
  const recapEntetes = ['Tranche (jours)', 'Camions en instance', 'Camions sortis'];
  const recap = data.tranches.map(function (t) { return [t.tranche, t.instance, t.sortis]; });
  recap.push(['TOTAL', data.totalInstance, data.totalSortis]);
  const detEntetes = ['ID', 'N° Camion', 'Opération', 'Statut', 'Créé le', 'Âge (jours)', 'Tranche', 'N° GPS', 'Agent CFS'];
  const det = data.instance.map(function (r) {
    return [r.id, r.numeroCamion, r.operation, r.statut, _fmtDate_(r.dateCreation, tz),
      r.ageJours, r.tranche, r.numeroGPS, r.agentCFS];
  });
  const titre = 'Délai de séjour & camions en instance';
  _log_(session, 'Export séjour ' + format.toUpperCase(), '', data.totalInstance + ' en instance');
  return _exporterClasseur_(titre, [
    { nom: 'Répartition', titre: titre + ' — répartition (délai moyen sortis : ' + data.delaiMoyen + ' j)',
      entetes: recapEntetes, lignes: recap },
    { nom: 'Camions en instance', titre: titre + ' — ' + data.totalInstance + ' camion(s) non sorti(s)',
      entetes: detEntetes, lignes: det },
  ], format);
}

/* ========================= KPI stock & flux (EVP) ===================== */
/**
 * Snapshot KPI : conteneurs vidés (dépotage), sortis scellés (enlèvement), flux
 * camions (actifs / sortis), stock physique par taille — le tout AUSSI en EVP
 * (20'=1 ; 40'=45'=2). du/au filtrent sur la date de création.
 */
function _rapportKPI_(session, p) {
  p = p || {};
  const du = p.du ? new Date(p.du + 'T00:00:00') : null;
  const au = p.au ? new Date(p.au + 'T23:59:59') : null;
  const vide = function () { return { conteneurs: 0, t20: 0, t40: 0, t45: 0, autres: 0, evp: 0 }; };
  const dep = vide(), enl = vide();
  let camActifs = 0, camSortis = 0, camTotal = 0;

  const sh = _sheet_(SHEETS.CARGOS);
  const last = sh.getLastRow();
  if (last >= 2) {
    const vals = sh.getRange(2, 1, last - 1, COLS.length).getValues();
    vals.forEach(function (row) {
      if (String(row[COL.estVehicule]) === 'Oui') return;
      const d = row[COL.dateCreation];
      if (du && (!(d instanceof Date) || d < du)) return;
      if (au && (!(d instanceof Date) || d > au)) return;
      camTotal++;
      if (String(row[COL.statut]) === STATUTS.SORTIE) camSortis++; else camActifs++;
      const op = row[COL.typeOperation];
      const bucket = op === OPERATIONS.DEPOTAGE ? dep : op === OPERATIONS.ENLEVEMENT ? enl : null;
      if (!bucket) return;
      _detsDeRow_(row).forEach(function (ct) {
        const b = _tailleBucket_(ct && ct.taille); bucket[b]++; bucket.conteneurs++; bucket.evp += evpDeTaille(b);
      });
    });
  }
  const stock = _listerStock_({ statut: 'tous' }).compte;
  const data = { du: p.du || '', au: p.au || '', depotage: dep, enlevement: enl,
    camions: { actifs: camActifs, sortis: camSortis, total: camTotal }, stock: stock };
  if (p.format === 'pdf' || p.format === 'xlsx') return _exporterKPI_(session, data, p.format);
  return data;
}
function _exporterKPI_(session, data, format) {
  const D = data.depotage, E = data.enlevement, S = data.stock;
  const e = ['Indicateur', 'Conteneurs', 'EVP'];
  const lignes = [
    ['Période', '', ''], ['Du', data.du || '—', ''], ['Au', data.au || '—', ''], ['', '', ''],
    ['Conteneurs vidés (Dépotage)', D.conteneurs, D.evp],
    ['Conteneurs sortis scellés (Enlèvement)', E.conteneurs, E.evp], ['', '', ''],
    ['Stock total', S.total, S.evp],
    ["  dont 20'", S.t20, S.t20], ["  dont 40'", S.t40, S.t40 * 2], ["  dont 45'", S.t45, S.t45 * 2],
    ['Stock — En stock', S.stock, ''], ['Stock — Positionné', S.positionne, ''], ['Stock — Dépoté', S.depote, ''],
    ['', '', ''], ['Camions actifs', data.camions.actifs, ''], ['Camions sortis', data.camions.sortis, ''],
  ];
  _log_(session, 'Export KPI ' + format.toUpperCase(), '', (data.du || '…') + ' → ' + (data.au || '…'));
  return _exporter_('KPI stock & flux (EVP)', e, lignes, format);
}

/* ======================= Suivi des dispenses ========================== */
/** Dispenses (balise dispensée) : total / en cours / terminées (arrivée bureau). */
function _rapportDispenses_(session, p) {
  p = p || {};
  const du = p.du ? new Date(p.du + 'T00:00:00') : null;
  const au = p.au ? new Date(p.au + 'T23:59:59') : null;
  let total = 0, enCours = 0, terminees = 0;
  const rows = [];
  const sh = _sheet_(SHEETS.CARGOS);
  const last = sh.getLastRow();
  if (last >= 2) {
    const vals = sh.getRange(2, 1, last - 1, COLS.length).getValues();
    vals.forEach(function (row) {
      const disp = String(row[COL.baliseRequise]) === 'Non' || String(row[COL.sauteBalise]) === 'Oui';
      if (!disp) return;
      const d = row[COL.dateCreation];
      if (du && (!(d instanceof Date) || d < du)) return;
      if (au && (!(d instanceof Date) || d > au)) return;
      total++;
      const arrivee = String(row[COL.arriveeBureau]) === 'Oui';
      if (arrivee) terminees++; else enCours++;
      rows.push({ id: row[COL.id], numeroCamion: row[COL.numeroCamion], operation: row[COL.typeOperation],
        statut: row[COL.statut], numeroDispense: row[COL.numeroDispense], bureauDestination: row[COL.bureauDestination],
        dateSortie: (row[COL.dateSortie] instanceof Date) ? row[COL.dateSortie].toISOString() : '',
        arrivee: arrivee ? 'Oui' : 'Non' });
    });
  }
  rows.sort(function (a, b) { return (a.arrivee === b.arrivee) ? 0 : (a.arrivee === 'Oui' ? 1 : -1); });
  return { total: total, enCours: enCours, terminees: terminees, rows: rows };
}

/* =============== Délai de séjour & instances — CONTENEURS (stock) ====== */
/**
 * Équivalent du rapport « séjour camions » côté STOCK : pour chaque conteneur encore
 * présent (≠ Dépoté), séjour = aujourd'hui − date d'entrée. Répartition par tranches
 * d'âge + totaux (en stock / positionnés / pointés / dépotés / EVP) + répartition tailles.
 */
function _rapportStock_(session, p) {
  p = p || {};
  const sh = _sheet_(SHEETS.STOCK);
  const last = sh.getLastRow();
  const tz = Session.getScriptTimeZone();
  const now = new Date();
  const SEUIL = 90;
  const dist = {}; TRANCHES_SEJOUR.forEach(function (t) { dist[t] = 0; });
  const compte = { total: 0, stock: 0, positionne: 0, depote: 0, pointes: 0, evp: 0, t20: 0, t40: 0, t45: 0, autres: 0 };
  const instances = []; let alerte = 0, sommeJ = 0, nJ = 0;
  if (last >= 2) {
    const vals = sh.getRange(2, 1, last - 1, STOCK_COLS.length).getValues();
    vals.forEach(function (r) {
      const o = _stockObj_(r);
      if (!o.numeroTC) return;
      compte.total++; const b = _tailleBucket_(o.taille); compte[b]++; compte.evp += evpDeTaille(b);
      if (o.statut === STOCK_STATUTS.STOCK) compte.stock++;
      else if (o.statut === STOCK_STATUTS.POSITIONNE) compte.positionne++;
      else if (o.statut === STOCK_STATUTS.DEPOTE) compte.depote++;
      if (o.datePointage) compte.pointes++;
      const jours = (o.dateEntree instanceof Date)
        ? Math.max(0, Math.floor((now - o.dateEntree) / 86400000)) : (Number(o.nbSejoursImport || 0) || 0);
      if (o.statut !== STOCK_STATUTS.DEPOTE) {
        const tr = _trancheAge_(jours); dist[tr]++; sommeJ += jours; nJ++;
        if (jours >= SEUIL) alerte++;
        instances.push({ numeroTC: o.numeroTC, taille: o.taille, typeConteneur: o.typeConteneur, statut: o.statut,
          dateEntree: _fmtDate_(o.dateEntree, tz), joursSejour: jours, tranche: tr,
          datePointage: _fmtDate_(o.datePointage, tz), pointePar: o.pointePar });
      }
    });
  }
  instances.sort(function (a, b) { return b.joursSejour - a.joursSejour; });
  const data = { seuilAlerte: SEUIL, compte: compte,
    tranches: TRANCHES_SEJOUR.map(function (t) { return { tranche: t, n: dist[t] }; }),
    instances: instances, alerte: alerte, sejourMoyen: nJ ? Math.round(sommeJ / nJ) : 0 };
  if (p.format === 'pdf' || p.format === 'xlsx') return _exporterStock_(session, data, p.format);
  _log_(session, 'Rapport stock (vue)', '', compte.total + ' conteneurs · ' + alerte + ' ≥ ' + SEUIL + 'j');
  return data;
}

function _exporterStock_(session, data, format) {
  const c = data.compte;
  const recE = ['Indicateur', 'Valeur'];
  const rec = [
    ['Total conteneurs', c.total], ['En stock', c.stock], ['Positionnés', c.positionne],
    ['Pointés', c.pointes], ['Dépotés (sortis du stock)', c.depote], ['EVP', c.evp], ['', ''],
    ["20'", c.t20], ["40'", c.t40], ["45'", c.t45], ['Autres', c.autres], ['', ''],
    ['Séjour moyen (jours)', data.sejourMoyen], ['En instance ≥ ' + data.seuilAlerte + ' j', data.alerte],
  ];
  const trE = ['Tranche (jours)', 'Conteneurs en stock'];
  const tr = data.tranches.map(function (t) { return [t.tranche, t.n]; });
  const detE = ['N° TC', 'Taille', 'Type', 'Statut', 'Entré le', 'Séjour (jours)', 'Tranche', 'Pointé le', 'Pointé par'];
  const det = data.instances.map(function (r) {
    return [r.numeroTC, r.taille, r.typeConteneur, r.statut, r.dateEntree, r.joursSejour, r.tranche, r.datePointage, r.pointePar];
  });
  const titre = 'Stock conteneurs — séjour & instances';
  _log_(session, 'Export stock ' + format.toUpperCase(), '', data.compte.total + ' conteneurs');
  return _exporterClasseur_(titre, [
    { nom: 'Récapitulatif', titre: titre, entetes: recE, lignes: rec },
    { nom: 'Tranches de séjour', titre: titre + ' — tranches', entetes: trE, lignes: tr },
    { nom: 'Conteneurs en stock', titre: titre + ' — détail', entetes: detE, lignes: det },
  ], format);
}

/* --------------------------- Rapports de listes ------------------------ */

const RAPPORTS_LISTE = {
  enregistrees:   { titre: 'Cargaisons enregistrées', statut: null },
  attente_gps:    { titre: 'Cargaisons en attente de GPS', statut: STATUTS.CREEE },
  attente_sortie: { titre: 'Cargaisons en attente de sortie', statut: STATUTS.GPS },
  sorties:        { titre: 'Cargaisons sorties', statut: STATUTS.SORTIE },
};

function _rapportListe_(session, p) {
  const def = RAPPORTS_LISTE[p.type];
  if (!def) throw new Error('Type de rapport inconnu.');
  const format = (p.format === 'pdf') ? 'pdf' : 'xlsx';

  const sh = _sheet_(SHEETS.CARGOS);
  const last = sh.getLastRow();
  let data = last < 2 ? [] : _lireColonnesResume_(sh, last).map(_serialiser_);
  if (def.statut) data = data.filter(r => r.statut === def.statut);
  data.sort((a, b) => _ts_(b.dateCreation) - _ts_(a.dateCreation));

  const tz = Session.getScriptTimeZone();
  const entetes = ['ID', 'Référence', 'Date création', 'N° Camion', 'Opération',
                   'Conteneur 1', 'Statut', 'N° GPS', 'Date sortie', 'Agent CFS'];
  const lignes = data.map(r => [
    r.id, r.reference, _fmtDate_(r.dateCreation, tz), r.numeroCamion, r.typeOperation,
    r.conteneur1, r.statut, r.numeroGPS, _fmtDate_(r.dateSortie, tz), r.agentCFS,
  ]);

  _log_(session, 'Export ' + format.toUpperCase(), '', def.titre + ' (' + lignes.length + ')');
  return _exporter_(def.titre, entetes, lignes, format);
}

/* --------------------------- Rapport historique ------------------------ */

function _rapportHistorique_(session, p) {
  const format = (p.format === 'pdf') ? 'pdf' : 'xlsx';
  const h = _listerHistorique_({ page: 1, pageSize: 100000, username: p.username, du: p.du, au: p.au });
  const entetes = ['Date/Heure', 'Utilisateur', 'Nom', 'Rôle', 'Action', 'ID Cargaison', 'Détails'];
  const lignes = h.rows.map(r => [r.timestamp, r.username, r.nomComplet, r.role, r.action, r.cargaisonId, r.details]);
  const titre = 'Historique' + (p.username ? ' - ' + p.username : '');
  _log_(session, 'Export historique ' + format.toUpperCase(), '', '(' + lignes.length + ')');
  return _exporter_(titre, entetes, lignes, format);
}

/* ----------------- Moteur d'export (classeur temporaire) --------------- */

/** Remplit (titre + entêtes + données + mise en forme) une feuille du classeur. */
function _remplirFeuille_(sh, titre, entetes, lignes) {
  sh.getRange(1, 1).setValue('Suivi des Cargaisons — ' + titre)
    .setFontSize(14).setFontWeight('bold').setFontColor('#2e6da4');
  sh.getRange(2, 1).setValue('Généré le ' +
    Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'dd/MM/yyyy HH:mm') +
    ' · ' + lignes.length + ' ligne(s)').setFontColor('#8aa1b1');
  sh.getRange(4, 1, 1, entetes.length).setValues([entetes])
    .setBackground('#2e6da4').setFontColor('#ffffff').setFontWeight('bold');
  if (lignes.length) {
    const dataRange = sh.getRange(5, 1, lignes.length, entetes.length);
    // Format TEXTE imposé AVANT l'écriture : empêche Excel/Sheets de reconvertir
    // les dates « dd/MM/yyyy HH:mm » en nombre (sinon « ##### » dans le .xlsx).
    dataRange.setNumberFormat('@');
    dataRange.setValues(lignes);
    sh.getRange(4, 1, lignes.length + 1, entetes.length)
      .setBorder(true, true, true, true, true, true, '#d7e2ec', SpreadsheetApp.BorderStyle.SOLID);
  }
  sh.setFrozenRows(4);
  sh.autoResizeColumns(1, entetes.length);
}

/** Construit l'URL d'export Google (PDF d'une feuille précise, ou xlsx complet). */
function _urlExport_(id, format, gid) {
  let url = 'https://docs.google.com/spreadsheets/d/' + id + '/export?';
  if (format === 'pdf') {
    url += 'format=pdf' + (gid != null ? '&gid=' + gid : '') +
      '&size=A4&portrait=true&fitw=true&gridlines=false&sheetnames=true' +
      '&printtitle=false&pagenumbers=true&fzr=true' +
      '&top_margin=0.50&bottom_margin=0.50&left_margin=0.50&right_margin=0.50';
  } else {
    url += 'format=xlsx';
  }
  return url;
}

/** Récupère le fichier exporté (octets) depuis Google avec le jeton OAuth. */
function _recupererExport_(url, format) {
  const resp = UrlFetchApp.fetch(url, {
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
    muteHttpExceptions: true,
  });
  if (resp.getResponseCode() !== 200) {
    throw new Error('Export ' + format.toUpperCase() + ' indisponible (code ' +
      resp.getResponseCode() + '). Réautorisez le script puis redéployez.');
  }
  return resp.getBlob();
}

/** Export d'UNE feuille (titre + entêtes + lignes) en xlsx/pdf. */
function _exporter_(titre, entetes, lignes, format) {
  const temp = SpreadsheetApp.create('TMP_' + Date.now());
  const id = temp.getId();
  try {
    const sh = temp.getSheets()[0];
    sh.setName('Rapport');
    _remplirFeuille_(sh, titre, entetes, lignes);
    SpreadsheetApp.flush();
    const isPdf = (format === 'pdf');
    const blob = _recupererExport_(_urlExport_(id, isPdf ? 'pdf' : 'xlsx', sh.getSheetId()), format);
    const ext = isPdf ? '.pdf' : '.xlsx';
    const mime = isPdf ? MIME.PDF : MIME.XLSX;
    const nomFichier = titre.replace(/[^\w\-]+/g, '_') + '_' +
      Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyyMMdd') + ext;
    return _blobVersClient_(blob.setName(nomFichier), nomFichier, mime);
  } finally {
    DriveApp.getFileById(id).setTrashed(true);
  }
}

/**
 * Export MULTI-FEUILLES (récap + détails…) en xlsx/pdf.
 *   feuilles = [{ nom, titre, entetes, lignes }, ...]
 * En PDF, on exporte le CLASSEUR ENTIER (toutes les feuilles) — pas de gid.
 */
function _exporterClasseur_(filenameBase, feuilles, format) {
  const temp = SpreadsheetApp.create('TMP_' + Date.now());
  const id = temp.getId();
  try {
    feuilles.forEach(function (f, idx) {
      const sh = (idx === 0) ? temp.getSheets()[0] : temp.insertSheet();
      sh.setName(f.nom);
      _remplirFeuille_(sh, f.titre, f.entetes, f.lignes);
    });
    SpreadsheetApp.flush();
    const isPdf = (format === 'pdf');
    const blob = _recupererExport_(_urlExport_(id, isPdf ? 'pdf' : 'xlsx', null), format); // null gid = tout le classeur
    const ext = isPdf ? '.pdf' : '.xlsx';
    const mime = isPdf ? MIME.PDF : MIME.XLSX;
    const nomFichier = filenameBase.replace(/[^\w\-]+/g, '_') + '_' +
      Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyyMMdd') + ext;
    return _blobVersClient_(blob.setName(nomFichier), nomFichier, mime);
  } finally {
    DriveApp.getFileById(id).setTrashed(true);
  }
}

/* ------------------------------ Helpers -------------------------------- */

function _blobVersClient_(blob, filename, mime) {
  return {
    filename: filename,
    mimeType: mime,
    bytesBase64: Utilities.base64Encode(blob.getBytes()),
  };
}

function _fmtDate_(v, tz) {
  if (!v) return '';
  const d = (v instanceof Date) ? v : new Date(v);
  return isNaN(d.getTime()) ? String(v) : Utilities.formatDate(d, tz, 'dd/MM/yyyy HH:mm');
}

function _esc_(v) {
  return String(v === null || v === undefined ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
