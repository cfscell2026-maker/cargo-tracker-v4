/**
 * ============================================================================
 *  Auth.gs : Authentification, sessions, hachage, contrôle des permissions
 * ============================================================================
 */

/* ----------------------------- Hachage --------------------------------- */

/**
 * Hachage du mot de passe : SHA-256 salé + itéré (anti brute-force basique).
 * Renvoie une chaîne hexadécimale.
 */
function _hashPassword_(username, password, salt) {
  let data = username.toLowerCase() + '|' + password + '|' + salt;
  let bytes = Utilities.newBlob(data).getBytes();
  for (let i = 0; i < APP.HASH_ITERATIONS; i++) {
    bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, bytes);
  }
  return bytes.map(b => ('0' + (b & 0xff).toString(16)).slice(-2)).join('');
}

/** Comparaison à temps ~constant pour éviter les attaques temporelles. */
function _safeEqual_(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

/* ----------------------------- Sessions -------------------------------- */

function _sessionKey_(token) { return 'sess_' + token; }

/** Crée une session en cache (rapide) et renvoie le token. */
function _creerSession_(user) {
  const token = Utilities.getUuid() + Utilities.getUuid().replace(/-/g, '');
  const payload = JSON.stringify({
    username: user.username,
    role: user.role,
    nomComplet: user.nomComplet,
    exp: Date.now() + APP.SESSION_TTL_SEC * 1000,
  });
  CacheService.getScriptCache().put(_sessionKey_(token), payload, APP.SESSION_TTL_SEC);
  return token;
}

/** Valide un token et renvoie l'objet session, ou null si invalide/expiré. */
function _validerSession_(token) {
  if (!token) return null;
  const raw = CacheService.getScriptCache().get(_sessionKey_(token));
  if (!raw) return null;
  let s;
  try { s = JSON.parse(raw); } catch (e) { return null; }
  if (!s.exp || Date.now() > s.exp) return null;
  return s;
}

function _detruireSession_(token) {
  if (token) CacheService.getScriptCache().remove(_sessionKey_(token));
}

/* ----------------------------- Connexion ------------------------------- */

/**
 * Point d'entrée appelé directement par le client.
 * Anti brute-force : compteur d'échecs par identifiant (verrou 5 min après 5 essais).
 */
function login(username, password) {
  username = String(username || '').trim();
  password = String(password || '');
  if (!username || !password) return { ok: false, error: 'Identifiant et mot de passe requis.' };

  const cache = CacheService.getScriptCache();
  const failKey = 'fail_' + username.toLowerCase();
  const fails = Number(cache.get(failKey) || '0');
  if (fails >= 5) {
    return { ok: false, error: 'Trop de tentatives. Réessayez dans quelques minutes.' };
  }

  const u = _findUser_(username);
  const invalid = { ok: false, error: 'Identifiant ou mot de passe incorrect.' };

  if (!u) { cache.put(failKey, String(fails + 1), 300); return invalid; }
  if (u.actif !== true && String(u.actif).toUpperCase() !== 'TRUE') {
    return { ok: false, error: 'Compte désactivé. Contactez l\'administrateur.' };
  }

  const hash = _hashPassword_(u.username, password, u.salt);
  if (!_safeEqual_(hash, String(u.passwordHash))) {
    cache.put(failKey, String(fails + 1), 300);
    return invalid;
  }

  cache.remove(failKey);
  _majDerniereConnexion_(u.row);
  const token = _creerSession_(u);
  _log_(u, 'Connexion', '', '');
  return {
    ok: true,
    token: token,
    user: { username: u.username, nomComplet: u.nomComplet, role: u.role },
  };
}

function logout(token) {
  const s = _validerSession_(token);
  if (s) _log_({ username: s.username, nomComplet: s.nomComplet, role: s.role }, 'Déconnexion', '', '');
  _detruireSession_(token);
  return { ok: true };
}

/* ----------------------- Lecture des utilisateurs ---------------------- */

/** Recherche un utilisateur par identifiant (insensible à la casse). */
function _findUser_(username) {
  const sh = _sheet_(SHEETS.USERS);
  const last = sh.getLastRow();
  if (last < 2) return null;
  const vals = sh.getRange(2, 1, last - 1, USER_COLS.length).getValues();
  const target = username.toLowerCase();
  for (let i = 0; i < vals.length; i++) {
    if (String(vals[i][UCOL.username]).toLowerCase() === target) {
      return _rowToUser_(vals[i], i + 2);
    }
  }
  return null;
}

function _rowToUser_(row, rowNumber) {
  return {
    username: row[UCOL.username],
    passwordHash: row[UCOL.passwordHash],
    salt: row[UCOL.salt],
    nomComplet: row[UCOL.nomComplet],
    role: row[UCOL.role],
    actif: row[UCOL.actif],
    dateCreation: row[UCOL.dateCreation],
    derniereConnexion: row[UCOL.derniereConnexion],
    row: rowNumber,
  };
}

function _majDerniereConnexion_(rowNumber) {
  _sheet_(SHEETS.USERS).getRange(rowNumber, UCOL.derniereConnexion + 1).setValue(new Date());
}

/* ----------------------- Contrôle des permissions ---------------------- */

/** Lève une erreur si la session est invalide ou l'action non autorisée. */
function _exigerPermission_(token, action) {
  const s = _validerSession_(token);
  if (!s) throw new _AuthError_('Session expirée. Veuillez vous reconnecter.');
  const allowed = PERMISSIONS[action];
  if (!allowed) throw new Error('Action inconnue : ' + action);
  if (allowed.indexOf(s.role) === -1) throw new _AuthError_('Accès refusé pour votre profil.');
  return s;
}

function _AuthError_(msg) { const e = new Error(msg); e.isAuth = true; return e; }

