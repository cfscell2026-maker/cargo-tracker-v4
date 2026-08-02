-- ============================================================================
--  CARGO TRACKER v4.1 — Pesée / surcharge à la validation chef brigade
--  (décision utilisateur 2026-07-27). Additif, non bloquant : colonnes nullables.
--  À la validation, le chef renseigne la pesée : en surcharge OUI/NON ; si OUI,
--  le poids en surcharge (kg). Sert aux statistiques Hors-Gabarit / Surcharge /
--  Transit national. hors_gabarit / hauteur_chargement existent déjà (00010).
-- ============================================================================

alter table cargaisons
  add column if not exists en_surcharge    boolean,          -- null = pas encore pesé
  add column if not exists poids_surcharge text not null default '';  -- kg, si en surcharge
