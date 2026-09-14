-- ============================================================================
--  RÉGULARISATION — Recaler les apurements que la fuite a faussés
--
--  ⚠ CE FICHIER ÉCRIT DANS LA BASE. Il n'est PAS une migration, et ne doit PAS
--    être placé dans supabase/migrations/. Recaler des compteurs douaniers est
--    une décision, pas un effet de bord d'un déploiement.
--
--  ⚠ LA PARTIE QUI ÉCRIT EST COMMENTÉE. On regarde d'abord, on décide, on
--    décommente ensuite. Ne jamais exécuter ce fichier d'un bloc.
--
--  CONTEXTE
--  --------
--  Jusqu'à la migration 00170, le compteur d'apurement ne pouvait que monter :
--  tout conteneur retiré, réaffecté, ou dont la cargaison a été annulée laissait
--  son +1 collé à sa déclaration d'origine. 00170 pose le correctif pour
--  l'avenir (fn_apurer_dec + les trois flux qui fuyaient) ; ce fichier traite
--  l'ARRIÉRÉ, c'est-à-dire les écarts déjà inscrits en base.
--
--  Relevé du 2026-09-09 : 34 déclarations sur les 121 qui portent un nombre
--  déclaré sont sur-apurées, jusqu'à +8 conteneurs.
--
--  À FAIRE AVANT
--  -------------
--  1. Appliquer la migration 00170 (sinon la fuite recommence aussitôt).
--  2. Traiter les 19 doublons de `conteneurs` (voir
--     scripts/diagnostic/doublons-conteneurs.sql) — sinon l'étape 1 ci-dessous
--     comptera deux fois les mêmes conteneurs et le recalage sera faux.
--  3. Vérifier que la sauvegarde quotidienne Supabase est bien active.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- ÉTAPE 1 — REGARDER : ce qui est compté contre ce qui existe vraiment
--
--  `attaches_reellement` = nombre de conteneurs effectivement rattachés à cette
--  déclaration, sur des cargaisons vivantes (ni annulées, ni archivées).
--  `fuite` = ce que le compteur porte en trop.
--
--  Lecture des résultats :
--   · fuite > 0  → conteneurs comptés puis retirés : c'est la fuite attendue.
--   · fuite = 0  → le compteur est juste ; le dépassement vient d'un nombre
--     déclaré trop bas à la saisie, PAS d'un défaut d'apurement. Ne pas toucher.
--   · fuite < 0  → le compteur est SOUS-évalué (conteneurs ajoutés sans
--     apurement). Cas non expliqué par la fuite : à examiner à part.
-- ---------------------------------------------------------------------------
with reel as (
  select
    upper(regexp_replace(coalesce(ct.annee_declaration,  ''), '\s', '', 'g')) || '|' ||
    upper(regexp_replace(coalesce(ct.bureau_declaration, ''), '\s', '', 'g')) || '|' ||
    upper(regexp_replace(coalesce(ct.type_declaration,   ''), '\s', '', 'g')) || '|' ||
    upper(regexp_replace(coalesce(ct.numero_declaration, ''), '\s', '', 'g')) as cle,
    count(*) as attaches
  from conteneurs ct
  join cargaisons c on c.id = ct.cargaison_id
  where c.annule  is not true
    and c.archive is not true
  group by 1
)
select
  d.cle,
  d.declarant,
  d.nombre_conteneurs                        as declares,
  d.conteneurs_apures                        as apures,
  coalesce(r.attaches, 0)                    as attaches_reellement,
  d.conteneurs_apures - coalesce(r.attaches, 0) as fuite,
  d.derniere_maj
from declarations d
left join reel r on r.cle = d.cle
where d.nombre_conteneurs > 0
  and d.conteneurs_apures > d.nombre_conteneurs
order by fuite desc, d.cle;


-- ---------------------------------------------------------------------------
-- ÉTAPE 2 — DÉCIDER
--
--  Ne recaler QUE les lignes dont la fuite est positive, et seulement celles-là.
--  Une déclaration dont le nombre déclaré a simplement été mal saisi ne relève
--  pas de ce script : elle se corrige à la source, avec le CFS.
--
--  Le périmètre est volontairement étroit :
--   · nombre_conteneurs > 0   → on ne touche pas aux 5 859 déclarations sans
--     nombre déclaré (« 0 = inconnu », décision utilisateur) ;
--   · conteneurs_apures > attaches → uniquement les compteurs en excès ;
--   · jamais en dessous de zéro.
-- ---------------------------------------------------------------------------


-- ---------------------------------------------------------------------------
-- ÉTAPE 3 — ÉCRIRE  (décommenter seulement après avoir lu l'étape 1)
--
--  Exécuter DANS UNE TRANSACTION, vérifier le nombre de lignes touchées, puis
--  COMMIT — ou ROLLBACK si le compte ne correspond pas à ce qu'annonçait
--  l'étape 1 (34 lignes au relevé du 2026-09-09).
-- ---------------------------------------------------------------------------
-- begin;
--
-- with reel as (
--   select
--     upper(regexp_replace(coalesce(ct.annee_declaration,  ''), '\s', '', 'g')) || '|' ||
--     upper(regexp_replace(coalesce(ct.bureau_declaration, ''), '\s', '', 'g')) || '|' ||
--     upper(regexp_replace(coalesce(ct.type_declaration,   ''), '\s', '', 'g')) || '|' ||
--     upper(regexp_replace(coalesce(ct.numero_declaration, ''), '\s', '', 'g')) as cle,
--     count(*) as attaches
--   from conteneurs ct
--   join cargaisons c on c.id = ct.cargaison_id
--   where c.annule is not true and c.archive is not true
--   group by 1
-- )
-- update declarations d
--    set conteneurs_apures = greatest(0, coalesce(r.attaches, 0)),
--        derniere_maj      = now()
--   from reel r
--  where r.cle = d.cle
--    and d.nombre_conteneurs  > 0
--    and d.conteneurs_apures  > d.nombre_conteneurs
--    and d.conteneurs_apures  > coalesce(r.attaches, 0);
--
-- -- Vérifier ici que le nombre de lignes annoncé correspond à l'étape 1.
-- -- commit;    ← si le compte est bon
-- -- rollback;  ← sinon
-- ---------------------------------------------------------------------------


-- ---------------------------------------------------------------------------
-- ÉTAPE 4 — CONTRÔLER : plus aucune sur-apurée après recalage
--
--  Doit renvoyer 0. Sinon, les lignes restantes ont un nombre déclaré trop bas
--  (voir étape 2) et relèvent d'une correction métier, pas de ce script.
-- ---------------------------------------------------------------------------
-- select count(*) as reste_sur_apurees
-- from declarations
-- where nombre_conteneurs > 0
--   and conteneurs_apures > nombre_conteneurs;


-- ---------------------------------------------------------------------------
-- TRAÇABILITÉ
--
--  Ce recalage ne passe pas par l'Edge Function : il n'apparaîtra donc PAS dans
--  `audit_log`. Consigner à la main ce qui a été fait, quand et par qui —
--  une écriture douanière modifiée hors journal doit rester explicable.
-- ---------------------------------------------------------------------------
