/**
 * ============================================================================
 *  Registre des actions RPC — équivalent du switch de Code.gs rpc() (v3.6).
 *  Chaque action est enregistrée sous SON NOM v3.6 ; le routeur (index.ts)
 *  vérifie la permission AVANT d'appeler le handler.
 * ============================================================================
 */
import type { Ctx } from '../ctx.ts';
import * as lecture from './lecture.ts';
import * as ecr from './ecriture.ts';
import * as stk from './stock.ts';
import * as spe from './speciaux.ts';
import * as usr from './utilisateurs.ts';
import * as rap from './rapports.ts';

type H = (ctx: Ctx, data: never) => Promise<unknown>;
const d = <T>(fn: (ctx: Ctx, data: T) => Promise<unknown>): H => fn as H;

export const ACTIONS: Record<string, H> = {
  /* ----- Recherche & lecture ----- */
  'cargo.search': d(lecture.cargoSearch),
  'cargo.get': d(lecture.cargoGet),
  'cargo.list': d(lecture.cargoList),
  'cargo.checkdup': d(lecture.cargoCheckdup),
  'dashboard.stats': d(lecture.dashboardStats),
  'etatcfs.list': d((ctx) => lecture.etatCfsList(ctx)),

  /* ----- Écriture par étape (flux principal) ----- */
  'cargo.createcamion': d(ecr.createcamion),
  'cargo.cfs': d(ecr.cfs),
  'cargo.declaration': d(ecr.declaration),
  'cargo.sceller': d(ecr.sceller),
  'cargo.visite': d(ecr.visite),
  'cargo.valider': d(ecr.valider),
  'cargo.validerlot': d(ecr.validerLot), // v4 : validation de toute une déclaration
  'cargo.horsgabarit': d(ecr.horsgabarit),
  'cargo.t1': d(ecr.t1),
  'cargo.gps': d(ecr.gps),
  'cargo.gpsedit': d(ecr.gpsedit),
  'cargo.bonsortie': d(ecr.bonsortie),
  'cargo.sortie': d(ecr.sortie),
  'cargo.etatcfs': d(ecr.etatcfs),
  'cargo.arriveebureau': d(ecr.arriveebureau),
  'cargo.editcamion': d(ecr.editcamion),
  'cargo.edittype': d(ecr.edittype),
  'cargo.delete': d(ecr.supprimerCargo),
  'cargo.editconteneur': d(ecr.editconteneur), // v4 : correction / suppression d'un conteneur mal saisi
  'cargo.editdecl': d(ecr.editdecl), // v4 : correction des infos de déclaration
  'cargo.lotcamions': d(ecr.lotcamions), // v4 : plusieurs camions sur une même déclaration
  'cargo.update': d(ecr.update),
  'cargo.mixte': d(ecr.mixte),

  /* ----- Spéciaux ----- */
  'cargo.create': d(spe.create),
  'cargo.ouillagedecl': d(spe.ouillagedecl),

  /* ----- Déclarations & stock ----- */
  'decl.lookup': d(stk.declLookup),
  'stock.list': d(stk.stockList),
  'stock.import': d(stk.stockImport),
  'stock.pointage': d(stk.stockPointage),
  'stock.entreemagasin': d(stk.stockEntreeMagasin),
  'report.stock': d((ctx) => stk.rapportStock(ctx)),
  'stockannonce.import': d(stk.annonceImport),
  'stockannonce.list': d(stk.annonceList),
  'stockannonce.pointage': d(stk.annoncePointage),
  'stockannonce.confirmer': d(stk.annonceConfirmer),
  'stockannonce.confirmerlot': d(stk.annonceConfirmerLot), // v4 : confirmation en lot (liste cochable, zéro saisie)
  'report.annonce': d(stk.annonceList),

  /* ----- Rapports ----- */
  'report.loading': d((ctx, data: { id?: string }) => rap.rapportChargement(ctx, String(data?.id ?? ''))),
  'report.loadingdecl': d(rap.rapportChargementDecl), // v4 : bon de chargement par déclaration
  'report.ordre': d(rap.ordreExecution), // v4 : ORDRE D'EXÉCUTION imprimable (trame OTR)
  'report.validationdecl': d(rap.validationParDeclaration), // v4 : dossier de validation par déclaration
  'report.cfs': d(rap.rapportCFS),
  'report.cfsdetail': d(rap.rapportCFSDetail),
  'report.vehicule': d(rap.rapportVehicules),
  'report.vehiculedetail': d(rap.rapportVehiculesDetail),
  'report.balise': d((ctx, data: Record<string, unknown>) => rap.rapportActivite(ctx, { ...data, kind: 'balise' })),
  'report.balisedetail': d((ctx, data: Record<string, unknown>) => rap.rapportActiviteDetail(ctx, { ...data, kind: 'balise' })),
  'report.pp': d((ctx, data: Record<string, unknown>) => rap.rapportActivite(ctx, { ...data, kind: 'pp' })),
  'report.ppdetail': d((ctx, data: Record<string, unknown>) => rap.rapportActiviteDetail(ctx, { ...data, kind: 'pp' })),
  'report.kpi': d(rap.rapportKPI),
  'report.dispenses': d(rap.rapportDispenses),
  'report.flux': d(rap.rapportFlux),
  'report.fluxdetail': d(rap.rapportFluxDetail),
  'report.dwell': d(rap.rapportSejour),
  'report.dwelldetail': d(rap.rapportSejourDetail),
  'report.list': d(rap.rapportListe),
  'report.history': d(rap.rapportHistorique),

  /* ----- Historique ----- */
  'log.list': d(rap.listerHistorique),

  /* ----- Utilisateurs (admin) ----- */
  'user.list': d((ctx) => usr.userList(ctx)),
  'user.create': d(usr.userCreate),
  'user.update': d(usr.userUpdate),
  'user.toggle': d(usr.userToggle),
  'user.resetpwd': d(usr.userResetpwd),
  'user.resetmfa': d(usr.userResetmfa),

  /* ----- Compte courant ----- */
  'account.me': d((ctx) => Promise.resolve({ username: ctx.session.username, nomComplet: ctx.session.nomComplet, role: ctx.session.role })),
  'account.changepwd': d(usr.accountChangepwd),
};
