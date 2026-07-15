/**
 * ============================================================================
 *  Administration des UTILISATEURS + compte courant.
 *  Équivalents Audit.gs : _listerUtilisateurs_, _creerUtilisateur_,
 *  _majUtilisateur_, _basculerUtilisateur_, _reinitMotDePasse_, _changerMonMotDePasse_.
 *  L'authentification est déléguée à Supabase Auth (bcrypt + 2FA TOTP).
 *  Identifiants internes → e-mail technique <username>@agents.cargo-pia.local.
 * ============================================================================
 */
import type { Ctx } from '../ctx.ts';
import { createClient } from 'npm:@supabase/supabase-js@2';
import { ROLES, type Role } from '../../_shared/domaine/src/index.ts';

const DOMAINE_TECH = 'agents.cargo-pia.local';
const emailDe = (username: string) => `${username}@${DOMAINE_TECH}`;
const ROLES_VALIDES = Object.values(ROLES) as string[];

export async function userList(ctx: Ctx) {
  const { data, error } = await ctx.db
    .from('profils')
    .select('username, nom_complet, role, actif, date_creation, derniere_connexion')
    .order('username');
  if (error) throw new Error(error.message);
  return (data ?? []).map((r) => ({
    username: r.username, nomComplet: r.nom_complet, role: r.role, actif: r.actif,
    dateCreation: r.date_creation ? new Date(r.date_creation).toISOString().slice(0, 10) : '',
    derniereConnexion: r.derniere_connexion ? new Date(r.derniere_connexion).toISOString().slice(0, 16).replace('T', ' ') : '',
  }));
}

export async function userCreate(ctx: Ctx, p: Record<string, unknown>) {
  const username = String(p['username'] ?? '').toLowerCase().replace(/\s+/g, '');
  if (!/^[a-z0-9._-]{3,30}$/.test(username)) throw new Error('Identifiant invalide (3-30 caractères : lettres, chiffres, . _ -).');
  const { data: exist } = await ctx.db.from('profils').select('username').eq('username', username).maybeSingle();
  if (exist) throw new Error('Cet identifiant existe déjà.');
  if (ROLES_VALIDES.indexOf(String(p['role'])) === -1) throw new Error('Rôle invalide.');
  const pwd = String(p['password'] ?? '');
  if (pwd.length < 6) throw new Error('Mot de passe : 6 caractères minimum.');
  const nom = String(p['nomComplet'] ?? '').trim() || username;

  const { data: u, error: eAuth } = await ctx.db.auth.admin.createUser({
    email: emailDe(username), password: pwd, email_confirm: true,
  });
  if (eAuth || !u?.user) throw new Error(eAuth?.message ?? 'Création du compte impossible.');
  const { error: eProf } = await ctx.db.from('profils').insert({
    id: u.user.id, username, nom_complet: nom, role: p['role'] as Role, actif: true,
  });
  if (eProf) {
    await ctx.db.auth.admin.deleteUser(u.user.id); // rollback si le profil échoue
    throw new Error(eProf.message);
  }
  await ctx.log('Création utilisateur', '', username + ' (' + p['role'] + ')');
  return { ok: true };
}

export async function userUpdate(ctx: Ctx, p: Record<string, unknown>) {
  const username = String(p['username'] ?? '');
  const { data: u, error } = await ctx.db.from('profils').select('id, username').eq('username', username).maybeSingle();
  if (error) throw new Error(error.message);
  if (!u) throw new Error('Utilisateur introuvable.');
  const patch: Record<string, unknown> = {};
  if (p['nomComplet'] !== undefined) patch['nom_complet'] = String(p['nomComplet']).trim();
  if (p['role'] !== undefined) {
    if (ROLES_VALIDES.indexOf(String(p['role'])) === -1) throw new Error('Rôle invalide.');
    patch['role'] = p['role'];
  }
  if (Object.keys(patch).length) await ctx.db.from('profils').update(patch).eq('id', u.id);
  await ctx.log('Modification utilisateur', '', u.username);
  return { ok: true };
}

export async function userToggle(ctx: Ctx, p: Record<string, unknown>) {
  const username = String(p['username'] ?? '');
  const { data: u, error } = await ctx.db.from('profils').select('id, username, actif').eq('username', username).maybeSingle();
  if (error) throw new Error(error.message);
  if (!u) throw new Error('Utilisateur introuvable.');
  if (u.username.toLowerCase() === ctx.session.username.toLowerCase())
    throw new Error('Vous ne pouvez pas désactiver votre propre compte.');
  const nouveau = !u.actif;
  await ctx.db.from('profils').update({ actif: nouveau }).eq('id', u.id);
  // Un compte désactivé est aussi banni côté Auth (empêche toute connexion).
  await ctx.db.auth.admin.updateUserById(u.id, { ban_duration: nouveau ? 'none' : '876000h' });
  await ctx.log(nouveau ? 'Activation compte' : 'Désactivation compte', '', u.username);
  return { ok: true, actif: nouveau };
}

export async function userResetpwd(ctx: Ctx, p: Record<string, unknown>) {
  const username = String(p['username'] ?? '');
  const { data: u, error } = await ctx.db.from('profils').select('id, username').eq('username', username).maybeSingle();
  if (error) throw new Error(error.message);
  if (!u) throw new Error('Utilisateur introuvable.');
  const pwd = String(p['password'] ?? '');
  if (pwd.length < 6) throw new Error('Mot de passe : 6 caractères minimum.');
  await ctx.db.auth.admin.updateUserById(u.id, { password: pwd });
  await ctx.log('Réinitialisation mot de passe', '', u.username);
  return { ok: true };
}

/** v4 — Réinitialisation du 2FA d'un agent (retire ses facteurs TOTP → ré-enrôlement). */
export async function userResetmfa(ctx: Ctx, p: Record<string, unknown>) {
  const username = String(p['username'] ?? '');
  const { data: u, error } = await ctx.db.from('profils').select('id, username').eq('username', username).maybeSingle();
  if (error) throw new Error(error.message);
  if (!u) throw new Error('Utilisateur introuvable.');
  const { data: facteurs } = await ctx.db.auth.admin.mfa.listFactors({ userId: u.id });
  for (const f of facteurs?.factors ?? []) {
    await ctx.db.auth.admin.mfa.deleteFactor({ id: f.id, userId: u.id });
  }
  await ctx.log('Réinitialisation 2FA', '', u.username);
  return { ok: true };
}

export async function accountChangepwd(ctx: Ctx, p: Record<string, unknown>) {
  const ancien = String(p['ancien'] ?? '');
  const nouveau = String(p['nouveau'] ?? '');
  if (nouveau.length < 6) throw new Error('Nouveau mot de passe : 6 caractères minimum.');
  // Vérifie l'ancien mot de passe via une connexion isolée (client anon éphémère).
  const anon = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, { auth: { persistSession: false } });
  const { error: eLog } = await anon.auth.signInWithPassword({ email: emailDe(ctx.session.username), password: ancien });
  if (eLog) throw new Error('Ancien mot de passe incorrect.');
  await ctx.db.auth.admin.updateUserById(ctx.session.userId, { password: nouveau });
  await ctx.log('Changement mot de passe', '', '');
  return { ok: true };
}
