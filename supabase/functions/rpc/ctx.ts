/**
 * ============================================================================
 *  Edge Function « rpc » — types & helpers PURS (aucun import runtime Supabase).
 *  Isolé de supa.ts pour rester importable/testable sous Node (les `import type`
 *  du client Supabase sont effacés à l'exécution).
 * ============================================================================
 */
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';
import type { Role } from '../_shared/domaine/src/index.ts';

/** Session applicative (équivalent de l'objet session Apps Script). */
export interface Session {
  userId: string;
  username: string;
  nomComplet: string;
  role: Role;
  /**
   * SEC-03 — true tant que l'agent n'a pas changé le mot de passe qui lui a été
   * attribué (création de compte ou réinitialisation par un ADMIN). Le routeur
   * ne laisse alors passer que `account.me` et `account.changepwd`.
   * Optionnel dans le type pour que les harnais de test restent compilables ;
   * l'Edge Function le renseigne TOUJOURS (voir supa.ts/exigerSession).
   */
  doitChangerMdp?: boolean;
}

/** Métadonnées de la requête HTTP — tracées dans le journal (SEC-05). */
export interface Requete {
  ip: string;
  agent: string;
}

export interface Ctx {
  db: SupabaseClient;
  session: Session;
  /** Journal d'audit best-effort — ne bloque JAMAIS l'opération métier (_log_). */
  log: (action: string, cargaisonId?: string, details?: string) => Promise<void>;
  /** Renseigné par le routeur ; absent dans les tests unitaires. */
  requete?: Requete;
}

/** Erreur d'authentification (le client redirige vers le login). */
export class AuthError extends Error {
  isAuth = true;
}

/**
 * SEC-08 — Erreur MÉTIER, dont le message est destiné à l'agent et peut sortir
 * tel quel. Tout ce qui n'est PAS une ErreurMetier (ni une AuthError) est une
 * erreur technique : son message reste côté serveur et le client ne reçoit
 * qu'un libellé générique + un identifiant de corrélation.
 *
 * Les actions métier lèvent des `Error` classiques historiquement ; le routeur
 * s'appuie donc sur une LISTE BLANCHE de préfixes plutôt que sur le seul type,
 * le temps que les actions soient migrées. Voir `estMessageMetier`.
 */
export class ErreurMetier extends Error {
  estMetier = true;
}

/**
 * Un message d'erreur PostgreSQL / PostgREST ne doit jamais atteindre le
 * navigateur : il cartographie le schéma (noms de contraintes, de colonnes, de
 * tables). Ces motifs sont ceux que produisent Postgres et PostgREST.
 */
const MOTIFS_TECHNIQUES = [
  /duplicate key value/i,
  /violates .*constraint/i,
  /relation ".*" does not exist/i,
  /column ".*" (of relation|does not exist)/i,
  /invalid input syntax/i,
  /permission denied/i,
  /\bJWT\b|\bJWS\b|\bJWK\b/i,
  /\bSQLSTATE\b/i,
  /supabase|postgrest|fetch failed|ECONNREFUSED/i,
];
// ⚠ Ne PAS ajouter ici de motif purement numérique pour attraper les SQLSTATE
// (23505, 22P02, 42703…). Les numéros de déclaration en douane font eux aussi
// cinq chiffres et commencent souvent par 22, 23 ou 42 : un message parfaitement
// légitime comme « Déclaration 23456 introuvable » serait pris pour une erreur
// technique et remplacé par un libellé générique — l'agent perdrait
// l'information dont il a besoin. Les motifs textuels ci-dessus suffisent.

/** true si le message peut être montré à l'agent sans rien divulguer. */
export function estMessageMetier(e: unknown): boolean {
  if (e instanceof ErreurMetier || e instanceof AuthError) return true;
  const msg = (e as Error)?.message ?? '';
  if (!msg) return false;
  return !MOTIFS_TECHNIQUES.some((r) => r.test(msg));
}

/** snake_case → camelCase (une ligne SQL → objet API, clés identiques à la v3.6). */
export function versCamel<T = Record<string, unknown>>(row: Record<string, unknown>): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    const ck = k.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
    out[ck] = v instanceof Date ? v.toISOString() : v;
  }
  return out as T;
}
