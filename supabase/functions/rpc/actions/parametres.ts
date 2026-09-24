/**
 * ============================================================================
 *  PARAMÈTRES : lecture et enregistrement (2026-09-21, demande utilisateur)
 *
 *  Stockage : table `parametres_app` (migration 00200), une ligne par réglage
 *  MODIFIÉ. Un réglage jamais touché n'a pas de ligne : il vaut son défaut.
 *
 *  ⚠ LA TABLE PEUT NE PAS EXISTER. Ce module est déployé AVANT que la migration
 *  soit appliquée (c'est une décision de l'exploitant, pas un effet de bord du
 *  déploiement). Tant qu'elle manque, la lecture rend les DÉFAUTS, c'est-à-dire
 *  exactement le comportement d'avant, et l'enregistrement explique pourquoi il
 *  est refusé. Rien ne tombe.
 * ============================================================================
 */
import type { Ctx } from '../ctx.ts';
import { ErreurMetier } from '../ctx.ts';
import {
  PARAMETRES, PARAMETRES_DEFAUT, defParametre, validerParametre, valeursParametres,
  type ValeursParametres,
} from '../../_shared/domaine/src/index.ts';

interface EtatParametres {
  valeurs: ValeursParametres;
  /** false tant que la table `parametres_app` n'existe pas en base. */
  active: boolean;
  /** Dernière modification de chaque réglage modifié. */
  modifs: Record<string, { majLe: string; majPar: string }>;
}

/* Une lecture par requête, pas une par action : plusieurs rapports lisent le
   même réglage dans le même appel. Le cache vit avec le contexte de la requête
   et disparaît avec lui, aucun risque de servir un réglage périmé à la suivante. */
const cache = new WeakMap<object, Promise<EtatParametres>>();

export function chargerEtatParametres(ctx: Ctx): Promise<EtatParametres> {
  let p = cache.get(ctx);
  if (!p) {
    p = (async (): Promise<EtatParametres> => {
      try {
        const { data, error } = await ctx.db.from('parametres_app').select('cle, valeur, maj_le, maj_par');
        if (error) return { valeurs: valeursParametres({}), active: false, modifs: {} };
        const brut: Record<string, unknown> = {};
        const modifs: EtatParametres['modifs'] = {};
        for (const r of (data ?? []) as Record<string, unknown>[]) {
          const cle = String(r['cle']);
          brut[cle] = r['valeur'];
          modifs[cle] = { majLe: String(r['maj_le'] ?? ''), majPar: String(r['maj_par'] ?? '') };
        }
        return { valeurs: valeursParametres(brut), active: true, modifs };
      } catch {
        return { valeurs: valeursParametres({}), active: false, modifs: {} };
      }
    })();
    cache.set(ctx, p);
  }
  return p;
}

/** Les valeurs effectives, ce que les autres actions consultent. */
export async function chargerParametres(ctx: Ctx): Promise<ValeursParametres> {
  return (await chargerEtatParametres(ctx)).valeurs;
}

/** `params.get`, tous les rôles : l'écran de signature en a besoin (liste, délai). */
export async function paramsGet(ctx: Ctx) {
  const e = await chargerEtatParametres(ctx);
  return { valeurs: e.valeurs, defauts: PARAMETRES_DEFAUT, definitions: PARAMETRES, active: e.active, modifs: e.modifs };
}

/**
 * `params.set`, ADMINISTRATEUR. Reçoit `{ valeurs: { cle: valeur | null } }` ;
 * `null` rétablit le défaut (la ligne est supprimée).
 *
 * TOUT est validé AVANT d'écrire quoi que ce soit : un lot contenant une seule
 * valeur fausse est refusé en entier, avec la liste des erreurs.
 */
export async function paramsSet(ctx: Ctx, p: Record<string, unknown>) {
  const entree = (p['valeurs'] ?? {}) as Record<string, unknown>;
  const cles = Object.keys(entree);
  if (!cles.length) throw new ErreurMetier('Aucun paramètre à enregistrer.');

  const aEcrire: { cle: string; valeur: number | string[] | null }[] = [];
  const erreurs: string[] = [];
  for (const cle of cles) {
    if (!defParametre(cle)) { erreurs.push(`Paramètre inconnu : « ${cle} ».`); continue; }
    if (entree[cle] === null) { aEcrire.push({ cle, valeur: null }); continue; }
    const r = validerParametre(cle, entree[cle]);
    // Lecture explicite des deux cas : la configuration serveur n'affine pas
    // l'union sur le booléen `ok`.
    if ('valeur' in r) aEcrire.push({ cle, valeur: r.valeur });
    else erreurs.push(r.erreur);
  }
  if (erreurs.length) throw new ErreurMetier(erreurs.join('\n'));

  const avant = await chargerEtatParametres(ctx);
  if (!avant.active)
    throw new ErreurMetier(
      'Les paramètres ne sont pas encore activés : la table « parametres_app » (migration 00200) '
      + 'n\'existe pas en base. L\'application applique les valeurs par défaut en attendant.',
    );

  const maintenant = new Date().toISOString();
  for (const { cle, valeur } of aEcrire) {
    const ancien = (avant.valeurs as unknown as Record<string, unknown>)[cle];
    if (valeur === null) {
      const { error } = await ctx.db.from('parametres_app').delete().eq('cle', cle);
      if (error) throw new Error(error.message);
    } else {
      // Lecture puis écriture : l'insertion-ou-mise-à-jour en une fois n'est pas
      // disponible partout, et deux administrateurs ne règlent pas la même valeur
      // à la même seconde.
      const { data: existe, error: e1 } = await ctx.db.from('parametres_app').select('cle').eq('cle', cle);
      if (e1) throw new Error(e1.message);
      const ligne = { valeur, maj_le: maintenant, maj_par: ctx.session.nomComplet };
      const { error } = existe && existe.length
        ? await ctx.db.from('parametres_app').update(ligne).eq('cle', cle)
        : await ctx.db.from('parametres_app').insert({ cle, ...ligne });
      if (error) throw new Error(error.message);
    }
    const nouveau = valeur === null ? (PARAMETRES_DEFAUT as unknown as Record<string, unknown>)[cle] : valeur;
    await ctx.log('Paramètre modifié', '', `${defParametre(cle)!.libelle} : ${JSON.stringify(ancien)} → ${JSON.stringify(nouveau)}`
      + (valeur === null ? ' (valeur par défaut rétablie)' : ''));
  }

  cache.delete(ctx); // relire ce qui vient d'être écrit
  return paramsGet(ctx);
}
