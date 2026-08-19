/**
 * ============================================================================
 *  @cargo/domaine — Moteur de workflow (étapes)
 *  Transcription FIDÈLE de Data.gs : _aFait_, _etatCellules_, _etapesEnAttente_,
 *  _prochaineEtape_ (v3.6). Utilisé par le FRONT (affichage) et par l'EDGE
 *  FUNCTION (autorité) — une seule source, plus de double maintenance.
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
  sauteValidation?: unknown; // ⚠ champ fantôme v3.6 (I-2) : jamais alimenté — conservé à l'identique
  dateValidation?: unknown;
  /**
   * Type de déclaration (T/C/S/A/E). Les types HORS TRANSIT (C = conso,
   * A = admission) sautent le T1 PAR NATURE. On le lit ici pour que le saut soit
   * honoré même quand le flag `sauteT1` n'a pas été persisté (données migrées,
   * type corrigé après coup, déclarant saisi tardivement) — cf. `etatCellules`.
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
   * souligné). Le moteur ne lisait que `sauteBS` — l'orthographe des payloads
   * client — si bien que le saut du bon de sortie écrit en base par les flux
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
  // écrit — sans quoi un type A/C réclamait indûment le T1.
  const t1 = estOui(c.sauteT1) || estTypeSansT1(c.typeDeclaration) || aFait(c.dateT1);
  return {
    cfs: !enCharge, // fin de chargement atteinte (≥ « Créée »)
    // CASCADE DESCENDANTE (décision utilisateur 2026-08-15) — « réputé validé » :
    // la validation du chef brigade est réputée acquise dès que l'étape suivante
    // (le T1, RÉELLEMENT saisi) est faite, ou dès que le camion est SORTI. On ne
    // fabrique AUCUNE signature : c'est une déduction d'affichage/de file, qui
    // vide les fausses « en attente de validation » des camions déjà partis ou
    // déjà passés en T1. La vraie signature (table `validations`) reste seule
    // preuve probante quand elle existe.
    valide: estOui(c.sauteValidation) || aFait(c.dateValidation) || aFait(c.dateT1) || sorti,
    t1,
    balise: estOui(c.sauteBalise) || estOui(c.estVehicule) || aFait(c.datePoseGps),
    // v3.6 : ouillage saute le bon de sortie. Les DEUX orthographes sont lues —
    // voir le commentaire de `sauteBs` dans SourceEtapes.
    // CASCADE : un camion SORTI (passé la PP) n'attend plus son bon de sortie —
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
  // RÉACTIVÉ — la Porte Principale ne peut clôturer qu'une fois le T1 ET la
  // Balise faits (ou sautés par nature : type C/A/E pour le T1, dispense/véhicule
  // pour la Balise). Le Bon de sortie reste, lui, non bloquant.
  const p: Etape[] = [];
  if (!e.valide) p.push('VALIDATION');
  if (!e.t1) p.push('T1');
  if (!e.balise) p.push('BALISE');
  if (!e.bs) p.push('BS');
  if (e.t1 && e.balise) p.push('PP');
  return p;
}

/** Compat : 1re étape en attente (ou null si terminé). */
export function prochaineEtape(c: SourceEtapes): Etape | null {
  const p = etapesEnAttente(c);
  return p.length ? (p[0] as Etape) : null;
}

/**
 * FILE D'ATTENTE UNIQUE (affichage / comptage) — décision utilisateur 2026-08-19.
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
 * v4.1 — VRAIE dispense de balise (correctif 2026-07-27). Une dispense est une
 * décision PRISE À LA BALISE : la cellule exempte de balise une cargaison qui en
 * aurait normalement eu besoin, et enregistre un NUMÉRO D'AUTORISATION obligatoire.
 *
 * ⚠ Ce n'est PAS la même chose qu'un « saute-balise » : les déclarations de type
 * C/A/E (mise à la consommation non balisée…) n'ont pas de balise PAR NATURE et
 * ne passent jamais par la cellule Balise. Les compter comme dispenses gonflait
 * le tableau de bord (59 affichées pour quelques-unes réelles). De même, les
 * véhicules sautent la balise par nature → jamais des dispenses.
 */
export function estDispenseBalise(c: {
  baliseRequise?: unknown; numeroDispense?: unknown; estVehicule?: unknown;
}): boolean {
  if (estOui(c.estVehicule)) return false;
  const pasRequise = c.baliseRequise === false || String(c.baliseRequise) === 'Non';
  return pasRequise && String(c.numeroDispense ?? '').trim() !== '';
}
