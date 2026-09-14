-- ============================================================================
--  00180 — Suivi des engagements à la validation (2026-09-10)
--
--  Le chef de brigade renseigne désormais, AU MOMENT DE SA SIGNATURE, si la
--  cargaison fait l'objet d'un suivi d'engagement — et si oui, lequel :
--  « Transit national », « Transit côtier », « BFE 03 Sinkase », ou toute autre
--  mention qu'il saisit librement.
--
--  POURQUOI DU TEXTE LIBRE, ET NON UN TYPE ÉNUMÉRÉ
--  -----------------------------------------------
--  Les trois libellés sont des PROPOSITIONS (cf. ENGAGEMENTS dans
--  domaine/constantes.ts), pas une liste fermée : le besoin exprimé prévoit
--  explicitement que le chef puisse écrire autre chose. Un `enum` PostgreSQL
--  rejetterait ces saisies, et chaque ajout de régime imposerait une migration.
--  Le texte libre est ici le choix juste ; la liste déroulante côté écran suffit
--  à canaliser les trois cas courants et à éviter les variantes d'orthographe.
--
--  RENSEIGNEMENT OBLIGATOIRE — mais côté MÉTIER, pas côté schéma
--  -------------------------------------------------------------
--  La validation est bloquée tant que la réponse OUI/NON n'est pas donnée
--  (garde dans `cargo.valider`). Aucune contrainte NOT NULL ici : les 14 055
--  cargaisons déjà en base ont été validées AVANT l'existence de ce champ, et
--  rien ne permet de le reconstituer pour elles. Une contrainte les rendrait
--  invalides rétroactivement. `NULL` porte donc un sens précis et utile :
--  « validée avant la mise en place du suivi ».
--
--  ⚠ MIGRATION ADDITIVE. Aucune donnée existante n'est modifiée ni supprimée.
-- ============================================================================

alter table cargaisons
  add column if not exists suivi_engagement      boolean,
  add column if not exists engagement_type       text not null default '',
  -- ÉCHÉANCE. Une `date` et non un `timestamptz` : l'engagement se tient à la
  -- journée (« les pièces pour le 12 »), pas à l'heure près. Un horodatage
  -- inviterait à des comparaisons de fuseau sans objet métier.
  add column if not exists engagement_delai      date,
  -- SOLDE. `engagement_effectue_le` NULL = engagement encore dû. On ne stocke
  -- pas de booléen « effectué » : la date porte à la fois le fait ET le moment,
  -- et deux champs qui se contredisent ne peuvent pas exister.
  add column if not exists engagement_effectue_le  timestamptz,
  add column if not exists engagement_effectue_par text not null default '';

comment on column cargaisons.suivi_engagement is
  'Suivi des engagements — réponse du chef de brigade à la validation. '
  'NULL = cargaison validée avant la mise en place du champ (2026-09-10).';

comment on column cargaisons.engagement_type is
  'Régime d''engagement retenu quand suivi_engagement est vrai : une valeur de '
  'ENGAGEMENTS (Transit national, Transit côtier, BFE 03 Sinkase) ou une saisie '
  'libre du chef de brigade. Vide quand il n''y a pas de suivi.';

comment on column cargaisons.engagement_delai is
  'Échéance à laquelle les informations doivent être transmises. Obligatoire '
  'quand suivi_engagement est vrai.';

comment on column cargaisons.engagement_effectue_le is
  'Horodatage du solde de l''engagement (bouton « Effectué »). NULL = encore dû.';

-- ---------------------------------------------------------------------------
-- Index de l'ÉCHÉANCIER.
--
-- Le tableau de bord interroge en permanence « quels engagements restent dus,
-- et lesquels arrivent à échéance ? ». Cet index partiel ne couvre QUE ces
-- lignes-là : un engagement soldé en sort automatiquement, et les cargaisons
-- sans suivi n'y entrent jamais. Sur 14 055 lignes dont une poignée sous
-- engagement, c'est la différence entre une lecture instantanée et un parcours
-- complet de la table à chaque affichage.
-- ---------------------------------------------------------------------------
create index if not exists cargaisons_engagement_du_idx
  on cargaisons (engagement_delai)
  where suivi_engagement is true and engagement_effectue_le is null;

-- Pour les rapports par régime (« combien de transits côtiers ce mois-ci ? »).
create index if not exists cargaisons_engagement_idx
  on cargaisons (engagement_type)
  where suivi_engagement is true;

-- ---------------------------------------------------------------------------
-- `v_cargaisons_resume` n'est VOLONTAIREMENT pas modifiée.
--
-- Le suivi des engagements se saisit et se lit sur la FICHE, qui passe par
-- `cargo.get` — lequel fait un `select *` sur la table et voit donc les deux
-- nouvelles colonnes sans rien changer. La vue de résumé alimente les listes et
-- la recherche, où l'engagement n'a pas sa place aujourd'hui.
--
-- Le jour où un rapport devra filtrer sur l'engagement, ce sera une décision à
-- part : redéfinir la vue impose d'en recopier l'intégralité (create or replace
-- view refuse de retirer ou de réordonner des colonnes), et l'index partiel
-- ci-dessus est là pour ça.
-- ---------------------------------------------------------------------------
