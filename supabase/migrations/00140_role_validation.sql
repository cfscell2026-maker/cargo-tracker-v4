-- ============================================================================
--  00140 — Traçabilité du signataire de la validation (rôle) + rôle CBPI
--  Demande utilisateur 2026-08-19 : déléguer la validation/signature à un « chef
--  brigade par intérim » (CBPI), et savoir sur chaque dossier QUI a signé — le
--  chef brigade titulaire ou un intérimaire — au-delà du seul nom.
--
--  La table `validations` (append-only) conserve déjà la colonne `role` par
--  signature. On ajoute ici, sur la fiche `cargaisons`, le rôle du DERNIER
--  signataire, pour l'afficher directement sans recharger l'historique. Colonne
--  facultative : les fiches validées avant cette migration restent nulles (le
--  nom du signataire, lui, était déjà stocké dans `agent_validation`).
-- ============================================================================

alter table cargaisons
  add column if not exists role_validation text;

comment on column cargaisons.role_validation is
  'Rôle du dernier signataire de la validation (CHEF_BRIGADE ou CBPI). Historique complet par signature dans la table validations.';
