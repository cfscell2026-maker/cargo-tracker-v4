-- ============================================================================
--  00170 — Anti-doublon camion : filet en base + dédoublonnage (2026-09-12)
--
--  CONSTAT (production) : plusieurs camions ACTIFS portant le même numéro, créés
--  à la même seconde (ex. 732382 en 3 exemplaires). L'anti-doublon applicatif de
--  `createcamion` (SELECT `camionActif` puis INSERT) n'est PAS atomique : sur un
--  double/triple-clic, les requêtes concurrentes passent toutes le SELECT avant
--  qu'aucun INSERT ne soit validé, puis insèrent toutes → doublons parfaits.
--  L'index existant `cargaisons_camion_idx` est SIMPLE, pas UNIQUE : la base ne
--  refuse rien.
--
--  Cette migration :
--    1) DÉDOUBLONNE les camions actifs déjà en base (suppression LOGIQUE SEC-12,
--       réversible via `annule` — rien n'est effacé), en ne touchant QUE les
--       coquilles VIDES en double (aucun conteneur), jamais un doublon porteur
--       de données ;
--    2) pose un INDEX UNIQUE PARTIEL, miroir exact de `camionActif()`, qui rend
--       la course impossible à l'avenir : le 2ᵉ INSERT concurrent lève alors
--       `duplicate key` (déjà classé « motif technique » dans rpc/ctx.ts) au lieu
--       de créer le doublon.
--
--  Actif = numéro non vide, ni sorti (« Sortie Enregistrée »), ni annulé (SEC-12).
--  Ordre 1) puis 2) dans une même transaction : si un groupe garde >1 ligne
--  porteuse de conteneurs (conflit réel à trancher par un humain), l'index échoue
--  et TOUTE la migration est annulée — aucun état partiel, aucune perte.
-- ============================================================================

begin;

-- 1) Dédoublonnage des coquilles vides en double ------------------------------
--    Par numéro normalisé, on GARDE une ligne (la plus « chargée » puis la plus
--    ancienne) et on ANNULE les autres UNIQUEMENT si elles sont vides.
with actifs as (
  select
    id, nb_conteneurs,
    row_number() over (
      partition by numero_camion_norm
      order by nb_conteneurs desc, date_creation asc, id asc
    ) as rang
  from cargaisons
  where numero_camion_norm <> ''
    and statut <> 'Sortie Enregistrée'
    and not annule
),
a_annuler as (
  select id from actifs where rang > 1 and nb_conteneurs = 0
)
update cargaisons c
set annule       = true,
    annule_le    = now(),
    annule_par   = 'SYSTÈME (migration 00170)',
    annule_motif = 'Doublon technique de saisie (course à la création) — dédoublonné automatiquement'
from a_annuler d
where c.id = d.id;

-- 2) Filet DÉFINITIF : unicité du numéro parmi les camions actifs -------------
--    Prédicat identique à camionActif() : un camion sorti ou annulé ne bloque
--    plus la recréation, exactement comme aujourd'hui côté application.
create unique index if not exists cargaisons_camion_actif_uniq
  on cargaisons (numero_camion_norm)
  where numero_camion_norm <> ''
    and statut <> 'Sortie Enregistrée'
    and not annule;

comment on index cargaisons_camion_actif_uniq is
  'Anti-doublon dur : un seul camion ACTIF par numéro normalisé. Rattrape les courses de createcamion que le SELECT+INSERT applicatif ne peut garantir.';

commit;
