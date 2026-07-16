/**
 * ============================================================================
 *  @cargo/domaine — Constructeurs & validations métier (purs, sans base)
 *  Transcription FIDÈLE de Data.gs : _construireCamion_, _construireVehicule_,
 *  _ligneConteneur_ (v3.6). Messages d'erreur conservés MOT POUR MOT.
 * ============================================================================
 */
import { CONTENEURS_APERCU, CONTENEURS_MAX, OPERATIONS, VEHICULE_DESTINATIONS, tailleBucket } from './constantes.ts';
import { maj, txt } from './normalisation.ts';
import { normaliserConteneur, tcValide, type Conteneur } from './normalisation.ts';

export interface CamionConstruit {
  numeroCamion: string;
  twins: string; // 'Yes' | 'No' (compat v3.6)
  conteneurs: Conteneur[];
  nbConteneurs: number;
  scellesCamion: string[];
  conteneursDetails: { conteneurs: Conteneur[]; scellesCamion: string[] };
}

/**
 * Valide + normalise un camion (dépotage ET enlèvement). Nombre de conteneurs
 * LIBRE (1..CONTENEURS_MAX). Taille + Type obligatoires ; en enlèvement le scellé
 * du conteneur l'est aussi (dépotage : scellés au niveau CAMION, 2-3).
 */
export function construireCamion(
  cam: { numeroCamion?: string; conteneurs?: Partial<Conteneur>[]; scellesCamion?: string[] } | null | undefined,
  type: string,
  exigerScelles = true,
): CamionConstruit {
  const src = cam ?? {};
  const numeroCamion = maj(src.numeroCamion, 40).replace(/[^A-Z0-9/-]/g, '');
  if (!numeroCamion) throw new Error('N° camion invalide (alphanumérique, majuscules).');

  const estDepotage = type === OPERATIONS.DEPOTAGE;

  const conteneurs = (Array.isArray(src.conteneurs) ? src.conteneurs : [])
    .map(normaliserConteneur)
    .filter((c) => c.num);
  if (!conteneurs.length) throw new Error('Camion ' + numeroCamion + ' : au moins un conteneur est requis.');
  if (conteneurs.length > CONTENEURS_MAX)
    throw new Error('Camion ' + numeroCamion + ' : trop de conteneurs (max ' + CONTENEURS_MAX + ').');

  conteneurs.forEach((c, i) => {
    if (!tcValide(c.num))
      throw new Error(
        'Camion ' + numeroCamion + ' · Conteneur ' + (i + 1) +
          ' : N° de conteneur invalide. Format attendu : 4 lettres + 7 chiffres (ex. MSKU1234567).',
      );
    if (!c.taille) throw new Error('Camion ' + numeroCamion + ' · Conteneur ' + (i + 1) + ' : la Taille est obligatoire.');
    if (!c.type) throw new Error('Camion ' + numeroCamion + ' · Conteneur ' + (i + 1) + ' : le Type est obligatoire.');
    if (exigerScelles && type === OPERATIONS.ENLEVEMENT && !c.plomb)
      throw new Error('Camion ' + numeroCamion + ' · Conteneur ' + (i + 1) + ' : le Scellé / Plomb est obligatoire.');
  });

  let scellesCamion: string[] = [];
  if (estDepotage) {
    scellesCamion = (Array.isArray(src.scellesCamion) ? src.scellesCamion : []).map((s) => maj(s, 30)).filter(Boolean);
    if (exigerScelles && scellesCamion.length < 2)
      throw new Error('Camion ' + numeroCamion + ' : au moins 2 scellés sont requis en dépotage.');
    if (scellesCamion.length > 3) throw new Error('Camion ' + numeroCamion + ' : 3 scellés maximum en dépotage.');
    conteneurs.forEach((c) => (c.plomb = '')); // en dépotage, les conteneurs ne portent pas de scellé
  }

  return {
    numeroCamion,
    twins: type === OPERATIONS.ENLEVEMENT && conteneurs.length >= 2 ? 'Yes' : 'No',
    conteneurs,
    nbConteneurs: conteneurs.length,
    scellesCamion,
    conteneursDetails: { conteneurs, scellesCamion: estDepotage ? scellesCamion : [] },
  };
}

export interface CamionEffets {
  numeroCamion: string;
  designation: string;
  chargementTermine: boolean;
  scellesCamion: string[];
}

/**
 * v4 — Camion d'EFFETS DIVERS d'un rapport véhicule : il ne porte PAS de
 * conteneur (les effets proviennent du conteneur d'origine du véhicule) mais
 * un N° de camion, une DÉSIGNATION des effets et ses scellés. Les scellés
 * (2-3, règle dépotage) ne sont exigés que si le chargement est terminé.
 */
export function construireCamionEffets(src: Record<string, unknown> | null | undefined): CamionEffets {
  const o = src ?? {};
  const numeroCamion = maj(o['numeroCamion'], 40).replace(/[^A-Z0-9/-]/g, '');
  if (!numeroCamion) throw new Error('N° camion invalide (alphanumérique, majuscules).');
  const designation = maj(o['designation'], 600);
  if (!designation) throw new Error('Camion ' + numeroCamion + ' : la désignation des effets divers est obligatoire.');
  const chargementTermine = !(o['chargementTermine'] === false);
  const scellesCamion = (Array.isArray(o['scellesCamion']) ? o['scellesCamion'] : []).map((s) => maj(s, 30)).filter(Boolean);
  if (chargementTermine && scellesCamion.length < 2)
    throw new Error('Camion ' + numeroCamion + ' : au moins 2 scellés sont requis en dépotage.');
  if (scellesCamion.length > 3) throw new Error('Camion ' + numeroCamion + ' : 3 scellés maximum en dépotage.');
  return { numeroCamion, designation, chargementTermine, scellesCamion };
}

export interface VehiculeConstruit {
  chassis: string;
  marque: string;
  modele: string;
  couleur: string;
  destination: string;
  extra: { nom: string; valeur: string }[];
}

/** Valide + normalise un véhicule (châssis VIN + destination obligatoires). */
export function construireVehicule(v: Partial<VehiculeConstruit> | null | undefined): VehiculeConstruit {
  const src = v ?? {};
  const chassis = maj(src.chassis, 40).replace(/[^A-Z0-9/-]/g, '');
  if (!chassis) throw new Error('Véhicule : le N° de châssis (VIN) est obligatoire.');
  const destination = txt(src.destination, 40);
  if (!destination) throw new Error('Véhicule ' + chassis + ' : la Destination est obligatoire.');
  if ((VEHICULE_DESTINATIONS as readonly string[]).indexOf(destination) === -1)
    throw new Error('Véhicule ' + chassis + ' : destination invalide (' + VEHICULE_DESTINATIONS.join(', ') + ').');
  const extra = (Array.isArray(src.extra) ? src.extra : [])
    .map((e) => ({ nom: maj(e?.nom, 40), valeur: maj(e?.valeur, 120) }))
    .filter((e) => e.nom || e.valeur);
  return {
    chassis,
    marque: maj(src.marque, 40),
    modele: maj(src.modele, 40),
    couleur: maj(src.couleur, 30),
    destination,
    extra,
  };
}

/** Aperçu conteneur1..4 / plomb1..4 (comportement v3.6, pour affichage éventuel). */
export function apercuConteneurs(cam: CamionConstruit, estDepotage: boolean) {
  const out: Record<string, string> = {};
  for (let i = 0; i < CONTENEURS_APERCU; i++) {
    out['conteneur' + (i + 1)] = cam.conteneurs[i]?.num ?? '';
  }
  if (estDepotage) {
    for (let i = 0; i < 3; i++) out['plomb' + (i + 1)] = cam.scellesCamion[i] ?? '';
    out['plomb4'] = '';
  } else {
    for (let i = 0; i < CONTENEURS_APERCU; i++) out['plomb' + (i + 1)] = cam.conteneurs[i]?.plomb ?? '';
  }
  return out;
}

/** Règle binôme 20' (enlèvement) : renvoie un message d'erreur ou null. */
export function verifierBinome(contsActuels: { taille?: string }[], nouvelleTaille: string): string | null {
  if (contsActuels.length >= 2) return "Enlèvement : 2 conteneurs maximum (binôme 20').";
  if (contsActuels.length === 1) {
    const tousVingt = contsActuels.every((x) => tailleBucket(x.taille) === 't20') && tailleBucket(nouvelleTaille) === 't20';
    if (!tousVingt) return "Binôme autorisé uniquement pour DEUX conteneurs 20'. (40'/45' = 1 seul)";
  }
  return null;
}
