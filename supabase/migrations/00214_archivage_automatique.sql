-- ============================================================================
--  00214 — ARCHIVAGE AUTOMATIQUE DES DOSSIERS TERMINÉS (demande utilisateur
--  2026-10-29 : « l'auto-archivage se fait toutes les deux semaines […] de
--  sorte à alléger la base »).
--
--  ⚠ CE QUI EST ARCHIVÉ, ET CE QUI NE L'EST JAMAIS.
--
--  La demande initiale portait sur TOUS les dossiers de plus de deux semaines.
--  Appliquée telle quelle, elle aurait arrêté le travail : `archive = true`
--  sort un dossier de `v_cargaisons_resume`, donc des files du T1, de la
--  balise et du bon de sortie (voir 00150). Or le cycle d'un camion dépasse
--  souvent quinze jours, et les engagements courent sur trente jours et plus.
--  Des camions encore en route auraient disparu des écrans des cellules.
--
--  Décision retenue : on n'archive QUE CE QUI EST FINI.
--    · statut « Sortie Enregistrée » ET sorti depuis plus de N jours ;
--    · jamais un dossier annulé (il a son propre drapeau) ;
--    · jamais un dossier dont l'ENGAGEMENT est encore ouvert : le camion est
--      sorti, mais la brigade attend encore les informations du pays de
--      destination, et le dossier doit rester sous les yeux.
--
--  ⚠ CE QUE CELA ALLÈGE, ET CE QUE CELA N'ALLÈGE PAS.
--
--  Rien n'est déplacé ni supprimé : la base pèse exactement le même poids
--  après qu'avant. Ce qui s'allège, ce sont les LISTES et les REQUÊTES, qui
--  cessent de balayer des dossiers terminés depuis des semaines — et c'est
--  précisément ce qui ralentissait les écrans. Réduire le poids réel du
--  disque demanderait de sortir les lignes vers une table froide, ce qui est
--  un autre chantier, et quinze jours y seraient beaucoup trop courts pour un
--  dossier douanier.
--
--  L'opération reste RÉVERSIBLE : le désarchivage existe déjà (`report.archives`
--  et `cargo.desarchiver`), et la trace dit qui a archivé — ici « Automatique ».
-- ============================================================================

-- Le délai se règle dans le volet Paramètres, sans toucher à la planification.
-- Absent de `parametres_app` ⇒ 14 jours, la valeur demandée.
create or replace function fn_archivage_delai_jours()
returns int
language sql
stable
as $$
  select greatest(1, coalesce(
    (select (valeur #>> '{}')::int from parametres_app where cle = 'archiveAutoJours'),
    14));
$$;

comment on function fn_archivage_delai_jours is
  'Nombre de jours après la SORTIE au bout desquels un dossier terminé est archivé (réglage « archiveAutoJours », 14 par défaut).';

-- ----------------------------------------------------------------------------
--  La tâche elle-même. Elle rend le nombre de dossiers archivés, pour que la
--  planification laisse une trace lisible et qu'un appel à la main réponde.
-- ----------------------------------------------------------------------------
create or replace function fn_archiver_termines(p_jours int default null)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_jours int := coalesce(p_jours, fn_archivage_delai_jours());
  v_seuil timestamptz := now() - make_interval(days => v_jours);
  v_n int;
begin
  with vises as (
    select c.id
    from cargaisons c
    where c.statut = 'Sortie Enregistrée'
      and c.date_sortie is not null
      and c.date_sortie < v_seuil
      and coalesce(c.archive, false) = false
      and coalesce(c.annule, false) = false
      -- L'ENGAGEMENT OUVERT RETIENT LE DOSSIER. Le camion est parti, mais la
      -- brigade attend encore : l'archiver le ferait disparaître de
      -- l'échéancier et le retard ne serait plus réclamé par personne.
      and not (coalesce(c.suivi_engagement, false) = true
               and c.engagement_effectue_le is null)
  )
  update cargaisons c
     set archive       = true,
         archive_le    = now(),
         archive_par   = 'Automatique',
         archive_motif = 'Dossier sorti depuis plus de ' || v_jours || ' jours (archivage automatique).'
    from vises v
   where c.id = v.id;

  get diagnostics v_n = row_count;

  if v_n > 0 then
    begin
      insert into audit_log (username, nom_complet, role, action, cargaison_id, details, prev_hash, hash)
      values ('systeme', 'Archivage automatique', 'SYSTEME', 'Archivage automatique', '',
              v_n || ' dossier(s) sorti(s) depuis plus de ' || v_jours || ' jours', '', '');
    exception when others then
      -- La trace a manqué, l'archivage tient : on ne défait pas un travail
      -- fait parce que le journal est momentanément indisponible.
      raise notice 'Archivage automatique : trace non écrite (%).', sqlerrm;
    end;
  end if;

  return v_n;
end;
$$;

comment on function fn_archiver_termines is
  'Archive les dossiers SORTIS depuis plus de N jours. N''archive jamais un dossier en cours, annulé, ou dont l''engagement reste ouvert. Réversible (désarchivage).';

revoke all on function fn_archiver_termines(int) from public, anon, authenticated;
grant execute on function fn_archiver_termines(int) to service_role;

-- L'index qui rend la sélection immédiate : sans lui, la tâche balaierait la
-- table entière chaque nuit pour trouver quelques dizaines de lignes.
create index if not exists cargaisons_archivage_auto_idx
  on cargaisons (date_sortie)
  where statut = 'Sortie Enregistrée' and archive = false and annule = false;

-- ----------------------------------------------------------------------------
--  LA PLANIFICATION, toutes les nuits à 02:10 UTC (heure creuse à Lomé).
--
--  Posée seulement si `pg_cron` est disponible : l'extension s'active depuis le
--  tableau de bord Supabase, et une migration qui échouerait faute d'extension
--  bloquerait tout le reste. Si elle manque, la fonction existe quand même et
--  s'appelle à la main ; le message dit quoi faire.
-- ----------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule('archivage-termines')
      where exists (select 1 from cron.job where jobname = 'archivage-termines');
    perform cron.schedule('archivage-termines', '10 2 * * *',
                          'select fn_archiver_termines();');
    raise notice 'Archivage automatique planifié : toutes les nuits à 02:10 UTC.';
  else
    raise notice 'pg_cron absent : activez-le (Dashboard > Database > Extensions), puis relancez ce bloc. La fonction fn_archiver_termines() reste appelable à la main.';
  end if;
end;
$$;
