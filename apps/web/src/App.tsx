/**
 * Coquille applicative : authentification (mot de passe + 2FA TOTP obligatoire),
 * menu par rôle (MENUS v3.6) et routeur d'écrans.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import './styles.css';
import { supabase } from './lib/supabase.ts';
import { call } from './lib/rpc.ts';
import { MENUS, TITLES, menuSections, roleLabel, ToastHost, toast, Spinner } from './lib/ui.tsx';
import { Icone } from './lib/icones.tsx';
import { iconeDeLEcran, raccourcisMobiles } from './lib/menu.ts';
import { heureCourte, salutation } from './lib/heure.ts';
import { empiler, vueInitiale, vueCourante, ecranPrecedentDe, allerA, type EtatNav } from './lib/navigation.ts';
import { SCREENS, BandeauModule } from './screens.tsx';
import { ContexteNav } from './lib/contexte-nav.ts';
import { BandeauMiseAJour, BoutonMiseAJour, nettoyerAdresse } from './lib/mise-a-jour.tsx';

// Après un « Mettre à jour », l'adresse porte un paramètre unique : on le retire.
nettoyerAdresse();

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

  // Deux blocs de menu, issus du SEUL menu du rôle (aucun droit ajouté).
  const { general, navigation } = menuSections(user.role);
  const navProps: Nav = { user, go, screen, arg, retour, ecranPrecedent: ecranPrecedentDe(nav) };
  const Screen = (SCREENS[screen] ?? SCREENS.dash)!;

  return (
    <div className="shell">
      <aside className={`side ${sideOpen ? 'open' : ''}`}>
        {/* Bloc de marque — carte arrondie, logo rond entier (cf. .logo-rond).
            `onError` masque l'image si le fichier manque : le nom reste lisible
            plutôt qu'une icône cassée. */}
        <div className="brand">
          {/* Le logo est enveloppé d'un anneau lumineux en rotation (.logo-halo).
              Le halo reste visible même si l'image manque : c'est le repère
              vivant de l'application, pas une décoration de l'image. */}
          <div className="logo-halo">
            <img className="logo-rond" src="/logo.png" alt="PIA_Suivi_Cargo"
              onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }} />
          </div>
          <div style={{ minWidth: 0 }}>
            <div className="brand-nom">Suivi des cargaisons</div>
            {/* Sigle sous le nom de l'application : « SDC », Suivi Des Cargaisons (2026-09-14). */}
            <div className="brand-sous">SDC</div>
          </div>
        </div>

        {/* Le menu occupe l'espace restant et défile seul : avec 33 entrées
            (ADMIN), la carte du compte doit rester visible en bas.

            DEUX BLOCS (2026-09-10) : le général — vue d'ensemble, administration,
            compte — puis les écrans métier. `menuSections` se contente de
            RÉPARTIR ce que le rôle possède déjà : un rôle sans « Utilisateurs »
            ne le voit pas apparaître pour autant. */}
        <nav className="nav">
          {general.length > 0 && <>
            {general.map((m) => (
              <a key={m[0]} className={screen === m[0] ? 'active' : ''} onClick={() => go(m[0])}>
                <Icone nom={m[2]} />{m[1]}
              </a>
            ))}
            {/* Séparateur : le bloc général se distingue sans qu'il faille l'annoncer. */}
            <div className="nav-sep" />
          </>}

          {navigation.length > 0 && <div className="nav-titre">Suivi des camions</div>}
          {navigation.map((m) => (
            <a key={m[0]} className={screen === m[0] ? 'active' : ''} onClick={() => go(m[0])}>
              <Icone nom={m[2]} />{m[1]}
            </a>
          ))}
        </nav>

        {/* Carte utilisateur ancrée en bas : qui je suis, à quel titre, et la
            sortie. Le rôle sous le nom évite d'avoir à le chercher ailleurs. */}
        <div className="compte">
          <div className="compte-ligne">
            <span className="compte-avatar">{(user.nomComplet || user.username || '?').trim().charAt(0).toUpperCase()}</span>
            <div style={{ minWidth: 0 }}>
              <div className="compte-nom" title={user.nomComplet}>{user.nomComplet}</div>
              <div className="compte-role">{roleLabel(user.role)}</div>
            </div>
          </div>
          {/* Recharge à la demande : pour le téléphone resté sur une ancienne
              version (l'onglet rouvert depuis la mémoire ne recharge rien). */}
          <BoutonMiseAJour />
          <button onClick={async () => { await supabase.auth.signOut(); setPhase('login'); setUser(null); }}>
            <Icone nom="sortie" />Déconnexion
          </button>
        </div>
      </aside>
      <div className="main">
        {/* BARRE SUPÉRIEURE — refonte 2026-09-11.
            L'icône du volet ouvert précède le nom de la plateforme ; le nom du
            volet passe en dessous, en graisse légère. L'icône vient de la MÊME
            table que le menu (`iconeDeLEcran`) : celle de la barre ne peut donc
            pas diverger de celle de la pilule qu'on vient de cliquer. */}
        <div className="top">
          {/* Trois traits nus (2026-09-11) : plus de cadre autour, et plus le
              caractère « ☰ » dont le dessin changeait d'un poste à l'autre —
              c'est une icône de la même famille que les autres. */}
          <button className="burger" onClick={() => setSideOpen((v) => !v)} aria-label="Ouvrir le menu">
            <Icone nom="menu" taille={22} />
          </button>
          <div className="top-titre">
            <span className="top-icone"><Icone nom={iconeDeLEcran(user.role, screen)} taille={20} /></span>
            <div className="top-textes">
              <div className="top-plateforme">Suivi des cargaisons</div>
              <h1 className="top-volet">{TITLES[screen] ?? ''}</h1>
            </div>
          </div>
          <CarteAgent user={user} />
        </div>
        {/* La navigation descend par contexte : le bandeau de module s'en sert
            pour son bouton « Retour », sur une vingtaine d'ecrans, sans qu'il
            faille la passer en propriete a chacun d'eux. */}
        <BandeauMiseAJour />
        <div className="content">
          <ContexteNav.Provider value={navProps}>
            {/* BANDEAU DE SECOURS. Pose pour TOUT ecran, a partir des memes
                tables que le menu et la barre du haut - donc jamais en
                desaccord avec elles. Quand l'ecran fournit le sien, plus
                precis, une regle CSS efface celui-ci : il ne peut y en avoir
                ni zero, ni deux. La fiche d'un camion en est exclue : ce n'est
                pas un volet, elle a son propre en-tete. */}
            {screen !== 'detail' && (
              <BandeauModule auto icone={iconeDeLEcran(user.role, screen)}
                titre={TITLES[screen] ?? ''} sansRetour={screen === 'dash'} />
            )}
            <Screen {...navProps} />
          </ContexteNav.Provider>
        </div>
        {/* BARRE DE NAVIGATION BASSE - telephones, 2026-09-12.
            Sur un ecran etroit, le menu lateral est un tiroir : changer de volet
            demandait deux gestes. Les quatre volets de tete du role sont ici a
            un seul geste, le cinquieme bouton ouvrant le tiroir pour le reste.
            Masquee au-dessus de 820 px, ou la barre laterale est deja visible. */}
        <nav className="nav-mobile" aria-label="Navigation principale">
          {raccourcisMobiles(user.role).map(([id, libelle, icone]) => (
            <button key={id} type="button"
              className={`nm-onglet ${screen === id ? 'actif' : ''}`}
              aria-current={screen === id ? 'page' : undefined}
              onClick={() => { setSideOpen(false); go(id); }}>
              <Icone nom={icone} taille={20} /><span>{libelle}</span>
            </button>
          ))}
          <button type="button" className={`nm-onglet ${sideOpen ? 'actif' : ''}`}
            aria-expanded={sideOpen} onClick={() => setSideOpen((v) => !v)}>
            <Icone nom="menu" taille={20} /><span>Menu</span>
          </button>
        </nav>
      </div>
      <ToastHost />
    </div>
  );
}


/**
 * LE PARC A CONTENEURS - scene du bas de l'ecran de connexion.
 *
 * Refaite le 2026-09-12 : elle montrait une escale de navire, alors que la PIA
 * est un port SEC, a Adetikope, a trente kilometres de la mer. Elle raconte
 * desormais ce qui s'y passe reellement, et ce que l'application enregistre :
 *
 *   1. un camion se presente CHARGE, le portique lui prend son conteneur et le
 *      pose sur le parc ; le camion reparti a vide sort du cadre ;
 *   2. un autre camion se presente A VIDE ; le portique reprend le conteneur
 *      sur le parc et le lui pose dessus ; il sort du cadre, charge.
 *
 * Et ainsi de suite, sans fin. Les deux camions se croisent : le second entre
 * pendant que le premier s'en va.
 *
 * UN SEUL cycle (`--parc-cycle`) commande tout - chariot, palan, conteneurs et
 * camions. C'est lui qui garantit que la grue saisit quand il y a quelque chose
 * a saisir. Les pourcentages sont commentes dans `styles.css`, en face des
 * `@keyframes` : ils se lisent ensemble, pas separement.
 *
 * SVG dessine a la main, aucune image ni bibliotheque : la CSP de
 * `netlify.toml` interdit les ressources tierces. Decoratif de bout en bout,
 * donc `aria-hidden` et insensible a la souris.
 */
function SceneQuai() {
  /* Un camion : la remorque, la cabine, les roues. Dessine a partir de
     l'origine pour que seules les animations decident de sa position ; sa
     charge est un groupe a part, qui apparait ou disparait a la seconde ou la
     grue la prend. */
  const Camion = ({ classe, charge }: { classe: string; charge: string }) => (
    <g className={classe}>
      <g className={charge}>
        <rect x="4" y="94" width="112" height="34" rx="3" fill="#1f7a5c" />
        <path d="M22 96 V126 M42 96 V126 M62 96 V126 M82 96 V126 M102 96 V126"
          stroke="rgba(255,255,255,.34)" strokeWidth="3" />
      </g>
      <rect x="0" y="128" width="150" height="8" rx="2" fill="#44586b" />
      <path d="M118 128 V98 h24 l18 22 v8 z" fill="#32485c" />
      <rect x="124" y="103" width="18" height="12" rx="2" fill="#cfdbe5" />
      <circle cx="28" cy="141" r="9" fill="#2b3b49" />
      <circle cx="58" cy="141" r="9" fill="#2b3b49" />
      <circle cx="136" cy="141" r="9" fill="#2b3b49" />
    </g>
  );
  return (
    <div className="quai" aria-hidden="true">
      <svg viewBox="0 0 1200 190" preserveAspectRatio="xMidYMax meet" width="100%" height="100%">
        {/* Le terre-plein. Il DEBORDE largement du viewBox (x negatif, largeur
            excessive) et c'est voulu : cadree en `meet`, la bande se centre sur
            un large ecran et laisserait sinon deux vides sur les cotes. */}
        <rect x="-900" y="150" width="3000" height="40" fill="#e2e8ee" />
        <rect x="-900" y="150" width="3000" height="4" fill="#c9d5df" />
        <path d="M-900 172 H2100" stroke="#cfdae3" strokeWidth="4" strokeDasharray="26 20" />

        {/* Le parc : deux conteneurs poses la depuis longtemps, et LA place qui
            se vide et se remplit au rythme de la grue. */}
        <rect x="1010" y="118" width="116" height="32" rx="3" fill="#0e5a8a" opacity=".45" />
        <rect x="1010" y="84" width="116" height="32" rx="3" fill="#b4531f" opacity=".45" />
        <g className="parc-pile">
          <rect x="740" y="118" width="112" height="32" rx="3" fill="#b4531f" />
          <path d="M758 120 V148 M778 120 V148 M798 120 V148 M818 120 V148"
            stroke="rgba(255,255,255,.3)" strokeWidth="3" />
        </g>

        {/* Les deux camions, sur la voie qui passe sous le portique. */}
        <Camion classe="parc-camion-a" charge="parc-charge-a" />
        <Camion classe="parc-camion-b" charge="parc-charge-b" />

        {/* LE POSTE D'ENTREE, dessine APRES les camions pour la meme raison :
            ils passent DERRIERE ses piles. Un camion n'arrive pas sur le parc
            par magie - il se presente d'abord ici, la barriere se leve, et
            c'est seulement ensuite qu'il va se ranger sous le portique. */}
        <rect x="146" y="104" width="8" height="46" rx="2" fill="#7c8fa0" />
        <circle className="parc-temoin" cx="150" cy="98" r="4" fill="#d94f2a" />
        <g className="parc-barriere">
          <rect x="149" y="105" width="92" height="9" rx="4.5" fill="#ffffff" stroke="#b4531f" strokeWidth="2" />
          <path d="M163 109.5 h13 M193 109.5 h13 M223 109.5 h13" stroke="#d94f2a" strokeWidth="9" />
        </g>
        <rect x="256" y="56" width="10" height="94" rx="2" fill="#8ea0b0" />
        <rect x="372" y="56" width="10" height="94" rx="2" fill="#8ea0b0" />
        {/* Enseigne « Porte Principale » (2026-09-14, demande utilisateur) : le
            texte est contraint a la largeur du bandeau par `textLength`, pour
            ne jamais deborder quelle que soit la police du poste. */}
        <rect x="246" y="34" width="146" height="22" rx="5" fill="#0e5a8a" />
        <text x="319" y="50" textAnchor="middle" fill="#ffffff"
          fontSize="12.5" fontWeight="700" letterSpacing="0.6"
          textLength="132" lengthAdjust="spacingAndGlyphs">Porte Principale</text>
        {/* La guerite, posee 10 unites au-dessus du sol : ce simple decalage
            suffit a la mettre EN RETRAIT de la voie, sans perspective. */}
        <path d="M392 106 h56 l-7 -11 h-42 z" fill="#8ea0b0" />
        <rect x="396" y="106" width="48" height="34" rx="2" fill="#eef3f7" stroke="#c3d0da" strokeWidth="2" />
        <rect x="404" y="113" width="26" height="16" rx="2" fill="#9fb6c8" />

        {/* LE PORTIQUE, dessine APRES les camions : ils passent DERRIERE ses
            jambes, et cette occultation suffit a poser la profondeur. La
            poutre est haute (y=18) pour laisser passer un conteneur suspendu
            au-dessus d'un plateau de camion - c'est cette cote qui commande
            toutes les hauteurs du palan. */}
        <g stroke="#8ea0b0" strokeWidth="8" fill="none" strokeLinecap="round">
          <path d="M470 150 V18" /><path d="M930 150 V18" />
          <path d="M440 18 H960" />
        </g>

        {/* LE CHARIOT ET SON PALAN. Deux axes separes : une seule propriete
            `transform` ne peut pas porter deux animations. Le mat vertical est
            fixe - c'est le guide le long duquel le spreader coulisse ; il evite
            d'avoir a animer en plus la longueur d'un cable. */}
        <g transform="translate(560,38)">
          <g className="parc-chariot">
            <rect x="-3" y="0" width="6" height="84" fill="#8ea0b0" opacity=".5" />
            <g className="parc-palan">
              <rect x="-20" y="-9" width="40" height="9" rx="2" fill="#6f8496" />
              <g className="parc-colis">
                <rect x="-56" y="0" width="112" height="32" rx="3" fill="#0e5a8a" />
                <path d="M-38 2 V30 M-18 2 V30 M2 2 V30 M22 2 V30 M42 2 V30"
                  stroke="rgba(255,255,255,.34)" strokeWidth="3" />
              </g>
            </g>
            <rect x="-30" y="-18" width="60" height="18" rx="4" fill="#6f8496" />
          </g>
        </g>
      </svg>
    </div>
  );
}


/**
 * CARTE DE L'AGENT, posée à droite de la barre — 2026-09-11.
 *
 * Son avatar, son nom, puis un mot d'accueil suivi de l'heure. Le mot dépend de
 * l'heure : « Bonjour » le matin, « Bonsoir » dès la fin d'après-midi, « Bonne
 * nuit » avant 5 h — le port travaille de nuit, souhaiter « bonjour » à la
 * relève de 3 h sonnerait faux.
 *
 * L'horloge se rafraîchit toutes les 30 s. Pas chaque seconde : l'affichage est
 * à la minute, réveiller React soixante fois par minute pour une valeur qui ne
 * change pas serait du gaspillage pur.
 *
 * Le RÔLE n'y figure pas : il est déjà sous le nom dans la carte de la barre
 * latérale, et le répéter ici encombrerait une bande de 60 pixels.
 */
function CarteAgent({ user }: { user: User }) {
  const [maintenant, setMaintenant] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setMaintenant(new Date()), 30_000);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="carte-agent">
      <span className="agent-avatar"><Icone nom="compte" taille={18} /></span>
      <div className="agent-textes">
        <div className="agent-nom" title={user.nomComplet}>{user.nomComplet}</div>
        <div className="agent-mot">{salutation(maintenant)} · {heureCourte(maintenant)}</div>
      </div>
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

  /**
   * Enrôlement TOTP.
   *
   * `issuer` est FIXÉ ICI, explicitement. Sans lui, Supabase reprend l'URL du
   * site configurée sur le projet — constatée à `localhost:3000` le 2026-09-10,
   * un reliquat de développement. Conséquence : l'application d'authentification
   * de chaque agent affichait « localhost:3000 » au lieu du nom du service.
   * Sur un téléphone qui porte plusieurs comptes TOTP, c'est illisible — et rien
   * n'indique à l'agent qu'il s'agit de l'outil douanier.
   *
   * Le fixer dans le code plutôt que dans la console Supabase rend le libellé
   * indépendant de la configuration du projet : il ne peut plus être cassé par
   * un réglage d'URL fait pour une autre raison.
   */
  async function demarrerEnrol() {
    setErr('');
    /* BLOCAGE DÉFINITIF DE L'ENRÔLEMENT — corrigé le 2026-09-10.
     *
     * L'appel ne fournissait aucun `friendlyName` : Supabase enregistrait donc
     * le facteur sous le nom vide `""`, puis REFUSAIT tout enrôlement suivant —
     * `422 mfa_factor_name_conflict`, « A factor with the friendly name "" for
     * this user already exists ».
     *
     * Conséquence : un agent qui ouvrait l'écran d'enrôlement sans le terminer
     * (onglet fermé, page rechargée, téléphone pas sous la main) ne pouvait
     * PLUS JAMAIS enrôler sa 2FA. Et comme MFA_REQUISE est actif, il ne pouvait
     * plus entrer dans l'application du tout — sur un message qui ne disait pas
     * pourquoi. Seul un ADMIN pouvait le débloquer.
     *
     * On repart donc d'une table rase : tout facteur TOTP resté NON VÉRIFIÉ est
     * une tentative abandonnée, sans valeur, et on la retire avant d'en créer
     * un neuf. Les facteurs vérifiés ne sont jamais touchés — de toute façon on
     * n'arrive ici que s'il n'y en a aucun (cf. evaluerSession).
     */
    const { data: liste } = await supabase.auth.mfa.listFactors();
    for (const f of liste?.all ?? []) {
      if (f.factor_type === 'totp' && f.status !== 'verified') {
        await supabase.auth.mfa.unenroll({ factorId: f.id });
      }
    }

    const { data, error } = await supabase.auth.mfa.enroll({
      factorType: 'totp',
      // Nom EXPLICITE : c'est lui qui provoquait le conflit quand il était vide.
      friendlyName: 'Cargo Tracker',
      // Sans `issuer`, Supabase reprend l'URL du site du projet — constatée à
      // `localhost:3000` le 2026-09-10, reliquat de développement. Chaque agent
      // voyait donc « localhost:3000 » dans son application d'authentification,
      // sans rien qui désigne l'outil douanier.
      issuer: 'Cargo Tracker — PIA Dry Port',
    });
    if (error || !data) {
      setErr("Impossible de démarrer l'enrôlement 2FA : " + (error?.message ?? 'erreur inconnue'));
      return;
    }
    setFactorId(data.id); setQr(data.totp.qr_code);
  }
  /* UN SEUL enrôlement, quoi qu'il arrive — corrigé le 2026-09-10.
   *
   * `React.StrictMode` (voir main.tsx) invoque VOLONTAIREMENT les effets deux
   * fois au montage en développement. La garde `!qr` ne suffisait pas : `qr` est
   * alimenté par une réponse ASYNCHRONE, si bien que les deux invocations la
   * voyaient encore vide et lançaient chacune un enrôlement.
   *
   * Le symptôme a changé de forme au fil des correctifs, mais la cause était la
   * même : d'abord un `422 mfa_factor_name_conflict` (le second appel butait sur
   * le nom du premier), puis — le nettoyage des facteurs non vérifiés ajouté —
   * une COURSE : le second appel supprimait le facteur du premier et en créait
   * un autre, pendant que l'écran pouvait continuer d'afficher le QR du premier.
   * L'agent scannait alors un secret déjà supprimé, et son code était rejeté
   * sans que rien n'explique pourquoi.
   *
   * Un `useRef` survit au démontage simulé de StrictMode, là où un état React
   * serait réinitialisé : c'est le seul verrou fiable ici. Il est relâché dès
   * qu'on quitte l'écran, pour qu'un retour ultérieur puisse réenrôler.
   */
  const enrolLance = useRef(false);
  useEffect(() => {
    if (phase !== 'enroll') { enrolLance.current = false; return; }
    if (enrolLance.current) return;
    enrolLance.current = true;
    demarrerEnrol();
  }, [phase]);

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
    /* `ecran-connexion` (2026-09-11) : porte le fond travaillé et l'effet de
       verre. Il est posé sur le conteneur, pas sur le bouton — voir styles.css,
       un verre dépoli ne montre rien s'il n'a rien à flouter derrière lui. */
    <main className="ecran-connexion" style={{ maxWidth: 400, margin: '5vh auto 130px', padding: 24 }}>
      <SceneQuai />
      {/* Aussi à la connexion : un téléphone resté sur une ancienne version y
          est souvent, et doit pouvoir se mettre à jour avant d'entrer. */}
      <BandeauMiseAJour />
      <div className="brand-login">
        {/* SUIVI EN MOUVEMENT — 2026-09-11.
            Le logo n'est plus posé seul : il est entouré de ce que fait la
            plateforme. Une ROUTE en pointillés (l'itinéraire), un CAMION qui la
            parcourt, et une ONDE qui se propage (le relevé de position). Trois
            signes, une seule idée : une cargaison suivie en temps réel.
            Décoratif, donc masqué aux lecteurs d'écran. */}
        <div className="suivi-logo">
          <span className="suivi-piste" aria-hidden="true" />
          <span className="suivi-onde" aria-hidden="true" />
          <span className="suivi-orbite" aria-hidden="true">
            <span className="suivi-mobile"><Icone nom="camion" taille={15} /></span>
          </span>
          <img className="logo-rond" src="/logo.png" alt="PIA_Suivi_Cargo"
            onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }} />
        </div>
        <h1 className="titre-hero">Suivi des Cargaisons</h1>
      </div>
      <p className="hero-sous">PIA Dry Port, Adétikopé. Accès réservé aux agents autorisés.</p>
      {/* Mot d'accueil (2026-09-11). Une seule ligne, discrète : l'écran de
          connexion est un seuil, pas une page d'information. La version longue
          qui détaillait la démarche de création de compte encombrait plus
          qu'elle n'aidait — elle s'adressait à une minorité au détriment de
          tous ceux qui viennent simplement travailler.
          Affiché à la seule phase de connexion : pendant la 2FA, l'agent est
          déjà accueilli. */}
      {phase === 'login' && <p className="mot-accueil">Merci de nous rejoindre</p>}
      <div className="card">
        {phase === 'login' && (
          <form onSubmit={login} style={{ display: 'grid', gap: 14 }}>
            <div><label className="help">Identifiant</label><input value={id} onChange={(e) => setId(e.target.value)} autoComplete="username" required /></div>
            <div><label className="help">Mot de passe</label><input type="password" value={pwd} onChange={(e) => setPwd(e.target.value)} autoComplete="current-password" required /></div>
            <button disabled={busy}>{busy ? 'Connexion…' : 'Se connecter'}</button>
          </form>
        )}
        {phase === 'enroll' && (
          <form onSubmit={verifier} style={{ display: 'grid', gap: 14 }}>
            <p style={{ margin: 0 }}>Première connexion : scannez ce QR code avec votre application d'authentification (Google Authenticator, etc.), puis saisissez le code.</p>
            {qr ? <img src={qr} alt="QR code 2FA" style={{ width: 180, margin: '4px auto', background: '#fff' }} /> : <Spinner />}
            <input inputMode="numeric" pattern="[0-9]{6}" maxLength={6} placeholder="Code à 6 chiffres" value={code} onChange={(e) => setCode(e.target.value)} required />
            <button disabled={busy}>{busy ? 'Vérification…' : 'Activer et se connecter'}</button>
          </form>
        )}
        {phase === 'verify' && (
          <form onSubmit={verifier} style={{ display: 'grid', gap: 14 }}>
            <label className="help">Code de votre application d'authentification</label>
            <input inputMode="numeric" pattern="[0-9]{6}" maxLength={6} placeholder="123456" value={code} onChange={(e) => setCode(e.target.value)} required />
            <button disabled={busy}>{busy ? 'Vérification…' : 'Valider'}</button>
          </form>
        )}
        {phase === 'motdepasse' && (
          <form onSubmit={changerMotDePasse} style={{ display: 'grid', gap: 14 }}>
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
