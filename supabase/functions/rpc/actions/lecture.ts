/**
 * ============================================================================
 *  Actions de LECTURE — transcription fidèle de Data.gs (v3.6) :
 *  _rechercher_, _getCargo_/cargo.get (+_filtrerConfidentiel_), _listerCargaisons_,
 *  _verifierDoublons_, _statistiques_, _listerEtatCFS_.
 * ============================================================================
 */
import type { Ctx } from '../ctx.ts';
import { versCamel } from '../ctx.ts';
import { fetchAll } from './helpers.ts';
import {
  STATUTS,
  APP,
  ROLES,
  VOIENT_HORSGABARIT,
  fileAttente,
  estOui,
  aFait,
  normAlphaNum,
  numeroQuasiDoublon,
  similariteNum,
  type Role,
} from '../../_shared/domaine/src/index.ts';

/** Résumé (v_cargaisons_resume) en camelCase — équivalent RESUME_KEYS. */
async function chargerResume(ctx: Ctx): Promise<Record<string, unknown>[]> {
  // fetchAll : pagine pour ne PAS tronquer au-delà de ~1000 lignes (5000+ migrées).
  const data = await fetchAll(ctx, 'v_cargaisons_resume', '*', { colonne: 'date_creation', ascendant: false });
  return data.map((r) => versCamel(r));
}

function ts(v: unknown): number {
  if (!v) return 0;
  const d = v instanceof Date ? v : new Date(String(v));
  return isNaN(d.getTime()) ? 0 : d.getTime();
}

/* ------------------------------ cargo.get ------------------------------ */

/**
 * RGPD-01 / v4.2 — Rôles autorisés à voir les COORDONNÉES du déclarant.
 *
 * `contact_declarant` est renseigné sur la totalité du fichier (5 022/5 022 à
 * l'audit du 2026-08-10), dont 5 009 numéros de téléphone : c'est une donnée à
 * caractère personnel au sens de la loi togolaise n° 2019-014 et du RGPD (le
 * projet est hébergé en région Europe). Elle était lisible par LES DIX RÔLES
 * via `cargo.get`, alors qu'elle ne sert qu'au CFS (qui appelle le déclarant) et
 * à l'encadrement. Principe de minimisation : on la retire aux autres.
 */
const VOIENT_CONTACT: Role[] = [
  ROLES.CFS, ROLES.CHEF_BRIGADE, ROLES.CHEF_BRIGADE_ADJOINT,
  ROLES.CHEF_VISITE, ROLES.CHEF_DIVISION, ROLES.ADMIN,
];

/**
 * RGPD-01 / v4.2 — Rôles autorisés à voir le NUMÉRO DE BALISE.
 *
 * Le numéro identifie le dispositif censé garantir le transit. Le diffuser à
 * l'ensemble des cellules est un risque opérationnel autant que de
 * confidentialité : il permet de désigner une balise précise à l'extérieur. Il
 * reste visible pour ceux qui en ont l'usage — la cellule qui la pose, celle
 * qui contrôle la sortie, et l'encadrement.
 */
const VOIENT_BALISE: Role[] = [
  ROLES.BALISE, ROLES.PP, ROLES.CFS, ROLES.CHEF_BRIGADE, ROLES.CHEF_BRIGADE_ADJOINT,
  ROLES.CHEF_VISITE, ROLES.CHEF_DIVISION, ROLES.ADMIN,
];

/** v3.0/v3.2 — retire les champs CONFIDENTIELS si la session n'y a pas droit. */
export function filtrerConfidentiel<T extends Record<string, unknown>>(obj: T, role: Role): T {
  const o = obj as Record<string, unknown>;
  if (VOIENT_HORSGABARIT.indexOf(role) === -1) {
    delete o['horsGabarit'];
    delete o['hauteurChargement'];
  }
  if (VOIENT_CONTACT.indexOf(role) === -1) delete o['contactDeclarant']; // RGPD-01
  if (VOIENT_BALISE.indexOf(role) === -1) delete o['numeroGps']; // RGPD-01
  return obj;
}

export async function cargoGet(ctx: Ctx, data: { id?: string }) {
  const id = String(data.id ?? '').trim();
  const { data: row, error } = await ctx.db.from('cargaisons').select('*').eq('id', id).maybeSingle();
  if (error) throw new Error(error.message);
  if (!row) throw new Error('Cargaison introuvable : ' + id);
  // SEC-12 — une cargaison annulée n'est plus une écriture vivante : elle reste
  // en base (on ne détruit pas de pièce) mais n'est plus servie aux cellules.
  if (row['annule'] === true && ctx.session.role !== ROLES.ADMIN)
    throw new Error('Cargaison introuvable : ' + id);
  return filtrerConfidentiel(versCamel(row), ctx.session.role);
}

/* ----------------------------- cargo.search ---------------------------- */

/** Recherche LIMITÉE au N° de camion, très flexible (normalisation des 2 côtés). */
export async function cargoSearch(ctx: Ctx, data: { valeur?: string }) {
  const q = normAlphaNum(data.valeur);
  if (!q) return [];
  const all = await chargerResume(ctx);
  const res: Record<string, unknown>[] = [];
  for (const r of all) {
    const norm = normAlphaNum(r['numeroCamion']);
    if (norm && norm.indexOf(q) > -1) res.push(r);
    if (res.length >= 200) break;
  }
  res.sort((a, b) => ts(b['dateCreation']) - ts(a['dateCreation']));
  return res;
}

/* ------------------------------ cargo.list ----------------------------- */

export async function cargoList(
  ctx: Ctx,
  opts: { statut?: string; etape?: string; categorie?: string; page?: number; pageSize?: number; search?: string; actifs?: boolean },
) {
  const statut = opts.statut || 'tous';
  const etape = opts.etape || '';
  const categorie = opts.categorie || 'camion';
  const actifs = opts.actifs === true;
  const page = Math.max(1, Number(opts.page || 1));
  const pageSize = Math.min(200, Number(opts.pageSize || APP.PAGE_SIZE));
  const search = String(opts.search ?? '').trim().toLowerCase();

  let all = await chargerResume(ctx);

  if (etape) {
    // File d'attente d'une cellule (modèle parallèle : un camion post-T1 figure
    // À LA FOIS dans la file Balise et Bon de Sortie).
    // FILE UNIQUE (2026-08-19) : la liste d'attente d'une cellule ne montre que
    // les dossiers dont c'est LA prochaine étape — plus de camion présent dans
    // deux files à la fois (cf. fileAttente vs etapesEnAttente).
    all = all.filter((r) => fileAttente(r as never) === etape);
    if (etape === 'BALISE') all = all.filter((r) => !estOui(r['estVehicule']));
  } else if (categorie !== 'tous') {
    // Les véhicules sont suivis à part : on ne les mélange pas aux camions.
    // (`tous` = écran Recherche, qui cherche indifféremment camions et véhicules.)
    all = all.filter((r) => (categorie === 'vehicule' ? estOui(r['estVehicule']) : !estOui(r['estVehicule'])));
  }
  // ACTIFS = encore dans l'enceinte : tout ce qui n'est pas sorti par la PP.
  if (actifs) all = all.filter((r) => r['statut'] !== STATUTS.SORTIE);
  if (statut !== 'tous') all = all.filter((r) => r['statut'] === statut);
  if (search) {
    // Recherche tolérante : on compare AUSSI en alphanumérique pur, pour que
    // « AB 12 CD », « AB-12-CD » et « ab12cd » trouvent le même camion.
    const brut = normAlphaNum(search);
    all = all.filter((r) =>
      [r['id'], r['reference'], r['rapportId'], r['numeroCamion'],
        r['conteneur1'], r['conteneur2'], r['conteneur3'], r['conteneur4'], r['numeroGps']]
        .some((x) => {
          const v = String(x ?? '');
          if (v.toLowerCase().indexOf(search) > -1) return true;
          return !!brut && normAlphaNum(v).indexOf(brut) > -1;
        }),
    );
  }
  all.sort((a, b) => ts(b['dateCreation']) - ts(a['dateCreation']));

  const total = all.length;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const start = (page - 1) * pageSize;
  return { rows: all.slice(start, start + pageSize), total, page, pages };
}

/* ---------------------------- vehicule.list ---------------------------- */
/**
 * v4.1 — Recherche VÉHICULE par CHÂSSIS et/ou MARQUE (décision utilisateur
 * 2026-07-27). La liste des cargaisons ne cherchait que sur `numero_camion` (=
 * châssis) via la vue résumé, qui n'expose PAS la marque : impossible de
 * retrouver un véhicule par sa marque, et la liste véhicules n'avait pas de
 * barre de recherche. On lit ici les véhicules directement (colonnes réduites,
 * donc léger pour l'egress) et on cherche sur châssis + marque + modèle.
 */
export async function vehiculeList(ctx: Ctx, opts: { search?: string; actifs?: boolean }) {
  const BLOC = 1000;
  const brut: Record<string, unknown>[] = [];
  for (let debut = 0; ; debut += BLOC) {
    const { data, error } = await ctx.db.from('cargaisons')
      .select('id, numero_camion, statut, date_creation, date_sortie, vehicule_details, conteneur_origine, destination_marchandise')
      .eq('est_vehicule', true)
      .neq('annule', true) // SEC-12 : les cargaisons annulées sortent des listes
      .order('date_creation', { ascending: false }).range(debut, debut + BLOC - 1);
    if (error) throw new Error(error.message);
    const lot = (data ?? []) as Record<string, unknown>[];
    brut.push(...lot);
    if (lot.length < BLOC) break;
  }
  let rows = brut.map((r0) => {
    const r = versCamel(r0);
    const v = (r['vehiculeDetails'] ?? {}) as Record<string, unknown>;
    return {
      id: r['id'], chassis: r['numeroCamion'], marque: v['marque'] ?? '', modele: v['modele'] ?? '',
      couleur: v['couleur'] ?? '', destination: v['destination'] ?? r['destinationMarchandise'] ?? '',
      statut: r['statut'], dateCreation: r['dateCreation'], dateSortie: r['dateSortie'],
      conteneurOrigine: r['conteneurOrigine'],
    };
  });
  if (opts.actifs === true) rows = rows.filter((r) => r['statut'] !== STATUTS.SORTIE);
  const q = String(opts.search ?? '').trim().toLowerCase();
  if (q) {
    const qBrut = normAlphaNum(q);
    rows = rows.filter((r) => [r['chassis'], r['marque'], r['modele']].some((x) => {
      const s = String(x ?? '');
      if (s.toLowerCase().indexOf(q) > -1) return true;
      return !!qBrut && normAlphaNum(s).indexOf(qBrut) > -1;
    }));
  }
  return { rows, total: rows.length };
}

/* ---------------------------- cargo.checkdup --------------------------- */

/** Détection de doublons (AVERTISSEMENT, jamais bloquant) à la saisie. */
export async function cargoCheckdup(
  ctx: Ctx,
  p: { numeroCamion?: string; conteneurs?: string[]; excludeId?: string },
) {
  const exclude = String(p.excludeId ?? '').trim();
  const numCam = normAlphaNum(p.numeroCamion);
  const conts = (Array.isArray(p.conteneurs) ? p.conteneurs : []).map(normAlphaNum).filter(Boolean);

  // `similaires` (2026-08-19) : quasi-doublons de N° de camion — un caractère de
  // trop / de moins / faux, ou deux caractères intervertis. AVERTISSEMENT only :
  // on ne renvoie que des camions ACTIFS (encore dans l'enceinte), non identiques
  // (l'identique exact est déjà dans `camion`), triés du plus ressemblant au
  // moins ressemblant et plafonnés — de quoi demander « n'est-ce pas celui-là ? ».
  const res: {
    camion: unknown[];
    conteneurs: Record<string, unknown[]>;
    similaires: unknown[];
  } = { camion: [], conteneurs: {}, similaires: [] };
  for (const k of conts) res.conteneurs[k] = [];

  const resume = await chargerResume(ctx);
  const similaires: { id: string; statut: string; dateCreation: unknown; numeroCamion: string; similarite: number }[] = [];
  const infoById: Record<string, { id: string; statut: string; dateCreation: unknown; numeroCamion: string; actif: boolean }> = {};
  for (const r of resume) {
    const id = String(r['id']);
    const actif = r['statut'] !== STATUTS.SORTIE;
    infoById[id] = {
      id,
      statut: String(r['statut'] ?? ''),
      dateCreation: r['dateCreation'],
      numeroCamion: String(r['numeroCamion'] ?? ''),
      actif,
    };
    if (id === exclude || !numCam) continue;
    if (normAlphaNum(r['numeroCamion']) === numCam) res.camion.push(infoById[id]);
    else if (actif && numeroQuasiDoublon(numCam, r['numeroCamion'])) {
      similaires.push({
        id, statut: String(r['statut'] ?? ''), dateCreation: r['dateCreation'],
        numeroCamion: String(r['numeroCamion'] ?? ''), similarite: similariteNum(numCam, r['numeroCamion']),
      });
    }
  }
  similaires.sort((a, b) => b.similarite - a.similarite);
  res.similaires = similaires.slice(0, 6);

  if (conts.length) {
    const { data, error } = await ctx.db
      .from('conteneurs')
      .select('cargaison_id, conteneur, numero_camion')
      .in('conteneur', conts);
    if (error) throw new Error(error.message);
    for (const row of data ?? []) {
      const cid = String(row.cargaison_id);
      if (cid === exclude) continue;
      const cn = normAlphaNum(row.conteneur);
      if (!cn || res.conteneurs[cn] === undefined) continue;
      const info = infoById[cid] ?? {
        id: cid, statut: '', dateCreation: '', numeroCamion: row.numero_camion, actif: false,
      };
      res.conteneurs[cn].push({ ...info, conteneur: row.conteneur });
    }
  }

  res.camion.sort((a, b) => ts((b as Record<string, unknown>)['dateCreation']) - ts((a as Record<string, unknown>)['dateCreation']));
  for (const k of Object.keys(res.conteneurs))
    res.conteneurs[k]!.sort((a, b) => ts((b as Record<string, unknown>)['dateCreation']) - ts((a as Record<string, unknown>)['dateCreation']));
  return res;
}

/* --------------------------- dashboard.stats --------------------------- */

function memeJourLocal(v: unknown, ref: Date): boolean {
  if (!v) return false;
  const d = v instanceof Date ? v : new Date(String(v));
  if (isNaN(d.getTime())) return false;
  return d.getFullYear() === ref.getFullYear() && d.getMonth() === ref.getMonth() && d.getDate() === ref.getDate();
}

/**
 * TABLEAU DE BORD — refonte 2026-08-19 (demande utilisateur).
 *
 * DEUX natures de chiffres, qu'il ne faut plus mélanger :
 *
 *   · ÉVÉNEMENTS DE LA PÉRIODE — « qu'est-ce qui s'est PASSÉ à chaque cellule
 *     dans la période choisie ? ». Chaque passage est compté à LA DATE DE SA
 *     PROPRE CELLULE, jamais à la date de création du camion : une sortie du
 *     jour est une sortie du jour, même si le camion est entré la semaine
 *     dernière. C'est exactement la lecture de la fiche de synthèse (ficheBord).
 *     → creesPeriode (entrée CFS), t1Periode, balisesPeriode, bonsPeriode,
 *       sortiePeriode, vehiculesSortisPeriode.
 *
 *   · EN ATTENTE MAINTENANT — « où sont, à l'instant T, les dossiers en
 *     souffrance ? ». État instantané, INDÉPENDANT de la période : un camion
 *     entré il y a un mois et toujours bloqué au T1 doit apparaître dans la file
 *     T1 d'aujourd'hui. On ne filtre donc PAS ces compteurs par la période.
 *     → attValidation, attT1, attBalise, attBs, attPP, camion, chargement,
 *       vehiculesAttente.
 *
 * L'ancienne version filtrait TOUT par la date de création : la tuile « Sortis »
 * ne montrait que les camions créés ET sortis dans la période — un camion sorti
 * aujourd'hui mais entré avant n'y figurait pas. C'est le défaut corrigé ici.
 */
export async function dashboardStats(ctx: Ctx, opts: { du?: string; au?: string }) {
  const stats = {
    // Événements datés sur la période (chaque cellule à sa propre date).
    creesPeriode: 0, t1Periode: 0, balisesPeriode: 0, bonsPeriode: 0, sortiePeriode: 0,
    vehiculesSortisPeriode: 0,
    // En attente — état instantané, hors période.
    attValidation: 0, attT1: 0, attBalise: 0, attBs: 0, attPP: 0,
    camion: 0, chargement: 0, vehiculesAttente: 0,
    // Divers / compat.
    total: 0, sortie: 0, aujourdHui: 0,
  };
  const du = opts.du ? new Date(opts.du + 'T00:00:00') : null;
  const auJ = opts.au ? new Date(opts.au + 'T00:00:00') : null;
  const auEx = auJ ? new Date(auJ.getTime() + 86400000) : null; // borne haute exclusive
  const dansPeriode = (v: unknown): boolean => {
    if (!v) return false;
    const d = new Date(String(v));
    if (isNaN(d.getTime())) return false;
    if (du && d < du) return false;
    if (auEx && d >= auEx) return false;
    return true;
  };

  const data = await chargerResume(ctx);
  const today = new Date();
  for (const r of data) {
    const veh = estOui(r['estVehicule']);

    /* --- ÉVÉNEMENTS DE LA PÉRIODE (chaque cellule à sa date) --- */
    if (veh) {
      if (dansPeriode(r['dateSortie'])) stats.vehiculesSortisPeriode++;
    } else {
      if (dansPeriode(r['dateCreation'])) stats.creesPeriode++;
      if (dansPeriode(r['dateT1'])) stats.t1Periode++;
      if (dansPeriode(r['datePoseGps'])) stats.balisesPeriode++;
      // date_bon_sortie n'est ajoutée à la vue résumé que par la migration
      // 00130 ; en son absence le champ est `undefined` → 0 (dégradation propre).
      if (dansPeriode(r['dateBonSortie']) && aFait(r['bonSortieNumero'])) stats.bonsPeriode++;
      if (dansPeriode(r['dateSortie'])) stats.sortiePeriode++;
      if (memeJourLocal(r['dateCreation'], today)) stats.aujourdHui++;
    }

    /* --- EN ATTENTE MAINTENANT (instant T, hors période) --- */
    if (veh) {
      if (r['statut'] !== STATUTS.SORTIE) stats.vehiculesAttente++;
      continue;
    }
    stats.total++;
    if (r['statut'] === STATUTS.CAMION) stats.camion++;
    else if (r['statut'] === STATUTS.CHARGEMENT) stats.chargement++;
    // FILE UNIQUE (2026-08-19) : chaque camion ne compte QUE dans sa prochaine
    // étape. Les files ne se chevauchent plus → la somme des tuiles « en attente »
    // égale le nombre de dossiers réellement en cours (fin des totaux gonflés).
    switch (fileAttente(r as never)) {
      case 'VALIDATION': stats.attValidation++; break;
      case 'T1': stats.attT1++; break;
      case 'BALISE': stats.attBalise++; break;
      case 'BS': stats.attBs++; break;
      case 'PP': stats.attPP++; break;
    }
  }
  stats.sortie = stats.sortiePeriode; // alias compat (ancien libellé client)
  return stats;
}

/* ----------------------------- etatcfs.list ---------------------------- */

/**
 * v4 — POINTAGE DES CAMIONS À LA SORTIE (ex-« état des camions », v3.5).
 * Situation du PARKING : camions ET véhicules-châssis encore présents, en
 * DÉFALQUANT (décision utilisateur 2026-07-16) :
 *   - ceux qui ont déjà PRIS LA BALISE (datePoseGps renseignée) ;
 *   - ceux SORTIS à la PP (statut « Sortie Enregistrée »).
 * NB : on teste datePoseGps (acte physique de prise de balise) et NON
 * etatCellules().balise, qui compte les véhicules et les dispenses comme
 * « faits » alors qu'ils sont toujours au parking.
 */
export async function etatCfsList(ctx: Ctx) {
  const out = {
    rows: [] as unknown[],
    compte: { total: 0, camions: 0, vehicules: 0, enCours: 0, fin: 0, vide: 0, np: 0 },
  };
  const data = await chargerResume(ctx);
  for (const r of data) {
    if (r['statut'] === STATUTS.SORTIE) continue; // sorti à la PP → défalqué
    if (aFait(r['datePoseGps'])) continue; // a déjà pris la balise → défalqué
    out.compte.total++;
    const veh = estOui(r['estVehicule']);
    if (veh) out.compte.vehicules++;
    else out.compte.camions++;
    const e = String(r['etatSortie'] ?? '');
    if (e === 'En cours de chargement') out.compte.enCours++;
    else if (e === 'Fin de chargement') out.compte.fin++;
    else if (e === 'Vide') out.compte.vide++;
    else out.compte.np++;
    out.rows.push({
      id: r['id'], numeroCamion: r['numeroCamion'], typeOperation: r['typeOperation'],
      statut: r['statut'], etatSortie: e, estVehicule: veh,
    });
  }
  return out;
}
