/**
 * ============================================================================
 *  ENTREPÔTS : MAD & Entrepôt industriel (v4.1, décision utilisateur 2026-07-27).
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
import { ErreurMetier } from '../ctx.ts';
import {
  ENTREPOT_TYPES, ARTICLES_MAX, uniteApurement, cleDecl, maj, tcValide, estTypeSansT1,
  STATUTS, OPERATIONS, sautsTypeC,
} from '../../_shared/domaine/src/index.ts';
import { fetchAll, nextRef, nextId, nextRapportId } from './helpers.ts';

const normTC = (v: unknown) => String(v ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const num = (v: unknown) => { const n = Number(String(v ?? '').replace(',', '.').replace(/[^0-9.]/g, '')); return isFinite(n) && n > 0 ? n : 0; };

/* ------------------------------ Entrepôts ------------------------------ */

export async function entrepotList(ctx: Ctx, opts: { type?: string; tous?: unknown }) {
  const data = await fetchAll(ctx, 'entrepots', '*');
  // `tous` (2026-09-11) : inclut les entrepôts DÉSACTIVÉS. Sans cela, désactiver
  // un magasin revenait à le perdre de vue, donc à ne plus pouvoir le
  // réactiver. Les écrans de saisie n'envoient pas ce drapeau : pour eux, rien
  // ne change, un magasin désactivé reste hors de portée.
  let rows = data.map((r) => versCamel(r));
  if (opts?.tous !== true) rows = rows.filter((r) => r['actif'] !== false);
  if (opts?.type) rows = rows.filter((r) => String(r['type']) === opts.type);
  rows.sort((a, b) => String(a['nom']).localeCompare(String(b['nom'])));
  return { rows };
}

/** Nombre d'entrées rattachées à un entrepôt, ce qui décide de sa suppressibilité. */
async function compterEntrees(ctx: Ctx, code: string): Promise<number> {
  const { data } = await ctx.db.from('entrepot_entrees').select('id').eq('entrepot_code', code);
  return (data ?? []).length;
}

/**
 * MODIFICATION d'un entrepôt, ADMIN / chef brigade / chef division
 * (2026-09-11, demande utilisateur). Renommer, changer le type, activer ou
 * désactiver.
 *
 * ⚠ LE CODE NE SE MODIFIE PAS. C'est la clé primaire, référencée par chaque
 * entrée et chaque sortie (`entrepot_code`) : la changer romprait le lien avec
 * tout l'historique du magasin.
 *
 * ⚠ LE TYPE NE SE CHANGE PLUS DÈS QU'IL Y A UNE ENTRÉE. MAD et INDUSTRIEL ne
 * comptent pas la même chose, colis d'un côté, kilos de l'autre (voir
 * `uniteApurement`). Basculer le type d'un magasin déjà garni ne convertirait
 * rien : il relirait simplement les quantités existantes dans la mauvaise
 * unité. Une erreur de frappe sur le nom se corrige ; un stock réinterprété, non.
 */
export async function entrepotEdit(ctx: Ctx, p: Record<string, unknown>) {
  const code = maj(p['code'], 20).replace(/[^A-Z0-9-]/g, '');
  if (!code) throw new Error('Code de l\'entrepôt requis.');
  const { data: ent } = await ctx.db.from('entrepots').select('*').eq('code', code).maybeSingle();
  if (!ent) throw new Error('Entrepôt « ' + code + ' » introuvable.');

  const patch: Record<string, unknown> = {};
  const trace: string[] = [];

  if (p['nom'] !== undefined) {
    const nom = maj(p['nom'], 80);
    if (!nom) throw new Error('Nom de l\'entrepôt requis.');
    if (nom !== String(ent['nom'])) { patch['nom'] = nom; trace.push('nom « ' + ent['nom'] + ' » → « ' + nom + ' »'); }
  }

  if (p['type'] !== undefined) {
    const type = String(p['type']) === ENTREPOT_TYPES.INDUSTRIEL ? ENTREPOT_TYPES.INDUSTRIEL : ENTREPOT_TYPES.MAD;
    if (type !== String(ent['type'])) {
      const n = await compterEntrees(ctx, code);
      if (n > 0) {
        throw new Error(
          'Type non modifiable : ce magasin contient déjà ' + n + ' entrée(s). '
          + 'MAD compte en colis, Industriel en kilos, changer le type relirait '
          + 'ces quantités dans la mauvaise unité. Créez un nouveau magasin du bon '
          + 'type et désactivez celui-ci.');
      }
      patch['type'] = type;
      trace.push('type ' + ent['type'] + ' → ' + type);
    }
  }

  if (p['actif'] !== undefined) {
    const actif = p['actif'] === true;
    if (actif !== (ent['actif'] !== false)) {
      patch['actif'] = actif;
      trace.push(actif ? 'réactivé' : 'désactivé');
    }
  }

  if (!trace.length) throw new Error('Aucune modification : les valeurs sont identiques.');
  const { error } = await ctx.db.from('entrepots').update(patch).eq('code', code);
  if (error) throw new Error(error.message);
  await ctx.log('Modification entrepôt', code, trace.join(' · '));
  return { code, ...patch };
}

/**
 * SUPPRESSION d'un entrepôt, ADMIN seul (2026-09-11, demande utilisateur).
 *
 * Refusée dès qu'une entrée s'y rattache, et le message dit alors quoi faire :
 * désactiver. Ce n'est pas une précaution de confort, `entrepot_entrees` et
 * `entrepot_sorties` référencent `entrepots(code)` par clé étrangère : la base
 * refuserait de toute façon, mais avec un message PostgreSQL illisible pour un
 * agent. Autant le dire nous-mêmes, et proposer la sortie.
 */
export async function entrepotSupprimer(ctx: Ctx, p: Record<string, unknown>) {
  const code = maj(p['code'], 20).replace(/[^A-Z0-9-]/g, '');
  const motif = maj(p['motif'], 200);
  if (!code) throw new Error('Code de l\'entrepôt requis.');
  if (!motif) throw new Error('Motif obligatoire pour supprimer un magasin.');
  const { data: ent } = await ctx.db.from('entrepots').select('*').eq('code', code).maybeSingle();
  if (!ent) throw new Error('Entrepôt « ' + code + ' » introuvable.');

  const n = await compterEntrees(ctx, code);
  if (n > 0) {
    throw new Error(
      'Suppression impossible : ce magasin contient ' + n + ' entrée(s), qui doivent '
      + 'rester consultables. Désactivez-le plutôt, il disparaîtra des écrans de '
      + 'saisie tout en gardant son historique.');
  }

  const { error } = await ctx.db.from('entrepots').delete().eq('code', code);
  if (error) throw new Error(error.message);
  await ctx.log('Suppression entrepôt', code, String(ent['nom']) + ' (' + ent['type'] + ') · ' + motif);
  return { code };
}

/** Création d'un entrepôt (ADMIN / chef brigade / chef division, vérifié en amont). */
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
  // v4.1, la marchandise (vrac) sort sur un CAMION scellé, pas des véhicules :
  // N° camion + scellés (comme une sortie Magasin/MAD). `vehicules` reste accepté
  // pour compatibilité mais n'est plus saisi côté écran.
  const numeroCamion = maj(p['numeroCamion'], 30).replace(/[^A-Z0-9/-]/g, ''); // 2026-09-10 : la barre oblique du format tracteur/remorque ne doit plus être retirée
  const scelles = (Array.isArray(p['scelles']) ? (p['scelles'] as unknown[]) : []).map((s) => maj(s, 30)).filter(Boolean);
  const vehicules = Array.isArray(p['vehicules']) ? p['vehicules'] : [];

  /* v4.2, BALISE / DISPENSE sur la sortie d'entrepôt.
   *
   * Le camion qui emporte la marchandise apurée doit être balisé ou non selon le
   * TYPE de la déclaration d'apurement. Pour un transit (T) la question ne se
   * pose pas : il est balisé. Pour les types C (consommation) et A (admission),
   * l'agent tranche, et le cas courant est SANS balise.
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

  /* v4.3, CRÉATION DU CAMION DANS LE PARCOURS (demande utilisateur 2026-08-19).
   *
   * La sortie MAD ne fait plus que solder le sommier : elle CRÉE aussi le camion
   * qui emporte la marchandise, SANS passer par le CFS, comme une « Sortie
   * Magasin / MAD ». Ce camion suit alors le circuit SELON LE RÉGIME de la
   * déclaration de sortie (règle unique sautsTypeC) :
   *   · transit (T) → validation chef brigade + T1 + Balise + Sortie ;
   *   · conso (C/A/S) → validation chef brigade, puis saute T1 et (au choix) la
   *     balise (baliseRequise coché ou non).
   * La VALIDATION du chef de brigade est TOUJOURS requise (statut « Créée »).
   *
   * CONCORDANCE : type « Sortie Magasin / MAD », ces cargaisons sont, par
   * construction, exclues des rapports CFS / Balise / PP (qui ne comptent que
   * Enlèvement/Dépotage), donc ce camion ne gonfle PAS les entrées CFS. Il
   * apparaît normalement dans les FILES d'attente (validation puis suite du
   * circuit). Le lien apurement → cargaison est conservé (best-effort).
   */
  let cargaisonId: string | null = null;
  if (numeroCamion) {
    const consoMode = baliseRequise === false ? 'sansbalise' : 'balise';
    const { sauteT1, sauteBalise } = sautsTypeC(typeApu, consoMode);
    cargaisonId = await nextId(ctx);
    const rapportId = await nextRapportId(ctx);
    const nowC = new Date().toISOString();
    const declarant = maj(d['declarant'], 120) || String(entree['declarant'] ?? '');
    const designation = maj(p['designation'], 200) || String(arts[numeroArticle - 1]?.['designation'] ?? '');
    const { error: eCargo } = await ctx.db.from('cargaisons').insert({
      id: cargaisonId, reference: cargaisonId, date_creation: nowC, numero_camion: numeroCamion,
      type_operation: OPERATIONS.MAGASIN, twins: false,
      declarant, contact_declarant: '', destination_marchandise: '',
      bureau_declaration: row.bureau_declaration, type_declaration: typeApu,
      numero_declaration: row.numero_declaration, annee_declaration: row.annee_declaration,
      description_marchandise: designation,
      observations_cfs: 'Sortie MAD ' + code + ' · entrée ' + entreeId + ' art.' + numeroArticle,
      agent_cfs: ctx.session.nomComplet, agent_cfs_id: ctx.session.userId,
      statut: STATUTS.CREEE, derniere_maj: nowC, rapport_id: rapportId,
      conteneurs_details: { conteneurs: [], scellesCamion: scelles }, nb_conteneurs: 0,
      saute_t1: sauteT1, saute_balise: sauteBalise, saute_bs: false,
    });
    if (eCargo) throw new Error(eCargo.message);
    // Lien de concordance sortie → cargaison (best-effort : sans la colonne
    // (migration 00160 non appliquée), la sortie reste valide, juste non liée).
    const { error: eLink } = await ctx.db.from('entrepot_sorties').update({ cargaison_id: cargaisonId }).eq('id', id);
    if (eLink) console.error('[MAD-SORTIE] lien cargaison non enregistré (' + id + ') : ' + eLink.message);
  }

  const mentionBalise = baliseRequise === null ? '' : baliseRequise ? ' · à baliser' : ' · sans balise';
  await ctx.log('Sortie entrepôt ' + code, id,
    'entrée ' + entreeId + ' art.' + numeroArticle + ' · ' + quantite + ' ' + unite + mentionBalise
      + (cargaisonId ? ' · camion ' + numeroCamion + ' (' + cargaisonId + ')' : ''));
  return { id, restantApres: restant - quantite, baliseRequise, cargaisonId };
}

/**
 * Détail des SORTIES (apurements), pour le tiroir « quantité apurée » : quelles
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
      // v4.2, décision balise prise à l'apurement (null = sans objet / antérieure).
      baliseRequise: s['baliseRequise'],
      // v4.3, cargaison (camion) créée pour cette sortie, s'il y en a une.
      cargaisonId: s['cargaisonId'],
    })),
  };
}

/* ------------------- Correction et suppression (2026-09-24) -------------
 *
 * Demande utilisateur : pouvoir reprendre un depot ou un apurement mal saisi.
 * La CORRECTION est ouverte a tous ceux qui voient l'ecran ; la SUPPRESSION est
 * reservee a l'administration, et reclame un motif comme partout ailleurs.
 * ---------------------------------------------------------------------- */

/** Les apurements deja poses sur une entree, article par article. */
async function apuresParArticle(ctx: Ctx, entreeId: string): Promise<Map<number, number>> {
  const { data } = await ctx.db.from('entrepot_sorties').select('*').eq('entree_id', entreeId);
  const parArticle = new Map<number, number>();
  for (const r of (data ?? []) as Record<string, unknown>[]) {
    const n = Number(r['numero_article'] ?? 0);
    const q = num(r['nb_colis']) || num(r['poids']);
    parArticle.set(n, (parArticle.get(n) ?? 0) + q);
  }
  return parArticle;
}

/**
 * `entrepot.entreeedit` : corriger un DEPOT (declaration, declarant,
 * conteneurs, designations et quantites). Les quantites ne peuvent pas passer
 * sous ce qui est deja sorti, et on ne retire pas un article qui a servi.
 */
export async function entrepotEntreeEdit(ctx: Ctx, p: Record<string, unknown>) {
  const id = maj(p['id'], 30);
  if (!id) throw new ErreurMetier('Identifiant de l\'entree requis.');
  const { data: e } = await ctx.db.from('entrepot_entrees').select('*').eq('id', id).maybeSingle();
  if (!e) throw new ErreurMetier('Entree « ' + id + ' » introuvable.');
  const avant = versCamel(e);

  const patch: Record<string, unknown> = {};
  const traces: string[] = [];
  const d = (p['declaration'] ?? {}) as Record<string, unknown>;

  const champs: [string, string, string, number][] = [
    ['numeroDeclaration', 'numero_declaration', 'n° declaration', 30],
    ['anneeDeclaration', 'annee_declaration', 'annee', 6],
    ['bureauDeclaration', 'bureau_declaration', 'bureau', 20],
    ['typeDeclaration', 'type_declaration', 'type', 10],
  ];
  for (const [cle, colonne, libelle, taille] of champs) {
    if (d[cle] === undefined) continue;
    const v = maj(d[cle], taille);
    if (v !== String(avant[cle] ?? '')) { patch[colonne] = v; traces.push(libelle + ' ' + (avant[cle] || '(vide)') + ' -> ' + (v || '(vide)')); }
  }
  if (p['declarant'] !== undefined) {
    const v = maj(p['declarant'], 120);
    if (v !== String(avant['declarant'] ?? '')) { patch['declarant'] = v; traces.push('declarant'); }
  }
  if (p['observations'] !== undefined) {
    const v = maj(p['observations'], 1000);
    if (v !== String(avant['observations'] ?? '')) { patch['observations'] = v; traces.push('observations'); }
  }

  // CONTENEURS : liste nettoyee, sans doublon, et chaque numero controle.
  if (p['conteneurs'] !== undefined) {
    const bruts = (Array.isArray(p['conteneurs']) ? (p['conteneurs'] as unknown[]) : []).map(normTC).filter(Boolean);
    const conteneurs = [...new Set(bruts)];
    for (const tc of conteneurs) if (!tcValide(tc)) throw new ErreurMetier('Conteneur invalide : ' + tc + ' (4 lettres + 7 chiffres).');
    const ancien = (Array.isArray(avant['conteneurs']) ? avant['conteneurs'] : []) as string[];
    if (conteneurs.join(',') !== ancien.join(',')) {
      patch['conteneurs'] = conteneurs;
      patch['conteneurise'] = conteneurs.length > 0;
      traces.push('conteneurs ' + ancien.length + ' -> ' + conteneurs.length);
    }
  }

  // ARTICLES : designation et quantite. Jamais sous ce qui est deja sorti.
  if (p['articles'] !== undefined) {
    const articles = normArticles(p['articles']);
    if (!articles.length) throw new ErreurMetier('Renseignez au moins un article (designation + quantite).');
    const anciens = (Array.isArray(avant['articles']) ? avant['articles'] : []) as Record<string, unknown>[];
    const apures = await apuresParArticle(ctx, id);
    if (articles.length < anciens.length) {
      for (let i = articles.length; i < anciens.length; i++) {
        if ((apures.get(i + 1) ?? 0) > 0)
          throw new ErreurMetier(
            'L\'article ' + (i + 1) + ' a deja ete apure : il ne peut pas etre retire. '
            + 'Supprimez d\'abord ses apurements.');
      }
    }
    articles.forEach((a, i) => {
      const sorti = apures.get(i + 1) ?? 0;
      const q = num(a['nbColis']) || num(a['poids']);
      if (sorti > 0 && q < sorti)
        throw new ErreurMetier(
          'Article ' + (i + 1) + ' : ' + sorti + ' deja sorti(s), la quantite ne peut pas descendre a ' + q + '.');
    });
    patch['articles'] = articles;
    traces.push('articles (' + articles.length + ')');
  }

  if (!traces.length) return { id, inchange: true };
  const { error } = await ctx.db.from('entrepot_entrees').update(patch).eq('id', id);
  if (error) throw new Error(error.message);
  await ctx.log('Correction entree entrepot ' + String(avant['entrepotCode']), id, traces.join(' · '));
  return { id, modifie: traces.length };
}

/**
 * `entrepot.entreedelete` : supprimer un DEPOT (administration).
 * Refuse tant qu'un apurement s'y rattache : ce sont eux qui donneraient un
 * sommier faux, pas l'entree elle-meme.
 */
export async function entrepotEntreeSupprimer(ctx: Ctx, p: Record<string, unknown>) {
  const id = maj(p['id'], 30);
  const motif = maj(p['motif'], 200);
  if (!id) throw new ErreurMetier('Identifiant de l\'entree requis.');
  if (!motif) throw new ErreurMetier('Motif de la suppression requis.');
  const { data: e } = await ctx.db.from('entrepot_entrees').select('*').eq('id', id).maybeSingle();
  if (!e) throw new ErreurMetier('Entree « ' + id + ' » introuvable.');

  const { data: sorties } = await ctx.db.from('entrepot_sorties').select('id').eq('entree_id', id);
  const n = (sorties ?? []).length;
  if (n > 0)
    throw new ErreurMetier(
      'Suppression impossible : ' + n + ' apurement(s) se rattachent a ce depot. '
      + 'Supprimez-les d\'abord, sinon le sommier ne se retrouverait plus.');

  const { error } = await ctx.db.from('entrepot_entrees').delete().eq('id', id);
  if (error) throw new Error(error.message);
  /* Les conteneurs de cette entree avaient ete marques « Depote » au stock. On
     ne revient pas dessus : leur etat d'avant n'est pas connu, et le dire ici
     vaut mieux que de le deviner. */
  await ctx.log('Suppression entree entrepot ' + String(e['entrepot_code']), id,
    String(e['numero_declaration'] ?? '') + ' · ' + motif);
  return { id };
}

/**
 * `entrepot.sortieedit` : corriger un APUREMENT (quantite, camion, scelles,
 * declaration d'apurement). La quantite reste bornee par ce qui restait.
 */
export async function entrepotSortieEdit(ctx: Ctx, p: Record<string, unknown>) {
  const id = maj(p['id'], 30);
  if (!id) throw new ErreurMetier('Identifiant de l\'apurement requis.');
  const { data: s0 } = await ctx.db.from('entrepot_sorties').select('*').eq('id', id).maybeSingle();
  if (!s0) throw new ErreurMetier('Apurement « ' + id + ' » introuvable.');
  const avant = versCamel(s0);
  const code = String(avant['entrepotCode']);
  const entreeId = String(avant['entreeId']);
  const numeroArticle = Number(avant['numeroArticle'] ?? 1);
  const type = String((await ctx.db.from('entrepots').select('type').eq('code', code).maybeSingle()).data?.type ?? 'MAD');
  const unite = uniteApurement(type);

  const patch: Record<string, unknown> = {};
  const traces: string[] = [];

  if (p['nbColis'] !== undefined || p['poids'] !== undefined) {
    const nbColis = p['nbColis'] !== undefined ? Math.round(num(p['nbColis'])) : num(avant['nbColis']);
    const poids = p['poids'] !== undefined ? num(p['poids']) : num(avant['poids']);
    const quantite = unite === 'poids' ? poids : nbColis;
    if (quantite <= 0) throw new ErreurMetier('Quantite apuree invalide.');
    // Le restant est calcule SANS cet apurement : on remplace, on n'ajoute pas.
    const { rows } = await entrepotEntrees(ctx, { entrepotCode: code });
    const art = (rows.find((r) => r['id'] === entreeId)?.['articles'] as Record<string, unknown>[] | undefined)?.[numeroArticle - 1];
    const ancienneQuantite = unite === 'poids' ? num(avant['poids']) : num(avant['nbColis']);
    const disponible = Number(art?.['restant'] ?? 0) + ancienneQuantite;
    if (quantite > disponible)
      throw new ErreurMetier('Apurement (' + quantite + ') superieur au restant disponible (' + disponible + ').');
    if (nbColis !== num(avant['nbColis']) || poids !== num(avant['poids'])) {
      patch['nb_colis'] = nbColis; patch['poids'] = poids;
      traces.push('quantite ' + ancienneQuantite + ' -> ' + quantite);
    }
  }
  if (p['numeroCamion'] !== undefined) {
    const v = maj(p['numeroCamion'], 30).replace(/[^A-Z0-9/-]/g, '');
    if (v !== String(avant['numeroCamion'] ?? '')) { patch['numero_camion'] = v; traces.push('camion ' + (avant['numeroCamion'] || '(vide)') + ' -> ' + (v || '(vide)')); }
  }
  if (p['scelles'] !== undefined) {
    const v = (Array.isArray(p['scelles']) ? (p['scelles'] as unknown[]) : []).map((x) => maj(x, 30)).filter(Boolean);
    const ancien = (Array.isArray(avant['scelles']) ? avant['scelles'] : []) as string[];
    if (v.join(',') !== ancien.join(',')) { patch['scelles'] = v; traces.push('scelles'); }
  }
  if (p['designation'] !== undefined) {
    const v = maj(p['designation'], 200);
    if (v !== String(avant['designation'] ?? '')) { patch['designation'] = v; traces.push('designation'); }
  }
  const d = (p['declarationApurement'] ?? {}) as Record<string, unknown>;
  const champs: [string, string, string, number][] = [
    ['numeroDeclaration', 'numero_declaration', 'n° declaration', 30],
    ['anneeDeclaration', 'annee_declaration', 'annee', 6],
    ['bureauDeclaration', 'bureau_declaration', 'bureau', 20],
    ['typeDeclaration', 'type_declaration', 'type', 10],
  ];
  for (const [cle, colonne, libelle, taille] of champs) {
    if (d[cle] === undefined) continue;
    const v = maj(d[cle], taille);
    if (v !== String(avant[cle] ?? '')) { patch[colonne] = v; traces.push(libelle); }
  }

  if (!traces.length) return { id, inchange: true };
  const { error } = await ctx.db.from('entrepot_sorties').update(patch).eq('id', id);
  if (error) throw new Error(error.message);
  await ctx.log('Correction apurement ' + code, id, traces.join(' · '));
  return { id, modifie: traces.length };
}

/**
 * `entrepot.sortiedelete` : supprimer un APUREMENT (administration).
 * Refuse si un camion a ete cree pour cette sortie et vit encore : le dossier
 * dirait qu'une marchandise est sortie que le sommier aurait oubliee.
 */
export async function entrepotSortieSupprimer(ctx: Ctx, p: Record<string, unknown>) {
  const id = maj(p['id'], 30);
  const motif = maj(p['motif'], 200);
  if (!id) throw new ErreurMetier('Identifiant de l\'apurement requis.');
  if (!motif) throw new ErreurMetier('Motif de la suppression requis.');
  const { data: s0 } = await ctx.db.from('entrepot_sorties').select('*').eq('id', id).maybeSingle();
  if (!s0) throw new ErreurMetier('Apurement « ' + id + ' » introuvable.');

  const cargaisonId = String(s0['cargaison_id'] ?? '');
  if (cargaisonId) {
    const { data: cargo } = await ctx.db.from('cargaisons').select('id, statut, annule').eq('id', cargaisonId).maybeSingle();
    if (cargo && cargo['annule'] !== true)
      throw new ErreurMetier(
        'Cet apurement a cree le camion ' + cargaisonId + ' (statut « ' + String(cargo['statut']) + ' »). '
        + 'Annulez d\'abord ce dossier, sinon il resterait un camion sorti sans apurement.');
  }

  const { error } = await ctx.db.from('entrepot_sorties').delete().eq('id', id);
  if (error) throw new Error(error.message);
  await ctx.log('Suppression apurement ' + String(s0['entrepot_code']), id,
    String(s0['numero_declaration'] ?? '') + ' · ' + motif);
  return { id };
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
