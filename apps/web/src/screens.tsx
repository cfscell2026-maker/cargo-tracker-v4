/**
 * Registre de tous les écrans (reproduction de SCREENS v3.6).
 */
import { useEffect, useState } from 'react';
import * as XLSX from 'xlsx';
import { call } from './lib/rpc.ts';
import { useAsync } from './lib/hooks.ts';
import { Spinner, StatCard, Tag, Modal, masks, toast, fmtDate, fmtJour, ChampDestination, Graphique, BarresClassees } from './lib/ui.tsx';
import { bornesDe, isoDate, normaliserPlage, type ModePeriode } from './lib/periode.ts';
import { Detail } from './detail.tsx';
import type { Nav } from './App.tsx';
import { OPERATIONS, VEHICULE_DESTINATIONS, TYPES_DECLARATION, STATUTS, tcValide, etapesEnAttente, estTypeSansT1, libelleTypeSansT1, dureeLisible } from '../../../supabase/functions/_shared/domaine/src/index.ts';

const STATUT_OPTIONS = Object.values(STATUTS);

type O = Record<string, unknown>;
type Screen = (p: Nav) => JSX.Element;

/* ------------------------------ Tableau -------------------------------- */
function Table({ cols, rows, onRow }: { cols: [string, string][]; rows: O[]; onRow?: (r: O) => void }) {
  if (!rows.length) return <div className="empty">Aucune donnée.</div>;
  return <div className="tbl"><table>
    <thead><tr>{cols.map((c) => <th key={c[0]}>{c[1]}</th>)}</tr></thead>
    <tbody>{rows.map((r, i) => (
      <tr key={i} className={onRow ? 'clk' : ''} onClick={() => onRow?.(r)}>
        {cols.map((c) => <td key={c[0]}>{c[0] === 'statut' ? <Tag statut={String(r['statut'])} o={r} /> : c[0].startsWith('date') ? fmtDate(r[c[0]]) : String(r[c[0]] ?? '—')}</td>)}
      </tr>
    ))}</tbody>
  </table></div>;
}

/* --------------------------- Liste de cargaisons ----------------------- */
/**
 * Mémoire d'écran (durée de la session) : recherche, filtre statut et page
 * courante d'une liste. Sans elle, ouvrir une cargaison puis revenir remettait
 * la liste à zéro — l'agent devait retaper sa recherche et refeuilleter ses
 * pages à chaque fiche consultée.
 */
const etatListe: Record<string, { statut: string; search: string; page: number }> = {};

function CargoList({ go, screen, filtre, titre, barre }: Nav & { filtre: O; titre?: string; barre?: boolean }) {
  // Un statut porté par l'ARGUMENT d'écran (tuile du tableau de bord) exprime une
  // intention FRAÎCHE : il prime sur la mémoire, qui repart alors de zéro.
  const impose = filtre['statut'] === undefined ? null : String(filtre['statut']);
  const memoire = barre ? etatListe[screen] : undefined;
  const reprise = memoire && (impose === null || impose === memoire.statut) ? memoire : undefined;

  const [page, setPage] = useState(reprise?.page ?? 1);
  const [statut, setStatut] = useState(impose ?? reprise?.statut ?? 'tous');
  const [search, setSearch] = useState(reprise?.search ?? '');
  const reset = () => setPage(1);
  // Écrit APRÈS le rendu (jamais pendant : le rendu doit rester sans effet de bord).
  useEffect(() => { if (barre) etatListe[screen] = { statut, search, page }; }, [barre, screen, statut, search, page]);
  const eff = barre ? { ...filtre, statut, search } : filtre;
  const { data, loading, error } = useAsync<{ rows: O[]; total: number; pages: number }>(
    () => call('cargo.list', { ...eff, page }), [JSON.stringify(filtre), statut, search, page]);
  return <div className="card">
    {titre && <h2>{titre}</h2>}
    {barre && <div className="row" style={{ alignItems: 'center', flexWrap: 'wrap', gap: 8, marginBottom: 10 }}>
      <input className="mono" value={search} onChange={(e) => { setSearch(e.target.value); reset(); }}
        placeholder="Rechercher — N° conteneur, ID, camion, GPS" style={{ flex: 1, minWidth: 220 }} />
      <select value={statut} onChange={(e) => { setStatut(e.target.value); reset(); }} style={{ maxWidth: 220 }}>
        <option value="tous">Tous les statuts</option>
        {STATUT_OPTIONS.map((s) => <option key={s} value={s}>{s}</option>)}
      </select>
    </div>}
    {barre && <ExportCargaisons />}
    {loading ? <Spinner /> : error ? <div className="err-msg">{error}</div> : <>
      {barre && <div className="help" style={{ marginBottom: 6 }}>{data?.total ?? 0} cargaison(s)</div>}
      <Table cols={[['id', 'ID'], ['dateCreation', 'Date'], ['numeroCamion', 'Camion'], ['typeOperation', 'Opération'], ['statut', 'Statut'], ['numeroGps', 'GPS']]}
        rows={data?.rows ?? []} onRow={(r) => go('detail', r['id'])} />
      {(data?.pages ?? 1) > 1 && <div className="row" style={{ marginTop: 10, justifyContent: 'center' }}>
        <button className="ghost xs" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>‹</button>
        <span>Page {page} / {data?.pages}</span>
        <button className="ghost xs" disabled={page >= (data?.pages ?? 1)} onClick={() => setPage((p) => p + 1)}>›</button>
      </div>}
    </>}
  </div>;
}

/**
 * v4.1 — Extraction des cargaisons (décision client 2026-07-31) : choisir un
 * critère (statut exact OU étape en attente) + une période, sortir en Excel ou
 * PDF. Rétablit l'onglet « Cargaisons » exportable de l'Apps Script (« je n'ai
 * pas la main pour le faire », pour les capitaines).
 */
function ExportCargaisons() {
  const p = useReportRange('mois');
  const [crit, setCrit] = useState(''); // '' | 'statut:<v>' | 'etape:<v>'
  const [busy, setBusy] = useState(false);
  async function exporter(fmt: 'xlsx' | 'pdf') {
    const params: O = { du: p.du, au: p.au, format: fmt };
    if (crit.startsWith('statut:')) params['statut'] = crit.slice(7);
    else if (crit.startsWith('etape:')) params['etape'] = crit.slice(6);
    setBusy(true);
    try {
      const r = await call<O>('report.cargaisons', params);
      if (fmt === 'pdf') imprimerHtml(String(r['html'] ?? '')); else telecharger(r);
    } catch (e) { toast((e as Error).message, 'err'); } finally { setBusy(false); }
  }
  return <details style={{ border: '1px solid var(--line)', borderRadius: 6, padding: '8px 12px', marginBottom: 10 }}>
    <summary style={{ cursor: 'pointer', fontWeight: 600 }}>⤓ Extraire (Excel / PDF) par statut et période</summary>
    <div className="row" style={{ alignItems: 'center', flexWrap: 'wrap', gap: 8, marginTop: 10 }}>
      <select value={crit} onChange={(e) => setCrit(e.target.value)} style={{ maxWidth: 240 }}>
        <option value="">Tous les statuts</option>
        {STATUT_OPTIONS.map((s) => <option key={s} value={`statut:${s}`}>{s}</option>)}
        <option value="etape:VALIDATION">En attente — À valider</option>
        <option value="etape:T1">En attente — T1</option>
        <option value="etape:BALISE">En attente — Balise</option>
        <option value="etape:BS">En attente — Bon de sortie</option>
        <option value="etape:PP">En attente — Sortie (PP)</option>
      </select>
      <PeriodPicker p={p} />
      <button className="ghost xs" disabled={busy} onClick={() => exporter('xlsx')}>⤓ Excel</button>
      <button className="ghost xs" disabled={busy} onClick={() => exporter('pdf')}>⤓ PDF</button>
    </div>
    <PeriodeLue p={p} />
  </details>;
}

/* ------------------------------ Écrans --------------------------------- */
const SCREENS: Record<string, Screen> = {};

SCREENS.dash = (nav) => {
  // Même sélecteur de période que les rapports, plage personnalisée comprise.
  const p = useReportRange();
  const { du, au } = p;
  const { data, loading } = useAsync<O>(() => call('dashboard.stats', { du, au }), [du, au]);
  const s = data ?? {};
  const go = (statut: string) => nav.go('list', { statut });
  return <>
    <div className="card"><div className="row" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
      <h2 style={{ flex: 1, margin: 0 }}>Tableau de bord</h2>
      <label className="help" style={{ margin: 0 }}>Période</label>
      <PeriodPicker p={p} />
    </div><div className="help">Cargaisons créées du {fmtJour(du)} au {fmtJour(au)}
      {p.inversee && <span style={{ color: 'var(--warn)' }}> — dates inversées, remises à l'endroit</span>}</div></div>
    {loading ? <Spinner /> : <div className="stats">
      <StatCard n={Number(s['camion'] ?? 0)} l="Camions créés" onClick={() => go('Camion créé')} />
      <StatCard n={Number(s['chargement'] ?? 0)} l="En chargement" onClick={() => go('En cours de chargement')} />
      <StatCard n={Number(s['attValidation'] ?? 0)} l="Attente validation" tone="warn" onClick={() => nav.go('wait_valid')} />
      <StatCard n={Number(s['attT1'] ?? 0)} l="Attente T1" onClick={() => nav.go('wait_t1')} />
      <StatCard n={Number(s['attBalise'] ?? 0)} l="Attente Balise" onClick={() => nav.go('wait_gps')} />
      <StatCard n={Number(s['attBs'] ?? 0)} l="Attente Bon de sortie" onClick={() => nav.go('wait_bs')} />
      <StatCard n={Number(s['attPP'] ?? 0)} l="Attente sortie" onClick={() => nav.go('wait_sortie')} />
      <StatCard n={Number(s['sortie'] ?? 0)} l="Sortis" tone="ok" onClick={() => go('Sortie Enregistrée')} />
      <StatCard n={Number(s['vehiculesAttente'] ?? 0)} l="Véhicules en attente" onClick={() => nav.go('vehicules')} />
    </div>}
    {/* Neuf tuiles disent COMBIEN, aucune ne dit OÙ ÇA BLOQUE : c'est pourtant
        la première question d'un chef le matin. Le classement des files répond
        d'un coup d'œil, et chaque barre ouvre la file concernée. */}
    {!loading && <div className="card"><h2>Où sont les dossiers en attente</h2>
      <BarresClassees
        lignes={[
          { nom: 'Validation chef de brigade', valeur: Number(s['attValidation'] ?? 0) },
          { nom: 'Cellule T1', valeur: Number(s['attT1'] ?? 0) },
          { nom: 'Cellule Balise', valeur: Number(s['attBalise'] ?? 0) },
          { nom: 'Bon de sortie', valeur: Number(s['attBs'] ?? 0) },
          { nom: 'Sortie (Porte Principale)', valeur: Number(s['attPP'] ?? 0) },
        ]}
        onClic={(nom) => nav.go(nom.startsWith('Validation') ? 'wait_valid'
          : nom.startsWith('Cellule T1') ? 'wait_t1'
            : nom.startsWith('Cellule Balise') ? 'wait_gps'
              : nom.startsWith('Bon') ? 'wait_bs' : 'wait_sortie')} />
      <p className="help" style={{ marginBottom: 0 }}>
        Les files sont <b>parallèles</b> : un même camion peut attendre à plusieurs postes à la fois.
        Le total dépasse donc le nombre de dossiers — les parts se lisent poste par poste.
      </p>
    </div>}
    <FicheBord p={p} />
  </>;
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
    <button className="ghost" onClick={() => setOuvert((v) => !v)} style={{ width: '100%', textAlign: 'left', fontWeight: 700 }}>
      {ouvert ? '▾' : '▸'} Fiche de synthèse — CFS · T1 · Balise · Bon de sortie · PP
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
function Hub({ nav, titre, desc, items }: { nav: Nav; titre: string; desc?: string; items: [string, string, string][] }) {
  return <div className="card"><h2>{titre}</h2>
    {desc && <p className="help" style={{ marginTop: 0 }}>{desc}</p>}
    <div className="hubgrid">
      {items.map(([s, l, ic]) => <button key={s} className="hubitem" onClick={() => nav.go(s)}>
        <span className="hubic">{ic}</span><span>{l}</span></button>)}
    </div>
  </div>;
}
function itemsConteneurs(role: string): [string, string, string][] {
  const stock: [string, string, string] = ['stock', 'Stock conteneurs', '▦'];
  const pointage: [string, string, string] = ['pointage', 'Pointage matinal', '◉'];
  const stockjour: [string, string, string] = ['stockjour', 'Stock CFS journalier', '◧'];
  const imp: [string, string, string] = ['import', 'Stock initial (import)', '⮉'];
  const impAnn: [string, string, string] = ['importannonce', 'Annonce de transfert', '⮈'];
  const annonce: [string, string, string] = ['annonce', 'Stock annoncé', '▦'];
  const pointEntree: [string, string, string] = ['pointentree', 'Pointage entrée', '◉'];
  const confEntree: [string, string, string] = ['confentree', 'Confirmer entrée', '✔'];
  // v4.2 — positionnés / dépotés / restant par jour (demande CFS).
  const depot: [string, string, string] = ['depotstats', 'Statistiques de dépotage', '◭'];
  if (role === 'ADMIN') return [stock, pointage, stockjour, depot, imp, impAnn, annonce, pointEntree, confEntree];
  if (role === 'PP') return [annonce, pointEntree, confEntree];
  if (role === 'CFS') return [stock, pointage, stockjour, depot, imp, annonce, confEntree];
  // Chefs : lecture seule, mais les statistiques de dépotage les intéressent.
  return [stock, depot, annonce];
}
SCREENS.conteneurs = (nav) => <Hub nav={nav} titre="Opérations sur conteneurs"
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
  return <>
    <div className="card"><div className="row" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
      <h2 style={{ flex: 1, margin: 0 }}>Véhicules dépotés</h2>
      {(nav.user.role === 'CFS' || nav.user.role === 'ADMIN') && <button onClick={() => nav.go('vehnew')}>＋ Dépotage de véhicules</button>}
    </div>
    <p className="help" style={{ marginBottom: 6 }}>Les véhicules dépotés sont suivis à part des camions.</p>
    {loading ? <Spinner /> : <div className="stats">
      <StatCard n={Number(cp['total'] ?? 0)} l="Total véhicules" />
      <StatCard n={Number(cp['attente'] ?? 0)} l="Présents sur site" tone="warn" />
      <StatCard n={Number(cp['sortis'] ?? 0)} l="Sortis" tone="ok" />
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
    <h2>Rechercher un véhicule</h2>
    <input className="mono" value={q} onChange={(e) => setQ(e.target.value)}
      placeholder="N° de châssis (même les 6 derniers chiffres) ou marque…" autoFocus />
    <div className="help" style={{ margin: '8px 0' }}>{loading ? 'Recherche…' : `${data?.total ?? 0} véhicule(s)`}</div>
    {loading ? <Spinner /> : <Table
      cols={[['chassis', 'Châssis'], ['marque', 'Marque'], ['modele', 'Modèle'], ['couleur', 'Couleur'], ['destination', 'Destination'], ['statut', 'Statut'], ['conteneurOrigine', 'TC origine']]}
      rows={rows} onRow={(r) => nav.go('detail', r['id'])} />}
  </div>;
}
SCREENS.vehnew = ({ go }) => <div className="card"><h2>Dépotage de véhicules</h2>
  <p className="help" style={{ marginTop: 0 }}>Un conteneur d'origine, puis un ou plusieurs véhicules (châssis). Les véhicules ne sont pas des camions.</p>
  <FormVehicule go={go} /></div>;
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
    <div className="card"><div className="row" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
      <h2 style={{ flex: 1, margin: 0 }}>{titre}</h2>
      {T.map(([k, l]) => <button key={k} className={onglet === k ? '' : 'ghost'} onClick={() => setOnglet(k as never)}>{l}</button>)}
    </div>
    <p className="help" style={{ marginBottom: 0 }}>Apurement par {estIndus(type) ? <b>poids (kg)</b> : <b>quantités (colis)</b>}. {entrepots.length} entrepôt(s) {titre}.</p></div>
    {loading ? <Spinner /> : entrepots.length === 0 && onglet !== 'gerer'
      ? <div className="card"><div className="empty">Aucun entrepôt {titre}. {peutGerer ? 'Créez-en un dans l\'onglet « Entrepôts ».' : 'Demandez à un chef d\'en créer un.'}</div></div>
      : onglet === 'entree' ? <EntrepotEntree type={type} entrepots={entrepots} />
        : onglet === 'sortie' ? <EntrepotSortie type={type} entrepots={entrepots} nav={nav} />
          : onglet === 'stats' ? <EntrepotStats type={type} />
            : <EntrepotGerer type={type} entrepots={entrepots} reload={reload} />}
  </>;
}

/** Gestion des entrepôts (création — admin / chef brigade / division). */
function EntrepotGerer({ type, entrepots, reload }: { type: EntrepotType; entrepots: O[]; reload: () => void }) {
  const [code, setCode] = useState('');
  const [nom, setNom] = useState('');
  const [busy, setBusy] = useState(false);
  async function creer() {
    if (!code.trim() || !nom.trim()) { toast('Code et nom requis.', 'err'); return; }
    setBusy(true);
    try { await call('entrepot.create', { code, nom, type }); toast('Entrepôt créé.', 'ok'); setCode(''); setNom(''); reload(); }
    catch (e) { toast((e as Error).message, 'err'); } finally { setBusy(false); }
  }
  return <div className="card"><h2>Entrepôts {estIndus(type) ? 'industriels' : 'MAD'}</h2>
    <div className="grid2">
      <div><label className="help">Code</label><input className="mono" value={code} onChange={(e) => setCode(masks.alnum(e.target.value))} placeholder="ex. MAD-01" /></div>
      <div><label className="help">Nom</label><input value={nom} onChange={(e) => setNom(masks.upper(e.target.value))} /></div>
    </div>
    <div style={{ marginTop: 10 }}><button disabled={busy} onClick={creer}>Créer l'entrepôt</button></div>
    <div className="section-title" style={{ marginTop: 14 }}>Existants ({entrepots.length})</div>
    <Table cols={[['code', 'Code'], ['nom', 'Nom'], ['creePar', 'Créé par']]} rows={entrepots} />
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
          <div><label className="help">N° camion</label><input className="mono" value={numCamion} onChange={(e) => setNumCamion(masks.alnum(e.target.value))} /></div>
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
        rows={ents} onRow={(r) => setSel(r)} /></div>
    <div className="card"><h2>Par déclaration ({u})</h2>
      {decls.length === 0 ? <div className="empty">Aucune entrée enregistrée.</div>
        : <Table cols={[['libelle', 'Déclaration'], ['entrepotCode', lib], ['entrees', `Entrées (${u})`], ['sorties', `Sorties (${u})`], ['restant', `Restant (${u})`]]} rows={decls} />}
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
    <h2>{lib} {String(entrepot['nom'])} ({code})</h2>
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
    <h2>Apurements — article n°{apur.numero}{apur.designation ? ` (${apur.designation})` : ''}</h2>
    <p className="help" style={{ marginTop: 0 }}>Déclarations venues apurer cet article ({unite}).</p>
    {loading ? <Spinner /> : rows.length === 0 ? <div className="empty">Aucun apurement.</div>
      : <Table cols={[['declaration', 'Déclaration d\'apurement'], [champ, `Quantité (${unite})`], ['dateSortie', 'Date'], ['camion', 'Camion / scellés'], ['agent', 'Agent']]} rows={rows} />}
  </Modal>;
}

SCREENS.completer = (nav) => <CargoList {...nav} filtre={{ etape: 'CFS' }} titre="À compléter (CFS)" />;
SCREENS.wait_valid = (nav) => <ValidationDeclaration {...nav} />;
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
async function chercherExistantActif(num: string): Promise<O | null> {
  if (!num.trim()) return null;
  try {
    const r = await call<{ camion: O[] }>('cargo.checkdup', { numeroCamion: num });
    return (r.camion ?? []).find((c) => c['actif'] && STATUTS_EDITABLES.includes(String(c['statut']))) ?? null;
  } catch { return null; }
}
/** Modale « ce numéro existe déjà » : ouvrir (mixte) / créer quand même / annuler. */
function ModaleMixte({ match, quoi, onOuvrir, onCreer, onAnnuler }: {
  match: O; quoi: string; onOuvrir: () => void; onCreer: () => void; onAnnuler: () => void;
}) {
  return <Modal onClose={onAnnuler}>
    <h2>Ce {quoi} existe déjà</h2>
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

SCREENS.creercamion = ({ go }) => {
  const [num, setNum] = useState('');
  const [routage, setRoutage] = useState(OPERATIONS.ENLEVEMENT as string);
  const [busy, setBusy] = useState(false);
  const [match, setMatch] = useState<O | null>(null);
  async function faireCreer() {
    setBusy(true);
    try {
      const r = await call<{ id: string }>('cargo.createcamion', { numeroCamion: num, routage });
      toast('Camion créé.', 'ok'); go('detail', r.id);
    } catch (e) { toast((e as Error).message, 'err'); } finally { setBusy(false); }
  }
  async function creer() {
    if (!num) { toast('N° camion requis.', 'err'); return; }
    setBusy(true);
    const ex = await chercherExistantActif(num);
    setBusy(false);
    if (ex) { setMatch(ex); return; } // propose le mixte
    await faireCreer();
  }
  return <div className="card" style={{ maxWidth: 480 }}>
    <h2>Créer un camion à l'entrée</h2>
    <p className="help">Le CFS crée le camion vide et choisit le type d'opération ; l'association des conteneurs se fait ensuite dans le détail.</p>
    <label className="help">N° camion</label><input className="mono" value={num} onChange={(e) => setNum(masks.alnum(e.target.value))} />
    <label className="help">Type d'opération</label>
    <select value={routage} onChange={(e) => setRoutage(e.target.value)}><option>{OPERATIONS.ENLEVEMENT}</option><option>{OPERATIONS.DEPOTAGE}</option></select>
    <div style={{ marginTop: 12 }}><button disabled={busy} onClick={creer}>Créer</button></div>
    {match && <ModaleMixte match={match} quoi="camion"
      onOuvrir={() => { setMatch(null); go('detail', match['id']); }}
      onCreer={() => { setMatch(null); faireCreer(); }}
      onAnnuler={() => setMatch(null)} />}
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
          <input className="mono" value={l.numeroCamion} onChange={(e) => majLigne(i, { numeroCamion: masks.alnum(e.target.value) })} /></div>
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
SCREENS.search = ({ go }) => {
  const [q, setQ] = useState('');
  const cherche = q.trim().length >= 2;
  const { data, loading } = useAsync<{ rows: O[]; total: number }>(
    () => (cherche ? call('cargo.list', { categorie: 'tous', actifs: true, search: q.trim(), pageSize: 100 })
      : call('cargo.list', { categorie: 'tous', actifs: true, pageSize: 100 })), [q]);
  const rows = data?.rows ?? [];
  return <div className="card">
    <h2>Rechercher une cargaison en cours</h2>
    <p className="help" style={{ marginTop: 0 }}>
      Uniquement les cargaisons <b>encore présentes</b> (non sorties). Cherchez par
      N° de camion, N° de conteneur, ID de cargaison ou N° de balise — les espaces et
      tirets sont ignorés.
    </p>
    <input className="mono" value={q} onChange={(e) => setQ(e.target.value)}
      placeholder="N° camion, conteneur, ID ou balise…" autoFocus />
    <div className="help" style={{ marginTop: 8 }}>
      {loading ? 'Recherche…' : cherche
        ? `${data?.total ?? 0} résultat(s) actif(s)`
        : `${data?.total ?? 0} cargaison(s) active(s) — tapez au moins 2 caractères pour filtrer`}
    </div>
    <div style={{ marginTop: 10 }}>
      {loading ? <Spinner /> : <Table
        cols={[['numeroCamion', 'Camion / Châssis'], ['conteneur1', 'Conteneur'], ['typeOperation', 'Opération'],
          ['statut', 'Statut'], ['etapeEnCours', 'Attendu à'], ['dateCreation', 'Entré le']]}
        rows={rows.map(avecEtape)} onRow={(r) => go('detail', r['id'])} />}
    </div>
  </div>;
};

/** Prochaine cellule qui doit traiter la cargaison — la réponse cherchée au guichet. */
const ETAPE_LABELS: Record<string, string> = {
  CFS: 'CFS (chargement)', VALIDATION: 'Chef brigade', T1: 'Cellule T1',
  BALISE: 'Cellule Balise', BS: 'Bon de sortie', PP: 'Porte principale',
};
function avecEtape(r: O): O {
  const pend = etapesEnAttente(r as never).map((e) => ETAPE_LABELS[e] ?? e);
  return { ...r, etapeEnCours: pend.join(' + ') || '—' };
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
    const chassis = String(vs[0]?.['chassis'] ?? '').trim();
    const ex = chassis ? await chercherExistantActif(chassis) : null;
    if (ex) { setMatch(ex); return; }
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
        <div style={{ flex: 1 }}><label className="help">N° camion</label><input className="mono" value={c.numeroCamion} onChange={(e) => majCam(i, { numeroCamion: masks.alnum(e.target.value) })} /></div>
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

    <div style={{ marginTop: 12 }}><button onClick={creer}>Créer le véhicule</button></div>
    {match && <ModaleMixte match={match} quoi="véhicule"
      onOuvrir={() => { setMatch(null); go('detail', match['id']); }}
      onCreer={() => { setMatch(null); faireCreer(); }}
      onAnnuler={() => setMatch(null)} />}
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
  return <div style={{ marginTop: 12 }}>
    <div className="section-title">Déclaration</div>
    <InfoTypeDecl d={d} mode={mode} setMode={setMode} />
    <DeclFields d={d} set={set} />
    <div className="section-title" style={{ marginTop: 14 }}>Camion</div>
    <div className="grid2"><div><label className="help">N° camion</label><input className="mono" value={num} onChange={(e) => setNum(masks.alnum(e.target.value))} /></div></div>
    <label className="help" style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 10 }}>
      <input type="checkbox" style={{ width: 'auto' }} checked={chargementTermine} onChange={(e) => setChargementTermine(e.target.checked)} />
      <span>Chargement terminé (scellés posés) — sinon « En cours de chargement »</span>
    </label>
    {chargementTermine && <div className="grid2" style={{ marginTop: 6 }}>
      {[0, 1, 2].map((k) => <div key={k}><label className="help">Scellé camion {k + 1}{k < 2 ? ' *' : ''}</label>
        <input value={scelles[k] ?? ''} onChange={(e) => setScelles((a) => a.map((x, j) => j === k ? masks.upper(e.target.value) : x))} /></div>)}
    </div>}
    <div style={{ marginTop: 12 }}><button onClick={creer}>Créer</button></div>
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
  return <div style={{ marginTop: 12 }}>
    <div className="section-title">Déclaration</div>
    <InfoTypeDecl d={d} mode={mode} setMode={setMode} />
    <DeclFields d={d} set={set} />
    <div className="section-title" style={{ marginTop: 14 }}>Camion & conteneur</div>
    <div className="grid2">
      <div><label className="help">N° camion</label><input className="mono" value={num} onChange={(e) => setNum(masks.alnum(e.target.value))} /></div>
      <div><label className="help">Conteneur</label><input className="mono" value={String(ct['num'])} onChange={(e) => setC('num', masks.tc(e.target.value))} /></div>
      <div><label className="help">Taille</label><input value={String(ct['taille'])} onChange={(e) => setC('taille', masks.upper(e.target.value))} /></div>
      <div><label className="help">Type</label><input value={String(ct['type'])} onChange={(e) => setC('type', masks.upper(e.target.value))} /></div>
      <div><label className="help">Scellé</label><input value={String(ct['plomb'])} onChange={(e) => setC('plomb', masks.upper(e.target.value))} /></div>
    </div>
    <div style={{ marginTop: 12 }}><button onClick={creer}>Créer</button></div>
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
  return <div className="card">
    <div className="row" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
      <h2 style={{ flex: 1, margin: 0 }}>Statistiques de dépotage</h2>
      <PeriodPicker p={p} />
    </div>
    <PeriodeLue p={p} />
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
  </div>;
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
    <h2>{doublons.length} conteneur(s) déjà connu(s) du système</h2>
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
  w.document.write(html);
  w.document.close();
  w.focus();
  setTimeout(() => w.print(), 300); // laisse le rendu se poser avant l'impression
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

  if (ouverte) return <DossierValidation decl={ouverte} data={data} loading={loading} error={error}
    reload={reload} fermer={() => (ecranPrecedent === 'wait_valid' ? retour() : go('wait_valid'))} go={go} />;

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
    onDone={() => { setSel({}); setGroupe(false); reload(); }} />;

  return <div className="card">
    <h2>Déclarations à valider</h2>
    <p className="help" style={{ marginTop: 0 }}>
      Ouvrez une déclaration pour examiner <b>tous</b> ses camions, véhicules et conteneurs,
      puis signer l'ensemble en une fois — ou <b>cochez plusieurs déclarations</b> et validez-les
      toutes d'un même geste.
    </p>
    <div className="row" style={{ alignItems: 'flex-end', gap: 8, marginBottom: 12 }}>
      <div style={{ flex: 1, minWidth: 200 }}><label className="help">Ouvrir directement un N° de déclaration</label>
        <input className="mono" value={q.numeroDeclaration} onChange={(e) => setQ({ ...q, numeroDeclaration: masks.upper(e.target.value) })}
          onKeyDown={(e) => e.key === 'Enter' && q.numeroDeclaration.trim() && ouvrir(q)} /></div>
      <div><label className="help">Année</label><input value={q.anneeDeclaration} style={{ maxWidth: 90 }}
        onChange={(e) => setQ({ ...q, anneeDeclaration: e.target.value })} /></div>
      <button disabled={!q.numeroDeclaration.trim()} onClick={() => ouvrir(q)}>Ouvrir</button>
    </div>

    {loading ? <Spinner /> : error ? <div className="err-msg">{error}</div> : decls.length === 0
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
  </div>;
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
  cles: QDecl[]; fermer: () => void; go: Nav['go']; onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [pesees, setPesees] = useState<Record<string, Pesee>>({});
  const { data, loading, error } = useAsync<O[]>(
    () => Promise.all(cles.map((c) => call<O>('report.validationdecl', c))),
    [JSON.stringify(cles)]);
  const dossiers = data ?? [];
  const aValider = dossiers.flatMap((d) => (d['aValider'] as string[]) ?? []);
  const setPesee = (id: string, p: Pesee) => setPesees((o) => ({ ...o, [id]: p }));
  const peseesPretes = aValider.every((id) => peseeComplete(pesees[id]));

  async function signer() {
    if (!peseesPretes) { toast('Renseignez la pesée de chaque camion avant de signer.', 'err'); return; }
    if (!window.confirm(
      `Valider et signer ${aValider.length} cargaison(s) réparties sur ${cles.length} déclaration(s) ?\n\n`
      + 'Votre signature numérique sera apposée sur chacune.')) return;
    setBusy(true);
    try {
      const payloadPesees: Record<string, { enSurcharge: boolean; poidsSurcharge: string }> = {};
      for (const id of aValider) { const p = pesees[id]!; payloadPesees[id] = { enSurcharge: p.enSurcharge === 'oui', poidsSurcharge: p.poids }; }
      const r = await call<{ compte: O; erreurs: O[] }>('cargo.validerlot', { ids: aValider, pesees: payloadPesees });
      const nb = Number(r.compte['validees'] ?? 0);
      toast(`${nb} cargaison(s) validée(s)${r.erreurs.length ? ` · ${r.erreurs.length} en erreur` : ''}.`,
        r.erreurs.length ? 'err' : 'ok');
      r.erreurs.forEach((e) => toast(`${String(e['id'])} : ${String(e['message'])}`, 'err'));
      onDone();
    } catch (e) { toast((e as Error).message, 'err'); } finally { setBusy(false); }
  }

  return <div>
    <button className="ghost" onClick={fermer}>← Retour à la sélection</button>
    <div className="card" style={{ marginTop: 10 }}>
      <h2 style={{ margin: 0 }}>Validation groupée — {cles.length} déclaration(s)</h2>
      {loading ? <Spinner /> : error ? <div className="err-msg">{error}</div> : <>
        <div className="row" style={{ alignItems: 'center', marginTop: 12 }}>
          <button disabled={busy || !peseesPretes || !aValider.length} onClick={signer}>
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
function DossierValidation({ decl, data, loading, error, reload, fermer, go }: {
  decl: QDecl; data: O | null; loading: boolean; error: string | null;
  reload: () => void; fermer: () => void; go: Nav['go'];
}) {
  const [busy, setBusy] = useState(false);
  const [pesees, setPesees] = useState<Record<string, Pesee>>({});
  const cam = (data?.['camions'] as O[]) ?? [];
  const veh = (data?.['vehicules'] as O[]) ?? [];
  const cpt = (data?.['compte'] as O) ?? {};
  const d = (data?.['declaration'] as O) ?? {};
  const apu = data?.['apurement'] as O | null;
  const aValider = (data?.['aValider'] as string[]) ?? [];
  const setPesee = (id: string, p: Pesee) => setPesees((o) => ({ ...o, [id]: p }));
  // Toutes les cargaisons à valider doivent avoir une pesée complète.
  const peseesPretes = aValider.every((id) => peseeComplete(pesees[id]));

  async function signer() {
    if (!peseesPretes) { toast('Renseignez la pesée de chaque camion avant de signer.', 'err'); return; }
    if (!window.confirm(
      `Valider et signer ${aValider.length} cargaison(s) de la déclaration ${String(d['numeroDeclaration'] ?? decl.numeroDeclaration)} ?\n\n`
      + `${Number(cpt['conteneursAValider'] ?? 0)} conteneur(s) concerné(s). Votre signature numérique sera apposée sur chacune.`)) return;
    setBusy(true);
    try {
      const payloadPesees: Record<string, { enSurcharge: boolean; poidsSurcharge: string }> = {};
      for (const id of aValider) { const p = pesees[id]!; payloadPesees[id] = { enSurcharge: p.enSurcharge === 'oui', poidsSurcharge: p.poids }; }
      const r = await call<{ compte: O; erreurs: O[] }>('cargo.validerlot', { ids: aValider, pesees: payloadPesees });
      const nb = Number(r.compte['validees'] ?? 0);
      toast(`${nb} cargaison(s) validée(s)${r.erreurs.length ? ` · ${r.erreurs.length} en erreur` : ''}.`,
        r.erreurs.length ? 'err' : 'ok');
      r.erreurs.forEach((e) => toast(`${String(e['id'])} : ${String(e['message'])}`, 'err'));
      reload();
    } catch (e) { toast((e as Error).message, 'err'); } finally { setBusy(false); }
  }

  return <div>
    <button className="ghost" onClick={fermer}>← Retour aux déclarations</button>
    <div className="card" style={{ marginTop: 10 }}>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <h2 style={{ margin: 0 }}>Déclaration {String(d['numeroDeclaration'] ?? decl.numeroDeclaration)}</h2>
          <div className="help" style={{ marginTop: 2 }}>
            {[d['anneeDeclaration'], d['bureauDeclaration'], d['typeDeclaration']].filter(Boolean).join(' · ') || '—'}
            {' · Déclarant '}<b>{String(d['declarant'] || '—')}</b>
            {apu?.['exists'] ? ` · Apurement ${String(apu['apures'])}/${String(apu['nombreConteneurs'])} (restant ${String(apu['restant'])})` : ''}
          </div>
        </div>
        <button className="ghost xs" onClick={reload}>⟳ Actualiser</button>
      </div>

      {loading ? <Spinner /> : error ? <div className="err-msg">{error}</div> : <>
        <div className="stats" style={{ marginTop: 12 }}>
          <StatCard n={Number(cpt['camions'] ?? 0)} l="Camions" />
          <StatCard n={Number(cpt['vehicules'] ?? 0)} l="Véhicules" />
          <StatCard n={Number(cpt['conteneurs'] ?? 0)} l="Conteneurs" />
          <StatCard n={Number(cpt['aValider'] ?? 0)} l="À valider" tone="warn" />
          <StatCard n={Number(cpt['dejaValidees'] ?? 0)} l="Déjà validées" tone="ok" />
        </div>

        {aValider.length > 0
          ? <div className="row" style={{ alignItems: 'center', marginTop: 4 }}>
            <button disabled={busy || !peseesPretes} onClick={signer}>
              {busy ? 'Signature…' : `✔ Valider et signer les ${aValider.length} cargaison(s)`}
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
  </div>;
}

/** Pesée d'un camion : en surcharge OUI/NON (+ poids si OUI). */
type Pesee = { enSurcharge: '' | 'oui' | 'non'; poids: string };
export const peseeComplete = (p?: Pesee): boolean => !!p && (p.enSurcharge === 'non' || (p.enSurcharge === 'oui' && p.poids.trim() !== ''));

/** Une cargaison du dossier : tout ce qu'il faut voir AVANT de signer. */
function LigneValidation({ r, go, pesee, onPesee }: { r: O; go: Nav['go']; pesee?: Pesee; onPesee?: (p: Pesee) => void }) {
  const conts = (r['conteneurs'] as O[]) ?? [];
  const sc = (r['scellesCamion'] as string[]) ?? [];
  const autres = (r['autresDeclarations'] as O[]) ?? [];
  const v = r['vehicule'] as O | undefined;
  const valide = Boolean(r['dateValidation']);
  const pe = pesee ?? { enSurcharge: '' as const, poids: '' };
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
    {valide && <div className="help" style={{ color: 'var(--ok)' }}>Validée par {String(r['agentValidation'] || '—')} le {fmtDate(r['dateValidation'])}</div>}
    {!valide && reste.length > 0 && <div className="help">Restera ensuite : {reste.join(' · ')}</div>}
    {conts.length > 0 && <Table cols={[['num', 'Conteneur'], ['plomb', 'Scellé'], ['taille', 'Taille'], ['type', 'Type']]} rows={conts} />}
    {!conts.length && !v && r['descriptionMarchandise'] ? <div className="help">Effets divers : {String(r['descriptionMarchandise'])}</div> : null}
    {/* v4.1 — pesée à renseigner AVANT la signature (seulement si à valider). */}
    {!valide && onPesee && <div className="row" style={{ alignItems: 'center', gap: 12, flexWrap: 'wrap', marginTop: 8, paddingTop: 8, borderTop: '1px dotted var(--line)' }}>
      <span className="help" style={{ fontWeight: 600 }}>Pesée :</span>
      <label className="help" style={{ display: 'flex', gap: 5, alignItems: 'center' }}>
        <input type="radio" style={{ width: 'auto' }} checked={pe.enSurcharge === 'oui'} onChange={() => onPesee({ enSurcharge: 'oui', poids: pe.poids })} /> En surcharge</label>
      <label className="help" style={{ display: 'flex', gap: 5, alignItems: 'center' }}>
        <input type="radio" style={{ width: 'auto' }} checked={pe.enSurcharge === 'non'} onChange={() => onPesee({ enSurcharge: 'non', poids: '' })} /> Hors surcharge</label>
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

function RapportCellule({ action, detail, titre, twins, camLabel, go }: {
  action: string; detail: string; titre: string; twins?: boolean; camLabel: string; go: Nav['go'];
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

  function Carte({ n, l, op: o, metric, tone }: { n: unknown; l: string; op?: string; metric?: MetriqueCellule; tone?: 'ok' }) {
    if (!metric) return <div className={`stat ${tone ?? ''}`}><div className="n">{Number(n ?? 0)}</div><div className="l">{l}</div></div>;
    return <div className={`stat ${tone ?? ''}`} role="button" title="Voir le détail" onClick={() => setModal({ op: o ?? '', metric })}>
      <div className="n">{Number(n ?? 0)}</div><div className="l">{l}</div></div>;
  }
  function Bloc({ nom, o, a }: { nom: string; o: string; a: O }) {
    return <div className="card"><h2>{nom}</h2><div className="stats">
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
    <div className="card"><div className="row" style={{ flexWrap: 'wrap', alignItems: 'center' }}>
      <h2 style={{ flex: 1 }}>{titre}</h2>
      <select value={op} onChange={(e) => setOp(e.target.value)} style={{ maxWidth: 200 }}>
        <option value="">Toutes opérations</option><option>{OPERATIONS.ENLEVEMENT}</option><option>{OPERATIONS.DEPOTAGE}</option>
      </select>
      <PeriodPicker p={p} />
      <button className="ghost xs" onClick={() => exporter('xlsx')}>⤓ Excel</button>
      <button className="ghost xs" onClick={() => exporter('pdf')}>⤓ PDF</button>
    </div><PeriodeLue p={p} /></div>
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
    <h2>{(op || 'Toutes opérations')} — {data?.titre ?? '…'} ({rows.length})</h2>
    {loading ? <Spinner /> : rows.length === 0 ? <div className="empty">Aucun élément sur la période.</div>
      : estCamions
        ? <Table cols={[['numeroCamion', 'Camion'], ['typeOperation', 'Opération'], ['statut', 'Statut'], ['numeroGps', 'N° GPS'], ['nbConteneurs', 'Nb cont.']]} rows={rows} onRow={(r) => ouvrir(r['id'])} />
        : <Table cols={[['conteneur', 'Conteneur'], ['taille', 'Taille'], ['type', 'Type'], ['scelle', 'Scellé'], ['numeroCamion', 'Camion'], ['cargaisonId', 'Cargaison']]} rows={rows} onRow={(r) => ouvrir(r['cargaisonId'] ?? r['id'])} />}
  </Modal>;
}

SCREENS.cfsreport = ({ go }) => <RapportCellule action="report.cfs" detail="report.cfsdetail" titre="Rapport CFS" camLabel="Camions" go={go} />;
SCREENS.baliserep = ({ go }) => <RapportCellule action="report.balise" detail="report.balisedetail" titre="Rapport Balise (pose balise)" twins camLabel="Camions balisés" go={go} />;
SCREENS.pprep = ({ go }) => <RapportCellule action="report.pp" detail="report.ppdetail" titre="Rapport Porte Principale (sorties)" camLabel="Camions sortis" go={go} />;

SCREENS.vehreport = () => {
  const p = useReportRange();
  const { m, du, au } = p;
  const { data, loading } = useAsync<O>(() => call('report.vehicule', { du, au, periode: m }), [du, au]);
  const cp = (data?.['compte'] ?? {}) as O; const pd = (data?.['parDest'] ?? {}) as O;
  return <div className="card"><div className="row" style={{ flexWrap: 'wrap' }}><h2 style={{ flex: 1 }}>Rapport véhicules</h2><PeriodPicker p={p} /></div><PeriodeLue p={p} />
    {loading ? <Spinner /> : <div className="stats">
      <StatCard n={Number(cp['total'] ?? 0)} l="Total" /><StatCard n={Number(cp['attente'] ?? 0)} l="En attente" /><StatCard n={Number(cp['sortis'] ?? 0)} l="Sortis" tone="ok" />
      {VEHICULE_DESTINATIONS.map((x) => <StatCard key={x} n={Number(pd[x] ?? 0)} l={x} />)}
    </div>}
  </div>;
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
      <div className="row" style={{ flexWrap: 'wrap' }}><h2 style={{ flex: 1 }}>Analyse des flux</h2><PeriodPicker p={p} /></div>
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
  const bloc = (titre: string, o: O, tone?: 'warn') => <div className="card"><h2>{titre}</h2><div className="stats">
    <StatCard n={Number(o['camions'] ?? 0)} l="Camions" tone={tone} />
    <StatCard n={Number(o['conteneurs'] ?? 0)} l="Conteneurs" tone={tone} />
  </div></div>;
  return <>
    <div className="card"><div className="row" style={{ flexWrap: 'wrap' }}><h2 style={{ flex: 1 }}>Statistiques de contrôle</h2><PeriodPicker p={p} /></div><PeriodeLue p={p} /></div>
    {loading ? <Spinner /> : <>
      {/* Trois blocs de cartes se lisent isolément mais ne se COMPARENT pas :
          on ne voit pas lequel pèse le plus, ni dans quelle proportion. */}
      <div className="card"><h2>Comparaison des motifs de contrôle</h2>
        <Graphique
          cats={['Hors gabarit', 'Surcharge', 'Transit national (TG)']}
          series={[
            { nom: 'Camions', valeurs: [Number(hg['camions'] ?? 0), Number(su['camions'] ?? 0), Number(tn['camions'] ?? 0)] },
            { nom: 'Conteneurs', valeurs: [Number(hg['conteneurs'] ?? 0), Number(su['conteneurs'] ?? 0), Number(tn['conteneurs'] ?? 0)] },
          ]}
          type="barres" ordonnee="Nombre" hauteur={250} valeursSurBarres /></div>
      {bloc('Hors gabarit', hg, 'warn')}
      {bloc('Surcharge', su, 'warn')}
      {bloc('Transit national (TG)', tn)}
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
      <div className="row" style={{ flexWrap: 'wrap' }}><h2 style={{ flex: 1 }}>Répartition des cargaisons par destination</h2><PeriodPicker p={p} /></div>
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
      <div className="row" style={{ flexWrap: 'wrap' }}><h2 style={{ flex: 1 }}>Temps de passage par poste</h2><PeriodPicker p={p} /></div>
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
const ROLES_LISTE = ['CFS', 'CHEF_BRIGADE', 'CHEF_BRIGADE_ADJOINT', 'CHEF_VISITE', 'CHEF_DIVISION', 'T1', 'BALISE', 'BON_SORTIE', 'PP', 'ADMIN'];
SCREENS.users = () => {
  const { data, loading, reload } = useAsync<O[]>(() => call('user.list'), []);
  const [form, setForm] = useState<O | null>(null);
  async function creer(f: O) {
    try { await call('user.create', f); toast('Compte créé.', 'ok'); setForm(null); reload(); }
    catch (e) { toast((e as Error).message, 'err'); }
  }
  return <div className="card"><div className="row"><h2 style={{ flex: 1 }}>Utilisateurs</h2>
    <button className="xs" onClick={() => setForm({ username: '', nomComplet: '', role: 'CFS', password: '' })}>+ Nouveau</button></div>
    {loading ? <Spinner /> : <Table cols={[['username', 'Identifiant'], ['nomComplet', 'Nom'], ['role', 'Rôle'], ['derniereConnexion', 'Dernière connexion']]}
      rows={data ?? []} onRow={async (u) => {
        const action = prompt(`Action pour ${u['username']} : 1=activer/désactiver, 2=réinit. mdp, 3=réinit. 2FA`);
        try {
          if (action === '1') { await call('user.toggle', { username: u['username'] }); }
          // SEC-03 : 12 caractères minimum, 3 familles. L'agent devra le
          // remplacer à sa prochaine connexion — ce mot de passe ne sert qu'à
          // lui rendre l'accès, il ne l'engage pas.
          else if (action === '2') { const p = prompt('Nouveau mot de passe provisoire — 12 caractères minimum, mêlant minuscules, majuscules, chiffres et/ou signes.\nÀ remettre en main propre : l\'agent devra le changer à sa prochaine connexion.'); if (p) await call('user.resetpwd', { username: u['username'], password: p }); }
          else if (action === '3') { await call('user.resetmfa', { username: u['username'] }); }
          else return; toast('Fait.', 'ok'); reload();
        } catch (e) { toast((e as Error).message, 'err'); }
      }} />}
    {form && <Modal onClose={() => setForm(null)}><h2>Nouveau compte</h2>
      <div className="grid2">
        <div><label className="help">Identifiant</label><input value={String(form['username'])} onChange={(e) => setForm({ ...form, username: e.target.value.toLowerCase() })} /></div>
        <div><label className="help">Nom complet</label><input value={String(form['nomComplet'])} onChange={(e) => setForm({ ...form, nomComplet: e.target.value })} /></div>
        <div><label className="help">Rôle</label><select value={String(form['role'])} onChange={(e) => setForm({ ...form, role: e.target.value })}>{ROLES_LISTE.map((r) => <option key={r}>{r}</option>)}</select></div>
        <div><label className="help">Mot de passe provisoire — 12 caractères minimum, 3 familles (minuscules, majuscules, chiffres, signes)</label>
          <input value={String(form['password'])} onChange={(e) => setForm({ ...form, password: e.target.value })} minLength={12} />
          <p className="help" style={{ marginTop: 4 }}>À remettre en main propre. L'agent devra le remplacer à sa première connexion.</p></div>
      </div>
      <div style={{ marginTop: 12 }}><button onClick={() => creer(form)}>Créer</button></div>
    </Modal>}
  </div>;
};

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

  return <div className="card">
    <div className="row" style={{ alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
      <h2 style={{ flex: 1, margin: 0 }}>Historique</h2>
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
  </div>;
};

SCREENS.account = ({ user }) => {
  const [anc, setAnc] = useState(''); const [nouv, setNouv] = useState('');
  async function changer() {
    try { await call('account.changepwd', { ancien: anc, nouveau: nouv }); toast('Mot de passe changé.', 'ok'); setAnc(''); setNouv(''); }
    catch (e) { toast((e as Error).message, 'err'); }
  }
  return <div className="card" style={{ maxWidth: 460 }}><h2>Mon compte</h2>
    <div className="kv"><b>Identifiant</b>{user.username}</div><div className="kv"><b>Nom</b>{user.nomComplet}</div><div className="kv"><b>Rôle</b>{user.role}</div>
    <div className="section-title">Changer mon mot de passe</div>
    <label className="help">Ancien</label><input type="password" value={anc} onChange={(e) => setAnc(e.target.value)} />
    <label className="help">Nouveau — 12 caractères minimum, 3 familles</label><input type="password" value={nouv} onChange={(e) => setNouv(e.target.value)} minLength={12} />
    <div style={{ marginTop: 12 }}><button onClick={changer} disabled={!anc || nouv.length < 6}>Changer</button></div>
  </div>;
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
