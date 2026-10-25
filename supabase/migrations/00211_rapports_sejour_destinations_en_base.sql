-- ============================================================================
--  00211, DÉLAI & INSTANCE ET PAR DESTINATION CALCULÉS PAR LA BASE
--  (2026-10-25, audit des requêtes)
--
--  Audit hors production : « Délai & instance » parcourait les 20 000 dossiers
--  (camions), « Par destination » les 17 000 sortis de l'année, pour ne rendre
--  que des totaux. Même démarche que 00209 (Flux, CFS) : le calcul se fait dans
--  la base, avec les MÊMES règles que rapports.ts, traduites littéralement ;
--  l'équivalence est prouvée sur un vrai PostgreSQL (calculs-en-base-2.test.ts).
--
--  Les paramètres viennent du serveur pour garder une seule source de vérité :
--  la liste des codes de destination (DESTINATION_CODES), le seuil d'alerte
--  (Paramètres) et l'instant de référence.
--
--  Dépend de 00209 (fn_cle_periode, fn_dans_bornes).
--  ⚠ AJOUT SEUL : des fonctions, aucune donnée modifiée. Serveur seulement.
-- ============================================================================

-- `trancheAge` : 0-7, 8-15, 16-30, 31-60, 61-90, 90+.
create or replace function fn_tranche_age(j integer) returns text
language sql immutable as $$
  select case when j <= 7 then '0-7' when j <= 15 then '8-15' when j <= 30 then '16-30'
              when j <= 60 then '31-60' when j <= 90 then '61-90' else '90+' end
$$;

-- `codeDestination` : majuscules, lettres seules ; premier code de la liste qui
-- est égal ou sert de préfixe ; sinon « Autres ».
create or replace function fn_code_destination(v text, codes text[]) returns text
language sql immutable as $$
  select coalesce(
    (select c from unnest(codes) with ordinality as t(c, o)
      where s <> '' and (s = c or s like c || '%') order by o limit 1),
    'Autres')
  from (select regexp_replace(upper(coalesce(v, '')), '[^A-Z]', '', 'g') as s) x
$$;

-- ---------------------------------------------------------------------------
-- Délai & instance : { compte, tranches, instance }
-- ---------------------------------------------------------------------------
create or replace function fn_rapport_sejour(p_now timestamptz, p_seuil integer) returns jsonb
language sql stable as $$
with base as (
  select c.id, c.numero_camion, c.type_operation::text as op, c.statut::text as statut,
         c.date_creation, c.date_sortie,
         (c.statut::text = 'Sortie Enregistrée' and c.date_sortie is not null) as sorti
  from cargaisons c
  where c.annule is not true and c.archive is not true and c.est_vehicule is not true
    and c.date_creation is not null
),
ages as (
  select b.*,
         greatest(0, floor(extract(epoch from (case when b.sorti then b.date_sortie else p_now end) - b.date_creation) / 86400))::integer as j
  from base b
),
tranches as (
  select t.tranche, t.o,
         count(a.id) filter (where not a.sorti) as instance,
         count(a.id) filter (where a.sorti) as sortis
  from (values ('0-7', 1), ('8-15', 2), ('16-30', 3), ('31-60', 4), ('61-90', 5), ('90+', 6)) as t(tranche, o)
  left join ages a on fn_tranche_age(a.j) = t.tranche
  group by t.tranche, t.o
)
select jsonb_build_object(
  'compte', jsonb_build_object(
    'totInstance', (select count(*) from ages where not sorti),
    'totSortis', (select count(*) from ages where sorti),
    'delaiMoyen', coalesce((select round(sum(j)::numeric / count(*)) from ages where sorti), 0),
    'alerte', (select count(*) from ages where not sorti and j >= p_seuil)),
  'tranches', (select jsonb_agg(jsonb_build_object('tranche', tranche, 'instance', instance, 'sortis', sortis) order by o) from tranches),
  'instance', coalesce((select jsonb_agg(jsonb_build_object(
      'id', id, 'numeroCamion', numero_camion, 'typeOperation', op, 'statut', statut, 'age', j)
      order by j desc, id collate "C") from ages where not sorti), '[]'::jsonb))
$$;

-- ---------------------------------------------------------------------------
-- Par destination : { parDest, total, series }
-- ---------------------------------------------------------------------------
create or replace function fn_rapport_destinations(p_du date, p_au date, p_gran text, p_codes text[]) returns jsonb
language sql stable as $$
with sortis as (
  select fn_code_destination(c.destination_marchandise, p_codes) as code,
         fn_cle_periode(c.date_sortie, p_gran) as k
  from cargaisons c
  where c.annule is not true and c.archive is not true and c.est_vehicule is not true
    and c.date_sortie is not null
    and ((p_du is null and p_au is null) or fn_dans_bornes(c.date_sortie, p_du, p_au))
),
codes as (
  select c, o from unnest(p_codes || array['Autres']) with ordinality as t(c, o)
),
periodes as (select distinct k from sortis where k is not null)
select jsonb_build_object(
  'parDest', (select jsonb_object_agg(c.c, (select count(*) from sortis s where s.code = c.c)) from codes c),
  'total', (select count(*) from sortis),
  'series', coalesce((select jsonb_agg(
      (select jsonb_object_agg(c.c, (select count(*) from sortis s where s.k = p.k and s.code = c.c)) from codes c)
        || jsonb_build_object('periode', p.k)
      order by p.k collate "C") from periodes p), '[]'::jsonb))
$$;

revoke all on function fn_tranche_age(integer), fn_code_destination(text, text[]),
  fn_rapport_sejour(timestamptz, integer), fn_rapport_destinations(date, date, text, text[])
  from public, anon, authenticated;
grant execute on function fn_tranche_age(integer), fn_code_destination(text, text[]),
  fn_rapport_sejour(timestamptz, integer), fn_rapport_destinations(date, date, text, text[])
  to service_role;

notify pgrst, 'reload schema';
