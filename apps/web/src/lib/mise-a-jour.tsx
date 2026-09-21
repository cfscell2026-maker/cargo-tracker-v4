/**
 * ============================================================================
 *  MISE À JOUR DE L'APPLICATION (2026-09-21, demande utilisateur)
 *
 *  Sur téléphone, le navigateur ROUVRE l'onglet depuis sa mémoire au lieu de
 *  recharger la page : l'agent peut travailler des jours sur une version
 *  dépassée sans le savoir. Deux remèdes :
 *
 *  1. Chaque construction dépose `/version.json` (voir vite.config.ts), servi
 *     sans cache (netlify.toml). L'application le relit au démarrage, toutes les
 *     5 minutes et À CHAQUE RETOUR AU PREMIER PLAN — le cas du téléphone qu'on
 *     ressort de la poche. Si la version diffère : bandeau « Mettre à jour ».
 *  2. Un bouton permanent « Mettre à jour l'application » (menu latéral) force
 *     le rechargement, même si aucune nouvelle version n'a été détectée.
 * ============================================================================
 */
import { useEffect, useState } from 'react';
import { Icone } from './icones.tsx';

/** Version de CE code, figée à la construction (vide en développement). */
export const VERSION_APP: string = String(import.meta.env['VITE_VERSION_APP'] ?? '');

const PARAM = 'maj';

/** Version publiée sur le serveur, ou '' si elle est illisible (hors ligne, dev…). */
export async function versionPubliee(): Promise<string> {
  try {
    const r = await fetch(`/version.json?t=${Date.now()}`, { cache: 'no-store' });
    if (!r.ok) return '';
    const j = (await r.json()) as { version?: unknown };
    return typeof j.version === 'string' ? j.version : '';
  } catch {
    return '';
  }
}

/**
 * Recharge l'application en contournant tout ce qui pourrait servir l'ancienne :
 * caches du navigateur, éventuel service worker, et page en mémoire (l'adresse
 * reçoit un paramètre unique, retiré dès le chargement suivant).
 */
export async function rechargerApplication(): Promise<void> {
  try {
    if ('serviceWorker' in navigator)
      for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister();
  } catch { /* rien à désinscrire */ }
  try {
    if ('caches' in window) for (const k of await caches.keys()) await caches.delete(k);
  } catch { /* pas de cache applicatif */ }
  const u = new URL(window.location.href);
  u.searchParams.set(PARAM, Date.now().toString(36));
  window.location.replace(u.toString());
}

/** Retire le paramètre posé par `rechargerApplication` : l'adresse reste propre. */
export function nettoyerAdresse(): void {
  const u = new URL(window.location.href);
  if (!u.searchParams.has(PARAM)) return;
  u.searchParams.delete(PARAM);
  window.history.replaceState(window.history.state, '', u.pathname + u.search + u.hash);
}

/** true dès qu'une version plus récente que celle-ci est publiée. */
export function useNouvelleVersion(): boolean {
  const [nouvelle, setNouvelle] = useState(false);
  useEffect(() => {
    if (!VERSION_APP) return; // développement : pas de version à comparer
    let fini = false;
    const verifier = async () => {
      const v = await versionPubliee();
      if (!fini && v && v !== VERSION_APP) setNouvelle(true);
    };
    const auPremierPlan = () => { if (document.visibilityState === 'visible') void verifier(); };
    void verifier();
    const t = window.setInterval(verifier, 5 * 60 * 1000);
    document.addEventListener('visibilitychange', auPremierPlan);
    window.addEventListener('focus', auPremierPlan);
    return () => {
      fini = true;
      window.clearInterval(t);
      document.removeEventListener('visibilitychange', auPremierPlan);
      window.removeEventListener('focus', auPremierPlan);
    };
  }, []);
  return nouvelle;
}

/** Bouton permanent : recharge l'application à la demande. */
export function BoutonMiseAJour({ className }: { className?: string }) {
  const [enCours, setEnCours] = useState(false);
  return <button type="button" className={className} disabled={enCours}
    title={VERSION_APP ? `Version installée : ${versionLisible(VERSION_APP)}` : undefined}
    onClick={() => { setEnCours(true); void rechargerApplication(); }}>
    <Icone nom="miseAJour" />{enCours ? 'Mise à jour…' : 'Mettre à jour'}
  </button>;
}

/** Bandeau affiché seulement quand une nouvelle version attend. */
export function BandeauMiseAJour() {
  const nouvelle = useNouvelleVersion();
  const [enCours, setEnCours] = useState(false);
  if (!nouvelle) return null;
  return <div className="maj-bandeau" role="status">
    <Icone nom="miseAJour" />
    <span>Une nouvelle version de l'application est disponible.</span>
    <button type="button" disabled={enCours} onClick={() => { setEnCours(true); void rechargerApplication(); }}>
      {enCours ? 'Mise à jour…' : 'Mettre à jour'}
    </button>
  </div>;
}

/** « 2026-09-21T14:05:12.000Z » → « 21/09/2026 14:05 » (heure locale). */
export function versionLisible(v: string): string {
  const d = new Date(v);
  if (isNaN(d.getTime())) return v;
  const z = (n: number) => String(n).padStart(2, '0');
  return `${z(d.getDate())}/${z(d.getMonth() + 1)}/${d.getFullYear()} ${z(d.getHours())}:${z(d.getMinutes())}`;
}
