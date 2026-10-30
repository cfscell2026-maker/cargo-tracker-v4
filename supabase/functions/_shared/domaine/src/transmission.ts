/**
 * ============================================================================
 *  TRANSMISSION D'UN ENGAGEMENT (2026-10-28, demande utilisateur).
 *
 *  Ce qu'on a reellement declare au pays de destination : un en-tete (pays,
 *  numero IM4) et des marchandises, chacune avec sa quantite AU DEPART puis,
 *  plus tard, sa quantite A L'ARRIVEE.
 *
 *  TOUT L'ENJEU TIENT DANS UNE DISTINCTION : « pas encore connu » n'est pas
 *  « zero ». Une quantite d'arrivee absente veut dire que le pays n'a pas
 *  encore repondu ; une quantite d'arrivee a zero veut dire que rien n'est
 *  arrive. Les confondre transformerait une attente en un ecart total, et
 *  ferait apparaitre des manquants qui n'existent pas.
 *
 *  Ce module ne touche ni a la base ni au reseau : il se teste entier.
 * ============================================================================
 */

export interface MarchandiseTransmise {
  designation: string;
  quantiteDepart: number;
  /** `null` ou absent : l'arrivee n'est pas encore connue. */
  quantiteArrivee?: number | null;
}

/** Un nombre, ou `null` si la saisie n'en est pas un. Vide reste vide. */
export function nombreOuNull(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const t = String(v).trim().replace(',', '.');
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/**
 * L'ECART d'une ligne : arrivee moins depart.
 *
 * NEGATIF = il manque a l'arrivee, et c'est le cas qui interesse le service.
 * POSITIF = il est arrive plus que declare, ce qui interesse tout autant.
 * `null` tant que l'arrivee n'est pas connue : on ne montre pas un ecart
 * qu'on n'a pas constate.
 */
export function ecartLigne(m: MarchandiseTransmise): number | null {
  const arr = nombreOuNull(m.quantiteArrivee);
  if (arr === null) return null;
  return arr - (nombreOuNull(m.quantiteDepart) ?? 0);
}

export interface TotauxTransmission {
  depart: number;
  /** Somme des arrivees CONNUES seulement. */
  arrivee: number;
  /** `null` tant qu'aucune arrivee n'est connue. */
  ecart: number | null;
  lignes: number;
  /** Lignes dont l'arrivee reste a renseigner. */
  enAttente: number;
}

/**
 * Les totaux du bas de la fenetre.
 *
 * L'ECART TOTAL NE PORTE QUE SUR LES LIGNES RENSEIGNEES. Additionner le depart
 * de lignes dont l'arrivee est inconnue produirait un manquant imaginaire, qui
 * grossirait a chaque marchandise ajoutee. Tant qu'aucune arrivee n'est connue,
 * l'ecart reste `null` et l'ecran affiche l'attente plutot qu'un chiffre.
 */
export function totauxTransmission(lignes: MarchandiseTransmise[]): TotauxTransmission {
  let depart = 0, arrivee = 0, connues = 0;
  for (const m of lignes) {
    const arr = nombreOuNull(m.quantiteArrivee);
    const dep = nombreOuNull(m.quantiteDepart) ?? 0;
    depart += dep;
    if (arr !== null) { arrivee += arr; connues++; }
  }
  const departConnu = lignes.reduce(
    (n, m) => n + (nombreOuNull(m.quantiteArrivee) === null ? 0 : (nombreOuNull(m.quantiteDepart) ?? 0)), 0);
  return {
    depart, arrivee,
    ecart: connues ? arrivee - departConnu : null,
    lignes: lignes.length,
    enAttente: lignes.length - connues,
  };
}

/**
 * Ce qui manque pour enregistrer le DEPART. Rendu en clair, pour que l'ecran
 * dise ce qu'il attend au lieu de griser un bouton sans explication.
 */
export function manqueAuDepart(
  entete: { paysDestination?: unknown; numeroIm4?: unknown },
  lignes: MarchandiseTransmise[],
): string | null {
  if (!String(entete.paysDestination ?? '').trim()) return 'Indiquez le pays de destination.';
  if (!String(entete.numeroIm4 ?? '').trim()) return 'Indiquez le numéro IM4 du pays de destination.';
  if (!lignes.length) return 'Ajoutez au moins une marchandise.';
  for (const [i, m] of lignes.entries()) {
    if (!String(m.designation ?? '').trim())
      return `Marchandise ${i + 1} : indiquez la désignation.`;
    const q = nombreOuNull(m.quantiteDepart);
    if (q === null) return `Marchandise ${i + 1} : indiquez la quantité déclarée au départ.`;
    if (q < 0) return `Marchandise ${i + 1} : la quantité au départ ne peut pas être négative.`;
  }
  return null;
}

/** Ce qui manque pour enregistrer une ARRIVEE, quand on en saisit une. */
export function manqueALArrivee(lignes: MarchandiseTransmise[]): string | null {
  for (const [i, m] of lignes.entries()) {
    const q = nombreOuNull(m.quantiteArrivee);
    if (q !== null && q < 0)
      return `Marchandise ${i + 1} : la quantité à l'arrivée ne peut pas être négative.`;
  }
  return null;
}

/* ==========================================================================
 *  DÉCLARATIONS « C » : L'ARRIVÉE ET L'APUREMENT (2026-10-30, demande
 *  utilisateur).
 *
 *  La preuve qu'un engagement est tenu, c'est la mise à la consommation dans
 *  le pays de destination : la déclaration du Burkina porte une référence
 *  douane « C 14985 » et sa date. On saisit chaque C avec la désignation et la
 *  quantité qu'il couvre ; un même engagement peut en ramener plusieurs.
 *
 *  Décisions utilisateur : les C SONT l'arrivée (le total à l'arrivée est la
 *  somme de leurs quantités), et l'engagement est apuré au premier C.
 * ========================================================================== */

export interface DeclarationC {
  /** Référence douane telle qu'imprimée : « C 14985 ». */
  numeroC: string;
  /** Date du C, AAAA-MM-JJ. */
  dateC: string;
  designation: string;
  quantite: number | null;
}

/** Une date AAAA-MM-JJ qui existe au calendrier (pas de 31 juin). */
export function dateCValide(v: unknown): boolean {
  const t = String(v ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) return false;
  const d = new Date(t + 'T00:00:00Z');
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === t;
}

/** « c14985 », « C-14985 », « C 14985 » : le même C. Sert à repérer un doublon. */
export function cleNumeroC(v: unknown): string {
  return String(v ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/**
 * Ce qui manque pour enregistrer les C, dit en clair.
 *
 * AU MOINS UN C : c'est lui qui apure l'engagement ; enregistrer une liste vide
 * ne prouverait rien. Un même C saisi deux fois compterait sa quantité deux
 * fois dans le total à l'arrivée : on le refuse. Une date de C dans le futur
 * est une faute de frappe (le C est forcément déjà délivré).
 */
export function manqueDeclarationsC(lignes: DeclarationC[], aujourdhui = new Date().toISOString().slice(0, 10)): string | null {
  if (!lignes.length) return 'Ajoutez au moins une déclaration C.';
  const vus = new Set<string>();
  for (const [i, c] of lignes.entries()) {
    const n = `Déclaration C ${i + 1}`;
    if (!cleNumeroC(c.numeroC)) return `${n} : indiquez le numéro du C.`;
    if (!String(c.dateC ?? '').trim()) return `${n} : indiquez la date du C.`;
    if (!dateCValide(c.dateC)) return `${n} : la date du C n'est pas valide.`;
    if (String(c.dateC) > aujourdhui) return `${n} : la date du C ne peut pas être dans le futur.`;
    if (!String(c.designation ?? '').trim()) return `${n} : indiquez la désignation de la marchandise.`;
    const q = nombreOuNull(c.quantite);
    if (q === null) return `${n} : indiquez la quantité.`;
    if (q <= 0) return `${n} : la quantité doit être supérieure à zéro.`;
    const cle = cleNumeroC(c.numeroC);
    if (vus.has(cle)) return `Le C « ${String(c.numeroC).trim()} » est saisi deux fois.`;
    vus.add(cle);
  }
  return null;
}

export interface TotauxApurement {
  /** Total déclaré au départ (toutes les marchandises). */
  depart: number;
  /** Somme des quantités des C. */
  arrivee: number;
  /** Arrivée moins départ ; `null` tant qu'aucun C n'est saisi. */
  ecart: number | null;
  /** Nombre de C. */
  nbC: number;
}

/**
 * Départ contre C. Tant qu'aucun C n'est saisi, l'écart reste `null` : on
 * attend la réponse du pays de destination, ce n'est pas un manquant.
 */
export function totauxApurement(marchandises: MarchandiseTransmise[], cs: DeclarationC[]): TotauxApurement {
  const depart = marchandises.reduce((n, m) => n + (nombreOuNull(m.quantiteDepart) ?? 0), 0);
  const arrivee = cs.reduce((n, c) => n + (nombreOuNull(c.quantite) ?? 0), 0);
  return { depart, arrivee, ecart: cs.length ? arrivee - depart : null, nbC: cs.length };
}
