/**
 * ============================================================================
 *  Actions d'ÉCRITURE — flux principal (transcription fidèle de Data.gs v3.6).
 *  createcamion, cfs, declaration, sceller, valider, horsgabarit, t1, gps,
 *  gpsedit, bonsortie, sortie, etatcfs, arriveebureau, editcamion, update,
 *  mixte, visite. Messages d'erreur conservés MOT POUR MOT.
 * ============================================================================
 */
import type { Ctx } from '../ctx.ts';
import { versCamel } from '../ctx.ts';
import {
  ROLES, STATUTS, STOCK_STATUTS, OPERATIONS, ETATS_SORTIE, HAUTEUR_HORS_GABARIT, CONTENEURS_MAX,
  alphaNumMaj, maj, txt, tcValide, normaliserConteneur, normaliserDeclaration, parseConteneursDetails,
  declKey, typeDeRoutage, tailleBucket, construireCamion, verifierBinome, apercuConteneurs,
  etapesEnAttente, estOui, aFait, sautsTypeC,
} from '../../_shared/domaine/src/index.ts';
import {
  getCargo, patchCargo, nextId, nextRapportId, ajouterConteneurs, supprimerConteneursDe,
  renommerCamionConteneurs, lierStock, delierStock, stockDisponible, lookupDeclaration, majApurement,
  majApurementSafe, declCont, signature,
} from './helpers.ts';

const b = (v: boolean) => v; // clarté d'intention : on stocke des booléens typés

/* --------------------------- createcamion ------------------------------ */

async function camionActif(ctx: Ctx, numeroCamion: string): Promise<Record<string, unknown> | null> {
  const q = String(numeroCamion || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!q) return null;
  const { data, error } = await ctx.db
    .from('cargaisons')
    .select('id, statut, numero_camion')
    .eq('numero_camion_norm', q)
    .neq('statut', STATUTS.SORTIE)
    .limit(1);
  if (error) throw new Error(error.message);
  return data && data[0] ? versCamel(data[0]) : null;
}

/** Étape 0 — le CFS crée le camion VIDE + choisit le type d'opération (v3.3). */
export async function createcamion(ctx: Ctx, p: { numeroCamion?: string; routage?: string; typeOperation?: string }) {
  const numeroCamion = alphaNumMaj(p.numeroCamion);
  if (!numeroCamion) throw new Error('N° camion requis.');
  const routage = String(p.routage || p.typeOperation || '').trim();
  if ([OPERATIONS.ENLEVEMENT, OPERATIONS.DEPOTAGE].indexOf(routage as never) === -1)
    throw new Error("Type d'opération requis : Enlèvement ou Dépotage.");
  const typeOp = typeDeRoutage(routage);
  const actif = await camionActif(ctx, numeroCamion);
  if (actif)
    throw new Error(
      'Le camion « ' + numeroCamion + ' » existe déjà (statut « ' + actif['statut'] + ' », ' + actif['id'] +
        "). Il ne pourra être recréé qu'après sa sortie.",
    );
  const id = await nextId(ctx);
  const rapportId = await nextRapportId(ctx);
  const now = new Date().toISOString();
  const { error } = await ctx.db.from('cargaisons').insert({
    id, reference: id, date_creation: now, numero_camion: numeroCamion,
    type_operation: typeOp, routage_entree: routage, agent_entree: ctx.session.nomComplet, agent_entree_id: ctx.session.userId,
    twins: false, statut: STATUTS.CAMION, derniere_maj: now, rapport_id: rapportId,
    nb_conteneurs: 0, saute_t1: false, saute_balise: false, saute_bs: false,
  });
  if (error) throw new Error(error.message);
  await ctx.log('Entrée camion (vide)', id, numeroCamion + ' · ' + routage);
  return { id, numeroCamion, typeOperation: typeOp, routage };
}

/* -------------------------------- cfs ---------------------------------- */

/** v2.7 — Saisie CFS itérative (un conteneur à la fois). Transcription de _associerCFS_. */
export async function cfs(ctx: Ctx, p: Record<string, unknown>) {
  const id = String(p['id'] ?? '').trim();
  const ct = normaliserConteneur((p['conteneur'] ?? {}) as never);
  const contInput = (p['conteneur'] ?? {}) as Record<string, unknown>;
  const manuel = !!contInput['manuel'];
  if (!tcValide(ct.num)) throw new Error('N° conteneur invalide. Format : 4 lettres + 7 chiffres (ex. MSKU1234567).');
  if (!ct.taille) throw new Error('Taille du conteneur obligatoire.');
  // v3.1 — le TYPE de conteneur est saisi à la main et n'est plus obligatoire.

  const stk = manuel ? null : await stockDisponible(ctx, ct.num);
  if (!manuel && !stk)
    throw new Error(
      'Conteneur « ' + ct.num + ' » introuvable dans le stock (ou déjà dépoté). Importez / pointez-le d\'abord, ou cochez « saisie manuelle » s\'il est partagé.',
    );

  const cargo = await getCargo(ctx, id);
  const c = cargo.o;
  if ([STATUTS.CAMION, STATUTS.CHARGEMENT, STATUTS.CREEE].indexOf(c['statut'] as never) === -1)
    throw new Error('Ajout impossible : statut « ' + c['statut'] + ' ».');

  const premier = c['statut'] === STATUTS.CAMION;
  const type = (c['typeOperation'] || (premier ? p['typeOperation'] : c['typeOperation'])) as string;
  if ([OPERATIONS.ENLEVEMENT, OPERATIONS.DEPOTAGE].indexOf(type as never) === -1)
    throw new Error("Type d'opération invalide (Enlèvement ou Dépotage).");
  const estEnl = type === OPERATIONS.ENLEVEMENT;
  if (estEnl && !ct.plomb) throw new Error('Enlèvement : le scellé (plomb) du conteneur est obligatoire.');
  else if (!estEnl) ct.plomb = '';
  if (!estEnl && !manuel && stk && stk['statut'] !== STOCK_STATUTS.POSITIONNE)
    throw new Error(
      'Dépotage : le conteneur « ' + ct.num + ' » n\'est pas POSITIONNÉ. Pointez-le au pointage matinal (stock CFS journalier) avant de le rattacher.',
    );

  const pd = parseConteneursDetails(c['conteneursDetails']);
  const conts = pd.conteneurs;
  const scellesCamion = pd.scellesCamion;
  if (conts.some((x) => normaliserConteneur(x).num === ct.num)) throw new Error('Ce conteneur est déjà sur ce camion.');

  if (estEnl) {
    const err = verifierBinome(conts, ct.taille);
    if (err) throw new Error(err);
  } else if (conts.length >= CONTENEURS_MAX) {
    throw new Error('Trop de conteneurs (max ' + CONTENEURS_MAX + ').');
  }

  // Déclaration complète (enlèvement 1er / dépotage chaque conteneur en v3.2+).
  const declInput = p['declaration'] as Record<string, unknown> | undefined;
  let declRef: ReturnType<typeof normaliserDeclaration> | null = null;
  if (declInput && String(declInput['declarant'] ?? '').trim()) {
    // Nb de conteneurs déclarés et date en douane sont facultatifs (décision user).
    declRef = normaliserDeclaration(declInput as never, type);
  }

  const declRefCamion: Record<string, unknown> = {
    numeroDeclaration: c['numeroDeclaration'], anneeDeclaration: c['anneeDeclaration'],
    bureauDeclaration: c['bureauDeclaration'], typeDeclaration: c['typeDeclaration'], declarant: c['declarant'],
  };
  if (premier && declRef) {
    declRefCamion['numeroDeclaration'] = declRef.numeroDeclaration; declRefCamion['anneeDeclaration'] = declRef.anneeDeclaration;
    declRefCamion['bureauDeclaration'] = declRef.bureauDeclaration; declRefCamion['typeDeclaration'] = declRef.typeDeclaration;
    declRefCamion['declarant'] = declRef.declarant;
  }
  const dc = declRef
    ? { numeroDeclaration: declRef.numeroDeclaration, anneeDeclaration: declRef.anneeDeclaration,
        bureauDeclaration: declRef.bureauDeclaration, typeDeclaration: declRef.typeDeclaration, declarant: declRef.declarant }
    : declCont(contInput, declRefCamion);
  const ctExt = ct as Record<string, unknown>;
  ctExt['numeroDeclaration'] = dc.numeroDeclaration; ctExt['anneeDeclaration'] = dc.anneeDeclaration;
  ctExt['bureauDeclaration'] = dc.bureauDeclaration; ctExt['typeDeclaration'] = dc.typeDeclaration;
  if (declRef) {
    ctExt['declarant'] = declRef.declarant; ctExt['contactDeclarant'] = declRef.contactDeclarant;
    ctExt['destinationMarchandise'] = declRef.destinationMarchandise; ctExt['descriptionMarchandise'] = declRef.descriptionMarchandise;
    ctExt['nombreConteneurs'] = declInput?.['nombreConteneurs'] ?? '';
  }
  let mixte = false;
  if (declRefCamion['numeroDeclaration'] && dc.numeroDeclaration && declKey(dc) !== declKey(declRefCamion)) mixte = true;

  conts.push(ct);

  const patch: Record<string, unknown> = {};
  if (premier) {
    patch['type_operation'] = type;
    patch['agent_cfs'] = ctx.session.nomComplet;
    patch['agent_cfs_id'] = ctx.session.userId;
    // v4 — « nombre de colis » réservé au DÉPOTAGE (saisi à la finalisation,
    // cargo.declaration). L'enlèvement ne le renseigne plus.
    if (p['observationsCFS']) patch['observations_cfs'] = maj(p['observationsCFS'], 1000);
    if (declRef) {
      patch['declarant'] = declRef.declarant; patch['contact_declarant'] = declRef.contactDeclarant;
      patch['destination_marchandise'] = declRef.destinationMarchandise; patch['bureau_declaration'] = declRef.bureauDeclaration;
      patch['type_declaration'] = declRef.typeDeclaration; patch['numero_declaration'] = declRef.numeroDeclaration;
      patch['annee_declaration'] = declRef.anneeDeclaration; patch['description_marchandise'] = declRef.descriptionMarchandise;
    }
  }
  patch['nb_conteneurs'] = conts.length;
  patch['conteneurs_details'] = { conteneurs: conts, scellesCamion };
  patch['twins'] = b(estEnl && conts.length >= 2);
  if (mixte) patch['chargement_mixte'] = true;
  // v4 — déclaration hors transit (type C = conso, type A = admission) : saute
  // le T1 (et la Balise si « non balisée », consoMode='sansbalise'). Dès qu'une
  // déclaration est saisie, on (re)positionne les sauts selon son type.
  if (declRef) {
    const sauts = sautsTypeC(declRef.typeDeclaration, p['consoMode']);
    patch['saute_t1'] = sauts.sauteT1;
    patch['saute_balise'] = sauts.sauteBalise;
  }
  // v4.1 — AJOUTER UN CONTENEUR NE TERMINE JAMAIS LE CHARGEMENT (décision
  // utilisateur 2026-07-22). L'enlèvement passait à « Créée » dès le 1er
  // conteneur : l'étape CFS virait au vert et les cellules en aval s'ouvraient
  // alors que le camion pouvait encore charger. Le camion reste « En cours de
  // chargement » jusqu'à ce que le CFS déclare explicitement la fin
  // (`cargo.fincharge` en enlèvement, `cargo.declaration` en dépotage).
  const resultStatut = STATUTS.CHARGEMENT;
  patch['statut'] = resultStatut;

  await patchCargo(ctx, cargo, patch);
  await ajouterConteneurs(ctx, String(c['rapportId']), id, String(c['numeroCamion']), type, [ct], conts.length);
  if (declRef) await majApurement(ctx, declRef, Number(declInput?.['nombreConteneurs']) || undefined, 1);
  else await majApurementSafe(ctx, dc, 1);
  if (!manuel) await lierStock(ctx, ct.num, id);

  await ctx.log('CFS — ajout conteneur', id, ct.num + ' (' + type + (manuel ? ', partagé/manuel' : '') + (mixte ? ', mixte' : '') + ')');
  return { id, statut: resultStatut, conteneur: ct.num, mixte, manuel };
}

/* ---------------------------- declaration ------------------------------ */

/** v3.2 — DÉPOTAGE : hauteur + colis + scellés → « Créée ». Hors gabarit auto. */
export async function declaration(ctx: Ctx, p: Record<string, unknown>) {
  const id = String(p['id'] ?? '').trim();
  const cargo = await getCargo(ctx, id);
  const c = cargo.o;
  if (c['typeOperation'] !== OPERATIONS.DEPOTAGE) throw new Error('Action réservée au dépotage.');
  if (ctx.session.role !== ROLES.ADMIN && c['statut'] !== STATUTS.CHARGEMENT)
    throw new Error('Finalisation impossible : le camion doit être « En cours de chargement » (statut « ' + c['statut'] + ' »).');

  const sc = (Array.isArray(p['scellesCamion']) ? (p['scellesCamion'] as unknown[]) : []).map((s) => maj(s, 30)).filter(Boolean);
  if (sc.length < 2) throw new Error('Au moins 2 scellés camion sont requis (dépotage).');
  if (sc.length > 3) throw new Error('3 scellés camion maximum.');
  const pd = parseConteneursDetails(c['conteneursDetails']);

  const hauteurStr = txt(p['hauteurChargement'], 30);
  const hauteurNum = parseFloat(String(p['hauteurChargement'] ?? '').replace(',', '.').replace(/[^0-9.]/g, ''));
  const horsGab = !isNaN(hauteurNum) && hauteurNum > HAUTEUR_HORS_GABARIT;

  const patch: Record<string, unknown> = {
    conteneurs_details: { conteneurs: pd.conteneurs, scellesCamion: sc },
    hauteur_chargement: hauteurStr,
    hors_gabarit: horsGab ? true : null,
    agent_cfs: ctx.session.nomComplet,
    agent_cfs_id: ctx.session.userId,
    statut: STATUTS.CREEE,
  };
  if (p['nbColis'] !== undefined && p['nbColis'] !== '') patch['nb_colis'] = txt(p['nbColis'], 20);
  if (p['observationsCFS']) patch['observations_cfs'] = maj(p['observationsCFS'], 1000);
  await patchCargo(ctx, cargo, patch);
  await ctx.log('CFS — finalisation dépotage' + (horsGab ? ' (HORS GABARIT)' : ''), id, '');
  return { id, statut: STATUTS.CREEE, horsGabarit: horsGab };
}

/* ----------------------------- fincharge ------------------------------- */

/**
 * v4.1 — FIN DE CHARGEMENT EXPLICITE (décision utilisateur 2026-07-22 :
 * « si la personne ne met pas fin de chargement, l'étape CFS ne passe pas au
 * vert et on ne peut pas avancer »).
 *
 * C'est le pendant, pour l'ENLÈVEMENT, de `cargo.declaration` qui clôt déjà le
 * DÉPOTAGE (hauteur + colis + scellés camion). Tant qu'elle n'est pas appelée,
 * le camion reste « En cours de chargement » : `etapesEnAttente` renvoie
 * ['CFS'], donc la validation du chef, le T1, la Balise, le bon de sortie et la
 * sortie PP sont tous refusés — le camion n'apparaît pas non plus sur le bon de
 * chargement par déclaration, qui ne retient que les camions « Créée ».
 *
 * Le dépotage garde SA porte (les scellés camion y sont la preuve matérielle de
 * la fin de chargement) : deux portes vers le même état avec des exigences
 * différentes ouvriraient un contournement.
 */
export async function finChargement(ctx: Ctx, p: Record<string, unknown>) {
  const id = String(p['id'] ?? '').trim();
  const cargo = await getCargo(ctx, id);
  const c = cargo.o;
  const estAdmin = ctx.session.role === ROLES.ADMIN;

  if (c['typeOperation'] === OPERATIONS.DEPOTAGE)
    throw new Error('Dépotage : terminez par la finalisation (hauteur, colis et scellés camion).');
  if (c['statut'] === STATUTS.CREEE) throw new Error('Le chargement de ce camion est déjà terminé.');
  if (!estAdmin && [STATUTS.CAMION, STATUTS.CHARGEMENT].indexOf(c['statut'] as never) === -1)
    throw new Error('Fin de chargement impossible : la cargaison a déjà avancé (statut « ' + c['statut'] + ' »).');

  // Un camion sans rien dessus n'a rien à clôturer : le laisser passer ferait
  // entrer une coquille vide dans le circuit des cellules en aval.
  const conts = parseConteneursDetails(c['conteneursDetails']).conteneurs;
  if (!conts.length && !String(c['descriptionMarchandise'] ?? '').trim())
    throw new Error('Rien à clôturer : ajoutez au moins un conteneur (ou la désignation des effets divers).');
  // Sans déclaration, les cellules en aval n'auraient rien à traiter.
  if (!String(c['numeroDeclaration'] ?? '').trim())
    throw new Error('Renseignez la déclaration avant de terminer le chargement.');
  // Le scellé porte la responsabilité du chargement en enlèvement.
  const sansPlomb = conts.filter((ct) => !normaliserConteneur(ct as never).plomb).length;
  if (sansPlomb) throw new Error('Enlèvement : ' + sansPlomb + ' conteneur(s) sans scellé. Corrigez-les avant de terminer.');

  await patchCargo(ctx, cargo, {
    statut: STATUTS.CREEE,
    agent_cfs: c['agentCfs'] || ctx.session.nomComplet,
    agent_cfs_id: c['agentCfsId'] || ctx.session.userId,
  });
  await ctx.log('CFS — fin de chargement', id, conts.length + ' conteneur(s)');
  return { id, statut: STATUTS.CREEE, conteneurs: conts.length };
}

/* ------------------------------- sceller ------------------------------- */

export async function sceller(ctx: Ctx, p: Record<string, unknown>) {
  const id = String(p['id'] ?? '').trim();
  const cargo = await getCargo(ctx, id);
  const c = cargo.o;
  if (ctx.session.role !== ROLES.ADMIN && c['statut'] !== STATUTS.CHARGEMENT)
    throw new Error("Pose de scellés impossible : la cargaison n'est pas « En cours de chargement ».");
  const type = c['typeOperation'];
  const pd = parseConteneursDetails(c['conteneursDetails']);
  const conts = pd.conteneurs;
  let scellesCamion = pd.scellesCamion;
  if (type === OPERATIONS.DEPOTAGE) {
    const sc = (Array.isArray(p['scellesCamion']) ? (p['scellesCamion'] as unknown[]) : []).map((s) => maj(s, 30)).filter(Boolean);
    if (sc.length < 2) throw new Error('Au moins 2 scellés requis (dépotage).');
    if (sc.length > 3) throw new Error('3 scellés maximum.');
    scellesCamion = sc;
  } else {
    const pls = (Array.isArray(p['plombs']) ? (p['plombs'] as unknown[]) : []).map((s) => maj(s, 30));
    conts.forEach((ct, i) => (ct.plomb = pls[i] || ct.plomb || ''));
    if (conts.some((ct) => !ct.plomb)) throw new Error('Chaque conteneur doit avoir un scellé.');
  }
  await patchCargo(ctx, cargo, {
    conteneurs_details: { conteneurs: conts, scellesCamion },
    statut: STATUTS.CREEE,
  });
  await ctx.log('Pose des scellés (fin de chargement)', id, '');
  return { id };
}

/* -------------------------------- visite ------------------------------- */

export async function visite(ctx: Ctx, p: Record<string, unknown>) {
  const id = String(p['id'] ?? '').trim();
  const norm = (v: unknown) => String(v ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const conteneur = norm(p['conteneur']);
  const nouveau = maj(p['nouveauScelle'], 30);
  if (!conteneur || !nouveau) throw new Error('Conteneur et nouveau scellé requis.');
  const cargo = await getCargo(ctx, id);
  const pd = parseConteneursDetails(cargo.o['conteneursDetails']);
  let found = false;
  pd.conteneurs.forEach((ct) => {
    if (norm(ct.num) === conteneur) { ct.plomb = nouveau; found = true; }
  });
  if (!found) throw new Error('Conteneur introuvable dans la cargaison.');
  await patchCargo(ctx, cargo, { conteneurs_details: pd });
  await ctx.log('Visite — modification scellé', id, conteneur + ' → ' + nouveau);
  return { id };
}

/* ----------------------------- valider (CB) ---------------------------- */

export async function valider(ctx: Ctx, p: Record<string, unknown>) {
  const id = String(p['id'] ?? '').trim();
  const cargo = await getCargo(ctx, id);
  const c = cargo.o;
  if (c['statut'] === STATUTS.CAMION || c['statut'] === STATUTS.CHARGEMENT || c['statut'] === STATUTS.VEHICULE_OUILLAGE)
    throw new Error("Validation impossible : le CFS doit d'abord terminer (statut « " + c['statut'] + " »).");
  if (aFait(c['dateValidation']) && ctx.session.role !== ROLES.ADMIN)
    throw new Error('Cargaison déjà validée le ' + fmtDate(c['dateValidation']) + '.');
  const now = new Date().toISOString();
  const sig = await signature(id + '|' + ctx.session.username + '|' + now);
  await patchCargo(ctx, cargo, {
    date_validation: now, agent_validation: ctx.session.nomComplet, agent_validation_id: ctx.session.userId,
    signature_validation: sig,
  });
  await ctx.log('Validation chef brigade', id, '');
  return { id };
}

/**
 * v4 — VALIDATION EN LOT (décision utilisateur 2026-07-19) : le chef brigade
 * signe d'un seul geste tous les camions d'une déclaration.
 *
 * Chaque cargaison reçoit SA PROPRE signature (une signature couvrant le lot
 * n'aurait aucune valeur probante sur une fiche prise isolément). Une cargaison
 * en erreur n'annule pas les autres : elle est rapportée à part, comme pour la
 * saisie en lot des camions — le chef voit ce qui est passé et ce qui reste.
 */
export async function validerLot(ctx: Ctx, p: Record<string, unknown>) {
  const ids = (Array.isArray(p['ids']) ? (p['ids'] as unknown[]) : [])
    .map((v) => String(v ?? '').trim()).filter(Boolean);
  if (!ids.length) throw new Error('Aucune cargaison à valider.');

  const validees: string[] = [];
  const erreurs: Record<string, unknown>[] = [];
  for (const id of ids) {
    try {
      await valider(ctx, { id });
      validees.push(id);
    } catch (e) {
      erreurs.push({ id, message: (e as Error).message });
    }
  }
  await ctx.log('Validation chef brigade (lot)', '',
    `${validees.length} validée(s)${erreurs.length ? ` · ${erreurs.length} en erreur` : ''}`);
  return { validees, erreurs, compte: { validees: validees.length, erreurs: erreurs.length } };
}

/** v3.0 — champ confidentiel Hors gabarit (I-7 : action conservée à l'identique). */
export async function horsgabarit(ctx: Ctx, p: Record<string, unknown>) {
  const id = String(p['id'] ?? '').trim();
  const hg = p['horsGabarit'] === true || String(p['horsGabarit']).toLowerCase() === 'oui';
  const cargo = await getCargo(ctx, id);
  await patchCargo(ctx, cargo, {
    hors_gabarit: hg ? true : null,
    hauteur_chargement: hg ? txt(p['hauteurChargement'], 30) : '',
  });
  await ctx.log('Hors gabarit', id, hg ? 'Oui · ' + txt(p['hauteurChargement'], 30) : 'Non');
  return { id };
}

/* --------------------------------- t1 ---------------------------------- */

export async function t1(ctx: Ctx, p: Record<string, unknown>) {
  const id = String(p['id'] ?? '').trim();
  const bureau = maj(p['bureauDestination'], 60);
  if (!bureau) throw new Error('Bureau de destination obligatoire.');
  const items = (Array.isArray(p['t1Numeros']) ? (p['t1Numeros'] as unknown[]) : [])
    .map((o) =>
      o && typeof o === 'object'
        ? { conteneur: maj((o as Record<string, unknown>)['conteneur'], 20), numero: maj((o as Record<string, unknown>)['numero'], 40) }
        : { conteneur: '', numero: maj(o, 40) },
    )
    .filter((o) => o.numero);
  if (!items.length) throw new Error('Au moins un numéro de document T1 est requis.');
  const numeros = items.map((o) => o.numero);
  if (new Set(numeros).size !== numeros.length) throw new Error('Les numéros T1 doivent être distincts (1 par conteneur).');

  const cargo = await getCargo(ctx, id);
  const c = cargo.o;
  if (ctx.session.role !== ROLES.ADMIN && etapesEnAttente(c as never).indexOf('T1') < 0)
    throw new Error('Cellule T1 impossible : étape non attendue (statut « ' + c['statut'] + ' »).');
  if (c['typeOperation'] === OPERATIONS.ENLEVEMENT) {
    const nb = Number(c['nbConteneurs'] || 0) || 1;
    if (items.length < nb) throw new Error('Enlèvement : un T1 par conteneur (≥ ' + nb + ' attendus).');
    const pd = parseConteneursDetails(c['conteneursDetails']);
    const dispo = pd.conteneurs.map((o) => String(o.num || '').toUpperCase().replace(/[^A-Z0-9]/g, '')).filter(Boolean);
    const lies: string[] = [];
    items.forEach((o) => {
      if (!o.conteneur) throw new Error('Enlèvement : associez chaque T1 à un conteneur.');
      if (dispo.length && dispo.indexOf(o.conteneur) < 0) throw new Error('Conteneur « ' + o.conteneur + ' » absent de cette cargaison.');
      if (lies.indexOf(o.conteneur) >= 0) throw new Error("Chaque conteneur ne peut recevoir qu'un seul T1.");
      lies.push(o.conteneur);
    });
  }
  const avancer = etapesEnAttente(c as never).indexOf('T1') >= 0;
  const patch: Record<string, unknown> = {
    bureau_destination: bureau, t1_numeros: items,
    date_t1: new Date().toISOString(), agent_t1: ctx.session.nomComplet, agent_t1_id: ctx.session.userId,
    observations_t1: txt(p['observations'], 1000),
  };
  // Le statut n'avance qu'à partir de « Créée » (jamais de régression si la Balise
  // ou le Bon de sortie ont déjà fait progresser la cargaison).
  if (avancer && c['statut'] === STATUTS.CREEE) patch['statut'] = STATUTS.T1;
  await patchCargo(ctx, cargo, patch);
  await ctx.log('Saisie T1', id, numeros.join(', ') + ' · ' + bureau);
  return { id };
}

/* --------------------------------- gps --------------------------------- */

export async function gps(ctx: Ctx, p: Record<string, unknown>) {
  const id = String(p['id'] ?? '').trim();
  const requise = !(p['baliseRequise'] === false || String(p['baliseRequise']).toLowerCase() === 'non');
  const t1Correct = p['t1Correct'] === true || String(p['t1Correct']).toLowerCase() === 'oui';
  const numeroGPS = txt(p['numeroGPS']);
  const numeroDispense = maj(p['numeroDispense'], 60);
  if (!t1Correct) throw new Error('Cochez « Numéro T1 correct » avant de valider la balise.');
  if (requise && !numeroGPS) throw new Error('Numéro de balise requis.');
  if (!requise && !numeroDispense) throw new Error("Numéro d'autorisation de dispense requis.");

  const cargo = await getCargo(ctx, id);
  const c = cargo.o;
  if (c['estVehicule'] === true || c['estVehicule'] === 'Oui') throw new Error('Les véhicules ne passent pas par la cellule Balise.');
  if (ctx.session.role !== ROLES.ADMIN && etapesEnAttente(c as never).indexOf('BALISE') < 0)
    throw new Error('Étape Balise impossible : chargement non terminé ou déjà balisée (statut « ' + c['statut'] + ' »).');
  const avancer = etapesEnAttente(c as never).indexOf('BALISE') >= 0;
  const patch: Record<string, unknown> = {
    numero_gps: requise ? numeroGPS : '', date_pose_gps: new Date().toISOString(),
    agent_balise: ctx.session.nomComplet, agent_balise_id: ctx.session.userId,
    observations_balise: txt(p['observations'], 1000), balise_requise: requise, t1_correct: true,
    numero_dispense: requise ? '' : numeroDispense,
  };
  if (avancer) patch['statut'] = STATUTS.GPS;
  await patchCargo(ctx, cargo, patch);
  if (requise) await ctx.log('Pose balise', id, 'Balise ' + numeroGPS);
  else await ctx.log('Dispense de balise', id, 'Dispense ' + numeroDispense);
  return { id, baliseRequise: requise ? 'Oui' : 'Non' };
}

/** Remplacement d'un GPS défectueux (ADMIN only). Statut inchangé. */
export async function gpsedit(ctx: Ctx, p: Record<string, unknown>) {
  const id = String(p['id'] ?? '').trim();
  const numeroGPS = txt(p['numeroGPS']);
  if (!numeroGPS) throw new Error('Numéro de GPS requis.');
  const cargo = await getCargo(ctx, id);
  const c = cargo.o;
  if (c['statut'] !== STATUTS.GPS)
    throw new Error('Remplacement impossible : la cargaison doit être au statut « ' + STATUTS.GPS + ' » (statut actuel « ' + c['statut'] + ' »).');
  const ancien = c['numeroGps'] || '';
  const patch: Record<string, unknown> = {
    numero_gps: numeroGPS, date_pose_gps: new Date().toISOString(),
    agent_balise: ctx.session.nomComplet, agent_balise_id: ctx.session.userId,
  };
  if (p['observations']) patch['observations_balise'] = txt(p['observations'], 1000);
  await patchCargo(ctx, cargo, patch);
  await ctx.log('Remplacement GPS', id, 'Ancien ' + ancien + ' → nouveau ' + numeroGPS);
  return { id };
}

/* ------------------------------ bonsortie ------------------------------ */

export async function bonsortie(ctx: Ctx, p: Record<string, unknown>) {
  const id = String(p['id'] ?? '').trim();
  let stored: unknown = '';
  let numeros: string[] = [];
  if (Array.isArray(p['bonSortieNumero'])) {
    const items = (p['bonSortieNumero'] as unknown[])
      .map((o) =>
        o && typeof o === 'object'
          ? { conteneur: maj((o as Record<string, unknown>)['conteneur'], 20), t1: maj((o as Record<string, unknown>)['t1'], 40), numero: maj((o as Record<string, unknown>)['numero'], 60) }
          : { conteneur: '', t1: '', numero: maj(o, 60) },
      )
      .filter((o) => o.numero);
    if (!items.length) throw new Error('Numéro de bon de sortie requis.');
    numeros = items.map((o) => o.numero);
    stored = items;
  } else {
    const s = maj(p['bonSortieNumero'], 60);
    if (!s) throw new Error('Numéro de bon de sortie requis.');
    stored = s;
    numeros = [s];
  }
  const cargo = await getCargo(ctx, id);
  const c = cargo.o;
  if (ctx.session.role !== ROLES.ADMIN && etapesEnAttente(c as never).indexOf('BS') < 0)
    throw new Error('Bon de sortie impossible : chargement non terminé ou bon déjà émis (statut « ' + c['statut'] + ' »).');
  const avancer = etapesEnAttente(c as never).indexOf('BS') >= 0;
  const patch: Record<string, unknown> = {
    bon_sortie_numero: stored, date_bon_sortie: new Date().toISOString(),
    agent_bon_sortie: ctx.session.nomComplet, agent_bon_sortie_id: ctx.session.userId,
    observations_bon_sortie: txt(p['observations'], 1000),
  };
  if (avancer) patch['statut'] = STATUTS.BS;
  await patchCargo(ctx, cargo, patch);
  await ctx.log('Bon de sortie', id, numeros.join(', '));
  return { id };
}

/* -------------------------------- sortie ------------------------------- */

export async function sortie(ctx: Ctx, p: Record<string, unknown>) {
  const id = String(p['id'] ?? '').trim();
  const cargo = await getCargo(ctx, id);
  const c = cargo.o;
  const estVeh = c['estVehicule'] === true || c['estVehicule'] === 'Oui';
  if (ctx.session.role !== ROLES.ADMIN && etapesEnAttente(c as never).indexOf('PP') < 0)
    throw new Error('Sortie impossible : la Balise doit être posée (statut « ' + c['statut'] + ' »).');
  let checklist: Record<string, boolean> = {};
  if (estVeh) {
    if (p['infosValidees'] !== true) throw new Error('Veuillez cocher « Informations validées ».');
  } else {
    checklist = { cfs: p['ckCfs'] === true, t1: p['ckT1'] === true, balise: p['ckBalise'] === true, bs: p['ckBs'] === true };
    if (!(checklist.cfs && checklist.t1 && checklist.balise && checklist.bs))
      throw new Error('Cochez les 4 contrôles (CFS, T1, Balise, Bon de sortie) avant la sortie.');
  }
  await patchCargo(ctx, cargo, {
    infos_validees: true, pp_checklist: estVeh ? null : checklist,
    date_sortie: new Date().toISOString(), agent_pp: ctx.session.nomComplet, agent_pp_id: ctx.session.userId,
    observations_pp: txt(p['observations'], 1000), statut: STATUTS.SORTIE,
  });
  await ctx.log('Enregistrement sortie', id, '');
  return { id };
}

/* ------------------------------- etatcfs ------------------------------- */

export async function etatcfs(ctx: Ctx, p: Record<string, unknown>) {
  const id = String(p['id'] ?? '').trim();
  const etat = String(p['etatSortie'] ?? '').trim();
  if ((ETATS_SORTIE as readonly string[]).indexOf(etat) === -1)
    throw new Error('État invalide. Choisissez : ' + ETATS_SORTIE.join(' / ') + '.');
  const cargo = await getCargo(ctx, id);
  await patchCargo(ctx, cargo, { etat_sortie: etat });
  await ctx.log('État sortie CFS', id, etat);
  return { id, etatSortie: etat };
}

/* ---------------------------- arriveebureau ---------------------------- */

export async function arriveebureau(ctx: Ctx, p: Record<string, unknown>) {
  const id = String(p['id'] ?? '').trim();
  const cargo = await getCargo(ctx, id);
  const c = cargo.o;
  if (String(c['baliseRequise']) !== 'Non' && c['baliseRequise'] !== false && !estOui(c['sauteBalise']))
    throw new Error("Cette cargaison n'est pas une dispense.");
  if (c['statut'] !== STATUTS.SORTIE) throw new Error("La cargaison doit d'abord être sortie.");
  await patchCargo(ctx, cargo, {
    arrivee_bureau: true, date_arrivee_bureau: new Date().toISOString(), agent_arrivee_bureau: ctx.session.nomComplet,
  });
  await ctx.log('Arrivée bureau destination (dispense soldée)', id, '');
  return { id };
}

/* ------------------------------ editcamion ----------------------------- */

/** Correction ciblée du N° camion (tous rôles, tout statut — I-3 conservé). */
export async function editcamion(ctx: Ctx, p: Record<string, unknown>) {
  const id = String(p['id'] ?? '').trim();
  const nouveau = alphaNumMaj(p['numeroCamion']);
  if (!nouveau) throw new Error('N° camion invalide (alphanumérique, majuscules).');
  const cargo = await getCargo(ctx, id);
  const ancien = String(cargo.o['numeroCamion'] || '');
  if (nouveau === ancien) return { id, numeroCamion: nouveau, inchange: true };
  await patchCargo(ctx, cargo, { numero_camion: nouveau });
  await renommerCamionConteneurs(ctx, id, nouveau);
  await ctx.log('Correction N° camion', id, ancien + ' → ' + nouveau);
  return { id, numeroCamion: nouveau, ancien };
}

/* ------------------------------ supprimer ------------------------------ */

/**
 * v4 — Suppression d'une cargaison (ADMIN uniquement) : pour retirer un DOUBLON
 * de saisie. Libère le stock rattaché (redevient « En stock »), supprime les
 * conteneurs normalisés puis la cargaison. Action tracée dans l'audit.
 */
export async function supprimerCargo(ctx: Ctx, p: Record<string, unknown>) {
  const id = String(p['id'] ?? '').trim();
  const cargo = await getCargo(ctx, id);
  const c = cargo.o;
  // Libère les conteneurs de stock rattachés à cette cargaison.
  const { error: eStock } = await ctx.db.from('stock')
    .update({ statut: STOCK_STATUTS.STOCK, cargaison_id: null, date_depote: null })
    .eq('cargaison_id', id);
  if (eStock) throw new Error(eStock.message);
  await supprimerConteneursDe(ctx, id);
  const { error } = await ctx.db.from('cargaisons').delete().eq('id', id);
  if (error) throw new Error(error.message);
  await ctx.log('Suppression cargaison (doublon)', id, String(c['numeroCamion'] || '') + ' · ' + String(c['typeOperation'] || ''));
  return { id, supprime: true };
}

/* ------------------------------- edittype ------------------------------ */

/**
 * v4 — Correction du TYPE d'opération (Dépotage ↔ Enlèvement). Réservée à la
 * phase CFS (avant validation) ; ADMIN partout. Ré-adapte les scellés au modèle
 * du nouveau type (par conteneur en enlèvement / au niveau camion en dépotage)
 * et remet le statut à un point cohérent (dépotage → à re-finaliser).
 */
export async function edittype(ctx: Ctx, p: Record<string, unknown>) {
  const id = String(p['id'] ?? '').trim();
  const nouveau = String(p['typeOperation'] ?? '').trim();
  if ([OPERATIONS.DEPOTAGE, OPERATIONS.ENLEVEMENT].indexOf(nouveau as never) === -1)
    throw new Error("Type d'opération invalide (Dépotage ou Enlèvement).");
  const cargo = await getCargo(ctx, id);
  const c = cargo.o;
  const estAdmin = ctx.session.role === ROLES.ADMIN;
  if (!estAdmin && [STATUTS.CAMION, STATUTS.CHARGEMENT, STATUTS.CREEE].indexOf(c['statut'] as never) === -1)
    throw new Error('Correction du type impossible : la cargaison a déjà avancé (statut « ' + c['statut'] + ' »).');
  if (!estAdmin && aFait(c['dateValidation']))
    throw new Error('Correction du type impossible : cargaison déjà validée.');
  const ancien = String(c['typeOperation'] || '');
  if (ancien === nouveau) return { id, typeOperation: nouveau, inchange: true };

  const estEnl = nouveau === OPERATIONS.ENLEVEMENT;
  const pd = parseConteneursDetails(c['conteneursDetails']);
  const conts = pd.conteneurs;
  let scellesCamion = pd.scellesCamion;
  if (estEnl) {
    // → Enlèvement : le scellé est porté PAR conteneur. On reprend les scellés
    //   camion comme plombs (best-effort, par position) puis on les efface.
    conts.forEach((ct, i) => { if (!ct.plomb) ct.plomb = scellesCamion[i] || ''; });
    scellesCamion = [];
  } else {
    // → Dépotage : scellés au niveau camion. On récupère les plombs conteneur.
    const migr = [...new Set(conts.map((ct) => ct.plomb).filter(Boolean))].slice(0, 3);
    if (migr.length) scellesCamion = migr;
    conts.forEach((ct) => { ct.plomb = ''; });
  }
  // Statut cohérent : vide → « Camion créé » ; sinon « En cours de chargement »,
  // car changer de type invalide la clôture précédente — la fin de chargement
  // est à redéclarer (scellés/hauteur en dépotage, cargo.fincharge en enlèvement).
  const statut = !conts.length ? STATUTS.CAMION : STATUTS.CHARGEMENT;
  await patchCargo(ctx, cargo, {
    type_operation: nouveau, routage_entree: nouveau,
    twins: estEnl && conts.length >= 2,
    conteneurs_details: { conteneurs: conts, scellesCamion },
    statut,
  });
  await ctx.log("Correction type d'opération", id, ancien + ' → ' + nouveau);
  return { id, typeOperation: nouveau, ancien };
}

/* ---------------------------- editconteneur ---------------------------- */

/**
 * v4 — CORRECTION d'un conteneur déjà enregistré sur un camion (N° erroné,
 * taille/type/scellé) ou SUPPRESSION de la ligne. C'était le trou noir du v4 :
 * une faute de frappe sur le N° de conteneur ne pouvait plus être rattrapée.
 *
 * Effets de bord tenus à jour : table normalisée « conteneurs » (réécrite),
 * nb_conteneurs, twins, et surtout le STOCK — l'ancien TC est délié (il
 * redevient sélectionnable) et le nouveau est lié à la cargaison.
 * CFS : phase CFS uniquement (Camion créé / En chargement / Créée) ; ADMIN partout.
 */
export async function editconteneur(ctx: Ctx, p: Record<string, unknown>) {
  const id = String(p['id'] ?? '').trim();
  const index = Number(p['index']);
  const supprimer = p['supprimer'] === true;
  const cargo = await getCargo(ctx, id);
  const c = cargo.o;
  const estAdmin = ctx.session.role === ROLES.ADMIN;
  if (!estAdmin && [STATUTS.CAMION, STATUTS.CHARGEMENT, STATUTS.CREEE].indexOf(c['statut'] as never) === -1)
    throw new Error('Correction impossible : la cargaison a déjà avancé (statut « ' + c['statut'] + ' »).');

  const type = String(c['typeOperation'] || '');
  const estEnl = type === OPERATIONS.ENLEVEMENT;
  const pd = parseConteneursDetails(c['conteneursDetails']);
  const conts = pd.conteneurs;
  if (!(index >= 0 && index < conts.length)) throw new Error('Conteneur introuvable sur ce camion (ligne ' + (index + 1) + ').');
  const ancien = normaliserConteneur(conts[index] as never);
  // normaliserConteneur ne retient PAS la déclaration : on la capture à part
  // pour pouvoir tracer un changement de déclaration sur cette ligne.
  const declAvant = declKey(conts[index] as never);

  if (supprimer) {
    conts.splice(index, 1);
  } else {
    const ct = normaliserConteneur({
      num: p['num'], taille: p['taille'], type: p['type'], plomb: p['plomb'], poids: p['poids'],
    } as never);
    if (!tcValide(ct.num)) throw new Error('N° conteneur invalide. Format : 4 lettres + 7 chiffres (ex. MSKU1234567).');
    if (!ct.taille) throw new Error('Taille du conteneur obligatoire.');
    if (estEnl && !ct.plomb) throw new Error('Enlèvement : le scellé (plomb) du conteneur est obligatoire.');
    if (!estEnl) ct.plomb = '';
    if (conts.some((x, i) => i !== index && normaliserConteneur(x).num === ct.num))
      throw new Error('Ce conteneur est déjà sur ce camion.');
    // Le nouveau TC doit exister au stock (sauf reprise d'une saisie manuelle et
    // sauf ADMIN, qui peut corriger un historique importé).
    const manuel = p['manuel'] === true;
    if (!manuel && !estAdmin && ct.num !== ancien.num && !(await stockDisponible(ctx, ct.num)))
      throw new Error(
        'Conteneur « ' + ct.num + ' » introuvable dans le stock (ou déjà dépoté). Importez / pointez-le d\'abord, ou cochez « saisie manuelle » s\'il est partagé.',
      );
    // On conserve la déclaration portée par la ligne d'origine (LOT D).
    const src = conts[index] as Record<string, unknown>;
    const cible = ct as unknown as Record<string, unknown>;
    for (const k of ['numeroDeclaration', 'anneeDeclaration', 'bureauDeclaration', 'typeDeclaration', 'declarant', 'contactDeclarant', 'destinationMarchandise', 'descriptionMarchandise', 'nombreConteneurs']) {
      if (src[k] !== undefined) cible[k] = src[k];
    }
    // v4.1 — DÉCLARATION DE CETTE LIGNE (décision utilisateur 2026-07-22).
    // En chargement MIXTE, chaque conteneur porte SA déclaration : la corriger
    // par `editdecl` les réécrirait toutes à l'identique et détruirait le mixte.
    // Ici on ne touche qu'à la ligne visée. Seule l'identité de la déclaration
    // est modifiable ; le déclarant et la marchandise restent portés par le camion.
    const dSaisie = (p['declaration'] ?? {}) as Record<string, unknown>;
    const champsDecl: [string, number][] = [
      ['numeroDeclaration', 30], ['anneeDeclaration', 6], ['bureauDeclaration', 20], ['typeDeclaration', 10],
    ];
    for (const [k, n] of champsDecl) {
      if (dSaisie[k] === undefined) continue;
      const v = maj(dSaisie[k], n);
      if (v) cible[k] = v; // vide = « ne touche pas », pas « efface »
    }
    conts[index] = ct;
  }

  // Stock : l'ancien TC redevient disponible, le nouveau est consommé.
  const nouveauNum = supprimer ? '' : normaliserConteneur(conts[index] as never).num;
  if (ancien.num && ancien.num !== nouveauNum)
    await delierStock(ctx, ancien.num, id, estEnl ? STOCK_STATUTS.STOCK : STOCK_STATUTS.POSITIONNE);
  if (nouveauNum && nouveauNum !== ancien.num) await lierStock(ctx, nouveauNum, id);

  // Un camion vidé de tous ses conteneurs retourne à « Camion créé ».
  const patch: Record<string, unknown> = {
    nb_conteneurs: conts.length,
    conteneurs_details: { conteneurs: conts, scellesCamion: pd.scellesCamion },
    twins: b(estEnl && conts.length >= 2),
  };
  if (!conts.length && [STATUTS.CAMION, STATUTS.CHARGEMENT, STATUTS.CREEE].indexOf(c['statut'] as never) >= 0)
    patch['statut'] = STATUTS.CAMION;
  await patchCargo(ctx, cargo, patch);

  // Table normalisée « conteneurs » : réécriture complète (source de vérité = pd).
  const rapportId = String(c['rapportId'] || '');
  await supprimerConteneursDe(ctx, id);
  await ajouterConteneurs(ctx, rapportId, id, String(c['numeroCamion']), type, conts.map((x) => normaliserConteneur(x)));

  const declApres = supprimer ? declAvant : declKey(conts[index] as never);
  await ctx.log(
    supprimer ? 'Correction — suppression conteneur' : 'Correction conteneur',
    id,
    supprimer ? ancien.num + ' retiré'
      : ancien.num + ' → ' + nouveauNum + (declApres !== declAvant ? ' · déclaration ' + declAvant + ' → ' + declApres : ''),
  );
  return { id, conteneurs: conts.length, ancien: ancien.num, nouveau: nouveauNum };
}

/* ------------------------------- editdecl ------------------------------ */

/**
 * v4 — CORRECTION des informations de déclaration d'un camion déjà enregistré
 * (déclarant, contact, destination, n°/année/bureau/type, marchandise).
 * Les lignes conteneurs de la cargaison portent la même déclaration (LOT D) :
 * elles sont réalignées. CFS : phase CFS ; ADMIN : partout.
 */
export async function editdecl(ctx: Ctx, p: Record<string, unknown>) {
  const id = String(p['id'] ?? '').trim();
  const cargo = await getCargo(ctx, id);
  const c = cargo.o;
  const estAdmin = ctx.session.role === ROLES.ADMIN;
  if (!estAdmin && [STATUTS.CAMION, STATUTS.CHARGEMENT, STATUTS.CREEE].indexOf(c['statut'] as never) === -1)
    throw new Error('Correction impossible : la cargaison a déjà avancé (statut « ' + c['statut'] + ' »).');
  const type = String(c['typeOperation'] || '');
  // CORRECTION, pas création : contact / destination / désignation absents des
  // données migrées ne doivent pas bloquer la correction d'un numéro.
  const decl = normaliserDeclaration(p['declaration'] as never, type, { correction: true });

  // Un champ laissé vide en correction NE DOIT PAS effacer ce qui existe :
  // l'agent corrige un numéro, il ne vient pas vider le contact du déclarant.
  const garder = (nouveau: string, ancien: unknown) => (nouveau ? nouveau : String(ancien ?? ''));
  const eff = {
    declarant: decl.declarant,
    contactDeclarant: garder(decl.contactDeclarant, c['contactDeclarant']),
    destinationMarchandise: garder(decl.destinationMarchandise, c['destinationMarchandise']),
    descriptionMarchandise: garder(decl.descriptionMarchandise, c['descriptionMarchandise']),
    bureauDeclaration: decl.bureauDeclaration, typeDeclaration: decl.typeDeclaration,
    numeroDeclaration: decl.numeroDeclaration, anneeDeclaration: decl.anneeDeclaration,
  };

  const pd = parseConteneursDetails(c['conteneursDetails']);
  pd.conteneurs.forEach((ct) => {
    const x = ct as unknown as Record<string, unknown>;
    x['numeroDeclaration'] = eff.numeroDeclaration; x['anneeDeclaration'] = eff.anneeDeclaration;
    x['bureauDeclaration'] = eff.bureauDeclaration; x['typeDeclaration'] = eff.typeDeclaration;
    x['declarant'] = eff.declarant; x['contactDeclarant'] = eff.contactDeclarant;
    x['destinationMarchandise'] = eff.destinationMarchandise; x['descriptionMarchandise'] = eff.descriptionMarchandise;
  });

  const patch: Record<string, unknown> = {
    declarant: eff.declarant, contact_declarant: eff.contactDeclarant,
    destination_marchandise: eff.destinationMarchandise, bureau_declaration: eff.bureauDeclaration,
    type_declaration: eff.typeDeclaration, numero_declaration: eff.numeroDeclaration,
    annee_declaration: eff.anneeDeclaration, description_marchandise: eff.descriptionMarchandise,
    conteneurs_details: { conteneurs: pd.conteneurs, scellesCamion: pd.scellesCamion },
    chargement_mixte: null,
  };
  // Le type de déclaration commande les sauts d'étapes (C = conso → saute T1).
  const sauts = sautsTypeC(decl.typeDeclaration, p['consoMode']);
  patch['saute_t1'] = sauts.sauteT1;
  patch['saute_balise'] = sauts.sauteBalise;
  await patchCargo(ctx, cargo, patch);

  const ancienne = [c['numeroDeclaration'], c['anneeDeclaration'], c['bureauDeclaration'], c['typeDeclaration']].filter(Boolean).join('|');
  await ctx.log('Correction déclaration', id, ancienne + ' → ' + declKey(decl));
  return { id, declaration: decl };
}

/* ------------------------------ lotcamions ----------------------------- */

/**
 * v4 — SAISIE EN LOT : plusieurs camions chargeant des conteneurs d'UNE MÊME
 * déclaration, sans re-saisir le déclarant / la déclaration / la marchandise à
 * chaque camion (demande terrain : c'était le geste le plus répétitif du CFS).
 * Chaque camion est créé puis alimenté par les chemins déjà validés
 * (createcamion + cfs), donc TOUTES les règles métier restent appliquées.
 * Traitement ligne par ligne : un camion en erreur n'annule pas les autres,
 * l'appelant reçoit le détail des réussites et des échecs.
 */
export async function lotcamions(ctx: Ctx, p: Record<string, unknown>) {
  const routage = String(p['typeOperation'] ?? p['routage'] ?? '').trim();
  if ([OPERATIONS.ENLEVEMENT, OPERATIONS.DEPOTAGE].indexOf(routage as never) === -1)
    throw new Error("Type d'opération requis : Enlèvement ou Dépotage.");
  const declaration = (p['declaration'] ?? {}) as Record<string, unknown>;
  if (!String(declaration['declarant'] ?? '').trim()) throw new Error('Champ de déclaration obligatoire : Déclarant.');
  const camions = (Array.isArray(p['camions']) ? (p['camions'] as Record<string, unknown>[]) : [])
    .filter((cm) => String(cm?.['numeroCamion'] ?? '').trim());
  if (!camions.length) throw new Error('Indiquez au moins un camion.');

  const crees: Record<string, unknown>[] = [];
  const erreurs: Record<string, unknown>[] = [];
  for (const cm of camions) {
    const numeroCamion = alphaNumMaj(cm['numeroCamion']);
    const conteneurs = (Array.isArray(cm['conteneurs']) ? (cm['conteneurs'] as Record<string, unknown>[]) : [])
      .filter((ct) => String(ct?.['num'] ?? '').trim());
    if (!conteneurs.length) { erreurs.push({ numeroCamion, message: 'Aucun conteneur saisi pour ce camion.' }); continue; }
    let id = '';
    try {
      const cr = await createcamion(ctx, { numeroCamion, routage });
      id = String((cr as { id: string }).id);
      let premier = true;
      for (const ct of conteneurs) {
        const charge: Record<string, unknown> = { id, conteneur: ct };
        // La déclaration n'accompagne que le 1er conteneur en enlèvement ;
        // en dépotage elle est portée par CHAQUE conteneur (règle cfs()).
        if (premier || routage === OPERATIONS.DEPOTAGE) {
          charge['declaration'] = declaration;
          if (p['consoMode']) charge['consoMode'] = p['consoMode'];
        }
        await cfs(ctx, charge);
        premier = false;
      }
      // La saisie en lot décrit le camion COMPLET en une fois : l'envoyer vaut
      // déclaration de fin de chargement. (Le dépotage garde sa finalisation —
      // scellés camion et hauteur ne sont pas saisis dans ce formulaire.)
      if (routage === OPERATIONS.ENLEVEMENT) await finChargement(ctx, { id });
      crees.push({ id, numeroCamion, conteneurs: conteneurs.length });
    } catch (e) {
      erreurs.push({ numeroCamion, id, message: (e as Error).message });
    }
  }
  await ctx.log('Saisie en lot (même déclaration)', '', crees.length + ' camion(s) créé(s), ' + erreurs.length + ' en erreur');
  return { crees, erreurs };
}

/* -------------------------------- update ------------------------------- */

/** Édition d'une cargaison (champs CFS). CFS limité au statut « Créée » ; ADMIN partout. */
export async function update(ctx: Ctx, p: Record<string, unknown>) {
  const id = String(p['id'] ?? '').trim();
  const type = p['typeOperation'] as string;
  if ([OPERATIONS.DEPOTAGE, OPERATIONS.ENLEVEMENT].indexOf(type as never) === -1) throw new Error("Type d'opération invalide.");
  const decl = normaliserDeclaration(p['declaration'] as never, type);
  const cam = construireCamion(
    { numeroCamion: p['numeroCamion'] as string, conteneurs: p['conteneurs'] as never, scellesCamion: p['scellesCamion'] as never },
    type,
  );
  const cargo = await getCargo(ctx, id);
  const c = cargo.o;
  if (ctx.session.role !== ROLES.ADMIN && c['statut'] !== STATUTS.CREEE)
    throw new Error("Modification impossible : la cargaison n'est plus au statut « Créée ».");
  const rapportId = String(c['rapportId'] || '');
  await patchCargo(ctx, cargo, {
    numero_camion: cam.numeroCamion, type_operation: type, twins: cam.twins === 'Yes',
    nb_conteneurs: cam.nbConteneurs, conteneurs_details: cam.conteneursDetails,
    declarant: decl.declarant, contact_declarant: decl.contactDeclarant,
    destination_marchandise: decl.destinationMarchandise, bureau_declaration: decl.bureauDeclaration,
    type_declaration: decl.typeDeclaration, numero_declaration: decl.numeroDeclaration,
    annee_declaration: decl.anneeDeclaration, description_marchandise: decl.descriptionMarchandise,
    observations_cfs: maj(p['observationsCFS'], 1000),
  });
  await supprimerConteneursDe(ctx, id);
  await ajouterConteneurs(ctx, rapportId, id, cam.numeroCamion, type, cam.conteneurs);
  await ctx.log('Modification cargaison', id, type);
  return { id };
}

/* -------------------------------- mixte -------------------------------- */

export async function mixte(ctx: Ctx, p: Record<string, unknown>) {
  const id = String(p['id'] ?? '').trim();
  const note = maj(p['note'], 1000);
  const infosSupp = maj(p['infosSupplementaires'], 2000);
  const ajout = (Array.isArray(p['conteneurs']) ? (p['conteneurs'] as unknown[]) : [])
    .map((cc) => normaliserConteneur(cc as never))
    .filter((cc) => cc.num);
  if (!note && !infosSupp && !ajout.length) throw new Error('Aucune information à ajouter au chargement mixte.');

  const cargo = await getCargo(ctx, id);
  const c = cargo.o;
  const type = c['typeOperation'] as string;
  const numeroCamion = String(c['numeroCamion']);
  const rapportId = String(c['rapportId'] || '');
  const estDepotage = type === OPERATIONS.DEPOTAGE;
  if (ajout.length) {
    ajout.forEach((ct, i) => {
      if (!tcValide(ct.num)) throw new Error('Conteneur ajouté ' + (i + 1) + ' : N° invalide. Format : 4 lettres + 7 chiffres (ex. MSKU1234567).');
      if (!ct.taille) throw new Error('Conteneur ajouté ' + (i + 1) + ' : la Taille est obligatoire.');
      if (!ct.type) throw new Error('Conteneur ajouté ' + (i + 1) + ' : le Type est obligatoire.');
      if (estDepotage) ct.plomb = '';
      else if (!ct.plomb) throw new Error('Conteneur ajouté ' + (i + 1) + ' : le Scellé / Plomb est obligatoire.');
    });
  }
  const histRaw = c['mixteDetails'];
  const hist: unknown[] = Array.isArray(histRaw) ? histRaw : [];
  hist.push({
    date: new Date().toISOString(), agent: ctx.session.nomComplet, note, infos: infosSupp,
    conteneursAjoutes: ajout.map((x) => x.num),
  });
  const patch: Record<string, unknown> = { chargement_mixte: true, mixte_details: hist };
  let total = 0;
  if (ajout.length) {
    const pd = parseConteneursDetails(c['conteneursDetails']);
    const conts = pd.conteneurs.concat(ajout);
    total = conts.length;
    patch['nb_conteneurs'] = total;
    patch['conteneurs_details'] = { conteneurs: conts, scellesCamion: pd.scellesCamion };
  }
  await patchCargo(ctx, cargo, patch);
  if (ajout.length) {
    const pd = parseConteneursDetails(c['conteneursDetails']);
    await ajouterConteneurs(ctx, rapportId, id, numeroCamion, type, ajout, pd.conteneurs.length + 1);
  }
  await ctx.log('Chargement mixte', id, (ajout.length ? ajout.length + ' conteneur(s) ajouté(s). ' : '') + (note || infosSupp || ''));
  return { id, total };
}

/* -------------------------------- utils -------------------------------- */

function fmtDate(v: unknown): string {
  if (!v) return '';
  const d = new Date(String(v));
  return isNaN(d.getTime()) ? String(v) : d.toLocaleDateString('fr-FR');
}
