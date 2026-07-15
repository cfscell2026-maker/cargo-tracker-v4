/**
 * ============================================================================
 *  Edge Function « rpc » — accès Supabase (runtime). Seul index.ts l'importe.
 *  Équivalents v3.6 : session (_validerSession_), _log_.
 * ============================================================================
 */
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2';
import type { Role } from '../_shared/domaine/src/index.ts';
import { AuthError, type Ctx, type Session } from './ctx.ts';

/** Client service_role — n'existe QUE côté serveur. */
export function dbAdmin(): SupabaseClient {
  const url = Deno.env.get('SUPABASE_URL')!;
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  return createClient(url, key, { auth: { persistSession: false } });
}

/** Décode le payload d'un JWT (sans vérification — getUser fait la vérification). */
export function jwtPayload(jwt: string): Record<string, unknown> {
  try {
    const part = jwt.split('.')[1] ?? '';
    return JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/')));
  } catch {
    return {};
  }
}

/**
 * INTERRUPTEUR 2FA — phase de démarrage « molo molo », double authentification
 * DÉSACTIVÉE temporairement (connexion par mot de passe seul).
 * ⚠ À REMETTRE À `true` avant la mise en production réelle (données douanières).
 * Surcharge possible sans redéploiement via la variable d'env MFA_REQUISE=true.
 */
const MFA_REQUISE = (Deno.env.get('MFA_REQUISE') ?? 'false').toLowerCase() === 'true';

/** Valide le JWT, exige aal2 (2FA) si MFA_REQUISE, charge le profil actif. Messages alignés v3.6. */
export async function exigerSession(db: SupabaseClient, authHeader: string | null): Promise<Session> {
  const jwt = (authHeader ?? '').replace(/^Bearer\s+/i, '');
  if (!jwt) throw new AuthError('Session expirée. Veuillez vous reconnecter.');
  const { data, error } = await db.auth.getUser(jwt);
  if (error || !data?.user) throw new AuthError('Session expirée. Veuillez vous reconnecter.');
  if (MFA_REQUISE && String(jwtPayload(jwt)['aal'] ?? '') !== 'aal2')
    throw new AuthError('Double authentification requise. Veuillez valider votre code.');

  const { data: profil, error: pErr } = await db
    .from('profils')
    .select('id, username, nom_complet, role, actif')
    .eq('id', data.user.id)
    .single();
  if (pErr || !profil) throw new AuthError('Session expirée. Veuillez vous reconnecter.');
  if (!profil.actif) throw new AuthError("Compte désactivé. Contactez l'administrateur.");
  // Trace de dernière connexion (best-effort).
  db.from('profils').update({ derniere_connexion: new Date().toISOString() }).eq('id', profil.id).then(() => {});
  return { userId: profil.id, username: profil.username, nomComplet: profil.nom_complet, role: profil.role as Role };
}

/** Journaliseur best-effort d'une session (le trigger SQL calcule la chaîne de hachage). */
export function fabriquerLog(db: SupabaseClient, s: Session): Ctx['log'] {
  return async (action, cargaisonId = '', details = '') => {
    try {
      await db.from('audit_log').insert({
        user_id: s.userId, username: s.username, nom_complet: s.nomComplet, role: s.role,
        action, cargaison_id: cargaisonId, details, prev_hash: '', hash: '',
      });
    } catch (e) {
      console.error('Echec journalisation: ' + e); // ne bloque jamais l'opération métier
    }
  };
}
