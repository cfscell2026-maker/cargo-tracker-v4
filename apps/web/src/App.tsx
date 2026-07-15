/**
 * Coquille applicative : authentification (mot de passe + 2FA TOTP obligatoire),
 * menu par rôle (MENUS v3.6) et routeur d'écrans.
 */
import { useCallback, useEffect, useState } from 'react';
import './styles.css';
import { supabase } from './lib/supabase.ts';
import { call } from './lib/rpc.ts';
import { MENUS, TITLES, roleLabel, ToastHost, toast, Spinner } from './lib/ui.tsx';
import { SCREENS } from './screens.tsx';

export interface User { username: string; nomComplet: string; role: string }
export interface Nav { user: User; go: (screen: string, arg?: unknown) => void; screen: string; arg: unknown }

type Phase = 'loading' | 'login' | 'enroll' | 'verify' | 'app';
const emailDe = (u: string) => (u.includes('@') ? u : `${u.toLowerCase()}@agents.cargo-pia.local`);

export function App() {
  const [phase, setPhase] = useState<Phase>('loading');
  const [user, setUser] = useState<User | null>(null);
  const [screen, setScreen] = useState('dash');
  const [arg, setArg] = useState<unknown>(null);
  const [sideOpen, setSideOpen] = useState(false);

  const go = useCallback((s: string, a?: unknown) => { setScreen(s); setArg(a ?? null); setSideOpen(false); }, []);

  const entrerApp = useCallback(async () => {
    const u = await call<User>('account.me');
    setUser(u); setScreen('dash'); setPhase('app');
  }, []);

  const evaluerSession = useCallback(async () => {
    const { data } = await supabase.auth.getSession();
    if (!data.session) { setPhase('login'); return; }
    const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    if (aal?.currentLevel === 'aal2') { await entrerApp(); return; }
    const { data: f } = await supabase.auth.mfa.listFactors();
    setPhase(f?.totp?.length ? 'verify' : 'enroll');
  }, [entrerApp]);

  useEffect(() => {
    evaluerSession();
    const retour = () => { setPhase('login'); setUser(null); };
    window.addEventListener('cargo:auth-requise', retour);
    return () => window.removeEventListener('cargo:auth-requise', retour);
  }, [evaluerSession]);

  if (phase === 'loading') return <div style={{ marginTop: '20vh' }}><Spinner /></div>;
  if (phase !== 'app' || !user) return <AuthGate phase={phase} setPhase={setPhase} onReady={evaluerSession} onApp={entrerApp} />;

  const menu = MENUS[user.role] ?? [];
  const nav: Nav = { user, go, screen, arg };
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
        <div className="content"><Screen {...nav} /></div>
      </div>
      <ToastHost />
    </div>
  );
}

/* ----------------------------- Authentification ------------------------ */
function AuthGate({ phase, setPhase, onReady, onApp }: { phase: Phase; setPhase: (p: Phase) => void; onReady: () => void; onApp: () => void }) {
  const [id, setId] = useState('');
  const [pwd, setPwd] = useState('');
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
        {err && <p className="err-msg">{err}</p>}
      </div>
      {phase !== 'login' && <button className="ghost" onClick={async () => { await supabase.auth.signOut(); setPhase('login'); }}>Retour à la connexion</button>}
    </main>
  );
}
