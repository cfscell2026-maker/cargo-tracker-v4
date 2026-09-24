/**
 * JEU D'ICÔNES — 2026-09-10, révisé le même jour.
 *
 * Remplace les caractères typographiques qui servaient d'icônes (▦ ＋ ✎ ◑ ◵ ◔…)
 * mêlés à quelques émojis. Deux défauts rédhibitoires :
 *
 *  · AUCUNE COHÉRENCE. Des glyphes géométriques, des symboles de ponctuation et
 *    des émojis en couleur se côtoyaient : ni la même graisse, ni la même
 *    optique, ni le même alignement.
 *  · UN RENDU IMPRÉVISIBLE. Un émoji est dessiné par le SYSTÈME : le même 🚗
 *    n'a pas la même allure sous Windows, Android ou iOS, et certains glyphes
 *    (◨ ◵ ⊕) s'affichent en carré vide sur les postes dépourvus de la police.
 *
 * DES SVG EN TRAIT, DÉFINIS ICI. Grille de 24, trait de 1,8 et bouts arrondis
 * pour toutes : elles forment une famille. `stroke="currentColor"` les fait
 * hériter de la couleur du menu — blanches sur la pilule active, grises sinon,
 * sans une ligne de CSS supplémentaire.
 *
 * PLUSIEURS TRACÉS PAR ICÔNE (révision). La première version n'en admettait
 * qu'un seul, et cela se voyait : le camion n'avait pas de roues, la voiture se
 * lisait comme un lit, le balai comme un marteau. Une silhouette juste réclame
 * des sous-parties détachées — roues, cabine, plateaux de balance —, d'où le
 * tableau de chaînes plutôt qu'une chaîne unique.
 *
 * ⚠ AUCUNE BIBLIOTHÈQUE EXTERNE, et ce n'est pas un choix esthétique : la CSP de
 * `netlify.toml` interdit tout script et toute feuille de style tiers
 * (`script-src 'self'`). Une police d'icônes ou un paquet chargé depuis un CDN
 * serait bloqué en production, sans erreur visible.
 */

/**
 * Tracés des icônes, sur une grille de 24.
 *
 * Une chaîne = un seul `<path>` ; un tableau = autant de `<path>` que d'entrées.
 * Les cercles (les roues) s'écrivent en deux arcs de 180°, de sorte que tout
 * reste une seule sorte d'élément à dessiner.
 */
const TRACES: Record<string, string | string[]> = {
  // Navigation
  // Trois traits, rien d'autre : l'ouverture du menu sur écran étroit. Elle
  // remplace le caractère « ☰ », dont le dessin variait d'un poste à l'autre.
  menu: 'M4 7h16M4 12h16M4 17h16',

  // Indicateurs du tableau de bord
  chevron: 'M9 6l6 6-6 6',
  oeil: 'M2 12s3.6-6.4 10-6.4S22 12 22 12s-3.6 6.4-10 6.4S2 12 2 12zM12 9.4a2.6 2.6 0 100 5.2 2.6 2.6 0 000-5.2z',
  poubelle: 'M4 7h16M10 7V5a1 1 0 011-1h2a1 1 0 011 1v2M6.5 7l.9 12.1a1 1 0 001 .9h7.2a1 1 0 001-.9L18.5 7M10 11v5M14 11v5',
  interrupteur: 'M12 4v8M7.8 6.4a7.5 7.5 0 108.4 0',
  fleche: 'M19 12H5M11 6l-6 6 6 6',
  plus: 'M12 5v14M5 12h14',
  hausse: 'M4 16l6-6 4 4 6-7M15 7h5v5',
  baisse: 'M4 8l6 6 4-4 6 7M15 17h5v-5',
  stable: 'M4 12h16',

  // Vue d'ensemble
  tableau: 'M3 3h7v7H3zM14 3h7v5h-7zM14 12h7v9h-7zM3 14h7v7H3z',

  // Camions et véhicules — caisse, cabine et DEUX ROUES : sans elles, la
  // silhouette se lisait comme une simple boîte.
  camion: [
    'M13 19V7a2 2 0 00-2-2H4a2 2 0 00-2 2v10a2 2 0 002 2h.5',
    'M18.5 19H20a2 2 0 002-2v-2.9a2 2 0 00-.45-1.26l-2.6-3.2a2 2 0 00-1.55-.74H13',
    'M8.5 19h6',
    'M8.5 19a2 2 0 1 0-4 0 2 2 0 1 0 4 0z',
    'M18.5 19a2 2 0 1 0-4 0 2 2 0 1 0 4 0z',
  ],
  // Le « + » est POSÉ AU-DESSUS de la cabine, ni dans la caisse — la silhouette
  // se lisait alors comme une ambulance — ni dans une pastille cerclée, qui à
  // 18 px se referme en tache.
  camionPlus: [
    'M13 19V7a2 2 0 00-2-2H4a2 2 0 00-2 2v10a2 2 0 002 2h.5',
    'M18.5 19H20a2 2 0 002-2v-2.9a2 2 0 00-.45-1.26l-2.6-3.2a2 2 0 00-1.55-.74H13',
    'M8.5 19h6',
    'M8.5 19a2 2 0 1 0-4 0 2 2 0 1 0 4 0z',
    'M18.5 19a2 2 0 1 0-4 0 2 2 0 1 0 4 0z',
    'M19.5 2.2v4.6M17.2 4.5h4.6',
  ],
  voiture: [
    'M5.6 11.5l1.6-4.3A2 2 0 019.07 5.9h5.86a2 2 0 011.87 1.3l1.6 4.3',
    'M4 11.5h16',
    'M5 17H3a1 1 0 01-1-1v-2.5a2 2 0 012-2',
    'M19 17h2a1 1 0 001-1v-2.5a2 2 0 00-2-2',
    'M9 17h6',
    'M9 17a2 2 0 1 0-4 0 2 2 0 1 0 4 0z',
    'M19 17a2 2 0 1 0-4 0 2 2 0 1 0 4 0z',
  ],

  // Marchandise
  conteneur: 'M4 8l8-4 8 4v8l-8 4-8-4zM4 8l8 4 8-4M12 12v8',
  boites: 'M3 8h8v6H3zM13 4h8v6h-8zM13 14h8v6h-8z',
  entrepot: 'M3 10l9-6 9 6v10H3zM8 20v-6h8v6',
  usine: 'M3 20V11l5 3V11l5 3V8l5 3v9zM7 20v-3M12 20v-3M17 20v-3',

  // Saisie et contrôle
  crayon: 'M4 20h4L19 9a2.1 2.1 0 00-3-3L5 17v3zM14.5 6.5l3 3',
  // Un bouclier, et non le sceau dentelé de la première version : à 18 px, ses
  // dents se refermaient en une tache. Le bouclier dit mieux ce dont il s'agit
  // — une validation par l'autorité, pas un label de qualité.
  valider: [
    'M12 3l7 3v5.6c0 4.2-2.9 7.7-7 8.6-4.1-.9-7-4.4-7-8.6V6z',
    'M9.2 12.1l2.1 2.1 3.9-4.3',
  ],
  presse: 'M9 4h6v3H9zM7 5H5v15h14V5h-2M9 12l2 2 4-4',
  loupe: 'M11 4a7 7 0 100 14 7 7 0 000-14zM20 20l-4.2-4.2',
  // Un tableau à LIGNES (en-tête + rangées) plutôt qu'une liste à puces :
  // « Cargaisons » est un LISTING. Les rangées comptent — avec la seule colonne
  // de la première version, l'icône imitait celle du tableau de bord.
  liste: [
    'M4 4h16a1 1 0 011 1v14a1 1 0 01-1 1H4a1 1 0 01-1-1V5a1 1 0 011-1z',
    'M3 9h18',
    'M3 14.5h18',
    'M9 9v11',
  ],
  document: 'M6 3h8l4 4v14H6zM14 3v4h4M9 13h6M9 17h4',

  // Cellules du parcours
  t1: 'M6 3h9l4 4v14H6zM15 3v4h4M9 12h6M9 16h3',
  balise: 'M12 10a2 2 0 100 4 2 2 0 000-4zM8.5 8.5a5 5 0 000 7M15.5 8.5a5 5 0 010 7M5.5 5.5a9 9 0 000 13M18.5 5.5a9 9 0 010 13',
  bonSortie: 'M6 3h8l4 4v14H6zM14 3v4h4M9 14l2 2 4-4',
  sortie: 'M14 4h4a1 1 0 011 1v14a1 1 0 01-1 1h-4M10 8l-4 4 4 4M6 12h9',
  /* PARKING — le panneau normalisé : cadre aux angles adoucis et « P » à la
     contre-forme ouverte. Deux tracés (cadre + lettre) plutôt qu'un seul : la
     lettre garde ainsi son épaisseur propre et reste lisible à 18 px. */
  parking: [
    'M6 3h12a3 3 0 013 3v12a3 3 0 01-3 3H6a3 3 0 01-3-3V6a3 3 0 013-3z',
    'M9.9 17.2V6.8h3.3a3.1 3.1 0 010 6.2H9.9',
  ],
  // Flèche qui tourne : recharger l'application (mise à jour).
  miseAJour: 'M20 12a8 8 0 11-2.34-5.66M20 4v4h-4',

  // Suivi et rapports
  rapport: 'M4 20h16M7 20v-6M12 20V8M17 20v-9',
  // Deux pointes de flèche complètes : l'ancienne n'avait qu'un demi-trait de
  // pointe, ce qui la faisait lire comme deux barres barrées.
  flux: ['M4 9h13', 'M14 6l3 3-3 3', 'M20 15H7', 'M10 12l-3 3 3 3'],
  carte: 'M12 21s7-5.4 7-11a7 7 0 10-14 0c0 5.6 7 11 7 11zM12 12.5a2.5 2.5 0 100-5 2.5 2.5 0 000 5z',
  // Plateaux en bol arrondi, et non en triangle pointant vers le bas : c'est ce
  // qui fait reconnaître une balance du premier coup d'œil.
  balance: [
    'M12 4.5v14.5',
    'M8.5 19h7',
    'M5 9h14',
    'M5 9l-2.5 5a2.5 2.5 0 005 0z',
    'M19 9l-2.5 5a2.5 2.5 0 005 0z',
  ],
  horloge: 'M12 4a8 8 0 100 16 8 8 0 000-16zM12 8v4.5l3 1.8',
  // 2026-09-21 : volet Paramètres — des curseurs de réglage.
  reglages: 'M4 6h9M17 6h3M15 4v4M4 12h3M11 12h9M9 10v4M4 18h11M19 18h1M17 16v4',
  sablier: 'M7 3h10M7 21h10M8 3v3.5c0 2.2 4 3.5 4 5.5s-4 3.3-4 5.5V21M16 3v3.5c0 2.2-4 3.5-4 5.5s4 3.3 4 5.5V21',
  attente: 'M12 4a8 8 0 100 16 8 8 0 000-16zM12 8v4h3.5',
  drapeau: 'M5 21V4M5 5h10l-1.5 3L15 11H5',

  // Flux d'entrée
  televerser: 'M12 15V4M8.5 7.5L12 4l3.5 3.5M4 15v3a2 2 0 002 2h12a2 2 0 002-2v-3',
  telecharger: 'M12 4v11M8.5 11.5L12 15l3.5-3.5M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2',
  megaphone: 'M4 10v4a1 1 0 001 1h2l7 4V5L7 9H5a1 1 0 00-1 1zM18 9.5a3.5 3.5 0 010 5',

  // Administration
  utilisateurs: 'M9 11a3.5 3.5 0 100-7 3.5 3.5 0 000 7zM3 20v-1.5C3 16 5.7 15 9 15s6 1 6 3.5V20M17 15.2c1.8.5 3 1.6 3 3.3V20M16 4.3a3.5 3.5 0 010 6.8',
  compte: 'M12 3a9 9 0 100 18 9 9 0 000-18zM12 12a3 3 0 100-6 3 3 0 000 6zM6.4 18.6a6 6 0 0111.2 0',
  historique: 'M4 12a8 8 0 108-8 8 8 0 00-6.3 3.1M4 4v3.5h3.5M12 8v4.5l3 1.8',
  archive: 'M3 4h18v4H3zM5 8v12h14V8M9.5 12h5',
  // Deux étincelles : le balai en un seul trait se lisait comme un marteau.
  // « Remise au propre » passe sans ambiguïté, et à toute taille.
  nettoyage: [
    'M10 3.5l1.9 5.1 5.1 1.9-5.1 1.9-1.9 5.1-1.9-5.1L3 10.5l5.1-1.9z',
    'M18 14.5l.9 2.4 2.4.9-2.4.9-.9 2.4-.9-2.4-2.4-.9 2.4-.9z',
  ],
};

/** Icône du menu. La taille suit le texte, la couleur aussi (`currentColor`). */
export function Icone({ nom, taille = 18 }: { nom: string; taille?: number }) {
  const brut = TRACES[nom] ?? TRACES['liste']!;
  const traces = typeof brut === 'string' ? [brut] : brut;
  return (
    <svg
      className="ic"
      width={taille}
      height={taille}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      // Décorative : le libellé du menu la suit immédiatement, un lecteur
      // d'écran qui l'annoncerait ne ferait que répéter.
      aria-hidden="true"
      focusable="false"
    >
      {traces.map((d, i) => <path key={i} d={d} />)}
    </svg>
  );
}
