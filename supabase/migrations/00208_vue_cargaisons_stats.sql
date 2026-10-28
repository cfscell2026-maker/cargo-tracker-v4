-- ============================================================================
--  00208, VUE ALLÉGÉE POUR LES STATISTIQUES (2026-10-24, vitesse)
--
--  Mesure en production : l'Analyse des flux sur l'année tuait le serveur
--  (HTTP 546, limite de ressources) au bout de 9,7 s, deux fois de suite ; les
--  Contrôles mettaient 3,1 s. Ces rapports chargeaient chaque dossier EN ENTIER,
--  dont le bloc JSON des conteneurs (déclaration, scellés, poids, champs libres
--  de chaque conteneur), alors qu'ils ne comptent que des conteneurs par taille.
--
--  Cette vue fait l'allègement DANS LA BASE, avant tout transfert :
--    · les seules colonnes simples utiles aux statistiques ;
--    · `conteneurs_details` réduit, pour chaque conteneur, à num, taille, type
--      et partage, dans le même ordre et sous la même forme
--      ({ conteneurs: [...], scellesCamion: [] }). Une valeur d'une autre forme
--      (ancienne saisie) est rendue telle quelle : le code la lit comme avant.
--
--  Elle ne filtre RIEN (ni annulés ni archivés) : les rapports gardent leurs
--  propres filtres, à l'identique. Si elle n'existe pas encore, le serveur
--  retombe tout seul sur la table : l'ordre de déploiement est indifférent.
--
--  ⚠ AJOUT SEUL : une vue, aucune donnée modifiée. Fermée au public comme
--  v_cargaisons_resume ; seul le serveur (service_role) la lit.
-- ============================================================================

create or replace view v_cargaisons_stats as
select
  c.id, c.numero_camion, c.type_operation, c.statut, c.est_vehicule, c.agent_cfs,
  c.date_creation, c.date_validation, c.date_t1, c.date_bon_sortie, c.date_pose_gps, c.date_sortie,
  c.hors_gabarit, c.en_surcharge, c.destination_marchandise,
  c.annule, c.archive,
  case
    when jsonb_typeof(c.conteneurs_details) = 'object'
         and jsonb_typeof(c.conteneurs_details -> 'conteneurs') = 'array' then
      jsonb_build_object(
        'conteneurs', coalesce((
          select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
                   'num', e -> 'num', 'taille', e -> 'taille', 'type', e -> 'type', 'partage', e -> 'partage'))
                 order by t.o)
          from jsonb_array_elements(c.conteneurs_details -> 'conteneurs') with ordinality as t(e, o)
        ), '[]'::jsonb),
        'scellesCamion', '[]'::jsonb)
    when jsonb_typeof(c.conteneurs_details) = 'array' then
      coalesce((
        select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
                 'num', e -> 'num', 'taille', e -> 'taille', 'type', e -> 'type', 'partage', e -> 'partage'))
               order by t.o)
        from jsonb_array_elements(c.conteneurs_details) with ordinality as t(e, o)
      ), '[]'::jsonb)
    else c.conteneurs_details
  end as conteneurs_details
from cargaisons c;

comment on view v_cargaisons_stats is
  'Cargaisons allégées pour les statistiques (flux, contrôles) : colonnes simples '
  'et conteneurs réduits à num/taille/type/partage. Aucun filtre. Serveur seulement.';

revoke all on v_cargaisons_stats from public, anon, authenticated;
grant select on v_cargaisons_stats to service_role;

notify pgrst, 'reload schema';
