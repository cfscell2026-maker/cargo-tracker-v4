-- ============================================================================
--  00204 — RAPPROCHEMENT DES LISTES ACP (2026-10-06, demande utilisateur)
--
--  L'ACP envoie régulièrement la liste des conteneurs qu'elle nous attribue.
--  La comparaison avec le parc se faisait à l'œil. Elle devient un geste de
--  l'application, et chaque contrôle est CONSERVÉ (décision utilisateur) :
--  savoir qu'un écart avait déjà été signalé en septembre vaut mieux que de le
--  redécouvrir en octobre.
--
--  ⚠ MIGRATION ADDITIVE. Une table NEUVE, vide. Aucune donnée existante n'est
--  touchée, aucun parcours actuel ne change, et tant que personne ne dépose de
--  fichier l'application se comporte exactement comme avant.
--
--  LE DÉTAIL EST STOCKÉ EN JSONB, et non en lignes filles. Un rapprochement est
--  une PHOTO : ce qu'on veut relire, c'est l'écart tel qu'il a été constaté ce
--  jour-là, figé. Des lignes filles inviteraient à les joindre au stock actuel
--  et à faire dire au contrôle de septembre ce qu'on sait en octobre.
-- ============================================================================

create table if not exists rapprochement_acp (
  id              text        primary key,
  fait_le         timestamptz not null default now(),
  fait_par        text        not null default '',
  -- Nom du fichier reçu, tel que déposé : c'est lui qui permet de dire « la
  -- liste du 3 octobre » sans avoir à rouvrir le détail.
  nom_fichier     text        not null default '',

  -- Ce qu'on a lu dans le fichier
  nb_lus          integer     not null default 0,   -- numéros valides, dédoublonnés
  nb_illisibles   integer     not null default 0,   -- cellules qui avaient l'air d'un numéro
  nb_doublons     integer     not null default 0,   -- numéros répétés dans le fichier

  -- Les quatre cases du rapprochement
  nb_concordants      integer not null default 0,
  nb_au_parc_hors_liste integer not null default 0,
  nb_deja_depotes     integer not null default 0,
  nb_inconnus         integer not null default 0,
  -- Présents au parc mais hors du périmètre demandé. Cette colonne n'existe que
  -- parce qu'on peut restreindre la comparaison : sans elle, comparer sur
  -- « En stock » ferait déclarer « inconnu » un conteneur simplement
  -- « Positionné », et l'on réclamerait à l'ACP un conteneur qu'on a sous les yeux.
  nb_hors_perimetre   integer not null default 0,

  -- Sur quoi a porté la comparaison : « parc » (défaut), « stock »,
  -- « positionne » ou « alerte », et les bornes de date d'entrée s'il y en a.
  -- Sans cela, les écarts d'un ancien rapprochement ne se rapportent à rien.
  perimetre           text    not null default 'parc',
  du                  date,
  au                  date,
  -- Taille du parc au moment du contrôle : sans elle, les écarts d'un ancien
  -- rapprochement ne se rapportent à rien.
  nb_parc             integer not null default 0,

  -- { auParcHorsListe: [...], listeDejaDepotes: [...], listeInconnus: [...],
  --   illisibles: [...] } — les CONCORDANTS n'y sont pas : ils ne posent aucune
  --   question, et ils pèsent à eux seuls plus que les trois autres réunis.
  detail          jsonb       not null default '{}'::jsonb
);

comment on table rapprochement_acp is
  'Rapprochements entre une liste reçue de l''ACP et le parc. Une ligne par contrôle ; le détail des écarts est figé dans « detail ».';

create index if not exists idx_rapprochement_acp_date on rapprochement_acp (fait_le desc);

-- Même politique que les autres tables : fermée aux clients, seule l'Edge
-- Function (rôle service) lit et écrit, après contrôle du rôle.
alter table rapprochement_acp enable row level security;
revoke all on rapprochement_acp from public, anon, authenticated;
