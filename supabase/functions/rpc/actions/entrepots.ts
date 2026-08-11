/**
 * ============================================================================
 *  ENTREPÔTS — MAD & Entrepôt industriel (v4.1, décision utilisateur 2026-07-27).
 *  Deux entrepôts nommés (nom + code) au fonctionnement identique ; seule
 *  l'UNITÉ D'APUREMENT change : MAD = quantités (colis), INDUSTRIEL = poids (kg).
 *
 *  Entrée = déclaration d'origine + 1..11 articles ({designation, nbColis,
 *  poids}) + conteneurs éventuels. Sortie en vrac = apurement d'UN article d'UNE
 *  entrée, avec une déclaration d'apurement (même ou différente) + véhicules.
 *  Restant théorique par article / déclaration / entrepôt = entrées − sorties.
 * ============================================================================
 */
import type { Ctx } from '../ctx.ts';
import { versCamel } from '../ctx.ts';
import {
  ENTREPOT_TYPES, ARTICLES_MAX, uniteApurement, cleDecl, maj, tcValide, estTypeSansT1,
} from '../../_shared/domaine/src/index.ts';
import { fetchAll, nextRef } from './helpers.ts';

const normTC = (v: unknown) => String(v ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const num = (v: unknown) => { const n = Number(String(v ?? '').replace(',', '.').replace(/[^0-9.]/g, '')); return isFinite(n) && n > 0 ? n : 0; };

/* ------------------------------ Entrepôts ------------------------------ */

export async function entrepotList(ctx: Ctx, opts: { type?: string }) {
  const data = await fetchAll(ctx, 'entrepots', '*');
  let rows = data.map((r) => versCamel(r)).filter((r) => r['actif'] !== false);
  if (opts?.type) rows = rows.filter((r) => String(r['type']) === opts.type);
  rows.sort((a, b) => String(a['nom']).localeCompare(String(b['nom'])));
  return { rows };
}

/** Création d'un entrepôt (ADMIN / chef brigade / chef division — vérifié en amont). */
export async function entrepotCreate(ctx: Ctx, p: Record<string, unknown>) {
  const code = maj(p['code'], 20).replace(/[^A-Z0-9-]/g, '');
  const nom = maj(p['nom'], 80);
  const type = String(p['type']) === ENTREPOT_TYPES.INDUSTRIEL ? ENTREPOT_TYPES.INDUSTRIEL : ENTREPOT_TYPES.MAD;
  if (!code) throw new Error('Code de l\'entrepôt requis.');
  if (!nom) throw new Error('Nom de l\'entrepôt requis.');
  const { data: exist } = await ctx.db.from('entrepots').select('code').eq('code', code).maybeSingle();
  if (exist) throw new Error('Un entrepôt porte déjà le code « ' + code + ' ».');
  const { error } = await ctx.db.from('entrepots').insert({
    code, nom, type, cree_par: ctx.session.nomComplet,
  });
  if (error) throw new Error(error.message);
  await ctx.log('Création entrepôt', code, nom + ' (' + type + ')');
  return { code, nom, type };
}

/* ------------------------------- Entrées ------------------------------- */

function normArticles(raw: unknown): { designation: string; nbColis: number; poids: number }[] {
  const arr = Array.isArray(raw) ? raw : [];
  const out = arr.map((a) => {
    const o = (a ?? {}) as Record<string, unknown>;
    return { designation: maj(o['designation'], 200), nbColis: Math.round(num(o['nbColis'])), poids: num(o['poids']) };
  }).filter((a) => a.designation || a.nbColis || a.poids);
  if (out.length > ARTICLES_MAX) throw new Error('Au plus ' + ARTICLES_MAX + ' articles par déclaration.');
  return out;
}

export async function entrepotEntree(ctx: Ctx, p: Record<string, unknown>) {
  const code = maj(p['entrepotCode'], 20).replace(/[^A-Z0-9-]/g, '');
  const { data: ent } = await ctx.db.from('entrepots').select('*').eq('code', code).maybeSingle();
  if (!ent) throw new Error('Entrepôt « ' + code + ' » introuvable.');
  const d = (p['declaration'] ?? {}) as Record<string, unknown>;
  const numeroDeclaration = maj(d['numeroDeclaration'], 30);
  if (!numeroDeclaration) throw new Error('N° de déclaration requis.');
  const articles = normArticles(p['articles']);
  if (!articles.length) throw new Error('Renseignez au moins un article (désignation + quantité).');
  const conteneurise = p['conteneurise'] === true;
  const conteneurs = conteneurise
    ? (Array.isArray(p['conteneurs']) ? (p['conteneurs'] as unknown[]) : []).map(normTC).filter(Boolean)
    : [];
  for (const tc of conteneurs) if (!tcValide(tc)) throw new Error('Conteneur invalide : ' + tc + ' (4 lettres + 7 chiffres).');

  const id = await nextRef(ctx, 'SEQ_ENT', 'ENT');
  const row = {
    id, entrepot_code: code,
    numero_declaration: numeroDeclaration, annee_declaration: maj(d['anneeDeclaration'], 6),
    bureau_declaration: maj(d['bureauDeclaration'], 20), type_declaration: maj(d['typeDeclaration'], 10),
    declarant: maj(d['declarant'], 120), conteneurise, conteneurs, articles,
    agent: ctx.session.nomComplet, observations: maj(p['observations'], 1000),
  };
  const { error } = await ctx.db.from('entrepot_entrees').insert(row);
  if (error) throw new Error(error.message);
  // Conteneurs : marqués dépotés / liés (best-effort ; hors stock = manuel accepté).
  for (const tc of conteneurs) {
    await ctx.db.from('stock').update({ statut: 'Dépoté', date_depote: new Date().toISOString(), observations: 'Entrée ' + code }).eq('numero_tc', tc);
  }
  await ctx.log('Entrée entrepôt ' + code, id, numeroDeclaration + ' · ' + articles.length + ' article(s)');
  return { id, entrepotCode: code, articles: articles.length };
}

/** Entrées d'un entrepôt, enrichies du RESTANT par article (pour l'apurement). */
export async function entrepotEntrees(ctx: Ctx, opts: { entrepotCode?: string }) {
  const code = maj(opts?.entrepotCode, 20).replace(/[^A-Z0-9-]/g, '');
  const entrees = (await fetchAll(ctx, 'entrepot_entrees', '*')).map((r) => versCamel(r))
    .filter((e) => !code || String(e['entrepotCode']) === code);
  const sorties = (await fetchAll(ctx, 'entrepot_sorties', '*')).map((r) => versCamel(r));
  const type = code ? String((await ctx.db.from('entrepots').select('type').eq('code', code).maybeSingle()).data?.type ?? 'MAD') : 'MAD';
  const unite = uniteApurement(type);
  // Somme apurée par (entrée, article).
  const apure = new Map<string, number>();
  for (const s of sorties) {
    const k = String(s['entreeId']) + '#' + String(s['numeroArticle']);
    const q = unite === 'poids' ? num(s['poids']) : num(s['nbColis']);
    apure.set(k, (apure.get(k) ?? 0) + q);
  }
  const rows = entrees.map((e) => {
    const arts = (Array.isArray(e['articles']) ? e['articles'] : []) as Record<string, unknown>[];
    const articles = arts.map((a, i) => {
      const initial = unite === 'poids' ? num(a['poids']) : num(a['nbColis']);
      const sorti = apure.get(String(e['id']) + '#' + (i + 1)) ?? 0;
      return { numero: i + 1, designation: a['designation'], nbColis: a['nbColis'], poids: a['poids'], initial, sorti, restant: Math.max(0, initial - sorti) };
    });
    return {
      id: e['id'], entrepotCode: e['entrepotCode'], numeroDeclaration: e['numeroDeclaration'],
      anneeDeclaration: e['anneeDeclaration'], bureauDeclaration: e['bureauDeclaration'], typeDeclaration: e['typeDeclaration'],
      declarant: e['declarant'], conteneurise: e['conteneurise'], conteneurs: e['conteneurs'],
      dateEntree: e['dateEntree'], articles,
    };
  });
  return { unite, rows };
}

/* ------------------------------- Sorties ------------------------------- */

export async function entrepotSortie(ctx: Ctx, p: Record<string, unknown>) {
  const entreeId = maj(p['entreeId'], 30);
  const { data: e } = await ctx.db.from('entrepot_entrees').select('*').eq('id', entreeId).maybeSingle();
  if (!e) throw new Error('Entrée « ' + entreeId + ' » introuvable.');
  const entree = versCamel(e);
  const code = String(entree['entrepotCode']);
  const type = String((await ctx.db.from('entrepots').select('type').eq('code', code).maybeSingle()).data?.type ?? 'MAD');
  const unite = uniteApurement(type);
  const numeroArticle = Math.round(num(p['numeroArticle'])) || 1;
  const arts = (Array.isArray(entree['articles']) ? entree['articles'] : []) as Record<string, unknown>[];
  if (numeroArticle < 1 || numeroArticle > arts.length) throw new Error('Article n°' + numeroArticle + ' inexistant sur cette entrée.');

  const nbColis = Math.round(num(p['nbColis']));
  const poids = num(p['poids']);
  const quantite = unite === 'poids' ? poids : nbColis;
  if (quantite <= 0) throw new Error(unite === 'poids' ? 'Poids à apurer (kg) requis.' : 'Nombre de colis à apurer requis.');

  // Contrôle du restant sur cet article (chiffres cohérents : on n'apure jamais
  // plus que ce qui reste).
  const { rows } = await entrepotEntrees(ctx, { entrepotCode: code });
  const art = (rows.find((r) => r['id'] === entreeId)?.['articles'] as Record<string, unknown>[] | undefined)?.[numeroArticle - 1];
  const restant = Number(art?.['restant'] ?? 0);
  if (quantite > restant) throw new Error('Apurement (' + quantite + ') supérieur au restant (' + restant + ') sur l\'article ' + numeroArticle + '.');

  const d = (p['declarationApurement'] ?? {}) as Record<string, unknown>;
  const id = await nextRef(ctx, 'SEQ_SOR', 'SOR');
  // v4.1 — la marchandise (vrac) sort sur un CAMION scellé, pas des véhicules :
  // N° camion + scellés (comme une sortie Magasin/MAD). `vehicules` reste accepté
  // pour compatibilité mais n'est plus saisi côté écran.
  const numeroCamion = maj(p['numeroCamion'], 30).replace(/[^A-Z0-9-]/g, '');
  const scelles = (Array.isArray(p['scelles']) ? (p['scelles'] as unknown[]) : []).map((s) => maj(s, 30)).filter(Boolean);
  const vehicules = Array.isArray(p['vehicules']) ? p['vehicules'] : [];

  /* v4.2 — BALISE / DISPENSE sur la sortie d'entrepôt.
   *
   * Le camion qui emporte la marchandise apurée doit être balisé ou non selon le
   * TYPE de la déclaration d'apurement. Pour un transit (T) la question ne se
   * pose pas : il est balisé. Pour les types C (consommation) et A (admission),
   * l'agent tranche — et le cas courant est SANS balise.
   *
   * On enregistre la DÉCISION, sans créer de cargaison : la sortie d'entrepôt
   * reste un apurement de sommier, pas un mouvement du parcours CFS → PP.
   */
  const typeApu = maj(d['typeDeclaration'], 10) || String(entree['typeDeclaration'] ?? '');
  const baliseRequise = estTypeSansT1(typeApu)
    ? p['baliseRequise'] === true || String(p['baliseRequise']).toLowerCase() === 'oui'
    : null; // type T (ou autre) : sans objet, le transit est balisé par nature

  const row = {
    id, entrepot_code: code, entree_id: entreeId, numero_article: numeroArticle,
    numero_declaration: maj(d['numeroDeclaration'], 30) || String(entree['numeroDeclaration']),
    annee_declaration: maj(d['anneeDeclaration'], 6), bureau_declaration: maj(d['bureauDeclaration'], 20),
    type_declaration: typeApu,
    designation: maj(p['designation'], 200) || String(arts[numeroArticle - 1]?.['designation'] ?? ''),
    nb_colis: nbColis, poids, numero_camion: numeroCamion, scelles, vehicules,
    balise_requise: baliseRequise,
    agent: ctx.session.nomComplet, observations: maj(p['observations'], 1000),
  };
  const { error } = await ctx.db.from('entrepot_sorties').insert(row);
  if (error) throw new Error(error.message);
  const mentionBalise = baliseRequise === null ? '' : baliseRequise ? ' · à baliser' : ' · sans balise';
  await ctx.log('Sortie entrepôt ' + code, id,
    'entrée ' + entreeId + ' art.' + numeroArticle + ' · ' + quantite + ' ' + unite + mentionBalise);
  return { id, restantApres: restant - quantite, baliseRequise };
}

/**
 * Détail des SORTIES (apurements) — pour le tiroir « quantité apurée » : quelles
 * déclarations sont venues apurer un article d'une entrée. Filtrable par
 * entrepôt / entrée / article.
 */
export async function entrepotSortiesDetail(ctx: Ctx, opts: { entrepotCode?: string; entreeId?: string; numeroArticle?: number }) {
  const code = maj(opts?.entrepotCode, 20).replace(/[^A-Z0-9-]/g, '');
  const rows = (await fetchAll(ctx, 'entrepot_sorties', '*')).map((r) => versCamel(r))
    .filter((s) => (!code || String(s['entrepotCode']) === code)
      && (!opts?.entreeId || String(s['entreeId']) === String(opts.entreeId))
      && (!opts?.numeroArticle || Number(s['numeroArticle']) === Number(opts.numeroArticle)));
  rows.sort((a, b) => String(b['dateSortie'] ?? '').localeCompare(String(a['dateSortie'] ?? '')));
  return {
    rows: rows.map((s) => ({
      id: s['id'], entreeId: s['entreeId'], numeroArticle: s['numeroArticle'], dateSortie: s['dateSortie'],
      designation: s['designation'], nbColis: s['nbColis'], poids: s['poids'], agent: s['agent'],
      declaration: [s['numeroDeclaration'], s['anneeDeclaration'], s['bureauDeclaration'], s['typeDeclaration']].filter(Boolean).join(' · '),
      numeroCamion: s['numeroCamion'], scelles: s['scelles'], vehicules: s['vehicules'],
      // v4.2 — décision balise prise à l'apurement (null = sans objet / antérieure).
      baliseRequise: s['baliseRequise'],
    })),
  };
}

/* ----------------------------- Statistiques ---------------------------- */
/**
 * Entrées initiales, sorties et RESTANT THÉORIQUE, par déclaration et par
 * entrepôt. Unité = colis (MAD) ou kg (INDUSTRIEL). Restant = entrées − sorties.
 */
export async function entrepotStats(ctx: Ctx, opts: { type?: string; entrepotCode?: string }) {
  const type = opts?.type === ENTREPOT_TYPES.INDUSTRIEL ? ENTREPOT_TYPES.INDUSTRIEL : ENTREPOT_TYPES.MAD;
  const unite = uniteApurement(type);
  const entrepots = (await fetchAll(ctx, 'entrepots', '*')).map((r) => versCamel(r)).filter((e) => String(e['type']) === type && (!opts?.entrepotCode || e['code'] === opts.entrepotCode));
  const codes = new Set(entrepots.map((e) => String(e['code'])));
  const entrees = (await fetchAll(ctx, 'entrepot_entrees', '*')).map((r) => versCamel(r)).filter((e) => codes.has(String(e['entrepotCode'])));
  const sorties = (await fetchAll(ctx, 'entrepot_sorties', '*')).map((r) => versCamel(r)).filter((s) => codes.has(String(s['entrepotCode'])));

  const qteArticle = (a: Record<string, unknown>) => unite === 'poids' ? num(a['poids']) : num(a['nbColis']);
  const qteSortie = (s: Record<string, unknown>) => unite === 'poids' ? num(s['poids']) : num(s['nbColis']);

  const parEntrepot: Record<string, { code: string; nom: string; entrees: number; sorties: number; restant: number }> = {};
  for (const e of entrepots) parEntrepot[String(e['code'])] = { code: String(e['code']), nom: String(e['nom']), entrees: 0, sorties: 0, restant: 0 };
  const parDecl = new Map<string, { cle: string; entrepotCode: string; libelle: string; entrees: number; sorties: number; restant: number }>();
  const cleDe = (r: Record<string, unknown>) => String(r['entrepotCode']) + '::' + cleDecl(r as never);

  for (const e of entrees) {
    const arts = (Array.isArray(e['articles']) ? e['articles'] : []) as Record<string, unknown>[];
    const tot = arts.reduce((n, a) => n + qteArticle(a), 0);
    parEntrepot[String(e['entrepotCode'])] && (parEntrepot[String(e['entrepotCode'])]!.entrees += tot);
    const k = cleDe(e);
    const g = parDecl.get(k) ?? { cle: cleDecl(e as never), entrepotCode: String(e['entrepotCode']), libelle: [e['numeroDeclaration'], e['anneeDeclaration'], e['bureauDeclaration'], e['typeDeclaration']].filter(Boolean).join(' · '), entrees: 0, sorties: 0, restant: 0 };
    g.entrees += tot; parDecl.set(k, g);
  }
  for (const s of sorties) {
    const q = qteSortie(s);
    parEntrepot[String(s['entrepotCode'])] && (parEntrepot[String(s['entrepotCode'])]!.sorties += q);
    // La sortie est rattachée à la déclaration D'ORIGINE de son entrée (apurement
    // du sommier d'origine, même si la déclaration d'apurement diffère).
    const ent = entrees.find((e) => e['id'] === s['entreeId']);
    if (ent) {
      const k = cleDe(ent);
      const g = parDecl.get(k);
      if (g) { g.sorties += q; }
    }
  }
  const parDeclaration = [...parDecl.values()].map((g) => ({ ...g, restant: Math.max(0, g.entrees - g.sorties) }));
  const listeEntrepots = Object.values(parEntrepot).map((e) => ({ ...e, restant: Math.max(0, e.entrees - e.sorties) }));
  return { type, unite, entrepots: listeEntrepots, parDeclaration };
}
