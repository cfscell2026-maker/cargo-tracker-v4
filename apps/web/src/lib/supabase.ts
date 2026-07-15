/**
 * Client Supabase du navigateur — clé ANON uniquement (authentification).
 * Toute la donnée métier passe par l'Edge Function rpc (voir rpc.ts).
 */
import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL as string;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

export const supabase = createClient(url, anonKey, {
  auth: { persistSession: true, autoRefreshToken: true },
});
