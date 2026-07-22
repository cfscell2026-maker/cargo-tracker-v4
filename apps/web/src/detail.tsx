/**
 * Détail d'une cargaison : timeline des 5 cellules + panneaux d'action
 * conditionnels (rôle × étape en attente), reproduction de renderDetail (v3.6).
 */
import { useState } from 'react';
import { call } from './lib/rpc.ts';
import { useAsync } from './lib/hooks.ts';
import { Spinner, Tag, masks, toast, fmtDate, BoutonRetour } from './lib/ui.tsx';
import type { Nav } from './App.tsx';
import {
  STATUTS, OPERATIONS, ROLES, TYPES_DECLARATION, ETATS_SORTIE,
  etapesEnAttente, estOui, tcValide, parseConteneursDetails, tailleBucket,
  groupesDeclaration, libelleDeclaration, estTypeSansT1, libelleTypeSansT1,
} from '../../../supabase/functions/_shared/domaine/src/index.ts';

type O = Record<string, unknown>;
const A = ROLES.ADMIN;
// Sous-panneau d'édition (rendu à l'intérieur du bloc « Éditer », sans chrome de carte).
const EDIT_ITEM = { border: '1px solid var(--line)', borderRadius: 6, padding: '8px 12px' } as const;

export function Detail({ user, arg, go, retour, ecranPrecedent }: Nav) {
  // `arg` = id (chaîne) OU { id, prefillDecl } quand on enchaîne un 2e camion.
  const a = arg && typeof arg === 'object' ? (arg as { id?: unknown; prefillDecl?: O }) : { id: arg };
  const id = String(a.id ?? '');
  const { data: c, loading, error, reload } = useAsync<O>(() => call('cargo.get', { id }), [id]);
  if (loading) return <Spinner />;
  if (error) return <div className="card err-msg">{error}</div>;
  if (!c) return <div className="card">Introuvable.</div>;

  const pend = etapesEnAttente(c as never);
  const role = user.role;
  const can = (...roles: string[]) => roles.includes(role);
  const dets = parseConteneursDetails(c['conteneursDetails']);
  // Chargement mixte : déduit des déclarations portées par chaque conteneur.
  const groupes = groupesDeclaration(dets.conteneurs, c);
  const estVeh = estOui(c['estVehicule']);
  // Enlèvement binôme : après UN conteneur 20', on peut en ajouter un 2e (20').
  const binomePossible = c['typeOperation'] === OPERATIONS.ENLEVEMENT
    && dets.conteneurs.length === 1 && tailleBucket(dets.conteneurs[0]?.taille) === 't20';

  async function action(fn: () => Promise<unknown>, ok: string) {
    try { await fn(); toast(ok, 'ok'); reload(); } catch (e) { toast((e as Error).message, 'err'); }
  }
  /** Quitter la fiche (retour d'un cran, ou la liste si on y est arrivé direct). */
  const quitter = () => (ecranPrecedent ? retour() : go('list'));
  // Bloc « Éditer » complet (conteneurs, déclaration, type, plaque, suppression) :
  // CFS jusqu'à la fin de chargement, ADMIN à tout moment. Les autres rôles n'ont
  // que la correction de plaque, rendue plus bas.
  const peutTtEditer = role === A
    || (role === ROLES.CFS && [STATUTS.CAMION, STATUTS.CHARGEMENT, STATUTS.CREEE].includes(c['statut'] as never));

  return (
    <div>
      <BoutonRetour retour={retour} ecranPrecedent={ecranPrecedent} secours={() => go('list')} />
      <FicheCargaison c={c} groupes={groupes} />
      <CarteConteneurs c={c} dets={dets} groupes={groupes} />

      <Timeline c={c} />

      {/* Panneaux d'action selon rôle × étape */}
      {(c['statut'] === STATUTS.CAMION || c['statut'] === STATUTS.CHARGEMENT || (c['statut'] === STATUTS.CREEE && binomePossible)) && can(ROLES.CFS, A) &&
        <PanneauCFS c={c} dets={dets} action={action} prefillDecl={a.prefillDecl} />}
      {c['statut'] === STATUTS.VEHICULE_OUILLAGE && can(ROLES.CFS, A) && <PanneauOuillage c={c} action={action} />}
      {pend.includes('VALIDATION') && can(ROLES.CHEF_BRIGADE, A) && <PanneauValidation c={c} action={action} />}
      {pend.includes('T1') && can(ROLES.T1, A) && <PanneauT1 c={c} dets={dets} action={action} />}
      {pend.includes('BALISE') && can(ROLES.BALISE, A) && !estVeh && <PanneauBalise c={c} action={action} />}
      {pend.includes('BS') && can(ROLES.BON_SORTIE, A) && <PanneauBS c={c} dets={dets} action={action} />}
      {pend.includes('PP') && can(ROLES.PP, A) && <PanneauPP c={c} estVeh={estVeh} action={action} />}
      {c['statut'] === STATUTS.GPS && can(ROLES.BALISE, A) && <PanneauGpsEdit c={c} action={action} />}
      {c['statut'] === STATUTS.SORTIE && (String(c['baliseRequise']) === 'Non' || estOui(c['sauteBalise'])) && !estOui(c['arriveeBureau']) && can(ROLES.BALISE, A) &&
        <div className="card"><h2>Dispense — arrivée au bureau</h2>
          <button onClick={() => action(() => call('cargo.arriveebureau', { id }), 'Arrivée confirmée.')}>Confirmer l'arrivée (solder la dispense)</button></div>}
      {!estVeh && c['statut'] !== STATUTS.SORTIE && can(ROLES.CFS, A) && <PanneauEtatCFS c={c} action={action} />}

      {/* v4 — enchaîner un autre camion sur la même déclaration : enlèvement ET dépotage. */}
      {[OPERATIONS.DEPOTAGE, OPERATIONS.ENLEVEMENT].includes(c['typeOperation'] as never) && can(ROLES.CFS, A) && !!c['numeroDeclaration'] &&
        <AjouterCamion c={c} go={go} />}
      {/* v4 — Éditer : le CFS a la main JUSQU'À la fin de chargement ; l'ADMIN toujours. */}
      {peutTtEditer
        ? <PanneauEditer c={c} dets={dets} action={action} apresSuppression={quitter} admin={role === A} />
        // Les autres cellules (Balise, PP, T1, Bon de sortie, chefs) gardent au
        // minimum la correction de la plaque, comme dans l'Apps Script.
        : <CorrigerCamion c={c} action={action} estVeh={estVeh} />}
    </div>
  );
}

type Groupe = ReturnType<typeof groupesDeclaration>[number];

/**
 * Fiche d'identité de la cargaison — en-tête du détail.
 *
 * v4 — la déclaration n'est plus affichée comme une ligne unique : un camion
 * peut être en CHARGEMENT MIXTE (conteneurs relevant de plusieurs déclarations,
 * cas courant en enlèvement). L'Apps Script l'affichait par un bandeau, mais
 * sur la foi d'un drapeau posé à la saisie ; ici il est reconnu automatiquement
 * à partir des déclarations des conteneurs, donc jamais oublié.
 */
function FicheCargaison({ c, groupes }: { c: O; groupes: Groupe[] }) {
  const mixte = groupes.length > 1;
  return <div className="card" style={{ marginTop: 10 }}>
    <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
      <div>
        <h2 style={{ margin: 0 }}>{(c['numeroCamion'] as string) || '—'}</h2>
        <div className="help mono" style={{ marginTop: 2 }}>{c['id'] as string}{c['rapportId'] ? ` · rapport ${String(c['rapportId'])}` : ''}</div>
      </div>
      <Tag statut={c['statut'] as string} o={c} />
    </div>

    <div className="fiche">
      <div className="kv"><b>Opération</b>{(c['typeOperation'] as string) || '—'}</div>
      <div className="kv"><b>Date d'entrée</b>{fmtDate(c['dateCreation'])}</div>
      <div className="kv"><b>Déclarant</b>{(c['declarant'] as string) || '—'}</div>
      <div className="kv"><b>Contact</b>{(c['contactDeclarant'] as string) || '—'}</div>
      <div className="kv"><b>Déclaration</b>{mixte
        ? <span style={{ color: 'var(--warn)', fontWeight: 600 }}>{groupes.length} déclarations (mixte)</span>
        : libelleDeclaration(groupes[0] ?? c)}</div>
      <div className="kv"><b>Destination</b>{(c['destinationMarchandise'] as string) || '—'}</div>
      {c['descriptionMarchandise'] ? <div className="kv"><b>Marchandise</b>{c['descriptionMarchandise'] as string}</div> : null}
      {c['nbColis'] ? <div className="kv"><b>Nombre de colis</b>{c['nbColis'] as string}</div> : null}
      {c['agentCfs'] ? <div className="kv"><b>Agent CFS</b>{c['agentCfs'] as string}</div> : null}
      {'horsGabarit' in c ? <div className="kv"><b>Hors gabarit</b>{estOui(c['horsGabarit']) ? `Oui (${(c['hauteurChargement'] as string) || '?'} m)` : 'Non'}</div> : null}
    </div>

    {mixte && <div className="bandeau">
      <div className="t">⊞ Chargement mixte — {groupes.length} déclarations sur ce camion</div>
      {groupes.map((g) => <div key={g.cle} className="l">
        <b>{libelleDeclaration(g)}</b>{g.declarant ? ` — ${g.declarant}` : ''} · conteneur{g.rangs.length > 1 ? 's' : ''} n° {g.rangs.join(', ')}
      </div>)}
      <div className="help" style={{ marginTop: 6 }}>Un bon de chargement et un ordre d'exécution sont édités <b>par déclaration</b> : ce camion apparaîtra sur chacun d'eux, avec ses seuls conteneurs concernés.</div>
    </div>}
  </div>;
}

/**
 * Conteneurs du camion, placés AVANT le parcours (l'agent cherche d'abord ce
 * qu'il y a dans le camion). En chargement mixte, les conteneurs sont groupés
 * par déclaration au lieu d'être listés à plat — sans ce regroupement, rien à
 * l'écran ne disait quel conteneur relevait de quelle déclaration.
 */
function CarteConteneurs({ c, dets, groupes }: { c: O; dets: ReturnType<typeof parseConteneursDetails>; groupes: Groupe[] }) {
  if (!dets.conteneurs.length) return null;
  const estDep = c['typeOperation'] === OPERATIONS.DEPOTAGE;
  const mixte = groupes.length > 1;
  const rang = (ct: unknown) => dets.conteneurs.indexOf(ct as never) + 1;

  const table = (liste: Groupe['conteneurs']) => <div className="tbl"><table>
    <thead><tr><th style={{ width: 40 }}>#</th><th>Conteneur</th><th>Taille</th><th>Type</th>{!estDep && <th>Scellé</th>}</tr></thead>
    <tbody>{liste.map((ct) => { const i = rang(ct); return (
      <tr key={i}><td>{i}</td><td className="mono">{ct.num}</td><td>{ct.taille || '—'}</td><td>{ct.type || '—'}</td>
        {/* Repli sur les scellés camion : certaines saisies migrées les portent
            là même en enlèvement, où ils devraient être sur le conteneur. */}
        {!estDep && <td>{ct.plomb || dets.scellesCamion[i - 1] || '—'}</td>}</tr>
    ); })}</tbody></table></div>;

  return <div className="card">
    <h2>Conteneurs ({dets.conteneurs.length})</h2>
    {/* Dépotage : le scellé est posé sur le CAMION, pas sur chaque conteneur. */}
    {estDep && <div className="kv" style={{ marginBottom: 10 }}>
      <b>Scellés camion</b>{dets.scellesCamion.length ? dets.scellesCamion.join(' · ') : '—'}</div>}
    {mixte
      ? groupes.map((g) => <div key={g.cle} style={{ marginBottom: 12 }}>
        <div className="section-title" style={{ marginTop: 0 }}>Déclaration {libelleDeclaration(g)}{g.declarant ? ` — ${g.declarant}` : ''}</div>
        {table(g.conteneurs)}
      </div>)
      : table(dets.conteneurs)}
  </div>;
}

/**
 * v4 — Bouton « Éditer » regroupant TOUTES les corrections (conteneur,
 * déclaration, type, N° camion) + suppression (ADMIN). Le CFS y a accès
 * jusqu'à la fin de chargement ; l'ADMIN à tout moment (erreurs fatales).
 */
function PanneauEditer({ c, dets, action, apresSuppression, admin }: { c: O; dets: ReturnType<typeof parseConteneursDetails>; action: ActionFn; apresSuppression: () => void; admin: boolean }) {
  const estCamionOp = [OPERATIONS.DEPOTAGE, OPERATIONS.ENLEVEMENT].includes(c['typeOperation'] as never);
  return <details className="card">
    <summary style={{ cursor: 'pointer', fontWeight: 700 }}>✎ Éditer la cargaison</summary>
    <p className="help" style={{ marginTop: 8 }}>Corrections de saisie. {admin ? 'Accès administrateur (à tout moment).' : 'Possible jusqu\'à la fin de chargement.'}</p>
    <div style={{ display: 'grid', gap: 8 }}>
      {dets.conteneurs.length > 0 && <PanneauEditConteneurs c={c} dets={dets} action={action} />}
      {!!c['numeroDeclaration'] && <PanneauEditDecl c={c} action={action} />}
      {estCamionOp && <PanneauEditType c={c} action={action} />}
      <PanneauEditCamion c={c} action={action} />
      {admin && <PanneauSupprimer c={c} apresSuppression={apresSuppression} />}
    </div>
  </details>;
}

/** v4 — Suppression d'un doublon de cargaison (ADMIN uniquement). */
function PanneauSupprimer({ c, apresSuppression }: { c: O; apresSuppression: () => void }) {
  const id = c['id'] as string;
  const [busy, setBusy] = useState(false);
  async function supprimer() {
    if (!window.confirm(`Supprimer définitivement la cargaison ${id} (${String(c['numeroCamion'] || '')}) ? Le stock rattaché redevient « En stock ».`)) return;
    setBusy(true);
    try {
      await call('cargo.delete', { id });
      toast('Cargaison supprimée.', 'ok');
      apresSuppression(); // la fiche n'existe plus : on repart d'où l'on venait
    } catch (e) { toast((e as Error).message, 'err'); } finally { setBusy(false); }
  }
  return <details style={EDIT_ITEM}><summary style={{ cursor: 'pointer', fontWeight: 600, color: 'var(--warn)' }}>Supprimer cette cargaison (doublon) — ADMIN</summary>
    <p className="help" style={{ marginTop: 10 }}>Action réservée à l'administrateur, pour retirer un <b>doublon de saisie</b>. Irréversible ; l'action est tracée dans l'historique.</p>
    <button className="ghost" disabled={busy} style={{ color: 'var(--warn)' }} onClick={supprimer}>Supprimer définitivement</button>
  </details>;
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
  // Cargaison clôturée : une étape non faite ne le sera plus → on l'affiche
  // explicitement « Non effectué » (traçabilité) au lieu d'un simple « en attente ».
  const sorti = e.pp;
  return <div className="card"><h2>Parcours</h2><div className="timeline">
    {steps.map(([done, t, d], i) => {
      const manque = !done && sorti;
      return (
        <div key={i} className={`tl ${done ? 'done' : 'wait'}`}>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
            <div className="dot">{done ? '✓' : manque ? '—' : i + 1}</div>{i < steps.length - 1 && <div className="bar" />}
          </div>
          <div className="body"><div className="t">{t}</div>
            {manque ? <div className="d" style={{ color: 'var(--warn)' }}>Non effectué</div> : d ? <div className="d">{d}</div> : null}
          </div>
        </div>
      );
    })}
  </div></div>;
}

/* ------------------------------ Panneaux ------------------------------- */
type ActionFn = (fn: () => Promise<unknown>, ok: string) => Promise<void>;

function Champ({ label, ...p }: { label: string } & React.InputHTMLAttributes<HTMLInputElement>) {
  return <div><label className="help">{label}</label><input {...p} /></div>;
}

function PanneauCFS({ c, dets, action, prefillDecl }: { c: O; dets: ReturnType<typeof parseConteneursDetails>; action: ActionFn; prefillDecl?: O }) {
  const id = c['id'] as string;
  const estEnl = c['typeOperation'] === OPERATIONS.ENLEVEMENT;
  const premier = c['statut'] === STATUTS.CAMION;
  const [f, setF] = useState<O>({ num: '', taille: '', type: '', poids: '', plomb: '', manuel: false });
  const [d, setD] = useState<O>({ declarant: '', contactDeclarant: '', destinationMarchandise: '', bureauDeclaration: 'TG120', typeDeclaration: 'T', numeroDeclaration: '', anneeDeclaration: String(new Date().getFullYear()), descriptionMarchandise: '', nombreConteneurs: '', dateDeclaration: '', ...(prefillDecl ?? {}) });
  const [consoMode, setConsoMode] = useState('balise'); // type C / A : balisée ou non balisée (dispense)
  // v4 — propose les TC de la bonne source à la frappe : dépotage → stock du jour
  // (Positionné) ; enlèvement → stock du PIA (En stock).
  const statutStock = estEnl ? 'En stock' : 'Positionné';
  const { data: stk } = useAsync<{ rows: O[] }>(() => call('stock.list', { statut: statutStock }), [statutStock]);
  const stockRows = (stk?.rows ?? []) as O[];
  const tcOptions = stockRows.map((r) => String(r['numeroTC'] ?? '')).filter(Boolean);
  const stockByTc = Object.fromEntries(stockRows.map((r) => [String(r['numeroTC'] ?? ''), r]));
  const set = (k: string, v: unknown) => setF((o) => ({ ...o, [k]: v }));

  // v4 — à la saisie/choix d'un conteneur du stock, pré-remplit taille + type
  // depuis la fiche stock (l'agent n'a plus à les ressaisir ; reste modifiable).
  function choisirConteneur(v: string) {
    const num = masks.tc(v);
    setF((o) => {
      const next: O = { ...o, num };
      const hit = stockByTc[num] as O | undefined;
      if (hit) {
        if (hit['taille']) next['taille'] = String(hit['taille']);
        if (hit['typeConteneur']) next['type'] = String(hit['typeConteneur']);
      }
      return next;
    });
  }
  const setDd = (k: string, v: unknown) => setD((o) => ({ ...o, [k]: v }));
  const montrerDecl = premier || !estEnl; // enlèvement 1er conteneur / dépotage : chaque conteneur
  const estConso = estTypeSansT1(d['typeDeclaration']); // C (conso) / A (admission) → saute le T1

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
        <Champ label="N° conteneur (ISO 6346)" className="mono" value={String(f['num'])} onChange={(e) => choisirConteneur(e.target.value)} list="dl-cfs-tc" autoComplete="off" />
        <datalist id="dl-cfs-tc">{tcOptions.map((t) => <option key={t} value={t} />)}</datalist>
        <Champ label="Taille" value={String(f['taille'])} onChange={(e) => set('taille', masks.upper(e.target.value))} placeholder="20' / 40' / 45'" />
        <Champ label="Type (facultatif)" value={String(f['type'])} onChange={(e) => set('type', masks.upper(e.target.value))} />
        {estEnl && <Champ label="Scellé / Plomb" value={String(f['plomb'])} onChange={(e) => set('plomb', masks.upper(e.target.value))} />}
        <label className="help" style={{ alignSelf: 'end' }}><input type="checkbox" style={{ width: 'auto' }} checked={!!f['manuel']} onChange={(e) => set('manuel', e.target.checked)} /> Saisie manuelle (conteneur hors stock)</label>
      </div>
      <div className="help" style={{ marginTop: 6 }}>{estEnl ? 'Enlèvement' : 'Dépotage'} : {tcOptions.length} conteneur(s) {estEnl ? 'en stock (PIA)' : 'positionné(s) du jour'} — tapez pour choisir.</div>
      {montrerDecl && (
        <>
          <div className="section-title">Déclaration</div>
          {estConso && <p className="help" style={{ marginTop: 0 }}>{libelleTypeSansT1(d['typeDeclaration'])} : la cargaison <b>saute le T1</b>{consoMode === 'sansbalise' ? ' et la Balise (dispense)' : ' ; balise à poser'}.</p>}
          <div className="grid2">
            <Champ label="Déclarant" value={String(d['declarant'])} onChange={(e) => setDd('declarant', masks.upper(e.target.value))} />
            <Champ label="Contact (téléphone)" value={String(d['contactDeclarant'])} onChange={(e) => setDd('contactDeclarant', masks.tel(e.target.value))} />
            <Champ label="Destination" value={String(d['destinationMarchandise'])} onChange={(e) => setDd('destinationMarchandise', masks.upper(e.target.value))} />
            <Champ label="Bureau" value={String(d['bureauDeclaration'])} onChange={(e) => setDd('bureauDeclaration', masks.upper(e.target.value))} />
            <div><label className="help">Type déclaration</label><select value={String(d['typeDeclaration'])} onChange={(e) => setDd('typeDeclaration', e.target.value)}>{TYPES_DECLARATION.map((t) => <option key={t}>{t}</option>)}</select></div>
            {estConso && <div><label className="help">Type {String(d['typeDeclaration'])} — balise</label><select value={consoMode} onChange={(e) => setConsoMode(e.target.value)}><option value="balise">À baliser</option><option value="sansbalise">Non balisée (dispense)</option></select></div>}
            <Champ label="N° déclaration" value={String(d['numeroDeclaration'])} onChange={(e) => setDd('numeroDeclaration', masks.upper(e.target.value))} />
            <Champ label="Année" value={String(d['anneeDeclaration'])} onChange={(e) => setDd('anneeDeclaration', e.target.value)} />
            <Champ label="Description marchandise" value={String(d['descriptionMarchandise'])} onChange={(e) => setDd('descriptionMarchandise', masks.upper(e.target.value))} />
          </div>
        </>
      )}
      <div style={{ marginTop: 12 }}><button onClick={ajouter}>Ajouter le conteneur</button></div>

      {/* v4 — un camion d'effets divers (0 conteneur) se finalise aussi (scellés camion). */}
      {!estEnl && c['statut'] === STATUTS.CHARGEMENT && <FinaliserDepotage id={id} action={action} />}
    </div>
  );
}

/**
 * v4 — Enchaîner un AUTRE camion sur la MÊME déclaration (enlèvement ET dépotage).
 * La déclaration du camion courant est reportée telle quelle sur le nouveau :
 * l'agent ne re-saisit que le N° de camion puis les conteneurs.
 */
export function prefillDe(c: O): O {
  return {
    declarant: String(c['declarant'] ?? ''), contactDeclarant: String(c['contactDeclarant'] ?? ''),
    destinationMarchandise: String(c['destinationMarchandise'] ?? ''), bureauDeclaration: String(c['bureauDeclaration'] ?? 'TG120'),
    typeDeclaration: String(c['typeDeclaration'] ?? 'T'), numeroDeclaration: String(c['numeroDeclaration'] ?? ''),
    anneeDeclaration: String(c['anneeDeclaration'] ?? ''), descriptionMarchandise: String(c['descriptionMarchandise'] ?? ''),
  };
}

function AjouterCamion({ c, go }: { c: O; go: Nav['go'] }) {
  const [num, setNum] = useState('');
  const [busy, setBusy] = useState(false);
  const routage = String(c['typeOperation'] ?? OPERATIONS.ENLEVEMENT);
  async function creer() {
    if (!num) { toast('N° camion requis.', 'err'); return; }
    setBusy(true);
    try {
      const r = await call<{ id: string }>('cargo.createcamion', { numeroCamion: num, routage });
      toast('Nouveau camion créé.', 'ok');
      go('detail', { id: r.id, prefillDecl: prefillDe(c) });
    } catch (e) { toast((e as Error).message, 'err'); } finally { setBusy(false); }
  }
  return <div className="card"><h2>Ajouter un autre camion (même déclaration)</h2>
    <p className="help" style={{ marginTop: 0 }}>Crée un nouveau camion de <b>{routage.toLowerCase()}</b> en reprenant la déclaration de ce camion (déclarant, n° de déclaration, marchandise) — vous n'aurez qu'à saisir les conteneurs.</p>
    <div className="row"><input className="mono" value={num} onChange={(e) => setNum(masks.alnum(e.target.value))} placeholder="N° du nouveau camion" style={{ flex: 1 }} />
      <button disabled={busy} onClick={creer}>Créer et associer</button></div>
    <p className="help" style={{ marginBottom: 0 }}>Plusieurs camions d'un coup ? Utilisez l'écran « Plusieurs camions (1 déclaration) » du menu.</p>
  </div>;
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

/**
 * Correction d'une balise déjà posée. Ouverte à la cellule BALISE (et à
 * l'ADMIN) : c'est elle qui saisit le numéro, elle seule est sur le terrain pour
 * rattraper sa coquille, et attendre l'administrateur immobilisait le camion.
 * Reste borné au statut « Balisé » — passé le bon de sortie, plus de reprise —
 * et chaque remplacement est tracé (ancien → nouveau) dans l'historique.
 */
function PanneauGpsEdit({ c, action }: { c: O; action: ActionFn }) {
  const id = c['id'] as string;
  const [gps, setGps] = useState('');
  const [obs, setObs] = useState('');
  const actuel = (c['numeroGps'] as string) || '—';
  const inchange = !gps.trim() || gps.trim() === String(c['numeroGps'] ?? '').trim();
  return <div className="card"><h2>Corriger le N° de balise</h2>
    <div className="kv"><b>Balise actuelle</b><span className="mono">{actuel}</span></div>
    <div className="grid2" style={{ marginTop: 8 }}>
      <Champ label="Nouveau N° de balise" className="mono" value={gps} onChange={(e) => setGps(e.target.value)} />
      <Champ label="Motif / observations (facultatif)" value={obs} onChange={(e) => setObs(e.target.value)} />
    </div>
    <p className="help" style={{ marginBottom: 0 }}>Le remplacement est enregistré dans l'historique avec l'ancien et le nouveau numéro.</p>
    <div style={{ marginTop: 12 }}>
      <button disabled={inchange}
        onClick={() => action(() => call('cargo.gpsedit', { id, numeroGPS: gps, observations: obs }), 'N° de balise corrigé.')}>
        Corriger la balise
      </button>
    </div>
  </div>;
}

/**
 * Correction du N° de camion (ou de châssis pour un véhicule), accessible à
 * TOUS LES RÔLES et à tout statut — c'est ce que faisait l'Apps Script, où le
 * bouton « ✎ Corriger N° camion » figurait en tête de fiche sans condition. La
 * v4 l'avait enfermé dans le bloc « Éditer » réservé au CFS et à l'ADMIN : la
 * Balise et la Porte Principale, qui lisent la plaque au passage du camion,
 * n'avaient plus aucun moyen de rectifier une plaque mal saisie en amont.
 * La permission serveur, elle, était restée ouverte à tous.
 */
function CorrigerCamion({ c, action, estVeh }: { c: O; action: ActionFn; estVeh: boolean }) {
  const id = c['id'] as string;
  const libelle = estVeh ? 'N° de châssis' : 'N° de camion';
  const [num, setNum] = useState((c['numeroCamion'] as string) || '');
  const inchange = !num.trim() || num.trim() === String(c['numeroCamion'] ?? '').trim();
  return <details className="card">
    <summary style={{ cursor: 'pointer', fontWeight: 700 }}>✎ Corriger le {libelle}</summary>
    <p className="help" style={{ marginTop: 8 }}>
      Rectifie une plaque mal saisie en amont. La correction suit le camion sur toute la fiche
      et sur ses conteneurs ; elle est tracée dans l'historique.
    </p>
    <div className="row">
      <input className="mono" value={num} onChange={(e) => setNum(masks.alnum(e.target.value))} style={{ maxWidth: 220 }} />
      <button className="ghost" disabled={inchange}
        onClick={() => action(() => call('cargo.editcamion', { id, numeroCamion: num }), `${libelle} corrigé.`)}>
        Corriger
      </button>
    </div>
  </details>;
}

function PanneauEtatCFS({ c, action }: { c: O; action: ActionFn }) {
  const id = c['id'] as string;
  const [etat, setEtat] = useState((c['etatSortie'] as string) || '');
  return <div className="card"><h2>État du camion à la sortie de la zone CFS</h2>
    <p className="help" style={{ marginTop: 0 }}>Sans rapport avec l'ajout de conteneurs ci-dessus. Renseigne l'état du camion quand il quitte la zone.</p>
    <div className="row">
      <select value={etat} onChange={(e) => setEtat(e.target.value)} style={{ maxWidth: 240 }}>
        <option value="">— Choisir —</option>{ETATS_SORTIE.map((s) => <option key={s}>{s}</option>)}
      </select>
      <button disabled={!etat} onClick={() => action(() => call('cargo.etatcfs', { id, etatSortie: etat }), 'État à la sortie enregistré.')}>Enregistrer l'état à la sortie</button>
    </div>
  </div>;
}

function PanneauEditCamion({ c, action }: { c: O; action: ActionFn }) {
  const id = c['id'] as string;
  const [num, setNum] = useState((c['numeroCamion'] as string) || '');
  return <details style={EDIT_ITEM}><summary style={{ cursor: 'pointer', fontWeight: 600 }}>Corriger le N° de camion</summary>
    <div className="row" style={{ marginTop: 10 }}>
      <input value={num} onChange={(e) => setNum(masks.alnum(e.target.value))} style={{ maxWidth: 200 }} />
      <button className="ghost" onClick={() => action(() => call('cargo.editcamion', { id, numeroCamion: num }), 'N° camion corrigé.')}>Corriger</button>
    </div>
  </details>;
}

/**
 * v4 — CORRECTION d'un conteneur déjà enregistré (N° erroné, taille, type,
 * scellé) ou retrait de la ligne. Sans cet écran, une faute de frappe sur le
 * N° de conteneur restait définitive.
 */
function PanneauEditConteneurs({ c, dets, action }: { c: O; dets: ReturnType<typeof parseConteneursDetails>; action: ActionFn }) {
  const id = c['id'] as string;
  const estEnl = c['typeOperation'] === OPERATIONS.ENLEVEMENT;
  const [i, setI] = useState<number | null>(null);
  const [f, setF] = useState<O>({ num: '', taille: '', type: '', plomb: '', manuel: false });
  const set = (k: string, v: unknown) => setF((o) => ({ ...o, [k]: v }));

  function ouvrir(k: number) {
    const ct = dets.conteneurs[k]!;
    setI(k);
    setF({ num: ct.num ?? '', taille: ct.taille ?? '', type: ct.type ?? '', plomb: ct.plomb ?? '', manuel: false });
  }
  async function corriger() {
    if (i === null) return;
    await action(() => call('cargo.editconteneur', { id, index: i, ...f }), 'Conteneur corrigé.');
    setI(null);
  }
  async function retirer(k: number) {
    const ct = dets.conteneurs[k]!;
    if (!confirm(`Retirer le conteneur ${ct.num} de ce camion ?`)) return;
    await action(() => call('cargo.editconteneur', { id, index: k, supprimer: true }), 'Conteneur retiré.');
    setI(null);
  }

  return <details style={EDIT_ITEM}><summary style={{ cursor: 'pointer', fontWeight: 600 }}>Corriger un conteneur (N° erroné, taille, scellé)</summary>
    <p className="help" style={{ marginTop: 10 }}>Le conteneur retiré ou remplacé <b>revient au stock</b> et redevient sélectionnable ; le nouveau lui est rattaché.</p>
    {dets.conteneurs.map((ct, k) => <div key={k} className="row" style={{ alignItems: 'center', marginBottom: 6 }}>
      <span className="mono" style={{ flex: 1 }}>{k + 1}. {ct.num} · {ct.taille || '—'}{ct.plomb ? ` · scellé ${ct.plomb}` : ''}</span>
      <button className="ghost xs" onClick={() => ouvrir(k)}>Corriger</button>
      <button className="ghost xs" onClick={() => retirer(k)}>Retirer</button>
    </div>)}
    {i !== null && <div style={{ borderTop: '1px solid var(--line)', marginTop: 10, paddingTop: 10 }}>
      <div className="section-title">Nouvelle saisie — ligne {i + 1}</div>
      <div className="grid2">
        <Champ label="N° conteneur (ISO 6346)" className="mono" value={String(f['num'])} onChange={(e) => set('num', masks.tc(e.target.value))} />
        <Champ label="Taille" value={String(f['taille'])} onChange={(e) => set('taille', masks.upper(e.target.value))} placeholder="20' / 40' / 45'" />
        <Champ label="Type (facultatif)" value={String(f['type'])} onChange={(e) => set('type', masks.upper(e.target.value))} />
        {estEnl && <Champ label="Scellé / Plomb" value={String(f['plomb'])} onChange={(e) => set('plomb', masks.upper(e.target.value))} />}
        <label className="help" style={{ alignSelf: 'end' }}><input type="checkbox" style={{ width: 'auto' }} checked={!!f['manuel']} onChange={(e) => set('manuel', e.target.checked)} /> Saisie manuelle (conteneur hors stock / partagé)</label>
      </div>
      <div className="row" style={{ marginTop: 12 }}>
        <button onClick={corriger}>Enregistrer la correction</button>
        <button className="ghost" onClick={() => setI(null)}>Annuler</button>
      </div>
    </div>}
  </details>;
}

/** v4 — Correction des informations de déclaration déjà enregistrées. */
function PanneauEditDecl({ c, action }: { c: O; action: ActionFn }) {
  const id = c['id'] as string;
  const [d, setD] = useState<O>({
    declarant: String(c['declarant'] ?? ''), contactDeclarant: String(c['contactDeclarant'] ?? ''),
    destinationMarchandise: String(c['destinationMarchandise'] ?? ''), bureauDeclaration: String(c['bureauDeclaration'] ?? 'TG120'),
    typeDeclaration: String(c['typeDeclaration'] ?? 'T'), numeroDeclaration: String(c['numeroDeclaration'] ?? ''),
    anneeDeclaration: String(c['anneeDeclaration'] ?? ''), descriptionMarchandise: String(c['descriptionMarchandise'] ?? ''),
  });
  const [consoMode, setConsoMode] = useState('balise');
  const setDd = (k: string, v: unknown) => setD((o) => ({ ...o, [k]: v }));
  const estConso = estTypeSansT1(d['typeDeclaration']);
  return <details style={EDIT_ITEM}><summary style={{ cursor: 'pointer', fontWeight: 600 }}>Corriger les informations de déclaration</summary>
    <p className="help" style={{ marginTop: 10 }}>Corrige le déclarant, la déclaration et la marchandise de ce camion et de ses conteneurs.</p>
    <div className="grid2">
      <Champ label="Déclarant" value={String(d['declarant'])} onChange={(e) => setDd('declarant', masks.upper(e.target.value))} />
      <Champ label="Contact (téléphone)" value={String(d['contactDeclarant'])} onChange={(e) => setDd('contactDeclarant', masks.tel(e.target.value))} />
      <Champ label="Destination" value={String(d['destinationMarchandise'])} onChange={(e) => setDd('destinationMarchandise', masks.upper(e.target.value))} />
      <Champ label="Bureau" value={String(d['bureauDeclaration'])} onChange={(e) => setDd('bureauDeclaration', masks.upper(e.target.value))} />
      <div><label className="help">Type déclaration</label><select value={String(d['typeDeclaration'])} onChange={(e) => setDd('typeDeclaration', e.target.value)}>{TYPES_DECLARATION.map((t) => <option key={t}>{t}</option>)}</select></div>
      {estConso && <div><label className="help">Type {String(d['typeDeclaration'])} — balise</label><select value={consoMode} onChange={(e) => setConsoMode(e.target.value)}><option value="balise">À baliser</option><option value="sansbalise">Non balisée (dispense)</option></select></div>}
      <Champ label="N° déclaration" value={String(d['numeroDeclaration'])} onChange={(e) => setDd('numeroDeclaration', masks.upper(e.target.value))} />
      <Champ label="Année" value={String(d['anneeDeclaration'])} onChange={(e) => setDd('anneeDeclaration', e.target.value)} />
      <Champ label="Description marchandise" value={String(d['descriptionMarchandise'])} onChange={(e) => setDd('descriptionMarchandise', masks.upper(e.target.value))} />
    </div>
    <div style={{ marginTop: 12 }}><button onClick={() => action(() => call('cargo.editdecl', { id, declaration: d, consoMode }), 'Déclaration corrigée.')}>Enregistrer la correction</button></div>
  </details>;
}

/** v4 — Correction du type d'opération (Dépotage ↔ Enlèvement), phase CFS. */
function PanneauEditType({ c, action }: { c: O; action: ActionFn }) {
  const id = c['id'] as string;
  const actuel = String(c['typeOperation']);
  const autre = actuel === OPERATIONS.DEPOTAGE ? OPERATIONS.ENLEVEMENT : OPERATIONS.DEPOTAGE;
  return <details style={EDIT_ITEM}><summary style={{ cursor: 'pointer', fontWeight: 600 }}>Corriger le type d'opération</summary>
    <p className="help" style={{ marginTop: 10 }}>Actuel : <b>{actuel}</b>. En passant à « {autre} », les scellés sont ré-adaptés au nouveau modèle
      (par conteneur en enlèvement / au niveau camion en dépotage). En dépotage, <b>refaites la finalisation</b> (scellés camion + hauteur) ; vérifiez les scellés après.</p>
    <button className="ghost" onClick={() => action(() => call('cargo.edittype', { id, typeOperation: autre }), `Type corrigé → ${autre}.`)}>Passer en « {autre} »</button>
  </details>;
}
