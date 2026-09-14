-- ============================================================================
--  00190 — Le suivi des engagements visible dans les LISTES (2026-09-12)
--
--  POURQUOI CETTE MIGRATION EXISTE
--  -------------------------------
--  La 00180 avait volontairement laissé `v_cargaisons_resume` de côté : « le
--  suivi des engagements se saisit et se lit sur la FICHE ; la vue de résumé
--  alimente les listes et la recherche, où l'engagement n'a pas sa place
--  aujourd'hui ». Ce raisonnement était juste à l'époque.
--
--  L'usage a tranché autrement : un chef doit voir, DANS LA LISTE, quels
--  camions portent un engagement — et pouvoir ne demander que ceux-là. Un
--  engagement qu'il faut ouvrir dossier par dossier pour découvrir n'est pas
--  suivi, il est archivé.
--
--  ⚠ PRÉREQUIS : la 00180 doit avoir été appliquée. Sans elle, les colonnes
--  n'existent pas et cette vue échouera à se créer — ce qui est le bon
--  comportement : mieux vaut une migration qui refuse que des listes qui mentent.
--
--  ⚠ MIGRATION ADDITIVE. La vue gagne trois colonnes ; aucune n'est retirée,
--  aucune donnée n'est touchée.
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
  c.date_bon_sortie,
  -- Suivi des engagements (00180), exposé aux LISTES le 2026-09-12.
  c.suivi_engagement,
  c.engagement_delai,
  c.engagement_effectue_le
from cargaisons c
where not c.annule and not c.archive;

revoke all on v_cargaisons_resume from public, anon, authenticated;
grant select on v_cargaisons_resume to service_role;
