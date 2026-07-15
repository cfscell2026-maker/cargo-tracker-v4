/**
 * ============================================================================
 *  Flux SPÉCIAUX — cargo.create (Dépotage/Enlèvement/Conso groupés, Véhicule,
 *  Magasin/MAD) + cargo.ouillagedecl. Transcription fidèle de Data.gs (v3.6).
 * ============================================================================
 */
import type { Ctx } from '../ctx.ts';
import {
  ROLES, STATUTS, OPERATIONS,
  alphaNumMaj, maj, txt, tcValide, parseDateImport,
  normaliserDeclaration, construireCamion, construireVehicule, type CamionConstruit,
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

  const estConso = type === OPERATIONS.CONSO;
  const sauteBalise = estConso && String(p['consoMode']) === 'sansbalise';
  const sauteT1 = estConso;

  const decl = normaliserDeclaration(p['declaration'] as never, type);
  const obsCFS = maj(p['observationsCFS'], 1000);
  const chargementTermine = !(p['chargementTermine'] === false);
  const statutInitial = chargementTermine ? STATUTS.CREEE : STATUTS.CHARGEMENT;

  const lignes = camions.map((cam) => construireCamion(cam as never, type, chargementTermine));
  const nbTotal = lignes.reduce((n, cam) => n + cam.conteneurs.length, 0);

  if (!(await lookupDeclaration(ctx, decl)).exists && !(Number((p['declaration'] as Record<string, unknown>)?.['nombreConteneurs']) >= 1))
    throw new Error('Nouvelle déclaration : indiquez le « nombre de conteneurs » déclarés.');

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
  const decl = normaliserDeclaration(p['declaration'] as never, OPERATIONS.MAGASIN);
  const obsCFS = maj(p['observationsCFS'], 1000);
  const sauteBalise = String(p['consoMode']) === 'sansbalise';
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
    statut: STATUTS.CREEE, derniere_maj: now, rapport_id: rapportId,
    conteneurs_details: { conteneurs: [], scellesCamion: [] }, nb_conteneurs: 0,
    saute_t1: true, saute_balise: sauteBalise,
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
  const conteneurOrigine = maj(p['conteneurOrigine'], 20).replace(/[^A-Z0-9]/g, '');
  if (conteneurOrigine && !tcValide(conteneurOrigine))
    throw new Error("N° conteneur d'origine invalide. Format attendu : 4 lettres + 7 chiffres (ex. MSKU1234567).");

  const vehicules = (Array.isArray(p['vehicules']) ? (p['vehicules'] as unknown[]) : []).map((v) => construireVehicule(v as never));
  if (!vehicules.length) throw new Error('Au moins un véhicule est requis.');
  const camions = estOuillage
    ? []
    : (Array.isArray(p['camions']) ? (p['camions'] as unknown[]) : []).map((cam) => construireCamion(cam as never, OPERATIONS.DEPOTAGE));

  const numsCamions: string[] = [];
  camions.forEach((cam) => cam.conteneurs.forEach((ct) => numsCamions.push(ct.num)));
  const compteSurVehicule = !!conteneurOrigine && numsCamions.indexOf(conteneurOrigine) === -1;

  const rapportId = await nextRapportId(ctx);
  const now = new Date().toISOString();
  const creeV: { id: string; chassis: string }[] = [];
  const creeC: { id: string; numeroCamion: string }[] = [];

  for (let i = 0; i < vehicules.length; i++) {
    const v = vehicules[i]!;
    const porteur = i === 0 && compteSurVehicule;
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
    const row = ligneCamion(id, rapportId, now, cam, OPERATIONS.DEPOTAGE, d as never, obsCFS, ctx.session, false, false, STATUTS.CREEE);
    row['conteneur_origine'] = conteneurOrigine;
    const { error } = await ctx.db.from('cargaisons').insert(row);
    if (error) throw new Error(error.message);
    for (const ct of cam.conteneurs) await lierStock(ctx, ct.num, id);
    await ajouterConteneurs(ctx, rapportId, id, cam.numeroCamion, OPERATIONS.DEPOTAGE, cam.conteneurs);
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
