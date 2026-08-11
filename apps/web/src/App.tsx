/**
 * Coquille applicative : authentification (mot de passe + 2FA TOTP obligatoire),
 * menu par rôle (MENUS v3.6) et routeur d'écrans.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import './styles.css';
import { supabase } from './lib/supabase.ts';
import { call } from './lib/rpc.ts';
import { MENUS, TITLES, roleLabel, ToastHost, toast, Spinner } from './lib/ui.tsx';
import { empiler, vueInitiale, vueCourante, ecranPrecedentDe, allerA, type EtatNav } from './lib/navigation.ts';
import { SCREENS } from './screens.tsx';

export interface User { username: string; nomComplet: string; role: string }
export interface Nav {
  user: User;
  go: (screen: string, arg?: unknown) => void;
  screen: string;
  arg: unknown;
  /** Revient à l'écran précédent (pile de navigation), pas à un écran fixe. */
  retour: () => void;
  /** Écran vers lequel « Retour » ramènerait, ou null si on est à la racine. */
  ecranPrecedent: string | null;
}


type Phase = 'loading' | 'login' | 'enroll' | 'verify' | 'motdepasse' | 'app';
const emailDe = (u: string) => (u.includes('@') ? u : `${u.toLowerCase()}@agents.cargo-pia.local`);

/**
 * SEC-02 — INTERRUPTEUR 2FA.
 *
 * C'était une constante EN DUR à `false` : la double authentification ne pouvait
 * pas être réactivée sans reconstruire et redéployer le front, et rien ne le
 * signalait à l'exploitant. Elle est désormais lue dans l'environnement de
 * build, ACTIVE par défaut, et doit rester cohérente avec `MFA_REQUISE` côté
 * Edge Function (supabase/functions/rpc/supa.ts) : les deux se déploient
 * ensemble. Mettre `VITE_MFA_REQUISE=false` est une décision explicite, écrite
 * dans la configuration Netlify — donc visible et réversible.
 */
const MFA_REQUISE = String(import.meta.env.VITE_MFA_REQUISE ?? 'true').toLowerCase() !== 'false';

export function App() {
  const [phase, setPhase] = useState<Phase>('loading');
  const [user, setUser] = useState<User | null>(null);
  // Historique de navigation (logique pure dans lib/navigation).
  const [nav, setNav] = useState<EtatNav>(vueInitiale);
  const [sideOpen, setSideOpen] = useState(false);
  const { screen, arg } = vueCourante(nav);

  /**
   * Miroir synchrone de `nav` : `go`/`retour` doivent connaître l'état COURANT
   * pour piloter l'historique du navigateur dans le même tour, alors que
   * `setNav` est asynchrone.
   */
  const navRef = useRef(nav);
  const majNav = useCallback((etat: EtatNav) => { navRef.current = etat; setNav(etat); }, []);

  /**
   * Chaque vue de l'appli = une entrée d'historique du navigateur, portant son
   * index. Le bouton Retour du téléphone devient donc le retour de l'appli au
   * lieu de faire quitter l'application.
   */
  const go = useCallback((s: string, a?: unknown) => {
    const apres = empiler(navRef.current, s, a);
    setSideOpen(false);
    if (apres === navRef.current) return; // même vue : ni entrée, ni rendu
    majNav(apres);
    window.history.pushState({ indexNav: apres.index }, '');
  }, [majNav]);

  /**
   * Retour de l'appli : on délègue au navigateur (`history.back()`) et c'est
   * `popstate` qui déplace le curseur. Une seule voie de retour, donc pas de
   * désynchronisation entre notre historique et celui du navigateur.
   */
  const retour = useCallback(() => {
    setSideOpen(false);
    if (navRef.current.index > 0) window.history.back();
  }, []);

  // Retour / Suivant du navigateur (et du téléphone) : l'entrée atteinte porte
  // son index, on s'y aligne. Sans état (entrée étrangère), on revient au début.
  useEffect(() => {
    window.history.replaceState({ indexNav: navRef.current.index }, '');
    const surPop = (e: PopStateEvent) => {
      const cible = typeof (e.state as { indexNav?: unknown } | null)?.indexNav === 'number'
        ? (e.state as { indexNav: number }).indexNav : 0;
      majNav(allerA(navRef.current, cible));
      setSideOpen(false);
    };
    window.addEventListener('popstate', surPop);
    return () => window.removeEventListener('popstate', surPop);
  }, [majNav]);

  const entrerApp = useCallback(async () => {
    const u = await call<User & { motDePasseAChanger?: boolean }>('account.me');
    // SEC-03 — Tant que l'agent n'a pas remplacé le mot de passe qui lui a été
    // ATTRIBUÉ (création de compte ou réinitialisation par un ADMIN), il n'entre
    // pas dans l'application : ce mot de passe est connu de l'administrateur,
    // il n'engage pas encore son porteur. Le serveur applique la même règle et
    // refuse toute autre action (voir index.ts) — l'écran n'est pas contournable
    // en appelant l'API directement.
    if (u.motDePasseAChanger) { setUser(u); setPhase('motdepasse'); return; }

    // SEC-05 — Trace de connexion : la v4 n'en enregistrait plus aucune.
    // Best-effort, une trace manquante ne doit pas empêcher de travailler.
    call('account.signin').catch(() => {});

    // Nouvelle session = historique repartant de zéro (on ne remonte pas dans
    // la navigation de l'utilisateur précédent). L'écran d'accueil = 1er onglet
    // du rôle : les agents qui n'ont plus le tableau de bord n'atterrissent pas
    // sur un écran absent de leur menu (v4.1).
    const accueil = MENUS[u.role]?.[0]?.[0] ?? 'dash';
    const depart = vueInitiale(accueil);
    setUser(u); majNav(depart); setPhase('app');
    window.history.replaceState({ indexNav: 0 }, '');
  }, [majNav]);

  const evaluerSession = useCallback(async () => {
    const { data } = await supabase.auth.getSession();
    if (!data.session) { setPhase('login'); return; }
    // 2FA désactivée (décision explicite) : la session mot de passe suffit.
    if (!MFA_REQUISE) { await entrerApp(); return; }
    const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    if (aal?.currentLevel === 'aal2') { await entrerApp(); return; }
    const { data: f } = await supabase.auth.mfa.listFactors();
    setPhase(f?.totp?.length ? 'verify' : 'enroll');
  }, [entrerApp]);

  useEffect(() => {
    evaluerSession();
    const retour = () => { setPhase('login'); setUser(null); };
    // SEC-03 — une session ouverte AVANT une réinitialisation par l'ADMIN se
    // heurte au refus du serveur en cours de route : on la ramène sur l'écran
    // de changement au lieu de laisser défiler des erreurs.
    const mdp = () => setPhase('motdepasse');
    window.addEventListener('cargo:auth-requise', retour);
    window.addEventListener('cargo:mdp-requis', mdp);
    return () => {
      window.removeEventListener('cargo:auth-requise', retour);
      window.removeEventListener('cargo:mdp-requis', mdp);
    };
  }, [evaluerSession]);

  if (phase === 'loading') return <div style={{ marginTop: '20vh' }}><Spinner /></div>;
  if (phase !== 'app' || !user) return <AuthGate phase={phase} setPhase={setPhase} onReady={evaluerSession} onApp={entrerApp} />;

  const menu = MENUS[user.role] ?? [];
  const navProps: Nav = { user, go, screen, arg, retour, ecranPrecedent: ecranPrecedentDe(nav) };
  const Screen = (SCREENS[screen] ?? SCREENS.dash)!;

  return (
    <div className="shell">
      <aside className={`side ${sideOpen ? 'open' : ''}`}>
        <div className="brand">Suivi des Cargaisons</div>
        {menu.map((m) => (
          <a key={m[0]} className={screen === m[0] ? 'active' : ''} onClick={() => go(m[0])}>
            <span className="ic">{m[2]}</span>{m[1]}
          </a>
        ))}
        <a onClick={async () => { await supabase.auth.signOut(); setPhase('login'); setUser(null); }}>
          <span className="ic">⎋</span>Déconnexion
        </a>
      </aside>
      <div className="main">
        <div className="top">
          <button className="burger" onClick={() => setSideOpen((v) => !v)}>☰</button>
          <h1>{TITLES[screen] ?? ''}</h1>
          <div className="who"><b>{user.nomComplet}</b><span className="role">{roleLabel(user.role)}</span></div>
        </div>
        <div className="content"><Screen {...navProps} /></div>
      </div>
      <ToastHost />
    </div>
  );
}

/* ----------------------------- Authentification ------------------------ */
function AuthGate({ phase, setPhase, onReady, onApp }: { phase: Phase; setPhase: (p: Phase) => void; onReady: () => void; onApp: () => void }) {
  const [id, setId] = useState('');
  const [pwd, setPwd] = useState('');
  const [nouveau, setNouveau] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [code, setCode] = useState('');
  const [qr, setQr] = useState('');
  const [factorId, setFactorId] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  async function login(e: React.FormEvent) {
    e.preventDefault(); setErr(''); setBusy(true);
    try {
      const { error } = await supabase.auth.signInWithPassword({ email: emailDe(id), password: pwd });
      if (error) throw new Error('Identifiant ou mot de passe incorrect.');
      await onReady();
    } catch (x) { setErr((x as Error).message); } finally { setBusy(false); }
  }

  async function demarrerEnrol() {
    setErr('');
    const { data, error } = await supabase.auth.mfa.enroll({ factorType: 'totp' });
    if (error || !data) { setErr("Impossible de démarrer l'enrôlement 2FA."); return; }
    setFactorId(data.id); setQr(data.totp.qr_code);
  }
  useEffect(() => { if (phase === 'enroll' && !qr) demarrerEnrol(); }, [phase, qr]);

  /**
   * SEC-03 — Changement imposé du mot de passe attribué.
   * L'ancien mot de passe est redemandé : c'est ce qui distingue « l'agent
   * change son mot de passe » de « quelqu'un qui a récupéré une session ouverte
   * s'en approprie le compte ».
   */
  async function changerMotDePasse(e: React.FormEvent) {
    e.preventDefault(); setErr(''); setBusy(true);
    try {
      if (nouveau !== confirmation) throw new Error('Les deux saisies ne correspondent pas.');
      await call('account.changepwd', { ancien: pwd, nouveau });
      toast('Mot de passe modifié. Conservez-le, il n\'est plus connu de personne d\'autre.', 'ok');
      setPwd(''); setNouveau(''); setConfirmation('');
      await onApp();
    } catch (x) { setErr((x as Error).message); } finally { setBusy(false); }
  }

  async function verifier(e: React.FormEvent) {
    e.preventDefault(); setErr(''); setBusy(true);
    try {
      let fid = factorId;
      if (phase === 'verify') {
        const { data: f } = await supabase.auth.mfa.listFactors();
        fid = f?.totp?.[0]?.id ?? '';
        if (!fid) throw new Error("Aucun 2FA enrôlé. Contactez l'administrateur.");
      }
      const { data: ch, error: e1 } = await supabase.auth.mfa.challenge({ factorId: fid });
      if (e1 || !ch) throw new Error('Vérification impossible. Réessayez.');
      const { error: e2 } = await supabase.auth.mfa.verify({ factorId: fid, challengeId: ch.id, code });
      if (e2) throw new Error('Code incorrect. Réessayez.');
      toast('Connexion sécurisée validée.', 'ok');
      await onApp();
    } catch (x) { setErr((x as Error).message); } finally { setBusy(false); }
  }

  return (
    <main style={{ maxWidth: 400, margin: '9vh auto', padding: 24 }}>
      <h1 style={{ fontSize: 22 }}>Suivi des Cargaisons</h1>
      <p style={{ color: '#5c6b7a' }}>PIA Dry Port — Adétikopé. Accès réservé aux agents autorisés.</p>
      <div className="card">
        {phase === 'login' && (
          <form onSubmit={login} style={{ display: 'grid', gap: 10 }}>
            <div><label className="help">Identifiant</label><input value={id} onChange={(e) => setId(e.target.value)} autoComplete="username" required /></div>
            <div><label className="help">Mot de passe</label><input type="password" value={pwd} onChange={(e) => setPwd(e.target.value)} autoComplete="current-password" required /></div>
            <button disabled={busy}>{busy ? 'Connexion…' : 'Se connecter'}</button>
          </form>
        )}
        {phase === 'enroll' && (
          <form onSubmit={verifier} style={{ display: 'grid', gap: 10 }}>
            <p style={{ margin: 0 }}>Première connexion : scannez ce QR code avec votre application d'authentification (Google Authenticator, etc.), puis saisissez le code.</p>
            {qr ? <img src={qr} alt="QR code 2FA" style={{ width: 180, margin: '4px auto', background: '#fff' }} /> : <Spinner />}
            <input inputMode="numeric" pattern="[0-9]{6}" maxLength={6} placeholder="Code à 6 chiffres" value={code} onChange={(e) => setCode(e.target.value)} required />
            <button disabled={busy}>{busy ? 'Vérification…' : 'Activer et se connecter'}</button>
          </form>
        )}
        {phase === 'verify' && (
          <form onSubmit={verifier} style={{ display: 'grid', gap: 10 }}>
            <label className="help">Code de votre application d'authentification</label>
            <input inputMode="numeric" pattern="[0-9]{6}" maxLength={6} placeholder="123456" value={code} onChange={(e) => setCode(e.target.value)} required />
            <button disabled={busy}>{busy ? 'Vérification…' : 'Valider'}</button>
          </form>
        )}
        {phase === 'motdepasse' && (
          <form onSubmit={changerMotDePasse} style={{ display: 'grid', gap: 10 }}>
            <p style={{ margin: 0 }}>
              <b>Changement de mot de passe obligatoire.</b><br />
              Le mot de passe qui vous a été remis est connu de l'administrateur.
              Choisissez-en un que vous seul connaissez : c'est lui qui engagera
              vos saisies.
            </p>
            <div><label className="help">Mot de passe actuel (celui qui vous a été remis)</label>
              <input type="password" value={pwd} onChange={(e) => setPwd(e.target.value)} autoComplete="current-password" required /></div>
            <div><label className="help">Nouveau mot de passe — 12 caractères minimum</label>
              <input type="password" value={nouveau} onChange={(e) => setNouveau(e.target.value)} autoComplete="new-password" minLength={12} required /></div>
            <div><label className="help">Confirmez le nouveau mot de passe</label>
              <input type="password" value={confirmation} onChange={(e) => setConfirmation(e.target.value)} autoComplete="new-password" minLength={12} required /></div>
            <p className="help" style={{ margin: 0 }}>
              Mélangez au moins trois familles de caractères (minuscules, majuscules,
              chiffres, signes). Une phrase longue est plus sûre et plus facile à retenir.
            </p>
            <button disabled={busy}>{busy ? 'Enregistrement…' : 'Changer et continuer'}</button>
          </form>
        )}
        {err && <p className="err-msg">{err}</p>}
      </div>
      {phase !== 'login' && <button className="ghost" onClick={async () => { await supabase.auth.signOut(); setPhase('login'); }}>Retour à la connexion</button>}
    </main>
  );
}
