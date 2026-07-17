-- ---------------------------------------------------------------------------
-- v4 — DÉCLARATION SUR LE STOCK INITIAL (import)
--
-- L'import du stock initial adopte le MÊME FORMAT que l'annonce de transfert,
-- SANS le bureau de déclaration (décision utilisateur 2026-07-17) :
--   numeroTC, taille, dateEntree, anneeDeclaration, typeDeclaration, numeroDeclaration
--
-- La table `stock` ne portait aucune information de déclaration (contrairement à
-- `stock_annonce`). On ajoute donc les trois colonnes correspondantes. Le
-- « bureau » est volontairement ABSENT ici. Le numéro de déclaration est
-- normalisé côté application (chiffres uniquement) avant insertion.
--
-- Colonnes NOT NULL DEFAULT '' (comme sur stock_annonce) : les lignes de stock
-- déjà migrées restent valides (chaîne vide = pas de déclaration renseignée).
-- ---------------------------------------------------------------------------

alter table stock
  add column if not exists annee_declaration  text not null default '',
  add column if not exists type_declaration   text not null default '',
  add column if not exists numero_declaration text not null default '';

comment on column stock.numero_declaration is
  'N° de déclaration importé avec le stock initial (chiffres uniquement). Bureau volontairement absent (cf. annonce de transfert).';
