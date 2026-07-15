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
}

export interface Ctx {
  db: SupabaseClient;
  session: Session;
  /** Journal d'audit best-effort — ne bloque JAMAIS l'opération métier (_log_). */
  log: (action: string, cargaisonId?: string, details?: string) => Promise<void>;
}

/** Erreur d'authentification (le client redirige vers le login). */
export class AuthError extends Error {
  isAuth = true;
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
