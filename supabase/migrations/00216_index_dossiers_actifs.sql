-- ============================================================================
--  00216 — L'INDEX QUI FAIT QUE L'ARCHIVAGE SERT À QUELQUE CHOSE (2026-10-29)
--
--  ⚠ L'ARCHIVAGE SEUL N'ACCÉLÈRE RIEN, et il fallait le mesurer pour le voir.
--
--  Mesure faite avant archivage, sur la requête de comptage des listes
--  (`select count(*) from v_cargaisons_resume`, appelée par `cargo.list` avec
--  `count: 'exact'`) :
--
--      Seq Scan on cargaisons   3 118 blocs lus   40,5 ms
--
--  Postgres BALAIE LA TABLE ENTIÈRE pour écarter les lignes archivées. Faire
--  passer 19 568 dossiers à `archive_auto = true` n'y change rien : il lira
--  toujours les 22 583 lignes, il en écartera simplement davantage. Le temps
--  resterait le même, et la promesse « l'archivage allège » serait fausse.
--
--  CET INDEX EST CE QUI REND LA PROMESSE VRAIE. Il est PARTIEL : il ne contient
--  que les dossiers vivants, exactement ceux que la vue garde. Une fois les
--  dossiers terminés archivés, il tombe de 22 500 entrées à quelques milliers,
--  et le comptage devient une lecture d'index au lieu d'un balayage de table.
--  Mieux : les lignes archivées SORTENT de l'index à mesure qu'elles sont
--  archivées, donc l'index rétrécit tout seul chaque nuit.
--
--  Il porte `date_creation desc` parce que toutes les listes trient par là :
--  l'index sert alors au filtre ET au tri, sans étape de tri supplémentaire.
-- ============================================================================

create index if not exists cargaisons_actifs_idx
  on cargaisons (date_creation desc)
  where not annule and not archive and not archive_auto;

comment on index cargaisons_actifs_idx is
  'Dossiers vivants uniquement (mêmes conditions que v_cargaisons_resume). Rétrécit à chaque archivage de nuit : c''est lui qui transforme l''archivage en gain de vitesse.';

-- Le second tri le plus fréquent : les files de travail regardent la sortie.
create index if not exists cargaisons_actifs_statut_idx
  on cargaisons (statut, date_creation desc)
  where not annule and not archive and not archive_auto;

comment on index cargaisons_actifs_statut_idx is
  'Files par étape (statut) sur les seuls dossiers vivants. Même logique que cargaisons_actifs_idx.';

-- Les statistiques du planificateur doivent connaître la nouvelle forme de la
-- table, sinon il continue de raisonner sur l'ancienne et ignore ces index.
analyze cargaisons;
