-- ============================================================================
--  00130 — date_bon_sortie dans la vue résumé (tableau de bord événementiel)
--  Demande utilisateur 2026-08-19 : le tableau de bord compte désormais chaque
--  passage À LA DATE DE SA CELLULE. La tuile « Bons de sortie (période) » a
--  besoin de `date_bon_sortie`, absente de la vue résumé jusqu'ici. On recrée la
--  vue à l'identique de 00120 en ajoutant cette seule colonne (en fin de liste,
--  pour ne pas déranger l'ordre existant). Tant que cette migration n'est pas
--  appliquée, la tuile lit 0 (dégradation propre côté Edge Function).
-- ============================================================================

create or replace view v_cargaisons_resume as
select
  c.id, c.reference, c.date_creation, c.numero_camion, c.numero_camion_norm,
  c.type_operation, c.statut, c.numero_gps, c.date_sortie, c.agent_cfs, c.rapport_id,
  c.est_vehicule, c.conteneur_origine, c.saute_t1, c.saute_balise, c.saute_bs,
  c.balise_requise, c.arrivee_bureau, c.date_t1, c.date_pose_gps, c.bon_sortie_numero,
  c.date_validation, c.etat_sortie, c.nb_conteneurs, c.twins,
  c.conteneurs_details -> 'conteneurs' -> 0 ->> 'num' as conteneur1,
  c.conteneurs_details -> 'conteneurs' -> 1 ->> 'num' as conteneur2,
  c.conteneurs_details -> 'conteneurs' -> 2 ->> 'num' as conteneur3,
  c.conteneurs_details -> 'conteneurs' -> 3 ->> 'num' as conteneur4,
  case when c.type_operation = 'Dépotage'
       then c.conteneurs_details -> 'scellesCamion' ->> 0
       else c.conteneurs_details -> 'conteneurs' -> 0 ->> 'plomb' end as plomb1,
  case when c.type_operation = 'Dépotage'
       then c.conteneurs_details -> 'scellesCamion' ->> 1
       else c.conteneurs_details -> 'conteneurs' -> 1 ->> 'plomb' end as plomb2,
  case when c.type_operation = 'Dépotage'
       then c.conteneurs_details -> 'scellesCamion' ->> 2
       else c.conteneurs_details -> 'conteneurs' -> 2 ->> 'plomb' end as plomb3,
  case when c.type_operation = 'Dépotage'
       then null
       else c.conteneurs_details -> 'conteneurs' -> 3 ->> 'plomb' end as plomb4,
  c.type_declaration,
  -- Ajout 2026-08-19 (en fin de liste, cf. note ci-dessus).
  c.date_bon_sortie
from cargaisons c
where not c.annule;

revoke all on v_cargaisons_resume from public, anon, authenticated;
grant select on v_cargaisons_resume to service_role;
