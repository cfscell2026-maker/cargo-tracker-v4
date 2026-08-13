/**
 * ============================================================================
 *  @cargo/domaine — TEMPS DE PASSAGE PAR POSTE (v4.2, demande du 2026-08-10)
 *
 *  Combien de temps un dossier reste-t-il à chaque poste ? Et globalement,
 *  combien de temps s'écoule entre l'entrée du camion et sa sortie à la Porte
 *  Principale ?
 *
 *  MODÈLE DE MESURE — il découle du workflow réel, qui est PARALLÈLE :
 *
 *      entrée camion ──[CFS]──► fin de chargement ──┬─[VALIDATION]─► signature
 *                                                    ├─[T1]────────► T1 saisi
 *                                                    ├─[BALISE]────► balise posée
 *                                                    └─[BS]────────► bon émis
 *                                                            │
 *                       éligibilité PP = T1 ET Balise faits ─┴─[PP]─► sortie
 *
 *  · CFS        : entrée du camion → fin de chargement.
 *  · VALIDATION : fin de chargement → signature du chef de brigade.
 *  · T1 / BALISE / BS : fin de chargement → acte de la cellule. Ces trois-là
 *    travaillent EN PARALLÈLE : les mesurer en cascade (T1 → Balise) donnerait
 *    des durées négatives dès qu'une cellule passe avant une autre.
 *  · PP         : de l'instant où le camion devient SORTABLE (T1 et Balise faits,
 *    ou sautés par nature) jusqu'à l'enregistrement de la sortie. C'est la vraie
 *    attente au portail : mesurer depuis la fin de chargement y inclurait
 *    l'attente des cellules d'amont, dont la PP n'est pas responsable.
 *  · GLOBAL     : entrée du camion → sortie à la PP. La performance de bout en
 *    bout, celle qui se compare d'un mois sur l'autre.
 *
 *  CE QUI N'EST PAS MESURÉ EST RENVOYÉ `null`, JAMAIS 0 :
 *  une cellule sautée par nature (type C/A sans T1, véhicule sans balise) n'a
 *  pas mis « zéro minute », elle n'a pas eu lieu. La compter zéro tirerait
 *  toutes les moyennes vers le bas et donnerait un indicateur flatteur et faux.
 * ============================================================================
 */

import { estOui } from './workflow.ts';

export type Poste = 'cfs' | 'validation' | 't1' | 'balise' | 'bs' | 'pp';

/** Ordre d'affichage : celui du parcours réel. */
export const POSTES: Poste[] = ['cfs', 'validation', 't1', 'balise', 'bs', 'pp'];

export const LIBELLE_POSTE: Record<Poste, string> = {
  cfs: 'CFS (chargement)',
  validation: 'Chef de brigade',
  t1: 'Cellule T1',
  balise: 'Cellule Balise',
  bs: 'Bon de sortie',
  pp: 'Porte Principale',
};

/** Vue minimale d'une cargaison nécessaire au calcul (objet camelCase). */
export interface SourceDelais {
  dateCreation?: unknown;
  dateFinChargement?: unknown;
  dateValidation?: unknown;
  dateT1?: unknown;
  datePoseGps?: unknown;
  dateBonSortie?: unknown;
  dateSortie?: unknown;
  sauteT1?: unknown;
  sauteBalise?: unknown;
  sauteBS?: unknown;
  sauteBs?: unknown;
  estVehicule?: unknown;
}

export interface Delais {
  /** Minutes par poste ; `null` = non mesurable (cellule sautée, date absente). */
  cfs: number | null;
  validation: number | null;
  t1: number | null;
  balise: number | null;
  bs: number | null;
  pp: number | null;
  /** Entrée du camion → sortie PP, en minutes. */
  global: number | null;
  /**
   * true = fin de chargement inconnue (cargaison antérieure à la v4.2). Le
   * détail par poste d'amont n'est pas mesurable ; le global, lui, reste exact.
   */
  approx: boolean;
  /** true = au moins une date d'aval antérieure à sa date de départ. */
  incoherent: boolean;
}

/** Horodatage → millisecondes, ou null si absent/illisible. */
function ms(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const d = v instanceof Date ? v : new Date(String(v));
  const t = d.getTime();
  return isNaN(t) ? null : t;
}

const MINUTE = 60000;

/** Le bon de sortie est-il sauté ? Les deux orthographes (cf. workflow.ts). */
export function sauteBonSortie(c: SourceDelais): boolean {
  return estOui(c.sauteBS) || estOui(c.sauteBs);
}

/**
 * Délais d'une cargaison, en MINUTES.
 *
 * Les durées négatives ne sont pas ramenées à zéro : elles signalent des dates
 * incohérentes (saisie a posteriori, horloge décalée). On les écarte du calcul
 * et on lève `incoherent`, pour que le rapport puisse les compter et les
 * montrer plutôt que de les diluer dans une moyenne.
 */
export function delaisDe(c: SourceDelais): Delais {
  const creation = ms(c.dateCreation);
  const fin = ms(c.dateFinChargement);
  const sortie = ms(c.dateSortie);

  let incoherent = false;
  /** Écart entre deux instants ; null si l'un manque, et signalé si négatif. */
  const ecart = (debut: number | null, arrivee: number | null): number | null => {
    if (debut === null || arrivee === null) return null;
    const d = arrivee - debut;
    if (d < 0) { incoherent = true; return null; }
    return Math.round(d / MINUTE);
  };

  // Cellules sautées PAR NATURE : elles n'ont pas eu lieu, on ne les mesure pas.
  const t1Requis = !estOui(c.sauteT1);
  const baliseRequise = !estOui(c.sauteBalise) && !estOui(c.estVehicule);
  const bsRequis = !sauteBonSortie(c);

  const dateT1 = t1Requis ? ms(c.dateT1) : null;
  const datePoseGps = baliseRequise ? ms(c.datePoseGps) : null;
  const dateBonSortie = bsRequis ? ms(c.dateBonSortie) : null;

  /*
   * Éligibilité à la Porte Principale : le camion est sortable quand le T1 ET
   * la Balise sont faits — ou sautés. On prend donc le PLUS TARDIF des jalons
   * réellement exigés. Sans aucun jalon exigé (type C/A non balisé), c'est la
   * fin de chargement qui fait foi.
   *
   * Ce calcul ne dépend PAS de `dateFinChargement` quand un jalon existe :
   * l'attente au portail reste donc mesurable sur l'historique, contrairement
   * aux postes d'amont.
   */
  const jalons: number[] = [];
  if (t1Requis && dateT1 !== null) jalons.push(dateT1);
  if (baliseRequise && datePoseGps !== null) jalons.push(datePoseGps);
  if (jalons.length === 0 && fin !== null) jalons.push(fin);
  const eligiblePP = jalons.length ? Math.max(...jalons) : null;

  return {
    cfs: ecart(creation, fin),
    validation: ecart(fin, ms(c.dateValidation)),
    t1: ecart(fin, dateT1),
    balise: ecart(fin, datePoseGps),
    bs: ecart(fin, dateBonSortie),
    pp: ecart(eligiblePP, sortie),
    global: ecart(creation, sortie),
    approx: fin === null,
    incoherent,
  };
}

/* -------------------------------------------------------------------------- */
/*  Agrégats — isolés ici pour être testables sans base                        */
/* -------------------------------------------------------------------------- */

export interface Agregat {
  n: number;
  moyenne: number | null;
  mediane: number | null;
  p90: number | null;
  min: number | null;
  max: number | null;
}

/** Agrège une série de durées (minutes) en ignorant les valeurs non mesurées. */
export function agreger(valeurs: (number | null)[]): Agregat {
  const v = valeurs.filter((x): x is number => typeof x === 'number' && isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return { n: 0, moyenne: null, mediane: null, p90: null, min: null, max: null };
  const somme = v.reduce((s, x) => s + x, 0);
  // Médiane : moyenne des deux valeurs centrales sur un effectif pair.
  const milieu = v.length >> 1;
  const mediane = v.length % 2 ? v[milieu]! : Math.round((v[milieu - 1]! + v[milieu]!) / 2);
  // p90 par rang le plus proche : lisible et stable sur de petits effectifs.
  const p90 = v[Math.min(v.length - 1, Math.ceil(v.length * 0.9) - 1)]!;
  return {
    n: v.length,
    moyenne: Math.round(somme / v.length),
    mediane,
    p90,
    min: v[0]!,
    max: v[v.length - 1]!,
  };
}

/**
 * Durée lisible par un agent : « 2 h 35 », « 45 min », « 3 j 4 h ».
 * Les rapports douaniers se lisent à l'œil, pas à la calculette : 155 minutes
 * ne dit rien, « 2 h 35 » se compare immédiatement à une norme de service.
 */
export function dureeLisible(minutes: number | null | undefined): string {
  if (minutes === null || minutes === undefined || !isFinite(minutes)) return '—';
  const m = Math.max(0, Math.round(minutes));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const reste = m % 60;
  if (h < 24) return reste ? `${h} h ${String(reste).padStart(2, '0')}` : `${h} h`;
  const j = Math.floor(h / 24);
  const hr = h % 24;
  return hr ? `${j} j ${hr} h` : `${j} j`;
}

/** Heures décimales (1 décimale) — unité des graphiques. */
export function enHeures(minutes: number | null | undefined): number | null {
  if (minutes === null || minutes === undefined || !isFinite(minutes)) return null;
  return Math.round((minutes / 60) * 10) / 10;
}
