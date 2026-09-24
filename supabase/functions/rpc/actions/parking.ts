/**
 * ============================================================================
 *  PARKING — camions stationnés, pointés chaque jour (2026-09-24, demande user)
 *
 *  Le premier jour, l'agent AJOUTE le camion (plaque obligatoire, conteneur et
 *  plomb facultatifs) et peut le pointer dans la foulée. Les jours suivants le
 *  camion est déjà en base : l'agent le retrouve en tapant sa plaque et le
 *  pointe d'un bouton, qui disparaît ensuite — un camion ne se pointe qu'UNE
 *  FOIS par jour (même règle que le pointage des conteneurs, voir stock.ts).
 *
 *  SORTIE DU PARKING : automatique, quand le camion est signalé à la Porte
 *  Principale (décision utilisateur). Voir `fermerParkingPourCamion`, appelée
 *  par `cargo.sortie`. Un chef ou l'administrateur peut aussi la déclarer à la
 *  main : un camion peut quitter le parc sans jamais passer par un dossier.
 *
 *  ⚠ LES TABLES PEUVENT NE PAS EXISTER (migration 00201 pas encore appliquée).
 *  Comme pour les paramètres : la lecture rend une liste vide plutôt que de
 *  tomber, et l'écriture explique pourquoi elle est refusée.
 * ============================================================================
 */
import type { Ctx } from '../ctx.ts';
import { ErreurMetier } from '../ctx.ts';
import { versCamel } from '../ctx.ts';
import { alphaNumMaj, camionValide, messageCamionFormat, maj, normAlphaNum } from '../../_shared/domaine/src/index.ts';
import { nextRef } from './helpers.ts';

const PRESENT = 'Présent';
const SORTI = 'Sorti';

/** Le jour civil, en date ISO — l'unité du pointage. */
const jour = (v?: unknown) => (v ? new Date(String(v)) : new Date()).toISOString().slice(0, 10);

/** Message unique quand les tables manquent : l'agent doit savoir quoi demander. */
const TABLES_ABSENTES =
  'Le parking n\'est pas encore activé : les tables « parking_camions » et « parking_pointages » '
  + '(migration 00201) n\'existent pas en base.';

function estTableAbsente(message: string): boolean {
  return /parking_(camions|pointages)/.test(message) && /does not exist|relation/i.test(message);
}

/**
 * Durée du séjour au parking, EN MINUTES : de l'entrée à la sortie pour un
 * camion sorti, jusqu'à maintenant pour un camion encore présent. L'écran la
 * lit ensuite en heures ou en jours selon sa longueur (`dureeLisible`).
 */
function dureeSejour(l: Record<string, unknown>): number | null {
  const debut = Date.parse(String(l['dateEntree'] ?? ''));
  if (isNaN(debut)) return null;
  const finBrute = l['statut'] === SORTI ? Date.parse(String(l['dateSortie'] ?? '')) : Date.now();
  const fin = isNaN(finBrute) ? Date.now() : finBrute;
  return Math.max(0, Math.round((fin - debut) / 60000));
}

/* --------------------------------- lecture -------------------------------- */

interface LigneParking extends Record<string, unknown> {
  id: string;
  numeroCamion: string;
  pointeAujourdhui: boolean;
}

/**
 * `parking.list` — les camions du parking.
 *
 * `recherche` filtre sur la plaque NORMALISÉE : l'agent tape « 2489 » et ne
 * garde que les camions qui portent ces chiffres, à chaque caractère saisi.
 */
export async function parkingList(ctx: Ctx, p: Record<string, unknown>) {
  const recherche = normAlphaNum(p['recherche']);
  const statut = String(p['statut'] ?? 'presents');
  /* PÉRIODE (2026-09-24, demande utilisateur) : jour, mois, année ou plage.
     L'écran envoie deux bornes ; on les applique à la DATE D'ENTRÉE au parking,
     qui est la date qui situe le séjour. */
  const du = String(p['du'] ?? '').slice(0, 10);
  const au = String(p['au'] ?? '').slice(0, 10);

  let q = ctx.db.from('parking_camions').select('*').order('date_entree', { ascending: false });
  if (statut === 'presents') q = q.eq('statut', PRESENT);
  else if (statut === 'sortis') q = q.eq('statut', SORTI);
  if (du) q = q.gte('date_entree', du + 'T00:00:00');
  if (au) q = q.lte('date_entree', au + 'T23:59:59.999');
  const { data, error } = await q;
  if (error) {
    if (estTableAbsente(error.message)) return { lignes: [], compte: { presents: 0, pointes: 0, restants: 0 }, active: false };
    throw new Error(error.message);
  }

  const lignes = (data ?? []).map((r) => versCamel(r as Record<string, unknown>) as LigneParking)
    .filter((l) => !recherche || String(l['numeroCamionNorm'] ?? '').indexOf(recherche) > -1);

  // Pointages du jour, pour les seules lignes affichées.
  const aujourdhui = jour();
  const pointesAujourdhui = new Set<string>();
  const dernier = new Map<string, string>();
  const { data: pts, error: e2 } = await ctx.db.from('parking_pointages').select('parking_id, jour, pointe_par');
  if (e2 && !estTableAbsente(e2.message)) throw new Error(e2.message);
  for (const r of (pts ?? []) as Record<string, unknown>[]) {
    const id = String(r['parking_id']);
    const j = String(r['jour'] ?? '').slice(0, 10);
    if (j === aujourdhui) pointesAujourdhui.add(id);
    if (!dernier.has(id) || j > dernier.get(id)!) dernier.set(id, j);
  }

  const compte = { presents: 0, pointes: 0, restants: 0 };
  for (const l of lignes) {
    l.pointeAujourdhui = pointesAujourdhui.has(l.id);
    l['dernierPointage'] = dernier.get(l.id) ?? '';
    l['dureeMinutes'] = dureeSejour(l);
    if (l['statut'] === PRESENT) {
      compte.presents++;
      if (l.pointeAujourdhui) compte.pointes++;
      else compte.restants++;
    }
  }
  return { lignes, compte, active: true, jour: aujourdhui, du, au };
}

/** `parking.detail` — une ligne et TOUS ses pointages (l'historique du séjour). */
export async function parkingDetail(ctx: Ctx, p: Record<string, unknown>) {
  const id = String(p['id'] ?? '').trim();
  if (!id) throw new ErreurMetier('Identifiant requis.');
  const { data, error } = await ctx.db.from('parking_camions').select('*').eq('id', id).maybeSingle();
  if (error) throw new Error(estTableAbsente(error.message) ? TABLES_ABSENTES : error.message);
  if (!data) throw new ErreurMetier('Camion introuvable au parking.');
  const { data: pts, error: e2 } = await ctx.db.from('parking_pointages')
    .select('jour, pointe_le, pointe_par').eq('parking_id', id).order('jour', { ascending: false });
  if (e2) throw new Error(e2.message);
  const ligne = versCamel(data as Record<string, unknown>) as LigneParking;
  const pointages = (pts ?? []).map((r) => versCamel(r as Record<string, unknown>));
  ligne.pointeAujourdhui = pointages.some((x) => String(x['jour'] ?? '').slice(0, 10) === jour());
  ligne['dureeMinutes'] = dureeSejour(ligne);
  return { ligne, pointages };
}

/**
 * `parking.check` — ce camion est-il AU PARKING en ce moment ?
 *
 * Appelée par les écrans de saisie avant d'enregistrer une cargaison : l'agent
 * est prévenu, et décide lui-même de continuer ou non. Elle n'interdit RIEN —
 * un camion au parking a parfaitement le droit d'être enregistré.
 */
export async function parkingCheck(ctx: Ctx, p: Record<string, unknown>) {
  const norm = normAlphaNum(p['numeroCamion']);
  if (!norm) return { present: false };
  const { data, error } = await ctx.db.from('parking_camions').select('*')
    .eq('numero_camion_norm', norm).eq('statut', PRESENT).order('date_entree', { ascending: false });
  if (error) {
    if (estTableAbsente(error.message)) return { present: false };
    throw new Error(error.message);
  }
  const ligne = (data ?? [])[0];
  if (!ligne) return { present: false };
  return { present: true, ligne: versCamel(ligne as Record<string, unknown>) };
}

/* -------------------------------- écriture -------------------------------- */

async function lirePresent(ctx: Ctx, norm: string) {
  const { data, error } = await ctx.db.from('parking_camions').select('*')
    .eq('numero_camion_norm', norm).eq('statut', PRESENT);
  if (error) throw new Error(estTableAbsente(error.message) ? TABLES_ABSENTES : error.message);
  return (data ?? [])[0] as Record<string, unknown> | undefined;
}

/** Écrit le pointage du jour. `false` si le camion était déjà pointé. */
async function poserPointage(ctx: Ctx, parkingId: string): Promise<boolean> {
  const j = jour();
  // L'identifiant PORTE le jour : deux pointages du même camion le même jour
  // ont le même identifiant, et le second est rejeté par la clé primaire même
  // si deux agents cliquent à la même seconde.
  const id = parkingId + '#' + j;
  const { data: existe, error: e1 } = await ctx.db.from('parking_pointages').select('id').eq('id', id);
  if (e1) throw new Error(estTableAbsente(e1.message) ? TABLES_ABSENTES : e1.message);
  if (existe && existe.length) return false;
  const { error } = await ctx.db.from('parking_pointages').insert({
    id, parking_id: parkingId, jour: j, pointe_le: new Date().toISOString(), pointe_par: ctx.session.nomComplet,
  });
  if (error) throw new Error(error.message);
  return true;
}

/**
 * `parking.add` — ajoute un camion au parking.
 *
 * `pointer` (vrai par défaut) pose le pointage du jour dans la foulée : l'agent
 * qui saisit un camion qu'il a sous les yeux n'a pas à le pointer ensuite.
 */
export async function parkingAdd(ctx: Ctx, p: Record<string, unknown>) {
  const numeroCamion = alphaNumMaj(p['numeroCamion']);
  if (!numeroCamion) throw new ErreurMetier('N° camion requis.');
  if (!camionValide(numeroCamion)) throw new ErreurMetier(messageCamionFormat(p['numeroCamion']));
  const norm = normAlphaNum(numeroCamion);

  const deja = await lirePresent(ctx, norm);
  if (deja)
    throw new ErreurMetier(
      'Le camion « ' + String(deja['numero_camion']) + ' » est DÉJÀ au parking (entré le '
      + String(deja['date_entree'] ?? '').slice(0, 10) + '). Pointez-le depuis la liste.',
    );

  const id = await nextRef(ctx, 'SEQ_PARK', 'PK');
  const now = new Date().toISOString();
  const { error } = await ctx.db.from('parking_camions').insert({
    id, numero_camion: numeroCamion, numero_camion_norm: norm,
    numero_conteneur: alphaNumMaj(p['numeroConteneur']), plomb: maj(p['plomb'], 60),
    statut: PRESENT, date_entree: now, cree_par: ctx.session.nomComplet, derniere_maj: now,
  });
  if (error) throw new Error(estTableAbsente(error.message) ? TABLES_ABSENTES : error.message);

  const pointe = p['pointer'] === false ? false : await poserPointage(ctx, id);
  await ctx.log('Entrée parking', id, numeroCamion + (pointe ? ' · pointé' : ''));
  return { id, numeroCamion, pointe };
}

/** `parking.point` — pointage du jour. Refusé deux fois le même jour. */
export async function parkingPointer(ctx: Ctx, p: Record<string, unknown>) {
  const id = String(p['id'] ?? '').trim();
  if (!id) throw new ErreurMetier('Identifiant requis.');
  const { data, error } = await ctx.db.from('parking_camions').select('*').eq('id', id).maybeSingle();
  if (error) throw new Error(estTableAbsente(error.message) ? TABLES_ABSENTES : error.message);
  if (!data) throw new ErreurMetier('Camion introuvable au parking.');
  if (data['statut'] === SORTI)
    throw new ErreurMetier('Le camion « ' + String(data['numero_camion']) + ' » est sorti du parking : il ne peut plus être pointé.');

  const pose = await poserPointage(ctx, id);
  if (!pose)
    throw new ErreurMetier('Le camion « ' + String(data['numero_camion']) + ' » est DÉJÀ POINTÉ aujourd\'hui.');
  await ctx.db.from('parking_camions').update({ derniere_maj: new Date().toISOString() }).eq('id', id);
  await ctx.log('Pointage parking', id, String(data['numero_camion']));
  return { id, numeroCamion: data['numero_camion'], jour: jour() };
}

/**
 * Ferme le séjour de tout camion présent portant cette plaque.
 *
 * Appelée par `cargo.sortie` : le camion signalé à la Porte Principale a quitté
 * le parking, c'est la règle retenue. Silencieuse par construction — si les
 * tables n'existent pas ou qu'aucun camion ne correspond, la sortie du dossier
 * n'a aucune raison d'échouer pour autant.
 */
export async function fermerParkingPourCamion(ctx: Ctx, numeroCamion: unknown, cargaisonId = ''): Promise<number> {
  const norm = normAlphaNum(numeroCamion);
  if (!norm) return 0;
  try {
    const { data, error } = await ctx.db.from('parking_camions').select('id, numero_camion')
      .eq('numero_camion_norm', norm).eq('statut', PRESENT);
    if (error) return 0;
    const lignes = (data ?? []) as Record<string, unknown>[];
    const now = new Date().toISOString();
    for (const l of lignes) {
      await ctx.db.from('parking_camions').update({
        statut: SORTI, date_sortie: now, sortie_par: ctx.session.nomComplet,
        sortie_cargaison: cargaisonId, derniere_maj: now,
      }).eq('id', String(l['id']));
      await ctx.log('Sortie parking (Porte Principale)', String(l['id']),
        String(l['numero_camion']) + (cargaisonId ? ' · ' + cargaisonId : ''));
    }
    return lignes.length;
  } catch {
    return 0; // parking non activé : la sortie du dossier reste prioritaire
  }
}

/**
 * `parking.edit` — corriger une ligne du parking (TOUS les rôles).
 *
 * La plaque elle-même est modifiable : une erreur de saisie doit pouvoir être
 * réparée par celui qui la constate. Deux camions PRÉSENTS ne peuvent pas
 * porter la même plaque — c'est ce que vérifie le contrôle ci-dessous. Chaque
 * correction est inscrite au journal, avec l'avant et l'après.
 */
export async function parkingEdit(ctx: Ctx, p: Record<string, unknown>) {
  const id = String(p['id'] ?? '').trim();
  if (!id) throw new ErreurMetier('Identifiant requis.');
  const { data, error } = await ctx.db.from('parking_camions').select('*').eq('id', id).maybeSingle();
  if (error) throw new Error(estTableAbsente(error.message) ? TABLES_ABSENTES : error.message);
  if (!data) throw new ErreurMetier('Camion introuvable au parking.');

  const patch: Record<string, unknown> = { derniere_maj: new Date().toISOString() };
  const traces: string[] = [];

  if (p['numeroCamion'] !== undefined) {
    const numeroCamion = alphaNumMaj(p['numeroCamion']);
    if (!numeroCamion) throw new ErreurMetier('N° camion requis.');
    if (!camionValide(numeroCamion)) throw new ErreurMetier(messageCamionFormat(p['numeroCamion']));
    const norm = normAlphaNum(numeroCamion);
    if (norm !== String(data['numero_camion_norm'])) {
      const autre = await lirePresent(ctx, norm);
      if (autre && String(autre['id']) !== id)
        throw new ErreurMetier('Le camion ' + numeroCamion + ' est deja au parking sous une autre ligne.');
      traces.push('camion ' + String(data['numero_camion']) + ' -> ' + numeroCamion);
      patch['numero_camion'] = numeroCamion;
      patch['numero_camion_norm'] = norm;
    }
  }
  if (p['numeroConteneur'] !== undefined) {
    const ct = alphaNumMaj(p['numeroConteneur']);
    if (ct !== String(data['numero_conteneur'] ?? '')) {
      traces.push('conteneur ' + (String(data['numero_conteneur'] ?? '') || '(vide)') + ' -> ' + (ct || '(vide)'));
      patch['numero_conteneur'] = ct;
    }
  }
  if (p['plomb'] !== undefined) {
    const pl = maj(p['plomb'], 60);
    if (pl !== String(data['plomb'] ?? '')) {
      traces.push('plomb ' + (String(data['plomb'] ?? '') || '(vide)') + ' -> ' + (pl || '(vide)'));
      patch['plomb'] = pl;
    }
  }
  if (!traces.length) return { id, inchange: true };

  const { error: e2 } = await ctx.db.from('parking_camions').update(patch).eq('id', id);
  if (e2) throw new Error(e2.message);
  await ctx.log('Correction parking', id, traces.join(' · '));
  return { id, modifie: traces.length };
}

/**
 * `parking.delete` — supprime la ligne ET ses pointages (ADMINISTRATEUR).
 *
 * SUPPRESSION RÉELLE, réservée à la ligne créée par erreur. Un camion qui a bel
 * et bien stationné se SORT (`parking.sortie`) : son séjour appartient à
 * l'historique. Le motif est obligatoire et reste au journal.
 */
export async function parkingSupprimer(ctx: Ctx, p: Record<string, unknown>) {
  const id = String(p['id'] ?? '').trim();
  const motif = maj(p['motif'], 200);
  if (!id) throw new ErreurMetier('Identifiant requis.');
  if (!motif) throw new ErreurMetier('Motif de la suppression requis.');
  const { data, error } = await ctx.db.from('parking_camions').select('*').eq('id', id).maybeSingle();
  if (error) throw new Error(estTableAbsente(error.message) ? TABLES_ABSENTES : error.message);
  if (!data) throw new ErreurMetier('Camion introuvable au parking.');

  // Les pointages d'abord : la base les efface en cascade, mais l'ordre ne doit
  // pas dépendre de cette garantie.
  const { error: e1 } = await ctx.db.from('parking_pointages').delete().eq('parking_id', id);
  if (e1) throw new Error(e1.message);
  const { error: e2 } = await ctx.db.from('parking_camions').delete().eq('id', id);
  if (e2) throw new Error(e2.message);
  await ctx.log('Suppression parking', id, String(data['numero_camion']) + ' · ' + motif);
  return { id, numeroCamion: data['numero_camion'] };
}

/**
 * `parking.sortie` — sortie déclarée à la main (chefs et administrateur).
 *
 * La sortie normale est automatique à la Porte Principale. Celle-ci existe pour
 * le camion qui quitte le parc SANS dossier : sans elle il resterait « présent »
 * indéfiniment et fausserait le comptage.
 */
export async function parkingSortie(ctx: Ctx, p: Record<string, unknown>) {
  const id = String(p['id'] ?? '').trim();
  const motif = maj(p['motif'], 200);
  if (!id) throw new ErreurMetier('Identifiant requis.');
  if (!motif) throw new ErreurMetier('Motif de la sortie requis.');
  const { data, error } = await ctx.db.from('parking_camions').select('*').eq('id', id).maybeSingle();
  if (error) throw new Error(estTableAbsente(error.message) ? TABLES_ABSENTES : error.message);
  if (!data) throw new ErreurMetier('Camion introuvable au parking.');
  if (data['statut'] === SORTI) throw new ErreurMetier('Ce camion est déjà sorti du parking.');
  const now = new Date().toISOString();
  const { error: e2 } = await ctx.db.from('parking_camions').update({
    statut: SORTI, date_sortie: now, sortie_par: ctx.session.nomComplet, derniere_maj: now,
  }).eq('id', id);
  if (e2) throw new Error(e2.message);
  await ctx.log('Sortie parking (manuelle)', id, String(data['numero_camion']) + ' · ' + motif);
  return { id, numeroCamion: data['numero_camion'] };
}
