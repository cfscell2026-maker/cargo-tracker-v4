/**
 * ============================================================================
 *  @cargo/domaine — Normalisation & validation des saisies
 *  Transcription FIDÈLE des helpers de Data.gs (v3.6) :
 *  _txt_, _maj_, _alphaNumMaj_, _tcValide_, _normaliserConteneur_,
 *  _normaliserDeclaration_, _declKey_, _parseDateImport_.
 *  ⚠ Les MESSAGES D'ERREUR sont conservés MOT POUR MOT (parité v3.6).
 * ============================================================================
 */

import { DEFAUTS, OPERATIONS } from './constantes.ts';

/** _txt_ : chaîne épurée, tronquée à `max`. */
export function txt(v: unknown, max?: number): string {
  let s = v === null || v === undefined ? '' : String(v).trim();
  if (max && s.length > max) s = s.slice(0, max);
  return s;
}

/** _maj_ : MAJUSCULES + troncature. */
export function maj(v: unknown, max?: number): string {
  return txt(v, max).toUpperCase();
}

/** _alphaNumMaj_ : alphanumérique MAJUSCULES (tolère / et -). */
export function alphaNumMaj(v: unknown): string {
  return txt(v).toUpperCase().replace(/[^A-Z0-9/-]/g, '');
}

/** Normalisation « recherche » : MAJUSCULES, alphanumérique strict. */
export function normAlphaNum(v: unknown): string {
  return String(v ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** _tcValide_ : N° de conteneur ISO 6346 = 4 lettres + 7 chiffres. */
export function tcValide(num: unknown): boolean {
  return /^[A-Z]{4}[0-9]{7}$/.test(normAlphaNum(num));
}

export interface ChampLibre {
  nom: string;
  valeur: string;
}

export interface Conteneur {
  num: string;
  plomb: string;
  taille: string;
  type: string;
  poids: string;
  extra: ChampLibre[];
  // LOT D — déclaration par conteneur (remplie par le flux d'entrée)
  numeroDeclaration?: string;
  anneeDeclaration?: string;
  bureauDeclaration?: string;
  typeDeclaration?: string;
  declarant?: string;
  contactDeclarant?: string;
  destinationMarchandise?: string;
  descriptionMarchandise?: string;
  nombreConteneurs?: string | number;
}

/** _normaliserConteneur_ : MAJUSCULES + champs additionnels. */
export function normaliserConteneur(c: Partial<Conteneur> | null | undefined): Conteneur {
  const src = c ?? {};
  const extra = (Array.isArray(src.extra) ? src.extra : [])
    .map((e) => ({ nom: maj(e?.nom, 40), valeur: maj(e?.valeur, 120) }))
    .filter((e) => e.nom || e.valeur);
  return {
    num: maj(src.num, 20).replace(/[^A-Z0-9]/g, ''),
    plomb: maj(src.plomb, 30),
    taille: maj(src.taille, 10),
    type: maj(src.type, 30),
    poids: maj(src.poids, 20),
    extra,
  };
}

export interface Declaration {
  declarant: string;
  contactDeclarant: string;
  destinationMarchandise: string;
  bureauDeclaration: string;
  typeDeclaration: string;
  numeroDeclaration: string;
  anneeDeclaration: string;
  descriptionMarchandise: string;
  /**
   * v4 — DATE de la déclaration en douane (ISO 'yyyy-MM-dd'), imprimée sur
   * l'ORDRE D'EXÉCUTION (« Déclaration : Type … N° … du 24/06/26 »). Distincte
   * de la date de saisie dans l'appli. FACULTATIVE au niveau du domaine :
   * exigée seulement à la CRÉATION d'une déclaration (comme nombreConteneurs),
   * pour ne pas bloquer les déclarations déjà migrées qui ne l'ont pas.
   */
  dateDeclaration?: string;
}

/**
 * _normaliserDeclaration_ : MAJUSCULES, défauts, longueurs — TOUS les champs
 * obligatoires (sauf description pour un VÉHICULE, portée par les effets divers).
 */
/**
 * v4.1 — Options de normalisation.
 *
 * `correction` : on CORRIGE une déclaration déjà enregistrée, on n'en crée pas
 * une. Seule l'IDENTITÉ de la déclaration (déclarant + année/bureau/type/numéro)
 * reste exigée ; le contact, la destination et la désignation peuvent rester
 * vides. Sans cela, corriger un simple numéro sur l'une des 5022 cargaisons
 * MIGRÉES est impossible : leur export d'origine n'avait ni contact, ni
 * destination, ni désignation, et la saisie était refusée sur des champs que
 * l'agent n'a jamais eus à l'écran (« Champ obligatoire : Contact déclarant »).
 * Le téléphone reste validé s'il est renseigné — on n'accepte pas un faux.
 */
export interface OptionsDeclaration { correction?: boolean }

export function normaliserDeclaration(
  d: Partial<Declaration> | null | undefined,
  type?: string,
  opts?: OptionsDeclaration,
): Declaration {
  const src = d ?? {};
  if (src.descriptionMarchandise && String(src.descriptionMarchandise).length > 600)
    throw new Error('Description trop longue (max 600 caractères).');
  // Contact = téléphone : chiffres, espaces et un « + » en tête uniquement.
  const contact = txt(src.contactDeclarant, 30)
    .replace(/[^\d+ ]/g, '')
    .replace(/(?!^)\+/g, '')
    .trim();
  // v4 — date de la déclaration en douane : acceptée en jj/mm/aaaa, aaaa-mm-jj,
  // Date ou sérial Excel ; normalisée en ISO 'yyyy-MM-dd'. Refusée si saisie mais
  // illisible (évite d'imprimer une date fausse sur l'ordre d'exécution).
  const dDecl = parseDateImport(src.dateDeclaration);
  if (src.dateDeclaration && !dDecl)
    throw new Error('Date de la déclaration invalide (attendu jj/mm/aaaa).');
  const out: Declaration = {
    declarant: maj(src.declarant),
    contactDeclarant: contact,
    destinationMarchandise: maj(src.destinationMarchandise),
    bureauDeclaration: maj(src.bureauDeclaration) || DEFAUTS.BUREAU_DECLARATION,
    typeDeclaration: maj(src.typeDeclaration) || DEFAUTS.TYPE_DECLARATION,
    numeroDeclaration: maj(src.numeroDeclaration),
    anneeDeclaration: maj(src.anneeDeclaration),
    descriptionMarchandise: maj(src.descriptionMarchandise, 600),
    dateDeclaration: dDecl ? dDecl.toISOString().slice(0, 10) : '',
  };
  // Identité de la déclaration : exigée dans TOUS les cas, création comme
  // correction — sans elle la ligne ne désigne plus rien.
  const requis: Array<[keyof Declaration, string]> = [
    ['declarant', 'Déclarant'],
    ['bureauDeclaration', 'Bureau de déclaration'],
    ['typeDeclaration', 'Type de déclaration'],
    ['numeroDeclaration', 'N° de déclaration'],
    ['anneeDeclaration', 'Année de déclaration'],
  ];
  if (!opts?.correction) {
    requis.push(['contactDeclarant', 'Contact déclarant']);
    requis.push(['destinationMarchandise', 'Destination marchandise']);
    // v3.6 — VÉHICULE : description non requise (portée par les effets divers).
    if (type !== OPERATIONS.VEHICULE) requis.push(['descriptionMarchandise', 'Description marchandise']);
  }
  for (const [k, label] of requis) {
    if (!out[k]) throw new Error('Champ de déclaration obligatoire : ' + label + '.');
  }
  // Téléphone : toujours vérifié DÈS QU'IL EST RENSEIGNÉ (en correction, le
  // laisser vide est permis ; le remplir n'importe comment, non).
  if ((contact || !opts?.correction) && contact.replace(/\D/g, '').length < 6)
    throw new Error('Contact déclarant : numéro de téléphone invalide (au moins 6 chiffres).');
  return out;
}

/** _declKey_ : clé unique d'une déclaration = année|bureau|type|numéro. */
export function declKey(d: Partial<Declaration> | null | undefined): string {
  const src = d ?? {};
  return [src.anneeDeclaration, src.bureauDeclaration, src.typeDeclaration, src.numeroDeclaration]
    .map((x) => String(x ?? '').toUpperCase().replace(/\s+/g, ''))
    .join('|');
}

/** _parseDateImport_ : Date JS, sérial Excel, dd/MM/yyyy, yyyy-MM-dd → Date ou null. */
export function parseDateImport(v: unknown): Date | null {
  if (!v) return null;
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
  const s = String(v).trim();
  if (!s) return null;
  if (/^\d+(\.\d+)?$/.test(s)) {
    // sérial Excel (jours depuis 1899-12-30)
    const n = Number(s);
    if (n > 59 && n < 60000) return new Date(Math.round((n - 25569) * 86400000));
  }
  let m = s.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})$/); // dd/MM/yyyy
  if (m) {
    let y = Number(m[3]);
    if (y < 100) y += 2000;
    return new Date(y, Number(m[2]) - 1, Number(m[1]));
  }
  m = s.match(/^(\d{4})[/\-.](\d{1,2})[/\-.](\d{1,2})$/); // yyyy-MM-dd
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

/**
 * Détail conteneurs d'une cargaison : les DEUX formes historiques sont gérées
 * (tableau simple, ou objet {conteneurs, scellesCamion}).
 */
export interface ConteneursDetails {
  conteneurs: Conteneur[];
  scellesCamion: string[];
}
export function parseConteneursDetails(raw: unknown): ConteneursDetails {
  let pd: unknown = raw;
  if (typeof raw === 'string') {
    try {
      pd = JSON.parse(raw || '[]');
    } catch {
      pd = [];
    }
  }
  if (Array.isArray(pd)) return { conteneurs: pd as Conteneur[], scellesCamion: [] };
  const o = (pd ?? {}) as Partial<ConteneursDetails>;
  return {
    conteneurs: Array.isArray(o.conteneurs) ? o.conteneurs : [],
    scellesCamion: Array.isArray(o.scellesCamion) ? o.scellesCamion : [],
  };
}

/* ------------------------ Chargement mixte (v4) ------------------------ */

/**
 * CHARGEMENT MIXTE — un camion qui emporte des conteneurs relevant de
 * PLUSIEURS déclarations. L'Apps Script (v3.x) le marquait par un drapeau
 * `chargementMixte` posé à l'ajout du conteneur ; en v4 chaque conteneur porte
 * SA déclaration (LOT D), donc le mixte se DÉDUIT des données au lieu d'être
 * stocké : plus de drapeau à maintenir, et les cargaisons migrées sans drapeau
 * sont reconnues elles aussi.
 *
 * La clé de regroupement est la déclaration complète (n° + année + bureau +
 * type) ; un conteneur sans déclaration propre hérite de celle du camion.
 */
export interface GroupeDeclaration {
  cle: string;
  numeroDeclaration: string;
  anneeDeclaration: string;
  bureauDeclaration: string;
  typeDeclaration: string;
  declarant: string;
  /** Index (base 1) des conteneurs du camion appartenant à ce groupe. */
  rangs: number[];
  conteneurs: Conteneur[];
}

/** Clé de déclaration normalisée (insensible à la casse et à la ponctuation). */
export function cleDeclaration(o: Record<string, unknown> | Conteneur | null | undefined): string {
  const r = (o ?? {}) as Record<string, unknown>;
  return [
    normAlphaNum(r['numeroDeclaration']),
    normAlphaNum(r['anneeDeclaration']),
    normAlphaNum(r['bureauDeclaration']),
    normAlphaNum(r['typeDeclaration']),
  ].join('|');
}

/**
 * Regroupe les conteneurs d'un camion par déclaration. Un seul groupe = chargement
 * homogène ; deux ou plus = chargement mixte.
 */
export function groupesDeclaration(
  conteneurs: Conteneur[],
  camion?: Record<string, unknown> | null,
): GroupeDeclaration[] {
  const cam = (camion ?? {}) as Record<string, unknown>;
  const groupes: GroupeDeclaration[] = [];
  const parCle: Record<string, GroupeDeclaration> = {};
  conteneurs.forEach((ct, i) => {
    // Le conteneur porte sa propre déclaration dès qu'il en a un numéro ; sinon
    // (saisies anciennes / migrées) il relève de la déclaration du camion.
    const src = txt(ct?.numeroDeclaration) ? (ct as unknown as Record<string, unknown>) : cam;
    const cle = cleDeclaration(src);
    let g = parCle[cle];
    if (!g) {
      g = parCle[cle] = {
        cle,
        numeroDeclaration: txt(src['numeroDeclaration']),
        anneeDeclaration: txt(src['anneeDeclaration']),
        bureauDeclaration: txt(src['bureauDeclaration']),
        typeDeclaration: txt(src['typeDeclaration']),
        declarant: txt(src['declarant']) || txt(cam['declarant']),
        rangs: [],
        conteneurs: [],
      };
      groupes.push(g);
    }
    g.rangs.push(i + 1);
    g.conteneurs.push(ct);
  });
  return groupes;
}

/** Vrai si le camion emporte des conteneurs de plusieurs déclarations. */
export function estChargementMixte(
  conteneurs: Conteneur[],
  camion?: Record<string, unknown> | null,
): boolean {
  return groupesDeclaration(conteneurs, camion).length > 1;
}

/** Libellé court d'une déclaration : « 12345 · 2026 · TG120 · T ». */
export function libelleDeclaration(o: Record<string, unknown> | GroupeDeclaration): string {
  const r = o as Record<string, unknown>;
  return [r['numeroDeclaration'], r['anneeDeclaration'], r['bureauDeclaration'], r['typeDeclaration']]
    .map((v) => txt(v)).filter(Boolean).join(' · ') || '—';
}
