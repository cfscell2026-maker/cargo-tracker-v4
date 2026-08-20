/**
 * ============================================================================
 *  @cargo/domaine — Matrice des droits : action -> rôles autorisés
 *  COPIE CONFORME de Config.gs PERMISSIONS (v3.6).
 *  Toute action passant par l'Edge Function rpc est contrôlée ici, côté serveur.
 *  La sécurité ne repose JAMAIS sur le client.
 *
 *  Écarts assumés par rapport à la v3.6 (décisions utilisateur du 15/07/2026) :
 *   + 'user.resetmfa' (nouveau : réinitialisation du 2FA par l'ADMIN — la v3.6
 *     n'avait pas de 2FA). Tout le reste est identique, y compris I-3/I-6/I-7
 *     (conservés à l'identique tant que non tranchés).
 * ============================================================================
 */

import { ROLES, TOUS_ROLES, type Role } from './constantes.ts';

/**
 * CBPI (chef brigade par intérim, 2026-08-19) : profil VOLONTAIREMENT ÉTROIT. Il
 * n'est PAS dans TOUS_ROLES — il ne bénéficie donc d'AUCUN accès en lecture par
 * défaut (ni recherche, ni stock, ni rapports, ni tableau de bord). Il reçoit
 * UNIQUEMENT, et de façon explicite ci-dessous :
 *   · account.me / account.changepwd / account.signin — entrer dans l'appli ;
 *   · cargo.get — ouvrir la fiche d'un dossier à valider ;
 *   · report.validationdecl — la file « À valider » et le dossier par déclaration ;
 *   · cargo.valider / cargo.validerlot — signer (unitaire ou en lot).
 * Toute autre action lui est refusée côté serveur (verifierPermission).
 */
const VALIDE_ET_COMPTE: Role[] = [ROLES.CBPI];

export const PERMISSIONS: Record<string, Role[]> = {
  // Lecture / recherche (tous les rôles)
  'cargo.search': TOUS_ROLES,
  // cargo.get : + CBPI, qui doit ouvrir la fiche du dossier qu'il signe.
  'cargo.get': [...TOUS_ROLES, ...VALIDE_ET_COMPTE],
  'cargo.list': TOUS_ROLES,
  'vehicule.list': TOUS_ROLES, // v4.1 : recherche véhicule (châssis + marque)
  'cargo.checkdup': TOUS_ROLES,
  // Écriture par étape (1 cellule = 1 rôle ; CFS = cellule unifiée entrée + chargement)
  'cargo.createcamion': [ROLES.CFS, ROLES.ADMIN],
  'cargo.cfs': [ROLES.CFS, ROLES.ADMIN],
  'cargo.declaration': [ROLES.CFS, ROLES.ADMIN],
  'cargo.create': [ROLES.CFS, ROLES.ADMIN],
  'cargo.update': [ROLES.CFS, ROLES.ADMIN],
  // SEC-11 (2026-08-10) — Le N° d'immatriculation est l'élément identifiant du
  // bon de sortie et de l'ordre d'exécution. Il était corrigeable par LES DIX
  // RÔLES, à TOUT statut, y compris après la sortie du camion (« I-3 conservé »
  // de la v3.6). Ce n'était pas théorique : sur l'historique de production, 638
  // corrections — soit un mouvement sur huit — dont 442 par la cellule BALISE et
  // 143 par la PP, et 7 après enregistrement de la sortie. Aucune de ces deux
  // cellules n'a de légitimité métier sur la plaque.
  // La correction reste possible là où elle a un sens : le CFS qui a saisi, le
  // chef de brigade qui contrôle, l'ADMIN qui dépanne. Un motif est désormais
  // exigé, et l'action est fermée après la validation (sauf ADMIN).
  'cargo.editcamion': [ROLES.CFS, ROLES.CHEF_BRIGADE, ROLES.ADMIN],
  'cargo.edittype': [ROLES.CFS, ROLES.ADMIN], // correction du type d'opération (phase CFS ; ADMIN partout)
  'cargo.delete': [ROLES.ADMIN], // suppression d'un doublon de cargaison (ADMIN uniquement)
  // v4.3 (2026-08-19) — Archivage des vieux dossiers « goulots » (ADMIN) :
  // clôture réversible et tracée, distincte de l'annulation d'un doublon.
  'cargo.archiver': [ROLES.ADMIN],
  'cargo.desarchiver': [ROLES.ADMIN],
  'cargo.editconteneur': [ROLES.CFS, ROLES.ADMIN], // v4 : correction / retrait d'un conteneur mal saisi (phase CFS ; ADMIN partout)
  'cargo.editdecl': [ROLES.CFS, ROLES.ADMIN], // v4 : correction des infos de déclaration d'un camion enregistré
  'cargo.lotcamions': [ROLES.CFS, ROLES.ADMIN], // v4 : saisie en lot de plusieurs camions sur une même déclaration
  'cargo.fincharge': [ROLES.CFS, ROLES.ADMIN], // v4.1 : seul le CFS clôt son chargement
  'cargo.sceller': [ROLES.CFS, ROLES.ADMIN],
  'cargo.visite': [ROLES.CFS, ROLES.ADMIN],
  'cargo.mixte': [ROLES.CFS, ROLES.ADMIN],
  // Validation / signature : chef brigade titulaire, CBPI (intérim), ADMIN.
  'cargo.valider': [ROLES.CHEF_BRIGADE, ROLES.CBPI, ROLES.ADMIN],
  'cargo.validerlot': [ROLES.CHEF_BRIGADE, ROLES.CBPI, ROLES.ADMIN], // v4 : signature de toute une déclaration
  'cargo.horsgabarit': [ROLES.CHEF_BRIGADE, ROLES.CHEF_BRIGADE_ADJOINT, ROLES.CHEF_VISITE, ROLES.CHEF_DIVISION, ROLES.ADMIN],
  'cargo.t1': [ROLES.T1, ROLES.ADMIN],
  'cargo.gps': [ROLES.BALISE, ROLES.ADMIN],
  // Remplacement d'une balise déjà posée. L'Apps Script le réservait à l'ADMIN
  // (anti-fraude, cahier 3.4) ; ouvert à la cellule BALISE sur demande
  // utilisateur (2026-07-20) : c'est elle qui pose le numéro, elle seule est sur
  // le terrain pour corriger sa propre coquille, et attendre l'ADMIN bloquait le
  // camion. Le garde-fou demeure ailleurs : action possible AU SEUL statut
  // « Balisé » (plus rien une fois le bon de sortie émis ou le camion sorti), et
  // chaque remplacement est tracé dans l'audit avec ancien → nouveau numéro.
  'cargo.gpsedit': [ROLES.BALISE, ROLES.ADMIN],
  'cargo.bonsortie': [ROLES.BON_SORTIE, ROLES.ADMIN],
  'cargo.sortie': [ROLES.PP, ROLES.ADMIN],
  'cargo.etatcfs': [ROLES.CFS, ROLES.ADMIN],
  'cargo.ouillagedecl': [ROLES.CFS, ROLES.ADMIN],
  'etatcfs.list': [ROLES.CFS, ROLES.ADMIN],
  'cargo.arriveebureau': [ROLES.BALISE, ROLES.ADMIN],
  // Déclarations (apurement)
  'decl.lookup': [ROLES.CFS, ROLES.ADMIN],
  // Stock physique de conteneurs
  'stock.list': TOUS_ROLES,
  // v4.2 — recherche d'UN conteneur dans tout le parc, quel que soit son statut.
  // Sert à dire à l'agent, au dépotage, qu'un conteneur est bien au parc mais
  // n'a pas été pointé — plutôt que de le laisser basculer en saisie manuelle.
  'stock.lookup': TOUS_ROLES,
  'stock.import': [ROLES.CFS, ROLES.ADMIN],
  'stock.pointage': [ROLES.CFS, ROLES.ADMIN],
  'stock.entreemagasin': [ROLES.CFS, ROLES.ADMIN],
  'report.stock': [ROLES.CFS, ROLES.CHEF_BRIGADE, ROLES.ADMIN],
  // v4.2 — statistiques de dépotage : positionnés / dépotés / restant par jour.
  'report.depotage': [ROLES.CFS, ROLES.CHEF_BRIGADE, ROLES.CHEF_VISITE, ROLES.CHEF_DIVISION, ROLES.ADMIN],
  // Stock ANNONCÉ (v2.8)
  'stockannonce.import': [ROLES.ADMIN],
  'stockannonce.list': TOUS_ROLES,
  'stockannonce.pointage': [ROLES.PP, ROLES.ADMIN],
  'stockannonce.confirmer': [ROLES.CFS, ROLES.ADMIN],
  'stockannonce.confirmerlot': [ROLES.CFS, ROLES.PP, ROLES.ADMIN], // v4 : confirmation en lot (liste cochable) — PP inclus (le chef PP peut confirmer l'entrée au port sec, décision capitaine 2026-07-17)
  'report.annonce': [ROLES.PP, ROLES.CFS, ROLES.CHEF_BRIGADE, ROLES.ADMIN], // I-6 conservé à l'identique
  // Entrepôts : MAD & Entrepôt industriel (v4.1)
  'entrepot.list': TOUS_ROLES,
  'entrepot.entrees': [ROLES.CFS, ROLES.CHEF_BRIGADE, ROLES.CHEF_DIVISION, ROLES.ADMIN],
  'entrepot.stats': [ROLES.CFS, ROLES.CHEF_BRIGADE, ROLES.CHEF_VISITE, ROLES.CHEF_DIVISION, ROLES.ADMIN],
  'entrepot.sorties': [ROLES.CFS, ROLES.CHEF_BRIGADE, ROLES.CHEF_VISITE, ROLES.CHEF_DIVISION, ROLES.ADMIN],
  // Création d'entrepôt : ADMIN + chefs brigade/division (décision utilisateur 2026-07-27).
  'entrepot.create': [ROLES.ADMIN, ROLES.CHEF_BRIGADE, ROLES.CHEF_DIVISION],
  // Saisie des entrées / sorties : opérationnel = CFS (+ ADMIN).
  'entrepot.entree': [ROLES.CFS, ROLES.ADMIN],
  'entrepot.sortie': [ROLES.CFS, ROLES.ADMIN],
  // Rapports
  // v4 — le CHEF_BRIGADE lit TOUS les rapports opérationnels de TOUTES les cellules
  // (décision utilisateur 2026-07-16). LECTURE SEULE : aucune action d'écriture ne
  // lui est ouverte ici, la règle anti-fraude « 1 cellule = 1 rôle » reste intacte.
  // report.list / report.history (outillage + journal d'audit) restent ADMIN.
  'report.loading': [ROLES.CFS, ROLES.CHEF_BRIGADE, ROLES.ADMIN],
  'report.loadingdecl': [ROLES.CFS, ROLES.CHEF_BRIGADE, ROLES.ADMIN], // v4 : bon de chargement par déclaration
  'report.ordre': [ROLES.CFS, ROLES.CHEF_BRIGADE, ROLES.ADMIN], // v4 : ordre d'exécution imprimable
  // v4 : dossier de validation par déclaration — même périmètre que cargo.valider
  // (le chef signe ; l'ADMIN dépanne). Le CFS n'y a PAS accès : il ne valide pas.
  'report.validationdecl': [ROLES.CHEF_BRIGADE, ROLES.CBPI, ROLES.ADMIN],
  'report.cfs': [ROLES.CFS, ROLES.CHEF_BRIGADE, ROLES.ADMIN],
  'report.cfsdetail': [ROLES.CFS, ROLES.CHEF_BRIGADE, ROLES.ADMIN],
  'report.vehicule': [ROLES.CFS, ROLES.CHEF_BRIGADE, ROLES.ADMIN],
  'report.vehiculedetail': [ROLES.CFS, ROLES.CHEF_BRIGADE, ROLES.ADMIN],
  'report.balise': [ROLES.BALISE, ROLES.CHEF_BRIGADE, ROLES.ADMIN],
  'report.balisedetail': [ROLES.BALISE, ROLES.CHEF_BRIGADE, ROLES.ADMIN],
  'report.pp': [ROLES.PP, ROLES.CHEF_BRIGADE, ROLES.ADMIN],
  'report.ppdetail': [ROLES.PP, ROLES.CHEF_BRIGADE, ROLES.ADMIN],
  'report.kpi': TOUS_ROLES,
  'report.dispenses': [ROLES.BALISE, ROLES.CHEF_BRIGADE, ROLES.ADMIN],
  'report.cargaisons': TOUS_ROLES, // v4.1 : export cargaisons (lecture) — captaines/chefs inclus
  'report.conteneurs': TOUS_ROLES, // v4.1 : export liste conteneurs (lecture)
  'report.flux': [ROLES.CHEF_BRIGADE, ROLES.ADMIN],
  'report.fluxdetail': [ROLES.CHEF_BRIGADE, ROLES.ADMIN],
  'report.destinations': [ROLES.CFS, ROLES.PP, ROLES.CHEF_BRIGADE, ROLES.ADMIN], // v4.1 : répartition par destination
  'report.controles': [ROLES.CHEF_BRIGADE, ROLES.CHEF_BRIGADE_ADJOINT, ROLES.CHEF_VISITE, ROLES.CHEF_DIVISION, ROLES.ADMIN], // v4.1 : hors gabarit / surcharge / transit
  'report.dwell': [ROLES.CFS, ROLES.CHEF_BRIGADE, ROLES.ADMIN],
  // v4.2 — Temps de passage par poste. Indicateur de performance des cellules :
  // il se lit à l'échelle du service, donc l'encadrement au complet, plus le CFS
  // qui pilote le flux au quotidien.
  'report.temps': [ROLES.CFS, ROLES.CHEF_BRIGADE, ROLES.CHEF_BRIGADE_ADJOINT, ROLES.CHEF_VISITE, ROLES.CHEF_DIVISION, ROLES.ADMIN],
  // v4.3 — Horodatage / plage d'activité par cellule (2026-08-19). Chaque agent
  // de cellule voit l'activité de TOUTE sa cellule (heures de début/fin, volume) ;
  // l'encadrement voit l'ensemble.
  'report.horodatage': [ROLES.CFS, ROLES.T1, ROLES.BALISE, ROLES.BON_SORTIE, ROLES.PP,
    ROLES.CHEF_BRIGADE, ROLES.CHEF_BRIGADE_ADJOINT, ROLES.CHEF_VISITE, ROLES.CHEF_DIVISION, ROLES.ADMIN],
  // v4.3 — Analyse des goulots + liste des archivés (nettoyage) : ADMIN + chefs.
  'report.goulots': [ROLES.ADMIN, ROLES.CHEF_BRIGADE, ROLES.CHEF_DIVISION],
  'report.archives': [ROLES.ADMIN, ROLES.CHEF_BRIGADE, ROLES.CHEF_DIVISION],
  'report.dwelldetail': [ROLES.CFS, ROLES.CHEF_BRIGADE, ROLES.ADMIN],
  'report.list': [ROLES.ADMIN],
  'report.history': [ROLES.ADMIN],
  // Tableau de bord / stats — v4.1 : réservé aux chefs (brigade, visite,
  // division) et à l'ADMIN (décision client 2026-07-27). Les agents de cellule
  // n'ont plus le tableau de bord ; l'adjoint non plus.
  'dashboard.stats': [ROLES.CHEF_BRIGADE, ROLES.CHEF_VISITE, ROLES.CHEF_DIVISION, ROLES.ADMIN],
  'dashboard.fiche': [ROLES.CHEF_BRIGADE, ROLES.CHEF_VISITE, ROLES.CHEF_DIVISION, ROLES.ADMIN],
  // Historique
  'log.list': [ROLES.ADMIN],
  // Administration des utilisateurs
  'user.list': [ROLES.ADMIN],
  'user.create': [ROLES.ADMIN],
  'user.update': [ROLES.ADMIN],
  'user.toggle': [ROLES.ADMIN],
  'user.resetpwd': [ROLES.ADMIN],
  'user.resetmfa': [ROLES.ADMIN], // v4 : réinitialisation du 2FA d'un agent
  // Compte courant — + CBPI (sinon il ne pourrait pas entrer dans l'appli).
  'account.me': [...TOUS_ROLES, ...VALIDE_ET_COMPTE], // v4 : profil de la session (username, nomComplet, role)
  'account.changepwd': [...TOUS_ROLES, ...VALIDE_ET_COMPTE],
  'account.signin': [...TOUS_ROLES, ...VALIDE_ET_COMPTE], // SEC-05 : trace de connexion (appelée par le client après login)
};

/** Vérifie une permission ; messages identiques à Auth.gs _exigerPermission_. */
export function verifierPermission(role: Role | string, action: string): void {
  const allowed = PERMISSIONS[action];
  if (!allowed) throw new Error('Action inconnue : ' + action);
  if (allowed.indexOf(role as Role) === -1) throw new Error('Accès refusé pour votre profil.');
}
