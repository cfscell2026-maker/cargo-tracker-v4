/**
 * ============================================================================
 *  Code.gs : Point d'entrée web (doGet) + routeur RPC unique sécurisé
 * ============================================================================
 *  TOUTES les actions du client passent par rpc(action, token, data).
 *  rpc() :
 *    1) valide la session (token),
 *    2) vérifie la permission du rôle pour l'action (PERMISSIONS),
 *    3) dispatche vers la fonction métier,
 *    4) renvoie {ok:true, data} ou {ok:false, error, auth?}.
 *  Le client ne décide JAMAIS des droits : tout est contrôlé ici.
 * ============================================================================
 */

function doGet() {
  return HtmlService.createTemplateFromFile('Index')
    .evaluate()
    .setTitle(APP.NAME)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, maximum-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/** Inclusion de fichiers HTML partiels (CSS / JS client). */
function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

/** Métadonnées publiques (avant connexion). */
function appInfo() {
  return { name: APP.NAME, version: APP.VERSION };
}

/**
 * Routeur RPC central. Renvoie toujours un objet (jamais d'exception au client).
 */
function rpc(action, token, data) {
  data = data || {};
  try {
    const session = _exigerPermission_(token, action);

    let result;
    switch (action) {
      /* ----- Recherche & lecture ----- */
      case 'cargo.search':  result = _rechercher_(data.critere, data.valeur); break;
      case 'cargo.get':     result = _filtrerConfidentiel_(_serialiser_(_getOuErreur_(data.id)), session); break;
      case 'cargo.list':    result = _listerCargaisons_(data); break;
      case 'cargo.checkdup':result = _verifierDoublons_(data); break;        // avertissement de doublon (camion / conteneur)
      case 'dashboard.stats': result = _statistiques_(data); break;

      /* ----- Écriture par étape ----- */
      case 'cargo.createcamion': result = _creerCamionVide_(session, data); break; // Porte CFS : camion vide
      case 'cargo.cfs':     result = _associerCFS_(session, data); break;    // Porte CFS/CFS : ajout conteneur (+ décl. en enlèvement)
      case 'cargo.declaration': result = _completerDeclaration_(session, data); break; // CFS : déclaration + scellés (dépotage) → Créée
      case 'cargo.create':  result = _creerRapport_(session, data); break;   // 1 rapport = N camions (spéciaux)
      case 'cargo.update':  result = _majCargo_(session, data); break;
      case 'cargo.editcamion': result = _corrigerCamion_(session, data); break;  // correction ciblée du N° camion
      case 'cargo.sceller': result = _poserScelles_(session, data); break;       // fin de chargement
      case 'cargo.visite':  result = _visiteScelle_(session, data); break;       // sous-module visite
      case 'cargo.mixte':   result = _completerMixte_(session, data); break;     // chargement mixte (compléter l'existant)
      case 'cargo.valider': result = _validerChefBrigade_(session, data); break; // v3.0 : validation (signature) chef brigade
      case 'cargo.horsgabarit': result = _majHorsGabarit_(session, data); break; // v3.0 : champ confidentiel hors gabarit
      case 'cargo.t1':      result = _saisirT1_(session, data); break;           // cellule T1
      case 'cargo.gps':     result = _poserGPS_(session, data); break;          // cellule Balise
      case 'cargo.gpsedit': result = _modifierGPS_(session, data); break;
      case 'cargo.bonsortie': result = _emettreBonSortie_(session, data); break; // cellule Bon de Sortie
      case 'cargo.sortie':  result = _enregistrerSortie_(session, data); break; // PP : checklist finale
      case 'cargo.etatcfs': result = _etatSortieCFS_(session, data); break;     // v3.5 : état camion à la sortie CFS
      case 'cargo.ouillagedecl': result = _ouillageDeclaration_(session, data); break; // v3.6 : déclaration d'un véhicule sous ouillage
      case 'etatcfs.list':  result = _listerEtatCFS_(); break;                  // v3.5 : traçabilité camions sur site
      case 'cargo.arriveebureau': result = _arriveeBureau_(session, data); break; // dispense soldée

      /* ----- Déclarations & stock ----- */
      case 'decl.lookup':   result = _lookupDeclaration_(data); break;
      case 'stock.list':    result = _listerStock_(data); break;
      case 'stock.import':  result = _importerStock_(session, data); break;
      case 'stock.pointage':result = _pointerStock_(session, data); break;
      case 'stock.entreemagasin': result = _entreeMagasin_(session, data); break;
      case 'report.stock':  result = _rapportStock_(session, data); break;   // délai de séjour & instances conteneurs
      // Stock ANNONCÉ (v2.8) : annonce de transfert (admin) + pointage à l'entrée (Porte Principale)
      case 'stockannonce.import':   result = _importerStockAnnonce_(session, data); break;
      case 'stockannonce.list':     result = _listerStockAnnonce_(data); break;
      case 'stockannonce.pointage': result = _pointerStockAnnonce_(session, data); break;
      case 'stockannonce.confirmer':result = _confirmerStockAnnonce_(session, data); break; // v3.1 : confirmation CFS → entrée stock
      case 'report.annonce':        result = _listerStockAnnonce_(data); break; // stats annoncés (réutilise les compteurs)

      /* ----- Rapports ----- */
      case 'report.loading': result = _rapportChargement_(session, data.id); break;
      case 'report.cfs':       result = _rapportCFS_(session, data); break;
      case 'report.cfsdetail': result = _rapportCFSDetail_(session, data); break;
      case 'report.vehicule':       result = _rapportVehicules_(session, data); break;
      case 'report.vehiculedetail': result = _rapportVehiculesDetail_(session, data); break;
      case 'report.balise':       data.kind = 'balise'; result = _rapportActivite_(session, data); break;
      case 'report.balisedetail': data.kind = 'balise'; result = _rapportActiviteDetail_(session, data); break;
      case 'report.pp':           data.kind = 'pp';     result = _rapportActivite_(session, data); break;
      case 'report.ppdetail':     data.kind = 'pp';     result = _rapportActiviteDetail_(session, data); break;
      case 'report.kpi':        result = _rapportKPI_(session, data); break;        // KPI stock & flux en EVP
      case 'report.dispenses':  result = _rapportDispenses_(session, data); break;  // suivi des dispenses
      case 'report.flux':       result = _rapportFlux_(session, data); break;       // analyse des flux dans le temps
      case 'report.fluxdetail': result = _rapportFluxDetail_(session, data); break; // détail d'une carte/cellule de flux
      case 'report.dwell':      result = _rapportSejour_(session, data); break;     // délai de séjour & camions en instance
      case 'report.dwelldetail':result = _rapportSejourDetail_(session, data); break; // détail d'une carte/tranche de séjour
      case 'report.list':      result = _rapportListe_(session, data); break;
      case 'report.history': result = _rapportHistorique_(session, data); break;

      /* ----- Historique ----- */
      case 'log.list':      result = _listerHistorique_(data); break;

      /* ----- Utilisateurs (admin) ----- */
      case 'user.list':     result = _listerUtilisateurs_(); break;
      case 'user.create':   result = _creerUtilisateur_(session, data); break;
      case 'user.update':   result = _majUtilisateur_(session, data); break;
      case 'user.toggle':   result = _basculerUtilisateur_(session, data); break;
      case 'user.resetpwd': result = _reinitMotDePasse_(session, data); break;

      /* ----- Compte courant ----- */
      case 'account.changepwd': result = _changerMonMotDePasse_(session, data); break;

      default: throw new Error('Action non gérée : ' + action);
    }
    return { ok: true, data: result };
  } catch (e) {
    return { ok: false, error: e.message || String(e), auth: !!e.isAuth };
  }
}

function _getOuErreur_(id) {
  const c = _getCargo_(id);
  if (!c) throw new Error('Cargaison introuvable : ' + id);
  return c;
}
