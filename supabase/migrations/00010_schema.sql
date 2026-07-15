-- ============================================================================
--  CARGO TRACKER v4 — Schéma PostgreSQL (migration initiale)
--  Transposition FIDÈLE des 8 feuilles Google Sheets (v3.6).
--  Sécurité : RLS activé PARTOUT, AUCUNE policy pour anon/authenticated
--  => refus par défaut. Seule l'Edge Function (service_role) lit/écrit.
-- ============================================================================

create extension if not exists pgcrypto;   -- digest() pour la chaîne d'audit

-- ---------------------------------------------------------------------------
-- Types énumérés (libellés français conservés à l'identique — compat données)
-- ---------------------------------------------------------------------------
create type role_utilisateur as enum
  ('CFS','CHEF_BRIGADE','CHEF_BRIGADE_ADJOINT','CHEF_VISITE','CHEF_DIVISION',
   'T1','BALISE','BON_SORTIE','PP','ADMIN');

create type statut_cargaison as enum
  ('Camion créé','En cours de chargement','Véhicule ouillage créé','Créée',
   'T1 saisi','GPS Installé','Bon de sortie émis','Sortie Enregistrée');

create type type_operation as enum
  ('Dépotage','Enlèvement','Dépotage / Véhicule','Conso (type C)','Sortie Magasin / MAD');

create type etat_sortie_cfs as enum ('En cours de chargement','Fin de chargement','Vide');
create type statut_stock    as enum ('En stock','Positionné','Dépoté');
create type statut_annonce  as enum ('Annoncé','Pointé','Confirmé');

-- ---------------------------------------------------------------------------
-- Utilisateurs : métadonnées métier (l'authentification vit dans auth.users)
-- ---------------------------------------------------------------------------
create table profils (
  id                 uuid primary key references auth.users(id) on delete cascade,
  username           text not null unique,
  nom_complet        text not null,
  role               role_utilisateur not null,
  actif              boolean not null default true,
  date_creation      timestamptz not null default now(),
  derniere_connexion timestamptz
);

-- ---------------------------------------------------------------------------
-- Cargaisons (feuille « Cargaisons » — toutes les colonnes de COLS v3.6)
-- ---------------------------------------------------------------------------
create table cargaisons (
  id                        text primary key,                -- 'CT-2026-000123'
  reference                 text not null,
  date_creation             timestamptz not null default now(),
  numero_camion             text not null,
  numero_camion_norm        text generated always as
                              (upper(regexp_replace(numero_camion,'[^A-Za-z0-9]','','g'))) stored,
  type_operation            type_operation,
  twins                     boolean not null default false,
  -- Déclaration de référence (1ʳᵉ déclaration du camion)
  declarant                 text not null default '',
  contact_declarant         text not null default '',
  destination_marchandise   text not null default '',
  bureau_declaration        text not null default '',
  type_declaration          text not null default '',
  numero_declaration        text not null default '',
  annee_declaration         text not null default '',
  description_marchandise   text not null default '',
  observations_cfs          text not null default '',
  agent_cfs                 text not null default '',
  agent_cfs_id              uuid references profils(id),
  statut                    statut_cargaison not null,
  -- Cellule Balise
  numero_gps                text not null default '',
  date_pose_gps             timestamptz,
  agent_balise              text not null default '',
  agent_balise_id           uuid references profils(id),
  observations_balise       text not null default '',
  balise_requise            boolean,                         -- null = non renseigné (comme '')
  t1_correct                boolean,
  numero_dispense           text not null default '',
  -- Sortie PP
  infos_validees            boolean,
  date_sortie               timestamptz,
  agent_pp                  text not null default '',
  agent_pp_id               uuid references profils(id),
  observations_pp           text not null default '',
  pp_checklist              jsonb,                           -- {cfs,t1,balise,bs}
  derniere_maj              timestamptz not null default now(),
  -- Rapport / conteneurs
  rapport_id                text not null,
  conteneurs_details        jsonb not null default '{"conteneurs":[],"scellesCamion":[]}',
  nb_conteneurs             integer not null default 0,
  chargement_mixte          boolean not null default false,
  mixte_details             jsonb,                           -- historique des compléments
  -- Véhicule
  est_vehicule              boolean not null default false,
  vehicule_details          jsonb,                           -- {chassis,marque,modele,couleur,destination,extra[]}
  conteneur_origine         text not null default '',
  -- Cellule T1
  bureau_destination        text not null default '',
  t1_numeros                jsonb,                           -- [{conteneur,numero}] ou [{'',numero}]
  date_t1                   timestamptz,
  agent_t1                  text not null default '',
  agent_t1_id               uuid references profils(id),
  observations_t1           text not null default '',
  -- Cellule Bon de sortie
  bon_sortie_numero         jsonb,                           -- chaîne JSON ("N°") ou liste [{conteneur,t1,numero}]
  date_bon_sortie           timestamptz,
  agent_bon_sortie          text not null default '',
  agent_bon_sortie_id       uuid references profils(id),
  observations_bon_sortie   text not null default '',
  -- Sauts de cellule + dispense
  saute_t1                  boolean not null default false,
  saute_balise              boolean not null default false,
  saute_bs                  boolean not null default false,
  arrivee_bureau            boolean not null default false,
  date_arrivee_bureau       timestamptz,
  agent_arrivee_bureau      text not null default '',
  -- Entrée + état de sortie CFS (traçabilité site)
  routage_entree            text not null default '',
  agent_entree              text not null default '',
  agent_entree_id           uuid references profils(id),
  etat_sortie               etat_sortie_cfs,
  -- Validation chef brigade + colis + hors gabarit (CONFIDENTIEL)
  nb_colis                  text not null default '',
  hors_gabarit              boolean,                         -- CONFIDENTIEL (CFS + chefs + ADMIN)
  hauteur_chargement        text not null default '',        -- CONFIDENTIEL
  date_validation           timestamptz,
  agent_validation          text not null default '',
  agent_validation_id       uuid references profils(id),
  signature_validation      text not null default '',
  -- Ouillage (v3.6)
  ouillage_numero           text not null default '',
  ouillage_date             timestamptz
);

create index cargaisons_statut_idx      on cargaisons (statut);
create index cargaisons_camion_idx      on cargaisons (numero_camion_norm);
create index cargaisons_date_idx        on cargaisons (date_creation desc);
create index cargaisons_rapport_idx     on cargaisons (rapport_id);
create index cargaisons_vehicule_idx    on cargaisons (est_vehicule);

-- ---------------------------------------------------------------------------
-- Conteneurs (feuille « Conteneurs » : 1 ligne PAR conteneur, pour l'export)
-- ---------------------------------------------------------------------------
create table conteneurs (
  id                 bigint generated always as identity primary key,
  rapport_id         text not null,
  cargaison_id       text not null references cargaisons(id) on delete cascade,
  numero_camion      text not null,
  type_operation     text not null,
  ordre              integer not null,
  conteneur          text not null,
  scelle             text not null default '',
  taille             text not null default '',
  type_conteneur     text not null default '',
  poids              text not null default '',
  champs_libres      text not null default '',               -- 'NOM=VALEUR ; …' (format d'export conservé)
  -- LOT D / v3.2 : déclaration PAR conteneur
  numero_declaration text not null default '',
  annee_declaration  text not null default '',
  bureau_declaration text not null default '',
  type_declaration   text not null default '',
  date_creation      timestamptz not null default now(),
  constraint conteneur_iso6346 check (conteneur ~ '^[A-Z]{4}[0-9]{7}$')
);
create index conteneurs_cargaison_idx on conteneurs (cargaison_id);
create index conteneurs_numero_idx    on conteneurs (conteneur);

-- ---------------------------------------------------------------------------
-- Déclarations + apurement (clé unique année|bureau|type|numéro)
-- ---------------------------------------------------------------------------
create table declarations (
  cle                text primary key,
  annee_declaration  text not null default '',
  bureau_declaration text not null default '',
  type_declaration   text not null default '',
  numero_declaration text not null default '',
  declarant          text not null default '',
  nombre_conteneurs  integer not null,
  conteneurs_apures  integer not null default 0,
  date_creation      timestamptz not null default now(),
  derniere_maj       timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Stock physique du port sec
-- ---------------------------------------------------------------------------
create table stock (
  numero_tc          text primary key,
  taille             text not null default '',
  type_conteneur     text not null default '',
  provenance         text not null default '',
  date_entree        timestamptz,
  statut             statut_stock not null default 'En stock',
  date_positionne    timestamptz,
  date_pointage      timestamptz,
  pointe_par         text not null default '',
  date_depote        timestamptz,
  cargaison_id       text references cargaisons(id),
  observations       text not null default '',
  nb_sejours_import  integer not null default 0,
  constraint stock_iso6346 check (numero_tc ~ '^[A-Z]{4}[0-9]{7}$')
);
create index stock_statut_idx on stock (statut);

-- ---------------------------------------------------------------------------
-- Stock ANNONCÉ (annonce de transfert Port Autonome → Port Sec)
-- ---------------------------------------------------------------------------
create table stock_annonce (
  numero_tc          text primary key,
  taille             text not null default '',
  date_entree        timestamptz,
  annee_declaration  text not null default '',
  bureau_declaration text not null default '',
  type_declaration   text not null default '',
  numero_declaration text not null default '',
  statut             statut_annonce not null default 'Annoncé',
  date_annonce       timestamptz not null default now(),
  date_pointage      timestamptz,
  pointe_par         text not null default '',
  date_confirmation  timestamptz,
  confirme_par       text not null default '',
  observations       text not null default '',
  constraint annonce_iso6346 check (numero_tc ~ '^[A-Z]{4}[0-9]{7}$')
);
create index stock_annonce_statut_idx on stock_annonce (statut);

-- ---------------------------------------------------------------------------
-- Journal d'audit : append-only + chaîne de hachage (inviolable)
-- ---------------------------------------------------------------------------
create table audit_log (
  id            bigint generated always as identity primary key,
  ts            timestamptz not null default now(),
  user_id       uuid,
  username      text not null default '',
  nom_complet   text not null default '',
  role          text not null default '',
  action        text not null,
  cargaison_id  text not null default '',
  details       text not null default '',
  prev_hash     text not null,
  hash          text not null
);

create or replace function fn_audit_chain() returns trigger
language plpgsql security definer as $$
declare
  v_prev text;
begin
  -- Sérialise les insertions concurrentes pour garantir une chaîne linéaire.
  perform pg_advisory_xact_lock(hashtext('audit_log_chain'));
  select hash into v_prev from audit_log order by id desc limit 1;
  new.prev_hash := coalesce(v_prev, 'GENESIS');
  new.hash := encode(digest(
    new.prev_hash || '|' || new.ts::text || '|' || coalesce(new.user_id::text,'') || '|' ||
    new.username || '|' || new.role || '|' || new.action || '|' ||
    new.cargaison_id || '|' || new.details, 'sha256'), 'hex');
  return new;
end $$;

create trigger audit_chain before insert on audit_log
  for each row execute function fn_audit_chain();

-- Append-only : personne ne modifie ni ne supprime (même via API).
revoke update, delete, truncate on audit_log from public;
create or replace function fn_audit_bloquer() returns trigger
language plpgsql as $$
begin
  raise exception 'Le journal d''audit est en ajout seul (append-only).';
end $$;
create trigger audit_no_update before update or delete on audit_log
  for each row execute function fn_audit_bloquer();

-- Vérification d'intégrité de la chaîne : renvoie l'id de la 1ʳᵉ rupture, sinon null.
create or replace function fn_audit_verifier() returns bigint
language plpgsql security definer as $$
declare
  r record;
  v_prev text := 'GENESIS';
begin
  for r in select * from audit_log order by id loop
    if r.prev_hash <> v_prev then return r.id; end if;
    if r.hash <> encode(digest(
        r.prev_hash || '|' || r.ts::text || '|' || coalesce(r.user_id::text,'') || '|' ||
        r.username || '|' || r.role || '|' || r.action || '|' ||
        r.cargaison_id || '|' || r.details, 'sha256'), 'hex')
    then return r.id; end if;
    v_prev := r.hash;
  end loop;
  return null;
end $$;

-- ---------------------------------------------------------------------------
-- Compteurs séquentiels (SEQ / SEQ_RPT) — comportement identique v3.6 :
-- compteur GLOBAL monotone, l'année (dans le libellé) ne le réinitialise pas.
-- ---------------------------------------------------------------------------
create table compteurs (cle text primary key, valeur bigint not null default 0);
insert into compteurs (cle, valeur) values ('SEQ', 0), ('SEQ_RPT', 0);

create or replace function fn_next_ref(p_cle text, p_prefix text) returns text
language plpgsql security definer as $$
declare
  v bigint;
begin
  update compteurs set valeur = valeur + 1 where cle = p_cle returning valeur into v;
  if not found then
    insert into compteurs (cle, valeur) values (p_cle, 1) returning valeur into v;
  end if;
  return p_prefix || '-' || extract(year from now())::int || '-' || lpad(v::text, 6, '0');
end $$;

-- ---------------------------------------------------------------------------
-- Vue résumé (équivalent RESUME_KEYS + aperçu conteneur1..4/plomb1..4)
-- Les colonnes d'aperçu sont DÉRIVÉES de conteneurs_details :
--   dépotage  : plomb1..3 = scellés du CAMION, plomb4 vide ;
--   enlèvement: plombN = scellé du conteneur N. (Comportement v3.6.)
-- NB : hors_gabarit / hauteur_chargement N'APPARAISSENT PAS ici (confidentiel).
-- ---------------------------------------------------------------------------
create view v_cargaisons_resume as
select
  c.id, c.reference, c.date_creation, c.numero_camion, c.numero_camion_norm,
  c.type_operation, c.statut, c.numero_gps, c.date_sortie, c.agent_cfs, c.rapport_id,
  c.est_vehicule, c.conteneur_origine, c.saute_t1, c.saute_balise, c.saute_bs,
  c.balise_requise, c.arrivee_bureau, c.date_t1, c.date_pose_gps, c.bon_sortie_numero,
  c.date_validation, c.etat_sortie, c.nb_conteneurs, c.twins,
  c.conteneurs_details -> 'conteneurs' -> 0 ->> 'num' as conteneur1,
  c.conteneurs_details -> 'conteneurs' -> 1 ->> 'num' as conteneur2,
  c.conteneurs_details -> 'conteneurs' -> 2 ->> 'num' as conteneur3,
  c.conteneurs_details -> 'conteneurs' -> 3 ->> 'num' as conteneur4,
  case when c.type_operation = 'Dépotage'
       then c.conteneurs_details -> 'scellesCamion' ->> 0
       else c.conteneurs_details -> 'conteneurs' -> 0 ->> 'plomb' end as plomb1,
  case when c.type_operation = 'Dépotage'
       then c.conteneurs_details -> 'scellesCamion' ->> 1
       else c.conteneurs_details -> 'conteneurs' -> 1 ->> 'plomb' end as plomb2,
  case when c.type_operation = 'Dépotage'
       then c.conteneurs_details -> 'scellesCamion' ->> 2
       else c.conteneurs_details -> 'conteneurs' -> 2 ->> 'plomb' end as plomb3,
  case when c.type_operation = 'Dépotage'
       then null
       else c.conteneurs_details -> 'conteneurs' -> 3 ->> 'plomb' end as plomb4
from cargaisons c;

-- ---------------------------------------------------------------------------
-- RLS : refus par défaut PARTOUT. Aucune policy pour anon/authenticated —
-- toutes les lectures/écritures passent par l'Edge Function (service_role).
-- ---------------------------------------------------------------------------
alter table profils        enable row level security;
alter table cargaisons     enable row level security;
alter table conteneurs     enable row level security;
alter table declarations   enable row level security;
alter table stock          enable row level security;
alter table stock_annonce  enable row level security;
alter table audit_log      enable row level security;
alter table compteurs      enable row level security;

revoke all on all tables in schema public from anon, authenticated;
revoke all on all functions in schema public from anon, authenticated;
