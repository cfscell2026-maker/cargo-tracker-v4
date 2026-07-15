/**
 * ============================================================================
 *  PIA DRY PORT — CARGO TRACKER
 *  Config.gs : Constantes, schéma des données, matrice des droits
 * ============================================================================
 *  NE PAS modifier l'ordre des colonnes une fois en production :
 *  l'ordre du tableau COLS définit l'ordre physique des colonnes dans la
 *  feuille "Cargaisons". Ajoutez toujours les nouvelles colonnes À LA FIN.
 * ============================================================================
 */

const APP = {
  NAME: 'Suivi des Cargaisons',
  VERSION: '1.1.0',
  ID_PREFIX: 'CT',                 // Préfixe des identifiants de cargaison
  RPT_PREFIX: 'RPT',               // Préfixe des identifiants de rapport (groupe de camions)
  SESSION_TTL_SEC: 6 * 60 * 60,    // Durée de vie d'une session : 6 h (max cache)
  HASH_ITERATIONS: 5000,           // Itérations de hachage du mot de passe
  PAGE_SIZE: 50,                   // Taille de page par défaut des listes
  BACKUP_FOLDER: 'BACKUP_CG',
};

/**
 * Valeurs par défaut / listes métier (modifiables ici sans toucher au code).
 * TYPES_DECLARATION : liste déroulante du champ « Type de déclaration ».
 *   Adaptez librement les codes ci-dessous à votre nomenclature douanière.
 */
const DEFAUTS = {
  BUREAU_DECLARATION: 'TG120',     // Bureau de déclaration pré-rempli
  TYPE_DECLARATION:   'T',         // Type de déclaration par défaut : Transit
};
// Types de déclaration douanière au CFS (liste déroulante). NB : « D » (déclaration
// de transit) n'apparaît PAS ici — il est saisi à l'étape T1, pas au CFS.
const TYPES_DECLARATION = ['T', 'C', 'S', 'A', 'E'];

/**
 * Conteneurs : nombre LIBRE par camion (chacun avec son propre scellé).
 * CONTENEURS_MAX = simple garde-fou anti-abus côté serveur (pas une limite métier).
 * CONTENEURS_APERCU = nb de conteneurs recopiés dans les colonnes plates
 * « Conteneur 1..N » de la feuille Cargaisons (aperçu rapide listes/recherche) ;
 * la liste complète vit dans la feuille « Conteneurs » + le JSON détaillé.
 */
const CONTENEURS_MAX = 50;
const CONTENEURS_APERCU = 4;

/** Noms des feuilles (onglets) du classeur. */
const SHEETS = {
  CARGOS:        'Cargaisons',
  CONTENEURS:    'Conteneurs',
  DECLARATIONS:  'Declarations',   // registre des déclarations + apurement (v2.1)
  STOCK:         'Stock',          // inventaire physique des conteneurs sur le port sec (v2.2)
  STOCK_ANNONCE: 'StockAnnonce',   // annonce de transfert (v2.8) : TC annoncés la veille, en attente de pointage à l'entrée
  USERS:         'Utilisateurs',
  LOG:           'Historique',
  META:          'Meta',
};

/**
 * Stock ANNONCÉ (v2.8) — annonce de transfert du Port Autonome vers le Port Sec.
 * L'administrateur importe la veille la liste des TC à transférer (Excel, 7 colonnes).
 * À l'arrivée au Port Sec, l'agent Porte Principale POINTE le TC : il passe de
 * « Annoncé » à « Pointé » et est AJOUTÉ au stock du port sec (feuille Stock).
 * Permet le suivi : annoncés non pointés / pointés / taux de transfert / délai & instance.
 */
// v3.1 — flux en 3 temps : Annoncé (import admin) → Pointé (PP, arrivée) → Confirmé (CFS, entrée au stock PIA).
const ANNONCE_STATUTS = { ANNONCE: 'Annoncé', POINTE: 'Pointé', CONFIRME: 'Confirmé' };
const STOCK_ANNONCE_COLS = [
  { key: 'numeroTC',          label: 'N° Conteneur' },
  { key: 'taille',            label: 'Taille' },
  { key: 'dateEntree',        label: "Date d'entrée" },     // date d'annonce / entrée prévue
  { key: 'anneeDeclaration',  label: 'Année déclaration' },
  { key: 'bureauDeclaration', label: 'Bureau déclaration' },
  { key: 'typeDeclaration',   label: 'Type déclaration' },
  { key: 'numeroDeclaration', label: 'N° déclaration' },
  { key: 'statut',            label: 'Statut' },            // Annoncé / Pointé / Confirmé
  { key: 'dateAnnonce',       label: 'Date annonce' },      // horodatage de l'import
  { key: 'datePointage',      label: 'Date pointage' },     // horodatage de l'arrivée pointée (PP)
  { key: 'pointePar',         label: 'Pointé par' },
  { key: 'dateConfirmation',  label: 'Date confirmation' }, // v3.1 : horodatage de la confirmation CFS (entrée au stock)
  { key: 'confirmePar',       label: 'Confirmé par' },
  { key: 'observations',      label: 'Observations' },
];
const ANCOL = (function () { const m = {}; STOCK_ANNONCE_COLS.forEach((c, i) => (m[c.key] = i)); return m; })();

/**
 * Registre des déclarations (clé unique = année|bureau|type|numéro) avec suivi
 * d'apurement : nombreConteneurs déclaré au 1er enregistrement, conteneursApures
 * incrémenté à chaque cargaison rattachée → restant = déclaré − apuré.
 */
const DECL_COLS = [
  { key: 'cle',               label: 'Clé déclaration' },
  { key: 'anneeDeclaration',  label: 'Année' },
  { key: 'bureauDeclaration', label: 'Bureau' },
  { key: 'typeDeclaration',   label: 'Type' },
  { key: 'numeroDeclaration', label: 'Numéro' },
  { key: 'declarant',         label: 'Déclarant' },
  { key: 'nombreConteneurs',  label: 'Nb conteneurs déclarés' },
  { key: 'conteneursApures',  label: 'Conteneurs apurés' },
  { key: 'dateCreation',      label: 'Date création' },
  { key: 'derniereMaj',       label: 'Dernière MAJ' },
];
const DCOL = (function () { const m = {}; DECL_COLS.forEach((c, i) => (m[c.key] = i)); return m; })();

/**
 * Inventaire physique des conteneurs présents sur le port sec (stock).
 * Statuts : « En stock » → « Positionné » (pointé pour dépotage le matin) →
 * « Dépoté » (vidé / sorti du yard). Sert au pointage matinal et aux KPI de stock.
 */
const STOCK_STATUTS = { STOCK: 'En stock', POSITIONNE: 'Positionné', DEPOTE: 'Dépoté' };
const STOCK_COLS = [
  { key: 'numeroTC',       label: 'N° Conteneur' },
  { key: 'taille',         label: 'Taille' },
  { key: 'typeConteneur',  label: 'Type' },
  { key: 'provenance',     label: 'Provenance' },        // Port sec / Port autonome
  { key: 'dateEntree',     label: "Date d'entrée" },
  { key: 'statut',         label: 'Statut' },            // En stock / Positionné / Dépoté
  { key: 'datePositionne', label: 'Date positionnement' },
  { key: 'datePointage',   label: 'Date pointage' },
  { key: 'pointePar',      label: 'Pointé par' },
  { key: 'dateDepote',     label: 'Date dépotage' },
  { key: 'cargaisonId',    label: 'Cargaison liée' },
  { key: 'observations',   label: 'Observations' },
  // --- Ajout v2.7 : nb de jours de séjour à l'import (le séjour réel est recalculé = aujourd'hui − date d'entrée) ---
  { key: 'nbSejoursImport', label: 'Nb séjours (import)' },
];
const SCOL = (function () { const m = {}; STOCK_COLS.forEach((c, i) => (m[c.key] = i)); return m; })();

/**
 * Schéma de la feuille "Conteneurs" : 1 ligne PAR conteneur.
 * Conçu pour un traitement tabulaire aisé dans Excel (tri, filtre, TCD) :
 * on peut grouper par N° Rapport ou par N° Camion.
 */
const CONT_COLS = [
  { key: 'rapportId',     label: 'N° Rapport' },
  { key: 'cargaisonId',   label: 'ID Cargaison' },
  { key: 'numeroCamion',  label: 'N° Camion' },
  { key: 'typeOperation', label: "Type d'opération" },
  { key: 'ordre',         label: 'Ordre' },
  { key: 'conteneur',     label: 'Conteneur' },
  { key: 'scelle',        label: 'Scellé' },
  { key: 'taille',        label: 'Taille' },
  { key: 'typeConteneur', label: 'Type conteneur' },
  { key: 'poids',         label: 'Poids' },
  { key: 'champsLibres',  label: 'Champs libres' },
  { key: 'dateCreation',  label: 'Date création' },
];
const CCOL = (function () {
  const m = {}; CONT_COLS.forEach((c, i) => (m[c.key] = i)); return m;
})();

/**
 * Rôles disponibles (une cellule = un rôle dédié, anti-fraude).
 * v2.8 — FUSION : l'ancien rôle « PORTE_CFS » a été supprimé. Le CFS et la Porte CFS
 * étant tenus par les mêmes personnes, le rôle unique « CFS » fait désormais TOUT
 * (créer le camion à l'entrée, saisir l'enlèvement/dépotage, déclaration, scellés,
 * stock, rapports). Les anciens comptes PORTE_CFS sont migrés vers CFS au démarrage.
 */
const ROLES = {
  CFS:        'CFS',          // cellule CFS : opération (déclaration, conteneurs, scellés) + stock
  CHEF_BRIGADE: 'CHEF_BRIGADE', // v3.0 : VALIDE (signature) les cargaisons après le CFS, avant T1/Balise/BS
  CHEF_BRIGADE_ADJOINT: 'CHEF_BRIGADE_ADJOINT', // superviseur (voit Hors gabarit)
  CHEF_VISITE: 'CHEF_VISITE', // superviseur (voit Hors gabarit)
  CHEF_DIVISION: 'CHEF_DIVISION', // superviseur (voit Hors gabarit)
  T1:         'T1',           // cellule document de transit T1
  BALISE:     'BALISE',       // pose / dispense de balise
  BON_SORTIE: 'BON_SORTIE',   // émission du bon de sortie
  PP:         'PP',           // porte principale : entrée (création + pointage annoncé) + sortie
  ADMIN:      'ADMIN',
};

/** Tous les rôles (lecture/recherche/tableau de bord/compte courant). */
const TOUS_ROLES = [ROLES.CFS, ROLES.CHEF_BRIGADE, ROLES.CHEF_BRIGADE_ADJOINT, ROLES.CHEF_VISITE,
                    ROLES.CHEF_DIVISION, ROLES.T1, ROLES.BALISE, ROLES.BON_SORTIE, ROLES.PP, ROLES.ADMIN];

/**
 * v3.0 — Profils « chefs » habilités à VOIR (et saisir) le champ confidentiel « Hors gabarit ».
 * Tous les autres rôles ne voient jamais ce champ (filtré côté serveur à la lecture du détail).
 */
const CHEFS_HORSGABARIT = [ROLES.CHEF_BRIGADE, ROLES.CHEF_BRIGADE_ADJOINT, ROLES.CHEF_VISITE, ROLES.CHEF_DIVISION, ROLES.ADMIN];

/**
 * v3.2 — « Hors gabarit » (DÉPOTAGE uniquement) : déterminé AUTOMATIQUEMENT par le système.
 * Dès que le CFS saisit une hauteur de chargement > 4,5 m, la cargaison est signalée hors gabarit
 * au chef brigade. Le CFS (qui saisit la hauteur) ET les chefs voient le champ ; les cellules en
 * aval (T1/Balise/Bon de sortie/PP) ne le voient pas.
 */
const HAUTEUR_HORS_GABARIT = 4.5;
const VOIENT_HORSGABARIT = [ROLES.CFS, ROLES.CHEF_BRIGADE, ROLES.CHEF_BRIGADE_ADJOINT, ROLES.CHEF_VISITE, ROLES.CHEF_DIVISION, ROLES.ADMIN];

/**
 * Statuts métier (workflow séquentiel v2) :
 *   Créée (CFS = fin de chargement) → T1 saisi → GPS Installé (balisé/dispensé)
 *   → Bon de sortie émis → Sortie Enregistrée (sorti).
 * Les VALEURS « Créée / GPS Installé / Sortie Enregistrée » sont conservées
 * (compat données existantes) ; deux étapes (T1, Bon de sortie) sont intercalées.
 */
const STATUTS = {
  CAMION:  'Camion créé',            // créé VIDE par la Porte CFS (entrée), pas encore de marchandise
  CHARGEMENT: 'En cours de chargement', // CFS a associé des conteneurs (dépotage), scellés PAS encore posés
  VEHICULE_OUILLAGE: 'Véhicule ouillage créé', // v3.6 : véhicule dépoté sous ouillage, déclaration PAS encore renseignée
  CREEE:   'Créée',                  // CFS validé = fin de chargement / en attente de T1
  T1:      'T1 saisi',               // cellule T1 franchie
  GPS:     'GPS Installé',           // balisé ou dispensé
  BS:      'Bon de sortie émis',     // bon de sortie émis
  SORTIE:  'Sortie Enregistrée',     // sorti (PP)
};

/** Types d'opération. */
const OPERATIONS = {
  DEPOTAGE:   'Dépotage',
  ENLEVEMENT: 'Enlèvement',
  VEHICULE:   'Dépotage / Véhicule',
  CONSO:      'Conso (type C)',       // mise à la consommation : à baliser OU non balisée
  MAGASIN:    'Sortie Magasin / MAD', // sortie de marchandise en vrac (sans conteneur)
};

/** Destinations / régimes possibles pour un véhicule dépoté (liste déroulante). */
const VEHICULE_DESTINATIONS = ['Transit', 'Conso', 'MAD', 'Véhicule abandonné'];

/**
 * v3.3 — C'est le CFS qui crée le camion à l'entrée et choisit le type d'opération.
 * Le « routage » se réduit donc au TYPE : Enlèvement ou Dépotage.
 */
const ROUTAGES = {
  ENLEVEMENT: 'Enlèvement',
  DEPOTAGE:   'Dépotage',
};
/** Type d'opération déduit du choix à la création (= le routage lui-même). */
function _typeDeRoutage_(routage) {
  return (routage === OPERATIONS.DEPOTAGE) ? OPERATIONS.DEPOTAGE : OPERATIONS.ENLEVEMENT;
}
/** v2.9 — État du camion au moment de la SORTIE physique (saisi par la PP). */
const ETATS_SORTIE = ['En cours de chargement', 'Fin de chargement', 'Vide'];

/** EVP (Équivalent Vingt Pieds) par taille : 20'=1 ; 40'=45'=2. */
function evpDeTaille(bucket) { return (bucket === 't40' || bucket === 't45') ? 2 : 1; }

/**
 * Schéma de la feuille "Cargaisons".
 * key      : clé logique utilisée partout dans le code et côté client
 * label    : entête lisible affiché dans la feuille
 * Important : l'index (0-based) de chaque colonne = sa position dans la feuille.
 */
const COLS = [
  { key: 'id',                    label: 'ID' },
  { key: 'reference',             label: 'Référence' },
  { key: 'dateCreation',          label: 'Date création' },
  { key: 'numeroCamion',          label: 'N° Camion' },
  { key: 'typeOperation',         label: "Type d'opération" },
  { key: 'twins',                 label: 'TWINS' },
  { key: 'conteneur1',            label: 'Conteneur 1' },
  { key: 'plomb1',                label: 'Plomb 1' },
  { key: 'conteneur2',            label: 'Conteneur 2' },
  { key: 'plomb2',                label: 'Plomb 2' },
  { key: 'conteneur3',            label: 'Conteneur 3' },
  { key: 'plomb3',                label: 'Plomb 3' },
  { key: 'declarant',             label: 'Déclarant' },
  { key: 'contactDeclarant',      label: 'Contact déclarant' },
  { key: 'destinationMarchandise',label: 'Destination marchandise' },
  { key: 'bureauDeclaration',     label: 'Bureau de déclaration' },
  { key: 'typeDeclaration',       label: 'Type de déclaration' },
  { key: 'numeroDeclaration',     label: 'N° de déclaration' },
  { key: 'anneeDeclaration',      label: 'Année de déclaration' },
  { key: 'descriptionMarchandise',label: 'Description marchandise' },
  { key: 'observationsCFS',       label: 'Observations CFS' },
  { key: 'agentCFS',              label: 'Agent CFS' },
  { key: 'statut',                label: 'Statut' },
  { key: 'numeroGPS',             label: 'N° GPS' },
  { key: 'datePoseGPS',           label: 'Date pose GPS' },
  { key: 'agentBalise',           label: 'Agent Balise' },
  { key: 'observationsBalise',    label: 'Observations Balise' },
  { key: 'infosValidees',         label: 'Infos validées' },
  { key: 'dateSortie',            label: 'Date sortie' },
  { key: 'agentPP',               label: 'Agent PP' },
  { key: 'observationsPP',        label: 'Observations PP' },
  { key: 'derniereMaj',           label: 'Dernière MAJ' },
  // --- Ajouts v1.1 (TOUJOURS à la fin : ne pas réorganiser) ---
  { key: 'rapportId',             label: 'N° Rapport' },        // regroupe les camions saisis ensemble
  { key: 'conteneur4',            label: 'Conteneur 4' },       // aperçu : 4e conteneur
  { key: 'conteneursDetails',     label: 'Détails conteneurs' },// JSON : liste complète (scellé/taille/type/poids + champs libres)
  // --- Ajouts v1.2 ---
  { key: 'plomb4',                label: 'Plomb 4' },           // aperçu : scellé du 4e conteneur
  { key: 'nbConteneurs',          label: 'Nb conteneurs' },     // total réel (au-delà de l'aperçu)
  // --- Ajouts v1.8 (TOUJOURS à la fin) ---
  { key: 'baliseRequise',         label: 'Balise requise' },    // 'Oui' (GPS posé) | 'Non' (cargaison sans balise) — renseigné à l'étape Balise
  { key: 'chargementMixte',       label: 'Chargement mixte' },  // 'Oui' si la cargaison porte plusieurs déclarations (compléments ajoutés)
  { key: 'mixteDetails',          label: 'Détails chargement mixte' }, // JSON : historique des compléments (date, agent, note, infos, conteneurs ajoutés)
  // --- Ajouts v1.9 (dépotage véhicule) ---
  { key: 'estVehicule',           label: 'Est véhicule' },      // 'Oui' = ligne véhicule (saute la balise, non comptée comme camion)
  { key: 'vehiculeDetails',       label: 'Détails véhicule' },  // JSON : { chassis, marque, modele, couleur, destination, extra[] }
  { key: 'conteneurOrigine',      label: "Conteneur d'origine" }, // N° du conteneur dépoté (TC) d'où sortent les véhicules
  // --- Ajouts v2.0 (workflow CFS → T1 → Balise → Bon de Sortie → PP) ---
  { key: 'bureauDestination',     label: 'Bureau de destination' }, // saisi à l'étape T1
  { key: 't1Numeros',             label: 'N° T1' },                 // JSON : liste des n° de document T1
  { key: 'dateT1',                label: 'Date T1' },
  { key: 'agentT1',               label: 'Agent T1' },
  { key: 'observationsT1',        label: 'Observations T1' },
  { key: 't1Correct',             label: 'T1 vérifié (Balise)' },   // 'Oui' : case « T1 correct » cochée à la balise
  { key: 'numeroDispense',        label: 'N° dispense' },           // si dispense de balise (baliseRequise='Non')
  { key: 'bonSortieNumero',       label: 'N° Bon de sortie' },
  { key: 'dateBonSortie',         label: 'Date Bon de sortie' },
  { key: 'agentBonSortie',        label: 'Agent Bon de sortie' },
  { key: 'observationsBonSortie', label: 'Observations Bon de sortie' },
  { key: 'ppChecklist',           label: 'Checklist PP' },          // JSON : {cfs, t1, balise, bs}
  // --- Ajouts v2.1 (Conso, Magasin/MAD, dispenses, apurement) ---
  { key: 'sauteT1',               label: 'Saute T1' },              // 'Oui' = pas de cellule T1 (conso, magasin)
  { key: 'sauteBalise',           label: 'Saute Balise' },          // 'Oui' = pas de cellule Balise (conso non balisée)
  { key: 'arriveeBureau',         label: 'Arrivée bureau dest.' },  // 'Oui' = dispense soldée (arrivée confirmée)
  { key: 'dateArriveeBureau',     label: 'Date arrivée bureau' },
  { key: 'agentArriveeBureau',    label: 'Agent arrivée bureau' },
  // --- Ajouts v2.9 (entrée Porte Principale + état de sortie) ---
  { key: 'routageEntree',         label: 'Routage entrée' },        // CFS-Enlèvement / CFS-Dépotage / Yard-Enlèvement (choisi par la PP à l'entrée)
  { key: 'agentEntree',           label: 'Agent entrée (PP)' },     // agent ayant constaté l'entrée du camion vide
  { key: 'etatSortie',            label: 'État de sortie' },        // En cours de chargement / Fin de chargement / Vide (saisi par la PP à la sortie)
  // --- Ajouts v3.0 (validation chef brigade + colis + hors gabarit) ---
  { key: 'nbColis',               label: 'Nombre de colis' },       // saisi par le CFS (visible de tous)
  { key: 'horsGabarit',           label: 'Hors gabarit' },          // 'Oui' = chargement hors gabarit — CONFIDENTIEL (chefs uniquement)
  { key: 'hauteurChargement',     label: 'Hauteur chargement' },    // hauteur si hors gabarit — CONFIDENTIEL (chefs uniquement)
  { key: 'dateValidation',        label: 'Date validation' },       // signature du chef brigade
  { key: 'agentValidation',       label: 'Agent validation' },
  { key: 'signatureValidation',   label: 'Signature validation' },  // empreinte (hash) faisant office de signature numérique
  // --- Ajouts v3.6 (ouillage véhicule + saut du bon de sortie) ---
  { key: 'ouillageNumero',        label: 'N° Ouillage' },           // régime ouillage (permis d'examiner) : n° du permis
  { key: 'ouillageDate',          label: 'Date Ouillage' },
  { key: 'sauteBS',               label: 'Saute Bon de sortie' },   // 'Oui' = pas de cellule Bon de sortie (véhicule transit/conso/MAD sous ouillage)
];

/** Index {key: colonne 0-based} construit une seule fois. */
const COL = (function () {
  const m = {};
  COLS.forEach((c, i) => (m[c.key] = i));
  return m;
})();

/** Schéma "Utilisateurs". */
const USER_COLS = [
  'username', 'passwordHash', 'salt', 'nomComplet',
  'role', 'actif', 'dateCreation', 'derniereConnexion',
];
const UCOL = (function () {
  const m = {}; USER_COLS.forEach((k, i) => (m[k] = i)); return m;
})();

/** Schéma "Historique" (journal d'audit, append-only). */
const LOG_COLS = ['timestamp', 'username', 'nomComplet', 'role', 'action', 'cargaisonId', 'details'];

/**
 * Matrice des droits : action -> rôles autorisés.
 * Toute action passant par rpc() est contrôlée ici, côté serveur.
 * La sécurité ne repose JAMAIS sur le client.
 */
const PERMISSIONS = {
  // Lecture / recherche (tous les rôles)
  'cargo.search':      TOUS_ROLES,
  'cargo.get':         TOUS_ROLES,
  'cargo.list':        TOUS_ROLES,
  'cargo.checkdup':    TOUS_ROLES,                 // détection des doublons camion / conteneur (avertissement)
  // Écriture par étape (1 cellule = 1 rôle ; CFS = cellule unifiée entrée + chargement)
  'cargo.createcamion':[ROLES.CFS, ROLES.ADMIN],   // v3.3 : le CFS crée le camion VIDE à l'entrée (+ type d'opération)
  'cargo.cfs':         [ROLES.CFS, ROLES.ADMIN],   // CFS : saisit l'enlèvement (tout) / ajoute les conteneurs du dépotage
  'cargo.declaration': [ROLES.CFS, ROLES.ADMIN],   // CFS : complète la déclaration (dépotage) + pose les scellés → « Créée »
  'cargo.create':      [ROLES.CFS, ROLES.ADMIN],   // (ancien) saisie groupée — conservé pour Véhicule/Conso/Magasin
  'cargo.update':      [ROLES.CFS, ROLES.ADMIN],   // édition (CFS limité au statut « Créée » ; ADMIN partout)
  'cargo.editcamion':  TOUS_ROLES,                 // correction ciblée du N° camion (tous rôles, tout statut)
  'cargo.sceller':     [ROLES.CFS, ROLES.ADMIN],   // poser les scellés (fin de chargement)
  'cargo.visite':      [ROLES.CFS, ROLES.ADMIN],   // sous-module Visite : modifier le scellé après inspection
  'cargo.mixte':       [ROLES.CFS, ROLES.ADMIN],   // chargement mixte : compléter une cargaison existante
  'cargo.valider':     [ROLES.CHEF_BRIGADE, ROLES.ADMIN], // v3.0 : validation (signature) du chef brigade, après le CFS
  'cargo.horsgabarit': [ROLES.CHEF_BRIGADE, ROLES.CHEF_BRIGADE_ADJOINT, ROLES.CHEF_VISITE, ROLES.CHEF_DIVISION, ROLES.ADMIN], // saisie du champ confidentiel Hors gabarit
  'cargo.t1':          [ROLES.T1, ROLES.ADMIN],    // cellule T1 : n° de transit + bureau de destination
  'cargo.gps':         [ROLES.BALISE, ROLES.ADMIN],// cellule Balise : pose / dispense (+ T1 correct)
  'cargo.gpsedit':     [ROLES.ADMIN],              // remplacement balise : ADMIN uniquement (anti-fraude, cahier 3.4)
  'cargo.bonsortie':   [ROLES.BON_SORTIE, ROLES.ADMIN], // cellule Bon de Sortie : n° du bon
  'cargo.sortie':      [ROLES.PP, ROLES.ADMIN],    // PP : checklist de validation finale
  'cargo.etatcfs':     [ROLES.CFS, ROLES.ADMIN],   // v3.5 : état du camion à la sortie de la zone CFS (traçabilité site)
  'cargo.ouillagedecl':[ROLES.CFS, ROLES.ADMIN],   // v3.6 : compléter la déclaration d'un véhicule sous ouillage (par véhicule)
  'etatcfs.list':      [ROLES.CFS, ROLES.ADMIN],   // v3.5 : liste/traçabilité des camions sur le site par état
  'cargo.arriveebureau': [ROLES.BALISE, ROLES.ADMIN], // dispense : confirmer l'arrivée au bureau de destination
  // Déclarations (apurement)
  'decl.lookup':       [ROLES.CFS, ROLES.ADMIN],   // recherche d'une déclaration + restant à apurer
  // Stock physique de conteneurs
  'stock.list':        TOUS_ROLES,
  'stock.import':      [ROLES.CFS, ROLES.ADMIN],   // import « stock initial » (TC déjà sur site / port autonome)
  'stock.pointage':    [ROLES.CFS, ROLES.ADMIN],   // pointage matinal des TC positionnés
  'stock.entreemagasin': [ROLES.CFS, ROLES.ADMIN], // Magasin/MAD temps 1 : conteneur dépoté/sorti du yard
  'report.stock':      [ROLES.CFS, ROLES.ADMIN],   // v2.7 : délai de séjour & instances des conteneurs en stock
  // Stock ANNONCÉ (v2.8) : annonce de transfert (admin) + pointage à l'entrée (Porte Principale)
  'stockannonce.import':   [ROLES.ADMIN],                       // import de l'annonce de transfert (la veille, par l'admin)
  'stockannonce.list':     TOUS_ROLES,                          // consultation du stock annoncé
  'stockannonce.pointage': [ROLES.PP, ROLES.ADMIN],             // pointage du TC à son arrivée au port sec (Porte Principale)
  'stockannonce.confirmer':[ROLES.CFS, ROLES.ADMIN],            // v3.1 : confirmation CFS avant l'entrée effective au stock PIA
  'report.annonce':        [ROLES.PP, ROLES.CFS, ROLES.ADMIN],  // stats annoncés : non pointés / pointés / taux / délai & instance
  // Rapports
  'report.loading':    [ROLES.CFS, ROLES.ADMIN],            // rapport de chargement camion
  'report.cfs':        [ROLES.CFS, ROLES.ADMIN],            // synthèse d'activité CFS par période (CFS = son activité)
  'report.cfsdetail':  [ROLES.CFS, ROLES.ADMIN],            // détail derrière une carte du rapport CFS
  'report.vehicule':   [ROLES.CFS, ROLES.ADMIN],            // rapport véhicules dépotés (par destination/régime)
  'report.vehiculedetail':[ROLES.CFS, ROLES.ADMIN],         // détail derrière une carte du rapport véhicules
  'report.balise':     [ROLES.BALISE, ROLES.ADMIN],         // synthèse d'activité Balise (pose GPS)
  'report.balisedetail':[ROLES.BALISE, ROLES.ADMIN],
  'report.pp':         [ROLES.PP, ROLES.ADMIN],             // synthèse d'activité Porte Principale (sorties)
  'report.ppdetail':   [ROLES.PP, ROLES.ADMIN],
  'report.kpi':        TOUS_ROLES,                          // KPI stock & flux en EVP (tableau de bord enrichi)
  'report.dispenses':  [ROLES.BALISE, ROLES.ADMIN],         // suivi des dispenses (total / en cours / terminées)
  'report.flux':       [ROLES.ADMIN],                       // analyse des flux CFS / Balise / PP par jour-semaine-mois
  'report.fluxdetail': [ROLES.ADMIN],                       // détail derrière une carte/cellule du rapport flux
  'report.dwell':      [ROLES.CFS, ROLES.ADMIN],            // délai de séjour & camions en instance (aide à la décision)
  'report.dwelldetail':[ROLES.CFS, ROLES.ADMIN],            // détail derrière une carte/tranche du rapport séjour
  'report.list':       [ROLES.ADMIN],
  'report.history':    [ROLES.ADMIN],
  // Tableau de bord / stats
  'dashboard.stats':   TOUS_ROLES,
  // Historique
  'log.list':          [ROLES.ADMIN],
  // Administration des utilisateurs
  'user.list':         [ROLES.ADMIN],
  'user.create':       [ROLES.ADMIN],
  'user.update':       [ROLES.ADMIN],
  'user.toggle':       [ROLES.ADMIN],
  'user.resetpwd':     [ROLES.ADMIN],
  // Compte courant
  'account.changepwd': TOUS_ROLES,
};
