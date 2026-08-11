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
    ['cfsreport', 'Rapport CFS', '∑'], ['vehreport', 'Rapport véhicules', '∑'], ['destinations', 'Par destination', '⇄'], ['kpi', 'KPI / EVP', '◫'], ['dwell', 'Camions en instance', '⏱'], ['stockdwell', 'Séjour conteneurs', '⏱'], ['account', 'Mon compte', '◔'],
  ],
  // v4 — le chef brigade lit TOUS les rapports de TOUTES les cellules (lecture seule).
  CHEF_BRIGADE: [
    ['dash', 'Tableau de bord', '▦'], ['wait_valid', 'À valider', '✔'], ['search', 'Recherche (en cours)', '⌕'], ['list', 'Cargaisons', '▤'], ['vehicules', 'Véhicules', '🚗'],
    ['etatcfs', 'Pointage camions (sortie)', '◨'], ['chargement', 'Bon de chargement', '▤'],
    ['kpi', 'KPI / EVP', '◫'], ['cfsreport', 'Rapport CFS', '∑'], ['vehreport', 'Rapport véhicules', '∑'], ['baliserep', 'Rapport Balise', '∑'], ['pprep', 'Rapport PP', '∑'], ['dispenses', 'Dispenses', '⚑'],
    ['flux', 'Analyse des flux', '⇄'], ['destinations', 'Par destination', '⇄'], ['controles', 'Contrôles (gabarit/surcharge)', '⚖'], ['dwell', 'Délai & instance', '⏱'], ['stockdwell', 'Séjour conteneurs', '⏱'], ['account', 'Mon compte', '◔'],
  ],
  CHEF_BRIGADE_ADJOINT: [['search', 'Recherche (en cours)', '⌕'], ['list', 'Cargaisons', '▤'], ['vehicules', 'Véhicules', '🚗'], ['kpi', 'KPI / EVP', '◫'], ['controles', 'Contrôles (gabarit/surcharge)', '⚖'], ['account', 'Mon compte', '◔']],
  CHEF_VISITE: [['dash', 'Tableau de bord', '▦'], ['search', 'Recherche (en cours)', '⌕'], ['list', 'Cargaisons', '▤'], ['vehicules', 'Véhicules', '🚗'], ['kpi', 'KPI / EVP', '◫'], ['controles', 'Contrôles (gabarit/surcharge)', '⚖'], ['account', 'Mon compte', '◔']],
  CHEF_DIVISION: [['dash', 'Tableau de bord', '▦'], ['search', 'Recherche (en cours)', '⌕'], ['list', 'Cargaisons', '▤'], ['vehicules', 'Véhicules', '🚗'], ['kpi', 'KPI / EVP', '◫'], ['controles', 'Contrôles (gabarit/surcharge)', '⚖'], ['account', 'Mon compte', '◔']],
  T1: [['t1', 'Cellule T1', '①'], ['wait_t1', 'En attente T1', '◷'], ['search', 'Recherche (en cours)', '⌕'], ['list', 'Cargaisons', '▤'], ['account', 'Mon compte', '◔']],
  BALISE: [['gps', 'Cellule Balise', '⊕'], ['wait_gps', 'En attente Balise', '◷'], ['dispenses', 'Dispenses', '⚑'], ['search', 'Recherche (en cours)', '⌕'], ['list', 'Cargaisons', '▤'], ['baliserep', 'Rapport Balise', '∑'], ['account', 'Mon compte', '◔']],
  BON_SORTIE: [['bonsortie', 'Cellule Bon de Sortie', '▣'], ['wait_bs', 'En attente Bon de Sortie', '◷'], ['search', 'Recherche (en cours)', '⌕'], ['list', 'Cargaisons', '▤'], ['account', 'Mon compte', '◔']],
  PP: [['sortie', 'Sortie (checklist)', '⇲'], ['wait_sortie', 'En attente sortie', '◷'], ['conteneurs', 'Opérations sur conteneurs', '▦'], ['search', 'Recherche (en cours)', '⌕'], ['vehicules', 'Véhicules', '🚗'], ['list', 'Cargaisons', '▤'], ['pprep', 'Rapport PP', '∑'], ['destinations', 'Par destination', '⇄'], ['account', 'Mon compte', '◔']],
  ADMIN: [
    ['dash', 'Tableau de bord', '▦'], ['creercamion', 'Créer un camion', '＋'], ['completer', 'Saisir / compléter', '✎'], ['wait_valid', 'À valider', '✔'], ['conso', 'Conso (type C)', '＋'], ['search', 'Recherche (en cours)', '⌕'], ['list', 'Cargaisons', '▤'], ['vehicules', 'Véhicules', '🚗'],
    ['conteneurs', 'Opérations sur conteneurs', '▦'], ['mad', 'Magasin / MAD', '▥'], ['entrepindus', 'Entrepôt industriel', '🏭'], ['etatcfs', 'Pointage camions (sortie)', '◨'], ['chargement', 'Bon de chargement', '▤'],
    ['kpi', 'KPI / EVP', '◫'], ['cfsreport', 'Rapport CFS', '∑'], ['vehreport', 'Rapport véhicules', '∑'], ['baliserep', 'Rapport Balise', '∑'], ['pprep', 'Rapport PP', '∑'], ['dispenses', 'Dispenses', '⚑'],
    ['flux', 'Analyse des flux', '⇄'], ['destinations', 'Par destination', '⇄'], ['controles', 'Contrôles (gabarit/surcharge)', '⚖'], ['dwell', 'Délai & instance', '⏱'], ['stockdwell', 'Séjour conteneurs', '⏱'], ['history', 'Historique', '◵'], ['users', 'Utilisateurs', '◑'], ['account', 'Mon compte', '◔'],
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
  vehicules: 'Véhicules', stock: 'Stock conteneurs', pointage: 'Pointage matinal', import: 'Stock initial — import',
  magasin: 'Entrée Magasin / MAD', importannonce: 'Annonce de transfert — import', annonce: 'Stock annoncé',
  pointentree: 'Pointage entrée (stock annoncé)', confentree: "Confirmer l'entrée au stock (annoncé)",
  kpi: 'KPI / EVP', dispenses: 'Suivi des dispenses', stockdwell: 'Séjour & instances conteneurs',
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

/**
 * v4.1 — Graphique SVG autonome (aucune dépendance, CSP-safe) : barres groupées
 * ou lignes. `cats` = étiquettes de l'axe X (périodes) ; `series` = séries à
 * tracer, chacune alignée sur `cats`. Axe Y = valeurs, gradations automatiques.
 */
const PALETTE = ['#0e5a8a', '#1f7a5c', '#a5670f', '#8a2be2', '#b03060', '#0a6a8a', '#5a7a1f', '#5c6b7a'];
export function Graphique({ cats, series, type = 'barres', hauteur = 260, ordonnee = 'Nombre' }: {
  cats: string[]; series: { nom: string; valeurs: number[] }[]; type?: 'barres' | 'lignes'; hauteur?: number; ordonnee?: string;
}) {
  if (!cats.length || !series.length) return <div className="empty">Pas de données à tracer sur la période.</div>;
  const W = 720, H = hauteur, mL = 44, mR = 12, mT = 12, mB = 46;
  const iw = W - mL - mR, ih = H - mT - mB;
  const maxV = Math.max(1, ...series.flatMap((s) => s.valeurs));
  // Graduations Y « rondes ».
  const pas = Math.max(1, Math.ceil(maxV / 4));
  const hautMax = pas * 4;
  const y = (v: number) => mT + ih - (v / hautMax) * ih;
  const x = (i: number) => mL + (iw / cats.length) * (i + 0.5);
  const ticks = [0, 1, 2, 3, 4].map((k) => k * pas);
  return <div style={{ overflowX: 'auto' }}>
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ minWidth: 320, maxWidth: 760, display: 'block' }} role="img">
      {/* grille + axe Y */}
      {ticks.map((t) => <g key={t}>
        <line x1={mL} y1={y(t)} x2={W - mR} y2={y(t)} stroke="var(--line)" strokeWidth={1} />
        <text x={mL - 6} y={y(t) + 4} textAnchor="end" fontSize={11} fill="var(--muted)">{t}</text>
      </g>)}
      <text x={12} y={mT + ih / 2} fontSize={11} fill="var(--muted)" transform={`rotate(-90 12 ${mT + ih / 2})`} textAnchor="middle">{ordonnee}</text>
      {/* étiquettes X */}
      {cats.map((c, i) => <text key={i} x={x(i)} y={H - mB + 16} textAnchor="middle" fontSize={10} fill="var(--muted)">{c}</text>)}
      {/* données */}
      {type === 'lignes'
        ? series.map((s, si) => <polyline key={si} fill="none" stroke={PALETTE[si % PALETTE.length]} strokeWidth={2}
            points={s.valeurs.map((v, i) => `${x(i)},${y(v)}`).join(' ')} />)
        : series.map((s, si) => {
            const bw = (iw / cats.length) * 0.8 / series.length;
            return s.valeurs.map((v, i) => {
              const bx = x(i) - (iw / cats.length) * 0.4 + si * bw;
              return <rect key={`${si}-${i}`} x={bx} y={y(v)} width={Math.max(1, bw - 1)} height={mT + ih - y(v)} fill={PALETTE[si % PALETTE.length]} />;
            });
          })}
    </svg>
    <div className="row" style={{ flexWrap: 'wrap', gap: 12, marginTop: 6, justifyContent: 'center' }}>
      {series.map((s, si) => <span key={si} className="help" style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
        <span style={{ width: 11, height: 11, borderRadius: 2, background: PALETTE[si % PALETTE.length], display: 'inline-block' }} />{s.nom}</span>)}
    </div>
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
