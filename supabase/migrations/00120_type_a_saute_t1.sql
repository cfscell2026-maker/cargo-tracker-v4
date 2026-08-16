-- ============================================================================
--  CARGO TRACKER — TYPE A (ADMISSION) : SAUT DU T1 GARANTI
--  (demande utilisateur du 2026-08-15)
--
--  Symptôme : les déclarations de type A (admission) réclamaient le T1, alors
--  qu'elles doivent le SAUTER exactement comme les type C (conso). La règle
--  métier était correcte (TYPES_SANS_T1 = C, A), mais le moteur de workflow ne
--  se fiait qu'au flag stocké `saute_t1` ; quand ce flag n'avait pas été écrit
--  (données migrées, type corrigé après coup, déclarant saisi tardivement), la
--  cargaison de type A retombait dans la file « en attente T1 ».
--
--  Correctif en deux temps :
--    1) le moteur (workflow.ts) saute désormais le T1 PAR NATURE pour C/A, à
--       partir de `type_declaration` — d'où l'ajout de cette colonne à la vue
--       résumé, que le moteur consomme pour les listes et les files d'attente ;
--    2) régularisation des lignes existantes : on pose `saute_t1 = true` sur les
--       type A/C qui ne l'avaient pas, pour que les lectures directes du flag
--       (libellés « T1 (sauté) », exports) soient cohérentes avec le moteur.
--
--  NB : on ne touche PAS `saute_balise` — le saut de balise d'un type A/C dépend
--  du choix « non balisée » (consoMode), pas du type seul.
-- ============================================================================

-- 1) Régularisation des données : type A/C ⇒ saute le T1.
update cargaisons
set saute_t1 = true
where type_declaration in ('A', 'C')
  and saute_t1 is distinct from true;

-- 2) La vue résumé expose `type_declaration` (le moteur en a besoin pour honorer
--    le saut « par nature »). Définition reprise de 00090, colonne ajoutée EN FIN
--    de liste : `create or replace view` interdit de réordonner/insérer une
--    colonne au milieu — on ne peut qu'en AJOUTER après les existantes. La
--    lecture applicative fait `select *` (ordre indifférent), donc c'est sans
--    incidence côté code.
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
  -- Ajout 2026-08-15 (en fin de liste, cf. note ci-dessus).
  c.type_declaration
from cargaisons c
where not c.annule;

revoke all on v_cargaisons_resume from public, anon, authenticated;
grant select on v_cargaisons_resume to service_role;
