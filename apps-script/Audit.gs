/**
 * ============================================================================
 *  Audit.gs : Journal d'audit (append-only) + gestion des utilisateurs
 * ============================================================================
 */

/* ------------------------------ Journal -------------------------------- */

/** Écrit une entrée d'historique (non modifiable). Ne lève jamais d'exception. */
function _log_(session, action, cargaisonId, details) {
  try {
    _sheet_(SHEETS.LOG).appendRow([
      new Date(),
      session.username || '',
      session.nomComplet || '',
      session.role || '',
      action || '',
      cargaisonId || '',
      details || '',
    ]);
  } catch (e) {
    // Le journal ne doit jamais bloquer l'opération métier.
    console.error('Echec journalisation: ' + e);
  }
}

/** Liste paginée de l'historique, filtrable par utilisateur / période. */
function _listerHistorique_(opts) {
  opts = opts || {};
  const page = Math.max(1, Number(opts.page || 1));
  const pageSize = Math.min(200, Number(opts.pageSize || APP.PAGE_SIZE));
  const sh = _sheet_(SHEETS.LOG);
  const last = sh.getLastRow();
  if (last < 2) return { rows: [], total: 0, page: 1, pages: 1 };

  let vals = sh.getRange(2, 1, last - 1, LOG_COLS.length).getValues();
  const tz = Session.getScriptTimeZone();

  if (opts.username) {
    const u = String(opts.username).toLowerCase();
    vals = vals.filter(r => String(r[1]).toLowerCase() === u);
  }
  if (opts.du)  vals = vals.filter(r => r[0] instanceof Date && r[0] >= new Date(opts.du + 'T00:00:00'));
  if (opts.au)  vals = vals.filter(r => r[0] instanceof Date && r[0] <= new Date(opts.au + 'T23:59:59'));

  vals.reverse(); // plus récent d'abord
  const total = vals.length;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const start = (page - 1) * pageSize;
  const rows = vals.slice(start, start + pageSize).map(r => ({
    timestamp: (r[0] instanceof Date) ? Utilities.formatDate(r[0], tz, 'yyyy-MM-dd HH:mm:ss') : String(r[0]),
    username: r[1], nomComplet: r[2], role: r[3], action: r[4], cargaisonId: r[5], details: r[6],
  }));
  return { rows: rows, total: total, page: page, pages: pages };
}

/* ----------------------- Gestion des utilisateurs ---------------------- */

function _listerUtilisateurs_() {
  const sh = _sheet_(SHEETS.USERS);
  const last = sh.getLastRow();
  if (last < 2) return [];
  const tz = Session.getScriptTimeZone();
  return sh.getRange(2, 1, last - 1, USER_COLS.length).getValues().map(r => ({
    username: r[UCOL.username],
    nomComplet: r[UCOL.nomComplet],
    role: r[UCOL.role],
    actif: r[UCOL.actif] === true || String(r[UCOL.actif]).toUpperCase() === 'TRUE',
    dateCreation: r[UCOL.dateCreation] instanceof Date
      ? Utilities.formatDate(r[UCOL.dateCreation], tz, 'yyyy-MM-dd') : '',
    derniereConnexion: r[UCOL.derniereConnexion] instanceof Date
      ? Utilities.formatDate(r[UCOL.derniereConnexion], tz, 'yyyy-MM-dd HH:mm') : '',
  }));
}

function _creerUtilisateur_(session, p) {
  const username = _txt_(p.username).toLowerCase().replace(/\s+/g, '');
  if (!/^[a-z0-9._-]{3,30}$/.test(username))
    throw new Error('Identifiant invalide (3-30 caractères : lettres, chiffres, . _ -).');
  if (_findUser_(username)) throw new Error('Cet identifiant existe déjà.');
  if (Object.values(ROLES).indexOf(p.role) === -1) throw new Error('Rôle invalide.');
  const pwd = _txt_(p.password);
  if (pwd.length < 6) throw new Error('Mot de passe : 6 caractères minimum.');
  const nom = _txt_(p.nomComplet) || username;

  const salt = Utilities.getUuid();
  _sheet_(SHEETS.USERS).appendRow([
    username, _hashPassword_(username, pwd, salt), salt, nom,
    p.role, true, new Date(), '',
  ]);
  _log_(session, 'Création utilisateur', '', username + ' (' + p.role + ')');
  return { ok: true };
}

function _majUtilisateur_(session, p) {
  const u = _findUser_(p.username);
  if (!u) throw new Error('Utilisateur introuvable.');
  const sh = _sheet_(SHEETS.USERS);
  if (p.nomComplet !== undefined) sh.getRange(u.row, UCOL.nomComplet + 1).setValue(_txt_(p.nomComplet));
  if (p.role !== undefined) {
    if (Object.values(ROLES).indexOf(p.role) === -1) throw new Error('Rôle invalide.');
    sh.getRange(u.row, UCOL.role + 1).setValue(p.role);
  }
  _log_(session, 'Modification utilisateur', '', u.username);
  return { ok: true };
}

function _basculerUtilisateur_(session, p) {
  const u = _findUser_(p.username);
  if (!u) throw new Error('Utilisateur introuvable.');
  if (u.username.toLowerCase() === session.username.toLowerCase())
    throw new Error('Vous ne pouvez pas désactiver votre propre compte.');
  const nouveau = !(u.actif === true || String(u.actif).toUpperCase() === 'TRUE');
  _sheet_(SHEETS.USERS).getRange(u.row, UCOL.actif + 1).setValue(nouveau);
  _log_(session, nouveau ? 'Activation compte' : 'Désactivation compte', '', u.username);
  return { ok: true, actif: nouveau };
}

function _reinitMotDePasse_(session, p) {
  const u = _findUser_(p.username);
  if (!u) throw new Error('Utilisateur introuvable.');
  const pwd = _txt_(p.password);
  if (pwd.length < 6) throw new Error('Mot de passe : 6 caractères minimum.');
  const salt = Utilities.getUuid();
  const sh = _sheet_(SHEETS.USERS);
  sh.getRange(u.row, UCOL.passwordHash + 1).setValue(_hashPassword_(u.username, pwd, salt));
  sh.getRange(u.row, UCOL.salt + 1).setValue(salt);
  _log_(session, 'Réinitialisation mot de passe', '', u.username);
  return { ok: true };
}

function _changerMonMotDePasse_(session, p) {
  const u = _findUser_(session.username);
  if (!u) throw new Error('Utilisateur introuvable.');
  const ancien = _hashPassword_(u.username, _txt_(p.ancien), u.salt);
  if (!_safeEqual_(ancien, String(u.passwordHash)))
    throw new Error('Ancien mot de passe incorrect.');
  const nouveau = _txt_(p.nouveau);
  if (nouveau.length < 6) throw new Error('Nouveau mot de passe : 6 caractères minimum.');
  const salt = Utilities.getUuid();
  const sh = _sheet_(SHEETS.USERS);
  sh.getRange(u.row, UCOL.passwordHash + 1).setValue(_hashPassword_(u.username, nouveau, salt));
  sh.getRange(u.row, UCOL.salt + 1).setValue(salt);
  _log_(session, 'Changement mot de passe', '', '');
  return { ok: true };
}
