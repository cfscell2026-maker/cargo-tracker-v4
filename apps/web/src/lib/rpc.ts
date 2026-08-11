/**
 * Client RPC — équivalent du helper call(action, data) de Client.html (v3.6).
 * Toutes les actions passent par l'Edge Function « rpc » avec le JWT courant ;
 * une erreur `auth` renvoie au login (session expirée / 2FA requis).
 */
import { supabase } from './supabase.ts';

export interface RpcErreur extends Error {
  auth?: boolean;
  /** Référence de corrélation d'une erreur technique, à citer à l'administrateur. */
  ref?: string;
}

export async function call<T = unknown>(action: string, data: Record<string, unknown> = {}): Promise<T> {
  const { data: sess } = await supabase.auth.getSession();
  const jwt = sess.session?.access_token;
  const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/rpc`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(jwt ? { Authorization: `Bearer ${jwt}` } : {}),
    },
    body: JSON.stringify({ action, data }),
  });

  const body = (await res.json().catch(() => ({ ok: false, error: 'Réponse invalide du serveur.' }))) as {
    ok: boolean;
    data?: T;
    error?: string;
    auth?: boolean;
    /** SEC-03 — le serveur exige le changement du mot de passe attribué. */
    motDePasseAChanger?: boolean;
    /** SEC-08 — référence de corrélation d'une erreur technique. */
    ref?: string;
  };

  if (!body.ok) {
    const err = new Error(body.error || 'Erreur inconnue.') as RpcErreur;
    err.auth = !!body.auth;
    err.ref = body.ref;
    if (err.auth) {
      // Session expirée ou 2FA non validé : on force le retour au login.
      window.dispatchEvent(new CustomEvent('cargo:auth-requise'));
    } else if (body.motDePasseAChanger) {
      // La règle vit sur le SERVEUR : une session ouverte avant la
      // réinitialisation se heurte au mur en cours de route. On ramène alors
      // l'agent sur l'écran de changement plutôt que de le laisser devant une
      // suite d'erreurs incompréhensibles.
      window.dispatchEvent(new CustomEvent('cargo:mdp-requis'));
    }
    throw err;
  }
  return body.data as T;
}
