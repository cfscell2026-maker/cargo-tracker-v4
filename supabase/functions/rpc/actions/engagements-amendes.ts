/**
 * ============================================================================
 *  RAPPORTS ENGAGEMENTS PAR PÉRIODE ET AMENDES « EFFETS NON DÉCLARÉS »
 *  2026-10-19, demande utilisateur.
 *
 *  1. Engagements : combien de camions et de conteneurs sous BFE 03 Sinkase,
 *     transit national, transit côtier (et « Autres »), sur une période. La
 *     date de référence est celle où l'engagement a été POSÉ sur la cargaison
 *     (`engagementPoseLe`), à la signature du chef ou à l'ajout par un chef ou
 *     un admin, et non la date d'entrée du camion.
 *
 *  2. Amendes : camions et conteneurs ayant payé une amende pour effets non
 *     déclarés, montant encaissé, forfaits et autres montants, sur une période
 *     (date de saisie de l'amende).
 *
 *  Module PUR : il reçoit des lignes déjà chargées (camelCase, sans annulées ni
 *  archivées) et rend des compteurs, des séries et des lignes prêtes à
 *  extraire. Les actions serveur (rapports.ts) chargent, appellent, journalisent.
 * ============================================================================
 */
import {
  NATURES_RAPPORT_ENGAGEMENT, natureRapportEngagement, AMENDE_EFFETS_FORFAIT,
  parseConteneursDetails, estOui, aFait, type NatureRapportEngagement,
} from '../../_shared/domaine/src/index.ts';
import { dansPeriode, dateHeureFr } from './extraction.ts';

type Ligne = Record<string, unknown>;
/** Clé de période (« 2026-10 », « 2026 », lundi de la semaine…) ; null si pas de date. */
export type ClePeriode = (v: unknown) => string | null;

const tx = (v: unknown) => String(v ?? '').trim();
const conteneursDe = (c: Ligne) => parseConteneursDetails(c['conteneursDetails']).conteneurs.map((ct) => ct.num).filter(Boolean);

/* ------------------------------ engagements ---------------------------- */

export interface CompteNature {
  nature: NatureRapportEngagement;
  camions: number;
  vehicules: number;
  conteneurs: number;
  enCours: number;
  soldes: number;
}

/** Date de pose ; repli sur la validation pour une ligne que la migration n'aurait pas calée. */
export const datePoseEngagement = (c: Ligne): string => tx(c['engagementPoseLe']) || tx(c['dateValidation']);

export function calculerEngagements(cargos: Ligne[], o: { du?: string; au?: string; cle: ClePeriode }) {
  const natures = Object.fromEntries(NATURES_RAPPORT_ENGAGEMENT.map((n) => [n, {
    nature: n, camions: 0, vehicules: 0, conteneurs: 0, enCours: 0, soldes: 0,
  } as CompteNature])) as Record<NatureRapportEngagement, CompteNature>;
  const parPeriode = new Map<string, { camions: Ligne; conteneurs: Ligne }>();
  const lignes: (Ligne & { _date: string })[] = [];

  for (const c of cargos) {
    if (c['suiviEngagement'] !== true) continue;
    const pose = datePoseEngagement(c);
    if (!pose || !dansPeriode(pose, o.du, o.au)) continue;
    const nature = natureRapportEngagement(c['engagementType']);
    const n = natures[nature];
    const conts = conteneursDe(c);
    const veh = estOui(c['estVehicule']);
    if (veh) n.vehicules++; else n.camions++;
    n.conteneurs += conts.length;
    const solde = aFait(c['engagementEffectueLe']);
    if (solde) n.soldes++; else n.enCours++;

    const k = o.cle(pose);
    if (k) {
      const p = parPeriode.get(k) ?? parPeriode.set(k, { camions: { periode: k }, conteneurs: { periode: k } }).get(k)!;
      p.camions[nature] = Number(p.camions[nature] ?? 0) + 1;
      p.conteneurs[nature] = Number(p.conteneurs[nature] ?? 0) + conts.length;
    }

    lignes.push({
      _date: pose,
      'ID': tx(c['id']),
      'Camion': tx(c['numeroCamion']),
      'Véhicule': veh ? 'Oui' : '',
      'Nature': nature,
      'Engagement saisi': tx(c['engagementType']),
      'Posé le': dateHeureFr(pose),
      'Échéance': dateHeureFr(c['engagementDelai']),
      'Soldé le': solde ? dateHeureFr(c['engagementEffectueLe']) : '',
      'Opération': tx(c['typeOperation']),
      'Statut': tx(c['statut']),
      'N° déclaration': tx(c['numeroDeclaration']),
      'Déclarant': tx(c['declarant']),
      'Destination': tx(c['destinationMarchandise']),
      'Nb conteneurs': String(conts.length),
      'Conteneurs': conts.join(', '),
    });
  }

  const periodes = [...parPeriode.keys()].sort();
  const zero = (row: Ligne) => { for (const n of NATURES_RAPPORT_ENGAGEMENT) row[n] = Number(row[n] ?? 0); return row; };
  lignes.sort((a, b) => b._date.localeCompare(a._date) || tx(a['ID']).localeCompare(tx(b['ID'])));
  return {
    natures: NATURES_RAPPORT_ENGAGEMENT.map((n) => natures[n]),
    seriesCamions: periodes.map((k) => zero(parPeriode.get(k)!.camions)),
    seriesConteneurs: periodes.map((k) => zero(parPeriode.get(k)!.conteneurs)),
    lignes: lignes.map(({ _date: _, ...l }) => l as Record<string, string>),
  };
}

/* -------------------------------- amendes ------------------------------ */

export interface Amende { cargaisonId: string; montant: number; saisieLe: string; saisiePar: string }

export function calculerAmendes(
  amendes: Amende[], cargosParId: Map<string, Ligne>, noms: Map<string, string>,
  o: { du?: string; au?: string; cle: ClePeriode },
) {
  const compte = { camions: 0, conteneurs: 0, montantTotal: 0, forfaits: 0, autres: 0, montantForfaits: 0, montantAutres: 0 };
  const parPeriode = new Map<string, { periode: string; camions: number; conteneurs: number; montant: number }>();
  const lignes: (Ligne & { _date: string })[] = [];

  for (const a of amendes) {
    // Une cargaison annulée ou archivée n'est plus chargée : son amende sort
    // des statistiques avec elle, comme partout ailleurs.
    const c = cargosParId.get(a.cargaisonId);
    if (!c || !dansPeriode(a.saisieLe, o.du, o.au)) continue;
    const conts = conteneursDe(c);
    const forfait = a.montant === AMENDE_EFFETS_FORFAIT;
    compte.camions++;
    compte.conteneurs += conts.length;
    compte.montantTotal += a.montant;
    if (forfait) { compte.forfaits++; compte.montantForfaits += a.montant; }
    else { compte.autres++; compte.montantAutres += a.montant; }

    const k = o.cle(a.saisieLe);
    if (k) {
      const p = parPeriode.get(k) ?? parPeriode.set(k, { periode: k, camions: 0, conteneurs: 0, montant: 0 }).get(k)!;
      p.camions++; p.conteneurs += conts.length; p.montant += a.montant;
    }

    lignes.push({
      _date: a.saisieLe,
      'ID': a.cargaisonId,
      'Camion': tx(c['numeroCamion']),
      'Montant (FCFA)': String(a.montant),
      'Type': forfait ? 'Forfait' : 'Autre montant',
      'Saisie le': dateHeureFr(a.saisieLe),
      'Saisie par': noms.get(a.saisiePar) ?? '',
      'Nb conteneurs': String(conts.length),
      'Conteneurs': conts.join(', '),
      'N° déclaration': tx(c['numeroDeclaration']),
      'Déclarant': tx(c['declarant']),
      'Désignation': tx(c['descriptionMarchandise']),
      'Statut': tx(c['statut']),
    });
  }
  lignes.sort((a, b) => b._date.localeCompare(a._date) || tx(a['ID']).localeCompare(tx(b['ID'])));
  return {
    compte,
    series: [...parPeriode.values()].sort((a, b) => a.periode.localeCompare(b.periode)),
    lignes: lignes.map(({ _date: _, ...l }) => l as Record<string, string>),
  };
}
