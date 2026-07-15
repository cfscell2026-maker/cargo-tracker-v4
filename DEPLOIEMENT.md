# CARGO TRACKER v4 — Guide de déploiement & migration (zéro perte)

> **Principe de sécurité des données** : la migration **lit uniquement** un export du Google Sheet. La source (Sheet + appli Apps Script v3.6) reste intacte et **continue de tourner** jusqu'à la bascule finale. On migre une **copie**, on **vérifie les comptages**, et on ne bascule que quand tout est vert.

## Où en est le projet

| Brique | État |
|---|---|
| Socle monorepo, `netlify.toml`, `domaine/` (cœur métier), schéma PostgreSQL, audit chaîné | ✅ construit |
| Routeur RPC sécurisé (2FA aal2) + **61 actions** (lecture, écriture, stock/annonce, spéciaux, 17 rapports, utilisateurs) | ✅ construit |
| Application React complète : login + **2FA TOTP** (enrôlement QR), écrans par rôle (MENUS/TITLES v3.6), détail + panneaux d'action, stock, imports, rapports | ✅ construit |
| Script de **migration** (données + comptes) + ce guide | ✅ construit |
| **Tests** : 32 automatisés verts (26 cœur métier + cycle de vie complet enlèvement + complétude du routeur) ; typecheck OK ; build Vite OK ; login rendu vérifié | ✅ |

> L'application est **fonctionnellement complète**. Il reste à la **déployer avec vos comptes** (étapes ci-dessous), puis à faire une **migration à blanc vérifiée** avant la bascule finale. La source Google Sheets n'est jamais touchée.

### Lancer les tests en local (facultatif)

```bash
# Cœur métier
cd packages/domaine/src && node --test
# Actions serveur (cycle de vie + complétude du routeur)
cd supabase/functions/rpc/actions && node --test
# Typecheck + build du front
cd apps/web && npx tsc --noEmit && npx vite build
```

> **Note bundling** : l'Edge Function `rpc` importe le cœur métier partagé depuis `packages/domaine` (relatif). `supabase functions deploy rpc` suit le graphe d'imports et l'inclut. Si une version de CLI refusait un import hors du dossier `functions/`, déplacez `packages/domaine/src` sous `supabase/functions/_shared/domaine/` et ajustez les chemins (mécanique, sans changement de code).

---

## Étape 1 — Supabase (région Europe)

1. Dans le projet Supabase créé : **Project Settings → General** → vérifier la **région = Europe** (Francfort/Paris). Sinon recréer le projet dans une région EU (la région n'est pas modifiable après coup).
2. **Installer la CLI** et se connecter :
   ```bash
   npm i -g supabase
   supabase login
   supabase link --project-ref <REF_DU_PROJET>
   ```
3. **Appliquer le schéma** (crée toutes les tables, RLS, audit chaîné, compteurs) :
   ```bash
   supabase db push
   ```
4. **Déployer l'Edge Function** `rpc` :
   ```bash
   supabase functions deploy rpc
   ```
5. **Activer le 2FA (TOTP)** : Dashboard → **Authentication → Providers/MFA** → activer **TOTP**. (Obligatoire : le routeur refuse tout token non-`aal2`.)

Récupérer, dans **Project Settings → API** :
- `Project URL` → `SUPABASE_URL`
- clé **anon** (publique) → pour le front
- clé **service_role** (SECRÈTE, ne jamais exposer) → pour la migration et l'Edge Function

---

## Étape 2 — Netlify (hébergement du front)

1. **New site → Import from Git** (ou dépôt lié), base du dépôt = racine du projet.
2. Le `netlify.toml` fournit déjà build (`npm ci && npm run build`), publish (`apps/web/dist`), redirect SPA et en-têtes de sécurité.
3. **Remplacer `<PROJET>`** dans `netlify.toml` (ligne `Content-Security-Policy`, `connect-src`) par la référence Supabase — sinon le navigateur bloquera les appels.
4. **Site settings → Environment variables** :
   | Variable | Valeur |
   |---|---|
   | `VITE_SUPABASE_URL` | `https://<REF>.supabase.co` |
   | `VITE_SUPABASE_ANON_KEY` | clé **anon** |
5. Déclencher le déploiement. → une URL `https://<votre-site>.netlify.app` avec la page de connexion 2FA.

> ⚠ Ne jamais mettre la clé **service_role** dans Netlify ni dans le front. Elle ne vit que dans l'Edge Function Supabase (déjà disponible côté serveur) et sur votre poste pour la migration.

---

## Étape 3 — Migration à blanc (répétable, sans risque)

1. Google Sheet → **Fichier → Télécharger → Microsoft Excel (.xlsx)**. Renommer `export.xlsx`, le placer dans `scripts/migration/`.
2. Dans `scripts/migration/`, créer `.env` :
   ```
   SUPABASE_URL=https://<REF>.supabase.co
   SUPABASE_SERVICE_ROLE_KEY=<clé service_role>
   ```
3. Installer et lancer :
   ```bash
   cd scripts/migration
   npm install
   npm run comptes    # crée les comptes agents (mots de passe provisoires → comptes-provisoires.csv)
   npm run migrer     # importe cargaisons/conteneurs/déclarations/stock + vérifie les comptages
   ```
4. Lire le rapport final : chaque table doit afficher ✅ (comptages identiques). **Recouper** avec le tableau de bord de l'ancienne appli (totaux par statut, stocks). Tant que ce n'est pas vert, **on ne bascule pas** — le script est rejouable après correction (upsert, aucun doublon).

> Cette étape peut être répétée autant de fois que voulu : elle ne touche jamais le Google Sheet, et réécrit proprement la copie PostgreSQL.

---

## Étape 4 — Bascule finale (uniquement quand v4 est complète et vérifiée)

1. Les briques 🔧 (écriture, spéciaux, rapports, écrans) sont terminées et testées (GUIDE_TEST rejoué).
2. Court **double-run** : les deux systèmes tournent, on compare.
3. **Gel** : on annonce l'arrêt des saisies sur l'ancienne appli à une heure donnée.
4. Export .xlsx **final** → `npm run migrer` une dernière fois → vérification verte.
5. On distribue les identifiants (`comptes-provisoires.csv`), chaque agent enrôle son 2FA.
6. On bascule les agents sur l'URL Netlify. L'ancien Sheet est **conservé en lecture seule** comme archive.

---

## Rappels de sécurité

- `comptes-provisoires.csv` contient des mots de passe : le remettre en main propre puis **le détruire**.
- La clé **service_role** ne doit apparaître que dans `scripts/migration/.env` (jamais commité) et dans Supabase.
- Après la 1ʳᵉ connexion, chaque agent **change son mot de passe** et **enrôle son 2FA** (obligatoire).
- Sauvegardes : activer le **PITR** (Supabase, plan Pro) avant la bascule.
