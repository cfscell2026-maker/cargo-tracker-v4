-- ============================================================================
--  CARGO TRACKER v4.2 — DURCISSEMENT DE SÉCURITÉ (audit du 2026-08-10)
--
--  Traite : SEC-01 (fonctions SECURITY DEFINER exécutables par anon),
--           SEC-04 (chaîne d'audit non clefée, jamais vérifiée, TRUNCATE-able),
--           SEC-06 (search_path mutable), SEC-03 (changement de mot de passe
--           imposé), SEC-10 (signature de validation sans contenu),
--           SEC-12 (suppression définitive d'une cargaison).
--
--  ⚠ MIGRATION ADDITIVE. Aucune donnée existante n'est modifiée ni supprimée.
--    La chaîne d'audit historique reste vérifiable (colonne `algo`).
-- ============================================================================

-- pgcrypto (digest/hmac/gen_random_bytes) vit selon les projets dans `public`
-- ou dans `extensions` : on rend les deux visibles le temps de la migration.
set search_path = public, extensions, pg_catalog;

-- ---------------------------------------------------------------------------
-- 0. Schéma privé des secrets applicatifs
--    Isolé de `public` : PostgREST n'expose QUE les schémas déclarés (public),
--    donc rien ici n'est joignable par l'API, quels que soient les GRANT.
-- ---------------------------------------------------------------------------
create schema if not exists securite;
revoke all on schema securite from public, anon, authenticated;

create table if not exists securite.parametres (
  cle    text primary key,
  valeur text not null,
  maj    timestamptz not null default now()
);
alter table securite.parametres enable row level security;
-- service_role compris : c'est TOUT l'intérêt du dispositif. La clé ne doit pas
-- être atteignable par l'API, même avec la clé service_role de l'Edge Function ;
-- seules les fonctions SECURITY DEFINER (exécutées sous le propriétaire) la lisent.
revoke all on schema securite from public, anon, authenticated, service_role;
revoke all on securite.parametres from public, anon, authenticated, service_role;

-- Clé de scellement du journal d'audit (32 octets aléatoires, générée une fois).
-- Elle ne sort jamais de la base : seules les fonctions SECURITY DEFINER la lisent.
insert into securite.parametres (cle, valeur)
select 'audit_hmac_cle', encode(gen_random_bytes(32), 'hex')
where not exists (select 1 from securite.parametres where cle = 'audit_hmac_cle');

-- ---------------------------------------------------------------------------
-- 1. SEC-04 — Journal d'audit scellé par HMAC-SHA256
--
--    L'ancien chaînage était un SHA-256 NON CLEFÉ : quiconque pouvait écrire
--    dans la base pouvait modifier une ligne puis recalculer toute la chaîne en
--    aval sans être détecté. Avec un HMAC, refaire la chaîne suppose de
--    connaître la clé, qui vit dans le schéma `securite` inaccessible à l'API.
--
--    Les lignes déjà écrites gardent `algo='sha256'` et restent vérifiables :
--    on ne réécrit PAS l'historique (ce serait précisément ce qu'on interdit).
-- ---------------------------------------------------------------------------
alter table audit_log add column if not exists algo text not null default 'sha256';

-- Charge utile canonique d'une ligne — un seul endroit, utilisé à l'écriture
-- comme à la vérification (toute divergence entre les deux serait un faux négatif).
-- ⚠ `p_ts::text` rend l'horodatage AVEC le fuseau de la session : le sceau
--   dépendrait donc du réglage `TimeZone` au moment du calcul, et une
--   vérification faite dans un autre fuseau échouerait sur des lignes pourtant
--   intactes — un faux positif d'altération, le pire résultat possible pour un
--   contrôle d'intégrité. La forme reste celle d'origine (compatibilité des
--   lignes déjà scellées en SHA-256), mais TOUTES les fonctions de la chaîne
--   fixent `TimeZone = UTC` : le rendu devient déterministe.
--   `stable` et non `immutable` : le résultat dépend d'un paramètre de session.
create or replace function fn_audit_charge(
  p_prev text, p_ts timestamptz, p_user uuid, p_username text,
  p_role text, p_action text, p_cargaison text, p_details text
) returns text
language sql stable
set search_path = pg_catalog, public, extensions
set timezone = 'UTC' as $$
  select p_prev || '|' || p_ts::text || '|' || coalesce(p_user::text, '') || '|' ||
         p_username || '|' || p_role || '|' || p_action || '|' ||
         p_cargaison || '|' || p_details;
$$;

create or replace function fn_audit_chain() returns trigger
language plpgsql security definer
set search_path = pg_catalog, public, extensions
set timezone = 'UTC' as $$
declare
  v_prev text;
  v_cle  text;
begin
  -- Sérialise les insertions concurrentes pour garantir une chaîne linéaire.
  perform pg_advisory_xact_lock(hashtext('audit_log_chain'));
  select hash into v_prev from audit_log order by id desc limit 1;
  select valeur into v_cle from securite.parametres where cle = 'audit_hmac_cle';

  new.prev_hash := coalesce(v_prev, 'GENESIS');
  new.algo      := 'hmac-sha256';
  new.hash      := encode(
    hmac(
      fn_audit_charge(new.prev_hash, new.ts, new.user_id, new.username,
                      new.role, new.action, new.cargaison_id, new.details),
      v_cle, 'sha256'),
    'hex');
  return new;
end $$;

-- Vérification : renvoie l'id de la 1ʳᵉ rupture, sinon null. Gère les DEUX
-- algorithmes pour que l'historique importé reste contrôlable.
create or replace function fn_audit_verifier() returns bigint
language plpgsql security definer
set search_path = pg_catalog, public, extensions
set timezone = 'UTC' as $$
declare
  r      record;
  v_prev text := 'GENESIS';
  v_cle  text;
  v_att  text;
  v_ch   text;
begin
  select valeur into v_cle from securite.parametres where cle = 'audit_hmac_cle';
  for r in select * from audit_log order by id loop
    if r.prev_hash <> v_prev then return r.id; end if;
    v_ch := fn_audit_charge(r.prev_hash, r.ts, r.user_id, r.username,
                            r.role, r.action, r.cargaison_id, r.details);
    if r.algo = 'hmac-sha256' then
      v_att := encode(hmac(v_ch, v_cle, 'sha256'), 'hex');
    else
      v_att := encode(digest(v_ch, 'sha256'), 'hex');
    end if;
    if r.hash <> v_att then return r.id; end if;
    v_prev := r.hash;
  end loop;
  return null;
end $$;

-- --- Ancrage périodique -----------------------------------------------------
-- Une chaîne interne ne prouve rien à elle seule : celui qui contrôle la base
-- contrôle aussi la chaîne. On fige donc régulièrement le hash de tête dans une
-- table en ajout seul, destinée à être RECOPIÉE HORS DE LA BASE (impression
-- contresignée, courriel au chef de division, dépôt externe).
create table if not exists audit_ancrage (
  id           bigint generated always as identity primary key,
  ts           timestamptz not null default now(),
  dernier_id   bigint      not null,
  dernier_hash text        not null,
  nb_lignes    bigint      not null,
  rupture_id   bigint                -- non null = chaîne rompue au moment de l'ancrage
);
alter table audit_ancrage enable row level security;
revoke all on audit_ancrage from public, anon, authenticated;

create or replace function fn_audit_ancrer() returns audit_ancrage
language plpgsql security definer
set search_path = pg_catalog, public, extensions
set timezone = 'UTC' as $$
declare v audit_ancrage;
begin
  insert into audit_ancrage (dernier_id, dernier_hash, nb_lignes, rupture_id)
  select coalesce(max(id), 0),
         coalesce((select hash from audit_log order by id desc limit 1), 'GENESIS'),
         count(*),
         fn_audit_verifier()
    from audit_log
  returning * into v;
  return v;
end $$;

-- --- Verrou append-only : UPDATE, DELETE **et TRUNCATE** --------------------
-- Le déclencheur d'origine ne couvrait pas TRUNCATE, et `scripts/migration/
-- reset.sql` s'en servait explicitement pour remettre le journal à zéro.
drop trigger if exists audit_no_truncate on audit_log;
create trigger audit_no_truncate before truncate on audit_log
  for each statement execute function fn_audit_bloquer();

drop trigger if exists ancrage_no_update on audit_ancrage;
create trigger ancrage_no_update before update or delete on audit_ancrage
  for each row execute function fn_audit_bloquer();
drop trigger if exists ancrage_no_truncate on audit_ancrage;
create trigger ancrage_no_truncate before truncate on audit_ancrage
  for each statement execute function fn_audit_bloquer();

-- ---------------------------------------------------------------------------
-- 2. SEC-06 — search_path figé sur les fonctions SECURITY DEFINER héritées
--    Sans cela, un rôle capable de créer un objet dans un schéma antérieur du
--    search_path peut détourner la résolution de `digest`, `now` ou `audit_log`
--    et faire exécuter son code avec les droits du propriétaire.
-- ---------------------------------------------------------------------------
alter function fn_audit_bloquer()               set search_path = pg_catalog, public, extensions;
alter function fn_next_ref(text, text)          set search_path = pg_catalog, public, extensions;
alter function fn_lier_stock(text, text)        set search_path = pg_catalog, public, extensions;

-- ---------------------------------------------------------------------------
-- 3. Apurement : garde-fou et search_path (SEC-06 + garde métier minimal)
--    On refuse un incrément non positif — `fn_apurer_inc` était appelable avec
--    un nombre négatif, ce qui *désapurait* une déclaration.
-- ---------------------------------------------------------------------------
create or replace function fn_apurer_inc(p_cle text, p_nb integer)
returns integer language plpgsql security definer
set search_path = pg_catalog, public, extensions as $$
declare v_restant integer;
begin
  if p_nb is null or p_nb <= 0 then
    raise exception 'Apurement : quantité strictement positive attendue (reçu %).', p_nb;
  end if;
  update declarations
     set conteneurs_apures = conteneurs_apures + p_nb, derniere_maj = now()
   where cle = p_cle
   returning greatest(0, nombre_conteneurs - conteneurs_apures) into v_restant;
  return coalesce(v_restant, 0);
end $$;

-- ---------------------------------------------------------------------------
-- 4. SEC-01 — Fermeture des droits d'exécution
--
--    LE POINT CENTRAL DE CETTE MIGRATION.
--    En PostgreSQL, CREATE FUNCTION accorde EXECUTE à **PUBLIC**. Les
--    `revoke ... from anon, authenticated` des migrations 00010/00020/00030 ne
--    retiraient donc RIEN : anon héritait du droit via PUBLIC et pouvait
--    appeler ces fonctions SECURITY DEFINER (donc hors RLS) par
--    POST /rest/v1/rpc/<nom> avec la seule clé anon, qui est publique.
--
--    On révoque sur PUBLIC, pour toutes les fonctions de `public` qui
--    n'appartiennent pas à une extension (on ne touche pas à pgcrypto & co.),
--    puis on redonne explicitement à service_role ce dont l'Edge Function a besoin.
-- ---------------------------------------------------------------------------
do $$
declare r record;
begin
  for r in
    select p.oid::regprocedure as f
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      left join pg_depend d on d.objid = p.oid and d.deptype = 'e'
     where n.nspname = 'public'
       and d.objid is null
  loop
    execute format('revoke all on function %s from public, anon, authenticated', r.f);
  end loop;
end $$;

-- L'Edge Function (service_role) appelle ces trois fonctions via PostgREST :
-- sans GRANT explicite, la révocation ci-dessus la casserait.
grant execute on function fn_next_ref(text, text)        to service_role;
grant execute on function fn_apurer_inc(text, integer)   to service_role;
grant execute on function fn_lier_stock(text, text)      to service_role;
grant execute on function fn_audit_verifier()            to service_role;
grant execute on function fn_audit_ancrer()              to service_role;

-- `fn_import_audit` servait à la migration ponctuelle de l'historique v3.6.
-- Elle est faite. Laisser en place une fonction capable d'insérer des lignes
-- d'audit arbitraires est un risque permanent sans contrepartie.
drop function if exists fn_import_audit(jsonb);

-- ---------------------------------------------------------------------------
-- 5. SEC-01 (suite) — Droits par défaut pour TOUT objet futur
--    Sans cette section, la prochaine migration écrite par quelqu'un d'autre
--    rouvrirait le trou sans s'en apercevoir. C'est le correctif qui survit
--    au départ de l'auteur.
-- ---------------------------------------------------------------------------
alter default privileges in schema public revoke execute on functions from public, anon, authenticated;
alter default privileges in schema public revoke all     on tables    from anon, authenticated;
alter default privileges in schema public revoke all     on sequences from anon, authenticated;

-- Filet de sécurité sur l'existant (tables ajoutées par 00070 comprises).
revoke all on all tables    in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 6. SEC-03 — Changement de mot de passe imposé
--    Positionné à la création d'un compte et à toute réinitialisation ; tant
--    qu'il est vrai, l'Edge Function n'autorise que `account.me` et
--    `account.changepwd`.
-- ---------------------------------------------------------------------------
alter table profils add column if not exists doit_changer_mdp boolean not null default false;

comment on column profils.doit_changer_mdp is
  'true = l''agent doit changer son mot de passe avant toute autre action (SEC-03).';

-- Tous les comptes existants ont été créés avec le mot de passe provisoire
-- commun « CargoPia2026 » : aucun n'est digne de confiance aujourd'hui.
update profils set doit_changer_mdp = true;

-- ---------------------------------------------------------------------------
-- 7. SEC-12 — Suppression LOGIQUE d'une cargaison
--    `cargo.delete` effaçait la ligne et, par cascade, tous ses conteneurs — à
--    n'importe quel statut, y compris après sortie et validation signée. Pour
--    une écriture douanière c'est une destruction de pièce. On conserve.
-- ---------------------------------------------------------------------------
alter table cargaisons
  add column if not exists annule        boolean not null default false,
  add column if not exists annule_le     timestamptz,
  add column if not exists annule_par    text not null default '',
  add column if not exists annule_par_id uuid references profils(id),
  add column if not exists annule_motif  text not null default '';

create index if not exists cargaisons_annule_idx on cargaisons (annule) where annule;

comment on column cargaisons.annule is
  'Suppression logique (doublon de saisie). La ligne et ses conteneurs sont conservés (SEC-12).';

-- ---------------------------------------------------------------------------
-- 8. SEC-10 — Historique des validations
--    `valider()` écrasait date/agent/signature à chaque re-validation ADMIN :
--    le premier signataire disparaissait. Et la « signature » ne couvrait que
--    id|username|horodatage, donc rien du contenu validé. On conserve chaque
--    validation avec l'empreinte des données réellement signées.
-- ---------------------------------------------------------------------------
create table if not exists validations (
  id                bigint generated always as identity primary key,
  cargaison_id      text        not null references cargaisons(id),
  ts                timestamptz not null default now(),
  agent             text        not null default '',
  agent_id          uuid references profils(id),
  role              text        not null default '',
  signature         text        not null default '',
  empreinte_donnees text        not null default '',  -- SHA-256 du contenu validé
  en_surcharge      boolean,
  poids_surcharge   text        not null default '',
  remplace          boolean     not null default false -- true = validation ultérieure
);
create index if not exists validations_cargaison_idx on validations (cargaison_id, ts desc);
alter table validations enable row level security;
revoke all on validations from public, anon, authenticated;
-- L'Edge Function y écrit sous service_role : le GRANT est explicite pour ne pas
-- dépendre des privilèges par défaut du projet (qu'on vient justement de réduire).
grant select, insert on validations to service_role;

drop trigger if exists validations_no_update on validations;
create trigger validations_no_update before update or delete on validations
  for each row execute function fn_audit_bloquer();

-- ---------------------------------------------------------------------------
-- 9. Vue résumé — exclut désormais les cargaisons annulées (SEC-12).
--    NB : on ne passe PAS la vue en `security_invoker`. Elle n'est de toute
--    façon joignable par personne d'autre que service_role (revoke ci-dessous),
--    et service_role contourne RLS : le gain serait nul pour un risque réel de
--    rupture si ses GRANT venaient à manquer.
-- ---------------------------------------------------------------------------
create or replace view v_cargaisons_resume as
select
  c.id, c.reference, c.date_creation, c.numero_camion, c.numero_camion_norm,
  c.type_operation, c.statut, c.numero_gps, c.date_sortie, c.agent_cfs, c.rapport_id,
  c.est_vehicule, c.conteneur_origine, c.saute_t1, c.saute_balise, c.saute_bs,
  c.balise_requise, c.arrivee_bureau, c.date_t1, c.date_pose_gps, c.bon_sortie_numero,
  c.date_validation, c.etat_sortie, c.nb_conteneurs, c.twins,
  c.conteneurs_details -> 'conteneurs' -> 0 ->> 'num' as conteneur1,
  c.conteneurs_details -> 'conteneurs' -> 1 ->> 'num' as conteneur2,
  c.conteneurs_details -> 'conteneurs' -> 2 ->> 'num' as conteneur3,
  c.conteneurs_details -> 'conteneurs' -> 3 ->> 'num' as conteneur4,
  case when c.type_operation = 'Dépotage'
       then c.conteneurs_details -> 'scellesCamion' ->> 0
       else c.conteneurs_details -> 'conteneurs' -> 0 ->> 'plomb' end as plomb1,
  case when c.type_operation = 'Dépotage'
       then c.conteneurs_details -> 'scellesCamion' ->> 1
       else c.conteneurs_details -> 'conteneurs' -> 1 ->> 'plomb' end as plomb2,
  case when c.type_operation = 'Dépotage'
       then c.conteneurs_details -> 'scellesCamion' ->> 2
       else c.conteneurs_details -> 'conteneurs' -> 2 ->> 'plomb' end as plomb3,
  case when c.type_operation = 'Dépotage'
       then null
       else c.conteneurs_details -> 'conteneurs' -> 3 ->> 'plomb' end as plomb4
from cargaisons c
where not c.annule;

revoke all on v_cargaisons_resume from public, anon, authenticated;
-- `create or replace view` conserve les privilèges existants, mais on l'écrit :
-- toute la lecture de l'application passe par cette vue.
grant select on v_cargaisons_resume to service_role;

-- ---------------------------------------------------------------------------
-- 10. Contrôle final — doit renvoyer que des `false` sur les colonnes de droits.
-- ---------------------------------------------------------------------------
-- Volontairement BLOQUANT : si le durcissement n'a pas pris, la migration
-- échoue et rien n'est appliqué. Un simple avertissement serait exactement le
-- mode de défaillance qui a produit SEC-01 — un REVOKE qui ne révoquait rien,
-- et personne pour s'en apercevoir pendant des mois.
do $$
declare restants text;
begin
  select string_agg(p.oid::regprocedure::text, ', ' order by p.oid::regprocedure::text)
    into restants
    from pg_proc p
    join pg_namespace ns on ns.oid = p.pronamespace
    left join pg_depend d on d.objid = p.oid and d.deptype = 'e'
   where ns.nspname = 'public' and d.objid is null
     and (has_function_privilege('anon', p.oid, 'EXECUTE')
       or has_function_privilege('authenticated', p.oid, 'EXECUTE'));
  if restants is not null then
    raise exception 'DURCISSEMENT INCOMPLET — encore exécutable(s) par anon/authenticated : %', restants
      using hint = 'Ajouter un REVOKE EXECUTE ... FROM PUBLIC, anon, authenticated sur ces fonctions.';
  end if;
  raise notice 'Durcissement OK : aucune fonction publique exécutable par anon/authenticated.';
end $$;
