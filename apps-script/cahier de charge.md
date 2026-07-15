Cahier des charges : Système de Gestion des Cargaisons

2. Gestion du Stock Initial et Entrées (Import de données)
•	Initialisation : Intégration préalable dans la base de données des conteneurs déjà présents sur le port sec et de ceux en provenance du port autonome
Annonce de transfert de conteneur: La liste des conteneurs à transférer est envoyée la veille. Elle sera uploadée dans le systeme sous format excel avec les colonnes suivantes (n° TC, Taille TC, date entrée, année declaration, bureau declaration, type declaration, numero declaration ) par l'administrateur avant le debut du trasfert. Les TC annoncés iront dans le "stock annoncé"
Pointage à l'entrée des TC au port sec: Recherche du TC arrivé dans le "stock annoncé". Son pointage envoie ses informations en ajout au stock du port sec existant. (a faire par l'agent Porte principale)
Les conteneurs pointés dans le "stock annoncé" par l'agent porte principale viendront s'ajouter au stock du port sec
On doit pouvoir avoir les statistiques sur les TC annoncés (non pointés, pointés, taux de transfert effectif, delai et instance)

•	Pointage matinal des conteneurs positionnés pour depotage : Le système doit permettre de pointer chaque matin les conteneurs du stock du port sec qui sont positionnés pour dépotage, donner la situation en temps réel des TC ouverts sur le site et le restant à ouvrir. Si TC déjà pointé, le signaler comme etant dejà pointé le jour précedent et bloquer l’acces au pointage.
•	Méthode d'entrée : Automatisation de l’enregistrement à l'entrée de la PIA via un module d'upload de fichiers Excel pour une fois. 


3. Workflow Opérationnel Standard par Cellule
Les opérations terrain s'articulent autour de deux flux principaux : L'Enlèvement (la marchandise part scellée sur conteneur) et Le Dépotage (le conteneur est vidé ou transféré).
[Entrée / Excel] ──> [1. Cellule CFS] ──> [2. Cellule T1] ──> [3. Cellule Balise] ──> [4. Bon de Sortie] ──> [5. Porte de Sortie (PP)]

3.1. Étape 0 : Enregistrement du Camion (Nouveau prérequis)
•	Création : Tout camion devant effectuer une opération doit être créé au préalable dans le système par l'agent à l'entrée de la CFS.
•	Statut Initial : Dès sa création, le camion prend le statut Créé.

3.2. Étape 1 : Cellule CFS (Terrain - Liaison Initiale)
L’agent recherche un conteneur et doit obligatoirement l'associer à un camion et à une déclaration. Cette action passe le camion au statut "En cours de chargement".
Le champ des déclarations doit permettre d’identifier de manière unique chaque déclaration grace à la combinaison « année declaration » + « bureau declaration » + « type declaration » + « numero declaration »
Un champ dédié « nombre de conteneurs » saisi au premier enregistrement de la declaration permet de suivre l’apurement des conteneurs sur la declaration. Les prochaines saisies rappelleront juste le nombre de conteneurs restants sur la declaration. 
•	Règle Enlèvement : Le conteneur étant déjà fermé/scellé, la saisie du numéro de scellé est obligatoire à cette étape. Un conteneur = un scellé
o	Sous-module Visite : Si une inspection douanière a lieu après coup, l’agent passe par un écran "Opération de visite" pour modifier et enregistrer le nouveau numéro de scellé.
•	Règle Dépotage : Le conteneur est ouvert pour manipulation. La saisie des scellés se fait pour le camion et determine la fin du chargement.
o	Règle de gestion des scellés : L'application doit exiger au minimum deux scellés obligatoires et un troisième facultatif.
•	Déblocage du flux : La validation de la CFS (avec pose des scellés requis) est le déclencheur indispensable pour ouvrir l'accès à la saisie des étapes suivantes.
•	A la sortie du camion, l’agent Porte CFS recherche et pointe les camions sortants et confirme leur etat : cours de chargement (scellés non apposés)/ fin de chargement (scellés apposés).
Cette situation doit etre integree au tableau de bord : nombre de camions en cours de chargement.
3.3. Étape 2 : Cellule T1 (Document de Transit)
•	En Enlèvement : Règle stricte de 1 pour 1. Chaque conteneur doit obligatoirement avoir son propre numéro de document T1 unique pour être validé.
•	En Dépotage : Règle de 1 pour Plusieurs. Un camion peut transporter des marchandises liées à plusieurs documents T1. Le système doit proposer un champ dynamique permettant d'ajouter plusieurs numéros de T1, tout en exigeant au moins un (1) T1 au minimum.
•	Pour les deux types d’Operations                                                                                                                     champ bureau de destination dès que l’on commence la saisie, il doit nous proposer le bureau dont le code s’apparente 
3.4. Étape 3 : Cellule Balise (Sécurisation des camions)
•	Formulaire de saisie : L'interface doit évoluer. Elle ne doit plus seulement lier le camion à une balise, mais présenter :
1.	Une case à cocher pour attester que le "Numéro T1 est correct".
2.	Un champ de saisie pour le Numéro de Balise.
3.	Au cas ou l’option dispense est choisie, demander le numero autorisation de dispense avant validation
Les dispenses doivent figurer sur le tableau de bord. Apres la sortie, une operation supplementaire : Arrivée au bureau de destination doit etre remplie avant de les solder
Donc sur le tableau de bord : Dispenses total / Dispenses en cours/ Dispenses terminées
•	Remplacement de Balise : Intégration d’une option pour remplacer une balise erronée ou défectueuse.
•	Droits d'accès (Sécurité) : Seuls les comptes de type Administrateur possèdent le droit de modification ou de remplacement à cette étape (maintenu restreint pour les agents de terrain afin d'éviter les fraudes).
NB : Compte administrateur doit pouvoir tout modifier sur un enregistrement peut importe le statut de la cargaison
Les comptes doivent pouvoir editer les rapports pour tous les agents de la cellule auxquels ils appartiennent
3.5. Étape 4 : Cellule Bon de Sortie (BS)
•	En Enlèvement : Traçabilité individuelle. Un conteneur = Un T1 = Un Bon de Sortie.
•	En Dépotage : Traçabilité documentaire. Le Bon de Sortie est généré par Déclaration (un seul bon pour l'ensemble des marchandises de la déclaration, indépendamment du nombre de conteneurs).
•	Note de conception : À cette étape, le système n'exige pas de vérification de la balise.
3.6. Étape 5 : Porte de Sortie - PP (Contrôle Final)
Cette cellule est l'entonnoir de contrôle ultime. L'agent de garde ne saisit pas de données mais valide l’intégralité des rapports précédents via des cases à cocher (Checklist) :
•	[ ] Rapport CFS conforme.
•	[ ] Numéro(s) T1 valide(s).
•	[ ] Numéro de Balise vérifié.
•	[ ] Numéro du Bon de Sortie vérifié.
La validation finale permet la sortie physique du camion de la zone PIA.

4. Gestion des Opérations Spéciales
4.1. Module Véhicules
•	Existant : Le comportement actuel du système pour le dépotage de véhicules est validé et reste inchangé. Il incorpore cependant les module T1 et bon de sortie avant d’arriver à la PP
4.2. Module "Conso"
Certaines cargaisons de mise a la consommation necessitent une balise, d’autres sortent directement sans balise (dispense).
•	Interface : Lors du choix de l'opération de type C, afficher dynamiquement un bouton radio / sélecteur :
o	Cargaison à baliser (suit le flux CFS—Balise –Bon de sortie—PP en sautant le T1).
o	Cargaison non balisée (CFS—Bon de sortie--PP) saute la balise et le T1
•	Règle automatisée : Si Cargaison non balisée est coché, la cargaison saute l'étape Balise et est notifiée instantanément au niveau du bon de sortie sous le statut "En attente de bon sortie". Cette étape remplie elle est notifiée à  la Porte de Sortie (PP) sous le statut "En attente de sortie".
4.3. Module Magasins & MAD 
Pour éviter la perte de traçabilité lors du déchargement de marchandises en vrac dans un entrepôt tampon (où le conteneur d'origine est libéré mais la marchandise reste sur site), le flux est scindé en deux temps :
Phase	Type d'opération	Action Système / Règle de gestion
Temps 1	Entrée Magasin / MAD	Enregistre la fin de vie du conteneur. Le conteneur est marqué comme "Dépoté - Sorti du Yard - Entré en Magasin". Les statistiques de conteneurs vidés sont incrémentées.
Temps 2	Sortie de Magasin	Permet de sortir la marchandise de la PIA. L'agent génère un flux de sortie en créant un camion/cargaison sans lier aucun conteneur physique, la marchandise étant désormais du vrac.
         
5. Indicateurs de Performance & Statistiques (KPI)
Le système doit intégrer un tableau de bord permettant d'extraire en temps réel :
•	Le volume de conteneurs vidés (Dépotage) par période.
•	Le volume de conteneurs sortis scellés (Enlèvement).
•	Le flux des camions actifs, en cours de chargement et sortis.
•	L'état des stocks physiques de conteneurs dans le Port Sec avec les détails 20’, 40, 45’
•	Toutes les données exprimées en conteneurs (total enlevement, total depotage, total sortie, total entrée, stock actuel) doivent etre exprimées egalement en EVP (Equivalent Vingt Pieds) : 1 TCx20’ = 1 EVP ; 1 TCx40’ = 1TC x 45’ = 2 EVP

