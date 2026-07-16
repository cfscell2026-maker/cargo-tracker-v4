/**
 * Détail d'une cargaison : timeline des 5 cellules + panneaux d'action
 * conditionnels (rôle × étape en attente), reproduction de renderDetail (v3.6).
 */
import { useState } from 'react';
import { call } from './lib/rpc.ts';
import { useAsync } from './lib/hooks.ts';
import { Spinner, Tag, masks, toast, fmtDate } from './lib/ui.tsx';
import type { Nav } from './App.tsx';
import {
  STATUTS, OPERATIONS, ROLES, TYPES_DECLARATION, ETATS_SORTIE,
  etapesEnAttente, estOui, tcValide, parseConteneursDetails,
} from '../../../supabase/functions/_shared/domaine/src/index.ts';

type O = Record<string, unknown>;
const A = ROLES.ADMIN;

export function Detail({ user, arg, go }: Nav) {
  const id = String(arg ?? '');
  const { data: c, loading, error, reload } = useAsync<O>(() => call('cargo.get', { id }), [id]);
  if (loading) return <Spinner />;
  if (error) return <div className="card err-msg">{error}</div>;
  if (!c) return <div className="card">Introuvable.</div>;

  const pend = etapesEnAttente(c as never);
  const role = user.role;
  const can = (...roles: string[]) => roles.includes(role);
  const dets = parseConteneursDetails(c['conteneursDetails']);
  const estVeh = estOui(c['estVehicule']);

  async function action(fn: () => Promise<unknown>, ok: string) {
    try { await fn(); toast(ok, 'ok'); reload(); } catch (e) { toast((e as Error).message, 'err'); }
  }

  return (
    <div>
      <button className="ghost" onClick={() => go('list')}>← Retour</button>
      <div className="card" style={{ marginTop: 10 }}>
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h2 style={{ margin: 0 }}>{c['numeroCamion'] as string} <span className="mono" style={{ color: '#5c6b7a', fontSize: 13 }}>{c['id'] as string}</span></h2>
          <Tag statut={c['statut'] as string} o={c} />
        </div>
        <div className="kv"><b>Opération</b>{c['typeOperation'] as string}</div>
        <div className="kv"><b>Déclarant</b>{(c['declarant'] as string) || '—'}</div>
        <div className="kv"><b>Déclaration</b>{[c['numeroDeclaration'], c['anneeDeclaration'], c['bureauDeclaration'], c['typeDeclaration']].filter(Boolean).join(' · ') || '—'}</div>
        <div className="kv"><b>Destination</b>{(c['destinationMarchandise'] as string) || '—'}</div>
        {c['nbColis'] ? <div className="kv"><b>Nombre de colis</b>{c['nbColis'] as string}</div> : null}
        {'horsGabarit' in c ? <div className="kv"><b>Hors gabarit</b>{estOui(c['horsGabarit']) ? `Oui (${(c['hauteurChargement'] as string) || '?'} m)` : 'Non'}</div> : null}
      </div>

      <Timeline c={c} />

      {dets.conteneurs.length > 0 && (
        <div className="card">
          <h2>Conteneurs ({dets.conteneurs.length})</h2>
          <div className="tbl"><table><thead><tr><th>#</th><th>Conteneur</th><th>Scellé</th><th>Taille</th><th>Type</th></tr></thead>
            <tbody>{dets.conteneurs.map((ct, i) => (
              <tr key={i}><td>{i + 1}</td><td className="mono">{ct.num}</td><td>{ct.plomb || (dets.scellesCamion[i] ?? '')}</td><td>{ct.taille}</td><td>{ct.type}</td></tr>
            ))}</tbody></table></div>
          {c['typeOperation'] === OPERATIONS.DEPOTAGE && dets.scellesCamion.length > 0 &&
            <div className="kv" style={{ marginTop: 8 }}><b>Scellés camion</b>{dets.scellesCamion.join(', ')}</div>}
        </div>
      )}

      {/* Panneaux d'action selon rôle × étape */}
      {(c['statut'] === STATUTS.CAMION || c['statut'] === STATUTS.CHARGEMENT) && can(ROLES.CFS, A) &&
        <PanneauCFS c={c} dets={dets} action={action} />}
      {c['statut'] === STATUTS.VEHICULE_OUILLAGE && can(ROLES.CFS, A) && <PanneauOuillage c={c} action={action} />}
      {pend.includes('VALIDATION') && can(ROLES.CHEF_BRIGADE, A) && <PanneauValidation c={c} action={action} />}
      {pend.includes('T1') && can(ROLES.T1, A) && <PanneauT1 c={c} dets={dets} action={action} />}
      {pend.includes('BALISE') && can(ROLES.BALISE, A) && !estVeh && <PanneauBalise c={c} action={action} />}
      {pend.includes('BS') && can(ROLES.BON_SORTIE, A) && <PanneauBS c={c} dets={dets} action={action} />}
      {pend.includes('PP') && can(ROLES.PP, A) && <PanneauPP c={c} estVeh={estVeh} action={action} />}
      {c['statut'] === STATUTS.GPS && role === A && <PanneauGpsEdit c={c} action={action} />}
      {c['statut'] === STATUTS.SORTIE && (String(c['baliseRequise']) === 'Non' || estOui(c['sauteBalise'])) && !estOui(c['arriveeBureau']) && can(ROLES.BALISE, A) &&
        <div className="card"><h2>Dispense — arrivée au bureau</h2>
          <button onClick={() => action(() => call('cargo.arriveebureau', { id }), 'Arrivée confirmée.')}>Confirmer l'arrivée (solder la dispense)</button></div>}
      {!estVeh && c['statut'] !== STATUTS.SORTIE && can(ROLES.CFS, A) && <PanneauEtatCFS c={c} action={action} />}

      <PanneauEditCamion c={c} action={action} />
    </div>
  );
}

function Timeline({ c }: { c: O }) {
  const e = {
    cfs: c['statut'] !== STATUTS.CAMION && c['statut'] !== STATUTS.CHARGEMENT && c['statut'] !== STATUTS.VEHICULE_OUILLAGE,
    valide: !!c['dateValidation'], t1: estOui(c['sauteT1']) || !!c['dateT1'],
    balise: estOui(c['sauteBalise']) || estOui(c['estVehicule']) || !!c['datePoseGps'],
    bs: estOui(c['sauteBS']) || !!c['bonSortieNumero'], pp: c['statut'] === STATUTS.SORTIE,
  };
  const steps: [boolean, string, string][] = [
    [e.cfs, 'CFS — chargement', c['agentCfs'] ? `${c['agentCfs']}` : ''],
    [e.valide, 'Validation chef brigade', c['agentValidation'] ? `${c['agentValidation']} · ${fmtDate(c['dateValidation'])}` : ''],
    [e.t1, estOui(c['sauteT1']) ? 'T1 (sauté)' : 'T1', c['agentT1'] ? `${c['agentT1']} · ${fmtDate(c['dateT1'])}` : ''],
    [e.balise, estOui(c['estVehicule']) || estOui(c['sauteBalise']) ? 'Balise (sautée)' : (c['numeroGps'] ? 'Balisé' : 'Balise/Dispense'), c['datePoseGps'] ? `${c['agentBalise']} · ${fmtDate(c['datePoseGps'])}` : ''],
    [e.bs, estOui(c['sauteBS']) ? 'Bon de sortie (sauté)' : 'Bon de sortie', c['dateBonSortie'] ? `${c['agentBonSortie']} · ${fmtDate(c['dateBonSortie'])}` : ''],
    [e.pp, 'Sortie (PP)', c['dateSortie'] ? `${c['agentPp']} · ${fmtDate(c['dateSortie'])}` : ''],
  ];
  return <div className="card"><h2>Parcours</h2><div className="timeline">
    {steps.map(([done, t, d], i) => (
      <div key={i} className={`tl ${done ? 'done' : 'wait'}`}>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
          <div className="dot">{done ? '✓' : i + 1}</div>{i < steps.length - 1 && <div className="bar" />}
        </div>
        <div className="body"><div className="t">{t}</div>{d && <div className="d">{d}</div>}</div>
      </div>
    ))}
  </div></div>;
}

/* ------------------------------ Panneaux ------------------------------- */
type ActionFn = (fn: () => Promise<unknown>, ok: string) => Promise<void>;

function Champ({ label, ...p }: { label: string } & React.InputHTMLAttributes<HTMLInputElement>) {
  return <div><label className="help">{label}</label><input {...p} /></div>;
}

function PanneauCFS({ c, dets, action }: { c: O; dets: ReturnType<typeof parseConteneursDetails>; action: ActionFn }) {
  const id = c['id'] as string;
  const estEnl = c['typeOperation'] === OPERATIONS.ENLEVEMENT;
  const premier = c['statut'] === STATUTS.CAMION;
  const [f, setF] = useState<O>({ num: '', taille: '', type: '', poids: '', plomb: '', manuel: false });
  const [d, setD] = useState<O>({ declarant: '', contactDeclarant: '', destinationMarchandise: '', bureauDeclaration: 'TG120', typeDeclaration: 'T', numeroDeclaration: '', anneeDeclaration: String(new Date().getFullYear()), descriptionMarchandise: '', nombreConteneurs: '', dateDeclaration: '' });
  const [consoMode, setConsoMode] = useState('balise'); // type C : balisée / non balisée (dispense)
  const set = (k: string, v: unknown) => setF((o) => ({ ...o, [k]: v }));
  const setDd = (k: string, v: unknown) => setD((o) => ({ ...o, [k]: v }));
  const montrerDecl = premier || !estEnl; // enlèvement 1er conteneur / dépotage : chaque conteneur
  const estConso = String(d['typeDeclaration']) === 'C'; // mise à la consommation → saute le T1

  async function ajouter() {
    if (!tcValide(String(f['num']))) { toast('N° conteneur invalide (4 lettres + 7 chiffres).', 'err'); return; }
    const payload: O = { id, conteneur: { num: f['num'], taille: f['taille'], type: f['type'], poids: f['poids'], plomb: f['plomb'], manuel: f['manuel'] } };
    if (montrerDecl && String(d['declarant']).trim()) { payload['declaration'] = d; if (estConso) payload['consoMode'] = consoMode; }
    await action(() => call('cargo.cfs', payload), 'Conteneur ajouté.');
    set('num', ''); set('plomb', ''); set('taille', ''); set('type', '');
  }

  return (
    <div className="card">
      <h2>CFS — associer / ajouter un conteneur</h2>
      <p style={{ color: '#5c6b7a', marginTop: 0 }}>Opération : <b>{c['typeOperation'] as string}</b>. {estEnl ? 'Enlèvement : scellé par conteneur, déclaration au 1er.' : 'Dépotage : conteneurs du stock (Positionné), déclaration par conteneur, puis scellés camion.'}</p>
      <div className="grid2">
        <Champ label="N° conteneur (ISO 6346)" className="mono" value={String(f['num'])} onChange={(e) => set('num', masks.tc(e.target.value))} />
        <Champ label="Taille" value={String(f['taille'])} onChange={(e) => set('taille', masks.upper(e.target.value))} placeholder="20' / 40' / 45'" />
        <Champ label="Type (facultatif)" value={String(f['type'])} onChange={(e) => set('type', masks.upper(e.target.value))} />
        {estEnl && <Champ label="Scellé / Plomb" value={String(f['plomb'])} onChange={(e) => set('plomb', masks.upper(e.target.value))} />}
        {!estEnl && <label className="help" style={{ alignSelf: 'end' }}><input type="checkbox" style={{ width: 'auto' }} checked={!!f['manuel']} onChange={(e) => set('manuel', e.target.checked)} /> Saisie manuelle (conteneur partagé)</label>}
      </div>
      {montrerDecl && (
        <>
          <div className="section-title">Déclaration</div>
          {estConso && <p className="help" style={{ marginTop: 0 }}>Type C = mise à la consommation : la cargaison <b>saute le T1</b>{consoMode === 'sansbalise' ? ' et la Balise (dispense)' : ' ; balise à poser'}.</p>}
          <div className="grid2">
            <Champ label="Déclarant" value={String(d['declarant'])} onChange={(e) => setDd('declarant', masks.upper(e.target.value))} />
            <Champ label="Contact (téléphone)" value={String(d['contactDeclarant'])} onChange={(e) => setDd('contactDeclarant', masks.tel(e.target.value))} />
            <Champ label="Destination" value={String(d['destinationMarchandise'])} onChange={(e) => setDd('destinationMarchandise', masks.upper(e.target.value))} />
            <Champ label="Bureau" value={String(d['bureauDeclaration'])} onChange={(e) => setDd('bureauDeclaration', masks.upper(e.target.value))} />
            <div><label className="help">Type déclaration</label><select value={String(d['typeDeclaration'])} onChange={(e) => setDd('typeDeclaration', e.target.value)}>{TYPES_DECLARATION.map((t) => <option key={t}>{t}</option>)}</select></div>
            {estConso && <div><label className="help">Conso (type C) — balise</label><select value={consoMode} onChange={(e) => setConsoMode(e.target.value)}><option value="balise">À baliser</option><option value="sansbalise">Non balisée (dispense)</option></select></div>}
            <Champ label="N° déclaration" value={String(d['numeroDeclaration'])} onChange={(e) => setDd('numeroDeclaration', masks.upper(e.target.value))} />
            <Champ label="Année" value={String(d['anneeDeclaration'])} onChange={(e) => setDd('anneeDeclaration', e.target.value)} />
            {/* v4 — date en douane, imprimée sur l'ordre d'exécution (exigée si nouvelle déclaration). */}
            <Champ label="Date de la déclaration (si nouvelle)" type="date" value={String(d['dateDeclaration'] ?? '')} onChange={(e) => setDd('dateDeclaration', e.target.value)} />
            <Champ label="Nb conteneurs déclarés (si nouvelle)" type="number" value={String(d['nombreConteneurs'])} onChange={(e) => setDd('nombreConteneurs', e.target.value)} />
            <Champ label="Description marchandise" value={String(d['descriptionMarchandise'])} onChange={(e) => setDd('descriptionMarchandise', masks.upper(e.target.value))} />
          </div>
        </>
      )}
      <div style={{ marginTop: 12 }}><button onClick={ajouter}>Ajouter le conteneur</button></div>

      {!estEnl && c['statut'] === STATUTS.CHARGEMENT && dets.conteneurs.length > 0 && <FinaliserDepotage id={id} action={action} />}
    </div>
  );
}

function FinaliserDepotage({ id, action }: { id: string; action: ActionFn }) {
  const [hauteur, setHauteur] = useState('');
  const [colis, setColis] = useState('');
  const [sc, setSc] = useState(['', '', '']);
  return <div style={{ borderTop: '1px solid var(--line)', marginTop: 14, paddingTop: 12 }}>
    <div className="section-title">Finaliser le dépotage (hauteur + colis + scellés camion)</div>
    <div className="grid2">
      <Champ label="Hauteur chargement (m) — hors gabarit auto si > 4,5" value={hauteur} onChange={(e) => setHauteur(e.target.value)} />
      <Champ label="Nombre de colis" value={colis} onChange={(e) => setColis(e.target.value)} />
      {[0, 1, 2].map((i) => <Champ key={i} label={`Scellé camion ${i + 1}${i < 2 ? ' *' : ''}`} value={sc[i]} onChange={(e) => setSc((a) => a.map((x, j) => j === i ? masks.upper(e.target.value) : x))} />)}
    </div>
    <div style={{ marginTop: 12 }}><button onClick={() => action(() => call('cargo.declaration', { id, hauteurChargement: hauteur, nbColis: colis, scellesCamion: sc.filter(Boolean) }), 'Dépotage finalisé.')}>Finaliser → « Créée »</button></div>
  </div>;
}

function PanneauOuillage({ c, action }: { c: O; action: ActionFn }) {
  const id = c['id'] as string;
  const [d, setD] = useState<O>({ declarant: '', contactDeclarant: '', destinationMarchandise: '', bureauDeclaration: 'TG120', typeDeclaration: 'T', numeroDeclaration: '', anneeDeclaration: String(new Date().getFullYear()) });
  const setDd = (k: string, v: unknown) => setD((o) => ({ ...o, [k]: v }));
  return <div className="card"><h2>Ouillage — compléter la déclaration du véhicule</h2>
    <div className="grid2">
      <Champ label="Déclarant" value={String(d['declarant'])} onChange={(e) => setDd('declarant', masks.upper(e.target.value))} />
      <Champ label="Contact" value={String(d['contactDeclarant'])} onChange={(e) => setDd('contactDeclarant', masks.tel(e.target.value))} />
      <Champ label="Destination" value={String(d['destinationMarchandise'])} onChange={(e) => setDd('destinationMarchandise', masks.upper(e.target.value))} />
      <Champ label="Bureau" value={String(d['bureauDeclaration'])} onChange={(e) => setDd('bureauDeclaration', masks.upper(e.target.value))} />
      <div><label className="help">Type (T = Transit → T1)</label><select value={String(d['typeDeclaration'])} onChange={(e) => setDd('typeDeclaration', e.target.value)}>{TYPES_DECLARATION.map((t) => <option key={t}>{t}</option>)}</select></div>
      <Champ label="N° déclaration" value={String(d['numeroDeclaration'])} onChange={(e) => setDd('numeroDeclaration', masks.upper(e.target.value))} />
      <Champ label="Année" value={String(d['anneeDeclaration'])} onChange={(e) => setDd('anneeDeclaration', e.target.value)} />
    </div>
    <div style={{ marginTop: 12 }}><button onClick={() => action(() => call('cargo.ouillagedecl', { id, declaration: d }), 'Déclaration enregistrée.')}>Enregistrer</button></div>
  </div>;
}

function PanneauValidation({ c, action }: { c: O; action: ActionFn }) {
  const id = c['id'] as string;
  const horsGab = estOui(c['horsGabarit']);
  return <div className="card"><h2>Validation — chef brigade</h2>
    {horsGab && <p style={{ background: 'var(--warn-soft)', color: 'var(--warn)', padding: 10, borderRadius: 6 }}>⚠ Chargement <b>hors gabarit</b> ({(c['hauteurChargement'] as string) || '?'} m).</p>}
    <p style={{ color: '#5c6b7a' }}>Votre validation (signature numérique) débloque les cellules T1 / Balise / Bon de sortie.</p>
    <button onClick={() => action(() => call('cargo.valider', { id }), 'Cargaison validée et signée.')}>Valider et signer</button>
  </div>;
}

function PanneauT1({ c, dets, action }: { c: O; dets: ReturnType<typeof parseConteneursDetails>; action: ActionFn }) {
  const id = c['id'] as string;
  const estEnl = c['typeOperation'] === OPERATIONS.ENLEVEMENT;
  const [bureau, setBureau] = useState((c['bureauDestination'] as string) || '');
  const [nums, setNums] = useState<string[]>(estEnl ? dets.conteneurs.map(() => '') : ['']);
  async function valider() {
    const t1Numeros = estEnl
      ? dets.conteneurs.map((ct, i) => ({ conteneur: ct.num, numero: nums[i] })).filter((x) => x.numero)
      : nums.filter(Boolean);
    await action(() => call('cargo.t1', { id, bureauDestination: bureau, t1Numeros }), 'T1 enregistré.');
  }
  return <div className="card"><h2>Cellule T1</h2>
    <Champ label="Bureau de destination" value={bureau} onChange={(e) => setBureau(masks.upper(e.target.value))} />
    <div className="section-title">Numéros T1 {estEnl ? '(1 par conteneur)' : '(1 ou plusieurs)'}</div>
    {estEnl ? dets.conteneurs.map((ct, i) => (
      <div key={i} className="row" style={{ marginBottom: 6 }}><span className="mono" style={{ minWidth: 130 }}>{ct.num}</span>
        <input value={nums[i]} onChange={(e) => setNums((a) => a.map((x, j) => j === i ? masks.upper(e.target.value) : x))} placeholder="N° T1" /></div>
    )) : <input value={nums[0]} onChange={(e) => setNums([masks.upper(e.target.value)])} placeholder="N° T1" />}
    <div style={{ marginTop: 12 }}><button onClick={valider}>Enregistrer le T1</button></div>
  </div>;
}

function PanneauBalise({ c, action }: { c: O; action: ActionFn }) {
  const id = c['id'] as string;
  const [requise, setRequise] = useState(true);
  const [t1ok, setT1ok] = useState(false);
  const [gps, setGps] = useState('');
  const [disp, setDisp] = useState('');
  return <div className="card"><h2>Cellule Balise</h2>
    <label className="help"><input type="checkbox" style={{ width: 'auto' }} checked={t1ok} onChange={(e) => setT1ok(e.target.checked)} /> Numéro T1 correct</label>
    <div className="row" style={{ margin: '8px 0' }}>
      <label className="help"><input type="radio" style={{ width: 'auto' }} checked={requise} onChange={() => setRequise(true)} /> Pose balise</label>
      <label className="help"><input type="radio" style={{ width: 'auto' }} checked={!requise} onChange={() => setRequise(false)} /> Dispense</label>
    </div>
    {requise ? <Champ label="N° balise GPS" value={gps} onChange={(e) => setGps(e.target.value)} />
      : <Champ label="N° autorisation de dispense" value={disp} onChange={(e) => setDisp(masks.upper(e.target.value))} />}
    <div style={{ marginTop: 12 }}><button onClick={() => action(() => call('cargo.gps', { id, baliseRequise: requise ? 'Oui' : 'Non', t1Correct: t1ok ? 'Oui' : 'Non', numeroGPS: gps, numeroDispense: disp }), requise ? 'Balise posée.' : 'Dispense enregistrée.')}>Valider la balise</button></div>
  </div>;
}

function PanneauBS({ c, dets, action }: { c: O; dets: ReturnType<typeof parseConteneursDetails>; action: ActionFn }) {
  const id = c['id'] as string;
  const estEnl = c['typeOperation'] === OPERATIONS.ENLEVEMENT;
  const [nums, setNums] = useState<string[]>(estEnl ? dets.conteneurs.map(() => '') : ['']);
  async function valider() {
    const bonSortieNumero = estEnl
      ? dets.conteneurs.map((ct, i) => ({ conteneur: ct.num, numero: nums[i] })).filter((x) => x.numero)
      : nums[0];
    await action(() => call('cargo.bonsortie', { id, bonSortieNumero }), 'Bon de sortie émis.');
  }
  return <div className="card"><h2>Cellule Bon de Sortie</h2>
    {estEnl ? dets.conteneurs.map((ct, i) => (
      <div key={i} className="row" style={{ marginBottom: 6 }}><span className="mono" style={{ minWidth: 130 }}>{ct.num}</span>
        <input value={nums[i]} onChange={(e) => setNums((a) => a.map((x, j) => j === i ? masks.upper(e.target.value) : x))} placeholder="N° bon de sortie" /></div>
    )) : <Champ label="N° bon de sortie" value={nums[0]} onChange={(e) => setNums([masks.upper(e.target.value)])} />}
    <div style={{ marginTop: 12 }}><button onClick={valider}>Émettre le bon de sortie</button></div>
  </div>;
}

function PanneauPP({ c, estVeh, action }: { c: O; estVeh: boolean; action: ActionFn }) {
  const id = c['id'] as string;
  const [ck, setCk] = useState({ cfs: false, t1: false, balise: false, bs: false });
  const [infos, setInfos] = useState(false);
  return <div className="card"><h2>Sortie — Porte Principale</h2>
    {estVeh ? (
      <label className="help"><input type="checkbox" style={{ width: 'auto' }} checked={infos} onChange={(e) => setInfos(e.target.checked)} /> Informations validées</label>
    ) : (
      <div style={{ display: 'grid', gap: 4 }}>
        {([['cfs', 'CFS conforme'], ['t1', 'T1 valide'], ['balise', 'Balise vérifiée'], ['bs', 'Bon de sortie vérifié']] as const).map(([k, l]) => (
          <label key={k} className="help"><input type="checkbox" style={{ width: 'auto' }} checked={ck[k]} onChange={(e) => setCk((o) => ({ ...o, [k]: e.target.checked }))} /> {l}</label>
        ))}
      </div>
    )}
    <div style={{ marginTop: 12 }}><button onClick={() => action(() => call('cargo.sortie', { id, infosValidees: infos, ckCfs: ck.cfs, ckT1: ck.t1, ckBalise: ck.balise, ckBs: ck.bs }), 'Sortie enregistrée.')}>Enregistrer la sortie</button></div>
  </div>;
}

function PanneauGpsEdit({ c, action }: { c: O; action: ActionFn }) {
  const id = c['id'] as string;
  const [gps, setGps] = useState('');
  return <div className="card"><h2>Remplacer la balise (ADMIN)</h2>
    <Champ label="Nouveau N° GPS" value={gps} onChange={(e) => setGps(e.target.value)} />
    <div style={{ marginTop: 12 }}><button onClick={() => action(() => call('cargo.gpsedit', { id, numeroGPS: gps }), 'Balise remplacée.')}>Remplacer</button></div>
  </div>;
}

function PanneauEtatCFS({ c, action }: { c: O; action: ActionFn }) {
  const id = c['id'] as string;
  const [etat, setEtat] = useState((c['etatSortie'] as string) || '');
  return <div className="card"><h2>État du camion (sortie zone CFS)</h2>
    <div className="row">
      <select value={etat} onChange={(e) => setEtat(e.target.value)} style={{ maxWidth: 240 }}>
        <option value="">— Choisir —</option>{ETATS_SORTIE.map((s) => <option key={s}>{s}</option>)}
      </select>
      <button disabled={!etat} onClick={() => action(() => call('cargo.etatcfs', { id, etatSortie: etat }), 'État enregistré.')}>Enregistrer</button>
    </div>
  </div>;
}

function PanneauEditCamion({ c, action }: { c: O; action: ActionFn }) {
  const id = c['id'] as string;
  const [num, setNum] = useState((c['numeroCamion'] as string) || '');
  return <details className="card"><summary style={{ cursor: 'pointer', fontWeight: 600 }}>Corriger le N° de camion</summary>
    <div className="row" style={{ marginTop: 10 }}>
      <input value={num} onChange={(e) => setNum(masks.alnum(e.target.value))} style={{ maxWidth: 200 }} />
      <button className="ghost" onClick={() => action(() => call('cargo.editcamion', { id, numeroCamion: num }), 'N° camion corrigé.')}>Corriger</button>
    </div>
  </details>;
}
