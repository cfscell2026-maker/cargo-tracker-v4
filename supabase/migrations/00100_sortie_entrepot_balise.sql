-- ============================================================================
--  CARGO TRACKER v4.2 — Sortie d'entrepôt : balise / dispense (types C et A)
--
--  Une sortie de magasin (MAD) ou d'entrepôt industriel emporte la marchandise
--  sur un camion scellé. Selon le TYPE de la déclaration d'apurement, ce camion
--  doit être balisé ou non :
--    · T (transit)            → balisé, comme un dépotage ;
--    · C (consommation) / A   → l'agent tranche, et le cas courant est SANS
--      (admission)              balise — c'est donc le défaut proposé.
--
--  La colonne enregistre la DÉCISION prise au moment de l'apurement :
--    true  = à baliser
--    false = à ne pas baliser (dispense)
--    null  = sans objet (type T) ou sortie enregistrée avant cette version.
-- ============================================================================

alter table entrepot_sorties
  add column if not exists balise_requise boolean;

comment on column entrepot_sorties.balise_requise is
  'Décision balise à l''apurement : true = à baliser, false = dispense (types C/A), null = sans objet (type T) ou sortie antérieure à la v4.2.';
