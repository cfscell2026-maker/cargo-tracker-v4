



## 2. Le circuit d'un camion (vue d'ensemble)

```
   ┌──────────────────────────── ENTRÉE DU STOCK ────────────────────────────┐
   │ ADMIN : importe « l'annonce de transfert » (la veille) → STOCK ANNONCÉ   │
   │ PP    : pointe le TC à son arrivée → ajouté au STOCK du port sec         │
   │ CFS   : pointe le matin certains TC → STOCK CFS JOURNALIER (positionnés) │
   └─────────────────────────────────────────────────────────────────────────┘
                                    │
        ┌──────────────┐
ENTRÉE  │   ① CFS      │  Crée le camion vide + TYPE D'OPÉRATION (Enlèvement / Dépotage),
        │              │  puis SAISIT L'OPÉRATION :
        │              │   • Enlèvement → tout (déclaration + conteneur + scellé) + nb de colis
        │              │   • Dépotage   → déclarant + conteneurs (stock journalier), PUIS scellés
        └──────┬───────┘
        ┌──────▼───────┐
        │ 🔒 VALIDATION│  CHEF BRIGADE : signature numérique. Tant qu'il n'a pas
        │  chef brigade│  validé, le T1/Balise/Bon de sortie sont BLOQUÉS.
        └──────┬───────┘
        ┌──────▼───────┐
        │   ② T1       │  N° de document de transit + bureau de destination
        │              │  (enlèvement : un T1 LIÉ à chaque conteneur)
        └──────┬───────┘
               │   ┌──────── EN PARALLÈLE ────────┐
        ┌──────▼─────┐                     ┌───────▼───────┐
        │ ③ Balise   │                     │ ④ Bon de      │
        │ ou Dispense│                     │    Sortie     │
        └──────┬─────┘                     └───────┬───────┘
               └───────────────┬───────────────────┘
                        ┌──────▼───────┐
                        │   ⑤ PP       │  Checklist finale (4 cases) → sortie
                        └──────────────┘
```



**Statuts** (sur la fiche et les listes) :

| Statut affiché | Signification | Prochaine cellule |
|---|---|---|
| **Camion créé (à compléter)** | Camion enregistré à l'entrée, aucune opération saisie | CFS (saisir l'opération) |
| **En cours de chargement** | Dépotage : déclarant + conteneurs saisis, **scellés pas encore posés** | CFS (poser les scellés) |
| **Fin de chargement / attente T1** | Opération complète (déclaration + conteneurs + scellés) | **Chef brigade (validation)**, puis T1 |
| **T1 saisi** | Document(s) de transit enregistré(s) — *après validation chef brigade* | Balise **et** Bon de Sortie (en parallèle) |
| **Balisé** *ou* **Dispensé** | Balise posée, ou dispense accordée | (attend que le Bon de Sortie soit aussi fait) |
| **Bon de sortie émis** | Bon(s) de sortie généré(s) | (attend que la Balise soit aussi faite) |
| **Sorti** | Camion sorti de la PIA | — (terminé) |

---

## 3. Connexion et comptes

- Chaque agent se connecte avec **son identifiant + mot de passe**.
- Selon son **rôle**, il ne voit **que les menus qui le concernent**.
- Le mot de passe se change dans **« Mon compte »**.
- Après 5 essais ratés, le compte est **bloqué 5 minutes** (anti-fraude).

### Les 10 rôles et qui fait quoi

| Rôle | Mission | Menus visibles (principaux) |
|---|---|---|
| **CFS** | **Crée le camion à l'entrée** (type Enlèvement/Dépotage), **saisit l'opération**, complète la déclaration & pose les scellés, **nombre de colis / hauteur**, suit l'**état des camions à la sortie CFS**, gère le **stock** (dont le **stock CFS journalier**) et les **rapports** ; crée les opérations spéciales | Créer un camion · Saisir / compléter · **État camions (sortie CFS)** · Nouveau (Véhic./Conso/MAD) · Cargaisons · Véhicules · Stock CFS journalier · Stock · Pointage matinal · Stock initial (import) · Stock annoncé · Confirmer entrée · Entrée Magasin/MAD · Rapports · KPI · Camions en instance · Séjour conteneurs |
| **Chef brigade** | **Valide (signe)** chaque cargaison après le CFS, **avant** que T1/Balise/Bon de sortie agissent ; **seul** à voir le signalement « hors gabarit » (à la validation) ; voit tout | À valider · Cargaisons · Véhicules · Recherche |
| **Chef brigade adjoint** | **Superviseur** : consulte tout (ne valide pas) | Cargaisons · Véhicules · Recherche · KPI |
| **Chef visite** | **Superviseur** : consulte tout | Cargaisons · Véhicules · Recherche · KPI |
| **Chef division** | **Superviseur** : consulte tout | Cargaisons · Véhicules · Recherche · KPI |
| **T1** | Saisit le(s) **document(s) T1** + bureau de destination (enlèvement : un T1 **par conteneur**) | Cellule T1 · En attente T1 |
| **Balise** | Pose la **balise** ou accorde une **dispense** | Cellule Balise · En attente Balise · Dispenses · Rapport Balise |
| **Bon de Sortie** | Émet le(s) **bon(s) de sortie** (enlèvement : un bon **par conteneur**) | Cellule Bon de Sortie · En attente Bon de Sortie |
| **PP** (Porte Principale) | **Pointe les conteneurs annoncés à l'entrée**, valide la **sortie** (checklist finale). *(Ne crée plus le camion ; ne saisit plus l'état.)* | Pointage entrée (annoncé) · Stock annoncé · Sortie (checklist) · En attente sortie · Véhicules · Rapport PP |
| **ADMIN** | **Tout** : importe l'**annonce de transfert**, modifie n'importe quoi à n'importe quel statut, gère les comptes, voit tous les rapports | tous les menus |

> Les anciens comptes « Porte CFS » sont **automatiquement migrés** vers le rôle **CFS**
> à la mise à jour. La **création des camions** est faite par le **CFS**.

---

## 4. Le tableau de bord

Première page après connexion. Des **cartes cliquables** indiquent combien de
camions sont à chaque étape :

- **Total camions** · **Camions créés (à compléter)** · **En cours / décl. à compléter**
- **Attente T1** · **Attente Balise** · **Attente Bon de sortie** · **Attente sortie (PP)**
- **Sortis (terminés)** · **Enregistrés aujourd'hui** · **Véhicules en attente de sortie**

**Filtre de période** (en haut) : les compteurs portent sur les cargaisons **créées dans la
période** choisie — **Hebdomadaire par défaut**, options **Journalier / Mensuel / Annuel**.
La plage de dates couverte s'affiche sous le sélecteur.

> Comme la Balise et le Bon de Sortie sont **en parallèle**, un même camion peut
> compter à la fois dans **Attente Balise** et **Attente Bon de sortie**.

👉 **Clique une carte** → liste filtrée ; **clique une ligne** → fiche du camion.

---

## 5. ① CELLULE CFS — créer le camion & saisir l'opération

### A. Créer le camion (CFS, menu « Créer un camion »)
1. Saisis le **N° du camion** + le **Type d'opération** : **Enlèvement** ou **Dépotage**.
2. **Anti-doublon** : un N° **déjà actif** ne peut **pas** être recréé tant qu'il n'est pas **sorti**.
3. Le camion est créé **vide** (statut **Camion créé**) ; tu enchaînes sur la saisie de l'opération.

### B. Saisir l'opération (menu « Saisir / compléter »)

Le **type d'opération est déjà fixé** à la création : il ne se rechoisit plus. Renseigne la
**Déclaration** (déclarant, contact, destination, **Type de déclaration** = liste **T · C · S · A · E**,
N° de déclaration, année, description). Le type **« D »** n'apparaît pas ici : c'est un type de
**document T1**, saisi à l'étape T1.

**➤ Enlèvement — tout en une fois :**
- Déclaration **complète** obligatoire.
- **Conteneur** choisi **dans le stock** : sa **Taille** se remplit **automatiquement** ; le **Type**
  se **saisit à la main** et est **facultatif** (le stock ne le fournit pas).
- **Scellé/Plomb obligatoire**.
- → Statut **« Fin de chargement / attente T1 »**.
- **Binôme 20'** : un 2ᵉ conteneur possible **uniquement si les deux sont des 20'**.
- **Chaque conteneur ajouté se saisit avec TOUS les champs du 1er** (déclarant, contact,
  destination, bureau, type, N° de déclaration, année, nombre de conteneurs, **description**) :
  deux conteneurs peuvent donc porter **deux déclarations différentes** (chargement mixte).

**➤ Dépotage — une déclaration COMPLÈTE par conteneur, puis hauteur/colis, puis scellés :**
1. Pour **chaque** « Ajouter un conteneur », saisis **la déclaration complète propre à ce
   conteneur** : déclarant, contact, destination, bureau, type, N° de déclaration, année,
   nombre de conteneurs, description — **+ le conteneur**. Ainsi **deux conteneurs d'un même
   camion peuvent porter deux déclarations différentes** (déclarants différents inclus).
   - Conteneur **obligatoirement du stock CFS journalier** (positionnés). Taille auto, **type
     facultatif**. *Conteneur **partagé** :* coche **« Saisir le conteneur manuellement »**.
2. Quand tous les conteneurs sont ajoutés, panneau **« CFS — Finaliser le dépotage »** :
   saisis **la hauteur du chargement** + **le nombre de colis**, puis pose les **scellés du
   camion (2 à 3)** → statut **« Fin de chargement / attente T1 »**.
3. 🔒 **Hors gabarit automatique** : si la **hauteur dépasse 4,5 m**, le système marque la
   cargaison **« hors gabarit »** et la **signale automatiquement au chef brigade** (voir §5 bis).
   *(Le hors gabarit n'existe **qu'en dépotage**, pas en enlèvement.)*

> ⚠️ **Le conteneur vient du stock.** Si le N° n'est pas dans le stock, l'ajout est refusé.
>
> 🔁 **Conteneur partagé entre deux camions (dépotage).** Comme le conteneur a déjà été
> « consommé » par le premier camion, il n'est plus proposé. Coche alors **« Saisir le
> conteneur manuellement (conteneur partagé) »** : tu saisis le N° à la main (et sa
> taille/type) sans passer par le stock.

### Détection des doublons
Saisir un **N° camion** ou un **conteneur déjà enregistré** déclenche un **avertissement**
(lien vers la fiche existante), **rouge fort** si l'autre cargaison est **active**.

---

## 5 bis. 🔒 VALIDATION — Chef brigade (signature numérique)

> **Maillon obligatoire**, inséré **entre le CFS et le reste**. Tant que le chef brigade n'a
> pas validé, **le T1, la Balise et le Bon de sortie sont bloqués** (ils ne peuvent ni agir ni
> modifier). S'applique à **toutes les opérations**.

- Agent **Chef brigade** (ou Admin). Menu **« À valider »** → liste des cargaisons en attente de
  validation → ouvre la fiche → panneau **« Validation — Chef brigade »**.
- Il clique **« Valider et signer »** : l'appli pose une **signature numérique** (empreinte +
  horodatage + nom du validateur), visible dans le parcours de la cargaison.
- Si la cargaison est **hors gabarit**, le panneau l'affiche en rouge (**signalé automatiquement**
  par le système, pas par le chef).
- Seuls **le chef brigade et l'Admin** peuvent valider. Les autres chefs (adjoint, visite,
  division) **consultent** mais ne valident pas.

### Champs « Nombre de colis » et « Hors gabarit »
- **Nombre de colis** : saisi par le **CFS** (enlèvement : à l'opération ; dépotage : à l'étape
  hauteur/scellés). **Visible de tous**.
- **Hauteur du chargement** : saisie par le **CFS** en **dépotage** (avant les scellés).
- **Hors gabarit** (**dépotage uniquement** — il n'existe **pas** en enlèvement) : **déterminé
  AUTOMATIQUEMENT** dès que la hauteur saisie **> 4,5 m**. Le **seul affichage** est un **signalement
  au chef brigade**, dans son panneau de validation (⚠ HORS GABARIT + hauteur). Il n'y a **plus de
  carte hors gabarit** pour les autres chefs/le CFS, et **aucun affichage en enlèvement**.

---

## 6. ② CELLULE T1 — document de transit

> Agent **T1**. Menu **« Cellule T1 »** ou **« En attente T1 »**.

Sur la fiche, panneau **Cellule T1** :
- **Bureau de destination** : autocomplétion des bureaux.
- **Numéro(s) T1** :
  - **Enlèvement (1 pour 1)** : on **lie chaque T1 à un conteneur** via un **menu déroulant**
    des conteneurs de la cargaison. Quand un conteneur est choisi, il **disparaît** de la
    liste pour le T1 suivant ; on continue jusqu'à ce que chaque conteneur ait son T1.
  - **Dépotage (1 pour plusieurs)** : au moins **un** T1 (numéros libres).
- Valider → statut **T1 saisi** : le camion entre **dans les deux files** (Balise et Bon de Sortie).

---

## 7. ③ CELLULE BALISE — baliser ou dispenser  *(en parallèle du Bon de Sortie)*

> Agent **Balise**. Menu **« Cellule Balise »** ou **« En attente Balise »**.
> ⚠️ Le **remplacement** d'une balise est réservé à l'**Administrateur**.

1. **Coche « Numéro T1 correct »** (obligatoire).
2. Choisis **Baliser** (saisis le N° de balise) **ou Dispense** (saisis le N° d'autorisation).
3. Valider → la fiche affiche **« Balisé »** ou **« Dispensé »** selon le cas.

> Indépendant du Bon de Sortie (avant ou après). Les **dispenses** sont suivies à part (voir §12).

---

## 8. ④ CELLULE BON DE SORTIE  *(en parallèle de la Balise)*

> Agent **Bon de Sortie**. Menu **« Cellule Bon de Sortie »** ou **« En attente Bon de Sortie »**.

- **Enlèvement** : **un bon de sortie par conteneur**, pré-associé à son **T1** (la liste
  affiche conteneur + T1, tu saisis le numéro de bon en face).
- **Dépotage** : **un bon par déclaration** (un seul numéro).
- → statut **Bon de sortie émis**. On ne revérifie pas la balise (c'est le rôle de la PP).

> ➜ Quand **Balise ET Bon de Sortie** sont **tous deux** faits, le camion passe en **« Attente sortie (PP) »**.

---

## 9. ⑤ PORTE DE SORTIE (PP) — contrôle final

> Agent **PP**. Menu **« Sortie (checklist) »** ou **« En attente sortie »**.
> Le camion n'apparaît ici **que si la Balise et le Bon de Sortie sont tous deux faits**.

1. L'agent **coche 4 cases** : ☑ Rapport CFS conforme · ☑ Numéro(s) T1 valide(s) ·
   ☑ Numéro de balise vérifié · ☑ Numéro du bon de sortie vérifié.
2. **Valider** → statut **Sorti**.

> ℹ️ L'**état du camion** (en cours de chargement / fin de chargement / vide) **n'est plus saisi
> ici** : il est géré par le **CFS** dans l'onglet **« État camions (sortie CFS) »** (voir ci-dessous).

---

## 10. Opérations spéciales (créées par le CFS via « Nouveau rapport »)

> Modèle **« Nouveau rapport » = 1 déclaration + N camions/véhicules**, menu
> **« Nouveau (Véhic./Conso/MAD) »**. Ne passe pas par « Créer un camion ».

### A. Dépotage / Véhicule — deux régimes : **Déclaration** ou **Ouillage**

À la création, on choisit le **régime** :

**➤ Régime « Déclaration » (flux normal)**
- **Déclaration** (déclarant, contact, destination, bureau, type, n° décl, année) — **sans champ
  désignation** : la **désignation de la marchandise** se saisit dans le **mini-onglet des effets
  divers** (là où on ajoute le camion d'effets divers ; les **scellés restent au niveau du camion**).
- **Véhicules** : VIN, marque, modèle, couleur, **destination** (Transit/Conso/MAD/Abandonné).
- Le **conteneur d'origine** est **décompté du stock CFS journalier** (Positionné → Dépoté),
  comme tout conteneur dépoté ; pour les effets divers du conteneur de véhicule, utiliser la
  **saisie manuelle** de l'onglet Dépotage pour éviter la **double comptabilisation**.
- Parcours : les véhicules **sautent la Balise** (Validation → T1 → Bon de Sortie → PP).

**➤ Régime « Ouillage » (permis d'examiner — on dépote AVANT la déclaration)**
1. À la création, on renseigne **uniquement** le **N° de l'ouillage** + sa **date** + les
   **informations des véhicules** → statut **« Véhicule ouillage créé »**.
2. **Ensuite**, on renseigne la **déclaration VÉHICULE PAR VÉHICULE** (panneau « Ouillage —
   Compléter la déclaration » sur la fiche du véhicule).
3. Le **type de déclaration** choisi fixe le parcours :
   - **Transit (T)** : passe par la **cellule T1**, **saute la Balise ET le Bon de sortie**,
     sort à la **PP** ;
   - **Autres régimes (Conso, MAD…)** : va **directement à la PP** (saute T1, Balise et Bon de
     sortie) — toujours après la **validation du chef brigade**.

Rapport dédié : **« Rapport véhicules »**.

### B. Autres opérations spéciales
- **Conso (type C)** : **À baliser** (saute le T1) ou **Non balisée** (saute T1 ET Balise = dispense).
- **Sortie Magasin / MAD** : Temps 1 = **Entrée Magasin/MAD** (conteneur dépoté) ; Temps 2 =
  cargaison **en vrac** qui sort.

---

## 11. Gestion du stock & des transferts

### A. Annonce de transfert (ADMIN) — menu « Annonce de transfert »
- **La veille** du transfert, l'administrateur **importe un fichier `.xlsx`** à **7 colonnes** :
  **N° conteneur · Taille · Date d'entrée · Année décl. · Bureau décl. · Type décl. · N° décl.**
- Un **aperçu** s'affiche → validation. Les TC annoncés vont dans le **« stock annoncé »**.

### B. Pointage entrée (PP) — menu « Pointage entrée (annoncé) »
- À l'arrivée du conteneur, la **Porte Principale** saisit son N° — **proposé en autocomplétion
  depuis le stock annoncé** (liste des « Annoncé » non encore pointés).
- Il passe de **« Annoncé »** à **« Pointé »**. ⚠️ **Il n'entre PAS encore au stock** : le **CFS
  doit le confirmer** (voir C).

### C. Confirmation d'entrée (CFS) — menu « Confirmer entrée (annoncé) »
- Le **CFS** voit la liste des conteneurs **pointés** par la PP (en attente).
- Il **confirme** : le conteneur passe **« Pointé » → « Confirmé »** et entre **effectivement au
  stock du port sec**. C'est le **double contrôle** entrée (PP) / confirmation (CFS).

### D. Stock annoncé (suivi) — menu « Stock annoncé »
- **Non pointés** · **Pointés (à confirmer)** · **Confirmés (au stock)** · **Taux de transfert
  effectif** (= confirmés) · **Délai moyen** · **instance max**. Filtre par statut.

### D. Stock initial (import) — menu « Stock initial (import) » *(CFS / Admin)*
- Import en masse des TC **déjà présents** sur site / venant du port autonome. Fichier `.xlsx`
  au **même format que l'annonce de transfert, SANS le bureau**, soit **6 colonnes dans l'ordre** :
  **N° conteneur · Taille · Date d'entrée · Année de déclaration · Type de déclaration · N° de
  déclaration**. Le **N° de déclaration** est ramené aux **chiffres uniquement** à l'import. Un TC
  déjà présent est mis à jour (import journalier). *(Le bug de « verrouillage expiré » est corrigé :
  l'import traite désormais tout le fichier en une passe.)*

### E. Pointage matinal (CFS / Admin) — menu « Pointage matinal »
- Chaque matin, le CFS **pointe les TC** à dépoter : ils passent **En stock → Positionné** et
  forment le **stock CFS journalier**. Bloque si déjà pointé.
- ⚠️ **En dépotage, on ne peut rattacher QUE des conteneurs positionnés** (du stock journalier).
  Un conteneur pas encore pointé est refusé.

### F. Stock CFS journalier (CFS) — menu « Stock CFS journalier »
- Liste des conteneurs **positionnés** du jour avec leur état : **Non ouvert** (positionné, pas
  encore dépoté) / **Ouvert** (déjà dépoté). Compteurs associés.

### F bis. État camions — sortie CFS (CFS) — menu « État camions (sortie CFS) »
- **Traçabilité des camions sur le site.** Le CFS indique, pour chaque camion, son **état à la
  sortie de la zone CFS** : **En cours de chargement** / **Fin de chargement** / **Vide**.
- L'écran liste les **camions présents sur le site** (non encore sortis) avec des **compteurs**
  par état, et des boutons pour définir/mettre à jour l'état de chaque camion.
- *(Cet état était auparavant saisi par la PP à la sortie ; il est désormais géré par le CFS.)*

### G. Stock conteneurs & Séjour conteneurs
- **Stock conteneurs** : inventaire + compteurs (En stock / Positionné / Dépoté), **EVP**, séjour.
- **Séjour conteneurs** : **jours de séjour** (date du jour − date d'entrée), tranches d'âge,
  séjour moyen, export Excel/PDF.

---

## 12. Dispenses (cycle de vie)

Menu **« Dispenses »** (Balise / Admin) : **Total / En cours / Terminées**. Une dispense est
**terminée** quand on confirme l'**Arrivée au bureau de destination** (bouton **« Solder »**).

---

## 13. Recherche, corrections et éditions

- **Recherche** (tous rôles) : par **N° de camion**, souple (espaces/tirets/casse ignorés).
- **Corriger N° camion** (tous rôles, à tout statut), journalisé.
- **Visite** (CFS/Admin, enlèvement) : modifier le **scellé** d'un conteneur après inspection.
- **Chargement mixte** / **Éditer** (CFS tant que « Créée » ; Admin toujours).

---

## 14. Rapports & indicateurs (KPI)

| Rapport | Qui | Contenu |
|---|---|---|
| **Rapport CFS** | CFS / Admin | Camions & conteneurs par période et opération (+ **EVP**) |
| **Rapport Balise** | Balise / Admin | Camions balisés, **TWINS**, dont **sans balise** (+ EVP) |
| **Rapport PP** | PP / Admin | Sorties par période |
| **Rapport véhicules** | CFS / Admin | Véhicules par **destination** |
| **Stock annoncé** | PP / CFS / Admin | Annoncés non pointés / pointés / **taux de transfert** / délai & instance |
| **Analyse des flux** | Admin | CFS / Balise / PP par jour / semaine / mois |
| **Camions en instance** | CFS / Admin | Délai création→sortie, tranches d'âge, alerte ≥ 90 j |
| **Séjour conteneurs** | CFS / Admin | Durée de séjour des conteneurs en stock |
| **KPI / EVP** | tous | Vidés, sortis scellés, flux, stock par 20'/40'/45', **tout en EVP** |
| **Dispenses** | Balise / Admin | Total / en cours / terminées |

> **Toutes les cartes** sont cliquables → détail → fiche. Export **Excel / PDF**.

---

## 15. Administration (Admin)

- **Annonce de transfert** : import du fichier des TC à transférer (la veille).
- **Utilisateurs** : créer / éditer / activer-désactiver / réinitialiser le mot de passe (6 rôles).
- **Historique** : journal de **toutes les actions**, filtrable + export.
- **Pouvoirs Admin** : modifier n'importe quelle cargaison à n'importe quel statut, piloter
  n'importe quelle cellule, voir les rapports de tous les agents.

---

## 16. Règles & contrôles importants

- **C'est le CFS qui crée le camion à l'entrée** (en choisissant le type : Enlèvement / Dépotage)
  puis saisit l'opération. La **PP** ne fait que le pointage d'entrée des annoncés et la sortie.
- **Validation obligatoire du chef brigade** après le CFS : sans sa signature, T1/Balise/Bon de
  sortie sont bloqués (toutes opérations). Seuls chef brigade + Admin valident.
- **« Hors gabarit » AUTOMATIQUE** (dépotage seulement, jamais en enlèvement) : hauteur saisie par
  le CFS **> 4,5 m** ⇒ **signalé au chef brigade** (seul affichage, dans son panneau de validation).
  **« Nombre de colis »** : saisi par le CFS, visible de tous.
- **Anti-doublon camion** : un N° actif ne peut pas être recréé tant qu'il n'est pas sorti.
- **Dépotage = conteneur du stock CFS journalier** (positionné le matin) obligatoire ;
  **taille auto-remplie, type facultatif** ; **saisie manuelle** possible pour un conteneur **partagé**.
- **État camion à la sortie CFS** (onglet CFS) : en cours de chargement / fin de chargement / vide
  — traçabilité des camions sur le site.
- **Type de déclaration** : liste **T · C · S · A · E** (le **D** est un type de document **T1**).
- **Déclaration par conteneur** → chargement mixte possible.
- **Scellés** : enlèvement = 1/conteneur ; dépotage = 2 (min) à 3 (max) au **camion**, posés **en dernier**.
- **Binôme 20'** : 2 conteneurs sur un camion uniquement si les deux sont des 20'.
- **T1** : enlèvement = **un T1 lié à chaque conteneur** (distincts) ; dépotage = ≥ 1.
- **Bon de sortie** : enlèvement = **un bon par conteneur (lié au T1)** ; dépotage = 1 par déclaration.
- **Balise ∥ Bon de Sortie** en parallèle ; la **PP** exige **les deux**.
- **Véhicules** : désignation de la marchandise dans les **effets divers** (pas dans la déclaration) ;
  le conteneur d'origine est **décompté du stock CFS journalier** (jamais compté deux fois).
- **Ouillage** (véhicules) : dépotage possible **avant la déclaration** (n° + date du permis) ;
  déclaration renseignée ensuite **par véhicule** — **Transit → T1 → PP** (saute Balise + Bon de
  sortie) ; **Conso/MAD → directement PP**.
- **Format conteneur (TC)** : 4 lettres + 7 chiffres (ISO 6346). **Téléphone** : chiffres/espaces/`+`.
- **Doublons** = avertissement, jamais blocage. **Sauvegarde quotidienne** automatique.

---

## 17. Glossaire

- **Cargaison** : un camion + ses conteneurs (ID `CT-…`).
- **CFS** : cellule qui **crée le camion**, **saisit l'opération** (déclaration, conteneurs,
  scellés, colis, hauteur), suit l'**état des camions** et gère le stock.
- **PP** : Porte Principale — pointe les conteneurs annoncés à l'entrée et valide la **sortie**.
- **Chef brigade** : valide (signe) chaque cargaison après le CFS, avant T1/Balise/Bon de sortie.
- **Chef brigade adjoint / chef visite / chef division** : superviseurs (lecture de tout).
- **Validation (signature)** : empreinte numérique horodatée posée par le chef brigade.
- **Routage** : type d'opération choisi à la création du camion (Enlèvement / Dépotage).
- **Stock annoncé** : conteneurs annoncés (transfert) en attente de pointage PP puis confirmation CFS.
- **Stock CFS journalier** : conteneurs **positionnés** (pointés le matin), seuls rattachables en dépotage.
- **État camion (sortie CFS)** : état noté par le CFS (en cours / fin de chargement / vide).
- **T1** : document de transit douanier (lié à un conteneur en enlèvement).
- **Balise / Dispense** : balise GPS de suivi / autorisation de circuler sans balise.
- **Bon de Sortie** : document autorisant la sortie (lié au conteneur en enlèvement).
- **Hors gabarit** : chargement de **hauteur > 4,5 m** (**dépotage uniquement**) — **détecté
  automatiquement**, **signalé au seul chef brigade** (à la validation).
- **Ouillage** (permis d'examiner) : régime permettant de **dépoter des véhicules AVANT la
  déclaration** ; la déclaration est renseignée après, **par véhicule**.
- **TWINS** : *(enlèvement)* camion à **2 conteneurs 20'** (binôme, 1 balise).
- **EVP** : Équivalent Vingt Pieds. 20' = 1 ; 40' = 45' = 2.
- **Apurement** : nombre de conteneurs restant à traiter sur une déclaration.
- **Séjour** : jours en stock (date du jour − date d'entrée).
- **Taux de transfert** : part des conteneurs annoncés effectivement confirmés au stock.
- **Dépoté** : conteneur ouvert/vidé (sorti du yard / consommé).
- **Positionné** : conteneur placé et pointé le matin, prêt à être ouvert.

---

## 18. Installation / mise à jour (rappel technique)

L'application est un **Google Sheet + Google Apps Script**. Après toute mise à jour :
1. Recopier les fichiers `.gs` et `.html` dans l'éditeur Apps Script.
2. Lancer **`initialiserApplication`** (crée/migre feuilles et colonnes — dont *N° Ouillage*,
   *Date Ouillage*, *Saute Bon de sortie* — sans perte de données).
3. **Redéployer une nouvelle version** de l'application web.
4. Vérifier les **comptes** (10 rôles : CFS, Chef brigade, Chef brigade adjoint, Chef visite,
   Chef division, T1, Balise, Bon de Sortie, PP, Admin). **Prévoir au moins un compte CFS**
   (crée les camions) **et un compte Chef brigade** (sans lui, rien ne passe après le CFS).

> ℹ️ Les **imports Excel** (annonce de transfert, stock initial) s'appuient sur une librairie
> chargée en ligne : prévoir une **connexion Internet** sur le poste qui réalise l'import.

---

*Fin du guide. Pour une fiche mémo d'1 page par rôle (à imprimer), demandez-la.*



