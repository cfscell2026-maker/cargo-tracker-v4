-- ============================================================================
--  00207, INDEX DES LECTURES FRÉQUENTES (2026-10-24, urgence E/S disque)
--
--  Alerte Supabase : budget d'E/S disque presque épuisé, bridage à 5 Mo/s.
--  Effet visible : la connexion (Supabase Auth, même disque) met 16 s, les
--  agents « ne peuvent plus se connecter ».
--
--  Mesure (pg_stat_user_tables) : `cargaisons`, 22 040 lignes, lue en entier
--  450 331 fois, soit 7,8 milliards de lignes lues. Les filtres du tableau de
--  bord et des rapports portent sur des colonnes de date SANS index : chaque
--  page de 1 000 lignes relisait toute la table.
--
--  Ces index permettent à PostgreSQL de ne lire que les lignes concernées :
--    · une date par cellule (sortie, balise, T1, validation, bon de sortie,
--      solde d'engagement), pour le « OU » du tableau de bord et les rapports
--      par période ;
--    · les dossiers ENCORE PRÉSENTS (statut différent de la sortie), la
--      question posée par les files d'attente, la recherche et l'anti-doublon ;
--    · (date d'entrée, id), l'ordre exact de la pagination, pour paginer sans
--      trier toute la table à chaque page.
--
--  ⚠ AJOUT SEUL : aucun changement de données ni de structure. Sur 22 000
--  lignes, chaque index se construit en quelques secondes. `if not exists` :
--  on peut relancer le script sans risque.
--
--  À coller tel quel dans l'éditeur SQL du tableau de bord Supabase si la
--  commande `db push` ne passe pas.
-- ============================================================================

create index if not exists cargaisons_date_sortie_idx      on cargaisons (date_sortie);
create index if not exists cargaisons_date_pose_gps_idx    on cargaisons (date_pose_gps);
create index if not exists cargaisons_date_t1_idx          on cargaisons (date_t1);
create index if not exists cargaisons_date_validation_idx  on cargaisons (date_validation);
create index if not exists cargaisons_date_bon_sortie_idx  on cargaisons (date_bon_sortie);
create index if not exists cargaisons_engagement_solde_idx on cargaisons (engagement_effectue_le);

-- Dossiers encore dans l'enceinte : même prédicat que `.neq('statut', SORTIE)`.
create index if not exists cargaisons_actifs_idx
  on cargaisons (date_creation desc, id)
  where statut <> 'Sortie Enregistrée';

-- Ordre de pagination de `chargerResume` (date d'entrée décroissante, puis id).
create index if not exists cargaisons_date_id_idx on cargaisons (date_creation desc, id);

-- Les statistiques du planificateur, à jour pour qu'il choisisse ces index.
analyze cargaisons;

-- Prise en compte immédiate par l'API.
notify pgrst, 'reload schema';
