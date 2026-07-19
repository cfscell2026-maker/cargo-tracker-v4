/**
 * Registre de tous les écrans (reproduction de SCREENS v3.6).
 */
import { useState } from 'react';
import * as XLSX from 'xlsx';
import { call } from './lib/rpc.ts';
import { useAsync } from './lib/hooks.ts';
import { Spinner, StatCard, Tag, Modal, masks, toast, fmtDate, fmtJour, isoDate } from './lib/ui.tsx';
import { Detail } from './detail.tsx';
import type { Nav } from './App.tsx';
import { OPERATIONS, VEHICULE_DESTINATIONS, TYPES_DECLARATION, STATUTS, tcValide } from '../../../supabase/functions/_shared/domaine/src/index.ts';

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
function CargoList({ go, filtre, titre, barre }: Nav & { filtre: O; titre?: string; barre?: boolean }) {
  const [page, setPage] = useState(1);
  const [statut, setStatut] = useState(String(filtre['statut'] ?? 'tous'));
  const [search, setSearch] = useState('');
  const reset = () => setPage(1);
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

/* ------------------------------ Écrans --------------------------------- */
const SCREENS: Record<string, Screen> = {};

SCREENS.dash = (nav) => {
  const [m, setM] = useState<'jour' | 'semaine' | 'mois' | 'annee'>('semaine');
  function range(): [string, string] {
    const now = new Date();
    if (m === 'jour') return [isoDate(now), isoDate(now)];
    if (m === 'mois') return [isoDate(new Date(now.getFullYear(), now.getMonth(), 1)), isoDate(new Date(now.getFullYear(), now.getMonth() + 1, 0))];
    if (m === 'annee') return [isoDate(new Date(now.getFullYear(), 0, 1)), isoDate(new Date(now.getFullYear(), 11, 31))];
    const day = (now.getDay() + 6) % 7; const lundi = new Date(now); lundi.setDate(now.getDate() - day);
    const dim = new Date(lundi); dim.setDate(lundi.getDate() + 6); return [isoDate(lundi), isoDate(dim)];
  }
  const [du, au] = range();
  const { data, loading } = useAsync<O>(() => call('dashboard.stats', { du, au }), [du, au]);
  const s = data ?? {};
  const go = (statut: string) => nav.go('list', { statut });
  return <>
    <div className="card"><div className="row" style={{ alignItems: 'center' }}>
      <h2 style={{ flex: 1, margin: 0 }}>Tableau de bord</h2>
      <label className="help" style={{ margin: 0 }}>Période</label>
      <select value={m} onChange={(e) => setM(e.target.value as never)} style={{ maxWidth: 160 }}>
        <option value="jour">Journalier</option><option value="semaine">Hebdomadaire</option><option value="mois">Mensuel</option><option value="annee">Annuel</option>
      </select>
    </div><div className="help">Cargaisons créées du {du} au {au}</div></div>
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
  </>;
};

SCREENS.detail = (nav) => <Detail {...nav} />;
SCREENS.list = (nav) => <CargoList {...nav} filtre={{ categorie: 'camion', ...((nav.arg as O) ?? {}) }} titre="Cargaisons" barre />;
SCREENS.vehicules = (nav) => <CargoList {...nav} filtre={{ categorie: 'vehicule' }} titre="Véhicules" />;
SCREENS.completer = (nav) => <CargoList {...nav} filtre={{ etape: 'CFS' }} titre="À compléter (CFS)" />;
SCREENS.wait_valid = (nav) => <CargoList {...nav} filtre={{ etape: 'VALIDATION' }} titre="À valider" />;
SCREENS.wait_t1 = (nav) => <CargoList {...nav} filtre={{ etape: 'T1' }} titre="En attente T1" />;
SCREENS.wait_gps = (nav) => <CargoList {...nav} filtre={{ etape: 'BALISE' }} titre="En attente Balise" />;
SCREENS.wait_bs = (nav) => <CargoList {...nav} filtre={{ etape: 'BS' }} titre="En attente Bon de Sortie" />;
SCREENS.wait_sortie = (nav) => <CargoList {...nav} filtre={{ etape: 'PP' }} titre="En attente de sortie" />;
SCREENS.t1 = (nav) => <CargoList {...nav} filtre={{ etape: 'T1' }} titre="Cellule T1 — cargaisons en attente" />;
SCREENS.gps = (nav) => <CargoList {...nav} filtre={{ etape: 'BALISE' }} titre="Cellule Balise — cargaisons en attente" />;
SCREENS.bonsortie = (nav) => <CargoList {...nav} filtre={{ etape: 'BS' }} titre="Cellule Bon de Sortie — en attente" />;
SCREENS.sortie = (nav) => <CargoList {...nav} filtre={{ etape: 'PP' }} titre="Sortie — cargaisons prêtes" />;

/* --------------------------- Créer un camion --------------------------- */
SCREENS.creercamion = ({ go }) => {
  const [num, setNum] = useState('');
  const [routage, setRoutage] = useState(OPERATIONS.ENLEVEMENT as string);
  const [busy, setBusy] = useState(false);
  async function creer() {
    if (!num) { toast('N° camion requis.', 'err'); return; }
    setBusy(true);
    try {
      const r = await call<{ id: string }>('cargo.createcamion', { numeroCamion: num, routage });
      toast('Camion créé.', 'ok'); go('detail', r.id);
    } catch (e) { toast((e as Error).message, 'err'); } finally { setBusy(false); }
  }
  return <div className="card" style={{ maxWidth: 480 }}>
    <h2>Créer un camion à l'entrée</h2>
    <p className="help">Le CFS crée le camion vide et choisit le type d'opération ; l'association des conteneurs se fait ensuite dans le détail.</p>
    <label className="help">N° camion</label><input className="mono" value={num} onChange={(e) => setNum(masks.alnum(e.target.value))} />
    <label className="help">Type d'opération</label>
    <select value={routage} onChange={(e) => setRoutage(e.target.value)}><option>{OPERATIONS.ENLEVEMENT}</option><option>{OPERATIONS.DEPOTAGE}</option></select>
    <div style={{ marginTop: 12 }}><button disabled={busy} onClick={creer}>Créer</button></div>
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
      {String(d['typeDeclaration'] ?? 'T') === 'C' && <div><label className="help">Conso (type C) — balise</label>
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

/* ------------------------ Recherche (N° camion) ------------------------ */
SCREENS.search = ({ go }) => {
  const [q, setQ] = useState('');
  const { data, loading } = useAsync<O[]>(() => (q ? call('cargo.search', { valeur: q }) : Promise.resolve([])), [q]);
  return <div className="card">
    <label className="help">Rechercher un N° de camion</label>
    <input className="mono" value={q} onChange={(e) => setQ(e.target.value)} placeholder="ex. AB 12 CD" autoFocus />
    <div style={{ marginTop: 12 }}>
      {loading ? <Spinner /> : <Table cols={[['id', 'ID'], ['dateCreation', 'Date'], ['numeroCamion', 'Camion'], ['typeOperation', 'Opération'], ['statut', 'Statut']]} rows={data ?? []} onRow={(r) => go('detail', r['id'])} />}
    </div>
  </div>;
};

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
    <div><label className="help">Destination</label><input value={String(d['destinationMarchandise'] ?? '')} onChange={(e) => set('destinationMarchandise', masks.upper(e.target.value))} /></div>
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
  const [cams, setCams] = useState<CamEffets[]>([]);
  const set = (k: string, val: unknown) => setD((o) => ({ ...o, [k]: val }));
  const majVeh = (i: number, k: string, val: unknown) => setVs((a) => a.map((v, j) => (j === i ? { ...v, [k]: val } : v)));

  // v4 — le TC d'origine est OBLIGATOIRE et se choisit dans les TC POSITIONNÉS au CFS.
  const { data: stk, loading: stkLoading } = useAsync<{ rows: O[] }>(() => call('stock.list', { statut: 'Positionné' }), []);
  const tcs = ((stk?.rows ?? []) as O[]).map((r) => String(r['numeroTC'] ?? '')).filter(Boolean);

  const majCam = (i: number, patch: Partial<CamEffets>) => setCams((a) => a.map((c, j) => (j === i ? { ...c, ...patch } : c)));

  async function creer() {
    if (!origine) { toast("Le N° de conteneur d'origine (TC) est obligatoire.", 'err'); return; }
    try {
      const r = await call<{ vehicules: { id: string }[] }>('cargo.create', {
        typeOperation: OPERATIONS.VEHICULE, declaration: d, conteneurOrigine: origine, vehicules: vs,
        camions: cams.map((c) => ({ ...c, scellesCamion: c.scellesCamion.filter(Boolean) })),
      });
      toast('Véhicule créé.', 'ok'); go('detail', r.vehicules[0]?.id);
    } catch (e) { toast((e as Error).message, 'err'); }
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
        <select value={origine} onChange={(e) => setOrigine(e.target.value)} className="mono">
          <option value="">{stkLoading ? 'Chargement…' : tcs.length ? '— Choisir un TC positionné —' : '— Aucun TC positionné —'}</option>
          {tcs.map((t) => <option key={t}>{t}</option>)}
        </select>
        <div className="help">Conteneurs positionnés au CFS uniquement.</div>
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
  </div>;
}

/**
 * v4 — Conso/MAD « comme en dépotage » : le TYPE de la déclaration commande le
 * parcours. T = transit → T1 + Balise ; C = mise à la consommation → saute le
 * T1 et l'agent choisit balisée / non balisée (le choix ne s'affiche que pour C).
 */
function InfoTypeDecl({ d, mode, setMode }: { d: O; mode: string; setMode: (v: string) => void }) {
  const estConso = String(d['typeDeclaration'] ?? 'T') === 'C';
  return <>
    <p className="help" style={{ marginTop: 0 }}>
      {estConso
        ? <>Type C = mise à la consommation : la cargaison <b>saute le T1</b>{mode === 'sansbalise' ? ' et la Balise (dispense)' : ' ; balise à poser'}.</>
        : <>Type T = transit : la cargaison passe par le <b>T1</b> puis la <b>Balise</b>, comme un dépotage.</>}
    </p>
    {estConso && <div className="grid2">
      <div><label className="help">Conso (type C) — balise</label>
        <select value={mode} onChange={(e) => setMode(e.target.value)}><option value="balise">À baliser</option><option value="sansbalise">Non balisée (dispense)</option></select></div>
    </div>}
  </>;
}

function FormMagasin({ go }: { go: Nav['go'] }) {
  const [d, setD] = useState<O>({});
  const [num, setNum] = useState('');
  const [mode, setMode] = useState('balise');
  const set = (k: string, val: unknown) => setD((o) => ({ ...o, [k]: val }));
  async function creer() {
    try {
      const r = await call<{ camions: { id: string }[] }>('cargo.create', { typeOperation: OPERATIONS.MAGASIN, numeroCamion: num, consoMode: mode, declaration: d });
      toast('Sortie magasin créée.', 'ok'); go('detail', r.camions[0]?.id);
    } catch (e) { toast((e as Error).message, 'err'); }
  }
  return <div style={{ marginTop: 12 }}>
    <div className="section-title">Déclaration</div>
    <InfoTypeDecl d={d} mode={mode} setMode={setMode} />
    <DeclFields d={d} set={set} />
    <div className="section-title" style={{ marginTop: 14 }}>Camion</div>
    <div className="grid2"><div><label className="help">N° camion</label><input className="mono" value={num} onChange={(e) => setNum(masks.alnum(e.target.value))} /></div></div>
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
SCREENS.stockjour = () => <StockList statut="Positionné" titre="Stock CFS journalier (positionnés)" />;
function StockList({ statut, titre }: { statut: string; titre?: string }) {
  const { data, loading, error } = useAsync<{ rows: O[]; compte: O }>(() => call('stock.list', { statut }), [statut]);
  return <div className="card"><h2>{titre ?? 'Stock conteneurs'}</h2>
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

// v4 — chaque pointage propose les TC de la BONNE source à la frappe (datalist) :
// pointage matinal → stock « En stock » ; pointage PP → stock annoncé « Annoncé ».
SCREENS.pointage = () => <PointageTC action="stock.pointage" titre="Pointage matinal" desc="Positionne un conteneur pour le dépotage du jour." suggest={{ action: 'stock.list', statut: 'En stock' }} />;
SCREENS.magasin = () => <PointageTC action="stock.entreemagasin" titre="Entrée Magasin / MAD" desc="Marque un conteneur comme dépoté / sorti du yard." />;
SCREENS.pointentree = () => <PointageTC action="stockannonce.pointage" titre="Pointage entrée (stock annoncé)" desc="Pointe l'arrivée d'un conteneur annoncé (Porte Principale)." suggest={{ action: 'stockannonce.list', statut: 'Annoncé' }} />;
SCREENS.confentree = () => <ConfirmerEntree />;
function PointageTC({ action, titre, desc, suggest }: { action: string; titre: string; desc: string; suggest?: { action: string; statut: string } }) {
  const [tc, setTc] = useState('');
  const [msg, setMsg] = useState('');
  // Suggestions : liste des TC de la source (rechargée après chaque pointage).
  const { data: sug, reload: reloadSug } = useAsync<{ rows: O[] }>(
    () => suggest ? call(suggest.action, { statut: suggest.statut }) : Promise.resolve({ rows: [] }),
    [suggest?.action, suggest?.statut]);
  const options = ((sug?.rows ?? []) as O[]).map((r) => String(r['numeroTC'] ?? '')).filter(Boolean);
  const listId = 'dl-' + action.replace(/[^a-z0-9]/gi, '');
  async function go() {
    try { const r = await call<O>(action, { numeroTC: tc }); toast('Enregistré.', 'ok'); setMsg(JSON.stringify(r)); setTc(''); if (suggest) reloadSug(); }
    catch (e) { toast((e as Error).message, 'err'); }
  }
  return <div className="card" style={{ maxWidth: 480 }}><h2>{titre}</h2><p className="help">{desc}</p>
    <div className="row"><input className="mono" value={tc} onChange={(e) => setTc(masks.tc(e.target.value))} placeholder="N° conteneur" style={{ flex: 1 }} list={suggest ? listId : undefined} autoComplete="off" />
      <button onClick={go} disabled={!tc}>Valider</button></div>
    {suggest && <datalist id={listId}>{options.map((t) => <option key={t} value={t} />)}</datalist>}
    {suggest && <div className="help" style={{ marginTop: 6 }}>{options.length} conteneur(s) disponible(s) — commencez à taper pour choisir.</div>}
    {msg && <div className="help" style={{ marginTop: 8 }}>{msg}</div>}
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

SCREENS.import = () => <ImportExcel action="stock.import" titre="Stock initial — import" cols={['numeroTC', 'taille', 'dateEntree', 'anneeDeclaration', 'typeDeclaration', 'numeroDeclaration']} />;
SCREENS.importannonce = () => <ImportExcel action="stockannonce.import" titre="Annonce de transfert — import" cols={['numeroTC', 'taille', 'dateEntree', 'anneeDeclaration', 'bureauDeclaration', 'typeDeclaration', 'numeroDeclaration']} />;
function ImportExcel({ action, titre, cols }: { action: string; titre: string; cols: string[] }) {
  const [items, setItems] = useState<O[]>([]);
  const [res, setRes] = useState('');
  function lire(file: File) {
    const reader = new FileReader();
    reader.onload = (e) => {
      const wb = XLSX.read(e.target?.result, { type: 'binary', cellDates: true });
      const sheet = wb.Sheets[wb.SheetNames[0]!];
      const rows = (XLSX.utils.sheet_to_json(sheet!, { header: 1 }) as unknown[][]).slice(1);
      setItems(rows.filter((r) => r[0]).map((r) => Object.fromEntries(cols.map((c, i) => [c, r[i] ?? '']))));
    };
    reader.readAsBinaryString(file);
  }
  async function importer() {
    try { const r = await call<O>(action, { items }); setRes(`${r['ajoutes']} ajouté(s), ${r['maj']} mis à jour, ${r['ignores']} ignoré(s).`); toast('Import terminé.', 'ok'); }
    catch (e) { toast((e as Error).message, 'err'); }
  }
  return <div className="card"><h2>{titre}</h2>
    <p className="help">Colonnes attendues (dans l'ordre) : {cols.join(', ')}. Première ligne = entêtes.</p>
    <input type="file" accept=".xlsx,.xls,.csv" onChange={(e) => e.target.files?.[0] && lire(e.target.files[0])} />
    {items.length > 0 && <><div className="help" style={{ marginTop: 8 }}>{items.length} ligne(s) prêtes.</div>
      <div style={{ marginTop: 10 }}><button onClick={importer}>Importer {items.length} ligne(s)</button></div></>}
    {res && <div className="help" style={{ marginTop: 8 }}>{res}</div>}
  </div>;
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
  return <div style={{ border: '1px solid var(--line)', borderRadius: 6, padding: 10, marginBottom: 8 }}>
    <div className="row" style={{ alignItems: 'center', gap: 8 }}>
      <b className="mono">{String(r['numeroCamion'])}</b>
      <span className="help">{String(r['id'])} · {String(r['typeOperation'])}</span>
      {Boolean(r['chargementMixte']) && <span className="help" style={{ color: 'var(--warn)' }}>⚠ chargement mixte</span>}
    </div>
    <div className="help">Date {fmtDate(r['dateCreation'])} · Agent CFS {String(r['agentCfs'] || '—')} · Destination {String(r['destinationMarchandise'] || '—')}{r['nbColis'] ? ` · ${String(r['nbColis'])} colis` : ''}</div>
    {v && <div className="help">Châssis {String(v['chassis'] ?? '')} · {String(v['marque'] ?? '')} {String(v['modele'] ?? '')} · {String(v['destination'] ?? '')}{r['conteneurOrigine'] ? ` · TC origine ${String(r['conteneurOrigine'])}` : ''}</div>}
    {sc.length > 0 && <div className="help">Scellés camion : {sc.join(' · ')}</div>}
    {/* v4 — camion d'effets divers : pas de conteneur propre, une désignation. */}
    {!conts.length && !v && r['descriptionMarchandise'] ? <div className="help">Effets divers : {String(r['descriptionMarchandise'])}</div> : null}
    {conts.length > 0 && <Table cols={[['num', 'Conteneur'], ['plomb', 'Scellé'], ['taille', 'Taille'], ['type', 'Type']]} rows={conts} />}
  </div>;
}

/* ------------------------------ Rapports ------------------------------- */
function useReportRange() {
  const [m, setM] = useState<'jour' | 'semaine' | 'mois'>('semaine');
  const now = new Date();
  let du = isoDate(now), au = isoDate(now);
  if (m === 'mois') { du = isoDate(new Date(now.getFullYear(), now.getMonth(), 1)); au = isoDate(new Date(now.getFullYear(), now.getMonth() + 1, 0)); }
  else if (m === 'semaine') { const d = (now.getDay() + 6) % 7; const l = new Date(now); l.setDate(now.getDate() - d); const s = new Date(l); s.setDate(l.getDate() + 6); du = isoDate(l); au = isoDate(s); }
  return { m, setM, du, au };
}
function PeriodPicker({ m, setM }: { m: string; setM: (v: never) => void }) {
  return <select value={m} onChange={(e) => setM(e.target.value as never)} style={{ maxWidth: 180 }}>
    <option value="jour">Journalier</option><option value="semaine">Hebdomadaire</option><option value="mois">Mensuel</option></select>;
}

function ReportCFS({ action, titre }: { action: string; titre: string }) {
  const { m, setM, du, au } = useReportRange();
  const { data, loading } = useAsync<O>(() => call(action, { du, au, periode: m }), [du, au]);
  const parOp = (data?.['parOp'] ?? {}) as Record<string, O>;
  const total = (data?.['total'] ?? {}) as O;
  async function exporter() { const f = await call<O>(action, { du, au, periode: m, format: 'xlsx' }); telecharger(f); }
  return <div className="card"><div className="row"><h2 style={{ flex: 1 }}>{titre}</h2><PeriodPicker m={m} setM={setM} /><button className="ghost xs" onClick={exporter}>Export Excel</button></div>
    <div className="help">Du {du} au {au}</div>
    {loading ? <Spinner /> : <div className="tbl" style={{ marginTop: 10 }}><table>
      <thead><tr><th>Opération</th><th>Camions</th><th>20'</th><th>40'</th><th>45'</th><th>Conteneurs</th><th>EVP</th></tr></thead>
      <tbody>{[OPERATIONS.ENLEVEMENT, OPERATIONS.DEPOTAGE].map((op) => { const a = parOp[op] ?? {}; return (
        <tr key={op}><td>{op}</td><td>{Number(a['camions'] ?? 0)}</td><td>{Number(a['t20'] ?? 0)}</td><td>{Number(a['t40'] ?? 0)}</td><td>{Number(a['t45'] ?? 0)}</td><td>{Number(a['conteneurs'] ?? 0)}</td><td>{Number(a['evp'] ?? 0)}</td></tr>
      ); })}
        <tr style={{ fontWeight: 700 }}><td>TOTAL</td><td>{Number(total['camions'] ?? 0)}</td><td>{Number(total['t20'] ?? 0)}</td><td>{Number(total['t40'] ?? 0)}</td><td>{Number(total['t45'] ?? 0)}</td><td>{Number(total['conteneurs'] ?? 0)}</td><td>{Number(total['evp'] ?? 0)}</td></tr>
      </tbody></table></div>}
  </div>;
}
SCREENS.cfsreport = () => <ReportCFS action="report.cfs" titre="Rapport CFS" />;
SCREENS.baliserep = () => <ReportActivite action="report.balise" titre="Rapport Balise" />;
SCREENS.pprep = () => <ReportActivite action="report.pp" titre="Rapport Porte Principale" />;
function ReportActivite({ action, titre }: { action: string; titre: string }) {
  const { m, setM, du, au } = useReportRange();
  const { data, loading } = useAsync<O>(() => call(action, { du, au, periode: m }), [du, au]);
  const parOp = (data?.['parOp'] ?? {}) as Record<string, O>;
  return <div className="card"><div className="row"><h2 style={{ flex: 1 }}>{titre}</h2><PeriodPicker m={m} setM={setM} /></div><div className="help">Du {du} au {au}</div>
    {loading ? <Spinner /> : <div className="tbl" style={{ marginTop: 10 }}><table>
      <thead><tr><th>Opération</th><th>Camions</th><th>Twins</th><th>Sans balise</th><th>Conteneurs</th><th>EVP</th></tr></thead>
      <tbody>{[OPERATIONS.ENLEVEMENT, OPERATIONS.DEPOTAGE].map((op) => { const a = parOp[op] ?? {}; return (
        <tr key={op}><td>{op}</td><td>{Number(a['camions'] ?? 0)}</td><td>{Number(a['twins'] ?? 0)}</td><td>{Number(a['sansBalise'] ?? 0)}</td><td>{Number(a['conteneurs'] ?? 0)}</td><td>{Number(a['evp'] ?? 0)}</td></tr>
      ); })}</tbody></table></div>}
  </div>;
}

SCREENS.vehreport = () => {
  const { m, setM, du, au } = useReportRange();
  const { data, loading } = useAsync<O>(() => call('report.vehicule', { du, au, periode: m }), [du, au]);
  const cp = (data?.['compte'] ?? {}) as O; const pd = (data?.['parDest'] ?? {}) as O;
  return <div className="card"><div className="row"><h2 style={{ flex: 1 }}>Rapport véhicules</h2><PeriodPicker m={m} setM={setM} /></div>
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

SCREENS.flux = () => {
  const [gran, setGran] = useState('jour');
  const { data, loading } = useAsync<{ rows: O[] }>(() => call('report.flux', { granularite: gran }), [gran]);
  return <div className="card"><div className="row"><h2 style={{ flex: 1 }}>Analyse des flux</h2>
    <select value={gran} onChange={(e) => setGran(e.target.value)} style={{ maxWidth: 160 }}><option value="jour">Journalier</option><option value="semaine">Hebdomadaire</option><option value="mois">Mensuel</option></select></div>
    {loading ? <Spinner /> : <Table cols={[['periode', 'Période'], ['cfsC', 'CFS'], ['baliseC', 'Balise'], ['ppC', 'PP'], ['sansBalise', 'Sans balise']]} rows={data?.rows ?? []} />}
  </div>;
};

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
          else if (action === '2') { const p = prompt('Nouveau mot de passe (min 6)'); if (p) await call('user.resetpwd', { username: u['username'], password: p }); }
          else if (action === '3') { await call('user.resetmfa', { username: u['username'] }); }
          else return; toast('Fait.', 'ok'); reload();
        } catch (e) { toast((e as Error).message, 'err'); }
      }} />}
    {form && <Modal onClose={() => setForm(null)}><h2>Nouveau compte</h2>
      <div className="grid2">
        <div><label className="help">Identifiant</label><input value={String(form['username'])} onChange={(e) => setForm({ ...form, username: e.target.value.toLowerCase() })} /></div>
        <div><label className="help">Nom complet</label><input value={String(form['nomComplet'])} onChange={(e) => setForm({ ...form, nomComplet: e.target.value })} /></div>
        <div><label className="help">Rôle</label><select value={String(form['role'])} onChange={(e) => setForm({ ...form, role: e.target.value })}>{ROLES_LISTE.map((r) => <option key={r}>{r}</option>)}</select></div>
        <div><label className="help">Mot de passe provisoire</label><input value={String(form['password'])} onChange={(e) => setForm({ ...form, password: e.target.value })} /></div>
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

  // Bornes de dates selon la période choisie.
  const now = new Date();
  let du = '', au = '';
  if (m === 'perso') { du = duP; au = auP; }
  else if (m === 'jour') { du = au = isoDate(now); }
  else if (m === 'semaine') { const d = (now.getDay() + 6) % 7; const l = new Date(now); l.setDate(now.getDate() - d); const s = new Date(l); s.setDate(l.getDate() + 6); du = isoDate(l); au = isoDate(s); }
  else if (m === 'mois') { du = isoDate(new Date(now.getFullYear(), now.getMonth(), 1)); au = isoDate(new Date(now.getFullYear(), now.getMonth() + 1, 0)); }
  else if (m === 'annee') { du = isoDate(new Date(now.getFullYear(), 0, 1)); au = isoDate(new Date(now.getFullYear(), 11, 31)); }
  // m === 'tout' → du/au vides → aucune contrainte de date.

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
    <label className="help">Nouveau (min 6)</label><input type="password" value={nouv} onChange={(e) => setNouv(e.target.value)} />
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
