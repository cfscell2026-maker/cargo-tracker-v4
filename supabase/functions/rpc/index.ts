/**
 * ============================================================================
 *  Edge Function « rpc » — POINT D'ENTRÉE UNIQUE de la logique métier.
 *  Équivalent fidèle de Code.gs rpc(action, token, data) :
 *    1) valide la session (JWT Supabase, niveau aal2 = 2FA vérifié),
 *    2) vérifie la permission du rôle pour l'action (PERMISSIONS),
 *    3) dispatche vers la fonction métier,
 *    4) renvoie {ok:true, data} ou {ok:false, error, auth?}.
 *  Le client ne décide JAMAIS des droits : tout est contrôlé ici.
 * ============================================================================
 */
import { verifierPermission } from '../../../supabase/functions/_shared/domaine/src/index.ts';
import { AuthError, type Ctx } from './ctx.ts';
import { dbAdmin, exigerSession, fabriquerLog } from './supa.ts';
import { ACTIONS } from './actions/registry.ts';

const CORS = {
  'Access-Control-Allow-Origin': '*', // à restreindre au domaine Netlify en production
  'Access-Control-Allow-Headers': 'authorization, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...CORS, 'Content-Type': 'application/json' },
    });

  try {
    const { action, data } = (await req.json().catch(() => ({}))) as {
      action?: string;
      data?: Record<string, unknown>;
    };
    if (!action) return json({ ok: false, error: 'Action requise.' }, 400);

    const db = dbAdmin();
    const session = await exigerSession(db, req.headers.get('Authorization'));
    verifierPermission(session.role, action);

    const handler = ACTIONS[action];
    if (!handler) throw new Error('Action non gérée : ' + action);

    const ctx: Ctx = { db, session, log: fabriquerLog(db, session) };
    const result = await handler(ctx, (data ?? {}) as never);
    return json({ ok: true, data: result });
  } catch (e) {
    const err = e as Error & { isAuth?: boolean };
    // Jamais d'exception brute vers le client (v3.6) — toujours {ok:false,…}.
    return json({ ok: false, error: err.message || String(e), auth: !!(err instanceof AuthError || err.isAuth) });
  }
});
