-- ============================================================================
--  ANNULATION — Remettre les fantômes du parc dans leur état d'avant la purge
--
--  À n'utiliser QUE si la purge (purger-fantomes-parc-EXECUTER.sql) doit être
--  défaite. Supabase → SQL Editor → coller tout → Run.
--
--  Ne touche QUE les conteneurs marqués par la purge, et leur rend exactement
--  les valeurs de la sauvegarde. Tout ce qui a été fait d'autre sur le parc
--  depuis la purge est conservé.
-- ============================================================================

update stock s
   set statut       = b.statut,
       date_depote  = b.date_depote,
       cargaison_id = b.cargaison_id,
       observations = b.observations
  from stock_sauvegarde_20260924 b
 where b.numero_tc = s.numero_tc
   and s.observations like '%Régularisé 2026-09 : fantôme du parc%';

select 'Conteneurs encore marqués par la purge (doit être 0)' as indicateur, count(*) as valeur
  from stock where observations like '%Régularisé 2026-09 : fantôme du parc%';
