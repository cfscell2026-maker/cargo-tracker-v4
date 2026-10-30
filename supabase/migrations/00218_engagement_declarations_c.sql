-- ============================================================================
--  00218, DÉCLARATIONS « C » À L'ARRIVÉE D'UN ENGAGEMENT (2026-10-30,
--  demande utilisateur)
--
--  Un engagement s'apure sur la preuve de la mise à la consommation dans le
--  pays de destination : la déclaration du Burkina (DS 4 à Cinkansé, BFE03…)
--  porte une référence douane « C 14985 » et sa date. Ce sont ces C qu'on
--  renseigne désormais à l'arrivée, chacun avec la désignation et la quantité
--  de marchandise qu'il couvre (84 colis de tissus polyester imprimés, par
--  exemple).
--
--  PLUSIEURS C PAR ENGAGEMENT : un T1 parti du PIA peut être mis à la
--  consommation en plusieurs fois, d'où une table fille, comme les
--  marchandises (00213), et non une colonne.
--
--  DÉCISIONS UTILISATEUR :
--    · les C SONT l'arrivée : le total à l'arrivée est la somme de leurs
--      quantités, comparée au total déclaré au départ ;
--    · l'engagement est APURÉ (soldé) au premier C enregistré, et non plus au
--      départ. Les engagements déjà soldés le restent : on ne réécrit pas le
--      passé.
--
--  Dépend de 00213 (engagement_transmission).
--  ⚠ MIGRATION ADDITIVE : une table NEUVE, vide.
-- ============================================================================

create table if not exists engagement_declarations_c (
  id                text        primary key,
  transmission_id   text        not null references engagement_transmission (id) on delete cascade,
  -- Ordre de saisie, relu à l'identique.
  rang              integer     not null default 1,

  -- Référence douane du pays de destination, telle qu'imprimée : « C 14985 ».
  numero_c          text        not null default '',
  date_c            date        not null,
  designation       text        not null default '',
  quantite          numeric     not null default 0
);

comment on table engagement_declarations_c is
  'Déclarations de mise à la consommation (« C ») qui apurent un engagement : numéro, date, désignation et quantité. Plusieurs par engagement.';

create index if not exists idx_engagement_declarations_c_transmission
  on engagement_declarations_c (transmission_id, rang);
-- Retrouver un engagement par son C (« où est passé le C 14985 ? »).
create index if not exists idx_engagement_declarations_c_numero
  on engagement_declarations_c (numero_c);

-- Même politique que 00213 : fermée aux clients, seule l'Edge Function lit et écrit.
alter table engagement_declarations_c enable row level security;
revoke all on engagement_declarations_c from public, anon, authenticated;

notify pgrst, 'reload schema';
