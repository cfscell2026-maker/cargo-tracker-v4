/**
 * ============================================================================
 *  Setup.gs : Initialisation du classeur (à lancer UNE seule fois)
 * ============================================================================
 *  Depuis l'éditeur Apps Script :
 *    1) Sélectionnez la fonction  initialiserApplication
 *    2) Cliquez sur "Exécuter" et autorisez les accès demandés
 *    3) Lisez le journal : l'identifiant + mot de passe admin par défaut y sont
 *  Cette fonction est idempotente : relançable sans détruire les données.
 * ============================================================================
 */

function initialiserApplication() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('Ouvrez ce script DEPUIS un Google Sheet (Extensions > Apps Script).');

  _ensureSheet_(ss, SHEETS.CARGOS,        COLS.map(c => c.label));
  _ensureSheet_(ss, SHEETS.CONTENEURS,    CONT_COLS.map(c => c.label));
  _ensureSheet_(ss, SHEETS.DECLARATIONS,  DECL_COLS.map(c => c.label));
  _ensureSheet_(ss, SHEETS.STOCK,         STOCK_COLS.map(c => c.label));
  _ensureSheet_(ss, SHEETS.STOCK_ANNONCE, STOCK_ANNONCE_COLS.map(c => c.label));
  _ensureSheet_(ss, SHEETS.USERS,         USER_COLS);
  _ensureSheet_(ss, SHEETS.LOG,           LOG_COLS);
  _ensureSheet_(ss, SHEETS.META,          ['cle', 'valeur']);

  _styleHeader_(ss.getSheetByName(SHEETS.CARGOS));
  _styleHeader_(ss.getSheetByName(SHEETS.CONTENEURS));
  _styleHeader_(ss.getSheetByName(SHEETS.DECLARATIONS));
  _styleHeader_(ss.getSheetByName(SHEETS.STOCK));
  _styleHeader_(ss.getSheetByName(SHEETS.STOCK_ANNONCE));
  _styleHeader_(ss.getSheetByName(SHEETS.USERS));
  _styleHeader_(ss.getSheetByName(SHEETS.LOG));

  _migrerRoles_(ss);   // v2.8 : fusion Porte CFS → CFS

  // Compteur de séquence pour les IDs (si absent)
  const props = PropertiesService.getScriptProperties();
  if (!props.getProperty('SEQ')) props.setProperty('SEQ', '0');

  // Création de l'administrateur par défaut s'il n'existe aucun utilisateur
  const users = ss.getSheetByName(SHEETS.USERS);
  let infoAdmin = 'Administrateur déjà présent — inchangé.';
  if (users.getLastRow() < 2) {
    const pwd = _motDePasseAleatoire_(10);
    const salt = Utilities.getUuid();
    users.appendRow([
      'admin',
      _hashPassword_('admin', pwd, salt),
      salt,
      'Administrateur',
      ROLES.ADMIN,
      true,
      new Date(),
      '',
    ]);
    infoAdmin = 'IDENTIFIANT ADMIN : admin   |   MOT DE PASSE : ' + pwd +
                '   <<< NOTEZ-LE puis changez-le après la 1ère connexion.';
  }

  _verrouillerOnglets_(ss); // protection des onglets contre l'édition manuelle
  installerSauvegardeAutomatique();

  Logger.log('==================================================');
  Logger.log(' Initialisation terminée.');
  Logger.log(' ' + infoAdmin);
  Logger.log('==================================================');
  return infoAdmin;
}

/**
 * Crée la feuille si absente et garantit la ligne d'entête.
 * Idempotent ET évolutif : remplit toute cellule d'entête VIDE (y compris les
 * nouvelles colonnes ajoutées en fin de schéma) sans écraser un libellé existant.
 * -> Relancer initialiserApplication après l'ajout de colonnes suffit à migrer.
 */
function _ensureSheet_(ss, name, headers) {
  let sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  const rng = sh.getRange(1, 1, 1, headers.length);
  const cur = rng.getValues()[0];
  let changed = false;
  for (let i = 0; i < headers.length; i++) {
    if (cur[i] === '' || cur[i] === null) { cur[i] = headers[i]; changed = true; }
  }
  if (changed) rng.setValues([cur]);
  sh.setFrozenRows(1);
  return sh;
}

function _styleHeader_(sh) {
  if (!sh) return;
  const lastCol = sh.getLastColumn();
  sh.getRange(1, 1, 1, lastCol)
    .setBackground('#2e6da4').setFontColor('#ffffff').setFontWeight('bold');
  sh.autoResizeColumns(1, Math.min(lastCol, 10));
}

/**
 * Protège les onglets pour qu'aucun agent n'édite manuellement les données
 * (l'intégrité doit passer uniquement par l'application). Le propriétaire du
 * script garde l'accès complet.
 */
function _verrouillerOnglets_(ss) {
  [SHEETS.CARGOS, SHEETS.CONTENEURS, SHEETS.DECLARATIONS, SHEETS.STOCK, SHEETS.STOCK_ANNONCE, SHEETS.USERS, SHEETS.LOG, SHEETS.META].forEach(name => {
    const sh = ss.getSheetByName(name);
    if (!sh) return;
    const protections = sh.getProtections(SpreadsheetApp.ProtectionType.SHEET);
    let p = protections.length ? protections[0] : sh.protect();
    p.setDescription('Protégé — modifications via l\'application uniquement');
    p.setWarningOnly(true); // avertissement (n'empêche pas le script d'écrire)
  });
}

/** Programme une sauvegarde quotidienne (déclencheur temporel). */
function installerSauvegardeAutomatique() {
  const exist = ScriptApp.getProjectTriggers()
    .some(t => t.getHandlerFunction() === 'sauvegardeQuotidienne');
  if (!exist) {
    ScriptApp.newTrigger('sauvegardeQuotidienne')
      .timeBased().everyDays(1).atHour(2).create();
  }
}

/** Copie quotidienne du classeur dans un dossier dédié de Drive. */
function sauvegardeQuotidienne() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const file = DriveApp.getFileById(ss.getId());
  let folder;
  const it = DriveApp.getFoldersByName(APP.BACKUP_FOLDER);
  folder = it.hasNext() ? it.next() : DriveApp.createFolder(APP.BACKUP_FOLDER);
  const stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd_HHmm');
  file.makeCopy('CargoTracker_' + stamp, folder);

  // Rotation : conserver les 30 dernières sauvegardes
  const copies = [];
  const fit = folder.getFiles();
  while (fit.hasNext()) copies.push(fit.next());
  copies.sort((a, b) => b.getDateCreated() - a.getDateCreated());
  copies.slice(30).forEach(f => f.setTrashed(true));
}

/**
 * v2.8 — Fusion des rôles : tout compte ayant l'ancien rôle « PORTE_CFS » est
 * basculé vers « CFS » (cellule unifiée). Idempotent : sans effet si aucun reste.
 */
function _migrerRoles_(ss) {
  const sh = ss.getSheetByName(SHEETS.USERS);
  if (!sh) return;
  const last = sh.getLastRow();
  if (last < 2) return;
  const col = UCOL.role + 1;
  const rng = sh.getRange(2, col, last - 1, 1);
  const vals = rng.getValues();
  let migres = 0;
  for (let i = 0; i < vals.length; i++) {
    if (vals[i][0] === 'PORTE_CFS') { vals[i][0] = ROLES.CFS; migres++; }
  }
  if (migres) { rng.setValues(vals); Logger.log(' ' + migres + ' compte(s) PORTE_CFS migré(s) vers CFS.'); }
}

function _motDePasseAleatoire_(n) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  let s = '';
  for (let i = 0; i < n; i++) s += chars.charAt(Math.floor(Math.random() * chars.length));
  return s;
}
