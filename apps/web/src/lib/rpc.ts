/**
 * Client RPC — équivalent du helper call(action, data) de Client.html (v3.6).
 * Toutes les actions passent par l'Edge Function « rpc » avec le JWT courant ;
 * une erreur `auth` renvoie au login (session expirée / 2FA requis).
 */
import { supabase } from './supabase.ts';

export interface RpcErreur extends Error {
  auth?: boolean;
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
  };

  if (!body.ok) {
    const err = new Error(body.error || 'Erreur inconnue.') as RpcErreur;
    err.auth = !!body.auth;
    if (err.auth) {
      // Session expirée ou 2FA non validé : on force le retour au login.
      window.dispatchEvent(new CustomEvent('cargo:auth-requise'));
    }
    throw err;
  }
  return body.data as T;
}
