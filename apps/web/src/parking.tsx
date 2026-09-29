/**
 * ============================================================================
 *  VOLET PARKING : 2026-09-24, demande utilisateur
 *
 *  Les camions stationnés au parking sont comptés CHAQUE JOUR. Le premier jour
 *  on AJOUTE le camion (plaque obligatoire, conteneur et plomb facultatifs) et
 *  on peut le pointer dans la foulée. Les jours suivants il est déjà là : on
 *  tape sa plaque, la liste se réduit à chaque caractère, et un bouton le
 *  pointe. Ce bouton DISPARAÎT une fois le camion pointé, un camion ne se
 *  pointe pas deux fois dans la même journée (règle tenue par le serveur, pas
 *  seulement par l'écran : voir actions/parking.ts).
 *
 *  Le camion quitte le parking quand il est signalé à la Porte Principale.
 * ============================================================================
 */
import { useEffect, useState } from 'react';
import * as XLSX from 'xlsx';
import { call } from './lib/rpc.ts';
import { useAsync } from './lib/hooks.ts';
import { Icone } from './lib/icones.tsx';
import { Spinner, StatCard, Modal, masks, toast, fmtDate, fmtJour, ChampCamion, ChoixSegmente, BoutonBascule } from './lib/ui.tsx';
import { BandeauModule, useReportRange } from './screens.tsx';
import type { ModePeriode } from './lib/periode.ts';
import type { Nav } from './App.tsx';
import { ROLES, alphaNumMaj, camionValide, dureeLisible } from '../../../supabase/functions/_shared/domaine/src/index.ts';

type O = Record<string, unknown>;
const s = (v: unknown) => String(v ?? '');

/** Camions montres d'un coup ; au-dela, on pagine. */
const PARKING_PAR_PAGE = 50;

/* ---------------------------------------------------------------- l'écran */

export function EcranParking({ user, go }: Nav) {
  const [recherche, setRecherche] = useState('');
  const [statut, setStatut] = useState('presents');
  const [page, setPage] = useState(1);
  // Changer de vue, de periode ou de recherche ramene a la premiere page :
  // rester sur une page 4 qui n'existe plus donnerait une liste vide.
  const [ajout, setAjout] = useState(false);
  const [detail, setDetail] = useState<string | null>(null);
  const [edite, setEdite] = useState<O | null>(null);
  const [supprime, setSupprime] = useState<O | null>(null);
  const [busy, setBusy] = useState('');
  const admin = user.role === ROLES.ADMIN;
  /* PÉRIODE (demande utilisateur) : jour, mois, année ou plage, sur la DATE
     D'ENTRÉE au parking. Elle tient dans UNE liste déroulante du bandeau, dont
     la première ligne (« Toute la période ») la neutralise : c'est le défaut,
     car la question courante est « qui est là aujourd'hui ? ». Les deux champs
     de dates n'apparaissent que si l'on choisit « Plage… ». */
  const periode = useReportRange('mois');
  const [limiterPeriode, setLimiterPeriode] = useState(false);
  const du = limiterPeriode ? periode.du : '';
  const au = limiterPeriode ? periode.au : '';
  const choisirPeriode = (v: string) => {
    if (!v) { setLimiterPeriode(false); return; }
    setLimiterPeriode(true);
    periode.setM(v as ModePeriode);
  };

  /* La recherche se fait sur les lignes DÉJÀ REÇUES : filtrer à chaque
     caractère ne doit pas appeler le serveur à chaque frappe. */
  const { data, loading, error, reload } = useAsync<O>(
    () => call('parking.list', { statut, du, au }), [statut, du, au]);
  const recues = (data?.['lignes'] as O[]) ?? [];
  const q = alphaNumMaj(recherche).replace(/[^A-Z0-9]/g, '');
  useEffect(() => { setPage(1); }, [q, statut, periode.du, periode.au]);

  /* CAMIONS DEJA DANS LE SYSTEME (2026-09-28, demande utilisateur). Beaucoup
     de camions sont crees au CFS, entrent sur le site, PUIS vont se garer. La
     recherche du parking ne fouillait que son propre registre : elle ne les
     trouvait pas, et l'agent les ressaisissait a la main. On interroge donc
     AUSSI les cargaisons en cours, des deux caracteres tapes. */
  const { data: cand, error: errCand, reload: reloadCand } = useAsync<{ lignes: O[] }>(
    () => (q.length >= 2 ? call('parking.candidats', { recherche: q }) : Promise.resolve({ lignes: [] })), [q]);
  const candidats = ((cand?.['lignes'] as O[]) ?? []);
  /* LE SERVEUR PEUT ETRE EN RETARD SUR L'ECRAN. Netlify publie le front des le
     merge, la fonction rpc est deployee a part : entre les deux, cette action
     n'existe pas encore. Sans ce test, une recherche qui ECHOUE s'affichait
     comme une reponse - « ce camion n'est pas encore ajoute » - alors que le
     camion existait bel et bien. Un echec doit se dire comme un echec. */
  const rechercheIndisponible = /Action inconnue|Action non gérée/.test(errCand);
  const lignes = q ? recues.filter((l) => s(l['numeroCamionNorm']).indexOf(q) > -1) : recues;
  /* PAR PAGES (2026-09-25, demande utilisateur). Un parking bien rempli, ou une
     vue « Tous » sur plusieurs mois, deroulait des centaines de lignes d'un
     bloc. La recherche reste le geste rapide ; la pagination evite la page
     interminable quand on ne cherche rien de precis. */
  const pages = Math.max(1, Math.ceil(lignes.length / PARKING_PAR_PAGE));
  const pageSure = Math.min(page, pages);
  const visibles = lignes.slice((pageSure - 1) * PARKING_PAR_PAGE, pageSure * PARKING_PAR_PAGE);
  const cpt = (data?.['compte'] as O) ?? {};
  const active = data?.['active'] !== false;

  async function pointer(id: string) {
    setBusy(id);
    try {
      await call('parking.point', { id });
      toast('Camion pointé.', 'ok');
      reload();
    } catch (e) { toast((e as Error).message, 'err'); } finally { setBusy(''); }
  }

  /**
   * Pointer au parking un camion DEJA dans le circuit : on reprend sa plaque,
   * son conteneur et son plomb tels qu'ils sont dans le dossier. Rien a
   * retaper, donc aucune faute de frappe et aucun doublon.
   */
  async function pointerCandidat(c: O) {
    const id = s(c['id']);
    setBusy(id);
    try {
      await call('parking.add', {
        numeroCamion: s(c['numeroCamion']), numeroConteneur: s(c['numeroConteneur']),
        plomb: s(c['plomb']), pointer: true,
      });
      toast('Camion ajoute au parking et pointe.', 'ok');
      reload(); reloadCand();
    } catch (e) { toast((e as Error).message, 'err'); } finally { setBusy(''); }
  }

  return <>
    <BandeauModule icone="parking" titre="Parking"
      /* UNE LIGNE, PAS TROIS (2026-09-28, demande utilisateur) : sur un ecran
         etroit la phrase tenait sur trois lignes et repoussait les commandes
         hors de vue. Les deux faits utiles tiennent en huit mots. */
      sous={<>Pointage une fois par jour. Sortie automatique à la <b>Porte Principale</b>.</>}
      action={<div className="bm-outils">
        <input className="mono" value={recherche} onChange={(e) => setRecherche(e.target.value)}
          placeholder="N° camion" title="Tapez la plaque : la liste se réduit à chaque caractère"
          style={{ width: 150 }} />
        {recherche && <button className="ghost xs" onClick={() => setRecherche('')}>Tout afficher</button>}
        {/* La période tient en une seule liste : le bandeau est déjà chargé. */}
        <select value={limiterPeriode ? periode.m : ''} onChange={(e) => choisirPeriode(e.target.value)}
          title="Période d'entrée au parking" style={{ maxWidth: 150 }}>
          <option value="">Toute la période</option>
          <option value="jour">Aujourd'hui</option>
          <option value="semaine">Cette semaine</option>
          <option value="mois">Ce mois</option>
          <option value="annee">Cette année</option>
          <option value="perso">Plage…</option>
        </select>
        {limiterPeriode && periode.m === 'perso' && <>
          <input type="date" value={periode.duP} onChange={(e) => periode.setDuP(e.target.value)}
            title="Entrées à partir du" style={{ maxWidth: 150 }} />
          <input type="date" value={periode.auP} onChange={(e) => periode.setAuP(e.target.value)}
            title="Entrées jusqu'au" style={{ maxWidth: 150 }} />
        </>}
        <button className="btn-export" onClick={() => exporterExcel(lignes, statut)}
          disabled={!lignes.length} title="Extraire la liste affichée au format Excel">
          <Icone nom="telecharger" taille={15} />Excel
        </button>
        <button onClick={() => setAjout(true)}><Icone nom="camionPlus" />Ajouter un camion</button>
      </div>} />


    {!active && <div className="card" style={{ borderLeft: '4px solid var(--warn)' }}>
      <b style={{ color: 'var(--warn)' }}>Le parking n'est pas encore activé</b>
      <p className="help" style={{ marginBottom: 0 }}>
        Les tables du parking (migration 00201) n'existent pas encore en base. L'écran fonctionnera
        dès qu'elles seront créées ; rien d'autre dans l'application n'est affecté.
      </p>
    </div>}

    {/* Trois chiffres, en tuiles COMPACTES : cet écran sert à pointer, la
        liste doit rester à portée de pouce sur un téléphone. */}
    <div className="stats compacts" style={{ marginTop: 10 }}>
      <StatCard n={Number(cpt['presents'] ?? 0)} l="Présents" icone="parking" />
      <StatCard n={Number(cpt['pointes'] ?? 0)} l="Pointés ce jour" icone="valider" tone="ok" />
      <StatCard n={Number(cpt['restants'] ?? 0)} l="À pointer" icone="sablier" tone="warn" />
    </div>

    <div className="card">
      {/* PRÉSENCE : au-dessus de la liste qu'elle commande, et non dans le
          bandeau (demande utilisateur). Un choix segmenté plutôt qu'une liste
          déroulante : trois valeurs, toutes visibles d'un coup d'œil. */}
      <div className="park-presence">
        <ChoixSegmente libelle="Camions affichés" valeur={statut}
          onChange={(v) => setStatut(v || statut)}
          options={[
            { valeur: 'presents', libelle: 'Présents', icone: 'parking' },
            { valeur: 'sortis', libelle: 'Sortis', icone: 'sortie' },
            { valeur: 'tous', libelle: 'Tous', icone: 'liste' },
          ]} />
        {limiterPeriode && <span className="help">
          Entrées du {fmtJour(periode.du)} au {fmtJour(periode.au)}
        </span>}
      </div>
      {loading ? <Spinner /> : error ? <div className="err-msg">{error}</div> : <>
        <div className="help" style={{ marginBottom: 8 }}>
          {q ? `${lignes.length} camion(s) sur ${recues.length}` : `${lignes.length} camion(s)`}
          {lignes.length > PARKING_PAR_PAGE ? ` · page ${pageSure} sur ${pages}` : ''}
          {data?.['jour'] ? ` · pointage du ${fmtJour(data['jour'])}` : ''}
        </div>
        {!lignes.length ? <div className="empty">
          {q ? (candidats.length
            ? 'Aucun camion DU PARKING ne correspond. Voir les propositions ci-dessous.'
            : 'Aucun camion ne correspond à cette recherche.')
            : statut === 'presents' ? 'Aucun camion au parking. Utilisez « Ajouter un camion ».'
              : 'Aucun camion dans cette vue.'}
        </div> : <div className="tbl"><table>
          <thead><tr>
            <th>Camion</th><th>Conteneur</th><th>Plomb</th><th>Au parking depuis</th>
            <th>Durée au parking</th><th>Dernier pointage</th><th>Aujourd'hui</th>
            <th>Dossier</th><th></th>
          </tr></thead>
          <tbody>
            {visibles.map((l) => {
              const id = s(l['id']);
              const pointe = l['pointeAujourdhui'] === true;
              const sorti = l['statut'] === 'Sorti';
              return <tr key={id} className="park-ligne">
                {/* La plaque ouvre le détail : le geste naturel sur une ligne. */}
                <td><button className="ghost xs mono" onClick={() => setDetail(id)}
                  title="Voir le détail de ce camion">{s(l['numeroCamion'])}</button></td>
                <td className="mono">{s(l['numeroConteneur']) || '—'}</td>
                <td className="mono">{s(l['plomb']) || '—'}</td>
                <td>{fmtJour(l['dateEntree'])}</td>
                {/* Heures tant que le séjour est court, jours ensuite : la même
                    lecture que partout ailleurs dans l'application. */}
                <td title={dureeTitre(l)}>{dureeLisible(dureeMinutesDe(l))}</td>
                <td>{l['dernierPointage'] ? fmtJour(l['dernierPointage']) : '—'}</td>
                <td>{sorti ? <span className="help">Sorti le {fmtJour(l['dateSortie'])}</span>
                  : pointe ? <span className="park-ok"><Icone nom="valider" taille={14} />Pointé</span>
                    : <span className="help">Pas encore</span>}</td>
                {/* LE DOSSIER, DEPUIS LE PARKING (2026-09-29, demande
                    utilisateur). Le parking comptait des presences sans mener
                    nulle part : l'agent qui voulait continuer la saisie devait
                    retenir la plaque, quitter le volet et la retaper ailleurs.
                    La colonne dit l'etape attendue et y mene d'un clic. */}
                <td className="park-dossier">
                  {s(l['cargaisonId']) ? <>
                    <button className="ghost xs" onClick={() => go('detail', s(l['cargaisonId']))}
                      title={'Ouvrir le dossier ' + s(l['cargaisonId']) + ' et continuer la saisie'}>
                      Ouvrir
                    </button>
                    {s(l['cargaisonEtape'])
                      ? <span className="help">attendu à {s(l['cargaisonEtape'])}</span>
                      : <span className="help">{s(l['cargaisonStatut'])}</span>}
                  </> : <button className="ghost xs" onClick={() => go('creercamion', s(l['numeroCamion']))}
                    title="Ce camion n'a pas encore de dossier : le créer">
                    Créer
                  </button>}
                </td>
                <td className="acts">
                  {/* Le bouton DISPARAÎT une fois le camion pointé. */}
                  {!sorti && !pointe && <button className="xs" disabled={busy === id} onClick={() => pointer(id)}>
                    {busy === id ? 'Pointage…' : 'Pointer'}
                  </button>}
                  <button className="ghost xs" onClick={() => setEdite(l)}>Modifier</button>
                  {admin && <button className="ghost xs acts-suppr" onClick={() => setSupprime(l)}>Supprimer</button>}
                </td>
              </tr>;
            })}
          </tbody>
        </table></div>}
        {pages > 1 && <div className="row pagination-tc">
          <button className="ghost xs" disabled={pageSure <= 1} onClick={() => setPage(pageSure - 1)}>‹ Précédents</button>
          <span className="help">{(pageSure - 1) * PARKING_PAR_PAGE + 1} à {Math.min(pageSure * PARKING_PAR_PAGE, lignes.length)} sur {lignes.length}</span>
          <button className="ghost xs" disabled={pageSure >= pages} onClick={() => setPage(pageSure + 1)}>Suivants ›</button>
        </div>}
      </>}
    </div>

    {/* PROPOSITIONS (2026-09-28) : les camions deja crees que la recherche
        rapproche, et qui ne sont pas encore au parking. Un seul geste les y
        amene, plaque, conteneur et plomb repris du dossier. */}
    {q.length >= 2 && candidats.length > 0 && <div className="card park-propose">
      <div className="pt-entete">
        <span className="pt-pastille" aria-hidden="true"><Icone nom="camion" taille={17} /></span>
        <div>
          <b>{candidats.length === 1 ? 'Ce camion est déjà dans le système' : `${candidats.length} camions déjà dans le système`}</b>
          <div className="help" style={{ marginTop: 2 }}>
            Créés au CFS et pas encore au parking. Pointez-les ici : leur conteneur et leur
            plomb sont repris du dossier, vous n'avez rien à retaper.
          </div>
        </div>
      </div>
      {candidats.map((c) => <div key={s(c['id'])} className="pt-ligne">
        <div className="pt-infos">
          <span className="mono pt-plaque">{s(c['numeroCamion'])}</span>
          <span className="help">
            {s(c['numeroConteneur'])
              ? <>conteneur <b className="mono">{s(c['numeroConteneur'])}</b>
                {Number(c['nbConteneurs'] ?? 0) > 1 ? ` (+${Number(c['nbConteneurs']) - 1})` : ''}
                {s(c['plomb']) ? <> · plomb <b className="mono">{s(c['plomb'])}</b></> : null} · </>
              : null}
            {s(c['typeOperation'])} · entré le {fmtJour(c['dateCreation'])}
          </span>
          <span className="help">
            Dossier <b className="mono">{s(c['id'])}</b> · {s(c['statut'])}
            {s(c['etape']) ? <> · attendu à <b>{s(c['etape'])}</b></> : null}
          </span>
        </div>
        <div className="row" style={{ gap: 6 }}>
          <button className="ghost xs" onClick={() => go('detail', s(c['id']))}>Voir la fiche</button>
          <button className="xs" disabled={busy === s(c['id'])} onClick={() => pointerCandidat(c)}>
            {busy === s(c['id']) ? 'Pointage…' : 'Pointer au parking'}
          </button>
        </div>
      </div>)}
    </div>}

    {/* CAMION INCONNU : ni au parking, ni dans le circuit. On le dit, au
        milieu, et on propose le seul geste possible : l'ajouter. */}
    {q.length >= 2 && !lignes.length && !candidats.length && !loading && <div className="card park-inconnu">
      <Icone nom="camionPlus" taille={30} />
      {rechercheIndisponible ? <>
        <b>Recherche des camions du circuit indisponible</b>
        <p className="help">
          Le serveur n'a pas encore été mis à jour : impossible de dire si
          <b className="mono"> {recherche.trim()} </b> existe déjà dans le circuit. <b>N'ajoutez pas
          ce camion à l'aveugle</b>, vous risqueriez un doublon.
        </p>
      </> : errCand ? <>
        <b>La recherche a échoué</b>
        <p className="help">{errCand}</p>
      </> : <>
        <b>Ce camion n'est pas encore ajouté</b>
        <p className="help">
          <b className="mono">{recherche.trim()}</b> ne figure ni au parking, ni parmi les cargaisons en
          cours. Ajoutez-le au parking : vous pourrez le pointer dans la foulée.
        </p>
        <button onClick={() => setAjout(true)}><Icone nom="camionPlus" />Ajouter ce camion</button>
      </>}
    </div>}

    {ajout && <ModaleAjoutParking plaque={recherche.trim()} onClose={() => setAjout(false)}
      onFait={() => { setAjout(false); reload(); reloadCand(); }} />}
    {detail && <ModaleDetailParking id={detail} go={go} onClose={() => setDetail(null)} onFait={reload} />}
    {edite && <ModaleModifierParking ligne={edite} onClose={() => setEdite(null)}
      onFait={() => { setEdite(null); reload(); }} />}
    {supprime && <ModaleSupprimerParking ligne={supprime} onClose={() => setSupprime(null)}
      onFait={() => { setSupprime(null); reload(); }} />}
  </>;
}

/**
 * Durée du séjour EN MINUTES.
 *
 * Le serveur la calcule et l'envoie (`dureeMinutes`). L'écran sait pourtant la
 * refaire à partir des dates de la ligne, et c'est volontaire : un serveur plus
 * ancien que l'écran ne renvoie pas ce champ, et la colonne se vidait alors
 * sans rien expliquer. Les deux dates, elles, ont toujours été là.
 */
function dureeMinutesDe(l: O): number | null {
  const envoyee = Number(l['dureeMinutes']);
  if (isFinite(envoyee)) return envoyee;
  const debut = Date.parse(s(l['dateEntree']));
  if (isNaN(debut)) return null;
  const finBrute = l['statut'] === 'Sorti' ? Date.parse(s(l['dateSortie'])) : Date.now();
  const fin = isNaN(finBrute) ? Date.now() : finBrute;
  return Math.max(0, Math.round((fin - debut) / 60000));
}

/** Le détail au survol : la durée exacte, en heures ET en jours. */
function dureeTitre(l: O): string {
  const min = Number(dureeMinutesDe(l) ?? NaN);
  if (!isFinite(min)) return '';
  const heures = Math.round((min / 60) * 10) / 10;
  const jours = Math.round((min / 1440) * 10) / 10;
  return `${heures} heure(s) · ${jours} jour(s)`;
}

/**
 * EXPORT EXCEL (demande utilisateur), la liste AFFICHÉE, telle quelle :
 * la recherche et la période en cours sont déjà appliquées aux lignes reçues,
 * donc on n'exporte jamais autre chose que ce qu'on a sous les yeux.
 */
function exporterExcel(lignes: O[], statut: string) {
  if (!lignes.length) { toast('Rien à extraire.', 'err'); return; }
  const rows = lignes.map((l) => ({
    'N° camion': s(l['numeroCamion']),
    'N° conteneur': s(l['numeroConteneur']),
    'N° plomb': s(l['plomb']),
    'Statut': s(l['statut']),
    'Entré le': fmtDate(l['dateEntree']),
    'Durée au parking': dureeLisible(dureeMinutesDe(l)),
    'Durée (heures)': dureeMinutesDe(l) === null ? '' : Math.round((dureeMinutesDe(l)! / 60) * 10) / 10,
    'Durée (jours)': dureeMinutesDe(l) === null ? '' : Math.round((dureeMinutesDe(l)! / 1440) * 10) / 10,
    'Dernier pointage': l['dernierPointage'] ? fmtJour(l['dernierPointage']) : '',
    'Pointé aujourd\'hui': l['pointeAujourdhui'] === true ? 'Oui' : 'Non',
    'Sorti le': l['dateSortie'] ? fmtDate(l['dateSortie']) : '',
    'Dossier de sortie': s(l['sortieCargaison']),
    'Ajouté par': s(l['creePar']),
  }));
  const feuille = XLSX.utils.json_to_sheet(rows);
  const classeur = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(classeur, feuille, 'Parking');
  const jour = new Date().toISOString().slice(0, 10);
  XLSX.writeFile(classeur, `parking-${statut}-${jour}.xlsx`);
  toast(`${rows.length} ligne(s) extraite(s).`, 'ok');
}

/* --------------------------------------------------- ajout d'un camion */

/**
 * EN-TÊTE ANIMÉ (demande utilisateur) : le logo au centre, et un camion qui
 * tourne autour pour entrer au parking. L'animation dit ce que fait la fenêtre
 * avant qu'on ait lu le titre. Décorative, donc masquée aux lecteurs d'écran.
 */
function EnteteParkingAnime() {
  return <div className="park-entete">
    <div className="park-scene" aria-hidden="true">
      <span className="park-piste" />
      <span className="park-places" />
      <span className="park-orbite"><span className="park-camion"><Icone nom="camion" taille={16} /></span></span>
      <img className="park-logo" src="/logo.png" alt=""
        onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }} />
    </div>
    <h2 style={{ marginBottom: 2 }}>Ajouter un camion au parking</h2>
  </div>;
}

export function ModaleAjoutParking({ onClose, onFait, plaque }: {
  onClose: () => void; onFait: () => void;
  /** Plaque deja tapee dans la recherche : on ne la fait pas retaper (28/09). */
  plaque?: string;
}) {
  const [num, setNum] = useState(plaque ?? '');
  const [conteneur, setConteneur] = useState('');
  const [plomb, setPlomb] = useState('');
  // Pointer en même temps que l'ajout : l'agent qui saisit un camion l'a sous
  // les yeux. Il peut décocher (camion signalé pour plus tard).
  const [pointer, setPointer] = useState(true);
  const [busy, setBusy] = useState(false);
  const pret = num.trim() !== '' && camionValide(num);

  async function ajouter() {
    setBusy(true);
    try {
      const r = await call<O>('parking.add', { numeroCamion: num, numeroConteneur: conteneur, plomb, pointer });
      toast(r['pointe'] ? 'Camion ajouté et pointé.' : 'Camion ajouté au parking.', 'ok');
      onFait();
    } catch (e) { toast((e as Error).message, 'err'); } finally { setBusy(false); }
  }

  return <Modal onClose={onClose}>
    <EnteteParkingAnime />
    <p className="help">Camion obligatoire ; conteneur et plomb facultatifs.</p>
    <ChampCamion value={num} onChange={setNum} label="N° camion *" placeholder="" autoFocus onEnter={() => { if (pret && !busy) void ajouter(); }} />
    <div className="grid2" style={{ marginTop: 8 }}>
      <div>
        <label className="help">N° conteneur</label>
        <input className="mono" value={conteneur} onChange={(e) => setConteneur(masks.upper(e.target.value))} />
      </div>
      <div>
        <label className="help">N° plomb</label>
        <input className="mono" value={plomb} onChange={(e) => setPlomb(masks.upper(e.target.value))} />
      </div>
    </div>
    {/* UN BOUTON, PAS UNE CASE A COCHER (2026-09-24, demande utilisateur). Le
        pointage est un GESTE ; il se clique, et la mention a cote dit ce que
        le clic change. Le voyant allume rappelle l'etat retenu. */}
    <div className="park-pointer">
      <BoutonBascule actif={pointer} onChange={setPointer} libelle="Pointer maintenant" icone="valider" />
      <span className="help">{pointer
        ? "Ce camion sera compté présent aujourd'hui."
        : 'Cliquez si vous voulez le pointer tout de suite.'}</span>
    </div>
    {/* CE QUI MANQUE, ECRIT NOIR SUR BLANC (2026-09-24). Le bouton grisé
        laissait deviner qu'il attendait quelque chose, sans dire quoi. */}
    <div className="row park-pied" style={{ marginTop: 12 }}>
      {!pret && <span className="park-attente">
        <Icone nom="attente" taille={14} />
        {num.trim() === '' ? 'Saisissez le N° du camion.' : 'Complétez le N° du camion.'}
      </span>}
      <button className="ghost" onClick={onClose}>Annuler</button>
      <button disabled={busy || !pret} onClick={ajouter}
        title={pret ? undefined : 'Le N° du camion est obligatoire'}>
        {busy ? 'Ajout…' : 'Ajouter au parking'}
      </button>
    </div>
  </Modal>;
}

/* ------------------------------------------------------------ le détail */

function ModaleDetailParking({ id, onClose, onFait, go }: {
  id: string; onClose: () => void; onFait: () => void;
  go: (ecran: string, arg?: unknown) => void;
}) {
  const { data, loading, error, reload } = useAsync<O>(() => call('parking.detail', { id }), [id]);
  const [busy, setBusy] = useState(false);
  const l = (data?.['ligne'] as O) ?? {};
  const pointages = (data?.['pointages'] as O[]) ?? [];
  const sorti = l['statut'] === 'Sorti';

  async function pointer() {
    setBusy(true);
    try {
      await call('parking.point', { id });
      toast('Camion pointé.', 'ok');
      reload(); onFait();
    } catch (e) { toast((e as Error).message, 'err'); } finally { setBusy(false); }
  }

  return <Modal onClose={onClose}>
    <h2>Camion au parking</h2>
    {loading ? <Spinner /> : error ? <div className="err-msg">{error}</div> : <>
      <p className="help">
        <b className="mono">{s(l['numeroCamion'])}</b> · entré le <b>{fmtDate(l['dateEntree'])}</b>
        {s(l['creePar']) ? <> par <b>{s(l['creePar'])}</b></> : null}
        {sorti ? <> · <b>sorti</b> le {fmtDate(l['dateSortie'])}
          {s(l['sortieCargaison']) ? <> (dossier <span className="mono">{s(l['sortieCargaison'])}</span>)</> : null}</> : null}
      </p>
      <div className="grid2">
        <div><label className="help">N° conteneur</label><div className="mono">{s(l['numeroConteneur']) || '—'}</div></div>
        <div><label className="help">N° plomb</label><div className="mono">{s(l['plomb']) || '—'}</div></div>
        <div><label className="help">Durée au parking</label>
          <div><b>{dureeLisible(dureeMinutesDe(l))}</b> <span className="help">({dureeTitre(l)})</span></div>
        </div>
        <div><label className="help">Dossier</label>
          {s(l['cargaisonId'])
            ? <div>
              <span className="mono">{s(l['cargaisonId'])}</span>
              <div className="help">{s(l['cargaisonStatut'])}
                {s(l['cargaisonEtape']) ? <> · attendu à <b>{s(l['cargaisonEtape'])}</b></> : null}
              </div>
            </div>
            : <div className="help">Aucun dossier ouvert pour ce camion.</div>}
        </div>
      </div>
      <div className="section-title" style={{ marginTop: 12 }}>Pointages ({pointages.length})</div>
      {!pointages.length ? <div className="empty">Ce camion n'a pas encore été pointé.</div>
        : <div className="tbl"><table>
          <thead><tr><th>Jour</th><th>Heure</th><th>Pointé par</th></tr></thead>
          <tbody>{pointages.map((p) => <tr key={s(p['jour'])}>
            <td>{fmtJour(p['jour'])}</td>
            <td>{fmtDate(p['pointeLe']).slice(-5)}</td>
            <td>{s(p['pointePar']) || '—'}</td>
          </tr>)}</tbody>
        </table></div>}
      <div className="row" style={{ marginTop: 12, justifyContent: 'flex-end' }}>
        <button className="ghost" onClick={onClose}>Fermer</button>
        {/* Continuer la saisie sans quitter le parking de tete : le bouton
            emmene a la fiche, a l'etape ou le camion est attendu. */}
        {s(l['cargaisonId'])
          ? <button className="ghost" onClick={() => { onClose(); go('detail', s(l['cargaisonId'])); }}>
            Ouvrir le dossier
          </button>
          : !sorti ? <button className="ghost" onClick={() => { onClose(); go('creercamion', s(l['numeroCamion'])); }}>
            Créer le dossier
          </button> : null}
        {!sorti && l['pointeAujourdhui'] !== true &&
          <button disabled={busy} onClick={pointer}>{busy ? 'Pointage…' : 'Pointer aujourd\'hui'}</button>}
      </div>
    </>}
  </Modal>;
}

/* ------------------------------------------------ modifier une ligne */

/**
 * Correction ouverte à TOUS (décision utilisateur) : celui qui constate une
 * erreur de saisie doit pouvoir la réparer. La plaque comprise, le serveur
 * refuse seulement qu'elle double celle d'un autre camion présent.
 */
function ModaleModifierParking({ ligne, onClose, onFait }: { ligne: O; onClose: () => void; onFait: () => void }) {
  const [num, setNum] = useState(s(ligne['numeroCamion']));
  const [conteneur, setConteneur] = useState(s(ligne['numeroConteneur']));
  const [plomb, setPlomb] = useState(s(ligne['plomb']));
  const [busy, setBusy] = useState(false);
  const pret = num.trim() !== '' && camionValide(num);
  const change = num !== s(ligne['numeroCamion'])
    || conteneur !== s(ligne['numeroConteneur'])
    || plomb !== s(ligne['plomb']);

  async function enregistrer() {
    setBusy(true);
    try {
      const r = await call<O>('parking.edit', {
        id: s(ligne['id']), numeroCamion: num, numeroConteneur: conteneur, plomb,
      });
      toast(r['inchange'] ? 'Aucune modification.' : 'Camion modifié.', 'ok');
      onFait();
    } catch (e) { toast((e as Error).message, 'err'); } finally { setBusy(false); }
  }

  return <Modal onClose={onClose}>
    <h2>Modifier ce camion</h2>
    <p className="help">
      Entré au parking le <b>{fmtDate(ligne['dateEntree'])}</b>. La correction est inscrite au
      journal, avec l'ancienne et la nouvelle valeur.
    </p>
    <ChampCamion value={num} onChange={setNum} label="N° camion *" placeholder="" autoFocus />
    <div className="grid2" style={{ marginTop: 8 }}>
      <div>
        <label className="help">N° conteneur</label>
        <input className="mono" value={conteneur} onChange={(e) => setConteneur(masks.upper(e.target.value))} />
      </div>
      <div>
        <label className="help">N° plomb</label>
        <input className="mono" value={plomb} onChange={(e) => setPlomb(masks.upper(e.target.value))} />
      </div>
    </div>
    <div className="row park-pied" style={{ marginTop: 12 }}>
      {!pret ? <span className="park-attente"><Icone nom="attente" taille={14} />Complétez le N° du camion.</span>
        : !change ? <span className="park-attente"><Icone nom="attente" taille={14} />Rien n'a changé.</span> : null}
      <button className="ghost" onClick={onClose}>Annuler</button>
      <button disabled={busy || !pret || !change} onClick={enregistrer}
        title={!pret ? 'Le N° du camion est obligatoire' : !change ? 'Modifiez une valeur pour enregistrer' : undefined}>
        {busy ? 'Enregistrement…' : 'Enregistrer'}
      </button>
    </div>
  </Modal>;
}

/* ----------------------------------------------- supprimer (ADMIN) */

function ModaleSupprimerParking({ ligne, onClose, onFait }: { ligne: O; onClose: () => void; onFait: () => void }) {
  const [motif, setMotif] = useState('');
  const [busy, setBusy] = useState(false);

  async function supprimer() {
    setBusy(true);
    try {
      await call('parking.delete', { id: s(ligne['id']), motif });
      toast('Ligne supprimée.', 'ok');
      onFait();
    } catch (e) { toast((e as Error).message, 'err'); } finally { setBusy(false); }
  }

  return <Modal onClose={onClose}>
    <h2>Supprimer cette ligne ?</h2>
    <p className="help">
      Camion <b className="mono">{s(ligne['numeroCamion'])}</b>, entré le <b>{fmtDate(ligne['dateEntree'])}</b>.
      La ligne <b>et tous ses pointages</b> sont effacés, définitivement.
    </p>
    <p className="help">
      À réserver à une ligne créée par erreur. Un camion qui a réellement stationné se
      <b> sort</b> du parking : son séjour fait partie de l'historique.
    </p>
    <label className="help">Motif de la suppression (obligatoire)</label>
    <input value={motif} onChange={(e) => setMotif(e.target.value)} placeholder="ex. ligne créée en double" autoFocus />
    <div className="row" style={{ marginTop: 12, justifyContent: 'flex-end' }}>
      <button className="ghost" onClick={onClose}>Annuler</button>
      <button className="acts-suppr-plein" disabled={busy || !motif.trim()} onClick={supprimer}>
        {busy ? 'Suppression…' : 'Supprimer'}
      </button>
    </div>
  </Modal>;
}

/* ============================================================================
 *  ALERTE « DÉJÀ AU PARKING » : posée sur les écrans de saisie.
 *
 *  Avant d'enregistrer une cargaison, on demande au serveur si ce camion est au
 *  parking. S'il y est, l'agent voit une question, pas un refus : il répond OUI
 *  pour continuer, NON pour annuler. Répondre OUI ne change rien au parking,
 *  le camion en sortira à la Porte Principale, comme les autres.
 * ========================================================================== */

/**
 * LE CAMION DU PARKING, RETROUVE A CHAQUE ETAPE (2026-09-28, demande
 * utilisateur).
 *
 * Un camion ajoute au parking n'a pas de dossier : le parking compte des
 * presences, il n'ouvre pas le circuit. L'agent qui tapait la plaque a la
 * cellule T1 ou Balise ne trouvait donc RIEN, sans savoir que le camion etait
 * la, pointe depuis trois jours.
 *
 * Ce bloc se glisse sous toute liste de recherche. Des que la saisie fait deux
 * caracteres, il montre les camions du parking qui correspondent et propose le
 * seul geste utile :
 *   · le dossier existe deja  -> l'ouvrir et continuer la saisie ;
 *   · le dossier n'existe pas -> le creer, plaque deja remplie.
 *
 * Il ne s'affiche que s'il a quelque chose a dire : pas de camion trouve, pas
 * de bloc. Une liste de recherche ordinaire n'est donc jamais alourdie.
 */
export function ResultatsParking({ recherche, go, exclureIds }: {
  recherche: string;
  go: (ecran: string, arg?: unknown) => void;
  /** Dossiers deja montres par la liste au-dessus : on ne les repete pas. */
  exclureIds?: string[];
}) {
  const q = recherche.trim();
  const { data } = useAsync<{ lignes: O[]; active: boolean }>(
    () => (q.length >= 2 ? call('parking.saisie', { recherche: q }) : Promise.resolve({ lignes: [], active: true })),
    [q]);
  const deja = new Set(exclureIds ?? []);
  const lignes = ((data?.['lignes'] as O[]) ?? []).filter((l) => !deja.has(s(l['cargaisonId'])));
  if (q.length < 2 || !lignes.length) return null;

  return <div className="card park-trouve">
    <div className="pt-entete">
      <span className="pt-pastille" aria-hidden="true"><Icone nom="parking" taille={17} /></span>
      <div>
        <b>{lignes.length === 1 ? 'Ce camion est au parking' : `${lignes.length} camions au parking`}</b>
        <div className="help" style={{ marginTop: 2 }}>
          Trouvé dans le registre du parking, pas dans les cargaisons. Ouvrez son dossier pour
          continuer la saisie, ou créez-le s'il n'existe pas encore.
        </div>
      </div>
    </div>
    {lignes.map((l) => {
      const id = s(l['cargaisonId']);
      const plaque = s(l['numeroCamion']);
      return <div key={s(l['id'])} className="pt-ligne">
        <div className="pt-infos">
          <span className="mono pt-plaque">{plaque}</span>
          <span className="help">
            {s(l['numeroConteneur']) ? <>conteneur <b className="mono">{s(l['numeroConteneur'])}</b> · </> : null}
            {s(l['plomb']) ? <>plomb <b className="mono">{s(l['plomb'])}</b> · </> : null}
            au parking depuis {fmtJour(l['dateEntree'])} ({dureeLisible(Number(l['dureeMinutes'] ?? 0))})
            {l['pointeAujourdhui'] === true ? ' · pointé aujourd\'hui' : ''}
          </span>
          {id ? <span className="help">
            Dossier <b className="mono">{id}</b> · {s(l['cargaisonStatut'])}
            {s(l['cargaisonEtape']) ? <> · attendu à <b>{s(l['cargaisonEtape'])}</b></> : null}
          </span> : <span className="help pt-sans">Aucun dossier ouvert pour ce camion.</span>}
        </div>
        {id
          ? <button className="xs" onClick={() => go('detail', id)}>Ouvrir le dossier</button>
          : <button className="xs" onClick={() => go('creercamion', plaque)}>Créer le dossier</button>}
      </div>;
    })}
  </div>;
}

export function useAlerteParking() {
  const [demande, setDemande] = useState<{ lignes: O[]; suite: (ok: boolean) => void } | null>(null);

  /**
   * À appeler AVANT d'enregistrer, avec une plaque ou plusieurs (saisie en lot).
   * Rend `true` si l'enregistrement peut se poursuivre : soit aucun de ces
   * camions n'est au parking, soit l'agent a répondu oui.
   */
  async function confirmer(numeros: string | string[]): Promise<boolean> {
    const plaques = (Array.isArray(numeros) ? numeros : [numeros]).filter((n) => String(n ?? '').trim());
    if (!plaques.length) return true;
    const lignes: O[] = [];
    for (const numeroCamion of plaques) {
      try {
        const r = await call<O>('parking.check', { numeroCamion });
        if (r['present'] === true) lignes.push((r['ligne'] as O) ?? { numeroCamion });
      } catch {
        return true; // le parking ne doit JAMAIS bloquer une saisie
      }
    }
    if (!lignes.length) return true;
    return await new Promise<boolean>((resoudre) => setDemande({ lignes, suite: resoudre }));
  }

  const repondre = (ok: boolean) => {
    demande?.suite(ok);
    setDemande(null);
  };

  const plusieurs = (demande?.lignes.length ?? 0) > 1;
  const fenetre = demande ? <Modal onClose={() => repondre(false)}>
    <h2>{plusieurs ? 'Ces camions sont déjà au parking' : 'Ce camion est déjà au parking'}</h2>
    <ul className="park-alerte">
      {demande.lignes.map((l, i) => <li key={s(l['id']) || i}>
        <b className="mono">{s(l['numeroCamion'])}</b>, au parking depuis le <b>{fmtJour(l['dateEntree'])}</b>
        {s(l['numeroConteneur']) ? <> · conteneur <span className="mono">{s(l['numeroConteneur'])}</span></> : null}
      </li>)}
    </ul>
    <p className="help">
      Voulez-vous continuer l'enregistrement ? {plusieurs ? 'Ces camions restent' : 'Le camion reste'} au
      parking : {plusieurs ? 'ils en sortiront' : 'il en sortira'} au passage à la <b>Porte Principale</b>.
    </p>
    <div className="row" style={{ marginTop: 12, justifyContent: 'flex-end' }}>
      <button className="ghost" onClick={() => repondre(false)}>Non, annuler</button>
      <button onClick={() => repondre(true)}>Oui, continuer</button>
    </div>
  </Modal> : null;

  return { confirmer, fenetre };
}
