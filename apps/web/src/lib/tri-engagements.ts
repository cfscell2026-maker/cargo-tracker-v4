/**
 * TRI DU VOLET « ENGAGEMENTS » : 2026-09-17 (demande utilisateur).
 *
 * Deux tris demandés : par CAMION (retrouver un dossier précis) et par DÉLAI
 * (traiter d'abord ce qui presse). Le tri se fait ici, sur les lignes déjà
 * reçues : la liste des engagements tient sur un écran, un aller-retour serveur
 * par clic n'apporterait rien.
 *
 * Fonction PURE et à part, pour être testée sans écran : c'est là que se logent
 * les erreurs de tri, une échéance vide qui remonte en tête, ou des numéros de
 * camion comparés sans tenir compte des accents et de la casse.
 */
export type TriEngagement = 'camion' | 'delai';
export type SensTri = 'asc' | 'desc';

type Ligne = Record<string, unknown>;

/** Comparaison de textes insensible à la casse et aux accents (« é » = « e »). */
const texte = (v: unknown) => String(v ?? '').trim();

export function trierEngagements(lignes: Ligne[], tri: TriEngagement, sens: SensTri = 'asc'): Ligne[] {
  const signe = sens === 'desc' ? -1 : 1;
  const copie = [...lignes];
  copie.sort((a, b) => {
    if (tri === 'camion') {
      const cmp = texte(a['numeroCamion']).localeCompare(texte(b['numeroCamion']), 'fr', { sensitivity: 'base', numeric: true });
      return cmp * signe;
    }
    /* DÉLAI. Une échéance MANQUANTE ne doit pas se glisser parmi les urgences :
       elle part toujours en fin de liste, quel que soit le sens du tri. */
    const da = texte(a['engagementDelai']).slice(0, 10);
    const db = texte(b['engagementDelai']).slice(0, 10);
    if (!da && !db) return 0;
    if (!da) return 1;
    if (!db) return -1;
    if (da === db) return texte(a['numeroCamion']).localeCompare(texte(b['numeroCamion']), 'fr', { sensitivity: 'base', numeric: true });
    return (da < db ? -1 : 1) * signe;
  });
  return copie;
}

/* ============ RECHERCHE ET DÉLAI : 2026-09-17 (demande utilisateur) ========
 *
 * Deux questions que le chef pose au volet :
 *   · « quels camions sont à échéance dans N jours ? », pour préparer sa
 *     semaine ; les DÉPASSÉS en font partie, ils sont déjà dans le délai ;
 *   · « où en est ce camion-là ? », la recherche par numéro, qui doit
 *     retrouver « TG 1234 BK » quand on tape « tg1234bk ».
 *
 * Fonction pure, à côté du tri : ce sont les mêmes lignes déjà reçues.
 */
export interface FiltreEngagements {
  /** N° de camion, même partiel. Espaces, tirets et casse sont ignorés. */
  camion?: string;
  /** Échéance dans AU PLUS N jours (les dépassées comprises). Vide = pas de filtre. */
  joursMax?: number | null;
}

/** Normalisation d'un n° pour la recherche : « TG-1234 BK » → « TG1234BK ». */
const normNum = (v: unknown) => String(v ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

/** Jours entre aujourd'hui et l'échéance ; null si l'échéance est absente ou illisible. */
export function joursAvantEcheance(delai: unknown, aujourdhui: Date = new Date()): number | null {
  const brut = String(delai ?? '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(brut)) return null;
  const [a, m, j] = brut.split('-').map(Number) as [number, number, number];
  const echeance = Date.UTC(a, m - 1, j);
  const jour = Date.UTC(aujourdhui.getFullYear(), aujourdhui.getMonth(), aujourdhui.getDate());
  return Math.round((echeance - jour) / 86400000);
}

export function filtrerEngagements(
  lignes: Record<string, unknown>[],
  f: FiltreEngagements,
  aujourdhui: Date = new Date(),
): Record<string, unknown>[] {
  const cam = normNum(f.camion);
  const jours = f.joursMax === null || f.joursMax === undefined || Number.isNaN(f.joursMax)
    ? null : Number(f.joursMax);
  return lignes.filter((l) => {
    if (cam && !normNum(l['numeroCamion']).includes(cam)) return false;
    if (jours !== null) {
      const restant = joursAvantEcheance(l['engagementDelai'], aujourdhui);
      // Sans échéance lisible, la ligne ne peut pas répondre « oui » à une
      // question qui porte sur un délai : on ne la fait pas passer par défaut.
      if (restant === null || restant > jours) return false;
    }
    return true;
  });
}
