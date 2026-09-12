/**
 * ============================================================================
 *  Flux SPÉCIAUX — cargo.create (Dépotage/Enlèvement/Conso groupés, Véhicule,
 *  Magasin/MAD) + cargo.ouillagedecl. Transcription fidèle de Data.gs (v3.6).
 * ============================================================================
 */
import type { Ctx } from '../ctx.ts';
import { ErreurMetier } from '../ctx.ts';
import { camionActif } from './ecriture.ts';
import {
  ROLES, STATUTS, OPERATIONS, sautsTypeC,
  alphaNumMaj, maj, txt, tcValide, camionValide, messageCamionFormat, parseDateImport,
  normaliserDeclaration, construireCamion, construireCamionEffets, construireVehicule, type CamionConstruit,
} from '../../_shared/domaine/src/index.ts';
import {
  getCargo, patchCargo, nextId, nextRapportId, ajouterConteneurs, lierStock, lookupDeclaration, majApurement,
} from './helpers.ts';

/** Objet ligne CAMION (parcours CFS → [T1] → [Balise] → BS → PP). */
function ligneCamion(
  id: string, rapportId: string, now: string, cam: CamionConstruit, type: string,
  decl: ReturnType<typeof normaliserDeclaration>, obsCFS: string, session: Ctx['session'],
  sauteT1: boolean, sauteBalise: boolean, statutInitial: string,
): Record<string, unknown> {
  return {
    id, reference: id, date_creation: now, numero_camion: cam.numeroCamion, type_operation: type,
    twins: cam.twins === 'Yes',
    declarant: decl.declarant, contact_declarant: decl.contactDeclarant, destination_marchandise: decl.destinationMarchandise,
    bureau_declaration: decl.bureauDeclaration, type_declaration: decl.typeDeclaration, numero_declaration: decl.numeroDeclaration,
    annee_declaration: decl.anneeDeclaration, description_marchandise: decl.descriptionMarchandise,
    observations_cfs: obsCFS, agent_cfs: session.nomComplet, agent_cfs_id: session.userId,
    statut: statutInitial || STATUTS.CREEE, derniere_maj: now, rapport_id: rapportId,
    conteneurs_details: cam.conteneursDetails, nb_conteneurs: cam.nbConteneurs,
    saute_t1: sauteT1, saute_balise: sauteBalise,
  };
}

/** Route cargo.create vers le bon parcours (véhicule/magasin/groupé). */
export async function create(ctx: Ctx, p: Record<string, unknown>) {
  const type = p['typeOperation'] as string;
  if (type === OPERATIONS.VEHICULE) return creerRapportVehicule(ctx, p);
  if (type === OPERATIONS.MAGASIN) return creerRapportMagasin(ctx, p);
  if ([OPERATIONS.DEPOTAGE, OPERATIONS.ENLEVEMENT, OPERATIONS.CONSO].indexOf(type as never) === -1)
    throw new Error("Type d'opération invalide.");

  const camions = Array.isArray(p['camions']) ? (p['camions'] as Record<string, unknown>[]) : [];
  if (!camions.length) throw new Error('Au moins un camion est requis.');

  const decl = normaliserDeclaration(p['declaration'] as never, type);
  // v4 — comme en DÉPOTAGE : le TYPE de la déclaration commande le parcours.
  // T = transit → T1 + Balise ; C = mise à la consommation → saute le T1 et
  // l'agent choisit balisée / non balisée (consoMode). Règle unique sautsTypeC.
  const { sauteT1, sauteBalise } = sautsTypeC(decl.typeDeclaration, p['consoMode']);
  const obsCFS = maj(p['observationsCFS'], 1000);
  const chargementTermine = !(p['chargementTermine'] === false);
  const statutInitial = chargementTermine ? STATUTS.CREEE : STATUTS.CHARGEMENT;

  const lignes = camions.map((cam) => construireCamion(cam as never, type, chargementTermine));
  const nbTotal = lignes.reduce((n, cam) => n + cam.conteneurs.length, 0);

  /* ANTI-DOUBLON — I-4 de l'audit, corrigé le 2026-09-10.
   *
   * `createcamion` (flux principal) refusait déjà un camion déjà présent et non
   * sorti. Les flux SPÉCIAUX — Véhicule, Conso, Magasin/MAD, et la saisie en lot
   * ci-dessous — ne faisaient AUCUN contrôle : seul un avertissement côté écran
   * (`cargo.checkdup`) prévenait l'agent, et rien n'empêchait de passer outre ni
   * d'appeler l'API directement.
   *
   * Deux contrôles, dans cet ordre :
   *  1. DANS LE LOT lui-même — deux fois la même plaque dans une seule saisie ;
   *  2. CONTRE LA BASE — une plaque déjà active, donc déjà dans l'enceinte.
   *
   * On vérifie AVANT d'écrire quoi que ce soit : un lot refusé ne doit laisser
   * aucune ligne derrière lui.
   */
  const vues = new Set<string>();
  for (const cam of lignes) {
    const plaque = String(cam.numeroCamion ?? '').trim();
    if (!plaque) continue;
    // Format tracteur/remorque (2026-09-10) — contrôlé aussi sur les flux
    // spéciaux, qui échappaient jusqu'ici à tout contrôle de saisie.
    if (!camionValide(plaque)) throw new ErreurMetier(messageCamionFormat(plaque));
    const norm = plaque.toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (vues.has(norm))
      throw new ErreurMetier(`Le camion « ${plaque} » figure deux fois dans cette saisie.`);
    vues.add(norm);

    const actif = await camionActif(ctx, plaque);
    if (actif)
      throw new ErreurMetier(
        `Le camion « ${plaque} » est déjà dans le système (statut « ${String(actif['statut'])} », `
        + `${String(actif['id'])}). Il ne pourra être recréé qu'après sa sortie.`,
      );
  }

  // v4 — nb de conteneurs déclarés et date en douane devenus facultatifs (décision user).

  const rapportId = await nextRapportId(ctx);
  const now = new Date().toISOString();
  const cree: { id: string; numeroCamion: string }[] = [];
  for (const cam of lignes) {
    const id = await nextId(ctx);
    const row = ligneCamion(id, rapportId, now, cam, type, decl, obsCFS, ctx.session, sauteT1, sauteBalise, statutInitial);
    const { error } = await ctx.db.from('cargaisons').insert(row);
    if (error) throw new Error(error.message);
    await ajouterConteneurs(ctx, rapportId, id, cam.numeroCamion, type, cam.conteneurs);
    cree.push({ id, numeroCamion: cam.numeroCamion });
  }
  const restant = await majApurement(ctx, decl, Number((p['declaration'] as Record<string, unknown>)?.['nombreConteneurs']) || undefined, nbTotal);
  await ctx.log('Création rapport', rapportId, type + ' / ' + cree.length + ' camion(s) : ' + cree.map((c) => c.id).join(', '));
  return { rapportId, camions: cree, apurementRestant: restant };
}

/** Magasin / MAD temps 2 — sortie de marchandise en VRAC (aucun conteneur). */
async function creerRapportMagasin(ctx: Ctx, p: Record<string, unknown>) {
  const numeroCamion = alphaNumMaj(p['numeroCamion']);
  if (!numeroCamion) throw new Error('N° camion requis pour la sortie magasin.');

  /* MAGASIN / MAD — format et anti-doublon (2026-09-10).
   *
   * Ce flux RETOURNE TÔT depuis `create` (dispatch par type d'opération) : ni le
   * contrôle de format ni l'anti-doublon posés plus bas ne le voyaient. Une
   * sortie magasin pouvait donc créer un SECOND dossier pour un camion déjà dans
   * l'enceinte — deux fiches pour un seul camion physique, deux apurements, deux
   * passages à la Porte Principale.
   *
   * Le message ne se contente pas de refuser : il NOMME la cargaison existante
   * et indique la voie à suivre. Un même camion qui emporte de la marchandise
   * relevant de plusieurs déclarations n'est pas un doublon — c'est un
   * CHARGEMENT MIXTE, et il se saisit sur la fiche déjà ouverte. Sans cette
   * indication, l'agent bloqué invente une plaque pour passer outre.
   */
  if (!camionValide(numeroCamion)) throw new ErreurMetier(messageCamionFormat(p['numeroCamion']));

  const actif = await camionActif(ctx, numeroCamion);
  if (actif)
    throw new ErreurMetier(
      `Le camion « ${numeroCamion} » est déjà dans le système : ${String(actif['id'])}, `
      + `statut « ${String(actif['statut'])} ».\n\n`
      + `S'il emporte AUSSI cette marchandise, ce n'est pas un nouveau dossier mais un `
      + `CHARGEMENT MIXTE : ouvrez la fiche ${String(actif['id'])} et utilisez « Chargement mixte » `
      + `pour y ajouter cette déclaration.\n\n`
      + `S'il s'agit d'un autre camion, vérifiez la plaque.`,
    );

  const decl = normaliserDeclaration(p['declaration'] as never, OPERATIONS.MAGASIN);
  const obsCFS = maj(p['observationsCFS'], 1000);
  // v4 — comme en dépotage : type T → T1 + Balise ; type C → saute le T1,
  // balisée ou non balisée selon consoMode (règle unique sautsTypeC).
  const { sauteT1, sauteBalise } = sautsTypeC(decl.typeDeclaration, p['consoMode']);
  // v4.1 — SCELLÉS DU CAMION « comme en dépotage » (décision utilisateur
  // 2026-08-04) : le camion de sortie magasin porte 2-3 scellés, posés à la fin
  // de chargement. Tant qu'ils ne le sont pas, la sortie reste « En cours de
  // chargement » et se finalise depuis la fiche (cargo.sceller).
  const chargementTermine = !(p['chargementTermine'] === false);
  const scellesCamion = (Array.isArray(p['scellesCamion']) ? (p['scellesCamion'] as unknown[]) : [])
    .map((s) => maj(s, 30)).filter(Boolean);
  if (chargementTermine && scellesCamion.length < 2)
    throw new Error('Sortie magasin : au moins 2 scellés camion sont requis (ou décochez « chargement terminé »).');
  if (scellesCamion.length > 3) throw new Error('3 scellés camion maximum.');
  const statut = chargementTermine ? STATUTS.CREEE : STATUTS.CHARGEMENT;
  const rapportId = await nextRapportId(ctx);
  const id = await nextId(ctx);
  const now = new Date().toISOString();
  const row = {
    id, reference: id, date_creation: now, numero_camion: numeroCamion, type_operation: OPERATIONS.MAGASIN,
    twins: false,
    declarant: decl.declarant, contact_declarant: decl.contactDeclarant, destination_marchandise: decl.destinationMarchandise,
    bureau_declaration: decl.bureauDeclaration, type_declaration: decl.typeDeclaration, numero_declaration: decl.numeroDeclaration,
    annee_declaration: decl.anneeDeclaration, description_marchandise: decl.descriptionMarchandise,
    observations_cfs: obsCFS, agent_cfs: ctx.session.nomComplet, agent_cfs_id: ctx.session.userId,
    statut, derniere_maj: now, rapport_id: rapportId,
    conteneurs_details: { conteneurs: [], scellesCamion }, nb_conteneurs: 0,
    saute_t1: sauteT1, saute_balise: sauteBalise,
  };
  const { error } = await ctx.db.from('cargaisons').insert(row);
  if (error) throw new Error(error.message);
  await majApurement(ctx, decl, Number((p['declaration'] as Record<string, unknown>)?.['nombreConteneurs']) || undefined, 0);
  await ctx.log('Sortie Magasin/MAD (vrac)', id, numeroCamion);
  return { rapportId, camions: [{ id, numeroCamion }] };
}

/** Dépotage / Véhicule (régime déclaration ou ouillage). */
async function creerRapportVehicule(ctx: Ctx, p: Record<string, unknown>) {
  const estOuillage = String(p['regime'] ?? '').toLowerCase() === 'ouillage';
  let decl: ReturnType<typeof normaliserDeclaration> | null = null;
  let ouillageNumero = '', ouillageDate: string | null = null;
  if (estOuillage) {
    ouillageNumero = maj(p['ouillageNumero'], 60);
    const d = parseDateImport(p['ouillageDate']);
    ouillageDate = d ? d.toISOString() : null;
    if (!ouillageNumero) throw new Error("Ouillage : le numéro du permis d'examiner est obligatoire.");
    if (!ouillageDate) throw new Error("Ouillage : la date du permis d'examiner est obligatoire.");
    if (Array.isArray(p['camions']) && (p['camions'] as unknown[]).length)
      throw new Error("Ouillage : pas de camions d'effets divers à ce stade (la déclaration n'existe pas encore).");
  } else {
    decl = normaliserDeclaration(p['declaration'] as never, OPERATIONS.VEHICULE);
  }
  const declVide = { declarant: '', contactDeclarant: '', destinationMarchandise: '', bureauDeclaration: '', typeDeclaration: '', numeroDeclaration: '', anneeDeclaration: '', descriptionMarchandise: '' };
  const d = decl ?? declVide;
  const obsCFS = maj(p['observationsCFS'], 1000);
  // v4 — le conteneur d'origine est OBLIGATOIRE (décision utilisateur 2026-07-16) :
  // il est choisi côté écran dans la liste des TC POSITIONNÉS au CFS.
  const conteneurOrigine = maj(p['conteneurOrigine'], 20).replace(/[^A-Z0-9]/g, '');
  if (!conteneurOrigine) throw new Error("Véhicule : le N° de conteneur d'origine (TC) est obligatoire.");
  if (!tcValide(conteneurOrigine))
    throw new Error("N° conteneur d'origine invalide. Format attendu : 4 lettres + 7 chiffres (ex. MSKU1234567).");

  const vehicules = (Array.isArray(p['vehicules']) ? (p['vehicules'] as unknown[]) : []).map((v) => construireVehicule(v as never));
  if (!vehicules.length) throw new Error('Au moins un véhicule est requis.');
  // v4 — camions d'EFFETS DIVERS : N° camion + DÉSIGNATION + scellés (plus de
  // conteneurs propres — les effets proviennent du conteneur d'origine).
  // « Chargement terminé (scellés posés) » reste porté PAR CAMION ; les scellés
  // (2-3, règle dépotage) ne sont exigés que s'il est terminé.
  const camions = estOuillage
    ? []
    : (Array.isArray(p['camions']) ? (p['camions'] as Record<string, unknown>[]) : []).map((src) => construireCamionEffets(src));

  /* Format tracteur/remorque sur les camions d'effets divers (2026-09-10).
   *
   * Ce flux RETOURNE TÔT depuis `create` (dispatch par type d'opération) : le
   * contrôle posé plus bas ne le voyait donc jamais. Ces camions portent pourtant
   * de vraies plaques et entrent dans le même parcours que les autres.
   *
   * Le châssis du VÉHICULE, lui, n'est pas concerné — un VIN ne comporte pas de
   * barre oblique. Seules les plaques sont contrôlées. */
  for (const cam of camions) {
    const plaque = String(cam.numeroCamion ?? '').trim();
    if (plaque && !camionValide(plaque)) throw new ErreurMetier(messageCamionFormat(plaque));
  }

  /* ANTI-DOUBLON DES VÉHICULES — 2026-09-12.
   *
   * Constaté en production : le châssis 732382 créé TROIS FOIS à 12:23, trois
   * dossiers « Créée » en attente du chef de brigade. Le flux véhicule était le
   * dernier à n'avoir AUCUN contrôle serveur : `create` refuse une plaque déjà
   * active, mais ce parcours retourne avant ce contrôle, et l'écran ne vérifiait
   * que le premier châssis — sans empêcher un second clic sur « Créer ».
   *
   * Mêmes deux contrôles que les camions, AVANT toute écriture :
   *  1. dans la saisie elle-même (même châssis ou même plaque deux fois) ;
   *  2. contre la base (déjà présent et pas encore sorti). */
  const vus = new Set<string>();
  const numeros = [
    ...vehicules.map((v) => ({ n: v.chassis, quoi: 'véhicule (châssis)' })),
    ...camions.map((c) => ({ n: String(c.numeroCamion ?? '').trim(), quoi: 'camion' })),
  ];
  for (const { n, quoi } of numeros) {
    const norm = n.toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!norm) continue;
    if (vus.has(norm)) throw new ErreurMetier(`Le ${quoi} « ${n} » figure deux fois dans cette saisie.`);
    vus.add(norm);
    const actif = await camionActif(ctx, n);
    if (actif)
      throw new ErreurMetier(
        `Le ${quoi} « ${n} » est déjà dans le système (statut « ${String(actif['statut'])} », `
        + `${String(actif['id'])}). Ouvrez ce dossier pour le compléter ou le corriger, au lieu d'en créer un second.`,
      );
  }

  const rapportId = await nextRapportId(ctx);
  const now = new Date().toISOString();
  const creeV: { id: string; chassis: string }[] = [];
  const creeC: { id: string; numeroCamion: string }[] = [];

  for (let i = 0; i < vehicules.length; i++) {
    const v = vehicules[i]!;
    // Le TC d'origine est compté (stock + apurement) sur le 1er véhicule du rapport.
    const porteur = i === 0;
    const id = await nextId(ctx);
    const row: Record<string, unknown> = {
      id, reference: id, date_creation: now, numero_camion: v.chassis, type_operation: OPERATIONS.VEHICULE, twins: false,
      declarant: d.declarant, contact_declarant: d.contactDeclarant, destination_marchandise: d.destinationMarchandise,
      bureau_declaration: d.bureauDeclaration, type_declaration: d.typeDeclaration, numero_declaration: d.numeroDeclaration,
      annee_declaration: d.anneeDeclaration, description_marchandise: d.descriptionMarchandise,
      observations_cfs: obsCFS, agent_cfs: ctx.session.nomComplet, agent_cfs_id: ctx.session.userId,
      statut: STATUTS.CREEE, balise_requise: false, derniere_maj: now, rapport_id: rapportId,
      conteneurs_details: porteur
        ? { conteneurs: [{ num: conteneurOrigine, plomb: '', taille: '', type: '', poids: '', extra: [] }], scellesCamion: [] }
        : { conteneurs: [], scellesCamion: [] },
      nb_conteneurs: porteur ? 1 : 0,
      est_vehicule: true, vehicule_details: v, conteneur_origine: conteneurOrigine,
      saute_t1: false, saute_balise: true,
    };
    if (estOuillage) { row['statut'] = STATUTS.VEHICULE_OUILLAGE; row['ouillage_numero'] = ouillageNumero; row['ouillage_date'] = ouillageDate; }
    const { error } = await ctx.db.from('cargaisons').insert(row);
    if (error) throw new Error(error.message);
    if (porteur) {
      await ajouterConteneurs(ctx, rapportId, id, v.chassis, OPERATIONS.VEHICULE, [{ num: conteneurOrigine, plomb: '', taille: '', type: '', poids: '', extra: [] }]);
      await lierStock(ctx, conteneurOrigine, id);
    }
    creeV.push({ id, chassis: v.chassis });
  }
  for (const cam of camions) {
    const id = await nextId(ctx);
    const statutCam = cam.chargementTermine ? STATUTS.CREEE : STATUTS.CHARGEMENT;
    const vide: CamionConstruit = {
      numeroCamion: cam.numeroCamion, twins: 'No', conteneurs: [], nbConteneurs: 0,
      scellesCamion: cam.scellesCamion, conteneursDetails: { conteneurs: [], scellesCamion: cam.scellesCamion },
    };
    const row = ligneCamion(id, rapportId, now, vide, OPERATIONS.DEPOTAGE, d as never, obsCFS, ctx.session, false, false, statutCam);
    row['description_marchandise'] = cam.designation; // désignation des effets divers
    row['conteneur_origine'] = conteneurOrigine;
    const { error } = await ctx.db.from('cargaisons').insert(row);
    if (error) throw new Error(error.message);
    creeC.push({ id, numeroCamion: cam.numeroCamion });
  }

  await ctx.log(
    'Création rapport véhicule' + (estOuillage ? ' (OUILLAGE ' + ouillageNumero + ')' : ''), rapportId,
    creeV.length + ' véhicule(s)' + (creeC.length ? ' + ' + creeC.length + ' camion(s)' : '') + (conteneurOrigine ? ' · conteneur ' + conteneurOrigine : ''),
  );
  return { rapportId, vehicules: creeV, camions: creeC, ouillage: estOuillage };
}

/** v3.6 — OUILLAGE : compléter la déclaration d'un véhicule dépoté. */
export async function ouillagedecl(ctx: Ctx, p: Record<string, unknown>) {
  const id = String(p['id'] ?? '').trim();
  const decl = normaliserDeclaration(p['declaration'] as never, OPERATIONS.VEHICULE);
  const estTransit = decl.typeDeclaration === 'T';
  const cargo = await getCargo(ctx, id);
  const c = cargo.o;
  if (c['estVehicule'] !== true && c['estVehicule'] !== 'Oui') throw new Error('Action réservée aux véhicules.');
  if (ctx.session.role !== ROLES.ADMIN && c['statut'] !== STATUTS.VEHICULE_OUILLAGE)
    throw new Error('Déclaration impossible : le véhicule doit être au statut « Véhicule ouillage créé » (statut « ' + c['statut'] + ' »).');
  const patch: Record<string, unknown> = {
    declarant: decl.declarant, contact_declarant: decl.contactDeclarant, destination_marchandise: decl.destinationMarchandise,
    bureau_declaration: decl.bureauDeclaration, type_declaration: decl.typeDeclaration, numero_declaration: decl.numeroDeclaration,
    annee_declaration: decl.anneeDeclaration,
    saute_t1: !estTransit, saute_balise: true, saute_bs: true, statut: STATUTS.CREEE,
  };
  if (decl.descriptionMarchandise) patch['description_marchandise'] = decl.descriptionMarchandise;
  await patchCargo(ctx, cargo, patch);
  await ctx.log('Ouillage — déclaration véhicule', id, decl.numeroDeclaration + ' (' + decl.typeDeclaration + (estTransit ? ' → T1' : ' → PP') + ')');
  return { id, transit: estTransit };
}
