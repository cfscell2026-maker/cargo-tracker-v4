/**
 * Primitives d'interface + libellés/menus (reproduction de Client.html v3.6 :
 * MENUS, TITLES, roleLabel, statutLabel/tag, masques de saisie).
 */
import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
// `rpc.ts` ne dépend que de `supabase.ts` : aucun cycle d'import ici.
import { call } from './rpc.ts';
import { useAsync } from './hooks.ts';
import { Icone } from './icones.tsx';
import type { Variation } from './periode.ts';

type O = Record<string, unknown>;
import { ROLE_LABELS, STATUTS, DESTINATIONS, DESTINATION_CODES, ENGAGEMENTS, dateDansNJours, camionValide } from '../../../../supabase/functions/_shared/domaine/src/index.ts';

// Menus et découpage : extraits dans menu.ts (données pures, testables).
export { MENUS, menuSections, type MenuItem } from './menu.ts';

export const TITLES: Record<string, string> = {
  dash: 'Tableau de bord', new: 'Nouveau rapport', list: 'Cargaisons', search: 'Recherche — cargaisons en cours',
  creercamion: 'Créer un camion (entrée)',
  completer: 'Saisir / compléter les camions', stockjour: 'Stock CFS journalier',
  depotstats: 'Statistiques de dépotage',
  wait_valid: 'À valider — chef brigade', etatcfs: 'Pointage des camions à la sortie', t1: 'Cellule T1', wait_cfs: 'En cours au CFS', wait_t1: 'En attente T1',
  chargement: 'Bon de chargement — par déclaration',
  gps: 'Cellule Balise', wait_gps: 'En attente Balise', bonsortie: 'Cellule Bon de Sortie', wait_bs: 'En attente Bon de Sortie',
  sortie: 'Sortie (checklist PP)', wait_sortie: 'En attente de sortie', history: 'Historique', users: 'Utilisateurs',
  account: 'Mon compte', detail: 'Détail cargaison', cfsreport: 'Rapport CFS', vehreport: 'Rapport véhicules',
  baliserep: 'Rapport Balise', pprep: 'Rapport PP', flux: 'Analyse des flux', dwell: 'Délai & camions en instance',
  t1report: 'Rapport T1 (T1 saisis)', bonsortiereport: 'Rapport Bon de sortie (bons émis)',
  horodatage: "Plage d'activité par cellule",
  goulots: 'Nettoyage — vieux dossiers (goulots)',
  archive: "Archive — dossiers de plus d'un an",
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
/**
 * Bouton de retour — COURT (2026-09-11, demande utilisateur).
 *
 * Il affichait « ← Retour — Saisir / compléter les camions » : une barre de
 * 312 px en tête de fiche, dont l'essentiel répétait un écran qu'on vient de
 * quitter. Il ne dit plus que « Retour ».
 *
 * La destination n'est pas perdue pour autant : elle reste dans l'infobulle et
 * dans le nom lu par les lecteurs d'écran. On raccourcit l'affichage, pas
 * l'information.
 */
export function BoutonRetour({ retour, ecranPrecedent, secours }: {
  retour: () => void; ecranPrecedent: string | null; secours?: () => void;
}) {
  const cible = ecranPrecedent ? TITLES[ecranPrecedent] : null;
  const ou = cible ? `Retour — ${cible}` : 'Retour';
  return <button className="ghost btn-retour" title={ou} aria-label={ou}
    onClick={() => (ecranPrecedent ? retour() : secours?.())}>
    <Icone nom="fleche" taille={16} />Retour
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
  // 2026-09-12 : même jeu de caractères que `alphaNumMaj` côté serveur — les
  // séparateurs usuels d'une plaque sont conservés, les espaces absorbés.
  alnum: (v: string) => v.toUpperCase().replace(/[^A-Z0-9/\\._-]/g, ''),
  tc: (v: string) => {
    const s = v.toUpperCase().replace(/[^A-Z0-9]/g, '');
    return (s.slice(0, 4).replace(/[^A-Z]/g, '') + s.slice(4).replace(/[^0-9]/g, '')).slice(0, 11);
  },
  tel: (v: string) => v.replace(/[^\d+ ]/g, '').replace(/(?!^)\+/g, ''),
};

/* ------------------------------ Composants ----------------------------- */
/**
 * ÉCRAN D'ATTENTE — refait le 2026-09-11 (demande utilisateur).
 *
 * Le logo de la plateforme, cerclé d'un anneau où court un conteneur. Le
 * mouvement reste DANS LE SUJET : on n'attend pas devant un disque abstrait,
 * on attend qu'une cargaison arrive. Et il dit quelque chose d'utile — tant
 * que le conteneur tourne, le serveur travaille.
 *
 * Ludique mais sobre : un tour en 1,4 s, une respiration lente du logo. Cet
 * écran s'affiche des dizaines de fois par jour ; ce qui s'agite y devient vite
 * pénible, et sur un serveur lent il reste parfois plusieurs secondes.
 *
 * `role="status"` + le texte masqué : un lecteur d'écran annonce « Chargement »
 * au lieu de laisser un blanc inexpliqué.
 */
export function Spinner() {
  return <div className="attente" role="status" aria-live="polite">
    <div className="att-logo">
      <span className="att-anneau" aria-hidden="true" />
      <span className="att-orbite" aria-hidden="true"><span className="att-colis" /></span>
      <img className="logo-rond" src="/logo_PIA.jpg" alt=""
        onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }} />
    </div>
    <span className="att-mot">Chargement…</span>
    {/* UNE SCENETTE SOUS LE LOGO - 2026-09-12.
        Les chargements durent plusieurs secondes ; autant que l'attente
        raconte quelque chose. Le camion arrive A VIDE - son plateau est un
        simple filet, pas un bloc -, la barriere du poste se leve, il se range
        sous le portique PIA, un conteneur descend sur son plateau, et il repart
        CHARGE. C'est le geste meme que l'ecran est en train d'aller chercher.
        Minuscule, decorative, et muette pour les lecteurs d'ecran, qui
        entendent deja << Chargement >> juste au-dessus. */}
    <svg className="att-scene" viewBox="0 0 200 48" width="200" height="48"
      aria-hidden="true" focusable="false">
      <path d="M0 40 H200" stroke="currentColor" strokeWidth="1.2" opacity=".3" />
      <path className="as-bitume" d="M0 44 H200" stroke="currentColor" strokeWidth="1.6"
        strokeDasharray="9 7" opacity=".22" />

      {/* LE PORTIQUE DE LA PIA. L'enseigne dit ou l'on arrive : sans elle, la
          scene montrait un camion quelconque sur une route quelconque. */}
      <path d="M120 40 V10 M176 40 V10 M116 10 H180" stroke="currentColor"
        strokeWidth="1.8" opacity=".4" fill="none" strokeLinecap="round" />
      <rect x="131" y="1" width="34" height="9.5" rx="2" fill="currentColor" opacity=".85" />
      <text x="148" y="8.4" textAnchor="middle" fontSize="6.4" fontWeight="700"
        letterSpacing="1.2" fill="#fff">PIA</text>

      {/* LE POSTE D'ENTREE : le pied, puis la barriere qui pivote dessus. */}
      <rect x="58" y="28" width="2.6" height="12" rx="1" fill="currentColor" opacity=".6" />
      <g className="as-barriere">
        <rect x="60" y="29" width="32" height="2.6" rx="1.3" fill="currentColor" opacity=".8" />
      </g>

      {/* Le conteneur porte par le portique : il descend, puis passe la main a
          celui du camion a l'instant precis de la pose (meme procede que la
          scene de l'ecran de connexion). */}
      <g className="as-colis">
        <rect x="135" y="12" width="26" height="8" rx="1" fill="currentColor" opacity=".85" />
      </g>

      <g className="as-camion">
        {/* Le PLATEAU : un filet de 2,5 unites. Un bloc plein se lisait comme
            une charge, et le camion semblait arriver deja charge. */}
        <rect x="0" y="32" width="30" height="2.5" rx="1" fill="currentColor" opacity=".65" />
        {/* La charge, absente a l'arrivee, posee par la grue. */}
        <g className="as-charge">
          <rect x="1" y="24" width="26" height="8" rx="1" fill="currentColor" opacity=".85" />
        </g>
        <path d="M30 34.5 V26 h6 l4 5 v3.5 z" fill="currentColor" opacity=".8" />
        <circle cx="6" cy="37" r="2.4" fill="currentColor" />
        <circle cx="20" cy="37" r="2.4" fill="currentColor" />
        <circle cx="34" cy="37" r="2.4" fill="currentColor" />
      </g>
    </svg>
  </div>;
}

/**
 * Tuile de compteur.
 *
 * 2026-09-11 — deux ajouts, tous deux optionnels pour ne rien changer aux
 * dizaines d'appels existants :
 *
 *  · `variation` — la flèche de hausse ou de baisse face à la période
 *    précédente. À ne fournir QUE sur un compteur de période : les compteurs
 *    « Attente » sont instantanés, un écart y serait inventé.
 *    `null` (comparaison impossible, période précédente à zéro) affiche
 *    « nouveau » plutôt qu'un pourcentage faux.
 *  · INDICATEUR DE CLIC — un chevron apparaît sur les tuiles cliquables. Rien
 *    ne distinguait jusqu'ici une tuile qui ouvre un écran d'une tuile qui ne
 *    fait rien ; le curseur seul ne se voit pas sur écran tactile.
 */
/**
 * L'icône qui représente chaque étape du parcours. Une seule table : la pastille
 * d'une tuile ne peut donc pas diverger de l'étape qu'elle annonce.
 */
const ICONE_ETAPE: Record<string, string> = {
  cfs: 'camionPlus', validation: 'valider', t1: 't1',
  balise: 'balise', bs: 'bonSortie', pp: 'sortie', vehicule: 'voiture',
};

export function StatCard({ n, l, tone, onClick, variation, comparable, etape, part, icone }: {
  n: ReactNode; l: string; tone?: 'ok' | 'warn'; onClick?: () => void;
  variation?: Variation | null; comparable?: boolean;
  /**
   * Dessin de la pastille, quand la tuile ne correspond a AUCUNE etape du
   * parcours - les vehicules depotes, par exemple, qui ont leur propre suivi.
   * Sans elle, ces tuiles restaient les seules sans icone.
   */
  icone?: string;
  /** Étape du parcours — donne sa couleur propre à la tuile (voir `--etape-*`). */
  etape?: string;
  /**
   * PART du total, en pourcentage (2026-09-11).
   *
   * Réservée aux compteurs INSTANTANÉS — les files d'attente. On leur a
   * réclamé une flèche de croissance ; elle serait fausse, puisque le serveur
   * renvoie ces compteurs sans tenir compte de la période (voir
   * `dashboardStats`) : il n'existe aucune valeur antérieure à comparer.
   *
   * La part, elle, se calcule vraiment : « cette file pèse 38 % de tout ce qui
   * attend ». Elle répond à la même question — où ça coince — avec un chiffre
   * qui existe.
   */
  part?: number | null;
}) {
  const cliquable = !!onClick;
  return <div
    className={`stat ${tone ?? ''} ${cliquable ? 'cliquable' : ''} ${etape ? 'et-' + etape : ''}`}
    onClick={onClick}
    role={cliquable ? 'button' : undefined}
    tabIndex={cliquable ? 0 : undefined}
    onKeyDown={cliquable ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } } : undefined}
  >
    {/* Pastille d'étape : sa couleur et son dessin disent le poste avant même
        qu'on ait lu le libellé. */}
    {(icone || etape) && <span className="stat-icone" aria-hidden="true">
      <Icone nom={icone ?? ICONE_ETAPE[etape!] ?? 'tableau'} taille={17} /></span>}
    <div className="n">{n}</div>
    <div className="l">{l}</div>
    {part !== undefined && part !== null && <div className="evo evo-part">
      <Icone nom="rapport" taille={12} />{part} % de la file
    </div>}
    {comparable && (variation
      ? <div className={`evo evo-${variation.sens}`}>
        <Icone nom={variation.sens} taille={13} />
        {/* La flèche et le pourcentage, RIEN DE PLUS (2026-09-11) : la mention
            « sur la période précédente » se répétait sur cinq tuiles et
            occupait plus de place que le chiffre qu'elle qualifiait. Le sens de
            la comparaison est déjà donné une fois pour toutes par la note en
            tête d'écran. */}
        {variation.sens === 'stable' ? 'stable' : `${variation.pourcent} %`}
      </div>
      : <div className="evo evo-neuf">nouveau</div>)}
    {cliquable && <span className="stat-clic" aria-hidden="true"><Icone nom="chevron" taille={15} /></span>}
  </div>;
}

export function Modal({ children, onClose }: { children: ReactNode; onClose: () => void }) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h);
  }, [onClose]);
  /* RENDUE HORS DE L'ARBRE, dans `document.body` - 2026-09-12.
   *
   * Une fenetre modale s'AFFICHE par-dessus tout l'ecran ; rien ne justifie
   * qu'elle VIVE au milieu du composant qui l'ouvre. Elle y heritait de son
   * contexte de style, et le defaut s'est vu des que le bouton d'extraction a
   * rejoint la barre d'outils du bandeau : les regles du bandeau SOMBRE
   * (`.bm-outils .help`, `.bm-outils button`) atteignaient l'interieur de la
   * fenetre, et son texte s'affichait en BLANC SUR BLANC - illisible, sans
   * qu'aucune regle de la fenetre soit en cause.
   *
   * Le portail coupe l'heritage a la racine : quel que soit l'endroit d'ou on
   * l'ouvre - bandeau sombre, tuile, tableau - la fenetre se rend au meme
   * niveau que l'application et n'herite que d'elle-meme. Les gestionnaires
   * React, eux, continuent de remonter l'arbre REACT : `onClose` fonctionne
   * comme avant. */
  return createPortal(
    <div className="overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>{children}</div>
    </div>,
    document.body,
  );
}

/**
 * CHOIX SEGMENTE - 2026-09-12.
 *
 * Remplace les boutons radio la ou le choix se compte sur les doigts d'une
 * main : deux pastilles de 13 px, difficiles a viser au doigt et indistinctes
 * du reste du formulaire, deviennent deux BOUTONS francs.
 *
 * Chacun porte un VOYANT : eteint, c'est un point gris mat ; allume, il
 * s'eclaire et diffuse un halo. Le choix se lit donc deux fois - par le
 * remplissage du bouton ET par le voyant - ce qui le rend lisible meme sur un
 * ecran au soleil, ou un simple aplat de couleur ne suffit pas.
 *
 * RECLIQUER ANNULE LE CHOIX (2026-09-12, demande utilisateur). C'est la
 * difference avec des boutons radio, qu'on ne peut plus decocher une fois
 * coches : ici, l'agent qui s'est trompe revient a l'etat « rien de choisi »
 * sans recharger l'ecran. Les ecrans concernes traitent deja cet etat - la
 * signature reste bloquee tant qu'aucune valeur n'est retenue.
 *
 * L'accessibilite suit : `role="radiogroup"` pour le groupe, et `aria-checked`
 * sur chaque bouton - qui vaut donc `false` partout quand rien n'est choisi.
 */
export function ChoixSegmente({ options, valeur, onChange, libelle }: {
  options: { valeur: string; libelle: string; icone?: string }[];
  valeur: string;
  onChange: (v: string) => void;
  libelle: string;
}) {
  return <div className="segmente" role="radiogroup" aria-label={libelle}>
    {options.map((o) => {
      const actif = o.valeur === valeur;
      return <button key={o.valeur} type="button" role="radio" aria-checked={actif}
        className={`seg-choix ${actif ? 'actif' : ''}`}
        onClick={() => onChange(actif ? '' : o.valeur)}>
        <span className="seg-voyant" aria-hidden="true" />
        {o.icone && <Icone nom={o.icone} taille={15} />}
        <span>{o.libelle}</span>
      </button>;
    })}
  </div>;
}

/**
 * BASCULE A VOYANT - 2026-09-12.
 *
 * Le pendant a UN SEUL choix de `ChoixSegmente` : meme bouton, meme voyant,
 * meme lecture. Remplace les cases a cocher isolees, qui detonnaient a cote des
 * choix segmentes - et dont la cible de 13 px se rate au doigt.
 *
 * `role="switch"` plutot que `checkbox` : c'est bien un interrupteur, et un
 * lecteur d'ecran annonce alors « active / desactive » au lieu de « coche ».
 */
export function BoutonBascule({ actif, onChange, libelle, icone }: {
  actif: boolean; onChange: (v: boolean) => void; libelle: string; icone?: string;
}) {
  return <button type="button" role="switch" aria-checked={actif}
    className={`seg-choix ${actif ? 'actif' : ''}`} onClick={() => onChange(!actif)}>
    <span className="seg-voyant" aria-hidden="true" />
    {icone && <Icone nom={icone} taille={15} />}
    <span>{libelle}</span>
  </button>;
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
 * SUIVI DES ENGAGEMENTS (2026-09-10) — renseigné par le chef de brigade au
 * moment de la validation, sur TOUTES les opérations, et BLOQUANT.
 *
 * Fourni comme HOOK plutôt que comme simple composant : la saisie tient en
 * trois états liés, et elle est réclamée à trois endroits — la fiche
 * (`PanneauValidation`) et les DEUX écrans de validation en lot. Recopier le
 * bloc trois fois garantissait qu'une correction future n'en atteigne que deux.
 *
 * Le hook rend le champ prêt à poser (`champ`), l'état de complétude (`pret`)
 * pour désactiver le bouton, et la charge utile déjà formée (`payload`).
 *
 * ⚠ `pret` n'est qu'un CONFORT D'ÉCRAN. L'autorité reste au serveur
 * (`engagementPatch`), qui refuse une validation incomplète même appelée
 * directement par l'API, sans passer par cette interface.
 */
export function useSuiviEngagement() {
  const [suivi, setSuivi] = useState<'' | 'oui' | 'non'>('');
  const [choix, setChoix] = useState('');
  // La saisie libre est conservée à part : revenir à la liste puis choisir
  // « Autre » à nouveau ne doit pas effacer ce que l'agent avait déjà tapé.
  const [libre, setLibre] = useState('');

  /* Délai OBLIGATOIRE quand le suivi est actif : c'est lui qui fait vivre
   * l'échéancier du tableau de bord.
   *
   * Saisi en NOMBRE DE JOURS (décision utilisateur 2026-09-10) : le chef
   * raisonne en délai (« sous 5 jours »), pas en date de calendrier. Le logiciel
   * convertit à compter du jour de la saisie, et affiche la date obtenue — pour
   * que ce qui sera enregistré reste sous les yeux, sans surprise. */
  const [jours, setJours] = useState('');
  const delai = dateDansNJours(jours);

  const valeur = choix === 'autre' ? libre.trim() : choix;
  const pret = suivi === 'non' || (suivi === 'oui' && valeur !== '' && delai !== '');
  const payload = { suiviEngagement: suivi === 'oui', engagementType: valeur, engagementDelai: delai };

  const champ = <div style={{ marginTop: 10 }}>
    <div className="section-title">Suivi des engagements</div>
    <ChoixSegmente libelle="Suivi des engagements" valeur={suivi}
      options={[{ valeur: 'oui', libelle: 'Oui', icone: 'valider' }, { valeur: 'non', libelle: 'Non' }]}
      onChange={(v) => {
        // Recliquer ramene a « rien de choisi » : `pret` repasse alors a faux et
        // la signature se rebloque, ce qui est exactement l'etat de depart.
        if (v === 'oui') setSuivi('oui');
        else { setSuivi(v === 'non' ? 'non' : ''); setChoix(''); setLibre(''); }
      }} />
    {suivi === 'oui' && <div style={{ marginTop: 8 }}>
      {/* L'ENGAGEMENT ET SON DELAI SUR UNE LIGNE (2026-09-12) : le menu
          occupait toute la largeur pour des libelles de vingt caracteres, et
          repoussait le delai - pourtant obligatoire - sous la ligne de
          flottaison. Les deux se decident ensemble, ils se posent ensemble. */}
      <div className="row ligne-engagement">
        <div className="ch-engagement">
          <label className="help">Engagement</label>
          <select value={choix} onChange={(e) => setChoix(e.target.value)}>
            <option value="">— Choisir —</option>
            {ENGAGEMENTS.map((e) => <option key={e} value={e}>{e}</option>)}
            <option value="autre">Autre (saisie libre)…</option>
          </select>
        </div>
        <div className="ch-delai">
          <label className="help">Délai — jours <b>(obligatoire)</b></label>
          <div className="row" style={{ alignItems: 'center', gap: 8 }}>
            <input inputMode="numeric" style={{ maxWidth: 92 }} value={jours}
              onChange={(e) => setJours(e.target.value.replace(/[^0-9]/g, ''))}
              placeholder="Ex. 5" />
            <span className="help" style={{ margin: 0 }}>jour(s)</span>
          </div>
        </div>
      </div>
      {choix === 'autre' && <div style={{ marginTop: 6 }}>
        <label className="help">Précisez l'engagement</label>
        <input value={libre} onChange={(e) => setLibre(masks.upper(e.target.value))}
          placeholder="Ex. TRANSIT SPÉCIAL" />
      </div>}
      <div style={{ marginTop: 6 }}>
        <div className="row" style={{ alignItems: 'center', gap: 8 }}>
          {delai
            ? <span style={{ fontWeight: 600 }}>→ échéance le {fmtJour(delai)}</span>
            : jours !== '' ? <span style={{ color: 'var(--warn)' }}>Indiquez au moins 1 jour.</span> : null}
        </div>
        <div className="help" style={{ marginTop: 2 }}>
          Le délai court à compter d'aujourd'hui. À cette échéance, la cargaison
          remontera au tableau de bord jusqu'à ce que les informations soient
          marquées comme transmises.
        </div>
      </div>
    </div>}
  </div>;

  return { pret, payload, champ };
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
/**
 * PALETTE DES GRAPHIQUES — remplacée le 2026-09-11 après MESURE.
 *
 * L'ancienne (`#0e5a8a, #1f7a5c, #a5670f, #7b3fa0, #b03060, #2a8fa8, #6b7a1f,
 * #5c6b7a`) échouait à trois contrôles, vérifiés par un validateur de palettes :
 *
 *   · TROIS teintes passaient sous le plancher de chroma — vert, cyan et
 *     ardoise se lisaient comme du GRIS sur un écran de bureau ;
 *   · la paire ardoise/olive n'était séparée que de ΔE 13,8 en vision NORMALE,
 *     sous le plancher de 15 : deux séries voisines qu'un œil valide ne
 *     distinguait pas ;
 *   · orange et vert tombaient à ΔE 7,8 en simulation protanope — le cas le
 *     plus fréquent de daltonisme.
 *
 * Celle-ci passe les cinq contrôles (bande de clarté, chroma, séparation en
 * vision daltonienne, plancher de vision normale, contraste). Les teintes sont
 * attribuées DANS L'ORDRE, jamais en boucle : une série garde sa couleur quand
 * on en filtre une autre.
 *
 * ⚠ Trois d'entre elles passent sous 3:1 de contraste avec le fond : c'est
 * pourquoi la LÉGENDE et l'INFOBULLE ne sont pas optionnelles ici. Elles sont
 * le recours qui rend la lecture possible sans jouer uniquement sur la couleur.
 */
const PALETTE = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948'];

/**
 * Tracé d'une colonne au BOUT ARRONDI côté donnée et CARRÉ sur la ligne de
 * base. `rx` arrondirait les quatre coins, y compris ceux qui reposent sur
 * l'axe — la barre semblerait alors flotter au lieu de partir du zéro.
 */
function barreArrondie(bx: number, by: number, bw: number, bh: number): string {
  const r = Math.max(0, Math.min(4, bw / 2, bh));
  const bas = by + bh;
  return `M${bx},${bas} L${bx},${by + r} Q${bx},${by} ${bx + r},${by}`
    + ` L${bx + bw - r},${by} Q${bx + bw},${by} ${bx + bw},${by + r}`
    + ` L${bx + bw},${bas} Z`;
}

/** Épaisseur maximale d'une colonne : au-delà, la barre mange son couloir. */
const BARRE_MAX = 24;
/** Écart de surface entre deux marques qui se touchent (2 px, constant). */
const ECART = 2;

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
  return <div className="graphique">
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
                {type === 'aire' && segments.map((seg, k) => seg.length > 1 && <polygon key={k} fill={col} opacity={0.10}
                  points={`${x(seg[0]!.i)},${y(0)} ${seg.map((pt) => `${x(pt.i)},${y(pt.v)}`).join(' ')} ${x(seg[seg.length - 1]!.i)},${y(0)}`} />)}
                {segments.map((seg, k) => <polyline key={k} fill="none" stroke={col} strokeWidth={2}
                  strokeLinejoin="round" strokeLinecap="round" points={seg.map((pt) => `${x(pt.i)},${y(pt.v)}`).join(' ')} />)}
                {/* Marqueur PLEIN de la couleur de série, cerclé de 2 px de la
                    couleur du fond : c'est cet anneau qui le garde lisible là
                    où deux courbes se croisent. Rayon 4 minimum — en dessous,
                    la cible devient trop petite pour être visée. */}
                {segments.flat().map((pt) => <circle key={pt.i} cx={x(pt.i)} cy={y(pt.v)}
                  r={survol === pt.i ? 5.5 : 4} fill={col} stroke="var(--panel)" strokeWidth={2} />)}
              </g>;
            })
          : cats.map((_, i) => {
              if (empile) {
                let cumul = 0;
                const lw = Math.min(BARRE_MAX, bande * 0.7);
                const dernier = visibles.filter(({ s }) => (s.valeurs[i] ?? 0) > 0).slice(-1)[0];
                return <g key={i}>{visibles.map(({ s, i: si }) => {
                  const v = Math.max(0, s.valeurs[i] ?? 0);
                  const yb = y(cumul + v), hb = y(cumul) - y(cumul + v);
                  cumul += v;
                  if (v <= 0) return null;
                  // L'ÉCART de 2 px se prend sur le HAUT du segment : c'est du
                  // fond qui sépare, pas un trait dessiné autour — un contour
                  // ajouterait de l'encre qui n'est pas de la donnée.
                  const sommet = dernier && dernier.i === si;
                  const hs = Math.max(1, hb - (sommet ? 0 : ECART));
                  return sommet
                    ? <path key={si} d={barreArrondie(x(i) - lw / 2, yb, lw, hs)} fill={couleur(si)} />
                    : <rect key={si} x={x(i) - lw / 2} y={yb + ECART} width={lw} height={hs} fill={couleur(si)} />;
                })}</g>;
              }
              // Largeur PLAFONNÉE : sur un graphique à trois catégories, une
              // barre qui remplit son couloir devient un aplat, pas une mesure.
              const couloir = Math.min(BARRE_MAX * visibles.length + ECART * (visibles.length - 1), bande * 0.72);
              const bw = (couloir + ECART) / visibles.length;
              return <g key={i}>{visibles.map(({ s, i: si }, k) => {
                const v = s.valeurs[i];
                if (v === null || v === undefined || !isFinite(v)) return null;
                const bx = x(i) - couloir / 2 + k * bw;
                const bh = Math.max(v > 0 ? 1 : 0, mT + ih - y(v));
                const lb = Math.max(1, bw - ECART);
                return <g key={si}>
                  <path d={barreArrondie(bx, y(v), lb, bh)} fill={couleur(si)} />
                  {valeursSurBarres && v > 0 && visibles.length <= 2 && cats.length <= 12 &&
                    <text x={bx + lb / 2} y={y(v) - 6} textAnchor="middle" fontSize={10} fill="var(--muted)">{format(v)}</text>}
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
        // Infobulle en VERRE : elle se pose sur le graphique, et on doit
        // continuer à deviner les barres qu'elle recouvre — un panneau opaque
        // masquerait précisément la donnée qu'on est en train de lire.
        background: 'rgba(255,255,255,.82)', border: '1px solid rgba(255,255,255,.9)', borderRadius: 12,
        backdropFilter: 'blur(14px) saturate(160%)', WebkitBackdropFilter: 'blur(14px) saturate(160%)',
        boxShadow: '0 10px 28px rgba(15,35,55,.18)', padding: '8px 11px', fontSize: 12, minWidth: 150, zIndex: 2,
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
        quand six courbes se croisent. Un second clic rétablit l'ensemble.
        UNE SEULE SÉRIE : pas de légende (2026-09-11). Une boîte à une pastille
        ne fait que répéter le titre, et coûte une ligne. */}
    {series.length > 1 && <div className="row" style={{ flexWrap: 'wrap', gap: 10, marginTop: 8, justifyContent: 'center' }}>
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
    </div>}
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
export function BarresClassees({ lignes, format = nombreFr, total, max = 12, onClic, teintes }: {
  lignes: { nom: string; valeur: number }[];
  format?: (v: number) => string;
  /** Base des pourcentages ; par défaut la somme des lignes affichées. */
  total?: number;
  max?: number;
  onClic?: (nom: string) => void;
  /**
   * Couleur par ligne (2026-09-11), indexée sur le NOM affiché. Le tableau de
   * bord y passe les couleurs d'étape : la barre « Cellule Balise » prend alors
   * l'indigo de la tuile « Balisés », et le classement se rattache d'un coup
   * d'œil aux compteurs du haut. Absent, tout reste dans le bleu d'accent.
   */
  teintes?: Record<string, string>;
}) {
  const tri = [...lignes].filter((l) => isFinite(l.valeur)).sort((a, b) => b.valeur - a.valeur);
  if (!tri.length) return <div className="empty">Aucune donnée à comparer.</div>;
  const gardees = tri.slice(0, max);
  const reste = tri.slice(max);
  const somme = total ?? tri.reduce((s, l) => s + l.valeur, 0);
  const plafond = Math.max(1, gardees[0]!.valeur);
  return <div className="barres" style={{ display: 'grid', gap: 6 }}>
    {gardees.map((l) => {
      const pct = somme > 0 ? (l.valeur / somme) * 100 : 0;
      const teinte = teintes?.[l.nom] ?? 'var(--accent)';
      return <div key={l.nom} className={onClic ? 'barre cliquable' : 'barre'}
        onClick={onClic ? () => onClic(l.nom) : undefined}
        role={onClic ? 'button' : undefined} tabIndex={onClic ? 0 : undefined}
        onKeyDown={onClic ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClic(l.nom); } } : undefined}
        style={{ cursor: onClic ? 'pointer' : 'default' }}>
        <div className="row" style={{ justifyContent: 'space-between', gap: 8, fontSize: 12.5 }}>
          <span style={{ fontWeight: 600 }}>{l.nom}</span>
          <span style={{ color: 'var(--muted)', whiteSpace: 'nowrap' }}>
            <b style={{ color: 'var(--ink)' }}>{format(l.valeur)}</b>{somme > 0 && ` · ${pct.toFixed(1)} %`}
          </span>
        </div>
        <div className="barre-piste">
          <div className="barre-jauge"
            style={{ width: `${Math.max(1, (l.valeur / plafond) * 100)}%`, background: teinte }} />
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

/**
 * CHAMP « N° DE CAMION » — format tracteur/remorque imposé (2026-09-10).
 *
 * Composant unique pour toutes les saisies de plaque. Il existe pour une raison
 * précise : le contrôle serveur (`camionValide`) refuse déjà un format
 * incomplet, mais il le fait APRÈS l'envoi, souvent au bout d'un formulaire
 * long. L'agent perd sa saisie et ne sait pas toujours quel champ reprendre.
 *
 * Ici l'erreur apparaît SOUS LE CHAMP, dès la frappe, avec l'exemple attendu.
 * Le serveur reste l'autorité — cet écran ne fait que dire la même chose plus
 * tôt et à l'endroit où l'on peut corriger.
 */
export function ChampCamion({ value, onChange, label = 'N° de camion', style, autoFocus, onBlur, onEnter, excludeId }: {
  value: string;
  onChange: (v: string) => void;
  label?: string;
  style?: React.CSSProperties;
  autoFocus?: boolean;
  /** Appelé quand l'agent quitte le champ — pour un contrôle de doublon, par exemple. */
  onBlur?: () => void;
  /** Appelé sur Entrée. Le geste naturel après avoir tapé une plaque. */
  onEnter?: () => void;
  /** Dossier en cours, à écarter des « passages antérieurs » (sinon il s'y annoncerait lui-même). */
  excludeId?: string;
}) {
  // On n'alerte pas sur un champ encore vide : l'agent n'a pas fini de taper.
  const invalide = value.trim() !== '' && !camionValide(value);
  return <div style={{ flex: 1 }}>
    {/* Icône de CAMION dans le libellé (2026-09-11) : ce champ attend une
        plaque, pas un numéro de conteneur. Les deux se saisissent côte à côte
        sur plusieurs écrans, et rien ne les distinguait au premier coup d'œil.
        `label.help:has(svg)` remet la casse normale — voir styles.css. */}
    {label ? <label className="help lbl-icone"><Icone nom="camion" taille={14} />{label}</label> : null}
    <input
      className="mono"
      value={value}
      autoFocus={autoFocus}
      onChange={(e) => onChange(masks.alnum(e.target.value))}
      onBlur={onBlur}
      // Entrée dans un champ de plaque : on déclenche le contrôle plutôt que de
      // laisser le formulaire s'envoyer à moitié rempli.
      onKeyDown={(e) => { if (e.key === 'Enter' && onEnter) { e.preventDefault(); onEnter(); } }}
      placeholder="TG2489BK ou TG2489BK/2725BP"
      style={{ ...style, borderColor: invalide ? 'var(--err)' : undefined }}
    />
    {/* 2026-09-12 — la barre oblique n'est PLUS exigée (décision utilisateur).
        Tout ce qui se présente au port n'est pas un ensemble : un porteur unique
        doit pouvoir être enregistré. L'aide PROPOSE donc les deux formes au lieu
        d'en imposer une, et l'alerte ne se déclenche plus que sur une saisie
        manifestement avortée. */}
    {invalide
      ? <div className="help" style={{ color: 'var(--err)' }}>
        Saisie trop courte : indiquez la plaque complète — par exemple{' '}
        <span className="mono">TG2489BK</span>, ou l'ensemble{' '}
        <span className="mono">TG2489BK/2725BP</span>.
      </div>
      : <div className="help">Plaque seule, ou tracteur et remorque séparés par « / ».</div>}
    {/* Antécédents du camion — s'affiche dès que la plaque est complète, sur
        TOUS les champs de saisie puisque le composant est unique. */}
    <PassagesAnterieurs numeroCamion={value} excludeId={excludeId} />
  </div>;
}

/**
 * PASSAGES ANTÉRIEURS D'UN CAMION (2026-09-10).
 *
 * « Ce camion est-il déjà venu, et quand ? » — la question se pose AU MOMENT où
 * l'on saisit la plaque, pas après. C'est ce qui donne son utilité à l'archive :
 * un camion revenu trois ans plus tard doit être reconnu tout de suite.
 *
 * Le contrôle part au `blur` ou sur Entrée, jamais à chaque frappe : une plaque
 * incomplète interrogerait le serveur pour rien, et chaque appel coûte un
 * aller-retour vers Dublin.
 *
 * Le bloc reste DISCRET (une ligne d'information, pas un avertissement) : un
 * camion qui revient est parfaitement normal. Ce n'est pas un doublon — celui-là
 * est signalé à part, et en orange.
 */
export function PassagesAnterieurs({ numeroCamion, excludeId }: {
  numeroCamion: string;
  excludeId?: string;
}) {
  const [q, setQ] = useState('');
  useEffect(() => {
    // On n'interroge qu'une plaque au format complet : avant, c'est une saisie
    // en cours, et la réponse n'aurait aucun sens.
    const t = setTimeout(() => setQ(camionValide(numeroCamion) ? numeroCamion : ''), 400);
    return () => clearTimeout(t);
  }, [numeroCamion]);

  const { data } = useAsync<O>(
    () => (q ? call('cargo.passages', { numeroCamion: q, excludeId }) : Promise.resolve({ total: 0 })),
    [q, excludeId],
  );

  const total = Number(data?.['total'] ?? 0);
  if (!q || !total) return null;
  const dernier = data?.['dernierPassage'] as O | undefined;

  return <div className="help" style={{ marginTop: 4 }}>
    🗄 Ce camion est <b>déjà passé {total} fois</b>.
    {dernier ? <> Dernier passage le <b>{fmtJour(dernier['dateCreation'])}</b>
      {dernier['typeOperation'] ? <> — {String(dernier['typeOperation'])}</> : null}
      {dernier['declarant'] ? <>, déclarant {String(dernier['declarant'])}</> : null}
      {' '}(<span className="mono">{String(dernier['id'] ?? '')}</span>).</> : null}
  </div>;
}
