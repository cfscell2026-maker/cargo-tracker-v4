/**
 * ============================================================================
 *  Actions STOCK, STOCK ANNONCÉ, DÉCLARATIONS — transcription fidèle (v3.6).
 *  Correction I-5 appliquée (décision utilisateur) : au ré-import de l'annonce,
 *  une ligne « Pointé » OU « Confirmé » n'est plus écrasée.
 * ============================================================================
 */
import type { Ctx } from '../ctx.ts';
import { versCamel } from '../ctx.ts';
import {
  STOCK_STATUTS, ANNONCE_STATUTS, TRANCHES_SEJOUR, SEUIL_ALERTE_SEJOUR,
  tailleBucket, evpDeTaille, trancheAge, tcValide, maj, parseDateImport,
} from '../../_shared/domaine/src/index.ts';
import { lookupDeclaration } from './helpers.ts';

const normTC = (v: unknown) => String(v ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const iso = (v: unknown) => (v ? new Date(String(v)).toISOString() : null);
const jours = (a: Date, b: Date) => Math.max(0, Math.floor((b.getTime() - a.getTime()) / 86400000));

/* ------------------------------ decl.lookup ---------------------------- */
export async function declLookup(ctx: Ctx, p: Record<string, unknown>) {
  return lookupDeclaration(ctx, (p['declaration'] ?? p) as never);
}

/* -------------------------------- stock -------------------------------- */

export async function stockList(ctx: Ctx, opts: { statut?: string }) {
  const statut = opts?.statut || 'tous';
  const { data, error } = await ctx.db.from('stock').select('*');
  if (error) throw new Error(error.message);
  const now = new Date();
  const rows: unknown[] = [];
  const compte = { total: 0, stock: 0, positionne: 0, depote: 0, pointes: 0, evp: 0, t20: 0, t40: 0, t45: 0, autres: 0, sejourMoyen: 0, tranches: [] as { tranche: string; n: number }[] };
  const dist: Record<string, number> = {};
  TRANCHES_SEJOUR.forEach((t) => (dist[t] = 0));
  let sommeJ = 0, nJ = 0;
  for (const r of data ?? []) {
    const o = versCamel(r);
    if (!o['numeroTc']) continue;
    compte.total++;
    const bk = tailleBucket(o['taille']); (compte as Record<string, number>)[bk]++; compte.evp += evpDeTaille(bk);
    if (o['statut'] === STOCK_STATUTS.STOCK) compte.stock++;
    else if (o['statut'] === STOCK_STATUTS.POSITIONNE) compte.positionne++;
    else if (o['statut'] === STOCK_STATUTS.DEPOTE) compte.depote++;
    if (o['datePointage']) compte.pointes++;
    const j = o['dateEntree'] ? jours(new Date(String(o['dateEntree'])), now) : Number(o['nbSejoursImport'] || 0) || 0;
    if (o['statut'] !== STOCK_STATUTS.DEPOTE) { dist[trancheAge(j)]++; sommeJ += j; nJ++; }
    if (statut !== 'tous' && o['statut'] !== statut) continue;
    rows.push({
      numeroTC: o['numeroTc'], taille: o['taille'], typeConteneur: o['typeConteneur'], provenance: o['provenance'],
      statut: o['statut'], dateEntree: o['dateEntree'], datePointage: o['datePointage'], pointePar: o['pointePar'],
      cargaisonId: o['cargaisonId'], joursSejour: j,
    });
  }
  compte.sejourMoyen = nJ ? Math.round(sommeJ / nJ) : 0;
  compte.tranches = TRANCHES_SEJOUR.map((t) => ({ tranche: t, n: dist[t]! }));
  return { rows, compte };
}

export async function stockImport(ctx: Ctx, p: { items?: Record<string, unknown>[]; provenanceDefaut?: string }) {
  const items = Array.isArray(p.items) ? p.items : [];
  if (!items.length) throw new Error('Aucune ligne à importer.');
  const provDef = maj(p.provenanceDefaut || 'PORT SEC', 40);
  const now = new Date().toISOString();
  // État existant (pour distinguer maj vs ajout et conserver le statut).
  const { data: existants, error } = await ctx.db.from('stock').select('numero_tc, statut');
  if (error) throw new Error(error.message);
  const present = new Set((existants ?? []).map((r) => normTC(r.numero_tc)));
  let ajoutes = 0, majN = 0, ignores = 0;
  const aInserer: Record<string, unknown>[] = [];
  const aMaj: Record<string, unknown>[] = [];
  for (const it of items) {
    const tc = normTC(it['numeroTC']);
    if (!tc || !tcValide(tc)) { ignores++; continue; }
    const taille = maj(it['taille'], 10);
    const nbSej = Number(it['nbSejours'] || it['nbSejoursImport'] || 0) || 0;
    const dEnt = iso(parseDateImport(it['dateEntree'])) || now;
    if (present.has(tc)) {
      aMaj.push({ numero_tc: tc, taille: taille || undefined, date_entree: dEnt, nb_sejours_import: nbSej });
      majN++;
    } else {
      aInserer.push({
        numero_tc: tc, taille, type_conteneur: maj(it['typeConteneur'], 30),
        provenance: maj(it['provenance'], 40) || provDef, date_entree: dEnt,
        statut: STOCK_STATUTS.STOCK, nb_sejours_import: nbSej,
      });
      present.add(tc); ajoutes++;
    }
  }
  if (aInserer.length) {
    const { error: e } = await ctx.db.from('stock').insert(aInserer);
    if (e) throw new Error(e.message);
  }
  for (const m of aMaj) {
    const patch: Record<string, unknown> = { date_entree: m['date_entree'], nb_sejours_import: m['nb_sejours_import'] };
    if (m['taille']) patch['taille'] = m['taille'];
    await ctx.db.from('stock').update(patch).eq('numero_tc', m['numero_tc']);
  }
  await ctx.log('Import stock', '', ajoutes + ' ajouté(s), ' + majN + ' mis à jour, ' + ignores + ' ignoré(s)');
  return { ajoutes, maj: majN, ignores };
}

export async function stockPointage(ctx: Ctx, p: Record<string, unknown>) {
  const tc = normTC(p['numeroTC']);
  if (!tc) throw new Error('N° conteneur requis.');
  const { data: o, error } = await ctx.db.from('stock').select('*').eq('numero_tc', tc).maybeSingle();
  if (error) throw new Error(error.message);
  if (!o) throw new Error('Conteneur « ' + tc + " » absent du stock. Importez-le d'abord.");
  if (o.statut === STOCK_STATUTS.POSITIONNE || o.date_pointage) {
    const dp = o.date_pointage ? new Date(o.date_pointage).toLocaleDateString('fr-FR') : '';
    throw new Error('Conteneur « ' + tc + ' » DÉJÀ POINTÉ le ' + dp + ' (par ' + (o.pointe_par || '?') + '). Pointage bloqué.');
  }
  if (o.statut === STOCK_STATUTS.DEPOTE) throw new Error('Conteneur déjà dépoté.');
  const now = new Date().toISOString();
  const { error: e2 } = await ctx.db
    .from('stock')
    .update({ statut: STOCK_STATUTS.POSITIONNE, date_positionne: now, date_pointage: now, pointe_par: ctx.session.nomComplet })
    .eq('numero_tc', tc)
    .eq('statut', STOCK_STATUTS.STOCK); // garde optimiste : bloque un double pointage concurrent
  if (e2) throw new Error(e2.message);
  await ctx.log('Pointage matinal', tc, '');
  const s = (await stockList(ctx, { statut: 'tous' })).compte;
  return { numeroTC: tc, positionne: s.positionne, depote: s.depote, restantAOuvrir: s.positionne };
}

export async function stockEntreeMagasin(ctx: Ctx, p: Record<string, unknown>) {
  const tc = normTC(p['numeroTC']);
  if (!tc) throw new Error('N° conteneur requis.');
  const now = new Date().toISOString();
  const { data: o, error } = await ctx.db.from('stock').select('numero_tc').eq('numero_tc', tc).maybeSingle();
  if (error) throw new Error(error.message);
  if (!o) {
    const { error: e } = await ctx.db.from('stock').insert({
      numero_tc: tc, taille: maj(p['taille'], 10), type_conteneur: maj(p['typeConteneur'], 30),
      provenance: maj(p['provenance'] || 'PORT SEC', 40), date_entree: now, statut: STOCK_STATUTS.DEPOTE,
      date_depote: now, observations: 'Entrée magasin/MAD',
    });
    if (e) throw new Error(e.message);
  } else {
    await ctx.db.from('stock').update({ statut: STOCK_STATUTS.DEPOTE, date_depote: now, observations: 'Entrée magasin/MAD' }).eq('numero_tc', tc);
  }
  await ctx.log('Entrée Magasin/MAD — conteneur dépoté', tc, '');
  return { numeroTC: tc };
}

/* ----------------------------- stock annoncé --------------------------- */

export async function annonceImport(ctx: Ctx, p: { items?: Record<string, unknown>[] }) {
  const items = Array.isArray(p.items) ? p.items : [];
  if (!items.length) throw new Error('Aucune ligne à importer.');
  const now = new Date().toISOString();
  const { data: existants, error } = await ctx.db.from('stock_annonce').select('numero_tc, statut');
  if (error) throw new Error(error.message);
  const statutParTC = new Map((existants ?? []).map((r) => [normTC(r.numero_tc), r.statut as string]));
  let ajoutes = 0, majN = 0, ignores = 0;
  const aInserer: Record<string, unknown>[] = [];
  const aMaj: Record<string, unknown>[] = [];
  for (const it of items) {
    const tc = normTC(it['numeroTC']);
    if (!tc || !tcValide(tc)) { ignores++; continue; }
    const champs = {
      taille: maj(it['taille'], 10), date_entree: iso(parseDateImport(it['dateEntree'])) || now,
      annee_declaration: maj(it['anneeDeclaration'], 6), bureau_declaration: maj(it['bureauDeclaration'], 20),
      type_declaration: maj(it['typeDeclaration'], 6), numero_declaration: maj(it['numeroDeclaration'], 30),
    };
    if (statutParTC.has(tc)) {
      const st = statutParTC.get(tc);
      // I-5 (corrigé) : ne pas écraser une ligne déjà POINTÉE **ou** CONFIRMÉE.
      if (st !== ANNONCE_STATUTS.POINTE && st !== ANNONCE_STATUTS.CONFIRME) {
        aMaj.push({ numero_tc: tc, ...champs });
      }
      majN++;
    } else {
      aInserer.push({ numero_tc: tc, ...champs, statut: ANNONCE_STATUTS.ANNONCE, date_annonce: now });
      statutParTC.set(tc, ANNONCE_STATUTS.ANNONCE); ajoutes++;
    }
  }
  if (aInserer.length) {
    const { error: e } = await ctx.db.from('stock_annonce').insert(aInserer);
    if (e) throw new Error(e.message);
  }
  for (const m of aMaj) {
    const { numero_tc, ...rest } = m;
    await ctx.db.from('stock_annonce').update(rest).eq('numero_tc', numero_tc);
  }
  await ctx.log('Import annonce de transfert', '', ajoutes + ' annoncé(s), ' + majN + ' mis à jour, ' + ignores + ' ignoré(s)');
  return { ajoutes, maj: majN, ignores };
}

export async function annonceList(ctx: Ctx, opts: { statut?: string }) {
  const statut = opts?.statut || 'tous';
  const { data, error } = await ctx.db.from('stock_annonce').select('*');
  if (error) throw new Error(error.message);
  const now = new Date();
  const rows: unknown[] = [];
  const compte = { total: 0, annonces: 0, aConfirmer: 0, confirmes: 0, pointes: 0, tauxTransfert: 0, delaiMoyen: 0, instanceMax: 0 };
  let sommeDelai = 0, nDelai = 0;
  for (const r of data ?? []) {
    const o = versCamel(r);
    if (!o['numeroTc']) continue;
    compte.total++;
    const estConfirme = o['statut'] === ANNONCE_STATUTS.CONFIRME;
    const estPointe = o['statut'] === ANNONCE_STATUTS.POINTE;
    if (estConfirme) compte.confirmes++;
    else if (estPointe) compte.aConfirmer++;
    else compte.annonces++;
    let j = 0;
    if (estConfirme && o['dateConfirmation'] && o['dateAnnonce']) {
      j = jours(new Date(String(o['dateAnnonce'])), new Date(String(o['dateConfirmation']))); sommeDelai += j; nDelai++;
    } else if (!estConfirme && o['dateAnnonce']) {
      j = jours(new Date(String(o['dateAnnonce'])), now);
      if (j > compte.instanceMax) compte.instanceMax = j;
    }
    if (statut !== 'tous' && o['statut'] !== statut) continue;
    rows.push({
      numeroTC: o['numeroTc'], taille: o['taille'], statut: o['statut'],
      anneeDeclaration: o['anneeDeclaration'], bureauDeclaration: o['bureauDeclaration'],
      typeDeclaration: o['typeDeclaration'], numeroDeclaration: o['numeroDeclaration'],
      dateEntree: o['dateEntree'], dateAnnonce: o['dateAnnonce'], datePointage: o['datePointage'],
      pointePar: o['pointePar'], dateConfirmation: o['dateConfirmation'], confirmePar: o['confirmePar'], jours: j,
    });
  }
  compte.pointes = compte.aConfirmer + compte.confirmes;
  compte.tauxTransfert = compte.total ? Math.round((compte.confirmes / compte.total) * 100) : 0;
  compte.delaiMoyen = nDelai ? Math.round(sommeDelai / nDelai) : 0;
  return { rows, compte };
}

export async function annoncePointage(ctx: Ctx, p: Record<string, unknown>) {
  const tc = normTC(p['numeroTC']);
  if (!tc) throw new Error('N° conteneur requis.');
  const { data: o, error } = await ctx.db.from('stock_annonce').select('*').eq('numero_tc', tc).maybeSingle();
  if (error) throw new Error(error.message);
  if (!o) throw new Error('Conteneur « ' + tc + ' » introuvable dans le stock annoncé.');
  if (o.statut === ANNONCE_STATUTS.POINTE || o.statut === ANNONCE_STATUTS.CONFIRME) {
    const dp = o.date_pointage ? new Date(o.date_pointage).toLocaleString('fr-FR') : '';
    throw new Error('Conteneur « ' + tc + ' » DÉJÀ POINTÉ le ' + dp + ' (par ' + (o.pointe_par || '?') + ').');
  }
  await ctx.db.from('stock_annonce').update({
    statut: ANNONCE_STATUTS.POINTE, date_pointage: new Date().toISOString(), pointe_par: ctx.session.nomComplet,
  }).eq('numero_tc', tc).eq('statut', ANNONCE_STATUTS.ANNONCE);
  await ctx.log('Pointage entrée (stock annoncé)', tc, '');
  const s = (await annonceList(ctx, { statut: 'tous' })).compte;
  return { numeroTC: tc, annonces: s.annonces, aConfirmer: s.aConfirmer, confirmes: s.confirmes, tauxTransfert: s.tauxTransfert };
}

export async function annonceConfirmer(ctx: Ctx, p: Record<string, unknown>) {
  const tc = normTC(p['numeroTC']);
  if (!tc) throw new Error('N° conteneur requis.');
  const { data: o, error } = await ctx.db.from('stock_annonce').select('*').eq('numero_tc', tc).maybeSingle();
  if (error) throw new Error(error.message);
  if (!o) throw new Error('Conteneur « ' + tc + ' » introuvable dans le stock annoncé.');
  if (o.statut === ANNONCE_STATUTS.CONFIRME) throw new Error('Conteneur « ' + tc + ' » déjà confirmé / entré au stock.');
  if (o.statut !== ANNONCE_STATUTS.POINTE) throw new Error('Conteneur « ' + tc + ' » pas encore pointé par la Porte Principale.');
  const now = new Date().toISOString();
  await ctx.db.from('stock_annonce').update({
    statut: ANNONCE_STATUTS.CONFIRME, date_confirmation: now, confirme_par: ctx.session.nomComplet,
  }).eq('numero_tc', tc).eq('statut', ANNONCE_STATUTS.POINTE);
  // Entrée EFFECTIVE au stock du port sec (provenance = Port autonome).
  const { data: sExist } = await ctx.db.from('stock').select('numero_tc').eq('numero_tc', tc).maybeSingle();
  if (sExist) {
    await ctx.db.from('stock').update({ date_entree: o.date_entree || now }).eq('numero_tc', tc);
  } else {
    await ctx.db.from('stock').insert({
      numero_tc: tc, taille: o.taille, provenance: 'PORT AUTONOME', date_entree: o.date_entree || now,
      statut: STOCK_STATUTS.STOCK, observations: 'Transfert annoncé confirmé le ' + new Date().toLocaleDateString('fr-FR'),
    });
  }
  await ctx.log('Confirmation entrée stock (annoncé)', tc, '');
  const s = (await annonceList(ctx, { statut: 'tous' })).compte;
  return { numeroTC: tc, aConfirmer: s.aConfirmer, confirmes: s.confirmes, tauxTransfert: s.tauxTransfert };
}

/* ----------------------- report.stock (séjour conteneurs) -------------- */

export async function rapportStock(ctx: Ctx) {
  const { data, error } = await ctx.db.from('stock').select('*');
  if (error) throw new Error(error.message);
  const now = new Date();
  const dist: Record<string, { tranche: string; n: number }> = {};
  TRANCHES_SEJOUR.forEach((t) => (dist[t] = { tranche: t, n: 0 }));
  const compte = { total: 0, stock: 0, positionne: 0, depote: 0, pointes: 0, evp: 0, t20: 0, t40: 0, t45: 0, autres: 0, sejourMoyen: 0, alerte: 0 };
  const instance: unknown[] = [];
  let sommeJ = 0, nJ = 0;
  for (const r of data ?? []) {
    const o = versCamel(r);
    if (!o['numeroTc']) continue;
    compte.total++;
    const bk = tailleBucket(o['taille']); (compte as Record<string, number>)[bk]++; compte.evp += evpDeTaille(bk);
    if (o['statut'] === STOCK_STATUTS.STOCK) compte.stock++;
    else if (o['statut'] === STOCK_STATUTS.POSITIONNE) compte.positionne++;
    else if (o['statut'] === STOCK_STATUTS.DEPOTE) compte.depote++;
    if (o['datePointage']) compte.pointes++;
    if (o['statut'] === STOCK_STATUTS.DEPOTE) continue;
    const j = o['dateEntree'] ? jours(new Date(String(o['dateEntree'])), now) : Number(o['nbSejoursImport'] || 0) || 0;
    dist[trancheAge(j)]!.n++; sommeJ += j; nJ++;
    if (j >= SEUIL_ALERTE_SEJOUR) compte.alerte++;
    instance.push({ numeroTC: o['numeroTc'], taille: o['taille'], statut: o['statut'], provenance: o['provenance'], joursSejour: j });
  }
  compte.sejourMoyen = nJ ? Math.round(sommeJ / nJ) : 0;
  instance.sort((a, b) => (b as { joursSejour: number }).joursSejour - (a as { joursSejour: number }).joursSejour);
  return { compte, tranches: TRANCHES_SEJOUR.map((t) => dist[t]), instance, seuil: SEUIL_ALERTE_SEJOUR };
}
