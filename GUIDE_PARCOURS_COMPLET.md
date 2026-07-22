# GUIDE DE PARCOURS COMPLET — Tester toute l'application, pas à pas

> **But** : exercer **chaque fonctionnalité** de chaque poste, sur l'appli en ligne, avec des
> **données de test clairement balisées**, sans perturber les vraies données (nettoyage admin à la fin).
> Suivez les étapes dans l'ordre. Cochez `☑` au fur et à mesure. Revenez me voir dès qu'une étape
> ne donne pas le résultat attendu.

---

## 0. AVANT DE COMMENCER (préparation) — À FAIRE UNE SEULE FOIS

### 0.1 Déployer le backend récent (obligatoire)
Certaines nouveautés testées ici ne marchent qu'après déploiement. Depuis votre poste, dans le dossier du projet :

```
supabase db push                                   # applique la migration 00050 (colonnes déclaration du stock)
supabase functions deploy rpc --no-verify-jwt      # confirmation en lot, nouvel import stock, Conso/MAD, effets divers
```
Le front (autocomplétion) est déjà en ligne via Netlify au dernier push.

- ☐ `db push` terminé sans erreur
- ☐ `functions deploy rpc` terminé (« Deployed Functions »)

### 0.2 Convention de données de TEST (à respecter partout)
Pour tout reconnaître et tout supprimer à la fin, utilisez **toujours** ces valeurs :

| Donnée | Valeur de test à utiliser |
|---|---|
| Déclarant | **TEST ACP** (commence par « TEST ») |
| N° camion | **TEST001**, TEST002, … |
| N° conteneur (ISO 6346 = 4 lettres + 7 chiffres) | **ZZZU0000001** … ZZZU0000020 |
| N° déclaration | **99001**, 99002, … |
| Châssis véhicule (VIN) | **TESTVIN0001** |
| N° balise GPS | **TESTGPS01** |
| N° T1 / bon de sortie / dispense | **TESTT1-01 / TESTBS-01 / TESTDISP-01** |

> ⚠️ **Rappel** : chaque action laisse une trace **définitive** dans l'Historique (audit inviolable).
> Les cargaisons/stock de test seront supprimables par l'admin (§14), pas les lignes d'historique.

### 0.3 Créer les comptes de test manquants (connecté en **admin**)
Vos 17 comptes actuels ne couvrent que ADMIN / CFS / BALISE / PP. Pour jouer **chaque** poste,
créez les comptes manquants : menu **Utilisateurs → + Nouveau**. Mot de passe provisoire au choix
(ex. `CargoPia2026`).

- ☐ `test_chef` — rôle **CHEF_BRIGADE**
- ☐ `test_t1` — rôle **T1**
- ☐ `test_bs` — rôle **BON_SORTIE**
- ☐ `test_adj` — rôle **CHEF_BRIGADE_ADJOINT**
- ☐ `test_visite` — rôle **CHEF_VISITE**
- ☐ `test_div` — rôle **CHEF_DIVISION**

(CFS = `testagent`, BALISE = `balise`, PP = `ppp`, ADMIN = `admin` existent déjà.)

### 0.4 Comment changer de poste
La 2FA est **désactivée** en ce moment : connexion = **identifiant + mot de passe** seulement.
Pour tester un autre rôle : menu **Déconnexion** → se reconnecter avec le compte du rôle voulu.

### 0.5 Légende des symboles de ce guide
- `➤` action à faire · `✓` résultat attendu · `✗` test d'erreur (le refus est le succès)
- **⚙️** = nécessite le déploiement du §0.1

---

## 1. VUE D'ENSEMBLE

### 1.1 Le circuit d'une cargaison (camion)
```
[CFS] Créer camion (Enlèvement/Dépotage)
   → [CFS] associer conteneur(s) + déclaration (+ scellés)  →  statut « Créée »
   → [CHEF BRIGADE] Valider et signer
   → [T1] saisir le(s) numéro(s) T1
   → en parallèle :  [BALISE] poser la balise (ou dispense)   ∥   [BON DE SORTIE] émettre le bon
   → [PP] contrôler (checklist) et enregistrer la SORTIE
```
Règles de saut : **type C (Conso)** saute le T1 ; **non balisée** saute aussi la Balise ;
**véhicule** saute la Balise ; **ouillage** saute Balise + Bon de sortie.

### 1.2 Le cycle de vie des conteneurs (stock)
```
STOCK PHYSIQUE :   En stock ──(Pointage matinal CFS)──► Positionné ──(dépotage)──► Dépoté
STOCK ANNONCÉ :    Annoncé ──(Pointage PP)──► Pointé ──(Confirmer entrée port sec)──► Confirmé (entre au stock)
```
- **Enlèvement** : le conteneur doit être **En stock** (stock du PIA).
- **Dépotage** : le conteneur doit être **Positionné** (pointé le matin, « stock du jour »).

### 1.3 Les postes et leurs responsabilités
| Poste | Rôle | Ce qu'il fait |
|---|---|---|
| **Agent CFS** | CFS | Cœur du système : crée les camions, associe conteneurs + déclarations, pose scellés, gère le stock (import, pointage matinal, entrée magasin), confirme l'entrée au port sec, état des camions à la sortie, bons de chargement / ordres d'exécution, rapports CFS. |
| **Chef brigade** | CHEF_BRIGADE | **Valide et signe** chaque cargaison avant le T1. **Lit tous les rapports** (lecture seule). Voit le « hors gabarit ». |
| **Chef adjoint / visite / division** | CHEF_* | Consultation : tableau de bord, cargaisons, véhicules, recherche, KPI. |
| **Agent T1** | T1 | Saisit les numéros de document T1 + bureau de destination. |
| **Agent Balise** | BALISE | Pose la balise GPS **ou** enregistre une dispense ; solde les dispenses (arrivée bureau). |
| **Agent Bon de Sortie** | BON_SORTIE | Émet le bon de sortie. |
| **Agent Porte Principale** | PP | Pointe l'entrée des conteneurs annoncés, confirme l'entrée au port sec, contrôle et enregistre la **sortie** finale. |
| **Administrateur** | ADMIN | Tout. Imports (stock, annonce), utilisateurs, historique, et peut exécuter **n'importe quelle étape** du circuit. |

> 💡 **Astuce testeur** : l'**admin voit tous les panneaux d'action**. Pour vivre chaque poste
> « comme le vrai agent », on se connecte avec le compte du rôle. Mais si vous êtes bloqué (compte
> manquant), l'admin peut faire l'étape à sa place.

---

## 2. RÔLE ADMINISTRATEUR — préparer le terrain
Connectez-vous en **admin**. On crée d'abord de quoi jouer les scénarios.

### 2.1 Importer un petit stock de test ⚙️
Préparez un fichier Excel `stock_test.xlsx`, **1re ligne = entêtes**, colonnes dans cet ordre exact :
`numeroTC · taille · dateEntree · anneeDeclaration · typeDeclaration · numeroDeclaration`

| numeroTC | taille | dateEntree | anneeDeclaration | typeDeclaration | numeroDeclaration |
|---|---|---|---|---|---|
| ZZZU0000001 | 20' | 01/07/2026 | 2026 | T | N° 99001/2026 |
| ZZZU0000002 | 20' | 01/07/2026 | 2026 | T | 99001 |
| ZZZU0000003 | 40' | 01/07/2026 | 2026 | C | 99002 |
| ZZZU0000004 | 40' | 01/07/2026 | 2026 | T | 99003 |
| ABCD123 | 20' | 01/07/2026 | 2026 | T | 99004 |

- ➤ Menu **Stock initial (import)** → choisir le fichier ✓ « 4 ligne(s) prêtes » (la ligne `ABCD123` mal formée est **ignorée**)
- ➤ **Importer** ✓ « 4 ajouté(s), 0 mis à jour, 1 ignoré(s) »
- ➤ Menu **Stock conteneurs** ✓ les 4 ZZZU sont **En stock**, colonne **N° décl.** = `992026`/`99001`/`99002`/`99003` (le N° est réduit aux **chiffres**)
- ☐ Fait

### 2.2 Importer une annonce de transfert de test ⚙️
Fichier `annonce_test.xlsx`, colonnes : `numeroTC · taille · dateEntree · anneeDeclaration · bureauDeclaration · typeDeclaration · numeroDeclaration`

| numeroTC | taille | dateEntree | anneeDeclaration | bureauDeclaration | typeDeclaration | numeroDeclaration |
|---|---|---|---|---|---|---|
| ZZZU0000010 | 20' | 05/07/2026 | 2026 | TG120 | T | 99010 |
| ZZZU0000011 | 40' | 05/07/2026 | 2026 | TG120 | C | 99011 |

- ➤ Menu **Annonce de transfert** → fichier → **Importer l'annonce** ✓ « 2 annoncé(s) »
- ➤ Menu **Stock annoncé** ✓ 2 **Annoncé**, 0 pointé, taux 0 %
- ☐ Fait

### 2.3 Fonctions d'administration (on y reviendra au §12)
- ☐ Menu **Utilisateurs** s'affiche (liste des comptes)
- ☐ Menu **Historique** s'affiche (journal d'audit)

---

## 3. RÔLE CFS (Agent CFS) — le poste central
Connectez-vous avec un compte **CFS** (`testagent`). On teste **tout** le menu CFS.

### 3.1 Pointage matinal (positionner un conteneur pour le dépotage) ⚙️ autocomplétion
- ➤ Menu **Pointage matinal**. Dans le champ, **commencez à taper `ZZZ`** ✓ la liste **propose** ZZZU0000001..4 (compteur « 4 conteneur(s) disponible(s) »)
- ➤ Choisir **ZZZU0000003** → **Valider** ✓ « Enregistré », il passe **Positionné**
- ➤ Menu **Stock CFS journalier** ✓ ZZZU0000003 y figure (Positionné)
- ✗ Re-pointer ZZZU0000003 ✓ **refus** « DÉJÀ POINTÉ »
- ☐ Fait

### 3.2 Créer un camion + ENLÈVEMENT (fil conducteur A)
- ➤ Menu **Créer un camion** → N° camion **TEST001**, Type **Enlèvement** → **Créer** ✓ ouvre le détail, statut **Camion créé**
- ➤ Panneau **CFS — associer un conteneur** : dans « N° conteneur », taper `ZZZ` ✓ propose le **stock En stock** (ZZZU0000001, 2, 4 ; le 3 positionné n'y est pas)
  - N° conteneur **ZZZU0000001**, Taille **20'**, Type `DRY`, **Scellé** `TESTSC-01`
  - Déclaration : Déclarant **TEST ACP**, Contact `90000000`, Destination `LOME`, Bureau `TG120`, Type **T**, N° décl **99001**, Année **2026**, **Date de la déclaration** `01/07/2026`, **Nb conteneurs** `2`, Description `MARCHANDISE TEST`
  - ➤ **Ajouter le conteneur** ✓ « Conteneur ajouté », statut **Créée**
- ➤ Ajouter le 2e (binôme 20') : **ZZZU0000002**, 20', scellé `TESTSC-02` (déclaration déjà portée) ✓ accepté (2×20' = binôme)
- ✗ Test binôme : essayez d'ajouter un 3e conteneur ✓ **refus** « 2 conteneurs maximum (binôme 20') »
- ☐ Fait (gardez TEST001 pour le §10.A)

### 3.3 Créer un camion + DÉPOTAGE (fil conducteur B) ⚙️ autocomplétion
- ➤ **Créer un camion** → **TEST002**, Type **Dépotage** → Créer
- ➤ Panneau CFS : champ conteneur, taper `ZZZ` ✓ propose le **stock Positionné** (ZZZU0000003 uniquement)
  - Conteneur **ZZZU0000003**, Taille **40'**, Type `DRY` (pas de scellé en dépotage)
  - Déclaration : Déclarant **TEST ACP**, Contact `90000000`, Destination `LOME`, Type **T**, N° décl **99002**, Année 2026, Date `01/07/2026`, Nb conteneurs `1`, Description `TEST DEPOT`
  - ➤ **Ajouter le conteneur** ✓ statut **En cours de chargement**
- ➤ **Finaliser le dépotage** : Hauteur `3.5`, Nb colis `100`, Scellés camion `TESTP1`, `TESTP2` → **Finaliser → Créée** ✓ statut **Créée**
- ✗ **Test « saisie manuelle »** : sur un autre camion dépotage, cochez « Saisie manuelle (conteneur partagé) » et saisissez un conteneur **non positionné** ✓ accepté (contourne le contrôle stock)
- ☐ Fait (gardez TEST002 pour le §10.B)

### 3.4 Test « hors gabarit » (automatique) ⚙️
- ➤ Refaites un dépotage (TEST003) et à la finalisation, mettez **Hauteur `5`** ✓ à l'ouverture du détail, l'entête indique **Hors gabarit : Oui (5 m)** ; le chef brigade verra l'alerte (§4)
- ☐ Fait

### 3.5 Saisir / compléter
- ➤ Menu **Saisir / compléter** ✓ liste les camions encore à l'étape CFS (les « Camion créé » / « En cours de chargement »)
- ☐ Fait

### 3.6 Nouveau (Véhicule / Conso / MAD)
**a) Véhicule + effets divers** ⚙️
- ➤ Menu **Nouveau** → Type **Dépotage / Véhicule**
  - **Déclaration** (en haut) : Déclarant **TEST ACP**, Contact `90000000`, Destination `NIGER`, Type **T**, N° décl **99005**, Année 2026, Date `01/07/2026`, Nb conteneurs `1` (Description facultative pour un véhicule)
  - **Conteneur & véhicules** : **Conteneur d'origine (TC)** = choisir **ZZZU0000003** (positionné) ; Châssis **TESTVIN0001**, Marque `TOYOTA`, Modèle `HILUX`, Couleur `BLANC`, Destination **Transit**
  - ➤ **＋ Ajouter un véhicule** (optionnel) : un 2e châssis `TESTVIN0002`
  - **Effets divers** (en bas) : **＋ Ajouter un camion** → N° camion **TEST010**, **Désignation** `CARTONS DIVERS`, « Chargement terminé » coché → Scellés `TESTE1`, `TESTE2`
  - ➤ **Créer le véhicule** ✓ « Véhicule créé »
- ✗ Créer un véhicule **sans TC d'origine** ✓ **refus** « conteneur d'origine (TC) est obligatoire »
- ✗ Camion d'effets divers **sans désignation** ✓ **refus** « la désignation est obligatoire »
- ☐ Fait

**b) Conso (type C)** ⚙️
- ➤ Menu **Nouveau** → Type **Conso (type C)**
  - Déclaration en haut ; choisir **Type T** ✓ **pas** de sélecteur balise (parcours complet T1 + Balise)
  - Repasser **Type C** ✓ le sélecteur **balise** apparaît (À baliser / Non balisée)
  - Remplir (N° décl **99006**…), N° camion **TEST020**, Conteneur `ZZZU0000004`, Taille 40', Type `DRY`, Scellé `TESTSC-C`
  - ➤ **Créer** ✓ créé ; le détail montrera « T1 (sauté) » si type C
- ☐ Fait

**c) Sortie Magasin / MAD** ⚙️
- ➤ Menu **Nouveau** → Type **Sortie Magasin / MAD** : N° camion **TEST030**, Déclaration (type **T** → garde le T1 ; type **C** → le saute), **Créer** ✓ créé (marchandise en vrac, sans conteneur)
- ☐ Fait

### 3.7 Stock — écrans de consultation
- ➤ **Stock conteneurs** ✓ compteurs (Total / En stock / Positionné / Dépoté / EVP) + colonne N° décl.
- ➤ **Stock CFS journalier** ✓ liste des Positionnés
- ☐ Fait

### 3.8 Entrée Magasin / MAD (marquer un conteneur dépoté)
- ➤ Menu **Entrée Magasin/MAD** → saisir un conteneur (ex. `ZZZU0000004`) → **Valider** ✓ passe **Dépoté**
- ☐ Fait

### 3.9 Confirmer l'entrée au port sec (EN LOT) ⚙️
> (Nécessite d'avoir des conteneurs **Pointés** par la PP — voir §9.1. Faites le §9 d'abord, ou en admin.)
- ➤ Menu **Confirmer entrée (port sec)** ✓ liste les conteneurs **Pointés** avec cases à cocher
- ➤ **Tout cocher** → **Valider l'entrée (N)** ✓ « N entrée(s) validée(s) », ils passent **Confirmé** et **entrent au stock**
- ➤ Bouton **Actualiser** ✓ recharge la liste
- ☐ Fait

### 3.10 Pointage des camions à la sortie (état CFS)
- ➤ Menu **Pointage camions (sortie)** ✓ liste les camions/véhicules présents + compteurs
- ➤ Cliquer une ligne → dans le détail, panneau **État du camion** : choisir **Fin de chargement** → Enregistrer ✓ enregistré
- ☐ Fait

### 3.11 Bon de chargement + Ordre d'exécution (impression)
- ➤ Menu **Bon de chargement** → N° déclaration **99001** → **Rechercher** ✓ liste les camions/véhicules « Créée » de cette déclaration + compteurs
- ➤ Bouton **🖨 Ordre d'exécution** ✓ un onglet s'ouvre avec le formulaire OTR prêt à imprimer (autorisez les fenêtres surgissantes)
- ☐ Fait

### 3.12 Rapports CFS
- ➤ **Rapport CFS** ✓ tableau par opération + **Export Excel** (un fichier se télécharge)
- ➤ **Rapport véhicules** ✓ stats + par destination
- ➤ **KPI / EVP** ✓ chiffres
- ➤ **Camions en instance** ✓ liste + alerte ≥ seuil
- ➤ **Séjour conteneurs** ✓ liste + tranches
- ☐ Fait

### 3.13 Mon compte
- ➤ Menu **Mon compte** → changer le mot de passe (ancien + nouveau ≥ 6) ✓ « Mot de passe changé » (remettez-le si besoin)
- ☐ Fait

### 3.14 Recherche
- ➤ Menu **Recherche** → taper `TEST001` ✓ retrouve le camion, clic → détail
- ☐ Fait

---

## 4. RÔLE CHEF BRIGADE — valider + lire les rapports
Connectez-vous avec **test_chef** (CHEF_BRIGADE).

- ➤ Menu **À valider** ✓ liste les cargaisons en attente de validation (dont TEST001, TEST002…)
- ➤ Ouvrir **TEST003** (le hors gabarit) → panneau **Validation** ✓ **alerte hors gabarit** visible ; ➤ **Valider et signer** ✓ « validée et signée » ; l'étape passe au **T1**
- ➤ Valider aussi **TEST001** et **TEST002** (pour la suite des scénarios)
- ➤ Parcourir en **lecture seule** : **Rapport CFS**, **Rapport véhicules**, **Rapport Balise**, **Rapport PP**, **Dispenses**, **KPI**, **Analyse des flux**, **Délai & instance**, **Séjour conteneurs** ✓ tous s'affichent
- ✗ Le chef brigade ne doit **pas** pouvoir saisir un T1/Balise/BS (aucun panneau d'action de ces cellules) ✓ absent
- ☐ Fait

---

## 5. RÔLES CHEF ADJOINT / VISITE / DIVISION — consultation
Connectez-vous successivement avec **test_adj**, **test_visite**, **test_div**.
- ➤ Menu réduit : **Tableau de bord · Cargaisons · Véhicules · Recherche · KPI · Mon compte** ✓
- ➤ Ouvrir une cargaison ✓ consultation, **aucun** panneau d'action de cellule
- ☐ Fait (les 3 comptes)

---

## 6. RÔLE T1
Connectez-vous avec **test_t1**.
- ➤ Menu **En attente T1** ✓ liste (TEST001, TEST002…)
- ➤ Menu **Cellule T1** ✓ liste également
- ➤ Ouvrir **TEST001** (enlèvement, 2 conteneurs) → panneau **Cellule T1** : Bureau de destination `TG120`, **1 T1 par conteneur** (`TESTT1-01`, `TESTT1-02`) → **Enregistrer le T1** ✓ statut **T1 saisi**, et l'étape ouvre **Balise + Bon de sortie en parallèle**
- ➤ Ouvrir **TEST002** (dépotage) → 1 numéro T1 suffit (`TESTT1-03`) → Enregistrer ✓
- ✗ Enlèvement : laisser un conteneur sans T1 ✓ **refus** « un T1 par conteneur »
- ☐ Fait

---

## 7. RÔLE BALISE
Connectez-vous avec **balise**.
- ➤ Menu **En attente Balise** ✓ liste
- ➤ Menu **Cellule Balise** ✓ liste
- ➤ Ouvrir **TEST001** → panneau **Cellule Balise** : cocher **N° T1 correct**, choisir **Pose balise**, N° balise **TESTGPS01** → **Valider la balise** ✓ statut **GPS Installé**
- ➤ **Test dispense** : sur une cargaison **type C non balisée** (ou TEST002) → choisir **Dispense**, N° dispense **TESTDISP-01** → Valider ✓ enregistré comme dispensé
- ✗ Valider sans cocher « N° T1 correct » ✓ **refus**
- ➤ Menu **Dispenses** ✓ suivi des dispenses (en cours / terminées)
- ➤ **Solder une dispense** : une cargaison dispensée déjà **sortie** (après §9) affichera un panneau **« Confirmer l'arrivée (solder la dispense) »** → cliquer ✓ dispense soldée
- ➤ Menu **Rapport Balise** ✓ s'affiche
- ☐ Fait

---

## 8. RÔLE BON DE SORTIE
Connectez-vous avec **test_bs**.
- ➤ Menu **En attente Bon de Sortie** ✓ liste
- ➤ Menu **Cellule Bon de Sortie** ✓ liste
- ➤ Ouvrir **TEST001** → **1 bon par conteneur** (`TESTBS-01`, `TESTBS-02`) → **Émettre le bon de sortie** ✓ statut **Bon de sortie émis** ; comme la balise est faite, l'étape **PP** devient possible
- ➤ Ouvrir **TEST002** → 1 numéro (`TESTBS-03`) → Émettre ✓
- ☐ Fait

---

## 9. RÔLE PORTE PRINCIPALE (PP)
Connectez-vous avec **ppp**.

### 9.1 Pointage entrée (stock annoncé) ⚙️ autocomplétion
- ➤ Menu **Pointage entrée (annoncé)** → taper `ZZZ` ✓ propose les **Annoncés** (ZZZU0000010, 11)
- ➤ Pointer **ZZZU0000010** → Valider ✓ passe **Pointé** ; puis **ZZZU0000011**
- ✗ Re-pointer ZZZU0000010 ✓ **refus** « DÉJÀ POINTÉ »
- ✗ Pointer un TC absent (`ZZZU9999999`) ✓ **refus** « introuvable dans le stock annoncé »
- ➤ Menu **Stock annoncé** ✓ 2 pointés, 0 confirmé
- ☐ Fait

### 9.2 Confirmer entrée (port sec) — en lot ⚙️
La PP peut aussi confirmer (décision capitaine).
- ➤ Menu **Confirmer entrée (port sec)** ✓ liste les 2 pointés → tout cocher → **Valider l'entrée (2)** ✓ Confirmés + au stock
- ☐ Fait

### 9.3 Sortie finale (checklist)
- ➤ Menu **En attente sortie** ✓ liste (TEST001, TEST002 prêts)
- ➤ Menu **Sortie (checklist)** ✓ liste
- ➤ Ouvrir **TEST001** → panneau **Sortie — Porte Principale** : cocher les **4 contrôles** (CFS, T1, Balise, Bon de sortie) → **Enregistrer la sortie** ✓ statut **Sortie Enregistrée**
- ✗ Sortie avec une case décochée ✓ **refus** « Cochez les 4 contrôles »
- ➤ **Véhicule** : ouvrir un véhicule prêt → une seule case **« Informations validées »** → Enregistrer ✓
- ➤ Menu **Véhicules** ✓ liste des véhicules ; **Rapport PP** ✓ s'affiche
- ☐ Fait

---

## 10. SCÉNARIOS COMPLETS (bout en bout) — récapitulatif
Si vous avez suivi §3→§9, vous avez déjà bouclé **A** et **B**. Vérifiez ici que chaque circuit va bien jusqu'au bout.

- ☐ **10.A — Enlèvement (TEST001)** : CFS → Chef → T1 → Balise → BS → PP = **Sortie Enregistrée**
- ☐ **10.B — Dépotage (TEST002)** : idem
- ☐ **10.C — Véhicule + effets divers** : CFS crée → Chef valide → (véhicule saute la Balise) → BS → PP (case unique)
- ☐ **10.D — Conso type C** : balisée (saute T1, garde Balise) **et** non balisée (saute T1 + Balise)
- ☐ **10.E — Magasin/MAD** : type T (garde T1) et type C (saute T1)
- ☐ **10.F — Stock annoncé** : Annonce (admin) → Pointage (PP) → Confirmation en lot
- ☐ **10.G — Dispense** : Balise « Dispense » → sortie PP → Balise solde l'arrivée bureau
- ☐ **10.H — Ouillage** : véhicule dépoté sous ouillage → statut « Véhicule ouillage créé » → CFS complète la déclaration ensuite (panneau **Ouillage**)

### Cas particuliers à cocher aussi
- ☐ **Remplacement de balise (ADMIN)** : sur une cargaison au statut « GPS Installé », en **admin**, panneau **Remplacer la balise** → nouveau N° → Remplacer
- ☐ **Correction du N° de camion** : sur n'importe quelle cargaison, section **Corriger le N° de camion** (tous rôles)
- ☐ **Chargement mixte** : associez sur un même camion deux conteneurs de **déclarations différentes** → l'appli marque « ⚠ chargement mixte » (visible sur le bon de chargement) — *automatique, pas de bouton*

---

## 11. RAPPORTS & EXPORTS (passage complet)
Connecté en **admin** (voit tout) :
- ☐ **Rapport CFS** + Export Excel
- ☐ **Rapport véhicules**
- ☐ **Rapport Balise**
- ☐ **Rapport PP**
- ☐ **KPI / EVP**
- ☐ **Dispenses**
- ☐ **Analyse des flux** (journalier / hebdo / mensuel)
- ☐ **Délai & camions en instance**
- ☐ **Séjour conteneurs**
- ☐ **Tableau de bord** : changer la période (jour/semaine/mois/année) ; cliquer une tuile → ouvre la liste filtrée

---

## 12. ADMINISTRATION
Connecté en **admin** :
- ☐ **Utilisateurs → + Nouveau** : créer un compte (déjà fait au §0.3)
- ☐ **Utilisateurs → clic sur une ligne** : `1` = activer/désactiver, `2` = réinitialiser le mot de passe, `3` = réinitialiser le 2FA (tester au moins l'activer/désactiver sur un compte **de test**)
- ☐ **Historique** : filtrer par **période**, par **utilisateur**, par **événement** ; pagination ✓ vous devez retrouver vos actions de test

---

## 13. CHECKLIST FINALE — aucune fonctionnalité oubliée
**Entrée & stock** ☐ import stock ☐ import annonce ☐ pointage matinal ☐ pointage entrée PP ☐ confirmation port sec (lot) ☐ entrée magasin/MAD ☐ stock conteneurs ☐ stock CFS journalier ☐ stock annoncé
**Création** ☐ créer camion (enlèvement) ☐ créer camion (dépotage) ☐ finaliser dépotage ☐ hors gabarit auto ☐ saisie manuelle ☐ nouveau véhicule + effets divers ☐ conso type C (balisée/non) ☐ magasin/MAD ☐ ouillage ☐ saisir/compléter
**Circuit** ☐ validation chef brigade ☐ T1 (enlèvement multi / dépotage) ☐ balise (pose) ☐ dispense ☐ arrivée bureau (solde dispense) ☐ bon de sortie ☐ sortie PP (checklist) ☐ sortie véhicule ☐ remplacement balise (admin) ☐ correction n° camion ☐ chargement mixte
**Édition & impression** ☐ bon de chargement par déclaration ☐ ordre d'exécution (impression) ☐ état camions sortie CFS
**Rapports** ☐ CFS ☐ véhicules ☐ balise ☐ PP ☐ KPI ☐ dispenses ☐ flux ☐ instance ☐ séjour ☐ tableau de bord (périodes)
**Admin & compte** ☐ créer utilisateur ☐ activer/désactiver ☐ reset mdp ☐ reset 2FA ☐ historique (filtres) ☐ recherche ☐ changer mon mot de passe ☐ autocomplétion des conteneurs (partout)

---

## 14. NETTOYAGE DES DONNÉES DE TEST (admin, dans Supabase)
Quand vous avez fini, l'admin supprime les lignes de test dans **Supabase → Table Editor** (ou SQL).
Comme l'appli ne supprime pas, ça se fait côté base. Repérez tout par la convention du §0.2 :

```sql
-- ⚠ À exécuter dans le SQL Editor de Supabase, en connaissance de cause.
delete from conteneurs where cargaison_id in (select id from cargaisons where declarant like 'TEST%');
delete from cargaisons where declarant like 'TEST%';
delete from stock          where numero_tc like 'ZZZU%';
delete from stock_annonce  where numero_tc like 'ZZZU%';
delete from declarations   where numero_declaration in ('99001','99002','99003','99005','99006','99010','99011');
-- L'audit_log n'est PAS supprimable (append-only) : les traces des actions de test y restent.
```
- ☐ Nettoyage effectué

---

## Annexe — fonctions serveur SANS bouton dédié dans l'appli (pour info)
Ces règles existent mais ne se déclenchent pas par un bouton propre — inutile de les « chercher » :
- **Hors gabarit** : automatique dès que la hauteur de dépotage dépasse 4,5 m.
- **Chargement mixte** : détecté automatiquement (déclarations différentes sur un camion).
- **Modification de scellé (visite)** et **édition complète d'une cargaison** : prévues côté serveur mais sans écran dédié (on corrige via les panneaux existants / l'admin).

---

*Prêt. On commence par le §0 (déploiement + comptes de test), puis on descend section par section.
Dès qu'une étape ne donne pas le `✓` attendu, notez le numéro (ex. « 3.6a ») et revenez me voir.*
