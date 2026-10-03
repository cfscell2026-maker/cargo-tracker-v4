-- ============================================================================
--  00203 — SUPER_ADMIN, INFO (et CBPI, oublié) dans le type des rôles
--          2026-10-03, demande utilisateur
--
--  L'ADMIN administre l'EXPLOITATION : il crée les comptes d'agents, les
--  reclasse, réinitialise un mot de passe. Il ne touche pas à ses pairs.
--
--  SUPER_ADMIN et INFO administrent L'ADMINISTRATION : eux seuls voient ces
--  deux rôles dans la liste, eux seuls les attribuent, et eux seuls peuvent
--  reclasser un ADMIN. Les deux ont les mêmes pouvoirs ; ils existent en double
--  pour distinguer QUI agit dans le journal — la direction d'un côté,
--  l'informatique de l'autre.
--
--  ⚠ CBPI ÉTAIT MANQUANT, et personne ne s'en était aperçu. Le rôle « chef
--  brigade par intérim » existe dans le code depuis le 2026-08-19 : la liste
--  déroulante le propose, la matrice des droits le gère, la migration 00140 en
--  parle dans ses commentaires. Mais il n'a JAMAIS été ajouté au type énuméré :
--  l'attribuer échouait donc sur une erreur technique, côté base. On le répare
--  ici, en même temps.
--
--  ⚠ MIGRATION ADDITIVE. On ajoute des valeurs à un type énuméré : aucune ligne
--  existante n'est modifiée, aucun compte ne change de rôle. Tant que personne
--  n'attribue ces rôles, l'application se comporte exactement comme avant.
--
--  ⚠ `alter type ... add value` ne peut pas s'exécuter dans un bloc transaction
--  suivi d'un usage de la valeur. Ces trois instructions sont donc seules dans
--  ce fichier : aucune autre instruction ne doit s'y ajouter.
-- ============================================================================

alter type role_utilisateur add value if not exists 'CBPI';
alter type role_utilisateur add value if not exists 'SUPER_ADMIN';
alter type role_utilisateur add value if not exists 'INFO';
