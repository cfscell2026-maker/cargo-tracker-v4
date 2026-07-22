-- ============================================================================
--  CARGO TRACKER — RÉINITIALISATION DES DONNÉES (avant re-migration)
--
--  ⚠ DESTRUCTIF ET IRRÉVERSIBLE.
--  À exécuter dans le SQL Editor de Supabase UNIQUEMENT APRÈS avoir pris une
--  sauvegarde (Supabase → Database → Backups).
--
--  Ce script :
--    • VIDE les données métier (cargaisons, conteneurs, déclarations, stock,
--      stock annoncé) ;
--    • REMET le journal d'audit (Historique) à zéro — chaîne redémarrée à GENESIS ;
--    • REMET les compteurs de numérotation à zéro.
--  Il CONSERVE : le schéma, les fonctions, et les COMPTES utilisateurs
--  (tables profils + auth.users intactes — inutile de recréer les comptes).
-- ============================================================================

-- 1) Données métier. L'ordre des clés étrangères est géré par TRUNCATE : toutes
--    les tables qui se référencent sont listées dans la même commande.
truncate conteneurs, stock, stock_annonce, cargaisons, declarations restart identity;

-- 2) Compteurs de numérotation. « npm run migrer » les réalignera ensuite sur
--    les ID du nouvel export (aucun doublon d'ID).
update compteurs set valeur = 0 where cle in ('SEQ','SEQ_RPT');

-- 3) Journal d'audit — remise à zéro. NB : TRUNCATE contourne le verrou
--    append-only (le déclencheur bloque UPDATE/DELETE, pas TRUNCATE) et
--    s'exécute ici en tant que propriétaire (SQL Editor = rôle postgres).
truncate audit_log restart identity;

-- 4) Contrôle : doit renvoyer 0 partout.
select
  (select count(*) from cargaisons)    as cargaisons,
  (select count(*) from conteneurs)     as conteneurs,
  (select count(*) from declarations)   as declarations,
  (select count(*) from stock)          as stock,
  (select count(*) from stock_annonce)  as stock_annonce,
  (select count(*) from audit_log)      as audit_log;
