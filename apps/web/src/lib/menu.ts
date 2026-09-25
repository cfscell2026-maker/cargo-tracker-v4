/**
 * Menus par rôle et découpage de la barre latérale.
 *
 * Extrait de `ui.tsx` le 2026-09-10 : ce sont des DONNÉES et une règle de
 * répartition, sans JSX. Les garder dans un fichier de composants les rendait
 * intestables (Node ne sait pas exécuter du .tsx), alors que la règle qui
 * décide de ce que chaque rôle voit mérite précisément d'être testée.
 */
/**
 * Un élément de menu : [clé d'écran, libellé, nom d'icône].
 *
 * Le 3ᵉ champ portait un CARACTÈRE (▦ ＋ ✎…) ; il porte désormais le NOM d'une
 * icône SVG définie dans `icones.tsx`. Voir ce fichier pour la raison du
 * changement, cohérence de la famille, et rendu identique sur tous les postes.
 */
export type MenuItem = [string, string, string];

/**
 * Menus PAR RÔLE. Cette table est la seule source de ce que chaque profil voit
 * dans la barre ; `menuSections` ne fait que la répartir en deux blocs.
 *
 * ⚠ Ce n'est QUE de l'affichage. L'autorité reste la matrice `PERMISSIONS` côté
 * serveur : retirer une entrée ici masque un écran, cela n'interdit rien.
 *
 * Retirés le 2026-09-10 (décision utilisateur) : « Conso (type C) » et
 * « KPI / EVP ». Les écrans correspondants existent toujours dans `screens.tsx`
 * : on les a seulement sortis des menus, de sorte que la décision se défait en
 * remettant une ligne, sans rien reconstruire.
 */
export const MENUS: Record<string, MenuItem[]> = {
  CFS: [
    ['creercamion', 'Créer un camion', 'camionPlus'], ['completer', 'Saisir / compléter', 'crayon'],
    ['search', 'Recherche (en cours)', 'loupe'], ['list', 'Cargaisons', 'liste'], ['vehicules', 'Véhicules', 'voiture'],
    ['conteneurs', 'Opérations sur conteneurs', 'conteneur'], ['mad', 'Magasin / MAD', 'entrepot'], ['entrepindus', 'Entrepôt industriel', 'usine'],
    ['etatcfs', 'Pointage camions (sortie)', 'presse'], ['chargement', 'Bon de chargement', 'document'],
    ['cfsreport', 'Rapport CFS', 'rapport'], ['vehreport', 'Rapport véhicules', 'rapport'], ['destinations', 'Par destination', 'carte'],
    ['dwell', 'Camions en instance', 'minuterie'], ['stockdwell', 'Séjour conteneurs', 'conteneurHorloge'], ['temps', 'Temps de passage', 'sablier'],
    ['horodatage', 'Heures d\'activité', 'horloge'], ['parking', 'Parking', 'parking'], ['account', 'Mon compte', 'compte'],
  ],
  // v4, le chef brigade lit TOUS les rapports de TOUTES les cellules (lecture seule).
  CHEF_BRIGADE: [
    ['dash', 'Tableau de bord', 'tableau'], ['wait_valid', 'À valider', 'valider'],
    // 2026-09-17 : le volet des engagements, tous les camions engages, et les
    // trois gestes (solder, corriger, retirer) au meme endroit.
    ['engagements', 'Engagements', 'echeance'], ['parking', 'Parking', 'parking'], ['search', 'Recherche (en cours)', 'loupe'],
    ['list', 'Cargaisons', 'liste'], ['vehicules', 'Véhicules', 'voiture'],
    ['etatcfs', 'Pointage camions (sortie)', 'presse'], ['chargement', 'Bon de chargement', 'document'],
    ['cfsreport', 'Rapport CFS', 'rapport'], ['vehreport', 'Rapport véhicules', 'rapport'], ['baliserep', 'Rapport Balise', 'rapport'],
    ['pprep', 'Rapport PP', 'rapport'], ['t1report', 'Rapport T1', 'rapport'], ['bonsortiereport', 'Rapport Bon de sortie', 'rapport'],
    ['dispenses', 'Dispenses', 'drapeau'],
    ['flux', 'Analyse des flux', 'flux'], ['destinations', 'Par destination', 'carte'], ['controles', 'Contrôles (gabarit/surcharge)', 'balance'],
    ['dwell', 'Délai & instance', 'minuterie'], ['stockdwell', 'Séjour conteneurs', 'conteneurHorloge'], ['temps', 'Temps de passage', 'sablier'],
    ['horodatage', 'Heures d\'activité', 'horloge'], ['account', 'Mon compte', 'compte'],
  ],
  CHEF_BRIGADE_ADJOINT: [
    ['engagements', 'Engagements', 'echeance'], ['parking', 'Parking', 'parking'],
    ['search', 'Recherche (en cours)', 'loupe'], ['list', 'Cargaisons', 'liste'], ['vehicules', 'Véhicules', 'voiture'],
    ['controles', 'Contrôles (gabarit/surcharge)', 'balance'], ['temps', 'Temps de passage', 'sablier'],
    ['horodatage', 'Heures d\'activité', 'horloge'], ['account', 'Mon compte', 'compte'],
  ],
  // CBPI · chef brigade par intérim : UNIQUEMENT la file « À valider » (+ son
  // compte). Aucun autre écran : c'est une délégation de signature, rien d'autre.
  CBPI: [['wait_valid', 'À valider', 'valider'], ['account', 'Mon compte', 'compte']],
  CHEF_VISITE: [
    ['dash', 'Tableau de bord', 'tableau'], ['engagements', 'Engagements', 'echeance'], ['parking', 'Parking', 'parking'],
    ['search', 'Recherche (en cours)', 'loupe'], ['list', 'Cargaisons', 'liste'],
    ['vehicules', 'Véhicules', 'voiture'], ['controles', 'Contrôles (gabarit/surcharge)', 'balance'],
    ['temps', 'Temps de passage', 'sablier'], ['horodatage', 'Heures d\'activité', 'horloge'], ['account', 'Mon compte', 'compte'],
  ],
  CHEF_DIVISION: [
    ['dash', 'Tableau de bord', 'tableau'], ['engagements', 'Engagements', 'echeance'], ['parking', 'Parking', 'parking'],
    ['search', 'Recherche (en cours)', 'loupe'], ['list', 'Cargaisons', 'liste'],
    ['vehicules', 'Véhicules', 'voiture'], ['controles', 'Contrôles (gabarit/surcharge)', 'balance'],
    ['temps', 'Temps de passage', 'sablier'], ['horodatage', 'Heures d\'activité', 'horloge'], ['account', 'Mon compte', 'compte'],
  ],
  T1: [
    ['t1', 'Cellule T1', 't1'], ['wait_t1', 'En attente T1', 'attenteT1'], ['search', 'Recherche (en cours)', 'loupe'],
    ['list', 'Cargaisons', 'liste'], ['t1report', 'Rapport T1', 'rapport'],
    ['horodatage', 'Heures d\'activité', 'horloge'], ['parking', 'Parking', 'parking'], ['account', 'Mon compte', 'compte'],
  ],
  BALISE: [
    ['gps', 'Cellule Balise', 'balise'], ['wait_gps', 'En attente Balise', 'attenteBalise'], ['dispenses', 'Dispenses', 'drapeau'],
    ['search', 'Recherche (en cours)', 'loupe'], ['list', 'Cargaisons', 'liste'], ['baliserep', 'Rapport Balise', 'rapport'],
    ['horodatage', 'Heures d\'activité', 'horloge'], ['parking', 'Parking', 'parking'], ['account', 'Mon compte', 'compte'],
  ],
  BON_SORTIE: [
    ['bonsortie', 'Cellule Bon de Sortie', 'bonSortie'], ['wait_bs', 'En attente Bon de Sortie', 'attenteBonSortie'],
    ['search', 'Recherche (en cours)', 'loupe'], ['list', 'Cargaisons', 'liste'], ['bonsortiereport', 'Rapport Bon de sortie', 'rapport'],
    ['horodatage', 'Heures d\'activité', 'horloge'], ['parking', 'Parking', 'parking'], ['account', 'Mon compte', 'compte'],
  ],
  PP: [
    ['sortie', 'Sortie (checklist)', 'sortie'], ['wait_sortie', 'En attente sortie', 'attenteSortie'],
    ['conteneurs', 'Opérations sur conteneurs', 'conteneur'], ['search', 'Recherche (en cours)', 'loupe'],
    ['vehicules', 'Véhicules', 'voiture'], ['list', 'Cargaisons', 'liste'], ['pprep', 'Rapport PP', 'rapport'],
    ['destinations', 'Par destination', 'carte'], ['horodatage', 'Heures d\'activité', 'horloge'], ['parking', 'Parking', 'parking'], ['account', 'Mon compte', 'compte'],
  ],
  ADMIN: [
    ['dash', 'Tableau de bord', 'tableau'], ['creercamion', 'Créer un camion', 'camionPlus'],
    ['completer', 'Saisir / compléter', 'crayon'], ['wait_valid', 'À valider', 'valider'],
    ['engagements', 'Engagements', 'echeance'], ['parking', 'Parking', 'parking'],
    ['search', 'Recherche (en cours)', 'loupe'], ['list', 'Cargaisons', 'liste'], ['vehicules', 'Véhicules', 'voiture'],
    ['conteneurs', 'Opérations sur conteneurs', 'conteneur'], ['mad', 'Magasin / MAD', 'entrepot'],
    ['entrepindus', 'Entrepôt industriel', 'usine'], ['etatcfs', 'Pointage camions (sortie)', 'presse'],
    ['chargement', 'Bon de chargement', 'document'],
    ['cfsreport', 'Rapport CFS', 'rapport'], ['vehreport', 'Rapport véhicules', 'rapport'], ['baliserep', 'Rapport Balise', 'rapport'],
    ['pprep', 'Rapport PP', 'rapport'], ['t1report', 'Rapport T1', 'rapport'], ['bonsortiereport', 'Rapport Bon de sortie', 'rapport'],
    ['dispenses', 'Dispenses', 'drapeau'],
    ['flux', 'Analyse des flux', 'flux'], ['destinations', 'Par destination', 'carte'],
    ['controles', 'Contrôles (gabarit/surcharge)', 'balance'], ['dwell', 'Délai & instance', 'minuterie'],
    ['stockdwell', 'Séjour conteneurs', 'conteneurHorloge'], ['temps', 'Temps de passage', 'sablier'],
    ['horodatage', 'Heures d\'activité', 'horloge'], ['goulots', 'Nettoyage (goulots)', 'nettoyage'], ['parametres', 'Paramètres', 'reglages'],
    ['archive', 'Archive (+1 an)', 'archive'], ['history', 'Historique', 'historique'],
    ['users', 'Utilisateurs', 'utilisateurs'], ['account', 'Mon compte', 'compte'],
  ],
};

/* ============ DEUX BLOCS DE MENU : 2026-09-10 ============================
 *
 * Le bloc GÉNÉRAL, juste sous le logo, rassemble ce qui ne relève d'aucune
 * cellule : la vue d'ensemble, l'administration et le compte. Les écrans métier
 * (saisie, cellules, rapports) suivent en dessous.
 *
 * ⚠ AUCUN DROIT N'EST ACCORDÉ ICI.
 *
 * `menuSections` ne fait que RÉPARTIR ce que `MENUS[role]` contient déjà. Une
 * entrée absente du menu d'un rôle reste absente ; « Utilisateurs » ne remonte
 * dans le bloc général que pour les rôles qui l'avaient. C'est le point qui rend
 * ce découpage sûr : il réordonne, il n'ouvre rien.
 *
 * Et cela reste de l'AFFICHAGE. L'autorité est la matrice `PERMISSIONS` côté
 * serveur, qui refuse toute action non autorisée même appelée directement.
 * ====================================================================== */

/** Écrans du bloc général, DANS L'ORDRE d'affichage voulu. */
// 2026-09-21 : « Paramètres » juste après « Nettoyage » (demande utilisateur).
const ECRANS_GENERAUX = ['dash', 'users', 'history', 'archive', 'goulots', 'parametres', 'account'] as const;

export function menuSections(role: string): { general: MenuItem[]; navigation: MenuItem[] } {
  const menu = MENUS[role] ?? [];
  const cles = new Set<string>(ECRANS_GENERAUX);
  // Ordre imposé par ECRANS_GENERAUX, et non celui du menu d'origine : le bloc
  // général doit se présenter pareil pour tous les rôles.
  const general = ECRANS_GENERAUX
    .map((k) => menu.find((m) => m[0] === k))
    .filter((m): m is MenuItem => !!m);
  return { general, navigation: menu.filter((m) => !cles.has(m[0])) };
}

/**
 * L'ICÔNE DE L'ÉCRAN COURANT : 2026-09-11.
 *
 * La barre supérieure affiche désormais, devant le nom de la plateforme,
 * l'icône du volet ouvert. Elle se lit dans la même table que le menu : une
 * seule source, donc l'icône de la barre ne peut pas diverger de celle de la
 * pilule qui vient d'être cliquée.
 *
 * Repli sur `tableau` pour les écrans qui ne figurent dans aucun menu, la
 * fiche d'un camion, par exemple, où l'on arrive par un clic dans une liste.
 */
export function iconeDeLEcran(role: string, ecran: string): string {
  const entree = (MENUS[role] ?? []).find((m) => m[0] === ecran);
  return entree ? entree[2] : 'tableau';
}

/**
 * LES RACCOURCIS DE LA BARRE BASSE : mobile, 2026-09-12.
 *
 * Sur un téléphone, le menu latéral est un tiroir : chaque changement d'écran
 * demande deux gestes, ouvrir puis choisir. La barre basse rend les quatre
 * volets les plus utiles du rôle accessibles en UN geste, le cinquième bouton
 * ouvrant le tiroir pour tout le reste.
 *
 * Les quatre sont simplement LES PREMIERS du menu du rôle : ces menus sont déjà
 * classés par importance, et s'en servir évite une seconde table à tenir à jour
 * : qui finirait par diverger.
 *
 * Les libellés, eux, sont raccourcis : « Opérations sur conteneurs » ne tient
 * pas sous une icône de 20 px. À défaut d'entrée dans la table, on garde le
 * PREMIER MOT du libellé du menu, qui suffit presque toujours.
 */
const LIBELLES_COURTS: Record<string, string> = {
  dash: 'Bord', creercamion: 'Créer', completer: 'Saisir', wait_valid: 'Valider',
  search: 'Chercher', list: 'Dossiers', engagements: 'Engage.', parking: 'Parking', parametres: 'Réglages', conteneurs: 'Parc', mad: 'Magasin',
  entrepindus: 'Usine', vehicules: 'Véhicules', etatcfs: 'Pointage',
  t1: 'Cellule T1', gps: 'Balise', bonsortie: 'Bon sortie', sortie: 'Sortie',
  stock: 'Stock', pointage: 'Pointage', account: 'Compte',
  wait_t1: 'Attente', wait_gps: 'Attente', wait_bs: 'Attente', wait_sortie: 'Attente',
};

export function raccourcisMobiles(role: string): MenuItem[] {
  return (MENUS[role] ?? []).slice(0, 4).map(
    ([id, libelle, icone]) => [id, LIBELLES_COURTS[id] ?? libelle.split(' ')[0]!, icone] as MenuItem,
  );
}
