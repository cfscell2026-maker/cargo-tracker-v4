/**
 * ============================================================================
 *  RAPPEL DES ENGAGEMENTS EN RETARD (2026-10-28, demande utilisateur).
 *
 *  Une fenêtre qui prévient qu'il reste des engagements en retard, revient
 *  toutes les CINQ HEURES, se ferme, et mène au volet déjà filtré sur les
 *  seuls retards.
 *
 *  ⚠ CINQ HEURES SE COMPTENT DEPUIS LE DERNIER REFUS, PAS DEPUIS L'OUVERTURE
 *  DE L'APPLICATION. C'est toute la différence entre un rappel et un
 *  harcèlement : un agent qui recharge sa page douze fois dans la matinée ne
 *  doit pas voir l'alerte douze fois. La date du dernier refus vit donc dans
 *  le navigateur, et lui survit.
 *
 *  Elle ne s'affiche QUE s'il y a réellement des retards : un rappel qui
 *  s'ouvre sur « zéro en retard » apprend à être ignoré, et le jour où il
 *  compte, il l'est aussi.
 * ============================================================================
 */
import { useEffect, useState } from 'react';
import { Icone } from './icones.tsx';

/** Cinq heures, en millisecondes. */
const RAPPEL_MS = 5 * 60 * 60 * 1000;
const CLE = 'pia.alerteEngagements.dernierRefus';

/** Lecture tolérante : un navigateur en navigation privée peut refuser. */
function dernierRefus(): number {
  try { return Number(localStorage.getItem(CLE) ?? 0) || 0; } catch { return 0; }
}
function noterRefus(): void {
  try { localStorage.setItem(CLE, String(Date.now())); } catch { /* sans mémoire, le rappel reviendra : c'est le bon sens du défaut */ }
}

/**
 * `retard` : combien d'engagements sont en retard, 0 si aucun.
 * `peut`   : ce profil suit-il les engagements ? Sinon on ne l'importune pas,
 *            il ne pourrait rien en faire.
 */
export function useAlerteEngagements(retard: number, peut: boolean) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!peut || retard <= 0) { setVisible(false); return; }
    const montrerSiTemps = () => {
      if (Date.now() - dernierRefus() >= RAPPEL_MS) setVisible(true);
    };
    montrerSiTemps();
    /* On repasse toutes les cinq minutes, pas toutes les cinq heures : une
       session ouverte toute la journée doit voir le rappel revenir, et un
       minuteur de cinq heures ne se déclencherait qu'une fois. */
    const t = setInterval(montrerSiTemps, 5 * 60 * 1000);
    return () => clearInterval(t);
  }, [retard, peut]);

  const fermer = () => { noterRefus(); setVisible(false); };
  return { visible, fermer };
}

export function AlerteEngagements({ retard, onVoir, onFermer }: {
  retard: number; onVoir: () => void; onFermer: () => void;
}) {
  return <div className="alerte-eng" role="alertdialog" aria-live="polite"
    aria-label={`${retard} engagement(s) en retard`}>
    <button type="button" className="alerte-eng-corps"
      onClick={() => { onFermer(); onVoir(); }}
      title="Ouvrir les engagements en retard">
      <span className="alerte-eng-icone" aria-hidden="true"><Icone nom="sablier" taille={20} /></span>
      <span className="alerte-eng-texte">
        <b>{retard} engagement(s) en retard</b>
        <span>Les informations n’ont pas été transmises dans le délai. Cliquez pour les voir.</span>
      </span>
      <span className="alerte-eng-aller" aria-hidden="true"><Icone nom="chevron" taille={16} /></span>
    </button>
    {/* LE BOUTON DE FERMETURE EST A PART, et non dans la zone cliquable : au
        centre d'un bandeau qui emmène ailleurs, une croix qui navigue serait
        un piège. */}
    <button type="button" className="alerte-eng-fermer" onClick={onFermer}
      aria-label="Fermer ce rappel" title="Fermer. Le rappel reviendra dans cinq heures.">✕</button>
  </div>;
}
