-- ============================================================================
--  RÉGULARISATION — Purger les « fantômes » du parc
--
--  ⚠ CE FICHIER ÉCRIT DANS LA BASE. Il n'est PAS une migration, et ne doit PAS
--    être placé dans supabase/migrations/.
--
--  ⚠ LA PARTIE QUI ÉCRIT EST COMMENTÉE. On regarde d'abord (étapes 1 et 2),
--    on décide, on décommente ensuite l'étape 3. Ne jamais exécuter d'un bloc.
--
--  CONTEXTE
--  --------
--  Rapprochement PIA ↔ Cargo Tracker du 2026-09-24
--  (scripts/diagnostic/rapprochement-pia-*.sql), catégorie B : 2 260 conteneurs
--  que la table `stock` dit « En stock » ou « Positionné » alors qu'ils sont
--  déjà saisis sur un camion — 2 258 de ces camions sont même « Sortie
--  Enregistrée ». Ils représentent 48 % du parc affiché et 1 990 des 3 285
--  conteneurs « > 30 jours ».
--
--  La régularisation fait exactement ce que `fn_lier_stock` aurait dû faire au
--  moment du dépotage : statut « Dépoté », rattachement à la cargaison. Seule
--  différence : `date_depote` reprend la date du camion, pas `now()`, pour que
--  les statistiques de dépotage restent justes.
--
--  À FAIRE AVANT
--  -------------
--  1. Vérifier que la sauvegarde quotidienne Supabase est active.
--  2. Lancer l'étape 1 et comparer le total à 2 260 (relevé du 2026-09-24, hors
--     les 7 conteneurs que la PIA voit encore au parc ; il peut avoir bougé de
--     quelques unités depuis).
-- ============================================================================


-- ---------------------------------------------------------------------------
-- ÉTAPE 1 — REGARDER : combien, et comment ils ont été saisis sur le camion
--
--  `mode_saisie` vient du journal d'audit (« CFS — ajout conteneur ») : il dit
--  si le conteneur a été saisi à la main, ce qui confirme ou infirme la cause.
-- ---------------------------------------------------------------------------
with vivants as (
  select id, statut::text as statut, numero_camion, date_creation
  from cargaisons where not coalesce(annule, false) and not coalesce(archive, false)
),
camions as (
  select distinct on (tc) tc, cargaison_id, numero_camion, date_creation as date_camion, statut as statut_camion
  from (
    select upper(regexp_replace(k.conteneur, '[^A-Za-z0-9]', '', 'g')) as tc,
           v.id as cargaison_id, v.numero_camion, v.date_creation, v.statut
    from conteneurs k join vivants v on v.id = k.cargaison_id
  ) x order by tc, date_creation desc
),
fantomes as materialized (
  select s.numero_tc, s.statut::text as statut_stock, s.date_entree, c.*
  from stock s join camions c on c.tc = s.numero_tc
  where s.statut in ('En stock', 'Positionné')
    and (s.date_entree is null or c.date_camion >= s.date_entree)
    -- EXCLUS : la PIA les voit ENCORE au parc (rapprochement du 24/09). À vérifier
    -- avec elle avant tout geste — numéro mal saisi sur le camion, ou liste PIA en retard.
    and s.numero_tc not in ('PONU2106574','MSMU2478633','TGBU3908363','TTNU1281301','FYCU7078466','CAIU3662980','CAAU2212878')
),
-- `audit_log` n'a AUCUN index : on le lit UNE seule fois, en ne gardant que
-- les lignes des camions concernés (une première version l'interrogeait
-- conteneur par conteneur et dépassait le délai de l'éditeur SQL).
journal as materialized (
  select a.cargaison_id, split_part(a.details, ' ', 1) as tc,
         bool_or(a.details ilike '%manuel%') as manuel
  from audit_log a
  where a.cargaison_id in (select cargaison_id from fantomes)
  group by 1, 2
)
select
  case
    when j.manuel then 'saisie manuelle'
    when j.tc is not null then 'saisie normale'
    else 'aucune trace au journal'
  end as mode_saisie,
  f.statut_camion,
  to_char(date_trunc('month', f.date_camion), 'YYYY-MM') as mois_camion,
  count(*) as n
from fantomes f
left join journal j on j.cargaison_id = f.cargaison_id and j.tc = f.numero_tc
group by 1, 2, 3
order by 3, 1, 2;


-- ---------------------------------------------------------------------------
-- ÉTAPE 2 — VÉRIFIER : les rares cas qui ne sont PAS sortis
--
--  Un camion encore en cours (« Créée », « GPS Installé »…) : le conteneur est
--  bien dépoté, la régularisation reste juste. On les liste pour mémoire.
-- ---------------------------------------------------------------------------
-- (reprendre le WITH de l'étape 1 jusqu'à `fantomes` inclus, puis :)
-- select * from fantomes where statut_camion <> 'Sortie Enregistrée';


-- ---------------------------------------------------------------------------
-- ÉTAPE 3 — ÉCRIRE (commenté). Une seule transaction ; le nombre de lignes
-- mises à jour doit être égal au total de l'étape 1.
-- ---------------------------------------------------------------------------
-- begin;
--
-- with vivants as (
--   select id, statut::text as statut, date_creation
--   from cargaisons where not coalesce(annule, false) and not coalesce(archive, false)
-- ),
-- camions as (
--   select distinct on (tc) tc, cargaison_id, date_creation as date_camion
--   from (
--     select upper(regexp_replace(k.conteneur, '[^A-Za-z0-9]', '', 'g')) as tc,
--            v.id as cargaison_id, v.date_creation
--     from conteneurs k join vivants v on v.id = k.cargaison_id
--   ) x order by tc, date_creation desc
-- )
-- update stock s
--    set statut       = 'Dépoté',
--        date_depote  = c.date_camion,
--        cargaison_id = c.cargaison_id,
--        observations = trim(both ' ' from s.observations || ' Régularisé 2026-09 : fantôme du parc (déjà sur camion ' || c.cargaison_id || ')')
--   from camions c
--  where c.tc = s.numero_tc
--    and s.statut in ('En stock', 'Positionné')
--    and (s.date_entree is null or c.date_camion >= s.date_entree)
--    and s.numero_tc not in ('PONU2106574','MSMU2478633','TGBU3908363','TTNU1281301','FYCU7078466','CAIU3662980','CAAU2212878');
--
-- -- Contrôle : doit rendre 0.
-- -- (relancer l'étape 1 : aucune ligne)
--
-- commit;   -- ou rollback; si le nombre ne correspond pas
