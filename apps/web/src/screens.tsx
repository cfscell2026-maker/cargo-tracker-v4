/**
 * Registre de tous les écrans (reproduction de SCREENS v3.6).
 */
import { useEffect, useRef, useState } from 'react';
import * as XLSX from 'xlsx';
import { call } from './lib/rpc.ts';
import { useAsync } from './lib/hooks.ts';
import { Icone } from './lib/icones.tsx';
import { iconeDeLEcran, MENUS } from './lib/menu.ts';
import { Spinner, StatCard, Tag, Modal, masks, toast, fmtDate, fmtJour, ChampDestination, Graphique, BarresClassees, useSuiviEngagement, ChampCamion, roleLabel, TITLES, ChoixSegmente } from './lib/ui.tsx';
import { bornesDe, isoDate, normaliserPlage, type ModePeriode, comparer, type Variation, fenetreComparaison } from './lib/periode.ts';
import { Detail, TitrePanneau } from './detail.tsx';
import type { ReactNode } from 'react';
import type { Nav } from './App.tsx';
import { useNav } from './lib/contexte-nav.ts';
import { ROLES, OPERATIONS, VEHICULE_DESTINATIONS, TYPES_DECLARATION, STATUTS, SUIVENT_ENGAGEMENTS, tcValide, fileAttente, estTypeSansT1, libelleTypeSansT1, exigeControlePoids, dureeLisible } from '../../../supabase/functions/_shared/domaine/src/index.ts';

const STATUT_OPTIONS = Object.values(STATUTS);

type O = Record<string, unknown>;
type Screen = (p: Nav) => JSX.Element;

/* ------------------------------ Tableau -------------------------------- */
/**
 * UN NUMÉRO PRÉCÉDÉ DE L'ICÔNE QUI DIT SA NATURE — 2026-09-11.
 *
 * La colonne « Camion » ne contient pas que des plaques : les données migrées y
 * portent parfois un NUMÉRO DE CONTENEUR (`TGBU4084237`), et rien ne le
 * signalait — deux natures de référence dans une même colonne, écrites de la
 * même façon.
 *
 * La reconnaissance n'est pas une heuristique de surface : elle utilise
 * `tcValide`, la règle du domaine (4 lettres + 7 chiffres) qui sert déjà à
 * valider les saisies. Un conteneur porte donc le même dessin partout dans
 * l'application, et une plaque le sien.
 */
function NumeroMobile({ valeur }: { valeur: unknown }) {
  const v = String(valeur ?? '').trim();
  if (!v) return <>—</>;
  const conteneur = tcValide(v.toUpperCase().replace(/[^A-Z0-9]/g, ''));
  return <span className={`num-mobile ${conteneur ? 'est-conteneur' : 'est-camion'}`}>
    <Icone nom={conteneur ? 'conteneur' : 'camion'} taille={14} />
    <span className="mono">{v}</span>
  </span>;
}

/** Colonnes dont la valeur est une référence de camion OU de conteneur. */
const COLONNES_MOBILES = new Set(['numeroCamion', 'camion', 'numeroTc', 'conteneur', 'num']);

/**
 * Un VÉHICULE n'est ni un camion ni un conteneur : c'est la marchandise elle-
 * même, dépotée d'un conteneur. Son châssis mérite donc son propre dessin —
 * sans quoi `NumeroMobile` l'aurait affiché avec une icône de camion, ce qui
 * est précisément la confusion que l'écran cherche à éviter.
 */
function ChassisVehicule({ valeur }: { valeur: unknown }) {
  const v = String(valeur ?? '').trim();
  if (!v) return <>—</>;
  return <span className="num-mobile est-vehicule">
    <Icone nom="voiture" taille={14} /><span className="mono">{v}</span>
  </span>;
}
/**
 * MARQUE D'ENGAGEMENT — 2026-09-12.
 *
 * Un engagement qu'il faut ouvrir dossier par dossier pour découvrir n'est pas
 * suivi, il est archivé. La liste doit donc le dire d'un coup d'œil, et dire
 * aussi ce qui compte vraiment : l'échéance est-elle passée ?
 *
 * Trois états, trois couleurs : soldé (vert), en retard (ambre), en cours
 * (bleu). Rien du tout si le dossier n'est pas sous suivi — la majorité des
 * lignes, qu'il ne faut pas charger de bruit.
 */
function MarqueEngagement({ c }: { c: O }) {
  if (c['suiviEngagement'] !== true) return <span className="help">—</span>;
  const solde = !!c['engagementEffectueLe'];
  const delai = String(c['engagementDelai'] ?? '');
  const enRetard = !solde && delai !== '' && delai < new Date().toISOString().slice(0, 10);
  const ton = solde ? 'ok' : enRetard ? 'retard' : 'cours';
  const titre = solde ? 'Engagement soldé'
    : enRetard ? `En retard — échéance du ${fmtJour(delai)}`
      : delai ? `Échéance le ${fmtJour(delai)}` : "Sous suivi d'engagement";
  return <span className={`eng-marque eng-${ton}`} title={titre}>
    <Icone nom={solde ? 'valider' : enRetard ? 'drapeau' : 'sablier'} taille={13} />
    {solde ? 'Soldé' : enRetard ? 'En retard' : 'Engagé'}
  </span>;
}

/** Colonnes qui désignent un véhicule par son châssis. */
const COLONNES_VEHICULE = new Set(['chassis', 'numeroChassis']);

/**
 * Une valeur precedee de son dessin : entrepot, magasin, ce qu'on veut.
 * L'icone est DEMANDEE colonne par colonne (`icones`), jamais deduite du nom de
 * la colonne : `nom` designe un magasin ici et un agent ailleurs, et deviner
 * aurait fini par coller une icone d'entrepot devant une personne.
 */
function ValeurIllustree({ icone, valeur }: { icone: string; valeur: unknown }) {
  const v = String(valeur ?? '').trim();
  if (!v) return <>—</>;
  return <span className="val-illustree"><Icone nom={icone} taille={15} /><span>{v}</span></span>;
}

function Table({ cols, rows, onRow, icones, actions }: {
  cols: [string, string][]; rows: O[]; onRow?: (r: O) => void;
  /** Boutons de fin de ligne (Modifier / Supprimer). Leur clic n'ouvre pas la fiche. */
  actions?: (r: O) => ReactNode;
  /** Colonne -> nom d'icone, posee devant la valeur. */
  icones?: Record<string, string>;
}) {
  if (!rows.length) return <div className="empty">Aucune donnée.</div>;
  // `avec-actions` : sur téléphone, la colonne des boutons reste collée au bord
  // droit pendant qu'on fait défiler le tableau (voir styles.css).
  return <div className={`tbl ${actions ? 'avec-actions' : ''}`}><table>
    <thead><tr>{cols.map((c) => <th key={c[0]}>{c[1]}</th>)}{actions && <th>Actions</th>}</tr></thead>
    <tbody>{rows.map((r, i) => (
      <tr key={i} className={onRow ? 'clk' : ''} onClick={() => onRow?.(r)}>
        {cols.map((c) => <td key={c[0]}>{
          c[0] === 'statut' ? <Tag statut={String(r['statut'])} o={r} />
            : c[0].startsWith('date') ? fmtDate(r[c[0]])
              : c[0] === 'suiviEngagement' ? <MarqueEngagement c={r} />
        : COLONNES_MOBILES.has(c[0]) ? <NumeroMobile valeur={r[c[0]]} />
                : COLONNES_VEHICULE.has(c[0]) ? <ChassisVehicule valeur={r[c[0]]} />
                  : icones?.[c[0]] ? <ValeurIllustree icone={icones[c[0]]!} valeur={r[c[0]]} />
                    : String(r[c[0]] ?? '—')}</td>)}
        {actions && <td onClick={(e) => e.stopPropagation()}>{actions(r)}</td>}
      </tr>
    ))}</tbody>
  </table></div>;
}

/* ------------------ Modifier / supprimer un dossier --------------------- */
/**
 * 2026-09-12 — DEMANDE UTILISATEUR : des agents créent le même camion plusieurs
 * fois (le châssis 732382 trois fois à 12:23). La correction et l'annulation
 * existaient, mais enfouies au fond de la fiche, dans un bloc replié : personne
 * ne les trouvait. Elles sont maintenant AU BOUT DE CHAQUE LIGNE.
 *
 *   · « Modifier » — visible pour TOUS les rôles. Motif obligatoire et tracé ;
 *     le serveur garde ses deux verrous (camion sorti ; dossier signé, sauf ADMIN).
 *   · « Supprimer » — visible pour l'ADMIN SEUL. Annulation logique : le dossier
 *     sort des listes et des compteurs mais reste en base, au journal d'audit.
 */
function ActionsDossier({ r, admin, onFait }: { r: O; admin: boolean; onFait: () => void }) {
  const [ouvert, setOuvert] = useState<'' | 'modifier' | 'supprimer'>('');
  const fermer = () => setOuvert('');
  const fait = () => { setOuvert(''); onFait(); };
  return <div className="acts-dossier">
    <button className="ghost xs" title="Corriger le N° de camion / châssis" aria-label="Modifier" onClick={() => setOuvert('modifier')}>
      ✎<span className="acts-lib"> Modifier</span>
    </button>
    {admin && <button className="ghost xs acts-suppr" title="Supprimer ce dossier (doublon)" aria-label="Supprimer" onClick={() => setOuvert('supprimer')}>
      ✕<span className="acts-lib"> Supprimer</span>
    </button>}
    {ouvert === 'modifier' && <ModaleCorrigerNumero r={r} onClose={fermer} onFait={fait} />}
    {ouvert === 'supprimer' && <ModaleSupprimerDossier r={r} onClose={fermer} onFait={fait} />}
  </div>;
}

const estLigneVehicule = (r: O) => r['typeOperation'] === OPERATIONS.VEHICULE || r['estVehicule'] === true;

function ModaleCorrigerNumero({ r, onClose, onFait }: { r: O; onClose: () => void; onFait: () => void }) {
  const libelle = estLigneVehicule(r) ? 'N° de châssis' : 'N° de camion';
  const ancien = String(r['numeroCamion'] ?? '');
  const [num, setNum] = useState(ancien);
  const [motif, setMotif] = useState('');
  const { busy, envoyer } = useEnvoiUnique();
  const inchange = !num.trim() || num.trim() === ancien.trim();
  const valider = () => envoyer(async () => {
    try {
      await call('cargo.editcamion', { id: r['id'], numeroCamion: num, motif });
      toast(`${libelle} corrigé.`, 'ok'); onFait();
    } catch (e) { toast((e as Error).message, 'err'); }
  });
  return <Modal onClose={onClose}>
    <h2>Modifier le {libelle}</h2>
    <p className="help">Dossier <b className="mono">{String(r['id'])}</b> — actuellement <b className="mono">{ancien || '—'}</b>.
      La correction suit le camion sur toute la fiche et ses conteneurs. Le motif part à l'historique.</p>
    <ChampCamion value={num} onChange={setNum} label={libelle} />
    <label className="help">Motif (obligatoire)</label>
    <input value={motif} onChange={(e) => setMotif(e.target.value)} placeholder="Erreur de frappe, plaque illisible…" />
    <div className="row" style={{ marginTop: 12, justifyContent: 'flex-end' }}>
      <button className="ghost" onClick={onClose}>Annuler</button>
      <button disabled={busy || inchange || !motif.trim()} onClick={valider}>{busy ? 'Enregistrement…' : 'Corriger'}</button>
    </div>
  </Modal>;
}

function ModaleSupprimerDossier({ r, onClose, onFait }: { r: O; onClose: () => void; onFait: () => void }) {
  const [motif, setMotif] = useState('');
  const { busy, envoyer } = useEnvoiUnique();
  const valider = () => envoyer(async () => {
    try {
      await call('cargo.delete', { id: r['id'], motif });
      toast('Dossier supprimé des listes et des compteurs.', 'ok'); onFait();
    } catch (e) { toast((e as Error).message, 'err'); }
  });
  return <Modal onClose={onClose}>
    <h2>Supprimer ce dossier ?</h2>
    <p className="help">
      <b className="mono">{String(r['numeroCamion'] ?? '—')}</b> · {String(r['typeOperation'] ?? '')} · dossier <b className="mono">{String(r['id'])}</b>
      {' '}— statut « {String(r['statut'] ?? '')} ».
    </p>
    <p className="help">
      Le dossier disparaît des listes, de la recherche, des rapports et de tous les compteurs ; ses conteneurs
      repassent « En stock » et l'apurement de sa déclaration est rendu. Il reste <b>conservé en base</b> et
      l'opération est inscrite au journal d'audit.
    </p>
    <label className="help">Motif (obligatoire)</label>
    <input value={motif} onChange={(e) => setMotif(e.target.value)} placeholder="ex. doublon : créé trois fois à 12:23" autoFocus />
    <div className="row" style={{ marginTop: 12, justifyContent: 'flex-end' }}>
      <button className="ghost" onClick={onClose}>Annuler</button>
      <button className="acts-suppr-plein" disabled={busy || !motif.trim()} onClick={valider}>{busy ? 'Suppression…' : 'Supprimer le dossier'}</button>
    </div>
  </Modal>;
}

/**
 * UN SEUL ENVOI À LA FOIS — 2026-09-12.
 * Un `useState` ne suffit pas contre le double clic : deux clics dans la même
 * image lisent tous deux « pas occupé » avant que React n'ait rendu. Le verrou
 * est donc tenu dans une référence, lue et posée de façon synchrone.
 */
function useEnvoiUnique() {
  const enCours = useRef(false);
  const [busy, setBusy] = useState(false);
  const envoyer = async (fn: () => Promise<void>) => {
    if (enCours.current) return;
    enCours.current = true; setBusy(true);
    try { await fn(); } finally { enCours.current = false; setBusy(false); }
  };
  return { busy, envoyer };
}

/* --------------------------- Liste de cargaisons ----------------------- */
/**
 * Mémoire d'écran (durée de la session) : recherche, filtre statut et page
 * courante d'une liste. Sans elle, ouvrir une cargaison puis revenir remettait
 * la liste à zéro — l'agent devait retaper sa recherche et refeuilleter ses
 * pages à chaque fiche consultée.
 */
const etatListe: Record<string, { statut: string; search: string; page: number }> = {};

function CargoList({ go, screen, user, filtre, titre, barre }: Nav & { filtre: O; titre?: string; barre?: boolean }) {
  // Un statut porté par l'ARGUMENT d'écran (tuile du tableau de bord) exprime une
  // intention FRAÎCHE : il prime sur la mémoire, qui repart alors de zéro.
  const impose = filtre['statut'] === undefined ? null : String(filtre['statut']);
  const memoire = barre ? etatListe[screen] : undefined;
  const reprise = memoire && (impose === null || impose === memoire.statut) ? memoire : undefined;

  const [page, setPage] = useState(reprise?.page ?? 1);
  const [statut, setStatut] = useState(impose ?? reprise?.statut ?? 'tous');
  const [search, setSearch] = useState(reprise?.search ?? '');
  // Suivi des engagements (2026-09-12) : '' | 'avec' | 'sans'.
  const [engagement, setEngagement] = useState('');
  const reset = () => setPage(1);
  // Écrit APRÈS le rendu (jamais pendant : le rendu doit rester sans effet de bord).
  useEffect(() => { if (barre) etatListe[screen] = { statut, search, page }; }, [barre, screen, statut, search, page]);
  const eff = barre ? { ...filtre, statut, search, engagement } : filtre;
  const { data, loading, error, reload } = useAsync<{ rows: O[]; total: number; pages: number }>(
    () => call('cargo.list', { ...eff, page }), [JSON.stringify(filtre), statut, search, engagement, page]);
  /* En-tête illustré (2026-09-11). L'icône vient de `iconeDeLEcran`, la MÊME
     table que le menu et que la barre supérieure : la liste affiche donc le
     dessin de la pilule qu'on vient de cliquer, sans qu'on ait à le redire ici.
     La teinte suit l'étape filtrée quand il y en a une — « En attente T1 »
     s'ouvre en sarcelle, comme la tuile et comme le parcours. */
  const teinte = ({ CFS: 'cfs', T1: 't1', BALISE: 'balise', BS: 'bs', PP: 'pp' } as Record<string, string>)[String(filtre['etape'] ?? '')];
  return <>
    {titre && <BandeauModule icone={iconeDeLEcran(user.role, screen)} titre={titre}
      sous={!loading && data ? `${data.total} dossier(s)` : undefined}
      action={<div className="bm-outils">
        {/* LE TRI DANS L'ANGLE (2026-09-12) : ce qui commande la liste se range
            a droite du titre, au lieu de courir sur une ligne a part. */}
        {barre && <>
          <input className="mono" value={search} onChange={(e) => { setSearch(e.target.value); reset(); }}
            placeholder="Rechercher…" style={{ width: 190 }} />
          <select value={statut} onChange={(e) => { setStatut(e.target.value); reset(); }} style={{ maxWidth: 190 }}>
            <option value="tous">Tous les statuts</option>
            {STATUT_OPTIONS.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          {/* Suivi des engagements (2026-09-12) : un chef doit pouvoir ne
              demander que les camions engages, sans ouvrir chaque dossier. */}
          <select value={engagement} onChange={(e) => { setEngagement(e.target.value); reset(); }}
            style={{ maxWidth: 190 }} aria-label="Suivi des engagements">
            <option value="">Engagement : indifferent</option>
            <option value="avec">Avec engagement</option>
            <option value="sans">Sans engagement</option>
          </select>
          <ExportCargaisons statutListe={statut} searchListe={search} />
        </>}
      </div>} />}
    <div className={`card ${teinte ? 'et-' + teinte : ''}`}>
    {loading ? <Spinner /> : error ? <div className="err-msg">{error}</div> : <>
      <Table cols={[['id', 'ID'], ['dateCreation', 'Date'], ['numeroCamion', 'Camion'], ['typeOperation', 'Opération'], ['statut', 'Statut'], ['suiviEngagement', 'Engagement'], ['numeroGps', 'GPS']]}
        rows={data?.rows ?? []} onRow={(r) => go('detail', r['id'])}
        actions={(r) => <ActionsDossier r={r} admin={user.role === ROLES.ADMIN} onFait={reload} />} />
      {(data?.pages ?? 1) > 1 && <div className="row" style={{ marginTop: 10, justifyContent: 'center' }}>
        <button className="ghost xs" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>‹</button>
        <span>Page {page} / {data?.pages}</span>
        <button className="ghost xs" disabled={page >= (data?.pages ?? 1)} onClick={() => setPage((p) => p + 1)}>›</button>
      </div>}
    </>}
  </div></>;
}

/**
 * v4.1 — Extraction des cargaisons (décision client 2026-07-31) : choisir un
 * critère (statut exact OU étape en attente) + une période, sortir en Excel ou
 * PDF. Rétablit l'onglet « Cargaisons » exportable de l'Apps Script (« je n'ai
 * pas la main pour le faire », pour les capitaines).
 */
function ExportCargaisons({ statutListe, searchListe }: { statutListe?: string; searchListe?: string }) {
  const p = useReportRange('mois');
  // v4.2 — 2026-08-19 : l'extraction PART du filtre AFFICHÉ dans la liste (statut
  // + recherche). Avant, elle avait ses propres sélecteurs indépendants et
  // sortait « toute la base » quand on venait d'une liste filtrée. Désormais :
  //   · le statut sélectionné dans la liste pré-remplit le critère ;
  //   · le texte recherché est transmis tel quel au serveur ;
  //   · la période est FACULTATIVE (décochée = toute la base, comme la liste, qui
  //     n'a pas de filtre de période) et ne s'applique que si on la coche.
  const critInitial = statutListe && statutListe !== 'tous' ? `statut:${statutListe}` : '';
  const [crit, setCrit] = useState(critInitial); // '' | 'statut:<v>' | 'etape:<v>'
  // Suit le statut de la liste tant que l'utilisateur n'a pas choisi lui-même.
  const [critTouche, setCritTouche] = useState(false);
  useEffect(() => { if (!critTouche) setCrit(critInitial); }, [critInitial, critTouche]);
  const [limiterPeriode, setLimiterPeriode] = useState(false);
  const [busy, setBusy] = useState(false);
  const [ouvert, setOuvert] = useState(false);
  async function exporter(fmt: 'xlsx' | 'pdf') {
    const params: O = { format: fmt };
    if (limiterPeriode) { params['du'] = p.du; params['au'] = p.au; }
    if (crit.startsWith('statut:')) params['statut'] = crit.slice(7);
    else if (crit.startsWith('etape:')) params['etape'] = crit.slice(6);
    if (searchListe && searchListe.trim()) params['search'] = searchListe.trim();
    setBusy(true);
    try {
      const r = await call<O>('report.cargaisons', params);
      if (fmt === 'pdf') imprimerHtml(String(r['html'] ?? '')); else telecharger(r);
    } catch (e) { toast((e as Error).message, 'err'); } finally { setBusy(false); }
  }
  /* BOUTON D'EN-TÊTE + FENÊTRE (2026-09-11, demande utilisateur). Le panneau
     repliable qui servait jusqu'ici s'intercalait entre les filtres et le
     tableau : il poussait la liste vers le bas sur TOUS les écrans, alors qu'on
     n'exporte qu'une fois de temps en temps. Le geste rare quitte donc le flux
     de lecture pour un bouton, et ses options s'ouvrent dans une fenêtre. */
  return <>
    <button className="btn-export" onClick={() => setOuvert(true)} title="Extraire la liste affichée">
      <Icone nom="telecharger" taille={15} />Extraire
    </button>
    {ouvert && <Modal onClose={() => setOuvert(false)}>
      <h2><span className="tp-pastille" aria-hidden="true"><Icone nom="telecharger" taille={18} /></span>
        Extraire les cargaisons</h2>
      <p className="help" style={{ marginTop: 0 }}>
        L'extraction reprend <b>le filtre affiché dans la liste</b> — vous n'exportez jamais
        autre chose que ce que vous avez sous les yeux.
        {searchListe && searchListe.trim() ? <> Recherche appliquée : <b className="mono">{searchListe.trim()}</b>.</> : null}
      </p>
      <div className="fen-corps">
        <div><label className="help">Statut ou étape</label>
          <select value={crit} onChange={(e) => { setCritTouche(true); setCrit(e.target.value); }}>
            <option value="">Tous les statuts</option>
            {STATUT_OPTIONS.map((s) => <option key={s} value={`statut:${s}`}>{s}</option>)}
            <option value="etape:VALIDATION">En attente — À valider</option>
            <option value="etape:T1">En attente — T1</option>
            <option value="etape:BALISE">En attente — Balise</option>
            <option value="etape:BS">En attente — Bon de sortie</option>
            <option value="etape:PP">En attente — Sortie (PP)</option>
          </select></div>
        <div>
          <label className="help" style={{ display: 'flex', alignItems: 'center', gap: 8, textTransform: 'none', fontSize: 13.5 }}>
            <input type="checkbox" checked={limiterPeriode} onChange={(e) => setLimiterPeriode(e.target.checked)} />
            Limiter à une période
          </label>
          {limiterPeriode ? <div style={{ marginTop: 8 }}><PeriodPicker p={p} /><PeriodeLue p={p} /></div>
            : <p className="help" style={{ margin: '6px 0 0' }}>Toute la base — cochez pour restreindre.</p>}
        </div>
      </div>
      <div className="fen-pied">
        <button className="ghost" onClick={() => setOuvert(false)}>Annuler</button>
        <button className="ghost" disabled={busy} onClick={() => exporter('pdf')}><Icone nom="telecharger" taille={15} />PDF</button>
        <button disabled={busy} onClick={() => exporter('xlsx')}><Icone nom="telecharger" taille={15} />Excel</button>
      </div>
    </Modal>}
  </>;
}

/**
 * BANDEAU DE MODULE — 2026-09-11.
 *
 * L'en-tête des écrans généraux : pastille, titre, sous-titre, et une action
 * facultative à droite. Mis en commun plutôt que recopié sur chaque écran —
 * cinq copies auraient divergé à la première retouche.
 */
export function BandeauModule({ icone, titre, sous, action, sansRetour, auto }: {
  icone: string; titre: string; sous?: ReactNode; action?: ReactNode;
  /** Ecran de depart (tableau de bord, hub) : il n'y a nulle part ou revenir. */
  sansRetour?: boolean;
  /**
   * BANDEAU DE SECOURS, pose par l'application - 2026-09-12.
   *
   * Vingt et un ecrans n'avaient pas de bandeau, et les doter un par un
   * demandait de rouvrir vingt et un blocs de JSX - avec autant d'occasions
   * d'en oublier un, et rien pour empecher le suivant d'arriver sans.
   *
   * `App` en pose donc UN pour tout ecran, bati sur les memes tables que le
   * menu et la barre du haut. Quand l'ecran fournit le sien - plus precis,
   * avec son sous-titre et ses commandes -, une regle CSS (`:has`) efface
   * celui-ci. Il ne peut donc y en avoir ni zero, ni deux.
   */
  auto?: boolean;
}) {
  // Le bouton n'apparait que s'il y a VRAIMENT un ecran precedent : a la racine,
  // un « Retour » qui ne mene nulle part est pire que pas de bouton du tout.
  const nav = useNav();
  const precedent = sansRetour ? null : nav?.ecranPrecedent ?? null;
  const ou = precedent ? `Retour — ${TITLES[precedent] ?? precedent}` : 'Retour';
  return <div className={`bandeau-module ${auto ? 'bm-auto' : ''}`}>
    <span className="bm-pastille" aria-hidden="true"><Icone nom={icone} taille={24} /></span>
    {/* Une CLASSE, et non un `style` en ligne : le style en ligne l'emportait
        sur la feuille, et sa base de 0 empechait de regler qui, du titre ou des
        commandes, cede la place quand la largeur manque. */}
    <div className="bm-textes">
      <div className="bm-titre">{titre}</div>
      {sous && <div className="bm-sous">{sous}</div>}
    </div>
    {/* DANS L'ANGLE : le retour d'abord, les commandes de l'ecran ensuite.
        Les deux vivent dans UN SEUL groupe (`bm-droite`) : tant qu'ils etaient
        deux blocs separes, le repli formait un escalier - le retour se centrait
        sur la hauteur du groupe d'outils au lieu de s'aligner sur sa premiere
        ligne. Reunis, ils se replient ensemble et restent alignes. */}
    {(precedent || action) && <div className="bm-droite">
      {precedent && <button type="button" className="bm-retour" title={ou} aria-label={ou}
        onClick={() => nav?.retour()}>
        <Icone nom="fleche" taille={16} />Retour
      </button>}
      {action}
    </div>}
  </div>;
}

/* ------------------------------ Écrans --------------------------------- */
const SCREENS: Record<string, Screen> = {};

/**
 * ÉCHÉANCIER DES ENGAGEMENTS (2026-09-10) — bandeau du tableau de bord.
 *
 * N'apparaît que pour les rôles qui portent le suivi, et seulement s'il reste
 * quelque chose à envoyer : un bandeau permanent et vide se met à ne plus être
 * lu, et c'est précisément ce qu'on ne veut pas d'une relance.
 *
 * L'alerte s'allume à J-1 (« à envoyer demain »), passe à « échéance
 * aujourd'hui », puis compte les jours de retard — et ne disparaît qu'au clic
 * sur « Effectué ». Elle ne bloque rien : le camion sort normalement (décision
 * du 2026-09-10).
 */
function BandeauEngagements({ role, go }: { role: string; go: Nav['go'] }) {
  const [n, setN] = useState(0); // force le rechargement après un solde
  const { data, loading } = useAsync<O>(() => call('report.engagements'), [n]);
  const [busy, setBusy] = useState('');

  if (!SUIVENT_ENGAGEMENTS.includes(role as never)) return null;
  if (loading || !data) return null;
  const lignes = (data['lignes'] as O[]) ?? [];
  if (!lignes.length) return null;
  const cpt = (data['compte'] as O) ?? {};

  async function solder(id: string) {
    setBusy(id);
    try {
      await call('cargo.engagementfait', { id });
      toast('Engagement soldé : informations marquées comme transmises.', 'ok');
      setN((x) => x + 1);
    } catch (e) { toast((e as Error).message, 'err'); } finally { setBusy(''); }
  }

  const retard = Number(cpt['retard'] ?? 0);
  return <div className="card" style={{
    marginTop: 10,
    borderLeft: `4px solid var(--${retard ? 'err' : 'warn'})`,
  }}>
    <h2 style={{ margin: 0 }}>
      Engagements à transmettre — {lignes.length}
      {retard ? <span style={{ color: 'var(--err)' }}> · {retard} en retard</span> : null}
    </h2>
    <div className="help" style={{ marginBottom: 8 }}>
      Ces cargaisons doivent faire l'objet d'un envoi d'informations. Cliquez sur
      « Effectué » une fois l'envoi réalisé.
    </div>
    {lignes.map((l) => {
      const id = String(l['id']);
      const enRetard = l['etat'] === 'retard';
      return <div key={id} className="row" style={{
        alignItems: 'center', gap: 10, flexWrap: 'wrap',
        padding: '6px 0', borderTop: '1px solid var(--line)',
      }}>
        <a className="mono" style={{ minWidth: 120 }} onClick={() => nav_go(go, id)}>{String(l['numeroCamion'] || id)}</a>
        <span style={{ flex: 1, minWidth: 160 }}>{String(l['engagementType'] || '—')}</span>
        <span className="help" style={{ minWidth: 130 }}>{fmtJour(l['engagementDelai'])}</span>
        <span style={{ color: `var(--${enRetard ? 'err' : 'warn'})`, fontWeight: 600, minWidth: 150 }}>
          {String(l['libelle'] || '')}
        </span>
        <button disabled={busy === id} onClick={() => solder(id)}>
          {busy === id ? '…' : '✔ Effectué'}
        </button>
      </div>;
    })}
  </div>;
}

/** Ouvre la fiche d'une cargaison depuis l'échéancier. */
const nav_go = (go: Nav['go'], id: string) => go('detail', { id });

SCREENS.dash = (nav) => {
  // Même sélecteur de période que les rapports, plage personnalisée comprise.
  const p = useReportRange();
  const { du, au } = p;
  /* ACTUALISATION AUTOMATIQUE (2026-09-12) : un camion qui passe du CFS au T1
     doit se voir quitter une tuile et rejoindre la suivante sans que le chef
     recharge la page. Toutes les 60 s — le cache de lecture (15 s) est alors
     périmé, la requête repart donc bien au serveur. Les tuiles restent affichées
     pendant la mise à jour : pas de clignotement. */
  const [tic, setTic] = useState(0);
  useEffect(() => { const t = window.setInterval(() => setTic((x) => x + 1), 60000); return () => window.clearInterval(t); }, []);
  const { data, loading } = useAsync<O>(() => call('dashboard.stats', { du, au }), [du, au, tic]);
  /* COMPARAISON (2026-09-11) : un second appel sur la fenêtre précédente, pour
     les flèches de hausse et de baisse.
     `fenetreComparaison` compare À DURÉE ÉCOULÉE ÉGALE : un vendredi, la
     semaine en cours ne pèse que cinq jours et se mesure aux cinq jours
     correspondants d'avant, pas aux sept. Sans cela, le tableau de bord
     afficherait une chute tous les jours de la semaine — et l'indicateur
     perdrait tout crédit.
     Appel SÉPARÉ et non bloquant : s'il échoue ou tarde, les tuiles
     s'affichent quand même, sans flèche. Un tableau de bord doit apparaître ;
     la comparaison est un supplément. */
  const av = fenetreComparaison(du, au, new Date(), p.m);
  const { data: dataAvant } = useAsync<O>(() => call('dashboard.stats', { du: av.du, au: av.au }), [av.du, av.au]);
  const s = data ?? {};
  const sAvant = dataAvant;
  /** Variation d'un compteur de PÉRIODE. `undefined` tant que la comparaison n'est pas là. */
  const evo = (cle: string): Variation | null | undefined =>
    sAvant ? comparer(Number(s[cle] ?? 0), Number(sAvant[cle] ?? 0)) : undefined;
  /* PART DE LA FILE pour les compteurs d'attente. FILE UNIQUE (serveur,
     2026-08-19) : chaque dossier actif est dans UNE file, celle de sa prochaine
     étape. Quand il avance, il quitte une tuile et rejoint la suivante ; la
     somme des tuiles égale donc le nombre de dossiers en cours, et les parts
     font 100 %. La file CFS (chargement non terminé) y entre le 2026-09-12. */
  const fileTotale = ['attCFS', 'attValidation', 'attT1', 'attBalise', 'attBs', 'attPP']
    .reduce((t, k) => t + Number(s[k] ?? 0), 0);
  const part = (cle: string): number | null =>
    fileTotale > 0 ? Math.round((Number(s[cle] ?? 0) / fileTotale) * 100) : null;
  const go = (statut: string) => nav.go('list', { statut });
  /* `ecran-dash` (2026-09-11) : le tableau de bord — et lui seul — se détache
     sur un fond bleu profond. Les cartes y deviennent des plaques de verre
     claires, et c'est ce contraste sombre/clair qui rend l'effet lisible. */
  return <div className="ecran-dash">
    <BandeauEngagements role={nav.user.role} go={nav.go} />
    {/* Le tableau de bord est l'ecran de DEPART : `sansRetour` y coupe le bouton,
        qui ne menerait nulle part. La note de lecture passe en sous-titre du
        bandeau, ou elle herite du blanc. */}
    <BandeauModule icone="tableau" titre="Tableau de bord" sansRetour
      sous={<>
        <b>Événements du {fmtJour(du)} au {fmtJour(au)}</b> (« (période) ») : ce qui s'est passé à chaque cellule
        sur la période, compté <b>à la date de chaque passage</b> — une sortie du jour reste une sortie du jour,
        même si le camion est entré avant. Les tuiles <b>« Attente »</b> montrent l'état <b>à l'instant T</b>,
        indépendamment de la période.
        {p.inversee && <span className="bm-alerte"> — dates inversées, remises à l'endroit</span>}
      </>}
      action={<div className="bm-outils">
        <label className="help">Période</label>
        <PeriodPicker p={p} />
      </div>} />
    {/* GRILLE BENTO (2026-09-11) : toutes les tuiles n'ont pas le même poids.
        Les cinq compteurs d'ÉVÉNEMENTS occupent deux colonnes — ce sont eux qui
        portent le travail de la période et la comparaison. « Attente
        validation » est large aussi : c'est la file la plus chargée, et celle
        qu'un chef regarde en premier. Les autres restent en petit format. */}
    {/* CADRE COLORÉ derrière les tuiles (2026-09-11). Il n'est pas décoratif :
        sans lui, les tuiles en verre reposaient sur un fond presque uni et
        n'avaient RIEN à dépolir — elles ressemblaient à de simples cartes
        blanches. Les halos qu'il porte sont ce que le verre diffuse. */}
    {loading && !data ? <Spinner /> : <div className="bento-cadre"><div className="stats bento">
      {/* Événements datés sur la période — le travail EFFECTIF de chaque cellule
          sur la période, compté à la date de la cellule (pas à la création). */}
      <StatCard n={Number(s['creesPeriode'] ?? 0)} l="Entrées CFS (période)" onClick={() => nav.go('cfsreport')}
        etape="cfs" comparable variation={evo('creesPeriode')} />
      <StatCard n={Number(s['t1Periode'] ?? 0)} l="T1 saisis (période)" onClick={() => go(STATUTS.T1)}
        etape="t1" comparable variation={evo('t1Periode')} />
      <StatCard n={Number(s['balisesPeriode'] ?? 0)} l="Balisés (période)" onClick={() => nav.go('baliserep')}
        etape="balise" comparable variation={evo('balisesPeriode')} />
      <StatCard n={Number(s['bonsPeriode'] ?? 0)} l="Bons de sortie (période)" onClick={() => go(STATUTS.BS)}
        etape="bs" comparable variation={evo('bonsPeriode')} />
      <StatCard n={Number(s['sortiePeriode'] ?? 0)} l="Sortis (période)" onClick={() => nav.go('pprep')}
        etape="pp" comparable variation={evo('sortiePeriode')} />
      {/* En attente — état instantané (hors période). */}
      <StatCard n={Number(s['attCFS'] ?? 0)} l="En cours au CFS" onClick={() => nav.go('wait_cfs')} etape="cfs" part={part('attCFS')} />
      <StatCard n={Number(s['attValidation'] ?? 0)} l="Attente validation" onClick={() => nav.go('wait_valid')} etape="validation" part={part('attValidation')} />
      <StatCard n={Number(s['attT1'] ?? 0)} l="Attente T1" onClick={() => nav.go('wait_t1')} etape="t1" part={part('attT1')} />
      <StatCard n={Number(s['attBalise'] ?? 0)} l="Attente Balise" onClick={() => nav.go('wait_gps')} etape="balise" part={part('attBalise')} />
      <StatCard n={Number(s['attBs'] ?? 0)} l="Attente Bon de sortie" onClick={() => nav.go('wait_bs')} etape="bs" part={part('attBs')} />
      <StatCard n={Number(s['attPP'] ?? 0)} l="Attente sortie" onClick={() => nav.go('wait_sortie')} etape="pp" part={part('attPP')} />
      <StatCard n={Number(s['vehiculesAttente'] ?? 0)} l="Véhicules en attente" onClick={() => nav.go('vehicules')} etape="vehicule" />
    </div></div>}
    {/* Neuf tuiles disent COMBIEN, aucune ne dit OÙ ÇA BLOQUE : c'est pourtant
        la première question d'un chef le matin. Le classement des files répond
        d'un coup d'œil, et chaque barre ouvre la file concernée. */}
    {!!data && <div className="card"><h2>Où sont les dossiers en attente</h2>
      <BarresClassees
        lignes={[
          { nom: 'Chargement au CFS', valeur: Number(s['attCFS'] ?? 0) },
          { nom: 'Validation chef de brigade', valeur: Number(s['attValidation'] ?? 0) },
          { nom: 'Cellule T1', valeur: Number(s['attT1'] ?? 0) },
          { nom: 'Cellule Balise', valeur: Number(s['attBalise'] ?? 0) },
          { nom: 'Bon de sortie', valeur: Number(s['attBs'] ?? 0) },
          { nom: 'Sortie (Porte Principale)', valeur: Number(s['attPP'] ?? 0) },
        ]}
        teintes={{
          'Chargement au CFS': 'var(--etape-cfs)',
          'Validation chef de brigade': 'var(--etape-validation)',
          'Cellule T1': 'var(--etape-t1)',
          'Cellule Balise': 'var(--etape-balise)',
          'Bon de sortie': 'var(--etape-bs)',
          'Sortie (Porte Principale)': 'var(--etape-pp)',
        }}
        onClic={(nom) => nav.go(nom.startsWith('Chargement') ? 'wait_cfs' : nom.startsWith('Validation') ? 'wait_valid'
          : nom.startsWith('Cellule T1') ? 'wait_t1'
            : nom.startsWith('Cellule Balise') ? 'wait_gps'
              : nom.startsWith('Bon') ? 'wait_bs' : 'wait_sortie')} />
      <p className="help" style={{ marginBottom: 0 }}>
        Chaque dossier en cours est dans <b>une seule file</b>, celle de sa prochaine étape : quand un camion
        avance (CFS → validation → T1 → Balise → Bon de sortie → sortie), il quitte une file et rejoint la
        suivante. Mise à jour automatique chaque minute.
      </p>
    </div>}
    <FicheBord p={p} />
  </div>;
};

/* ------------- Fiche de synthèse repliable (fiche papier) -------------- */
/**
 * v4.1 — La fiche papier du chef (« TABLEAU DE BORD — SEMAINE EN COURS »)
 * reproduite à l'identique, bloc par bloc, SOUS le tableau de bord et REPLIÉE
 * par défaut (décision utilisateur 2026-07-22) : les tuiles du haut répondent à
 * « qu'est-ce qui bloque maintenant ? », la fiche répond à « qu'a produit la
 * période ? ». Repliée, elle n'encombre pas l'écran ; on appuie pour la voir.
 *
 * Elle n'est CHARGÉE qu'à l'ouverture : tant que personne ne la déplie, elle ne
 * coûte pas une requête à chaque affichage du tableau de bord.
 */
const fnum = (v: unknown) => (v === null || v === undefined ? '—' : Number(v).toLocaleString('fr-FR'));
const fpct = (v: unknown) => `${Number(v ?? 0).toLocaleString('fr-FR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} %`;

type FCase = [string, string];
function FicheBloc({ titre, lignes }: { titre: string; lignes: FCase[][] }) {
  return <div className="fbloc">
    <div className="fbloc-t">{titre}</div>
    {lignes.map((l, i) => <div className="fligne" key={i}>
      {l.map(([lab, val], j) => <div className="fcase" key={j}>
        <div className="flab">{lab}</div><div className="fval">{val}</div>
      </div>)}
    </div>)}
  </div>;
}

/** Détail 20' / 40' / 45' demandé en marge de la fiche papier. */
function FicheTailles({ lignes }: { lignes: [string, O][] }) {
  return <div className="tbl" style={{ marginTop: 4 }}><table>
    <thead><tr><th>Détail par taille</th><th>20'</th><th>40'</th><th>45'</th><th>Autres</th><th>Conteneurs</th><th>EVP</th></tr></thead>
    <tbody>{lignes.map(([nom, t]) => <tr key={nom}>
      <td><b>{nom}</b></td><td>{fnum(t['t20'])}</td><td>{fnum(t['t40'])}</td><td>{fnum(t['t45'])}</td>
      <td>{fnum(t['autres'])}</td><td>{fnum(t['conteneurs'])}</td><td>{fnum(t['evp'])}</td>
    </tr>)}</tbody>
  </table></div>;
}

function FicheBord({ p }: { p: Periode }) {
  const [ouvert, setOuvert] = useState(false);
  const { du, au } = p;
  const { data, loading, error } = useAsync<O | null>(
    () => (ouvert ? call<O>('dashboard.fiche', { du, au }) : Promise.resolve(null)), [ouvert, du, au]);

  const cfs = (data?.['cfs'] ?? {}) as O;
  const t1 = (data?.['t1'] ?? {}) as O;
  const bal = (data?.['balise'] ?? {}) as O;
  const bs = (data?.['bs'] ?? {}) as O;
  const pp = (data?.['pp'] ?? {}) as O;

  return <div className="card" style={{ marginTop: 12 }}>
    {/* Le repli (2026-09-11) : un chevron qui PIVOTE plutôt que deux caractères
        « ▸ / ▾ », dont le dessin variait d'un poste à l'autre. Le mouvement dit
        l'état — ouvert ou fermé — mieux qu'un glyphe. */}
    <button className={`repli ${ouvert ? 'ouvert' : ''}`} onClick={() => setOuvert((v) => !v)}
      aria-expanded={ouvert}>
      <Icone nom="chevron" taille={16} />
      <span>Fiche de synthèse — CFS · T1 · Balise · Bon de sortie · PP</span>
    </button>
    {!ouvert && <div className="help" style={{ marginTop: 6 }}>Appuyez pour déplier la fiche détaillée de la période.</div>}
    {ouvert && (loading ? <Spinner /> : error ? <div className="err-msg">{error}</div> : <div className="fiche-bord">
      <div className="help">Période lue : du {fmtJour(du)} au {fmtJour(au)}. Chaque bloc est compté à la date de SA cellule (CFS = entrée du camion, T1 = saisie, Balise = pose, Bon de sortie = émission, PP = sortie).</div>

      <FicheBloc titre="CFS — Container Freight Station" lignes={[
        [['Conteneurs enlèvement', fnum((cfs['enlevement'] as O)?.['conteneurs'])],
          ['Conteneurs dépotage', fnum((cfs['depotage'] as O)?.['conteneurs'])],
          ['Conteneurs MAD', fnum((cfs['mad'] as O)?.['conteneurs'])],
          ['Total conteneurs', fnum((cfs['total'] as O)?.['conteneurs'])]],
        [['Total camions CFS (enl+dép)', fnum(cfs['camionsCfs'])],
          ['Total camions conso', fnum(cfs['camionsConso'])],
          ['Sorties EVP', fnum((cfs['total'] as O)?.['evp'])]],
      ]} />
      <FicheTailles lignes={[
        ['Enlèvement', (cfs['enlevement'] ?? {}) as O], ['Dépotage', (cfs['depotage'] ?? {}) as O],
        ['Magasin / MAD', (cfs['mad'] ?? {}) as O], ['TOTAL CFS', (cfs['total'] ?? {}) as O],
        ['Sorties PP', (pp['tailles'] ?? {}) as O],
      ]} />

      <FicheBloc titre="T1" lignes={[
        [['T1 émis', fnum(t1['emis'])], ['T1 émis — apurés', fnum(t1['emisApures'])],
          ['T1 émis — non apurés', fnum(t1['emisNonApures'])], ['Taux apurement (émis)', fpct(t1['tauxEmis'])]],
        [['T1 arrivés', fnum(t1['arrives'])], ['T1 arrivés — apurés', fnum(t1['arrivesApures'])],
          ['T1 arrivés — non apurés', fnum(t1['arrivesNonApures'])], ['Taux apurement (arrivée)', fpct(t1['tauxArrives'])]],
      ]} />
      <div className="help">« Arrivés » = T1 dont le bureau de destination est notre bureau (transit reçu) ; « émis » = tous les autres. Apuré = arrivée au bureau confirmée par la cellule Balise.</div>

      <FicheBloc titre="Balise" lignes={[
        [['Total balisé', fnum(bal['total'])], ['Camions balisés (enl+dép)', fnum(bal['camions'])],
          ['Camions au parking', fnum(bal['parking'])], ['Dispenses', fnum(bal['dispenses'])]],
        [['Sortie MAD balisé', fnum(bal['mad'])], ['Camions CFS (enl+dép)', fnum(bal['camionsCfs'])],
          ['Écart CFS ↔ Balise', fnum(bal['ecart'])]],
      ]} />
      <div className="help">« Camions au parking » est un instantané (ce qui est là maintenant), pas un flux de la période.</div>

      <FicheBloc titre="Bon de sortie" lignes={[[['Total bons de sortie', fnum(bs['total'])]]]} />

      <FicheBloc titre="PP — Porte principale" lignes={[
        [['Total sorties PP', fnum(pp['total'])], ['Enlèvement', fnum(pp['enlevement'])],
          ['Dépotage', fnum(pp['depotage'])], ['Sortie MAD', fnum(pp['mad'])]],
        [['Sortie conso', fnum(pp['conso'])], ['Empotages (PIA+ZF)', fnum(pp['empotages'])],
          ['Véhi à nus (S)', fnum(pp['vehicules'])], ['Transferts', fnum(pp['transferts'])]],
      ]} />
      <div className="help">« Empotages (PIA+ZF) » n'est pas encore saisi dans l'application — la case reste à « — » tant qu'aucune cellule ne l'alimente. « Transferts » = conteneurs annoncés par le Port Autonome et confirmés entrés au port sec sur la période.</div>
    </div>)}
  </div>;
}

SCREENS.detail = (nav) => <Detail {...nav} />;
SCREENS.list = (nav) => <CargoList {...nav} filtre={{ categorie: 'camion', ...((nav.arg as O) ?? {}) }} titre="Cargaisons" barre />;

/* ------- v4.1 : onglets regroupés (menu allégé) ----------------------- */
/**
 * Un onglet « hub » : une carte de gros boutons qui ouvrent les écrans
 * regroupés (décision utilisateur 2026-07-27, le menu déroulant était trop
 * long). Les items dépendent du rôle : on n'affiche que ce que le rôle utilise.
 */
/**
 * Grille de raccourcis d'un module.
 *
 * 2026-09-11 — en-tête illustré, et le 3ᵉ champ des items porte désormais un
 * NOM D'ICÔNE au lieu d'un caractère (▦ ◉ ◧ ⮉ ✔…). Mêmes raisons que pour le
 * menu : ces glyphes n'avaient ni graisse ni optique communes, et certains
 * s'affichaient en carré vide sur les postes dépourvus de la police.
 */
function Hub({ nav, titre, desc, items, icone = 'boites', etape }: {
  nav: Nav; titre: string; desc?: string; items: [string, string, string][];
  icone?: string; etape?: string;
}) {
  return <div className="card hub-carte">
    {/* EN-TETE ILLUSTRE (2026-09-12) - le logo de l'ecran de connexion, repris
        ici avec l'icone DU HUB en orbite : conteneur pour le parc, camion pour
        les vehicules. Un hub est une page d'accueil de module ; il merite la
        meme entree que l'ecran de creation, pas un simple titre de ligne. */}
    <div className={`hub-entete ${etape ? 'et-' + etape : ''}`}>
      <div className="hub-logo">
        <span className="hub-piste" aria-hidden="true" />
        <span className="hub-onde" aria-hidden="true" />
        <img className="logo-rond" src="/logo_PIA.jpg" alt=""
          onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }} />
        <span className="hub-orbite" aria-hidden="true">
          <span className="hub-mobile"><Icone nom={icone} taille={15} /></span>
        </span>
      </div>
      <h2>{titre}</h2>
      {desc && <p className="help">{desc}</p>}
    </div>
    <div className="hubgrid">
      {items.map(([s, l, ic]) => <button key={s} className="hubitem" onClick={() => nav.go(s)}>
        <span className="hubic"><Icone nom={ic} taille={20} /></span><span>{l}</span></button>)}
    </div>
  </div>;
}
function itemsConteneurs(role: string): [string, string, string][] {
  const stock: [string, string, string] = ['stock', 'Stock conteneurs', 'conteneur'];
  const pointage: [string, string, string] = ['pointage', 'Pointage matinal', 'presse'];
  const stockjour: [string, string, string] = ['stockjour', 'Stock CFS journalier', 'liste'];
  const imp: [string, string, string] = ['import', 'Stock initial (import)', 'televerser'];
  const impAnn: [string, string, string] = ['importannonce', 'Annonce de transfert', 'megaphone'];
  const annonce: [string, string, string] = ['annonce', 'Stock annoncé', 'boites'];
  const pointEntree: [string, string, string] = ['pointentree', 'Pointage entrée', 'presse'];
  const confEntree: [string, string, string] = ['confentree', 'Confirmer entrée', 'valider'];
  // v4.2 — positionnés / dépotés / restant par jour (demande CFS).
  const depot: [string, string, string] = ['depotstats', 'Statistiques de dépotage', 'rapport'];
  if (role === 'ADMIN') return [stock, pointage, stockjour, depot, imp, impAnn, annonce, pointEntree, confEntree];
  if (role === 'PP') return [annonce, pointEntree, confEntree];
  if (role === 'CFS') return [stock, pointage, stockjour, depot, imp, annonce, confEntree];
  // Chefs : lecture seule, mais les statistiques de dépotage les intéressent.
  return [stock, depot, annonce];
}
SCREENS.conteneurs = (nav) => <Hub nav={nav} titre="Opérations sur conteneurs" icone="conteneur"
  desc="Stock du parc, pointages, imports et entrées annoncées — tout au même endroit." items={itemsConteneurs(nav.user.role)} />;
// v4.1 — MAD & Entrepôt industriel : même module, unité d'apurement différente
// (MAD = colis ; INDUSTRIEL = poids kg).
SCREENS.mad = (nav) => <EcranEntrepot nav={nav} type="MAD" />;
SCREENS.entrepindus = (nav) => <EcranEntrepot nav={nav} type="INDUSTRIEL" />;

/* ------- v4.1 : véhicules = mini tableau de bord + dépotage + liste ---- */
SCREENS.vehicules = (nav) => <VehiculesEcran nav={nav} />;
function VehiculesEcran({ nav }: { nav: Nav }) {
  // Les véhicules dépotés ne sont PAS des camions : suivi à part. Instantané =
  // sans période (présents sur site = non sortis ; sortis = déjà sortis).
  const { data, loading } = useAsync<{ compte: O }>(() => call('report.vehicule', {}), []);
  const cp = (data?.compte ?? {}) as O;
  const peutCreer = nav.user.role === 'CFS' || nav.user.role === 'ADMIN';
  return <>
    <BandeauModule icone="voiture" titre="Véhicules dépotés"
      sous="Sortis d'un conteneur, ils sont suivis à part des camions."
      action={peutCreer ? <button className="bm-action" onClick={() => nav.go('vehnew')}>
        <Icone nom="plus" taille={15} /> Dépotage de véhicules</button> : undefined} />
    <div className="card">
    {loading ? <Spinner /> : <div className="stats">
      <StatCard n={Number(cp['total'] ?? 0)} l="Total véhicules" icone="voiture" />
      <StatCard n={Number(cp['attente'] ?? 0)} l="Présents sur site" tone="warn" icone="entrepot" />
      <StatCard n={Number(cp['sortis'] ?? 0)} l="Sortis" tone="ok" icone="sortie" />
    </div>}
    </div>
    <VehiculeRecherche nav={nav} />
  </>;
}

/**
 * v4.1 — Recherche VÉHICULE par CHÂSSIS ou MARQUE (le champ unique cherche les
 * deux). Résout la plainte : les 6 derniers chiffres du châssis ne trouvaient
 * rien, et la marque n'était pas cherchable du tout.
 */
function VehiculeRecherche({ nav }: { nav: Nav }) {
  const [q, setQ] = useState('');
  const { data, loading } = useAsync<{ rows: O[]; total: number }>(() => call('vehicule.list', { search: q.trim() }), [q]);
  const rows = data?.rows ?? [];
  return <div className="card">
    <TitrePanneau icone="loupe">Rechercher un véhicule</TitrePanneau>
    <input className="mono" value={q} onChange={(e) => setQ(e.target.value)}
      placeholder="N° de châssis (même les 6 derniers chiffres) ou marque…" autoFocus />
    <div className="help lbl-icone" style={{ margin: '8px 0' }}>
      <Icone nom={loading ? 'sablier' : 'voiture'} taille={14} />
      {loading ? 'Recherche…' : `${data?.total ?? 0} véhicule(s)`}</div>
    {loading ? <Spinner /> : <Table
      cols={[['chassis', 'Châssis'], ['marque', 'Marque'], ['modele', 'Modèle'], ['couleur', 'Couleur'], ['destination', 'Destination'], ['statut', 'Statut'], ['conteneurOrigine', 'TC origine']]}
      rows={rows} onRow={(r) => nav.go('detail', r['id'])} />}
  </div>;
}
SCREENS.vehnew = ({ go }) => <>
  <BandeauModule icone="voiture" titre="Dépotage de véhicules"
    sous={<>Un conteneur d'origine, puis un ou plusieurs châssis — un véhicule n'est pas un camion.</>} />
  <div className="card"><FormVehicule go={go} /></div></>;
SCREENS.madsortie = ({ go }) => <div className="card"><h2>Sortie Magasin / MAD</h2><FormMagasin go={go} /></div>;
SCREENS.conso = ({ go }) => <div className="card"><h2>Conso (type C)</h2><FormConso go={go} /></div>;

/* ============ v4.1 : MAD & Entrepôt industriel (module unifié) ========= */
/**
 * Un entrepôt reçoit des ENTRÉES (déclaration + 1..11 articles + conteneurs
 * éventuels) et des SORTIES en vrac (apurement d'un article). MAD apure des
 * quantités (colis), Entrepôt industriel des poids (kg). Le module est le même,
 * seule l'unité change (prop `type`).
 */
type EntrepotType = 'MAD' | 'INDUSTRIEL';
const estIndus = (t: EntrepotType) => t === 'INDUSTRIEL';
const uniteLabel = (t: EntrepotType) => estIndus(t) ? 'Poids (kg)' : 'Nombre de colis';

function EcranEntrepot({ nav, type }: { nav: Nav; type: EntrepotType }) {
  const titre = estIndus(type) ? 'Entrepôt industriel' : 'Magasin / MAD';
  const [onglet, setOnglet] = useState<'entree' | 'sortie' | 'stats' | 'gerer'>('entree');
  const { data, loading, reload } = useAsync<{ rows: O[] }>(() => call('entrepot.list', { type }), [type]);
  const entrepots = (data?.rows ?? []) as O[];
  const peutGerer = ['ADMIN', 'CHEF_BRIGADE', 'CHEF_DIVISION'].includes(nav.user.role);
  const T: [string, string][] = [['entree', 'Entrée'], ['sortie', 'Sortie (apurement)'], ['stats', 'Statistiques']];
  if (peutGerer) T.push(['gerer', 'Entrepôts']);
  return <>
    {/* Bandeau de module, comme sur les autres volets généraux : il porte
        l'identité du magasin et son UNITÉ D'APUREMENT, qui décide de tout ce
        qui suit — des colis d'un côté, des kilos de l'autre. */}
    <BandeauModule icone={estIndus(type) ? 'usine' : 'entrepot'} titre={titre}
      sous={<>Apurement par <b>{estIndus(type) ? 'poids (kg)' : 'quantités (colis)'}</b> - {entrepots.length} magasin(s) en service</>} />
    <div className="card"><div className="row" style={{ alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
      {/* Chaque onglet porte son icône : entrée, sortie, chiffres, gestion —
          quatre gestes distincts, qu'un libellé seul faisait lire comme quatre
          mots de même poids. */}
      {T.map(([k, l]) => <button key={k} className={`onglet-mag ${onglet === k ? '' : 'ghost'}`} onClick={() => setOnglet(k as never)}>
        <Icone nom={({ entree: 'televerser', sortie: 'sortie', stats: 'rapport', gerer: 'entrepot' } as Record<string, string>)[k] ?? 'liste'} taille={15} />
        {l}
      </button>)}
    </div></div>
    {loading ? <Spinner /> : entrepots.length === 0 && onglet !== 'gerer'
      ? <div className="card"><div className="empty">Aucun entrepôt {titre}. {peutGerer ? 'Créez-en un dans l\'onglet « Entrepôts ».' : 'Demandez à un chef d\'en créer un.'}</div></div>
      : onglet === 'entree' ? <EntrepotEntree type={type} entrepots={entrepots} />
        : onglet === 'sortie' ? <EntrepotSortie type={type} entrepots={entrepots} nav={nav} />
          : onglet === 'stats' ? <EntrepotStats type={type} />
            : <EntrepotGerer type={type} reload={reload} admin={nav.user.role === 'ADMIN'} />}
  </>;
}

/**
 * Gestion des entrepôts — création (admin / chef brigade / division), et depuis
 * le 2026-09-11 MODIFICATION par les mêmes, SUPPRESSION par l'ADMIN seul.
 *
 * Trois gestes, et la raison de chacun :
 *   · RENOMMER — une faute de frappe restait affichée pour toujours.
 *   · DÉSACTIVER — un magasin fermé encombrait les listes de saisie. Désactivé,
 *     il en sort tout en gardant son historique consultable ; il se réactive.
 *   · SUPPRIMER — réservé à l'ADMIN, et refusé par le serveur dès qu'une entrée
 *     s'y rattache. Ne sert donc qu'à effacer un magasin créé par erreur.
 *
 * Le TYPE ne se change pas ici : cet écran est déjà cadré par un type (MAD ou
 * industriel), un magasin qui changerait de type disparaîtrait sous les yeux de
 * celui qui vient de le modifier. Créé du mauvais type et encore vierge : on le
 * supprime et on le recrée.
 *
 * La liste inclut ici les magasins DÉSACTIVÉS (`tous: true`) — sans quoi les
 * désactiver reviendrait à les perdre, donc à ne plus pouvoir les réactiver.
 */
function EntrepotGerer({ type, reload, admin }: { type: EntrepotType; reload: () => void; admin: boolean }) {
  const [code, setCode] = useState('');
  const [nom, setNom] = useState('');
  const [busy, setBusy] = useState(false);
  const [n, setN] = useState(0);
  // Édition en place : le code de la ligne en cours de renommage, et le nom saisi.
  const [edit, setEdit] = useState<{ code: string; nom: string } | null>(null);

  const { data, loading } = useAsync<{ rows: O[] }>(() => call('entrepot.list', { type, tous: true }), [type, n]);
  const rows = (data?.rows ?? []) as O[];
  // On rafraîchit CETTE liste et celle du parent : les onglets Entrée / Sortie
  // travaillent sur les seuls entrepôts actifs, une désactivation les concerne.
  const rafraichir = () => { setN((x) => x + 1); reload(); };

  async function agir(travail: () => Promise<unknown>, succes: string) {
    setBusy(true);
    try { await travail(); toast(succes, 'ok'); rafraichir(); }
    catch (e) { toast((e as Error).message, 'err'); } finally { setBusy(false); }
  }

  const pret = !!code.trim() && !!nom.trim();
  const creer = () => {
    // Le garde-fou reste — un clavier peut déclencher le bouton autrement —,
    // mais il ne devrait plus jamais se déclencher : le bouton est désactivé
    // tant que les deux champs ne sont pas remplis. Reprocher un oubli APRÈS
    // le clic est la plus mauvaise façon de le signaler.
    if (!pret) { toast('Renseignez le code ET le nom du magasin.', 'err'); return; }
    return agir(async () => { await call('entrepot.create', { code, nom, type }); setCode(''); setNom(''); }, 'Entrepôt créé.');
  };

  const enregistrerNom = () => {
    if (!edit || !edit.nom.trim()) { toast('Nom requis.', 'err'); return; }
    return agir(async () => { await call('entrepot.edit', { code: edit.code, nom: edit.nom }); setEdit(null); }, 'Nom modifié.');
  };

  function basculer(e: O) {
    const actif = e['actif'] !== false;
    const c = String(e['code']);
    const avertissement = actif
      ? `DÉSACTIVER LE MAGASIN ${c}\n\n`
        + `« ${String(e['nom'])} » ne sera plus proposé à la saisie des entrées ni des\n`
        + `sorties. Son historique reste consultable, et vous pourrez le réactiver.\n\n`
        + `Confirmer ?`
      : `RÉACTIVER LE MAGASIN ${c}\n\n« ${String(e['nom'])} » sera de nouveau proposé à la saisie.\n\nConfirmer ?`;
    if (!window.confirm(avertissement)) return;
    return agir(() => call('entrepot.edit', { code: c, actif: !actif }), actif ? 'Magasin désactivé.' : 'Magasin réactivé.');
  }

  function supprimer(e: O) {
    const c = String(e['code']);
    const motif = window.prompt(
      `⚠ SUPPRESSION DÉFINITIVE DU MAGASIN ${c}\n\n`
      + `« ${String(e['nom'])} » sera effacé de la base. L'opération est inscrite au\n`
      + `journal d'audit et ne peut pas être annulée.\n\n`
      + `Elle sera REFUSÉE si le magasin contient la moindre entrée — dans ce cas,\n`
      + `désactivez-le plutôt.\n\n`
      + `Indiquez le motif :`, '');
    if (motif === null) return;              // l'agent a renoncé
    if (!motif.trim()) { toast('Motif obligatoire.', 'err'); return; }
    if (!window.confirm(`Supprimer définitivement ${c} ?\n\nMotif : ${motif.trim()}`)) return;
    return agir(() => call('entrepot.delete', { code: c, motif }), 'Magasin supprimé.');
  }

  return <div className="card"><h2>Entrepôts {estIndus(type) ? 'industriels' : 'MAD'}</h2>
    <div className="grid2">
      <div><label className="help">Code</label><input className="mono" value={code} onChange={(e) => setCode(masks.alnum(e.target.value))} placeholder="ex. MAD-01" /></div>
      <div><label className="help">Nom</label><input value={nom} onChange={(e) => setNom(masks.upper(e.target.value))} /></div>
    </div>
    <div className="row" style={{ marginTop: 12, alignItems: 'center', gap: 10 }}>
      <button disabled={busy || !pret} onClick={creer}>
        <Icone nom="plus" taille={15} />Créer l'entrepôt
      </button>
      {!pret && <span className="help" style={{ margin: 0 }}>Renseignez le code et le nom pour activer le bouton.</span>}
    </div>

    <div className="section-title" style={{ marginTop: 14 }}>Existants ({rows.length})</div>
    {loading ? <Spinner /> : rows.length === 0 ? <div className="empty">Aucun entrepôt {estIndus(type) ? 'industriel' : 'MAD'}.</div>
      : <div className="tbl"><table>
        <thead><tr><th>Code</th><th>Nom</th><th>Créé par</th><th>État</th><th>Actions</th></tr></thead>
        <tbody>{rows.map((e) => {
          const c = String(e['code']);
          const actif = e['actif'] !== false;
          const enEdition = edit?.code === c;
          return <tr key={c} style={actif ? undefined : { opacity: .6 }}>
            <td className="mono">{c}</td>
            <td>{enEdition
              ? <input value={edit.nom} autoFocus onChange={(ev) => setEdit({ code: c, nom: masks.upper(ev.target.value) })}
                  onKeyDown={(ev) => { if (ev.key === 'Enter') enregistrerNom(); if (ev.key === 'Escape') setEdit(null); }} />
              : String(e['nom'] ?? '')}</td>
            <td>{String(e['creePar'] ?? '—')}</td>
            <td><span className={`pastille-statut ${actif ? 'ok' : 'ko'}`}>{actif ? 'Actif' : 'Désactivé'}</span></td>
            <td><div className="actions-u" style={{ justifyContent: 'flex-start' }}>
              {enEdition
                ? <>
                  <button className="ghost xs" disabled={busy} onClick={enregistrerNom}>Enregistrer</button>
                  <button className="ghost xs" onClick={() => setEdit(null)}>Annuler</button>
                </>
                : <>
                  {/* Icônes plutôt que trois libellés : la colonne passait de
                      280 px à 110, et les mêmes dessins servent déjà dans la
                      liste des comptes — un seul vocabulaire à apprendre. */}
                  <button className="acte" title="Renommer le magasin" aria-label={`Renommer ${c}`}
                    disabled={busy} onClick={() => setEdit({ code: c, nom: String(e['nom'] ?? '') })}><Icone nom="crayon" taille={16} /></button>
                  <button className={`acte ${actif ? 'acte-warn' : 'acte-ok'}`}
                    title={actif ? 'Désactiver le magasin' : 'Réactiver le magasin'}
                    aria-label={`${actif ? 'Désactiver' : 'Réactiver'} ${c}`}
                    disabled={busy} onClick={() => basculer(e)}><Icone nom="interrupteur" taille={16} /></button>
                  {/* Suppression : ADMIN seulement. Le serveur le revérifie. */}
                  {admin && <button className="acte acte-err" title="Supprimer le magasin" aria-label={`Supprimer ${c}`}
                    disabled={busy} onClick={() => supprimer(e)}><Icone nom="poubelle" taille={16} /></button>}
                </>}
            </div></td>
          </tr>;
        })}</tbody>
      </table></div>}
  </div>;
}

/** Champs de déclaration réutilisés (entrée / apurement). */
function DeclEntrepot({ d, set, titre }: { d: O; set: (k: string, v: unknown) => void; titre: string }) {
  return <><div className="section-title">{titre}</div><div className="grid2">
    <div><label className="help">Déclarant</label><input value={String(d['declarant'] ?? '')} onChange={(e) => set('declarant', masks.upper(e.target.value))} /></div>
    <div><label className="help">Bureau</label><input value={String(d['bureauDeclaration'] ?? 'TG120')} onChange={(e) => set('bureauDeclaration', masks.upper(e.target.value))} /></div>
    <div><label className="help">Type décl.</label><select value={String(d['typeDeclaration'] ?? 'T')} onChange={(e) => set('typeDeclaration', e.target.value)}>{TYPES_DECLARATION.map((t) => <option key={t}>{t}</option>)}</select></div>
    <div><label className="help">N° décl.</label><input value={String(d['numeroDeclaration'] ?? '')} onChange={(e) => set('numeroDeclaration', masks.upper(e.target.value))} /></div>
    <div><label className="help">Année</label><input value={String(d['anneeDeclaration'] ?? new Date().getFullYear())} onChange={(e) => set('anneeDeclaration', e.target.value)} /></div>
  </div></>;
}

/** Entrée : déclaration + jusqu'à 11 articles + conteneurs éventuels. */
function EntrepotEntree({ type, entrepots }: { type: EntrepotType; entrepots: O[] }) {
  const [code, setCode] = useState('');
  const [d, setD] = useState<O>({ bureauDeclaration: 'TG120', typeDeclaration: 'T', anneeDeclaration: String(new Date().getFullYear()) });
  const artVide = () => ({ designation: '', nbColis: '', poids: '' });
  const [arts, setArts] = useState<O[]>([artVide()]);
  // v4.2 — la marchandise arrive CONTENEURISÉE dans la grande majorité des cas :
  // la case est cochée d'emblée, on la décoche pour le vrac (décision utilisateur).
  const [conteneurise, setConteneurise] = useState(true);
  // v4.2 — saisie manuelle : la liste ne propose que les conteneurs POSITIONNÉS
  // au CFS. Un conteneur arrivé hors de ce circuit (partagé, positionné après le
  // pointage) n'y figure pas ; sans cette bascule, l'agent restait bloqué.
  const [manuelTC, setManuelTC] = useState(false);
  const [conts, setConts] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const set = (k: string, v: unknown) => setD((o) => ({ ...o, [k]: v }));
  const majArt = (i: number, k: string, v: unknown) => setArts((a) => a.map((x, j) => j === i ? { ...x, [k]: v } : x));
  const { data: stk } = useAsync<{ rows: O[] }>(
    () => (conteneurise && !manuelTC ? call('stock.list', { statut: 'Positionné' }) : Promise.resolve({ rows: [] })),
    [conteneurise, manuelTC],
  );
  const tcs = ((stk?.rows ?? []) as O[]).map((r) => String(r['numeroTC'] ?? '')).filter(Boolean);

  async function envoyer() {
    if (!code) { toast('Choisissez un entrepôt.', 'err'); return; }
    const articles = arts.filter((a) => String(a['designation']).trim() || a['nbColis'] || a['poids']);
    if (!articles.length) { toast('Renseignez au moins un article.', 'err'); return; }
    setBusy(true);
    try {
      await call('entrepot.entree', { entrepotCode: code, declaration: d, conteneurise, conteneurs: conts, articles });
      toast('Entrée enregistrée.', 'ok');
      setD({ bureauDeclaration: 'TG120', typeDeclaration: 'T', anneeDeclaration: String(new Date().getFullYear()) });
      setArts([artVide()]); setConteneurise(true); setManuelTC(false); setConts([]);
    } catch (e) { toast((e as Error).message, 'err'); } finally { setBusy(false); }
  }

  return <div className="card"><h2>Nouvelle entrée</h2>
    <label className="help">Entrepôt</label>
    <select value={code} onChange={(e) => setCode(e.target.value)}><option value="">— Choisir —</option>
      {entrepots.map((x) => <option key={String(x['code'])} value={String(x['code'])}>{String(x['nom'])} ({String(x['code'])})</option>)}</select>
    <DeclEntrepot d={d} set={set} titre="Déclaration d'origine (sommier)" />

    <div className="row" style={{ alignItems: 'center', marginTop: 12 }}>
      <div className="section-title" style={{ flex: 1, margin: 0 }}>Articles ({arts.length}/11)</div>
      <button className="ghost xs" disabled={arts.length >= 11} onClick={() => setArts((a) => [...a, artVide()])}>＋ Ajouter un article</button>
    </div>
    {arts.map((a, i) => <div key={i} className="grid2" style={{ border: '1px solid var(--line)', borderRadius: 6, padding: 8, marginTop: 6 }}>
      <div><label className="help">Désignation article {i + 1}</label><input value={String(a['designation'])} onChange={(e) => majArt(i, 'designation', masks.upper(e.target.value))} /></div>
      <div><label className="help">Nombre de colis</label><input value={String(a['nbColis'])} onChange={(e) => majArt(i, 'nbColis', e.target.value.replace(/[^0-9]/g, ''))} /></div>
      {estIndus(type) && <div><label className="help">Poids (kg)</label><input value={String(a['poids'])} onChange={(e) => majArt(i, 'poids', e.target.value.replace(/[^0-9.,]/g, ''))} /></div>}
      {arts.length > 1 && <div style={{ alignSelf: 'end' }}><button className="ghost xs" onClick={() => setArts((x) => x.filter((_, j) => j !== i))}>Retirer</button></div>}
    </div>)}

    <label className="help" style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 14 }}>
      <input type="checkbox" style={{ width: 'auto' }} checked={conteneurise} onChange={(e) => setConteneurise(e.target.checked)} />
      <span>Marchandise <b>conteneurisée</b> à l'arrivée <span style={{ fontWeight: 400 }}>— décochez pour du vrac</span></span>
    </label>
    {conteneurise && <div style={{ marginTop: 6 }}>
      <label className="help" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <input type="checkbox" style={{ width: 'auto' }} checked={manuelTC} onChange={(e) => setManuelTC(e.target.checked)} />
        <span>Saisie manuelle (conteneur absent de la liste du CFS)</span>
      </label>
      <label className="help" style={{ marginTop: 6 }}>
        {manuelTC
          ? 'Conteneurs — saisie libre, sans contrôle sur le stock du jour'
          : `Conteneurs — ${tcs.length} positionné(s) au CFS proposé(s) à la frappe`}
      </label>
      {!manuelTC && <datalist id="dl-ent-tc">{tcs.map((t) => <option key={t} value={t} />)}</datalist>}
      {conts.map((c, i) => <div key={i} className="row" style={{ marginTop: 4 }}>
        <input className="mono" value={c} {...(manuelTC ? {} : { list: 'dl-ent-tc' })}
          onChange={(e) => setConts((a) => a.map((x, j) => j === i ? masks.tc(e.target.value) : x))} style={{ flex: 1 }} />
        <button className="ghost xs" onClick={() => setConts((a) => a.filter((_, j) => j !== i))}>Retirer</button>
      </div>)}
      <button className="ghost xs" style={{ marginTop: 6 }} onClick={() => setConts((a) => [...a, ''])}>＋ Conteneur</button>
    </div>}

    <div style={{ marginTop: 14 }}><button disabled={busy} onClick={envoyer}>{busy ? 'Enregistrement…' : 'Enregistrer l\'entrée'}</button></div>
  </div>;
}

/** Sortie / apurement : choisir entrepôt → entrée → article → quantité + déclaration d'apurement + véhicules. */
function EntrepotSortie({ type, entrepots, nav }: { type: EntrepotType; entrepots: O[]; nav: Nav }) {
  void nav;
  const [code, setCode] = useState('');
  const { data, loading, reload } = useAsync<{ unite: string; rows: O[] }>(
    () => (code ? call('entrepot.entrees', { entrepotCode: code }) : Promise.resolve({ unite: 'colis', rows: [] })), [code]);
  const entrees = (data?.rows ?? []) as O[];
  const [entreeId, setEntreeId] = useState('');
  const [numeroArticle, setNumeroArticle] = useState('1');
  const [dApu, setDApu] = useState<O>({ bureauDeclaration: 'TG120', typeDeclaration: 'T', anneeDeclaration: String(new Date().getFullYear()) });
  const [qte, setQte] = useState('');
  // v4.1 — la marchandise (vrac) sort sur un CAMION scellé : N° camion + scellés.
  const [numCamion, setNumCamion] = useState('');
  const [scelles, setScelles] = useState(['', '', '']);
  const [busy, setBusy] = useState(false);
  const set = (k: string, v: unknown) => setDApu((o) => ({ ...o, [k]: v }));
  const entree = entrees.find((e) => e['id'] === entreeId);
  const articles = (entree?.['articles'] as O[]) ?? [];
  const art = articles[Number(numeroArticle) - 1];

  /* v4.2 — BALISE / DISPENSE sur la marchandise qui sort.
   * Le camion qui emporte le vrac apuré doit être balisé ou non selon le TYPE de
   * la déclaration d'apurement : un transit (T) l'est par nature, les types C
   * (consommation) et A (admission) laissent le choix. Le cas courant étant la
   * SORTIE SANS BALISE, c'est le défaut proposé — l'agent coche pour baliser. */
  const apuSansT1 = estTypeSansT1(dApu['typeDeclaration']);
  const [baliseRequise, setBaliseRequise] = useState(false);

  async function envoyer() {
    if (!entreeId || !art) { toast('Choisissez l\'entrée et l\'article à apurer.', 'err'); return; }
    if (!qte) { toast('Quantité à apurer requise.', 'err'); return; }
    setBusy(true);
    try {
      const payload: O = {
        entreeId, numeroArticle: Number(numeroArticle), declarationApurement: dApu,
        numeroCamion: numCamion, scelles: scelles.filter(Boolean),
        designation: art['designation'],
        // v4.2 — décision balise, n'a de sens que pour les types C et A.
        baliseRequise: apuSansT1 ? baliseRequise : undefined,
      };
      if (estIndus(type)) payload['poids'] = qte; else payload['nbColis'] = qte;
      const r = await call<{ restantApres: number }>('entrepot.sortie', payload);
      toast(`Sortie enregistrée. Restant : ${r.restantApres}.`, 'ok');
      setQte(''); setNumCamion(''); setScelles(['', '', '']); reload();
    } catch (e) { toast((e as Error).message, 'err'); } finally { setBusy(false); }
  }

  return <div className="card"><h2>Sortie (apurement) — vrac</h2>
    <label className="help">Entrepôt</label>
    <select value={code} onChange={(e) => { setCode(e.target.value); setEntreeId(''); }}><option value="">— Choisir —</option>
      {entrepots.map((x) => <option key={String(x['code'])} value={String(x['code'])}>{String(x['nom'])} ({String(x['code'])})</option>)}</select>
    {code && (loading ? <Spinner /> : <>
      <label className="help" style={{ marginTop: 10 }}>Déclaration à apurer (entrée)</label>
      <select value={entreeId} onChange={(e) => { setEntreeId(e.target.value); setNumeroArticle('1'); }}><option value="">— Choisir une entrée —</option>
        {entrees.map((e) => <option key={String(e['id'])} value={String(e['id'])}>
          {String(e['numeroDeclaration'])} · {String(e['anneeDeclaration'])} · {String(e['typeDeclaration'])} — {(e['articles'] as O[]).length} article(s)
        </option>)}</select>
      {entree && <>
        <label className="help" style={{ marginTop: 10 }}>Article à apurer</label>
        <select value={numeroArticle} onChange={(e) => setNumeroArticle(e.target.value)}>
          {articles.map((a, i) => <option key={i} value={String(i + 1)}>N°{i + 1} — {String(a['designation'] || '(sans désignation)')} · restant {String(a['restant'])} {data?.unite === 'poids' ? 'kg' : 'colis'}</option>)}
        </select>
        <div className="help" style={{ marginTop: 4 }}>Restant sur cet article : <b>{String(art?.['restant'] ?? 0)}</b> {data?.unite === 'poids' ? 'kg' : 'colis'}.</div>
        <div className="grid2" style={{ marginTop: 8 }}>
          <div><label className="help">{estIndus(type) ? 'Poids à apurer (kg)' : 'Colis à apurer'}</label>
            <input value={qte} onChange={(e) => setQte(e.target.value.replace(estIndus(type) ? /[^0-9.,]/g : /[^0-9]/g, ''))} /></div>
        </div>
        <DeclEntrepot d={dApu} set={set} titre="Déclaration d'apurement (même que l'origine ou différente)" />
        {/* v4.2 — le choix n'apparaît que pour les types C et A : un transit est
            balisé par nature, poser la question n'aurait pas de sens. */}
        {apuSansT1 && <div style={{ marginTop: 8 }}>
          <label className="help">Type {String(dApu['typeDeclaration'])} — balise du camion de sortie</label>
          <select value={baliseRequise ? 'balise' : 'sansbalise'} onChange={(e) => setBaliseRequise(e.target.value === 'balise')}>
            <option value="sansbalise">À ne pas baliser (cas courant)</option>
            <option value="balise">À baliser</option>
          </select>
          <p className="help" style={{ marginTop: 4 }}>
            {libelleTypeSansT1(dApu['typeDeclaration'])} : {baliseRequise
              ? <>le camion emportant la marchandise <b>doit être balisé</b>.</>
              : <>le camion emportant la marchandise <b>sort sans balise</b>.</>}
          </p>
        </div>}
        <div className="section-title" style={{ marginTop: 12 }}>Camion</div>
        <div className="grid2">
          <ChampCamion value={numCamion} onChange={setNumCamion} label="N° camion" />
          {[0, 1, 2].map((k) => <div key={k}><label className="help">Scellé {k + 1}</label>
            <input value={scelles[k] ?? ''} onChange={(e) => setScelles((a) => a.map((x, j) => j === k ? masks.upper(e.target.value) : x))} /></div>)}
        </div>
        <div style={{ marginTop: 14 }}><button disabled={busy} onClick={envoyer}>{busy ? 'Enregistrement…' : 'Enregistrer la sortie'}</button></div>
      </>}
    </>)}
  </div>;
}

/**
 * Statistiques : entrées / sorties / restant, par magasin (MAD) ou entrepôt
 * (industriel) et par déclaration — avec TIROIRS (v4.1, décision client) :
 * cliquer un magasin ouvre le détail de ses entrées/articles ; cliquer une
 * quantité apurée ouvre la liste des déclarations venues apurer.
 */
function EntrepotStats({ type }: { type: EntrepotType }) {
  const indus = estIndus(type);
  const lib = indus ? 'Entrepôt' : 'Magasin';
  const { data, loading } = useAsync<O>(() => call('entrepot.stats', { type }), [type]);
  const u = String(data?.['unite'] ?? 'colis') === 'poids' ? 'kg' : 'colis';
  const ents = (data?.['entrepots'] ?? []) as O[];
  const decls = (data?.['parDeclaration'] ?? []) as O[];
  const [sel, setSel] = useState<O | null>(null);
  if (loading) return <Spinner />;
  return <>
    <div className="card"><h2>Par {lib.toLowerCase()} ({u})</h2>
      <p className="help" style={{ marginTop: 0 }}>Cliquez un {lib.toLowerCase()} pour voir le détail des entrées et des apurements.</p>
      <Table cols={[['nom', lib], ['entrees', `Entrées (${u})`], ['sorties', `Sorties (${u})`], ['restant', `Restant (${u})`]]}
        icones={{ nom: indus ? 'usine' : 'entrepot' }}
        rows={ents} onRow={(r) => setSel(r)} /></div>
    <div className="card"><h2>Par déclaration ({u})</h2>
      {decls.length === 0 ? <div className="empty">Aucune entrée enregistrée.</div>
        : <Table cols={[['libelle', 'Déclaration'], ['entrepotCode', lib], ['entrees', `Entrées (${u})`], ['sorties', `Sorties (${u})`], ['restant', `Restant (${u})`]]}
          icones={{ libelle: 'document', entrepotCode: indus ? 'usine' : 'entrepot' }} rows={decls} />}
    </div>
    {sel && <DetailEntrepotStats entrepot={sel} unite={u} lib={lib} onClose={() => setSel(null)} />}
  </>;
}

/** Tiroir d'un magasin/entrepôt : ses entrées, chaque article (entrée / apuré / restant). */
function DetailEntrepotStats({ entrepot, unite, lib, onClose }: { entrepot: O; unite: string; lib: string; onClose: () => void }) {
  const code = String(entrepot['code']);
  const { data, loading } = useAsync<{ rows: O[] }>(() => call('entrepot.entrees', { entrepotCode: code }), [code]);
  const entrees = (data?.rows ?? []) as O[];
  const [apur, setApur] = useState<{ entreeId: string; numero: number; designation: string } | null>(null);
  return <Modal onClose={onClose}>
    <h2><span className="tp-pastille" aria-hidden="true"><Icone nom="entrepot" taille={18} /></span>{lib} {String(entrepot['nom'])} ({code})</h2>
    <div className="help" style={{ marginBottom: 8 }}>Entrées : {String(entrepot['entrees'])} {unite} · Sorties : {String(entrepot['sorties'])} {unite} · Restant : <b>{String(entrepot['restant'])}</b> {unite}</div>
    {loading ? <Spinner /> : entrees.length === 0 ? <div className="empty">Aucune entrée.</div>
      : entrees.map((e) => <div key={String(e['id'])} style={{ border: '1px solid var(--line)', borderRadius: 6, padding: 10, marginTop: 10 }}>
        <div className="row" style={{ alignItems: 'center' }}>
          <b className="mono" style={{ flex: 1 }}>{[e['numeroDeclaration'], e['anneeDeclaration'], e['bureauDeclaration'], e['typeDeclaration']].filter(Boolean).join(' · ')}</b>
          <span className="help">{fmtDate(e['dateEntree'])}</span>
        </div>
        <div className="help">Déclarant {String(e['declarant'] || '—')}{e['conteneurise'] ? ` · conteneurs : ${((e['conteneurs'] as string[]) || []).join(', ') || '—'}` : ''}</div>
        <div className="tbl" style={{ marginTop: 6 }}><table>
          <thead><tr><th>Art.</th><th>Désignation</th><th>Entrée</th><th>Apuré</th><th>Restant</th></tr></thead>
          <tbody>{(e['articles'] as O[]).map((a) => <tr key={String(a['numero'])}>
            <td>{String(a['numero'])}</td><td>{String(a['designation'] || '—')}</td>
            <td>{String(a['initial'])}</td>
            <td>{Number(a['sorti']) > 0
              ? <button className="ghost xs" onClick={() => setApur({ entreeId: String(e['id']), numero: Number(a['numero']), designation: String(a['designation'] || '') })}>{String(a['sorti'])} ▸</button>
              : '0'}</td>
            <td><b>{String(a['restant'])}</b></td>
          </tr>)}</tbody>
        </table></div>
      </div>)}
    {apur && <DetailApurements code={code} apur={apur} unite={unite} onClose={() => setApur(null)} />}
  </Modal>;
}

/** Tiroir « quantité apurée » : les déclarations venues apurer un article. */
function DetailApurements({ code, apur, unite, onClose }: { code: string; apur: { entreeId: string; numero: number; designation: string }; unite: string; onClose: () => void }) {
  const { data, loading } = useAsync<{ rows: O[] }>(
    () => call('entrepot.sorties', { entrepotCode: code, entreeId: apur.entreeId, numeroArticle: apur.numero }), [code, apur.entreeId, apur.numero]);
  const champ = unite === 'kg' ? 'poids' : 'nbColis';
  const rows = ((data?.rows ?? []) as O[]).map((r) => {
    const scelles = ((r['scelles'] as string[]) || []).filter(Boolean);
    // Sorties récentes : N° camion + scellés. Anciennes : liste de châssis (véhicules).
    const camion = r['numeroCamion']
      ? `${String(r['numeroCamion'])}${scelles.length ? ` (scellés ${scelles.join(', ')})` : ''}`
      : ((r['vehicules'] as O[]) || []).map((v) => String(v['chassis'] ?? '')).filter(Boolean).join(', ');
    return { ...r, camion: camion || '—' };
  });
  return <Modal onClose={onClose}>
    <h2><span className="tp-pastille" aria-hidden="true"><Icone nom="boites" taille={18} /></span>Apurements — article n°{apur.numero}{apur.designation ? ` (${apur.designation})` : ''}</h2>
    <p className="help" style={{ marginTop: 0 }}>Déclarations venues apurer cet article ({unite}).</p>
    {loading ? <Spinner /> : rows.length === 0 ? <div className="empty">Aucun apurement.</div>
      : <Table cols={[['declaration', 'Déclaration d\'apurement'], [champ, `Quantité (${unite})`], ['dateSortie', 'Date'], ['camion', 'Camion / scellés'], ['agent', 'Agent']]} rows={rows} />}
  </Modal>;
}

/**
 * AVIS D'ÉCHEC D'AFFICHAGE APRÈS UNE SIGNATURE — 2026-09-11.
 *
 * Mesuré sur la base réelle : la signature (`cargo.validerlot`) aboutit, puis
 * le `reload()` qui la suit — la requête LOURDE de l'écran — échoue une fois
 * sur trois environ (HTTP 546, worker tué faute de ressources). Le chef voyait
 * alors un message ROUGE, en concluait que sa validation n'était pas passée, et
 * recliquait. Pour un ADMIN, recliquer écrit une seconde ligne dans
 * `validations` : du bruit dans la trace probante, causé par un simple défaut
 * d'affichage.
 *
 * Quand une signature vient d'aboutir, l'erreur qui suit ne parle donc plus
 * d'échec : elle dit ce qui est acquis, ce qui a manqué, et quoi faire.
 */
function AvisApresSignature({ error, signee }: { error: string; signee: number }) {
  if (!signee) return <div className="err-msg">{error}</div>;
  return <div className="avis-signature">
    <b>✔ {signee} cargaison(s) ont bien été signées.</b> Seul l'affichage de la liste n'a pas pu se
    rafraîchir — <b>ne resignez pas</b>. Rouvrez l'écran dans quelques secondes pour le voir à jour.
    <span className="detail">Détail technique : {error}</span>
  </div>;
}

SCREENS.completer = (nav) => <CargoList {...nav} filtre={{ etape: 'CFS' }} titre="À compléter (CFS)" />;
SCREENS.wait_valid = (nav) => <ValidationDeclaration {...nav} />;
SCREENS.wait_cfs = (nav) => <CargoList {...nav} filtre={{ etape: 'CFS' }} titre="En cours au CFS" />;
SCREENS.wait_t1 = (nav) => <CargoList {...nav} filtre={{ etape: 'T1' }} titre="En attente T1" />;
SCREENS.wait_gps = (nav) => <CargoList {...nav} filtre={{ etape: 'BALISE' }} titre="En attente Balise" />;
SCREENS.wait_bs = (nav) => <CargoList {...nav} filtre={{ etape: 'BS' }} titre="En attente Bon de Sortie" />;
SCREENS.wait_sortie = (nav) => <CargoList {...nav} filtre={{ etape: 'PP' }} titre="En attente de sortie" />;
SCREENS.t1 = (nav) => <CargoList {...nav} filtre={{ etape: 'T1' }} titre="Cellule T1 — cargaisons en attente" />;
SCREENS.gps = (nav) => <CargoList {...nav} filtre={{ etape: 'BALISE' }} titre="Cellule Balise — cargaisons en attente" />;
SCREENS.bonsortie = (nav) => <CargoList {...nav} filtre={{ etape: 'BS' }} titre="Cellule Bon de Sortie — en attente" />;
SCREENS.sortie = (nav) => <CargoList {...nav} filtre={{ etape: 'PP' }} titre="Sortie — cargaisons prêtes" />;

/* --------------------------- Créer un camion --------------------------- */
/**
 * v4.1 — CHARGEMENT MIXTE SUR UN EXISTANT (décision utilisateur 2026-07-27 ;
 * existait dans l'Apps Script). À la création d'un camion / véhicule, si un
 * autre du MÊME numéro est déjà présent à un statut ENCORE MODIFIABLE (Camion
 * créé / En cours de chargement / Créée), on propose de l'OUVRIR pour y ajouter
 * (mixte) au lieu de créer un doublon. S'appuie sur cargo.checkdup.
 */
const STATUTS_EDITABLES = [STATUTS.CAMION, STATUTS.CHARGEMENT, STATUTS.CREEE] as string[];
/**
 * Analyse anti-doublons à la saisie d'un N° :
 *   · `mixte`      — un existant ACTIF encore modifiable (même N° exact) → on
 *                    propose de l'ouvrir en chargement mixte ;
 *   · `similaires` — des N° actifs TRÈS RESSEMBLANTS (faute de frappe probable)
 *                    → on avertit (jamais bloquant, décision 2026-08-19).
 */
async function analyserDoublons(num: string): Promise<{ mixte: O | null; similaires: O[] }> {
  if (!num.trim()) return { mixte: null, similaires: [] };
  try {
    const r = await call<{ camion: O[]; similaires: O[] }>('cargo.checkdup', { numeroCamion: num });
    const mixte = (r.camion ?? []).find((c) => c['actif'] && STATUTS_EDITABLES.includes(String(c['statut']))) ?? null;
    return { mixte, similaires: r.similaires ?? [] };
  } catch { return { mixte: null, similaires: [] }; }
}
/** Modale « ce numéro existe déjà » : ouvrir (mixte) / créer quand même / annuler. */
function ModaleMixte({ match, quoi, onOuvrir, onCreer, onAnnuler }: {
  match: O; quoi: string; onOuvrir: () => void; onCreer: () => void; onAnnuler: () => void;
}) {
  return <Modal onClose={onAnnuler}>
    <h2><span className="tp-pastille" aria-hidden="true"><Icone nom="camion" taille={18} /></span>Ce {quoi} existe déjà</h2>
    <p className="help" style={{ marginTop: 0 }}>
      <b className="mono">{String(match['numeroCamion'])}</b> est déjà enregistré (statut « {String(match['statut'])} »),
      encore en cours de saisie. Voulez-vous l'<b>ouvrir pour y ajouter</b> (chargement mixte) plutôt que d'en créer un nouveau&nbsp;?
    </p>
    <div className="row" style={{ marginTop: 12, flexWrap: 'wrap' }}>
      <button onClick={onOuvrir}>Ouvrir « {String(match['numeroCamion'])} » (chargement mixte)</button>
      <button className="ghost" onClick={onCreer}>Créer un nouveau {quoi}</button>
      <button className="ghost" onClick={onAnnuler}>Annuler</button>
    </div>
  </Modal>;
}

/**
 * Modale « N° ressemblant » (quasi-doublon) : la saisie ressemble fortement à un
 * ou plusieurs {quoi}s actifs. On propose d'OUVRIR le bon dossier (faute de
 * frappe) ou de CONFIRMER un nouveau {quoi}. Jamais bloquant.
 */
function ModaleSimilaires({ similaires, quoi, onOuvrir, onCreer, onAnnuler }: {
  similaires: O[]; quoi: string; onOuvrir: (id: string) => void; onCreer: () => void; onAnnuler: () => void;
}) {
  const plur = similaires.length > 1;
  return <Modal onClose={onAnnuler}>
    <h2><span className="tp-pastille" aria-hidden="true"><Icone nom="loupe" taille={18} /></span>Ce numéro ressemble à un {quoi} existant</h2>
    <p className="help" style={{ marginTop: 0 }}>
      Le numéro saisi ressemble de très près à {plur ? `des ${quoi}s déjà enregistrés` : `un ${quoi} déjà enregistré`},
      encore présent{plur ? 's' : ''} dans l'enceinte — peut-être une <b>faute de frappe</b>.
      Si c'est le même, ouvrez le bon dossier ; sinon, confirmez qu'il s'agit bien d'un <b>nouveau</b> {quoi}.
    </p>
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, margin: '8px 0' }}>
      {similaires.map((c) => <button key={String(c['id'])} className="ghost mono" style={{ justifyContent: 'flex-start', textAlign: 'left' }}
        onClick={() => onOuvrir(String(c['id']))}>
        Ouvrir « {String(c['numeroCamion'])} » — statut « {String(c['statut'])} »
      </button>)}
    </div>
    <div className="row" style={{ marginTop: 12, flexWrap: 'wrap' }}>
      <button onClick={onCreer}>Non, c'est un nouveau {quoi} — créer</button>
      <button className="ghost" onClick={onAnnuler}>Annuler</button>
    </div>
  </Modal>;
}

/**
 * ARRIVEE SUR LE SITE - pied de l'ecran de creation (2026-09-12).
 *
 * Pendant a la scene de quai de l'ecran de connexion, mais racontant l'etape
 * SUIVANTE : le camion se presente au poste d'entree de la PIA, la barriere
 * se leve, il franchit le portail et rentre sur le parc. C'est exactement le
 * geste que l'agent est en train d'enregistrer au-dessus.
 *
 * SVG dessine a la main, aucune image : `netlify.toml` interdit les ressources
 * tierces. Tout le mouvement est en CSS (`@keyframes pia-*`), sur UN SEUL
 * cycle partage - c'est ce qui garantit que la barriere se leve quand le
 * camion est devant, et pas dans le vide. Decoratif : `aria-hidden`, et
 * neutralise en << mouvement reduit >>.
 */
function SceneEntreePIA() {
  return (
    <div className="entree-pia" aria-hidden="true">
      <svg viewBox="0 0 600 118" preserveAspectRatio="xMidYMax meet" width="100%" height="100%">
        {/* LE PARC, derriere la cloture : des piles de conteneurs en retrait.
            Volontairement pales - c'est l'arriere-plan, pas le sujet. */}
        <g opacity="0.42">
          <rect x="452" y="74" width="42" height="15" rx="2" fill="#0e5a8a" />
          <rect x="452" y="59" width="42" height="15" rx="2" fill="#b4531f" />
          <rect x="498" y="74" width="42" height="15" rx="2" fill="#1f7a5c" />
          <rect x="544" y="74" width="42" height="15" rx="2" fill="#b4531f" />
          <rect x="544" y="59" width="42" height="15" rx="2" fill="#0e5a8a" />
        </g>
        {/* La cloture du parc, a droite du portail. */}
        <g stroke="#c3d0da" strokeWidth="2" strokeLinecap="round">
          <path d="M546 89 H600" />
          <path d="M552 89 V78 M566 89 V78 M580 89 V78 M594 89 V78" />
        </g>

        {/* LA CHAUSSEE : la bande sur laquelle tout se pose. */}
        <rect x="0" y="89" width="600" height="29" fill="#e2e8ee" />
        <rect x="0" y="89" width="600" height="3" fill="#c9d5df" />
        <path d="M0 104 H600" stroke="#cfdae3" strokeWidth="3" strokeDasharray="20 16" />

        {/* LE PORTAIL : deux piles et le bandeau qui porte le nom du site. */}
        <rect x="404" y="34" width="10" height="55" rx="2" fill="#8ea0b0" />
        <rect x="530" y="34" width="10" height="55" rx="2" fill="#8ea0b0" />
        <rect x="396" y="18" width="152" height="19" rx="4" fill="#0e5a8a" />
        <text x="472" y="32" textAnchor="middle" fill="#ffffff"
          fontSize="12" fontWeight="700" letterSpacing="2.5">PIA</text>

        {/* LE POSTE DE GARDE, a l'ecart de la voie. */}
        <path d="M548 60 h46 l-6 -9 h-34 z" fill="#8ea0b0" />
        <rect x="552" y="60" width="38" height="29" rx="2" fill="#eef3f7" stroke="#c3d0da" strokeWidth="1.5" />
        <rect x="559" y="66" width="24" height="14" rx="2" fill="#9fb6c8" />

        {/* LA BARRIERE : elle pivote sur son pied, a gauche de la voie. Le
            pivot est pose en unites du viewBox (`transform-box:view-box`),
            sinon la barre tournerait autour du centre de sa propre boite et
            decollerait du pied. */}
        <rect x="330" y="66" width="8" height="23" rx="2" fill="#7c8fa0" />
        <circle className="pia-temoin" cx="334" cy="62" r="3.4" fill="#d94f2a" />
        <g className="pia-barriere">
          <rect x="333" y="70" width="96" height="7" rx="3.5" fill="#ffffff" stroke="#b4531f" strokeWidth="1.6" />
          <path d="M348 73.5 h13 M378 73.5 h13 M408 73.5 h13" stroke="#d94f2a" strokeWidth="7" />
        </g>

        {/* LE CAMION : il arrive de la route, marque l'arret au poste, puis
            franchit le portail. Dessine autour de l'origine, positionne par
            l'animation seule. */}
        <g className="pia-camion">
          <rect x="0" y="60" width="70" height="27" rx="3" fill="#1f7a5c" />
          <path d="M12 62 V85 M26 62 V85 M40 62 V85 M54 62 V85" stroke="rgba(255,255,255,.35)" strokeWidth="2" />
          <rect x="-2" y="86" width="104" height="5" rx="2" fill="#44586b" />
          <path d="M74 86 V64 h18 l14 16 v6 z" fill="#32485c" />
          <rect x="79" y="68" width="16" height="11" rx="2" fill="#cfdbe5" />
          <circle cx="16" cy="92" r="7" fill="#2b3b49" />
          <circle cx="44" cy="92" r="7" fill="#2b3b49" />
          <circle cx="90" cy="92" r="7" fill="#2b3b49" />
          <circle cx="16" cy="92" r="2.6" fill="#7f8e9c" />
          <circle cx="44" cy="92" r="2.6" fill="#7f8e9c" />
          <circle cx="90" cy="92" r="2.6" fill="#7f8e9c" />
        </g>
      </svg>
    </div>
  );
}

SCREENS.creercamion = ({ go }) => {
  const [num, setNum] = useState('');
  const [routage, setRoutage] = useState(OPERATIONS.ENLEVEMENT as string);
  const [busy, setBusy] = useState(false);
  const verrou = useRef(false); // double clic : cf. useEnvoiUnique
  const [match, setMatch] = useState<O | null>(null);
  const [simil, setSimil] = useState<O[] | null>(null);
  async function faireCreer() {
    if (verrou.current) return;
    verrou.current = true;
    setBusy(true);
    try {
      const r = await call<{ id: string }>('cargo.createcamion', { numeroCamion: num, routage });
      toast('Camion créé.', 'ok'); go('detail', r.id);
    } catch (e) { toast((e as Error).message, 'err'); } finally { verrou.current = false; setBusy(false); }
  }
  async function creer() {
    if (!num) { toast('N° camion requis.', 'err'); return; }
    setBusy(true);
    const { mixte, similaires } = await analyserDoublons(num);
    setBusy(false);
    if (mixte) { setMatch(mixte); return; }          // même N° exact → chargement mixte
    if (similaires.length) { setSimil(similaires); return; } // N° ressemblant → avertir
    await faireCreer();
  }
  return <div className="ecran-creer"><div className="card" style={{ maxWidth: 520 }}>
    {/* EN-TÊTE ILLUSTRÉ (2026-09-11) — le logo comme sur l'écran de connexion,
        mais l'animation raconte ici ce qu'on vient y faire : un camion ENTRE
        dans le cercle, puis un « + » apparaît. L'écran de connexion montre un
        suivi ; celui-ci montre une création. */}
    <div className="creer-entete">
      <div className="creer-logo">
        <span className="creer-piste" aria-hidden="true" />
        <span className="creer-onde" aria-hidden="true" />
        <img className="logo-rond" src="/logo_PIA.jpg" alt=""
          onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }} />
        <span className="creer-camion" aria-hidden="true"><Icone nom="camion" taille={17} /></span>
        <span className="creer-plus" aria-hidden="true"><Icone nom="plus" taille={14} /></span>
      </div>
      <h2>Créer un camion à l'entrée</h2>
      <p className="help">Le CFS crée le camion vide et choisit le type d'opération ;
        l'association des conteneurs se fait ensuite dans le détail.</p>
    </div>
    <ChampCamion value={num} onChange={setNum} label="N° camion" />
    <label className="help">Type d'opération</label>
    <select value={routage} onChange={(e) => setRoutage(e.target.value)}><option>{OPERATIONS.ENLEVEMENT}</option><option>{OPERATIONS.DEPOTAGE}</option></select>
    <div style={{ marginTop: 12 }}><button disabled={busy} onClick={creer}>Créer</button></div>
    {match && <ModaleMixte match={match} quoi="camion"
      onOuvrir={() => { setMatch(null); go('detail', match['id']); }}
      onCreer={() => { setMatch(null); faireCreer(); }}
      onAnnuler={() => setMatch(null)} />}
    {simil && <ModaleSimilaires similaires={simil} quoi="camion"
      onOuvrir={(id) => { setSimil(null); go('detail', id); }}
      onCreer={() => { setSimil(null); faireCreer(); }}
      onAnnuler={() => setSimil(null)} />}
    {/* Mot d'accueil en pied de carte (2026-09-11) : une ligne, dans la même
        mise en page que celle de l'écran de connexion — deux filets qui
        s'effacent de part et d'autre. L'écran de saisie du CFS est le premier
        geste de la journée ; il n'y a pas de raison qu'il soit sec. */}
    <p className="mot-accueil creer-mot">Bienvenue, et bonne saisie</p>
  </div>
  <SceneEntreePIA />
  </div>;
};

/* --------- Plusieurs camions sur une même déclaration (saisie en lot) --- */
/**
 * v4 — La déclaration (déclarant, n°, marchandise…) est saisie UNE SEULE FOIS,
 * puis on aligne autant de camions que nécessaire avec leurs conteneurs.
 * Répond au geste le plus répétitif du CFS : plusieurs camions enlèvent des
 * conteneurs de la même déclaration, et tout était à re-saisir à chaque fois.
 */
type LigneCam = { numeroCamion: string; conteneurs: O[] };
const ctVide = (): O => ({ num: '', taille: '', type: '', plomb: '' });
const ligneVide = (): LigneCam => ({ numeroCamion: '', conteneurs: [ctVide()] });

SCREENS.lotcamions = ({ go }) => {
  const [op, setOp] = useState(OPERATIONS.ENLEVEMENT as string);
  const [d, setD] = useState<O>({});
  const [consoMode, setConsoMode] = useState('balise');
  const [lignes, setLignes] = useState<LigneCam[]>([ligneVide(), ligneVide()]);
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<{ crees: O[]; erreurs: O[] } | null>(null);
  const set = (k: string, v: unknown) => setD((o) => ({ ...o, [k]: v }));
  const estEnl = op === OPERATIONS.ENLEVEMENT;

  // Conteneurs proposés à la frappe : enlèvement → stock PIA, dépotage → positionnés du jour.
  const statutStock = estEnl ? 'En stock' : 'Positionné';
  const { data: stk } = useAsync<{ rows: O[] }>(() => call('stock.list', { statut: statutStock }), [statutStock]);
  const stockRows = (stk?.rows ?? []) as O[];
  const stockByTc = Object.fromEntries(stockRows.map((r) => [String(r['numeroTC'] ?? ''), r]));

  const majLigne = (i: number, patch: Partial<LigneCam>) => setLignes((a) => a.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const majCt = (i: number, k: number, patch: O) =>
    majLigne(i, { conteneurs: lignes[i]!.conteneurs.map((ct, j) => (j === k ? { ...ct, ...patch } : ct)) });
  // Taille / type repris de la fiche stock dès que le N° est reconnu (zéro ressaisie).
  function choisirCt(i: number, k: number, v: string) {
    const num = masks.tc(v);
    const hit = stockByTc[num] as O | undefined;
    majCt(i, k, { num, ...(hit ? { taille: String(hit['taille'] ?? ''), type: String(hit['typeConteneur'] ?? '') } : {}) });
  }

  async function envoyer() {
    const camions = lignes.filter((l) => l.numeroCamion.trim()).map((l) => ({
      numeroCamion: l.numeroCamion, conteneurs: l.conteneurs.filter((ct) => String(ct['num'] ?? '').trim()),
    }));
    if (!camions.length) { toast('Indiquez au moins un camion.', 'err'); return; }
    setBusy(true);
    try {
      const r = await call<{ crees: O[]; erreurs: O[] }>('cargo.lotcamions', {
        typeOperation: op, declaration: d, consoMode, camions,
      });
      setRes(r);
      toast(`${r.crees.length} camion(s) enregistré(s)${r.erreurs.length ? ` · ${r.erreurs.length} en erreur` : ''}.`, r.erreurs.length ? 'err' : 'ok');
      // Les camions passés restent visibles dans le récapitulatif ; on ne garde
      // à l'écran que les lignes en échec, à corriger et à renvoyer.
      const kos = new Set(r.erreurs.map((e) => String(e['numeroCamion'])));
      setLignes((a) => { const reste = a.filter((l) => kos.has(masks.alnum(l.numeroCamion))); return reste.length ? reste : [ligneVide()]; });
    } catch (e) { toast((e as Error).message, 'err'); } finally { setBusy(false); }
  }

  return <div className="card">
    <h2>Plusieurs camions — une seule déclaration</h2>
    <p className="help" style={{ marginTop: 0 }}>Saisissez la déclaration <b>une fois</b>, puis alignez les camions et leurs conteneurs. Chaque camion est créé et rattaché à cette déclaration ; un camion en erreur n'annule pas les autres.</p>

    <div className="grid2">
      <div><label className="help">Type d'opération</label>
        <select value={op} onChange={(e) => setOp(e.target.value)}><option>{OPERATIONS.ENLEVEMENT}</option><option>{OPERATIONS.DEPOTAGE}</option></select></div>
      {estTypeSansT1(d['typeDeclaration'] ?? 'T') && <div><label className="help">Type {String(d['typeDeclaration'])} — balise</label>
        <select value={consoMode} onChange={(e) => setConsoMode(e.target.value)}><option value="balise">À baliser</option><option value="sansbalise">Non balisée (dispense)</option></select></div>}
    </div>

    <div className="section-title" style={{ marginTop: 14 }}>Déclaration (saisie une seule fois)</div>
    <DeclFields d={d} set={set} />

    <div className="row" style={{ alignItems: 'center', marginTop: 14 }}>
      <div className="section-title" style={{ flex: 1, margin: 0 }}>Camions ({lignes.length})</div>
      <button className="ghost xs" onClick={() => setLignes((a) => [...a, ligneVide()])}>＋ Ajouter un camion</button>
    </div>
    <datalist id="dl-lot-tc">{stockRows.map((r) => <option key={String(r['numeroTC'])} value={String(r['numeroTC'])} />)}</datalist>
    {lignes.map((l, i) => <div key={i} style={{ border: '1px solid var(--line)', borderRadius: 6, padding: 10, marginTop: 8 }}>
      <div className="row" style={{ alignItems: 'center' }}>
        <div style={{ flex: 1 }}><label className="help">N° camion {i + 1}</label>
          <ChampCamion value={l.numeroCamion} onChange={(v) => majLigne(i, { numeroCamion: v })} label="" /></div>
        <button className="ghost xs" onClick={() => majLigne(i, { conteneurs: [...l.conteneurs, ctVide()] })}>＋ Conteneur</button>
        {lignes.length > 1 && <button className="ghost xs" onClick={() => setLignes((a) => a.filter((_, j) => j !== i))}>Retirer</button>}
      </div>
      {l.conteneurs.map((ct, k) => <div key={k} className="grid2" style={{ marginTop: 6 }}>
        <div><label className="help">Conteneur {k + 1}</label>
          <input className="mono" value={String(ct['num'])} onChange={(e) => choisirCt(i, k, e.target.value)} list="dl-lot-tc" autoComplete="off" /></div>
        <div><label className="help">Taille</label>
          <input value={String(ct['taille'])} onChange={(e) => majCt(i, k, { taille: masks.upper(e.target.value) })} placeholder="20' / 40' / 45'" /></div>
        <div><label className="help">Type (facultatif)</label>
          <input value={String(ct['type'])} onChange={(e) => majCt(i, k, { type: masks.upper(e.target.value) })} /></div>
        {estEnl && <div><label className="help">Scellé / Plomb</label>
          <input value={String(ct['plomb'])} onChange={(e) => majCt(i, k, { plomb: masks.upper(e.target.value) })} /></div>}
      </div>)}
    </div>)}

    <div style={{ marginTop: 14 }}><button disabled={busy} onClick={envoyer}>{busy ? 'Enregistrement…' : 'Enregistrer tous les camions'}</button></div>

    {res && <div style={{ marginTop: 16 }}>
      {res.crees.length > 0 && <>
        <div className="section-title">Camions enregistrés ({res.crees.length})</div>
        <Table cols={[['id', 'ID'], ['numeroCamion', 'Camion'], ['conteneurs', 'Conteneurs']]} rows={res.crees} onRow={(r) => go('detail', r['id'])} />
      </>}
      {res.erreurs.length > 0 && <>
        <div className="section-title" style={{ marginTop: 12 }}>En erreur ({res.erreurs.length}) — à corriger ci-dessus</div>
        {res.erreurs.map((e, i) => <div key={i} className="err-msg"><b className="mono">{String(e['numeroCamion'])}</b> — {String(e['message'])}</div>)}
      </>}
    </div>}
  </div>;
};

/* -------------------- Recherche — cargaisons ACTIVES ------------------- */
/**
 * v4 — Écran de recherche RÉTABLI, mais recentré sur son seul usage réel :
 * retrouver un camion ou un conteneur ENCORE DANS L'ENCEINTE (pas encore sorti
 * par la Porte Principale). C'est la question posée au guichet — « ce camion,
 * il est où ? » — et non une consultation de l'historique, qui reste l'écran
 * « Cargaisons ». Camions ET véhicules sont cherchés ensemble.
 */
SCREENS.search = ({ go, user }) => {
  const [q, setQ] = useState('');
  const cherche = q.trim().length >= 2;
  const { data, loading, reload } = useAsync<{ rows: O[]; total: number }>(
    () => (cherche ? call('cargo.list', { categorie: 'tous', actifs: true, search: q.trim(), pageSize: 100 })
      : call('cargo.list', { categorie: 'tous', actifs: true, pageSize: 100 })), [q]);
  const rows = data?.rows ?? [];
  return <>
    {/* Le champ de recherche EST la commande de l'ecran : il se range dans
        l'angle du bandeau, avec le compteur de resultats en sous-titre. */}
    <BandeauModule icone="loupe" titre="Rechercher une cargaison en cours"
      sous={<>
        Uniquement les cargaisons <b>encore présentes</b> (non sorties) — par
        N° de camion, de conteneur, de balise ou ID ; espaces et tirets ignorés.
        {' · '}
        {loading ? 'Recherche…' : cherche
          ? `${data?.total ?? 0} résultat(s)`
          : `${data?.total ?? 0} cargaison(s) active(s), tapez au moins 2 caractères pour filtrer`}
      </>}
      action={<div className="bm-outils">
        <input className="mono" value={q} onChange={(e) => setQ(e.target.value)}
          placeholder="N° camion, conteneur, ID…" style={{ width: 230 }} autoFocus />
      </div>} />
    <div className="card">
    <div>
      {loading ? <Spinner /> : <Table
        cols={[['numeroCamion', 'Camion / Châssis'], ['conteneur1', 'Conteneur'], ['typeOperation', 'Opération'],
          ['statut', 'Statut'], ['etapeEnCours', 'Attendu à'], ['dateCreation', 'Entré le']]}
        rows={rows.map(avecEtape)} onRow={(r) => go('detail', r['id'])}
        actions={(r) => <ActionsDossier r={r} admin={user.role === ROLES.ADMIN} onFait={reload} />} />}
    </div>
  </div></>;
};

/** Prochaine cellule qui doit traiter la cargaison — la réponse cherchée au guichet. */
const ETAPE_LABELS: Record<string, string> = {
  CFS: 'CFS (chargement)', VALIDATION: 'Chef brigade', T1: 'Cellule T1',
  BALISE: 'Cellule Balise', BS: 'Bon de sortie', PP: 'Porte principale',
};
function avecEtape(r: O): O {
  // File unique (2026-08-19) : une seule prochaine cellule, pas une liste parallèle.
  const f = fileAttente(r as never);
  return { ...r, etapeEnCours: f ? (ETAPE_LABELS[f] ?? f) : '—' };
}

/* --------------------- Nouveau (Véhicule/Conso/MAD) -------------------- */
SCREENS.new = ({ go }) => {
  const [type, setType] = useState(OPERATIONS.VEHICULE as string);
  return <div className="card">
    <h2>Nouveau rapport</h2>
    <label className="help">Type</label>
    <select value={type} onChange={(e) => setType(e.target.value)} style={{ maxWidth: 320 }}>
      <option>{OPERATIONS.VEHICULE}</option><option>{OPERATIONS.CONSO}</option><option>{OPERATIONS.MAGASIN}</option>
    </select>
    {type === OPERATIONS.VEHICULE ? <FormVehicule go={go} /> : type === OPERATIONS.MAGASIN ? <FormMagasin go={go} /> : <FormConso go={go} />}
  </div>;
};

function DeclFields({ d, set }: { d: O; set: (k: string, v: unknown) => void }) {
  return <div className="grid2">
    <div><label className="help">Déclarant</label><input value={String(d['declarant'] ?? '')} onChange={(e) => set('declarant', masks.upper(e.target.value))} /></div>
    <div><label className="help">Contact</label><input value={String(d['contactDeclarant'] ?? '')} onChange={(e) => set('contactDeclarant', masks.tel(e.target.value))} /></div>
    <ChampDestination value={String(d['destinationMarchandise'] ?? '')} onChange={(v) => set('destinationMarchandise', v)} />
    <div><label className="help">Bureau</label><input value={String(d['bureauDeclaration'] ?? 'TG120')} onChange={(e) => set('bureauDeclaration', masks.upper(e.target.value))} /></div>
    <div><label className="help">Type décl.</label><select value={String(d['typeDeclaration'] ?? 'T')} onChange={(e) => set('typeDeclaration', e.target.value)}>{TYPES_DECLARATION.map((t) => <option key={t}>{t}</option>)}</select></div>
    <div><label className="help">N° décl.</label><input value={String(d['numeroDeclaration'] ?? '')} onChange={(e) => set('numeroDeclaration', masks.upper(e.target.value))} /></div>
    <div><label className="help">Année</label><input value={String(d['anneeDeclaration'] ?? new Date().getFullYear())} onChange={(e) => set('anneeDeclaration', e.target.value)} /></div>
    <div><label className="help">Désignation des marchandises</label><input value={String(d['descriptionMarchandise'] ?? '')} onChange={(e) => set('descriptionMarchandise', masks.upper(e.target.value))} /></div>
  </div>;
}

/** Camion d'effets divers (v4) : N° camion + DÉSIGNATION + scellés (plus de conteneurs propres). */
type CamEffets = { numeroCamion: string; designation: string; chargementTermine: boolean; scellesCamion: string[] };
const camVide = (): CamEffets => ({ numeroCamion: '', designation: '', chargementTermine: true, scellesCamion: ['', '', ''] });
const vehVide = (): O => ({ chassis: '', marque: '', modele: '', couleur: '', destination: 'Transit' });

function FormVehicule({ go }: { go: Nav['go'] }) {
  const [d, setD] = useState<O>({});
  const [vs, setVs] = useState<O[]>([vehVide()]);
  const [origine, setOrigine] = useState('');
  const [manuelOrigine, setManuelOrigine] = useState(false); // v4.1 : TC hors stock
  const [cams, setCams] = useState<CamEffets[]>([]);
  const set = (k: string, val: unknown) => setD((o) => ({ ...o, [k]: val }));
  const majVeh = (i: number, k: string, val: unknown) => setVs((a) => a.map((v, j) => (j === i ? { ...v, [k]: val } : v)));

  // v4 — le TC d'origine est OBLIGATOIRE et se choisit dans les TC POSITIONNÉS au CFS.
  const { data: stk, loading: stkLoading } = useAsync<{ rows: O[] }>(() => call('stock.list', { statut: 'Positionné' }), []);
  const tcs = ((stk?.rows ?? []) as O[]).map((r) => String(r['numeroTC'] ?? '')).filter(Boolean);

  const majCam = (i: number, patch: Partial<CamEffets>) => setCams((a) => a.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  const [match, setMatch] = useState<O | null>(null); // v4.1 : véhicule déjà présent → mixte ?
  const [simil, setSimil] = useState<O[] | null>(null); // 2026-08-19 : châssis ressemblant → avertir
  // 2026-09-12 — le bouton n'avait AUCUNE garde : 732382 créé trois fois à 12:23.
  const { busy, envoyer } = useEnvoiUnique();

  async function faireCreer() {
    try {
      const r = await call<{ vehicules: { id: string }[] }>('cargo.create', {
        typeOperation: OPERATIONS.VEHICULE, declaration: d, conteneurOrigine: origine, vehicules: vs,
        camions: cams.map((c) => ({ ...c, scellesCamion: c.scellesCamion.filter(Boolean) })),
      });
      toast('Véhicule créé.', 'ok'); go('detail', r.vehicules[0]?.id);
    } catch (e) { toast((e as Error).message, 'err'); }
  }
  async function creer() {
    if (!origine) { toast("Le N° de conteneur d'origine (TC) est obligatoire.", 'err'); return; }
    if (manuelOrigine && !tcValide(origine)) { toast('N° conteneur d\'origine invalide (4 lettres + 7 chiffres).', 'err'); return; }
    // v4.1 — si le 1er châssis existe déjà à un statut modifiable : proposer le mixte.
    // 2026-08-19 — sinon, avertir si un châssis actif ressemble fortement (frappe).
    const chassis = String(vs[0]?.['chassis'] ?? '').trim();
    const { mixte, similaires } = chassis ? await analyserDoublons(chassis) : { mixte: null, similaires: [] };
    if (mixte) { setMatch(mixte); return; }
    if (similaires.length) { setSimil(similaires); return; }
    await faireCreer();
  }

  return <div style={{ marginTop: 12 }}>
    {/* v4 — ordre demandé : Déclaration EN HAUT, puis conteneur + véhicules, effets divers EN BAS. */}
    <div className="section-title">Déclaration</div>
    <DeclFields d={d} set={set} />

    <div className="row" style={{ alignItems: 'center', marginTop: 14 }}>
      <div className="section-title" style={{ flex: 1, margin: 0 }}>Conteneur & véhicules</div>
      <button className="ghost xs" onClick={() => setVs((a) => [...a, vehVide()])}>＋ Ajouter un véhicule</button>
    </div>
    <div className="grid2" style={{ marginTop: 6 }}>
      <div>
        <label className="help">Conteneur d'origine (TC) *</label>
        {manuelOrigine
          ? <input className="mono" value={origine} onChange={(e) => setOrigine(masks.tc(e.target.value))}
              placeholder="N° conteneur (4 lettres + 7 chiffres)" autoComplete="off" />
          : <select value={origine} onChange={(e) => setOrigine(e.target.value)} className="mono">
              <option value="">{stkLoading ? 'Chargement…' : tcs.length ? '— Choisir un TC positionné —' : '— Aucun TC positionné —'}</option>
              {tcs.map((t) => <option key={t}>{t}</option>)}
            </select>}
        <label className="help" style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 6 }}>
          <input type="checkbox" style={{ width: 'auto' }} checked={manuelOrigine}
            onChange={(e) => { setManuelOrigine(e.target.checked); setOrigine(''); }} />
          <span>Saisie manuelle (conteneur hors stock / non positionné)</span>
        </label>
      </div>
    </div>
    {vs.map((v, i) => <div key={i} style={{ border: '1px solid var(--line)', borderRadius: 6, padding: 10, marginTop: 8 }}>
      <div className="row" style={{ alignItems: 'center' }}>
        <div className="help" style={{ flex: 1, fontWeight: 600 }}>Véhicule {i + 1}</div>
        {vs.length > 1 && <button className="ghost xs" onClick={() => setVs((a) => a.filter((_, j) => j !== i))}>Retirer</button>}
      </div>
      <div className="grid2">
        <div><label className="help">Châssis (VIN)</label><input className="mono" value={String(v['chassis'])} onChange={(e) => majVeh(i, 'chassis', masks.alnum(e.target.value))} /></div>
        <div><label className="help">Marque</label><input value={String(v['marque'])} onChange={(e) => majVeh(i, 'marque', masks.upper(e.target.value))} /></div>
        <div><label className="help">Modèle</label><input value={String(v['modele'])} onChange={(e) => majVeh(i, 'modele', masks.upper(e.target.value))} /></div>
        <div><label className="help">Couleur</label><input value={String(v['couleur'])} onChange={(e) => majVeh(i, 'couleur', masks.upper(e.target.value))} /></div>
        <div><label className="help">Destination</label><select value={String(v['destination'])} onChange={(e) => majVeh(i, 'destination', e.target.value)}>{VEHICULE_DESTINATIONS.map((x) => <option key={x}>{x}</option>)}</select></div>
      </div>
    </div>)}

    <div className="row" style={{ alignItems: 'center', marginTop: 14 }}>
      <div className="section-title" style={{ flex: 1, margin: 0 }}>Effets divers (camions) — facultatif</div>
      <button className="ghost xs" onClick={() => setCams((a) => [...a, camVide()])}>＋ Ajouter un camion</button>
    </div>
    {cams.map((c, i) => <div key={i} style={{ border: '1px solid var(--line)', borderRadius: 6, padding: 10, marginTop: 8 }}>
      <div className="row" style={{ alignItems: 'center' }}>
        <ChampCamion value={c.numeroCamion} onChange={(v) => majCam(i, { numeroCamion: v })} label="N° camion" />
        <button className="ghost xs" onClick={() => setCams((a) => a.filter((_, j) => j !== i))}>Retirer</button>
      </div>
      <div style={{ marginTop: 6 }}><label className="help">Désignation des effets divers</label>
        <input value={c.designation} onChange={(e) => majCam(i, { designation: masks.upper(e.target.value) })} placeholder="ex. CARTONS D'EFFETS PERSONNELS" /></div>

      {/* v4 — « chargement terminé (scellés posés) » : ramené AU NIVEAU DU CAMION. */}
      <label className="help" style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 10 }}>
        <input type="checkbox" style={{ width: 'auto' }} checked={c.chargementTermine} onChange={(e) => majCam(i, { chargementTermine: e.target.checked })} />
        <span>Chargement terminé (scellés posés) — sinon « En cours de chargement »</span>
      </label>
      {c.chargementTermine && <div className="grid2" style={{ marginTop: 6 }}>
        {[0, 1, 2].map((k) => <div key={k}><label className="help">Scellé camion {k + 1}{k < 2 ? ' *' : ''}</label>
          <input value={c.scellesCamion[k] ?? ''} onChange={(e) => majCam(i, { scellesCamion: c.scellesCamion.map((x, j) => j === k ? masks.upper(e.target.value) : x) })} /></div>)}
      </div>}
    </div>)}

    <div style={{ marginTop: 12 }}><button disabled={busy} onClick={() => envoyer(creer)}>{busy ? 'Enregistrement…' : 'Créer le véhicule'}</button></div>
    {match && <ModaleMixte match={match} quoi="véhicule"
      onOuvrir={() => { setMatch(null); go('detail', match['id']); }}
      onCreer={() => { setMatch(null); envoyer(faireCreer); }}
      onAnnuler={() => setMatch(null)} />}
    {simil && <ModaleSimilaires similaires={simil} quoi="véhicule"
      onOuvrir={(id) => { setSimil(null); go('detail', id); }}
      onCreer={() => { setSimil(null); envoyer(faireCreer); }}
      onAnnuler={() => setSimil(null)} />}
  </div>;
}

/**
 * v4 — Conso/MAD « comme en dépotage » : le TYPE de la déclaration commande le
 * parcours. T = transit → T1 + Balise ; C (conso) et A (admission, décision
 * utilisateur 2026-07-22) → sautent le T1 et l'agent choisit balisée / non
 * balisée (le choix ne s'affiche que pour ces types-là).
 */
function InfoTypeDecl({ d, mode, setMode }: { d: O; mode: string; setMode: (v: string) => void }) {
  const type = String(d['typeDeclaration'] ?? 'T');
  const estConso = estTypeSansT1(type);
  return <>
    <p className="help" style={{ marginTop: 0 }}>
      {estConso
        ? <>{libelleTypeSansT1(type)} : la cargaison <b>saute le T1</b>{mode === 'sansbalise' ? ' et la Balise (dispense)' : ' ; balise à poser'}.</>
        : <>Type T = transit : la cargaison passe par le <b>T1</b> puis la <b>Balise</b>, comme un dépotage.</>}
    </p>
    {estConso && <div className="grid2">
      <div><label className="help">Type {type} — balise</label>
        <select value={mode} onChange={(e) => setMode(e.target.value)}><option value="balise">À baliser</option><option value="sansbalise">Non balisée (dispense)</option></select></div>
    </div>}
  </>;
}

function FormMagasin({ go }: { go: Nav['go'] }) {
  const [d, setD] = useState<O>({});
  const [num, setNum] = useState('');
  const [mode, setMode] = useState('balise');
  // v4.1 — scellés du camion « comme en dépotage » (2-3). « Chargement terminé
  // (scellés posés) » : sinon la sortie reste « En cours de chargement » et se
  // finalise depuis la fiche.
  const [chargementTermine, setChargementTermine] = useState(true);
  const [scelles, setScelles] = useState(['', '', '']);
  const set = (k: string, val: unknown) => setD((o) => ({ ...o, [k]: val }));

  /* ANTI-DOUBLON À LA SAISIE (2026-09-10).
   *
   * Le serveur refuse déjà un camion déjà présent, mais seulement à l'envoi —
   * c'est-à-dire après que l'agent a rempli toute la déclaration. On l'avertit
   * donc dès qu'il quitte le champ ou appuie sur Entrée, avant qu'il ne travaille
   * pour rien.
   *
   * Et surtout on lui propose LA SORTIE : un même camion qui emporte de la
   * marchandise relevant d'une autre déclaration n'est pas un doublon, c'est un
   * chargement mixte, et il se saisit sur la fiche déjà ouverte. Sans cette
   * proposition, l'agent bloqué invente une plaque pour passer outre. */
  const [dejaLa, setDejaLa] = useState<O | null>(null);

  async function verifierDoublon(plaque: string) {
    setDejaLa(null);
    if (!plaque.trim()) return;
    try {
      const r = await call<{ camion: O[] }>('cargo.checkdup', { numeroCamion: plaque });
      // `checkdup` renvoie AUSSI les camions déjà sortis. Ceux-là ne sont pas des
      // doublons : un camion qui revient est normal, et le serveur ne les bloque
      // pas non plus (cf. camionActif). On n'alerte que sur un camion ENCORE
      // dans l'enceinte — sinon l'avertissement crierait au loup à chaque retour.
      setDejaLa((r.camion ?? []).find((x) => x['actif'] === true) ?? null);
    } catch { /* l'avertissement est un confort : son échec ne bloque pas la saisie */ }
  }

  async function creer() {
    if (!num) { toast('N° camion requis.', 'err'); return; }
    if (chargementTermine && scelles.filter(Boolean).length < 2) { toast('Au moins 2 scellés camion (ou décochez « chargement terminé »).', 'err'); return; }
    try {
      const r = await call<{ camions: { id: string }[] }>('cargo.create', {
        typeOperation: OPERATIONS.MAGASIN, numeroCamion: num, consoMode: mode, declaration: d,
        chargementTermine, scellesCamion: scelles.filter(Boolean),
      });
      toast('Sortie magasin créée.', 'ok'); go('detail', r.camions[0]?.id);
    } catch (e) { toast((e as Error).message, 'err'); }
  }
  const { busy, envoyer } = useEnvoiUnique();
  return <div style={{ marginTop: 12 }}>
    <div className="section-title">Déclaration</div>
    <InfoTypeDecl d={d} mode={mode} setMode={setMode} />
    <DeclFields d={d} set={set} />
    <div className="section-title" style={{ marginTop: 14 }}>Camion</div>
    <div className="grid2"><div>
      <ChampCamion value={num} onChange={(v) => { setNum(v); setDejaLa(null); }} label="N° camion"
        onBlur={() => verifierDoublon(num)} onEnter={() => verifierDoublon(num)} />
    </div></div>
    {dejaLa && <div className="card" style={{ marginTop: 8, borderLeft: '4px solid var(--warn)' }}>
      <b style={{ color: 'var(--warn)' }}>⚠ Ce camion est déjà dans le système</b>
      <div className="help" style={{ marginTop: 4 }}>
        <span className="mono">{String(dejaLa['numeroCamion'] ?? '')}</span> —
        dossier <span className="mono">{String(dejaLa['id'] ?? '')}</span>,
        statut « {String(dejaLa['statut'] ?? '')} ».
      </div>
      <p className="help" style={{ marginTop: 8 }}>
        S'il emporte <b>aussi</b> cette marchandise, ce n'est pas un nouveau dossier
        mais un <b>chargement mixte</b> : ajoutez cette déclaration sur la fiche
        existante. S'il s'agit d'un autre camion, vérifiez la plaque.
      </p>
      <button onClick={() => go('detail', String(dejaLa['id'] ?? ''))}>
        Ouvrir {String(dejaLa['id'] ?? '')} pour un chargement mixte
      </button>
    </div>}
    <label className="help" style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 10 }}>
      <input type="checkbox" style={{ width: 'auto' }} checked={chargementTermine} onChange={(e) => setChargementTermine(e.target.checked)} />
      <span>Chargement terminé (scellés posés) — sinon « En cours de chargement »</span>
    </label>
    {chargementTermine && <div className="grid2" style={{ marginTop: 6 }}>
      {[0, 1, 2].map((k) => <div key={k}><label className="help">Scellé camion {k + 1}{k < 2 ? ' *' : ''}</label>
        <input value={scelles[k] ?? ''} onChange={(e) => setScelles((a) => a.map((x, j) => j === k ? masks.upper(e.target.value) : x))} /></div>)}
    </div>}
    <div style={{ marginTop: 12 }}><button disabled={busy} onClick={() => envoyer(creer)}>{busy ? 'Enregistrement…' : 'Créer'}</button></div>
  </div>;
}

function FormConso({ go }: { go: Nav['go'] }) {
  const [d, setD] = useState<O>({});
  const [num, setNum] = useState('');
  const [mode, setMode] = useState('balise');
  const [ct, setCt] = useState<O>({ num: '', taille: '', type: '', plomb: '' });
  const set = (k: string, val: unknown) => setD((o) => ({ ...o, [k]: val }));
  const setC = (k: string, val: unknown) => setCt((o) => ({ ...o, [k]: val }));
  async function creer() {
    if (!tcValide(String(ct['num']))) { toast('N° conteneur invalide.', 'err'); return; }
    try {
      const r = await call<{ camions: { id: string }[] }>('cargo.create', {
        typeOperation: OPERATIONS.CONSO, consoMode: mode, declaration: d,
        camions: [{ numeroCamion: num, conteneurs: [ct] }],
      });
      toast('Conso créée.', 'ok'); go('detail', r.camions[0]?.id);
    } catch (e) { toast((e as Error).message, 'err'); }
  }
  const { busy, envoyer } = useEnvoiUnique();
  return <div style={{ marginTop: 12 }}>
    <div className="section-title">Déclaration</div>
    <InfoTypeDecl d={d} mode={mode} setMode={setMode} />
    <DeclFields d={d} set={set} />
    <div className="section-title" style={{ marginTop: 14 }}>Camion & conteneur</div>
    <div className="grid2">
      <div><ChampCamion value={num} onChange={setNum} label="N° camion" /></div>
      <div><label className="help">Conteneur</label><input className="mono" value={String(ct['num'])} onChange={(e) => setC('num', masks.tc(e.target.value))} /></div>
      <div><label className="help">Taille</label><input value={String(ct['taille'])} onChange={(e) => setC('taille', masks.upper(e.target.value))} /></div>
      <div><label className="help">Type</label><input value={String(ct['type'])} onChange={(e) => setC('type', masks.upper(e.target.value))} /></div>
      <div><label className="help">Scellé</label><input value={String(ct['plomb'])} onChange={(e) => setC('plomb', masks.upper(e.target.value))} /></div>
    </div>
    <div style={{ marginTop: 12 }}><button disabled={busy} onClick={() => envoyer(creer)}>{busy ? 'Enregistrement…' : 'Créer'}</button></div>
  </div>;
}

/* --------------------------------- Stock ------------------------------- */
SCREENS.stock = () => <StockList statut="tous" />;
SCREENS.stockjour = () => <StockJournalier />;

/**
 * v4.2 — STATISTIQUES DE DÉPOTAGE (demande CFS).
 *
 * Trois chiffres par journée : combien de conteneurs ont été positionnés
 * (pointés), combien ont été dépotés, et combien restaient à dépoter en fin de
 * journée. Le troisième est celui qui compte : c'est le report qui grossit quand
 * le dépotage ne suit pas le positionnement.
 */
SCREENS.depotstats = () => <StatsDepotage />;
function StatsDepotage() {
  const p = useReportRange('semaine');
  const { data, loading, error } = useAsync<{ rows: O[]; compte: O }>(
    () => call('report.depotage', { du: p.du, au: p.au }), [p.du, p.au]);
  const c = (data?.compte ?? {}) as O;
  return <><BandeauModule icone="conteneur" titre="Statistiques de dépotage" sous={<PeriodeLue p={p} />}
    action={<div className="bm-outils"><PeriodPicker p={p} /></div>} />
  <div className="card">
    {/* Netlify déploie le front dès le push, l'Edge Function quelques minutes
        plus tard : entre les deux, cette action n'existe pas encore côté
        serveur. On l'annonce comme telle plutôt que d'afficher une erreur
        technique à un agent qui n'y peut rien. */}
    {loading ? <Spinner /> : error ? (
      /Action inconnue|Action non gérée/.test(error)
        ? <div className="empty">Écran disponible dès la prochaine mise à jour du serveur.</div>
        : <div className="err-msg">{error}</div>
    ) : <>
      <div className="stats" style={{ marginTop: 10 }}>
        <StatCard n={Number(c['pointes'] ?? 0)} l="Positionnés (période)" />
        <StatCard n={Number(c['depotes'] ?? 0)} l="Dépotés (période)" tone="ok" />
        <StatCard n={Number(c['restant'] ?? 0)} l="Restant à dépoter" tone="warn" />
        <StatCard n={Number(c['evp'] ?? 0)} l="EVP restants" />
        <StatCard n={Number(c['jamaisPointes'] ?? 0)} l="Au parc, jamais pointés" tone="warn" />
      </div>
      <p className="help" style={{ marginTop: 8 }}>
        « Restant » = conteneurs pointés à cette date ou avant et pas encore dépotés
        en fin de journée : c'est le report d'un jour sur l'autre.
        <br />
        Un conteneur re-pointé un jour suivant compte au jour de son <b>dernier</b> pointage —
        la colonne « positionnés » est une photo de la journée de travail, pas un cumul d'arrivées.
        « Au parc, jamais pointés » compte les conteneurs présents qui ne sont jamais
        passés par un pointage : ce sont eux qui échappent au suivi.
      </p>
      {(data?.rows ?? []).length === 0
        ? <div className="empty">Aucun mouvement sur la période.</div>
        : <>
          {/* Le report d'un jour sur l'autre est une TENDANCE : sur un tableau
              de chiffres, une dérive lente passe inaperçue ; sur une courbe,
              elle saute aux yeux. D'où l'aire pour le restant, superposée aux
              barres du mouvement quotidien. */}
          <div style={{ marginTop: 12 }}>
            <Graphique
              cats={(data?.rows ?? []).map((r) => fmtJour(String(r['jour'])))}
              series={[
                { nom: 'Positionnés (pointés)', valeurs: (data?.rows ?? []).map((r) => Number(r['positionnes'] ?? 0)) },
                { nom: 'Dépotés', valeurs: (data?.rows ?? []).map((r) => Number(r['depotes'] ?? 0)) },
              ]}
              type="barres" ordonnee="Conteneurs" valeursSurBarres />
          </div>
          <div style={{ marginTop: 14 }}>
            <div className="section-title">Report en fin de journée</div>
            <Graphique
              cats={(data?.rows ?? []).map((r) => fmtJour(String(r['jour'])))}
              series={[{ nom: 'Restant à dépoter', valeurs: (data?.rows ?? []).map((r) => Number(r['restant'] ?? 0)), couleur: '#b4531f' }]}
              type="aire" ordonnee="Conteneurs" hauteur={220} />
          </div>
          <Table cols={[['jour', 'Jour'], ['positionnes', 'Positionnés'], ['depotes', 'Dépotés'], ['restant', 'Restant en fin de journée']]}
            rows={data?.rows ?? []} />
        </>}
    </>}
  </div></>;
}
function StockList({ statut, titre }: { statut: string; titre?: string }) {
  const { data, loading, error } = useAsync<{ rows: O[]; compte: O }>(() => call('stock.list', { statut }), [statut]);
  return <div className="card"><h2>{titre ?? 'Stock conteneurs'}</h2>
    <ExportConteneurs statutDefaut={statut === 'tous' ? '' : statut} />
    {loading ? <Spinner /> : error ? <div className="err-msg">{error}</div> : <>
      <div className="stats">
        <StatCard n={Number(data?.compte['total'] ?? 0)} l="Total" />
        <StatCard n={Number(data?.compte['stock'] ?? 0)} l="En stock" />
        <StatCard n={Number(data?.compte['positionne'] ?? 0)} l="Positionnés" />
        <StatCard n={Number(data?.compte['depote'] ?? 0)} l="Dépotés" />
        <StatCard n={Number(data?.compte['evp'] ?? 0)} l="EVP" />
      </div>
      <Table cols={[['numeroTC', 'Conteneur'], ['taille', 'Taille'], ['statut', 'Statut'], ['provenance', 'Provenance'], ['numeroDeclaration', 'N° décl.'], ['joursSejour', 'Séjour (j)']]} rows={data?.rows ?? []} />
    </>}
  </div>;
}

/**
 * v4.1 — Stock CFS JOURNALIER (décision client 2026-07-31). N'affiche que les
 * conteneurs pointés AUJOURD'HUI ; les restes des jours précédents (pointés,
 * pas encore dépotés) sont comptés à part (« restes à dépoter ») et consultables
 * en dessous. Rien n'est effacé en base — seule la vue du jour se remet à zéro.
 */
function StockJournalier() {
  const { data, loading, error } = useAsync<{ rows: O[]; compte: O }>(() => call('stock.list', { statut: 'Positionné' }), []);
  const [voirRestes, setVoirRestes] = useState(false);
  const rows = (data?.rows ?? []) as O[];
  const duJour = rows.filter((r) => r['duJour']);
  const restes = rows.filter((r) => !r['duJour']);
  const cols: [string, string][] = [['numeroTC', 'Conteneur'], ['taille', 'Taille'], ['datePointage', 'Pointé le'], ['pointePar', 'Pointé par'], ['numeroDeclaration', 'N° décl.'], ['joursSejour', 'Séjour (j)']];
  return <div className="card"><h2>Stock CFS journalier</h2>
    <p className="help" style={{ marginTop: 0 }}>Conteneurs positionnés <b>aujourd'hui</b>. Les restes des jours précédents sont comptés à part et restent dépotables (et re-pointables).</p>
    <ExportConteneurs statutDefaut="Positionné" />
    {loading ? <Spinner /> : error ? <div className="err-msg">{error}</div> : <>
      <div className="stats">
        <StatCard n={Number(data?.compte['positionneJour'] ?? 0)} l="Positionnés aujourd'hui" tone="ok" />
        <StatCard n={Number(data?.compte['restes'] ?? 0)} l="Restes à dépoter" tone="warn" onClick={() => setVoirRestes((v) => !v)} />
        <StatCard n={Number(data?.compte['depote'] ?? 0)} l="Dépotés (total)" />
      </div>
      <div className="section-title">Positionnés aujourd'hui ({duJour.length})</div>
      <Table cols={cols} rows={duJour} />
      {restes.length > 0 && <>
        <div className="row" style={{ alignItems: 'center', marginTop: 12 }}>
          <div className="section-title" style={{ flex: 1, margin: 0 }}>Restes des jours précédents ({restes.length})</div>
          <button className="ghost xs" onClick={() => setVoirRestes((v) => !v)}>{voirRestes ? 'Masquer' : 'Afficher'}</button>
        </div>
        {voirRestes && <Table cols={cols} rows={restes} />}
      </>}
    </>}
  </div>;
}

/** v4.1 — Extraction de la liste des conteneurs (statut + période, Excel/PDF). */
function ExportConteneurs({ statutDefaut }: { statutDefaut: string }) {
  const p = useReportRange('mois');
  const [statut, setStatut] = useState(statutDefaut);
  const [busy, setBusy] = useState(false);
  async function exporter(fmt: 'xlsx' | 'pdf') {
    setBusy(true);
    try {
      const r = await call<O>('report.conteneurs', { statut, du: p.du, au: p.au, format: fmt });
      if (fmt === 'pdf') imprimerHtml(String(r['html'] ?? '')); else telecharger(r);
    } catch (e) { toast((e as Error).message, 'err'); } finally { setBusy(false); }
  }
  return <details style={{ border: '1px solid var(--line)', borderRadius: 6, padding: '8px 12px', margin: '6px 0 10px' }}>
    <summary style={{ cursor: 'pointer', fontWeight: 600 }}>⤓ Extraire les conteneurs (Excel / PDF) par statut et période</summary>
    <div className="row" style={{ alignItems: 'center', flexWrap: 'wrap', gap: 8, marginTop: 10 }}>
      <select value={statut} onChange={(e) => setStatut(e.target.value)} style={{ maxWidth: 200 }}>
        <option value="">Tous les statuts</option>
        <option value="En stock">En stock</option>
        <option value="Positionné">Positionné (non dépoté)</option>
        <option value="Dépoté">Dépoté</option>
      </select>
      <PeriodPicker p={p} />
      <button className="ghost xs" disabled={busy} onClick={() => exporter('xlsx')}>⤓ Excel</button>
      <button className="ghost xs" disabled={busy} onClick={() => exporter('pdf')}>⤓ PDF</button>
    </div>
    <div className="help" style={{ marginTop: 4 }}>Période sur la date de pointage (positionné) ou d'entrée. {p.inversee && <span style={{ color: 'var(--warn)' }}>dates inversées, remises à l'endroit</span>}</div>
  </details>;
}

// v4 — chaque pointage propose les TC de la BONNE source à la frappe (datalist) :
// pointage matinal → stock « En stock » ; pointage PP → stock annoncé « Annoncé ».
SCREENS.pointage = () => <PointageTC action="stock.pointage" titre="Pointage matinal" desc="Positionne un conteneur pour le dépotage du jour." suggest={{ action: 'stock.list', statut: 'En stock' }} />;
// v4.1 — Magasin/MAD : les TC destinés au magasin ne passent PAS par le
// positionnement du CFS (décision utilisateur 2026-07-22) — PIA les prend
// directement dans le yard et les pose devant le magasin. On propose donc le
// STOCK DU PARC (« En stock »), pas les positionnés du jour. La saisie libre
// reste ouverte : le serveur accepte un conteneur inconnu du stock et le crée.
SCREENS.magasin = () => <PointageTC action="stock.entreemagasin" titre="Entrée Magasin / MAD"
  desc="Conteneur pris dans le stock du parc PIA et entré au magasin : il est marqué dépoté / sorti du yard."
  suggest={{ action: 'stock.list', statut: 'En stock' }} libre />;
SCREENS.pointentree = () => <PointageTC action="stockannonce.pointage" titre="Pointage entrée (stock annoncé)" desc="Pointe l'arrivée d'un conteneur annoncé (Porte Principale)." suggest={{ action: 'stockannonce.list', statut: 'Annoncé' }} />;
SCREENS.confentree = () => <ConfirmerEntree />;
/**
 * Pointage d'un conteneur — v4 : PLUS DE SAISIE À L'AVEUGLE (décision
 * utilisateur). L'agent ne tape plus les 11 caractères d'un N° ISO 6346 avant
 * de savoir s'il existe : la liste des conteneurs RÉELLEMENT pointables lui est
 * présentée, il tape éventuellement quelques caractères pour la réduire, puis
 * choisit. Une faute de frappe ne peut plus produire un refus après coup.
 *
 * `libre` autorise en plus un N° hors liste (Magasin/MAD accepte un conteneur
 * inconnu du stock, que le serveur crée) ; les pointages stricts, eux, n'ont de
 * sens que sur la liste proposée.
 */
function PointageTC({ action, titre, desc, suggest, libre }: {
  action: string; titre: string; desc: string;
  suggest?: { action: string; statut: string }; libre?: boolean;
}) {
  const [tc, setTc] = useState('');
  const [filtre, setFiltre] = useState('');
  const [busy, setBusy] = useState(false);
  // Liste des TC de la source, rechargée après chaque pointage (le TC pointé
  // quitte la liste : l'agent voit son avancement).
  const { data: sug, loading, reload: reloadSug } = useAsync<{ rows: O[] }>(
    () => suggest ? call(suggest.action, { statut: suggest.statut }) : Promise.resolve({ rows: [] }),
    [suggest?.action, suggest?.statut]);

  const rows = (sug?.rows ?? []) as O[];
  const q = masks.tc(filtre);
  const visibles = (q ? rows.filter((r) => String(r['numeroTC'] ?? '').includes(q)) : rows).slice(0, 200);
  const trop = (q ? rows.filter((r) => String(r['numeroTC'] ?? '').includes(q)) : rows).length - visibles.length;

  async function pointer(num: string) {
    if (!num) return;
    setBusy(true);
    try {
      await call<O>(action, { numeroTC: num });
      toast(`${num} pointé.`, 'ok');
      setTc(''); setFiltre('');
      if (suggest) reloadSug();
    } catch (e) { toast((e as Error).message, 'err'); } finally { setBusy(false); }
  }

  return <div className="card" style={{ maxWidth: 620 }}>
    <h2>{titre}</h2>
    <p className="help" style={{ marginTop: 0 }}>{desc}</p>

    {suggest ? <>
      <label className="help">Filtrer la liste (tapez quelques caractères du N°)</label>
      <input className="mono" value={filtre} onChange={(e) => setFiltre(masks.tc(e.target.value))}
        placeholder="ex. MSKU ou 1234" autoComplete="off" autoFocus />
      <div className="help" style={{ margin: '8px 0 6px' }}>
        {loading ? 'Chargement du stock…'
          : `${rows.length} conteneur(s) pointable(s)${q ? ` · ${visibles.length + Math.max(0, trop)} correspondant(s)` : ''} — cliquez pour choisir.`}
      </div>
      {loading ? <Spinner /> : rows.length === 0
        ? <div className="empty">Aucun conteneur à pointer.</div>
        : visibles.length === 0
          ? <div className="empty">Aucun conteneur ne correspond à « {q} ».</div>
          : <>
            <div className="tbl" style={{ maxHeight: 340, overflowY: 'auto' }}><table>
              <thead><tr><th>Conteneur</th><th>Taille</th><th>N° décl.</th><th style={{ width: 110 }}></th></tr></thead>
              <tbody>{visibles.map((r) => {
                const num = String(r['numeroTC'] ?? '');
                const choisi = num === tc;
                return <tr key={num} className="clk" onClick={() => setTc(num)}
                  style={choisi ? { background: 'var(--accent-soft)' } : undefined}>
                  <td className="mono"><b>{num}</b></td>
                  <td>{String(r['taille'] ?? '—')}</td>
                  <td>{[r['numeroDeclaration'], r['anneeDeclaration'], r['typeDeclaration']].filter(Boolean).join(' · ') || '—'}</td>
                  <td>{choisi
                    ? <button disabled={busy} onClick={(e) => { e.stopPropagation(); pointer(num); }}>
                      {busy ? '…' : 'Pointer'}</button>
                    : <span className="help">Choisir</span>}</td>
                </tr>;
              })}</tbody>
            </table></div>
            {trop > 0 && <div className="help" style={{ marginTop: 6 }}>+ {trop} autre(s) — affinez le filtre.</div>}
          </>}
    </> : null}

    {/* Magasin/MAD : un conteneur inconnu du stock est légitime, la saisie reste ouverte. */}
    {(!suggest || libre) && <div style={{ marginTop: suggest ? 14 : 0 }}>
      {suggest && <div className="section-title">Conteneur hors liste</div>}
      <div className="row">
        <input className="mono" value={tc} onChange={(e) => setTc(masks.tc(e.target.value))}
          placeholder="N° conteneur (4 lettres + 7 chiffres)" style={{ flex: 1 }} autoComplete="off" />
        <button disabled={busy || !tc} onClick={() => pointer(tc)}>{busy ? '…' : 'Valider'}</button>
      </div>
    </div>}
  </div>;
}

/**
 * v4 — Confirmer l'entrée au port sec EN LOT (décision capitaine 2026-07-17).
 * Plus de saisie : la liste montre les conteneurs déjà pointés par la Porte
 * Principale (« en progression vers le port sec ») ; l'agent au gate coche ceux
 * physiquement entrés et valide tout d'un coup. Réutilisable le lendemain — les
 * conteneurs pointés restent en attente tant qu'ils ne sont pas confirmés.
 */
function ConfirmerEntree() {
  const { data, loading, error, reload } = useAsync<{ rows: O[] }>(() => call('stockannonce.list', { statut: 'Pointé' }), []);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const rows = data?.rows ?? [];
  const toggle = (tc: string) => setSel((s) => { const n = new Set(s); if (n.has(tc)) n.delete(tc); else n.add(tc); return n; });
  const toggleAll = () => setSel((s) => s.size === rows.length ? new Set() : new Set(rows.map((r) => String(r['numeroTC']))));

  async function valider() {
    if (!sel.size) { toast('Cochez au moins un conteneur.', 'err'); return; }
    setBusy(true);
    try {
      const r = await call<{ confirmes: string[]; ignores: O[] }>('stockannonce.confirmerlot', { numerosTC: [...sel] });
      toast(`${r.confirmes.length} entrée(s) validée(s)${r.ignores.length ? ` · ${r.ignores.length} ignoré(s)` : ''}.`, 'ok');
      setSel(new Set());
      reload();
    } catch (e) { toast((e as Error).message, 'err'); } finally { setBusy(false); }
  }

  return <div className="card">
    <h2>Confirmer l'entrée au port sec</h2>
    <p className="help" style={{ marginTop: 0 }}>Conteneurs déjà pointés par la Porte Principale, en progression vers le port sec. Cochez ceux qui sont physiquement entrés, puis validez — aucune saisie manuelle. Ce qui n'est pas confirmé reste en attente (validable plus tard).</p>
    <div className="row" style={{ alignItems: 'center' }}>
      <button className="ghost xs" onClick={() => reload()}>⟳ Actualiser</button>
      <span className="help" style={{ flex: 1 }}>{rows.length} en attente · {sel.size} sélectionné(s)</span>
      <button disabled={busy || !sel.size} onClick={valider}>{busy ? 'Validation…' : `Valider l'entrée (${sel.size})`}</button>
    </div>
    {loading ? <Spinner /> : error ? <div className="err-msg">{error}</div> : rows.length === 0 ? <div className="empty">Aucun conteneur en attente de confirmation.</div> :
      <div className="tbl" style={{ marginTop: 10 }}><table>
        <thead><tr>
          <th style={{ width: 32 }}><input type="checkbox" checked={sel.size === rows.length && rows.length > 0} onChange={toggleAll} /></th>
          <th>Conteneur</th><th>Taille</th><th>N° décl.</th><th>Pointé le</th><th>Pointé par</th>
        </tr></thead>
        <tbody>{rows.map((r) => { const tc = String(r['numeroTC']); return (
          <tr key={tc} className="clk" onClick={() => toggle(tc)}>
            <td><input type="checkbox" checked={sel.has(tc)} onChange={() => toggle(tc)} onClick={(e) => e.stopPropagation()} /></td>
            <td className="mono">{tc}</td>
            <td>{String(r['taille'] ?? '—')}</td>
            <td>{[r['numeroDeclaration'], r['anneeDeclaration'], r['bureauDeclaration'], r['typeDeclaration']].filter(Boolean).join(' · ') || '—'}</td>
            <td>{fmtDate(r['datePointage'])}</td>
            <td>{String(r['pointePar'] ?? '—')}</td>
          </tr>
        ); })}</tbody>
      </table></div>}
  </div>;
}

SCREENS.import = () => <ImportExcel action="stock.import" titre="Stock initial — import" cols={['numeroTC', 'taille', 'dateEntree', 'anneeDeclaration', 'typeDeclaration', 'numeroDeclaration']} conflits />;
SCREENS.importannonce = () => <ImportExcel action="stockannonce.import" titre="Annonce de transfert — import" cols={['numeroTC', 'taille', 'dateEntree', 'anneeDeclaration', 'bureauDeclaration', 'typeDeclaration', 'numeroDeclaration']} />;
function ImportExcel({ action, titre, cols, conflits }: { action: string; titre: string; cols: string[]; conflits?: boolean }) {
  const [items, setItems] = useState<O[]>([]);
  const [res, setRes] = useState('');
  const [busy, setBusy] = useState(false);
  const [analyse, setAnalyse] = useState<O | null>(null);
  function lire(file: File) {
    const reader = new FileReader();
    reader.onload = (e) => {
      const wb = XLSX.read(e.target?.result, { type: 'binary', cellDates: true });
      const sheet = wb.Sheets[wb.SheetNames[0]!];
      const rows = (XLSX.utils.sheet_to_json(sheet!, { header: 1 }) as unknown[][]).slice(1);
      setItems(rows.filter((r) => r[0]).map((r) => Object.fromEntries(cols.map((c, i) => [c, r[i] ?? '']))));
      setRes(''); setAnalyse(null);
    };
    reader.readAsBinaryString(file);
  }
  /** Écrit réellement. `surDoublon` n'a de sens que pour l'import du stock. */
  async function ecrire(surDoublon?: string) {
    setBusy(true);
    try {
      const r = await call<O>(action, surDoublon ? { items, surDoublon } : { items });
      const reg = Number(r['regularises'] ?? 0);
      setRes(`${r['ajoutes']} ajouté(s), ${r['maj']} mis à jour${reg ? `, ${reg} régularisé(s)` : ''}, ${r['ignores']} ignoré(s).`);
      setAnalyse(null); toast('Import terminé.', 'ok');
    } catch (e) { toast((e as Error).message, 'err'); } finally { setBusy(false); }
  }
  /** Import du stock : on REGARDE d'abord, on écrit ensuite. */
  async function lancer() {
    if (!conflits) { await ecrire(); return; }
    setBusy(true);
    try {
      const a = await call<O>(action, { items, analyser: true });
      const d = (a['doublons'] ?? []) as O[];
      if (!d.length) { setBusy(false); await ecrire('ignorer'); return; }
      setAnalyse(a); setBusy(false);
    } catch (e) { toast((e as Error).message, 'err'); setBusy(false); }
  }

  return <div className="card"><h2>{titre}</h2>
    <p className="help">Colonnes attendues (dans l'ordre) : {cols.join(', ')}. Première ligne = entêtes.</p>
    <input type="file" accept=".xlsx,.xls,.csv" onChange={(e) => e.target.files?.[0] && lire(e.target.files[0])} />
    {items.length > 0 && <><div className="help" style={{ marginTop: 8 }}>{items.length} ligne(s) prêtes.</div>
      <div style={{ marginTop: 10 }}><button disabled={busy} onClick={lancer}>{busy ? 'Vérification…' : `Importer ${items.length} ligne(s)`}</button></div></>}
    {res && <div className="help" style={{ marginTop: 8 }}>{res}</div>}
    {analyse && <ConflitsImport a={analyse} busy={busy} onChoix={ecrire} onAnnuler={() => setAnalyse(null)} />}
  </div>;
}

/**
 * v4.1 — Conflits d'import (décision utilisateur 2026-07-22). Même geste que
 * copier des fichiers dans un dossier qui en contient déjà : on annonce ce qui
 * existe, on laisse choisir. Le défaut proposé est « ignorer », parce que les
 * conteneurs déjà là ont souvent été saisis à la main et sont ENGAGÉS dans une
 * opération — les écraser réécrirait leur date d'entrée et leur déclaration
 * sous les pieds des cellules en aval.
 */
function ConflitsImport({ a, busy, onChoix, onAnnuler }: { a: O; busy: boolean; onChoix: (s: string) => void; onAnnuler: () => void }) {
  const doublons = (a['doublons'] ?? []) as O[];
  const engages = Number(a['engages'] ?? 0);
  const nouveaux = Number(a['nouveaux'] ?? 0);
  const manuels = Number(a['manuels'] ?? 0);
  return <Modal onClose={onAnnuler}>
    <h2><span className="tp-pastille" aria-hidden="true"><Icone nom="conteneur" taille={18} /></span>{doublons.length} conteneur(s) déjà connu(s) du système</h2>
    <p className="help" style={{ marginTop: 0 }}>
      Le fichier apporte <b>{nouveaux} nouveau(x)</b> conteneur(s) — ceux-là seront ajoutés dans tous les cas.
      Les {doublons.length} ci-dessous existent déjà{engages > 0 && <> et <b style={{ color: 'var(--warn)' }}>{engages} sont déjà engagés</b> (positionnés, dépotés ou rattachés à un camion)</>}.
    </p>
    {manuels > 0 && <div className="bandeau"><div className="t">⚠ {manuels} saisie(s) manuelle(s) retrouvée(s)</div>
      <div className="l">Ces conteneurs avaient été <b>saisis à la main</b> (ils n'étaient pas encore dans le stock) et sont déjà sur un camion.
        Ils ne seront <b>pas</b> recréés comme disponibles. « Remplacer » leur crée enfin une fiche stock (marquée dépotée, liée à leur camion).</div></div>}
    <div className="tbl" style={{ maxHeight: 320, overflowY: 'auto' }}><table>
      <thead><tr><th>Conteneur</th><th>Situation actuelle</th><th>En base</th><th>Dans le fichier</th></tr></thead>
      <tbody>{doublons.map((d) => <tr key={String(d['numeroTC'])}>
        <td className="mono"><b>{String(d['numeroTC'])}</b></td>
        <td>{String(d['statut'] ?? '—')}
          {d['source'] === 'manuel' ? <span className="tag st-camion" style={{ marginLeft: 6 }}>saisie manuelle</span>
            : d['engage'] ? <span className="tag st-charge" style={{ marginLeft: 6 }}>engagé</span> : null}</td>
        <td>{String(d['declarationExistante'] || '—')}</td>
        <td>{String(d['declarationFichier'] || '—')}</td>
      </tr>)}</tbody>
    </table></div>
    {Number(a['invalides'] ?? 0) > 0 && <div className="help" style={{ marginTop: 8 }}>
      {String(a['invalides'])} ligne(s) du fichier sont inexploitables (N° non conforme ou répété) et seront écartées.
    </div>}
    <div className="row" style={{ marginTop: 14, flexWrap: 'wrap' }}>
      <button disabled={busy} onClick={() => onChoix('ignorer')}>Ignorer les doublons — ne toucher à rien</button>
      <button className="ghost" disabled={busy} onClick={() => onChoix('remplacer')}>Remplacer / régulariser</button>
      <button className="ghost" disabled={busy} onClick={onAnnuler}>Annuler</button>
    </div>
    <p className="help" style={{ marginTop: 10 }}>
      « Remplacer » met à jour la taille, la date d'entrée et la déclaration. Le <b>statut n'est jamais touché</b> :
      un conteneur dépoté ou positionné ne redevient jamais « En stock » parce qu'il figure dans un fichier.
    </p>
  </Modal>;
}

SCREENS.annonce = () => {
  const { data, loading } = useAsync<{ rows: O[]; compte: O }>(() => call('stockannonce.list', { statut: 'tous' }), []);
  return <div className="card"><h2>Stock annoncé</h2>
    {loading ? <Spinner /> : <>
      <div className="stats">
        <StatCard n={Number(data?.compte['annonces'] ?? 0)} l="Annoncés" />
        <StatCard n={Number(data?.compte['aConfirmer'] ?? 0)} l="À confirmer" tone="warn" />
        <StatCard n={Number(data?.compte['confirmes'] ?? 0)} l="Confirmés" tone="ok" />
        <StatCard n={`${Number(data?.compte['tauxTransfert'] ?? 0)}%`} l="Taux transfert" />
      </div>
      <Table cols={[['numeroTC', 'Conteneur'], ['taille', 'Taille'], ['statut', 'Statut'], ['numeroDeclaration', 'N° décl.'], ['datePointage', 'Pointé le'], ['dateConfirmation', 'Confirmé le']]} rows={data?.rows ?? []} />
    </>}
  </div>;
};

SCREENS.etatcfs = ({ go }) => {
  const { data, loading } = useAsync<{ rows: O[]; compte: O }>(() => call('etatcfs.list'), []);
  return <div className="card"><h2>Pointage des camions à la sortie</h2>
    <p className="help" style={{ marginTop: 0 }}>Situation du parking : camions et véhicules encore présents. Sont <b>défalqués</b> ceux qui ont déjà pris la balise et ceux sortis à la PP.</p>
    {loading ? <Spinner /> : <>
      <div className="stats">
        <StatCard n={Number(data?.compte['total'] ?? 0)} l="Au parking" />
        <StatCard n={Number(data?.compte['camions'] ?? 0)} l="Camions" />
        <StatCard n={Number(data?.compte['vehicules'] ?? 0)} l="Véhicules" />
        <StatCard n={Number(data?.compte['enCours'] ?? 0)} l="En chargement" />
        <StatCard n={Number(data?.compte['fin'] ?? 0)} l="Fin chargement" />
        <StatCard n={Number(data?.compte['vide'] ?? 0)} l="Vides" />
        <StatCard n={Number(data?.compte['np'] ?? 0)} l="Non précisé" tone="warn" />
      </div>
      <Table cols={[['id', 'ID'], ['numeroCamion', 'Camion / Châssis'], ['typeOperation', 'Opération'], ['statut', 'Statut'], ['etatSortie', 'État sortie']]} rows={data?.rows ?? []} onRow={(r) => go('detail', r['id'])} />
    </>}
  </div>;
};

/**
 * Ouvre un rapport HTML dans un onglet et lance l'impression (→ PDF).
 * Le v4 n'avait aucun mécanisme d'impression : les rapports HTML du serveur
 * (bon de chargement, ordre d'exécution) étaient injoignables depuis l'écran.
 */
function imprimerHtml(html: string) {
  const w = window.open('', '_blank');
  if (!w) { toast('Autorisez les fenêtres surgissantes pour imprimer.', 'err'); return; }
  /* UNE BALISE `base` INJECTEE (2026-09-12).
   *
   * La fenetre est ouverte sur `about:blank` : une adresse relative comme
   * `/logo_PIA.jpg` n'y resout PAS vers l'application, et le logo des editions
   * ne s'affichait pas. La `base` ancre le document sur l'origine de
   * l'application ; toutes les adresses relatives suivent.
   *
   * Elle est posee ICI, et non dans le gabarit du serveur : celui-ci n'a aucun
   * moyen de connaitre l'origine du navigateur (preview, Netlify, domaine
   * propre), et n'a pas a la connaitre. */
  const avecBase = html.replace(/<head>/i, `<head><base href="${location.origin}/">`);
  w.document.write(avecBase);
  w.document.close();
  w.focus();
  /* On attend que les IMAGES soient chargees avant d'ouvrir l'impression :
   * sans cela, le logo arrivait apres le rendu et l'apercu sortait sans lui.
   * Le delai reste une SECURITE, pas le mecanisme - si `load` ne vient jamais
   * (image absente), l'impression part quand meme. */
  let lance = false;
  const imprimer = () => { if (!lance) { lance = true; w.print(); } };
  w.addEventListener('load', imprimer);
  setTimeout(imprimer, 1200);
}

/* ------------- Bon de chargement — recherche par déclaration ----------- */
// ⚠ Format d'édition à fournir : cet écran affiche les données collectées
// (camions + véhicules au statut « Créée » = fin de chargement). La mise en
// page définitive du bon se branchera dessus.
SCREENS.chargement = () => {
  const [q, setQ] = useState<O>({ numeroDeclaration: '', anneeDeclaration: '', bureauDeclaration: '', typeDeclaration: '' });
  const [res, setRes] = useState<O | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: string, v: unknown) => setQ((o) => ({ ...o, [k]: v }));

  async function chercher() {
    if (!String(q['numeroDeclaration'] ?? '').trim()) { toast('Indiquez le N° de déclaration.', 'err'); return; }
    setBusy(true);
    try { setRes(await call<O>('report.loadingdecl', q)); }
    catch (e) { toast((e as Error).message, 'err'); setRes(null); }
    finally { setBusy(false); }
  }

  /** Ordre d'exécution (trame OTR) : ouvert dans un onglet, prêt à imprimer. */
  async function imprimer() {
    try {
      const r = await call<{ html: string }>('report.ordre', q);
      imprimerHtml(r.html);
    } catch (e) { toast((e as Error).message, 'err'); }
  }

  const cam = (res?.['camions'] as O[]) ?? [];
  const veh = (res?.['vehicules'] as O[]) ?? [];
  const cpt = (res?.['compte'] as O) ?? {};
  const dec = (res?.['declaration'] as O) ?? {};
  const apu = res?.['apurement'] as O | null;

  return <div className="card">
    <h2>Bon de chargement — par déclaration</h2>
    <p className="help" style={{ marginTop: 0 }}>Remonte tous les camions et véhicules ayant chargé des conteneurs de la déclaration, au statut <b>« Créée » (fin de chargement)</b>.</p>
    <div className="grid2">
      <div><label className="help">N° déclaration *</label><input className="mono" value={String(q['numeroDeclaration'])} onChange={(e) => set('numeroDeclaration', masks.upper(e.target.value))} onKeyDown={(e) => e.key === 'Enter' && chercher()} autoFocus /></div>
      <div><label className="help">Année (facultatif)</label><input value={String(q['anneeDeclaration'])} onChange={(e) => set('anneeDeclaration', e.target.value)} /></div>
      <div><label className="help">Bureau (facultatif)</label><input value={String(q['bureauDeclaration'])} onChange={(e) => set('bureauDeclaration', masks.upper(e.target.value))} /></div>
      <div><label className="help">Type (facultatif)</label><select value={String(q['typeDeclaration'])} onChange={(e) => set('typeDeclaration', e.target.value)}><option value="">Tous</option>{TYPES_DECLARATION.map((t) => <option key={t}>{t}</option>)}</select></div>
    </div>
    <div style={{ marginTop: 12 }}><button disabled={busy} onClick={chercher}>{busy ? 'Recherche…' : 'Rechercher'}</button></div>

    {res && <div style={{ marginTop: 18 }}>
      <div className="row" style={{ alignItems: 'center' }}>
        <div className="section-title" style={{ flex: 1, margin: 0 }}>Déclaration {String(dec['numeroDeclaration'] ?? '')} · {String(dec['anneeDeclaration'] ?? '—')} · {String(dec['bureauDeclaration'] ?? '—')} · type {String(dec['typeDeclaration'] ?? '—')}</div>
        {(cam.length > 0 || veh.length > 0) && <button onClick={imprimer}>🖨 Ordre d'exécution</button>}
      </div>
      <div className="help">Déclarant : <b>{String(dec['declarant'] || '—')}</b>{apu?.['exists'] ? <> · Apurement : {String(apu['apures'])}/{String(apu['nombreConteneurs'])} conteneurs (restant {String(apu['restant'])})</> : null}</div>
      <div className="stats" style={{ marginTop: 10 }}>
        <StatCard n={Number(cpt['camions'] ?? 0)} l="Camions" />
        <StatCard n={Number(cpt['vehicules'] ?? 0)} l="Véhicules" />
        <StatCard n={Number(cpt['conteneurs'] ?? 0)} l="Conteneurs" />
      </div>
      {!cam.length && !veh.length && <div className="empty">Aucun camion ni véhicule au statut « Créée » pour cette déclaration.</div>}
      {[['Camions', cam] as const, ['Véhicules', veh] as const].map(([titre, lst]) => lst.length ? <div key={titre} style={{ marginTop: 14 }}>
        <div className="section-title">{titre} ({lst.length})</div>
        {lst.map((r) => <LigneChargement key={String(r['id'])} r={r} />)}
      </div> : null)}
    </div>}
  </div>;
};

function LigneChargement({ r }: { r: O }) {
  const conts = (r['conteneurs'] as O[]) ?? [];
  const sc = (r['scellesCamion'] as string[]) ?? [];
  const v = r['vehicule'] as O | undefined;
  const autres = (r['autresDeclarations'] as O[]) ?? [];
  return <div style={{ border: '1px solid var(--line)', borderRadius: 6, padding: 10, marginBottom: 8 }}>
    <div className="row" style={{ alignItems: 'center', gap: 8 }}>
      <b className="mono">{String(r['numeroCamion'])}</b>
      <span className="help">{String(r['id'])} · {String(r['typeOperation'])}</span>
      {Boolean(r['chargementMixte']) && <span className="tag st-charge">⊞ Chargement mixte</span>}
    </div>
    {/* Mixte : dire lesquelles des déclarations du camion ne sont PAS sur ce bon,
        sinon le total de conteneurs affiché paraît incomplet à la lecture. */}
    {autres.length > 0 && <div className="help" style={{ color: 'var(--warn)' }}>
      Ce camion porte aussi : {autres.map((a) => `${String(a['libelle'])} (${String(a['nbConteneurs'])} TC)`).join(' · ')} — non repris sur ce bon.
    </div>}
    <div className="help">Date {fmtDate(r['dateCreation'])} · Agent CFS {String(r['agentCfs'] || '—')} · Destination {String(r['destinationMarchandise'] || '—')}{r['nbColis'] ? ` · ${String(r['nbColis'])} colis` : ''}</div>
    {v && <div className="help">Châssis {String(v['chassis'] ?? '')} · {String(v['marque'] ?? '')} {String(v['modele'] ?? '')} · {String(v['destination'] ?? '')}{r['conteneurOrigine'] ? ` · TC origine ${String(r['conteneurOrigine'])}` : ''}</div>}
    {sc.length > 0 && <div className="help">Scellés camion : {sc.join(' · ')}</div>}
    {/* v4 — camion d'effets divers : pas de conteneur propre, une désignation. */}
    {!conts.length && !v && r['descriptionMarchandise'] ? <div className="help">Effets divers : {String(r['descriptionMarchandise'])}</div> : null}
    {conts.length > 0 && <Table cols={[['num', 'Conteneur'], ['plomb', 'Scellé'], ['taille', 'Taille'], ['type', 'Type']]} rows={conts} />}
  </div>;
}

/* ---------- Validation du chef brigade — PAR DÉCLARATION --------------- */
/**
 * v4 — Le chef brigade ne signe plus camion par camion (décision utilisateur
 * 2026-07-19). Il ouvre une déclaration, voit tout ce qu'elle contient et signe
 * l'ensemble d'un geste. L'écran s'ouvre sur la file des déclarations en attente
 * — le chef n'a pas à connaître les numéros par cœur — et une recherche directe
 * reste possible quand il a le dossier papier sous les yeux.
 */
type QDecl = { numeroDeclaration: string; anneeDeclaration: string; bureauDeclaration: string; typeDeclaration: string };
const qVide = (): QDecl => ({ numeroDeclaration: '', anneeDeclaration: '', bureauDeclaration: '', typeDeclaration: '' });

function ValidationDeclaration({ go, arg, retour, ecranPrecedent }: Nav) {
  const [q, setQ] = useState<QDecl>(qVide());
  // v4.3 (décision utilisateur 2026-08-15) — sélection de PLUSIEURS déclarations
  // pour les signer d'un seul geste. `sel` est indexé par la clé de déclaration.
  const [sel, setSel] = useState<Record<string, QDecl>>({});
  const [groupe, setGroupe] = useState(false);
  // La déclaration ouverte vit dans l'ARGUMENT D'ÉCRAN, pas dans un état local :
  // ainsi, ouvrir une fiche de cargaison puis revenir rouvre le dossier là où on
  // l'avait laissé, au lieu de retomber sur la file d'attente.
  const ouverte = (arg && typeof arg === 'object' ? arg as QDecl : null);
  const ouvrir = (d: QDecl) => go('wait_valid', d);

  // Sans déclaration ouverte : la file d'attente. Avec : le dossier complet.
  const { data, loading, error, reload } = useAsync<O>(
    () => call('report.validationdecl', ouverte ?? {}), [JSON.stringify(ouverte)]);

  // 2026-09-11 — nombre de cargaisons signées à l'instant, retenu le temps que
  // l'écran se rafraîchisse. Sert UNIQUEMENT à ne pas présenter un échec
  // d'affichage comme un échec de signature (voir `AvisApresSignature`).
  const [signee, setSignee] = useState(0);
  useEffect(() => {
    // Le rafraîchissement a fini par aboutir : la liste est à jour, l'avis n'a
    // plus lieu d'être.
    if (!loading && !error) setSignee(0);
  }, [loading, error]);

  if (ouverte) return <DossierValidation decl={ouverte} data={data} loading={loading} error={error}
    reload={reload} signee={signee} onSigne={setSignee}
    fermer={() => (ecranPrecedent === 'wait_valid' ? retour() : go('wait_valid'))} go={go} />;

  const decls = (data?.['declarations'] as O[]) ?? [];
  const selCles = Object.keys(sel);
  const cleDe = (r: O): QDecl => ({
    numeroDeclaration: String(r['numeroDeclaration']), anneeDeclaration: String(r['anneeDeclaration'] ?? ''),
    bureauDeclaration: String(r['bureauDeclaration'] ?? ''), typeDeclaration: String(r['typeDeclaration'] ?? ''),
  });
  const basculer = (r: O) => {
    const k = String(r['cle']);
    setSel((s) => { const n = { ...s }; if (n[k]) delete n[k]; else n[k] = cleDe(r); return n; });
  };

  if (groupe) return <ValidationGroupee cles={Object.values(sel)} go={go}
    fermer={() => setGroupe(false)}
    onDone={(nb) => { setSignee(nb); setSel({}); setGroupe(false); reload(); }} />;

  return <>
    {/* Bandeau de module (2026-09-12) : l'acces direct a un N° de declaration
        est LE geste d'entree de cet ecran - il se range donc dans l'angle, avec
        le reste des commandes. */}
    <BandeauModule icone="valider" titre="Déclarations à valider"
      sous={<>
        Ouvrez une déclaration pour examiner <b>tous</b> ses camions, véhicules et conteneurs,
        puis signer l'ensemble en une fois — ou <b>cochez plusieurs déclarations</b> et validez-les
        toutes d'un même geste.
        {decls.length > 0 && <> — <b>{decls.length}</b> en attente.</>}
      </>}
      action={<div className="bm-outils">
        <input className="mono" placeholder="N° de déclaration" style={{ width: 170 }}
          value={q.numeroDeclaration} onChange={(e) => setQ({ ...q, numeroDeclaration: masks.upper(e.target.value) })}
          onKeyDown={(e) => e.key === 'Enter' && q.numeroDeclaration.trim() && ouvrir(q)} />
        <input value={q.anneeDeclaration} style={{ width: 88 }} aria-label="Année" placeholder="Année"
          onChange={(e) => setQ({ ...q, anneeDeclaration: e.target.value })} />
        <button disabled={!q.numeroDeclaration.trim()} onClick={() => ouvrir(q)}>Ouvrir</button>
      </div>} />
    <div className="card et-validation">

    {loading ? <Spinner /> : error ? <AvisApresSignature error={error} signee={signee} /> : decls.length === 0
      ? <div className="empty">Aucune déclaration en attente de validation.</div>
      : <>
        <div className="row" style={{ alignItems: 'center', justifyContent: 'space-between', marginBottom: 6, gap: 8 }}>
          <div className="help">{decls.length} déclaration(s) en attente — la plus ancienne en tête. Cochez pour valider en lot.</div>
          <div className="row" style={{ alignItems: 'center', gap: 8 }}>
            {selCles.length > 0 && <button className="ghost xs" onClick={() => setSel({})}>Tout décocher</button>}
            <button disabled={selCles.length === 0} onClick={() => setGroupe(true)}>
              ✔ Valider la sélection{selCles.length ? ` (${selCles.length})` : ''}
            </button>
          </div>
        </div>
        <div className="tbl"><table>
          <thead><tr>
            <th style={{ width: 28 }}>
              <input type="checkbox" aria-label="Tout sélectionner"
                checked={selCles.length === decls.length && decls.length > 0}
                onChange={(e) => setSel(e.target.checked
                  ? Object.fromEntries(decls.map((r) => [String(r['cle']), cleDe(r)]))
                  : {})} />
            </th>
            <th>Déclaration</th><th>Déclarant</th><th>Camions</th><th>Véhicules</th><th>Conteneurs</th><th>Plus ancienne</th>
          </tr></thead>
          <tbody>{decls.map((r) => (
            <tr key={String(r['cle'])} className="clk"
              style={sel[String(r['cle'])] ? { background: 'var(--warn-soft)' } : undefined}
              onClick={() => ouvrir(cleDe(r))}>
              <td onClick={(e) => e.stopPropagation()}>
                <input type="checkbox" aria-label={`Sélectionner ${String(r['libelle'])}`}
                  checked={!!sel[String(r['cle'])]} onChange={() => basculer(r)} />
              </td>
              <td className="mono">{String(r['libelle'])}</td><td>{String(r['declarant'] || '—')}</td>
              <td>{String(r['camions'])}</td><td>{String(r['vehicules'])}</td><td>{String(r['conteneurs'])}</td>
              <td>{fmtJour(r['plusAncienne'])}</td>
            </tr>
          ))}</tbody>
        </table></div>
      </>}
  </div></>;
}

/**
 * v4.3 — VALIDATION GROUPÉE sur PLUSIEURS déclarations (décision utilisateur
 * 2026-08-15). Le chef brigade coche plusieurs dossiers dans la file, les
 * parcourt regroupés par déclaration, renseigne la pesée de chaque camion, puis
 * signe l'ensemble en UN seul appel `cargo.validerlot`. Chaque cargaison reçoit
 * malgré tout SA propre signature (garantie par validerLot) : une signature de
 * lot n'aurait aucune valeur probante sur une fiche isolée.
 */
function ValidationGroupee({ cles, fermer, go, onDone }: {
  // `onDone` reçoit le NOMBRE de cargaisons effectivement signées (2026-09-11) :
  // l'écran de retour en a besoin pour distinguer un échec d'affichage d'un
  // échec de signature.
  cles: QDecl[]; fermer: () => void; go: Nav['go']; onDone: (signees: number) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [pesees, setPesees] = useState<Record<string, Pesee>>({});
  const { data, loading, error } = useAsync<O[]>(
    () => Promise.all(cles.map((c) => call<O>('report.validationdecl', c))),
    [JSON.stringify(cles)]);
  const dossiers = data ?? [];
  const aValider = dossiers.flatMap((d) => (d['aValider'] as string[]) ?? []);
  const aPeser = idsAPeser(dossiers);
  const setPesee = (id: string, p: Pesee) => setPesees((o) => ({ ...o, [id]: p }));
  const peseesPretes = peseesLotPretes(aValider, aPeser, pesees);
  /* Suivi des engagements (2026-09-10) — UNE valeur pour tout le lot.
   * La pesée est un fait physique propre à chaque camion ; l'engagement est un
   * régime attaché à la déclaration, et le lot est précisément l'ensemble des
   * camions d'une même déclaration. */
  const eng = useSuiviEngagement();

  async function signer() {
    if (!peseesPretes) { toast('Renseignez la pesée de chaque dépotage avant de signer.', 'err'); return; }
    if (!eng.pret) { toast('Renseignez le suivi des engagements avant de signer.', 'err'); return; }
    if (!window.confirm(
      `Valider et signer ${aValider.length} cargaison(s) réparties sur ${cles.length} déclaration(s) ?\n\n`
      + 'Votre signature numérique sera apposée sur chacune.')) return;
    setBusy(true);
    try {
      const r = await call<{ compte: O; erreurs: O[] }>('cargo.validerlot', { ids: aValider, pesees: payloadPesees(aValider, pesees), ...eng.payload });
      const nb = Number(r.compte['validees'] ?? 0);
      toast(`${nb} cargaison(s) validée(s)${r.erreurs.length ? ` · ${r.erreurs.length} en erreur` : ''}.`,
        r.erreurs.length ? 'err' : 'ok');
      r.erreurs.forEach((e) => toast(`${String(e['id'])} : ${String(e['message'])}`, 'err'));
      onDone(nb);
    } catch (e) { toast((e as Error).message, 'err'); } finally { setBusy(false); }
  }

  return <div>
    <button className="ghost" onClick={fermer}>← Retour à la sélection</button>
    <div className="card" style={{ marginTop: 10 }}>
      <h2 style={{ margin: 0 }}>Validation groupée — {cles.length} déclaration(s)</h2>
      {loading ? <Spinner /> : error ? <div className="err-msg">{error}</div> : <>
        {eng.champ}
        <div className="row" style={{ alignItems: 'center', marginTop: 12 }}>
          <button disabled={busy || !peseesPretes || !eng.pret || !aValider.length} onClick={signer}>
            {busy ? 'Signature…' : `✔ Valider et signer les ${aValider.length} cargaison(s)`}
          </button>
          <span className="help">{!aValider.length ? 'Rien à valider dans la sélection.'
            : peseesPretes ? 'Signature apposée sur chacune.' : 'Renseignez d\'abord la pesée de chaque camion ci-dessous.'}</span>
        </div>

        {dossiers.map((dos, i) => {
          const d = (dos['declaration'] as O) ?? {};
          const cam = (dos['camions'] as O[]) ?? [];
          const veh = (dos['vehicules'] as O[]) ?? [];
          const cpt = (dos['compte'] as O) ?? {};
          return <div key={cles[i]?.numeroDeclaration ?? i} style={{ marginTop: 16 }}>
            <div className="section-title">
              Déclaration {String(d['numeroDeclaration'] ?? cles[i]?.numeroDeclaration ?? '—')}
              {' — '}<span className="help">{String(d['declarant'] || '—')} · {Number(cpt['aValider'] ?? 0)} à valider</span>
            </div>
            {!cam.length && !veh.length && <div className="empty">Rien à valider pour cette déclaration.</div>}
            {[['Camions', cam] as const, ['Véhicules', veh] as const].map(([titre, lst]) => lst.length
              ? <div key={titre} style={{ marginTop: 8 }}>
                <div className="help" style={{ marginBottom: 4 }}>{titre} ({lst.length})</div>
                {lst.map((r) => <LigneValidation key={String(r['id'])} r={r} go={go}
                  pesee={pesees[String(r['id'])]} onPesee={(p) => setPesee(String(r['id']), p)} />)}
              </div> : null)}
          </div>;
        })}
      </>}
    </div>
  </div>;
}

/** Dossier complet d'une déclaration + signature en lot. */
function DossierValidation({ decl, data, loading, error, reload, signee, onSigne, fermer, go }: {
  decl: QDecl; data: O | null; loading: boolean; error: string | null;
  reload: () => void;
  // 2026-09-11 — cargaisons signées à l'instant, portées par l'écran parent
  // (c'est lui qui tient la requête, donc lui qui sait quand elle aboutit).
  signee: number; onSigne: (n: number) => void;
  fermer: () => void; go: Nav['go'];
}) {
  const [busy, setBusy] = useState(false);
  const [pesees, setPesees] = useState<Record<string, Pesee>>({});
  const cam = (data?.['camions'] as O[]) ?? [];
  const veh = (data?.['vehicules'] as O[]) ?? [];
  const cpt = (data?.['compte'] as O) ?? {};
  const d = (data?.['declaration'] as O) ?? {};
  const apu = data?.['apurement'] as O | null;
  const aValider = (data?.['aValider'] as string[]) ?? [];
  const aPeser = idsAPeser(data ? [data] : []);
  const setPesee = (id: string, p: Pesee) => setPesees((o) => ({ ...o, [id]: p }));
  // Chaque DÉPOTAGE à valider doit avoir une pesée complète ; le reste est prêt d'office.
  const peseesPretes = peseesLotPretes(aValider, aPeser, pesees);
  // Suivi des engagements (2026-09-10) — une valeur pour toute la déclaration.
  const eng = useSuiviEngagement();

  async function signer() {
    if (!peseesPretes) { toast('Renseignez la pesée de chaque dépotage avant de signer.', 'err'); return; }
    if (!eng.pret) { toast('Renseignez le suivi des engagements avant de signer.', 'err'); return; }
    if (!window.confirm(
      `Valider et signer ${aValider.length} cargaison(s) de la déclaration ${String(d['numeroDeclaration'] ?? decl.numeroDeclaration)} ?\n\n`
      + `${Number(cpt['conteneursAValider'] ?? 0)} conteneur(s) concerné(s). Votre signature numérique sera apposée sur chacune.`)) return;
    setBusy(true);
    try {
      const r = await call<{ compte: O; erreurs: O[] }>('cargo.validerlot', { ids: aValider, pesees: payloadPesees(aValider, pesees), ...eng.payload });
      const nb = Number(r.compte['validees'] ?? 0);
      toast(`${nb} cargaison(s) validée(s)${r.erreurs.length ? ` · ${r.erreurs.length} en erreur` : ''}.`,
        r.erreurs.length ? 'err' : 'ok');
      r.erreurs.forEach((e) => toast(`${String(e['id'])} : ${String(e['message'])}`, 'err'));
      onSigne(nb);
      reload();
    } catch (e) { toast((e as Error).message, 'err'); } finally { setBusy(false); }
  }

  return <>
    {/* Le dossier d'une declaration reprend le bandeau des volets : le long
        bouton « Retour aux declarations » et le titre nu tenaient deux lignes
        pour dire ce qu'une bande dit en une. */}
    <BandeauModule icone="valider" titre={`Déclaration ${String(d['numeroDeclaration'] ?? decl.numeroDeclaration)}`}
      sous={<>
        {[d['anneeDeclaration'], d['bureauDeclaration'], d['typeDeclaration']].filter(Boolean).join(' · ') || '—'}
        {' · Déclarant '}<b>{String(d['declarant'] || '—')}</b>
        {apu?.['exists'] ? ` · Apurement ${String(apu['apures'])}/${String(apu['nombreConteneurs'])} (restant ${String(apu['restant'])})` : ''}
      </>}
      sansRetour
      action={<div className="bm-outils">
        <button onClick={fermer}><Icone nom="fleche" taille={15} />Les déclarations</button>
        <button onClick={reload}><Icone nom="attente" taille={15} />Actualiser</button>
      </div>} />
    <div className="card">

      {loading ? <Spinner /> : error ? <AvisApresSignature error={error} signee={signee} /> : <>
        <div className="stats" style={{ marginTop: 12 }}>
          <StatCard n={Number(cpt['camions'] ?? 0)} l="Camions" />
          <StatCard n={Number(cpt['vehicules'] ?? 0)} l="Véhicules" />
          <StatCard n={Number(cpt['conteneurs'] ?? 0)} l="Conteneurs" />
          <StatCard n={Number(cpt['aValider'] ?? 0)} l="À valider" tone="warn" />
          <StatCard n={Number(cpt['dejaValidees'] ?? 0)} l="Déjà validées" tone="ok" />
        </div>

        {aValider.length > 0 && eng.champ}
        {aValider.length > 0
          ? <div className="row" style={{ alignItems: 'center', marginTop: 4, gap: 12, flexWrap: 'wrap' }}>
            <button className="acte-signer" disabled={busy || !peseesPretes || !eng.pret} onClick={signer}>
              <Icone nom="valider" taille={17} />
              {busy ? 'Signature…' : `Valider et signer les ${aValider.length} cargaison(s)`}
            </button>
            <span className="help">{peseesPretes ? 'Signature apposée sur chacune ; débloque T1, Balise et Bon de sortie.' : 'Renseignez d\'abord la pesée de chaque camion ci-dessous.'}</span>
          </div>
          : <div className="help" style={{ color: 'var(--ok)' }}>✓ Tout est validé pour cette déclaration.</div>}

        {!cam.length && !veh.length && <div className="empty">Aucune cargaison en fin de chargement pour cette déclaration.</div>}
        {[['Camions', cam] as const, ['Véhicules', veh] as const].map(([titre, lst]) => lst.length ? <div key={titre} style={{ marginTop: 14 }}>
          <div className="section-title">{titre} ({lst.length})</div>
          {lst.map((r) => <LigneValidation key={String(r['id'])} r={r} go={go}
            pesee={pesees[String(r['id'])]} onPesee={(p) => setPesee(String(r['id']), p)} />)}
        </div> : null)}
      </>}
    </div>
  </>;
}

/** Pesée d'un camion : en surcharge OUI/NON (+ poids si OUI). */
type Pesee = { enSurcharge: '' | 'oui' | 'non'; poids: string };
export const peseeComplete = (p?: Pesee): boolean => !!p && (p.enSurcharge === 'non' || (p.enSurcharge === 'oui' && p.poids.trim() !== ''));

/** v4.3 — ids des camions qui DOIVENT être pesés (dépotage) dans un/des dossier(s)
 *  de validation. Les autres opérations ne sont pas pesées (2026-08-19). */
function idsAPeser(dossiers: O[]): Set<string> {
  const s = new Set<string>();
  for (const dos of dossiers)
    for (const grp of [dos['camions'], dos['vehicules']])
      for (const r of ((grp as O[]) ?? []))
        if (exigeControlePoids(r['typeOperation'])) s.add(String(r['id']));
  return s;
}
/** Pesée prête pour un lot : chaque camion À PESER a une pesée complète ; les
 *  autres (non pesés) sont d'office prêts. */
function peseesLotPretes(aValider: string[], aPeser: Set<string>, pesees: Record<string, Pesee>): boolean {
  return aValider.every((id) => !aPeser.has(id) || peseeComplete(pesees[id]));
}
/** Charge utile de pesées pour validerlot, sans planter sur un camion non pesé. */
function payloadPesees(aValider: string[], pesees: Record<string, Pesee>): Record<string, { enSurcharge: boolean; poidsSurcharge: string }> {
  const out: Record<string, { enSurcharge: boolean; poidsSurcharge: string }> = {};
  for (const id of aValider) {
    const p = pesees[id] ?? { enSurcharge: '' as const, poids: '' };
    out[id] = { enSurcharge: p.enSurcharge === 'oui', poidsSurcharge: p.poids };
  }
  return out;
}

/** Une cargaison du dossier : tout ce qu'il faut voir AVANT de signer. */
function LigneValidation({ r, go, pesee, onPesee }: { r: O; go: Nav['go']; pesee?: Pesee; onPesee?: (p: Pesee) => void }) {
  const conts = (r['conteneurs'] as O[]) ?? [];
  const sc = (r['scellesCamion'] as string[]) ?? [];
  const autres = (r['autresDeclarations'] as O[]) ?? [];
  const v = r['vehicule'] as O | undefined;
  const valide = Boolean(r['dateValidation']);
  const pe = pesee ?? { enSurcharge: '' as const, poids: '' };
  // v4.3 — pesée seulement en dépotage (2026-08-19).
  const exigePesee = exigeControlePoids(r['typeOperation']);
  const reste = ((r['etapesEnAttente'] as string[]) ?? []).filter((e) => e !== 'VALIDATION');
  return <div style={{
    border: '1px solid var(--line)', borderLeft: `3px solid var(--${valide ? 'ok' : 'warn'})`,
    borderRadius: 6, padding: 10, marginBottom: 8,
  }}>
    <div className="row" style={{ alignItems: 'center', gap: 8 }}>
      <b className="mono">{String(r['numeroCamion'])}</b>
      <span className={`tag ${valide ? 'st-gps' : 'st-charge'}`}>{valide ? '✓ validée' : 'à valider'}</span>
      {Boolean(r['chargementMixte']) && <span className="tag st-charge">⊞ mixte</span>}
      {/* Hors gabarit : le chef doit le voir AVANT de signer, c'est sa décision. */}
      {Boolean(r['horsGabarit']) && <span className="tag" style={{ background: 'var(--warn-soft)', color: 'var(--warn)' }}>
        ⚠ hors gabarit {String(r['hauteurChargement'] || '?')} m</span>}
      <span style={{ flex: 1 }} />
      <button className="ghost xs" onClick={() => go('detail', r['id'])}>Ouvrir la fiche</button>
    </div>
    <div className="help">{String(r['id'])} · {String(r['typeOperation'])} · {fmtDate(r['dateCreation'])} · Agent CFS {String(r['agentCfs'] || '—')}</div>
    <div className="help">Destination {String(r['destinationMarchandise'] || '—')}{r['nbColis'] ? ` · ${String(r['nbColis'])} colis` : ''}{r['descriptionMarchandise'] ? ` · ${String(r['descriptionMarchandise'])}` : ''}</div>
    {v && <div className="help">Châssis {String(v['chassis'] ?? '')} · {String(v['marque'] ?? '')} {String(v['modele'] ?? '')} · {String(v['destination'] ?? '')}</div>}
    {sc.length > 0 && <div className="help">Scellés camion : {sc.join(' · ')}</div>}
    {autres.length > 0 && <div className="help" style={{ color: 'var(--warn)' }}>
      Porte aussi : {autres.map((a) => `${String(a['libelle'])} (${String(a['nbConteneurs'])} TC)`).join(' · ')} — hors de cette déclaration.
    </div>}
    {valide && <div className="help" style={{ color: 'var(--ok)' }}>Validée par {String(r['agentValidation'] || '—')}{r['roleValidation'] === 'CBPI' ? ' (par intérim)' : ''} le {fmtDate(r['dateValidation'])}</div>}
    {!valide && reste.length > 0 && <div className="help">Restera ensuite : {reste.join(' · ')}</div>}
    {conts.length > 0 && <Table cols={[['num', 'Conteneur'], ['plomb', 'Scellé'], ['taille', 'Taille'], ['type', 'Type']]} rows={conts} />}
    {!conts.length && !v && r['descriptionMarchandise'] ? <div className="help">Effets divers : {String(r['descriptionMarchandise'])}</div> : null}
    {/* v4.1 — pesée à renseigner AVANT la signature (seulement à valider, et
        seulement en DÉPOTAGE : enlèvement / véhicule ne sont pas pesés). */}
    {!valide && onPesee && exigePesee && <div className="row" style={{ alignItems: 'center', gap: 12, flexWrap: 'wrap', marginTop: 8, paddingTop: 8, borderTop: '1px dotted var(--line)' }}>
      <span className="help lbl-icone" style={{ fontWeight: 600 }}>
        <Icone nom="balance" taille={15} />Pesée</span>
      <ChoixSegmente libelle="Pesée du camion" valeur={pe.enSurcharge === 'oui' ? 'oui' : pe.enSurcharge === 'non' ? 'non' : ''}
        options={[{ valeur: 'oui', libelle: 'En surcharge' }, { valeur: 'non', libelle: 'Hors surcharge' }]}
        onChange={(v) => onPesee(v === 'oui' ? { enSurcharge: 'oui', poids: pe.poids } : { enSurcharge: 'non', poids: '' })} />
      {pe.enSurcharge === 'oui' && <input value={pe.poids} onChange={(e) => onPesee({ enSurcharge: 'oui', poids: e.target.value.replace(/[^0-9.,]/g, '') })}
        placeholder="Poids surcharge (kg)" style={{ maxWidth: 160 }} />}
    </div>}
  </div>;
}

/* ------------------------------ Rapports ------------------------------- */
/**
 * Période d'un rapport — les 4 périodes glissantes usuelles PLUS une PLAGE
 * PERSONNALISÉE (décision utilisateur) : les périodes calendaires ne couvrent
 * pas les questions réelles (« du 3 au 17 », une campagne, un mois écoulé à
 * cheval sur deux mois). Un seul hook pour tous les rapports et le tableau de
 * bord, afin que la période se choisisse partout de la même façon.
 */
function useReportRange(initial: ModePeriode = 'semaine') {
  const [m, setM] = useState<ModePeriode>(initial);
  // Plage personnalisée amorcée sur le mois en cours : basculer en
  // « Personnalisée » part de ce que l'agent a sous les yeux au lieu de vider
  // l'écran ou de le réduire à une seule journée.
  const [duP, setDuP] = useState(() => bornesDe('mois')[0]);
  const [auP, setAuP] = useState(() => isoDate(new Date()));
  const brut = m === 'perso' ? { du: duP, au: auP } : (() => { const [du, au] = bornesDe(m); return { du, au }; })();
  const { du, au, inversee } = normaliserPlage(brut.du, brut.au);
  return { m, setM, du, au, duP, setDuP, auP, setAuP, inversee };
}

type Periode = ReturnType<typeof useReportRange>;

function PeriodPicker({ p }: { p: Periode }) {
  return <>
    <select value={p.m} onChange={(e) => p.setM(e.target.value as ModePeriode)} style={{ maxWidth: 170 }}>
      <option value="jour">Journalier</option>
      <option value="semaine">Hebdomadaire</option>
      <option value="mois">Mensuel</option>
      <option value="annee">Annuel</option>
      <option value="perso">Plage personnalisée…</option>
    </select>
    {p.m === 'perso' && <span className="row" style={{ gap: 6, alignItems: 'center' }}>
      <label className="help" style={{ margin: 0 }}>du</label>
      <input type="date" value={p.duP} onChange={(e) => p.setDuP(e.target.value)} style={{ maxWidth: 155 }} />
      <label className="help" style={{ margin: 0 }}>au</label>
      <input type="date" value={p.auP} onChange={(e) => p.setAuP(e.target.value)} style={{ maxWidth: 155 }} />
    </span>}
  </>;
}

/** Rappel de la période effectivement interrogée, sous le titre du rapport. */
function PeriodeLue({ p }: { p: Periode }) {
  return <div className="help">Du {fmtJour(p.du)} au {fmtJour(p.au)}
    {p.inversee && <span style={{ color: 'var(--warn)' }}> — dates inversées, remises à l'endroit</span>}
  </div>;
}

/**
 * v4.1 — Rapports de cellule (CFS, Balise, PP) reproduits À L'IDENTIQUE de
 * l'Apps Script (décision utilisateur 2026-07-22) : un bloc PAR OPÉRATION
 * (Enlèvement / Dépotage), des cartes cliquables — Camions, [TWINS], 20', 40',
 * 45', Autres, Total conteneurs, EVP — et un clic ouvre la LISTE détaillée
 * (camions ou conteneurs), chaque ligne ouvrant la fiche. Plus un bloc TOTAL.
 * `twins`/`camLabel` distinguent les trois cellules ; la donnée par taille était
 * déjà calculée côté serveur.
 */
type MetriqueCellule = 'camions' | 'twins' | 't20' | 't40' | 't45' | 'autres' | 'conteneurs';

/**
 * Rapport d'une cellule — sert CINQ écrans (CFS, Balise, PP, T1, Bon de sortie).
 *
 * 2026-09-11 : `etape` et `icone` donnent à chacun l'identité visuelle de son
 * poste — la pastille du menu, la teinte du parcours et des tuiles. Un chef qui
 * passe d'un rapport à l'autre sait où il est avant d'avoir lu le titre.
 */
function RapportCellule({ action, detail, titre, twins, camLabel, go, etape, icone }: {
  action: string; detail: string; titre: string; twins?: boolean; camLabel: string; go: Nav['go'];
  etape?: string; icone?: string;
}) {
  const p = useReportRange();
  const { m, du, au } = p;
  const [op, setOp] = useState('');
  const { data, loading } = useAsync<O>(() => call(action, { du, au, periode: m, operation: op }), [du, au, op]);
  const [modal, setModal] = useState<{ op: string; metric: MetriqueCellule } | null>(null);
  async function exporter(fmt: string) { const f = await call<O>(action, { du, au, periode: m, operation: op, format: fmt }); telecharger(f); }

  const parOp = (data?.['parOp'] ?? {}) as Record<string, O>;
  const total = (data?.['total'] ?? {}) as O;
  const evpDe = (o: O) => Number(o['t20'] ?? 0) + 2 * (Number(o['t40'] ?? 0) + Number(o['t45'] ?? 0));

  /* La tuile prend la TEINTE DU POSTE, et un chevron quand elle ouvre un
     détail : rien ne distinguait jusqu'ici une carte cliquable d'un simple
     compteur — le curseur ne se voit pas sur un poste tactile. */
  function Carte({ n, l, op: o, metric, tone }: { n: unknown; l: string; op?: string; metric?: MetriqueCellule; tone?: 'ok' }) {
    const cls = `stat ${tone ?? ''} ${etape && !tone ? 'et-' + etape : ''}`;
    if (!metric) return <div className={cls}><div className="n">{Number(n ?? 0)}</div><div className="l">{l}</div></div>;
    return <div className={`${cls} cliquable`} role="button" tabIndex={0} title="Voir le détail"
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setModal({ op: o ?? '', metric }); } }}
      onClick={() => setModal({ op: o ?? '', metric })}>
      <div className="n">{Number(n ?? 0)}</div><div className="l">{l}</div>
      <span className="stat-clic" aria-hidden="true"><Icone nom="chevron" taille={15} /></span>
    </div>;
  }
  function Bloc({ nom, o, a }: { nom: string; o: string; a: O }) {
    return <div className={`card ${etape ? 'et-' + etape : ''}`}>
      <div className="ecran-tete">
        <span className="tete-pastille" aria-hidden="true">
          <Icone nom={nom === OPERATIONS.DEPOTAGE ? 'conteneur' : 'camion'} taille={20} />
        </span>
        <h2 style={{ flex: 1, margin: 0, minWidth: 0 }}>{nom}</h2>
      </div><div className="stats">
      <Carte n={a['camions']} l={camLabel} op={o} metric="camions" />
      {twins && <Carte n={a['twins']} l="TWINS" op={o} metric="twins" />}
      <Carte n={a['t20']} l="20'" op={o} metric="t20" />
      <Carte n={a['t40']} l="40'" op={o} metric="t40" />
      <Carte n={a['t45']} l="45'" op={o} metric="t45" />
      <Carte n={a['autres']} l="Autres / n.p." op={o} metric="autres" />
      <Carte n={a['conteneurs']} l="Total conteneurs" op={o} metric="conteneurs" />
      <Carte n={evpDe(a)} l="EVP" tone="ok" />
    </div><p className="help">Cliquez une carte pour voir le détail.</p></div>;
  }

  return <>
    <BandeauModule icone={icone ?? 'rapport'} titre={titre}
      sous={<PeriodeLue p={p} />}
      action={<div className="bm-outils">
        <select value={op} onChange={(e) => setOp(e.target.value)} style={{ maxWidth: 190 }}>
          <option value="">Toutes opérations</option><option>{OPERATIONS.ENLEVEMENT}</option><option>{OPERATIONS.DEPOTAGE}</option>
        </select>
        <PeriodPicker p={p} />
        <button onClick={() => exporter('xlsx')}><Icone nom="telecharger" taille={14} />Excel</button>
        <button onClick={() => exporter('pdf')}><Icone nom="telecharger" taille={14} />PDF</button>
      </div>} />
    {loading ? <Spinner /> : <>
      {(op === '' || op === OPERATIONS.ENLEVEMENT) && <Bloc nom={OPERATIONS.ENLEVEMENT} o={OPERATIONS.ENLEVEMENT} a={parOp[OPERATIONS.ENLEVEMENT] ?? {}} />}
      {(op === '' || op === OPERATIONS.DEPOTAGE) && <Bloc nom={OPERATIONS.DEPOTAGE} o={OPERATIONS.DEPOTAGE} a={parOp[OPERATIONS.DEPOTAGE] ?? {}} />}
      {op === '' && <div className="card"><h2>Total</h2><div className="stats">
        <Carte n={total['camions']} l={`TOTAL ${camLabel.toLowerCase()}`} op="" metric="camions" />
        {twins && <Carte n={total['twins']} l="TOTAL TWINS" op="" metric="twins" />}
        <Carte n={total['conteneurs']} l="TOTAL conteneurs" op="" metric="conteneurs" />
        <Carte n={evpDe(total)} l="EVP" tone="ok" />
      </div></div>}
    </>}
    {modal && <DetailCellule detail={detail} du={du} au={au} op={modal.op} metric={modal.metric} go={go} onClose={() => setModal(null)} />}
  </>;
}

/** Modal de détail d'une carte de rapport : liste de camions OU de conteneurs. */
function DetailCellule({ detail, du, au, op, metric, go, onClose }: {
  detail: string; du: string; au: string; op: string; metric: MetriqueCellule; go: Nav['go']; onClose: () => void;
}) {
  const { data, loading } = useAsync<{ kind?: string; titre?: string; rows: O[] }>(
    () => call(detail, { du, au, operation: op, metric }), []);
  const rows = data?.rows ?? [];
  const estCamions = data?.['kind'] === 'camions' || metric === 'camions' || metric === 'twins';
  const ouvrir = (id: unknown) => { onClose(); if (id) go('detail', id); };
  return <Modal onClose={onClose}>
    <h2><span className="tp-pastille" aria-hidden="true"><Icone nom="liste" taille={18} /></span>{(op || 'Toutes opérations')} — {data?.titre ?? '…'} ({rows.length})</h2>
    {loading ? <Spinner /> : rows.length === 0 ? <div className="empty">Aucun élément sur la période.</div>
      : estCamions
        ? <Table cols={[['numeroCamion', 'Camion'], ['typeOperation', 'Opération'], ['statut', 'Statut'], ['numeroGps', 'N° GPS'], ['nbConteneurs', 'Nb cont.']]} rows={rows} onRow={(r) => ouvrir(r['id'])} />
        : <Table cols={[['conteneur', 'Conteneur'], ['taille', 'Taille'], ['type', 'Type'], ['scelle', 'Scellé'], ['numeroCamion', 'Camion'], ['cargaisonId', 'Cargaison']]} rows={rows} onRow={(r) => ouvrir(r['cargaisonId'] ?? r['id'])} />}
  </Modal>;
}

SCREENS.cfsreport = ({ go }) => <RapportCellule action="report.cfs" detail="report.cfsdetail" titre="Rapport CFS" camLabel="Camions" go={go} etape="cfs" icone="presse" />;
SCREENS.baliserep = ({ go }) => <RapportCellule action="report.balise" detail="report.balisedetail" titre="Rapport Balise (pose balise)" twins camLabel="Camions balisés" go={go} etape="balise" icone="balise" />;
SCREENS.pprep = ({ go }) => <RapportCellule action="report.pp" detail="report.ppdetail" titre="Rapport Porte Principale (sorties)" camLabel="Camions sortis" go={go} etape="pp" icone="sortie" />;
// v4.3 — rapports des cellules T1 et Bon de sortie, datés à leur propre cellule.
SCREENS.t1report = ({ go }) => <RapportCellule action="report.t1" detail="report.t1detail" titre="Rapport T1 (T1 saisis)" camLabel="Camions (T1)" go={go} etape="t1" icone="t1" />;
SCREENS.bonsortiereport = ({ go }) => <RapportCellule action="report.bonsortie" detail="report.bonsortiedetail" titre="Rapport Bon de sortie (bons émis)" camLabel="Camions (bons émis)" go={go} etape="bs" icone="bonSortie" />;

SCREENS.vehreport = () => {
  const p = useReportRange();
  const { m, du, au } = p;
  const { data, loading } = useAsync<O>(() => call('report.vehicule', { du, au, periode: m }), [du, au]);
  const cp = (data?.['compte'] ?? {}) as O; const pd = (data?.['parDest'] ?? {}) as O;
  return <><BandeauModule icone="voiture" titre="Rapport véhicules" sous={<PeriodeLue p={p} />}
    action={<div className="bm-outils"><PeriodPicker p={p} /></div>} />
  <div className="card">
    {loading ? <Spinner /> : <div className="stats">
      <StatCard n={Number(cp['total'] ?? 0)} l="Total" /><StatCard n={Number(cp['attente'] ?? 0)} l="En attente" /><StatCard n={Number(cp['sortis'] ?? 0)} l="Sortis" tone="ok" />
      {VEHICULE_DESTINATIONS.map((x) => <StatCard key={x} n={Number(pd[x] ?? 0)} l={x} />)}
    </div>}
  </div></>;
};

SCREENS.kpi = () => {
  const { data, loading } = useAsync<O>(() => call('report.kpi', {}), []);
  const k = data ?? {};
  return <div className="card"><h2>KPI / EVP</h2>
    {loading ? <Spinner /> : <div className="stats">
      <StatCard n={Number(k['videsDepotage'] ?? 0)} l="Conteneurs dépotés" />
      <StatCard n={Number(k['sortisScelles'] ?? 0)} l="Sortis scellés" />
      <StatCard n={Number(k['camionsActifs'] ?? 0)} l="Camions actifs" />
      <StatCard n={Number(k['camionsSortis'] ?? 0)} l="Camions sortis" tone="ok" />
      <StatCard n={Number(k['evpVides'] ?? 0)} l="EVP dépotés" />
      <StatCard n={Number(k['evpStock'] ?? 0)} l="EVP en stock" />
    </div>}
  </div>;
};

SCREENS.dispenses = () => {
  const { data, loading } = useAsync<{ compte: O; rows: O[] }>(() => call('report.dispenses', {}), []);
  return <div className="card"><h2>Suivi des dispenses</h2>
    {loading ? <Spinner /> : <>
      <div className="stats"><StatCard n={Number(data?.compte['total'] ?? 0)} l="Total" /><StatCard n={Number(data?.compte['enCours'] ?? 0)} l="En cours" tone="warn" /><StatCard n={Number(data?.compte['terminees'] ?? 0)} l="Terminées" tone="ok" /></div>
      <Table cols={[['id', 'ID'], ['numeroCamion', 'Camion'], ['numeroDispense', 'N° dispense'], ['statut', 'Statut']]} rows={data?.rows ?? []} />
    </>}
  </div>;
};

const MOIS_COURT = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'];

/**
 * Étiquettes de l'axe X.
 *
 * Elles valaient « S1, S2… » et « M1, M2… » : sur un graphique couvrant une
 * année, personne ne peut dire de quel mois parle « M7 », et il faut
 * redescendre dans le tableau pour le savoir — ce qui vide le graphique de son
 * intérêt. La clé de période renvoyée par le serveur porte l'information
 * (`2026`, `2026-07`, `2026-07-06`) : on l'affiche telle qu'un agent la lit.
 */
function libellesPeriode(rows: O[], gran: string): string[] {
  return rows.map((r) => {
    const k = String(r['periode'] ?? '');
    if (gran === 'annee') return k;
    const [a, m, j] = k.split('-');
    if (gran === 'mois') return m ? `${MOIS_COURT[Number(m) - 1] ?? m} ${String(a).slice(2)}` : k;
    // Semaine : la clé est le lundi. « sem. 06/07 » se repère sur un calendrier.
    if (gran === 'semaine') return j ? `sem. ${j}/${m}` : k;
    return j ? `${j}/${m}` : k;
  });
}

SCREENS.flux = () => {
  // Deux filtres DISTINCTS : la PÉRIODE borne l'analyse (plage personnalisée
  // comprise), le REGROUPEMENT (« répartition de la période ») décide de la
  // maille — un point par semaine, par mois ou par an.
  const p = useReportRange('annee');
  const { du, au } = p;
  const [gran, setGran] = useState('mois');
  const { data, loading } = useAsync<{ rows: O[]; totaux: O }>(
    () => call('report.flux', { granularite: gran, du, au }), [gran, du, au]);
  const rows = data?.rows ?? [];
  const tot = (data?.totaux ?? {}) as O;
  const cats = libellesPeriode(rows, gran);
  const series = [
    { nom: 'Conteneurs enlevés', valeurs: rows.map((r) => Number(r['enlevesC'] ?? 0)) },
    { nom: 'Conteneurs dépotés', valeurs: rows.map((r) => Number(r['depotesC'] ?? 0)) },
    { nom: 'Camions balisés', valeurs: rows.map((r) => Number(r['baliseC'] ?? 0)) },
    { nom: 'Camions sortis', valeurs: rows.map((r) => Number(r['ppC'] ?? 0)) },
  ];
  return <>
    <div className="card">
      <BandeauModule icone="flux" titre="Analyse des flux" sous={<PeriodeLue p={p} />}
        action={<div className="bm-outils"><PeriodPicker p={p} /></div>} />
      <div className="row" style={{ alignItems: 'center', marginTop: 6 }}>
        <label className="help" style={{ margin: 0 }}>Répartition de la période</label>
        <select value={gran} onChange={(e) => setGran(e.target.value)} style={{ maxWidth: 160 }}>
          <option value="semaine">Hebdomadaire</option><option value="mois">Mensuelle</option><option value="annee">Annuelle</option>
        </select>
        <span style={{ flex: 1 }} /><PeriodeLue p={p} />
      </div>
    </div>
    {loading ? <Spinner /> : <>
      <div className="card"><div className="stats">
        <StatCard n={Number(tot['enlevesC'] ?? 0)} l="Conteneurs enlevés" />
        <StatCard n={Number(tot['depotesC'] ?? 0)} l="Conteneurs dépotés" />
        <StatCard n={Number(tot['tc'] ?? 0)} l="Total conteneurs (TC)" />
        <StatCard n={Number(tot['evp'] ?? 0)} l="Total EVP" />
        <StatCard n={Number(tot['baliseC'] ?? 0)} l="Camions balisés" />
        <StatCard n={Number(tot['ppC'] ?? 0)} l="Camions sortis" tone="ok" />
      </div></div>
      <div className="card"><h2>Évolution du flux</h2>
        <p className="help" style={{ marginTop: 0 }}>Volume traité par période. Isolez une série pour la lire seule.</p>
        <Graphique cats={cats} series={series} type="barres" ordonnee="Nombre" valeursSurBarres /></div>
      <div className="card"><h2>Répartition cumulée</h2>
        <p className="help" style={{ marginTop: 0 }}>La même donnée empilée : la hauteur totale donne la charge de la période.</p>
        <Graphique cats={cats} series={series} type="barresEmpilees" ordonnee="Total" hauteur={260} /></div>
      <div className="card"><h2>Détail chiffré</h2>
        <Table cols={[['periode', 'Période'], ['enlevesC', 'Cont. enlevés'], ['depotesC', 'Cont. dépotés'], ['tc', 'Total TC'], ['evp', 'EVP'], ['baliseC', 'Camions balisés'], ['ppC', 'Camions sortis']]} rows={rows} /></div>
    </>}
  </>;
};

/* ------- v4.1 : Statistiques de contrôle (hors gabarit / surcharge / transit) */
SCREENS.controles = () => {
  const p = useReportRange('mois');
  const { m, du, au } = p;
  const { data, loading } = useAsync<O>(() => call('report.controles', { du, au, periode: m }), [du, au]);
  const hg = (data?.['horsGabarit'] ?? {}) as O;
  const su = (data?.['surcharge'] ?? {}) as O;
  const tn = (data?.['transitNational'] ?? {}) as O;
  /* Chaque motif de contrôle porte SON icône : un gabarit se mesure (balance),
     une surcharge aussi, un transit national est un régime de déclaration. Les
     deux tuiles d'un bloc disent camions et conteneurs — elles reçoivent donc
     l'icône correspondante, comme dans les tableaux. */
  const bloc = (titre: string, o: O, icone: string, tone?: 'warn') =>
    <div className="card">
      <div className="ecran-tete">
        <span className="tete-pastille" aria-hidden="true"><Icone nom={icone} taille={20} /></span>
        <h2 style={{ flex: 1, margin: 0, minWidth: 0 }}>{titre}</h2>
      </div>
      <div className="stats">
        <StatCard n={Number(o['camions'] ?? 0)} l="Camions" tone={tone} etape="cfs" />
        <StatCard n={Number(o['conteneurs'] ?? 0)} l="Conteneurs" tone={tone} etape="t1" />
      </div>
    </div>;
  return <>
    <BandeauModule icone="balance" titre="Statistiques de contrôle" sous={<PeriodeLue p={p} />}
      action={<div className="bm-outils"><PeriodPicker p={p} /></div>} />
    {loading ? <Spinner /> : <>
      {/* Trois blocs de cartes se lisent isolément mais ne se COMPARENT pas :
          on ne voit pas lequel pèse le plus, ni dans quelle proportion. */}
      <div className="card">
        <div className="ecran-tete">
          <span className="tete-pastille" aria-hidden="true"><Icone nom="rapport" taille={20} /></span>
          <h2 style={{ flex: 1, margin: 0, minWidth: 0 }}>Comparaison des motifs de contrôle</h2>
        </div>
        <Graphique
          cats={['Hors gabarit', 'Surcharge', 'Transit national (TG)']}
          series={[
            { nom: 'Camions', valeurs: [Number(hg['camions'] ?? 0), Number(su['camions'] ?? 0), Number(tn['camions'] ?? 0)] },
            { nom: 'Conteneurs', valeurs: [Number(hg['conteneurs'] ?? 0), Number(su['conteneurs'] ?? 0), Number(tn['conteneurs'] ?? 0)] },
          ]}
          type="barres" ordonnee="Nombre" hauteur={250} valeursSurBarres /></div>
      {bloc('Hors gabarit', hg, 'balance', 'warn')}
      {bloc('Surcharge', su, 'camion', 'warn')}
      {bloc('Transit national (TG)', tn, 'drapeau')}
    </>}
  </>;
};

/* ------- v4.1 : Répartition des cargaisons par destination ------------- */
SCREENS.destinations = () => {
  const p = useReportRange('annee');
  const { du, au } = p;
  const [gran, setGran] = useState('mois');
  const { data, loading } = useAsync<O>(() => call('report.destinations', { du, au, granularite: gran }), [du, au, gran]);
  const parDest = (data?.['parDest'] ?? {}) as O;
  const codes = (data?.['codes'] ?? []) as string[];
  const seriesData = (data?.['series'] ?? []) as O[];
  const cats = libellesPeriode(seriesData, gran);
  // Une ligne par destination réellement présente sur la période (évite un fouillis de zéros).
  const actifs = codes.filter((c) => Number(parDest[c] ?? 0) > 0);
  const series = (actifs.length ? actifs : codes).map((c) => ({ nom: c, valeurs: seriesData.map((s) => Number(s[c] ?? 0)) }));
  return <>
    <div className="card">
      <BandeauModule icone="carte" titre="Répartition par destination" sous={<PeriodeLue p={p} />}
        action={<div className="bm-outils"><PeriodPicker p={p} /></div>} />
      <div className="row" style={{ alignItems: 'center', marginTop: 6 }}>
        <label className="help" style={{ margin: 0 }}>Répartition de la période</label>
        <select value={gran} onChange={(e) => setGran(e.target.value)} style={{ maxWidth: 160 }}>
          <option value="semaine">Hebdomadaire</option><option value="mois">Mensuelle</option><option value="annee">Annuelle</option>
        </select>
        <span style={{ flex: 1 }} /><PeriodeLue p={p} />
      </div>
    </div>
    {loading ? <Spinner /> : <>
      <div className="card"><div className="help" style={{ marginBottom: 6 }}>Camions sortis vers chaque destination sur la période — {Number(data?.['total'] ?? 0)} au total.</div>
        <div className="stats">{codes.map((c) => <StatCard key={c} n={Number(parDest[c] ?? 0)} l={c} />)}</div></div>
      {/* Le classement répond à « qui pèse le plus », que la courbe ne dit pas :
          avec une destination à 80 % du volume, toutes les autres se confondent
          avec l'axe. Les deux vues sont complémentaires. */}
      <div className="card"><h2>Classement des destinations</h2>
        <BarresClassees lignes={codes.map((c) => ({ nom: c, valeur: Number(parDest[c] ?? 0) }))}
          total={Number(data?.['total'] ?? 0)} max={10} /></div>
      <div className="card"><h2>Évolution des camions sortis par destination</h2>
        <Graphique cats={cats} series={series} type="lignes" ordonnee="Camions sortis" /></div>
    </>}
  </>;
};

/* -------------------- v4.2 : temps de passage par poste ---------------- */

/**
 * Combien de temps un dossier reste-t-il à chaque poste, et combien de temps
 * s'écoule entre l'entrée du camion et sa sortie à la Porte Principale.
 *
 * Trois niveaux de lecture, du plus général au plus fin : la performance
 * globale en tête, la moyenne par poste ensuite, puis le détail dossier par
 * dossier. Le graphique journalier répond à la question posée : « aujourd'hui,
 * combien de temps a mis la marchandise à chaque poste ».
 */
SCREENS.temps = ({ go }) => {
  const p = useReportRange('semaine');
  const { du, au } = p;
  const [avecVeh, setAvecVeh] = useState(true);
  const [busy, setBusy] = useState(false);
  const { data, loading, error } = useAsync<O>(
    () => call('report.temps', { du, au, ...(avecVeh ? {} : { vehicules: false }) }), [du, au, avecVeh]);

  async function exporter(fmt: 'xlsx' | 'pdf') {
    setBusy(true);
    try {
      const r = await call<O>('report.temps', { du, au, format: fmt, ...(avecVeh ? {} : { vehicules: false }) });
      if (fmt === 'pdf') imprimerHtml(String(r['html'] ?? '')); else telecharger(r);
    } catch (e) { toast((e as Error).message, 'err'); } finally { setBusy(false); }
  }

  const cp = (data?.['compte'] ?? {}) as O;
  const glob = (data?.['global'] ?? {}) as O;
  const postes = (data?.['postes'] ?? []) as O[];
  const parJour = (data?.['parJour'] ?? []) as O[];
  const lignes = (data?.['lignes'] ?? []) as O[];

  const cats = parJour.map((j) => fmtJour(String(j['jour'])));
  // ⚠ Ne PAS remplacer une absence de mesure par 0 : le serveur renvoie `null`
  // quand aucun dossier n'a été mesuré à ce poste ce jour-là, et la courbe doit
  // se couper. Un `?? 0` afficherait « zéro minute d'attente », soit l'inverse
  // de la réalité.
  const series = POSTES_UI.map(([cle, nom]) => ({
    nom,
    valeurs: parJour.map((j) => (j[cle] === null || j[cle] === undefined ? null : Number(j[cle]))),
  }));

  return <>
    <div className="card">
      <BandeauModule icone="sablier" titre="Temps de passage par poste" sous={<PeriodeLue p={p} />}
        action={<div className="bm-outils"><PeriodPicker p={p} /></div>} />
      <div className="row" style={{ alignItems: 'center', flexWrap: 'wrap', gap: 8, marginTop: 6 }}>
        <label className="help" style={{ display: 'flex', gap: 6, alignItems: 'center', margin: 0 }}>
          <input type="checkbox" style={{ width: 'auto' }} checked={avecVeh} onChange={(e) => setAvecVeh(e.target.checked)} />
          <span>Inclure les véhicules</span>
        </label>
        <span style={{ flex: 1 }} />
        <button className="ghost xs" disabled={busy} onClick={() => exporter('xlsx')}>⤓ Excel</button>
        <button className="ghost xs" disabled={busy} onClick={() => exporter('pdf')}>⤓ PDF</button>
      </div>
      <PeriodeLue p={p} />
      <p className="help" style={{ marginBottom: 0 }}>
        Un dossier est rattaché au <b>jour d'entrée du camion</b>. Pour la journée en cours,
        les moyennes ne portent donc que sur les dossiers <b>déjà sortis</b> — l'effectif
        mesuré est indiqué à côté de chaque chiffre.
      </p>
    </div>

    {loading ? <Spinner /> : error ? (
      /Action inconnue|Action non gérée/.test(error)
        ? <div className="card"><div className="empty">Écran disponible dès la prochaine mise à jour du serveur.</div></div>
        : <div className="card"><div className="err-msg">{error}</div></div>
    ) : <>
      <div className="card">
        <h2>Performance globale — entrée du camion → sortie à la PP</h2>
        <div className="stats">
          <StatCard n={Number(cp['dossiers'] ?? 0)} l="Dossiers de la période" />
          <StatCard n={Number(cp['sortis'] ?? 0)} l="Déjà sortis" tone="ok" />
          <StatCard n={dureeLisible(glob['moyenne'] as number | null)} l={`Temps moyen (${Number(glob['n'] ?? 0)} mesurés)`} />
          <StatCard n={dureeLisible(glob['mediane'] as number | null)} l="Temps médian" />
          <StatCard n={dureeLisible(glob['p90'] as number | null)} l="9 dossiers sur 10 en moins de" />
        </div>
        {Number(cp['sansFin'] ?? 0) > 0 && <p className="help" style={{ color: 'var(--warn)', marginBottom: 0 }}>
          ⚠ {String(cp['sansFin'])} dossier(s) sans horodatage de fin de chargement — antérieurs à la mise en service
          de cette mesure. Leur <b>temps global reste exact</b>, mais le détail par poste n'est pas
          reconstituable et n'est donc pas compté (plutôt que d'être inventé).
        </p>}
        {Number(cp['incoherents'] ?? 0) > 0 && <p className="help" style={{ color: 'var(--warn)', marginBottom: 0 }}>
          ⚠ {String(cp['incoherents'])} dossier(s) portent des dates incohérentes (une étape enregistrée
          avant l'étape qui la précède). Ces durées sont écartées des moyennes — voir la colonne du détail.
        </p>}
      </div>

      <div className="card">
        <h2>Moyenne par poste sur la période</h2>
        <Table
          cols={[['libelle', 'Poste'], ['nTxt', 'Dossiers mesurés'], ['moyenneTxt', 'Moyenne'], ['medianeTxt', 'Médiane'], ['p90Txt', '9 sur 10 sous'], ['maxTxt', 'Maximum']]}
          rows={postes.map((x) => ({
            libelle: x['libelle'], nTxt: String(x['n'] ?? 0),
            moyenneTxt: dureeLisible(x['moyenne'] as number | null),
            medianeTxt: dureeLisible(x['mediane'] as number | null),
            p90Txt: dureeLisible(x['p90'] as number | null),
            maxTxt: dureeLisible(x['max'] as number | null),
          }))} />
      </div>

      <div className="card">
        <h2>Temps moyen par jour et par poste</h2>
        <p className="help" style={{ marginTop: 0 }}>
          Un jour sans dossier mesuré à un poste <b>coupe la courbe</b> au lieu de retomber à zéro :
          une absence de mesure n'est pas une performance parfaite.
        </p>
        {parJour.length ? <Graphique cats={cats} series={series} type="lignes" ordonnee="Durée"
          format={(v) => dureeLisible(Math.round(v * 60))} hauteur={320} />
          : <div className="empty">Aucun dossier sur la période.</div>}
      </div>

      <div className="card">
        <h2>Détail par dossier ({lignes.length})</h2>
        <Table
          cols={[['numeroCamion', 'Camion / Châssis'], ['declaration', 'Déclaration'], ['jourTxt', 'Entré le'],
            ['cfsTxt', 'CFS'], ['validationTxt', 'Brigade'], ['t1Txt', 'T1'], ['baliseTxt', 'Balise'], ['bsTxt', 'Bon sortie'], ['ppTxt', 'PP'], ['globalTxt', 'GLOBAL']]}
          rows={lignes.map((l) => ({
            id: l['id'], numeroCamion: l['numeroCamion'], declaration: l['declaration'],
            jourTxt: fmtJour(String(l['jour'] ?? '')),
            cfsTxt: dureeLisible(l['cfs'] as number | null),
            validationTxt: dureeLisible(l['validation'] as number | null),
            t1Txt: dureeLisible(l['t1'] as number | null),
            baliseTxt: dureeLisible(l['balise'] as number | null),
            bsTxt: dureeLisible(l['bs'] as number | null),
            ppTxt: dureeLisible(l['pp'] as number | null),
            globalTxt: (l['incoherent'] ? '⚠ ' : '') + dureeLisible(l['global'] as number | null),
          }))}
          onRow={(r) => go('detail', r['id'])} />
        <p className="help" style={{ marginBottom: 0 }}>
          « — » = étape non mesurée : cellule sautée par nature (type C/A sans T1, véhicule sans balise),
          étape pas encore faite, ou dossier antérieur à la mise en service de la mesure.
        </p>
      </div>
    </>}
  </>;
};

/* --------- v4.3 : Horodatage / plage d'activité par cellule ------------ */
/**
 * Heures de travail de chaque cellule (2026-08-19) : pour la période choisie,
 * chaque agent voit, PAR JOUR, son heure de début (1re action), de fin (dernière
 * action), sa durée d'activité et le volume traité (camions / conteneurs). Chaque
 * agent d'une cellule voit TOUTE la cellule (pas seulement lui-même).
 */
const CELLULES_HORODATAGE: [string, string][] = [
  ['', 'Toutes les cellules'], ['CFS', 'CFS (entrée / chargement)'], ['VALIDATION', 'Validation (chef brigade)'],
  ['T1', 'Cellule T1'], ['BALISE', 'Cellule Balise'], ['BS', 'Bon de sortie'], ['PP', 'Porte principale (sortie)'],
];
SCREENS.horodatage = () => {
  const p = useReportRange('jour'); // par défaut : la journée d'aujourd'hui
  const { du, au } = p;
  const [cellule, setCellule] = useState('');
  const { data, loading } = useAsync<O>(() => call('report.horodatage', { du, au, cellule }), [du, au, cellule]);
  const rows = ((data?.['rows'] as O[]) ?? []).map((r) => ({
    ...r, dureeTxt: dureeLisible(Number(r['dureeMin'] ?? 0)), jourTxt: fmtJour(String(r['jour'] ?? '')),
  }));
  const [busy, setBusy] = useState(false);
  async function exporter() {
    setBusy(true);
    try { telecharger(await call<O>('report.horodatage', { du, au, cellule, format: 'xlsx' })); }
    catch (e) { toast((e as Error).message, 'err'); } finally { setBusy(false); }
  }
  return <><BandeauModule icone="horloge" titre="Plage d'activité par cellule" sous={<PeriodeLue p={p} />}
    action={<div className="bm-outils"><PeriodPicker p={p} /></div>} />
  <div className="card">
    <p className="help" style={{ marginTop: 0 }}>
      Pour chaque cellule et chaque agent, PAR JOUR : heure de <b>début</b> (première action),
      heure de <b>fin</b> (dernière action), <b>durée</b> d'activité et <b>volume</b> traité.
    </p>
    <div className="row" style={{ alignItems: 'center', flexWrap: 'wrap', gap: 8, marginBottom: 10 }}>
      <select value={cellule} onChange={(e) => setCellule(e.target.value)} style={{ maxWidth: 240 }}>
        {CELLULES_HORODATAGE.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
      <span style={{ flex: 1 }} />
      <button className="ghost xs" disabled={busy} onClick={exporter}>⤓ Excel</button>
    </div>
    {loading ? <Spinner /> : rows.length === 0
      ? <div className="empty">Aucune activité sur la période.</div>
      : <Table cols={[['celluleLibelle', 'Cellule'], ['agent', 'Agent'], ['jourTxt', 'Jour'],
        ['debut', 'Début'], ['fin', 'Fin'], ['dureeTxt', 'Durée'], ['camions', 'Camions'], ['conteneurs', 'Conteneurs']]}
        rows={rows} />}
  </div></>;
};

/* --------- v4.3 : Nettoyage des vieux dossiers « goulots » -------------- */
/**
 * Archivage des vieux dossiers (2026-08-19). Les dossiers migrés jamais menés à
 * la sortie restent « en attente » pour toujours et gonflent les files. Cet
 * écran les analyse (par statut / poste / âge) et permet à l'ADMIN de les
 * ARCHIVER — clôture RÉVERSIBLE et TRACÉE : rien n'est supprimé, ils sortent
 * seulement des files et des rapports. Un désarchivage les réactive.
 */
function BlocArchives() {
  const { data, loading, reload } = useAsync<{ total: number; rows: O[] }>(() => call('report.archives', {}), []);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const rows = data?.rows ?? [];
  const toggle = (id: string) => setSel((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  async function desarchiver() {
    if (!sel.size) return;
    setBusy(true);
    try { await call('cargo.desarchiver', { ids: [...sel] }); toast(`${sel.size} réactivé(s).`, 'ok'); setSel(new Set()); reload(); }
    catch (e) { toast((e as Error).message, 'err'); } finally { setBusy(false); }
  }
  return <details className="card">
    <summary style={{ cursor: 'pointer', fontWeight: 600 }}>Dossiers archivés {data ? `(${data.total})` : ''} — désarchiver</summary>
    {loading ? <Spinner /> : rows.length === 0 ? <p className="help">Aucun dossier archivé.</p> : <>
      <div className="row" style={{ margin: '8px 0' }}>
        <button disabled={busy || !sel.size} onClick={desarchiver}><Icone nom="fleche" taille={15} /> Désarchiver la sélection ({sel.size})</button>
      </div>
      <div className="tbl"><table><thead><tr>
        <th style={{ width: 28 }}></th><th>ID</th><th>Camion</th><th>Statut</th><th>Archivé le</th><th>Par</th><th>Motif</th>
      </tr></thead><tbody>{rows.map((r) => <tr key={String(r['id'])}>
        <td><input type="checkbox" checked={sel.has(String(r['id']))} onChange={() => toggle(String(r['id']))} /></td>
        <td className="mono">{String(r['id'])}</td><td><NumeroMobile valeur={r['numeroCamion']} /></td>
        <td>{String(r['statut'])}</td><td>{fmtDate(r['archiveLe'])}</td><td>{String(r['archivePar'] || '—')}</td>
        <td>{String(r['archiveMotif'] || '—')}</td>
      </tr>)}</tbody></table></div>
    </>}
  </details>;
}

SCREENS.goulots = (nav) => {
  const admin = nav.user.role === 'ADMIN';
  const [jours, setJours] = useState(90);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [motif, setMotif] = useState('');
  const [busy, setBusy] = useState(false);
  const { data, loading, reload } = useAsync<O>(() => call('report.goulots', { joursMin: jours }), [jours]);
  const rows = (data?.['rows'] as O[]) ?? [];
  const parEtape = (data?.['parEtape'] as O[]) ?? [];
  const parStatut = (data?.['parStatut'] as O[]) ?? [];
  const parAge = (data?.['parAge'] as O[]) ?? [];
  const toggle = (id: string) => setSel((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const tousCoches = rows.length > 0 && rows.every((r) => sel.has(String(r['id'])));
  async function archiver() {
    if (!sel.size) { toast('Sélectionnez au moins un dossier.', 'err'); return; }
    if (!motif.trim()) { toast("Indiquez le motif de l'archivage.", 'err'); return; }
    if (!window.confirm(`Archiver ${sel.size} dossier(s) ?\n\nIls sortiront des files et des rapports.\nRien n'est supprimé — l'opération est réversible (désarchivage).`)) return;
    setBusy(true);
    try {
      const r = await call<{ compte: O; erreurs: O[] }>('cargo.archiver', { ids: [...sel], motif: motif.trim() });
      toast(`${Number(r.compte?.['archives'] ?? 0)} archivé(s)${r.erreurs?.length ? ` · ${r.erreurs.length} en erreur` : ''}.`, 'ok');
      setSel(new Set()); setMotif(''); reload();
    } catch (e) { toast((e as Error).message, 'err'); } finally { setBusy(false); }
  }
  return <>
    <BandeauModule icone="nettoyage" titre="Nettoyage des goulots"
      sous={<>Vieux dossiers restés en attente — l'archivage est <b>réversible</b> et <b>tracé</b>.</>} />
    <div className="card">
      <h2>Dossiers retenus</h2>
      <p className="help" style={{ marginTop: 0 }}>
        Dossiers encore « en attente » (non sortis, non annulés) plus vieux que le seuil choisi.
        Les <b>archiver</b> les sort des files et des rapports — <b>rien n'est supprimé</b>.
      </p>
      <div className="row" style={{ alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <label className="help" style={{ margin: 0 }}>Plus vieux que</label>
        <select value={jours} onChange={(e) => { setJours(Number(e.target.value)); setSel(new Set()); }} style={{ maxWidth: 160 }}>
          <option value={0}>Tous (0 jour)</option><option value={30}>30 jours</option>
          <option value={60}>60 jours</option><option value={90}>90 jours</option><option value={180}>180 jours</option>
        </select>
      </div>
      {loading ? <Spinner /> : <>
        <div className="stats" style={{ marginTop: 10 }}>
          <StatCard n={Number(data?.['total'] ?? 0)} l="Dossiers en attente" tone="warn" />
          {parAge.map((a) => <StatCard key={String(a['tranche'])} n={Number(a['n'])} l={String(a['tranche'])} />)}
        </div>
        <div className="row" style={{ gap: 16, flexWrap: 'wrap', marginTop: 6 }}>
          <div style={{ flex: 1, minWidth: 220 }}>
            <div className="help"><b>Par poste d'attente</b></div>
            <Table cols={[['etapeLibelle', 'Poste'], ['n', 'Dossiers']]} rows={parEtape} />
          </div>
          <div style={{ flex: 1, minWidth: 220 }}>
            <div className="help"><b>Par statut</b></div>
            <Table cols={[['statut', 'Statut'], ['n', 'Dossiers']]} rows={parStatut} />
          </div>
        </div>
      </>}
    </div>

    {!loading && <div className="card">
      <div className="row" style={{ alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
        <h2 style={{ flex: 1, margin: 0 }}>Dossiers concernés ({rows.length})</h2>
        {rows.length > 0 && <button className="ghost xs" onClick={() => setSel(tousCoches ? new Set() : new Set(rows.map((r) => String(r['id']))))}>
          {tousCoches ? 'Tout décocher' : 'Tout cocher'}</button>}
      </div>
      {!admin && <p className="help">Lecture seule — seul un administrateur peut archiver.</p>}
      {admin && <div className="row" style={{ alignItems: 'center', gap: 8, flexWrap: 'wrap', margin: '8px 0' }}>
        <input value={motif} onChange={(e) => setMotif(e.target.value)} placeholder="Motif de l'archivage (obligatoire)" style={{ flex: 1, minWidth: 240 }} />
        <button disabled={busy || !sel.size} onClick={archiver}><Icone nom="archive" taille={15} /> Archiver la sélection ({sel.size})</button>
      </div>}
      {rows.length === 0 ? <p className="help">Aucun dossier au-delà de ce seuil.</p>
        : <div className="tbl"><table><thead><tr>
          {admin && <th style={{ width: 28 }}></th>}<th>ID</th><th>Camion</th><th>Statut</th><th>En attente à</th><th>Âge (j)</th><th>Entré le</th>
        </tr></thead><tbody>{rows.map((r) => <tr key={String(r['id'])} className="clk" onClick={() => nav.go('detail', r['id'])}>
          {admin && <td onClick={(e) => e.stopPropagation()}><input type="checkbox" checked={sel.has(String(r['id']))} onChange={() => toggle(String(r['id']))} /></td>}
          <td className="mono">{String(r['id'])}</td><td><NumeroMobile valeur={r['numeroCamion']} /></td>
          <td>{String(r['statut'])}</td><td>{String(r['etapeLibelle'] || '—')}</td>
          <td>{String(r['age'])}</td><td>{fmtDate(r['dateCreation'])}</td>
        </tr>)}</tbody></table></div>}
    </div>}

    {admin && <BlocArchives />}
  </>;
};

/**
 * Séries du graphique — même ordre et mêmes libellés que le serveur.
 *
 * Le temps GLOBAL est volontairement ABSENT : il vaut la somme des attentes
 * cumulées, donc plusieurs fois n'importe quel poste. Tracé sur le même axe, il
 * écraserait les six courbes qu'on cherche justement à comparer. Il est lu en
 * tête d'écran, sous forme de cartes, et figure dans l'export.
 */
const POSTES_UI: [string, string][] = [
  ['cfs', 'CFS (chargement)'], ['validation', 'Chef de brigade'], ['t1', 'Cellule T1'],
  ['balise', 'Cellule Balise'], ['bs', 'Bon de sortie'], ['pp', 'Porte Principale'],
];

SCREENS.dwell = ({ go }) => {
  const { data, loading } = useAsync<{ compte: O; tranches: O[]; instance: O[]; seuil: number }>(() => call('report.dwell', {}), []);
  return <div className="card"><h2>Délai & camions en instance</h2>
    {loading ? <Spinner /> : <>
      <div className="stats"><StatCard n={Number(data?.compte['totInstance'] ?? 0)} l="En instance" /><StatCard n={Number(data?.compte['totSortis'] ?? 0)} l="Sortis" tone="ok" /><StatCard n={Number(data?.compte['delaiMoyen'] ?? 0)} l="Délai moyen (j)" /><StatCard n={Number(data?.compte['alerte'] ?? 0)} l={`Alerte ≥ ${data?.seuil ?? 90} j`} tone="warn" /></div>
      <Table cols={[['id', 'ID'], ['numeroCamion', 'Camion'], ['typeOperation', 'Opération'], ['statut', 'Statut'], ['age', 'Âge (j)']]} rows={data?.instance ?? []} onRow={(r) => go('detail', r['id'])} />
    </>}
  </div>;
};

SCREENS.stockdwell = () => {
  const { data, loading } = useAsync<{ compte: O; tranches: O[]; instance: O[] }>(() => call('report.stock'), []);
  return <div className="card"><h2>Séjour & instances conteneurs</h2>
    {loading ? <Spinner /> : <>
      <div className="stats"><StatCard n={Number(data?.compte['total'] ?? 0)} l="Total" /><StatCard n={Number(data?.compte['stock'] ?? 0)} l="En stock" /><StatCard n={Number(data?.compte['sejourMoyen'] ?? 0)} l="Séjour moyen (j)" /><StatCard n={Number(data?.compte['alerte'] ?? 0)} l="Alerte ≥ 90 j" tone="warn" /></div>
      <Table cols={[['numeroTC', 'Conteneur'], ['taille', 'Taille'], ['statut', 'Statut'], ['joursSejour', 'Séjour (j)']]} rows={data?.instance ?? []} />
    </>}
  </div>;
};

/* ---------------------------- Utilisateurs ----------------------------- */
const ROLES_LISTE = ['CFS', 'CHEF_BRIGADE', 'CHEF_BRIGADE_ADJOINT', 'CBPI', 'CHEF_VISITE', 'CHEF_DIVISION', 'T1', 'BALISE', 'BON_SORTIE', 'PP', 'ADMIN'];
SCREENS.users = () => {
  const { data, loading, reload } = useAsync<O[]>(() => call('user.list'), []);
  const [form, setForm] = useState<O | null>(null);
  async function creer(f: O) {
    try { await call('user.create', f); toast('Compte créé.', 'ok'); setForm(null); reload(); }
    catch (e) { toast((e as Error).message, 'err'); }
  }
  const comptes = data ?? [];
  const [acces, setAcces] = useState<O | null>(null);
  const [edition, setEdition] = useState<O | null>(null);

  /**
   * Les quatre gestes d'une ligne. Ils remplacent l'invite
   * `prompt('1=activer, 2=mdp, 3=2FA')` qui servait jusqu'ici : elle ne disait
   * pas ce que chaque numéro faisait, n'offrait aucun retour en arrière, et un
   * chiffre tapé de travers lançait une autre action que celle voulue.
   */
  async function agir(quoi: string, u: O) {
    const nom = String(u['nomComplet'] || u['username']);
    try {
      if (quoi === 'acces') { setAcces(u); return; }
      if (quoi === 'modifier') { setEdition({ ...u }); return; }
      if (quoi === 'basculer') {
        const off = u['actif'] === false;
        if (!window.confirm((off ? 'RÉACTIVER' : 'DÉSACTIVER') + ' le compte de ' + nom + ' ?\n\n'
          + (off ? 'Il pourra de nouveau se connecter.'
            : 'Il ne pourra plus se connecter. Son historique et ses signatures restent intacts.'))) return;
        await call('user.toggle', { username: u['username'] });
        toast(off ? 'Compte réactivé.' : 'Compte désactivé.', 'ok'); reload(); return;
      }
      if (quoi === 'supprimer') {
        // L'avertissement vient AVANT la demande de motif : on ne fait pas remplir
        // un champ à quelqu'un pour lui apprendre ensuite ce qu'il s'apprête à faire.
        if (!window.confirm('⚠ SUPPRESSION DÉFINITIVE DU COMPTE\n\n' + nom + ' (' + String(u['username']) + ')\n\n'
          + 'Le serveur REFUSERA si ce compte a déjà travaillé sur la plateforme :\n'
          + 'son nom doit rester consultable devant une signature contestée.\n'
          + 'Dans ce cas, désactivez-le plutôt.\n\nContinuer ?')) return;
        const motif = window.prompt('Motif de la suppression (inscrit au journal d\'audit) :', '');
        if (motif === null) return;
        if (!motif.trim()) { toast('Motif obligatoire.', 'err'); return; }
        await call('user.delete', { username: u['username'], motif });
        toast('Compte supprimé.', 'ok'); reload(); return;
      }
    } catch (e) { toast((e as Error).message, 'err'); }
  }

  async function enregistrer(f: O) {
    try {
      await call('user.update', { username: f['username'], nomComplet: f['nomComplet'], role: f['role'] });
      toast('Compte modifié.', 'ok'); setEdition(null); reload();
    } catch (e) { toast((e as Error).message, 'err'); }
  }

  return <>
    {/* BANDEAU DE MODULE (2026-09-11) — repris de la disposition fournie : un
        panneau coloré qui annonce le module, son volume et son action
        principale. Il remplace un titre nu suivi d'un petit bouton. */}
    <div className="bandeau-module">
      <span className="bm-pastille" aria-hidden="true"><Icone nom="utilisateurs" taille={24} /></span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="bm-titre">Gestion des utilisateurs</div>
        <div className="bm-sous">{comptes.length} compte(s) — rôles et accès aux modules</div>
      </div>
      <button className="bm-action" onClick={() => setForm({ username: '', nomComplet: '', role: 'CFS', password: '' })}>
        <Icone nom="plus" taille={15} />Nouvel utilisateur
      </button>
    </div>
    <div className="card">
    {loading ? <Spinner /> : <TableUtilisateurs rows={comptes} onAction={agir} />}
    </div>
    {/* FENÊTRE D'AJOUT — refaite le 2026-09-11 sur le modèle fourni : un bandeau
        coloré en tête, qui annonce ce qu'on est en train de créer et reflète le
        rôle choisi EN DIRECT. Le formulaire dessous, en une colonne centrée —
        quatre champs courts n'ont pas besoin de deux colonnes, qui obligent
        l'œil à faire des allers-retours. */}
    {form && <Modal onClose={() => setForm(null)}>
      <div className="fen-tete">
        <span className="fen-pastille" aria-hidden="true"><Icone nom="utilisateurs" taille={26} /></span>
        <div style={{ minWidth: 0 }}>
          <div className="fen-titre">Nouvel utilisateur</div>
          <div className="fen-sous">{roleLabel(String(form['role'])) || 'Choisissez un rôle'}</div>
        </div>
      </div>
      <div className="fen-corps">
        <div><label className="help">Identifiant</label>
          <input className="mono" value={String(form['username'])} placeholder="ex. adjo.kossi"
            onChange={(e) => setForm({ ...form, username: e.target.value.toLowerCase() })} /></div>
        <div><label className="help">Nom complet</label>
          <input value={String(form['nomComplet'])} placeholder="Nom et prénoms"
            onChange={(e) => setForm({ ...form, nomComplet: e.target.value })} /></div>
        <div><label className="help">Rôle</label>
          <select value={String(form['role'])} onChange={(e) => setForm({ ...form, role: e.target.value })}>
            {ROLES_LISTE.map((r) => <option key={r}>{r}</option>)}</select></div>
        <div><label className="help">Mot de passe provisoire</label>
          <input value={String(form['password'])} minLength={12} placeholder="12 caractères minimum"
            onChange={(e) => setForm({ ...form, password: e.target.value })} />
          <p className="help" style={{ marginTop: 5 }}>
            12 caractères minimum, mêlant minuscules, majuscules, chiffres et/ou signes.
            À remettre <b>en main propre</b> : l'agent devra le remplacer à sa première connexion.
          </p></div>
      </div>
      <div className="fen-pied">
        <button className="ghost" onClick={() => setForm(null)}>Annuler</button>
        <button onClick={() => creer(form)}>Créer le compte</button>
      </div>
    </Modal>}

    {/* L'ŒIL — les volets auxquels ce rôle accède. La liste est lue dans la MÊME
        table que le menu : ce qui s'affiche ici est exactement ce que l'agent
        verra en se connectant, sans risque de divergence.
        ⚠ C'est un aperçu de MENU, pas la matrice des droits. L'autorité reste
        `PERMISSIONS`, côté serveur — le texte le dit, pour qu'un administrateur
        ne prenne pas cet écran pour un état des permissions. */}
    {acces && <Modal onClose={() => setAcces(null)}>
      <h2><span className="tp-pastille" aria-hidden="true"><Icone nom="oeil" taille={18} /></span>
        Accès de {String(acces['nomComplet'] || acces['username'])}</h2>
      <p className="help" style={{ marginTop: 0 }}>
        Rôle <b>{roleLabel(String(acces['role']))}</b> — {(MENUS[String(acces['role'])] ?? []).length} volet(s).
        Voici ce que cet agent voit dans sa barre latérale. Les droits d'ÉCRITURE, eux,
        sont vérifiés par le serveur à chaque action, indépendamment de ce menu.
      </p>
      <div className="grille-acces">
        {(MENUS[String(acces['role'])] ?? []).map((m) => <span key={m[0]} className="acces-item">
          <Icone nom={m[2]} taille={16} />{m[1]}
        </span>)}
      </div>
    </Modal>}

    {/* LE CRAYON — nom et rôle. L'identifiant ne se modifie pas : il est la clé
        du compte et se retrouve dans chaque ligne du journal d'audit. */}
    {edition && <Modal onClose={() => setEdition(null)}>
      <h2><span className="tp-pastille" aria-hidden="true"><Icone nom="crayon" taille={18} /></span>
        Modifier {String(edition['username'])}</h2>
      <div className="grid2">
        <div><label className="help">Nom complet</label>
          <input value={String(edition['nomComplet'] ?? '')} onChange={(e) => setEdition({ ...edition, nomComplet: e.target.value })} /></div>
        <div><label className="help">Rôle</label>
          <select value={String(edition['role'])} onChange={(e) => setEdition({ ...edition, role: e.target.value })}>
            {ROLES_LISTE.map((r) => <option key={r}>{r}</option>)}</select></div>
      </div>
      <p className="help">L'identifiant n'est pas modifiable : il identifie le compte dans tout le journal d'audit.</p>
      <div className="row" style={{ marginTop: 12 }}>
        <button onClick={() => enregistrer(edition)}>Enregistrer</button>
        <button className="ghost" onClick={() => setEdition(null)}>Annuler</button>
      </div>
    </Modal>}
  </>;
};

/**
 * LISTE DES COMPTES — 2026-09-11, reprise de la disposition fournie.
 *
 * Chaque ligne porte un AVATAR à l'initiale, le nom avec son rôle en dessous,
 * l'identifiant en chasse fixe et une pastille de rôle. La couleur de l'avatar
 * est TIRÉE DU NOM, jamais du rang dans la liste : le même agent garde sa
 * couleur quand on filtre ou qu'on ajoute un compte — sinon les repères de
 * couleur se déplaceraient à chaque changement et ne serviraient à rien.
 */
function TableUtilisateurs({ rows, onAction }: { rows: O[]; onAction: (quoi: string, u: O) => void }) {
  if (!rows.length) return <div className="empty">Aucun compte.</div>;
  return <div className="tbl"><table>
    <thead><tr>
      <th>Utilisateur</th><th>Identifiant</th><th>Rôle</th>
      <th>Dernière connexion</th><th>Statut</th><th style={{ textAlign: 'right' }}>Actions</th>
    </tr></thead>
    <tbody>{rows.map((u, i) => {
      const nom = String(u['nomComplet'] || u['username'] || '?').trim();
      const inactif = u['actif'] === false;
      return <tr key={i}>
        <td>
          <span className="compte-ligne-u">
            <span className="avatar-u" style={{ backgroundColor: couleurDepuisNom(nom) }}>{nom.charAt(0).toUpperCase()}</span>
            <span style={{ minWidth: 0 }}>
              <span className="nom-u">{nom}{inactif && <span className="badge-inactif">désactivé</span>}</span>
              <span className="role-u">{roleLabel(String(u['role']))}</span>
            </span>
          </span>
        </td>
        <td><span className="mono ident-u">{String(u['username'] ?? '—')}</span></td>
        <td><span className="pastille-role">{String(u['role'] ?? '—')}</span></td>
        <td>{fmtDate(u['derniereConnexion'])}</td>
        <td><span className={`pastille-statut ${inactif ? 'ko' : 'ok'}`}>{inactif ? 'Désactivé' : 'Actif'}</span></td>
        <td>
          {/* Quatre gestes distincts, quatre boutons — l'invite `prompt('1, 2
              ou 3 ?')` qui servait jusqu'ici ne disait pas ce que chaque
              numéro faisait, et ne laissait aucun moyen de revenir en arrière. */}
          <span className="actions-u">
            <button className="acte" title="Voir les volets accessibles à ce rôle"
              aria-label={`Accès de ${nom}`} onClick={() => onAction('acces', u)}><Icone nom="oeil" taille={16} /></button>
            <button className="acte" title="Modifier le compte"
              aria-label={`Modifier ${nom}`} onClick={() => onAction('modifier', u)}><Icone nom="crayon" taille={16} /></button>
            <button className={`acte ${inactif ? 'acte-ok' : 'acte-warn'}`}
              title={inactif ? 'Réactiver le compte' : 'Désactiver le compte'}
              aria-label={`${inactif ? 'Réactiver' : 'Désactiver'} ${nom}`}
              onClick={() => onAction('basculer', u)}><Icone nom="interrupteur" taille={16} /></button>
            <button className="acte acte-err" title="Supprimer le compte"
              aria-label={`Supprimer ${nom}`} onClick={() => onAction('supprimer', u)}><Icone nom="poubelle" taille={16} /></button>
          </span>
        </td>
      </tr>;
    })}</tbody>
  </table></div>;
}

/**
 * Couleur d'avatar déduite du nom — somme des codes de caractères ramenée à la
 * palette validée des graphiques. Déterministe : le même nom donne toujours la
 * même couleur, sur tous les postes et d'une session à l'autre.
 */
function couleurDepuisNom(nom: string): string {
  const teintes = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948'];
  let somme = 0;
  for (const c of nom) somme = (somme + c.charCodeAt(0)) % 9973;
  return teintes[somme % teintes.length]!;
}

// Types d'événements du journal (connexions/déconnexions volontairement exclues).
const EVENEMENTS = [
  'Création cargaison', 'Création rapport', 'Modification cargaison', 'Correction N° camion',
  'Chargement mixte', 'Rapport de chargement', 'Affectation GPS', 'Remplacement GPS',
  'Étape Balise — sans balise', 'Enregistrement sortie',
  'Rapport CFS (vue)', 'Rapport Balise (vue)', 'Rapport PP (vue)', 'Rapport séjour (vue)', 'Rapport flux (vue)',
  'Export XLSX', 'Export PDF', 'Export historique XLSX', 'Export séjour XLSX',
  'Export Rapport PP XLSX', 'Export Rapport PP PDF', 'Export Rapport Balise XLSX', 'Export Rapport Balise PDF',
  'Création utilisateur', 'Modification utilisateur', 'Réinitialisation mot de passe', 'Changement mot de passe',
  'Activation compte', 'Désactivation compte',
];

SCREENS.history = () => {
  const [m, setM] = useState('mois');
  const [duP, setDuP] = useState(''); const [auP, setAuP] = useState('');
  const [username, setUsername] = useState(''); const [action, setAction] = useState('');
  const [page, setPage] = useState(1);
  const reset = () => setPage(1); // tout changement de filtre revient à la page 1

  // Bornes de dates : même calcul que les rapports (module partagé).
  // « tout » = du/au vides → aucune contrainte de date.
  const brut = m === 'tout' ? { du: '', au: '' }
    : m === 'perso' ? { du: duP, au: auP }
      : (() => { const [d, a] = bornesDe(m as ModePeriode); return { du: d, au: a }; })();
  const { du, au } = normaliserPlage(brut.du, brut.au);

  const users = useAsync<O[]>(() => call('user.list'), []);
  const { data, loading } = useAsync<{ rows: O[]; pages: number; total: number }>(
    () => call('log.list', { page, du, au, username, action }), [page, du, au, username, action]);

  return <>
    <BandeauModule icone="historique" titre="Journal d'activité"
      sous="Qui a fait quoi, et quand — chaque écriture de la plateforme y est scellée." />
    <div className="card">
    <div className="row" style={{ alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
      <h2 style={{ flex: 1, margin: 0 }}>Filtrer le journal</h2>
      <select value={m} onChange={(e) => { setM(e.target.value); reset(); }} style={{ maxWidth: 190 }}>
        <option value="tout">Toute la période</option>
        <option value="jour">Aujourd'hui</option>
        <option value="semaine">Cette semaine</option>
        <option value="mois">Ce mois-ci</option>
        <option value="annee">Cette année</option>
        <option value="perso">Plage personnalisée…</option>
      </select>
      {m === 'perso' && <>
        <input type="date" value={duP} onChange={(e) => { setDuP(e.target.value); reset(); }} />
        <span className="help">→</span>
        <input type="date" value={auP} onChange={(e) => { setAuP(e.target.value); reset(); }} />
      </>}
      <select value={username} onChange={(e) => { setUsername(e.target.value); reset(); }} style={{ maxWidth: 190 }}>
        <option value="">Tous les utilisateurs</option>
        {(users.data ?? []).map((u) => <option key={String(u['username'])} value={String(u['username'])}>{String(u['nomComplet'] || u['username'])}</option>)}
      </select>
      <select value={action} onChange={(e) => { setAction(e.target.value); reset(); }} style={{ maxWidth: 210 }}>
        <option value="">Tous les événements</option>
        {EVENEMENTS.map((a) => <option key={a} value={a}>{a}</option>)}
      </select>
    </div>
    <div className="help" style={{ marginTop: 6 }}>
      {m === 'tout' ? 'Toutes dates' : du && au ? `Du ${du} au ${au}` : 'Choisissez une plage de dates'} · {data?.total ?? 0} entrée(s)
    </div>
    {loading ? <Spinner /> : <>
      <Table cols={[['timestamp', 'Horodatage'], ['nomComplet', 'Agent'], ['role', 'Rôle'], ['action', 'Événement'], ['cargaisonId', 'Cargaison'], ['details', 'Détails']]} rows={data?.rows ?? []} />
      {(data?.pages ?? 1) > 1 && <div className="row" style={{ marginTop: 10, justifyContent: 'center' }}>
        <button className="ghost xs" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>‹</button><span>Page {page} / {data?.pages}</span>
        <button className="ghost xs" disabled={page >= (data?.pages ?? 1)} onClick={() => setPage((p) => p + 1)}>›</button></div>}
    </>}
  </div></>;
};

SCREENS.account = ({ user }) => {
  const [anc, setAnc] = useState(''); const [nouv, setNouv] = useState('');
  async function changer() {
    try { await call('account.changepwd', { ancien: anc, nouveau: nouv }); toast('Mot de passe changé.', 'ok'); setAnc(''); setNouv(''); }
    catch (e) { toast((e as Error).message, 'err'); }
  }
  return <><BandeauModule icone="compte" titre="Mon compte"
    sous={<>{user.nomComplet} — <b>{roleLabel(user.role)}</b></>} />
    <div className="ecran-compte">
      <div className="card">
        {/* EN-TETE ILLUSTRE (2026-09-12) - le logo, un anneau qui tourne, et
            DEUX pastilles qui disent de quoi l'ecran parle : le compte, et le
            crayon de la modification. La carte est centree : c'est un ecran a
            une seule colonne, il n'a pas de raison de se coller a gauche. */}
        <div className="compte-entete">
          <div className="compte-logo">
            <span className="compte-piste" aria-hidden="true" />
            <span className="compte-onde" aria-hidden="true" />
            <img className="logo-rond" src="/logo_PIA.jpg" alt=""
              onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }} />
            <span className="compte-jeton cj-compte" aria-hidden="true"><Icone nom="compte" taille={16} /></span>
            <span className="compte-jeton cj-crayon" aria-hidden="true"><Icone nom="crayon" taille={14} /></span>
          </div>
          <h2>{user.nomComplet}</h2>
          <p className="help">{roleLabel(user.role)}</p>
        </div>
        <div className="kv"><b>Identifiant</b>{user.username}</div>
        <div className="kv"><b>Nom</b>{user.nomComplet}</div>
        <div className="kv"><b>Rôle</b>{user.role}</div>
        <TitrePanneau icone="interrupteur">Changer mon mot de passe</TitrePanneau>
        <label className="help lbl-icone"><Icone nom="oeil" taille={14} />Ancien</label>
        <input type="password" value={anc} onChange={(e) => setAnc(e.target.value)} />
        <label className="help lbl-icone"><Icone nom="valider" taille={14} />Nouveau — 12 caractères minimum, 3 familles</label>
        <input type="password" value={nouv} onChange={(e) => setNouv(e.target.value)} minLength={12} />
        <div style={{ marginTop: 14 }}>
          <button onClick={changer} disabled={!anc || nouv.length < 6}>Changer le mot de passe</button>
        </div>
      </div>
    </div></>;
};

SCREENS.reports = () => <div className="card"><h2>Rapports</h2><p className="help">Sélectionnez un rapport dans le menu (CFS, véhicules, Balise, PP, KPI, dispenses, flux, séjour).</p></div>;

function telecharger(f: O) {
  const b64 = String(f['base64'] ?? ''); if (!b64) return;
  const bin = atob(b64); const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const blob = new Blob([bytes], { type: String(f['mime'] ?? 'application/octet-stream') });
  const url = URL.createObjectURL(blob); const a = document.createElement('a');
  a.href = url; a.download = String(f['filename'] ?? 'export.xlsx'); a.click(); URL.revokeObjectURL(url);
}

export { SCREENS };

/**
 * ARCHIVE — dossiers de plus d'un an (ADMIN, 2026-09-10).
 *
 * DISTINCT de l'écran « Nettoyage (goulots) », qui liste les dossiers archivés à
 * la main. Ici, aucun geste : c'est l'ancienneté seule qui définit l'archive.
 *
 * Les données ne sont PAS déplacées ailleurs — voir `archiveAncienne` côté
 * serveur pour le raisonnement. Une cargaison de plus d'un an reste consultable
 * et recherchable comme n'importe quelle autre ; cet écran est une VUE sur elle,
 * pas un entrepôt séparé.
 *
 * La pagination est faite côté SQL : on ne remonte que la page affichée, jamais
 * la table entière (GOV-05).
 */
SCREENS.archive = ({ go }) => {
  const [page, setPage] = useState(1);
  const [mois, setMois] = useState(12);
  const [recherche, setRecherche] = useState('');
  const [q, setQ] = useState(''); // terme réellement envoyé (validé par Entrée)
  const { data, loading, error } = useAsync<O>(
    () => call('report.archive', { page, pageSize: 50, mois, search: q }),
    [page, mois, q],
  );

  const rows = (data?.['rows'] as O[]) ?? [];
  const total = Number(data?.['total'] ?? 0);
  const pages = Math.max(1, Math.ceil(total / 50));

  return <>
    <BandeauModule icone="archive" titre="Archive"
      sous={<>Dossiers entrés il y a plus de <b>{mois} mois</b>{data?.['total'] ? <> — <b>{String(data['total'])}</b> dossier(s)</> : null}</>} />
    <div className="card">
      <p className="help" style={{ marginTop: 0 }}>
        Cargaisons entrées avant le <b>{fmtJour(data?.['seuil'])}</b>. Elles restent
        entièrement consultables : cet écran est une vue par ancienneté, aucune
        donnée n'a été déplacée ni retirée des recherches.
      </p>
      <div className="row" style={{ gap: 10, flexWrap: 'wrap', alignItems: 'end', marginTop: 8 }}>
        <div>
          <label className="help">Ancienneté</label>
          <select value={mois} onChange={(e) => { setMois(Number(e.target.value)); setPage(1); }}>
            <option value={12}>Plus de 1 an</option>
            <option value={24}>Plus de 2 ans</option>
            <option value={36}>Plus de 3 ans</option>
            <option value={60}>Plus de 5 ans</option>
          </select>
        </div>
        <div style={{ flex: 1, minWidth: 200 }}>
          <label className="help">Rechercher un camion</label>
          <input className="mono" value={recherche} placeholder="TG2489BK/2725BP"
            onChange={(e) => setRecherche(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { setQ(recherche); setPage(1); } }} />
        </div>
        <button className="ghost" onClick={() => { setQ(recherche); setPage(1); }}>Rechercher</button>
        {q && <button className="ghost" onClick={() => { setRecherche(''); setQ(''); setPage(1); }}>Effacer</button>}
      </div>
    </div>

    {loading ? <Spinner /> : error ? <div className="err-msg">{error}</div> : <div className="card">
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <b>{total} dossier(s)</b>
        <span className="help">Page {page} / {pages}</span>
      </div>
      {!rows.length ? <div className="empty">Aucun dossier de cette ancienneté.</div> : <>
        <div style={{ overflowX: 'auto', marginTop: 8 }}>
          <table>
            <thead><tr>
              <th>Camion</th><th>Dossier</th><th>Opération</th><th>Statut</th>
              <th>Entré le</th><th>Sorti le</th><th>Déclarant</th><th>Décl.</th>
            </tr></thead>
            <tbody>
              {rows.map((r) => <tr key={String(r['id'])} style={{ cursor: 'pointer' }}
                onClick={() => go('detail', String(r['id']))}>
                <td className="mono">{String(r['numeroCamion'] ?? '')}</td>
                <td className="mono help">{String(r['id'] ?? '')}</td>
                <td>{String(r['typeOperation'] ?? '')}</td>
                <td><Tag statut={String(r['statut'] ?? '')} o={r} /></td>
                <td>{fmtJour(r['dateCreation'])}</td>
                <td>{r['dateSortie'] ? fmtJour(r['dateSortie']) : '—'}</td>
                <td>{String(r['declarant'] ?? '')}</td>
                <td className="mono help">{String(r['numeroDeclaration'] ?? '')}</td>
              </tr>)}
            </tbody>
          </table>
        </div>
        <div className="row" style={{ gap: 8, marginTop: 10, alignItems: 'center' }}>
          <button className="ghost" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>← Précédent</button>
          <button className="ghost" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>Suivant →</button>
          <span className="help">Cliquez une ligne pour ouvrir la fiche.</span>
        </div>
      </>}
    </div>}
  </>;
};
