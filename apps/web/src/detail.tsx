/**
 * Détail d'une cargaison : timeline des 5 cellules + panneaux d'action
 * conditionnels (rôle × étape en attente), reproduction de renderDetail (v3.6).
 */
import { useEffect, useState } from 'react';
import { call } from './lib/rpc.ts';
import { useAsync } from './lib/hooks.ts';
import { Icone } from './lib/icones.tsx';
import { Spinner, Tag, masks, toast, fmtDate, BoutonRetour, ChampDestination, useSuiviEngagement, ChampCamion, roleLabel, ChoixSegmente, BoutonBascule } from './lib/ui.tsx';
import type { Nav } from './App.tsx';
import {
  STATUTS, OPERATIONS, ROLES, TYPES_DECLARATION, ETATS_SORTIE, ENGAGEMENTS, dateDansNJours,
  etapesEnAttente, estOui, tcValide, parseConteneursDetails, tailleBucket,
  groupesDeclaration, libelleDeclaration, estTypeSansT1, libelleTypeSansT1, exigeControlePoids,
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
  // Bloc « Éditer » complet (conteneurs, déclaration, type, plaque, suppression).
  //
  // 2026-09-11 (décision utilisateur) — le CFS y accède désormais À TOUTE ÉTAPE,
  // et non plus jusqu'à la seule fin de chargement. C'est en aval du parcours
  // qu'on découvre qu'une déclaration manque ou qu'un numéro est faux, et le CFS
  // est le seul à savoir lequel écrire ; le renvoyer vers l'administrateur pour
  // une faute de frappe immobilisait le dossier sans rien protéger.
  //
  // Le garde-fou n'a pas disparu, il a changé de nature : passé le statut
  // « Créée », le serveur EXIGE UN MOTIF, inscrit au journal d'audit
  // (`exigerMotifSiAvancee`). Le champ correspondant apparaît alors à l'écran.
  // Les autres rôles n'ont toujours que la correction de plaque, rendue plus bas.
  const peutTtEditer = role === A || role === ROLES.CFS;

  return (
    <div>
      <BoutonRetour retour={retour} ecranPrecedent={ecranPrecedent} secours={() => go('list')} />
      <FicheCargaison c={c} groupes={groupes} />
      <ToutesLesInformations c={c} />
      <HistoriqueCargaison c={c} />
      <CarteConteneurs c={c} dets={dets} groupes={groupes} />

      <Timeline c={c} />

      {/* Panneaux d'action selon rôle × étape */}
      {/* Sortie Magasin/MAD : pas de conteneurs — on ne « finalise » que les
          scellés du camion (vrac). Les autres opérations passent par PanneauCFS. */}
      {c['typeOperation'] !== OPERATIONS.MAGASIN
        && (c['statut'] === STATUTS.CAMION || c['statut'] === STATUTS.CHARGEMENT || (c['statut'] === STATUTS.CREEE && binomePossible)) && can(ROLES.CFS, A) &&
        <PanneauCFS c={c} dets={dets} action={action} prefillDecl={a.prefillDecl} />}
      {c['typeOperation'] === OPERATIONS.MAGASIN && c['statut'] === STATUTS.CHARGEMENT && can(ROLES.CFS, A) &&
        <FinaliserMagasin id={id} action={action} />}
      {c['statut'] === STATUTS.VEHICULE_OUILLAGE && can(ROLES.CFS, A) && <PanneauOuillage c={c} action={action} />}
      {pend.includes('VALIDATION') && can(ROLES.CHEF_BRIGADE, ROLES.CBPI, A) && <PanneauValidation c={c} action={action} />}
      {pend.includes('T1') && can(ROLES.T1, A) && <PanneauT1 c={c} dets={dets} action={action} />}
      {pend.includes('BALISE') && can(ROLES.BALISE, A) && !estVeh && <PanneauBalise c={c} action={action} />}
      {pend.includes('BS') && can(ROLES.BON_SORTIE, A) && <PanneauBS c={c} dets={dets} action={action} />}
      {pend.includes('PP') && can(ROLES.PP, A) && <PanneauPP c={c} estVeh={estVeh} action={action} />}
      {c['statut'] === STATUTS.GPS && can(ROLES.BALISE, A) && <PanneauGpsEdit c={c} action={action} />}
      {/* CORRECTIONS DE CELLULES REMPLIES (2026-09-10) — ajout.
          Chaque cellule corrige la sienne, l'ADMIN corrige partout. Le panneau
          n'apparaît QUE si la cellule est déjà renseignée : avant, c'est la
          saisie normale qui s'affiche, et corriger n'aurait aucun sens. */}
      {!!c['dateT1'] && can(ROLES.T1, A) && <PanneauT1Edit c={c} dets={dets} action={action} />}
      {!!c['dateBonSortie'] && can(ROLES.BON_SORTIE, A) && <PanneauBSEdit c={c} action={action} />}
      {c['suiviEngagement'] === true && !c['engagementEffectueLe']
        && can(ROLES.CHEF_BRIGADE, ROLES.CHEF_BRIGADE_ADJOINT, ROLES.CHEF_VISITE, ROLES.CHEF_DIVISION, A)
        && <PanneauEngagementEdit c={c} action={action} />}
      {c['statut'] === STATUTS.SORTIE && (String(c['baliseRequise']) === 'Non' || estOui(c['sauteBalise'])) && !estOui(c['arriveeBureau']) && can(ROLES.BALISE, A) &&
        <div className="card"><TitrePanneau icone="drapeau" etape="balise">Dispense — arrivée au bureau</TitrePanneau>
          <button onClick={() => action(() => call('cargo.arriveebureau', { id }), 'Arrivée confirmée.')}>Confirmer l'arrivée (solder la dispense)</button></div>}
      {!estVeh && c['statut'] !== STATUTS.SORTIE && can(ROLES.CFS, A) && <PanneauEtatCFS c={c} action={action} />}

      {/* v4 — enchaîner un autre camion sur la même déclaration : enlèvement,
          dépotage ET sortie Magasin/MAD (v4.1). */}
      {[OPERATIONS.DEPOTAGE, OPERATIONS.ENLEVEMENT, OPERATIONS.MAGASIN].includes(c['typeOperation'] as never) && can(ROLES.CFS, A) && !!c['numeroDeclaration'] &&
        <AjouterCamion c={c} go={go} />}
      {/* v4 — Éditer : le CFS a la main JUSQU'À la fin de chargement ; l'ADMIN toujours. */}
      {peutTtEditer
        ? <PanneauEditer c={c} dets={dets} action={action} apresSuppression={quitter} admin={role === A} />
        /* 2026-09-12 — décision utilisateur : la correction de plaque est de
           nouveau ouverte à TOUS les rôles (permission serveur alignée). */
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
  // Pastille d'en-tête : camion ou véhicule selon la nature du dossier. Elle
  // donne à la fiche le même repère visuel que les tuiles et le parcours.
  const pastille = estOui(c['estVehicule']) ? 'voiture' : 'camion';
  return <div className="card fiche-tete" style={{ marginTop: 10 }}>
    <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
      <div className="row" style={{ gap: 12, flexWrap: 'nowrap', alignItems: 'center' }}>
        <span className="tete-pastille" aria-hidden="true"><Icone nom={pastille} taille={22} /></span>
        <div>
          <h2 style={{ margin: 0 }}>{(c['numeroCamion'] as string) || '—'}</h2>
          <div className="help mono" style={{ marginTop: 2 }}>{c['id'] as string}{c['rapportId'] ? ` · rapport ${String(c['rapportId'])}` : ''}</div>
        </div>
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
      {/* Suivi des engagements (2026-09-10) — renseigné à la validation.
          `null` n'est PAS « Non » : il désigne les cargaisons validées avant
          l'existence du champ. On n'affiche donc rien pour celles-là, plutôt que
          d'affirmer une absence de suivi qui n'a jamais été constatée. */}
      {c['suiviEngagement'] === true || c['suiviEngagement'] === false
        ? <div className="kv"><b>Engagement</b>{c['suiviEngagement'] === true
          ? ((c['engagementType'] as string) || 'Oui')
          : 'Aucun'}</div>
        : null}
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
  if (!dets.conteneurs.length) {
    // Sortie Magasin/MAD : vrac sans conteneur — on n'a que les scellés du camion.
    if (c['typeOperation'] === OPERATIONS.MAGASIN && dets.scellesCamion.length) return <div className="card">
      <TitrePanneau icone="camion" etape="cfs">Camion</TitrePanneau>
      <div className="kv"><b>Scellés camion</b>{dets.scellesCamion.join(' · ')}</div>
    </div>;
    return null;
  }
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
    <TitrePanneau icone="conteneur" etape="cfs">Conteneurs ({dets.conteneurs.length})</TitrePanneau>
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
      {dets.conteneurs.length > 0 && <PanneauEditConteneurs c={c} dets={dets} action={action} admin={admin} />}
      {/* v4.1 — plus conditionné à la présence d'un n° de déclaration : sans
          celui-ci le panneau disparaissait, et un camion dont la déclaration
          manquait ne pouvait plus jamais en recevoir une par la correction. */}
      <PanneauEditDecl c={c} action={action} admin={admin} />
      {/* 2026-09-11 — le bloc « Éditer » est maintenant ouvert au CFS à toute
          étape (pour la déclaration). Le TYPE D'OPÉRATION, lui, garde son verrou
          serveur : le changer après le T1 ou après signature est refusé. On
          masque donc le panneau quand il ne pourrait que refuser, plutôt que
          d'offrir un bouton qui échoue à tous les coups. */}
      {estCamionOp && (admin || (!c['dateValidation']
        && [STATUTS.CAMION, STATUTS.CHARGEMENT, STATUTS.CREEE].includes(c['statut'] as never)))
        && <PanneauEditType c={c} action={action} />}
      <PanneauEditCamion c={c} action={action} />
      {/* Apurement : le CFS CORRIGE (c'est lui qui saisit les déclarations et
          constate les écarts) ; seul l'ADMIN peut SUPPRIMER une ligne.
          Pas de condition ici : ce panneau n'est rendu qu'à l'intérieur de
          « Éditer la cargaison », déjà réservé à l'ADMIN et au CFS. */}
      <PanneauApurement c={c} admin={admin} />
      {admin && <PanneauSupprimer c={c} apresSuppression={apresSuppression} />}
    </div>
  </details>;
}

/**
 * v4 — Annulation d'un doublon de cargaison (ADMIN uniquement).
 * SEC-12 : la cargaison n'est plus effacée mais marquée annulée, et le MOTIF est
 * obligatoire — sans lui, l'historique dit qu'une pièce a été retirée mais pas
 * pourquoi, ce qui ne vaut rien lors d'un contrôle.
 */
function PanneauSupprimer({ c, apresSuppression }: { c: O; apresSuppression: () => void }) {
  const id = c['id'] as string;
  const [busy, setBusy] = useState(false);
  const [motif, setMotif] = useState('');
  const valide = !!c['dateValidation'];
  const sortie = c['statut'] === STATUTS.SORTIE;

  async function supprimer() {
    /* AVERTISSEMENT AVANT RETRAIT (2026-09-10).
     *
     * Il ne se contente plus d'annoncer « elle disparaîtra » : il ÉNUMÈRE ce qui
     * sera retiré, camion par camion. Un avertissement vague se clique sans être
     * lu ; celui-ci nomme les conséquences, et se durcit quand la cargaison est
     * déjà validée ou sortie — les deux cas que le serveur bloquait autrefois et
     * qu'il autorise désormais à l'ADMIN. */
    const engagee = [valide && 'VALIDÉE ET SIGNÉE par le chef de brigade', sortie && 'DÉJÀ SORTIE du port sec']
      .filter(Boolean).join('\n  · ');

    const avertissement =
      `⚠ ANNULATION DE LA CARGAISON ${id}\n`
      + `Camion : ${String(c['numeroCamion'] || '—')}\n`
      + (engagee ? `\n⚠ ATTENTION — cette cargaison est :\n  · ${engagee}\n` : '')
      + `\nCe camion sera retiré de TOUT le système :\n`
      + `  · les listes, la recherche et le détail\n`
      + `  · tous les rapports, statistiques et compteurs\n`
      + `  · l'apurement de sa déclaration, qui sera rendu\n`
      + `  · ses conteneurs de stock, qui repassent « En stock »\n`
      + `\nLa pièce reste conservée en base pour un contrôle douanier,\n`
      + `et l'opération est inscrite au journal d'audit — elle ne peut\n`
      + `pas être effacée.\n`
      + `\nMotif enregistré : ${motif.trim()}\n`
      + `\nConfirmer ?`;

    if (!window.confirm(avertissement)) return;
    setBusy(true);
    try {
      await call('cargo.delete', { id, motif });
      toast('Cargaison annulée.', 'ok');
      apresSuppression(); // la fiche sort des listes : on repart d'où l'on venait
    } catch (e) { toast((e as Error).message, 'err'); } finally { setBusy(false); }
  }
  return <details style={EDIT_ITEM}><summary style={{ cursor: 'pointer', fontWeight: 600, color: 'var(--warn)' }}>Annuler cette cargaison (doublon) — ADMIN</summary>
    <p className="help" style={{ marginTop: 10 }}>
      Réservé à l'administrateur. La cargaison et ses conteneurs sont <b>conservés en
      base</b> (on ne détruit pas une écriture douanière) mais sortent des listes, des
      rapports et de tous les compteurs ; le stock est libéré et l'apurement rendu.
      Action tracée dans l'historique, de façon ineffaçable.
    </p>
    {(valide || sortie) && <p className="help" style={{ color: 'var(--warn)', fontWeight: 600 }}>
      ⚠ Cette cargaison est {valide ? 'validée et signée' : ''}{valide && sortie ? ' et ' : ''}{sortie ? 'déjà sortie' : ''}.
      Son annulation reste possible, mais elle sera signalée comme telle au journal.
    </p>}
    <label className="help">Motif de l'annulation (obligatoire)</label>
    <input value={motif} onChange={(e) => setMotif(e.target.value)} placeholder="ex. doublon du camion AB1234 saisi deux fois le 12/08" />
    <button className="ghost" disabled={busy || !motif.trim()} style={{ color: 'var(--warn)', marginTop: 8 }} onClick={supprimer}>Annuler cette cargaison</button>
  </details>;
}

/** Icône de chaque poste du parcours — mêmes dessins que le reste de l'application. */
const ICONE_ETAPE_PARCOURS: Record<string, string> = {
  cfs: 'camion', validation: 'valider', t1: 't1',
  balise: 'balise', bs: 'bonSortie', pp: 'sortie',
};

/**
 * TITRE DE PANNEAU AVEC PASTILLE — 2026-09-11.
 *
 * Chaque bloc d'action de la fiche porte l'icône de son poste, dans la teinte
 * de l'étape — les mêmes que sur les tuiles du tableau de bord et sur le
 * parcours. Sur une fiche qui empile huit à dix cartes, la pastille dit d'un
 * coup d'œil de quelle cellule on parle, avant qu'on ait lu le titre.
 */
export function TitrePanneau({ icone, etape, children }: { icone: string; etape?: string; children: React.ReactNode }) {
  return <h2 className={`titre-panneau ${etape ? 'et-' + etape : ''}`}>
    <span className="tp-pastille" aria-hidden="true"><Icone nom={icone} taille={17} /></span>
    {children}
  </h2>;
}

function Timeline({ c }: { c: O }) {
  const pp = c['statut'] === STATUTS.SORTIE;
  // CASCADE DESCENDANTE (cf. workflow.ts / etatCellules) : la validation chef
  // brigade est RÉPUTÉE acquise dès que le T1 est saisi ou que le camion est
  // sorti ; le bon de sortie est réputé acquis dès la sortie. Aucune signature
  // n'est fabriquée — c'est un état déduit, signalé « (réputée) » ci-dessous.
  const valideReel = !!c['dateValidation'];
  const bsReel = estOui(c['sauteBS']) || estOui(c['sauteBs']) || !!c['bonSortieNumero'];
  const e = {
    cfs: c['statut'] !== STATUTS.CAMION && c['statut'] !== STATUTS.CHARGEMENT && c['statut'] !== STATUTS.VEHICULE_OUILLAGE,
    // T1 sauté par nature pour les types hors transit (C/A), même si le flag
    // `sauteT1` n'a pas été persisté — cf. workflow.ts / etatCellules.
    valide: valideReel || !!c['dateT1'] || pp, t1: estOui(c['sauteT1']) || estTypeSansT1(c['typeDeclaration']) || !!c['dateT1'],
    balise: estOui(c['sauteBalise']) || estOui(c['estVehicule']) || !!c['datePoseGps'],
    // `sauteBs` (camelCase de la colonne) ET `sauteBS` (payload client) — cf. workflow.ts.
    bs: bsReel || pp, pp,
  };
  /* 4ᵉ champ (2026-09-11) : la CLÉ D'ÉTAPE. Elle apporte à la fois la couleur
     (`--etape-*`) et l'icône — les mêmes que sur les tuiles du tableau de bord.
     Une seule table de correspondance pour toute l'application : le parcours ne
     peut pas montrer un vert là où le tableau de bord montre un indigo. */
  const steps: [boolean, string, string, string][] = [
    [e.cfs, 'CFS — chargement', c['agentCfs'] ? `${c['agentCfs']}` : '', 'cfs'],
    [e.valide, 'Validation chef brigade',
      // Traçabilité CBPI : on nomme le signataire ET, s'il a signé par intérim,
      // on le signale explicitement (« par intérim »).
      c['agentValidation'] ? `${c['agentValidation']}${c['roleValidation'] === ROLES.CBPI ? ' (par intérim)' : ''} · ${fmtDate(c['dateValidation'])}`
        : (e.valide && !valideReel ? 'réputée (T1/sortie effectué)' : ''), 'validation'],
    [e.t1, (estOui(c['sauteT1']) || estTypeSansT1(c['typeDeclaration'])) && !c['dateT1'] ? 'T1 (sauté)' : 'T1', c['agentT1'] ? `${c['agentT1']} · ${fmtDate(c['dateT1'])}` : '', 't1'],
    [e.balise, estOui(c['estVehicule']) || estOui(c['sauteBalise']) ? 'Balise (sautée)' : (c['numeroGps'] ? 'Balisé' : 'Balise/Dispense'), c['datePoseGps'] ? `${c['agentBalise']} · ${fmtDate(c['datePoseGps'])}` : '', 'balise'],
    [e.bs, (estOui(c['sauteBS']) || estOui(c['sauteBs'])) ? 'Bon de sortie (sauté)' : 'Bon de sortie',
      c['dateBonSortie'] ? `${c['agentBonSortie']} · ${fmtDate(c['dateBonSortie'])}`
        : (e.bs && !bsReel ? 'réputé (sortie effectuée)' : ''), 'bs'],
    [e.pp, 'Sortie (PP)', c['dateSortie'] ? `${c['agentPp']} · ${fmtDate(c['dateSortie'])}` : '', 'pp'],
  ];
  // Cargaison clôturée : une étape non faite ne le sera plus → on l'affiche
  // explicitement « Non effectué » (traçabilité) au lieu d'un simple « en attente ».
  const sorti = e.pp;
  return <div className="card"><TitrePanneau icone="flux">Parcours</TitrePanneau><div className="timeline">
    {steps.map(([done, t, d, etape], i) => {
      const manque = !done && sorti;
      // L'étape COURANTE : la première encore à faire sur un dossier vivant.
      // Elle seule bat — un parcours où tout clignote ne désigne plus rien.
      const courante = !done && !sorti && steps.slice(0, i).every(([f]) => f);
      return (
        <div key={i} className={`tl ${done ? 'done' : 'wait'} ${manque ? 'manque' : ''} ${courante ? 'courante' : ''} et-${etape}`}>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
            <div className="dot"><Icone nom={ICONE_ETAPE_PARCOURS[etape] ?? 'camion'} taille={15} /></div>
            {i < steps.length - 1 && <div className="bar" />}
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

/**
 * v4.2 — État d'un conteneur DANS LE PARC, affiché sous le champ de saisie.
 *
 * Répond au cas réel signalé par le CFS : « il y a des positionnements dans la
 * journée ; quand on fait le pointage matinal et qu'on part, ils viennent encore
 * ajouter des conteneurs. Du coup, quand on veut les mettre en dépotage, on ne
 * les voit pas et on utilise la saisie manuelle. »
 *
 * La saisie manuelle est justement ce qu'il faut éviter : elle ne rattache pas
 * le conteneur à sa fiche stock. On dit donc ce qui se passe réellement, et on
 * propose l'action juste.
 */
function EtatConteneurParc({
  fiche, cherche, estEnl, manuel, regulariser, setRegulariser, activerManuel,
}: {
  fiche: O | null; cherche: boolean; estEnl: boolean; manuel: boolean;
  regulariser: boolean; setRegulariser: (v: boolean) => void; activerManuel: () => void;
}) {
  /* INDICATION DE LA SAISIE MANUELLE — 2026-09-12, règles du douanier.
   *
   * L'ancien texte « le conteneur ne sera pas rattaché à une fiche du parc »
   * n'est plus vrai : en dépotage, une fiche est désormais créée pour un
   * conteneur absent. Il disait aussi à l'agent ce que le logiciel NE FAIT PAS,
   * au lieu de lui dire QUAND s'en servir — d'où trois blocages en une journée. */
  if (manuel) return <div className="help" style={{ marginTop: 6 }}>
    <b>Saisie manuelle</b> — à réserver à deux cas :
    <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
      <li>le conteneur est <b>absent du parc</b> — sa fiche sera créée et pointée à votre nom ;</li>
      <li>il est <b>déjà rattaché</b> à un autre camion (marchandise partagée) — il ne sera
        compté qu'une fois dans les statistiques.</li>
    </ul>
    S'il est <b>au parc sans avoir été pointé</b>, décochez : il faut le pointer.
  </div>;
  if (cherche) return <p className="help" style={{ marginTop: 6 }}>Recherche dans le parc…</p>;
  if (!fiche) return null;

  const enc = (fond: string, bord: string): React.CSSProperties => ({
    marginTop: 8, padding: '8px 10px', borderRadius: 6,
    background: fond, border: `1px solid ${bord}`, fontSize: 13,
  });

  /* Absent du parc.
   *
   * En ENLÈVEMENT, la saisie manuelle reste l'issue : le conteneur part scellé
   * et peut n'être jamais passé par le parc.
   *
   * En DÉPOTAGE, elle n'existe plus (2026-09-10) : tout conteneur dépoté au port
   * sec a été acheminé sur le site de la PIA, donc il doit figurer au stock. Un
   * conteneur absent est soit une erreur de numéro, soit un conteneur qu'on a
   * oublié de faire entrer — et c'est cela qu'il faut corriger, pas contourner. */
  if (!fiche['existe']) return <div style={enc('#fff7ed', '#fdba74')}>
    <b>Conteneur absent du parc.</b> Il n'a pas été importé ni annoncé.
    {estEnl
      ? <> S'il s'agit d'un conteneur partagé ou arrivé hors circuit, cochez
        « saisie manuelle » ; sinon vérifiez le numéro.
        <div style={{ marginTop: 6 }}><button className="ghost xs" onClick={activerManuel}>Passer en saisie manuelle</button></div></>
      : <> Or tout conteneur dépoté au port sec est présent au parc. <b>Vérifiez le
        numéro</b> ; s'il est bien sur le site, faites-le entrer par « Stock initial
        — import » ou « Pointage matinal », puis revenez ici.</>}
  </div>;

  // Déjà dépoté : c'est une erreur de numéro, ou un doublon.
  if (fiche['depote']) return <div style={enc('#fef2f2', '#fca5a5')}>
    <b>Conteneur déjà dépoté</b>{fiche['cargaisonId'] ? <> sur la cargaison <b>{String(fiche['cargaisonId'])}</b></> : null}.
    Vérifiez le numéro : un conteneur ne se dépote qu'une fois.
  </div>;

  // Au parc et pointé positionné : rien à signaler.
  if (!fiche['aRegulariser']) return <div style={enc('#f0fdf4', '#86efac')}>
    Conteneur au parc, <b>positionné</b>
    {fiche['datePointage'] ? <> — pointé le {String(fiche['datePointage']).slice(0, 10)}{fiche['pointePar'] ? ` par ${String(fiche['pointePar'])}` : ''}</> : null}
    {fiche['pointeAujourdhui'] ? ' (aujourd\'hui).' : '.'}
  </div>;

  // LE CAS VISÉ : présent au parc, jamais pointé comme positionné au CFS.
  if (estEnl) return <div style={enc('#f0fdf4', '#86efac')}>
    Conteneur au parc — statut <b>{String(fiche['statut'])}</b>. Enlèvement : rien à pointer.
  </div>;

  return <div style={enc('#fffbeb', '#fcd34d')}>
    <b>Ce conteneur est au parc mais n'a pas été pointé comme positionné au CFS.</b>
    <div style={{ marginTop: 4 }}>
      Statut actuel : <b>{String(fiche['statut'])}</b>
      {fiche['dateEntree'] ? <> · entré le {String(fiche['dateEntree']).slice(0, 10)}</> : null}.
      C'est le cas typique d'un conteneur positionné <i>après</i> le pointage matinal.
    </div>
    <label className="help" style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 }}>
      <input type="checkbox" style={{ width: 'auto' }} checked={regulariser} onChange={(e) => setRegulariser(e.target.checked)} />
      <span>Le pointer maintenant et poursuivre le dépotage</span>
    </label>
    <div className="help" style={{ marginTop: 4 }}>
      Préférez ceci à la saisie manuelle : le conteneur restera rattaché à sa fiche
      de parc, et le pointage sera tracé au nom de l'agent.
    </div>
  </div>;
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

  /* v4.2 — LE CONTENEUR EST AU PARC MAIS N'A PAS ÉTÉ POINTÉ.
   *
   * La liste ci-dessus ne contient que les conteneurs « Positionné ». Or le
   * pointage matinal fige la liste du jour, et des conteneurs continuent d'être
   * positionnés dans la journée : au dépotage, ils sont introuvables, et les
   * agents se rabattent sur « saisie manuelle » — qui ne rattache RIEN à la
   * fiche stock. Le conteneur reste « En stock » pour toujours et le parc
   * affiche des conteneurs partis depuis longtemps.
   *
   * On interroge donc tout le parc dès que le numéro est complet, et on dit à
   * l'agent ce qu'il en est. S'il est là mais non pointé, un bouton le pointe
   * et enchaîne — au lieu de le contourner. */
  const [fiche, setFiche] = useState<O | null>(null);
  const [cherche, setCherche] = useState(false);
  const [regulariser, setRegulariser] = useState(false);
  const numSaisi = String(f['num'] ?? '');

  useEffect(() => {
    if (!tcValide(numSaisi) || f['manuel']) { setFiche(null); setRegulariser(false); return; }
    let annule = false;
    setCherche(true);
    call<O>('stock.lookup', { numeroTC: numSaisi })
      .then((r) => { if (!annule) { setFiche(r); setRegulariser(false); } })
      .catch(() => { if (!annule) setFiche(null); })
      .finally(() => { if (!annule) setCherche(false); });
    return () => { annule = true; };
  }, [numSaisi, f['manuel']]);

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

  // Complète taille/type depuis la fiche du parc quand le conteneur n'est pas
  // dans la liste du jour (il n'a donc pas pu être pré-rempli plus haut).
  useEffect(() => {
    if (!fiche?.['existe']) return;
    setF((o) => ({
      ...o,
      taille: String(o['taille'] ?? '') || String(fiche['taille'] ?? ''),
      type: String(o['type'] ?? '') || String(fiche['typeConteneur'] ?? ''),
    }));
  }, [fiche]);
  const setDd = (k: string, v: unknown) => setD((o) => ({ ...o, [k]: v }));
  const montrerDecl = premier || !estEnl; // enlèvement 1er conteneur / dépotage : chaque conteneur
  const estConso = estTypeSansT1(d['typeDeclaration']); // C (conso) / A (admission) → saute le T1

  async function ajouter() {
    if (!tcValide(String(f['num']))) { toast('N° conteneur invalide (4 lettres + 7 chiffres).', 'err'); return; }
    const payload: O = { id, conteneur: { num: f['num'], taille: f['taille'], type: f['type'], poids: f['poids'], plomb: f['plomb'], manuel: f['manuel'] } };
    // v4.2 — confirmation explicite du pointage à la volée (le serveur refuse sans).
    if (regulariser) payload['pointerSiNonPositionne'] = true;
    if (montrerDecl && String(d['declarant']).trim()) { payload['declaration'] = d; if (estConso) payload['consoMode'] = consoMode; }
    await action(
      () => call('cargo.cfs', payload),
      regulariser ? 'Conteneur pointé et ajouté.' : 'Conteneur ajouté.',
    );
    set('num', ''); set('plomb', ''); set('taille', ''); set('type', '');
    setFiche(null); setRegulariser(false);
  }

  return (
    <div className="card">
      <TitrePanneau icone="conteneur" etape="cfs">CFS — associer / ajouter un conteneur</TitrePanneau>
      <p style={{ color: '#5c6b7a', marginTop: 0 }}>Opération : <b>{c['typeOperation'] as string}</b>. {estEnl ? 'Enlèvement : scellé par conteneur, déclaration au 1er.' : 'Dépotage : conteneurs du stock (Positionné), déclaration par conteneur, puis scellés camion.'}</p>
      <div className="grid2">
        <Champ label="N° conteneur (ISO 6346)" className="mono" value={String(f['num'])} onChange={(e) => choisirConteneur(e.target.value)} list="dl-cfs-tc" autoComplete="off" />
        <datalist id="dl-cfs-tc">{tcOptions.map((t) => <option key={t} value={t} />)}</datalist>
        <Champ label="Taille" value={String(f['taille'])} onChange={(e) => set('taille', masks.upper(e.target.value))} placeholder="20' / 40' / 45'" />
        <Champ label="Type (facultatif)" value={String(f['type'])} onChange={(e) => set('type', masks.upper(e.target.value))} />
        {estEnl && <Champ label="Scellé / Plomb" value={String(f['plomb'])} onChange={(e) => set('plomb', masks.upper(e.target.value))} />}
        {/* Dépotage : plus de saisie manuelle (2026-09-10) — tout conteneur dépoté
            au port sec est au parc et doit être pointé. La case ne subsiste qu'en
            ENLÈVEMENT, où le conteneur part scellé sans forcément passer par le parc. */}
        {estEnl && <label className="help" style={{ alignSelf: 'end' }}><input type="checkbox" style={{ width: 'auto' }} checked={!!f['manuel']} onChange={(e) => set('manuel', e.target.checked)} /> Saisie manuelle (conteneur hors stock)</label>}
      </div>
      <div className="help" style={{ marginTop: 6 }}>{estEnl ? 'Enlèvement' : 'Dépotage'} : {tcOptions.length} conteneur(s) {estEnl ? 'en stock (PIA)' : 'positionné(s) du jour'} — tapez pour choisir.</div>
      <EtatConteneurParc
        fiche={fiche} cherche={cherche} estEnl={estEnl} manuel={!!f['manuel']}
        regulariser={regulariser} setRegulariser={setRegulariser}
        activerManuel={() => set('manuel', true)}
      />
      {montrerDecl && (
        <>
          <div className="section-title">Déclaration</div>
          {estConso && <p className="help" style={{ marginTop: 0 }}>{libelleTypeSansT1(d['typeDeclaration'])} : la cargaison <b>saute le T1</b>{consoMode === 'sansbalise' ? ' et la Balise (dispense)' : ' ; balise à poser'}.</p>}
          <div className="grid2">
            <Champ label="Déclarant" value={String(d['declarant'])} onChange={(e) => setDd('declarant', masks.upper(e.target.value))} />
            <Champ label="Contact (téléphone)" value={String(d['contactDeclarant'])} onChange={(e) => setDd('contactDeclarant', masks.tel(e.target.value))} />
            <ChampDestination value={String(d['destinationMarchandise'])} onChange={(v) => setDd('destinationMarchandise', v)} />
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
      {/* v4.1 (affiné 2026-07-22) — l'ENLÈVEMENT passe désormais SEUL en « Créée »
          à la saisie (scellés par conteneur = fin de chargement). Ce bouton n'est
          qu'un RATTRAPAGE pour les enlèvements restés « En cours de chargement »
          d'avant ce changement ; le flux normal ne l'affiche jamais. */}
      {estEnl && c['statut'] === STATUTS.CHARGEMENT && <FinirEnlevement c={c} action={action} />}
    </div>
  );
}

/**
 * v4.1 — RATTRAPAGE de fin de chargement (enlèvements bloqués « En cours de
 * chargement » avant le 2026-07-22, où l'enlèvement passe seul en « Créée »).
 * Ne s'affiche plus dans le flux normal.
 */
function FinirEnlevement({ c, action }: { c: O; action: ActionFn }) {
  const id = c['id'] as string;
  const conts = parseConteneursDetails(c['conteneursDetails']).conteneurs;
  const sansPlomb = conts.filter((ct) => !ct.plomb).length;
  const sansDecl = !String(c['numeroDeclaration'] ?? '').trim();
  const bloque = !conts.length || !!sansPlomb || sansDecl;
  return <div style={{ borderTop: '1px solid var(--line)', marginTop: 14, paddingTop: 12 }}>
    <div className="section-title">Terminer le chargement</div>
    <p className="help" style={{ marginTop: 0 }}>
      Ce camion d'enlèvement est resté « En cours de chargement ». Un clic le passe
      en « Créée » pour qu'il reparte dans le circuit.
    </p>
    {!conts.length && <div className="err-msg">Aucun conteneur : ajoutez-en au moins un.</div>}
    {!!sansPlomb && <div className="err-msg">{sansPlomb} conteneur(s) sans scellé — corrigez-les d'abord.</div>}
    {sansDecl && <div className="err-msg">Déclaration non renseignée.</div>}
    <div style={{ marginTop: 12 }}>
      <button disabled={bloque} onClick={() => action(() => call('cargo.fincharge', { id }), 'Chargement terminé.')}>
        Terminer le chargement → « Créée »
      </button>
    </div>
  </div>;
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
  const op = String(c['typeOperation'] ?? OPERATIONS.ENLEVEMENT);
  // v4.1 — la Sortie Magasin/MAD n'a PAS de conteneurs : le camion se crée en
  // une fois (comme le formulaire Magasin), pas en « camion vide + conteneurs ».
  const estMagasin = op === OPERATIONS.MAGASIN;
  async function creer() {
    if (!num) { toast('N° camion requis.', 'err'); return; }
    setBusy(true);
    try {
      if (estMagasin) {
        // Reprend la déclaration ; le choix « balise » suit le type de déclaration
        // du camion courant (type C non balisé = dispense déjà résolue).
        const consoMode = estOui(c['sauteBalise']) ? 'sansbalise' : 'balise';
        // Créée « En cours de chargement » : les scellés du camion se posent
        // ensuite sur la fiche (bouton « Finaliser la sortie »).
        const r = await call<{ camions: { id: string }[] }>('cargo.create', {
          typeOperation: OPERATIONS.MAGASIN, numeroCamion: num, declaration: prefillDe(c), consoMode, chargementTermine: false,
        });
        toast('Nouvelle sortie magasin créée (à finaliser : scellés).', 'ok');
        go('detail', r.camions[0]?.id);
      } else {
        const r = await call<{ id: string }>('cargo.createcamion', { numeroCamion: num, routage: op });
        toast('Nouveau camion créé.', 'ok');
        go('detail', { id: r.id, prefillDecl: prefillDe(c) });
      }
    } catch (e) { toast((e as Error).message, 'err'); } finally { setBusy(false); }
  }
  return <div className="card"><TitrePanneau icone="camionPlus" etape="cfs">Ajouter un autre camion (même déclaration)</TitrePanneau>
    <p className="help" style={{ marginTop: 0 }}>{estMagasin
      ? <>Crée une nouvelle <b>sortie Magasin / MAD</b> en reprenant la déclaration de ce camion (déclarant, n° de déclaration, marchandise) — vous n'aurez qu'à saisir le N° du camion.</>
      : <>Crée un nouveau camion de <b>{op.toLowerCase()}</b> en reprenant la déclaration de ce camion (déclarant, n° de déclaration, marchandise) — vous n'aurez qu'à saisir les conteneurs.</>}</p>
    <div className="row"><ChampCamion value={num} onChange={setNum} label="" />
      <button disabled={busy} onClick={creer}>{estMagasin ? 'Créer' : 'Créer et associer'}</button></div>
    {!estMagasin && <p className="help" style={{ marginBottom: 0 }}>Plusieurs camions d'un coup ? Utilisez l'écran « Plusieurs camions (1 déclaration) » du menu.</p>}
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

/**
 * v4.1 — Finaliser une SORTIE MAGASIN/MAD restée « En cours de chargement » :
 * poser les scellés du camion (2-3, comme en dépotage) → « Créée ». C'est
 * l'équivalent, pour le vrac sans conteneur, de la finalisation du dépotage.
 */
function FinaliserMagasin({ id, action }: { id: string; action: ActionFn }) {
  const [sc, setSc] = useState(['', '', '']);
  return <div className="card">
    <TitrePanneau icone="entrepot" etape="cfs">Finaliser la sortie (scellés camion)</TitrePanneau>
    <p className="help" style={{ marginTop: 0 }}>Cette sortie magasin est « En cours de chargement ». Posez les scellés du camion (2-3) pour terminer le chargement → « Créée ».</p>
    <div className="grid2">
      {[0, 1, 2].map((i) => <Champ key={i} label={`Scellé camion ${i + 1}${i < 2 ? ' *' : ''}`} value={sc[i]} onChange={(e) => setSc((a) => a.map((x, j) => j === i ? masks.upper(e.target.value) : x))} />)}
    </div>
    <div style={{ marginTop: 12 }}><button onClick={() => action(() => call('cargo.sceller', { id, scellesCamion: sc.filter(Boolean) }), 'Scellés posés — chargement terminé.')}>Poser les scellés → « Créée »</button></div>
  </div>;
}

function PanneauOuillage({ c, action }: { c: O; action: ActionFn }) {
  const id = c['id'] as string;
  const [d, setD] = useState<O>({ declarant: '', contactDeclarant: '', destinationMarchandise: '', bureauDeclaration: 'TG120', typeDeclaration: 'T', numeroDeclaration: '', anneeDeclaration: String(new Date().getFullYear()) });
  const setDd = (k: string, v: unknown) => setD((o) => ({ ...o, [k]: v }));
  return <div className="card"><TitrePanneau icone="voiture" etape="cfs">Ouillage — compléter la déclaration du véhicule</TitrePanneau>
    <div className="grid2">
      <Champ label="Déclarant" value={String(d['declarant'])} onChange={(e) => setDd('declarant', masks.upper(e.target.value))} />
      <Champ label="Contact" value={String(d['contactDeclarant'])} onChange={(e) => setDd('contactDeclarant', masks.tel(e.target.value))} />
      <ChampDestination value={String(d['destinationMarchandise'])} onChange={(v) => setDd('destinationMarchandise', v)} />
      <Champ label="Bureau" value={String(d['bureauDeclaration'])} onChange={(e) => setDd('bureauDeclaration', masks.upper(e.target.value))} />
      <div><label className="help">Type (seuls T et E → T1)</label><select value={String(d['typeDeclaration'])} onChange={(e) => setDd('typeDeclaration', e.target.value)}>{TYPES_DECLARATION.map((t) => <option key={t}>{t}</option>)}</select></div>
      <Champ label="N° déclaration" value={String(d['numeroDeclaration'])} onChange={(e) => setDd('numeroDeclaration', masks.upper(e.target.value))} />
      <Champ label="Année" value={String(d['anneeDeclaration'])} onChange={(e) => setDd('anneeDeclaration', e.target.value)} />
    </div>
    <div style={{ marginTop: 12 }}><button onClick={() => action(() => call('cargo.ouillagedecl', { id, declaration: d }), 'Déclaration enregistrée.')}>Enregistrer</button></div>
  </div>;
}

function PanneauValidation({ c, action }: { c: O; action: ActionFn }) {
  const id = c['id'] as string;
  const horsGab = estOui(c['horsGabarit']);
  // v4.3 — hors gabarit & surcharge = DÉPOTAGE uniquement (2026-08-19). En
  // enlèvement / véhicule / conso / magasin, pas de pesée : rien à cocher.
  const exigePesee = exigeControlePoids(c['typeOperation']);
  // v4.1 — pesée AVANT la signature : en surcharge OUI/NON ; si OUI, le poids (kg).
  const [enSurcharge, setEnSurcharge] = useState<'' | 'oui' | 'non'>('');
  const [poids, setPoids] = useState('');
  const pretPesee = !exigePesee || enSurcharge === 'non' || (enSurcharge === 'oui' && poids.trim() !== '');

  // Suivi des engagements (2026-09-10) — bloquant, sur toutes les opérations.
  // Le hook est partagé avec les deux écrans de validation en lot (lib/ui.tsx).
  const eng = useSuiviEngagement();

  return <div className="card"><TitrePanneau icone="valider" etape="validation">Validation — chef brigade</TitrePanneau>
    {horsGab && exigePesee && <p style={{ background: 'var(--warn-soft)', color: 'var(--warn)', padding: 10, borderRadius: 6 }}>⚠ Chargement <b>hors gabarit</b> ({(c['hauteurChargement'] as string) || '?'} m).</p>}
    {exigePesee ? <>
      <div className="section-title">Pesée</div>
      <div className="row" style={{ alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
        <label className="help" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <input type="radio" name={`surch-${id}`} style={{ width: 'auto' }} checked={enSurcharge === 'oui'} onChange={() => setEnSurcharge('oui')} /> En surcharge</label>
        <label className="help" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <input type="radio" name={`surch-${id}`} style={{ width: 'auto' }} checked={enSurcharge === 'non'} onChange={() => { setEnSurcharge('non'); setPoids(''); }} /> Hors surcharge</label>
        {enSurcharge === 'oui' && <Champ label="Poids en surcharge (kg)" value={poids} onChange={(e) => setPoids(e.target.value.replace(/[^0-9.,]/g, ''))} />}
      </div>
    </> : <p className="help" style={{ marginTop: 0 }}>Opération « {String(c['typeOperation'])} » : pas de pesée ni de hors gabarit (réservés au dépotage).</p>}
    {eng.champ}

    <p style={{ color: '#5c6b7a', marginTop: 10 }}>Votre validation (signature numérique) débloque les cellules T1 / Balise / Bon de sortie.</p>
    <button disabled={!pretPesee || !eng.pret}
      onClick={() => action(() => call('cargo.valider', {
        id,
        enSurcharge: enSurcharge === 'oui',
        poidsSurcharge: poids,
        ...eng.payload,
      }), 'Cargaison validée et signée.')}>
      Valider et signer
    </button>
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
  return <div className="card"><TitrePanneau icone="t1" etape="t1">Cellule T1</TitrePanneau>
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
  /* TROIS etats, et non plus un booleen (2026-09-12) : recliquer le bouton
     actif annule le choix, il faut donc pouvoir n'avoir RIEN de choisi. Le
     bouton de validation reste bloque tant que c'est le cas - sans quoi on
     enregistrerait une pose de balise par defaut, jamais decidee. */
  const [pose, setPose] = useState<'' | 'pose' | 'dispense'>('pose');
  const requise = pose === 'pose';
  const [t1ok, setT1ok] = useState(false);
  const [gps, setGps] = useState('');
  const [disp, setDisp] = useState('');
  return <div className="card"><TitrePanneau icone="balise" etape="balise">Cellule Balise</TitrePanneau>
    {/* La bascule et le choix segmente partagent la meme ligne ET le meme
        dessin : la case a cocher de 13 px, collee contre deux boutons a voyant,
        se lisait comme un residu de l'ancien formulaire. */}
    <div className="segmente">
      <BoutonBascule actif={t1ok} onChange={setT1ok} libelle="Numéro T1 correct" icone="document" />
    </div>
    <ChoixSegmente libelle="Pose balise ou dispense" valeur={pose}
      options={[{ valeur: 'pose', libelle: 'Pose balise', icone: 'balise' },
        { valeur: 'dispense', libelle: 'Dispense', icone: 'drapeau' }]}
      onChange={(v) => setPose(v as '' | 'pose' | 'dispense')} />
    {pose === '' ? <p className="help">Choisissez <b>Pose balise</b> ou <b>Dispense</b> pour continuer.</p>
      : requise ? <Champ label="N° balise GPS" value={gps} onChange={(e) => setGps(e.target.value)} />
        : <Champ label="N° autorisation de dispense" value={disp} onChange={(e) => setDisp(masks.upper(e.target.value))} />}
    <div style={{ marginTop: 12 }}><button disabled={pose === ''}
      onClick={() => action(() => call('cargo.gps', { id, baliseRequise: requise ? 'Oui' : 'Non', t1Correct: t1ok ? 'Oui' : 'Non', numeroGPS: gps, numeroDispense: disp }), requise ? 'Balise posée.' : 'Dispense enregistrée.')}>Valider la balise</button></div>
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
  return <div className="card"><TitrePanneau icone="bonSortie" etape="bs">Cellule Bon de Sortie</TitrePanneau>
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
  return <div className="card"><TitrePanneau icone="sortie" etape="pp">Sortie — Porte Principale</TitrePanneau>
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
  return <div className="card"><TitrePanneau icone="balise" etape="balise">Corriger le N° de balise</TitrePanneau>
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
  const [motif, setMotif] = useState('');
  const inchange = !num.trim() || num.trim() === String(c['numeroCamion'] ?? '').trim();
  return <details className="card">
    <summary style={{ cursor: 'pointer', fontWeight: 700 }}>✎ Corriger le {libelle}</summary>
    <p className="help" style={{ marginTop: 8 }}>
      Rectifie une plaque mal saisie en amont. La correction suit le camion sur toute la fiche
      et sur ses conteneurs. <b>Le motif est obligatoire</b> et part à l'historique : c'est lui
      qui distingue une coquille d'une substitution de camion.
    </p>
    <div className="row">
      <ChampCamion value={num} onChange={setNum} label="" />
    </div>
    <input value={motif} onChange={(e) => setMotif(e.target.value)} style={{ marginTop: 8 }}
      placeholder="Motif : plaque illisible à l'entrée, erreur de frappe…" />
    <button className="ghost" style={{ marginTop: 8 }} disabled={inchange || !motif.trim()}
      onClick={() => action(() => call('cargo.editcamion', { id, numeroCamion: num, motif }), `${libelle} corrigé.`)}>
      Corriger
    </button>
  </details>;
}

function PanneauEtatCFS({ c, action }: { c: O; action: ActionFn }) {
  const id = c['id'] as string;
  const [etat, setEtat] = useState((c['etatSortie'] as string) || '');
  return <div className="card"><TitrePanneau icone="presse" etape="cfs">État du camion à la sortie de la zone CFS</TitrePanneau>
    <p className="help" style={{ marginTop: 0 }}>Traçabilité du parking : dans quel état le camion quitte la zone CFS. Sans rapport avec l'ajout de conteneurs ci-dessus.</p>
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
  const [motif, setMotif] = useState(''); // SEC-11 : motif obligatoire
  return <details style={EDIT_ITEM}><summary style={{ cursor: 'pointer', fontWeight: 600 }}>Corriger le N° de camion</summary>
    <div className="row" style={{ marginTop: 10 }}>
      <ChampCamion value={num} onChange={setNum} label="" />
    </div>
    <input value={motif} onChange={(e) => setMotif(e.target.value)} style={{ marginTop: 8 }}
      placeholder="Motif de la correction (obligatoire)" />
    <button className="ghost" style={{ marginTop: 8 }} disabled={!motif.trim()}
      onClick={() => action(() => call('cargo.editcamion', { id, numeroCamion: num, motif }), 'N° camion corrigé.')}>Corriger</button>
  </details>;
}

/**
 * v4 — CORRECTION d'un conteneur déjà enregistré (N° erroné, taille, type,
 * scellé) ou retrait de la ligne. Sans cet écran, une faute de frappe sur le
 * N° de conteneur restait définitive.
 */
function PanneauEditConteneurs({ c, dets, action, admin }: { c: O; dets: ReturnType<typeof parseConteneursDetails>; action: ActionFn; admin: boolean }) {
  const id = c['id'] as string;
  const estEnl = c['typeOperation'] === OPERATIONS.ENLEVEMENT;
  const [i, setI] = useState<number | null>(null);
  const [f, setF] = useState<O>({ num: '', taille: '', type: '', plomb: '', manuel: false });
  // v4.1 — déclaration PROPRE à la ligne (chargement mixte) : éditable ici, car
  // « Corriger les informations de déclaration » réécrit TOUS les conteneurs à
  // l'identique et écraserait le mixte.
  const [d, setD] = useState<O>({ numeroDeclaration: '', anneeDeclaration: '', bureauDeclaration: '', typeDeclaration: '' });
  // Motif exigé par le serveur dès que la cargaison a dépassé « Créée ».
  const [motif, setMotif] = useState('');
  const set = (k: string, v: unknown) => setF((o) => ({ ...o, [k]: v }));
  const setDd = (k: string, v: unknown) => setD((o) => ({ ...o, [k]: v }));
  const declDe = (ct: O) => [ct['numeroDeclaration'], ct['anneeDeclaration'], ct['bureauDeclaration'], ct['typeDeclaration']].filter(Boolean).join(' · ');

  function ouvrir(k: number) {
    const ct = dets.conteneurs[k]! as unknown as O;
    setI(k);
    setF({ num: ct['num'] ?? '', taille: ct['taille'] ?? '', type: ct['type'] ?? '', plomb: ct['plomb'] ?? '', manuel: false });
    setD({
      numeroDeclaration: String(ct['numeroDeclaration'] ?? c['numeroDeclaration'] ?? ''),
      anneeDeclaration: String(ct['anneeDeclaration'] ?? c['anneeDeclaration'] ?? ''),
      bureauDeclaration: String(ct['bureauDeclaration'] ?? c['bureauDeclaration'] ?? ''),
      typeDeclaration: String(ct['typeDeclaration'] ?? c['typeDeclaration'] ?? ''),
    });
  }
  async function corriger() {
    if (i === null) return;
    await action(() => call('cargo.editconteneur', { id, index: i, ...f, declaration: d, motif }), 'Conteneur corrigé.');
    setI(null);
  }
  async function retirer(k: number) {
    const ct = dets.conteneurs[k]!;
    if (!confirm(`Retirer le conteneur ${ct.num} de ce camion ?`)) return;
    await action(() => call('cargo.editconteneur', { id, index: k, supprimer: true, motif }), 'Conteneur retiré.');
    setI(null);
  }

  return <details style={EDIT_ITEM}><summary style={{ cursor: 'pointer', fontWeight: 600 }}>Corriger un conteneur (N°, taille, scellé, déclaration)</summary>
    <p className="help" style={{ marginTop: 10 }}>Le conteneur retiré ou remplacé <b>revient au stock</b> et redevient sélectionnable ; le nouveau lui est rattaché.
      La déclaration se corrige <b>ligne par ligne</b> : un camion peut porter des conteneurs de plusieurs déclarations.</p>
    {dets.conteneurs.map((ct, k) => <div key={k} className="row" style={{ alignItems: 'center', marginBottom: 6 }}>
      <span style={{ flex: 1 }}>
        <span className="mono">{k + 1}. {ct.num} · {ct.taille || '—'}{ct.plomb ? ` · scellé ${ct.plomb}` : ''}</span>
        <span className="help"> — décl. {declDe(ct as unknown as O) || '(celle du camion)'}</span>
      </span>
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
        {estEnl && <label className="help" style={{ alignSelf: 'end' }}><input type="checkbox" style={{ width: 'auto' }} checked={!!f['manuel']} onChange={(e) => set('manuel', e.target.checked)} /> Saisie manuelle (conteneur hors stock / partagé)</label>}
      </div>
      <div className="section-title" style={{ marginTop: 12 }}>Déclaration de CE conteneur</div>
      <p className="help" style={{ marginTop: 0 }}>Laissez un champ vide pour ne pas y toucher. Le déclarant et la marchandise restent portés par le camion.</p>
      <div className="grid2">
        <Champ label="N° déclaration" value={String(d['numeroDeclaration'])} onChange={(e) => setDd('numeroDeclaration', masks.upper(e.target.value))} />
        <Champ label="Année" value={String(d['anneeDeclaration'])} onChange={(e) => setDd('anneeDeclaration', e.target.value)} />
        <Champ label="Bureau" value={String(d['bureauDeclaration'])} onChange={(e) => setDd('bureauDeclaration', masks.upper(e.target.value))} />
        <div><label className="help">Type déclaration</label>
          <select value={String(d['typeDeclaration'])} onChange={(e) => setDd('typeDeclaration', e.target.value)}>
            <option value="">— inchangé —</option>{TYPES_DECLARATION.map((t) => <option key={t}>{t}</option>)}
          </select></div>
      </div>
      <ChampMotifCorrection c={c} motif={motif} setMotif={setMotif} admin={admin} />
      <div className="row" style={{ marginTop: 12 }}>
        <button onClick={corriger}>Enregistrer la correction</button>
        <button className="ghost" onClick={() => setI(null)}>Annuler</button>
      </div>
    </div>}
  </details>;
}

/** v4 — Correction des informations de déclaration déjà enregistrées. */
/**
 * CHAMP « MOTIF » DES CORRECTIONS TARDIVES — 2026-09-11.
 *
 * N'apparaît QUE si la cargaison a dépassé le statut « Créée ». Avant, corriger
 * une saisie est un geste courant : réclamer un motif à chaque frappe serait du
 * bruit. Après, la correction touche un dossier en cours de parcours — le
 * serveur exige alors le motif, et il est inscrit au journal d'audit.
 *
 * Quand la cargaison est DÉJÀ VALIDÉE, l'avertissement le dit franchement : la
 * signature du chef couvre le numéro de déclaration, la corriger rend
 * l'empreinte non concordante. Ce n'est pas un interdit, c'est une conséquence
 * que celui qui corrige doit connaître avant d'appuyer.
 */
function ChampMotifCorrection({ c, motif, setMotif, admin }: { c: O; motif: string; setMotif: (v: string) => void; admin: boolean }) {
  const avancee = ![STATUTS.CAMION, STATUTS.CHARGEMENT, STATUTS.CREEE].includes(c['statut'] as never);
  if (!avancee) return null;
  return <div className="avis-signature" style={{ marginTop: 10 }}>
    <b>Cargaison déjà avancée</b> (statut « {String(c['statut'])} ») — le motif est{' '}
    {admin ? 'facultatif pour un administrateur, mais vivement conseillé' : 'obligatoire'}. Il sera
    inscrit au journal d'audit.
    {c['dateValidation'] ? <span className="detail">
      ⚠ Validée le {fmtDate(c['dateValidation'])} par {String(c['agentValidation'] ?? '—')}.
      La signature du chef couvre le numéro de déclaration : après correction, elle ne concordera plus.
    </span> : null}
    <input style={{ marginTop: 8 }} value={motif} placeholder="Motif de la correction"
      onChange={(e) => setMotif(e.target.value)} />
  </div>;
}

function PanneauEditDecl({ c, action, admin }: { c: O; action: ActionFn; admin: boolean }) {
  const id = c['id'] as string;
  const [d, setD] = useState<O>({
    declarant: String(c['declarant'] ?? ''), contactDeclarant: String(c['contactDeclarant'] ?? ''),
    destinationMarchandise: String(c['destinationMarchandise'] ?? ''), bureauDeclaration: String(c['bureauDeclaration'] ?? 'TG120'),
    typeDeclaration: String(c['typeDeclaration'] ?? 'T'), numeroDeclaration: String(c['numeroDeclaration'] ?? ''),
    anneeDeclaration: String(c['anneeDeclaration'] ?? ''), descriptionMarchandise: String(c['descriptionMarchandise'] ?? ''),
  });
  const [consoMode, setConsoMode] = useState('balise');
  const [motif, setMotif] = useState('');
  const setDd = (k: string, v: unknown) => setD((o) => ({ ...o, [k]: v }));
  const estConso = estTypeSansT1(d['typeDeclaration']);
  return <details style={EDIT_ITEM}><summary style={{ cursor: 'pointer', fontWeight: 600 }}>Corriger les informations de déclaration</summary>
    <p className="help" style={{ marginTop: 10 }}>Corrige le déclarant, la déclaration et la marchandise de ce camion
      et <b>de tous ses conteneurs</b>. Un champ laissé vide garde sa valeur actuelle.
      ⚠ Si le camion porte plusieurs déclarations (chargement mixte), passez plutôt par
      « Corriger un conteneur » : ici, toutes les lignes seraient ramenées à la même déclaration.</p>
    <div className="grid2">
      <Champ label="Déclarant" value={String(d['declarant'])} onChange={(e) => setDd('declarant', masks.upper(e.target.value))} />
      <Champ label="Contact (téléphone)" value={String(d['contactDeclarant'])} onChange={(e) => setDd('contactDeclarant', masks.tel(e.target.value))} />
      <ChampDestination value={String(d['destinationMarchandise'])} onChange={(v) => setDd('destinationMarchandise', v)} />
      <Champ label="Bureau" value={String(d['bureauDeclaration'])} onChange={(e) => setDd('bureauDeclaration', masks.upper(e.target.value))} />
      <div><label className="help">Type déclaration</label><select value={String(d['typeDeclaration'])} onChange={(e) => setDd('typeDeclaration', e.target.value)}>{TYPES_DECLARATION.map((t) => <option key={t}>{t}</option>)}</select></div>
      {estConso && <div><label className="help">Type {String(d['typeDeclaration'])} — balise</label><select value={consoMode} onChange={(e) => setConsoMode(e.target.value)}><option value="balise">À baliser</option><option value="sansbalise">Non balisée (dispense)</option></select></div>}
      <Champ label="N° déclaration" value={String(d['numeroDeclaration'])} onChange={(e) => setDd('numeroDeclaration', masks.upper(e.target.value))} />
      <Champ label="Année" value={String(d['anneeDeclaration'])} onChange={(e) => setDd('anneeDeclaration', e.target.value)} />
      <Champ label="Description marchandise" value={String(d['descriptionMarchandise'])} onChange={(e) => setDd('descriptionMarchandise', masks.upper(e.target.value))} />
    </div>
    <ChampMotifCorrection c={c} motif={motif} setMotif={setMotif} admin={admin} />
    <div style={{ marginTop: 12 }}><button onClick={() => action(() => call('cargo.editdecl', { id, declaration: d, consoMode, motif }), 'Déclaration corrigée.')}>Enregistrer la correction</button></div>
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

/* ============ CORRECTIONS DE CELLULES REMPLIES — ajout 2026-09-10 ==========
 *
 * Trois panneaux repliés (`<details>`), sur le modèle de `PanneauSupprimer` :
 * une correction n'est pas une saisie courante, elle ne doit pas s'imposer à
 * l'écran ni s'ouvrir par mégarde. Chacun affiche la valeur ACTUELLE avant de
 * proposer la nouvelle — corriger à l'aveugle, c'est écraser sans savoir quoi.
 * ========================================================================== */

/** Correction des numéros T1 déjà saisis (cellule T1 + ADMIN). */
function PanneauT1Edit({ c, dets, action }: { c: O; dets: ReturnType<typeof parseConteneursDetails>; action: ActionFn }) {
  const id = c['id'] as string;
  const estEnl = c['typeOperation'] === OPERATIONS.ENLEVEMENT;
  const actuels = Array.isArray(c['t1Numeros']) ? (c['t1Numeros'] as O[]) : [];
  const [bureau, setBureau] = useState((c['bureauDestination'] as string) || '');
  const [nums, setNums] = useState<string[]>(
    estEnl
      ? dets.conteneurs.map((ct) => String(actuels.find((x) => x['conteneur'] === ct.num)?.['numero'] ?? ''))
      : actuels.map((x) => String(typeof x === 'string' ? x : x['numero'] ?? '')),
  );

  async function enregistrer() {
    const t1Numeros = estEnl
      ? dets.conteneurs.map((ct, i) => ({ conteneur: ct.num, numero: nums[i] })).filter((x) => x.numero)
      : nums.filter(Boolean);
    await action(() => call('cargo.t1edit', { id, bureauDestination: bureau, t1Numeros }), 'T1 corrigé.');
  }

  return <details style={EDIT_ITEM}><summary style={{ cursor: 'pointer', fontWeight: 600 }}>Corriger le T1</summary>
    <p className="help" style={{ marginTop: 10 }}>
      Corrige une erreur de saisie. L'ancienne valeur est conservée dans l'historique.
      Le statut de la cargaison n'est pas modifié.
    </p>
    <Champ label="Bureau de destination" value={bureau} onChange={(e) => setBureau(masks.upper(e.target.value))} />
    <div className="section-title">Numéros T1 {estEnl ? '(1 par conteneur)' : ''}</div>
    {estEnl ? dets.conteneurs.map((ct, i) => (
      <div key={i} className="row" style={{ marginBottom: 6, alignItems: 'center' }}>
        <span className="mono" style={{ minWidth: 130 }}>{ct.num}</span>
        <input value={nums[i] ?? ''} onChange={(e) => setNums((o) => o.map((v, k) => k === i ? masks.upper(e.target.value) : v))} />
      </div>
    )) : nums.map((v, i) => (
      <input key={i} style={{ marginBottom: 6 }} value={v}
        onChange={(e) => setNums((o) => o.map((x, k) => k === i ? masks.upper(e.target.value) : x))} />
    ))}
    <button style={{ marginTop: 8 }} onClick={enregistrer}>Enregistrer la correction</button>
  </details>;
}

/** Correction du numéro de bon de sortie déjà émis (cellule BS + ADMIN). */
function PanneauBSEdit({ c, action }: { c: O; action: ActionFn }) {
  const id = c['id'] as string;
  const brut = c['bonSortieNumero'];
  // Deux formes historiques : chaîne unique (dépotage) ou liste (enlèvement).
  const liste = Array.isArray(brut) ? (brut as O[]) : null;
  const [simple, setSimple] = useState(liste ? '' : String(brut ?? ''));
  const [multi, setMulti] = useState<string[]>(liste ? liste.map((x) => String(x['numero'] ?? '')) : []);

  async function enregistrer() {
    const bonSortieNumero = liste
      ? liste.map((x, i) => ({ ...x, numero: multi[i] })).filter((x) => x['numero'])
      : simple.trim();
    await action(() => call('cargo.bsedit', { id, bonSortieNumero }), 'Bon de sortie corrigé.');
  }

  return <details style={EDIT_ITEM}><summary style={{ cursor: 'pointer', fontWeight: 600 }}>Corriger le bon de sortie</summary>
    <p className="help" style={{ marginTop: 10 }}>
      Corrige une erreur de saisie. L'ancienne valeur est conservée dans l'historique.
    </p>
    {liste
      ? liste.map((x, i) => <div key={i} className="row" style={{ marginBottom: 6, alignItems: 'center' }}>
        <span className="mono" style={{ minWidth: 130 }}>{String(x['conteneur'] ?? x['t1'] ?? '')}</span>
        <input value={multi[i] ?? ''} onChange={(e) => setMulti((o) => o.map((v, k) => k === i ? masks.upper(e.target.value) : v))} />
      </div>)
      : <Champ label="N° du bon de sortie" value={simple} onChange={(e) => setSimple(masks.upper(e.target.value))} />}
    <button style={{ marginTop: 8 }} onClick={enregistrer}>Enregistrer la correction</button>
  </details>;
}

/**
 * Correction d'un suivi d'engagement (chefs + ADMIN).
 *
 * ⚠ L'engagement entre dans l'empreinte de signature SEC-10. La signature du
 * chef n'est PAS recalculée : elle reste celle de ce qu'il a signé. L'écart
 * devient donc détectable — c'est voulu, et l'écran le dit.
 */
function PanneauEngagementEdit({ c, action }: { c: O; action: ActionFn }) {
  const id = c['id'] as string;
  const [type, setType] = useState((c['engagementType'] as string) || '');
  const [jours, setJours] = useState('');
  const [motif, setMotif] = useState('');
  const nouveauDelai = dateDansNJours(jours);

  async function enregistrer() {
    await action(() => call('cargo.engagementedit', {
      id, motif, engagementType: type,
      ...(nouveauDelai ? { engagementDelai: nouveauDelai } : {}),
    }), 'Engagement corrigé.');
  }

  return <details style={EDIT_ITEM}><summary style={{ cursor: 'pointer', fontWeight: 600 }}>Corriger le suivi d'engagement</summary>
    <p className="help" style={{ marginTop: 10 }}>
      Actuel : <b>{(c['engagementType'] as string) || '—'}</b> · échéance <b>{fmtDate(c['engagementDelai'])}</b>
    </p>
    <p className="help" style={{ color: 'var(--warn)' }}>
      ⚠ L'engagement fait partie de ce que le chef de brigade a signé. La signature
      n'est pas refaite : la correction restera visible lors d'un contrôle.
    </p>
    <label className="help">Engagement</label>
    <select value={type} onChange={(e) => setType(e.target.value)}>
      {!ENGAGEMENTS.includes(type as never) && type && <option value={type}>{type} (actuel)</option>}
      {ENGAGEMENTS.map((e) => <option key={e} value={e}>{e}</option>)}
    </select>
    <label className="help" style={{ marginTop: 6 }}>Nouveau délai en jours (laisser vide pour conserver l'échéance)</label>
    <div className="row" style={{ alignItems: 'center', gap: 8 }}>
      <input inputMode="numeric" style={{ maxWidth: 110 }} value={jours}
        onChange={(e) => setJours(e.target.value.replace(/[^0-9]/g, ''))} placeholder="Ex. 3" />
      {nouveauDelai ? <span style={{ fontWeight: 600 }}>→ {fmtDate(nouveauDelai)}</span> : null}
    </div>
    <label className="help" style={{ marginTop: 6 }}>Motif de la correction (obligatoire)</label>
    <input value={motif} onChange={(e) => setMotif(e.target.value)} placeholder="ex. délai renégocié avec le déclarant" />
    <button style={{ marginTop: 8 }} disabled={!motif.trim() || !type} onClick={enregistrer}>
      Enregistrer la correction
    </button>
  </details>;
}

/* ================ TOUTES LES INFORMATIONS — ajout 2026-09-10 ==============
 *
 * La fiche du haut est un RÉSUMÉ : neuf champs choisis pour être lus d'un coup
 * d'œil. Elle reste telle quelle. Ce bloc-ci ajoute l'intégralité de ce que
 * porte la cargaison, ancien comme récent, regroupé par cellule.
 *
 * DEUX PROPRIÉTÉS QUI COMPTENT :
 *
 *  1. RIEN N'EST OUBLIÉ. Les champs connus sont libellés et rangés ; tout champ
 *     NON PRÉVU ici atterrit dans « Autres informations » plutôt que d'être
 *     silencieusement ignoré. Une colonne ajoutée demain apparaîtra donc sans
 *     qu'on ait à y penser.
 *
 *  2. LA CONFIDENTIALITÉ EST AUTOMATIQUE. On affiche ce que le SERVEUR a
 *     envoyé. `filtrerConfidentiel` (lecture.ts) retire déjà le contact du
 *     déclarant, le n° de balise et le hors gabarit aux rôles qui n'y ont pas
 *     droit : ces champs n'arrivent pas, donc ne s'affichent pas. Aucune règle
 *     de droits n'est réécrite ici — elle serait la deuxième, donc celle qui
 *     finit par diverger.
 * ========================================================================== */

/** Libellés français des champs, groupés par cellule du parcours. */
const GROUPES_INFOS: [string, [string, string][]][] = [
  ['Identification', [
    ['id', 'Identifiant'], ['reference', 'Référence'], ['rapportId', 'N° de rapport'],
    ['numeroCamion', 'N° de camion'], ['typeOperation', 'Opération'], ['statut', 'Statut'],
    ['dateCreation', "Date d'entrée"], ['derniereMaj', 'Dernière modification'],
    ['twins', 'Binôme (twins)'], ['estVehicule', 'Véhicule'],
  ]],
  ['Déclaration', [
    ['declarant', 'Déclarant'], ['contactDeclarant', 'Contact'],
    ['numeroDeclaration', 'N° de déclaration'], ['anneeDeclaration', 'Année'],
    ['bureauDeclaration', 'Bureau'], ['typeDeclaration', 'Type'],
    ['destinationMarchandise', 'Destination'], ['descriptionMarchandise', 'Marchandise'],
    ['nbColis', 'Nombre de colis'], ['nbConteneurs', 'Nombre de conteneurs'],
    ['chargementMixte', 'Chargement mixte'], ['conteneurOrigine', "Conteneur d'origine"],
  ]],
  ['Entrée / CFS', [
    ['routageEntree', "Routage à l'entrée"], ['agentEntree', "Agent d'entrée"],
    ['agentCfs', 'Agent CFS'], ['observationsCfs', 'Observations CFS'],
    ['etatSortie', 'État à la sortie CFS'],
  ]],
  ['Validation — chef de brigade', [
    ['dateValidation', 'Date de validation'], ['agentValidation', 'Agent'],
    ['roleValidation', 'Rôle du signataire'], ['signatureValidation', 'Signature'],
    ['horsGabarit', 'Hors gabarit'], ['hauteurChargement', 'Hauteur du chargement'],
    ['enSurcharge', 'En surcharge'], ['poidsSurcharge', 'Poids en surcharge (kg)'],
    ['suiviEngagement', "Suivi d'engagement"], ['engagementType', 'Engagement'],
    ['engagementDelai', 'Échéance'], ['engagementEffectueLe', 'Informations transmises le'],
    ['engagementEffectuePar', 'Transmises par'],
  ]],
  ['Cellule T1', [
    ['dateT1', 'Date T1'], ['agentT1', 'Agent T1'], ['bureauDestination', 'Bureau de destination'],
    ['t1Numeros', 'Numéros T1'], ['observationsT1', 'Observations T1'],
    ['sauteT1', 'T1 sauté'],
  ]],
  ['Cellule Balise', [
    ['numeroGps', 'N° de balise'], ['datePoseGps', 'Date de pose'], ['agentBalise', 'Agent Balise'],
    ['baliseRequise', 'Balise requise'], ['numeroDispense', 'N° de dispense'],
    ['arriveeBureau', 'Arrivée au bureau'], ['dateArriveeBureau', "Date d'arrivée"],
    ['agentArriveeBureau', 'Agent (arrivée)'], ['observationsBalise', 'Observations Balise'],
    ['sauteBalise', 'Balise sautée'], ['t1Correct', 'T1 correct'],
  ]],
  ['Bon de sortie', [
    ['bonSortieNumero', 'N° de bon de sortie'], ['dateBonSortie', "Date d'émission"],
    ['agentBonSortie', 'Agent'], ['observationsBonSortie', 'Observations'],
    ['sauteBs', 'Bon de sortie sauté'], ['sauteBS', 'Bon de sortie sauté'],
  ]],
  ['Sortie — Porte Principale', [
    ['dateSortie', 'Date de sortie'], ['agentPp', 'Agent PP'],
    ['infosValidees', 'Informations validées'], ['ppChecklist', 'Liste de contrôle'],
    ['observationsPp', 'Observations PP'],
  ]],
  ['Véhicule / Ouillage', [
    ['vehiculeDetails', 'Détails du véhicule'],
    ['ouillageNumero', "N° d'ouillage"], ['ouillageDate', "Date d'ouillage"],
  ]],
  ['Annulation / Archivage', [
    ['annule', 'Annulée'], ['annuleLe', 'Annulée le'], ['annulePar', 'Annulée par'],
    ['annuleMotif', "Motif d'annulation"],
    ['archive', 'Archivée'], ['archiveLe', 'Archivée le'], ['archivePar', 'Archivée par'],
    ['archiveMotif', "Motif d'archivage"],
  ]],
];

/** Champs volumineux ou déjà présentés ailleurs sur la fiche : écartés du listing. */
const INFOS_EXCLUES = new Set([
  'conteneursDetails', // affiché par le tableau des conteneurs
  'mixteDetails', // idem, via les groupes de déclaration
  'agentCfsId', 'agentBaliseId', 'agentT1Id', 'agentPpId', 'agentValidationId',
  'agentBonSortieId', 'agentEntreeId', 'annuleParId', 'archiveParId',
]);

/** Rend une valeur quelconque de façon lisible, sans jamais afficher « [object Object] ». */
function valeurLisible(cle: string, v: unknown): string {
  if (v === null || v === undefined || v === '') return '—';
  if (typeof v === 'boolean') return v ? 'Oui' : 'Non';
  // Les dates se reconnaissent au NOM de la clé : plus sûr que de deviner au
  // contenu, un numéro de déclaration pouvant ressembler à une date.
  if (/^date|Le$|Date$/.test(cle) && typeof v === 'string') return fmtDate(v) || String(v);
  if (Array.isArray(v)) {
    if (!v.length) return '—';
    return v.map((x) => typeof x === 'object' && x
      ? Object.values(x as O).filter(Boolean).join(' · ')
      : String(x)).join(' , ');
  }
  if (typeof v === 'object') {
    const e = Object.entries(v as O).filter(([, x]) => x !== '' && x !== null && x !== undefined);
    if (!e.length) return '—';
    return e.map(([k, x]) => k + ' : ' + (typeof x === 'boolean' ? (x ? 'Oui' : 'Non') : String(x))).join(' · ');
  }
  return String(v);
}

/** camelCase inconnu → libellé lisible (« numeroTruc » devient « Numero truc »). */
const libelleDeCle = (k: string) =>
  k.replace(/([A-Z])/g, ' $1').replace(/^./, (m) => m.toUpperCase()).trim();

function ToutesLesInformations({ c }: { c: O }) {
  const vus = new Set<string>(INFOS_EXCLUES);
  const sections = GROUPES_INFOS.map(([titre, champs]) => {
    const lignes = champs
      .filter(([k]) => { const ok = k in c && !vus.has(k); vus.add(k); return ok; })
      .map(([k, label]) => [label, valeurLisible(k, c[k])] as [string, string]);
    return [titre, lignes] as [string, [string, string][]];
  }).filter(([, l]) => l.length > 0);

  // Tout ce que la carte des libellés ne connaît pas : jamais perdu.
  const autres = Object.keys(c)
    .filter((k) => !vus.has(k))
    .sort()
    .map((k) => [libelleDeCle(k), valeurLisible(k, c[k])] as [string, string]);
  if (autres.length) sections.push(['Autres informations', autres]);

  return <details className="card" style={{ marginTop: 10 }}>
    <summary style={{ cursor: 'pointer', fontWeight: 600 }}>
      Toutes les informations sur ce camion
    </summary>
    <p className="help" style={{ marginTop: 8 }}>
      L'intégralité des données enregistrées, regroupées par cellule. Les champs
      auxquels votre profil n'a pas accès ne sont pas transmis par le serveur et
      n'apparaissent donc pas ici.
    </p>
    {sections.map(([titre, lignes]) => <div key={titre} style={{ marginTop: 12 }}>
      <div className="section-title">{titre}</div>
      <div className="fiche">
        {lignes.map(([label, val]) => <div key={label} className="kv"><b>{label}</b>{val}</div>)}
      </div>
    </div>)}
  </details>;
}

/* ============ CORRECTION D'APUREMENT — ADMIN, ajout 2026-09-10 ============
 *
 * ⚠ C'EST UN COMPTEUR DOUANIER : déclarer qu'un nombre de conteneurs a été
 * dédouané. D'où un panneau replié, réservé à l'ADMIN, qui affiche l'état réel
 * AVANT de proposer quoi que ce soit — corriger à l'aveugle, c'est écraser sans
 * savoir quoi.
 *
 * Ce n'est PAS le chemin normal. Depuis la migration 00170, l'apurement se
 * corrige tout seul quand un conteneur est retiré, réaffecté, ou qu'une
 * cargaison est annulée. Ce panneau ne sert qu'à rattraper un écart hérité —
 * les 34 déclarations sur-apurées relevées le 2026-09-09, par exemple.
 *
 * Les garde-fous vivent côté SERVEUR (`decl.apurementedit`) : motif obligatoire,
 * refus du négatif, refus de dépasser le nombre déclaré. L'écran ne fait que
 * les rendre lisibles à l'avance.
 */
function PanneauApurement({ c, admin }: { c: O; admin: boolean }) {
  const decl = {
    numeroDeclaration: String(c['numeroDeclaration'] ?? ''),
    anneeDeclaration: String(c['anneeDeclaration'] ?? ''),
    bureauDeclaration: String(c['bureauDeclaration'] ?? ''),
    typeDeclaration: String(c['typeDeclaration'] ?? ''),
  };
  const [n, setN] = useState(0); // relance la lecture après correction
  const { data, loading } = useAsync<O>(() => call('decl.lookup', { declaration: decl }), [JSON.stringify(decl), n]);
  const [nombre, setNombre] = useState('');
  const [apures, setApures] = useState('');
  const [motif, setMotif] = useState('');
  const [busy, setBusy] = useState(false);

  if (!decl.numeroDeclaration) return null;

  const d = data ?? {};
  const cle = String(d['cle'] ?? '');
  const aNombre = Number(d['nombreConteneurs'] ?? 0);
  const aApures = Number(d['apures'] ?? 0);
  const restant = Number(d['restant'] ?? 0);
  const surApuree = aNombre > 0 && aApures > aNombre;

  /** Suppression de la ligne de suivi — ADMIN, et seulement si rien n'est apuré. */
  async function supprimer() {
    const avertissement =
      `⚠ SUPPRESSION D'UNE LIGNE DE DÉCLARATION\n\n`
      + `Déclaration : ${cle}\n`
      + `Déclarés : ${aNombre} · Apurés : ${aApures}\n\n`
      + `Cette ligne de SUIVI D'APUREMENT sera effacée. La déclaration en douane\n`
      + `elle-même n'est pas concernée : seul le compteur tenu par l'application\n`
      + `disparaît.\n\n`
      + `L'opération est inscrite au journal d'audit et ne peut pas être effacée.\n\n`
      + `Motif : ${motif.trim()}\n\nConfirmer ?`;
    if (!window.confirm(avertissement)) return;
    setBusy(true);
    try {
      await call('decl.apurementdelete', { cle, motif });
      toast('Ligne de déclaration supprimée.', 'ok');
      setMotif(''); setN((x) => x + 1);
    } catch (e) { toast((e as Error).message, 'err'); } finally { setBusy(false); }
  }

  async function corriger() {
    const avertissement =
      `⚠ CORRECTION D'UN COMPTEUR DOUANIER\n\n`
      + `Déclaration : ${cle}\n\n`
      + `Nombre déclaré  : ${aNombre} → ${nombre === '' ? aNombre : nombre}\n`
      + `Conteneurs apurés : ${aApures} → ${apures === '' ? aApures : apures}\n\n`
      + `Cette écriture déclare combien de conteneurs ont été dédouanés.\n`
      + `Elle est inscrite au journal d'audit avec l'ancienne valeur,\n`
      + `et ne peut pas être effacée.\n\n`
      + `Motif : ${motif.trim()}\n\nConfirmer ?`;
    if (!window.confirm(avertissement)) return;
    setBusy(true);
    try {
      await call('decl.apurementedit', {
        cle, motif,
        ...(nombre === '' ? {} : { nombreConteneurs: Number(nombre) }),
        ...(apures === '' ? {} : { conteneursApures: Number(apures) }),
      });
      toast('Apurement corrigé.', 'ok');
      setNombre(''); setApures(''); setMotif(''); setN((x) => x + 1);
    } catch (e) { toast((e as Error).message, 'err'); } finally { setBusy(false); }
  }

  return <details style={EDIT_ITEM}>
    <summary style={{ cursor: 'pointer', fontWeight: 600, color: surApuree ? 'var(--err)' : undefined }}>
      Apurement de la déclaration{surApuree ? ' — ⚠ sur-apurée' : ''}
    </summary>
    {loading ? <Spinner /> : <>
      <p className="help" style={{ marginTop: 10 }}>
        Déclaration <b>{cle || '—'}</b> · déclarés <b>{aNombre || '—'}</b> ·
        apurés <b>{aApures}</b> · restant <b>{restant}</b>
        {aNombre === 0 && <> · <i>nombre déclaré non renseigné : l'apurement y est neutre</i></>}
      </p>
      {surApuree && <p className="help" style={{ color: 'var(--err)', fontWeight: 600 }}>
        ⚠ Cette déclaration compte plus de conteneurs apurés que déclarés.
      </p>}
      <p className="help">
        Laissez un champ vide pour ne pas le modifier. Depuis la migration 00170,
        l'apurement se corrige seul quand un conteneur change : n'utilisez ceci
        que pour rattraper un écart ancien.
      </p>
      <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
        <div><label className="help">Nombre déclaré</label>
          <input inputMode="numeric" style={{ maxWidth: 120 }} value={nombre}
            onChange={(e) => setNombre(e.target.value.replace(/[^0-9]/g, ''))} placeholder={String(aNombre)} /></div>
        <div><label className="help">Conteneurs apurés</label>
          <input inputMode="numeric" style={{ maxWidth: 120 }} value={apures}
            onChange={(e) => setApures(e.target.value.replace(/[^0-9]/g, ''))} placeholder={String(aApures)} /></div>
      </div>
      <label className="help" style={{ marginTop: 6 }}>Motif de la correction (obligatoire)</label>
      <input value={motif} onChange={(e) => setMotif(e.target.value)}
        placeholder="ex. rattrapage de la fuite d'apurement corrigée par 00170" />
      <div className="row" style={{ gap: 10, flexWrap: 'wrap', marginTop: 8 }}>
        <button className="ghost" style={{ color: 'var(--warn)' }}
          disabled={busy || !motif.trim() || !cle || (nombre === '' && apures === '')}
          onClick={corriger}>
          {busy ? 'Correction…' : "Corriger l'apurement"}
        </button>

        {/* SUPPRESSION — ADMIN seul, et seulement une ligne à ZÉRO apuré.
            Le bouton reste VISIBLE mais désactivé quand des conteneurs sont
            apurés : le masquer laisserait croire que la suppression n'existe
            pas, alors que c'est une règle qui s'applique — et l'explication
            juste en dessous dit laquelle. */}
        {admin && <button className="ghost" style={{ color: 'var(--err)' }}
          disabled={busy || !motif.trim() || !cle || aApures > 0}
          onClick={supprimer}>
          {busy ? 'Suppression…' : 'Supprimer cette ligne'}
        </button>}
      </div>
      {admin && aApures > 0 && <div className="help" style={{ marginTop: 4 }}>
        Suppression impossible : <b>{aApures} conteneur(s) apurés</b> sur cette
        déclaration. Effacer la ligne ferait disparaître la trace de ce qui a été
        dédouané — corrigez les compteurs plutôt que de supprimer.
      </div>}
    </>}
  </details>;
}

/**
 * HISTORIQUE DE LA CARGAISON (2026-09-10) — le PARCOURS, pas l'état.
 *
 * La fiche et « Toutes les informations » disent où en est le camion. Ceci dit
 * comment il y est arrivé : qui a saisi, qui a corrigé, ce qui a été modifié
 * après coup et pourquoi. C'était la moitié manquante — un champ corrigé ne
 * laisse sur la fiche que sa valeur finale, jamais ce qu'il valait avant.
 *
 * Chargé À L'OUVERTURE du bloc seulement (`ouvert`), pas au rendu de la fiche :
 * la plupart des consultations n'en ont pas besoin, et chaque appel coûte un
 * aller-retour de ~700 ms vers Dublin.
 *
 * Le bloc se masque de lui-même si le rôle n'y a pas droit (le serveur renvoie
 * « Accès refusé ») : aucune règle de permission n'est réécrite ici.
 */
function HistoriqueCargaison({ c }: { c: O }) {
  const id = String(c['id'] ?? '');
  const [ouvert, setOuvert] = useState(false);
  const { data, loading, error } = useAsync<O>(
    () => (ouvert ? call('cargo.historique', { id }) : Promise.resolve({ lignes: [] })),
    [id, ouvert],
  );
  if (error) return null; // rôle sans droit : on n'affiche pas un bloc en erreur
  const lignes = (data?.['lignes'] as O[]) ?? [];

  return <details className="card" style={{ marginTop: 10 }}
    onToggle={(e) => setOuvert((e.currentTarget as HTMLDetailsElement).open)}>
    <summary style={{ cursor: 'pointer', fontWeight: 600 }}>
      Historique de ce camion — qui a fait quoi, et quand
    </summary>
    {!ouvert ? null : loading ? <Spinner /> : !lignes.length
      ? <div className="empty" style={{ marginTop: 8 }}>Aucun événement enregistré.</div>
      : <>
        <p className="help" style={{ marginTop: 8 }}>
          {lignes.length} événement(s), du plus ancien au plus récent. Ce journal
          est <b>inaltérable</b> : aucune ligne ne peut y être modifiée ni effacée.
        </p>
        <div style={{ overflowX: 'auto' }}>
          <table>
            <thead><tr><th>Date</th><th>Agent</th><th>Rôle</th><th>Action</th><th>Détail</th></tr></thead>
            <tbody>
              {lignes.map((l, i) => <tr key={i}>
                <td className="mono" style={{ whiteSpace: 'nowrap' }}>{fmtDate(l['ts'])}</td>
                <td>{String(l['nomComplet'] || l['username'] || '—')}</td>
                <td className="help">{roleLabel(String(l['role'] ?? ''))}</td>
                <td><b>{String(l['action'] ?? '')}</b></td>
                <td className="help" style={{ whiteSpace: 'pre-wrap' }}>{String(l['details'] ?? '')}</td>
              </tr>)}
            </tbody>
          </table>
        </div>
      </>}
  </details>;
}
