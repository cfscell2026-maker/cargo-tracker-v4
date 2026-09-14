-- ============================================================================
--  DAT-05 — Les 19 conteneurs en doublon, à arbitrer
--
--  ⚠ LECTURE SEULE. Que des SELECT.
--
--  POURQUOI CE FICHIER
--  -------------------
--  Le diagnostic du 2026-09-09 compte 19 couples (cargaison, conteneur) présents
--  plusieurs fois dans la table `conteneurs`, et 16 dans le jsonb
--  `conteneurs_details`. La migration 00170 ne pose PAS la contrainte
--  `unique (cargaison_id, conteneur)` : un index unique ne peut pas être créé en
--  `NOT VALID`, il échouerait sur ces 19 lignes.
--
--  Ces lignes doivent donc être VUES avant d'être touchées. C'est de la donnée
--  douanière : on ne supprime pas un doublon sans savoir lequel des deux compte.
--
--  UNE PISTE À VÉRIFIER EN LISANT LES RÉSULTATS
--  --------------------------------------------
--  La table `conteneurs` est DÉRIVÉE : à chaque correction, `editconteneur`
--  fait `supprimerConteneursDe` puis `ajouterConteneurs` — réécriture complète
--  depuis le jsonb, qui est la source de vérité. Un doublon présent dans la
--  table mais ABSENT du jsonb est donc probablement un résidu de réécriture,
--  pas une double saisie. L'écart 19 / 16 va exactement dans ce sens.
--
--  Si la requête 2 confirme que les doublons de la table n'existent pas dans le
--  jsonb, le nettoyage est sans risque : il suffit de régénérer la table depuis
--  le jsonb. Sinon, chaque cas doit être arbitré avec le CFS.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- 1. Les 19 doublons, avec leur contexte
-- ---------------------------------------------------------------------------
select
  k.cargaison_id,
  k.conteneur,
  k.n                as occurrences,
  c.numero_camion,
  c.statut,
  c.type_operation,
  c.date_creation,
  c.nb_conteneurs    as nb_annonce_sur_la_cargaison
from (
  select cargaison_id, conteneur, count(*) as n
  from conteneurs
  group by cargaison_id, conteneur
  having count(*) > 1
) k
join cargaisons c on c.id = k.cargaison_id
order by k.n desc, c.date_creation desc;


-- ---------------------------------------------------------------------------
-- 2. LA QUESTION QUI TRANCHE — le doublon existe-t-il aussi dans le jsonb ?
--
--    `dans_le_jsonb` = combien de fois le conteneur apparaît dans
--    `conteneurs_details`, c'est-à-dire ce que voient réellement les agents.
--
--    · dans_le_jsonb = 1  → résidu de réécriture, la table seule est fausse.
--      Nettoyage sans risque : régénérer la table depuis le jsonb.
--    · dans_le_jsonb > 1  → VRAIE double saisie, visible à l'écran.
--      À arbitrer au cas par cas avec le CFS.
-- ---------------------------------------------------------------------------
-- with dups as (
--   select cargaison_id, conteneur, count(*) as n_table
--   from conteneurs group by cargaison_id, conteneur having count(*) > 1
-- )
-- select
--   d.cargaison_id,
--   d.conteneur,
--   d.n_table,
--   (
--     select count(*)
--     from jsonb_array_elements(
--       case jsonb_typeof(c.conteneurs_details)
--         when 'array'  then c.conteneurs_details
--         when 'object' then coalesce(c.conteneurs_details -> 'conteneurs', '[]'::jsonb)
--         else '[]'::jsonb
--       end
--     ) e
--     where upper(trim(coalesce(e ->> 'num', ''))) = d.conteneur
--   ) as dans_le_jsonb,
--   c.numero_camion, c.statut, c.date_creation
-- from dups d
-- join cargaisons c on c.id = d.cargaison_id
-- order by dans_le_jsonb desc, d.n_table desc;


-- ---------------------------------------------------------------------------
-- 3. Une fois les 19 cas traités : poser la contrainte
--
--    À exécuter dans une migration 00180, PAS ici — et seulement après que la
--    requête 1 ne renvoie plus aucune ligne.
-- ---------------------------------------------------------------------------
-- create unique index concurrently if not exists conteneurs_cargaison_unique
--   on conteneurs (cargaison_id, conteneur);
