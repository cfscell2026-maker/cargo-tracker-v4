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

export const PERMISSIONS: Record<string, Role[]> = {
  // Lecture / recherche (tous les rôles)
  'cargo.search': TOUS_ROLES,
  'cargo.get': TOUS_ROLES,
  'cargo.list': TOUS_ROLES,
  'cargo.checkdup': TOUS_ROLES,
  // Écriture par étape (1 cellule = 1 rôle ; CFS = cellule unifiée entrée + chargement)
  'cargo.createcamion': [ROLES.CFS, ROLES.ADMIN],
  'cargo.cfs': [ROLES.CFS, ROLES.ADMIN],
  'cargo.declaration': [ROLES.CFS, ROLES.ADMIN],
  'cargo.create': [ROLES.CFS, ROLES.ADMIN],
  'cargo.update': [ROLES.CFS, ROLES.ADMIN],
  'cargo.editcamion': TOUS_ROLES, // correction ciblée du N° camion (tous rôles, tout statut) — I-3 conservé
  'cargo.edittype': [ROLES.CFS, ROLES.ADMIN], // correction du type d'opération (phase CFS ; ADMIN partout)
  'cargo.delete': [ROLES.ADMIN], // suppression d'un doublon de cargaison (ADMIN uniquement)
  'cargo.editconteneur': [ROLES.CFS, ROLES.ADMIN], // v4 : correction / retrait d'un conteneur mal saisi (phase CFS ; ADMIN partout)
  'cargo.editdecl': [ROLES.CFS, ROLES.ADMIN], // v4 : correction des infos de déclaration d'un camion enregistré
  'cargo.lotcamions': [ROLES.CFS, ROLES.ADMIN], // v4 : saisie en lot de plusieurs camions sur une même déclaration
  'cargo.sceller': [ROLES.CFS, ROLES.ADMIN],
  'cargo.visite': [ROLES.CFS, ROLES.ADMIN],
  'cargo.mixte': [ROLES.CFS, ROLES.ADMIN],
  'cargo.valider': [ROLES.CHEF_BRIGADE, ROLES.ADMIN],
  'cargo.horsgabarit': [ROLES.CHEF_BRIGADE, ROLES.CHEF_BRIGADE_ADJOINT, ROLES.CHEF_VISITE, ROLES.CHEF_DIVISION, ROLES.ADMIN],
  'cargo.t1': [ROLES.T1, ROLES.ADMIN],
  'cargo.gps': [ROLES.BALISE, ROLES.ADMIN],
  'cargo.gpsedit': [ROLES.ADMIN], // remplacement balise : ADMIN uniquement (anti-fraude)
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
  'stock.import': [ROLES.CFS, ROLES.ADMIN],
  'stock.pointage': [ROLES.CFS, ROLES.ADMIN],
  'stock.entreemagasin': [ROLES.CFS, ROLES.ADMIN],
  'report.stock': [ROLES.CFS, ROLES.CHEF_BRIGADE, ROLES.ADMIN],
  // Stock ANNONCÉ (v2.8)
  'stockannonce.import': [ROLES.ADMIN],
  'stockannonce.list': TOUS_ROLES,
  'stockannonce.pointage': [ROLES.PP, ROLES.ADMIN],
  'stockannonce.confirmer': [ROLES.CFS, ROLES.ADMIN],
  'stockannonce.confirmerlot': [ROLES.CFS, ROLES.PP, ROLES.ADMIN], // v4 : confirmation en lot (liste cochable) — PP inclus (le chef PP peut confirmer l'entrée au port sec, décision capitaine 2026-07-17)
  'report.annonce': [ROLES.PP, ROLES.CFS, ROLES.CHEF_BRIGADE, ROLES.ADMIN], // I-6 conservé à l'identique
  // Rapports
  // v4 — le CHEF_BRIGADE lit TOUS les rapports opérationnels de TOUTES les cellules
  // (décision utilisateur 2026-07-16). LECTURE SEULE : aucune action d'écriture ne
  // lui est ouverte ici, la règle anti-fraude « 1 cellule = 1 rôle » reste intacte.
  // report.list / report.history (outillage + journal d'audit) restent ADMIN.
  'report.loading': [ROLES.CFS, ROLES.CHEF_BRIGADE, ROLES.ADMIN],
  'report.loadingdecl': [ROLES.CFS, ROLES.CHEF_BRIGADE, ROLES.ADMIN], // v4 : bon de chargement par déclaration
  'report.ordre': [ROLES.CFS, ROLES.CHEF_BRIGADE, ROLES.ADMIN], // v4 : ordre d'exécution imprimable
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
  'report.flux': [ROLES.CHEF_BRIGADE, ROLES.ADMIN],
  'report.fluxdetail': [ROLES.CHEF_BRIGADE, ROLES.ADMIN],
  'report.dwell': [ROLES.CFS, ROLES.CHEF_BRIGADE, ROLES.ADMIN],
  'report.dwelldetail': [ROLES.CFS, ROLES.CHEF_BRIGADE, ROLES.ADMIN],
  'report.list': [ROLES.ADMIN],
  'report.history': [ROLES.ADMIN],
  // Tableau de bord / stats
  'dashboard.stats': TOUS_ROLES,
  // Historique
  'log.list': [ROLES.ADMIN],
  // Administration des utilisateurs
  'user.list': [ROLES.ADMIN],
  'user.create': [ROLES.ADMIN],
  'user.update': [ROLES.ADMIN],
  'user.toggle': [ROLES.ADMIN],
  'user.resetpwd': [ROLES.ADMIN],
  'user.resetmfa': [ROLES.ADMIN], // v4 : réinitialisation du 2FA d'un agent
  // Compte courant
  'account.me': TOUS_ROLES, // v4 : profil de la session (username, nomComplet, role)
  'account.changepwd': TOUS_ROLES,
};

/** Vérifie une permission ; messages identiques à Auth.gs _exigerPermission_. */
export function verifierPermission(role: Role | string, action: string): void {
  const allowed = PERMISSIONS[action];
  if (!allowed) throw new Error('Action inconnue : ' + action);
  if (allowed.indexOf(role as Role) === -1) throw new Error('Accès refusé pour votre profil.');
}
