-- ============================================================================
--  RÉGULARISATION — Purger les « fantômes » du parc — VERSION À EXÉCUTER
--
--  Supabase → SQL Editor → coller TOUT ce fichier → Run. Une seule fois.
--
--  Ce que fait ce fichier, dans cet ordre :
--   1. copie INTÉGRALE de la table `stock` dans `stock_sauvegarde_20260924`
--      (fermée à l'API : seul l'éditeur SQL peut la lire) ;
--   2. passe les fantômes à « Dépoté » — exactement la même sélection que
--      l'étape 1 de purger-fantomes-parc.sql (2 260 au relevé du 2026-09-24) ;
--   3. affiche le bilan.
--
--  GARDE-FOUS INTÉGRÉS — rien à surveiller à la main :
--   · Tout le fichier est UNE transaction : si une seule étape échoue, RIEN
--     n'est écrit, ni la copie ni la mise à jour.
--   · Si le nombre de conteneurs mis à jour sort de la fourchette 2 200 – 2 320,
--     le script s'arrête avec une erreur et annule tout.
--   · Relancé une deuxième fois par erreur, il échoue dès l'étape 1 (la copie
--     existe déjà) et n'écrit rien.
--
--  Pour revenir en arrière : purger-fantomes-parc-ANNULER.sql
-- ============================================================================


-- 1. SAUVEGARDE ---------------------------------------------------------------
create table stock_sauvegarde_20260924 as table stock;
alter table stock_sauvegarde_20260924 enable row level security;   -- aucune politique = aucun accès API
revoke all on stock_sauvegarde_20260924 from anon, authenticated;
comment on table stock_sauvegarde_20260924 is
  'Copie de stock avant la purge des fantômes du parc (2026-09-24). À supprimer une fois la régularisation validée.';


-- 2. RÉGULARISATION -----------------------------------------------------------
do $$
declare n integer;
begin
  with vivants as (
    select id, date_creation
    from cargaisons where not coalesce(annule, false) and not coalesce(archive, false)
  ),
  camions as (   -- dernier camion vivant sur lequel chaque conteneur a été saisi
    select distinct on (tc) tc, cargaison_id, date_creation as date_camion
    from (
      select upper(regexp_replace(k.conteneur, '[^A-Za-z0-9]', '', 'g')) as tc,
             v.id as cargaison_id, v.date_creation
      from conteneurs k join vivants v on v.id = k.cargaison_id
    ) x order by tc, date_creation desc
  )
  update stock s
     set statut       = 'Dépoté',
         date_depote  = c.date_camion,
         cargaison_id = c.cargaison_id,
         observations = trim(both ' ' from s.observations || ' Régularisé 2026-09 : fantôme du parc (déjà sur camion ' || c.cargaison_id || ')')
    from camions c
   where c.tc = s.numero_tc
     and s.statut in ('En stock', 'Positionné')
     and (s.date_entree is null or c.date_camion >= s.date_entree)
     -- EXCLUS : la PIA les voit encore au parc — à vérifier avec elle d'abord.
     and s.numero_tc not in ('PONU2106574','MSMU2478633','TGBU3908363','TTNU1281301',
                             'FYCU7078466','CAIU3662980','CAAU2212878');

  get diagnostics n = row_count;
  if n not between 2200 and 2320 then
    raise exception 'ARRÊT : % conteneur(s) auraient été modifiés, 2 260 attendus. Rien n''a été écrit.', n;
  end if;
  raise notice '% conteneur(s) régularisé(s).', n;
end $$;


-- 3. BILAN --------------------------------------------------------------------
select 'Conteneurs régularisés' as indicateur,
       count(*) as valeur
  from stock where observations like '%Régularisé 2026-09 : fantôme du parc%'
union all
select 'Parc Cargo Tracker après purge (En stock + Positionné)', count(*)
  from stock where statut in ('En stock', 'Positionné')
union all
select 'Lignes dans la sauvegarde', count(*)
  from stock_sauvegarde_20260924;
