/**
 * ============================================================================
 *  TRANSMISSION D'UN ENGAGEMENT (2026-10-28, demande utilisateur).
 *
 *  Le bouton « Effectué » soldait l'engagement en un clic : on savait QUE les
 *  informations avaient été transmises, jamais LESQUELLES. Il est remplacé par
 *  cette fiche, qui porte ce qu'on a réellement déclaré.
 *
 *  DEUX VOLETS, ET DEUX MOMENTS (décision utilisateur) :
 *    · le DÉPART se saisit quand on transmet : pays, numéro IM4, marchandises ;
 *    · l'ARRIVÉE se saisit plus tard, quand le pays de destination répond,
 *      parfois des semaines après. La fiche se rouvre autant de fois qu'il faut.
 *
 *  L'ARRIVÉE, CE SONT LES DÉCLARATIONS « C » (2026-10-30, demande utilisateur).
 *  La preuve de la mise à la consommation dans le pays de destination : chaque
 *  C (« C 14985 » du 11/07/2026) avec la désignation et la quantité qu'il
 *  couvre, plusieurs par engagement. Le total à l'arrivée est la somme de
 *  leurs quantités, et c'est le PREMIER C qui APURE l'engagement, non plus le
 *  départ : transmettre ne prouve pas que la marchandise est arrivée.
 *
 *  Les règles (manques, écarts) vivent dans le domaine (`transmission.ts`) : elles
 *  se testent sans base, et donnent le même résultat à l'écran et au serveur.
 * ============================================================================
 */
import type { Ctx } from '../ctx.ts';
import { ErreurMetier } from '../ctx.ts';
import { getCargo, patchCargo, nextRef } from './helpers.ts';
import {
  manqueAuDepart, manqueDeclarationsC, nombreOuNull, totauxApurement,
  aFait, txt, type MarchandiseTransmise, type DeclarationC,
} from '../../_shared/domaine/src/index.ts';

const TABLES_ABSENTES =
  'La transmission des engagements n\'est pas encore activée : les tables '
  + '« engagement_transmission » et « engagement_marchandises » (migration 00213) '
  + 'n\'existent pas en base.';
const TABLE_C_ABSENTE =
  'Les déclarations C ne sont pas encore activées : la table « engagement_declarations_c » '
  + '(migration 00218) n\'existe pas en base.';

/* ⚠ Trois formulations, cf. `rapprochement.ts` : PostgREST annonce aussi une
   table absente par « schema cache » quand elle existe mais qu'il ne l'a pas
   relue. Se rafraîchit avec `NOTIFY pgrst, 'reload schema';`. */
function estTableAbsente(message: string): boolean {
  return /engagement_(transmission|marchandises|declarations_c)/.test(message)
    && /does not exist|relation|schema cache/i.test(message);
}

interface LigneBase { id: string; rang: number; designation: string; quantite_depart: number; quantite_arrivee: number | null }
interface LigneC { numero_c: string; date_c: string; designation: string; quantite: number }

/** Les marchandises reçues de l'écran, ramenées à ce que le domaine sait lire. */
function lireMarchandises(v: unknown): MarchandiseTransmise[] {
  if (!Array.isArray(v)) return [];
  return v.slice(0, 200).map((x) => {
    const o = (x ?? {}) as Record<string, unknown>;
    return {
      designation: txt(o['designation'], 200),
      quantiteDepart: nombreOuNull(o['quantiteDepart']) ?? 0,
      quantiteArrivee: nombreOuNull(o['quantiteArrivee']),
    };
  });
}

/** Les C reçus de l'écran. */
function lireDeclarationsC(v: unknown): DeclarationC[] {
  if (!Array.isArray(v)) return [];
  return v.slice(0, 100).map((x) => {
    const o = (x ?? {}) as Record<string, unknown>;
    return {
      numeroC: txt(o['numeroC'], 40),
      dateC: txt(o['dateC'], 10),
      designation: txt(o['designation'], 200),
      quantite: nombreOuNull(o['quantite']),
    };
  });
}

/** La fiche d'une cargaison, ou `null` si rien n'a encore été transmis. */
export async function transmissionLire(ctx: Ctx, p: Record<string, unknown>) {
  const id = String(p['id'] ?? '').trim();
  if (!id) throw new ErreurMetier('Cargaison non précisée.');

  const { data, error } = await ctx.db.from('engagement_transmission')
    .select('*').eq('cargaison_id', id).maybeSingle();
  if (error) {
    // Table absente : il n'y a simplement rien de transmis, l'écran s'ouvre vide.
    if (estTableAbsente(error.message)) return { transmission: null, marchandises: [], declarationsC: [], active: false };
    throw new Error(error.message);
  }
  if (!data) return { transmission: null, marchandises: [], declarationsC: [], active: true, cActives: true };
  const transmissionId = (data as Record<string, unknown>)['id'];

  const { data: lignes, error: e2 } = await ctx.db.from('engagement_marchandises')
    .select('*').eq('transmission_id', transmissionId).order('rang', { ascending: true });
  if (e2) throw new Error(e2.message);

  const marchandises = ((lignes ?? []) as unknown as LigneBase[]).map((l) => ({
    designation: String(l.designation ?? ''),
    quantiteDepart: Number(l.quantite_depart ?? 0),
    quantiteArrivee: l.quantite_arrivee === null || l.quantite_arrivee === undefined
      ? null : Number(l.quantite_arrivee),
  }));

  // Sans la table des C (00218 pas encore passée), la fiche s'ouvre quand même.
  let declarationsC: DeclarationC[] = [];
  let cActives = true;
  const { data: cs, error: e3 } = await ctx.db.from('engagement_declarations_c')
    .select('*').eq('transmission_id', transmissionId).order('rang', { ascending: true });
  if (e3) {
    if (!estTableAbsente(e3.message)) throw new Error(e3.message);
    cActives = false;
  } else {
    declarationsC = ((cs ?? []) as unknown as LigneC[]).map((c) => ({
      numeroC: String(c.numero_c ?? ''),
      dateC: String(c.date_c ?? '').slice(0, 10),
      designation: String(c.designation ?? ''),
      quantite: Number(c.quantite ?? 0),
    }));
  }
  return { transmission: data, marchandises, declarationsC, totaux: totauxApurement(marchandises, declarationsC), active: true, cActives };
}

/**
 * Enregistre le DÉPART : pays, numéro IM4, marchandises.
 *
 * Il ne solde plus l'engagement (2026-10-30) : c'est le premier C qui l'apure.
 * Il reste REJOUABLE : une erreur de frappe sur un numéro IM4 se corrige, sans
 * quoi il faudrait retirer l'engagement pour le recréer.
 */
export async function transmissionDepart(ctx: Ctx, p: Record<string, unknown>) {
  const id = String(p['id'] ?? '').trim();
  const cargo = await getCargo(ctx, id);
  const c = cargo.o;
  if (c['suiviEngagement'] !== true)
    throw new ErreurMetier("Cette cargaison n'est pas sous suivi d'engagement.");

  const paysDestination = txt(p['paysDestination'], 120);
  const numeroIm4 = txt(p['numeroIm4'], 60);
  const marchandises = lireMarchandises(p['marchandises']);
  const manque = manqueAuDepart({ paysDestination, numeroIm4 }, marchandises);
  if (manque) throw new ErreurMetier(manque);

  const existante = await lireExistante(ctx, id);
  const maintenant = new Date().toISOString();
  let transmissionId = existante?.id ?? '';

  if (existante) {
    const { error } = await ctx.db.from('engagement_transmission')
      .update({ pays_destination: paysDestination, numero_im4: numeroIm4, maj_le: maintenant })
      .eq('id', existante.id);
    if (error) throw new Error(estTableAbsente(error.message) ? TABLES_ABSENTES : error.message);
  } else {
    transmissionId = await nextRef(ctx, 'SEQ_TRANSM', 'TR');
    const { error } = await ctx.db.from('engagement_transmission').insert({
      id: transmissionId, cargaison_id: id,
      pays_destination: paysDestination, numero_im4: numeroIm4,
      transmis_le: maintenant, transmis_par: ctx.session.nomComplet, maj_le: maintenant,
    });
    if (error) throw new Error(estTableAbsente(error.message) ? TABLES_ABSENTES : error.message);
  }

  await remplacerMarchandises(ctx, transmissionId, marchandises);
  await ctx.log(existante ? 'Engagement, transmission corrigée' : 'Engagement, informations transmises', id,
    `${paysDestination} · IM4 ${numeroIm4} · ${marchandises.length} marchandise(s)`);
  return { id, transmissionId, effectueLe: c['engagementEffectueLe'] ?? null };
}

/**
 * Enregistre l'ARRIVÉE : les déclarations C, et APURE l'engagement.
 *
 * La liste est remplacée en bloc (ajouter un C, en corriger un, en retirer un
 * se fait en renvoyant la liste entière). Elle ne peut pas être vide : c'est
 * elle qui prouve l'apurement.
 */
export async function transmissionArrivee(ctx: Ctx, p: Record<string, unknown>) {
  const id = String(p['id'] ?? '').trim();
  const existante = await lireExistante(ctx, id);
  if (!existante)
    throw new ErreurMetier("Le départ n'a pas encore été transmis : renseignez-le d'abord.");

  const cs = lireDeclarationsC(p['declarationsC']);
  const manque = manqueDeclarationsC(cs);
  if (manque) throw new ErreurMetier(manque);

  const cargo = await getCargo(ctx, id);
  const maintenant = new Date().toISOString();
  await remplacerDeclarationsC(ctx, existante.id, cs);
  const { error } = await ctx.db.from('engagement_transmission')
    .update({ arrivee_le: maintenant, arrivee_par: ctx.session.nomComplet, maj_le: maintenant })
    .eq('id', existante.id);
  if (error) throw new Error(estTableAbsente(error.message) ? TABLES_ABSENTES : error.message);

  /* L'APUREMENT, une seule fois. Ajouter un C plus tard ou corriger une faute
     de frappe ne doit pas déplacer la date : elle dit QUAND l'engagement a été
     apuré, pas quand on a relu la fiche. */
  const dejaApure = aFait(cargo.o['engagementEffectueLe']);
  if (!dejaApure) {
    await patchCargo(ctx, cargo, {
      engagement_effectue_le: maintenant,
      engagement_effectue_par: ctx.session.nomComplet,
    });
  }

  const { data: lignes } = await ctx.db.from('engagement_marchandises')
    .select('quantite_depart').eq('transmission_id', existante.id);
  const depart = ((lignes ?? []) as { quantite_depart: number }[])
    .map((l) => ({ designation: '', quantiteDepart: Number(l.quantite_depart ?? 0) }));
  const t = totauxApurement(depart, cs);
  await ctx.log(dejaApure ? 'Engagement, déclarations C corrigées' : 'Engagement apuré', id,
    `${cs.map((c) => `${c.numeroC} du ${c.dateC}`).join(', ')} · départ ${t.depart} · C ${t.arrivee}`
    + ` · écart ${t.ecart === null ? '—' : t.ecart}`);
  return { id, totaux: t, apureLe: dejaApure ? cargo.o['engagementEffectueLe'] : maintenant };
}

async function lireExistante(ctx: Ctx, cargaisonId: string): Promise<{ id: string } | null> {
  const { data, error } = await ctx.db.from('engagement_transmission')
    .select('id').eq('cargaison_id', cargaisonId).maybeSingle();
  if (error) {
    if (estTableAbsente(error.message)) throw new ErreurMetier(TABLES_ABSENTES);
    throw new Error(error.message);
  }
  return (data ?? null) as { id: string } | null;
}

/**
 * Les marchandises sont REMPLACÉES en bloc, jamais modifiées une à une.
 *
 * L'écran envoie la liste telle qu'elle doit être ; comparer ligne à ligne
 * pour deviner ce qui a bougé demanderait des identifiants stables côté écran,
 * et se tromperait au premier déplacement de ligne. Effacer puis réécrire rend
 * la base conforme à ce qu'on voit, sans interprétation.
 */
async function remplacerMarchandises(ctx: Ctx, transmissionId: string, lignes: MarchandiseTransmise[]): Promise<void> {
  const { error: eDel } = await ctx.db.from('engagement_marchandises')
    .delete().eq('transmission_id', transmissionId);
  if (eDel) throw new Error(estTableAbsente(eDel.message) ? TABLES_ABSENTES : eDel.message);
  if (!lignes.length) return;

  const aInserer = lignes.map((m, i) => ({
    id: `${transmissionId}-${i + 1}`,
    transmission_id: transmissionId,
    rang: i + 1,
    designation: m.designation,
    quantite_depart: nombreOuNull(m.quantiteDepart) ?? 0,
    quantite_arrivee: nombreOuNull(m.quantiteArrivee),
  }));
  const { error } = await ctx.db.from('engagement_marchandises').insert(aInserer);
  if (error) throw new Error(estTableAbsente(error.message) ? TABLES_ABSENTES : error.message);
}

/** Les C, remplacés en bloc pour la même raison que les marchandises. */
async function remplacerDeclarationsC(ctx: Ctx, transmissionId: string, cs: DeclarationC[]): Promise<void> {
  const { error: eDel } = await ctx.db.from('engagement_declarations_c')
    .delete().eq('transmission_id', transmissionId);
  if (eDel) throw estTableAbsente(eDel.message) ? new ErreurMetier(TABLE_C_ABSENTE) : new Error(eDel.message);
  const { error } = await ctx.db.from('engagement_declarations_c').insert(cs.map((c, i) => ({
    id: `${transmissionId}-C${i + 1}`,
    transmission_id: transmissionId,
    rang: i + 1,
    numero_c: c.numeroC,
    date_c: c.dateC,
    designation: c.designation,
    quantite: nombreOuNull(c.quantite) ?? 0,
  })));
  if (error) throw estTableAbsente(error.message) ? new ErreurMetier(TABLE_C_ABSENTE) : new Error(error.message);
}
