-- ============================================================================
--  CARGO TRACKER v4.2 — DIAGNOSTIC D'INTÉGRITÉ DES DONNÉES
--
--  Prépare la migration 00170 (contraintes DAT-02, DAT-05, DAT-08).
--
--  ⚠ LECTURE SEULE. Ce fichier ne contient QUE des SELECT : aucun INSERT,
--    UPDATE, DELETE, CREATE ni ALTER. Il ne modifie rien, ne verrouille rien,
--    et peut être exécuté en production aux heures ouvrées sans risque.
--
--  POURQUOI CE SCRIPT AVANT LA MIGRATION
--  -------------------------------------
--  Les contraintes envisagées (unicité de balise, unicité conteneur, plafond
--  d'apurement) portent sur des données DÉJÀ EN BASE. L'audit du 2026-08-10 a
--  relevé au moins 11 balises posées sur deux camions à la fois : poser la
--  contrainte sans arbitrer ces cas ferait ÉCHOUER la migration en production.
--  On compte d'abord, on décide ensuite.
--
--  UTILISATION
--  -----------
--  Supabase → SQL Editor → coller la PARTIE 1, exécuter, renvoyer le tableau.
--  Les requêtes de la PARTIE 2 listent le détail de chaque anomalie trouvée :
--  ne les lancer que pour les lignes de la synthèse dont le compte est > 0.
--
--  CONVENTION : « vivant » = ni annulé (SEC-12) ni archivé (2026-08-19). Ces
--  deux catégories restent en base pour l'audit mais sont exclues de tous les
--  rapports ; une contrainte peut donc légitimement les ignorer (index partiel).
-- ============================================================================


-- ############################################################################
-- #  PARTIE 1 — SYNTHÈSE : une seule requête, un seul tableau à me renvoyer  #
-- ############################################################################

with
-- --------------------------------------------------------------------------
-- Normalisation de `conteneurs_details` : la colonne porte DEUX formes
-- historiques (tableau simple, ou objet {conteneurs, scellesCamion}) et peut
-- aussi contenir une CHAÎNE JSON non désérialisée sur les données migrées.
-- On traite les deux premières ; la troisième est comptée à part (elle demande
-- un examen manuel, car un parsing raté ferait échouer toute la requête).
-- --------------------------------------------------------------------------
details as (
  select
    c.id,
    c.annule,
    c.archive,
    jsonb_typeof(c.conteneurs_details) as forme,
    case jsonb_typeof(c.conteneurs_details)
      when 'array'  then c.conteneurs_details
      when 'object' then coalesce(c.conteneurs_details -> 'conteneurs', '[]'::jsonb)
      else '[]'::jsonb
    end as conteneurs
  from cargaisons c
),
-- Un conteneur par ligne, tel que le voit l'application (clé `num`).
details_plat as (
  select d.id, d.annule, d.archive,
         upper(trim(coalesce(e ->> 'num', ''))) as num
  from details d
  cross join lateral jsonb_array_elements(d.conteneurs) as e
),

-- --------------------------------------------------------------------------
-- DAT-02 — Balises GPS posées sur plusieurs cargaisons.
-- « Active » = balise renseignée sur une cargaison vivante pas encore sortie.
-- --------------------------------------------------------------------------
balises_actives as (
  select numero_gps, count(*) as n
  from cargaisons
  where coalesce(numero_gps, '') <> ''
    and statut <> 'Sortie Enregistrée'
    and annule is not true
    and archive is not true
  group by numero_gps
  having count(*) > 1
),
balises_toutes as (
  select numero_gps, count(*) as n
  from cargaisons
  where coalesce(numero_gps, '') <> ''
    and annule is not true
    and archive is not true
  group by numero_gps
  having count(*) > 1
),

-- --------------------------------------------------------------------------
-- DAT-05 — Même conteneur répété dans une même cargaison.
-- Deux sources à vérifier : la table normalisée `conteneurs` (qui portera la
-- contrainte) ET le jsonb `conteneurs_details` (ce que les écrans affichent).
-- Elles peuvent diverger : c'est justement ce qu'on veut savoir.
-- --------------------------------------------------------------------------
dup_table as (
  select cargaison_id, conteneur, count(*) as n
  from conteneurs
  group by cargaison_id, conteneur
  having count(*) > 1
),
dup_jsonb as (
  select id, num, count(*) as n
  from details_plat
  where num <> ''
    and annule is not true
    and archive is not true
  group by id, num
  having count(*) > 1
),

-- --------------------------------------------------------------------------
-- DAT-08 — Apurement : dépassement du nombre déclaré, et nombre déclaré absent.
-- `fn_apurer_inc` refuse déjà les incréments négatifs (migration 00090) mais ne
-- borne PAS la valeur stockée : le `greatest(0, …)` ne corrige que la valeur
-- RETOURNÉE. Une déclaration peut donc afficher plus d'apurés que de déclarés.
-- --------------------------------------------------------------------------
apur_depasse as (
  select count(*) as n from declarations where conteneurs_apures > nombre_conteneurs
),
apur_sans_nombre as (
  select count(*) as n from declarations where nombre_conteneurs <= 0
),

-- --------------------------------------------------------------------------
-- DAT-04 (bonus) — Numéros de conteneur non conformes à l'ISO 6346 dans le
-- jsonb. La table `conteneurs` porte déjà un CHECK : elle ne peut PAS en
-- contenir. Le jsonb, lui, n'est pas contraint — c'est là que vivent les 188
-- lignes signalées par l'audit comme « rejetées à la migration ».
-- --------------------------------------------------------------------------
iso_invalides as (
  select count(*) as n
  from details_plat
  where num <> ''
    and num !~ '^[A-Z]{4}[0-9]{7}$'
    and annule is not true
    and archive is not true
),
-- Formes de `conteneurs_details` que cette requête n'a pas su lire.
formes_inattendues as (
  select count(*) as n
  from details
  where forme is not null
    and forme not in ('array', 'object')
    and annule is not true
    and archive is not true
)

select * from (
  select 1 as ordre, 'DAT-02' as ref,
         'Balises posées sur PLUSIEURS cargaisons ACTIVES (bloque la contrainte)' as controle,
         (select count(*) from balises_actives) as valeur
  union all
  select 2, 'DAT-02',
         'Balises réutilisées sur plusieurs cargaisons, sorties comprises (informatif)',
         (select count(*) from balises_toutes)
  union all
  select 3, 'DAT-05',
         'Conteneurs en doublon dans une cargaison — table `conteneurs` (bloque la contrainte)',
         (select count(*) from dup_table)
  union all
  select 4, 'DAT-05',
         'Conteneurs en doublon dans une cargaison — jsonb `conteneurs_details` (informatif)',
         (select count(*) from dup_jsonb)
  union all
  select 5, 'DAT-08',
         'Déclarations dont les apurés DÉPASSENT le nombre déclaré',
         (select n from apur_depasse)
  union all
  select 6, 'DAT-08',
         'Déclarations sans nombre déclaré (nombre_conteneurs <= 0)',
         (select n from apur_sans_nombre)
  union all
  select 7, 'DAT-04',
         'Numéros de conteneur non conformes ISO 6346 dans le jsonb',
         (select n from iso_invalides)
  union all
  select 8, '—',
         'Cargaisons dont `conteneurs_details` a une forme non lue par ce script',
         (select n from formes_inattendues)
  union all
  select 9, '—',
         'Cargaisons vivantes (référence de volume)',
         (select count(*) from cargaisons where annule is not true and archive is not true)
) s
order by ordre;


-- ############################################################################
-- #  PARTIE 2 — DÉTAIL : à lancer seulement si la synthèse compte > 0        #
-- ############################################################################

-- ---------------------------------------------------------------------------
-- 2.1  DAT-02 — Quelles balises, sur quels camions ?
--      C'est la liste à arbitrer : pour chaque balise, quelle cargaison la
--      porte réellement ? L'autre a probablement une saisie erronée.
-- ---------------------------------------------------------------------------
-- select c.numero_gps,
--        c.id, c.numero_camion, c.statut, c.type_operation,
--        c.date_pose_gps, c.agent_balise, c.date_sortie
-- from cargaisons c
-- join (
--   select numero_gps
--   from cargaisons
--   where coalesce(numero_gps, '') <> ''
--     and statut <> 'Sortie Enregistrée'
--     and annule is not true and archive is not true
--   group by numero_gps having count(*) > 1
-- ) d on d.numero_gps = c.numero_gps
-- where c.annule is not true and c.archive is not true
-- order by c.numero_gps, c.date_pose_gps;


-- ---------------------------------------------------------------------------
-- 2.2  DAT-05 — Quels conteneurs en doublon, dans quelle cargaison ?
-- ---------------------------------------------------------------------------
-- select k.cargaison_id, k.conteneur, k.n as occurrences,
--        c.numero_camion, c.statut, c.date_creation
-- from (
--   select cargaison_id, conteneur, count(*) as n
--   from conteneurs group by cargaison_id, conteneur having count(*) > 1
-- ) k
-- join cargaisons c on c.id = k.cargaison_id
-- order by k.n desc, k.cargaison_id;


-- ---------------------------------------------------------------------------
-- 2.3  DAT-08 — Quelles déclarations sur-apurées, et de combien ?
--      `ecart` = nombre de conteneurs apurés en trop. Un écart important
--      signale un double appel d'apurement, pas une erreur de saisie.
-- ---------------------------------------------------------------------------
-- select cle, declarant, nombre_conteneurs, conteneurs_apures,
--        conteneurs_apures - nombre_conteneurs as ecart,
--        date_creation, derniere_maj
-- from declarations
-- where conteneurs_apures > nombre_conteneurs
-- order by ecart desc;


-- ---------------------------------------------------------------------------
-- 2.4  DAT-04 — Quels numéros de conteneur non conformes, et où ?
--      Ces lignes seront REJETÉES par le CHECK `conteneur_iso6346` si elles
--      doivent un jour rejoindre la table `conteneurs`.
-- ---------------------------------------------------------------------------
-- select c.id, c.numero_camion, c.statut, c.date_creation,
--        upper(trim(coalesce(e ->> 'num', ''))) as num_invalide
-- from cargaisons c
-- cross join lateral jsonb_array_elements(
--   case jsonb_typeof(c.conteneurs_details)
--     when 'array'  then c.conteneurs_details
--     when 'object' then coalesce(c.conteneurs_details -> 'conteneurs', '[]'::jsonb)
--     else '[]'::jsonb
--   end
-- ) as e
-- where c.annule is not true and c.archive is not true
--   and upper(trim(coalesce(e ->> 'num', ''))) <> ''
--   and upper(trim(coalesce(e ->> 'num', ''))) !~ '^[A-Z]{4}[0-9]{7}$'
-- order by c.date_creation desc;


-- ---------------------------------------------------------------------------
-- 2.5  Formes de `conteneurs_details` présentes en base (contrôle de lecture).
--      Attendu : 'array' et/ou 'object'. Tout autre résultat ('string', 'null')
--      signifie que la PARTIE 1 a sous-compté : me le signaler.
-- ---------------------------------------------------------------------------
-- select jsonb_typeof(conteneurs_details) as forme, count(*) as n
-- from cargaisons
-- where annule is not true and archive is not true
-- group by 1 order by 2 desc;
