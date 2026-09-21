-- ============================================================================
--  00200 — Paramètres de l'application (2026-09-21, demande utilisateur)
--
--  Les seuils de l'application (séjour des conteneurs, hauteur hors gabarit,
--  délais des engagements…) étaient écrits dans le code. Cette table les rend
--  réglables par l'administrateur depuis le volet « Paramètres ».
--
--  ⚠ MIGRATION ADDITIVE. Une table neuve, vide : aucune donnée existante n'est
--  touchée. Tant qu'un réglage n'a pas de ligne ici, l'application applique sa
--  valeur par défaut — la même qu'avant cette migration. Créer la table ne
--  change donc RIEN au fonctionnement ; seules les modifications faites ensuite
--  depuis le volet en changent.
--
--  Une ligne par réglage MODIFIÉ. `valeur` est du JSON : un nombre, ou une liste
--  (les engagements proposés). Le serveur valide chaque valeur avant d'écrire,
--  et ignore à la lecture toute valeur qu'il ne sait pas relire.
-- ============================================================================

create table if not exists parametres_app (
  cle     text        primary key,
  valeur  jsonb       not null,
  maj_le  timestamptz not null default now(),
  maj_par text        not null default ''
);

comment on table parametres_app is
  'Réglages de l''application modifiés par l''administrateur (volet Paramètres). Réglage absent = valeur par défaut.';

-- Même politique que les autres tables : fermée aux clients, seule l'Edge
-- Function (rôle service) lit et écrit, après contrôle du rôle ADMIN.
alter table parametres_app enable row level security;
revoke all on parametres_app from public, anon, authenticated;
