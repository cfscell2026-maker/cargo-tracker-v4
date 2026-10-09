/**
 * ============================================================================
 *  EXTRACTION SUR MESURE : 2026-10-09 (demande utilisateur).
 *
 *  « On fait les filtres, on les applique au tout, et on extrait juste les
 *  camions, les conteneurs ou les déclarations concernés. » Exemple donné :
 *  les enlèvements engagés vers le bureau BF ; et la DÉSIGNATION de la
 *  marchandise partout, avec une recherche dessus.
 *
 *  Ce module est PUR : il reçoit des cargaisons déjà chargées (camelCase, sans
 *  les annulées ni les archivées) et rend des colonnes et des lignes prêtes à
 *  afficher et à extraire. L'action serveur (rapports.ts) ne fait que charger,
 *  appeler, et tracer l'export.
 *
 *  UNE LIGNE PAR CONTENEUR D'ABORD. Depuis le LOT D, un conteneur porte SA
 *  déclaration et sa désignation ; un camion en chargement mixte en porte
 *  plusieurs. Les filtres s'appliquent donc conteneur par conteneur (un camion
 *  sans conteneur compte pour une ligne, sur la déclaration du camion), puis
 *  les lignes retenues sont regroupées selon ce qu'on extrait :
 *    · camions      : un camion par ligne, avec les seules déclarations RETENUES ;
 *    · conteneurs   : une ligne par conteneur retenu ;
 *    · déclarations : une ligne par déclaration, camions et conteneurs listés.
 * ============================================================================
 */
import {
  STATUTS, LIBELLES_TYPE_DECLARATION, parseConteneursDetails, estOui, normAlphaNum,
} from '../../_shared/domaine/src/index.ts';

type Ligne = Record<string, unknown>;

export type Niveau = 'camions' | 'conteneurs' | 'declarations';

/** Date sur laquelle porte la période : celle de la cellule qui intéresse. */
export const DATES_REFERENCE: Record<string, { col: string; colSql: string; libelle: string }> = {
  entree: { col: 'dateCreation', colSql: 'date_creation', libelle: 'Entrée' },
  validation: { col: 'dateValidation', colSql: 'date_validation', libelle: 'Validation' },
  t1: { col: 'dateT1', colSql: 'date_t1', libelle: 'T1' },
  bonsortie: { col: 'dateBonSortie', colSql: 'date_bon_sortie', libelle: 'Bon de sortie' },
  balise: { col: 'datePoseGps', colSql: 'date_pose_gps', libelle: 'Balise' },
  sortie: { col: 'dateSortie', colSql: 'date_sortie', libelle: 'Sortie' },
};

export interface FiltresExtraction {
  niveau?: Niveau;
  dateRef?: string;
  du?: string;
  au?: string;
  operation?: string;
  etat?: '' | 'encours' | 'sortis';
  statut?: string;
  typeDeclaration?: string;
  bureauDeclaration?: string;
  bureauDestination?: string;
  destination?: string;
  engagement?: '' | 'oui' | 'non';
  natureEngagement?: string;
  declarant?: string;
  numeroDeclaration?: string;
  /** Un ou plusieurs termes séparés par « ; » : la désignation doit en contenir AU MOINS UN. */
  designation?: string;
  /** N° de camion, de conteneur ou ID de dossier ; espaces et tirets ignorés. */
  recherche?: string;
  vehicules?: 'exclure' | 'inclure' | 'seulement';
}

/* ---------------------------- outils ---------------------------------- */

const tx = (v: unknown) => String(v ?? '').trim();

/** Comparaison indulgente : casse, accents et espaces en trop ignorés. */
export const normTexte = (v: unknown) => String(v ?? '')
  .normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/\s+/g, ' ').trim();

const contient = (valeur: unknown, cherche: string | undefined) =>
  !cherche || normTexte(valeur).includes(normTexte(cherche));

/** Vrai si la désignation contient au moins un des termes (« riz ; sucre »). */
export function designationCorrespond(designation: unknown, termes: string | undefined): boolean {
  const liste = String(termes ?? '').split(';').map(normTexte).filter(Boolean);
  if (!liste.length) return true;
  const d = normTexte(designation);
  return liste.some((t) => d.includes(t));
}

/** Période inclusive sur des jours UTC (= heure locale au Togo). */
function dansPeriode(v: unknown, du?: string, au?: string): boolean {
  if (!du && !au) return true;
  if (!v) return false;
  const t = new Date(String(v)).getTime();
  if (isNaN(t)) return false;
  if (du && t < Date.parse(du + 'T00:00:00Z')) return false;
  if (au && t >= Date.parse(au + 'T00:00:00Z') + 86400000) return false;
  return true;
}

/** « 2026-10-05T14:32:00Z » → « 05/10/2026 14:32 ». */
export function dateHeureFr(v: unknown): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/.exec(tx(v));
  if (!m) return '';
  return `${m[3]}/${m[2]}/${m[1]}` + (m[4] ? ` ${m[4]}:${m[5]}` : '');
}

/** Numéros d'une pièce (T1, bon de sortie), sous toutes ses formes stockées ;
 *  pour un conteneur précis quand la pièce est saisie conteneur par conteneur. */
export function numerosPiece(v: unknown, conteneur?: string): string {
  const liste = Array.isArray(v) ? v : v === null || v === undefined || v === '' ? [] : [v];
  const lignes = liste.map((x) => (x !== null && typeof x === 'object'
    ? { cont: normAlphaNum((x as Ligne)['conteneur']), num: tx((x as Ligne)['numero']) }
    : { cont: '', num: tx(x) })).filter((l) => l.num);
  const cible = normAlphaNum(conteneur);
  const siennes = cible ? lignes.filter((l) => l.cont === cible) : [];
  return [...new Set((siennes.length ? siennes : lignes).map((l) => l.num))].join(', ');
}

const uniques = (vals: unknown[], sep = ' / ') => [...new Set(vals.map(tx).filter(Boolean))].join(sep);

/* ----------------------- lignes par conteneur -------------------------- */

interface LigneCt {
  c: Ligne;
  ct: Ligne | null;
  declarant: string; numeroDeclaration: string; anneeDeclaration: string;
  bureauDeclaration: string; typeDeclaration: string; designation: string;
  t1: string; bonSortie: string;
}

function lignesDe(c: Ligne): LigneCt[] {
  const dets = parseConteneursDetails(c['conteneursDetails']).conteneurs as unknown as Ligne[];
  const sources: (Ligne | null)[] = dets.length ? dets : [null];
  return sources.map((ct) => {
    const src = ct && tx(ct['numeroDeclaration']) ? ct : c;
    const num = ct ? tx(ct['num']) : '';
    return {
      c, ct,
      declarant: tx(src['declarant']) || tx(c['declarant']),
      numeroDeclaration: tx(src['numeroDeclaration']), anneeDeclaration: tx(src['anneeDeclaration']),
      bureauDeclaration: tx(src['bureauDeclaration']), typeDeclaration: tx(src['typeDeclaration']).toUpperCase(),
      designation: tx(ct?.['descriptionMarchandise']) || tx(c['descriptionMarchandise']),
      t1: numerosPiece(c['t1Numeros'], num || undefined),
      bonSortie: numerosPiece(c['bonSortieNumero'], num || undefined),
    };
  });
}

const estSorti = (c: Ligne) => c['statut'] === STATUTS.SORTIE || !!tx(c['dateSortie']);

function garder(l: LigneCt, f: FiltresExtraction): boolean {
  const c = l.c;
  const ref = DATES_REFERENCE[f.dateRef ?? 'entree'] ?? DATES_REFERENCE['entree']!;
  if (!dansPeriode(c[ref.col], f.du, f.au)) return false;

  const veh = estOui(c['estVehicule']);
  const regleVeh = f.vehicules ?? 'exclure';
  if (regleVeh === 'exclure' && veh) return false;
  if (regleVeh === 'seulement' && !veh) return false;

  if (f.operation && tx(c['typeOperation']) !== f.operation) return false;
  if (f.etat === 'sortis' && !estSorti(c)) return false;
  if (f.etat === 'encours' && estSorti(c)) return false;
  if (f.statut && tx(c['statut']) !== f.statut) return false;

  if (f.typeDeclaration && l.typeDeclaration !== tx(f.typeDeclaration).toUpperCase()) return false;
  if (!contient(l.bureauDeclaration, f.bureauDeclaration)) return false;
  if (!contient(c['bureauDestination'], f.bureauDestination)) return false;
  if (!contient(c['destinationMarchandise'], f.destination)) return false;
  if (!contient(l.declarant, f.declarant)) return false;
  if (f.numeroDeclaration && !normAlphaNum(l.numeroDeclaration).includes(normAlphaNum(f.numeroDeclaration))) return false;
  if (!designationCorrespond(l.designation, f.designation)) return false;

  const engage = c['suiviEngagement'] === true;
  if (f.engagement === 'oui' && !engage) return false;
  if (f.engagement === 'non' && engage) return false;
  if (f.natureEngagement && !(engage && contient(c['engagementType'], f.natureEngagement))) return false;

  if (f.recherche) {
    const q = normAlphaNum(f.recherche);
    const champs = [c['numeroCamion'], c['id'], l.ct?.['num']];
    if (q && !champs.some((v) => normAlphaNum(v).includes(q))) return false;
  }
  return true;
}

/* --------------------------- regroupements ----------------------------- */

const libType = (t: string) => (t ? t + (LIBELLES_TYPE_DECLARATION[t] ? ' · ' + LIBELLES_TYPE_DECLARATION[t] : '') : '');

function colonnesCamion(c: Ligne, ls: LigneCt[], voitBalise: boolean): Record<string, string> {
  const conts = ls.map((l) => tx(l.ct?.['num'])).filter(Boolean);
  return {
    'ID': tx(c['id']),
    'Camion': tx(c['numeroCamion']),
    'Opération': tx(c['typeOperation']),
    'Statut': tx(c['statut']),
    'Déclarant': uniques(ls.map((l) => l.declarant)),
    'N° déclaration': uniques(ls.map((l) => l.numeroDeclaration)),
    'Année': uniques(ls.map((l) => l.anneeDeclaration)),
    'Bureau décl.': uniques(ls.map((l) => l.bureauDeclaration)),
    'Type décl.': uniques(ls.map((l) => libType(l.typeDeclaration))),
    'Désignation': uniques(ls.map((l) => l.designation)),
    'Destination': tx(c['destinationMarchandise']),
    'Bureau de destination (T1)': tx(c['bureauDestination']),
    'T1': uniques(ls.map((l) => l.t1), ', '),
    'Bon de sortie': uniques(ls.map((l) => l.bonSortie), ', '),
    ...(voitBalise ? { 'N° balise': tx(c['numeroGps']) } : {}),
    'Engagement': c['suiviEngagement'] === true ? tx(c['engagementType']) || 'Oui' : '',
    'Nb conteneurs': String(conts.length),
    'Conteneurs': conts.join(', '),
    'Entré le': dateHeureFr(c['dateCreation']),
    'Validé le': dateHeureFr(c['dateValidation']),
    'T1 le': dateHeureFr(c['dateT1']),
    'Bon de sortie le': dateHeureFr(c['dateBonSortie']),
    'Balisé le': dateHeureFr(c['datePoseGps']),
    'Sorti le': dateHeureFr(c['dateSortie']),
  };
}

function colonnesConteneur(l: LigneCt, voitBalise: boolean): Record<string, string> {
  const c = l.c, ct = l.ct ?? {};
  return {
    'Conteneur': tx(ct['num']),
    'Taille': tx(ct['taille']),
    'Type': tx(ct['type']),
    'Scellé': tx(ct['plomb']),
    'Camion': tx(c['numeroCamion']),
    'ID': tx(c['id']),
    'Opération': tx(c['typeOperation']),
    'Statut': tx(c['statut']),
    'Déclarant': l.declarant,
    'N° déclaration': l.numeroDeclaration,
    'Année': l.anneeDeclaration,
    'Bureau décl.': l.bureauDeclaration,
    'Type décl.': libType(l.typeDeclaration),
    'Désignation': l.designation,
    'Destination': tx(c['destinationMarchandise']),
    'Bureau de destination (T1)': tx(c['bureauDestination']),
    'T1': l.t1,
    'Bon de sortie': l.bonSortie,
    ...(voitBalise ? { 'N° balise': tx(c['numeroGps']) } : {}),
    'Engagement': c['suiviEngagement'] === true ? tx(c['engagementType']) || 'Oui' : '',
    'Entré le': dateHeureFr(c['dateCreation']),
    'Sorti le': dateHeureFr(c['dateSortie']),
  };
}

function colonnesDeclaration(ls: LigneCt[]): Record<string, string> {
  const l0 = ls[0]!;
  const camions = [...new Map(ls.map((l) => [tx(l.c['id']), l.c])).values()];
  const conts = [...new Set(ls.map((l) => tx(l.ct?.['num'])).filter(Boolean))];
  const dates = (col: string) => camions.map((c) => tx(c[col])).filter(Boolean).sort();
  const entrees = dates('dateCreation'), sorties = dates('dateSortie');
  return {
    'N° déclaration': l0.numeroDeclaration,
    'Année': l0.anneeDeclaration,
    'Bureau décl.': l0.bureauDeclaration,
    'Type décl.': libType(l0.typeDeclaration),
    'Déclarant': uniques(ls.map((l) => l.declarant)),
    'Désignation': uniques(ls.map((l) => l.designation)),
    'Destination': uniques(camions.map((c) => c['destinationMarchandise'])),
    'Bureau de destination (T1)': uniques(camions.map((c) => c['bureauDestination'])),
    'Opération': uniques(camions.map((c) => c['typeOperation'])),
    'Engagement': uniques(camions.map((c) => (c['suiviEngagement'] === true ? tx(c['engagementType']) || 'Oui' : ''))),
    'Nb camions': String(camions.length),
    'Nb conteneurs': String(conts.length),
    'Camions': uniques(camions.map((c) => c['numeroCamion']), ', '),
    'Conteneurs': conts.join(', '),
    'T1': uniques(ls.map((l) => l.t1), ', '),
    'Bon de sortie': uniques(ls.map((l) => l.bonSortie), ', '),
    'Première entrée': dateHeureFr(entrees[0]),
    'Dernière sortie': dateHeureFr(sorties[sorties.length - 1]),
    'Camions sortis': `${camions.filter(estSorti).length} / ${camions.length}`,
  };
}

/** Clé d'une déclaration : année, bureau, type et numéro, sans casse ni ponctuation. */
const cleDecl = (l: LigneCt) => [l.anneeDeclaration, l.bureauDeclaration, l.typeDeclaration, l.numeroDeclaration]
  .map(normAlphaNum).join('|');

export interface ResultatExtraction {
  niveau: Niveau;
  colonnes: string[];
  lignes: Record<string, string>[];
  total: number;
}

export function extraire(cargos: Ligne[], f: FiltresExtraction, opts: { voitBalise: boolean }): ResultatExtraction {
  const niveau: Niveau = f.niveau === 'conteneurs' || f.niveau === 'declarations' ? f.niveau : 'camions';
  const ref = DATES_REFERENCE[f.dateRef ?? 'entree'] ?? DATES_REFERENCE['entree']!;
  // Plus récent d'abord, sur la date choisie ; à défaut, l'entrée.
  const tries = [...cargos].sort((a, b) =>
    tx(b[ref.col] || b['dateCreation']).localeCompare(tx(a[ref.col] || a['dateCreation'])) || tx(a['id']).localeCompare(tx(b['id'])));
  const retenues = tries.flatMap(lignesDe).filter((l) => garder(l, f));

  let lignes: Record<string, string>[];
  if (niveau === 'conteneurs') {
    lignes = retenues.filter((l) => l.ct).map((l) => colonnesConteneur(l, opts.voitBalise));
  } else if (niveau === 'declarations') {
    const groupes = new Map<string, LigneCt[]>();
    for (const l of retenues) {
      if (!l.numeroDeclaration) continue; // sans numéro, ce n'est pas une déclaration identifiable
      const k = cleDecl(l);
      (groupes.get(k) ?? groupes.set(k, []).get(k)!).push(l);
    }
    lignes = [...groupes.values()].map(colonnesDeclaration);
  } else {
    const parCamion = new Map<string, LigneCt[]>();
    for (const l of retenues) {
      const k = tx(l.c['id']);
      (parCamion.get(k) ?? parCamion.set(k, []).get(k)!).push(l);
    }
    lignes = [...parCamion.values()].map((ls) => colonnesCamion(ls[0]!.c, ls, opts.voitBalise));
  }
  const colonnes = lignes.length ? Object.keys(lignes[0]!) : [];
  return { niveau, colonnes, lignes, total: lignes.length };
}

/** Résumé lisible des filtres actifs (journal d'audit, nom de fichier). */
export function resumeFiltres(f: FiltresExtraction): string {
  const ref = DATES_REFERENCE[f.dateRef ?? 'entree']?.libelle ?? 'Entrée';
  const morceaux = [
    f.du || f.au ? `${ref} du ${f.du || '…'} au ${f.au || '…'}` : '',
    f.operation ?? '', f.etat === 'sortis' ? 'sortis' : f.etat === 'encours' ? 'en cours' : '',
    f.statut ?? '', f.typeDeclaration ? 'type ' + f.typeDeclaration : '',
    f.bureauDeclaration ? 'bureau décl. ' + f.bureauDeclaration : '',
    f.bureauDestination ? 'bureau dest. ' + f.bureauDestination : '',
    f.destination ? 'destination ' + f.destination : '',
    f.engagement === 'oui' ? 'engagés' : f.engagement === 'non' ? 'non engagés' : '',
    f.natureEngagement ? 'engagement ' + f.natureEngagement : '',
    f.declarant ? 'déclarant ' + f.declarant : '', f.numeroDeclaration ? 'décl. ' + f.numeroDeclaration : '',
    f.designation ? 'désignation ' + f.designation : '', f.recherche ? 'recherche ' + f.recherche : '',
    f.vehicules === 'seulement' ? 'véhicules seuls' : f.vehicules === 'inclure' ? 'véhicules inclus' : '',
  ];
  return morceaux.filter(Boolean).join(' · ') || 'aucun filtre';
}

