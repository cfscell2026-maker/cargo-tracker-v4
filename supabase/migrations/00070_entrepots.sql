-- ============================================================================
--  CARGO TRACKER v4.1 — MAD & Entrepôt industriel (décision utilisateur
--  2026-07-27). Deux entrepôts nommés (nom + code) au fonctionnement identique ;
--  seule l'UNITÉ D'APUREMENT diffère : MAD = quantités (nombre de colis),
--  INDUSTRIEL = poids (kg). Un entrepôt reçoit des ENTRÉES (déclaration + jusqu'à
--  11 articles + conteneurs éventuels) et des SORTIES en vrac (apurement d'un
--  article d'une entrée). Le restant théorique = entrées − sorties, par
--  déclaration et par entrepôt.
--  RLS : refus par défaut ; seule l'Edge Function (service_role) lit/écrit.
-- ============================================================================

create table entrepots (
  code          text primary key,                 -- code unique (ex. 'MAD-01')
  nom           text not null,
  type          text not null default 'MAD',       -- 'MAD' | 'INDUSTRIEL'
  actif         boolean not null default true,
  date_creation timestamptz not null default now(),
  cree_par      text not null default ''
);

-- Entrées (sommier d'origine) : une déclaration, ses articles, ses conteneurs.
create table entrepot_entrees (
  id                 text primary key,             -- 'ENT-2026-000001'
  entrepot_code      text not null references entrepots(code),
  numero_declaration text not null default '',
  annee_declaration  text not null default '',
  bureau_declaration text not null default '',
  type_declaration   text not null default '',
  declarant          text not null default '',
  conteneurise       boolean not null default false,
  conteneurs         jsonb not null default '[]',  -- ["MSKU1234567", …]
  -- articles : [{ designation, nbColis, poids }] — 1 à 11 par déclaration.
  articles           jsonb not null default '[]',
  date_entree        timestamptz not null default now(),
  agent              text not null default '',
  observations       text not null default ''
);
create index entrepot_entrees_code_idx on entrepot_entrees (entrepot_code);
create index entrepot_entrees_decl_idx on entrepot_entrees (numero_declaration, annee_declaration, bureau_declaration, type_declaration);

-- Sorties (apurement en vrac) : on apure un ARTICLE d'une entrée ; la
-- déclaration d'apurement peut différer de celle d'origine.
create table entrepot_sorties (
  id                 text primary key,             -- 'SOR-2026-000001'
  entrepot_code      text not null references entrepots(code),
  entree_id          text not null references entrepot_entrees(id),
  numero_article     integer not null default 1,   -- 1..11
  numero_declaration text not null default '',      -- déclaration d'apurement
  annee_declaration  text not null default '',
  bureau_declaration text not null default '',
  type_declaration   text not null default '',
  designation        text not null default '',
  nb_colis           integer not null default 0,    -- quantité apurée (MAD)
  poids              numeric not null default 0,     -- poids apuré kg (INDUSTRIEL)
  vehicules          jsonb not null default '[]',
  date_sortie        timestamptz not null default now(),
  agent              text not null default '',
  observations       text not null default ''
);
create index entrepot_sorties_code_idx  on entrepot_sorties (entrepot_code);
create index entrepot_sorties_entree_idx on entrepot_sorties (entree_id);

alter table entrepots         enable row level security;
alter table entrepot_entrees  enable row level security;
alter table entrepot_sorties  enable row level security;
revoke all on entrepots, entrepot_entrees, entrepot_sorties from anon, authenticated;
