# Normalisation de la base Cargo Tracker : diagnostic 5FN (19/10/2026)

## Réponse courte

**Non, la base actuelle ne respecte pas la 5FN.** Elle ne respecte même pas
entièrement la 3FN. Certaines colonnes violent aussi la 1FN au sens strict, parce
qu'elles stockent des listes en JSON.

Ce n'est pas un accident. Le schéma a été recopié des feuilles Google Sheets de
la version Apps Script (« toutes les colonnes de COLS v3.6 », dit le fichier
`00010_schema.sql`). Une feuille de calcul est par nature une grande table plate.
Certaines copies ont ensuite été gardées **volontairement**, pour que les
rapports répondent vite.

**Les nouveautés du 19/10 (date de pose des engagements, amendes pour effets
non déclarés) sont, elles, en 5FN.** Voir la dernière partie.

## Rappel : que demande chaque forme normale ?

| Forme | Exigence, en une phrase |
|---|---|
| 1FN | Une case = une seule valeur (pas de liste dans une colonne). |
| 2FN | Chaque colonne dépend de **toute** la clé, pas d'une partie. |
| 3FN | Aucune colonne ne dépend d'une **autre colonne non clé** (pas de dépendance transitive). |
| FNBC | Toute dépendance part d'une clé. |
| 4FN | Pas deux listes indépendantes mélangées dans une même table. |
| 5FN | Aucune table ne peut être découpée en morceaux plus petits puis recollée sans perte ni ligne inventée. |

On ne peut pas être en 5FN sans être d'abord en 1FN, 2FN, 3FN, FNBC et 4FN.

## Ce qui empêche la base actuelle d'y être

### 1. Des listes stockées dans une seule colonne (1FN)

| Table.colonne | Contenu |
|---|---|
| `cargaisons.conteneurs_details` | La liste des conteneurs du camion (numéro, scellé, taille, déclaration…) |
| `cargaisons.t1_numeros` | La liste des T1, conteneur par conteneur |
| `cargaisons.bon_sortie_numero` | Un numéro, **ou** une liste de numéros |
| `cargaisons.mixte_details`, `vehicule_details`, `pp_checklist` | Des structures JSON |
| `parking…scelles` | Une liste de scellés |

En plus, `conteneurs_details` **double** la table `conteneurs`, qui contient déjà
une ligne par conteneur. Les deux sont réécrites ensemble (`ecriture.ts`,
« effets de bord tenus à jour »). Si l'une est mise à jour sans l'autre, elles
divergent.

### 2. Des colonnes qui dépendent d'une autre colonne que la clé (3FN)

- **La déclaration est recopiée partout.** `declarant`, `bureau_declaration`,
  `type_declaration`, `numero_declaration` et `annee_declaration` se trouvent dans
  `cargaisons`, `conteneurs`, `stock_annonce`, `entrepot_entrees` et
  `entrepot_sorties`. Le déclarant dépend de la **déclaration**, pas du camion :
  une correction faite sur un camion ne se propage pas aux autres.
- **Le camion est recopié dans `conteneurs`.** `numero_camion`, `type_operation`
  et `rapport_id` y dépendent de `cargaison_id`, pas de la ligne de conteneur.
- **Le nom de l'agent à côté de son identifiant.** `agent_cfs` et
  `agent_cfs_id`, `agent_validation` et `agent_validation_id`, de même pour T1,
  Balise, Bon de sortie, PP, annulation et archivage. Le nom dépend de l'id
  (table `profils`). Si un agent change de nom, les anciennes fiches gardent
  l'ancien. Ici, c'est parfois **voulu** : cela fige le nom tel qu'il était au
  moment de la signature.
- **Des comptes calculés et stockés.** `cargaisons.nb_conteneurs` se calcule
  depuis la liste des conteneurs. `declarations.cle` est la concaténation de
  quatre colonnes elles aussi stockées. `declarations.nombre_conteneurs` et
  `conteneurs_apures` sont des compteurs tenus à la main.
- **Deux colonnes qui disent la même chose.** `suivi_engagement = vrai` revient
  à dire « `engagement_type` est renseigné ». Elles peuvent se contredire.

### 3. Une table « fourre-tout »

`cargaisons` compte plus de 100 colonnes. Chaque cellule (CFS, validation, T1,
Balise, Bon de sortie, PP, engagement, archivage…) y a les siennes. Ce n'est pas
une violation en soi : chaque colonne dépend bien de l'id de la cargaison. Mais
c'est ce qui a fait recopier les déclarations, les agents et les listes plutôt
que de les mettre dans leurs propres tables.

## Faut-il tout normaliser maintenant ?

**Pas d'un seul coup, et pas sans plan.** La base compte plus de 14 000
cargaisons en production, et presque toutes les actions du serveur lisent
`conteneurs_details`. Une refonte complète obligerait à réécrire la majorité des
fichiers de `supabase/functions/rpc/actions/` et à migrer toutes les données en
une fois. Le risque d'arrêter l'exploitation est réel.

Certaines redondances sont aussi **utiles** et doivent rester, sous une forme
maîtrisée :

- le nom de l'agent figé au moment de sa signature (valeur probante) ;
- le journal d'audit et la table `validations`, qui recopient l'état au moment
  du fait. C'est de l'historique, pas de la redondance.

### Plan proposé, par étapes indépendantes

1. **Déclarations** : une table `declarations` de référence (clé = année,
   bureau, type, numéro, avec le déclarant). `cargaisons` et `conteneurs` ne
   gardent que la clé. C'est le gain le plus net : le déclarant n'est saisi
   qu'une fois.
2. **Conteneurs** : faire de la table `conteneurs` la seule source, sans les
   colonnes recopiées du camion. `conteneurs_details` devient une **vue**
   calculée, pour ne pas casser le code existant pendant la transition.
3. **T1 et bons de sortie** : tables `t1(cargaison_id, conteneur, numero)` et
   `bons_sortie(...)` à la place des listes JSON.
4. **Engagements** : table `engagements(cargaison_id, nature, delai, pose_le,
   solde_le, …)`, ce qui supprime aussi la double information
   `suivi_engagement` / `engagement_type`.
5. **Compteurs** (`nb_conteneurs`, apurement) : remplacés par des vues ou des
   calculs, ou maintenus par un déclencheur en base plutôt qu'à la main.

Chaque étape se livre seule, avec une vue de compatibilité, et se teste avant la
suivante.

## Ce qui a été fait le 19/10, dans les règles

**`cargaisons.engagement_pose_le`** (date de pose de l'engagement). Elle dépend
de la seule clé de la cargaison, qui a au plus un engagement. Aucune nouvelle
dépendance transitive n'est créée.

**Table `amendes_effets`** :

```
amendes_effets (cargaison_id PK → cargaisons, montant, saisie_le, saisie_par → profils)
```

- Une ligne par amende ; **l'absence de ligne veut dire « pas d'amende »**. Il n'y
  a donc pas de booléen « amende oui/non » à côté du montant, qui pourrait le
  contredire.
- Pas de colonne « forfait oui/non » : c'est le montant qui le dit (250 000 FCFA).
- Ni le camion, ni les conteneurs, ni le nom de l'agent ne sont recopiés : on
  les retrouve par `cargaison_id` et par `profils`.
- Une seule dépendance, `cargaison_id → (montant, saisie_le, saisie_par)`, sur
  une clé simple. Il n'y a ni dépendance multivaluée ni dépendance de jointure :
  la table est en 5FN.
