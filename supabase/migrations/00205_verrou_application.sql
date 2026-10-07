-- ============================================================================
--  00205, VERROU DE L'APPLICATION (2026-10-07, demande utilisateur)
--
--  Un bouton, reserve au role INFO, qui bloque l'application pour TOUS les
--  autres comptes. Protege par un mot de passe que l'INFO definit lui-meme, et
--  accompagne d'un message que les agents bloques voient en plein ecran.
--
--  UNE SEULE LIGNE, et la contrainte le garantit : deux verrous concurrents
--  n'auraient aucun sens, et la question « lequel fait foi ? » n'a pas de bonne
--  reponse. La cle est figee a 'verrou'.
--
--  LE MOT DE PASSE N'EST JAMAIS STOCKE EN CLAIR : on garde un derive PBKDF2
--  (SHA-256, 210 000 tours) et son sel. Personne, pas meme quelqu'un qui lit la
--  table, ne peut le relire.
--
--  ⚠ MIGRATION ADDITIVE. Une table NEUVE, vide, et l'application se comporte
--  exactement comme avant tant que personne n'a defini de mot de passe.
--
--  ⚠ RECOURS SI LE MOT DE PASSE EST PERDU. DEUX COMMANDES, et la premiere ne
--  suffit PAS. Elles ne s'executent que depuis le tableau de bord Supabase,
--  auquel seul le proprietaire du projet a acces : c'est la que tient la
--  securite du dispositif, hors de l'application et derriere un autre compte.
--
--    1. Rouvrir l'application, si elle est bloquee :
--         update verrou_application set actif = false where cle = 'verrou';
--       Elle NE REND PAS le mot de passe. Or en changer exige l'ancien (voir
--       `verrouDefinir`) : le verrou resterait donc inutilisable pour toujours.
--
--    2. Repartir de zero, mot de passe compris :
--         delete from verrou_application;
--       Le panneau reproposera alors « Definir le mot de passe ».
-- ============================================================================

create table if not exists verrou_application (
  cle           text        primary key default 'verrou',
  -- L'application est-elle bloquee EN CE MOMENT ?
  actif         boolean     not null default false,
  -- Ce que les agents bloques lisent en plein ecran. Ecrit au moment du
  -- blocage : « Maintenance jusqu'a 14 h » vaut mieux qu'un refus muet.
  message       text        not null default '',

  -- PBKDF2-SHA256 : le derive et son sel, en base64. Jamais le mot de passe.
  mdp_hash      text        not null default '',
  mdp_sel       text        not null default '',
  mdp_tours     integer     not null default 0,
  mdp_defini_le timestamptz,

  bloque_le     timestamptz,
  bloque_par    text        not null default '',
  ouvert_le     timestamptz,
  ouvert_par    text        not null default '',
  maj_le        timestamptz not null default now(),

  -- Une seule ligne possible, quoi qu'il arrive.
  constraint verrou_unique check (cle = 'verrou')
);

comment on table verrou_application is
  'Verrou global de l''application (volet Parametres, role INFO). Une seule ligne, cle = ''verrou''. Le mot de passe n''y figure que sous forme de derive PBKDF2.';

-- Meme politique que les autres tables : fermee aux clients, seule l'Edge
-- Function (role service) lit et ecrit, apres controle du role.
alter table verrou_application enable row level security;
revoke all on verrou_application from public, anon, authenticated;
