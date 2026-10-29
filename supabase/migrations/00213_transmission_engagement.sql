-- ============================================================================
--  00213, TRANSMISSION D'UN ENGAGEMENT (2026-10-28, demande utilisateur)
--
--  Jusqu'ici, solder un engagement tenait en un clic sur « Effectué » : on
--  savait QUE les informations avaient ete transmises, jamais LESQUELLES. Un
--  engagement solde sans trace de son contenu ne prouve rien lors d'un controle.
--
--  La transmission porte desormais ce qu'on a reellement declare :
--    · l'en-tete, PAYS DE DESTINATION et NUMERO IM4 de ce pays ;
--    · les MARCHANDISES, une ou plusieurs, chacune avec sa quantite declaree
--      AU DEPART puis, plus tard, sa quantite constatee A L'ARRIVEE.
--
--  L'ARRIVEE SE SAISIT PLUS TARD (decision utilisateur). Le pays de destination
--  repond parfois des semaines apres : les quantites d'arrivee restent donc
--  NULLES jusque-la, et l'ecart ne se calcule que sur les lignes renseignees.
--  C'est pourquoi `quantite_arrivee` est nullable alors que `quantite_depart`
--  ne l'est pas : zero a l'arrivee est une information (rien n'est arrive),
--  l'absence de valeur n'en est pas une (on ne sait pas encore).
--
--  LES MARCHANDISES SONT UNE TABLE FILLE, pas un jsonb. On veut pouvoir
--  demander « quel est l'ecart total par pays de destination ce trimestre »,
--  et cette question se pose mal a travers un tableau JSON.
--
--  ⚠ MIGRATION ADDITIVE. Deux tables NEUVES, vides. Les engagements deja
--  soldes le restent, simplement sans detail : on ne reecrit pas le passe.
-- ============================================================================

create table if not exists engagement_transmission (
  id                text        primary key,
  cargaison_id      text        not null references cargaisons (id) on delete cascade,

  pays_destination  text        not null default '',
  -- Numero IM4 delivre par le pays de destination.
  numero_im4        text        not null default '',

  -- Quand le depart a ete declare, et par qui.
  transmis_le       timestamptz not null default now(),
  transmis_par      text        not null default '',
  -- Quand l'arrivee a ete renseignee. NULL tant qu'on attend la reponse.
  arrivee_le        timestamptz,
  arrivee_par       text        not null default '',

  maj_le            timestamptz not null default now(),

  -- UNE SEULE transmission par cargaison : la fiche se ROUVRE et se complete,
  -- elle ne se duplique pas. Sans cette contrainte, deux saisies concurrentes
  -- laisseraient deux verites pour un meme engagement.
  constraint engagement_transmission_cargaison_unique unique (cargaison_id)
);

comment on table engagement_transmission is
  'Ce qui a ete transmis pour un engagement : pays de destination, numero IM4, et la date de chaque volet (depart, arrivee). Une ligne par cargaison.';

create index if not exists idx_engagement_transmission_pays
  on engagement_transmission (pays_destination, transmis_le desc);

create table if not exists engagement_marchandises (
  id                text        primary key,
  transmission_id   text        not null references engagement_transmission (id) on delete cascade,
  -- Rang d'affichage : l'ordre de saisie est celui du document d'origine, et il
  -- doit se relire a l'identique.
  rang              integer     not null default 1,

  designation       text        not null default '',
  quantite_depart   numeric     not null default 0,
  -- NULL = arrivee pas encore connue. 0 = rien n'est arrive. Les deux sont
  -- des reponses differentes, et les confondre fausserait tous les ecarts.
  quantite_arrivee  numeric
);

comment on table engagement_marchandises is
  'Marchandises d''une transmission d''engagement. « quantite_arrivee » NULL signifie « arrivee pas encore connue », a ne pas confondre avec 0.';

create index if not exists idx_engagement_marchandises_transmission
  on engagement_marchandises (transmission_id, rang);

-- Meme politique que les autres tables : fermees aux clients, seule l'Edge
-- Function (role service) lit et ecrit, apres controle du role.
alter table engagement_transmission enable row level security;
alter table engagement_marchandises enable row level security;
revoke all on engagement_transmission from public, anon, authenticated;
revoke all on engagement_marchandises from public, anon, authenticated;
