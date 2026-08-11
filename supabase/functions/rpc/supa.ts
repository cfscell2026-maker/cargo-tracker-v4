/**
 * ============================================================================
 *  Edge Function « rpc » — accès Supabase (runtime). Seul index.ts l'importe.
 *  Équivalents v3.6 : session (_validerSession_), _log_.
 * ============================================================================
 */
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2';
import type { Role } from '../_shared/domaine/src/index.ts';
import { AuthError, type Ctx, type Requete, type Session } from './ctx.ts';

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
 * SEC-02 — DOUBLE AUTHENTIFICATION.
 *
 * Elle avait été désactivée « le temps du démarrage » (`?? 'false'`) alors que
 * l'application porte des données douanières et que tous les comptes migrés
 * partageaient le même mot de passe provisoire. Le défaut est désormais ACTIF :
 * il faut une décision explicite et visible dans la configuration du projet
 * (`MFA_REQUISE=false`) pour l'abaisser.
 *
 * Le client doit être aligné : `VITE_MFA_REQUISE` côté Netlify (voir App.tsx).
 */
const MFA_REQUISE = (Deno.env.get('MFA_REQUISE') ?? 'true').toLowerCase() !== 'false';

/** Valide le JWT, exige aal2 (2FA) si MFA_REQUISE, charge le profil actif. Messages alignés v3.6. */
export async function exigerSession(db: SupabaseClient, authHeader: string | null): Promise<Session> {
  const jwt = (authHeader ?? '').replace(/^Bearer\s+/i, '');
  if (!jwt) throw new AuthError('Session expirée. Veuillez vous reconnecter.');
  // ⚠ ORDRE IMPORTANT : `getUser` valide la SIGNATURE du jeton auprès du serveur
  // d'authentification. Le décodage de `aal` ci-dessous porte donc sur un jeton
  // déjà authentifié — ne jamais inverser ces deux étapes.
  const { data, error } = await db.auth.getUser(jwt);
  if (error || !data?.user) throw new AuthError('Session expirée. Veuillez vous reconnecter.');
  if (MFA_REQUISE && String(jwtPayload(jwt)['aal'] ?? '') !== 'aal2')
    throw new AuthError('Double authentification requise. Veuillez valider votre code.');

  const { data: profil, error: pErr } = await db
    .from('profils')
    .select('id, username, nom_complet, role, actif, doit_changer_mdp')
    .eq('id', data.user.id)
    .single();
  if (pErr || !profil) throw new AuthError('Session expirée. Veuillez vous reconnecter.');
  if (!profil.actif) throw new AuthError("Compte désactivé. Contactez l'administrateur.");
  // Trace de dernière connexion (best-effort).
  db.from('profils').update({ derniere_connexion: new Date().toISOString() }).eq('id', profil.id).then(() => {});
  return {
    userId: profil.id,
    username: profil.username,
    nomComplet: profil.nom_complet,
    role: profil.role as Role,
    doitChangerMdp: profil.doit_changer_mdp === true,
  };
}

/**
 * Journaliseur d'une session (le déclencheur SQL scelle la ligne en HMAC).
 *
 * SEC-04 — L'ancienne version enveloppait l'insertion dans un `try/catch` : or
 * supabase-js NE LÈVE PAS sur erreur, il renvoie `{ error }`. Un échec
 * d'écriture du journal passait donc totalement inaperçu — ni exception, ni
 * message, ni compteur : l'opération métier réussissait, la trace disparaissait.
 * On lit désormais l'erreur, on l'écrit sur la sortie d'erreur (visible dans les
 * logs Supabase) et on la compte.
 *
 * Le comportement reste « best-effort » à dessein : refuser une sortie de camion
 * parce que le journal est momentanément indisponible bloquerait le port sec.
 * Mais l'échec est désormais VISIBLE, ce qui est la condition pour être corrigé.
 */
let echecsJournal = 0;
export function compteurEchecsJournal(): number {
  return echecsJournal;
}

export function fabriquerLog(db: SupabaseClient, s: Session, req?: Requete): Ctx['log'] {
  return async (action, cargaisonId = '', details = '') => {
    // L'adresse IP est jointe au détail : sans elle, impossible de qualifier une
    // activité anormale a posteriori (SEC-05).
    const suffixe = req?.ip ? ` [ip ${req.ip}]` : '';
    try {
      const { error } = await db.from('audit_log').insert({
        user_id: s.userId, username: s.username, nom_complet: s.nomComplet, role: s.role,
        action, cargaison_id: cargaisonId, details: details + suffixe, prev_hash: '', hash: '',
      });
      if (error) {
        echecsJournal++;
        console.error(`[AUDIT-ECHEC #${echecsJournal}] action=${action} cargaison=${cargaisonId} : ${error.message}`);
      }
    } catch (e) {
      echecsJournal++;
      console.error(`[AUDIT-ECHEC #${echecsJournal}] action=${action} : ${e}`);
    }
  };
}

/** Métadonnées de la requête (SEC-05) — en-têtes posés par la passerelle Supabase. */
export function requeteDe(req: Request): Requete {
  const ip =
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    req.headers.get('cf-connecting-ip') ||
    '';
  return { ip, agent: (req.headers.get('user-agent') ?? '').slice(0, 200) };
}
