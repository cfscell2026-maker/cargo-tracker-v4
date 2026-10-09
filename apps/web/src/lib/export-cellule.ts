/**
 * EXTRACTION DU DÉTAIL D'UN RAPPORT DE CELLULE : 2026-10-09 (demande utilisateur).
 *
 * « Rapport CFS, Enlèvement : quand on clique, on peut extraire toutes les
 * déclarations ; de même pour la PP et les autres. » La fenêtre de détail d'une
 * carte (CFS, T1, Bon de sortie, Balise, PP) s'extrait en Excel : les lignes
 * affichées, dans leur ordre, avec la déclaration, le T1, le bon de sortie et la
 * date de chaque cellule.
 *
 * Fonction PURE et à part, pour être testée sans écran.
 */
type Ligne = Record<string, unknown>;

const tx = (v: unknown) => String(v ?? '').trim();

/** « 2026-10-05T14:32:00Z » → « 05/10/2026 14:32 » (Togo = UTC+0 : l'heure stockée est l'heure locale). */
export function dateHeureFr(v: unknown): string {
  const s = tx(v);
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/.exec(s);
  if (!m) return '';
  const jour = `${m[3]}/${m[2]}/${m[1]}`;
  return m[4] ? `${jour} ${m[4]}:${m[5]}` : jour;
}

/** Colonnes communes : la déclaration, les pièces et le passage à chaque cellule. */
function declarationEtPieces(r: Ligne): Record<string, string> {
  return {
    'Déclarant': tx(r['declarant']),
    'N° déclaration': tx(r['numeroDeclaration']),
    'Année': tx(r['anneeDeclaration']),
    'Bureau': tx(r['bureauDeclaration']),
    'Type décl.': tx(r['typeDeclaration']),
    'Destination': tx(r['destination']),
    'T1': tx(r['t1']),
    'Bon de sortie': tx(r['bonSortie']),
    'Entré le': dateHeureFr(r['dateCreation']),
    'Validé le': dateHeureFr(r['dateValidation']),
    'T1 le': dateHeureFr(r['dateT1']),
    'Bon de sortie le': dateHeureFr(r['dateBonSortie']),
    'Balisé le': dateHeureFr(r['datePoseGps']),
    'Sorti le': dateHeureFr(r['dateSortie']),
  };
}

/** Lignes du classeur, dans l'ordre affiché : une par camion, ou une par conteneur. */
export function lignesExportCellule(rows: Ligne[], estCamions: boolean): Record<string, string>[] {
  return rows.map((r) => estCamions
    ? {
      'Camion': tx(r['numeroCamion']),
      'ID': tx(r['id']),
      'Opération': tx(r['typeOperation']),
      'Statut': tx(r['statut']),
      'N° GPS': tx(r['numeroGps']),
      'Nb conteneurs': tx(r['nbConteneurs']),
      ...declarationEtPieces(r),
    }
    : {
      'Conteneur': tx(r['conteneur']),
      'Taille': tx(r['taille']),
      'Type': tx(r['type']),
      'Scellé': tx(r['scelle']),
      'Camion': tx(r['numeroCamion']),
      'ID': tx(r['cargaisonId'] ?? r['id']),
      'Opération': tx(r['typeOperation']),
      ...declarationEtPieces(r),
    });
}

/** Nom du fichier, qui dit ce qu'il contient : « rapport-pp-Enlevement-camions-2026-10-01-au-2026-10-09.xlsx ». */
export function nomFichierCellule(rapport: string, op: string, quoi: string, du: string, au: string): string {
  const net = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const periode = du || au ? `-${du || 'debut'}-au-${au || 'fin'}` : '';
  return `${['rapport', rapport, op || 'toutes-operations', quoi].map(net).filter(Boolean).join('-')}${periode}.xlsx`;
}
