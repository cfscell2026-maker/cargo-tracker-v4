-- ============================================================================
--  URGENCE : BASE SATURÉE (2026-10-25)
--
--  Symptôme : la base et la connexion ne répondent plus (délai dépassé), alors
--  que la fonction serveur répond. Des lectures lourdes continuent de tourner
--  dans PostgreSQL après que le serveur a abandonné (HTTP 546) : elles
--  s'empilent et occupent le disque.
--
--  À exécuter dans l'éditeur SQL de Supabase, ÉTAPE PAR ÉTAPE (sélectionner
--  le bloc, puis Run).
-- ============================================================================

-- ÉTAPE 1 · Voir ce qui tourne (lecture seule).
select pid, usename, state, now() - query_start as duree, left(query, 120) as requete
from pg_stat_activity
where state <> 'idle' and pid <> pg_backend_pid()
order by duree desc nulls last;

-- ÉTAPE 2 · Arrêter les LECTURES de l'application qui tournent depuis plus
-- d'une minute. Les écritures (insert / update / delete) ne sont pas touchées.
select pg_terminate_backend(pid) as arretee, now() - query_start as duree, left(query, 80) as requete
from pg_stat_activity
where state = 'active'
  and pid <> pg_backend_pid()
  and usename = 'authenticator'
  and now() - query_start > interval '60 seconds'
  and query !~* '\m(insert|update|delete)\M';

-- ÉTAPE 3 · Prévention : une requête du serveur de l'application ne peut plus
-- dépasser 30 s. Au-delà, c'est qu'elle est anormale, et elle ne doit pas
-- s'empiler. (Les rôles anon / authenticated ont déjà une limite chez Supabase ;
-- service_role, celui du serveur, n'en avait aucune.)
alter role service_role set statement_timeout = '30s';
notify pgrst, 'reload config';
