/**
 * ============================================================================
 *  Migration — table de correspondance « libellé feuille » → colonne PostgreSQL.
 *  Les libellés viennent EXACTEMENT de apps-script/Config.gs (COLS, CONT_COLS…).
 *  Type de conversion :
 *   text       : chaîne telle quelle
 *   bool_oui   : 'Oui' → true, sinon false  (null si cellule vide et nullable)
 *   bool_yesno : 'Yes' → true, sinon false
 *   ts         : date/serial → ISO (ou null)
 *   int        : entier (0 par défaut)
 *   json       : chaîne JSON → objet (ou null)
 *   json_conts : conteneursDetails → forme normalisée {conteneurs,scellesCamion}
 * ============================================================================
 */
export type Conv = 'text' | 'bool_oui' | 'bool_yesno' | 'ts' | 'int' | 'json' | 'json_conts';
export interface Champ {
  col: string;
  label: string;
  conv: Conv;
  nullable?: boolean; // true → cellule vide donne null (et non '' / false)
}

/** Cargaisons (feuille « Cargaisons ») → table cargaisons. */
export const CARGAISONS: Champ[] = [
  { col: 'id', label: 'ID', conv: 'text' },
  { col: 'reference', label: 'Référence', conv: 'text' },
  { col: 'date_creation', label: 'Date création', conv: 'ts' },
  { col: 'numero_camion', label: 'N° Camion', conv: 'text' },
  { col: 'type_operation', label: "Type d'opération", conv: 'text', nullable: true },
  { col: 'twins', label: 'TWINS', conv: 'bool_yesno' },
  { col: 'declarant', label: 'Déclarant', conv: 'text' },
  { col: 'contact_declarant', label: 'Contact déclarant', conv: 'text' },
  { col: 'destination_marchandise', label: 'Destination marchandise', conv: 'text' },
  { col: 'bureau_declaration', label: 'Bureau de déclaration', conv: 'text' },
  { col: 'type_declaration', label: 'Type de déclaration', conv: 'text' },
  { col: 'numero_declaration', label: 'N° de déclaration', conv: 'text' },
  { col: 'annee_declaration', label: 'Année de déclaration', conv: 'text' },
  { col: 'description_marchandise', label: 'Description marchandise', conv: 'text' },
  { col: 'observations_cfs', label: 'Observations CFS', conv: 'text' },
  { col: 'agent_cfs', label: 'Agent CFS', conv: 'text' },
  { col: 'statut', label: 'Statut', conv: 'text' },
  { col: 'numero_gps', label: 'N° GPS', conv: 'text' },
  { col: 'date_pose_gps', label: 'Date pose GPS', conv: 'ts', nullable: true },
  { col: 'agent_balise', label: 'Agent Balise', conv: 'text' },
  { col: 'observations_balise', label: 'Observations Balise', conv: 'text' },
  { col: 'infos_validees', label: 'Infos validées', conv: 'bool_oui', nullable: true },
  { col: 'date_sortie', label: 'Date sortie', conv: 'ts', nullable: true },
  { col: 'agent_pp', label: 'Agent PP', conv: 'text' },
  { col: 'observations_pp', label: 'Observations PP', conv: 'text' },
  { col: 'derniere_maj', label: 'Dernière MAJ', conv: 'ts' },
  { col: 'rapport_id', label: 'N° Rapport', conv: 'text' },
  { col: 'conteneurs_details', label: 'Détails conteneurs', conv: 'json_conts' },
  { col: 'nb_conteneurs', label: 'Nb conteneurs', conv: 'int' },
  { col: 'balise_requise', label: 'Balise requise', conv: 'bool_oui', nullable: true },
  { col: 'chargement_mixte', label: 'Chargement mixte', conv: 'bool_oui' },
  { col: 'mixte_details', label: 'Détails chargement mixte', conv: 'json', nullable: true },
  { col: 'est_vehicule', label: 'Est véhicule', conv: 'bool_oui' },
  { col: 'vehicule_details', label: 'Détails véhicule', conv: 'json', nullable: true },
  { col: 'conteneur_origine', label: "Conteneur d'origine", conv: 'text' },
  { col: 'bureau_destination', label: 'Bureau de destination', conv: 'text' },
  { col: 't1_numeros', label: 'N° T1', conv: 'json', nullable: true },
  { col: 'date_t1', label: 'Date T1', conv: 'ts', nullable: true },
  { col: 'agent_t1', label: 'Agent T1', conv: 'text' },
  { col: 'observations_t1', label: 'Observations T1', conv: 'text' },
  { col: 't1_correct', label: 'T1 vérifié (Balise)', conv: 'bool_oui', nullable: true },
  { col: 'numero_dispense', label: 'N° dispense', conv: 'text' },
  { col: 'bon_sortie_numero', label: 'N° Bon de sortie', conv: 'json', nullable: true },
  { col: 'date_bon_sortie', label: 'Date Bon de sortie', conv: 'ts', nullable: true },
  { col: 'agent_bon_sortie', label: 'Agent Bon de sortie', conv: 'text' },
  { col: 'observations_bon_sortie', label: 'Observations Bon de sortie', conv: 'text' },
  { col: 'pp_checklist', label: 'Checklist PP', conv: 'json', nullable: true },
  { col: 'saute_t1', label: 'Saute T1', conv: 'bool_oui' },
  { col: 'saute_balise', label: 'Saute Balise', conv: 'bool_oui' },
  { col: 'arrivee_bureau', label: 'Arrivée bureau dest.', conv: 'bool_oui' },
  { col: 'date_arrivee_bureau', label: 'Date arrivée bureau', conv: 'ts', nullable: true },
  { col: 'agent_arrivee_bureau', label: 'Agent arrivée bureau', conv: 'text' },
  { col: 'routage_entree', label: 'Routage entrée', conv: 'text' },
  { col: 'agent_entree', label: 'Agent entrée (PP)', conv: 'text' },
  { col: 'etat_sortie', label: 'État de sortie', conv: 'text', nullable: true },
  { col: 'nb_colis', label: 'Nombre de colis', conv: 'text' },
  { col: 'hors_gabarit', label: 'Hors gabarit', conv: 'bool_oui', nullable: true },
  { col: 'hauteur_chargement', label: 'Hauteur chargement', conv: 'text' },
  { col: 'date_validation', label: 'Date validation', conv: 'ts', nullable: true },
  { col: 'agent_validation', label: 'Agent validation', conv: 'text' },
  { col: 'signature_validation', label: 'Signature validation', conv: 'text' },
  { col: 'ouillage_numero', label: 'N° Ouillage', conv: 'text' },
  { col: 'ouillage_date', label: 'Date Ouillage', conv: 'ts', nullable: true },
];

/** Conteneurs (feuille « Conteneurs »). */
export const CONTENEURS: Champ[] = [
  { col: 'rapport_id', label: 'N° Rapport', conv: 'text' },
  { col: 'cargaison_id', label: 'ID Cargaison', conv: 'text' },
  { col: 'numero_camion', label: 'N° Camion', conv: 'text' },
  { col: 'type_operation', label: "Type d'opération", conv: 'text' },
  { col: 'ordre', label: 'Ordre', conv: 'int' },
  { col: 'conteneur', label: 'Conteneur', conv: 'text' },
  { col: 'scelle', label: 'Scellé', conv: 'text' },
  { col: 'taille', label: 'Taille', conv: 'text' },
  { col: 'type_conteneur', label: 'Type conteneur', conv: 'text' },
  { col: 'poids', label: 'Poids', conv: 'text' },
  { col: 'champs_libres', label: 'Champs libres', conv: 'text' },
  { col: 'date_creation', label: 'Date création', conv: 'ts' },
];

/** Declarations. */
export const DECLARATIONS: Champ[] = [
  { col: 'cle', label: 'Clé déclaration', conv: 'text' },
  { col: 'annee_declaration', label: 'Année', conv: 'text' },
  { col: 'bureau_declaration', label: 'Bureau', conv: 'text' },
  { col: 'type_declaration', label: 'Type', conv: 'text' },
  { col: 'numero_declaration', label: 'Numéro', conv: 'text' },
  { col: 'declarant', label: 'Déclarant', conv: 'text' },
  { col: 'nombre_conteneurs', label: 'Nb conteneurs déclarés', conv: 'int' },
  { col: 'conteneurs_apures', label: 'Conteneurs apurés', conv: 'int' },
  { col: 'date_creation', label: 'Date création', conv: 'ts' },
  { col: 'derniere_maj', label: 'Dernière MAJ', conv: 'ts' },
];

/** Stock. */
export const STOCK: Champ[] = [
  { col: 'numero_tc', label: 'N° Conteneur', conv: 'text' },
  { col: 'taille', label: 'Taille', conv: 'text' },
  { col: 'type_conteneur', label: 'Type', conv: 'text' },
  { col: 'provenance', label: 'Provenance', conv: 'text' },
  { col: 'date_entree', label: "Date d'entrée", conv: 'ts', nullable: true },
  { col: 'statut', label: 'Statut', conv: 'text' },
  { col: 'date_positionne', label: 'Date positionnement', conv: 'ts', nullable: true },
  { col: 'date_pointage', label: 'Date pointage', conv: 'ts', nullable: true },
  { col: 'pointe_par', label: 'Pointé par', conv: 'text' },
  { col: 'date_depote', label: 'Date dépotage', conv: 'ts', nullable: true },
  { col: 'cargaison_id', label: 'Cargaison liée', conv: 'text', nullable: true },
  { col: 'observations', label: 'Observations', conv: 'text' },
  { col: 'nb_sejours_import', label: 'Nb séjours (import)', conv: 'int' },
];

/** Stock annoncé. */
export const STOCK_ANNONCE: Champ[] = [
  { col: 'numero_tc', label: 'N° Conteneur', conv: 'text' },
  { col: 'taille', label: 'Taille', conv: 'text' },
  { col: 'date_entree', label: "Date d'entrée", conv: 'ts', nullable: true },
  { col: 'annee_declaration', label: 'Année déclaration', conv: 'text' },
  { col: 'bureau_declaration', label: 'Bureau déclaration', conv: 'text' },
  { col: 'type_declaration', label: 'Type déclaration', conv: 'text' },
  { col: 'numero_declaration', label: 'N° déclaration', conv: 'text' },
  { col: 'statut', label: 'Statut', conv: 'text' },
  { col: 'date_annonce', label: 'Date annonce', conv: 'ts', nullable: true },
  { col: 'date_pointage', label: 'Date pointage', conv: 'ts', nullable: true },
  { col: 'pointe_par', label: 'Pointé par', conv: 'text' },
  { col: 'date_confirmation', label: 'Date confirmation', conv: 'ts', nullable: true },
  { col: 'confirme_par', label: 'Confirmé par', conv: 'text' },
  { col: 'observations', label: 'Observations', conv: 'text' },
];
