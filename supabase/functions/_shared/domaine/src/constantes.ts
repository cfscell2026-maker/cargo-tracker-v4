/**
 * ============================================================================
 *  @cargo/domaine, Constantes métier
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
// de transit) n'apparaît PAS ici, il est saisi à l'étape T1, pas au CFS.
export const TYPES_DECLARATION = ['T', 'C', 'S', 'A', 'E'] as const;

/**
 * CE QUE CHAQUE LETTRE VEUT DIRE (2026-09-24, precise par l'utilisateur).
 *
 * Les listes deroulantes n'affichaient que la lettre : un agent nouveau devait
 * la deviner ou demander. La VALEUR enregistree reste la lettre seule ; seul
 * l'affichage porte le sens.
 */
export const LIBELLES_TYPE_DECLARATION: Record<string, string> = {
  /* 'T' = TRANSIT, tout court (2026-09-26, correction de l'utilisateur). Le
     « transit national » est un ENGAGEMENT, pas un type de declaration : les
     deux se lisaient pareil dans les listes, ce qui melangeait deux notions
     distinctes. Voir ENGAGEMENTS plus bas. */
  T: 'Transit',
  C: 'Mise en conso',
  S: 'Entrée en entrepôt',
  A: 'Entrée en MAD',
  E: 'Exportation',
};

/** « Transit » pour 'T'. Rend la lettre seule si elle est inconnue. */
export function libelleTypeDeclaration(t: unknown): string {
  const cle = String(t ?? '').trim().toUpperCase();
  return LIBELLES_TYPE_DECLARATION[cle] ?? cle;
}

/** « T (Transit) » : ce qu'affiche une liste deroulante. */
export function optionTypeDeclaration(t: unknown): string {
  const cle = String(t ?? '').trim().toUpperCase();
  const lib = LIBELLES_TYPE_DECLARATION[cle];
  return lib ? cle + ' (' + lib + ')' : cle;
}

/** Conteneurs : nombre LIBRE par camion. Garde-fou anti-abus + taille d'aperçu. */
export const CONTENEURS_MAX = 50;
export const CONTENEURS_APERCU = 4;

/** Rôles (une cellule = un rôle dédié, anti-fraude). v2.8 : PORTE_CFS fusionné dans CFS. */
export const ROLES = {
  CFS: 'CFS',
  CHEF_BRIGADE: 'CHEF_BRIGADE',
  CHEF_BRIGADE_ADJOINT: 'CHEF_BRIGADE_ADJOINT',
  // CBPI : Chef brigade PAR INTÉRIM (2026-08-19). Délégation de la SEULE
  // validation/signature quand le chef brigade titulaire n'est pas là. Ce profil
  // ne voit QUE la file « À valider » et ne peut QUE valider (aucun autre écran,
  // aucune autre action). La traçabilité distingue ses signatures de celles du
  // titulaire (colonne role_validation + libellé sur la fiche).
  CBPI: 'CBPI',
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

/** v3.0, Profils « chefs » habilités à saisir le champ confidentiel « Hors gabarit ». */
export const CHEFS_HORSGABARIT: Role[] = [
  ROLES.CHEF_BRIGADE, ROLES.CHEF_BRIGADE_ADJOINT, ROLES.CHEF_VISITE, ROLES.CHEF_DIVISION, ROLES.ADMIN,
];

/**
 * v3.2, « Hors gabarit » (DÉPOTAGE uniquement) : automatique dès que la hauteur
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
 * v4, Types de déclaration qui NE SONT PAS un transit : ils SAUTENT le T1 et
 * laissent à l'agent le choix de baliser ou non.
 *   C = mise à la consommation ;
 *   A = admission (décision utilisateur 2026-07-22 : « le type A se comporte
 *       comme la conso, on donne le choix de baliser ou pas ») ;
 *   S = ne prend pas le T1 non plus (décision utilisateur 2026-08-19 : « seules
 *       les déclarations de type T et E prennent les T1 »).
 * SEULS les types T (transit) et E restent sur le parcours T1 → Balise. Tout
 * autre type explicitement saisi saute le T1 ; un type ENCORE VIDE (camion tout
 * juste créé, déclaration pas renseignée) n'est PAS considéré comme sauté, il
 * reste dans la file T1 jusqu'à ce que le type soit connu (voir estTypeSansT1).
 */
export const TYPES_SANS_T1 = ['C', 'A', 'S'] as const;
export function estTypeSansT1(typeDeclaration: unknown): boolean {
  const t = String(typeDeclaration ?? '').trim().toUpperCase();
  return (TYPES_SANS_T1 as readonly string[]).indexOf(t) >= 0;
}

/**
 * Règle de parcours d'une déclaration hors transit : elle SAUTE toujours le T1.
 * L'agent choisit ensuite si elle est balisée (`consoMode` par défaut) ou non
 * balisée (`consoMode === 'sansbalise'`, dispense), dans ce dernier cas elle
 * saute aussi la Balise. Source unique utilisée par le CFS itératif et les
 * flux spéciaux (Conso/Magasin), pour éviter la double maintenance.
 * NB : le nom `sautsTypeC` est conservé (appelé partout) bien que la règle
 * couvre désormais C ET A.
 */
export function sautsTypeC(typeDeclaration: unknown, consoMode?: unknown): { sauteT1: boolean; sauteBalise: boolean } {
  const sansT1 = estTypeSansT1(typeDeclaration);
  return { sauteT1: sansT1, sauteBalise: sansT1 && String(consoMode ?? '') === 'sansbalise' };
}

/** Phrase d'explication du parcours, à l'écran, pour un type hors transit. */
export function libelleTypeSansT1(typeDeclaration: unknown): string {
  const t = String(typeDeclaration ?? '').trim().toUpperCase();
  if (t === 'C') return 'Type C = mise en conso';
  if (t === 'A') return 'Type A = entrée en MAD (même parcours que la conso)';
  if (t === 'S') return 'Type S = entrée en entrepôt (ne prend pas le T1)';
  const lib = LIBELLES_TYPE_DECLARATION[t];
  return lib ? 'Type ' + t + ' = ' + lib.toLowerCase() : 'Type ' + t;
}

/**
 * v4.3, HORS GABARIT & SURCHARGE : DÉPOTAGE UNIQUEMENT (décision utilisateur
 * 2026-08-19). Seul un dépotage (déchargement de conteneurs, marchandise pesée
 * et mesurée à l'entrée) peut être hors gabarit ou en surcharge. Un enlèvement
 * (conteneur plombé qui ressort), un véhicule, une conso ou une sortie magasin ne
 * sont NI pesés NI contrôlés en gabarit&nbsp;: on ne demande donc plus la pesée à
 * la validation pour ces opérations, et le hors gabarit ne les concerne pas.
 * Source unique utilisée par le CFS (hauteur), la validation (pesée) et l'affichage.
 */
export function exigeControlePoids(typeOperation: unknown): boolean {
  return String(typeOperation ?? '') === OPERATIONS.DEPOTAGE;
}

/** Destinations / régimes possibles pour un véhicule dépoté. */
export const VEHICULE_DESTINATIONS = ['Transit', 'Conso', 'MAD', 'Véhicule abandonné'] as const;

/**
 * v4.1, DESTINATIONS de la marchandise (décision utilisateur 2026-07-27).
 * Liste déroulante partout où la destination se saisit, au lieu du texte libre.
 * TG = transit national ; les autres = pays de destination du transit.
 */
export const DESTINATIONS = [
  { code: 'TG', label: 'TG (Transit National)' },
  { code: 'BF', label: 'BF' },
  { code: 'NE', label: 'NE' },
  { code: 'ML', label: 'ML' },
  { code: 'CI', label: 'CI' },
  { code: 'BJ', label: 'BJ' },
  { code: 'GH', label: 'GH' },
  { code: 'NG', label: 'NG' },
] as const;
export const DESTINATION_CODES = DESTINATIONS.map((d) => d.code);

/**
 * Ramène une valeur de destination (code v4.1 OU ancien texte libre migré) à un
 * code connu, sinon « Autres ». Sert aux rapports par destination.
 */
export function codeDestination(v: unknown): string {
  const s = String(v ?? '').toUpperCase().replace(/[^A-Z]/g, '');
  if (!s) return 'Autres';
  const hit = (DESTINATION_CODES as readonly string[]).find((c) => s === c || s.startsWith(c));
  return hit ?? 'Autres';
}

/**
 * v4.1, ENTREPÔTS (décision utilisateur 2026-07-27). Deux types au
 * fonctionnement identique ; seule l'UNITÉ D'APUREMENT change : MAD apure des
 * QUANTITÉS (nombre de colis), INDUSTRIEL apure des POIDS (kg).
 */
export const ENTREPOT_TYPES = { MAD: 'MAD', INDUSTRIEL: 'INDUSTRIEL' } as const;
export type EntrepotType = (typeof ENTREPOT_TYPES)[keyof typeof ENTREPOT_TYPES];
/** Une déclaration porte jusqu'à 11 articles (marchandises distinctes). */
export const ARTICLES_MAX = 11;
/** Unité d'apurement selon le type d'entrepôt. */
export function uniteApurement(type: unknown): 'poids' | 'colis' {
  return String(type) === ENTREPOT_TYPES.INDUSTRIEL ? 'poids' : 'colis';
}
/** Clé d'une déclaration (année|bureau|type|numéro), pour regrouper l'apurement. */
export function cleDecl(d: { anneeDeclaration?: unknown; bureauDeclaration?: unknown; typeDeclaration?: unknown; numeroDeclaration?: unknown }): string {
  return [d.anneeDeclaration, d.bureauDeclaration, d.typeDeclaration, d.numeroDeclaration]
    .map((x) => String(x ?? '').toUpperCase().replace(/\s+/g, '')).join('|');
}

/** v3.3, Le CFS crée le camion et choisit le type ; le routage = le type. */
export const ROUTAGES = {
  ENLEVEMENT: OPERATIONS.ENLEVEMENT,
  DEPOTAGE: OPERATIONS.DEPOTAGE,
} as const;
export function typeDeRoutage(routage: string): Operation {
  return routage === OPERATIONS.DEPOTAGE ? OPERATIONS.DEPOTAGE : OPERATIONS.ENLEVEMENT;
}

/** v2.9/v3.5, État du camion à la sortie de la zone CFS (traçabilité site, saisi par le CFS). */
export const ETATS_SORTIE = ['En cours de chargement', 'Fin de chargement', 'Vide'] as const;
export type EtatSortie = (typeof ETATS_SORTIE)[number];

/**
 * SUIVI DES ENGAGEMENTS (2026-09-10) : renseigné par le chef de brigade au
 * moment de la validation, sur TOUTES les opérations.
 *
 * Ces libellés sont des PROPOSITIONS, pas une liste fermée : le chef peut
 * toujours saisir autre chose. Le champ stocké est donc du texte libre, et
 * cette liste ne sert qu'à éviter de retaper les trois cas courants, ce qui
 * limite au passage les variantes d'orthographe dans les rapports.
 */
export const ENGAGEMENTS = ['Transit national', 'Transit côtier', 'BFE 03 Sinkase'] as const;
export type Engagement = (typeof ENGAGEMENTS)[number];

/**
 * Rôles qui suivent les engagements : ils voient l'échéancier au tableau de bord
 * et peuvent solder un engagement (« Effectué »).
 *
 * C'est le chef de brigade qui prend l'engagement en signant ; c'est donc lui,
 * et son encadrement, qui en répondent. Les cellules d'exécution (T1, Balise,
 * Bon de sortie, PP) n'ont pas à porter cette relance, elle n'est pas de leur
 * ressort et n'apparaît pas sur leur tableau de bord.
 *
 * Volontairement DISTINCT de `CHEFS_HORSGABARIT`, qui a aujourd'hui la même
 * composition : les deux listes répondent à des questions différentes et
 * doivent pouvoir diverger sans effet de bord.
 */
export const SUIVENT_ENGAGEMENTS: Role[] = [
  ROLES.CHEF_BRIGADE, ROLES.CHEF_BRIGADE_ADJOINT, ROLES.CHEF_VISITE, ROLES.CHEF_DIVISION, ROLES.ADMIN,
];

/**
 * Échéance calculée à partir d'un NOMBRE DE JOURS (décision utilisateur
 * 2026-09-10) : le chef de brigade raisonne en délai (« sous 5 jours »), pas en
 * date de calendrier. C'est le logiciel qui convertit, à compter du jour de la
 * saisie.
 *
 * Le calcul se fait sur les composantes LOCALES de la date, jamais en
 * millisecondes ajoutées à un horodatage : passer par `Date.now() + n * 86400000`
 * puis `toISOString()` bascule d'un jour dès que le fuseau s'écarte d'UTC, ou au
 * changement d'heure. `setDate` gère aussi les fins de mois et les années
 * bissextiles sans qu'on ait à y penser.
 *
 * Renvoie '' si `n` n'est pas un entier strictement positif, un délai de zéro
 * jour n'a pas de sens pour un envoi de pièces.
 */
export function dateDansNJours(n: unknown, depuis: Date = new Date()): string {
  const jours = Number(n);
  if (!Number.isInteger(jours) || jours < 1) return '';
  const d = new Date(depuis.getFullYear(), depuis.getMonth(), depuis.getDate());
  d.setDate(d.getDate() + jours);
  const p2 = (v: number) => String(v).padStart(2, '0');
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
}

/** État d'un engagement vis-à-vis de son échéance, du plus calme au plus urgent. */
export type EtatEngagement = 'aucun' | 'solde' | 'a_venir' | 'demain' | 'aujourdhui' | 'retard';

/**
 * Où en est un engagement aujourd'hui.
 *
 * Le calcul se fait en JOURS CALENDAIRES, jamais en millisecondes : « demain »
 * doit rester « demain » qu'il soit 8 h ou 23 h. On compare donc des dates
 * normalisées à minuit, ce qui rend la fonction stable dans la journée et
 * testable sans dépendre de l'heure d'exécution.
 *
 * `joursRestants` est négatif en cas de retard, c'est ce qui permet d'afficher
 * « en retard de 3 jours » sans recalculer quoi que ce soit côté écran.
 */
export function etatEngagement(
  delai: unknown,
  effectueLe: unknown,
  aujourdhui: Date = new Date(),
): { etat: EtatEngagement; joursRestants: number } {
  if (effectueLe) return { etat: 'solde', joursRestants: 0 };
  const brut = String(delai ?? '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(brut)) return { etat: 'aucun', joursRestants: 0 };

  const [a, m, j] = brut.split('-').map(Number) as [number, number, number];
  const echeance = Date.UTC(a, m - 1, j);
  const jour = Date.UTC(aujourdhui.getFullYear(), aujourdhui.getMonth(), aujourdhui.getDate());
  const jours = Math.round((echeance - jour) / 86400000);

  if (jours < 0) return { etat: 'retard', joursRestants: jours };
  if (jours === 0) return { etat: 'aujourdhui', joursRestants: 0 };
  if (jours === 1) return { etat: 'demain', joursRestants: 1 };
  return { etat: 'a_venir', joursRestants: jours };
}

/** true si l'engagement doit remonter au tableau de bord (J-1 et au-delà). */
export function engagementAlerte(delai: unknown, effectueLe: unknown, aujourdhui?: Date, joursAlerte = 1): boolean {
  /* `joursAlerte` (2026-09-21) vient du volet Paramètres : combien de jours avant
     l'échéance l'engagement remonte au tableau de bord. 1 = la veille, le
     comportement d'origine. Retard et jour même remontent TOUJOURS. */
  const { etat, joursRestants } = etatEngagement(delai, effectueLe, aujourdhui);
  if (etat === 'retard' || etat === 'aujourdhui') return true;
  if (etat === 'demain' || etat === 'a_venir') return joursRestants <= Math.max(0, joursAlerte);
  return false;
}

/** Libellé d'alerte prêt à afficher, aligné sur `etatEngagement`. */
export function libelleEngagement(delai: unknown, effectueLe: unknown, aujourdhui?: Date): string {
  const { etat, joursRestants } = etatEngagement(delai, effectueLe, aujourdhui);
  if (etat === 'retard') {
    const n = Math.abs(joursRestants);
    return `En retard de ${n} jour${n > 1 ? 's' : ''}`;
  }
  if (etat === 'aujourdhui') return "Échéance aujourd'hui";
  if (etat === 'demain') return 'À envoyer demain';
  if (etat === 'a_venir') return `Dans ${joursRestants} jours`;
  if (etat === 'solde') return 'Effectué';
  return '';
}

/** Statuts du stock physique. */
export const STOCK_STATUTS = { STOCK: 'En stock', POSITIONNE: 'Positionné', DEPOTE: 'Dépoté' } as const;
export type StatutStock = (typeof STOCK_STATUTS)[keyof typeof STOCK_STATUTS];

/** v3.1, Statuts du stock annoncé : Annoncé (import admin) → Pointé (PP) → Confirmé (CFS). */
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
  CBPI: 'Chef brigade par intérim',
  CHEF_VISITE: 'Chef visite',
  CHEF_DIVISION: 'Chef division',
  T1: 'Agent T1',
  BALISE: 'Agent Balise',
  BON_SORTIE: 'Agent Bon de Sortie',
  PP: 'Agent Porte Principale',
  ADMIN: 'Administrateur',
};

/** Clés du résumé de liste (RESUME_KEYS v3.6), champs exposés par les listes/files. */
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
