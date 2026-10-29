-- ============================================================================
--  00215 — L'ARCHIVAGE AUTOMATIQUE PREND SON PROPRE DRAPEAU (2026-10-29)
--
--  ⚠ CE QUE 00214 AURAIT FAIT, ET QU'IL NE FAUT PAS.
--
--  00214 posait `archive = true` sur les dossiers sortis depuis plus de
--  quinze jours. Le comptage à blanc, fait avant de laisser tourner la tâche,
--  a donné 19 568 dossiers sur 22 583 — 86 % de la base.
--
--  Or `archive` n'est pas lu que par les listes. TOUS LES RAPPORTS l'excluent
--  aussi (`rapports.ts` : `.not('archive','is',true)`), parce que ce drapeau a
--  été créé en août 2026 (00150) pour les « goulots » : de vieux dossiers
--  migrés jamais sortis, qu'on voulait retirer des files ET des rapports.
--
--  Archiver 19 568 dossiers avec ce drapeau aurait donc VIDÉ les rapports
--  historiques : rapport CFS, flux, amendes, engagements par période, temps de
--  passage, destinations. Tout ce qui porte sur plus de quinze jours. Ce n'est
--  pas alléger, c'est effacer.
--
--  LES DEUX INTENTIONS SONT SÉPARÉES :
--    · `archive`      — goulot, posé À LA MAIN avec un motif. Sort des files
--                       ET des rapports. 47 dossiers. Inchangé.
--    · `archive_auto` — routine de nuit, dossier TERMINÉ depuis N jours. Sort
--                       des files et des listes, RESTE dans les rapports :
--                       l'historique doit continuer de se lire.
-- ============================================================================

alter table cargaisons
  add column if not exists archive_auto    boolean not null default false,
  add column if not exists archive_auto_le timestamptz;

comment on column cargaisons.archive_auto is
  'Dossier TERMINÉ archivé par la tâche de nuit. Sort des listes de travail, RESTE dans les rapports (différence avec `archive`, réservé aux goulots). Réversible.';

create index if not exists cargaisons_archive_auto_idx on cargaisons (archive_auto);

-- ----------------------------------------------------------------------------
--  La vue des listes exclut désormais les DEUX drapeaux. Reprise fidèle de
--  la DÉFINITION VIVANTE (`pg_get_viewdef`), à laquelle on n'ajoute que
--  « and not c.archive_auto ».
--
--  ⚠ NE PAS REPARTIR DE 00150 : une migration ultérieure y a ajouté les trois
--  colonnes d'engagement. Les omettre revient à les supprimer, et Postgres
--  refuse (42P16, « cannot drop columns from view »). Il a bien fait : la
--  liste des engagements se serait vidée sans un mot.
-- ----------------------------------------------------------------------------
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
  c.suivi_engagement,
  c.engagement_delai,
  c.engagement_effectue_le
from cargaisons c
where not c.annule and not c.archive and not c.archive_auto;

revoke all on v_cargaisons_resume from public, anon, authenticated;
grant select on v_cargaisons_resume to service_role;

-- ----------------------------------------------------------------------------
--  La tâche écrit désormais `archive_auto`, et plus `archive`.
--  Les garde-fous de 00214 sont conservés mot pour mot : jamais un dossier en
--  cours, jamais un annulé, jamais un dont l'engagement reste ouvert.
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
      and coalesce(c.archive_auto, false) = false
      and coalesce(c.archive, false) = false
      and coalesce(c.annule, false) = false
      -- L'ENGAGEMENT OUVERT RETIENT LE DOSSIER. Le camion est parti, mais la
      -- brigade attend encore : l'archiver le ferait disparaître de
      -- l'échéancier et le retard ne serait plus réclamé par personne.
      and not (coalesce(c.suivi_engagement, false) = true
               and c.engagement_effectue_le is null)
  )
  update cargaisons c
     set archive_auto    = true,
         archive_auto_le = now()
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
  'Archive (archive_auto) les dossiers SORTIS depuis plus de N jours. N''archive jamais un dossier en cours, annulé, ou dont l''engagement reste ouvert. Les rapports continuent de les lire. Réversible.';

revoke all on function fn_archiver_termines(int) from public, anon, authenticated;
grant execute on function fn_archiver_termines(int) to service_role;

-- L'index de 00214 visait `archive` : il vise désormais le bon drapeau.
drop index if exists cargaisons_archivage_auto_idx;
create index if not exists cargaisons_archivage_auto_idx
  on cargaisons (date_sortie)
  where statut = 'Sortie Enregistrée' and archive_auto = false and annule = false;

-- ----------------------------------------------------------------------------
--  RETOUR EN ARRIÈRE, s'il fallait tout rouvrir d'un coup. Laissée ici parce
--  qu'une fonction qui touche 19 000 lignes doit pouvoir se défaire sans qu'on
--  réécrive la requête sous pression.
-- ----------------------------------------------------------------------------
create or replace function fn_desarchiver_auto()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare v_n int;
begin
  update cargaisons set archive_auto = false, archive_auto_le = null where archive_auto = true;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

revoke all on function fn_desarchiver_auto() from public, anon, authenticated;
grant execute on function fn_desarchiver_auto() to service_role;
