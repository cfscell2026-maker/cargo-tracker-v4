/**
 * ============================================================================
 *  VERROU DE L'APPLICATION (2026-10-07, demande utilisateur).
 *
 *  Un bouton, dans le volet Parametres, qui bloque l'application pour TOUS les
 *  comptes sauf l'INFO. Protege par un mot de passe que l'INFO definit
 *  lui-meme, et accompagne d'un message que les agents bloques voient.
 *
 *  TROIS REGLES GOUVERNENT CE FICHIER :
 *
 *  1. LE ROLE INFO SEUL. Pas le SUPER_ADMIN, pas l'ADMIN (decision
 *     utilisateur). C'est la seule capacite du projet qui ne suit PAS
 *     `aPouvoirAdmin` : bloquer l'outil de travail de tout le monde n'est pas
 *     un pouvoir d'administration ordinaire.
 *
 *  2. LE MOT DE PASSE NE SORT JAMAIS, ni en clair ni autrement. On garde un
 *     derive PBKDF2 et son sel ; la verification recalcule et compare. Aucune
 *     action ne rend le hash, meme a l'INFO : il n'en a aucun usage, et le
 *     rendre le ferait transiter par le reseau et par un navigateur.
 *
 *  3. L'INFO N'EST JAMAIS ENFERME DEHORS. Il continue de travailler pendant le
 *     blocage (decision utilisateur), et c'est aussi ce qui garantit qu'il
 *     reste quelqu'un pour rouvrir. Le recours ultime, si le mot de passe est
 *     perdu, est en base et documente dans la migration 00205.
 * ============================================================================
 */
import type { Ctx } from '../ctx.ts';
import { ErreurMetier } from '../ctx.ts';
import { ROLES } from '../../_shared/domaine/src/index.ts';

const CLE = 'verrou';
const TOURS = 210_000;

const TABLE_ABSENTE =
  'Le verrou n\'est pas encore activé : la table « verrou_application » '
  + '(migration 00205) n\'existe pas en base.';

function estTableAbsente(message: string): boolean {
  return /verrou_application/.test(message) && /does not exist|relation/i.test(message);
}

/** Le verrou est une capacité À PART : ni l'ADMIN ni le SUPER_ADMIN n'y touchent. */
function exigerInfo(ctx: Ctx) {
  if (ctx.session.role !== ROLES.INFO)
    throw new ErreurMetier('Le verrou de l\'application est réservé au rôle INFO.');
}

const b64 = (b: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(b)));

/**
 * PBKDF2-SHA256. Lent VOLONTAIREMENT : 210 000 tours rendent une recherche
 * exhaustive hors de portée, alors qu'un simple SHA-256 se parcourt au
 * milliard par seconde. Le coût ne se paie qu'au blocage et au déverrouillage,
 * deux gestes rares.
 */
async function deriver(motDePasse: string, sel: string, tours = TOURS): Promise<string> {
  const enc = new TextEncoder();
  const cle = await crypto.subtle.importKey('raw', enc.encode(motDePasse), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(sel), iterations: tours }, cle, 256);
  return b64(bits);
}

/**
 * Comparaison À TEMPS CONSTANT. Un `===` sur des chaînes s'arrête au premier
 * caractère différent ; mesurer ce temps renseigne sur le préfixe correct.
 * Marginal ici, mais c'est le genre de détail qu'on n'ajoute jamais après coup.
 */
function memeDerive(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

interface LigneVerrou {
  actif: boolean; message: string;
  mdp_hash: string; mdp_sel: string; mdp_tours: number;
  mdp_defini_le: string | null;
  bloque_le: string | null; bloque_par: string;
}

async function lire(ctx: Ctx): Promise<LigneVerrou | null> {
  const { data, error } = await ctx.db.from('verrou_application').select('*').eq('cle', CLE).maybeSingle();
  if (error) {
    // La table absente n'est pas une panne : il n'y a simplement pas de verrou.
    if (estTableAbsente(error.message)) return null;
    throw new Error(error.message);
  }
  return (data ?? null) as LigneVerrou | null;
}

/**
 * L'ÉTAT DU VERROU, pour le routeur et pour `account.me`.
 *
 * Ne lève JAMAIS : si la lecture échoue, l'application reste OUVERTE. Un verrou
 * qui se refermerait sur une panne de base bloquerait tout le port sans que
 * personne l'ait demandé, et sans qu'on puisse rouvrir.
 */
export async function etatVerrou(ctx: Ctx): Promise<{ actif: boolean; message: string }> {
  try {
    const l = await lire(ctx);
    return { actif: l?.actif === true, message: String(l?.message ?? '') };
  } catch { return { actif: false, message: '' }; }
}

/** Ce que le panneau de l'INFO affiche. Le hash n'en fait PAS partie. */
export async function verrouEtat(ctx: Ctx) {
  exigerInfo(ctx);
  const l = await lire(ctx);
  return {
    actif: l?.actif === true,
    message: String(l?.message ?? ''),
    defini: !!(l && l.mdp_hash),
    bloqueLe: l?.bloque_le ?? null,
    bloquePar: String(l?.bloque_par ?? ''),
  };
}

function exigerMotDePasse(v: unknown, champ = 'Le mot de passe'): string {
  const m = String(v ?? '');
  if (m.length < 8) throw new ErreurMetier(champ + ' doit faire au moins 8 caractères.');
  if (m.length > 200) throw new ErreurMetier(champ + ' est trop long.');
  return m;
}

async function verifier(ctx: Ctx, motDePasse: unknown): Promise<LigneVerrou> {
  const l = await lire(ctx);
  if (!l || !l.mdp_hash) throw new ErreurMetier('Aucun mot de passe de verrou n\'est défini.');
  const calcule = await deriver(String(motDePasse ?? ''), l.mdp_sel, l.mdp_tours || TOURS);
  if (!memeDerive(calcule, l.mdp_hash)) throw new ErreurMetier('Mot de passe du verrou incorrect.');
  return l;
}

/** Définit le mot de passe, ou le change (l'ancien est alors exigé). */
export async function verrouDefinir(ctx: Ctx, p: Record<string, unknown>) {
  exigerInfo(ctx);
  const existant = await lire(ctx);
  if (existant?.mdp_hash) await verifier(ctx, p['ancien']);
  const nouveau = exigerMotDePasse(p['nouveau'], 'Le nouveau mot de passe');
  if (String(p['confirmation'] ?? '') !== nouveau)
    throw new ErreurMetier('La confirmation ne correspond pas au nouveau mot de passe.');

  const sel = b64(crypto.getRandomValues(new Uint8Array(16)).buffer);
  const hash = await deriver(nouveau, sel);
  const maintenant = new Date().toISOString();
  const { error } = await ctx.db.from('verrou_application').upsert({
    cle: CLE, actif: existant?.actif === true, message: String(existant?.message ?? ''),
    mdp_hash: hash, mdp_sel: sel, mdp_tours: TOURS, mdp_defini_le: maintenant, maj_le: maintenant,
  });
  if (error) throw new Error(estTableAbsente(error.message) ? TABLE_ABSENTE : error.message);
  await ctx.log(existant?.mdp_hash ? 'Verrou : mot de passe changé' : 'Verrou : mot de passe défini', '', '');
  return { defini: true };
}

/** Bloque l'application pour tous les comptes sauf l'INFO. */
export async function verrouBloquer(ctx: Ctx, p: Record<string, unknown>) {
  exigerInfo(ctx);
  await verifier(ctx, p['motDePasse']);
  const message = String(p['message'] ?? '').trim().slice(0, 500);
  if (!message)
    throw new ErreurMetier('Indiquez la raison du blocage : c\'est ce que les agents verront à l\'écran.');
  const maintenant = new Date().toISOString();
  const { error } = await ctx.db.from('verrou_application')
    .update({ actif: true, message, bloque_le: maintenant, bloque_par: ctx.session.nomComplet, maj_le: maintenant })
    .eq('cle', CLE);
  if (error) throw new Error(estTableAbsente(error.message) ? TABLE_ABSENTE : error.message);
  await ctx.log('⚠ APPLICATION BLOQUÉE', '', message);
  return { actif: true, message };
}

/** Rouvre l'application. */
export async function verrouOuvrir(ctx: Ctx, p: Record<string, unknown>) {
  exigerInfo(ctx);
  await verifier(ctx, p['motDePasse']);
  const maintenant = new Date().toISOString();
  const { error } = await ctx.db.from('verrou_application')
    .update({ actif: false, message: '', ouvert_le: maintenant, ouvert_par: ctx.session.nomComplet, maj_le: maintenant })
    .eq('cle', CLE);
  if (error) throw new Error(estTableAbsente(error.message) ? TABLE_ABSENTE : error.message);
  await ctx.log('Application rouverte', '', '');
  return { actif: false };
}
