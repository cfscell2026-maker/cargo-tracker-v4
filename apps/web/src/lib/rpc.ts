/**
 * Client RPC — équivalent du helper call(action, data) de Client.html (v3.6).
 * Toutes les actions passent par l'Edge Function « rpc » avec le JWT courant ;
 * une erreur `auth` renvoie au login (session expirée / 2FA requis).
 *
 * 2026-09-11 — REPRISE DES PANNES DE PLATEFORME. Le chemin normal (enveloppe
 * `{ ok, data | error }`) est inchangé. S'y ajoute le traitement des réponses
 * qui ne viennent PAS de notre fonction : voir `reprise.ts` pour le diagnostic
 * complet et la règle de rejeu.
 */
import { supabase } from './supabase.ts';
import { attenteAvantReprise, estSansEffet, estTransitoire, messageTechnique, REPRISES_MAX } from './reprise.ts';
import { CacheLecture, cleCache } from './cache-lecture.ts';

export interface RpcErreur extends Error {
  auth?: boolean;
  /** Référence de corrélation d'une erreur technique, à citer à l'administrateur. */
  ref?: string;
  /** 2026-09-11 — statut HTTP d'une panne de plateforme (0 = échec réseau). */
  statut?: number;
}

/** Enveloppe de réponse de l'Edge Function « rpc ». */
interface Enveloppe<T> {
  ok: boolean;
  data?: T;
  error?: string;
  auth?: boolean;
  /** SEC-03 — le serveur exige le changement du mot de passe attribué. */
  motDePasseAChanger?: boolean;
  /** SEC-08 — référence de corrélation d'une erreur technique. */
  ref?: string;
}

/** Un aller-retour, sans interprétation : le statut et le corps, tels quels. */
async function unAppel(action: string, data: Record<string, unknown>): Promise<{ statut: number; corps: unknown }> {
  const { data: sess } = await supabase.auth.getSession();
  const jwt = sess.session?.access_token;
  // En DÉVELOPPEMENT, on passe par le relais de Vite (voir vite.config.ts) :
  // l'URL devient relative, donc de même origine que la page, et le navigateur
  // n'applique aucun contrôle CORS. C'est Vite qui appelle Supabase côté
  // serveur. Cela évite d'ajouter `localhost` à ORIGINES_AUTORISEES, c'est-à-dire
  // d'ouvrir la liste blanche de PRODUCTION pour une commodité de développement.
  //
  // En production, `import.meta.env.DEV` vaut false : l'appel repart en direct
  // vers Supabase, exactement comme avant. Ce chemin n'existe qu'en local.
  const base = import.meta.env.DEV ? '' : import.meta.env.VITE_SUPABASE_URL;

  let res: Response;
  try {
    res = await fetch(`${base}/functions/v1/rpc`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(jwt ? { Authorization: `Bearer ${jwt}` } : {}),
      },
      body: JSON.stringify({ action, data }),
    });
  } catch {
    // `fetch` ne rejette que si la requête n'a pas abouti du tout — réseau
    // coupé, serveur injoignable. Statut 0, par convention interne.
    return { statut: 0, corps: null };
  }

  return { statut: res.status, corps: await res.json().catch(() => null) };
}

/** Vrai si le corps est bien NOTRE enveloppe (donc : notre fonction a répondu). */
function estEnveloppe<T>(corps: unknown): corps is Enveloppe<T> {
  return !!corps && typeof corps === 'object' && typeof (corps as Enveloppe<T>).ok === 'boolean';
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* ============ CACHE DE LECTURE - 2026-09-12 ============================
 *
 * Deux mecanismes, tous deux limites aux actions SANS EFFET (`estSansEffet`,
 * la meme liste qui autorise deja le rejeu apres une panne) :
 *
 *   1. DEDOUBLONNAGE - deux composants qui demandent la meme chose en meme
 *      temps partagent UN appel au lieu d'en lancer deux.
 *   2. CACHE COURT - revenir sur un ecran quitte il y a dix secondes le
 *      reaffiche instantanement, au lieu de rejouer les 3,7 s.
 *
 * Le pourquoi, la duree et les garde-fous sont documentes dans
 * `cache-lecture.ts`, ou ils sont aussi testes.
 */
const cacheLecture = new CacheLecture();
const enVol = new Map<string, Promise<unknown>>();

/** Vide le cache de lecture. Appele apres toute ecriture, et sur demande. */
export function viderCacheLecture(): void {
  cacheLecture.vider();
}

export async function call<T = unknown>(
  action: string,
  data: Record<string, unknown> = {},
  options: { fraiche?: boolean } = {},
): Promise<T> {
  const sansEffet = estSansEffet(action);

  // ECRITURE : ce qui a ete lu avant ne vaut plus. On vide AVANT l'appel comme
  // apres - avant, parce qu'une lecture concurrente ne doit pas reposer un
  // resultat perime par-dessus ; apres, parce que c'est la que la base a change.
  if (!sansEffet) viderCacheLecture();

  if (sansEffet && !options.fraiche) {
    const k = cleCache(action, data);
    const eu = cacheLecture.lire(k);
    if (eu !== undefined) return eu as T;
    const deja = enVol.get(k);
    if (deja) return deja as Promise<T>;
    const promesse = appelComplet<T>(action, data, sansEffet)
      .then((v) => { cacheLecture.poser(k, v); return v; })
      .finally(() => { enVol.delete(k); });
    enVol.set(k, promesse);
    return promesse;
  }

  const res = await appelComplet<T>(action, data, sansEffet);
  if (!sansEffet) viderCacheLecture();
  return res;
}

/** L'appel lui-meme : enveloppe, diagnostic et rejeu. Inchange. */
async function appelComplet<T>(action: string, data: Record<string, unknown>, sansEffet: boolean): Promise<T> {

  for (let essai = 0; ; essai++) {
    const { statut, corps } = await unAppel(action, data);

    if (estEnveloppe<T>(corps)) {
      // Réponse de notre fonction : comportement d'origine, inchangé. Une
      // erreur MÉTIER n'est jamais rejouée — elle se reproduirait à l'identique.
      if (corps.ok) return corps.data as T;

      const err = new Error(corps.error || 'Erreur inconnue.') as RpcErreur;
      err.auth = !!corps.auth;
      err.ref = corps.ref;
      if (err.auth) {
        // Session expirée ou 2FA non validé : on force le retour au login.
        window.dispatchEvent(new CustomEvent('cargo:auth-requise'));
      } else if (corps.motDePasseAChanger) {
        // La règle vit sur le SERVEUR : une session ouverte avant la
        // réinitialisation se heurte au mur en cours de route. On ramène alors
        // l'agent sur l'écran de changement plutôt que de le laisser devant une
        // suite d'erreurs incompréhensibles.
        window.dispatchEvent(new CustomEvent('cargo:mdp-requis'));
      }
      throw err;
    }

    // Pas notre enveloppe : l'hébergeur a flanché avant nous. On rejoue si et
    // seulement si l'action ne modifie rien (cf. `reprise.ts`).
    if (sansEffet && estTransitoire(statut) && essai < REPRISES_MAX) {
      await pause(attenteAvantReprise(essai + 1));
      continue;
    }

    const err = new Error(messageTechnique(statut, corps as never, sansEffet)) as RpcErreur;
    err.statut = statut;
    throw err;
  }
}
