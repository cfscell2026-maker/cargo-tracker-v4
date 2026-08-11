/**
 * ============================================================================
 *  Edge Function « rpc » — POINT D'ENTRÉE UNIQUE de la logique métier.
 *  Équivalent fidèle de Code.gs rpc(action, token, data) :
 *    1) contrôle l'origine (CORS liste blanche) et le débit,
 *    2) valide la session (JWT Supabase, niveau aal2 = 2FA vérifié),
 *    3) impose le changement du mot de passe attribué s'il est en attente,
 *    4) vérifie la permission du rôle pour l'action (PERMISSIONS),
 *    5) dispatche vers la fonction métier,
 *    6) renvoie {ok:true, data} ou {ok:false, error, auth?, ref?}.
 *  Le client ne décide JAMAIS des droits : tout est contrôlé ici.
 * ============================================================================
 */
import { verifierPermission } from '../_shared/domaine/src/index.ts';
import { AuthError, estMessageMetier, type Ctx } from './ctx.ts';
import { dbAdmin, exigerSession, fabriquerLog, requeteDe } from './supa.ts';
import { ACTIONS } from './actions/registry.ts';

/* -------------------------------------------------------------------------- */
/* SEC-07 — CORS : liste blanche d'origines                                    */
/*                                                                            */
/* L'en-tête était `Access-Control-Allow-Origin: *`, accompagné du commentaire */
/* « à restreindre en production ». Le jeton étant porté par un en-tête (et    */
/* non un cookie), ce n'était pas une faille CSRF ; mais c'était une barrière  */
/* de confinement gratuite laissée ouverte : n'importe quelle page web pouvait */
/* appeler l'API métier depuis le navigateur d'un agent connecté.              */
/*                                                                            */
/* Les origines viennent de la variable d'environnement ORIGINES_AUTORISEES    */
/* (séparées par des virgules). Vide = aucune origine navigateur autorisée :   */
/* à renseigner au déploiement (voir EXPLOITATION.md).                         */
/* -------------------------------------------------------------------------- */
const ORIGINES = (Deno.env.get('ORIGINES_AUTORISEES') ?? '')
  .split(',')
  .map((o) => o.trim().replace(/\/+$/, ''))
  .filter(Boolean);

function enTetesCors(origine: string | null): Record<string, string> {
  const base: Record<string, string> = {
    'Access-Control-Allow-Headers': 'authorization, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
  const o = (origine ?? '').replace(/\/+$/, '');
  if (o && ORIGINES.includes(o)) base['Access-Control-Allow-Origin'] = o;
  return base;
}

/* -------------------------------------------------------------------------- */
/* SEC-05 — Limitation de débit                                                */
/*                                                                            */
/* Il n'y en avait aucune, et la fonction est déployée avec --no-verify-jwt :  */
/* elle est donc joignable sans clé. Un compteur en mémoire suffit à casser    */
/* l'énumération et le martèlement automatisés.                                */
/*                                                                            */
/* ⚠ LIMITE ASSUMÉE : la mémoire est propre à chaque isolat Deno. Un attaquant */
/* réparti sur plusieurs isolats obtient un plafond effectif plus élevé. C'est */
/* un garde-fou, pas une protection anti-DDoS — celle-ci relève de la          */
/* passerelle Supabase et des protections anti-force-brute de Supabase Auth,   */
/* à activer côté console (voir EXPLOITATION.md).                              */
/* -------------------------------------------------------------------------- */
const FENETRE_MS = 60_000;
const PLAFOND_IP = 1200; // requêtes/minute par IP (un bureau entier derrière un NAT)
const PLAFOND_UTILISATEUR = 300; // requêtes/minute par agent
const PLAFOND_SENSIBLE = 12; // requêtes/minute par agent sur les actions sensibles

/** Actions dont l'abus a une conséquence directe : comptes, imports, suppression. */
const ACTIONS_SENSIBLES = new Set([
  'account.changepwd',
  'user.create', 'user.update', 'user.toggle', 'user.resetpwd', 'user.resetmfa',
  'cargo.delete', 'stock.import', 'stockannonce.import',
]);

const compteurs = new Map<string, { debut: number; n: number }>();

function depasse(cle: string, plafond: number): boolean {
  const now = Date.now();
  const c = compteurs.get(cle);
  if (!c || now - c.debut >= FENETRE_MS) {
    compteurs.set(cle, { debut: now, n: 1 });
    // Purge paresseuse : évite que la table enfle indéfiniment dans un isolat
    // à longue durée de vie.
    if (compteurs.size > 5000) {
      for (const [k, v] of compteurs) if (now - v.debut >= FENETRE_MS) compteurs.delete(k);
    }
    return false;
  }
  c.n++;
  return c.n > plafond;
}

/* -------------------------------------------------------------------------- */
/* SEC-03 — Tant que le mot de passe attribué n'a pas été changé, l'agent ne   */
/* peut rien faire d'autre que le changer.                                     */
/* -------------------------------------------------------------------------- */
const ACTIONS_AVANT_CHANGEMENT = new Set(['account.me', 'account.changepwd']);

Deno.serve(async (req) => {
  const CORS = enTetesCors(req.headers.get('origin'));

  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...CORS, 'Content-Type': 'application/json' },
    });

  const requete = requeteDe(req);
  let action = '';

  try {
    // Débit par IP — avant tout travail, y compris la lecture du corps.
    if (requete.ip && depasse('ip:' + requete.ip, PLAFOND_IP))
      return json({ ok: false, error: 'Trop de requêtes. Réessayez dans une minute.' }, 429);

    const corps = (await req.json().catch(() => ({}))) as {
      action?: string;
      data?: Record<string, unknown>;
    };
    action = String(corps.action ?? '');
    const data = corps.data;
    if (!action) return json({ ok: false, error: 'Action requise.' }, 400);

    const db = dbAdmin();
    const session = await exigerSession(db, req.headers.get('Authorization'));

    // Débit par agent : une session compromise ne peut pas aspirer le fichier.
    if (depasse('u:' + session.userId, PLAFOND_UTILISATEUR))
      return json({ ok: false, error: 'Trop de requêtes. Réessayez dans une minute.' }, 429);
    if (ACTIONS_SENSIBLES.has(action) && depasse('s:' + session.userId, PLAFOND_SENSIBLE))
      return json({ ok: false, error: 'Trop de tentatives sur cette opération. Réessayez dans une minute.' }, 429);

    // SEC-03 — mot de passe attribué non encore changé.
    if (session.doitChangerMdp && !ACTIONS_AVANT_CHANGEMENT.has(action))
      return json({
        ok: false,
        error: "Vous devez d'abord changer le mot de passe qui vous a été attribué.",
        motDePasseAChanger: true,
      }, 403);

    verifierPermission(session.role, action);

    const handler = ACTIONS[action];
    if (!handler) throw new Error('Action non gérée : ' + action);

    const ctx: Ctx = { db, session, requete, log: fabriquerLog(db, session, requete) };
    const result = await handler(ctx, (data ?? {}) as never);
    return json({ ok: true, data: result });
  } catch (e) {
    const err = e as Error & { isAuth?: boolean };
    const auth = !!(err instanceof AuthError || err.isAuth);

    // SEC-08 — Ne jamais renvoyer une erreur technique telle quelle : les
    // messages PostgreSQL/PostgREST livrent les noms de tables, de colonnes et
    // de contraintes. Les messages MÉTIER, eux, sont écrits pour l'agent et
    // sortent inchangés (comportement v3.6 conservé).
    if (auth || estMessageMetier(err)) {
      return json({ ok: false, error: err.message || 'Erreur inconnue.', auth });
    }
    const ref = crypto.randomUUID().slice(0, 8).toUpperCase();
    console.error(`[ERREUR ${ref}] action=${action} ip=${requete.ip} : ${err?.stack ?? err}`);
    return json({
      ok: false,
      auth: false,
      ref,
      error: `Une erreur technique est survenue (référence ${ref}). Signalez cette référence à l'administrateur.`,
    }, 500);
  }
});
