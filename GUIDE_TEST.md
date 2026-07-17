# Plan de test complet — PIA Dry Port · Cargo Tracker (v3.0)

> Document de **recette** : à dérouler dans l'ordre, **après déploiement**, pour valider
> **tous les chemins** de l'application (nominaux, contrôles, anti-fraude, confidentialité)
> et la **cohérence métier douanière**. Cochez la colonne **OK** au fur et à mesure.
>
> Rôle du testeur : ouvrir **plusieurs navigateurs / sessions** (un par profil) pour enchaîner
> les rôles sur la même cargaison.

---

## 0. Préparation de l'environnement

| # | Action | Résultat attendu | OK |
|---|--------|------------------|----|
| 0.1 | Recopier les `.gs` + `.html` dans l'éditeur Apps Script | Aucune erreur de copie | ☐ |
| 0.2 | Exécuter **`initialiserApplication`** | Le journal affiche l'admin par défaut + « Initialisation terminée ». Feuilles créées : Cargaisons, Conteneurs, Declarations, Stock, **StockAnnonce**, Utilisateurs, Historique, Meta | ☐ |
| 0.3 | Re-exécuter `initialiserApplication` une 2ᵉ fois | **Idempotent** : aucune perte, aucun doublon de colonne ; comptes « PORTE_CFS » migrés en « CFS » | ☐ |
| 0.4 | **Déployer une nouvelle version** de l'application web | URL accessible, écran de connexion | ☐ |
| 0.5 | Se connecter en **admin**, changer le mot de passe (Mon compte) | Connexion OK, mot de passe changé | ☐ |

### Comptes de test à créer (Admin ▸ Utilisateurs)

| Identifiant | Rôle | Usage dans les tests |
|---|---|---|
| `pp1` | PP (Porte Principale) | Pointe l'entrée des annoncés, sortie (checklist + état) |
| `cfs1` | CFS | **Crée les camions**, saisit l'opération, stock, pointage matinal, confirme entrée |
| `cb1` | Chef brigade | **Valide** (signe) |
| `cba1` | Chef brigade adjoint | Superviseur (voit Hors gabarit) |
| `cv1` | Chef visite | Superviseur (voit/saisit Hors gabarit) |
| `cd1` | Chef division | Superviseur |
| `t1` | T1 | Cellule T1 |
| `bal1` | Balise | Cellule Balise |
| `bs1` | Bon de Sortie | Cellule Bon de sortie |
| `adm1` | Admin | Débloquer / vérifier |

| # | Action | Résultat attendu | OK |
|---|--------|------------------|----|
| 0.6 | Créer les 10 comptes ci-dessus | Création OK, mot de passe initial communiqué | ☐ |
| 0.7 | Se connecter avec **chaque** compte | Chaque rôle voit **uniquement ses menus** (voir Matrice §13) | ☐ |
| 0.8 | 5 connexions ratées sur un compte | Compte **bloqué 5 min** (message anti-fraude) | ☐ |

---

## 1. Jeux de données de test (fichiers Excel)

> Préparez ces deux classeurs `.xlsx` (1 feuille, **sans** transformation ; une ligne d'en-tête
> est tolérée). N° conteneur au format **ISO 6346 = 4 lettres + 7 chiffres**.

### Fichier 1 — « Annonce de transfert » (7 colonnes, ordre exact)
`N° conteneur · Taille · Date d'entrée · Année décl. · Bureau décl. · Type décl. · N° décl.`

| N° TC | Taille | Date entrée | Année | Bureau | Type | N° décl |
|---|---|---|---|---|---|---|
| MSKU1234567 | 20' | 27/06/2026 | 2026 | TG120 | T | 12345 |
| HLBU3334445 | 20' | 27/06/2026 | 2026 | TG120 | T | 12345 |
| TCNU7654321 | 40' | 27/06/2026 | 2026 | TG120 | T | 22001 |
| CMAU1112223 | 20' | 27/06/2026 | 2026 | TG121 | C | 33010 |
| FCIU9998887 | 20' | 27/06/2026 | 2026 | TG121 | C | 33010 |
| ABCD123 (invalide) | 20' | 27/06/2026 | 2026 | TG120 | T | 12345 |

### Fichier 2 — « Stock initial » (6 colonnes, ordre exact — même format que l'annonce SANS le bureau)
`N° conteneur · Taille · Date d'entrée · Année décl. · Type décl. · N° décl.`

| N° TC | Taille | Date entrée | Année | Type | N° décl. |
|---|---|---|---|---|---|
| OOLU4445556 | 20' | 22/06/2026 | 2026 | C | N° 4001/2026 |
| MEDU5556667 | 40' | 15/06/2026 | 2026 | T | 4002 |

> Le **N° de déclaration** est ramené aux **chiffres uniquement** à l'import : `N° 4001/2026` devient `40012026`.

---

## 2. Scénario A — Entrée du stock (annonce → pointage PP)

| # | Rôle | Action | Résultat attendu | OK |
|---|------|--------|------------------|----|
| A1 | Admin | Menu **Annonce de transfert** → choisir Fichier 1 | Aperçu : 6 lignes lues, **5 valides** (la ligne `ABCD123` est **✕ invalide**) | ☐ |
| A2 | Admin | Cliquer **Importer l'annonce** | « 5 annoncé(s) » ; la ligne invalide est **ignorée** | ☐ |
| A3 | Admin/PP | Menu **Stock annoncé** | 5 conteneurs **Annoncé**, **0 pointé**, taux 0 % | ☐ |
| A4 | PP (`pp1`) | Menu **Pointage entrée (annoncé)** : le champ **propose** les TC annoncés | Liste déroulante = les 5 « Annoncé » | ☐ |
| A4b | PP | Pointer `MSKU1234567` | « Pointé. En attente de **confirmation CFS** » ; compteurs : 1 à confirmer / **0 confirmé** ; **PAS encore au stock** | ☐ |
| A5 | PP | Re-pointer `MSKU1234567` | **Refus** : « DÉJÀ POINTÉ le … » | ☐ |
| A6 | PP | Pointer un TC **absent** du stock annoncé (`ZZZZ0000000`) | **Refus** : « introuvable dans le stock annoncé » | ☐ |
| A7 | PP | Pointer `HLBU3334445`, `TCNU7654321`, `CMAU1112223`, `FCIU9998887` | 5 « pointés (à confirmer) » / 0 confirmé / taux **0 %** | ☐ |
| A8a | CFS (`cfs1`) | Menu **Stock conteneurs** | Les TC pointés **n'y sont pas encore** (pas confirmés) | ☐ |
| A8b | CFS **ou PP** | Menu **Confirmer entrée (port sec)** → la liste montre les **5 pointés** → **tout cocher** → **Valider l'entrée (5)** | « 5 entrée(s) validée(s) » ; passent **Pointé → Confirmé** ; **aucune saisie** | ☐ |
| A8c | CFS/PP | Un TC **non pointé** (encore « Annoncé ») | **N'apparaît PAS** dans la liste (seuls les « Pointé » sont proposés) ; rien à confirmer | ☐ |
| A8d | CFS | Menu **Stock conteneurs** | Les 5 TC apparaissent **En stock** (provenance « Port autonome ») ; **taux de transfert = 100 %** | ☐ |
| A9 | Admin | Menu **Stock initial (import)** → Fichier 2 → Importer | « 2 ajouté(s) » | ☐ |
| A10 | Admin | **Bug verrouillage** : importer un fichier de **plusieurs centaines de lignes** | L'import **se termine** (pas d'« Expiration de la demande de verrouillage ») | ☐ |

---

## 3. Scénario B — Pointage matinal / stock CFS journalier

| # | Rôle | Action | Résultat attendu | OK |
|---|------|--------|------------------|----|
| B1 | CFS (`cfs1`) | Menu **Pointage matinal** → pointer `CMAU1112223` et `FCIU9998887` | Passent **En stock → Positionné** | ☐ |
| B2 | CFS | Re-pointer `CMAU1112223` | **Refus** : « DÉJÀ POINTÉ … » | ☐ |
| B3 | CFS | Menu **Stock CFS journalier** | `CMAU1112223` + `FCIU9998887` = **Non ouverts** ; compteurs cohérents | ☐ |

---

## 4. Scénario C — ENLÈVEMENT complet (chemin nominal)

> Métier : enlèvement = sortie d'un **conteneur plein**. Déclaration + conteneur + camion saisis ensemble.

| # | Rôle | Action | Résultat attendu | OK |
|---|------|--------|------------------|----|
| C1 | CFS | **Créer un camion** : N° `AB1234CD`, type **Enlèvement** | Camion créé, statut **Camion créé**, opération **Enlèvement** | ☐ |
| C2 | CFS | Ouvre la fiche → panneau **Saisir l'opération** | Le **type est déjà affiché** (Enlèvement) — pas de choix | ☐ |
| C3 | CFS | Déclaration : déclarant, **contact**, destination, **Type décl = liste T/C/S/A/E**, N° `22001`, année `2026`, **Nombre de colis = 18** | Pas de « D » dans la liste type | ☐ |
| C4 | CFS | Conteneur : choisir `TCNU7654321` dans la liste stock | **Taille (40') auto-remplie** (verrouillée) ; **Type saisi à la main et facultatif** (peut rester vide) | ☐ |
| C5 | CFS | Saisir le **scellé** puis Enregistrer | Statut → **Fin de chargement / attente T1** | ☐ |
| C6 | CFS | Tenter d'ajouter un **2ᵉ conteneur** (40' déjà posé) | **Refus binôme** : autorisé seulement pour 2× 20' | ☐ |
| C7 | T1 (`t1`) | Ouvrir la fiche `AB1234CD` | **Aucun panneau T1 actif** (bloqué : pas encore validé) | ☐ |
| C8 | Chef brigade (`cb1`) | Menu **À valider** → ouvrir → **Valider et signer** | Signature posée (parcours affiche « Validé par … » + empreinte) | ☐ |
| C9 | T1 | Rouvrir la fiche → panneau **Cellule T1** | Bureau destination + **1 T1 lié au conteneur** `TCNU7654321` (menu déroulant) | ☐ |
| C10 | T1 | Valider | Statut **T1 saisi** ; le camion entre dans **2 files** (Balise + Bon de sortie) | ☐ |
| C11 | Balise (`bal1`) | **Baliser** : cocher « T1 correct » + N° balise | Fiche affiche **« Balisé »** (pas « Balisé / Dispensé ») | ☐ |
| C12 | Bon de sortie (`bs1`) | Panneau BS : **1 bon par conteneur** (conteneur + T1 affichés) | Saisie du n° de bon en face du conteneur → **Bon de sortie émis** | ☐ |
| C13 | PP | Menu **Sortie (checklist)** → **4 cases** → Valider *(plus d'« état de sortie » ici)* | Statut **Sorti** | ☐ |
| C13b | CFS | Menu **État camions (sortie CFS)** → sur ce camion, cliquer **Fin de chargement** | État enregistré ; compteur « Fin de chargement » +1 | ☐ |
| C14 | PP | Re-créer un camion `AB1234CD` | **Anti-doublon levé** (le précédent est Sorti) → autorisé | ☐ |

### C bis — Binôme 20' (enlèvement)
| # | Rôle | Action | Résultat attendu | OK |
|---|------|--------|------------------|----|
| Cb1 | CFS | Créer `CD5678EF`, type **Enlèvement** | OK | ☐ |
| Cb2 | CFS | 1ᵉʳ conteneur `MSKU1234567` (20', décl 12345) + scellé | Fin de chargement | ☐ |
| Cb3 | CFS | **Ajouter 2ᵉ conteneur** `HLBU3334445` (20') : le bloc déclaration **redemande tous les champs** (déclarant…description) + scellé | Accepté (les **deux sont 20'**) ; **TWINS = Yes** ; chaque conteneur garde **sa** déclaration | ☐ |
| Cb4 | CFS | Tenter un **3ᵉ** conteneur | **Refus** (2 max en enlèvement) | ☐ |
| Cb5 | T1 | Lier les T1 | **2 T1 distincts**, un par conteneur ; le conteneur choisi **disparaît** de la 2ᵉ liste | ☐ |

---

## 5. Scénario D — DÉPOTAGE complet

> Métier : dépotage (devanning) = ouverture du conteneur, scellés **du camion** (2 à 3). Le
> conteneur doit avoir été **positionné le matin** (stock CFS journalier).

| # | Rôle | Action | Résultat attendu | OK |
|---|------|--------|------------------|----|
| D1 | CFS | Créer `GH9012IJ`, type **Dépotage** | Opération **Dépotage** | ☐ |
| D2 | CFS | Ajouter conteneur `CMAU1112223` (Positionné) **avec sa déclaration complète** (déclarant, contact, destination, bureau, type, n° décl `33010`, année, nb conteneurs, description) | Le **bloc déclaration s'affiche pour le conteneur** ; taille auto, **type facultatif** ; statut **En cours de chargement** | ☐ |
| D2b | CFS | Ajouter `FCIU9998887` avec une déclaration **différente** (autre déclarant, n° décl `40020`) | Accepté → **chargement mixte** ; chaque conteneur garde **sa** déclaration (visible au détail) | ☐ |
| D3 | CFS | Tenter un conteneur **non positionné** (`OOLU4445556`, juste En stock) | **Refus** : « n'est pas POSITIONNÉ … pointez-le au pointage matinal » | ☐ |
| D4 | CFS | **Conteneur partagé** : cocher **« saisie manuelle »**, taper un TC déjà pris sur un 2ᵉ camion | Accepté (hors stock), pas de double consommation | ☐ |
| D5 | CFS | Panneau **« Finaliser le dépotage »** : saisir **hauteur = 3,80 m** + **nombre de colis** + **2 scellés** camion → Finaliser | Statut **Fin de chargement / attente T1** ; **pas** hors gabarit | ☐ |
| D6 | CFS | Tenter sans hauteur, ou 1 seul scellé | **Refus** (hauteur requise ; 2 scellés min) | ☐ |
| D7 | Chef brigade | Valider et signer | Débloque la suite | ☐ |
| D8 | T1 | Cellule T1 : **règle 1:N** (au moins 1 T1, numéros libres) | OK | ☐ |
| D9 | Bon de sortie | **1 bon par déclaration** (un seul numéro) | OK | ☐ |
| D10 | PP | Sortie : **checklist** (4 cases) | Sorti | ☐ |
| D11 | CFS | Menu **État camions (sortie CFS)** → définir l'état (En cours / Fin / Vide) | Traçabilité mise à jour ; compteurs cohérents | ☐ |

---

## 6. Scénario E — Validation chef brigade (le verrou)

| # | Rôle | Action | Résultat attendu | OK |
|---|------|--------|------------------|----|
| E1 | PP+CFS | Préparer un camion jusqu'à **Fin de chargement** (non validé) | Statut Fin de chargement | ☐ |
| E2 | T1 | Tenter de saisir le T1 | **Refus / panneau absent** (non validé) | ☐ |
| E3 | Balise | Tenter de baliser | **Refus / panneau absent** | ☐ |
| E4 | Bon de sortie | Tenter d'émettre | **Refus / panneau absent** | ☐ |
| E5 | Chef **adjoint** (`cba1`) | Chercher un bouton « Valider » | **Aucun** (l'adjoint ne valide pas) | ☐ |
| E6 | Chef **visite**/`division` | Idem | **Aucun** bouton valider | ☐ |
| E7 | Chef brigade | Valider | Signature posée ; **T1 redevient possible** | ☐ |
| E8 | Chef brigade | Re-valider la même cargaison | **Refus** « déjà validée » (sauf Admin) | ☐ |
| E9 | Admin | Forcer une validation | Autorisé (pouvoir admin) | ☐ |
| E10 | Tous | Vérifier le **parcours** de la fiche | Étape « Validation — Chef brigade » avec **date + signataire + empreinte** | ☐ |

---

## 7. Scénario F — Confidentialité « Hors gabarit »

| # | Rôle | Action | Résultat attendu | OK |
|---|------|--------|------------------|----|
| F1 | CFS | Dépotage : à « Finaliser le dépotage », saisir hauteur **= 4,80 m** (> 4,5) | Avertissement « sera signalé HORS GABARIT » pendant la saisie ; après finalisation, **horsGabarit = Oui** (auto) | ☐ |
| F1b | CFS | Autre dépotage avec hauteur **= 3,50 m** | **Pas** hors gabarit | ☐ |
| F2 | Chef brigade | Ouvrir la fiche du camion à 4,80 m (à valider) | Bandeau rouge **⚠ HORS GABARIT — 4,80 m** dans le panneau de validation (**sans** la mention « signalé automatiquement par le système ») | ☐ |
| F3 | Chef visite / adjoint / division | Ouvrir la fiche | **AUCUNE carte « Hors gabarit »** (supprimée) | ☐ |
| F4 | **CFS** | Ouvrir la même fiche (après finalisation) | **Aucune carte « Hors gabarit »** | ☐ |
| F5 | **T1 / Balise / Bon de sortie / PP** | Ouvrir la fiche | **Rien** sur le hors gabarit / la hauteur | ☐ |
| F6 | Chef brigade | **Enlèvement** : ouvrir une fiche à valider | **Aucun signalement hors gabarit** (n'existe qu'en dépotage) | ☐ |
| F7 | (Technique) | Console réseau d'un compte **T1/Balise/PP** sur `cargo.get` | La réponse **ne contient pas** `horsGabarit` / `hauteurChargement` (filtré **serveur**) | ☐ |
| F8 | Tous | Vérifier **Nombre de colis** | **Visible de tous** (parcours, étape CFS) | ☐ |

---

## 8. Scénario G — Parallélisme Balise ∥ Bon de sortie

| # | Rôle | Action | Résultat attendu | OK |
|---|------|--------|------------------|----|
| G1 | … | Camion validé + T1 fait | Apparaît dans **Attente Balise ET Attente Bon de sortie** | ☐ |
| G2 | Bon de sortie | Émettre le bon **avant** la balise | Accepté ; reste en attente Balise | ☐ |
| G3 | PP | Tenter la sortie (balise pas encore faite) | **Refus** : « la Balise ET le Bon de Sortie doivent être faits » | ☐ |
| G4 | Balise | Baliser | Le camion passe alors en **Attente sortie (PP)** | ☐ |
| G5 | (inverse) | Sur un autre camion, **baliser d'abord**, puis bon de sortie | Même résultat : PP seulement quand les deux faits | ☐ |

---

## 9. Scénario H — Opérations spéciales (créées par le CFS)

> Menu CFS ▸ **Nouveau (Véhic./Conso/MAD)**. La **validation chef brigade s'applique aussi**.

| # | Cas | Étapes clés | Résultat attendu | OK |
|---|-----|-------------|------------------|----|
| H1 | **Véhicule (régime Déclaration)** | VIN, marque, destination (Transit/Conso/MAD/Abandonné), conteneur d'origine | La déclaration **n'a pas de champ désignation** ; la **désignation se saisit dans les effets divers**. Le véhicule **saute la Balise** ; passe Validation → T1 → Bon de sortie → PP | ☐ |
| H1b | Véhicule — désignation | Basculer sur « Dépotage / Véhicule » | Le champ **description quitte la déclaration** et apparaît dans le bloc effets divers (camions) | ☐ |
| H2 | Véhicule — comptage | Conteneur d'origine + camion d'effets | Conteneur **compté une seule fois** ET **décompté du stock CFS journalier** (Positionné → Dépoté) | ☐ |
| H3 | **Conso à baliser** | Régime « à baliser » | **Saute le T1** ; passe Validation → Balise → Bon de sortie → PP | ☐ |
| H4 | **Conso non balisée** | Régime « non balisée » | **Saute T1 ET Balise** (= dispense) | ☐ |
| H5 | **Magasin/MAD T1** | Entrée Magasin/MAD : marquer un conteneur dépoté | Stock conteneur → Dépoté | ☐ |
| H6 | **Magasin/MAD T2** | Sortie Magasin (vrac, sans conteneur) | Cargaison sort | ☐ |
| H7 | Validation des spéciaux | Avant validation chef brigade | T1/Balise/BS **bloqués** aussi pour les spéciaux | ☐ |

### H bis — Régime OUILLAGE (permis d'examiner)

| # | Rôle | Action | Résultat attendu | OK |
|---|------|--------|------------------|----|
| Ho1 | CFS | Nouveau ▸ Dépotage / Véhicule ▸ régime **Ouillage** | La **déclaration disparaît** du formulaire ; champs **N° ouillage + Date** apparaissent ; **pas de camions d'effets divers** | ☐ |
| Ho2 | CFS | Créer avec n° `OUI-2026-001` + date + 2 véhicules | Statut **« Véhicule ouillage créé (décl. à renseigner) »** ; n°/date d'ouillage visibles sur la fiche | ☐ |
| Ho3 | T1/Balise/BS | Ouvrir la fiche d'un véhicule ouillage | **Aucun panneau** actif (déclaration pas encore renseignée) | ☐ |
| Ho4 | CFS | Fiche véhicule 1 → panneau **« Ouillage — Compléter la déclaration »**, type **T (Transit)** | Statut → Créée ; après **validation chef brigade** → passe par la **cellule T1**, **saute Balise + Bon de sortie** → sortie **PP** | ☐ |
| Ho5 | CFS | Fiche véhicule 2 → déclaration type **C (Conso)** (ou MAD) | Après validation chef brigade → va **directement à la PP** (saute T1, Balise, Bon de sortie) | ☐ |
| Ho6 | Chef brigade | Avant sa validation | T1/PP **bloqués** aussi pour l'ouillage | ☐ |
| Ho7 | Tous | Parcours de la fiche | Étapes T1/Bon de sortie affichent « Non requise/requis (ouillage) » selon le régime | ☐ |

---

## 10. Scénario I — Contrôles, sécurité & anti-fraude

| # | Cas | Action | Résultat attendu | OK |
|---|-----|--------|------------------|----|
| I1 | Anti-doublon camion | Créer un N° déjà **actif** | **Refus** (jusqu'à sa sortie) | ☐ |
| I2 | Conteneur hors stock | Enlèvement avec un TC absent du stock | **Refus** (ou « saisie manuelle ») | ☐ |
| I3 | Dépotage non positionné | (cf. D4) | **Refus** | ☐ |
| I4 | Format TC | Saisir `MSK12` ou `MSKU12345` | **Refus** : 4 lettres + 7 chiffres | ☐ |
| I5 | Téléphone | Contact avec lettres | **Refus / normalisation** | ☐ |
| I6 | Apurement | Réutiliser la déclaration `33010` (2 conteneurs déclarés) | **Restant à apurer** décrémenté | ☐ |
| I7 | Déclaration mixte | 2 conteneurs de **2 N° de décl différents** sur un camion | Flag **chargement mixte** | ☐ |
| I8 | Remplacement balise | Tenter en tant que **Balise** | **Refus** (ADMIN uniquement) | ☐ |
| I9 | Remplacement balise | En **Admin**, sur un camion balisé | Autorisé, journalisé | ☐ |
| I10 | Correction N° camion | Tous rôles, bouton sur la fiche | OK, **journalisé** | ☐ |
| I11 | Doublons (avertissement) | Saisir un conteneur déjà enregistré | **Avertissement** (lien), jamais blocage | ☐ |
| I12 | Visite (douane) | CFS/Admin, enlèvement : modifier un scellé | OK, tracé | ☐ |
| I13 | Édition | CFS édite après « Créée » | Refusé si statut avancé (sauf Admin) | ☐ |
| I14 | Historique | Admin ▸ Historique | Toutes les actions (qui/quoi/quand) tracées + export | ☐ |

---

## 11. Scénario J — Rapports & indicateurs

| # | Rapport | Rôle | Vérifier | OK |
|---|---------|------|----------|----|
| J1 | **Rapport CFS** | CFS/Admin | Camions & conteneurs / période / opération + **EVP** ; cartes **cliquables** → détail | ☐ |
| J2 | **Rapport Balise** | Balise/Admin | Balisés, **TWINS**, dont sans balise | ☐ |
| J3 | **Rapport PP** | PP/Admin | Sorties / période | ☐ |
| J4 | **Rapport véhicules** | CFS/Admin | Ventilation par destination | ☐ |
| J5 | **Stock annoncé** | PP/CFS/Admin | Non pointés / pointés / **taux de transfert** / délai | ☐ |
| J6 | **Analyse des flux** | Admin | CFS/Balise/PP par jour/semaine/mois | ☐ |
| J7 | **Camions en instance** | CFS/Admin | Tranches d'âge, alerte ≥ 90 j | ☐ |
| J8 | **Séjour conteneurs** | CFS/Admin | Jours de séjour, tranches | ☐ |
| J9 | **KPI / EVP** | tous | Stock par 20'/40'/45', tout en **EVP** (20'=1 ; 40'=45'=2) | ☐ |
| J10 | **Dispenses** | Balise/Admin | Total / en cours / terminées ; **Solder** une dispense | ☐ |
| J11 | Export | — | Chaque rapport s'exporte en **Excel** et **PDF** | ☐ |

---

## 12. Tableau de bord (cartes)

| # | Vérifier | OK |
|---|----------|----|
| 12.1 | Cartes : Total · Camions créés · En cours · **Attente validation** · Attente T1 · Attente Balise · Attente Bon de sortie · Attente sortie · Sortis · Aujourd'hui · Véhicules | ☐ |
| 12.2 | Un camion validé+T1 compte à la fois **Attente Balise** et **Attente Bon de sortie** | ☐ |
| 12.3 | Cliquer une carte → liste filtrée → cliquer une ligne → fiche | ☐ |
| 12.4 | **Filtre de période** : sélecteur en haut, **Hebdomadaire par défaut** ; passer en **Journalier / Mensuel / Annuel** recharge les compteurs (cargaisons créées dans la période) ; la plage de dates s'affiche | ☐ |
| 12.5 | Journalier après minuit : une cargaison d'hier **disparaît** du journalier mais reste dans l'hebdomadaire | ☐ |

---

## 13. Matrice des rôles (menus visibles) — à vérifier visuellement

| Menu \ Rôle | PP | CFS | Chef brig. | Adjt/Visite/Div. | T1 | Balise | BS | Admin |
|---|---|---|---|---|---|---|---|---|
| Créer un camion | — | ✅ | — | — | — | — | — | ✅ |
| Saisir / compléter | — | ✅ | — | — | — | — | — | ✅ |
| À valider | — | — | ✅ | — | — | — | — | ✅ |
| Pointage entrée (annoncé) | ✅ | — | — | — | — | — | — | ✅ |
| Confirmer entrée (annoncé) | — | ✅ | — | — | — | — | — | ✅ |
| État camions (sortie CFS) | — | ✅ | — | — | — | — | — | ✅ |
| Stock CFS journalier | — | ✅ | — | — | — | — | — | ✅ |
| Cellule T1 / Balise / Bon de sortie | — | — | — | — | ✅ | ✅ | ✅ | ✅ |
| Sortie (checklist) | ✅ | — | — | — | — | — | — | ✅ |
| Annonce de transfert (import) | — | — | — | — | — | — | — | ✅ |
| Voir « Hors gabarit » (dans la fiche) | ❌ | ❌ | ✅ | ✅ | ❌ | ❌ | ❌ | ✅ |
| Valider (signer) | ❌ | ❌ | ✅ | ❌ | ❌ | ❌ | ❌ | ✅ |

---

## 14. Workflow de bout en bout (récapitulatif à dérouler en équipe)

```
ADMIN  ── importe l'annonce de transfert (la veille) ─────────────► STOCK ANNONCÉ
PP     ── pointe le TC à l'arrivée (proposé depuis annoncé) ──────► « Pointé » (à confirmer)
CFS    ── CONFIRME l'entrée ──────────────────────────────────────► STOCK PORT SEC
CFS    ── pointe le matin (pointage matinal) ─────────────────────► STOCK CFS JOURNALIER (positionnés)
CFS    ── crée le camion vide + TYPE (Enlèvement/Dépotage) ───────► « Camion créé »
CFS    ── saisit l'opération (+ colis / hauteur en dépotage) ─────► « Fin de chargement »
CHEF BRIGADE ── VALIDE / SIGNE (+ hors gabarit confidentiel) ────► déverrouille la suite
T1     ── n° T1 (enlèvement : 1 par conteneur) ─────────────────► « T1 saisi »
BALISE ∥ BON DE SORTIE  (en parallèle) ─────────────────────────► « Balisé/Dispensé » + « Bon émis »
PP     ── checklist finale (4 cases) ──────────────────────────► « Sorti »
CFS    ── état camion à la sortie CFS (En cours/Fin/Vide) ──────► traçabilité site
```

**Critère de recette global :** chaque ligne du présent document est cochée **OK**, sans
contournement possible d'une étape (hors pouvoir Admin), et le champ **Hors gabarit** n'est
jamais visible hors des 4 profils chefs + Admin.

---

## 15. Anomalies (à remplir pendant la recette)

| # | Étape (ex : C8) | Description de l'anomalie | Gravité | Statut |
|---|---|---|---|---|
| | | | | |
| | | | | |
| | | | | |

---

*Fin du plan de test. En cas d'anomalie, noter l'ID de l'étape ci-dessus et la remonter pour correction.*
