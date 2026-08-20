-- ============================================================================
--  00150 — Archivage des vieux dossiers « goulots » (demande utilisateur 2026-08-19)
--
--  Beaucoup de dossiers migrés ont été importés mais jamais menés jusqu'à la
--  sortie : ils restent « en attente » pour toujours et gonflent les files. On
--  ajoute un ARCHIVAGE — distinct de l'annulation (doublon) — pour les sortir des
--  files et des rapports SANS rien supprimer : ils restent en base, tracés, et
--  l'opération est RÉVERSIBLE (désarchivage).
--
--  `annule`  = doublon de saisie écarté (SEC-12).
--  `archive` = vieux dossier clôturé administrativement (goulot). Les deux sont
--  exclus des rapports et des files ; on les garde séparés pour l'audit.
-- ============================================================================

alter table cargaisons
  add column if not exists archive        boolean not null default false,
  add column if not exists archive_le     timestamptz,
  add column if not exists archive_par    text not null default '',
  add column if not exists archive_par_id uuid references profils(id),
  add column if not exists archive_motif  text not null default '';

comment on column cargaisons.archive is
  'Dossier ancien clôturé administrativement (goulot). Exclu des rapports/files, conservé pour audit, réversible.';

create index if not exists cargaisons_archive_idx on cargaisons (archive);

-- La vue résumé (base des listes / files / tableau de bord) exclut désormais
-- AUSSI les dossiers archivés. Reprise fidèle de 00130 + « and not c.archive ».
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
  c.date_bon_sortie
from cargaisons c
where not c.annule and not c.archive;

revoke all on v_cargaisons_resume from public, anon, authenticated;
grant select on v_cargaisons_resume to service_role;
