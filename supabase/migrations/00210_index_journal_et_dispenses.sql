-- ============================================================================
--  00210, INDEX DU JOURNAL ET DES DISPENSES (2026-10-25, audit des requêtes)
--
--  Audit hors production (scripts/audit/cout-lecture.ts) :
--    · Historique : chaque page triait le journal ENTIER (124 000 lignes en
--      production) par date, faute d'index sur `ts` : l'index suit exactement
--      l'ordre demandé (date décroissante, puis id).
--    · Dispenses : le rapport ne lit plus que les camions dont la balise n'est
--      pas requise ; un index partiel les retrouve sans parcourir la table.
--
--  ⚠ AJOUT SEUL, rejouable (`if not exists`). Quelques secondes sur ces tailles.
-- ============================================================================

create index if not exists audit_log_ts_id_idx on audit_log (ts desc, id desc);

create index if not exists cargaisons_dispenses_idx
  on cargaisons (id)
  where balise_requise is false and est_vehicule is not true;

analyze audit_log;
analyze cargaisons;

notify pgrst, 'reload schema';
