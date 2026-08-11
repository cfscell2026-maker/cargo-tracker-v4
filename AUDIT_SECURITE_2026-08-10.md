# CARGO TRACKER v4.1 — Audit de sécurité, de continuité et de cohérence douanière

**Date** : 10 août 2026
**Périmètre** : `supabase/` (schéma + Edge Function `rpc`), `apps/web/` (React), `apps-script/` (v3.6 legacy), `scripts/migration/`, dépôt Git, et l'export de production `CargoTracker_2026-06-14` (5 022 cargaisons, 6 331 lignes conteneurs, 17 017 événements d'audit, 17 comptes).
**Nature** : revue de code et de données en boîte blanche. Aucun test intrusif n'a été lancé contre l'environnement de production — les vulnérabilités marquées « à confirmer » comportent la commande de vérification.

---

## 0. Résumé exécutif

L'architecture est **saine dans son principe** : RLS en refus par défaut, point d'entrée unique (Edge Function), matrice de permissions côté serveur, journal d'audit chaîné, concurrence optimiste. C'est un bon socle. Les problèmes ne sont pas d'architecture, ils sont de **fermeture** : des portes laissées ouvertes « le temps du démarrage » et jamais refermées, et des garde-fous métier qui n'existent que sur le papier.

Les dix points à traiter en priorité :

| # | Constat | Gravité |
|---|---|---|
| SEC-01 | 5 fonctions `SECURITY DEFINER` restent exécutables par `anon` (le `REVOKE` ne retire pas le droit de `PUBLIC`) → falsification d'apurement et **injection dans le journal d'audit** sans compte | **CRITIQUE** |
| SEC-02 | Double authentification **désactivée** des deux côtés (`MFA_REQUISE=false` serveur *et* en dur dans le front) | **CRITIQUE** |
| SEC-03 | Mot de passe provisoire **fixe et identique pour tous** (`CargoPia2026`), 6 caractères minimum, aucun changement forcé | **CRITIQUE** |
| SEC-04 | La chaîne d'audit SHA-256 n'est **pas clefée** et n'est **jamais vérifiée** ; `reset.sql` documente comment la remettre à zéro | **ÉLEVÉ** |
| SEC-05 | Aucune trace de connexion/déconnexion en v4 (et les connexions sont explicitement filtrées de l'historique) | **ÉLEVÉ** |
| GOV-01 | Dépôt Git local **corrompu** + backend absent du disque de travail | **ÉLEVÉ** |
| GOV-02 | Facteur bus = 1 : un seul compte GitHub, un seul projet Supabase, secrets sur un seul poste, aucun runbook de reprise | **ÉLEVÉ** |
| DAT-01 | 3 cellules du parcours (T1, Bon de sortie, Validation chef brigade) n'ont **jamais servi** — 0 occurrence sur 17 017 événements — alors que 4 910 mouvements sont déclarés en **transit (type T)** | **CRITIQUE (métier)** |
| DAT-02 | 11 balises GPS posées sur **deux camions en même temps** ; 172 sorties moins de 5 min après la pose | **ÉLEVÉ (métier)** |
| RGPD-01 | Coordonnées téléphoniques de 5 009 déclarants lisibles par **les 10 rôles**, exportables en Excel par tous | **ÉLEVÉ** |

---

# Partie A — Sécurité technique

## SEC-01 — CRITIQUE — Fonctions `SECURITY DEFINER` ouvertes à `anon`

**Où** : `supabase/migrations/00010_schema.sql:353`, `00020_fonctions.sql:29-30`, `00030_import_audit.sql:35`

Le schéma se protège ainsi :

```sql
revoke all on all functions in schema public from anon, authenticated;
revoke all on function fn_apurer_inc(text, integer) from anon, authenticated;
revoke all on function fn_import_audit(jsonb) from anon, authenticated;
```

**Le problème** : en PostgreSQL, `CREATE FUNCTION` accorde `EXECUTE` à **`PUBLIC`**, pas à `anon`. Révoquer sur `anon` ne retire rien : `anon` hérite du droit via `PUBLIC`. Les fonctions restent donc appelables par n'importe qui possédant la clé `anon` — laquelle est publique par conception (elle est dans le bundle du navigateur et dans `netlify.toml`).

Comme elles sont `SECURITY DEFINER`, elles s'exécutent avec les droits du propriétaire et **contournent RLS**. PostgREST les expose sur `/rest/v1/rpc/<nom>`.

**Ce qu'un inconnu peut faire, sans compte :**

| Fonction | Effet |
|---|---|
| `fn_import_audit(jsonb)` | **Insérer des lignes arbitraires dans `audit_log`** — horodatage, agent, rôle, action, détails au choix. Le trigger de chaînage les intègre proprement : elles sont indistinguables de vraies entrées. La valeur probante du journal tombe à zéro. |
| `fn_apurer_inc(cle, nb)` | Incrémenter `conteneurs_apures` de n'importe quelle déclaration → **apurement douanier falsifié**, y compris en négatif (`p_nb` n'est pas contrôlé). |
| `fn_lier_stock(tc, cargaison_id)` | Marquer n'importe quel conteneur « Dépoté » et le rattacher à une cargaison arbitraire. |
| `fn_next_ref(cle, prefix)` | Consommer les compteurs `SEQ`/`SEQ_RPT` → trous dans la numérotation `CT-2026-xxxxxx`, qui ressemblent à des suppressions d'enregistrements. |

**Vérifier** (SQL Editor Supabase) :

```sql
select p.proname,
       has_function_privilege('anon',   p.oid, 'EXECUTE') as anon_peut,
       has_function_privilege('public', p.oid, 'EXECUTE') as public_peut
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname like 'fn_%';
```

**Corriger** — nouvelle migration `00090_durcissement_fonctions.sql` :

```sql
-- 1) Retirer le droit à PUBLIC (la vraie source du droit)
revoke execute on all functions in schema public from public;
revoke execute on all functions in schema public from anon, authenticated;

-- 2) Verrouiller le search_path de chaque SECURITY DEFINER (voir SEC-06)
alter function fn_next_ref(text, text)        set search_path = pg_catalog, public;
alter function fn_apurer_inc(text, integer)   set search_path = pg_catalog, public;
alter function fn_lier_stock(text, text)      set search_path = pg_catalog, public;
alter function fn_import_audit(jsonb)         set search_path = pg_catalog, public;
alter function fn_audit_verifier()            set search_path = pg_catalog, public;
alter function fn_audit_chain()               set search_path = pg_catalog, public;

-- 3) fn_import_audit n'a plus de raison d'exister : la migration est faite
drop function if exists fn_import_audit(jsonb);

-- 4) Garde-fou métier sur l'apurement (voir DAT-08)
create or replace function fn_apurer_inc(p_cle text, p_nb integer)
returns integer language plpgsql security definer
set search_path = pg_catalog, public as $$
declare v_restant integer;
begin
  if p_nb <= 0 then raise exception 'Apurement : quantité positive attendue.'; end if;
  update declarations
     set conteneurs_apures = conteneurs_apures + p_nb, derniere_maj = now()
   where cle = p_cle
   returning greatest(0, nombre_conteneurs - conteneurs_apures) into v_restant;
  return coalesce(v_restant, 0);
end $$;

-- 5) Et pour toute table/fonction future : couper les droits par défaut
alter default privileges in schema public revoke execute on functions from public, anon, authenticated;
alter default privileges in schema public revoke all    on tables    from anon, authenticated;
```

> Le point 5 est le plus important pour l'après : sans lui, **la prochaine migration écrite par quelqu'un d'autre rouvrira le trou**. `00070_entrepots.sql` a pensé à révoquer ; rien ne garantit que la 00090 y pensera.

---

## SEC-02 — CRITIQUE — Double authentification désactivée

**Où** : `supabase/functions/rpc/supa.ts:32` et `apps/web/src/App.tsx:35`

```ts
// serveur
const MFA_REQUISE = (Deno.env.get('MFA_REQUISE') ?? 'false').toLowerCase() === 'true';
// client
const MFA_REQUISE = false;
```

Le commentaire est explicite : *« ⚠ À REMETTRE À `true` avant la mise en production réelle (données douanières). »* Ça n'a pas été fait. Conséquence : un mot de passe seul suffit — et voir SEC-03, on connaît ce mot de passe.

Le côté client est **en dur** : passer `MFA_REQUISE=true` côté Supabase ne suffit pas, il bloquera simplement tout le monde avec « Double authentification requise » sans jamais proposer l'écran d'enrôlement. Les deux doivent bouger ensemble, et le front doit être rebâti et redéployé.

**Corriger** : lire la variable côté front (`import.meta.env.VITE_MFA_REQUISE`) plutôt qu'une constante, activer côté Edge Function, puis enrôler les agents un par un (le QR TOTP est déjà codé, `App.tsx:174`). Prévoir 2 codes de secours imprimés par agent, conservés en coffre.

**Détail annexe** : `supa.ts:49` lit le niveau `aal` en décodant le JWT sans vérification de signature (`jwtPayload`). Ici c'est acceptable — `db.auth.getUser(jwt)` a validé le jeton juste avant — mais c'est fragile : si l'ordre des deux appels est inversé un jour, le contrôle 2FA devient contournable par un jeton forgé. Préférer la valeur retournée par l'API d'authentification.

---

## SEC-03 — CRITIQUE — Mot de passe unique et connu pour tous les comptes

**Où** : `scripts/migration/creer-comptes.ts:41`

```ts
const MDP_CONFIG = process.env.MOT_DE_PASSE_PROVISOIRE ?? 'CargoPia2026';
```

Tous les comptes créés par la migration partagent ce mot de passe. Combiné à :

- **aucun changement forcé à la première connexion** (rien dans `App.tsx` ni dans `exigerSession`) ;
- **minimum 6 caractères** (`utilisateurs.ts:37, 96, 118`) sans exigence de complexité ;
- **2FA désactivée** (SEC-02) ;
- des **identifiants devinables et publiés** : les noms d'utilisateur apparaissent en clair dans l'historique, les rapports et les exports ;
- **5 comptes n'ont jamais servi** (`ppp`, `maxi_id`, `nawou`, `lokou`, `max`) mais sont **tous actifs** — donc encore sur le mot de passe d'origine, avec certitude.

… n'importe qui connaissant l'URL et un identifiant entre dans le système, **y compris sur un compte ADMIN** (7 des 17 comptes sont ADMIN, cf. GOV-04).

Toute la logique anti-fraude « 1 cellule = 1 rôle » repose sur l'identité de l'agent. Ici l'identité ne vaut rien.

**Corriger, dans l'ordre** :
1. Réinitialiser **tous** les mots de passe avec `MOT_DE_PASSE_PROVISOIRE=ALEATOIRE` (le mode existe déjà, `creer-comptes.ts:44`), remise en main propre, destruction du CSV.
2. Porter le minimum à 12 caractères dans les trois contrôles de `utilisateurs.ts`.
3. Ajouter un drapeau `profils.doit_changer_mdp` positionné à la création/réinitialisation, testé dans `exigerSession`, qui n'autorise que `account.me` et `account.changepwd` tant qu'il est vrai.
4. Activer la 2FA (SEC-02).
5. Désactiver les 5 comptes dormants (`user.toggle`).

---

## SEC-04 — ÉLEVÉ — La chaîne d'audit n'est ni clefée ni vérifiée

**Où** : `00010_schema.sql:240-286`, `scripts/migration/reset.sql:33`, `rapports.ts:1248`

Trois faiblesses cumulées :

1. **Hachage non clefé.** `hash = sha256(prev_hash || ts || user || role || action || …)` sans secret. Quiconque a l'accès en écriture à la base (SQL Editor, clé `service_role`, ou SEC-01) peut modifier une ligne **et recalculer toute la chaîne en aval** : `fn_audit_verifier()` ne verra rien. Une chaîne non clefée protège contre l'accident, pas contre l'insider — or c'est précisément l'insider que le journal doit couvrir dans un contexte douanier.

2. **Jamais vérifiée.** `fn_audit_verifier()` n'est appelée qu'une fois, dans `scripts/migration/importer-historique.ts:106`. En exploitation, **rien** ne la déclenche. La preuve d'intégrité existe et ne sert à personne.

3. **Remise à zéro documentée.** `reset.sql` explique lui-même que *« TRUNCATE contourne le verrou append-only (le déclencheur bloque UPDATE/DELETE, pas TRUNCATE) »*. Le script est dans le dépôt, prêt à l'emploi.

À quoi s'ajoute que **l'écriture du journal est silencieusement faillible** (`supa.ts:60-71`) : `fabriquerLog` enveloppe l'insertion dans un `try/catch`, mais le client Supabase **ne lève pas** en cas d'erreur — il retourne `{ error }`, qui n'est jamais lu. Un échec d'insertion ne produit donc ni exception, ni `console.error`, ni alerte. L'opération métier réussit, la trace disparaît.

**Corriger** :
- Passer à un HMAC-SHA256 avec une clé stockée **hors base** (secret Supabase, injecté par variable d'env dans une fonction dédiée) — ou, à défaut, ancrer quotidiennement le hash de tête : tâche planifiée qui écrit `(date, id_max, hash_tete)` dans un support hors du contrôle des exploitants (e-mail signé au chef de division, export S3 en écriture seule, ou simple impression contresignée).
- Appeler `fn_audit_verifier()` une fois par jour et alerter si le retour n'est pas `null`.
- Corriger `fabriquerLog` : lire l'erreur retournée, la journaliser, et **compter** les échecs (métrique).
- Retirer `reset.sql` du dépôt ou le renommer explicitement (`DANGER_reset_donnees.sql`) avec une garde `\prompt`.

---

## SEC-05 — ÉLEVÉ — Aucune traçabilité des connexions

L'authentification est déléguée à Supabase Auth, et **aucune action de connexion/déconnexion n'est journalisée dans `audit_log`** en v4. Pire, `rapports.ts:1253` filtre activement ce qui pourrait en rester :

```ts
q = q.not('action', 'ilike', '%connexion%');   // « Connexions = bruit »
```

La v3.6 les enregistrait (1 224 « Connexion » et 486 « Déconnexion » dans l'historique importé). On a donc **régressé** : impossible de répondre à « qui s'est connecté cette nuit », « depuis quelle adresse », « combien de tentatives échouées ».

Corollaire : **aucune limitation de débit ni protection anti-force brute** dans `index.ts` (aucune occurrence de `rate`, `throttle`, `captcha` dans le code). La fonction est déployée avec `--no-verify-jwt` (`DEPLOIEMENT.md`), donc joignable sans clé : le contrôle repose entièrement sur `exigerSession`, sans compteur.

**Corriger** : journaliser `Connexion` / `Échec de connexion` / `Déconnexion` avec IP et user-agent depuis l'Edge Function (une action `account.signin` appelée après authentification), retirer le filtre de `listerHistorique` et le remplacer par une case à cocher « masquer les connexions », activer les protections anti-brute-force côté Supabase Auth, et ajouter un compteur d'appels par utilisateur dans l'Edge Function.

---

## SEC-06 — ÉLEVÉ — `SECURITY DEFINER` sans `search_path` figé

Les six fonctions `SECURITY DEFINER` (`fn_audit_chain`, `fn_audit_verifier`, `fn_next_ref`, `fn_apurer_inc`, `fn_lier_stock`, `fn_import_audit`) n'ont pas de `SET search_path`. C'est le vecteur d'élévation de privilèges classique en PostgreSQL : un rôle capable de créer un objet dans un schéma antérieur du `search_path` peut détourner `digest()`, `now()` ou la résolution de `audit_log` et faire exécuter son code avec les droits du propriétaire. Le linter Supabase le signale sous `function_search_path_mutable`.

**Corriger** : les `ALTER FUNCTION … SET search_path` du bloc SEC-01.

---

## SEC-07 — MOYEN — CORS ouvert à tous les domaines

**Où** : `supabase/functions/rpc/index.ts:19`

```ts
'Access-Control-Allow-Origin': '*', // à restreindre au domaine Netlify en production
```

Le commentaire dit ce qu'il faut faire. Le jeton étant porté par un en-tête `Authorization` (et non un cookie), ce n'est pas une faille CSRF ; mais cela autorise **n'importe quel site** à appeler l'API métier depuis le navigateur d'un agent connecté si le jeton fuit, et cela supprime une barrière de confinement gratuite. La CSP de `netlify.toml` verrouille bien le sens sortant ; le sens entrant reste ouvert.

**Corriger** : refléter l'origine uniquement si elle figure dans une liste blanche (`https://<site>.netlify.app`, domaine propre), sinon refuser. Ajouter `Vary: Origin`.

---

## SEC-08 — MOYEN — Messages d'erreur bruts renvoyés au client

**Où** : `index.ts:47` — `return json({ ok: false, error: err.message … })`

Toutes les erreurs PostgREST/PostgreSQL remontent telles quelles : noms de contraintes, de colonnes, de tables, messages de violation de clé. C'est une cartographie gratuite du schéma pour un attaquant, et c'est incompréhensible pour un agent. Le code métier lève de bons messages en français ; les erreurs techniques, elles, ne devraient pas sortir.

**Corriger** : distinguer erreurs métier (classe dédiée, message affiché) et erreurs techniques (message générique + identifiant de corrélation journalisé côté serveur).

---

## SEC-09 — MOYEN — Le rôle ADMIN peut usurper n'importe quel agent

`user.resetpwd` (`utilisateurs.ts:96`) et `user.resetmfa` (`utilisateurs.ts:108`) permettent à un ADMIN de fixer le mot de passe de **n'importe quel compte** et d'en supprimer les facteurs 2FA — y compris ceux d'un autre ADMIN ou du chef de brigade. Il peut ensuite se connecter sous cette identité et poser une signature de validation, un T1, une balise. Le journal enregistrera la réinitialisation, mais **rien ne distinguera** ensuite l'agent légitime de l'usurpateur : `signature_validation` ne couvre que `id|username|now`.

Avec 7 ADMIN sur 17 comptes (GOV-04), la séparation des tâches est nominale.

**Corriger** :
- Réduire ADMIN à 2 comptes nominatifs, jamais partagés, avec 2FA obligatoire.
- Créer un rôle `SUPPORT` (lecture + réinitialisation de mot de passe) distinct de l'ADMIN technique.
- Journaliser la réinitialisation **et** forcer `doit_changer_mdp` : l'agent constate au retour que son mot de passe a changé.
- Interdire à un ADMIN de réinitialiser un autre ADMIN sans double validation.

---

## SEC-10 — MOYEN — La « signature de validation » ne signe rien

**Où** : `helpers.ts:signature()` + `ecriture.ts:361`

```ts
const sig = await signature(id + '|' + ctx.session.username + '|' + now);
```

16 caractères hexadécimaux d'un SHA-256 de trois éléments qui ne décrivent **pas le contenu validé** : ni les conteneurs, ni la déclaration, ni la pesée, ni le nombre de colis. Modifier après coup la déclaration ou les conteneurs d'une cargaison validée laisse la signature intacte. Elle donne une impression de garantie qu'elle n'apporte pas.

De plus, `valider()` autorise un ADMIN à re-valider une cargaison déjà validée : la date, l'agent et la signature d'origine sont **écrasés**. Le premier signataire disparaît de la fiche.

**Corriger** : signer un condensé canonique des champs validés (déclaration, liste des conteneurs et scellés, nombre de colis, pesée) ; conserver l'historique des validations dans une table dédiée plutôt que d'écraser.

---

## SEC-11 — MOYEN — Renumérotation du camion ouverte à tous les rôles, à tout statut

**Où** : `permissions.ts` — `'cargo.editcamion': TOUS_ROLES` (marqué « I-3 conservé ») ; `ecriture.ts:611`

Aucun contrôle de statut : le numéro d'immatriculation — l'élément identifiant du bon de sortie et de l'ordre d'exécution — est modifiable par les 10 rôles, y compris **après la sortie du camion**.

Ce n'est pas théorique. Dans l'historique de production : **638 corrections de N° camion**, soit 1 mouvement sur 8, dont **442 par la cellule BALISE** et **143 par la PP** (7 après l'enregistrement de la sortie). Deux cellules qui n'ont, métier, aucune légitimité à réécrire la plaque.

**Corriger** : restreindre à `[CFS, CHEF_BRIGADE, ADMIN]`, interdire après `date_validation` (sauf ADMIN avec motif obligatoire), et rendre le motif obligatoire dans tous les cas — il alimentera l'audit.

---

## SEC-12 — MOYEN — Suppression définitive d'une cargaison, à n'importe quel statut

**Où** : `ecriture.ts:631` (`cargo.delete`, ADMIN)

`supprimerCargo` efface la ligne `cargaisons` ; la contrainte `on delete cascade` emporte toutes les lignes `conteneurs`. **Aucun contrôle de statut** : une cargaison « Sortie Enregistrée », validée et signée, peut être effacée. Il ne reste qu'une ligne d'audit contenant le numéro de camion et le type d'opération — ni la déclaration, ni les conteneurs, ni les scellés.

Pour une écriture douanière, c'est une destruction de pièce.

**Corriger** : passer en suppression logique (`annule boolean`, `annule_par`, `annule_motif`, `annule_le`), exclue des listes et des rapports mais conservée ; interdire l'annulation au-delà de la validation du chef de brigade ; sauvegarder l'enregistrement complet en JSON dans le détail d'audit avant toute suppression.

---

## SEC-13 — MOYEN — La liste de contrôle de la Porte Principale peut contredire la base

**Où** : `ecriture.ts:562-569`

La PP doit cocher quatre contrôles (CFS, T1, Balise, Bon de sortie) pour enregistrer la sortie. Ces quatre cases sont **purement déclaratives** : le serveur vérifie qu'elles sont cochées, jamais qu'elles correspondent à la réalité. Or `etapesEnAttente` n'exige que T1 **et** Balise — le bon de sortie est explicitement non bloquant. Un camion peut donc sortir avec `bon_sortie_numero` vide **et** `pp_checklist.bs = true` enregistré : le système consigne un contrôle qui n'a pas pu avoir lieu.

**Corriger** : calculer les quatre cases côté serveur à partir des données, les présenter à l'agent en lecture seule, et refuser la sortie (ou exiger un motif de dérogation tracé) si l'une est fausse.

---

## SEC-14 — FAIBLE — Points vérifiés, sans anomalie

Pour être complet, ces pistes ont été examinées et ne présentent pas de défaut :

- **Injection SQL** : aucune concaténation SQL ; tout passe par PostgREST paramétré.
- **XSS** : les rapports HTML côté serveur échappent systématiquement (`esc()` dans `rapports.ts:81-89, 760, 1104-1110`) ; la CSP de `netlify.toml` est stricte (`script-src 'self'`, `frame-ancestors 'none'`) ; l'impression via `window.open` + `document.write` (`screens.tsx:1469`) hérite de cette CSP. Le legacy `apps-script/Client.html` utilise massivement `innerHTML` mais échappe lui aussi via `esc()`.
- **Secrets en dur** : aucun. `service_role` n'existe qu'en variable d'environnement ; la clé `anon` exposée dans `apps/web/.env` et le bundle est publique par conception, correctement documentée dans `netlify.toml`.
- **`.gitignore`** : correctement rédigé — `*.xlsx`, `comptes-provisoires.csv`, `backup_data.sql`, `.env` sont exclus, avec des commentaires qui en expliquent la raison. Bonne pratique.
- **Concurrence** : `patchCargo` implémente une concurrence optimiste correcte sur `derniere_maj` ; les compteurs sont atomiques en SQL.
- **En-têtes HTTP** : HSTS, `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy` tous présents et bien réglés.

---

# Partie B — Continuité : que le système survive à votre départ

## GOV-01 — ÉLEVÉ — Dépôt Git local corrompu, backend absent du disque

`git fsck --full` remonte **11 objets à l'emplacement erroné** (« hash-path mismatch », selon un décalage régulier `5a→69`, `7a→89`, `ba→c9`, `ea→f8` — signature typique d'une synchronisation cloud ou d'un antivirus ayant réécrit `.git/objects/`), **5 arbres/blobs manquants**, et `git archive HEAD` échoue.

Par ailleurs, **tout le backend a disparu du répertoire de travail** : `supabase/`, `packages/`, `scripts/` sont marqués supprimés (48 fichiers). Seuls `apps/` et `apps-script/` sont encore sur le disque.

**Ce qui sauve la situation** : `origin/main` et `HEAD` pointent sur le même commit `c3994ae`. Le code est intact sur GitHub. Un seul fichier, `normalisation.ts`, est irrécupérable **localement** — il est présent sur le distant.

**À faire aujourd'hui** :

```bash
cd "C:/Users/x/Documents"
git clone https://github.com/cfscell2026-maker/cargo-tracker-v4.git CARGO-TRACKER-SAIN
cd CARGO-TRACKER-SAIN && git fsck --full && git log --oneline -1
```

Si le clone est propre, recopier `apps/web/.env` et le fichier `.xlsx` (non versionnés) dans le nouveau dossier, puis **archiver** l'ancien répertoire sans le supprimer immédiatement. Exclure ensuite le dossier de travail de toute synchronisation OneDrive/Drive et de l'analyse temps réel de l'antivirus — c'est la cause la plus probable.

## GOV-02 — ÉLEVÉ — Facteur bus = 1

Aujourd'hui, une seule personne détient : le compte GitHub `cfscell2026-maker`, la clé `service_role`, l'accès au projet Supabase, l'accès Netlify, le fichier `.env`, et la connaissance du déploiement. Rien de tout cela n'est documenté à destination d'un successeur.

**À mettre en place, dans l'ordre :**

1. **Deux dépositaires nommés** (par exemple le chef de division et un référent informatique) avec accès propriétaire à Supabase, Netlify et GitHub. Comptes nominatifs, jamais partagés.
2. **Coffre de secrets** hors ligne : enveloppe scellée au coffre contenant `SUPABASE_SERVICE_ROLE_KEY`, les identifiants propriétaires, et la procédure de rotation. Datée, contresignée, à ré-ouvrir/re-sceller à chaque rotation.
3. **Runbook d'exploitation** (`EXPLOITATION.md`) couvrant : redéployer le front, redéployer l'Edge Function, appliquer une migration, restaurer la base à un instant T, créer/désactiver un agent, faire tourner la clé `service_role`, et « que faire si l'application ne répond plus ». Chaque procédure testée une fois, en présence du successeur.
4. **Sauvegardes vérifiées.** `DEPLOIEMENT.md:134` recommande d'activer le PITR (plan Pro) — **à confirmer que c'est fait**. Une sauvegarde jamais restaurée n'est pas une sauvegarde : programmer une restauration à blanc sur un projet Supabase jetable, une fois par trimestre.
5. **Export hors plateforme** : `pg_dump` hebdomadaire chiffré, conservé sur un support qui n'appartient pas à Supabase. Un incident de compte (facturation, suspension) ne doit pas emporter les données douanières.
6. **Supervision** : `CONCEPTION_V4.md:19` annonce « alertes Sentry » et la CSP autorise `*.ingest.sentry.io` — **Sentry n'est câblé nulle part** dans `apps/web/src`. Aujourd'hui, si l'Edge Function tombe, personne n'est prévenu. Câbler Sentry (ou un simple contrôle de disponibilité + alerte e-mail) et l'adresser à une **liste** de destinataires, pas à une personne.

## GOV-03 — MOYEN — Deux systèmes vivants en parallèle

`DEPLOIEMENT.md` indique que le Google Sheet et l'application Apps Script v3.6 « restent intacts et continuent de tourner jusqu'à la bascule finale ». Il existe donc, aujourd'hui, **deux portes d'entrée** sur les mêmes données douanières — dont l'ancienne, dont l'authentification repose sur un SHA-256 itéré avec sel maison (`apps-script/Auth.gs:13-17`) et une session en `CacheService`, sans 2FA.

Tant que la bascule n'est pas prononcée, la surface d'attaque est celle du **maillon le plus faible**. Et l'export `.xlsx` posé à la racine du projet contient les 17 empreintes de mots de passe v3.6 et les coordonnées de 5 022 déclarants.

**À faire** : fixer et écrire une date de bascule ; le jour venu, révoquer les accès au Sheet (lecture seule pour les archives), retirer le déploiement Apps Script, et **chiffrer ou déplacer l'export `.xlsx`** hors du répertoire de travail (il est correctement exclu de Git, mais il est en clair sur le poste).

## GOV-04 — MOYEN — Répartition des rôles incohérente avec le modèle anti-fraude

Les 17 comptes de production se répartissent ainsi :

| Rôle | Comptes |
|---|---|
| ADMIN | **7** |
| CFS | 5 |
| PP | 3 |
| BALISE | 2 |
| T1 | **0** |
| BON_SORTIE | **0** |
| CHEF_BRIGADE / ADJOINT / VISITE / DIVISION | **0** |

41 % des comptes sont ADMIN, c'est-à-dire dispensés de toutes les règles de cellule (`role !== ROLES.ADMIN` court-circuite les contrôles de statut dans `t1`, `gps`, `bonsortie`, `sortie`, `valider`). Et quatre des six cellules du parcours n'ont **aucun titulaire** — voir DAT-01, qui en montre la conséquence dans les données.

**À faire** : ramener ADMIN à 2, nommer des titulaires T1, Bon de sortie et Chef de brigade, ou bien **acter formellement** que ces cellules n'existent pas au PIA Dry Port et retirer les étapes correspondantes du parcours (voir DAT-01 : en l'état, la v4.1 va bloquer les sorties).

## GOV-05 — MOYEN — Charge technique qui grandit toute seule

Plusieurs lectures rapatrient **des tables entières** dans la mémoire de l'Edge Function avant de filtrer en JavaScript :

- `chargerResume()` (`lecture.ts:23`) — lit les 5 022 cargaisons **à chaque recherche, à chaque liste, à chaque affichage du tableau de bord** ;
- `stockList`, `annonceList` — table `stock` entière (~6 000 lignes) ;
- `entrepotEntrees` — appelée **à l'intérieur de** `entrepotSortie` pour un simple calcul de restant ;
- `stockPointage` — rappelle `stockList` complet pour renvoyer 4 compteurs ;
- `rapportHistorique` — `pageSize: 100000` sur `audit_log`.

À 5 000 cargaisons, ça passe. Le volume de production a été de **5 022 mouvements en un mois** (période couverte : 15/06 → 15/07/2026). À ce rythme, la table dépassera 60 000 lignes d'ici un an et 300 000 en cinq ans. Les Edge Functions Deno ont des limites de mémoire et de durée : le système ralentira, puis renverra des erreurs, sans que personne n'ait rien changé — et la facture d'egress Supabase suivra la même courbe.

**À faire** : porter les filtres, tris et paginations côté SQL (vues + index, `.range()` sur la requête et non après coup), et remplacer les statistiques du tableau de bord par des vues matérialisées rafraîchies périodiquement.

---

# Partie C — Données à caractère personnel

Contexte applicable : loi togolaise **n° 2019-014** relative à la protection des données à caractère personnel (autorité : APDP), et RGPD si des données transitent par l'UE — ce qui est le cas ici, le projet Supabase étant hébergé en région Europe (`DEPLOIEMENT.md`, étape 1).

## RGPD-01 — ÉLEVÉ — Coordonnées des déclarants visibles par tous

`cargo.get` est ouvert à `TOUS_ROLES` et renvoie **toutes** les colonnes de la cargaison ; `filtrerConfidentiel` (`lecture.ts:38`) ne retire que `horsGabarit` et `hauteurChargement`. Sont donc lisibles par les 10 rôles :

- `contact_declarant` — renseigné sur **5 022/5 022** enregistrements, dont **5 009 numéros de téléphone** ;
- `declarant`, `description_marchandise`, `destination_marchandise` ;
- `numero_gps` — le numéro de la balise de transit.

Par ailleurs `report.cargaisons` et `report.conteneurs` sont ouverts à `TOUS_ROLES` (v4.1) : **n'importe quel agent peut exporter en Excel l'intégralité du fichier**, coordonnées comprises, et l'emporter.

Le numéro de balise mérite une mention à part : le communiquer aux 10 rôles, alors qu'il désigne le dispositif censé garantir le transit, est un risque opérationnel autant que de confidentialité.

**Corriger** : étendre `filtrerConfidentiel` à `contactDeclarant` (visible seulement CFS + chefs + ADMIN), masquer `numeroGps` hors cellule Balise/PP/chefs, restreindre `report.cargaisons`/`report.conteneurs` aux profils qui en ont l'usage, et journaliser tout export nominatif (l'action `Export XLSX` existe déjà dans le journal — la rendre systématique et non contournable).

## RGPD-02 — MOYEN — Aucune politique de conservation

Aucune durée de conservation n'est définie, ni pour les données de mouvement, ni pour le journal d'audit, ni pour les coordonnées de déclarants. Le principe de limitation de la conservation impose de fixer une durée et de purger — sachant qu'ici la durée sera longue et justifiée (obligations douanières), mais elle doit être **écrite**.

**Corriger** : documenter dans un registre de traitement : finalité, base légale, catégories de personnes (agents, déclarants, transporteurs), destinataires, durée (proposition : 10 ans pour les mouvements et l'audit, alignés sur la prescription douanière ; anonymisation du `contact_declarant` au-delà de 3 ans), et procédure d'exercice des droits.

## RGPD-03 — MOYEN — Le journal d'audit est aussi un fichier de surveillance des agents

`audit_log` conserve, par agent nommé, chaque action et chaque consultation de rapport. C'est légitime et nécessaire (anti-fraude). Mais c'est un traitement de données de salariés qui doit être **déclaré aux intéressés** : information des agents, interdiction d'usage à des fins disciplinaires hors procédure, accès au journal restreint (`log.list` est bien limité à ADMIN — c'est correct).

**Corriger** : note d'information affichée à la première connexion et annexée au règlement intérieur.

---

# Partie D — Expertise douanière : incohérences relevées dans les données

Analyse portant sur l'export de production du 14/06/2026 (période couverte 15/06 → 15/07/2026) : 5 022 cargaisons, 6 331 lignes conteneurs, 17 017 événements.

## DAT-01 — CRITIQUE — Le transit sort sans T1 et sans bon de sortie

Sur **17 017 événements** d'audit :

| Action | Occurrences |
|---|---|
| Saisie T1 | **0** |
| Bon de sortie | **0** |
| Validation chef brigade | **0** |
| Hors gabarit | **0** |
| Enregistrement sortie | 4 857 |
| Affectation GPS | 4 751 |

Or **4 910 cargaisons sur 5 022 sont de type « T » (transit)**, à destination du Burkina Faso (4 010), du Niger (476) et du Mali (242) — des mouvements sous régime de transit vers des pays enclavés, précisément ceux qui exigent un document T1 et une escorte/balise.

Autrement dit : le parcours réellement pratiqué est **CFS → Balise → Porte Principale**. Les cellules T1, Bon de sortie et Validation chef brigade sont codées, testées, dotées de permissions… et **n'ont jamais servi**. Aucun numéro de T1 n'est enregistré dans le système pour 4 910 transits.

**Deux conséquences, dont une immédiate et bloquante :**

1. **Sur le plan douanier** : le système ne porte aucune trace du document de transit. En cas de contrôle a posteriori ou de contentieux (marchandise non représentée au bureau de destination), l'exploitant ne peut pas produire le lien camion ↔ T1 ↔ conteneur. La table `declarations` suit un apurement en nombre de conteneurs, ce qui n'est pas l'apurement du régime.

2. **Sur le plan opérationnel — à traiter avant toute mise en production** : la v4.1 a **réactivé le verrou PP** (`workflow.ts:76-84`, décision du 27/07/2026) — la Porte Principale ne peut clôturer que si le T1 **et** la Balise sont faits. Comme aucune cellule T1 n'existe et qu'aucun compte T1 n'est créé, **tous les camions en transit seront bloqués à la sortie** dès la bascule. Seul un ADMIN pourra forcer, ce qui ramènera tout le monde sur les comptes ADMIN.

**Trancher, avant la bascule** : soit la cellule T1 est réellement mise en place (comptes, agents, procédure) ; soit `saute_t1` est positionné par nature pour les flux concernés et le verrou PP est retiré. La situation actuelle — un verrou logiciel sans cellule pour le lever — est la pire des trois.

## DAT-02 — ÉLEVÉ — Balises GPS incohérentes

**11 balises posées sur deux cargaisons simultanément.** Exemples (balise, cargaison A sortie le, cargaison B balisée le) :

| Balise | Cargaison A (sortie) | Cargaison B (pose) |
|---|---|---|
| 296680 | CT-2026-000088 — 20/06 12:47 | CT-2026-000827 — **19/06 20:04** |
| 845770 | CT-2026-001536 — 02/07 15:41 | CT-2026-002595 — **01/07 17:39** |
| 497680 | CT-2026-000312 — 26/06 08:46 | CT-2026-001116 — **20/06 23:06** |
| 529630 | CT-2026-001670 — 05/07 12:45 | CT-2026-002477 — **30/06 13:58** |

Un dispositif physique ne peut pas être scellé sur deux camions à la fois. Soit la balise a été retirée sans que la sortie du premier camion soit enregistrée à l'heure (les dates de sortie sont alors fausses), soit le numéro a été saisi de mémoire sur le second. Dans les deux cas, la traçabilité du transit est rompue sur ces mouvements.

**172 sorties enregistrées moins de 5 minutes après la pose de la balise** (délai médian : 1,8 h ; p90 : 5,8 h). Physiquement difficile : pose, contrôle et franchissement en moins de 300 secondes. Signature d'une saisie groupée a posteriori plutôt que d'une saisie au fil de l'eau.

**Format du numéro de balise non contrôlé** : longueurs relevées de **1 à 7 caractères** — 10 balises portent un numéro d'**un seul caractère**, 8 en portent deux, alors que 3 848 en portent cinq (la norme). Un numéro à un chiffre n'est pas rattachable à un dispositif.

**16 cargaisons restent au statut « GPS Installé »** sans sortie enregistrée : autant de balises immobilisées, non restituées, dont deux portent des numéros manifestement erronés (`40286720`, `7212160`).

**Corriger** : contrainte de format sur `numero_gps` (5 à 7 chiffres) ; contrôle serveur d'unicité — refuser la pose d'une balise déjà posée sur une cargaison non sortie ; module d'inventaire des balises (parc, posée, restituée, perdue) ; alerte au-delà de 48 h au statut « GPS Installé ».

## DAT-03 — ÉLEVÉ — 131 transits sans balise ni dispense

131 cargaisons de type **T** n'ont **ni numéro de balise, ni dispense déclarée** (`balise_requise` non renseigné à « Non »). À l'inverse, la règle est bien respectée pour les types C/A : 108 sur 112 sont sans balise, ce qui est conforme.

Ces 131 mouvements sont sortis du port sec sous régime de transit sans dispositif de suivi et sans autorisation de dispense enregistrée. C'est le point qu'un contrôle externe relèvera en premier.

**Corriger** : contrôle bloquant côté serveur — un type T ne peut atteindre la Porte Principale qu'avec un numéro de balise **ou** un numéro d'autorisation de dispense. Le code v4.1 a bien introduit la « vraie dispense » (`estDispenseBalise`, `workflow.ts:104`) ; il reste à en faire une condition de sortie. Et régulariser les 131 cas historiques par une note motivée.

## DAT-04 — ÉLEVÉ — Numéros de conteneurs invalides

Contrôle ISO 6346 (format + clé de contrôle) sur les 6 331 lignes conteneurs :

| Constat | Nombre | Part |
|---|---|---|
| Format non conforme (`AAAA9999999`) | **146** | 2,3 % |
| Format bon mais **clé de contrôle fausse** | **391** | 6,2 % |
| **Total suspect** | **537** | 8,5 % |

Exemples de formats non conformes : `FSCUU8855505` (5 lettres), `PCU 952356-9`, `DRYU9338213-9`, `TCN2487235`, `MEDU 5071313`, `PIDU41197478`, `GAIU701642/1`.

Deux conséquences distinctes :

1. **Migration** : la contrainte v4 `conteneur_iso6346 check (conteneur ~ '^[A-Z]{4}[0-9]{7}$')` (`00010_schema.sql:159`) rejettera **188 lignes conteneurs réparties sur 179 cargaisons**. Elles n'entreront pas en base — le `.gitignore` prévoit d'ailleurs un fichier `conteneurs-rejetes.csv`. Ces 179 cargaisons migreront donc avec un ou plusieurs conteneurs manquants, faussant le comptage et l'apurement.
2. **Exploitation** : les 391 numéros à clé fausse **passeront** la contrainte (elle ne vérifie pas la clé) mais ne correspondent à aucun conteneur réel. Impossible de rapprocher le fichier du manifeste de la compagnie maritime ou du port autonome.

**Corriger** : implémenter le calcul de la clé ISO 6346 dans `tcValide()` — en **avertissement** à la saisie (certains propriétaires historiques ne la respectent pas) et en **rapport hebdomadaire** des numéros douteux ; traiter les 188 rejets à la main avant la bascule, ne pas les laisser tomber silencieusement.

## DAT-05 — MOYEN — Conteneurs comptés plusieurs fois

- **67 numéros de conteneur apparaissent sur plusieurs cargaisons distinctes.**
- **17 lignes conteneur strictement dupliquées** (même conteneur, même cargaison, deux lignes).
- **6 cargaisons déclarent 1 à 2 conteneurs mais n'ont aucune ligne dans la table Conteneurs** (`CT-2026-001334`, `-003190`, `-003191`, `-003192`, `-003195`, `-004490`).
- **2 numéros de camion** portent plusieurs cargaisons actives simultanément.

Chaque doublon compte deux fois dans l'apurement d'une déclaration ; chaque cargaison sans ligne compte zéro. La table `declarations` (`conteneurs_apures`) hérite mécaniquement de ces écarts.

**Corriger** : contrainte d'unicité `(cargaison_id, conteneur)` sur `conteneurs` ; contrôle serveur refusant un conteneur déjà rattaché à une cargaison non sortie (la détection existe — `cargo.checkdup` — mais elle est explicitement « AVERTISSEMENT, jamais bloquant », `lecture.ts:168`) ; contrôle de cohérence `nb_conteneurs` = nombre de lignes, exécuté en tâche quotidienne.

## DAT-06 — MOYEN — Référentiels absents : déclarants, destinations, numéros de déclaration

**Déclarants** — 265 noms distincts saisis en texte libre, dont **36 groupes de quasi-doublons** :

`ALO TRANS` / `ALOTRANS` · `ENI TRANS` / `ENITRANS` · `CRÉPUSCULE` / `CREPUSCULE` · `LOUKMAN` / `LOUKOUMAN` / `LOUKUMAN` · `AVE TRANS` / `AVE-TRANS` / `AVETRANS` · `FAVOR T` / `FAVOR -T` / `FAVOR  T` / `FAVORT` · `DEO GRACIAS` / `DEOGRACIAS` · `ABEL ET FILS` / `ABEL ET  FILS` …

Toute statistique par déclarant est donc fausse, et un opérateur peut apparaître sous plusieurs identités — ce qui neutralise tout ciblage fondé sur l'historique d'un déclarant.

**Destinations** — texte libre également : `BF` (4 010) mais aussi `NIGER` (476) et `NE` (17), `MALI` (242) et `ML` (8), `TG` (70) / `TOGO` (24) / `LOME` (70), `CI` (18), `VILLE` (7), et 8 vides. Le rapport `report.destinations` (v4.1) additionne donc des lignes qui devraient être fusionnées.

**Numéros de déclaration** — longueurs de **2 à 15 caractères** ; 4 822 sur 5 022 font 5 chiffres (la norme), soit **~200 hors norme**, dont 22 à deux chiffres seulement. Chaque numéro mal saisi crée une déclaration fantôme dans la table `declarations` et laisse la vraie déclaration non apurée.

**Une année de déclaration à `20262`** au lieu de `2026` (1 enregistrement) — aucun contrôle de plage.

**Corriger** : tables de référence `declarants` et `destinations` avec saisie par liste (et création contrôlée), contrainte de format sur `numero_declaration` (5 chiffres, avertissement au-delà) et sur `annee_declaration` (4 chiffres, plage année courante ± 1) ; campagne de dédoublonnage des 36 groupes avant la bascule.

## DAT-07 — MOYEN — Clé de déclaration ambiguë : 101 déclarations à plusieurs déclarants

**101 clés de déclaration sur 3 226** (3,1 %) portent **deux ou trois noms de déclarant différents** pour la même combinaison `année|bureau|type|numéro` :

| Clé | Déclarants relevés |
|---|---|
| T 16659/2026 TG120 | `MARCH-F`, `VIP` |
| T 16063/2026 TG120 | `REGIS`, `UNIC TRANS` |
| T 16743/2026 TG120 | `ENITRANS`, `SIL` |
| T 16654/2026 TG120 | `LOUKMAN`, `LOUKOUMAN`, `LOUKUMAN` |

Une partie relève de DAT-06 (variantes d'orthographe). Le reste signale soit une erreur de numéro de déclaration, soit deux déclarations réellement distinctes qui se télescopent sur la même clé.

Or dans la v4, `declarations.cle` est **clé primaire** et `declarant` y est stocké **une seule fois** : au premier apurement, le second déclarant disparaît silencieusement, et les conteneurs des deux déclarations sont additionnés sur une seule ligne d'apurement.

**Corriger** : rapport de contrôle listant les clés à déclarants multiples, à traiter avant la migration ; à terme, alerte à la saisie lorsqu'une déclaration existante est rappelée avec un déclarant différent.

## DAT-08 — MOYEN — L'apurement n'a pas de garde-fou

Trois faiblesses dans `helpers.ts` / `00020_fonctions.sql` :

1. **Pas de plafond** : `fn_apurer_inc` incrémente sans jamais vérifier que `conteneurs_apures` reste ≤ `nombre_conteneurs`. On peut apurer 12 conteneurs sur une déclaration qui en compte 8 ; le `greatest(0, …)` masque le dépassement en affichant « restant 0 ».
2. **Nombre déclaré facultatif** : `majApurement` accepte `nbDecl = 0` — « 0 = inconnu (apurement neutre) » (`helpers.ts`). Le restant vaut alors toujours 0 : une déclaration non apurée est indistinguable d'une déclaration soldée.
3. **Échec silencieux** : `majApurementSafe` enveloppe tout dans un `try { … } catch { /* best-effort */ }`. Toute erreur d'apurement est avalée sans trace. L'écart s'accumule sans que personne ne le voie.

**Corriger** : rendre `nombre_conteneurs` obligatoire à la création d'une déclaration ; lever une exception explicite en cas de dépassement (et la remonter à l'agent) ; remplacer le `catch` vide par une journalisation dans l'audit et un compteur d'échecs ; rapport hebdomadaire des déclarations en écart.

## DAT-09 — MOYEN — Course sur l'apurement des entrepôts (MAD / industriel)

`entrepotSortie` (`entrepots.ts:129-174`) contrôle le restant en lisant **toutes** les entrées et sorties, puis insère la sortie — sans verrou ni contrainte. Deux agents apurant le même article au même moment passent **tous les deux** le contrôle : le restant devient négatif, et le module affiche `Math.max(0, …)`, c'est-à-dire zéro. La marchandise sortie dépasse la marchandise entrée, sans alerte.

Deux autres points sur ce module :

- **Aucune correction possible.** Ni annulation d'une entrée, ni d'une sortie. Une erreur de saisie est définitive ; les agents la « compenseront » par une écriture inverse fictive, ce qui polluera les statistiques.
- **Deux systèmes d'apurement qui ne se parlent pas.** `declarations.conteneurs_apures` (conteneurs) et le restant d'entrepôt (colis ou kg) sont calculés indépendamment ; la « déclaration d'apurement » saisie en sortie d'entrepôt n'est jamais confrontée à la table `declarations`. Rien ne garantit qu'une déclaration soldée côté conteneurs le soit côté entrepôt, ni l'inverse.

**Corriger** : verrou consultatif (`pg_advisory_xact_lock` sur `entree_id||article`) ou contrôle en SQL dans une fonction transactionnelle ; actions d'annulation tracées (`entrepot.annulerentree`, `entrepot.annulersortie`, réservées aux chefs) ; rapprochement périodique entre les deux apurements.

## DAT-10 — FAIBLE — Signaux à surveiller

- **Compte partagé** : `kola` apparaît sous **deux identités différentes** dans le journal — `KOLA Abiré` et `KOLA Essohame`. Ce compte totalise **6 010 événements, soit 35 % de toute l'activité**. La non-répudiation est perdue sur plus d'un tiers du fichier : impossible de dire lequel des deux agents a posé un acte donné.
- **Concentration** : 4 comptes (`kola`, `nala`, `arizika`, `balibatoka`) concentrent **91 %** de l'activité. Absence, congé ou compromission de l'un d'eux arrête une partie du port sec.
- **Activité nocturne** : **9,6 % des événements entre 22 h et 5 h**, dont 346 entre minuit et 1 h. Cela peut être normal pour un port sec en activité continue — mais ce n'est pas contrôlé aujourd'hui, et depuis la v4 il n'y a même plus de trace de connexion pour le vérifier (SEC-05). À croiser avec les horaires de service.
- **148 remplacements de balise** (3 % des poses), tous par la cellule BALISE. Le remplacement leur a été ouvert le 20/07/2026 (auparavant réservé à l'ADMIN pour raison anti-fraude, cf. `permissions.ts`). Le garde-fou retenu — action possible au seul statut « GPS Installé » — est correct ; à surveiller par un rapport mensuel, un taux qui monterait au-delà de 5 % mériterait explication.
- **125 modifications de cargaison** (92 CFS, 33 ADMIN) : volume normal, à conserver sous suivi.
- **Séjours courts et sains** : durée médiane 0 jour, p90 1 jour, maximum 23 jours ; aucun conteneur au-delà de 30 jours, aucune cargaison non sortie de plus de 90 jours. Sur ce point, l'exploitation est bonne.
- **Aucune anomalie chronologique** (sortie antérieure à la création, balise antérieure à la création) : les horodatages sont cohérents entre eux.

---

# Plan d'action

## Vague 1 — sous 72 heures (rien ne doit attendre)

| # | Action | Réf. |
|---|---|---|
| 1 | Cloner le dépôt depuis GitHub dans un répertoire sain ; sortir le projet de toute synchronisation cloud | GOV-01 |
| 2 | Appliquer la migration `00090_durcissement_fonctions.sql` (REVOKE PUBLIC + search_path + DROP `fn_import_audit`) | SEC-01, SEC-06 |
| 3 | Réinitialiser **tous** les mots de passe en aléatoire ; désactiver les 5 comptes dormants | SEC-03 |
| 4 | Vérifier que le PITR Supabase est actif ; lancer une restauration à blanc | GOV-02 |
| 5 | Déplacer/chiffrer l'export `.xlsx` (empreintes de mots de passe + 5 009 numéros de téléphone) hors du répertoire de travail | GOV-03 |

## Vague 2 — sous 30 jours (avant toute mise en production réelle)

| # | Action | Réf. |
|---|---|---|
| 6 | Activer la 2FA des deux côtés ; enrôler les agents ; codes de secours au coffre | SEC-02 |
| 7 | **Trancher la question T1** : créer la cellule, ou retirer le verrou PP. Sans cela, la bascule bloque les transits | DAT-01 |
| 8 | Journaliser les connexions ; retirer le filtre `%connexion%` ; activer l'anti-brute-force | SEC-05 |
| 9 | Restreindre le CORS au domaine Netlify | SEC-07 |
| 10 | Restreindre `cargo.editcamion` ; passer `cargo.delete` en suppression logique | SEC-11, SEC-12 |
| 11 | Masquer `contactDeclarant` et `numeroGps` ; restreindre les exports | RGPD-01 |
| 12 | Ramener ADMIN à 2 comptes ; nommer les titulaires de cellule | GOV-04, SEC-09 |
| 13 | Traiter les 188 lignes conteneurs qui seront rejetées à la migration | DAT-04 |
| 14 | Contrôle bloquant balise/dispense pour les types T ; unicité de balise ; format du numéro | DAT-02, DAT-03 |

## Vague 3 — sous 90 jours (pérennité)

| # | Action | Réf. |
|---|---|---|
| 15 | Écrire `EXPLOITATION.md` ; nommer deux dépositaires ; sceller les secrets au coffre | GOV-02 |
| 16 | HMAC ou ancrage externe de la chaîne d'audit ; vérification quotidienne automatique | SEC-04 |
| 17 | Câbler Sentry (ou un contrôle de disponibilité) vers une liste de destinataires | GOV-02 |
| 18 | Référentiels déclarants / destinations ; dédoublonnage des 36 groupes ; contraintes de format | DAT-06, DAT-07 |
| 19 | Garde-fous d'apurement (plafond, nombre déclaré obligatoire, fin des échecs silencieux) ; verrou entrepôt | DAT-08, DAT-09 |
| 20 | Porter filtres/tris/pagination côté SQL ; vues matérialisées pour le tableau de bord | GOV-05 |
| 21 | Registre de traitement, durées de conservation, note d'information aux agents | RGPD-02, RGPD-03 |
| 22 | Contrôle ISO 6346 (clé) en avertissement ; unicité `(cargaison_id, conteneur)` ; rapport de cohérence quotidien | DAT-04, DAT-05 |

---

## Annexe — commandes de vérification

```bash
# Intégrité du dépôt
git fsck --full && git count-objects -v
git rev-parse HEAD origin/main       # doivent être identiques
```

```sql
-- SEC-01 : qui peut exécuter les fonctions ?
select p.proname,
       has_function_privilege('anon', p.oid, 'EXECUTE')   as anon,
       has_function_privilege('public', p.oid, 'EXECUTE') as public,
       p.prosecdef as security_definer,
       p.proconfig as search_path
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname like 'fn_%';

-- SEC-04 : intégrité de la chaîne d'audit (doit renvoyer NULL)
select fn_audit_verifier();

-- DAT-05 : conteneurs sur plusieurs cargaisons actives
select conteneur, count(distinct cargaison_id) n, array_agg(distinct cargaison_id)
from conteneurs group by conteneur having count(distinct cargaison_id) > 1;

-- DAT-02 : balises posées sur deux cargaisons non sorties
select numero_gps, count(*) n, array_agg(id)
from cargaisons
where numero_gps <> '' and statut <> 'Sortie Enregistrée'
group by numero_gps having count(*) > 1;

-- DAT-03 : transits sans balise ni dispense
select id, numero_camion, date_sortie
from cargaisons
where type_declaration = 'T' and numero_gps = ''
  and coalesce(balise_requise, true) is true and numero_dispense = '';

-- DAT-08 : déclarations en sur-apurement
select cle, nombre_conteneurs, conteneurs_apures
from declarations where conteneurs_apures > nombre_conteneurs and nombre_conteneurs > 0;
```

---

*Les scripts d'analyse des données (lecture XLSX, contrôle ISO 6346, corrélations audit) sont conservés dans le répertoire de travail temporaire de la session et peuvent être rejoués sur un export ultérieur.*
