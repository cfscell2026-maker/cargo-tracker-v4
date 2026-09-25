-- ============================================================================
--  00202 — DISPENSE ou ESCORTE (2026-09-24, demande utilisateur)
--
--  La cellule Balise pouvait exempter un camion de balise, sans dire POURQUOI.
--  Deux situations très différentes se retrouvaient donc mélangées dans le
--  volet « Dispenses » : l'exemption accordée sur autorisation, et le camion
--  qui part SOUS ESCORTE. Les agents l'écrivaient d'ailleurs à la main dans le
--  numéro d'autorisation (« ESCORTE MILITAIRE », « ESCORTE SANVEE CONDJI »),
--  faute d'un endroit pour le dire.
--
--  ⚠ MIGRATION ADDITIVE. Une colonne neuve, vide : aucune ligne existante n'est
--  modifiée, et l'application se comporte comme avant tant que personne ne
--  choisit « Escorter ». Pour les lignes déjà en base, la nature est DÉDUITE de
--  la référence saisie (voir `natureExemption` dans le domaine) : on ne réécrit
--  pas l'historique, on le lit mieux.
--
--  Valeurs : 'dispense', 'escorte', ou NULL (pas d'exemption / donnée ancienne).
-- ============================================================================

alter table cargaisons add column if not exists type_exemption text;

comment on column cargaisons.type_exemption is
  'Nature de l''exemption de balise décidée à la cellule Balise : dispense (sur autorisation) ou escorte. NULL = balise posée, ou donnée antérieure au 2026-09-24.';

-- La recherche du volet « Dispenses » filtre sur cette colonne ET sur
-- balise_requise ; l'index partiel ne couvre donc que les lignes exemptées,
-- une poignée sur seize mille.
create index if not exists idx_cargaisons_exemption
  on cargaisons (type_exemption)
  where type_exemption is not null;
