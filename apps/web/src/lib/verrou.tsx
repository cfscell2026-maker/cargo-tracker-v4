/**
 * ============================================================================
 *  ÉCRAN DE BLOCAGE (2026-10-07, demande utilisateur).
 *
 *  Quand l'INFO bloque l'application, tous les autres comptes voient ceci par
 *  dessus leur écran, avec la raison qu'il a écrite.
 *
 *  ON NE DÉCONNECTE PERSONNE (décision utilisateur) : la session reste ouverte,
 *  l'écran se pose simplement par-dessus. Dès la réouverture, chacun reprend où
 *  il en était, sans se reconnecter et sans perdre une saisie en cours.
 *
 *  ⚠ CE N'EST PAS LA SÉCURITÉ. Cet écran est un AFFICHAGE : c'est le serveur
 *  qui refuse réellement les actions (voir `index.ts`, code 423). Supprimer ce
 *  composant dans la console du navigateur ne débloquerait rien, on verrait
 *  seulement l'application échouer action après action.
 * ============================================================================
 */
import { useEffect, useState } from 'react';
import { call } from './rpc.ts';

/** La veille : toutes les 15 s, « est-ce rouvert ? ». */
const VEILLE_MS = 15_000;

export interface EtatVerrou { actif: boolean; message: string }

/**
 * `account.me` porte l'état du verrou et traverse le blocage (le serveur le
 * laisse passer exprès). C'est par cette veille que l'écran se lève TOUT SEUL
 * à la réouverture : sans elle, chaque agent devrait recharger la page, et
 * personne ne saurait quand le faire.
 */
export function useVerrou(initial: EtatVerrou | undefined, role: string) {
  const [verrou, setVerrou] = useState<EtatVerrou>(initial ?? { actif: false, message: '' });

  useEffect(() => {
    // L'INFO n'est jamais bloqué : lui faire interroger le serveur toutes les
    // 15 s ne lui apprendrait rien et chargerait la base pour rien.
    if (role === 'INFO' || !verrou.actif) return;
    const t = setInterval(() => {
      call<{ verrou?: EtatVerrou }>('account.me')
        .then((u) => setVerrou(u.verrou ?? { actif: false, message: '' }))
        .catch(() => {});   // une veille qui échoue retente simplement au tour suivant
    }, VEILLE_MS);
    return () => clearInterval(t);
  }, [verrou.actif, role]);

  return { verrou, setVerrou };
}

/**
 * LE LOGO SOUS SUSPENSION, l'embleme du verrou.
 *
 * Le dessin parle dans le vocabulaire que l'application emploie deja : le
 * `Spinner` fait tourner un conteneur autour du logo, et son commentaire
 * l'explique, tant qu'il tourne le serveur travaille. Celui-ci en est le
 * CONTRAIRE EXACT. Le conteneur s'elance, BUTE sur une barriere baissee,
 * recule, et attend ; le tour ne s'acheve jamais. L'anneau passe en
 * pointilles : le circuit est interrompu.
 *
 * `taille` en pixels : le meme dessin sert sur l'ecran de blocage (96),
 * dans le panneau des Parametres (78) et en tete des fenetres (64). Tout se
 * derive de cette unique mesure, sans quoi il aurait fallu trois jeux de
 * regles qui auraient diverge a la premiere retouche.
 */
export function LogoVerrou({ taille = 96 }: { taille?: number }) {
  return <div className="verrou-logo" style={{ ['--t' as string]: taille + 'px' }} aria-hidden="true">
    <span className="verrou-anneau" />
    <span className="verrou-orbite"><span className="verrou-colis" /></span>
    <span className="verrou-barriere" />
    <img className="logo-rond" src="/logo.png" alt=""
      onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }} />
    <span className="verrou-pause"><i /><i /></span>
  </div>;
}

export function EcranVerrouille({ message }: { message: string }) {
  return <div className="verrou-ecran" role="alertdialog" aria-live="assertive">
    <div className="verrou-carte">
      <LogoVerrou taille={96} />
      <h1>Application momentanément bloquée</h1>
      {/* Le message écrit par l'INFO au moment du blocage. C'est tout l'intérêt
          du dispositif : « Inventaire jusqu'à 14 h » évite vingt appels
          téléphoniques qu'un refus muet aurait provoqués. */}
      {message && <p className="verrou-raison">{message}</p>}
      <p className="verrou-aide">
        Votre session reste ouverte : vous reprendrez où vous en étiez dès la réouverture,
        sans vous reconnecter. Cet écran disparaîtra tout seul.
      </p>
    </div>
  </div>;
}
