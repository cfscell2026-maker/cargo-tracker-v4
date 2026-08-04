-- ============================================================================
--  CARGO TRACKER v4.1 — SORTIE ENTREPÔT PAR CAMION (décision utilisateur
--  2026-08-04). L'apurement d'un magasin/entrepôt sort de la marchandise EN VRAC
--  (sacs de riz, etc.) chargée sur un CAMION scellé, pas des véhicules. On saisit
--  donc le N° de camion et ses scellés, comme pour une sortie Magasin/MAD.
--  La colonne `vehicules` reste pour compatibilité des sorties déjà saisies.
-- ============================================================================

alter table entrepot_sorties
  add column if not exists numero_camion text  not null default '',
  add column if not exists scelles       jsonb not null default '[]';  -- ["SCEL1","SCEL2",…]
