-- ---------------------------------------------------------------------------
-- v4 — DATE DE LA DÉCLARATION EN DOUANE
--
-- L'ORDRE D'EXÉCUTION (OTR / Section Brigade PIA) imprime :
--   « Déclaration : Type … N° … du 24/06/26 »
-- Cette date est celle de la déclaration EN DOUANE. Elle est distincte de
-- `date_creation`, qui n'est que la date de saisie de la déclaration dans
-- l'application — les deux peuvent diverger de plusieurs jours.
--
-- Nullable À DESSEIN : les déclarations déjà migrées ne la connaissent pas et
-- doivent continuer à fonctionner. Elle n'est exigée qu'à la CRÉATION d'une
-- nouvelle déclaration (contrôle applicatif, comme `nombre_conteneurs`).
-- ---------------------------------------------------------------------------

alter table declarations
  add column if not exists date_declaration date;

comment on column declarations.date_declaration is
  'Date de la déclaration en douane (imprimée sur l''ordre d''exécution). NULL pour les déclarations migrées.';
