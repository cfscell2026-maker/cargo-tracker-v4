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
--    • CONSERVE le journal d'audit — voir le point 3 (correctif SEC-04) ;
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

-- 3) Journal d'audit — VOLONTAIREMENT PRÉSERVÉ (correctif SEC-04, 2026-08-10).
--
--    Ce script remettait auparavant `audit_log` à zéro par TRUNCATE, en
--    exploitant le fait que le verrou append-only ne bloquait que UPDATE et
--    DELETE. C'était la seule faille assumée du journal : un script du dépôt
--    documentait comment effacer la preuve.
--
--    La migration 00090 ajoute un déclencheur BEFORE TRUNCATE : la commande
--    ci-dessous ÉCHOUERAIT désormais, et c'est le comportement voulu. Le
--    journal d'audit survit aux ré-imports — c'est précisément son rôle.
--
--    Si une remise à zéro du journal est réellement nécessaire (montage d'un
--    environnement de recette vierge, JAMAIS en production), elle relève d'une
--    décision tracée : supprimer explicitement le déclencheur, purger, le
--    recréer, et consigner l'opération par écrit.
--
-- truncate audit_log restart identity;   -- ⛔ NE PAS RÉACTIVER EN PRODUCTION

-- 4) Contrôle : doit renvoyer 0 partout.
select
  (select count(*) from cargaisons)    as cargaisons,
  (select count(*) from conteneurs)     as conteneurs,
  (select count(*) from declarations)   as declarations,
  (select count(*) from stock)          as stock,
  (select count(*) from stock_annonce)  as stock_annonce,
  (select count(*) from audit_log)      as audit_log_conserve;
