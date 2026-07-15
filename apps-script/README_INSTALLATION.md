# Suivi des Cargaisons
### Application web (Google Apps Script + Google Sheets) — Guide d'installation

Application de suivi des cargaisons à travers 3 points de contrôle (CFS → Balise/GPS →
Porte Principale), avec 4 profils, données infalsifiables, historique, recherche et
rapports Excel/PDF. **Aucun hébergement à gérer** : tout tourne sur Google.

---

## 1. Créer le classeur et le projet de script

1. Allez sur **drive.google.com** → **Nouveau → Google Sheets** (classeur vierge).
2. Renommez-le, par ex. `CARGO TRACKER`.
3. Dans le classeur : menu **Extensions → Apps Script**. Un projet de script s'ouvre.
4. Dans l'éditeur Apps Script, **supprimez** le fichier `Code.gs` par défaut (ou videz-le).

## 2. Coller les fichiers

Dans l'éditeur Apps Script, recréez **exactement** ces fichiers (bouton **+ → Script**
pour les `.gs`, **+ → HTML** pour les `.html`) et collez le contenu correspondant :

| Fichier à créer (dans Apps Script) | Type   | Coller le contenu de |
|------------------------------------|--------|----------------------|
| `Config`                           | Script | `Config.gs`          |
| `Setup`                            | Script | `Setup.gs`           |
| `Auth`                             | Script | `Auth.gs`            |
| `Data`                             | Script | `Data.gs`            |
| `Audit`                            | Script | `Audit.gs`           |
| `Reports`                          | Script | `Reports.gs`         |
| `Code`                             | Script | `Code.gs`            |
| `Index`                            | HTML   | `Index.html`         |
| `Styles`                           | HTML   | `Styles.html`        |
| `Client`                           | HTML   | `Client.html`        |

> Apps Script ajoute l'extension tout seul : créez le fichier `Index` en HTML, il
> deviendra `Index.html`. Ne mettez **pas** le `.gs`/`.html` dans le nom.

Cliquez sur **💾 Enregistrer** (Ctrl+S).

## 3. Initialiser (à faire une seule fois)

1. En haut de l'éditeur, dans la liste des fonctions, choisissez **`initialiserApplication`**.
2. Cliquez sur **▶ Exécuter**.
3. Google demande des autorisations → **Examiner les autorisations** → choisissez votre
   compte → **Autoriser** (l'avertissement « application non vérifiée » est normal pour
   un script personnel : *Paramètres avancés → Accéder au projet*).
4. Ouvrez le menu **Exécution / Journaux** (ou *Affichage → Journaux*). Vous y verrez :

   ```
   IDENTIFIANT ADMIN : admin   |   MOT DE PASSE : xxxxxxxx
   ```
   **Notez ce mot de passe**, il ne sera plus affiché.

Cette étape crée les onglets `Cargaisons`, `Utilisateurs`, `Historique`, `Meta`, le
compte administrateur, et programme la **sauvegarde automatique quotidienne**.

## 4. Déployer l'application web

1. En haut à droite : **Déployer → Nouveau déploiement**.
2. Roue dentée → **Application Web**.
3. Réglages :
   - **Description** : `Cargo Tracker v1`
   - **Exécuter en tant que** : **Moi** (votre compte) ✅
   - **Qui a accès** : **Tout le monde** ✅
     *(L'authentification est gérée par l'application elle-même, identifiant + mot de
     passe ; les agents n'ont pas besoin de compte Google.)*
4. **Déployer** → autorisez si demandé → **copiez l'URL de l'application Web**
   (`https://script.google.com/macros/s/.../exec`).
5. Partagez cette URL aux agents. Première connexion : `admin` + le mot de passe noté.

> À chaque modification du code, refaites **Déployer → Gérer les déploiements →
> (crayon) → Version : Nouvelle version → Déployer** pour publier la mise à jour.

> ⚠️ **Autorisation pour les exports Excel/PDF.** Les rapports utilisent
> `UrlFetchApp` (service externe Google). La **première fois**, exécutez n'importe
> quelle fonction dans l'éditeur (ex. `initialiserApplication`) pour accepter la
> nouvelle autorisation demandée, **puis redéployez une nouvelle version**. Sans
> cela l'export renverra « conversion non disponible » / erreur d'autorisation.

## 5. Créer les comptes des agents

Connectez-vous en `admin` → menu **Utilisateurs → + Nouvel utilisateur**.
Créez un compte par agent avec le profil adapté :

- **CFS** — création des rapports + édition (tant que statut « Créée ») + rapport de chargement
- **BALISE** — pose du GPS
- **PP** — enregistrement des sorties
- **ADMIN** — tout + édition de n'importe quelle cargaison + utilisateurs + rapports + historique

Pensez à **changer le mot de passe admin** (menu *Mon compte*).

---

## Nouveautés v1.1 (modèle « rapport » multi-camions)

- **1 rapport = plusieurs camions.** À la saisie CFS (*Nouveau rapport*), on choisit le
  type d'opération, on renseigne la déclaration **commune** (dépotage), puis on ajoute
  autant de camions que nécessaire. Chaque camion devient une **cargaison à part entière**
  (son propre ID `CT-…`) reliée aux autres par un **N° de rapport** `RPT-…`. Chaque camion
  suit ensuite son **parcours individuel** (Balise → Porte Principale) — inchangé.
- **Conteneurs** : voir la v1.2 ci-dessous (nombre libre, un scellé par conteneur).
- **Champs supplémentaires conteneur** : Taille / Type / Poids + **champs libres**
  (nom/valeur). Bouton *⊕ Champs +* sur chaque conteneur.
- **Tous les champs en MAJUSCULES** (forcé à la saisie et côté serveur). Le **N° camion**
  voit ses caractères spéciaux retirés automatiquement pendant la frappe.
- **Valeurs par défaut** (dépotage) : *Bureau de déclaration* = **TG120**, *Type de
  déclaration* = **T** (liste déroulante). Modifiables dans `Config.gs`
  (`DEFAUTS` et `TYPES_DECLARATION`).
- **Édition** : bouton *✎ Éditer* sur le détail d'une cargaison (Admin à tout moment ;
  CFS tant que le statut est « Créée »). Toute modification est **journalisée**.
- **Recherche** par **N° de rapport** ajoutée.

## Nouveautés v1.2 (conteneurs illimités + table dédiée Excel)

- **Nombre de conteneurs LIBRE par camion** (plus de plafond 2/4). Bouton
  *＋ Ajouter un conteneur* autant de fois que nécessaire ; idem *＋ Ajouter un camion*
  pour le rapport.
- **Un scellé propre à chaque conteneur** (dépotage **et** enlèvement). L'ancienne règle
  « 3 plombs au niveau du chargement » est remplacée par ce modèle plus simple.
- **Nouvelle feuille `Conteneurs`** : **1 ligne par conteneur**
  (`N° Rapport · ID Cargaison · N° Camion · Type · Ordre · Conteneur · Scellé · Taille ·
  Type · Poids · Champs libres · Date`). C'est **la** table à utiliser pour le traitement
  Excel : tri, filtre et tableaux croisés dynamiques par rapport ou par camion sont
  immédiats. La feuille `Cargaisons` reste « 1 ligne par camion » (les colonnes
  `Conteneur 1..4` n'y servent que d'aperçu rapide pour les listes/recherche).

> ⚠️ **Migration (v1.0 → v1.2).** Les versions successives ajoutent des colonnes EN FIN de
> `Cargaisons` (`N° Rapport`, `Conteneur 4`, `Détails conteneurs`, `Plomb 4`,
> `Nb conteneurs`) **et** une nouvelle feuille `Conteneurs`. Après avoir collé le code,
> **relancez `initialiserApplication`** : la fonction crée la feuille manquante et ajoute
> les en-têtes manquants **sans toucher aux données existantes**, puis **redéployez** une
> nouvelle version. *(Les cargaisons créées avant la v1.2 n'ont pas de lignes dans la
> feuille `Conteneurs` ; il suffit de les ré-enregistrer via ✎ Éditer pour les y faire
> apparaître.)*

---

## Sécurité intégrée

- Mots de passe **hachés** (SHA-256 salé, 5000 itérations) — jamais stockés en clair.
- **Sessions** par jeton (6 h), invalidées à la déconnexion.
- **Anti brute-force** : blocage temporaire après 5 essais.
- **Tous les droits vérifiés côté serveur** (routeur `rpc`) — le navigateur ne décide rien.
- **Intégrité** : chaque étape ne peut écrire que ses propres champs. Workflow séquentiel
  strict (Créée → GPS Installé → Sortie Enregistrée). L'édition des champs CFS est
  contrôlée côté serveur (Admin à tout moment ; CFS uniquement au statut « Créée ») et
  ne touche jamais aux champs Balise/PP ; chaque modification est journalisée.
- **Historique non modifiable** (journal append-only de toutes les actions).
- **Onglets protégés** contre l'édition manuelle.
- **Sauvegarde automatique** quotidienne dans Drive (30 copies glissantes).
- Connexion **HTTPS** native (domaine Google).

## Performance (classeur volumineux)

- Recherche d'un ID via **TextFinder** natif (n'analyse pas toute la feuille).
- Génération d'ID **atomique** (`LockService`) — pas de doublon en accès concurrent.
- Écritures groupées + **verrous** sur les mises à jour de ligne.
- Listes **paginées** (50/page) avec **cache court** (45 s) — fluidité même à grand volume.
- Données transportées en **résumé** (colonnes utiles uniquement) vers le client.

## Maintenance

- **Sauvegarde manuelle** : exécuter la fonction `sauvegardeQuotidienne` dans l'éditeur.
- **Réinitialiser un mot de passe agent** : menu *Utilisateurs → Mot de passe*.
- Ne modifiez jamais les onglets à la main : passez toujours par l'application.
