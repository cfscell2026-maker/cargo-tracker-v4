-- ============================================================================
--  Nettoyage manuel des doublons de camion ACTIFS (course à la création)
--  À exécuter dans l'éditeur SQL Supabase (rôle service_role).
--
--  Même logique que la migration 00170 : si vous DÉPLOYEZ 00170, ce script est
--  inutile (00170 fait le nettoyage). Il sert à AGIR / INSPECTER tout de suite,
--  avant le déploiement. Idempotent : le relancer ne re-annule rien (les lignes
--  déjà annulées sont exclues).
--
--  Actif = numéro non vide, ni sorti (« Sortie Enregistrée »), ni annulé (SEC-12).
--  Règle : on GARDE une ligne par numéro (la plus « chargée » puis la plus
--  ancienne) et on ANNULE (SEC-12, logique/réversible) les coquilles VIDES en
--  double. Jamais un doublon porteur de conteneurs → rien n'est perdu.
-- ============================================================================

-- ÉTAPE 1 — DIAGNOSTIC (lecture seule). Lister tous les groupes de doublons
-- actifs. `a_annuler = true` = ce que l'ÉTAPE 2 annulera ; `a_garder = true` =
-- la ligne conservée.
with actifs as (
  select
    id, numero_camion, numero_camion_norm, statut, nb_conteneurs, date_creation,
    row_number() over (
      partition by numero_camion_norm
      order by nb_conteneurs desc, date_creation asc, id asc
    ) as rang,
    count(*) over (partition by numero_camion_norm) as nb_dans_groupe
  from cargaisons
  where numero_camion_norm <> ''
    and statut <> 'Sortie Enregistrée'
    and not annule
)
select
  numero_camion, id, statut, nb_conteneurs, date_creation, rang,
  (rang = 1)                        as a_garder,
  (rang > 1 and nb_conteneurs = 0)  as a_annuler,
  (rang > 1 and nb_conteneurs > 0)  as conflit_a_trancher_humain
from actifs
where nb_dans_groupe > 1
order by numero_camion_norm, rang;

-- ----------------------------------------------------------------------------
-- ÉTAPE 2 — NETTOYAGE (écriture). Décommentez pour appliquer APRÈS avoir vérifié
-- l'étape 1. Annule les coquilles vides en double ; ne touche jamais une ligne
-- porteuse de conteneurs (celles-ci resteront et devront être tranchées à la
-- main — l'index unique 00170 les signalera).
-- ----------------------------------------------------------------------------
-- with actifs as (
--   select
--     id, nb_conteneurs,
--     row_number() over (
--       partition by numero_camion_norm
--       order by nb_conteneurs desc, date_creation asc, id asc
--     ) as rang
--   from cargaisons
--   where numero_camion_norm <> ''
--     and statut <> 'Sortie Enregistrée'
--     and not annule
-- ),
-- a_annuler as (
--   select id from actifs where rang > 1 and nb_conteneurs = 0
-- )
-- update cargaisons c
-- set annule       = true,
--     annule_le    = now(),
--     annule_par   = 'SYSTÈME (nettoyage doublons)',
--     annule_motif = 'Doublon technique de saisie (course à la création) — dédoublonné manuellement'
-- from a_annuler d
-- where c.id = d.id
-- returning c.id, c.numero_camion, c.annule_motif;
