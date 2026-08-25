-- ============================================================================
--  00160 — Sortie d'entrepôt MAD : lien vers la cargaison créée (2026-08-19)
--
--  À la sortie (apurement) d'un entrepôt MAD, le camion qui emporte la
--  marchandise est désormais CRÉÉ comme une vraie cargaison (type « Sortie
--  Magasin / MAD »), qui suit le circuit selon le régime de la déclaration de
--  sortie : transit → validation + T1 + balise + sortie ; conso → validation
--  puis saute T1/balise. On garde le LIEN apurement → cargaison pour la
--  concordance et l'audit. Colonne facultative : les sorties antérieures (sans
--  camion créé) restent nulles ; le remplissage du lien est best-effort côté
--  Edge Function (une absence de colonne ne casse pas la sortie).
-- ============================================================================

alter table entrepot_sorties
  add column if not exists cargaison_id text;

comment on column entrepot_sorties.cargaison_id is
  'Cargaison (camion) créée pour emporter la marchandise apurée. Lien de concordance sortie MAD → parcours CFS→PP.';
