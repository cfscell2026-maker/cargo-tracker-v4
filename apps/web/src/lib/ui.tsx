/**
 * Primitives d'interface + libellés/menus (reproduction de Client.html v3.6 :
 * MENUS, TITLES, roleLabel, statutLabel/tag, masques de saisie).
 */
import { useEffect, useState, type ReactNode } from 'react';
import { ROLE_LABELS, STATUTS, DESTINATIONS, DESTINATION_CODES } from '../../../../supabase/functions/_shared/domaine/src/index.ts';

export type MenuItem = [string, string, string];

export const MENUS: Record<string, MenuItem[]> = {
  CFS: [
    ['creercamion', 'Créer un camion', '＋'], ['completer', 'Saisir / compléter', '✎'],
    ['conso', 'Conso (type C)', '＋'], ['search', 'Recherche (en cours)', '⌕'], ['list', 'Cargaisons', '▤'], ['vehicules', 'Véhicules', '🚗'],
    ['conteneurs', 'Opérations sur conteneurs', '▦'], ['mad', 'Magasin / MAD', '▥'], ['entrepindus', 'Entrepôt industriel', '🏭'],
    ['etatcfs', 'Pointage camions (sortie)', '◨'], ['chargement', 'Bon de chargement', '▤'],
    ['cfsreport', 'Rapport CFS', '∑'], ['vehreport', 'Rapport véhicules', '∑'], ['destinations', 'Par destination', '⇄'], ['kpi', 'KPI / EVP', '◫'], ['dwell', 'Camions en instance', '⏱'], ['stockdwell', 'Séjour conteneurs', '⏱'], ['temps', 'Temps de passage', '⏳'], ['horodatage', 'Heures d\'activité', '⏰'], ['account', 'Mon compte', '◔'],
  ],
  // v4 — le chef brigade lit TOUS les rapports de TOUTES les cellules (lecture seule).
  CHEF_BRIGADE: [
    ['dash', 'Tableau de bord', '▦'], ['wait_valid', 'À valider', '✔'], ['search', 'Recherche (en cours)', '⌕'], ['list', 'Cargaisons', '▤'], ['vehicules', 'Véhicules', '🚗'],
    ['etatcfs', 'Pointage camions (sortie)', '◨'], ['chargement', 'Bon de chargement', '▤'],
    ['kpi', 'KPI / EVP', '◫'], ['cfsreport', 'Rapport CFS', '∑'], ['vehreport', 'Rapport véhicules', '∑'], ['baliserep', 'Rapport Balise', '∑'], ['pprep', 'Rapport PP', '∑'], ['t1report', 'Rapport T1', '∑'], ['bonsortiereport', 'Rapport Bon de sortie', '∑'], ['dispenses', 'Dispenses', '⚑'],
    ['flux', 'Analyse des flux', '⇄'], ['destinations', 'Par destination', '⇄'], ['controles', 'Contrôles (gabarit/surcharge)', '⚖'], ['dwell', 'Délai & instance', '⏱'], ['stockdwell', 'Séjour conteneurs', '⏱'], ['temps', 'Temps de passage', '⏳'], ['horodatage', 'Heures d\'activité', '⏰'], ['account', 'Mon compte', '◔'],
  ],
  CHEF_BRIGADE_ADJOINT: [['search', 'Recherche (en cours)', '⌕'], ['list', 'Cargaisons', '▤'], ['vehicules', 'Véhicules', '🚗'], ['kpi', 'KPI / EVP', '◫'], ['controles', 'Contrôles (gabarit/surcharge)', '⚖'], ['temps', 'Temps de passage', '⏳'], ['horodatage', 'Heures d\'activité', '⏰'], ['account', 'Mon compte', '◔']],
  // CBPI — chef brigade par intérim : UNIQUEMENT la file « À valider » (+ son
  // compte). Aucun autre écran : c'est une délégation de signature, rien d'autre.
  CBPI: [['wait_valid', 'À valider', '✔'], ['account', 'Mon compte', '◔']],
  CHEF_VISITE: [['dash', 'Tableau de bord', '▦'], ['search', 'Recherche (en cours)', '⌕'], ['list', 'Cargaisons', '▤'], ['vehicules', 'Véhicules', '🚗'], ['kpi', 'KPI / EVP', '◫'], ['controles', 'Contrôles (gabarit/surcharge)', '⚖'], ['temps', 'Temps de passage', '⏳'], ['horodatage', 'Heures d\'activité', '⏰'], ['account', 'Mon compte', '◔']],
  CHEF_DIVISION: [['dash', 'Tableau de bord', '▦'], ['search', 'Recherche (en cours)', '⌕'], ['list', 'Cargaisons', '▤'], ['vehicules', 'Véhicules', '🚗'], ['kpi', 'KPI / EVP', '◫'], ['controles', 'Contrôles (gabarit/surcharge)', '⚖'], ['temps', 'Temps de passage', '⏳'], ['horodatage', 'Heures d\'activité', '⏰'], ['account', 'Mon compte', '◔']],
  T1: [['t1', 'Cellule T1', '①'], ['wait_t1', 'En attente T1', '◷'], ['search', 'Recherche (en cours)', '⌕'], ['list', 'Cargaisons', '▤'], ['t1report', 'Rapport T1', '∑'], ['horodatage', 'Heures d\'activité', '⏰'], ['account', 'Mon compte', '◔']],
  BALISE: [['gps', 'Cellule Balise', '⊕'], ['wait_gps', 'En attente Balise', '◷'], ['dispenses', 'Dispenses', '⚑'], ['search', 'Recherche (en cours)', '⌕'], ['list', 'Cargaisons', '▤'], ['baliserep', 'Rapport Balise', '∑'], ['horodatage', 'Heures d\'activité', '⏰'], ['account', 'Mon compte', '◔']],
  BON_SORTIE: [['bonsortie', 'Cellule Bon de Sortie', '▣'], ['wait_bs', 'En attente Bon de Sortie', '◷'], ['search', 'Recherche (en cours)', '⌕'], ['list', 'Cargaisons', '▤'], ['bonsortiereport', 'Rapport Bon de sortie', '∑'], ['horodatage', 'Heures d\'activité', '⏰'], ['account', 'Mon compte', '◔']],
  PP: [['sortie', 'Sortie (checklist)', '⇲'], ['wait_sortie', 'En attente sortie', '◷'], ['conteneurs', 'Opérations sur conteneurs', '▦'], ['search', 'Recherche (en cours)', '⌕'], ['vehicules', 'Véhicules', '🚗'], ['list', 'Cargaisons', '▤'], ['pprep', 'Rapport PP', '∑'], ['destinations', 'Par destination', '⇄'], ['horodatage', 'Heures d\'activité', '⏰'], ['account', 'Mon compte', '◔']],
  ADMIN: [
    ['dash', 'Tableau de bord', '▦'], ['creercamion', 'Créer un camion', '＋'], ['completer', 'Saisir / compléter', '✎'], ['wait_valid', 'À valider', '✔'], ['conso', 'Conso (type C)', '＋'], ['search', 'Recherche (en cours)', '⌕'], ['list', 'Cargaisons', '▤'], ['vehicules', 'Véhicules', '🚗'],
    ['conteneurs', 'Opérations sur conteneurs', '▦'], ['mad', 'Magasin / MAD', '▥'], ['entrepindus', 'Entrepôt industriel', '🏭'], ['etatcfs', 'Pointage camions (sortie)', '◨'], ['chargement', 'Bon de chargement', '▤'],
    ['kpi', 'KPI / EVP', '◫'], ['cfsreport', 'Rapport CFS', '∑'], ['vehreport', 'Rapport véhicules', '∑'], ['baliserep', 'Rapport Balise', '∑'], ['pprep', 'Rapport PP', '∑'], ['t1report', 'Rapport T1', '∑'], ['bonsortiereport', 'Rapport Bon de sortie', '∑'], ['dispenses', 'Dispenses', '⚑'],
    ['flux', 'Analyse des flux', '⇄'], ['destinations', 'Par destination', '⇄'], ['controles', 'Contrôles (gabarit/surcharge)', '⚖'], ['dwell', 'Délai & instance', '⏱'], ['stockdwell', 'Séjour conteneurs', '⏱'], ['temps', 'Temps de passage', '⏳'], ['horodatage', 'Heures d\'activité', '⏰'], ['goulots', 'Nettoyage (goulots)', '🧹'], ['history', 'Historique', '◵'], ['users', 'Utilisateurs', '◑'], ['account', 'Mon compte', '◔'],
  ],
};

export const TITLES: Record<string, string> = {
  dash: 'Tableau de bord', new: 'Nouveau rapport', list: 'Cargaisons', search: 'Recherche — cargaisons en cours',
  creercamion: 'Créer un camion (entrée)',
  completer: 'Saisir / compléter les camions', stockjour: 'Stock CFS journalier',
  depotstats: 'Statistiques de dépotage',
  wait_valid: 'À valider — chef brigade', etatcfs: 'Pointage des camions à la sortie', t1: 'Cellule T1', wait_t1: 'En attente T1',
  chargement: 'Bon de chargement — par déclaration',
  gps: 'Cellule Balise', wait_gps: 'En attente Balise', bonsortie: 'Cellule Bon de Sortie', wait_bs: 'En attente Bon de Sortie',
  sortie: 'Sortie (checklist PP)', wait_sortie: 'En attente de sortie', history: 'Historique', users: 'Utilisateurs',
  account: 'Mon compte', detail: 'Détail cargaison', cfsreport: 'Rapport CFS', vehreport: 'Rapport véhicules',
  baliserep: 'Rapport Balise', pprep: 'Rapport PP', flux: 'Analyse des flux', dwell: 'Délai & camions en instance',
  t1report: 'Rapport T1 (T1 saisis)', bonsortiereport: 'Rapport Bon de sortie (bons émis)',
  horodatage: "Plage d'activité par cellule",
  goulots: 'Nettoyage — vieux dossiers (goulots)',
  vehicules: 'Véhicules', stock: 'Stock conteneurs', pointage: 'Pointage matinal', import: 'Stock initial — import',
  magasin: 'Entrée Magasin / MAD', importannonce: 'Annonce de transfert — import', annonce: 'Stock annoncé',
  pointentree: 'Pointage entrée (stock annoncé)', confentree: "Confirmer l'entrée au stock (annoncé)",
  kpi: 'KPI / EVP', dispenses: 'Suivi des dispenses', stockdwell: 'Séjour & instances conteneurs',
  temps: 'Temps de passage par poste',
  conteneurs: 'Opérations sur conteneurs', mad: 'Magasin / MAD', madsortie: 'Sortie Magasin / MAD',
  vehnew: 'Dépotage de véhicules', conso: 'Conso (type C)', destinations: 'Répartition par destination',
  controles: 'Statistiques de contrôle', entrepindus: 'Entrepôt industriel',
};

export const roleLabel = (r: string) => ROLE_LABELS[r] ?? r;

/**
 * Bouton « Retour » qui remonte d'un cran dans la navigation (et NOMME l'écran
 * de destination). Avant, chaque retour était codé en dur vers « Cargaisons » :
 * on quittait donc sa file d'attente ou son dossier de validation pour atterrir
 * ailleurs. `secours` sert quand la pile est vide (entrée directe sur l'écran).
 */
export function BoutonRetour({ retour, ecranPrecedent, secours }: {
  retour: () => void; ecranPrecedent: string | null; secours?: () => void;
}) {
  const cible = ecranPrecedent ? TITLES[ecranPrecedent] : null;
  return <button className="ghost" onClick={() => (ecranPrecedent ? retour() : secours?.())}>
    ← Retour{cible ? ` — ${cible}` : ''}
  </button>;
}
export const estChef = (r: string) => ['CHEF_BRIGADE', 'CHEF_BRIGADE_ADJOINT', 'CHEF_VISITE', 'CHEF_DIVISION', 'ADMIN'].includes(r);

/** Classe CSS + libellé d'un statut (statutTag / statutLabelRow v3.6). */
export function statutTag(statut: string, opts?: { numeroGps?: unknown; baliseRequise?: unknown }): { cls: string; label: string } {
  switch (statut) {
    case STATUTS.CAMION: return { cls: 'st-camion', label: 'Camion créé' };
    case STATUTS.CHARGEMENT: return { cls: 'st-charge', label: 'En cours de chargement' };
    case STATUTS.VEHICULE_OUILLAGE: return { cls: 'st-charge', label: 'Véhicule ouillage créé' };
    case STATUTS.CREEE: return { cls: 'st-creee', label: 'Créée' };
    case STATUTS.T1: return { cls: 'st-t1', label: 'T1 saisi' };
    case STATUTS.GPS: {
      const dispense = opts && !opts.numeroGps && (opts.baliseRequise === false || opts.baliseRequise === 'Non');
      return { cls: 'st-gps', label: dispense ? 'Dispensé' : 'Balisé' };
    }
    case STATUTS.BS: return { cls: 'st-bs', label: 'Bon de sortie émis' };
    case STATUTS.SORTIE: return { cls: 'st-sortie', label: 'Sorti' };
    default: return { cls: 'st-creee', label: statut };
  }
}

export function Tag({ statut, o }: { statut: string; o?: Record<string, unknown> }) {
  const t = statutTag(statut, o ? { numeroGps: o['numeroGps'], baliseRequise: o['baliseRequise'] } : undefined);
  return <span className={`tag ${t.cls}`}>{t.label}</span>;
}

/* --------------------------- Masques de saisie ------------------------- */
export const masks = {
  upper: (v: string) => v.toUpperCase(),
  alnum: (v: string) => v.toUpperCase().replace(/[^A-Z0-9/-]/g, ''),
  tc: (v: string) => {
    const s = v.toUpperCase().replace(/[^A-Z0-9]/g, '');
    return (s.slice(0, 4).replace(/[^A-Z]/g, '') + s.slice(4).replace(/[^0-9]/g, '')).slice(0, 11);
  },
  tel: (v: string) => v.replace(/[^\d+ ]/g, '').replace(/(?!^)\+/g, ''),
};

/* ------------------------------ Composants ----------------------------- */
export function Spinner() { return <div className="empty"><div className="spin" style={{ margin: 'auto' }} /></div>; }

export function StatCard({ n, l, tone, onClick }: { n: ReactNode; l: string; tone?: 'ok' | 'warn'; onClick?: () => void }) {
  return <div className={`stat ${tone ?? ''}`} onClick={onClick} role={onClick ? 'button' : undefined}>
    <div className="n">{n}</div><div className="l">{l}</div>
  </div>;
}

export function Modal({ children, onClose }: { children: ReactNode; onClose: () => void }) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h);
  }, [onClose]);
  return <div className="overlay" onClick={onClose}><div className="modal" onClick={(e) => e.stopPropagation()}>{children}</div></div>;
}

let toastFn: ((msg: string, kind?: 'ok' | 'err') => void) | null = null;
export function toast(msg: string, kind: 'ok' | 'err' = 'ok') { toastFn?.(msg, kind); }
export function ToastHost() {
  const [t, setT] = useState<{ msg: string; kind: string } | null>(null);
  useEffect(() => {
    toastFn = (msg, kind = 'ok') => { setT({ msg, kind }); setTimeout(() => setT(null), 3500); };
    return () => { toastFn = null; };
  }, []);
  if (!t) return null;
  return <div className={`toast ${t.kind}`}>{t.msg}</div>;
}

/**
 * v4.1 — Destination de la marchandise en LISTE DÉROULANTE (décision
 * utilisateur 2026-07-27). Une valeur héritée (texte libre migré) hors liste
 * n'est pas perdue : elle apparaît en tête, marquée « (actuel) ».
 */
export function ChampDestination({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const v = String(value ?? '');
  const connue = (DESTINATION_CODES as readonly string[]).includes(v.toUpperCase());
  return <div>
    <label className="help">Destination</label>
    <select value={connue ? v.toUpperCase() : v} onChange={(e) => onChange(e.target.value)}>
      <option value="">— Choisir —</option>
      {!connue && v && <option value={v}>{v} (actuel)</option>}
      {DESTINATIONS.map((d) => <option key={d.code} value={d.code}>{d.label}</option>)}
    </select>
  </div>;
}

/* ==========================================================================
 *  GRAPHIQUES — v4.2
 *
 *  SVG pur, aucune dépendance, compatible avec la CSP stricte (aucun script
 *  tiers n'est autorisé à s'exécuter : voir netlify.toml). Ce qui interdit
 *  d'emblée toute bibliothèque de graphiques chargée depuis un CDN.
 *
 *  Ce que la version précédente ne savait pas faire, et qui manquait pour lire
 *  vraiment un chiffre :
 *   · l'échelle était FORCÉE À L'ENTIER (`Math.ceil(max/4)`), donc un graphique
 *     de durées en heures dont le maximum valait 2,5 h affichait un axe 0-4 et
 *     toutes les courbes écrasées en bas ;
 *   · aucune valeur n'était lisible : ni au survol, ni sur les barres. Il
 *     fallait redescendre dans le tableau pour savoir ce qu'on regardait ;
 *   · un zéro et une donnée absente se traçaient pareil, ce qui invente une
 *     mesure là où il n'y en a pas ;
 *   · avec six séries, la légende ne servait qu'à colorier : impossible d'en
 *     isoler une pour la comparer.
 * ========================================================================== */

/** Teintes distinctes en clair comme en impression noir et blanc (luminosité étagée). */
const PALETTE = ['#0e5a8a', '#1f7a5c', '#a5670f', '#7b3fa0', '#b03060', '#2a8fa8', '#6b7a1f', '#5c6b7a'];

export interface SerieGraphique {
  nom: string;
  /** `null` = pas de mesure (trou dans la courbe), à distinguer d'un vrai zéro. */
  valeurs: (number | null)[];
  couleur?: string;
}

/**
 * Graduations « rondes » à toute échelle : 1, 2, 2,5 ou 5 × 10ⁿ.
 * C'est ce qui permet de lire aussi bien des camions (0…400) que des heures
 * (0…2,5) sans que l'axe ne devienne absurde.
 */
function graduations(max: number, cible = 4): number[] {
  if (!isFinite(max) || max <= 0) return [0, 1];
  const brut = max / cible;
  const magnitude = Math.pow(10, Math.floor(Math.log10(brut)));
  const norm = brut / magnitude;
  const pas = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * magnitude;
  const haut = Math.ceil(max / pas) * pas;
  const out: number[] = [];
  for (let v = 0; v <= haut + pas / 1000; v += pas) out.push(Math.round(v * 1000) / 1000);
  return out;
}

/** Nombre lisible en français : 1 234, 2,5 — jamais 2.5000000001. */
export const nombreFr = (v: number): string =>
  Number.isInteger(v) ? v.toLocaleString('fr-FR') : v.toLocaleString('fr-FR', { maximumFractionDigits: 2 });

export function Graphique({
  cats, series, type = 'barres', hauteur = 300, ordonnee = 'Nombre',
  format = nombreFr, repere, valeursSurBarres,
}: {
  cats: string[];
  series: SerieGraphique[];
  type?: 'barres' | 'barresEmpilees' | 'lignes' | 'aire';
  hauteur?: number;
  ordonnee?: string;
  /** Mise en forme des valeurs (axe, infobulle) — ex. durées en « 2 h 35 ». */
  format?: (v: number) => string;
  /** Ligne de référence horizontale : objectif de service, moyenne, seuil… */
  repere?: { valeur: number; libelle: string };
  /** Affiche la valeur au-dessus de chaque barre (lisible jusqu'à ~12 barres). */
  valeursSurBarres?: boolean;
}) {
  // `isole` = index de la série mise en avant par un clic sur la légende.
  const [isole, setIsole] = useState<number | null>(null);
  const [survol, setSurvol] = useState<number | null>(null);

  if (!cats.length || !series.length) return <div className="empty">Pas de données à tracer sur la période.</div>;

  const visibles = series.map((s, i) => ({ s, i })).filter(({ i }) => isole === null || isole === i);
  const empile = type === 'barresEmpilees';

  // Échelle : le sommet d'une pile, sinon la plus grande valeur d'une série.
  const maxV = empile
    ? Math.max(0, ...cats.map((_, i) => visibles.reduce((t, { s }) => t + Math.max(0, s.valeurs[i] ?? 0), 0)))
    : Math.max(0, ...visibles.flatMap(({ s }) => s.valeurs.map((v) => v ?? 0)));
  const ticks = graduations(Math.max(maxV, repere?.valeur ?? 0));
  const hautMax = ticks[ticks.length - 1] || 1;

  const W = 760, H = hauteur, mL = 56, mR = 14, mT = 16, mB = 54;
  const iw = W - mL - mR, ih = H - mT - mB;
  const bande = iw / cats.length;
  const y = (v: number) => mT + ih - (Math.max(0, v) / hautMax) * ih;
  const x = (i: number) => mL + bande * (i + 0.5);
  const couleur = (i: number) => series[i]?.couleur ?? PALETTE[i % PALETTE.length]!;

  /* Étiquettes de l'axe X : au-delà d'une quinzaine de catégories, elles se
     chevauchent et deviennent illisibles — on n'en garde qu'une sur N. */
  const saut = Math.ceil(cats.length / 14);

  const svgH = H;
  return <div>
    <div style={{ position: 'relative', overflowX: 'auto' }}>
      <svg viewBox={`0 0 ${W} ${svgH}`} width="100%" style={{ minWidth: 320, display: 'block' }}
        role="img" aria-label={`${ordonnee} — ${series.map((s) => s.nom).join(', ')}`}>
        <title>{ordonnee}</title>

        {/* Grille + axe des ordonnées */}
        {ticks.map((t) => <g key={t}>
          <line x1={mL} y1={y(t)} x2={W - mR} y2={y(t)} stroke="var(--line)" strokeWidth={1} />
          <text x={mL - 8} y={y(t) + 4} textAnchor="end" fontSize={11} fill="var(--muted)">{format(t)}</text>
        </g>)}
        <text x={14} y={mT + ih / 2} fontSize={11} fill="var(--muted)"
          transform={`rotate(-90 14 ${mT + ih / 2})`} textAnchor="middle">{ordonnee}</text>

        {/* Ligne de référence (objectif, seuil) */}
        {repere && repere.valeur <= hautMax && <g>
          <line x1={mL} y1={y(repere.valeur)} x2={W - mR} y2={y(repere.valeur)}
            stroke="var(--warn)" strokeWidth={1.5} strokeDasharray="6 4" />
          <text x={W - mR - 4} y={y(repere.valeur) - 5} textAnchor="end" fontSize={10} fill="var(--warn)">{repere.libelle}</text>
        </g>}

        {/* Bande survolée : repère visuel avant l'infobulle */}
        {survol !== null && <rect x={mL + bande * survol} y={mT} width={bande} height={ih} fill="var(--accent)" opacity={0.07} />}

        {/* Étiquettes de l'axe X */}
        {cats.map((c, i) => (i % saut === 0
          ? <text key={i} x={x(i)} y={H - mB + 17} textAnchor="middle" fontSize={10}
              fill={survol === i ? 'var(--ink)' : 'var(--muted)'} fontWeight={survol === i ? 700 : 400}>{c}</text>
          : null))}

        {/* Séries */}
        {type === 'lignes' || type === 'aire'
          ? visibles.map(({ s, i: si }) => {
              /* Une valeur `null` COUPE la courbe au lieu d'être tracée à zéro :
                 sans quoi une journée sans mesure s'afficherait comme une chute
                 de la performance à zéro, ce qui est faux. */
              const segments: { i: number; v: number }[][] = [];
              let courant: { i: number; v: number }[] = [];
              s.valeurs.forEach((v, i) => {
                if (v === null || v === undefined || !isFinite(v)) { if (courant.length) segments.push(courant); courant = []; }
                else courant.push({ i, v });
              });
              if (courant.length) segments.push(courant);
              const col = couleur(si);
              return <g key={si}>
                {type === 'aire' && segments.map((seg, k) => seg.length > 1 && <polygon key={k} fill={col} opacity={0.12}
                  points={`${x(seg[0]!.i)},${y(0)} ${seg.map((pt) => `${x(pt.i)},${y(pt.v)}`).join(' ')} ${x(seg[seg.length - 1]!.i)},${y(0)}`} />)}
                {segments.map((seg, k) => <polyline key={k} fill="none" stroke={col} strokeWidth={2.2}
                  strokeLinejoin="round" strokeLinecap="round" points={seg.map((pt) => `${x(pt.i)},${y(pt.v)}`).join(' ')} />)}
                {/* Points : indispensables quand un segment ne compte qu'une mesure isolée. */}
                {segments.flat().map((pt) => <circle key={pt.i} cx={x(pt.i)} cy={y(pt.v)}
                  r={survol === pt.i ? 4.5 : 2.5} fill="var(--panel)" stroke={col} strokeWidth={2} />)}
              </g>;
            })
          : cats.map((_, i) => {
              if (empile) {
                let cumul = 0;
                return <g key={i}>{visibles.map(({ s, i: si }) => {
                  const v = Math.max(0, s.valeurs[i] ?? 0);
                  const yb = y(cumul + v), hb = y(cumul) - y(cumul + v);
                  cumul += v;
                  return v > 0 ? <rect key={si} x={x(i) - bande * 0.35} y={yb} width={bande * 0.7} height={Math.max(1, hb)} fill={couleur(si)} /> : null;
                })}</g>;
              }
              const bw = (bande * 0.72) / visibles.length;
              return <g key={i}>{visibles.map(({ s, i: si }, k) => {
                const v = s.valeurs[i];
                if (v === null || v === undefined || !isFinite(v)) return null;
                const bx = x(i) - bande * 0.36 + k * bw;
                const bh = Math.max(v > 0 ? 1 : 0, mT + ih - y(v));
                return <g key={si}>
                  <rect x={bx} y={y(v)} width={Math.max(1, bw - 1.5)} height={bh} fill={couleur(si)} rx={1.5} />
                  {valeursSurBarres && v > 0 && visibles.length <= 2 && cats.length <= 12 &&
                    <text x={bx + bw / 2} y={y(v) - 4} textAnchor="middle" fontSize={9.5} fill="var(--muted)">{format(v)}</text>}
                </g>;
              })}</g>;
            })}

        {/* Zones de survol — transparentes, posées en dernier pour capter le pointeur */}
        {cats.map((_, i) => <rect key={i} x={mL + bande * i} y={mT} width={bande} height={ih} fill="transparent"
          onMouseEnter={() => setSurvol(i)} onMouseLeave={() => setSurvol(null)} />)}
      </svg>

      {/* Infobulle : toutes les séries de la catégorie survolée, d'un coup d'œil */}
      {survol !== null && <div style={{
        position: 'absolute', top: 8, pointerEvents: 'none',
        left: `calc(${((mL + bande * (survol + 0.5)) / W) * 100}% + ${survol < cats.length / 2 ? 12 : -12}px)`,
        transform: survol < cats.length / 2 ? 'none' : 'translateX(-100%)',
        background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 6,
        boxShadow: '0 2px 10px rgba(0,0,0,.12)', padding: '6px 9px', fontSize: 12, minWidth: 140, zIndex: 2,
      }}>
        <div style={{ fontWeight: 700, marginBottom: 3 }}>{cats[survol]}</div>
        {visibles.map(({ s, i: si }) => {
          const v = s.valeurs[survol!];
          return <div key={si} style={{ display: 'flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap' }}>
            <span style={{ width: 9, height: 9, borderRadius: 2, background: couleur(si), display: 'inline-block', flexShrink: 0 }} />
            <span style={{ color: 'var(--muted)', flex: 1 }}>{s.nom}</span>
            <b>{v === null || v === undefined || !isFinite(v) ? '—' : format(v)}</b>
          </div>;
        })}
      </div>}
    </div>

    {/* Légende CLIQUABLE : isoler une série est la seule façon de la lire
        quand six courbes se croisent. Un second clic rétablit l'ensemble. */}
    <div className="row" style={{ flexWrap: 'wrap', gap: 10, marginTop: 8, justifyContent: 'center' }}>
      {series.map((s, si) => {
        const actif = isole === null || isole === si;
        return <button key={si} type="button" className="ghost xs"
          onClick={() => setIsole((v) => (v === si ? null : si))}
          aria-pressed={isole === si}
          title={isole === si ? 'Afficher toutes les séries' : `N’afficher que « ${s.nom} »`}
          style={{
            display: 'flex', alignItems: 'center', gap: 6, padding: '3px 8px',
            opacity: actif ? 1 : 0.4, borderColor: isole === si ? couleur(si) : 'var(--line)',
          }}>
          <span style={{ width: 11, height: 11, borderRadius: 2, background: couleur(si), display: 'inline-block' }} />
          {s.nom}
        </button>;
      })}
    </div>
    {series.length > 1 && <div className="help" style={{ textAlign: 'center', marginTop: 2 }}>
      Survolez le graphique pour lire les valeurs · cliquez une légende pour isoler une série
    </div>}
  </div>;
}

/**
 * Classement horizontal — la forme juste pour comparer des CATÉGORIES entre
 * elles (destinations, déclarants, postes) plutôt qu'une évolution dans le
 * temps. Les libellés s'y lisent en entier, ce qu'un axe X vertical ne permet
 * jamais, et l'ordre décroissant répond directement à « qui pèse le plus ».
 */
export function BarresClassees({ lignes, format = nombreFr, total, max = 12, onClic }: {
  lignes: { nom: string; valeur: number }[];
  format?: (v: number) => string;
  /** Base des pourcentages ; par défaut la somme des lignes affichées. */
  total?: number;
  max?: number;
  onClic?: (nom: string) => void;
}) {
  const tri = [...lignes].filter((l) => isFinite(l.valeur)).sort((a, b) => b.valeur - a.valeur);
  if (!tri.length) return <div className="empty">Aucune donnée à comparer.</div>;
  const gardees = tri.slice(0, max);
  const reste = tri.slice(max);
  const somme = total ?? tri.reduce((s, l) => s + l.valeur, 0);
  const plafond = Math.max(1, gardees[0]!.valeur);
  return <div style={{ display: 'grid', gap: 6 }}>
    {gardees.map((l) => {
      const pct = somme > 0 ? (l.valeur / somme) * 100 : 0;
      return <div key={l.nom} onClick={onClic ? () => onClic(l.nom) : undefined}
        style={{ cursor: onClic ? 'pointer' : 'default' }}>
        <div className="row" style={{ justifyContent: 'space-between', gap: 8, fontSize: 12.5 }}>
          <span style={{ fontWeight: 600 }}>{l.nom}</span>
          <span style={{ color: 'var(--muted)', whiteSpace: 'nowrap' }}>
            <b style={{ color: 'var(--ink)' }}>{format(l.valeur)}</b>{somme > 0 && ` · ${pct.toFixed(1)} %`}
          </span>
        </div>
        <div style={{ background: 'var(--line)', borderRadius: 3, height: 9, overflow: 'hidden', marginTop: 2 }}>
          <div style={{ width: `${Math.max(1, (l.valeur / plafond) * 100)}%`, height: '100%', background: 'var(--accent)', borderRadius: 3 }} />
        </div>
      </div>;
    })}
    {reste.length > 0 && <div className="help">
      + {reste.length} autre(s) — {format(reste.reduce((s, l) => s + l.valeur, 0))} au total
    </div>}
  </div>;
}

export function fmtDate(v: unknown): string {
  if (!v) return '—';
  const d = new Date(String(v));
  return isNaN(d.getTime()) ? String(v) : d.toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' });
}
export function fmtJour(v: unknown): string {
  if (!v) return '—';
  const d = new Date(String(v));
  return isNaN(d.getTime()) ? String(v) : d.toLocaleDateString('fr-FR');
}
// Ré-exporté depuis periode.ts : une SEULE définition de la date ISO courte
// dans l'appli (l'ancienne copie ici passait par UTC, celle-ci reste locale).
export { isoDate } from './periode.ts';
