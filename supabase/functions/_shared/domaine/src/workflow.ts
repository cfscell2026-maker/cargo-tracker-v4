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

import { STATUTS, type Statut } from './constantes.ts';

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
  sauteT1?: unknown;
  dateT1?: unknown;
  sauteBalise?: unknown;
  estVehicule?: unknown;
  datePoseGps?: unknown;
  sauteBS?: unknown;
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
  return {
    cfs: !enCharge, // fin de chargement atteinte (≥ « Créée »)
    valide: estOui(c.sauteValidation) || aFait(c.dateValidation), // v3.0 : signature du chef brigade
    t1: estOui(c.sauteT1) || aFait(c.dateT1),
    balise: estOui(c.sauteBalise) || estOui(c.estVehicule) || aFait(c.datePoseGps),
    bs: estOui(c.sauteBS) || aFait(c.bonSortieNumero), // v3.6 : ouillage saute le bon de sortie
    sorti: c.statut === STATUTS.SORTIE,
  };
}

/** Étapes ENCORE EN ATTENTE (parallèle Balise/Bon de Sortie). */
export function etapesEnAttente(c: SourceEtapes): Etape[] {
  const e = etatCellules(c);
  if (e.sorti) return [];
  if (!e.cfs) return ['CFS']; // camion vide / en cours -> à compléter par le CFS
  // Après le CFS, les cellules sont ouvertes EN PARALLÈLE ; la PP peut clôturer
  // dès que la Balise est posée.
  const p: Etape[] = [];
  if (!e.valide) p.push('VALIDATION');
  if (!e.t1) p.push('T1');
  if (!e.balise) p.push('BALISE');
  if (!e.bs) p.push('BS');
  if (e.balise) p.push('PP');
  return p;
}

/** Compat : 1re étape en attente (ou null si terminé). */
export function prochaineEtape(c: SourceEtapes): Etape | null {
  const p = etapesEnAttente(c);
  return p.length ? (p[0] as Etape) : null;
}
