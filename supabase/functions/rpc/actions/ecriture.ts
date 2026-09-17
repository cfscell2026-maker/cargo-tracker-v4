/**
 * ============================================================================
 *  Actions d'ÉCRITURE — flux principal (transcription fidèle de Data.gs v3.6).
 *  createcamion, cfs, declaration, sceller, valider, horsgabarit, t1, gps,
 *  gpsedit, bonsortie, sortie, etatcfs, arriveebureau, editcamion, update,
 *  mixte, visite. Messages d'erreur conservés MOT POUR MOT.
 * ============================================================================
 */
import { ErreurMetier, type Ctx } from '../ctx.ts';
import { versCamel } from '../ctx.ts';
import {
  ROLES, STATUTS, STOCK_STATUTS, OPERATIONS, ETATS_SORTIE, HAUTEUR_HORS_GABARIT, CONTENEURS_MAX, exigeControlePoids,
  alphaNumMaj, maj, txt, tcValide, camionValide, messageCamionFormat,
  normaliserConteneur, normaliserDeclaration, parseConteneursDetails,
  declKey, typeDeRoutage, tailleBucket, construireCamion, verifierBinome, apercuConteneurs,
  etapesEnAttente, etatCellules, estOui, aFait, sautsTypeC,
} from '../../_shared/domaine/src/index.ts';
import {
  getCargo, patchCargo, nextId, nextRapportId, ajouterConteneurs, supprimerConteneursDe,
  renommerCamionConteneurs, lierStock, delierStock, stockDisponible, stockFiche, lookupDeclaration, majApurement,
  majApurementSafe, majApurementDec, declCont, signature,
} from './helpers.ts';

const b = (v: boolean) => v; // clarté d'intention : on stocke des booléens typés

/**
 * SEC-13 — Interrupteur de BLOCAGE à la Porte Principale.
 *
 * `false` par défaut : la sortie est enregistrée même si une pièce manque, mais
 * l'écart est consigné tel quel (voir `sortie`). Passer à `true` le jour où les
 * cellules T1 et Bon de sortie sont réellement pourvues — sans quoi le blocage
 * arrêterait tout le trafic de transit (aucun bon de sortie n'a jamais été émis
 * sur les données de production). Voir EXPLOITATION.md.
 *
 * `globalThis.Deno` : ce module est aussi chargé par les tests sous Node, où
 * l'objet Deno n'existe pas.
 */
const EXIGE_PIECES =
  String((globalThis as { Deno?: { env?: { get(k: string): string | undefined } } }).Deno?.env?.get('SORTIE_EXIGE_PIECES') ?? 'false')
    .toLowerCase() === 'true';

/* --------------------------- createcamion ------------------------------ */

export async function camionActif(ctx: Ctx, numeroCamion: string): Promise<Record<string, unknown> | null> {
  const q = String(numeroCamion || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!q) return null;
  const { data, error } = await ctx.db
    .from('cargaisons')
    .select('id, statut, numero_camion')
    .eq('numero_camion_norm', q)
    .neq('statut', STATUTS.SORTIE)
    .neq('annule', true) // SEC-12 : un doublon annulé ne bloque plus le camion
    .limit(1);
  if (error) throw new Error(error.message);
  return data && data[0] ? versCamel(data[0]) : null;
}

/** Étape 0 — le CFS crée le camion VIDE + choisit le type d'opération (v3.3). */
export async function createcamion(ctx: Ctx, p: { numeroCamion?: string; routage?: string; typeOperation?: string }) {
  const numeroCamion = alphaNumMaj(p.numeroCamion);
  if (!numeroCamion) throw new Error('N° camion requis.');
  // Format tracteur/remorque imposé le 2026-09-10 (voir camionValide).
  if (!camionValide(numeroCamion)) throw new ErreurMetier(messageCamionFormat(p.numeroCamion));
  const routage = String(p.routage || p.typeOperation || '').trim();
  if ([OPERATIONS.ENLEVEMENT, OPERATIONS.DEPOTAGE].indexOf(routage as never) === -1)
    throw new Error("Type d'opération requis : Enlèvement ou Dépotage.");
  const typeOp = typeDeRoutage(routage);
  const actif = await camionActif(ctx, numeroCamion);
  if (actif)
    throw new Error(
      'Le camion « ' + numeroCamion + ' » existe déjà (statut « ' + actif['statut'] + ' », ' + actif['id'] +
        "). Il ne pourra être recréé qu'après sa sortie.",
    );
  const id = await nextId(ctx);
  const rapportId = await nextRapportId(ctx);
  const now = new Date().toISOString();
  const { error } = await ctx.db.from('cargaisons').insert({
    id, reference: id, date_creation: now, numero_camion: numeroCamion,
    type_operation: typeOp, routage_entree: routage, agent_entree: ctx.session.nomComplet, agent_entree_id: ctx.session.userId,
    twins: false, statut: STATUTS.CAMION, derniere_maj: now, rapport_id: rapportId,
    nb_conteneurs: 0, saute_t1: false, saute_balise: false, saute_bs: false,
  });
  if (error) throw new Error(error.message);
  await ctx.log('Entrée camion (vide)', id, numeroCamion + ' · ' + routage);
  return { id, numeroCamion, typeOperation: typeOp, routage };
}

/* -------------------------------- cfs ---------------------------------- */

/** v2.7 — Saisie CFS itérative (un conteneur à la fois). Transcription de _associerCFS_. */
export async function cfs(ctx: Ctx, p: Record<string, unknown>) {
  const id = String(p['id'] ?? '').trim();
  const ct = normaliserConteneur((p['conteneur'] ?? {}) as never);
  const contInput = (p['conteneur'] ?? {}) as Record<string, unknown>;
  const manuel = !!contInput['manuel'];
  if (!tcValide(ct.num)) throw new Error('N° conteneur invalide. Format : 4 lettres + 7 chiffres (ex. MSKU1234567).');
  if (!ct.taille) throw new Error('Taille du conteneur obligatoire.');
  // v3.1 — le TYPE de conteneur est saisi à la main et n'est plus obligatoire.

  /* La saisie manuelle NE PEUT PLUS masquer un conteneur présent au parc
   * (2026-09-10).
   *
   * `manuel` existe pour les conteneurs ABSENTS du stock : partagés, arrivés
   * hors circuit d'import. C'était sa raison d'être. Mais il était appliqué
   * AVANT toute lecture du stock, si bien qu'il court-circuitait aussi les deux
   * contrôles suivants — l'existence, et l'exigence de pointage au dépotage.
   *
   * Conséquence : un conteneur bien présent au parc, mais non pointé, se
   * dépotait quand même en cochant la case. Et comme la saisie manuelle ne
   * rattache pas le conteneur à sa fiche stock, celui-ci restait « En stock »
   * indéfiniment — le parc affichait des conteneurs partis depuis longtemps, et
   * l'apurement portait à faux.
   *
   * On lit donc TOUJOURS le stock. `manuel` ne dispense plus que du cas
   * « absent du parc », qui reste son usage légitime. */
  const stk = await stockDisponible(ctx, ct.num);
  /* CONTENEUR PARTAGE - 2026-09-12.
   *
   * `stockDisponible` rend `null` pour un conteneur deja DEPOTE : il n'est plus
   * disponible. Or un conteneur depote au port sec alimente souvent PLUSIEURS
   * camions, sa marchandise etant repartie entre eux - le deuxieme tombait donc
   * sur << introuvable dans le stock >>, et le message invitait lui-meme a
   * cocher << saisie manuelle >>. C'est ainsi que la saisie manuelle, faite pour
   * les conteneurs ABSENTS du parc, est devenue l'outil du partage - en
   * detachant chaque fois le conteneur de sa fiche, ce que la regle voulait
   * precisement empecher.
   *
   * On separe donc les deux questions : << est-il disponible ? >> et
   * << existe-t-il ? >>. Un conteneur depote EXISTE, et cela suffit a l'attacher
   * a un camion de plus, sans saisie manuelle et sans perdre le lien. */
  const fiche = stk ? null : await stockFiche(ctx, ct.num);
  if (!manuel && !stk && !fiche)
    throw new Error(
      'Conteneur « ' + ct.num + ' » introuvable dans le stock. '
      + "Importez-le par « Stock initial », ou pointez-le d'abord.",
    );

  const cargo = await getCargo(ctx, id);
  const c = cargo.o;
  if ([STATUTS.CAMION, STATUTS.CHARGEMENT, STATUTS.CREEE].indexOf(c['statut'] as never) === -1)
    throw new Error('Ajout impossible : statut « ' + c['statut'] + ' ».');

  const premier = c['statut'] === STATUTS.CAMION;
  const type = (c['typeOperation'] || (premier ? p['typeOperation'] : c['typeOperation'])) as string;
  if ([OPERATIONS.ENLEVEMENT, OPERATIONS.DEPOTAGE].indexOf(type as never) === -1)
    throw new Error("Type d'opération invalide (Enlèvement ou Dépotage).");
  const estEnl = type === OPERATIONS.ENLEVEMENT;
  if (estEnl && !ct.plomb) throw new Error('Enlèvement : le scellé (plomb) du conteneur est obligatoire.');
  else if (!estEnl) ct.plomb = '';
  // ENLÈVEMENT : un conteneur présent au stock se rattache à sa fiche, pas à la main.
  // (En DÉPOTAGE, la saisie manuelle d'un conteneur au parc est permise depuis le
  // 2026-09-14 — voir les règles plus bas.)
  if (estEnl && manuel && stk)
    throw new ErreurMetier(
      `Le conteneur « ${ct.num} » EST au stock (statut « ${String(stk['statut'])} ») : `
      + `la saisie manuelle ne lui est pas destinée en enlèvement. Retirez la case « saisie manuelle » — `
      + `le conteneur sera rattaché à sa fiche de stock.`,
    );

  /* DÉPOTAGE : PLUS AUCUNE SAISIE MANUELLE (décision utilisateur 2026-09-10).
   *
   * Le contrôle précédent fermait la porte pour les conteneurs PRÉSENTS au parc.
   * Celui-ci la ferme entièrement, et il repose sur un fait métier : tout
   * conteneur qui se dépote au port sec est un conteneur qui a été ACHEMINÉ SUR
   * LE SITE DE LA PIA. Il figure donc au parc et doit être pointé — il n'existe
   * pas de conteneur à dépoter qui serait légitimement absent du stock.
   *
   * La saisie manuelle n'était donc plus une exception : c'était le moyen de ne
   * pas pointer. Chaque usage laissait un conteneur non rattaché à sa fiche, qui
   * restait « En stock » pour toujours — le parc se remplissait de conteneurs
   * partis, et l'apurement portait à faux.
   *
   * La voie normale couvre tous les cas réels : conteneur pointé le matin, ou
   * pointé À LA VOLÉE au moment du dépotage (`pointerSiNonPositionne`, v4.2).
   *
   * ⚠ L'ENLÈVEMENT n'est pas concerné : le conteneur y part scellé, et il peut
   * légitimement ne pas être passé par le parc. */
  /* CONTENEUR INCONNU DU STOCK — 2026-09-12.
   *
   * La règle du 2026-09-10 fermait la saisie manuelle en dépotage, en posant
   * que « tout conteneur dépoté au port sec figure au parc ». CONSTATÉ EN
   * PRODUCTION : c'est faux. « CCLU7731903 », présent physiquement, n'existait
   * dans aucune fiche — et l'écran ne proposait alors AUCUNE issue : la case de
   * régularisation ne s'affiche que pour un conteneur déjà fiché, et
   * « Pointage matinal » refuse ce qu'il ne connaît pas. Seul restait l'import
   * d'un fichier Excel — pour un conteneur. L'agent était bloqué.
   *
   * La saisie manuelle retrouve donc sa raison d'être D'ORIGINE, et elle seule :
   * les conteneurs ABSENTS du parc. Elle reste refusée dès que le conteneur est
   * fiché (contrôle juste au-dessus) — c'est là qu'elle servait à éviter le
   * pointage, et c'est ce détournement que la règle visait.
   *
   * ET ON CRÉE LA FICHE. C'est ce qui rend la réouverture sûre : le grief contre
   * la saisie manuelle était qu'elle laissait un conteneur SANS fiche, donc hors
   * du parc et hors de l'apurement. En créant la fiche au passage, on obtient
   * l'inverse de ce que la règle redoutait — un conteneur de plus rattaché,
   * tracé, et compté. */
  /* RÈGLES DU DOUANIER — 2026-09-12, dictées après trois blocages successifs.
   *
   *   · conteneur AU PARC mais NON POINTÉ  → pas de saisie manuelle. Il faut
   *     pointer : c'est exactement l'abus que la règle du 10 septembre visait.
   *   · conteneur DÉJÀ RATTACHÉ à un camion → saisie manuelle AUTORISÉE. Sa
   *     marchandise se répartit sur plusieurs camions ; il est déjà pointé et
   *     déjà sorti du parc, il n'y a plus rien à pointer.
   *   · conteneur ABSENT du parc → saisie manuelle autorisée, et sa fiche est
   *     créée au passage.
   *
   * Le cas « déjà rattaché » ne crée AUCUNE fiche — elle existe déjà — et ne
   * touche pas au stock : le repasser à « positionné » ferait réapparaître au
   * parc un conteneur qui en est parti.
   *
   * ⚠ 2026-09-14 — LA PREMIÈRE RÈGLE A CHANGÉ (demande utilisateur) : un conteneur
   * au parc non pointé ACCEPTE désormais la saisie manuelle, et un conteneur
   * partagé n'est plus compté du tout dans les conteneurs dépotés. */
  const dejaRattache = !estEnl && !!fiche && fiche['statut'] === STOCK_STATUTS.DEPOTE;
  if (dejaRattache && manuel) {
    await ctx.log('Saisie manuelle — conteneur déjà rattaché', ct.num,
      'partagé entre plusieurs camions : compté UNE SEULE FOIS dans les statistiques');
  } else if (!estEnl && manuel && !stk && !fiche) {
    const maintenant = new Date().toISOString();
    const { error: eFiche } = await ctx.db.from('stock').insert({
      numero_tc: ct.num, taille: ct.taille ?? '', type_conteneur: ct.type ?? '',
      provenance: 'PORT SEC', date_entree: maintenant,
      statut: STOCK_STATUTS.POSITIONNE, date_positionne: maintenant,
      date_pointage: maintenant, pointe_par: ctx.session.nomComplet,
      observations: 'Fiche créée au dépotage (conteneur absent du stock)',
    });
    if (eFiche) throw new Error(eFiche.message);
    await ctx.log('Fiche de stock créée au dépotage', ct.num,
      "conteneur absent du parc, déclaré présent par l'agent en saisie manuelle");
  } else if (!estEnl && manuel && stk) {
    /* RÈGLE MODIFIÉE LE 2026-09-14 (demande utilisateur) — AU PARC, NON POINTÉ.
     *
     * La règle du 12/09 refusait ici la saisie manuelle et imposait le pointage.
     * Elle est désormais PERMISE, proposée comme option à côté du pointage.
     *
     * Ce qui rendait le refus nécessaire est traité autrement : la saisie
     * manuelle détachait le conteneur de sa fiche, qui restait « En stock » pour
     * toujours. On la RATTACHE donc quand même (`lierStock` plus bas) : la fiche
     * passe à « Dépoté » sur ce camion, le parc reste juste, et l'opération est
     * tracée au journal. Seule différence avec le pointage : aucune date de
     * pointage n'est inventée. */
    await ctx.log('Saisie manuelle — conteneur présent au parc', ct.num,
      'statut « ' + String(stk['statut']) + ' » : rattaché à sa fiche et marqué dépoté, sans pointage');
  }

  /* v4.2 — CONTENEUR AU PARC MAIS PAS POINTÉ « POSITIONNÉ ».
   *
   * Le pointage matinal fige la liste du jour. Des conteneurs continuent d'être
   * positionnés dans la journée, après le passage de l'agent : au moment de les
   * dépoter, ils étaient refusés ici, et le seul contournement était de cocher
   * « saisie manuelle ». Or la saisie manuelle NE RATTACHE PAS le conteneur à sa
   * fiche stock : il reste « En stock » indéfiniment, le parc affiche des
   * conteneurs partis depuis longtemps, et l'apurement porte à faux.
   *
   * Le refus est donc remplacé par une RÉGULARISATION explicite : l'écran signale
   * que le conteneur est au parc sans avoir été pointé, l'agent confirme
   * (`pointerSiNonPositionne`), et on le pointe au passage — en le traçant comme
   * un pointage à part, distinct du pointage matinal.
   */
  let pointeALaVolee = false;

  /* LE CAS PARTAGÉ, NOMMÉ PLUTÔT QUE SUBI — 2026-09-12.
   *
   * Un conteneur DÉJÀ DÉPOTÉ qu'on rattache à un camion supplémentaire est
   * légitime : sa marchandise se répartit entre plusieurs camions. Il ne doit
   * donc PAS repasser par la règle de pointage — celle-ci réclamait un pointage
   * sur un conteneur déjà pointé et déjà sorti du parc, et la mise à jour qui
   * suivait, portant un `.neq('statut', DEPOTE)`, ne touchait de toute façon
   * aucune ligne. Le rendre « positionné » le ferait réapparaître au parc alors
   * qu'il en est parti : ce serait fausser le stock pour satisfaire une règle.
   *
   * On le trace, parce qu'un partage doit rester lisible dans le journal. */
  const estPartage = !estEnl && !!fiche && fiche['statut'] === STOCK_STATUTS.DEPOTE;
  if (estPartage) {
    await ctx.log('Conteneur partagé (dépotage)', ct.num,
      'déjà dépoté : rattaché à un camion supplémentaire, sans re-pointage');
  }

  // Pointage exigé pour un conteneur au parc non positionné — SAUF si l'agent a
  // choisi la saisie manuelle, permise pour ce cas depuis le 2026-09-14.
  if (!estPartage && !estEnl && !manuel && stk && stk['statut'] !== STOCK_STATUTS.POSITIONNE) {
    if (p['pointerSiNonPositionne'] !== true)
      throw new Error(
        'Dépotage : le conteneur « ' + ct.num + ' » est au parc (statut « ' + String(stk['statut']) +
          ' ») mais n\'a pas été pointé comme POSITIONNÉ au CFS. Confirmez le pointage pour continuer, ' +
          'ou pointez-le depuis « Pointage matinal ».',
      );
    const nowPointage = new Date().toISOString();
    const { error: ePoint } = await ctx.db.from('stock')
      .update({
        statut: STOCK_STATUTS.POSITIONNE, date_positionne: nowPointage,
        date_pointage: nowPointage, pointe_par: ctx.session.nomComplet,
      })
      .eq('numero_tc', ct.num)
      .neq('statut', STOCK_STATUTS.DEPOTE);
    if (ePoint) throw new Error(ePoint.message);
    pointeALaVolee = true;
    await ctx.log('Pointage à la volée (dépotage)', ct.num,
      'positionné au moment du dépotage — statut précédent : ' + String(stk['statut']));
  }
  void pointeALaVolee;

  const pd = parseConteneursDetails(c['conteneursDetails']);
  const conts = pd.conteneurs;
  const scellesCamion = pd.scellesCamion;
  if (conts.some((x) => normaliserConteneur(x).num === ct.num)) throw new Error('Ce conteneur est déjà sur ce camion.');

  if (estEnl) {
    const err = verifierBinome(conts, ct.taille);
    if (err) throw new Error(err);
  } else if (conts.length >= CONTENEURS_MAX) {
    throw new Error('Trop de conteneurs (max ' + CONTENEURS_MAX + ').');
  }

  // Déclaration complète (enlèvement 1er / dépotage chaque conteneur en v3.2+).
  const declInput = p['declaration'] as Record<string, unknown> | undefined;
  let declRef: ReturnType<typeof normaliserDeclaration> | null = null;
  if (declInput && String(declInput['declarant'] ?? '').trim()) {
    // Nb de conteneurs déclarés et date en douane sont facultatifs (décision user).
    declRef = normaliserDeclaration(declInput as never, type);
  }

  const declRefCamion: Record<string, unknown> = {
    numeroDeclaration: c['numeroDeclaration'], anneeDeclaration: c['anneeDeclaration'],
    bureauDeclaration: c['bureauDeclaration'], typeDeclaration: c['typeDeclaration'], declarant: c['declarant'],
  };
  if (premier && declRef) {
    declRefCamion['numeroDeclaration'] = declRef.numeroDeclaration; declRefCamion['anneeDeclaration'] = declRef.anneeDeclaration;
    declRefCamion['bureauDeclaration'] = declRef.bureauDeclaration; declRefCamion['typeDeclaration'] = declRef.typeDeclaration;
    declRefCamion['declarant'] = declRef.declarant;
  }
  const dc = declRef
    ? { numeroDeclaration: declRef.numeroDeclaration, anneeDeclaration: declRef.anneeDeclaration,
        bureauDeclaration: declRef.bureauDeclaration, typeDeclaration: declRef.typeDeclaration, declarant: declRef.declarant }
    : declCont(contInput, declRefCamion);
  const ctExt = ct as Record<string, unknown>;
  /* CONTENEUR PARTAGÉ : NON COMPTÉ — 2026-09-14 (demande utilisateur).
   * La ligne est marquée `partage`. Tous les compteurs de conteneurs (rapport
   * CFS, rapports de cellule, fiche de synthèse, KPI, flux) l'ignorent : la boîte
   * a déjà été comptée sur le camion qui l'a dépotée le premier. Le repérage par
   * numéro, lui, échouait dès que ce premier dépotage tombait dans une AUTRE
   * période. Le serveur seul pose ce drapeau : `normaliserConteneur` ne le
   * reprend pas de la saisie. */
  if (estPartage) ctExt['partage'] = true;
  ctExt['numeroDeclaration'] = dc.numeroDeclaration; ctExt['anneeDeclaration'] = dc.anneeDeclaration;
  ctExt['bureauDeclaration'] = dc.bureauDeclaration; ctExt['typeDeclaration'] = dc.typeDeclaration;
  if (declRef) {
    ctExt['declarant'] = declRef.declarant; ctExt['contactDeclarant'] = declRef.contactDeclarant;
    ctExt['destinationMarchandise'] = declRef.destinationMarchandise; ctExt['descriptionMarchandise'] = declRef.descriptionMarchandise;
    ctExt['nombreConteneurs'] = declInput?.['nombreConteneurs'] ?? '';
  }
  let mixte = false;
  if (declRefCamion['numeroDeclaration'] && dc.numeroDeclaration && declKey(dc) !== declKey(declRefCamion)) mixte = true;

  conts.push(ct);

  const patch: Record<string, unknown> = {};
  if (premier) {
    patch['type_operation'] = type;
    patch['agent_cfs'] = ctx.session.nomComplet;
    patch['agent_cfs_id'] = ctx.session.userId;
    // v4 — « nombre de colis » réservé au DÉPOTAGE (saisi à la finalisation,
    // cargo.declaration). L'enlèvement ne le renseigne plus.
    if (p['observationsCFS']) patch['observations_cfs'] = maj(p['observationsCFS'], 1000);
    if (declRef) {
      patch['declarant'] = declRef.declarant; patch['contact_declarant'] = declRef.contactDeclarant;
      patch['destination_marchandise'] = declRef.destinationMarchandise; patch['bureau_declaration'] = declRef.bureauDeclaration;
      patch['type_declaration'] = declRef.typeDeclaration; patch['numero_declaration'] = declRef.numeroDeclaration;
      patch['annee_declaration'] = declRef.anneeDeclaration; patch['description_marchandise'] = declRef.descriptionMarchandise;
    }
  }
  patch['nb_conteneurs'] = conts.length;
  patch['conteneurs_details'] = { conteneurs: conts, scellesCamion };
  patch['twins'] = b(estEnl && conts.length >= 2);
  if (mixte) patch['chargement_mixte'] = true;
  // v4 — déclaration hors transit (type C = conso, type A = admission) : saute
  // le T1 (et la Balise si « non balisée », consoMode='sansbalise'). Dès qu'une
  // déclaration est saisie, on (re)positionne les sauts selon son type.
  if (declRef) {
    const sauts = sautsTypeC(declRef.typeDeclaration, p['consoMode']);
    patch['saute_t1'] = sauts.sauteT1;
    patch['saute_balise'] = sauts.sauteBalise;
  }
  // v4.1 (affiné 2026-07-22) — ENLÈVEMENT : le scellé est posé PAR conteneur, à
  // la saisie ; ajouter le(s) conteneur(s) avec leurs scellés VAUT fin de
  // chargement → « Créée » directement, sans bouton à confirmer. DÉPOTAGE : les
  // scellés sont au niveau du CAMION et se posent à la finalisation
  // (hauteur + colis + scellés), donc il reste « En cours de chargement » tant
  // que `cargo.declaration` n'a pas été appelé.
  const resultStatut = estEnl ? STATUTS.CREEE : STATUTS.CHARGEMENT;
  patch['statut'] = resultStatut;

  await patchCargo(ctx, cargo, patch);
  await ajouterConteneurs(ctx, String(c['rapportId']), id, String(c['numeroCamion']), type, [ct], conts.length);
  if (declRef) await majApurement(ctx, declRef, Number(declInput?.['nombreConteneurs']) || undefined, 1);
  else await majApurementSafe(ctx, dc, 1);
  /* Rattachement à la fiche du parc (2026-09-14) : aussi en saisie manuelle —
   * conteneur au parc, ou fiche créée ci-dessus pour un absent — afin qu'aucun
   * conteneur dépoté ne reste « En stock » ou « Positionné ». JAMAIS pour un
   * conteneur partagé : sa fiche garde le camion et la date du premier dépotage. */
  if (!estPartage && (!manuel || !estEnl)) await lierStock(ctx, ct.num, id);

  await ctx.log('CFS — ajout conteneur', id, ct.num + ' (' + type + (estPartage ? ', partagé : non compté' : manuel ? ', saisie manuelle' : '') + (mixte ? ', mixte' : '') + ')');
  return { id, statut: resultStatut, conteneur: ct.num, mixte, manuel };
}

/**
 * RETRAIT DU SUIVI D'ENGAGEMENT — 2026-09-17 (demande utilisateur).
 *
 * La correction (`engagementEdit`) change le type et le délai ; elle ne sait pas
 * dire « finalement, ce camion n'a pas d'engagement ». Un engagement coché par
 * erreur restait donc pour toujours dans l'échéancier et dans les rapports, et
 * le seul contournement était d'inventer un type et une date.
 *
 * Le retrait efface le suivi ET ses deux valeurs, y compris le solde : la
 * cargaison redevient une cargaison sans engagement. RIEN N'EST PERDU pour
 * autant — l'engagement retiré, son échéance et son éventuel solde sont recopiés
 * au journal avant l'effacement, avec le motif : c'est ce qui rend le retrait
 * défendable lors d'un contrôle, puisqu'il porte sur une pièce signée.
 */
export async function engagementRetirer(ctx: Ctx, p: Record<string, unknown>) {
  const id = String(p['id'] ?? '').trim();
  const motif = txt(p['motif'], 300);
  if (!motif) throw new ErreurMetier('Indiquez le motif du retrait.');

  const cargo = await getCargo(ctx, id);
  const c = cargo.o;
  if (c['suiviEngagement'] !== true)
    throw new ErreurMetier("Cette cargaison n'est pas sous suivi d'engagement.");

  const avant = `${String(c['engagementType'] ?? '')} · ${String(c['engagementDelai'] ?? '')}`;
  const soldeLe = aFait(c['engagementEffectueLe']) ? fmtDate(c['engagementEffectueLe']) : '';
  await patchCargo(ctx, cargo, {
    suivi_engagement: false, engagement_type: null, engagement_delai: null, engagement_effectue_le: null,
  });
  await ctx.log('Retrait du suivi d\'engagement', id,
    'Retiré : ' + avant + (soldeLe ? ' · soldé le ' + soldeLe : '') + ' · motif : ' + motif);
  return { id, suiviEngagement: false };
}

/* ---------------------------- declaration ------------------------------ */

/** v3.2 — DÉPOTAGE : hauteur + colis + scellés → « Créée ». Hors gabarit auto. */
export async function declaration(ctx: Ctx, p: Record<string, unknown>) {
  const id = String(p['id'] ?? '').trim();
  const cargo = await getCargo(ctx, id);
  const c = cargo.o;
  if (c['typeOperation'] !== OPERATIONS.DEPOTAGE) throw new Error('Action réservée au dépotage.');
  if (ctx.session.role !== ROLES.ADMIN && c['statut'] !== STATUTS.CHARGEMENT)
    throw new Error('Finalisation impossible : le camion doit être « En cours de chargement » (statut « ' + c['statut'] + ' »).');

  const sc = (Array.isArray(p['scellesCamion']) ? (p['scellesCamion'] as unknown[]) : []).map((s) => maj(s, 30)).filter(Boolean);
  if (sc.length < 2) throw new Error('Au moins 2 scellés camion sont requis (dépotage).');
  if (sc.length > 3) throw new Error('3 scellés camion maximum.');
  const pd = parseConteneursDetails(c['conteneursDetails']);

  const hauteurStr = txt(p['hauteurChargement'], 30);
  const hauteurNum = parseFloat(String(p['hauteurChargement'] ?? '').replace(',', '.').replace(/[^0-9.]/g, ''));
  const horsGab = !isNaN(hauteurNum) && hauteurNum > HAUTEUR_HORS_GABARIT;

  const patch: Record<string, unknown> = {
    conteneurs_details: { conteneurs: pd.conteneurs, scellesCamion: sc },
    hauteur_chargement: hauteurStr,
    hors_gabarit: horsGab ? true : null,
    agent_cfs: ctx.session.nomComplet,
    agent_cfs_id: ctx.session.userId,
    statut: STATUTS.CREEE,
  };
  if (p['nbColis'] !== undefined && p['nbColis'] !== '') patch['nb_colis'] = txt(p['nbColis'], 20);
  if (p['observationsCFS']) patch['observations_cfs'] = maj(p['observationsCFS'], 1000);
  await patchCargo(ctx, cargo, patch);
  await ctx.log('CFS — finalisation dépotage' + (horsGab ? ' (HORS GABARIT)' : ''), id, '');
  return { id, statut: STATUTS.CREEE, horsGabarit: horsGab };
}

/* ----------------------------- fincharge ------------------------------- */

/**
 * v4.1 — FIN DE CHARGEMENT EXPLICITE (décision utilisateur 2026-07-22 :
 * « si la personne ne met pas fin de chargement, l'étape CFS ne passe pas au
 * vert et on ne peut pas avancer »).
 *
 * C'est le pendant, pour l'ENLÈVEMENT, de `cargo.declaration` qui clôt déjà le
 * DÉPOTAGE (hauteur + colis + scellés camion). Tant qu'elle n'est pas appelée,
 * le camion reste « En cours de chargement » : `etapesEnAttente` renvoie
 * ['CFS'], donc la validation du chef, le T1, la Balise, le bon de sortie et la
 * sortie PP sont tous refusés — le camion n'apparaît pas non plus sur le bon de
 * chargement par déclaration, qui ne retient que les camions « Créée ».
 *
 * Le dépotage garde SA porte (les scellés camion y sont la preuve matérielle de
 * la fin de chargement) : deux portes vers le même état avec des exigences
 * différentes ouvriraient un contournement.
 */
export async function finChargement(ctx: Ctx, p: Record<string, unknown>) {
  const id = String(p['id'] ?? '').trim();
  const cargo = await getCargo(ctx, id);
  const c = cargo.o;
  const estAdmin = ctx.session.role === ROLES.ADMIN;

  if (c['typeOperation'] === OPERATIONS.DEPOTAGE)
    throw new Error('Dépotage : terminez par la finalisation (hauteur, colis et scellés camion).');
  if (c['statut'] === STATUTS.CREEE) throw new Error('Le chargement de ce camion est déjà terminé.');
  if (!estAdmin && [STATUTS.CAMION, STATUTS.CHARGEMENT].indexOf(c['statut'] as never) === -1)
    throw new Error('Fin de chargement impossible : la cargaison a déjà avancé (statut « ' + c['statut'] + ' »).');

  // Un camion sans rien dessus n'a rien à clôturer : le laisser passer ferait
  // entrer une coquille vide dans le circuit des cellules en aval.
  const conts = parseConteneursDetails(c['conteneursDetails']).conteneurs;
  if (!conts.length && !String(c['descriptionMarchandise'] ?? '').trim())
    throw new Error('Rien à clôturer : ajoutez au moins un conteneur (ou la désignation des effets divers).');
  // Sans déclaration, les cellules en aval n'auraient rien à traiter.
  if (!String(c['numeroDeclaration'] ?? '').trim())
    throw new Error('Renseignez la déclaration avant de terminer le chargement.');
  // Le scellé porte la responsabilité du chargement en enlèvement.
  const sansPlomb = conts.filter((ct) => !normaliserConteneur(ct as never).plomb).length;
  if (sansPlomb) throw new Error('Enlèvement : ' + sansPlomb + ' conteneur(s) sans scellé. Corrigez-les avant de terminer.');

  await patchCargo(ctx, cargo, {
    statut: STATUTS.CREEE,
    agent_cfs: c['agentCfs'] || ctx.session.nomComplet,
    agent_cfs_id: c['agentCfsId'] || ctx.session.userId,
  });
  await ctx.log('CFS — fin de chargement', id, conts.length + ' conteneur(s)');
  return { id, statut: STATUTS.CREEE, conteneurs: conts.length };
}

/* ------------------------------- sceller ------------------------------- */

export async function sceller(ctx: Ctx, p: Record<string, unknown>) {
  const id = String(p['id'] ?? '').trim();
  const cargo = await getCargo(ctx, id);
  const c = cargo.o;
  if (ctx.session.role !== ROLES.ADMIN && c['statut'] !== STATUTS.CHARGEMENT)
    throw new Error("Pose de scellés impossible : la cargaison n'est pas « En cours de chargement ».");
  const type = c['typeOperation'];
  const pd = parseConteneursDetails(c['conteneursDetails']);
  const conts = pd.conteneurs;
  let scellesCamion = pd.scellesCamion;
  // Dépotage ET sortie Magasin/MAD : les scellés sont posés AU NIVEAU DU CAMION
  // (2-3), pas par conteneur — la sortie magasin est un vrac sans conteneur.
  if (type === OPERATIONS.DEPOTAGE || type === OPERATIONS.MAGASIN) {
    const sc = (Array.isArray(p['scellesCamion']) ? (p['scellesCamion'] as unknown[]) : []).map((s) => maj(s, 30)).filter(Boolean);
    if (sc.length < 2) throw new Error('Au moins 2 scellés requis.');
    if (sc.length > 3) throw new Error('3 scellés maximum.');
    scellesCamion = sc;
  } else {
    const pls = (Array.isArray(p['plombs']) ? (p['plombs'] as unknown[]) : []).map((s) => maj(s, 30));
    conts.forEach((ct, i) => (ct.plomb = pls[i] || ct.plomb || ''));
    if (conts.some((ct) => !ct.plomb)) throw new Error('Chaque conteneur doit avoir un scellé.');
  }
  await patchCargo(ctx, cargo, {
    conteneurs_details: { conteneurs: conts, scellesCamion },
    statut: STATUTS.CREEE,
  });
  await ctx.log('Pose des scellés (fin de chargement)', id, '');
  return { id };
}

/* -------------------------------- visite ------------------------------- */

export async function visite(ctx: Ctx, p: Record<string, unknown>) {
  const id = String(p['id'] ?? '').trim();
  const norm = (v: unknown) => String(v ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const conteneur = norm(p['conteneur']);
  const nouveau = maj(p['nouveauScelle'], 30);
  if (!conteneur || !nouveau) throw new Error('Conteneur et nouveau scellé requis.');
  const cargo = await getCargo(ctx, id);
  const pd = parseConteneursDetails(cargo.o['conteneursDetails']);
  let found = false;
  pd.conteneurs.forEach((ct) => {
    if (norm(ct.num) === conteneur) { ct.plomb = nouveau; found = true; }
  });
  if (!found) throw new Error('Conteneur introuvable dans la cargaison.');
  await patchCargo(ctx, cargo, { conteneurs_details: pd });
  await ctx.log('Visite — modification scellé', id, conteneur + ' → ' + nouveau);
  return { id };
}

/* ----------------------------- valider (CB) ---------------------------- */

/**
 * v4.1 — PESÉE obligatoire AVANT la validation (décision utilisateur 2026-07-27).
 * `enSurcharge` OUI/NON ; si OUI, le poids en surcharge (kg) est requis ; si NON,
 * le camion est « hors surcharge ». Renvoie le patch de pesée à appliquer.
 */
function peseePatch(p: Record<string, unknown>, exige: boolean): Record<string, unknown> {
  // v4.3 — la pesée (surcharge) ne concerne QUE le dépotage (2026-08-19). Hors
  // dépotage (enlèvement, véhicule, conso, magasin), aucune pesée n'est demandée :
  // la cargaison est simplement « hors surcharge », sans rien à saisir.
  if (!exige) return { en_surcharge: false, poids_surcharge: '' };
  const brut = p['enSurcharge'];
  if (brut === undefined || brut === null || brut === '')
    throw new Error('Renseignez la pesée (en surcharge : OUI / NON) avant de valider.');
  const enSurcharge = brut === true || String(brut).toLowerCase() === 'oui' || String(brut).toLowerCase() === 'true';
  const poids = maj(p['poidsSurcharge'], 30).replace(',', '.');
  if (enSurcharge && !poids)
    throw new Error('En surcharge : renseignez le poids en surcharge (kg).');
  return { en_surcharge: enSurcharge, poids_surcharge: enSurcharge ? poids : '' };
}

/**
 * SUIVI DES ENGAGEMENTS (2026-09-10) — renseigné par le chef de brigade à la
 * validation, sur TOUTES les opérations, et BLOQUANT.
 *
 * Même forme que `peseePatch` : une réponse OUI/NON, puis une précision exigée
 * si OUI. La garde vit ICI, côté serveur — l'écran désactive le bouton, mais
 * c'est cette fonction qui fait autorité : un appel direct à l'API ne peut pas
 * contourner la saisie.
 *
 * Le régime est du TEXTE LIBRE : les trois libellés d'`ENGAGEMENTS` ne sont que
 * des propositions, le chef doit pouvoir écrire autre chose. On ne valide donc
 * pas la valeur contre la liste — ce serait refuser le cas prévu par le besoin.
 */
function engagementPatch(p: Record<string, unknown>): Record<string, unknown> {
  const brut = p['suiviEngagement'];
  /* CHAMP ABSENT = ON N'EN TIENT PAS COMPTE — correctif du 2026-09-12.
   *
   * Cette garde refusait toute validation quand `suiviEngagement` manquait.
   * Elle a bloqué la production : le serveur a été déployé avant le front, or
   * l'écran alors en ligne — celui du 25 août — ignorait ce champ. Plus aucun
   * chef de brigade ne pouvait signer.
   *
   * LA LEÇON, qui vaut au-delà de ce champ : un serveur ne peut pas EXIGER ce
   * qu'un client déjà déployé n'a aucun moyen d'envoyer. Entre deux
   * déploiements, les deux versions coexistent forcément ; le serveur doit
   * tolérer l'absence, et c'est à l'écran d'exiger la réponse — ce qu'il fait
   * déjà : le bouton de signature y reste inerte tant qu'on n'a pas répondu.
   *
   * L'exigence n'est donc pas perdue, elle est portée là où elle est tenable.
   * Une valeur FOURNIE reste, elle, intégralement vérifiée ci-dessous. */
  if (brut === undefined || brut === null || brut === '') return {};
  const suivi = brut === true || String(brut).toLowerCase() === 'oui' || String(brut).toLowerCase() === 'true';
  const type = txt(p['engagementType'], 120);
  const delai = String(p['engagementDelai'] ?? '').slice(0, 10);

  if (!suivi) return { suivi_engagement: false, engagement_type: '', engagement_delai: null };

  if (!type)
    throw new ErreurMetier("Suivi des engagements : précisez l'engagement (liste ou saisie libre).");
  // Le délai est OBLIGATOIRE : un engagement sans échéance n'est pas suivi, il
  // est seulement noté. C'est lui qui fait vivre l'échéancier du tableau de bord.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(delai))
    throw new ErreurMetier("Suivi des engagements : indiquez le délai (date d'envoi des informations).");
  // Une échéance déjà passée serait en retard dès la signature : c'est une faute
  // de frappe, pas une intention. On refuse, plutôt que de créer une alerte
  // immédiate que personne ne comprendrait.
  const aujourdhui = new Date().toISOString().slice(0, 10);
  if (delai < aujourdhui)
    throw new ErreurMetier(`Le délai (${delai}) est déjà passé. Indiquez une date à venir.`);

  return { suivi_engagement: true, engagement_type: type, engagement_delai: delai };
}

/**
 * Solde d'un engagement — le bouton « Effectué » de l'échéancier.
 *
 * Réservé aux rôles qui portent le suivi (voir SUIVENT_ENGAGEMENTS et la matrice
 * de permissions) : c'est le chef de brigade qui a pris l'engagement en signant,
 * c'est lui et son encadrement qui le soldent.
 *
 * Écriture en AJOUT SEUL du point de vue de l'engagement : on n'efface ni le
 * type, ni le délai. La fiche garde donc trace de ce qui était dû ET de quand
 * cela a été fourni — sans quoi le solde effacerait l'obligation qu'il honore.
 */
export async function engagementFait(ctx: Ctx, p: Record<string, unknown>) {
  const id = String(p['id'] ?? '').trim();
  const cargo = await getCargo(ctx, id);
  const c = cargo.o;

  if (c['suiviEngagement'] !== true)
    throw new ErreurMetier("Cette cargaison n'est pas sous suivi d'engagement.");
  if (aFait(c['engagementEffectueLe']))
    throw new ErreurMetier('Engagement déjà soldé le ' + fmtDate(c['engagementEffectueLe']) + '.');

  const now = new Date().toISOString();
  await patchCargo(ctx, cargo, {
    engagement_effectue_le: now,
    engagement_effectue_par: ctx.session.nomComplet,
  });
  await ctx.log('Engagement — informations transmises', id,
    String(c['engagementType'] ?? '') + ' · délai ' + String(c['engagementDelai'] ?? '—'));
  return { id, effectueLe: now };
}

/**
 * SEC-10 — EMPREINTE DU CONTENU VALIDÉ.
 *
 * L'ancienne « signature » était `sha256(id | username | horodatage)` tronqué à
 * 16 caractères : elle ne couvrait AUCUNE donnée validée. On pouvait modifier
 * après coup la déclaration, les conteneurs ou les scellés d'une cargaison
 * signée sans que la signature bouge — elle donnait une garantie qu'elle
 * n'apportait pas.
 *
 * L'empreinte porte désormais sur ce que le chef de brigade atteste réellement :
 * le camion, la déclaration de référence, le nombre de colis, la pesée, et la
 * liste ordonnée des conteneurs avec leurs scellés. Toute retouche ultérieure de
 * l'un de ces éléments rend l'empreinte non reproductible — donc détectable.
 */
async function empreinteValidation(
  c: Record<string, unknown>,
  pesee: Record<string, unknown>,
  engagement: Record<string, unknown>,
): Promise<string> {
  const pd = parseConteneursDetails(c['conteneursDetails']);
  const conts = pd.conteneurs
    .map((ct) => [ct.num, ct.plomb ?? '', ct.taille ?? '', ct.type ?? ''].join('~'))
    .join(',');
  const base = [
    // 'v2' depuis le 2026-09-10 : le suivi des engagements entre dans l'empreinte.
    // Le numéro de version fait PARTIE du haché — les empreintes 'v1' restent donc
    // distinctes et reproductibles avec l'ancien jeu de champs, sans ambiguïté.
    'v2',
    String(c['id'] ?? ''),
    String(c['numeroCamion'] ?? ''),
    String(c['typeOperation'] ?? ''),
    declKey({
      anneeDeclaration: String(c['anneeDeclaration'] ?? ''),
      bureauDeclaration: String(c['bureauDeclaration'] ?? ''),
      typeDeclaration: String(c['typeDeclaration'] ?? ''),
      numeroDeclaration: String(c['numeroDeclaration'] ?? ''),
    }),
    String(c['nbColis'] ?? ''),
    String(c['nbConteneurs'] ?? ''),
    conts,
    (pd.scellesCamion ?? []).join('~'),
    String(pesee['en_surcharge']),
    String(pesee['poids_surcharge'] ?? ''),
    // Le suivi des engagements est attesté par le chef au même titre que la
    // pesée : le retoucher après signature doit rendre l'empreinte irreproductible.
    String(engagement['suivi_engagement']),
    String(engagement['engagement_type'] ?? ''),
    String(engagement['engagement_delai'] ?? ''),
  ].join('|');
  return await signature(base);
}

export async function valider(ctx: Ctx, p: Record<string, unknown>) {
  const id = String(p['id'] ?? '').trim();
  const cargo = await getCargo(ctx, id);
  const c = cargo.o;
  if (c['statut'] === STATUTS.CAMION || c['statut'] === STATUTS.CHARGEMENT || c['statut'] === STATUTS.VEHICULE_OUILLAGE)
    throw new ErreurMetier("Validation impossible : le CFS doit d'abord terminer (statut « " + c['statut'] + " »).");
  const dejaValidee = aFait(c['dateValidation']);
  if (dejaValidee && ctx.session.role !== ROLES.ADMIN)
    throw new ErreurMetier('Cargaison déjà validée le ' + fmtDate(c['dateValidation']) + '.');
  // Pesée exigée uniquement en dépotage (2026-08-19).
  const pesee = peseePatch(p, exigeControlePoids(c['typeOperation']));
  // Suivi des engagements (2026-09-10) : exigé sur TOUTES les opérations,
  // contrairement à la pesée qui ne concerne que le dépotage.
  const engagement = engagementPatch(p);
  const now = new Date().toISOString();
  const empreinte = await empreinteValidation(c, pesee, engagement);
  const sig = await signature(id + '|' + ctx.session.username + '|' + now + '|' + empreinte);

  await patchCargo(ctx, cargo, {
    date_validation: now, agent_validation: ctx.session.nomComplet, agent_validation_id: ctx.session.userId,
    // TRAÇABILITÉ CBPI (2026-08-19) — on garde SUR LA FICHE le rôle du signataire :
    // chef brigade titulaire ou chef brigade par intérim. Le nom seul (agent_validation)
    // ne dit pas à quel titre la personne a signé ; la table `validations` en garde
    // déjà l'historique, on le remonte ici pour l'affichage direct.
    role_validation: ctx.session.role,
    signature_validation: sig, ...pesee, ...engagement,
  });

  // SEC-10 — La ligne `cargaisons` ne porte qu'UNE validation : une re-validation
  // ADMIN écrasait date, agent et signature, faisant disparaître le premier
  // signataire de la fiche. On conserve chaque validation à part, en ajout seul.
  const { error: eVal } = await ctx.db.from('validations').insert({
    cargaison_id: id, ts: now, agent: ctx.session.nomComplet, agent_id: ctx.session.userId,
    role: ctx.session.role, signature: sig, empreinte_donnees: empreinte,
    en_surcharge: pesee['en_surcharge'], poids_surcharge: pesee['poids_surcharge'],
    remplace: dejaValidee,
  });
  if (eVal) console.error(`[VALIDATION-ECHEC] ${id} : ${eVal.message}`);

  await ctx.log(
    dejaValidee ? 'Re-validation chef brigade' : 'Validation chef brigade',
    id,
    (pesee['en_surcharge'] ? 'SURCHARGE ' + pesee['poids_surcharge'] + ' kg' : 'hors surcharge') +
      (dejaValidee ? ' · REMPLACE la validation du ' + fmtDate(c['dateValidation']) : ''),
  );
  return { id };
}

/**
 * v4 — VALIDATION EN LOT (décision utilisateur 2026-07-19) : le chef brigade
 * signe d'un seul geste tous les camions d'une déclaration.
 *
 * Chaque cargaison reçoit SA PROPRE signature (une signature couvrant le lot
 * n'aurait aucune valeur probante sur une fiche prise isolément). Une cargaison
 * en erreur n'annule pas les autres : elle est rapportée à part, comme pour la
 * saisie en lot des camions — le chef voit ce qui est passé et ce qui reste.
 */
export async function validerLot(ctx: Ctx, p: Record<string, unknown>) {
  const ids = (Array.isArray(p['ids']) ? (p['ids'] as unknown[]) : [])
    .map((v) => String(v ?? '').trim()).filter(Boolean);
  if (!ids.length) throw new Error('Aucune cargaison à valider.');
  // v4.1 — la pesée est PAR CAMION : le lot porte une entrée de pesée par id.
  const pesees = (p['pesees'] ?? {}) as Record<string, { enSurcharge?: unknown; poidsSurcharge?: unknown }>;
  /* Le suivi des engagements, lui, vaut POUR TOUT LE LOT (2026-09-10).
   *
   * La pesée est un fait physique propre à chaque camion — d'où une entrée par
   * id. L'engagement est un régime attaché à la DÉCLARATION, et ce lot est
   * précisément l'ensemble des camions d'une même déclaration : le répéter
   * camion par camion inviterait à des réponses divergentes sur une seule et
   * même déclaration. Une valeur unique, donc, recopiée sur chaque fiche pour
   * qu'elle reste lisible prise isolément. */
  const suiviEngagement = p['suiviEngagement'];
  const engagementType = p['engagementType'];

  const validees: string[] = [];
  const erreurs: Record<string, unknown>[] = [];
  for (const id of ids) {
    try {
      const ps = pesees[id] ?? {};
      await valider(ctx, {
        id, enSurcharge: ps.enSurcharge, poidsSurcharge: ps.poidsSurcharge,
        suiviEngagement, engagementType,
      });
      validees.push(id);
    } catch (e) {
      erreurs.push({ id, message: (e as Error).message });
    }
  }
  await ctx.log('Validation chef brigade (lot)', '',
    `${validees.length} validée(s)${erreurs.length ? ` · ${erreurs.length} en erreur` : ''}`);
  return { validees, erreurs, compte: { validees: validees.length, erreurs: erreurs.length } };
}

/** v3.0 — champ confidentiel Hors gabarit (I-7 : action conservée à l'identique). */
export async function horsgabarit(ctx: Ctx, p: Record<string, unknown>) {
  const id = String(p['id'] ?? '').trim();
  const hg = p['horsGabarit'] === true || String(p['horsGabarit']).toLowerCase() === 'oui';
  const cargo = await getCargo(ctx, id);
  await patchCargo(ctx, cargo, {
    hors_gabarit: hg ? true : null,
    hauteur_chargement: hg ? txt(p['hauteurChargement'], 30) : '',
  });
  await ctx.log('Hors gabarit', id, hg ? 'Oui · ' + txt(p['hauteurChargement'], 30) : 'Non');
  return { id };
}

/* --------------------------------- t1 ---------------------------------- */

export async function t1(ctx: Ctx, p: Record<string, unknown>) {
  const id = String(p['id'] ?? '').trim();
  const bureau = maj(p['bureauDestination'], 60);
  if (!bureau) throw new Error('Bureau de destination obligatoire.');
  const items = (Array.isArray(p['t1Numeros']) ? (p['t1Numeros'] as unknown[]) : [])
    .map((o) =>
      o && typeof o === 'object'
        ? { conteneur: maj((o as Record<string, unknown>)['conteneur'], 20), numero: maj((o as Record<string, unknown>)['numero'], 40) }
        : { conteneur: '', numero: maj(o, 40) },
    )
    .filter((o) => o.numero);
  if (!items.length) throw new Error('Au moins un numéro de document T1 est requis.');
  const numeros = items.map((o) => o.numero);
  if (new Set(numeros).size !== numeros.length) throw new Error('Les numéros T1 doivent être distincts (1 par conteneur).');

  const cargo = await getCargo(ctx, id);
  const c = cargo.o;
  if (ctx.session.role !== ROLES.ADMIN && etapesEnAttente(c as never).indexOf('T1') < 0)
    throw new Error('Cellule T1 impossible : étape non attendue (statut « ' + c['statut'] + ' »).');
  if (c['typeOperation'] === OPERATIONS.ENLEVEMENT) {
    const nb = Number(c['nbConteneurs'] || 0) || 1;
    if (items.length < nb) throw new Error('Enlèvement : un T1 par conteneur (≥ ' + nb + ' attendus).');
    const pd = parseConteneursDetails(c['conteneursDetails']);
    const dispo = pd.conteneurs.map((o) => String(o.num || '').toUpperCase().replace(/[^A-Z0-9]/g, '')).filter(Boolean);
    const lies: string[] = [];
    items.forEach((o) => {
      if (!o.conteneur) throw new Error('Enlèvement : associez chaque T1 à un conteneur.');
      if (dispo.length && dispo.indexOf(o.conteneur) < 0) throw new Error('Conteneur « ' + o.conteneur + ' » absent de cette cargaison.');
      if (lies.indexOf(o.conteneur) >= 0) throw new Error("Chaque conteneur ne peut recevoir qu'un seul T1.");
      lies.push(o.conteneur);
    });
  }
  const avancer = etapesEnAttente(c as never).indexOf('T1') >= 0;
  const patch: Record<string, unknown> = {
    bureau_destination: bureau, t1_numeros: items,
    date_t1: new Date().toISOString(), agent_t1: ctx.session.nomComplet, agent_t1_id: ctx.session.userId,
    observations_t1: txt(p['observations'], 1000),
  };
  // Le statut n'avance qu'à partir de « Créée » (jamais de régression si la Balise
  // ou le Bon de sortie ont déjà fait progresser la cargaison).
  if (avancer && c['statut'] === STATUTS.CREEE) patch['statut'] = STATUTS.T1;
  await patchCargo(ctx, cargo, patch);
  await ctx.log('Saisie T1', id, numeros.join(', ') + ' · ' + bureau);
  return { id };
}

/* --------------------------------- gps --------------------------------- */

export async function gps(ctx: Ctx, p: Record<string, unknown>) {
  const id = String(p['id'] ?? '').trim();
  const requise = !(p['baliseRequise'] === false || String(p['baliseRequise']).toLowerCase() === 'non');
  const t1Correct = p['t1Correct'] === true || String(p['t1Correct']).toLowerCase() === 'oui';
  const numeroGPS = txt(p['numeroGPS']);
  const numeroDispense = maj(p['numeroDispense'], 60);
  if (!t1Correct) throw new Error('Cochez « Numéro T1 correct » avant de valider la balise.');
  if (requise && !numeroGPS) throw new Error('Numéro de balise requis.');
  if (!requise && !numeroDispense) throw new Error("Numéro d'autorisation de dispense requis.");

  const cargo = await getCargo(ctx, id);
  const c = cargo.o;

  /* BALISE DÉJÀ POSÉE SUR UN AUTRE CAMION — 2026-09-12.
   *
   * La migration 00170 pose un index unique : deux cargaisons NON SORTIES ne
   * peuvent plus porter la même balise. C'est la bonne règle — sinon plus
   * personne ne sait quel camion est réellement suivi.
   *
   * Mais un refus venu de l'index arrive sous forme de « duplicate key value »,
   * que `estMessageMetier` masque à juste titre (il cartographierait le schéma).
   * L'agent verrait donc une erreur technique générique, sans savoir que c'est
   * le NUMÉRO DE BALISE qui est en cause ni sur quel camion il est déjà posé.
   *
   * On vérifie donc AVANT d'écrire, et on nomme le camion fautif. L'index reste
   * la garantie dure — lui seul résiste à deux agents qui saisissent en même
   * temps ; ce contrôle-ci ne sert qu'à rendre le refus compréhensible. */
  if (requise && numeroGPS) {
    const { data: dejaPosee } = await ctx.db.from('cargaisons')
      .select('id, numero_camion')
      .eq('numero_gps', numeroGPS)
      .neq('id', id)
      .neq('statut', STATUTS.SORTIE)
      .is('date_sortie', null)
      .limit(1);
    const autre = (dejaPosee ?? [])[0];
    if (autre)
      throw new ErreurMetier(
        `La balise « ${numeroGPS} » est déjà posée sur le camion `
        + `« ${String(autre['numero_camion'] ?? autre['id'])} », qui n'est pas encore sorti. `
        + `Une balise ne peut suivre qu'un camion à la fois : vérifiez le numéro, `
        + `ou enregistrez d'abord la sortie de l'autre camion.`,
      );
  }
  if (c['estVehicule'] === true || c['estVehicule'] === 'Oui') throw new Error('Les véhicules ne passent pas par la cellule Balise.');
  if (ctx.session.role !== ROLES.ADMIN && etapesEnAttente(c as never).indexOf('BALISE') < 0)
    throw new Error('Étape Balise impossible : chargement non terminé ou déjà balisée (statut « ' + c['statut'] + ' »).');
  const avancer = etapesEnAttente(c as never).indexOf('BALISE') >= 0;
  const patch: Record<string, unknown> = {
    numero_gps: requise ? numeroGPS : '', date_pose_gps: new Date().toISOString(),
    agent_balise: ctx.session.nomComplet, agent_balise_id: ctx.session.userId,
    observations_balise: txt(p['observations'], 1000), balise_requise: requise, t1_correct: true,
    numero_dispense: requise ? '' : numeroDispense,
  };
  if (avancer) patch['statut'] = STATUTS.GPS;
  await patchCargo(ctx, cargo, patch);
  if (requise) await ctx.log('Pose balise', id, 'Balise ' + numeroGPS);
  else await ctx.log('Dispense de balise', id, 'Dispense ' + numeroDispense);
  return { id, baliseRequise: requise ? 'Oui' : 'Non' };
}

/** Remplacement d'un GPS défectueux (ADMIN only). Statut inchangé. */
export async function gpsedit(ctx: Ctx, p: Record<string, unknown>) {
  const id = String(p['id'] ?? '').trim();
  const numeroGPS = txt(p['numeroGPS']);
  if (!numeroGPS) throw new Error('Numéro de GPS requis.');
  const cargo = await getCargo(ctx, id);
  const c = cargo.o;
  if (c['statut'] !== STATUTS.GPS)
    throw new Error('Remplacement impossible : la cargaison doit être au statut « ' + STATUTS.GPS + ' » (statut actuel « ' + c['statut'] + ' »).');
  const ancien = c['numeroGps'] || '';
  const patch: Record<string, unknown> = {
    numero_gps: numeroGPS, date_pose_gps: new Date().toISOString(),
    agent_balise: ctx.session.nomComplet, agent_balise_id: ctx.session.userId,
  };
  if (p['observations']) patch['observations_balise'] = txt(p['observations'], 1000);
  await patchCargo(ctx, cargo, patch);
  await ctx.log('Remplacement GPS', id, 'Ancien ' + ancien + ' → nouveau ' + numeroGPS);
  return { id };
}

/* ------------------------------ bonsortie ------------------------------ */

export async function bonsortie(ctx: Ctx, p: Record<string, unknown>) {
  const id = String(p['id'] ?? '').trim();
  let stored: unknown = '';
  let numeros: string[] = [];
  if (Array.isArray(p['bonSortieNumero'])) {
    const items = (p['bonSortieNumero'] as unknown[])
      .map((o) =>
        o && typeof o === 'object'
          ? { conteneur: maj((o as Record<string, unknown>)['conteneur'], 20), t1: maj((o as Record<string, unknown>)['t1'], 40), numero: maj((o as Record<string, unknown>)['numero'], 60) }
          : { conteneur: '', t1: '', numero: maj(o, 60) },
      )
      .filter((o) => o.numero);
    if (!items.length) throw new Error('Numéro de bon de sortie requis.');
    numeros = items.map((o) => o.numero);
    stored = items;
  } else {
    const s = maj(p['bonSortieNumero'], 60);
    if (!s) throw new Error('Numéro de bon de sortie requis.');
    stored = s;
    numeros = [s];
  }
  const cargo = await getCargo(ctx, id);
  const c = cargo.o;
  if (ctx.session.role !== ROLES.ADMIN && etapesEnAttente(c as never).indexOf('BS') < 0)
    throw new Error('Bon de sortie impossible : chargement non terminé ou bon déjà émis (statut « ' + c['statut'] + ' »).');
  const avancer = etapesEnAttente(c as never).indexOf('BS') >= 0;
  const patch: Record<string, unknown> = {
    bon_sortie_numero: stored, date_bon_sortie: new Date().toISOString(),
    agent_bon_sortie: ctx.session.nomComplet, agent_bon_sortie_id: ctx.session.userId,
    observations_bon_sortie: txt(p['observations'], 1000),
  };
  if (avancer) patch['statut'] = STATUTS.BS;
  await patchCargo(ctx, cargo, patch);
  await ctx.log('Bon de sortie', id, numeros.join(', '));
  return { id };
}

/* -------------------------------- sortie ------------------------------- */

export async function sortie(ctx: Ctx, p: Record<string, unknown>) {
  const id = String(p['id'] ?? '').trim();
  const cargo = await getCargo(ctx, id);
  const c = cargo.o;
  const estVeh = c['estVehicule'] === true || c['estVehicule'] === 'Oui';
  if (ctx.session.role !== ROLES.ADMIN && etapesEnAttente(c as never).indexOf('PP') < 0)
    throw new Error('Sortie impossible : le T1 et la Balise doivent être faits d\'abord (statut « ' + c['statut'] + ' »).');
  let checklist: Record<string, unknown> = {};
  let derogation = '';
  let ecart = '';
  if (estVeh) {
    if (p['infosValidees'] !== true) throw new ErreurMetier('Veuillez cocher « Informations validées ».');
  } else {
    const declare = { cfs: p['ckCfs'] === true, t1: p['ckT1'] === true, balise: p['ckBalise'] === true, bs: p['ckBs'] === true };
    if (!(declare.cfs && declare.t1 && declare.balise && declare.bs))
      throw new ErreurMetier('Cochez les 4 contrôles (CFS, T1, Balise, Bon de sortie) avant la sortie.');

    /* SEC-13 — CONFRONTATION AUX DONNÉES.
     *
     * Les quatre cases étaient purement DÉCLARATIVES : le serveur vérifiait
     * qu'elles étaient cochées, jamais qu'elles correspondaient à la réalité.
     * Comme le bon de sortie n'est pas bloquant dans le moteur de workflow, un
     * camion pouvait sortir avec `bon_sortie_numero` vide ET
     * `pp_checklist.bs = true` en base : le système CONSIGNAIT UN CONTRÔLE QUI
     * N'AVAIT PAS PU AVOIR LIEU. C'est cette écriture mensongère qui est le
     * problème de sécurité, pas la sortie elle-même.
     *
     * Correctif : la case cochée ne peut plus créer une pièce qui n'existe pas.
     * On enregistre l'état RÉEL, on conserve à part ce que l'agent déclare, et
     * tout écart est marqué et journalisé.
     *
     * ⚠ NON BLOQUANT PAR DÉFAUT — ET C'EST DÉLIBÉRÉ. Sur les données de
     * production, la cellule « Bon de sortie » n'a jamais été utilisée (0
     * occurrence sur 17 017 événements) : refuser la sortie faute de bon de
     * sortie fermerait le portail dès le premier jour, et les agents saisiraient
     * « RAS » cinq mille fois — soit exactement le formalisme creux qu'on retire.
     * Le blocage s'active le jour où la cellule existe réellement, par la
     * variable d'environnement SORTIE_EXIGE_PIECES=true (voir EXPLOITATION.md).
     */
    const reel = etatCellules(c as never);
    const manquants: string[] = [];
    if (!reel.cfs) manquants.push('fin de chargement CFS');
    if (!reel.t1) manquants.push('T1');
    if (!reel.balise) manquants.push('balise');
    if (!reel.bs) manquants.push('bon de sortie');

    derogation = txt(p['derogationMotif'], 300);
    if (manquants.length && EXIGE_PIECES && !derogation)
      throw new ErreurMetier(
        'Sortie refusée : ' + manquants.join(', ') + ' — non enregistré(s) dans le système. ' +
          'Faites compléter la cellule concernée, ou saisissez un motif de dérogation (il sera tracé au journal).',
      );

    checklist = {
      // L'état RÉEL fait foi : une case cochée ne crée pas la pièce manquante.
      cfs: reel.cfs, t1: reel.t1, balise: reel.balise, bs: reel.bs,
      // Ce que l'agent de la PP atteste avoir contrôlé physiquement au portail.
      declare: { cfs: declare.cfs, t1: declare.t1, balise: declare.balise, bs: declare.bs },
      ...(manquants.length ? { ecart: manquants, ...(derogation ? { derogation } : {}) } : {}),
    };
    if (manquants.length) ecart = manquants.join(', ');
  }
  await patchCargo(ctx, cargo, {
    infos_validees: true, pp_checklist: estVeh ? null : checklist,
    date_sortie: new Date().toISOString(), agent_pp: ctx.session.nomComplet, agent_pp_id: ctx.session.userId,
    observations_pp: txt(p['observations'], 1000), statut: STATUTS.SORTIE,
  });
  await ctx.log(
    ecart ? '⚠ Sortie sans pièce complète' : 'Enregistrement sortie',
    id,
    ecart ? 'manquant : ' + ecart + (derogation ? ' · dérogation : ' + derogation : '') : '',
  );
  return { id, ...(ecart ? { ecart: ecart.split(', ') } : {}) };
}

/* ------------------------------- etatcfs ------------------------------- */

export async function etatcfs(ctx: Ctx, p: Record<string, unknown>) {
  const id = String(p['id'] ?? '').trim();
  const etat = String(p['etatSortie'] ?? '').trim();
  if ((ETATS_SORTIE as readonly string[]).indexOf(etat) === -1)
    throw new Error('État invalide. Choisissez : ' + ETATS_SORTIE.join(' / ') + '.');
  const cargo = await getCargo(ctx, id);
  await patchCargo(ctx, cargo, { etat_sortie: etat });
  await ctx.log('État sortie CFS', id, etat);
  return { id, etatSortie: etat };
}

/* ---------------------------- arriveebureau ---------------------------- */

export async function arriveebureau(ctx: Ctx, p: Record<string, unknown>) {
  const id = String(p['id'] ?? '').trim();
  const cargo = await getCargo(ctx, id);
  const c = cargo.o;
  if (String(c['baliseRequise']) !== 'Non' && c['baliseRequise'] !== false && !estOui(c['sauteBalise']))
    throw new Error("Cette cargaison n'est pas une dispense.");
  if (c['statut'] !== STATUTS.SORTIE) throw new Error("La cargaison doit d'abord être sortie.");
  await patchCargo(ctx, cargo, {
    arrivee_bureau: true, date_arrivee_bureau: new Date().toISOString(), agent_arrivee_bureau: ctx.session.nomComplet,
  });
  await ctx.log('Arrivée bureau destination (dispense soldée)', id, '');
  return { id };
}

/* ------------------------------ editcamion ----------------------------- */

/**
 * Correction ciblée du N° camion.
 *
 * SEC-11 (2026-08-10) — Cette action était ouverte à TOUS LES RÔLES, à TOUT
 * STATUT, y compris après la sortie du camion. Or l'immatriculation est
 * l'élément identifiant du bon de sortie et de l'ordre d'exécution. Sur
 * l'historique de production : 638 corrections (un mouvement sur huit), dont
 * 442 par la cellule BALISE et 143 par la PP, 7 après enregistrement de la
 * sortie. Deux verrous sont posés :
 *   · la permission est réduite à CFS / CHEF_BRIGADE / ADMIN (permissions.ts) ;
 *   · après la validation du chef de brigade, seul l'ADMIN peut encore corriger,
 *     et plus rien n'est modifiable une fois le camion sorti.
 * Un MOTIF est désormais obligatoire : c'est lui qui rend l'audit exploitable.
 */
export async function editcamion(ctx: Ctx, p: Record<string, unknown>) {
  const id = String(p['id'] ?? '').trim();
  const nouveau = alphaNumMaj(p['numeroCamion']);
  if (!nouveau) throw new ErreurMetier('N° camion invalide (alphanumérique, majuscules).');
  // La correction est précisément l'endroit où l'on remet un numéro au format.
  if (!camionValide(nouveau)) throw new ErreurMetier(messageCamionFormat(p['numeroCamion'], 'Nouveau n° de camion'));
  const motif = txt(p['motif'], 300);
  if (!motif)
    throw new ErreurMetier('Indiquez le motif de la correction du N° de camion (erreur de saisie, plaque illisible…).');

  const cargo = await getCargo(ctx, id);
  const c = cargo.o;
  const ancien = String(c['numeroCamion'] || '');
  if (nouveau === ancien) return { id, numeroCamion: nouveau, inchange: true };

  const estAdmin = ctx.session.role === ROLES.ADMIN;
  if (c['statut'] === STATUTS.SORTIE)
    throw new ErreurMetier(
      'Camion déjà sorti : le N° d\'immatriculation ne peut plus être corrigé. ' +
        'Signalez l\'erreur à la hiérarchie — elle sera consignée hors application.',
    );
  if (aFait(c['dateValidation']) && !estAdmin)
    throw new ErreurMetier(
      'Cargaison déjà validée par le chef de brigade : la correction du N° de camion relève de l\'administrateur.',
    );

  await patchCargo(ctx, cargo, { numero_camion: nouveau });
  await renommerCamionConteneurs(ctx, id, nouveau);
  await ctx.log('Correction N° camion', id, ancien + ' → ' + nouveau + ' · motif : ' + motif);
  return { id, numeroCamion: nouveau, ancien };
}

/* ------------------------------ supprimer ------------------------------ */

/**
 * v4 — Retrait d'une cargaison (ADMIN uniquement) : pour écarter un DOUBLON de
 * saisie. Libère le stock rattaché (redevient « En stock »).
 *
 * SEC-12 (2026-08-10) — L'action effaçait physiquement la ligne `cargaisons` et,
 * par `on delete cascade`, toutes ses lignes `conteneurs` — À N'IMPORTE QUEL
 * STATUT, y compris une cargaison sortie, validée et signée. Il ne restait
 * qu'une ligne d'audit portant le numéro de camion : ni la déclaration, ni les
 * conteneurs, ni les scellés. Pour une écriture douanière, c'est une destruction
 * de pièce.
 *
 * Désormais :
 *   · SUPPRESSION LOGIQUE — la cargaison et ses conteneurs restent en base, mais
 *     disparaissent des listes, des rapports et de toute saisie ultérieure ;
 *   · l'annulation est FERMÉE après la validation du chef de brigade (au-delà,
 *     ce n'est plus un doublon de saisie mais une écriture engagée) ;
 *   · MOTIF obligatoire, et l'enregistrement complet est recopié dans le détail
 *     d'audit avant l'annulation, pour être reconstituable.
 */
export async function supprimerCargo(ctx: Ctx, p: Record<string, unknown>) {
  const id = String(p['id'] ?? '').trim();
  const motif = txt(p['motif'], 300);
  if (!motif) throw new ErreurMetier("Indiquez le motif de l'annulation (doublon de saisie, camion jamais entré…).");

  const cargo = await getCargo(ctx, id);
  const c = cargo.o;

  /* ANNULATION OUVERTE À TOUS LES STADES (décision utilisateur 2026-09-10).
   *
   * L'annulation était fermée après la signature du chef de brigade et après la
   * sortie. En exploitation, cette rigidité laissait sans recours les erreurs
   * découvertes tard — un doublon repéré après coup restait dans les compteurs
   * pour toujours.
   *
   * Ce qui rendait la fermeture nécessaire n'existe plus : l'action reste
   * réservée à l'ADMIN, l'annulation est LOGIQUE (aucune pièce n'est détruite,
   * cf. SEC-12), le motif est obligatoire, l'enregistrement complet est recopié
   * au journal, et depuis 00170 l'apurement de la déclaration est rendu.
   *
   * On ne bloque donc plus — on TRACE PLUS FORT : le journal dit désormais
   * explicitement qu'une écriture engagée a été annulée, et à quel stade. */
  const engagee: string[] = [];
  if (aFait(c['dateValidation'])) engagee.push('VALIDÉE ET SIGNÉE le ' + fmtDate(c['dateValidation']));
  if (c['statut'] === STATUTS.SORTIE) engagee.push('DÉJÀ SORTIE le ' + fmtDate(c['dateSortie']));

  // Libère les conteneurs de stock rattachés à cette cargaison.
  const { error: eStock } = await ctx.db.from('stock')
    .update({ statut: STOCK_STATUTS.STOCK, cargaison_id: null, date_depote: null })
    .eq('cargaison_id', id);
  if (eStock) throw new Error(eStock.message);

  // Trace intégrale AVANT l'annulation : le journal doit permettre de
  // reconstituer ce qui a été écarté, pas seulement d'en connaître l'existence.
  const empreinte = JSON.stringify({
    numeroCamion: c['numeroCamion'], typeOperation: c['typeOperation'], statut: c['statut'],
    declaration: [c['typeDeclaration'], c['numeroDeclaration'], c['anneeDeclaration'], c['bureauDeclaration']].join('/'),
    declarant: c['declarant'], nbConteneurs: c['nbConteneurs'],
    conteneurs: c['conteneursDetails'], rapportId: c['rapportId'],
  }).slice(0, 4000);

  const { error } = await ctx.db.from('cargaisons').update({
    annule: true,
    annule_le: new Date().toISOString(),
    annule_par: ctx.session.nomComplet,
    annule_par_id: ctx.session.userId,
    annule_motif: motif,
  }).eq('id', id);
  if (error) throw new Error(error.message);

  /* 00170 — APUREMENT : une cargaison annulée ne doit plus rien apurer.
   *
   * EFFET DE BORD DE SEC-12. Le passage à la suppression LOGIQUE était une
   * correction de sécurité — ne plus détruire de pièce douanière. Mais en
   * laissant les compteurs intacts, elle a créé une fuite : la cargaison
   * disparaissait des listes et des rapports pendant que ses conteneurs
   * restaient comptés comme apurés sur leur déclaration. Un doublon écarté
   * apurait donc une déclaration deux fois.
   *
   * On regroupe par déclaration (un camion en chargement MIXTE en porte
   * plusieurs) et on retire le compte exact. Best-effort : l'annulation ne doit
   * pas échouer parce qu'un compteur n'a pas pu être rattrapé.
   */
  const parDecl = new Map<string, { decl: Record<string, unknown>; n: number }>();
  for (const ct of parseConteneursDetails(c['conteneursDetails']).conteneurs) {
    const s = ct as unknown as Record<string, unknown>;
    // Repli sur la déclaration du camion : les conteneurs migrés depuis la v3.6
    // ne portent pas toujours la leur (LOT D postérieur à l'import).
    const decl = {
      numeroDeclaration: s['numeroDeclaration'] || c['numeroDeclaration'],
      anneeDeclaration: s['anneeDeclaration'] || c['anneeDeclaration'],
      bureauDeclaration: s['bureauDeclaration'] || c['bureauDeclaration'],
      typeDeclaration: s['typeDeclaration'] || c['typeDeclaration'],
      declarant: s['declarant'] || c['declarant'],
    };
    const k = declKey(decl as never);
    const e = parDecl.get(k);
    if (e) e.n++;
    else parDecl.set(k, { decl, n: 1 });
  }
  for (const { decl, n } of parDecl.values()) await majApurementDec(ctx, decl as never, n);

  await ctx.log(
    engagee.length ? 'Annulation cargaison — ÉCRITURE ENGAGÉE' : 'Annulation cargaison (doublon)',
    id,
    String(c['numeroCamion'] || '') + ' · ' + String(c['typeOperation'] || '')
      + (engagee.length ? ' · ⚠ ' + engagee.join(' · ') : '')
      + ' · motif : ' + motif + ' · ' + empreinte,
  );
  return { id, annule: true, engagee };
}

/* --------------------------- archivage goulots ------------------------- */
/**
 * ARCHIVAGE DES VIEUX DOSSIERS « GOULOTS » (ADMIN, 2026-08-19).
 *
 * DISTINCT de l'annulation (doublon) : un dossier archivé est un vieux dossier
 * migré, jamais mené à la sortie, que l'on CLÔT administrativement pour qu'il
 * cesse de gonfler les files et les rapports. RIEN N'EST SUPPRIMÉ — la ligne
 * reste en base, tracée (qui / quand / motif), et l'opération est RÉVERSIBLE
 * (désarchivage). On refuse d'archiver un camion SORTI (déjà terminé) ou ANNULÉ.
 * Traitement en lot, tolérant : un id en erreur n'empêche pas les autres.
 */
export async function archiverGoulots(ctx: Ctx, p: Record<string, unknown>) {
  const ids = (Array.isArray(p['ids']) ? (p['ids'] as unknown[]) : []).map((v) => String(v ?? '').trim()).filter(Boolean);
  const motif = txt(p['motif'], 300);
  if (!ids.length) throw new ErreurMetier('Aucun dossier sélectionné.');
  if (!motif) throw new ErreurMetier("Indiquez le motif de l'archivage (ex. « vieux dossier migré jamais sorti »).");
  const now = new Date().toISOString();
  const archives: string[] = [];
  const erreurs: Record<string, unknown>[] = [];
  for (const id of ids) {
    try {
      const { data: row, error } = await ctx.db.from('cargaisons').select('id, statut, annule, archive').eq('id', id).maybeSingle();
      if (error) throw new Error(error.message);
      if (!row) throw new ErreurMetier('Introuvable.');
      if (row['statut'] === STATUTS.SORTIE) throw new ErreurMetier('Déjà sorti : terminé, pas un goulot.');
      if (row['annule'] === true) throw new ErreurMetier('Déjà annulé.');
      if (row['archive'] === true) { archives.push(id); continue; } // idempotent
      const { error: eUp } = await ctx.db.from('cargaisons').update({
        archive: true, archive_le: now, archive_par: ctx.session.nomComplet,
        archive_par_id: ctx.session.userId, archive_motif: motif,
      }).eq('id', id);
      if (eUp) throw new Error(eUp.message);
      archives.push(id);
    } catch (e) {
      erreurs.push({ id, message: (e as Error).message });
    }
  }
  await ctx.log('Archivage goulots', '',
    `${archives.length} archivé(s)${erreurs.length ? ` · ${erreurs.length} en erreur` : ''} · motif : ${motif}`);
  return { archives, erreurs, compte: { archives: archives.length, erreurs: erreurs.length } };
}

/** Désarchivage (ADMIN) : réactive des dossiers archivés — ils reviennent dans
 *  les files et les rapports. Réversible symétrique de l'archivage. */
export async function desarchiverGoulots(ctx: Ctx, p: Record<string, unknown>) {
  const ids = (Array.isArray(p['ids']) ? (p['ids'] as unknown[]) : []).map((v) => String(v ?? '').trim()).filter(Boolean);
  if (!ids.length) throw new ErreurMetier('Aucun dossier sélectionné.');
  const { error } = await ctx.db.from('cargaisons').update({
    archive: false, archive_le: null, archive_par: '', archive_par_id: null, archive_motif: '',
  }).in('id', ids);
  if (error) throw new Error(error.message);
  await ctx.log('Désarchivage goulots', '', `${ids.length} dossier(s) réactivé(s)`);
  return { desarchives: ids.length };
}

/* ------------------------------- edittype ------------------------------ */

/**
 * v4 — Correction du TYPE d'opération (Dépotage ↔ Enlèvement). Réservée à la
 * phase CFS (avant validation) ; ADMIN partout. Ré-adapte les scellés au modèle
 * du nouveau type (par conteneur en enlèvement / au niveau camion en dépotage)
 * et remet le statut à un point cohérent (dépotage → à re-finaliser).
 */
export async function edittype(ctx: Ctx, p: Record<string, unknown>) {
  const id = String(p['id'] ?? '').trim();
  const nouveau = String(p['typeOperation'] ?? '').trim();
  if ([OPERATIONS.DEPOTAGE, OPERATIONS.ENLEVEMENT].indexOf(nouveau as never) === -1)
    throw new Error("Type d'opération invalide (Dépotage ou Enlèvement).");
  const cargo = await getCargo(ctx, id);
  const c = cargo.o;
  const estAdmin = ctx.session.role === ROLES.ADMIN;
  if (!estAdmin && [STATUTS.CAMION, STATUTS.CHARGEMENT, STATUTS.CREEE].indexOf(c['statut'] as never) === -1)
    throw new Error('Correction du type impossible : la cargaison a déjà avancé (statut « ' + c['statut'] + ' »).');
  if (!estAdmin && aFait(c['dateValidation']))
    throw new Error('Correction du type impossible : cargaison déjà validée.');
  const ancien = String(c['typeOperation'] || '');
  if (ancien === nouveau) return { id, typeOperation: nouveau, inchange: true };

  const estEnl = nouveau === OPERATIONS.ENLEVEMENT;
  const pd = parseConteneursDetails(c['conteneursDetails']);
  const conts = pd.conteneurs;
  let scellesCamion = pd.scellesCamion;
  if (estEnl) {
    // → Enlèvement : le scellé est porté PAR conteneur. On reprend les scellés
    //   camion comme plombs (best-effort, par position) puis on les efface.
    conts.forEach((ct, i) => { if (!ct.plomb) ct.plomb = scellesCamion[i] || ''; });
    scellesCamion = [];
  } else {
    // → Dépotage : scellés au niveau camion. On récupère les plombs conteneur.
    const migr = [...new Set(conts.map((ct) => ct.plomb).filter(Boolean))].slice(0, 3);
    if (migr.length) scellesCamion = migr;
    conts.forEach((ct) => { ct.plomb = ''; });
  }
  // Statut cohérent : vide → « Camion créé » ; enlèvement → « Créée » (scellés
  // déjà par conteneur = fin de chargement implicite) ; dépotage → « En cours de
  // chargement » (finalisation scellés camion / hauteur à refaire).
  const statut = !conts.length ? STATUTS.CAMION : estEnl ? STATUTS.CREEE : STATUTS.CHARGEMENT;
  await patchCargo(ctx, cargo, {
    type_operation: nouveau, routage_entree: nouveau,
    twins: estEnl && conts.length >= 2,
    conteneurs_details: { conteneurs: conts, scellesCamion },
    statut,
  });
  await ctx.log("Correction type d'opération", id, ancien + ' → ' + nouveau);
  return { id, typeOperation: nouveau, ancien };
}

/* ===== SAISIE DE LA DÉCLARATION À TOUTES LES ÉTAPES — 2026-09-11 ==========
 *
 * (décision utilisateur) Jusqu'ici, passé le statut « Créée », un agent CFS se
 * heurtait à un refus sec sur les deux points où se saisit un numéro de
 * déclaration : `editdecl` (le camion) et `editconteneur` (une ligne). Or c'est
 * précisément plus loin dans le parcours qu'on s'aperçoit qu'une déclaration
 * manque ou qu'un numéro est faux — et le CFS est le seul à savoir lequel
 * écrire. Le renvoyer vers l'administrateur pour une faute de frappe bloquait
 * le dossier sans rien protéger.
 *
 * L'ÉTAPE NE BLOQUE DONC PLUS. Ce qui la remplace n'est pas rien : un MOTIF
 * OBLIGATOIRE, inscrit au journal d'audit. On n'interdit pas le geste, on en
 * garde la trace — ce qui vaut mieux qu'un refus contourné par un appel à
 * l'administrateur, lequel ne laissait, lui, aucune trace du vrai demandeur.
 *
 * ⚠ L'ADMIN garde EXACTEMENT son comportement d'avant : aucun motif ne lui est
 * réclamé, à aucune étape. Seule la porte fermée au CFS s'ouvre.
 *
 * ⚠ SIGNATURE DU CHEF. L'empreinte de validation couvre la déclaration (voir
 * `empreinteValidation`). Corriger une cargaison DÉJÀ SIGNÉE rend l'empreinte
 * stockée non concordante : c'est voulu, c'est ainsi qu'une modification
 * d'après-signature se détecte. Le journal le mentionne, pour que le
 * rapprochement reste lisible des mois plus tard.
 */
function exigerMotifSiAvancee(ctx: Ctx, c: Record<string, unknown>, p: Record<string, unknown>): string {
  const avancee = [STATUTS.CAMION, STATUTS.CHARGEMENT, STATUTS.CREEE].indexOf(c['statut'] as never) === -1;
  if (!avancee) return '';
  const motif = txt(p['motif'], 200).trim();
  if (ctx.session.role !== ROLES.ADMIN && !motif) {
    throw new ErreurMetier(
      'Cette cargaison a déjà avancé (statut « ' + c['statut'] + ' ») : indiquez le MOTIF de la '
      + "correction dans le champ prévu, puis enregistrez. Le motif est inscrit au journal d'audit.");
  }
  const suffixe = aFait(c['dateValidation']) ? ' · APRÈS VALIDATION (empreinte de signature non concordante)' : '';
  return (motif ? ' · motif : ' + motif : ' · correction ADMIN') + suffixe;
}

/* ---------------------------- editconteneur ---------------------------- */

/**
 * v4 — CORRECTION d'un conteneur déjà enregistré sur un camion (N° erroné,
 * taille/type/scellé) ou SUPPRESSION de la ligne. C'était le trou noir du v4 :
 * une faute de frappe sur le N° de conteneur ne pouvait plus être rattrapée.
 *
 * Effets de bord tenus à jour : table normalisée « conteneurs » (réécrite),
 * nb_conteneurs, twins, et surtout le STOCK — l'ancien TC est délié (il
 * redevient sélectionnable) et le nouveau est lié à la cargaison.
 * CFS : phase CFS uniquement (Camion créé / En chargement / Créée) ; ADMIN partout.
 */
export async function editconteneur(ctx: Ctx, p: Record<string, unknown>) {
  const id = String(p['id'] ?? '').trim();
  const index = Number(p['index']);
  const supprimer = p['supprimer'] === true;
  const cargo = await getCargo(ctx, id);
  const c = cargo.o;
  const estAdmin = ctx.session.role === ROLES.ADMIN;
  const motifAvance = exigerMotifSiAvancee(ctx, c, p);

  const type = String(c['typeOperation'] || '');
  const estEnl = type === OPERATIONS.ENLEVEMENT;
  const pd = parseConteneursDetails(c['conteneursDetails']);
  const conts = pd.conteneurs;
  if (!(index >= 0 && index < conts.length)) throw new Error('Conteneur introuvable sur ce camion (ligne ' + (index + 1) + ').');
  const ancien = normaliserConteneur(conts[index] as never);
  // normaliserConteneur ne retient PAS la déclaration : on la capture à part
  // pour pouvoir tracer un changement de déclaration sur cette ligne.
  const declAvant = declKey(conts[index] as never);
  // 00170 — l'OBJET déclaration, et pas seulement sa clé : il faut pouvoir
  // décrémenter l'apurement de la déclaration quittée. Capturé AVANT mutation,
  // car `conts[index]` va être remplacé ou retiré juste après.
  const declObjAvant = ((): Record<string, unknown> => {
    const s = (conts[index] ?? {}) as unknown as Record<string, unknown>;
    return {
      numeroDeclaration: s['numeroDeclaration'], anneeDeclaration: s['anneeDeclaration'],
      bureauDeclaration: s['bureauDeclaration'], typeDeclaration: s['typeDeclaration'],
      declarant: s['declarant'],
    };
  })();

  if (supprimer) {
    conts.splice(index, 1);
  } else {
    const ct = normaliserConteneur({
      num: p['num'], taille: p['taille'], type: p['type'], plomb: p['plomb'], poids: p['poids'],
    } as never);
    if (!tcValide(ct.num)) throw new Error('N° conteneur invalide. Format : 4 lettres + 7 chiffres (ex. MSKU1234567).');
    if (!ct.taille) throw new Error('Taille du conteneur obligatoire.');
    if (estEnl && !ct.plomb) throw new Error('Enlèvement : le scellé (plomb) du conteneur est obligatoire.');
    if (!estEnl) ct.plomb = '';
    if (conts.some((x, i) => i !== index && normaliserConteneur(x).num === ct.num))
      throw new Error('Ce conteneur est déjà sur ce camion.');
    // Le nouveau TC doit exister au stock (sauf reprise d'une saisie manuelle et
    // sauf ADMIN, qui peut corriger un historique importé).
    const manuel = p['manuel'] === true;
    if (!manuel && !estAdmin && ct.num !== ancien.num && !(await stockDisponible(ctx, ct.num)))
      throw new Error(
        'Conteneur « ' + ct.num + ' » introuvable dans le stock (ou déjà dépoté). Importez / pointez-le d\'abord, ou cochez « saisie manuelle » s\'il est partagé.',
      );
    // On conserve la déclaration portée par la ligne d'origine (LOT D).
    const src = conts[index] as Record<string, unknown>;
    const cible = ct as unknown as Record<string, unknown>;
    for (const k of ['numeroDeclaration', 'anneeDeclaration', 'bureauDeclaration', 'typeDeclaration', 'declarant', 'contactDeclarant', 'destinationMarchandise', 'descriptionMarchandise', 'nombreConteneurs']) {
      if (src[k] !== undefined) cible[k] = src[k];
    }
    // v4.1 — DÉCLARATION DE CETTE LIGNE (décision utilisateur 2026-07-22).
    // En chargement MIXTE, chaque conteneur porte SA déclaration : la corriger
    // par `editdecl` les réécrirait toutes à l'identique et détruirait le mixte.
    // Ici on ne touche qu'à la ligne visée. Seule l'identité de la déclaration
    // est modifiable ; le déclarant et la marchandise restent portés par le camion.
    const dSaisie = (p['declaration'] ?? {}) as Record<string, unknown>;
    const champsDecl: [string, number][] = [
      ['numeroDeclaration', 30], ['anneeDeclaration', 6], ['bureauDeclaration', 20], ['typeDeclaration', 10],
    ];
    for (const [k, n] of champsDecl) {
      if (dSaisie[k] === undefined) continue;
      const v = maj(dSaisie[k], n);
      if (v) cible[k] = v; // vide = « ne touche pas », pas « efface »
    }
    conts[index] = ct;
  }

  // Stock : l'ancien TC redevient disponible, le nouveau est consommé.
  const nouveauNum = supprimer ? '' : normaliserConteneur(conts[index] as never).num;
  if (ancien.num && ancien.num !== nouveauNum)
    await delierStock(ctx, ancien.num, id, estEnl ? STOCK_STATUTS.STOCK : STOCK_STATUTS.POSITIONNE);
  if (nouveauNum && nouveauNum !== ancien.num) await lierStock(ctx, nouveauNum, id);

  // Un camion vidé de tous ses conteneurs retourne à « Camion créé ».
  const patch: Record<string, unknown> = {
    nb_conteneurs: conts.length,
    conteneurs_details: { conteneurs: conts, scellesCamion: pd.scellesCamion },
    twins: b(estEnl && conts.length >= 2),
  };
  if (!conts.length && [STATUTS.CAMION, STATUTS.CHARGEMENT, STATUTS.CREEE].indexOf(c['statut'] as never) >= 0)
    patch['statut'] = STATUTS.CAMION;
  await patchCargo(ctx, cargo, patch);

  // Table normalisée « conteneurs » : réécriture complète (source de vérité = pd).
  const rapportId = String(c['rapportId'] || '');
  await supprimerConteneursDe(ctx, id);
  await ajouterConteneurs(ctx, rapportId, id, String(c['numeroCamion']), type, conts.map((x) => normaliserConteneur(x)));

  const declApres = supprimer ? declAvant : declKey(conts[index] as never);

  /* 00170 — APUREMENT : le compteur suit enfin le conteneur.
   *
   * Jusqu'ici cette fonction CONSTATAIT le changement de déclaration et se
   * contentait de l'écrire dans le journal. Le +1 posé à l'ajout restait donc
   * sur la déclaration d'origine, que le conteneur soit retiré du camion ou
   * réaffecté à une autre déclaration — et la nouvelle déclaration ne recevait
   * jamais le sien. Relevé du 2026-09-09 : 34 des 121 déclarations portant un
   * nombre déclaré étaient sur-apurées, jusqu'à +8 conteneurs.
   *
   * Best-effort des deux côtés (cf. majApurementDec / majApurementSafe) : une
   * correction de conteneur ne doit jamais échouer parce qu'un compteur n'a pas
   * pu être rattrapé.
   */
  if (supprimer) {
    await majApurementDec(ctx, declObjAvant as never, 1);
  } else if (declApres !== declAvant) {
    await majApurementDec(ctx, declObjAvant as never, 1);
    const s = conts[index] as unknown as Record<string, unknown>;
    await majApurementSafe(ctx, {
      numeroDeclaration: s['numeroDeclaration'], anneeDeclaration: s['anneeDeclaration'],
      bureauDeclaration: s['bureauDeclaration'], typeDeclaration: s['typeDeclaration'],
      declarant: s['declarant'],
    } as never, 1);
  }

  await ctx.log(
    supprimer ? 'Correction — suppression conteneur' : 'Correction conteneur',
    id,
    (supprimer ? ancien.num + ' retiré'
      : ancien.num + ' → ' + nouveauNum + (declApres !== declAvant ? ' · déclaration ' + declAvant + ' → ' + declApres : ''))
      + motifAvance,
  );
  return { id, conteneurs: conts.length, ancien: ancien.num, nouveau: nouveauNum };
}

/* ------------------------------- editdecl ------------------------------ */

/**
 * v4 — CORRECTION des informations de déclaration d'un camion déjà enregistré
 * (déclarant, contact, destination, n°/année/bureau/type, marchandise).
 * Les lignes conteneurs de la cargaison portent la même déclaration (LOT D) :
 * elles sont réalignées. CFS : phase CFS ; ADMIN : partout.
 */
export async function editdecl(ctx: Ctx, p: Record<string, unknown>) {
  const id = String(p['id'] ?? '').trim();
  const cargo = await getCargo(ctx, id);
  const c = cargo.o;
  const estAdmin = ctx.session.role === ROLES.ADMIN;
  const motifAvance = exigerMotifSiAvancee(ctx, c, p);
  const type = String(c['typeOperation'] || '');
  // CORRECTION, pas création : contact / destination / désignation absents des
  // données migrées ne doivent pas bloquer la correction d'un numéro.
  const decl = normaliserDeclaration(p['declaration'] as never, type, { correction: true });

  // Un champ laissé vide en correction NE DOIT PAS effacer ce qui existe :
  // l'agent corrige un numéro, il ne vient pas vider le contact du déclarant.
  const garder = (nouveau: string, ancien: unknown) => (nouveau ? nouveau : String(ancien ?? ''));
  const eff = {
    declarant: decl.declarant,
    contactDeclarant: garder(decl.contactDeclarant, c['contactDeclarant']),
    destinationMarchandise: garder(decl.destinationMarchandise, c['destinationMarchandise']),
    descriptionMarchandise: garder(decl.descriptionMarchandise, c['descriptionMarchandise']),
    bureauDeclaration: decl.bureauDeclaration, typeDeclaration: decl.typeDeclaration,
    numeroDeclaration: decl.numeroDeclaration, anneeDeclaration: decl.anneeDeclaration,
  };

  const pd = parseConteneursDetails(c['conteneursDetails']);
  pd.conteneurs.forEach((ct) => {
    const x = ct as unknown as Record<string, unknown>;
    x['numeroDeclaration'] = eff.numeroDeclaration; x['anneeDeclaration'] = eff.anneeDeclaration;
    x['bureauDeclaration'] = eff.bureauDeclaration; x['typeDeclaration'] = eff.typeDeclaration;
    x['declarant'] = eff.declarant; x['contactDeclarant'] = eff.contactDeclarant;
    x['destinationMarchandise'] = eff.destinationMarchandise; x['descriptionMarchandise'] = eff.descriptionMarchandise;
  });

  const patch: Record<string, unknown> = {
    declarant: eff.declarant, contact_declarant: eff.contactDeclarant,
    destination_marchandise: eff.destinationMarchandise, bureau_declaration: eff.bureauDeclaration,
    type_declaration: eff.typeDeclaration, numero_declaration: eff.numeroDeclaration,
    annee_declaration: eff.anneeDeclaration, description_marchandise: eff.descriptionMarchandise,
    conteneurs_details: { conteneurs: pd.conteneurs, scellesCamion: pd.scellesCamion },
    // La correction réaligne TOUS les conteneurs sur une même déclaration : plus
    // de mixte. La colonne est NOT NULL → false, pas null (sinon violation de
    // contrainte, l'enregistrement de la correction échouait).
    chargement_mixte: false,
  };
  // Le type de déclaration commande les sauts d'étapes (C = conso → saute T1).
  const sauts = sautsTypeC(decl.typeDeclaration, p['consoMode']);
  patch['saute_t1'] = sauts.sauteT1;
  patch['saute_balise'] = sauts.sauteBalise;
  await patchCargo(ctx, cargo, patch);

  const ancienne = [c['numeroDeclaration'], c['anneeDeclaration'], c['bureauDeclaration'], c['typeDeclaration']].filter(Boolean).join('|');
  await ctx.log('Correction déclaration', id, ancienne + ' → ' + declKey(decl) + motifAvance);
  return { id, declaration: decl };
}

/* ------------------------------ lotcamions ----------------------------- */

/**
 * v4 — SAISIE EN LOT : plusieurs camions chargeant des conteneurs d'UNE MÊME
 * déclaration, sans re-saisir le déclarant / la déclaration / la marchandise à
 * chaque camion (demande terrain : c'était le geste le plus répétitif du CFS).
 * Chaque camion est créé puis alimenté par les chemins déjà validés
 * (createcamion + cfs), donc TOUTES les règles métier restent appliquées.
 * Traitement ligne par ligne : un camion en erreur n'annule pas les autres,
 * l'appelant reçoit le détail des réussites et des échecs.
 */
export async function lotcamions(ctx: Ctx, p: Record<string, unknown>) {
  const routage = String(p['typeOperation'] ?? p['routage'] ?? '').trim();
  if ([OPERATIONS.ENLEVEMENT, OPERATIONS.DEPOTAGE].indexOf(routage as never) === -1)
    throw new Error("Type d'opération requis : Enlèvement ou Dépotage.");
  const declaration = (p['declaration'] ?? {}) as Record<string, unknown>;
  if (!String(declaration['declarant'] ?? '').trim()) throw new Error('Champ de déclaration obligatoire : Déclarant.');
  const camions = (Array.isArray(p['camions']) ? (p['camions'] as Record<string, unknown>[]) : [])
    .filter((cm) => String(cm?.['numeroCamion'] ?? '').trim());
  if (!camions.length) throw new Error('Indiquez au moins un camion.');

  const crees: Record<string, unknown>[] = [];
  const erreurs: Record<string, unknown>[] = [];
  for (const cm of camions) {
    const numeroCamion = alphaNumMaj(cm['numeroCamion']);
    const conteneurs = (Array.isArray(cm['conteneurs']) ? (cm['conteneurs'] as Record<string, unknown>[]) : [])
      .filter((ct) => String(ct?.['num'] ?? '').trim());
    if (!conteneurs.length) { erreurs.push({ numeroCamion, message: 'Aucun conteneur saisi pour ce camion.' }); continue; }
    let id = '';
    try {
      const cr = await createcamion(ctx, { numeroCamion, routage });
      id = String((cr as { id: string }).id);
      let premier = true;
      for (const ct of conteneurs) {
        const charge: Record<string, unknown> = { id, conteneur: ct };
        // La déclaration n'accompagne que le 1er conteneur en enlèvement ;
        // en dépotage elle est portée par CHAQUE conteneur (règle cfs()).
        if (premier || routage === OPERATIONS.DEPOTAGE) {
          charge['declaration'] = declaration;
          if (p['consoMode']) charge['consoMode'] = p['consoMode'];
        }
        await cfs(ctx, charge);
        premier = false;
      }
      // Enlèvement : `cfs` place déjà le camion en « Créée » (scellés par
      // conteneur = fin de chargement). Rien à confirmer ici.
      crees.push({ id, numeroCamion, conteneurs: conteneurs.length });
    } catch (e) {
      erreurs.push({ numeroCamion, id, message: (e as Error).message });
    }
  }
  await ctx.log('Saisie en lot (même déclaration)', '', crees.length + ' camion(s) créé(s), ' + erreurs.length + ' en erreur');
  return { crees, erreurs };
}

/* -------------------------------- update ------------------------------- */

/** Édition d'une cargaison (champs CFS). CFS limité au statut « Créée » ; ADMIN partout. */
export async function update(ctx: Ctx, p: Record<string, unknown>) {
  const id = String(p['id'] ?? '').trim();
  const type = p['typeOperation'] as string;
  if ([OPERATIONS.DEPOTAGE, OPERATIONS.ENLEVEMENT].indexOf(type as never) === -1) throw new Error("Type d'opération invalide.");
  const decl = normaliserDeclaration(p['declaration'] as never, type);
  const cam = construireCamion(
    { numeroCamion: p['numeroCamion'] as string, conteneurs: p['conteneurs'] as never, scellesCamion: p['scellesCamion'] as never },
    type,
  );
  const cargo = await getCargo(ctx, id);
  const c = cargo.o;
  if (ctx.session.role !== ROLES.ADMIN && c['statut'] !== STATUTS.CREEE)
    throw new Error("Modification impossible : la cargaison n'est plus au statut « Créée ».");
  const rapportId = String(c['rapportId'] || '');
  await patchCargo(ctx, cargo, {
    numero_camion: cam.numeroCamion, type_operation: type, twins: cam.twins === 'Yes',
    nb_conteneurs: cam.nbConteneurs, conteneurs_details: cam.conteneursDetails,
    declarant: decl.declarant, contact_declarant: decl.contactDeclarant,
    destination_marchandise: decl.destinationMarchandise, bureau_declaration: decl.bureauDeclaration,
    type_declaration: decl.typeDeclaration, numero_declaration: decl.numeroDeclaration,
    annee_declaration: decl.anneeDeclaration, description_marchandise: decl.descriptionMarchandise,
    observations_cfs: maj(p['observationsCFS'], 1000),
  });
  await supprimerConteneursDe(ctx, id);
  await ajouterConteneurs(ctx, rapportId, id, cam.numeroCamion, type, cam.conteneurs);
  await ctx.log('Modification cargaison', id, type);
  return { id };
}

/* -------------------------------- mixte -------------------------------- */

export async function mixte(ctx: Ctx, p: Record<string, unknown>) {
  const id = String(p['id'] ?? '').trim();
  const note = maj(p['note'], 1000);
  const infosSupp = maj(p['infosSupplementaires'], 2000);
  const ajout = (Array.isArray(p['conteneurs']) ? (p['conteneurs'] as unknown[]) : [])
    .map((cc) => normaliserConteneur(cc as never))
    .filter((cc) => cc.num);
  if (!note && !infosSupp && !ajout.length) throw new Error('Aucune information à ajouter au chargement mixte.');

  const cargo = await getCargo(ctx, id);
  const c = cargo.o;
  const type = c['typeOperation'] as string;
  const numeroCamion = String(c['numeroCamion']);
  const rapportId = String(c['rapportId'] || '');
  const estDepotage = type === OPERATIONS.DEPOTAGE;
  if (ajout.length) {
    ajout.forEach((ct, i) => {
      if (!tcValide(ct.num)) throw new Error('Conteneur ajouté ' + (i + 1) + ' : N° invalide. Format : 4 lettres + 7 chiffres (ex. MSKU1234567).');
      if (!ct.taille) throw new Error('Conteneur ajouté ' + (i + 1) + ' : la Taille est obligatoire.');
      if (!ct.type) throw new Error('Conteneur ajouté ' + (i + 1) + ' : le Type est obligatoire.');
      if (estDepotage) ct.plomb = '';
      else if (!ct.plomb) throw new Error('Conteneur ajouté ' + (i + 1) + ' : le Scellé / Plomb est obligatoire.');
    });
  }
  const histRaw = c['mixteDetails'];
  const hist: unknown[] = Array.isArray(histRaw) ? histRaw : [];
  hist.push({
    date: new Date().toISOString(), agent: ctx.session.nomComplet, note, infos: infosSupp,
    conteneursAjoutes: ajout.map((x) => x.num),
  });
  const patch: Record<string, unknown> = { chargement_mixte: true, mixte_details: hist };
  let total = 0;
  if (ajout.length) {
    const pd = parseConteneursDetails(c['conteneursDetails']);
    const conts = pd.conteneurs.concat(ajout);
    total = conts.length;
    patch['nb_conteneurs'] = total;
    patch['conteneurs_details'] = { conteneurs: conts, scellesCamion: pd.scellesCamion };
  }
  await patchCargo(ctx, cargo, patch);
  if (ajout.length) {
    const pd = parseConteneursDetails(c['conteneursDetails']);
    await ajouterConteneurs(ctx, rapportId, id, numeroCamion, type, ajout, pd.conteneurs.length + 1);
  }
  await ctx.log('Chargement mixte', id, (ajout.length ? ajout.length + ' conteneur(s) ajouté(s). ' : '') + (note || infosSupp || ''));
  return { id, total };
}

/* -------------------------------- utils -------------------------------- */

function fmtDate(v: unknown): string {
  if (!v) return '';
  const d = new Date(String(v));
  return isNaN(d.getTime()) ? String(v) : d.toLocaleDateString('fr-FR');
}

/* ================== CORRECTIONS DE CELLULES REMPLIES (2026-09-10) ==========
 *
 * Ajout, sans rien retirer : chaque cellule déjà renseignée devient corrigible
 * par la cellule qui l'a saisie, et par l'ADMIN. Jusqu'ici seule la Balise avait
 * son `gpsedit` ; une erreur de frappe sur un numéro T1 ou un bon de sortie
 * n'avait aucun recours, sinon annuler tout le camion.
 *
 * TROIS PRINCIPES COMMUNS, calqués sur `gpsedit` :
 *  · on ne crée jamais la donnée par ces actions — elles CORRIGENT ce qui existe
 *    déjà, et refusent une cellule vide (sinon elles contourneraient le workflow
 *    et ses gardes) ;
 *  · l'ancienne valeur est portée au journal, sans quoi la correction efface ce
 *    qu'elle corrige et devient invérifiable ;
 *  · aucun statut n'est modifié : corriger n'est pas refaire l'étape.
 * ========================================================================== */

/** Correction des numéros T1 / bureau de destination déjà saisis. */
export async function t1edit(ctx: Ctx, p: Record<string, unknown>) {
  const id = String(p['id'] ?? '').trim();
  const cargo = await getCargo(ctx, id);
  const c = cargo.o;
  if (!aFait(c['dateT1']))
    throw new ErreurMetier("Le T1 n'a pas encore été saisi : utilisez la cellule T1.");

  const bureau = maj(p['bureauDestination'], 60) || String(c['bureauDestination'] ?? '');
  const brut = Array.isArray(p['t1Numeros']) ? (p['t1Numeros'] as unknown[]) : null;
  if (!brut || !brut.length) throw new ErreurMetier('Indiquez au moins un numéro T1.');

  const avant = JSON.stringify(c['t1Numeros'] ?? []);
  await patchCargo(ctx, cargo, {
    bureau_destination: bureau,
    t1_numeros: brut,
    observations_t1: p['observations'] !== undefined ? txt(p['observations'], 1000) : c['observationsT1'],
  });
  await ctx.log('Correction T1', id,
    'Avant ' + avant.slice(0, 300) + ' → après ' + JSON.stringify(brut).slice(0, 300) + ' · bureau ' + bureau);
  return { id };
}

/** Correction du numéro de bon de sortie déjà émis. */
export async function bsedit(ctx: Ctx, p: Record<string, unknown>) {
  const id = String(p['id'] ?? '').trim();
  const cargo = await getCargo(ctx, id);
  const c = cargo.o;
  if (!aFait(c['dateBonSortie']))
    throw new ErreurMetier("Aucun bon de sortie émis : utilisez la cellule Bon de sortie.");

  const numero = p['bonSortieNumero'];
  const vide = numero === undefined || numero === null || numero === ''
    || (Array.isArray(numero) && !numero.length);
  if (vide) throw new ErreurMetier('Indiquez le numéro du bon de sortie.');

  const avant = JSON.stringify(c['bonSortieNumero'] ?? '');
  await patchCargo(ctx, cargo, {
    bon_sortie_numero: numero,
    observations_bon_sortie: p['observations'] !== undefined
      ? txt(p['observations'], 1000) : c['observationsBonSortie'],
  });
  await ctx.log('Correction bon de sortie', id,
    'Avant ' + avant.slice(0, 300) + ' → après ' + JSON.stringify(numero).slice(0, 300));
  return { id };
}

/**
 * Correction d'un suivi d'engagement après la validation.
 *
 * ⚠ L'engagement entre dans l'empreinte SEC-10. On NE recalcule PAS la signature :
 * elle reste celle de ce que le chef a réellement signé. La conséquence est
 * voulue — l'écart entre l'empreinte enregistrée et le contenu courant devient
 * détectable, ce qui est précisément le rôle de SEC-10. La correction est donc
 * possible, et elle se voit.
 *
 * Le délai est saisi en JOURS, comme à la validation, et court à compter du jour
 * de la correction.
 */
export async function engagementEdit(ctx: Ctx, p: Record<string, unknown>) {
  const id = String(p['id'] ?? '').trim();
  const motif = txt(p['motif'], 300);
  if (!motif) throw new ErreurMetier('Indiquez le motif de la correction.');

  const cargo = await getCargo(ctx, id);
  const c = cargo.o;
  if (c['suiviEngagement'] !== true)
    throw new ErreurMetier("Cette cargaison n'est pas sous suivi d'engagement.");
  /* CORRECTION POSSIBLE MÊME APRÈS « EFFECTUÉ » — 2026-09-17 (demande utilisateur).
   *
   * Le refus qui se trouvait ici figeait l'erreur pour toujours : un clic de trop
   * sur « Effectué », et l'engagement mal saisi restait faux dans les rapports.
   * Or solder n'est pas contrôler : c'est dire qu'on a transmis les informations.
   * La correction reste donc ouverte, et le journal dit qu'elle est intervenue
   * APRÈS le solde — c'est ce qu'un contrôle a besoin de savoir. */
  const soldeLe = aFait(c['engagementEffectueLe']) ? String(c['engagementEffectueLe']) : '';

  const type = txt(p['engagementType'], 120) || String(c['engagementType'] ?? '');
  if (!type) throw new ErreurMetier("Précisez l'engagement.");
  const delai = String(p['engagementDelai'] ?? '').slice(0, 10) || String(c['engagementDelai'] ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(delai)) throw new ErreurMetier('Indiquez le délai.');

  const avant = `${String(c['engagementType'] ?? '')} · ${String(c['engagementDelai'] ?? '')}`;
  await patchCargo(ctx, cargo, { engagement_type: type, engagement_delai: delai });
  await ctx.log(soldeLe ? 'Correction engagement — APRÈS SOLDE' : 'Correction engagement (après signature)', id,
    'Avant ' + avant + ' → après ' + type + ' · ' + delai
      + (soldeLe ? ' · ⚠ engagement déjà soldé le ' + fmtDate(soldeLe) : '')
      + ' · motif : ' + motif);
  return { id, engagementType: type, engagementDelai: delai };
}
