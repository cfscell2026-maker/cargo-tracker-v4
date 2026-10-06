/**
 * ============================================================================
 *  RAPPROCHEMENT D'UNE LISTE EXTÉRIEURE AVEC LE PARC (2026-10-06, demande
 *  utilisateur).
 *
 *  L'ACP envoie régulièrement la liste des conteneurs qu'elle nous attribue.
 *  Jusqu'ici la comparaison avec le parc se faisait à l'œil, ligne à ligne.
 *
 *  DEUX RÈGLES GOUVERNENT CE FICHIER, et elles expliquent presque tout le reste :
 *
 *  1. ON NE DICTE PAS SON FORMAT À CELUI QUI ENVOIE. Les deux imports existants
 *     (stock, annonce) lisent les colonnes PAR POSITION : acceptable pour un
 *     fichier qu'on prépare soi-même, intenable pour un fichier qu'on reçoit.
 *     Ici on balaie TOUTES les cellules et on ramasse ce qui a la forme d'un
 *     numéro de conteneur. Colonne, ordre, entêtes, lignes de titre : rien de
 *     tout cela n'a d'importance.
 *
 *  2. ON NE PERD RIEN EN SILENCE. Ce qui ressemble à un numéro sans en être un
 *     est COMPTÉ et RENDU, au lieu d'être écarté sans bruit. Sinon les totaux
 *     ne tombent jamais juste et personne ne sait pourquoi.
 *
 *  Ce module ne touche ni à la base ni au réseau : il se teste entier.
 * ============================================================================
 */

import { normAlphaNum } from './normalisation.ts';

/**
 * La forme d'un numéro de conteneur ISO : 4 lettres puis 7 chiffres.
 *
 * ANCRÉE AUX DEUX BOUTS, et c'est capital. Chercher cette forme AU MILIEU d'un
 * texte normalisé fabrique de faux conteneurs : la ligne de titre
 * « LISTE ACP DU 06/10/2026 » devient « LISTEACPDU06102026 », où l'on
 * lit « CPDU0610202 » - quatre lettres, sept chiffres, parfaitement valide et
 * parfaitement imaginaire. On teste donc des MORCEAUX entiers (voir
 * `morceaux`), jamais une sous-chaîne.
 */
const FORME_TC = /^[A-Z]{4}[0-9]{7}$/;

/**
 * Les découpes d'une cellule qu'on accepte d'examiner.
 *
 * Trois a la fois, et leur union seule couvre les cas reels :
 *   · la cellule ENTIERE, pour « msku 123456-7 », dont les espaces sont internes ;
 *   · les morceaux separes par / , ; | : ou tabulation, pour
 *     « MSKU1234567 / TGHU7654321 » et « N° conteneur : MSKU1234567 » ;
 *   · les mots, pour deux numeros colles par une simple espace.
 */
function morceaux(brut: string): string[] {
  return [brut, ...brut.split(/[\/,;|:\t\n]+/), ...brut.split(/\s+/)];
}

/**
 * Ce qui RESSEMBLE à un numéro sans en être un : 4 lettres suivies de 4 à 10
 * chiffres, mais pas exactement 7. Le cas courant est le chiffre oublié ou
 * frappé deux fois.
 *
 * Volontairement ÉTROIT. Élargir l'heuristique ferait passer des dates et des
 * numéros de déclaration pour des conteneurs abîmés, et le compteur
 * « illisibles » n'inspirerait plus confiance - or c'est tout ce qu'on lui
 * demande.
 */
const PRESQUE_TC = /^[A-Z]{4}[0-9]{4,12}$/;

export interface Extraction {
  /** Numéros valides, normalisés, DÉDOUBLONNÉS, dans l'ordre de rencontre. */
  numeros: string[];
  /** Cellules qui avaient l'air d'un numéro sans en être un, telles que lues. */
  illisibles: string[];
  /** Numéros valides rencontrés PLUSIEURS fois dans le fichier reçu. */
  doublons: string[];
}

/**
 * Ramasse les numéros de conteneur dans un paquet de cellules quelconques.
 *
 * Une cellule peut en porter plusieurs (« MSKU1234567 / TGHU7654321 ») : on les
 * prend tous. La normalisation efface espaces, tirets et minuscules, de sorte
 * que « msku 123456-7 » et « MSKU1234567 » sont le même conteneur.
 */
export function extraireNumerosTC(cellules: unknown[]): Extraction {
  const vus = new Set<string>();
  const numeros: string[] = [];
  const illisibles: string[] = [];
  const doublons: string[] = [];
  for (const cellule of cellules) {
    const brut = String(cellule ?? '').trim();
    if (!brut) continue;
    const trouves: string[] = [];
    for (const m of morceaux(brut)) {
      const norm = normAlphaNum(m);
      if (FORME_TC.test(norm) && !trouves.includes(norm)) trouves.push(norm);
    }
    if (trouves.length) {
      for (const tc of trouves) {
        if (vus.has(tc)) { if (!doublons.includes(tc)) doublons.push(tc); continue; }
        vus.add(tc); numeros.push(tc);
      }
      continue;
    }
    if (PRESQUE_TC.test(normAlphaNum(brut))) illisibles.push(brut);
  }
  return { numeros, illisibles, doublons };
}

/** Une ligne du parc, réduite à ce dont le rapprochement a besoin. */
export interface LigneParc {
  numeroTC: string;
  statut: string;
  taille?: string;
  dateEntree?: string;
  /** true dès que le conteneur n'est plus sur le site. */
  depote: boolean;
}

export interface LigneRapprochee extends LigneParc {
  /** Vrai pour les lignes venues de la liste reçue et absentes de la base. */
  inconnu?: boolean;
}

export interface Rapprochement {
  concordants: LigneRapprochee[];
  /** Au parc chez nous, absent de la liste reçue. */
  auParcHorsListe: LigneRapprochee[];
  /** Dans la liste reçue, mais déjà dépoté chez nous. */
  listeDejaDepotes: LigneRapprochee[];
  /** Dans la liste reçue, inconnu de la base. */
  listeInconnus: LigneRapprochee[];
  /**
   * Dans la liste reçue, PRÉSENT au parc, mais hors du périmètre demandé.
   *
   * Cette case n'existe que parce qu'on peut restreindre la comparaison. Sans
   * elle, comparer sur « En stock » ferait déclarer « inconnu » un conteneur
   * simplement « Positionné » - on réclamerait à l'ACP un conteneur qu'on a
   * sous les yeux. Sur le périmètre par défaut (tout le parc) elle reste vide.
   */
  horsPerimetre: LigneRapprochee[];
  compte: {
    lus: number; concordants: number; auParcHorsListe: number;
    listeDejaDepotes: number; listeInconnus: number;
    horsPerimetre: number; parc: number;
  };
}

/**
 * Confronte la liste reçue au parc.
 *
 * LE PÉRIMÈTRE EST LE PARC ENTIER (décision utilisateur) : « En stock » ET
 * « Positionné ». Un conteneur pointé le matin pour le dépotage du jour est
 * encore sur le site ; le compter absent parce que son statut a changé ferait
 * apparaître chaque matin des écarts qui n'existent pas.
 *
 * `base` doit porter TOUTE la base, dépotés compris : c'est ce qui permet de
 * distinguer « déjà sorti chez nous » (leur liste est en retard, ou nous avons
 * dépoté à tort) de « jamais vu » (il n'est jamais entré). Mélanger les deux
 * reviendrait à réclamer à l'ACP des conteneurs qu'on a nous-mêmes traités.
 *
 * `dansPerimetre` RESTREINT la comparaison sans amputer la base : on peut
 * vouloir ne confronter la liste qu'aux conteneurs en alerte, ou à ceux entrés
 * en septembre. Les conteneurs présents mais hors de ce périmètre ne sont ni
 * concordants ni inconnus : ils ont leur propre case.
 */
export function rapprocher(
  numerosRecus: string[], base: LigneParc[],
  dansPerimetre: (l: LigneParc) => boolean = () => true,
): Rapprochement {
  const recus = new Set(numerosRecus.map((n) => normAlphaNum(n)).filter(Boolean));
  const parNumero = new Map<string, LigneParc>();
  for (const l of base) {
    const tc = normAlphaNum(l.numeroTC);
    if (tc) parNumero.set(tc, { ...l, numeroTC: tc });
  }

  const concordants: LigneRapprochee[] = [];
  const auParcHorsListe: LigneRapprochee[] = [];
  const listeDejaDepotes: LigneRapprochee[] = [];
  const listeInconnus: LigneRapprochee[] = [];
  const horsPerimetre: LigneRapprochee[] = [];

  for (const [tc, ligne] of parNumero) {
    if (ligne.depote) continue;             // les dépotés se jugent depuis la liste reçue
    if (!dansPerimetre(ligne)) continue;    // présent, mais pas de ceux qu'on compare
    (recus.has(tc) ? concordants : auParcHorsListe).push(ligne);
  }
  for (const tc of recus) {
    const ligne = parNumero.get(tc);
    if (!ligne) { listeInconnus.push({ numeroTC: tc, statut: '', depote: false, inconnu: true }); continue; }
    if (ligne.depote) listeDejaDepotes.push(ligne);
    else if (!dansPerimetre(ligne)) horsPerimetre.push(ligne);
  }

  const parc = concordants.length + auParcHorsListe.length;
  return {
    concordants, auParcHorsListe, listeDejaDepotes, listeInconnus, horsPerimetre,
    compte: {
      lus: recus.size, concordants: concordants.length,
      auParcHorsListe: auParcHorsListe.length,
      listeDejaDepotes: listeDejaDepotes.length,
      listeInconnus: listeInconnus.length,
      horsPerimetre: horsPerimetre.length, parc,
    },
  };
}
