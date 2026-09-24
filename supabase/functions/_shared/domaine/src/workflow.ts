/**
 * ============================================================================
 *  @cargo/domaine, Moteur de workflow (étapes)
 *  Transcription FIDÈLE de Data.gs : _aFait_, _etatCellules_, _etapesEnAttente_,
 *  _prochaineEtape_ (v3.6). Utilisé par le FRONT (affichage) et par l'EDGE
 *  FUNCTION (autorité), une seule source, plus de double maintenance.
 *
 *  Modèle PARALLÈLE :
 *    CFS (fin de chargement) → { VALIDATION ∥ T1 ∥ BALISE ∥ BON DE SORTIE } → PP.
 *  Après le CFS, les cellules travaillent EN PARALLÈLE ; la PP peut clôturer dès
 *  que la Balise est posée. Les sauts (conso/magasin/véhicule/ouillage) marquent
 *  la cellule concernée comme déjà « faite ».
 * ============================================================================
 */

import { STATUTS, estTypeSansT1, type Statut } from './constantes.ts';

/** Étapes possibles d'une cargaison. */
export type Etape = 'CFS' | 'VALIDATION' | 'T1' | 'BALISE' | 'BS' | 'PP';

/**
 * Vue minimale d'une cargaison nécessaire au moteur (résumé de liste ou objet
 * complet). Les champs booléens acceptent les deux formes : booléen typé (v4)
 * ou chaîne 'Oui'/'Non' (données migrées / payloads historiques).
 */
export interface SourceEtapes {
  statut: Statut | string;
  sauteValidation?: unknown; // ⚠ champ fantôme v3.6 (I-2) : jamais alimenté, conservé à l'identique
  dateValidation?: unknown;
  /**
   * Type de déclaration (T/C/S/A/E). Les types HORS TRANSIT (C = conso,
   * A = admission) sautent le T1 PAR NATURE. On le lit ici pour que le saut soit
   * honoré même quand le flag `sauteT1` n'a pas été persisté (données migrées,
   * type corrigé après coup, déclarant saisi tardivement), cf. `etatCellules`.
   */
  typeDeclaration?: unknown;
  sauteT1?: unknown;
  dateT1?: unknown;
  sauteBalise?: unknown;
  estVehicule?: unknown;
  datePoseGps?: unknown;
  /**
   * Date de sortie (PP). Renseignée = le camion a QUITTÉ le port sec : il est
   * TERMINÉ, quel que soit son statut. On la lit pour que tout dossier réellement
   * sorti disparaisse des files, même si son `statut` n'a pas été mis à
   * « Sortie Enregistrée » (données migrées, sortie enregistrée hors séquence).
   */
  dateSortie?: unknown;
  sauteBS?: unknown;
  /**
   * ⚠ CORRECTIF 2026-08-10. La colonne SQL `saute_bs` devient `sauteBs` en
   * camelCase (`versCamel` ne met en majuscule QUE la lettre suivant le
   * souligné). Le moteur ne lisait que `sauteBS`, l'orthographe des payloads
   * client, si bien que le saut du bon de sortie écrit en base par les flux
   * ouillage et magasin/MAD n'était JAMAIS honoré : ces cargaisons restaient
   * indéfiniment dans la file « Bon de sortie » et dans le compteur du tableau
   * de bord. On accepte désormais les deux orthographes, comme on accepte déjà
   * 'Oui' et `true`.
   */
  sauteBs?: unknown;
  bonSortieNumero?: unknown;
}

/** _aFait_ : une valeur est « renseignée » (idem v3.6, + gestion des booléens typés). */
export function aFait(v: unknown): boolean {
  return v !== '' && v !== null && v !== undefined && v !== false;
}

/** 'Oui' (chaîne historique) OU true (booléen v4). */
export function estOui(v: unknown): boolean {
  return v === true || String(v) === 'Oui';
}

export interface EtatCellules {
  cfs: boolean;
  valide: boolean;
  t1: boolean;
  balise: boolean;
  bs: boolean;
  sorti: boolean;
}

/** État de chaque cellule pour une cargaison (objet complet OU résumé). */
export function etatCellules(c: SourceEtapes): EtatCellules {
  // v3.6 : « Véhicule ouillage créé » = déclaration pas encore renseignée -> encore côté CFS.
  const enCharge =
    c.statut === STATUTS.CAMION ||
    c.statut === STATUTS.CHARGEMENT ||
    c.statut === STATUTS.VEHICULE_OUILLAGE;
  // SORTI = terminal. Statut « Sortie Enregistrée » OU date de sortie renseignée
  // (2026-08-19) : un dossier réellement sorti ne doit JAMAIS figurer dans une
  // file d'attente, même si son statut est resté à une valeur intermédiaire.
  const sorti = c.statut === STATUTS.SORTIE || aFait(c.dateSortie);
  // T1 fait, sauté par flag, OU sauté PAR NATURE (type hors transit C/A). Le
  // « par nature » rattrape les cargaisons dont le flag `saute_t1` n'a pas été
  // écrit, sans quoi un type A/C réclamait indûment le T1.
  const t1 = estOui(c.sauteT1) || estTypeSansT1(c.typeDeclaration) || aFait(c.dateT1);
  return {
    cfs: !enCharge, // fin de chargement atteinte (≥ « Créée »)
    // CASCADE DESCENDANTE (décision utilisateur 2026-08-15), « réputé validé » :
    // la validation du chef brigade est réputée acquise dès que l'étape suivante
    // (le T1, RÉELLEMENT saisi) est faite, ou dès que le camion est SORTI. On ne
    // fabrique AUCUNE signature : c'est une déduction d'affichage/de file, qui
    // vide les fausses « en attente de validation » des camions déjà partis ou
    // déjà passés en T1. La vraie signature (table `validations`) reste seule
    // preuve probante quand elle existe.
    valide: estOui(c.sauteValidation) || aFait(c.dateValidation) || aFait(c.dateT1) || sorti,
    t1,
    balise: estOui(c.sauteBalise) || estOui(c.estVehicule) || aFait(c.datePoseGps),
    // v3.6 : ouillage saute le bon de sortie. Les DEUX orthographes sont lues,
    // voir le commentaire de `sauteBs` dans SourceEtapes.
    // CASCADE : un camion SORTI (passé la PP) n'attend plus son bon de sortie,
    // il est réputé acquis, ce qui vide les fausses « en attente Bon de sortie ».
    bs: estOui(c.sauteBS) || estOui(c.sauteBs) || aFait(c.bonSortieNumero) || sorti,
    sorti,
  };
}

/** Étapes ENCORE EN ATTENTE (parallèle Balise/Bon de Sortie). */
export function etapesEnAttente(c: SourceEtapes): Etape[] {
  const e = etatCellules(c);
  if (e.sorti) return [];
  if (!e.cfs) return ['CFS']; // camion vide / en cours -> à compléter par le CFS
  // Après le CFS, les cellules Validation / T1 / Balise / Bon de sortie sont
  // ouvertes EN PARALLÈLE. v4.1 (décision utilisateur 2026-07-27) : VERROU PP
  // RÉACTIVÉ : la Porte Principale ne peut clôturer qu'une fois le T1 ET la
  // Balise faits (ou sautés par nature : type C/A/E pour le T1, dispense/véhicule
  // pour la Balise). Le Bon de sortie reste, lui, non bloquant.
  const p: Etape[] = [];
  if (!e.valide) p.push('VALIDATION');
  /* CHAINE STRICTE T1 -> BALISE -> BON DE SORTIE (2026-09-24, demande
     utilisateur). Ces trois cellules ne travaillent plus en parallele : la
     balise attend le T1, le bon de sortie attend la balise. Une etape SAUTEE
     par nature (type C/A/S pour le T1, vehicule ou dispense pour la balise,
     ouillage et magasin pour le bon de sortie) compte comme faite : la chaine
     encadre l'ordre de travail, elle ne rouvre pas des etapes que le regime de
     la declaration ne prevoit pas.
     La VALIDATION reste en parallele : elle n'a jamais bloque le parcours, et
     le T1 la vaut (cascade descendante, voir etatCellules). */
  if (!e.t1) p.push('T1');
  else if (!e.balise) p.push('BALISE');
  else if (!e.bs) p.push('BS');
  if (e.t1 && e.balise) p.push('PP');
  return p;
}

/** Libellé lisible d'une étape, pour les messages adressés à l'agent. */
export const LIBELLE_ETAPE: Record<Etape, string> = {
  CFS: 'la saisie CFS (fin de chargement)',
  VALIDATION: 'la validation du chef de brigade',
  T1: 'le T1',
  BALISE: 'la pose de la balise',
  BS: 'le bon de sortie',
  PP: 'la sortie à la Porte Principale',
};

/**
 * L'étape qui doit être franchie AVANT celle qu'on veut faire, si elle manque.
 *
 * Une seule source pour les deux bouts : le serveur s'en sert pour REFUSER avec
 * une phrase juste, l'écran pour PRÉVENIR avant même le clic. Rend `null` quand
 * la voie est libre.
 */
export function etapePrecedenteManquante(c: SourceEtapes, etape: Etape): Etape | null {
  const e = etatCellules(c);
  if (etape !== 'CFS' && !e.cfs) return 'CFS';
  if (etape === 'BALISE' && !e.t1) return 'T1';
  if (etape === 'BS') {
    if (!e.t1) return 'T1';
    if (!e.balise) return 'BALISE';
  }
  if (etape === 'PP') {
    if (!e.t1) return 'T1';
    if (!e.balise) return 'BALISE';
  }
  return null;
}

/** La phrase montrée à l'agent : ce qui manque, et ce qu'il faut faire d'abord. */
export function messageEtapePrecedente(manquante: Etape, voulue: Etape): string {
  return 'Étape précédente manquante : ' + LIBELLE_ETAPE[manquante] + ' doit être fait avant '
    + LIBELLE_ETAPE[voulue] + '.';
}

/** Compat : 1re étape en attente (ou null si terminé). */
export function prochaineEtape(c: SourceEtapes): Etape | null {
  const p = etapesEnAttente(c);
  return p.length ? (p[0] as Etape) : null;
}

/**
 * FILE D'ATTENTE UNIQUE (affichage / comptage), décision utilisateur 2026-08-19.
 *
 * Un dossier ne doit figurer que dans UNE SEULE file&nbsp;: celle de ce qui lui
 * reste à faire AU PROCHAIN POSTE, dans l'ordre strict&nbsp;:
 *   CFS → VALIDATION → T1 → BALISE → BON DE SORTIE → PP (sortie).
 * Renvoie `null` si le dossier est terminé (sorti).
 *
 * ⚠ À DISTINGUER de `etapesEnAttente`, qui reste l'AUTORITÉ du workflow (files
 * PARALLÈLES) utilisée par les handlers d'écriture et le verrou PP&nbsp;: là, la
 * PP peut clôturer dès le T1 et la Balise faits (bon de sortie non bloquant pour
 * l'ACTION). `fileAttente` sert uniquement aux COMPTEURS et aux LISTES d'attente,
 * pour qu'un même camion ne soit plus compté dans plusieurs files à la fois
 * (fin des totaux « gonflés »). Les étapes SAUTÉES (type C/A/S, véhicule,
 * dispense, ouillage) sont franchies automatiquement, comme dans etatCellules.
 */
export function fileAttente(c: SourceEtapes): Etape | null {
  const e = etatCellules(c);
  if (e.sorti) return null;     // terminé : aucune file
  if (!e.cfs) return 'CFS';     // chargement pas fini
  if (!e.valide) return 'VALIDATION';
  if (!e.t1) return 'T1';
  if (!e.balise) return 'BALISE';
  if (!e.bs) return 'BS';
  return 'PP';                  // tout l'amont fait : attend la sortie
}

/**
 * v4.1, VRAIE dispense de balise (correctif 2026-07-27). Une dispense est une
 * décision PRISE À LA BALISE : la cellule exempte de balise une cargaison qui en
 * aurait normalement eu besoin, et enregistre un NUMÉRO D'AUTORISATION obligatoire.
 *
 * ⚠ Ce n'est PAS la même chose qu'un « saute-balise » : un véhicule saute la
 * balise par nature, il n'est donc jamais dispensé.
 *
 * ⚠ IL FAUT UN VRAI NUMÉRO (2026-09-24, décision utilisateur). Le volet
 * « Dispenses » affichait 80 camions pour une poignée de dispenses réelles. La
 * cause : le champ « N° d'autorisation » est OBLIGATOIRE dès qu'on choisit
 * Dispense, et les agents y tapaient « 0 » (43 fois) ou « SAUTÉ » (21 fois)
 * pour passer. Une mention de contournement n'est pas une autorisation : elle
 * ne fait pas une dispense. Le TYPE de déclaration, lui, n'entre pas dans la
 * règle — ce qui compte est le marquage à la cellule Balise.
 */
export function estDispenseBalise(c: {
  baliseRequise?: unknown; numeroDispense?: unknown; estVehicule?: unknown;
}): boolean {
  if (estOui(c.estVehicule)) return false;
  const pasRequise = c.baliseRequise === false || String(c.baliseRequise) === 'Non';
  return pasRequise && numeroDispenseValide(c.numeroDispense);
}

/**
 * Le numéro d'autorisation est-il une VRAIE référence ?
 *
 * On écarte ce que les agents tapent pour franchir un champ obligatoire : zéro,
 * « sauté », « sans balise », « néant »… La liste tient aux mentions relevées
 * dans la base, accents et ponctuation ignorés. Tout le reste est accepté :
 * « D 42034 », « IM4 » comme « ESCORTE SANVEE CONDJI » — on refuse le vide de
 * sens, pas les formes inattendues.
 */
const MENTIONS_SANS_VALEUR = [
  '', 'SANSBALISE', 'SANS', 'SAUTE', 'SAUTEE', 'SAUT', 'CONSO', 'NEANT', 'RAS', 'NA',
  'AUCUN', 'AUCUNE', 'NON', 'NULL', 'NUL', 'X', 'XX', 'XXX', 'VIDE', 'PASDEBALISE',
];

/**
 * NATURE DE L'EXEMPTION : dispense, escorte, ou rien (2026-09-24, demande
 * utilisateur).
 *
 * La colonne `type_exemption` (migration 00202) porte le choix fait à la
 * cellule Balise. Les lignes ANTÉRIEURES ne l'ont pas : faute de mieux, on la
 * DÉDUIT de la référence saisie, où les agents écrivaient déjà « ESCORTE
 * MILITAIRE » ou « ESCORTE SANVEE CONDJI ». On ne réécrit pas l'historique, on
 * le lit mieux — et toute ligne exemptée sans indice reste une dispense.
 */
export type NatureExemption = 'dispense' | 'escorte' | null;

export function natureExemption(c: {
  baliseRequise?: unknown; numeroDispense?: unknown; estVehicule?: unknown; typeExemption?: unknown;
}): NatureExemption {
  if (!estDispenseBalise(c)) return null;
  const declare = String(c.typeExemption ?? '').trim().toLowerCase();
  if (declare === 'escorte' || declare === 'dispense') return declare;
  const ref = String(c.numeroDispense ?? '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase();
  return ref.indexOf('ESCORT') >= 0 ? 'escorte' : 'dispense';
}

export function numeroDispenseValide(v: unknown): boolean {
  const brut = String(v ?? '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // accents : SAUTÉ = SAUTE
    .toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!brut) return false;
  if (/^0+$/.test(brut)) return false; // « 0 », « 00 », « 000 »
  return MENTIONS_SANS_VALEUR.indexOf(brut) < 0;
}

/* ===================== ENTRÉES ET SORTIES DES FILES =====================
 * 2026-09-13 · demande utilisateur : sous chaque tuile « Attente » du tableau
 * de bord, combien de dossiers sont ENTRÉS dans la file et combien en sont
 * SORTIS sur la période. Un camion qui quitte le CFS pour la validation compte
 * une sortie au CFS et une entrée à la validation, et ainsi de suite.
 *
 * On ne stocke aucun compteur : les instants se DÉDUISENT des horodatages que
 * chaque cellule pose déjà. Un dossier entre dans une file au moment où il a fini
 * tout ce qui la précède, et en sort au moment où il finit cette étape.
 *
 * GARANTIE : les files, leur ordre et leurs sauts sont EXACTEMENT ceux de
 * `fileAttente`. Le dossier dont la sortie est inconnue est dans la file que
 * `fileAttente` désigne, et dans aucune autre. D'où l'invariant, testé : sur une
 * période couvrant toute la vie des dossiers, entrées − sorties = taille de la file.
 */

/** Ordre des files, celui de `fileAttente`. */
export const ORDRE_FILES: readonly Etape[] = ['CFS', 'VALIDATION', 'T1', 'BALISE', 'BS', 'PP'];

export interface SourcePassages extends SourceEtapes {
  dateCreation?: unknown;
  /** Posée par déclencheur depuis le 2026-08-13 (migration 00110). */
  dateFinChargement?: unknown;
  dateBonSortie?: unknown;
}

/** Instants (ms) d'entrée et de sortie d'une file ; `sortie` null = encore dedans. */
export type Passage = { entree: number; sortie: number | null };

export function passagesDesFiles(c: SourcePassages): Partial<Record<Etape, Passage>> {
  const ms = (v: unknown): number | null => {
    if (!aFait(v)) return null;
    const t = new Date(String(v)).getTime();
    return isNaN(t) ? null : t;
  };
  const debut = ms(c.dateCreation);
  if (debut === null) return {};
  const e = etatCellules(c);
  const sortiePort = e.sorti ? ms(c.dateSortie) : null;
  const plusTot = (a: number | null, b: number | null) => (a === null ? b : b === null ? a : Math.min(a, b));

  const faite: Record<Etape, boolean> = { CFS: e.cfs, VALIDATION: e.valide, T1: e.t1, BALISE: e.balise, BS: e.bs, PP: e.sorti };
  // Sauts : les mêmes que ceux qu'`etatCellules` tient pour « faits » sans passage.
  const sautee: Record<Etape, boolean> = {
    CFS: false,
    VALIDATION: estOui(c.sauteValidation),
    T1: estOui(c.sauteT1) || estTypeSansT1(c.typeDeclaration),
    BALISE: estOui(c.sauteBalise) || estOui(c.estVehicule),
    BS: estOui(c.sauteBS) || estOui(c.sauteBs),
    PP: false,
  };
  const dateFin: Record<Etape, number | null> = {
    CFS: ms(c.dateFinChargement),
    // Cascade d'`etatCellules` : réputée validée dès le T1 saisi.
    VALIDATION: plusTot(ms(c.dateValidation), ms(c.dateT1)),
    T1: ms(c.dateT1),
    BALISE: ms(c.datePoseGps),
    BS: aFait(c.bonSortieNumero) ? ms(c.dateBonSortie) : null,
    PP: sortiePort,
  };

  const out: Partial<Record<Etape, Passage>> = {};
  let courant = debut;
  for (const k of ORDRE_FILES) {
    if (sautee[k]) continue;
    if (!(faite[k] || e.sorti)) { out[k] = { entree: courant, sortie: null }; break; }
    // Fin connue ; à défaut, la sortie du port (un camion sorti a quitté toutes
    // les files) ; à défaut encore (dossier ancien sans horodatage), l'instant
    // d'entrée, traversée comptée, sans inventer de durée.
    let fin = dateFin[k] ?? sortiePort ?? courant;
    // Étape faite AVANT d'y arriver (Bon de sortie émis avant la balise) : le
    // dossier traverse la file à l'instant où il l'atteint.
    if (fin < courant) fin = courant;
    if (sortiePort !== null && fin > sortiePort) fin = Math.max(courant, sortiePort);
    out[k] = { entree: courant, sortie: fin };
    courant = fin;
  }
  return out;
}
