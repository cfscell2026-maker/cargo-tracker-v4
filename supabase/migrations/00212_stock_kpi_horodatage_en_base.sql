-- ============================================================================
--  00212, STOCK EN UN ALLER-RETOUR, KPI CALCULÉS PAR LA BASE, VUE ALLÉGÉE
--  POUR LES HEURES D'ACTIVITÉ (2026-10-25, audit des requêtes, suite)
--
--  Mesures en production (25/10, après 00211) : la liste du stock et « Séjour
--  conteneurs » mettaient 2,2 à 2,3 s, dont l'essentiel en dix-huit pages de
--  mille lignes lues l'une après l'autre ; les KPI relisaient tous les dossiers
--  et tout le stock (37 000 lignes) pour rendre une douzaine de nombres ; les
--  heures d'activité rapatriaient les blocs de conteneurs complets pour n'en
--  compter que le nombre.
--
--    · fn_stock_lignes : les colonnes du stock dont le serveur se sert, dans
--      l'ordre de la clé, en UNE réponse au lieu de dix-huit ;
--    · fn_rapport_kpi : les règles de rapports.ts (rapportKPI) traduites
--      littéralement, avec les aides de 00209 déjà prouvées équivalentes ;
--    · v_cargaisons_stats : on AJOUTE en fin de vue les agents de chaque
--      cellule et le nombre de conteneurs déclaré (heures d'activité).
--
--  L'équivalence avec le calcul JavaScript est prouvée sur un vrai PostgreSQL
--  (calculs-en-base-3.test.ts). Tant que ce script n'est pas passé, le serveur
--  retombe sur la lecture actuelle : rien ne casse.
--
--  Dépend de 00208 (vue) et 00209 (fn_conteneurs_de, fn_taille_bucket,
--  fn_js_vrai, fn_dans_bornes).
--  ⚠ AJOUT SEUL : des fonctions et des colonnes de vue, aucune donnée modifiée.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Vue allégée : mêmes colonnes que 00208, puis les nouvelles À LA FIN (seul
-- changement qu'accepte `create or replace view`).
-- ---------------------------------------------------------------------------
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
  end as conteneurs_details,
  c.agent_entree, c.agent_validation, c.agent_t1, c.agent_bon_sortie, c.agent_balise, c.agent_pp,
  c.nb_conteneurs
from cargaisons c;

revoke all on v_cargaisons_stats from public, anon, authenticated;
grant select on v_cargaisons_stats to service_role;

-- ---------------------------------------------------------------------------
-- Stock : les lignes utiles, en une réponse.
-- Bornes sur la date d'entrée (incluses) et statut exact, chacun facultatif.
-- ---------------------------------------------------------------------------
create or replace function fn_stock_lignes(p_du timestamptz, p_au timestamptz, p_statut text) returns jsonb
language sql stable as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'numero_tc', s.numero_tc, 'taille', s.taille, 'type_conteneur', s.type_conteneur,
      'provenance', s.provenance, 'statut', s.statut, 'date_entree', s.date_entree,
      'date_pointage', s.date_pointage, 'pointe_par', s.pointe_par, 'date_depote', s.date_depote,
      'cargaison_id', s.cargaison_id, 'annee_declaration', s.annee_declaration,
      'type_declaration', s.type_declaration, 'numero_declaration', s.numero_declaration,
      'nb_sejours_import', s.nb_sejours_import)
    order by s.numero_tc), '[]'::jsonb)
  from stock s
  where (p_du is null or s.date_entree >= p_du)
    and (p_au is null or s.date_entree <= p_au)
    and (p_statut is null or s.statut::text = p_statut)
$$;

-- ---------------------------------------------------------------------------
-- KPI : { videsDepotage, sortisScelles, camionsActifs, camionsSortis,
--         evpVides, evpSortis, evpStock, stock: { t20, t40, t45, autres } }
-- ---------------------------------------------------------------------------
create or replace function fn_rapport_kpi(p_du date, p_au date) returns jsonb
language sql stable as $$
with base as (
  select c.id, c.type_operation::text as op,
         coalesce(c.statut::text = 'Sortie Enregistrée', false) as sorti, c.conteneurs_details
  from cargaisons c
  where c.annule is not true and c.archive is not true and c.est_vehicule is not true
    and fn_dans_bornes(c.date_creation, p_du, p_au)
),
-- Un conteneur partagé est compté au premier dépotage, pas ici.
conts as (
  select b.op, b.sorti, fn_taille_bucket(t.e ->> 'taille') as bk
  from base b cross join lateral fn_conteneurs_de(b.conteneurs_details) t
  where not fn_js_vrai(t.e -> 'partage')
),
stk as (
  select fn_taille_bucket(s.taille) as bk from stock s where s.statut::text <> 'Dépoté'
)
select jsonb_build_object(
  'videsDepotage', (select count(*) from conts where op = 'Dépotage'),
  'sortisScelles', (select count(*) from conts where op = 'Enlèvement' and sorti),
  'camionsActifs', (select count(*) from base where not sorti),
  'camionsSortis', (select count(*) from base where sorti),
  'evpVides', (select coalesce(sum(case when bk in ('t40', 't45') then 2 else 1 end), 0) from conts where op = 'Dépotage'),
  'evpSortis', (select coalesce(sum(case when bk in ('t40', 't45') then 2 else 1 end), 0) from conts where op = 'Enlèvement' and sorti),
  'evpStock', (select coalesce(sum(case when bk in ('t40', 't45') then 2 else 1 end), 0) from stk),
  'stock', jsonb_build_object(
    't20', (select count(*) from stk where bk = 't20'),
    't40', (select count(*) from stk where bk = 't40'),
    't45', (select count(*) from stk where bk = 't45'),
    'autres', (select count(*) from stk where bk = 'autres')))
$$;

revoke all on function fn_stock_lignes(timestamptz, timestamptz, text), fn_rapport_kpi(date, date)
  from public, anon, authenticated;
grant execute on function fn_stock_lignes(timestamptz, timestamptz, text), fn_rapport_kpi(date, date)
  to service_role;

notify pgrst, 'reload schema';
