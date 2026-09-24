/**
 * ============================================================================
 *  PARAMÈTRES DE L'APPLICATION : 2026-09-21 (demande utilisateur)
 *
 *  Les seuils de l'application étaient écrits dans le code : changer l'alerte de
 *  séjour des conteneurs ou la hauteur hors gabarit demandait un développeur et
 *  un déploiement. Ils deviennent des RÉGLAGES, modifiables par l'administrateur
 *  depuis le volet « Paramètres ».
 *
 *  Trois règles tiennent l'ensemble :
 *    · chaque réglage a une valeur PAR DÉFAUT égale à ce que le code faisait
 *      avant : tant que personne n'y touche, rien ne change ;
 *    · chaque réglage a des BORNES : une faute de frappe (« 900 » au lieu de
 *      « 90 ») est refusée, elle ne peut pas désorganiser l'exploitation ;
 *    · une valeur illisible en base est IGNORÉE au profit du défaut, un
 *      réglage abîmé ne doit jamais faire tomber un écran.
 *
 *  Module partagé : le serveur l'applique, l'écran l'affiche. Une seule liste,
 *  donc jamais de réglage que l'un connaît et pas l'autre.
 * ============================================================================
 */
import { ENGAGEMENTS, SEUIL_ALERTE_SEJOUR, CONTENEURS_MAX, HAUTEUR_HORS_GABARIT } from './constantes.ts';

export type TypeParametre = 'entier' | 'decimal' | 'liste';

export interface DefParametre {
  cle: CleParametre;
  groupe: string;
  libelle: string;
  unite?: string;
  type: TypeParametre;
  defaut: number | string[];
  min?: number;
  max?: number;
  /** Ce que le réglage change, dit simplement. */
  aide: string;
  /** Qui voit la différence dans son travail. */
  concerne: string;
}

export interface ValeursParametres {
  sejourAlerteJours: number;
  conteneursMaxCamion: number;
  engagementDelaiDefaut: number;
  engagementAlerteJours: number;
  engagementsProposes: string[];
  hauteurHorsGabarit: number;
  actualisationSecondes: number;
  archiveMois: number;
}
export type CleParametre = keyof ValeursParametres;

export const PARAMETRES: readonly DefParametre[] = [
  /* ---------------------------- Conteneurs ---------------------------- */
  {
    cle: 'sejourAlerteJours', groupe: 'Conteneurs', libelle: 'Séjour d\'un conteneur avant alerte',
    unite: 'jours', type: 'entier', defaut: SEUIL_ALERTE_SEJOUR, min: 7, max: 365,
    aide: 'Au-delà de cette durée au parc, un conteneur est compté « en alerte » dans les écrans de séjour '
      + '(Séjour conteneurs, Délai & instance) et dans leurs exports.',
    concerne: 'CFS, chefs, administrateur, écrans de séjour',
  },
  {
    cle: 'conteneursMaxCamion', groupe: 'Conteneurs', libelle: 'Conteneurs au plus par camion (dépotage)',
    unite: 'conteneurs', type: 'entier', defaut: CONTENEURS_MAX, min: 1, max: 100,
    aide: 'Nombre maximal de conteneurs qu\'un même camion peut recevoir en dépotage. Au-delà, l\'ajout est refusé. '
      + 'L\'enlèvement garde sa propre règle (binôme de conteneurs).',
    concerne: 'Agents CFS, ajout de conteneurs',
  },
  /* ---------------------------- Engagements --------------------------- */
  {
    cle: 'engagementDelaiDefaut', groupe: 'Engagements', libelle: 'Délai proposé à la signature',
    unite: 'jours', type: 'entier', defaut: 0, min: 0, max: 60,
    aide: 'Délai déjà rempli quand le chef de brigade coche « suivi des engagements ». Il reste modifiable à chaque '
      + 'signature. 0 : aucun délai proposé, le chef le saisit lui-même.',
    concerne: 'Chef de brigade (et intérim), à la validation',
  },
  {
    cle: 'engagementAlerteJours', groupe: 'Engagements', libelle: 'Alerte avant l\'échéance',
    unite: 'jours', type: 'entier', defaut: 1, min: 0, max: 30,
    aide: 'Combien de jours avant son échéance un engagement apparaît dans l\'encadré « Engagements à transmettre » '
      + 'du tableau de bord. 1 : la veille (réglage d\'origine). 0 : le jour même. Les retards y restent toujours.',
    concerne: 'Chefs et administrateur, tableau de bord',
  },
  {
    cle: 'engagementsProposes', groupe: 'Engagements', libelle: 'Engagements proposés dans la liste',
    type: 'liste', defaut: [...ENGAGEMENTS],
    aide: 'Les choix du menu « Engagement » à la signature et à la correction, un par ligne. Le chef peut toujours '
      + 'saisir autre chose avec « Autre (saisie libre) ». Retirer un choix ne touche pas aux engagements déjà pris.',
    concerne: 'Chef de brigade, à la validation et à la correction',
  },
  /* ----------------------------- Contrôles ---------------------------- */
  {
    cle: 'hauteurHorsGabarit', groupe: 'Contrôles', libelle: 'Hauteur de chargement hors gabarit',
    unite: 'mètres', type: 'decimal', defaut: HAUTEUR_HORS_GABARIT, min: 3, max: 6,
    aide: 'Au-dessus de cette hauteur, la finalisation d\'un dépotage marque le camion « hors gabarit ». '
      + 'La valeur s\'applique aux camions finalisés après la modification ; les précédents ne changent pas.',
    concerne: 'Agents CFS, chefs, contrôles de gabarit',
  },
  /* ---------------------------- Affichage ----------------------------- */
  {
    cle: 'actualisationSecondes', groupe: 'Affichage', libelle: 'Actualisation du tableau de bord',
    unite: 'secondes', type: 'entier', defaut: 60, min: 30, max: 600,
    aide: 'Fréquence à laquelle le tableau de bord se met à jour tout seul. Plus court : chiffres plus frais, '
      + 'mais plus d\'appels au serveur. Pris en compte au prochain chargement de la page.',
    concerne: 'Chefs et administrateur, tableau de bord',
  },
  {
    cle: 'archiveMois', groupe: 'Affichage', libelle: 'Âge d\'un dossier à l\'archive',
    unite: 'mois', type: 'entier', defaut: 12, min: 3, max: 60,
    aide: 'Ancienneté à partir de laquelle un dossier apparaît dans « Archive ». Rien n\'est déplacé ni effacé : '
      + 'c\'est un simple filtre de lecture.',
    concerne: 'Administrateur, écran Archive',
  },
];

export const PARAMETRES_DEFAUT: ValeursParametres = Object.fromEntries(
  PARAMETRES.map((d) => [d.cle, Array.isArray(d.defaut) ? [...d.defaut] : d.defaut]),
) as unknown as ValeursParametres;

export const defParametre = (cle: string): DefParametre | undefined => PARAMETRES.find((d) => d.cle === cle);

export type Verdict = { ok: true; valeur: number | string[] } | { ok: false; erreur: string };

/** Valide UNE valeur ; renvoie la valeur normalisée ou le motif du refus. */
export function validerParametre(cle: string, valeur: unknown): Verdict {
  const d = defParametre(cle);
  if (!d) return { ok: false, erreur: `Paramètre inconnu : « ${cle} ».` };

  if (d.type === 'liste') {
    const brut = Array.isArray(valeur) ? valeur : String(valeur ?? '').split(/\r?\n/);
    const vus = new Set<string>();
    const liste: string[] = [];
    for (const v of brut) {
      const t = String(v ?? '').trim().replace(/\s+/g, ' ');
      if (!t) continue;
      if (t.length > 60) return { ok: false, erreur: `${d.libelle} : « ${t.slice(0, 30)}… » dépasse 60 caractères.` };
      const k = t.toLowerCase();
      if (vus.has(k)) continue; // doublon : ignoré sans bruit
      vus.add(k);
      liste.push(t);
    }
    if (!liste.length) return { ok: false, erreur: `${d.libelle} : indiquez au moins un choix.` };
    if (liste.length > 12) return { ok: false, erreur: `${d.libelle} : 12 choix au plus.` };
    return { ok: true, valeur: liste };
  }

  const n = typeof valeur === 'number' ? valeur : Number(String(valeur ?? '').replace(',', '.').trim());
  if (String(valeur ?? '').trim() === '' || !Number.isFinite(n))
    return { ok: false, erreur: `${d.libelle} : indiquez un nombre.` };
  if (d.type === 'entier' && !Number.isInteger(n))
    return { ok: false, erreur: `${d.libelle} : un nombre entier est attendu.` };
  if ((d.min !== undefined && n < d.min) || (d.max !== undefined && n > d.max))
    return { ok: false, erreur: `${d.libelle} : entre ${d.min} et ${d.max}${d.unite ? ' ' + d.unite : ''}.` };
  return { ok: true, valeur: d.type === 'decimal' ? Math.round(n * 100) / 100 : n };
}

/**
 * Valeurs EFFECTIVES à partir de ce qui est stocké : chaque réglage absent ou
 * illisible reprend sa valeur par défaut. Ne lève jamais.
 */
export function valeursParametres(brut: Record<string, unknown> | null | undefined): ValeursParametres {
  const v = { ...PARAMETRES_DEFAUT, engagementsProposes: [...PARAMETRES_DEFAUT.engagementsProposes] } as Record<string, unknown>;
  for (const d of PARAMETRES) {
    if (!brut || !(d.cle in brut)) continue;
    const r = validerParametre(d.cle, brut[d.cle]);
    if (r.ok) v[d.cle] = r.valeur;
  }
  return v as unknown as ValeursParametres;
}
