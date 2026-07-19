/**
 * Primitives d'interface + libellés/menus (reproduction de Client.html v3.6 :
 * MENUS, TITLES, roleLabel, statutLabel/tag, masques de saisie).
 */
import { useEffect, useState, type ReactNode } from 'react';
import { ROLE_LABELS, STATUTS } from '../../../../supabase/functions/_shared/domaine/src/index.ts';

export type MenuItem = [string, string, string];

export const MENUS: Record<string, MenuItem[]> = {
  CFS: [
    ['dash', 'Tableau de bord', '▦'], ['creercamion', 'Créer un camion', '＋'], ['completer', 'Saisir / compléter', '✎'],
    ['new', 'Nouveau (Véhic./Conso/MAD)', '＋'], ['search', 'Recherche (en cours)', '⌕'], ['list', 'Cargaisons', '▤'], ['vehicules', 'Véhicules', '🚗'],
    ['etatcfs', 'Pointage camions (sortie)', '◨'], ['chargement', 'Bon de chargement', '▤'], ['confentree', 'Confirmer entrée (annoncé)', '✔'], ['stockjour', 'Stock CFS journalier', '◧'],
    ['stock', 'Stock conteneurs', '▦'], ['pointage', 'Pointage matinal', '◉'], ['import', 'Stock initial (import)', '⮉'], ['annonce', 'Stock annoncé', '⮈'], ['magasin', 'Entrée Magasin/MAD', '▥'],
    ['cfsreport', 'Rapport CFS', '∑'], ['vehreport', 'Rapport véhicules', '∑'], ['kpi', 'KPI / EVP', '◫'], ['dwell', 'Camions en instance', '⏱'], ['stockdwell', 'Séjour conteneurs', '⏱'], ['account', 'Mon compte', '◔'],
  ],
  // v4 — le chef brigade lit TOUS les rapports de TOUTES les cellules (lecture seule).
  CHEF_BRIGADE: [
    ['dash', 'Tableau de bord', '▦'], ['wait_valid', 'À valider', '✔'], ['search', 'Recherche (en cours)', '⌕'], ['list', 'Cargaisons', '▤'], ['vehicules', 'Véhicules', '🚗'],
    ['etatcfs', 'Pointage camions (sortie)', '◨'], ['chargement', 'Bon de chargement', '▤'],
    ['kpi', 'KPI / EVP', '◫'], ['cfsreport', 'Rapport CFS', '∑'], ['vehreport', 'Rapport véhicules', '∑'], ['baliserep', 'Rapport Balise', '∑'], ['pprep', 'Rapport PP', '∑'], ['dispenses', 'Dispenses', '⚑'],
    ['flux', 'Analyse des flux', '⇄'], ['dwell', 'Délai & instance', '⏱'], ['stockdwell', 'Séjour conteneurs', '⏱'], ['account', 'Mon compte', '◔'],
  ],
  CHEF_BRIGADE_ADJOINT: [['dash', 'Tableau de bord', '▦'], ['search', 'Recherche (en cours)', '⌕'], ['list', 'Cargaisons', '▤'], ['vehicules', 'Véhicules', '🚗'], ['kpi', 'KPI / EVP', '◫'], ['account', 'Mon compte', '◔']],
  CHEF_VISITE: [['dash', 'Tableau de bord', '▦'], ['search', 'Recherche (en cours)', '⌕'], ['list', 'Cargaisons', '▤'], ['vehicules', 'Véhicules', '🚗'], ['kpi', 'KPI / EVP', '◫'], ['account', 'Mon compte', '◔']],
  CHEF_DIVISION: [['dash', 'Tableau de bord', '▦'], ['search', 'Recherche (en cours)', '⌕'], ['list', 'Cargaisons', '▤'], ['vehicules', 'Véhicules', '🚗'], ['kpi', 'KPI / EVP', '◫'], ['account', 'Mon compte', '◔']],
  T1: [['dash', 'Tableau de bord', '▦'], ['t1', 'Cellule T1', '①'], ['wait_t1', 'En attente T1', '◷'], ['search', 'Recherche (en cours)', '⌕'], ['list', 'Cargaisons', '▤'], ['account', 'Mon compte', '◔']],
  BALISE: [['dash', 'Tableau de bord', '▦'], ['gps', 'Cellule Balise', '⊕'], ['wait_gps', 'En attente Balise', '◷'], ['dispenses', 'Dispenses', '⚑'], ['search', 'Recherche (en cours)', '⌕'], ['list', 'Cargaisons', '▤'], ['baliserep', 'Rapport Balise', '∑'], ['account', 'Mon compte', '◔']],
  BON_SORTIE: [['dash', 'Tableau de bord', '▦'], ['bonsortie', 'Cellule Bon de Sortie', '▣'], ['wait_bs', 'En attente Bon de Sortie', '◷'], ['search', 'Recherche (en cours)', '⌕'], ['list', 'Cargaisons', '▤'], ['account', 'Mon compte', '◔']],
  PP: [['dash', 'Tableau de bord', '▦'], ['pointentree', 'Pointage entrée (annoncé)', '◉'], ['confentree', 'Confirmer entrée (port sec)', '✔'], ['annonce', 'Stock annoncé', '⮈'], ['sortie', 'Sortie (checklist)', '⇲'], ['wait_sortie', 'En attente sortie', '◷'], ['search', 'Recherche (en cours)', '⌕'], ['vehicules', 'Véhicules', '🚗'], ['list', 'Cargaisons', '▤'], ['pprep', 'Rapport PP', '∑'], ['account', 'Mon compte', '◔']],
  ADMIN: [
    ['dash', 'Tableau de bord', '▦'], ['creercamion', 'Créer un camion', '＋'], ['completer', 'Saisir / compléter', '✎'], ['wait_valid', 'À valider', '✔'], ['new', 'Nouveau (Véhic./Conso/MAD)', '＋'], ['search', 'Recherche (en cours)', '⌕'], ['list', 'Cargaisons', '▤'], ['vehicules', 'Véhicules', '🚗'],
    ['stock', 'Stock conteneurs', '▦'], ['pointage', 'Pointage matinal', '◉'], ['import', 'Stock initial (import)', '⮉'], ['importannonce', 'Annonce de transfert', '⮈'], ['annonce', 'Stock annoncé', '▦'], ['pointentree', 'Pointage entrée', '◉'], ['confentree', 'Confirmer entrée', '✔'], ['etatcfs', 'Pointage camions (sortie)', '◨'], ['chargement', 'Bon de chargement', '▤'], ['magasin', 'Entrée Magasin/MAD', '▥'],
    ['kpi', 'KPI / EVP', '◫'], ['cfsreport', 'Rapport CFS', '∑'], ['vehreport', 'Rapport véhicules', '∑'], ['baliserep', 'Rapport Balise', '∑'], ['pprep', 'Rapport PP', '∑'], ['dispenses', 'Dispenses', '⚑'],
    ['flux', 'Analyse des flux', '⇄'], ['dwell', 'Délai & instance', '⏱'], ['stockdwell', 'Séjour conteneurs', '⏱'], ['history', 'Historique', '◵'], ['users', 'Utilisateurs', '◑'], ['account', 'Mon compte', '◔'],
  ],
};

export const TITLES: Record<string, string> = {
  dash: 'Tableau de bord', new: 'Nouveau rapport', list: 'Cargaisons', search: 'Recherche — cargaisons en cours',
  creercamion: 'Créer un camion (entrée)',
  completer: 'Saisir / compléter les camions', stockjour: 'Stock CFS journalier',
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
export const isoDate = (d: Date) => d.toISOString().slice(0, 10);
