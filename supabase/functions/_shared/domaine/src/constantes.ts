/**
 * ============================================================================
 *  @cargo/domaine — Constantes métier
 *  Transcription FIDÈLE de apps-script/Config.gs (v3.6).
 *  Toute divergence par rapport à Config.gs est un bug, sauf mention contraire.
 * ============================================================================
 */

export const APP = {
  NAME: 'Suivi des Cargaisons',
  VERSION: '4.0.0',
  ID_PREFIX: 'CT', // Préfixe des identifiants de cargaison
  RPT_PREFIX: 'RPT', // Préfixe des identifiants de rapport (groupe de camions)
  PAGE_SIZE: 50, // Taille de page par défaut des listes
} as const;
// NB v4 : SESSION_TTL_SEC / HASH_ITERATIONS / BACKUP_FOLDER de la v3.6 sont
// remplacés par Supabase Auth (JWT + 2FA) et les sauvegardes managées.

/** Valeurs par défaut / listes métier. */
export const DEFAUTS = {
  BUREAU_DECLARATION: 'TG120', // Bureau de déclaration pré-rempli
  TYPE_DECLARATION: 'T', // Type de déclaration par défaut : Transit
} as const;

// Types de déclaration douanière au CFS (liste déroulante). NB : « D » (déclaration
// de transit) n'apparaît PAS ici — il est saisi à l'étape T1, pas au CFS.
export const TYPES_DECLARATION = ['T', 'C', 'S', 'A', 'E'] as const;

/** Conteneurs : nombre LIBRE par camion. Garde-fou anti-abus + taille d'aperçu. */
export const CONTENEURS_MAX = 50;
export const CONTENEURS_APERCU = 4;

/** Rôles (une cellule = un rôle dédié, anti-fraude). v2.8 : PORTE_CFS fusionné dans CFS. */
export const ROLES = {
  CFS: 'CFS',
  CHEF_BRIGADE: 'CHEF_BRIGADE',
  CHEF_BRIGADE_ADJOINT: 'CHEF_BRIGADE_ADJOINT',
  CHEF_VISITE: 'CHEF_VISITE',
  CHEF_DIVISION: 'CHEF_DIVISION',
  T1: 'T1',
  BALISE: 'BALISE',
  BON_SORTIE: 'BON_SORTIE',
  PP: 'PP',
  ADMIN: 'ADMIN',
} as const;
export type Role = (typeof ROLES)[keyof typeof ROLES];

/** Tous les rôles (lecture/recherche/tableau de bord/compte courant). */
export const TOUS_ROLES: Role[] = [
  ROLES.CFS, ROLES.CHEF_BRIGADE, ROLES.CHEF_BRIGADE_ADJOINT, ROLES.CHEF_VISITE,
  ROLES.CHEF_DIVISION, ROLES.T1, ROLES.BALISE, ROLES.BON_SORTIE, ROLES.PP, ROLES.ADMIN,
];

/** v3.0 — Profils « chefs » habilités à saisir le champ confidentiel « Hors gabarit ». */
export const CHEFS_HORSGABARIT: Role[] = [
  ROLES.CHEF_BRIGADE, ROLES.CHEF_BRIGADE_ADJOINT, ROLES.CHEF_VISITE, ROLES.CHEF_DIVISION, ROLES.ADMIN,
];

/**
 * v3.2 — « Hors gabarit » (DÉPOTAGE uniquement) : automatique dès que la hauteur
 * saisie par le CFS dépasse 4,5 m. Le CFS + les chefs voient le champ ; les cellules
 * en aval (T1/Balise/Bon de sortie/PP) ne le voient JAMAIS.
 */
export const HAUTEUR_HORS_GABARIT = 4.5;
export const VOIENT_HORSGABARIT: Role[] = [
  ROLES.CFS, ROLES.CHEF_BRIGADE, ROLES.CHEF_BRIGADE_ADJOINT, ROLES.CHEF_VISITE, ROLES.CHEF_DIVISION, ROLES.ADMIN,
];

/** Statuts métier (workflow v2+). Libellés conservés à l'identique (compat données). */
export const STATUTS = {
  CAMION: 'Camion créé', // créé VIDE à l'entrée, pas encore de marchandise
  CHARGEMENT: 'En cours de chargement', // conteneurs associés (dépotage), scellés PAS posés
  VEHICULE_OUILLAGE: 'Véhicule ouillage créé', // v3.6 : dépoté sous ouillage, décl. à renseigner
  CREEE: 'Créée', // CFS validé = fin de chargement / attente validation puis T1
  T1: 'T1 saisi',
  GPS: 'GPS Installé', // balisé ou dispensé
  BS: 'Bon de sortie émis',
  SORTIE: 'Sortie Enregistrée',
} as const;
export type Statut = (typeof STATUTS)[keyof typeof STATUTS];

/** Types d'opération. */
export const OPERATIONS = {
  DEPOTAGE: 'Dépotage',
  ENLEVEMENT: 'Enlèvement',
  VEHICULE: 'Dépotage / Véhicule',
  CONSO: 'Conso (type C)', // mise à la consommation : à baliser OU non balisée
  MAGASIN: 'Sortie Magasin / MAD', // sortie de marchandise en vrac (sans conteneur)
} as const;
export type Operation = (typeof OPERATIONS)[keyof typeof OPERATIONS];

/**
 * v4 — Règle « déclaration de type C = mise à la consommation ».
 * Une déclaration de type C n'est PAS un transit : elle SAUTE toujours le T1.
 * L'agent choisit ensuite si elle est balisée (`consoMode` par défaut) ou non
 * balisée (`consoMode === 'sansbalise'`, dispense) — dans ce dernier cas elle
 * saute aussi la Balise. Source unique utilisée par le CFS itératif et les
 * flux spéciaux (Conso/Magasin), pour éviter la double maintenance.
 */
export function sautsTypeC(typeDeclaration: unknown, consoMode?: unknown): { sauteT1: boolean; sauteBalise: boolean } {
  const estConso = String(typeDeclaration ?? '').trim().toUpperCase() === 'C';
  return { sauteT1: estConso, sauteBalise: estConso && String(consoMode ?? '') === 'sansbalise' };
}

/** Destinations / régimes possibles pour un véhicule dépoté. */
export const VEHICULE_DESTINATIONS = ['Transit', 'Conso', 'MAD', 'Véhicule abandonné'] as const;

/** v3.3 — Le CFS crée le camion et choisit le type ; le routage = le type. */
export const ROUTAGES = {
  ENLEVEMENT: OPERATIONS.ENLEVEMENT,
  DEPOTAGE: OPERATIONS.DEPOTAGE,
} as const;
export function typeDeRoutage(routage: string): Operation {
  return routage === OPERATIONS.DEPOTAGE ? OPERATIONS.DEPOTAGE : OPERATIONS.ENLEVEMENT;
}

/** v2.9/v3.5 — État du camion à la sortie de la zone CFS (traçabilité site, saisi par le CFS). */
export const ETATS_SORTIE = ['En cours de chargement', 'Fin de chargement', 'Vide'] as const;
export type EtatSortie = (typeof ETATS_SORTIE)[number];

/** Statuts du stock physique. */
export const STOCK_STATUTS = { STOCK: 'En stock', POSITIONNE: 'Positionné', DEPOTE: 'Dépoté' } as const;
export type StatutStock = (typeof STOCK_STATUTS)[keyof typeof STOCK_STATUTS];

/** v3.1 — Statuts du stock annoncé : Annoncé (import admin) → Pointé (PP) → Confirmé (CFS). */
export const ANNONCE_STATUTS = { ANNONCE: 'Annoncé', POINTE: 'Pointé', CONFIRME: 'Confirmé' } as const;
export type StatutAnnonce = (typeof ANNONCE_STATUTS)[keyof typeof ANNONCE_STATUTS];

/** EVP (Équivalent Vingt Pieds) par taille : 20'=1 ; 40'=45'=2. */
export function evpDeTaille(bucket: string): number {
  return bucket === 't40' || bucket === 't45' ? 2 : 1;
}

/** Classe une taille de conteneur dans 20 / 40 / 45 / autres (Reports.gs _tailleBucket_). */
export function tailleBucket(t: unknown): 't20' | 't40' | 't45' | 'autres' {
  const s = String(t ?? '').replace(/['''’\s]/g, '');
  if (s.indexOf('20') === 0) return 't20';
  if (s.indexOf('40') === 0) return 't40';
  if (s.indexOf('45') === 0) return 't45';
  return 'autres';
}

/** Tranches d'âge de séjour (rapports dwell / stock). */
export const TRANCHES_SEJOUR = ['0-7', '8-15', '16-30', '31-60', '61-90', '90+'] as const;
export function trancheAge(j: number): (typeof TRANCHES_SEJOUR)[number] {
  if (j <= 7) return '0-7';
  if (j <= 15) return '8-15';
  if (j <= 30) return '16-30';
  if (j <= 60) return '31-60';
  if (j <= 90) return '61-90';
  return '90+';
}
/** Seuil d'alerte du rapport séjour (« 90 jours, pourquoi pas sorti ? »). */
export const SEUIL_ALERTE_SEJOUR = 90;

/** Libellés d'affichage des rôles (Client.html roleLabel). */
export const ROLE_LABELS: Record<string, string> = {
  CFS: 'Agent CFS',
  PORTE_CFS: 'Agent CFS', // alias historique conservé (comptes migrés)
  CHEF_BRIGADE: 'Chef brigade',
  CHEF_BRIGADE_ADJOINT: 'Chef brigade adjoint',
  CHEF_VISITE: 'Chef visite',
  CHEF_DIVISION: 'Chef division',
  T1: 'Agent T1',
  BALISE: 'Agent Balise',
  BON_SORTIE: 'Agent Bon de Sortie',
  PP: 'Agent Porte Principale',
  ADMIN: 'Administrateur',
};

/** Clés du résumé de liste (RESUME_KEYS v3.6) — champs exposés par les listes/files. */
export const RESUME_KEYS = [
  'id', 'reference', 'dateCreation', 'numeroCamion', 'typeOperation',
  'conteneur1', 'conteneur2', 'conteneur3', 'conteneur4', 'statut', 'numeroGps',
  'dateSortie', 'agentCfs', 'rapportId', 'estVehicule', 'conteneurOrigine',
  'sauteT1', 'sauteBalise', 'baliseRequise', 'arriveeBureau',
  'dateT1', 'datePoseGps', 'bonSortieNumero',
  'dateValidation',
  'etatSortie',
  'sauteBS',
] as const;
