-- ============================================================================
--  00170 — Fuite d'apurement + unicité de balise active (2026-09-09)
--
--  DIAGNOSTIC À L'ORIGINE DE CETTE MIGRATION
--  -----------------------------------------
--  Mesure faite en production le 2026-09-09 (14 055 cargaisons vivantes,
--  5 980 déclarations) :
--
--    · 5 859 déclarations (98 %) n'ont AUCUN nombre de conteneurs déclaré.
--      Ce n'est pas une anomalie : le champ a été rendu facultatif par décision
--      utilisateur (« 0 = inconnu, apurement neutre », cf. helpers.ts). Aucune
--      contrainte de plafond n'est donc posée ici — elle refuserait 5 848
--      apurements dès son installation et arrêterait le flux douanier.
--
--    · Sur les 121 déclarations qui PORTENT un nombre déclaré, 34 (28 %) sont
--      sur-apurées, jusqu'à +8 conteneurs. CELLES-LÀ sont un vrai défaut.
--
--  CAUSE, ÉTABLIE PAR LECTURE DU CODE
--  ----------------------------------
--  Le compteur d'apurement ne peut QUE monter :
--
--    · `majApurement` n'est appelé que sur l'AJOUT d'un conteneur
--      (ecriture.ts, flux `cargo.cfs` et `speciaux.ts`) ;
--    · la CORRECTION d'un conteneur (`cargo.update`) calcule bien l'ancienne et
--      la nouvelle déclaration… et se contente de les écrire dans le journal ;
--    · l'ANNULATION d'une cargaison (SEC-12) la sort de tous les rapports mais
--      laisse ses conteneurs comptés comme apurés ;
--    · `fn_apurer_inc` REFUSE tout décrément (`p_nb <= 0` → exception), garde-fou
--      anti-fraude posé en 00090.
--
--  Conséquence : tout conteneur retiré, remplacé ou réaffecté laisse son +1
--  définitivement collé à sa déclaration d'origine.
--
--  ⚠ SEC-12 — le passage à la suppression LOGIQUE était une correction de
--  sécurité (ne plus détruire de pièce douanière). En ne touchant pas aux
--  compteurs, elle a introduit cette fuite. Effet de bord qu'un audit point par
--  point ne pouvait pas voir.
--
--  CE QUE FAIT CETTE MIGRATION
--  ---------------------------
--   1. `fn_apurer_dec` — le décrément qui manquait, borné à zéro.
--   2. DAT-02 — unicité de la balise sur les cargaisons ACTIVES.
--
--  CE QU'ELLE NE FAIT PAS, ET POURQUOI
--  -----------------------------------
--   · Pas de plafond d'apurement (voir ci-dessus : 98 % sans nombre déclaré).
--   · Pas de contrainte `unique (cargaison_id, conteneur)` : le diagnostic
--     compte 19 doublons en base. Un index unique ne peut PAS être créé en
--     `NOT VALID` — il échouerait. Ces 19 lignes doivent être listées et
--     arbitrées d'abord (voir `scripts/diagnostic/doublons-conteneurs.sql`).
--   · Aucune régularisation des 34 déclarations existantes : recaler des
--     compteurs douaniers est une écriture de données, elle doit être vue et
--     décidée, pas glissée dans une migration.
--
--  ⚠ MIGRATION ADDITIVE. Aucune donnée existante n'est modifiée ni supprimée.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- 1. Le décrément d'apurement
--
--    Fonction SÉPARÉE, et non un assouplissement de `fn_apurer_inc` : le refus
--    des valeurs négatives par l'incrément est une protection anti-fraude (un
--    apurement négatif = un dédouanement falsifié). On ne la relâche pas.
--
--    `p_nb` est donc POSITIF ici aussi — c'est la quantité à RETIRER. L'intention
--    est portée par le nom de la fonction, ce qui la rend lisible dans le
--    journal d'audit et impossible à confondre avec un incrément signé.
--
--    Le compteur est borné à zéro : une fuite déjà survenue ne peut pas
--    faire basculer une déclaration en négatif lors du rattrapage.
-- ---------------------------------------------------------------------------
create or replace function fn_apurer_dec(p_cle text, p_nb integer)
returns integer language plpgsql security definer
set search_path = pg_catalog, public, extensions as $$
declare v_restant integer;
begin
  if p_nb is null or p_nb <= 0 then
    raise exception 'Désapurement : quantité strictement positive attendue (reçu %).', p_nb;
  end if;
  update declarations
     set conteneurs_apures = greatest(0, conteneurs_apures - p_nb),
         derniere_maj      = now()
   where cle = p_cle
   returning greatest(0, nombre_conteneurs - conteneurs_apures) into v_restant;
  return coalesce(v_restant, 0);
end $$;

comment on function fn_apurer_dec(text, integer) is
  'Retire p_nb conteneurs de l''apurement d''une déclaration (borné à zéro). '
  'Appelée quand un conteneur est supprimé, réaffecté à une autre déclaration, '
  'ou quand sa cargaison est annulée. Complète fn_apurer_inc, qui n''accepte '
  'que des incréments positifs (garde-fou anti-fraude, migration 00090).';

-- SEC-01 — même traitement que toutes les fonctions SECURITY DEFINER : rien pour
-- PUBLIC (dont `anon` hérite), exécution accordée à la seule Edge Function.
revoke all   on function fn_apurer_dec(text, integer) from public, anon, authenticated;
grant execute on function fn_apurer_dec(text, integer) to service_role;


-- ---------------------------------------------------------------------------
-- 2. DAT-02 — Une balise GPS ne peut équiper qu'UN camion à la fois
--
--    L'audit du 2026-08-10 relevait 11 balises posées sur deux camions dont les
--    périodes se chevauchaient. Le diagnostic du 2026-09-09 compte **0** conflit
--    OUVERT : l'index peut donc être créé sans nettoyage préalable.
--
--    L'index est PARTIEL, et c'est essentiel. Une balise est un boîtier physique
--    qu'on repose sur un autre camion après chaque transit : 2 911 numéros ont
--    légitimement servi à plusieurs cargaisons dans l'histoire. Interdire cette
--    réutilisation serait un contresens métier. Ce qui doit être impossible,
--    c'est que DEUX cargaisons NON SORTIES portent la même balise — là, plus
--    personne ne sait quel camion est réellement suivi.
--
--    Le prédicat reproduit exactement celui du diagnostic qui a renvoyé 0.
-- ---------------------------------------------------------------------------
create unique index if not exists cargaisons_balise_active_unique
  on cargaisons (numero_gps)
  where numero_gps <> ''
    and statut <> 'Sortie Enregistrée'
    and annule  is not true
    and archive is not true;

comment on index cargaisons_balise_active_unique is
  'DAT-02 — une balise GPS ne peut équiper qu''une seule cargaison non sortie. '
  'Index PARTIEL : la réutilisation d''une balise après la sortie du camion est '
  'le fonctionnement normal et reste autorisée.';
