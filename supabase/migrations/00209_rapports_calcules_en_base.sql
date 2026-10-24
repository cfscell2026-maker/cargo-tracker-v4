-- ============================================================================
--  00209, RAPPORTS FLUX ET CFS CALCULÉS PAR LA BASE (2026-10-24, vitesse)
--
--  Mesuré en production : Analyse des flux 4,1 s, Rapport CFS 2,9 s. Le serveur
--  rapatriait des milliers de dossiers et leurs conteneurs pour ne rendre que
--  quelques dizaines de chiffres. Ces fonctions font le calcul DANS la base et
--  ne renvoient que le résultat.
--
--  RÈGLE D'OR : MÊMES CHIFFRES QUE LE CALCUL JAVASCRIPT, À L'UNITÉ.
--  Chaque règle est la traduction littérale de rapports.ts :
--    · dossiers annulés, archivés et véhicules écartés ;
--    · conteneurs lus comme `parseConteneursDetails` (enveloppe, simple liste,
--      ou texte JSON d'une ancienne saisie) ;
--    · conteneur « partagé » écarté, avec la vérité au sens JavaScript ;
--    · doublon de N° compté une seule fois (par période pour le flux, sur la
--      période entière pour le CFS), le PREMIER rencontré dans l'ordre des
--      identifiants, comme la boucle JavaScript ;
--    · tailles classées comme `tailleBucket`, EVP comme `evpDeTaille` ;
--    · périodes en UTC, comme le serveur.
--  L'équivalence est vérifiée par un test sur un vrai PostgreSQL (PGlite),
--  sur un jeu de données qui couvre chacun de ces cas.
--
--  Le serveur garde le calcul JavaScript : pour les exports Excel (qui ont
--  besoin des listes), pour un filtre par agent, et si ces fonctions manquent.
--
--  ⚠ AJOUT SEUL : des fonctions, aucune donnée modifiée. Exécution réservée au
--  serveur (service_role).
-- ============================================================================

-- Vérité au sens JavaScript d'une valeur JSON (`if (x)`).
create or replace function fn_js_vrai(v jsonb) returns boolean
language sql immutable as $$
  select case
    when v is null then false
    when jsonb_typeof(v) = 'null' then false
    when jsonb_typeof(v) = 'boolean' then v::text::boolean
    when jsonb_typeof(v) = 'number' then (v::text)::numeric <> 0
    when jsonb_typeof(v) = 'string' then (v #>> '{}') <> ''
    else true
  end
$$;

-- `tailleBucket` : retire apostrophes ('’) et espaces (\s de JavaScript), puis
-- classe sur le début : 20 / 40 / 45 / autres.
create or replace function fn_taille_bucket(t text) returns text
language sql immutable as $$
  select case
    when s like '20%' then 't20'
    when s like '40%' then 't40'
    when s like '45%' then 't45'
    else 'autres'
  end
  from (select regexp_replace(coalesce(t, ''),
          '[''’\t\n\v\f\r    -     　﻿]', '', 'g') as s) x
$$;

-- Conteneurs d'un dossier, dans l'ordre, comme `parseConteneursDetails`.
create or replace function fn_conteneurs_de(cd jsonb) returns table(ord bigint, e jsonb)
language plpgsql immutable as $$
declare
  x jsonb := cd;
begin
  if x is null then return; end if;
  if jsonb_typeof(x) = 'string' then
    -- Ancienne saisie : du texte JSON. `JSON.parse('')` vaut `[]`, un texte
    -- illisible aussi.
    begin
      x := coalesce(nullif(x #>> '{}', ''), '[]')::jsonb;
    exception when others then
      return;
    end;
  end if;
  if jsonb_typeof(x) = 'array' then
    return query select t.o, t.v from jsonb_array_elements(x) with ordinality as t(v, o);
  elsif jsonb_typeof(x) = 'object' and jsonb_typeof(x -> 'conteneurs') = 'array' then
    return query select t.o, t.v from jsonb_array_elements(x -> 'conteneurs') with ordinality as t(v, o);
  end if;
end
$$;

-- `periodeKey`, en UTC : année, mois, semaine (lundi), sinon jour.
create or replace function fn_cle_periode(ts timestamptz, gran text) returns text
language sql immutable as $$
  select case
    when ts is null then null
    when gran = 'annee' then to_char(ts at time zone 'UTC', 'YYYY')
    when gran = 'mois' then to_char(ts at time zone 'UTC', 'YYYY-MM')
    when gran = 'semaine' then to_char(date_trunc('week', ts at time zone 'UTC'), 'YYYY-MM-DD')
    else to_char(ts at time zone 'UTC', 'YYYY-MM-DD')
  end
$$;

-- `inRange` : dans [du 00:00, au + 1 jour[ (UTC) ; une date absente n'y est jamais.
create or replace function fn_dans_bornes(ts timestamptz, du date, au date) returns boolean
language sql immutable as $$
  select ts is not null
     and (du is null or ts >= (du::timestamp at time zone 'UTC'))
     and (au is null or ts < ((au + 1)::timestamp at time zone 'UTC'))
$$;

-- ---------------------------------------------------------------------------
-- Analyse des flux : { rows: [{periode, enlevesC, depotesC, tc, evp, baliseC, ppC}], totaux }
-- ---------------------------------------------------------------------------
create or replace function fn_rapport_flux(p_du date, p_au date, p_gran text) returns jsonb
language sql stable as $$
with base as (
  select c.id, c.type_operation::text as op, c.date_creation, c.date_pose_gps, c.date_sortie, c.conteneurs_details
  from cargaisons c
  where c.annule is not true and c.archive is not true and c.est_vehicule is not true
),
-- « dansPeriode » : sans aucune borne, tout passe (même une date absente, sur laquelle la clé reste nulle).
dans as (
  select b.*,
    case when (p_du is null and p_au is null) or fn_dans_bornes(b.date_creation, p_du, p_au)
         then fn_cle_periode(b.date_creation, p_gran) end as k_crea,
    case when b.date_pose_gps is not null and ((p_du is null and p_au is null) or fn_dans_bornes(b.date_pose_gps, p_du, p_au))
         then fn_cle_periode(b.date_pose_gps, p_gran) end as k_balise,
    case when b.date_sortie is not null and ((p_du is null and p_au is null) or fn_dans_bornes(b.date_sortie, p_du, p_au))
         then fn_cle_periode(b.date_sortie, p_gran) end as k_pp
  from base b
),
conts as (
  select d.id, d.op, d.k_crea as k, t.ord,
         case when fn_js_vrai(t.e -> 'num') then t.e ->> 'num' end as num,
         case when fn_taille_bucket(t.e ->> 'taille') in ('t40', 't45') then 2 else 1 end as evp
  from dans d cross join lateral fn_conteneurs_de(d.conteneurs_details) t
  where d.k_crea is not null and not fn_js_vrai(t.e -> 'partage')
),
gardes as (
  select * from (
    select c.*, case when c.num is null then 1
                     else row_number() over (partition by c.k, c.num order by c.id, c.ord) end as rang
    from conts c
  ) x where rang = 1
),
par_conts as (
  select k,
         count(*) filter (where op = 'Enlèvement') as enl,
         count(*) filter (where op = 'Dépotage') as dep,
         count(*) as tc, sum(evp) as evp
  from gardes group by k
),
periodes as (
  select k_crea as k from dans where k_crea is not null
  union select k_balise from dans where k_balise is not null
  union select k_pp from dans where k_pp is not null
),
lignes as (
  select p.k as periode,
         coalesce(pc.enl, 0) as "enlevesC", coalesce(pc.dep, 0) as "depotesC",
         coalesce(pc.tc, 0) as tc, coalesce(pc.evp, 0) as evp,
         (select count(*) from dans d where d.k_balise = p.k) as "baliseC",
         (select count(*) from dans d where d.k_pp = p.k) as "ppC"
  from periodes p left join par_conts pc on pc.k = p.k
)
select jsonb_build_object(
  'rows', coalesce((select jsonb_agg(to_jsonb(l) order by l.periode collate "C") from lignes l), '[]'::jsonb),
  'totaux', jsonb_build_object(
    'periode', '',
    'enlevesC', coalesce((select sum("enlevesC") from lignes), 0),
    'depotesC', coalesce((select sum("depotesC") from lignes), 0),
    'tc', coalesce((select sum(tc) from lignes), 0),
    'evp', coalesce((select sum(evp) from lignes), 0),
    'baliseC', coalesce((select sum("baliseC") from lignes), 0),
    'ppC', coalesce((select sum("ppC") from lignes), 0)))
$$;

-- ---------------------------------------------------------------------------
-- Rapport CFS : { parOp: {Enlèvement: agg, Dépotage: agg}, total: agg }
--   agg = { camions, t20, t40, t45, autres, evp, conteneurs }
-- ---------------------------------------------------------------------------
create or replace function fn_rapport_cfs(p_du date, p_au date) returns jsonb
language sql stable as $$
with base as (
  select c.id, c.type_operation::text as op, c.conteneurs_details
  from cargaisons c
  where c.annule is not true and c.archive is not true and c.est_vehicule is not true
    and fn_dans_bornes(c.date_creation, p_du, p_au)
    and c.type_operation::text in ('Enlèvement', 'Dépotage')
),
conts as (
  select b.id, b.op, t.ord,
         case when fn_js_vrai(t.e -> 'num') then t.e ->> 'num' end as num,
         fn_taille_bucket(t.e ->> 'taille') as bk
  from base b cross join lateral fn_conteneurs_de(b.conteneurs_details) t
  where not fn_js_vrai(t.e -> 'partage')
),
gardes as (
  select * from (
    select c.*, case when c.num is null then 1
                     else row_number() over (partition by c.num order by c.id, c.ord) end as rang
    from conts c
  ) x where rang = 1
),
agg as (
  select o.op,
    (select count(*) from base b where b.op = o.op or o.op = 'TOTAL') as camions,
    count(g.id) filter (where g.bk = 't20') as t20,
    count(g.id) filter (where g.bk = 't40') as t40,
    count(g.id) filter (where g.bk = 't45') as t45,
    count(g.id) filter (where g.bk = 'autres') as autres,
    coalesce(sum(case when g.bk in ('t40', 't45') then 2 when g.bk is not null then 1 end), 0) as evp,
    count(g.id) as conteneurs
  from (values ('Enlèvement'), ('Dépotage'), ('TOTAL')) as o(op)
  left join gardes g on (g.op = o.op or o.op = 'TOTAL')
  group by o.op
)
select jsonb_build_object(
  'parOp', jsonb_build_object(
    'Enlèvement', (select to_jsonb(a) - 'op' from agg a where a.op = 'Enlèvement'),
    'Dépotage', (select to_jsonb(a) - 'op' from agg a where a.op = 'Dépotage')),
  'total', (select to_jsonb(a) - 'op' from agg a where a.op = 'TOTAL'))
$$;

revoke all on function fn_js_vrai(jsonb), fn_taille_bucket(text), fn_conteneurs_de(jsonb),
  fn_cle_periode(timestamptz, text), fn_dans_bornes(timestamptz, date, date),
  fn_rapport_flux(date, date, text), fn_rapport_cfs(date, date)
  from public, anon, authenticated;
grant execute on function fn_js_vrai(jsonb), fn_taille_bucket(text), fn_conteneurs_de(jsonb),
  fn_cle_periode(timestamptz, text), fn_dans_bornes(timestamptz, date, date),
  fn_rapport_flux(date, date, text), fn_rapport_cfs(date, date)
  to service_role;

notify pgrst, 'reload schema';
