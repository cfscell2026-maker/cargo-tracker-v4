/**
 * TRI DU VOLET « ENGAGEMENTS » — 2026-09-17 (demande utilisateur).
 *
 * Deux tris demandés : par CAMION (retrouver un dossier précis) et par DÉLAI
 * (traiter d'abord ce qui presse). Le tri se fait ici, sur les lignes déjà
 * reçues : la liste des engagements tient sur un écran, un aller-retour serveur
 * par clic n'apporterait rien.
 *
 * Fonction PURE et à part, pour être testée sans écran : c'est là que se logent
 * les erreurs de tri — une échéance vide qui remonte en tête, ou des numéros de
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
