# CARGO TRACKER v4.2 — État des lieux au 9 septembre 2026

**Document de travail commun.** Il remplace `AUDIT_SECURITE_2026-08-10.md` comme
référence de suivi : l'audit reste le document d'origine (constats, preuves,
recommandations), mais il a **un mois** et une grande partie de ses points a été
traitée depuis. Le lire aujourd'hui comme un état des lieux conduit à des
conclusions fausses.

| | |
|---|---|
| **Établi le** | 2026-09-09, **mis à jour le 2026-09-10** |
| **Sur quelle base** | Dépôt `cfscell2026-maker/cargo-tracker-v4`, commit `eb17df9` (2026-08-25), branche `main` |
| **Méthode** | Relecture du code point par point, puis **mesure en production** (SQL en lecture seule, 2026-09-09). Chaque ligne « corrigé » a été vérifiée dans un fichier nommé ci-dessous — aucune n'est reprise d'un document. |
| **Tests** | **168 au vert** (58 domaine · 91 actions serveur · 19 front) — dont 4 ajoutés pour la migration `00170` |
| **Types** | Front : aucune erreur. Edge Function : **3 erreurs préexistantes** (`TS2352`), et surtout **aucun script de contrôle ne couvre `supabase/functions/`** alors que le projet est en `strict: true` |

### Légende

| | |
|---|---|
| ✅ | **Corrigé** — vérifié dans le code |
| ⚙️ | **Corrigé dans le code**, mais l'effet dépend d'une variable d'environnement **non vérifiable sans accès à la production** |
| 🟡 | **Partiel** — une partie du garde-fou existe, l'autre manque |
| 🔴 | **Ouvert** — rien dans le code |
| 🤔 | **Décision à prendre** — le code est prêt, il attend un arbitrage métier |
| ➖ | Sans objet |

---

## Résumé en une phrase

**Toute la sécurité technique (SEC-01 → SEC-13) a été traitée** par le
prestataire avant le 2026-08-25. Ce qui reste ouvert n'est plus, pour l'essentiel,
du code : c'est l'**intégrité des données** (DAT), la **gouvernance** (GOV-02 →
GOV-05) et deux points RGPD.

Cette répartition n'est pas une impression : les identifiants `SEC-xx` sont cités
dans le code aux endroits corrigés, les identifiants `DAT-xx`, `GOV-xx`,
`RGPD-02/03` ne l'étaient **nulle part**.

**⚠️ RIEN N'EST DÉPLOYÉ.** La migration `00170` et les correctifs de code
existent sur disque et sont testés ; la **production est inchangée**. Tant que
`db push` et `functions deploy` n'ont pas été lancés, la fuite d'apurement
continue de se produire à chaque correction de conteneur.

**Deux constats postérieurs à l'audit** s'ajoutent au dossier : le dépôt GitHub
est **public**, et `xlsx` porte une **faille de production sans correctif npm**.

---

## Partie A — Sécurité technique

| # | Constat de l'audit | État | Où c'est traité |
|---|---|---|---|
| SEC-01 | Fonctions `SECURITY DEFINER` exécutables par `anon` | ✅ | `00090` §4 — `revoke ... from public` sur toutes les fonctions de `public` hors extensions, puis `grant` explicite à `service_role` |
| SEC-02 | Double authentification désactivée des deux côtés | ⚙️ | `supa.ts:39` et `App.tsx:40` — défaut `true` des deux côtés. **Dépend de `MFA_REQUISE` / `VITE_MFA_REQUISE` en production** |
| SEC-03 | Mot de passe provisoire fixe et commun | ✅ | `index.ts:135` — tant que `doitChangerMdp`, seules `account.me` et `account.changepwd` passent ; `00090` ajoute une liste de mots de passe interdits |
| SEC-04 | Chaîne d'audit non clefée, jamais vérifiée | ✅ | `00090` §1 — HMAC-SHA256, clé dans le schéma `securite` inaccessible à l'API (y compris `service_role`) |
| SEC-05 | Aucune trace de connexion | ✅ | `registry.ts:142` (`account.signin`), `rapports.ts:1581` (filtre `%connexion%` devenu optionnel), `index.ts:62-90` (limitation de débit) |
| SEC-06 | `SECURITY DEFINER` sans `search_path` figé | ✅ | `00090` §2 — `search_path` figé sur toutes les fonctions héritées |
| SEC-07 | CORS ouvert à tous les domaines | ⚙️ | `index.ts:32-47` — liste blanche. **Dépend de `ORIGINES_AUTORISEES` en production ; vide = aucune origine autorisée** |
| SEC-08 | Messages d'erreur bruts renvoyés au client | ✅ | `ctx.ts:66-90` — liste de motifs techniques, référence de corrélation côté client, détail côté serveur |
| SEC-09 | Un ADMIN peut usurper n'importe quel agent | ✅ | `utilisateurs.ts:65-197` — cloisonnement entre administrateurs : pas de reclassement, de désactivation ni de réinitialisation d'un pair |
| SEC-10 | La « signature de validation » ne signe rien | ✅ | `ecriture.ts:419-467` — l'empreinte porte désormais sur le contenu validé ; `00090:312` ajoute `empreinte_donnees` |
| SEC-11 | `cargo.editcamion` ouvert à tous les rôles, à tout statut | ✅ | `permissions.ts:54` — `[CFS, CHEF_BRIGADE, ADMIN]` |
| SEC-12 | Suppression définitive d'une cargaison | ✅ | `00090:286` (colonne `annule`), `lecture.ts:86` (exclue des fiches), `rapports.ts:45` (exclue de tous les rapports) |
| SEC-13 | La checklist de la Porte Principale peut contredire la base | ⚙️ | `ecriture.ts:700-730` — l'état **réel** fait foi, tout écart est marqué et journalisé. **Le blocage dépend de `SORTIE_EXIGE_PIECES`, à `false` par défaut** (voir DAT-01) |
| SEC-14 | Points vérifiés, sans anomalie | ➖ | — |

> **Les trois ⚙️ sont le point aveugle de ce document.** Le code est correct, mais
> son comportement réel dépend de variables d'environnement que personne ne peut
> lire sans accès au projet Supabase. Voir l'annexe.

---

## Partie B — Gouvernance

| # | Constat | État | Commentaire |
|---|---|---|---|
| GOV-01 | Dépôt Git local corrompu, backend absent du disque | ✅ | Résolu le 2026-09-09 : dépôt distant retrouvé et cloné dans `Documents/cargo-tracker-v4`. La copie détachée `cargo-tracker-v4-main` s'est révélée **identique au dépôt à jour** (diff vide hors fins de ligne) |
| GOV-02 | Facteur bus = 1 | 🔴 **aggravé** | Un seul titulaire des accès Supabase / Netlify / Sentry. Le contournement actuel — **travailler sous le compte GitHub du prestataire** — n'est pas une solution : il supprime toute traçabilité (les actions apparaissent sous son nom) et bute sur les vérifications d'identité (sudo mode GitHub). Il faut des comptes nommés, deux titulaires |
| GOV-03 | Deux systèmes vivants en parallèle | 🔴 | Le classeur Apps Script v3.6 est toujours en service. Non vérifiable depuis le code |
| GOV-04 | Répartition des rôles incohérente avec le modèle anti-fraude | 🤔 | Décision d'organisation : ramener ADMIN à 2 comptes, nommer les titulaires de cellule |
| GOV-05 | Charge technique qui grandit toute seule | 🟠 **devenu urgent** | **5 022 cargaisons à l'audit → 14 055 le 2026-09-09**, presque le triple en un mois. `00150` (archivage réversible) soulage les rapports, mais `fetchAll` charge toujours la table entière en mémoire dans l'Edge Function à chaque liste. Reste à porter filtres, tris et pagination côté SQL |

---

## RGPD

| # | Constat | État | Où |
|---|---|---|---|
| RGPD-01 | Coordonnées des déclarants visibles par les 10 rôles | ✅ | `lecture.ts:50-79` — `VOIENT_CONTACT` et `VOIENT_BALISE` ; `rapports.ts:703` filtre l'export ; `rapports.ts:713` **journalise tout export nominatif** |
| RGPD-02 | Aucune politique de conservation | 🔴 | Rien dans le code. Durées de conservation à définir |
| RGPD-03 | Le journal d'audit est aussi un fichier de surveillance des agents | 🔴 | Note d'information aux agents et registre de traitement à produire |

---

## Partie C — Intégrité des données

**Mesuré en production le 2026-09-09** (14 055 cargaisons vivantes, 5 980
déclarations) puis partiellement traité par la migration `00170` — **écrite et
testée, mais pas encore appliquée**. Le reste est le chantier ouvert.

| # | Constat | État | Ce qui manque exactement |
|---|---|---|---|
| DAT-01 | Le transit sort sans T1 ni bon de sortie — 0 occurrence sur 17 017 événements, pour 4 910 mouvements en transit | 🤔 **le point majeur** | Le code est prêt des deux côtés. Il attend un arbitrage : **activer réellement les cellules T1 et Bon de sortie**, ou **retirer le verrou côté PP**. Tant que rien n'est tranché, `SORTIE_EXIGE_PIECES` reste à `false` et la sortie ne contrôle rien |
| DAT-02 | 11 balises GPS posées sur deux camions en même temps | ⚙️ **corrigé, non appliqué** | Mesure du 2026-09-09 : **0 conflit ouvert** (2 911 balises réutilisées dans l'histoire — normal, un boîtier se repose sur un autre camion). `00170` pose un index unique **partiel** sur les cargaisons non sorties : créable sans nettoyage préalable |
| DAT-03 | 131 transits sans balise ni dispense | 🔴 | Lié à DAT-01. Contrôle bloquant balise-ou-dispense pour les régimes de transit |
| DAT-04 | Numéros de conteneurs invalides | 🟡 | La table `conteneurs` porte un `CHECK` ISO 6346 (`00010:159`) : elle est propre par construction. Le **jsonb `conteneurs_details` n'est pas contraint** — **173 numéros non conformes** y ont été comptés le 2026-09-09 |
| DAT-05 | Conteneurs comptés plusieurs fois | 🔴 | **19 doublons** `(cargaison_id, conteneur)` en base, **16** dans le jsonb — les deux sources divergent. Un index unique **ne peut pas** être créé en `NOT VALID` : il échouerait. Ces 19 lignes doivent être **listées et arbitrées d'abord** (`scripts/diagnostic/doublons-conteneurs.sql`), c'est pourquoi `00170` ne pose pas cette contrainte |
| DAT-06 | Référentiels absents (déclarants, destinations, n° de déclaration) | 🔴 | Saisie libre partout |
| DAT-07 | Clé de déclaration ambiguë — 101 déclarations à plusieurs déclarants | 🔴 | La clé reste année/bureau/type/numéro, sans le déclarant (cf. I-11 de la conception) |
| DAT-08 | L'apurement n'a pas de garde-fou | ⚙️ **corrigé, non appliqué** | **Le diagnostic a révélé bien pire qu'un plafond manquant : une FUITE.** Voir ci-dessous |
| DAT-09 | Course sur l'apurement des entrepôts (MAD / industriel) | 🔴 | Aucun `select ... for update` dans `entrepots.ts` |
| DAT-10 | Signaux à surveiller | ➖ | Rapport mensuel de remplacement de balises à mettre en place |

### DAT-08 en détail — la fuite d'apurement

Le diagnostic comptait d'abord **5 882 déclarations sur-apurées**, chiffre qui
semblait catastrophique. La décomposition l'a ramené à sa juste mesure :

| | |
|---|---|
| Sans nombre déclaré, mais apurées | **5 848** — normal : le champ est facultatif par décision utilisateur (`0 = inconnu, apurement neutre`, cf. `helpers.ts`) |
| **Vrai dépassement** | **34** sur les 121 déclarations qui portent un nombre déclaré, jusqu'à **+8 conteneurs** |
| Saines | 87 |

**⚠️ Ce que ça évite.** Poser le plafond `conteneurs_apures <= nombre_conteneurs`
comme prévu initialement aurait **refusé 5 848 apurements dès l'installation** et
arrêté le flux douanier. Le diagnostic n'a pas seulement mesuré : il a écarté un
correctif qui aurait cassé la production.

**La cause, établie par lecture du code.** Le compteur ne pouvait que **monter** :
`majApurement` n'était appelé qu'à l'ajout d'un conteneur, et `fn_apurer_inc`
refuse tout décrément (garde-fou anti-fraude posé en `00090`). Trois flux
fuyaient — la correction d'un conteneur, sa réaffectation à une autre
déclaration, et l'annulation d'une cargaison.

**Effet de bord de SEC-12.** Le passage à la suppression *logique* était une
correction de sécurité — ne plus détruire de pièce douanière. En ne touchant pas
aux compteurs, elle a créé cette fuite : la cargaison disparaissait des rapports
pendant que ses conteneurs restaient comptés comme apurés. Un doublon écarté
apurait donc une déclaration deux fois. **Un audit point par point ne pouvait pas
voir cet effet croisé.**

**Traitement** : `00170` ajoute `fn_apurer_dec` (borné à zéro, durci SEC-01) et
les trois flux sont corrigés, couverts par **4 tests** (retrait, réaffectation,
annulation, plancher à zéro). L'arriéré des 34 déclarations relève d'un script
séparé (`scripts/regularisation/recaler-apurement.sql`, **partie écriture
commentée**) : recaler des compteurs douaniers est une décision, pas un effet de
bord de déploiement.

---

## Points nouveaux, relevés après l'audit

### 🔴 Le dépôt GitHub est public

```
github.com/cfscell2026-maker/cargo-tracker-v4
"private": false · "visibility": "public" · créé le 2026-07-15
```

Sont donc lisibles par n'importe qui depuis près de deux mois :

- **`AUDIT_SECURITE_2026-08-10.md`** — la carte complète des faiblesses, avec
  gravités, détails d'exploitation et commandes de vérification ;
- la **référence du projet Supabase de production** ;
- le fait que `SORTIE_EXIGE_PIECES` vaut `false` par défaut ;
- des données d'exploitation de l'administration douanière (volumes, cellules
  inactives, comptes dormants).

**Ce qui n'est PAS exposé** — vérifié sur les 61 commits de l'historique :
aucune clé JWT, aucun `service_role`, aucun fichier `.env`, aucun export
`.xlsx`, aucun dump. Le `.gitignore` a fait son travail depuis l'origine.
**Aucun identifiant n'est compromis.**

Le code source public n'est pas en soi une faille — l'architecture ne repose pas
sur le secret. Le **document d'audit**, lui, n'a rien à faire en public.

**Correctif** : `Settings → General → Danger Zone → Change repository
visibility → Make private`. Nécessite une vérification d'identité du
propriétaire du compte.

### 🔴 `xlsx` (SheetJS) — faille de production, sans correctif npm (2026-09-10)

Relevé en installant les dépendances du projet (`npm audit`).

| | |
|---|---|
| **Gravité** | Élevée — deux avis de sécurité |
| **Failles** | Pollution de prototype (`GHSA-4r6h-8v6p-xvw6`) · déni de service par expression régulière (`GHSA-5pgg-2g8v-p4x9`) |
| **Version** | `xlsx@0.18.5` |
| **Correctif npm** | ❌ **aucun** |
| **Nature** | **Dépendance de production**, pas un outil de développement |

C'est la seule des cinq vulnérabilités signalées qui touche le code exécuté par
les agents. `XLSX.read` analyse le fichier déposé **dans le navigateur de
l'agent** (`apps/web/src/screens.tsx:1561`), sur deux écrans :

```
SCREENS.import        → stock.import        (Stock initial — rôle CFS)
SCREENS.importannonce → stockannonce.import (Annonce de transfert — ADMIN)
```

**Scénario.** Un fichier de stock piégé est fourni de l'extérieur. L'agent CFS
l'importe normalement. La pollution de prototype s'exécute dans son navigateur :
elle peut altérer le comportement de l'application, voire ouvrir la voie à une
injection de script dans une session authentifiée. Ce n'est pas exploitable à
distance — il faut qu'un agent importe le fichier. Mais les fichiers de stock
viennent bien de l'extérieur, et le CFS est le rôle qui écrit le plus.

**Pourquoi aucun correctif npm.** SheetJS a cessé de publier sur npm : la version
`0.18.5` y est figée et ne sera jamais corrigée. Les versions à jour sont
distribuées depuis le CDN de l'éditeur.

**Correctif** :

```bash
npm install https://cdn.sheetjs.com/xlsx-latest/xlsx-latest.tgz
```

L'API ne change pas (`XLSX.read`, `XLSX.utils.sheet_to_json`) : le risque de
régression est faible.

> **Les trois autres vulnérabilités ne concernent pas la production.**
> `esbuild`/`vite` : un site malveillant peut lire le serveur de développement
> local — aucun effet sur Netlify, qui sert des fichiers statiques ; le correctif
> imposerait Vite 5 → 8, disproportionné. `browserslist` et
> `baseline-browser-mapping` : outils de compilation, jamais envoyés au
> navigateur, corrigeables par `npm audit fix` — **à faire une fois les accès
> nominatifs obtenus**, pour ne pas faire diverger `package-lock.json`.

---

## Ce qui bloque, et pourquoi

| Travail | Bloqué par |
|---|---|
| **Application de `00170`** — écrite, testée, jamais déployée | Accès au projet Supabase `hwutqjlbzfcjfxvnugnx` |
| Contrainte DAT-05 | Les **19 doublons** à arbitrer — un index unique échoue tant qu'ils existent |
| Régularisation des **34** déclarations sur-apurées | Accès + décision (écriture de données douanières) |
| Vérification des 3 points ⚙️ | Lecture des variables d'environnement en production |
| Passage du dépôt en privé | Vérification d'identité du titulaire du compte GitHub |
| **Tout commit** | Le dépôt appartient au prestataire ; aucun accès GitHub nominatif |

**Faisable sans rien attendre** : la migration `xlsx` vers le CDN SheetJS, et le
branchement d'un `typecheck` sur `supabase/functions/`.

### ⚠️ Le volume a triplé

L'audit portait sur **5 022 cargaisons** (export du 2026-06-14). Le diagnostic du
2026-09-09 en compte **14 055 vivantes** — presque le triple en un mois.

**GOV-05 cesse d'être théorique.** `fetchAll` charge la table entière en mémoire
dans l'Edge Function à chaque liste et chaque rapport ; les Edge Functions Deno
ont des limites de mémoire et de durée. C'est aussi la confirmation que
l'application est en **production active**, et que chaque correctif bloquant doit
être annoncé aux cellules avant activation.

---

## Annexe — Les variables d'environnement, angle mort du dossier

Trois constats « corrigés » ne le sont réellement que si la production est
configurée en conséquence. Aucune de ces valeurs n'est vérifiable sans accès.

| Variable | Ce qu'elle décide | Défaut dans le code | Conséquence si mal réglée |
|---|---|---|---|
| `MFA_REQUISE` | La 2FA est-elle exigée par le serveur ? | `true` | À `false` : SEC-02 rouvert |
| `VITE_MFA_REQUISE` | La 2FA est-elle exigée par le front ? | `true` | Doit rester cohérent avec la précédente |
| `ORIGINES_AUTORISEES` | Liste blanche CORS | *(vide)* | Vide : **aucun navigateur ne peut appeler l'API** |
| `SORTIE_EXIGE_PIECES` | Un camion peut-il sortir sans T1 ni bon de sortie ? | **`false`** | À `false` : la sortie ne contrôle aucune pièce (voir DAT-01) |
| `SUPABASE_SERVICE_ROLE_KEY` | Clé qui contourne toute la sécurité | — | Ne doit exister que dans l'Edge Function |
| `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` | Base visée par le front | — | — |

**Première chose à faire dès l'obtention de l'accès : lire ces six valeurs.**

---

## Prochaines étapes, dans l'ordre

| | Étape | État |
|---|---|---|
| 1 | **Régler la facture Supabase** — carte expirée en 8/2026, facture d'août impayée, l'organisation risque la rétrogradation vers le plan Free (perte des sauvegardes quotidiennes) | 🔴 à faire |
| 2 | **Passer le dépôt en privé** — propriétaire du compte GitHub | 🔴 à faire |
| 3 | **Ouvrir les accès nommés** (Supabase Owner, GitHub, Netlify, Sentry) — règle GOV-02 et débloque tout le reste | 🔴 à faire |
| 4 | **Lancer le diagnostic** en lecture seule | ✅ fait le 2026-09-09 |
| 5 | **Écrire la migration `00170`** | ✅ écrite et testée — **le numéro n'est plus libre** |
| 6 | **Appliquer `00170`** (`db push` **avant** `functions deploy` : si le code appelle `fn_apurer_dec` avant qu'elle existe, le décrément échoue en silence) | 🔴 bloqué par l'accès |
| 7 | **Lire les 6 variables d'environnement** — lève les trois ⚙️ | 🔴 bloqué par l'accès |
| 8 | **Arbitrer les 19 doublons** de conteneurs, puis poser la contrainte DAT-05 | 🔴 bloqué par l'accès |
| 9 | **Régulariser les 34 déclarations** sur-apurées — décision, pas déploiement | 🔴 bloqué par l'accès |
| 10 | **Migrer `xlsx`** vers le CDN SheetJS | 🔴 à faire |
| 11 | **Brancher un `typecheck`** sur `supabase/functions/` | 🔴 à faire |
| 12 | **Trancher DAT-01** — la décision qui commande le contrôle de sortie | 🤔 arbitrage douanes |
