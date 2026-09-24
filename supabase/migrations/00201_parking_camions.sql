-- ============================================================================
--  00201 — PARKING (2026-09-24, demande utilisateur)
--
--  Les camions stationnés au parking sont pointés CHAQUE JOUR, comme les
--  conteneurs du parc le sont déjà (« pointage matinal », voir stock). Jusqu'ici
--  ce comptage se faisait hors de l'application.
--
--  ⚠ MIGRATION ADDITIVE. Deux tables NEUVES, vides : aucune donnée existante
--  n'est touchée, aucun parcours actuel ne change. Tant que personne n'ajoute
--  de camion au parking, l'application se comporte exactement comme avant.
--
--  DEUX TABLES, et non une seule colonne « date de pointage » :
--  un camion est pointé jour après jour, et c'est cette SUITE de pointages qui
--  dit depuis quand il occupe le parking. Une colonne unique n'en garderait que
--  le dernier et perdrait l'historique — précisément ce qu'on veut pouvoir
--  relire sur la fiche du camion.
-- ============================================================================

create table if not exists parking_camions (
  id                text        primary key,
  numero_camion     text        not null,
  -- Plaque réduite aux lettres et chiffres : c'est sur elle que portent la
  -- recherche au fil de la frappe et le rapprochement avec les cargaisons
  -- (« TG 2489 BK », « tg2489bk/2725bp » et « TG2489BK » sont le même camion).
  numero_camion_norm text       not null,
  numero_conteneur  text        not null default '',
  plomb             text        not null default '',
  -- « Présent » ou « Sorti ». Un camion sort du parking quand il est signalé à
  -- la Porte Principale (fermeture automatique, voir actions/parking.ts).
  statut            text        not null default 'Présent',
  date_entree       timestamptz not null default now(),
  cree_par          text        not null default '',
  date_sortie       timestamptz,
  sortie_par        text        not null default '',
  -- Dossier par lequel le camion est sorti, quand la sortie vient de la PP.
  sortie_cargaison  text        not null default '',
  derniere_maj      timestamptz not null default now()
);

comment on table parking_camions is
  'Camions stationnés au parking (volet Parking). Une ligne par séjour ; « Sorti » une fois le camion signalé à la Porte Principale.';

create index if not exists idx_parking_camions_norm   on parking_camions (numero_camion_norm);
create index if not exists idx_parking_camions_statut on parking_camions (statut, date_entree desc);

create table if not exists parking_pointages (
  id          text        primary key,
  parking_id  text        not null references parking_camions (id) on delete cascade,
  -- Le JOUR pointé, et non l'horodatage : c'est lui qui porte la règle « un
  -- seul pointage par camion et par jour ». L'unicité ci-dessous la fait tenir
  -- en base, même si deux agents pointent à la même seconde.
  jour        date        not null,
  pointe_le   timestamptz not null default now(),
  pointe_par  text        not null default ''
);

comment on table parking_pointages is
  'Pointages quotidiens des camions au parking : une ligne par camion et par jour.';

create unique index if not exists idx_parking_pointages_jour on parking_pointages (parking_id, jour);

-- Même politique que les autres tables : fermées aux clients, seule l'Edge
-- Function (rôle service) lit et écrit, après contrôle du rôle.
alter table parking_camions   enable row level security;
alter table parking_pointages enable row level security;
revoke all on parking_camions   from public, anon, authenticated;
revoke all on parking_pointages from public, anon, authenticated;
