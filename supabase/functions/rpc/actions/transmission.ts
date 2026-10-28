/**
 * ============================================================================
 *  TRANSMISSION D'UN ENGAGEMENT (2026-10-28, demande utilisateur).
 *
 *  Le bouton « Effectué » soldait l'engagement en un clic : on savait QUE les
 *  informations avaient été transmises, jamais LESQUELLES. Il est remplacé par
 *  cette fiche, qui porte ce qu'on a réellement déclaré.
 *
 *  DEUX VOLETS, ET DEUX MOMENTS (décision utilisateur) :
 *    · le DÉPART se saisit quand on transmet. C'est lui, et lui seul, qui
 *      solde l'engagement ;
 *    · l'ARRIVÉE se saisit plus tard, quand le pays de destination répond,
 *      parfois des semaines après. La fiche se rouvre autant de fois qu'il
 *      faut, et l'écart n'apparaît qu'une fois l'arrivée connue.
 *
 *  Le calcul des écarts vit dans le domaine (`transmission.ts`), pas ici : il
 *  doit pouvoir se tester sans base, et donner le même résultat à l'écran et
 *  au serveur.
 * ============================================================================
 */
import type { Ctx } from '../ctx.ts';
import { ErreurMetier } from '../ctx.ts';
import { getCargo, patchCargo, nextRef } from './helpers.ts';
import {
  manqueAuDepart, manqueALArrivee, nombreOuNull, totauxTransmission,
  aFait, txt, type MarchandiseTransmise,
} from '../../_shared/domaine/src/index.ts';

const TABLES_ABSENTES =
  'La transmission des engagements n\'est pas encore activée : les tables '
  + '« engagement_transmission » et « engagement_marchandises » (migration 00213) '
  + 'n\'existent pas en base.';

/* ⚠ Trois formulations, cf. `rapprochement.ts` : PostgREST annonce aussi une
   table absente par « schema cache » quand elle existe mais qu'il ne l'a pas
   relue. Se rafraîchit avec `NOTIFY pgrst, 'reload schema';`. */
function estTableAbsente(message: string): boolean {
  return /engagement_(transmission|marchandises)/.test(message)
    && /does not exist|relation|schema cache/i.test(message);
}

interface LigneBase { id: string; rang: number; designation: string; quantite_depart: number; quantite_arrivee: number | null }

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

/** La fiche d'une cargaison, ou `null` si rien n'a encore été transmis. */
export async function transmissionLire(ctx: Ctx, p: Record<string, unknown>) {
  const id = String(p['id'] ?? '').trim();
  if (!id) throw new ErreurMetier('Cargaison non précisée.');

  const { data, error } = await ctx.db.from('engagement_transmission')
    .select('*').eq('cargaison_id', id).maybeSingle();
  if (error) {
    // Table absente : il n'y a simplement rien de transmis, l'écran s'ouvre vide.
    if (estTableAbsente(error.message)) return { transmission: null, marchandises: [], active: false };
    throw new Error(error.message);
  }
  if (!data) return { transmission: null, marchandises: [], active: true };

  const { data: lignes, error: e2 } = await ctx.db.from('engagement_marchandises')
    .select('*').eq('transmission_id', (data as Record<string, unknown>)['id']).order('rang', { ascending: true });
  if (e2) throw new Error(e2.message);

  const marchandises = ((lignes ?? []) as unknown as LigneBase[]).map((l) => ({
    designation: String(l.designation ?? ''),
    quantiteDepart: Number(l.quantite_depart ?? 0),
    quantiteArrivee: l.quantite_arrivee === null || l.quantite_arrivee === undefined
      ? null : Number(l.quantite_arrivee),
  }));
  return { transmission: data, marchandises, totaux: totauxTransmission(marchandises), active: true };
}

/**
 * Enregistre le DÉPART, et solde l'engagement.
 *
 * C'est ce geste qui remplace l'ancien « Effectué ». Il reste REJOUABLE tant
 * que l'arrivée n'est pas saisie : une erreur de frappe sur un numéro IM4 se
 * corrige, sans quoi il faudrait retirer l'engagement pour le recréer.
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

  await remplacerMarchandises(ctx, transmissionId, marchandises, existante ? null : 'depart');

  /* LE DÉPART SOLDE L'ENGAGEMENT, une seule fois. Rejouer la saisie pour
     corriger une faute de frappe ne doit pas réécrire la date du solde : elle
     dit QUAND les informations sont parties, pas quand on les a relues. */
  if (!aFait(c['engagementEffectueLe'])) {
    await patchCargo(ctx, cargo, {
      engagement_effectue_le: maintenant,
      engagement_effectue_par: ctx.session.nomComplet,
    });
  }
  await ctx.log(existante ? 'Engagement, transmission corrigée' : 'Engagement, informations transmises', id,
    `${paysDestination} · IM4 ${numeroIm4} · ${marchandises.length} marchandise(s)`);
  return { id, transmissionId, effectueLe: c['engagementEffectueLe'] ?? maintenant };
}

/** Enregistre l'ARRIVÉE : les quantités constatées, et rien d'autre. */
export async function transmissionArrivee(ctx: Ctx, p: Record<string, unknown>) {
  const id = String(p['id'] ?? '').trim();
  const existante = await lireExistante(ctx, id);
  if (!existante)
    throw new ErreurMetier("Le départ n'a pas encore été transmis : renseignez-le d'abord.");

  const marchandises = lireMarchandises(p['marchandises']);
  const manque = manqueALArrivee(marchandises);
  if (manque) throw new ErreurMetier(manque);

  const maintenant = new Date().toISOString();
  await remplacerMarchandises(ctx, existante.id, marchandises, null);
  const { error } = await ctx.db.from('engagement_transmission')
    .update({ arrivee_le: maintenant, arrivee_par: ctx.session.nomComplet, maj_le: maintenant })
    .eq('id', existante.id);
  if (error) throw new Error(estTableAbsente(error.message) ? TABLES_ABSENTES : error.message);

  const t = totauxTransmission(marchandises);
  await ctx.log('Engagement, arrivée constatée', id,
    `départ ${t.depart} · arrivée ${t.arrivee} · écart ${t.ecart === null ? '—' : t.ecart}`
    + (t.enAttente ? ` · ${t.enAttente} ligne(s) encore en attente` : ''));
  return { id, totaux: t };
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
async function remplacerMarchandises(
  ctx: Ctx, transmissionId: string, lignes: MarchandiseTransmise[], _volet: string | null,
): Promise<void> {
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
