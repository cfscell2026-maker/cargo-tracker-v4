-- ============================================================================
--  CARGO TRACKER v4.2 — TEMPS DE PASSAGE PAR POSTE
--  (demande utilisateur du 2026-08-10)
--
--  Objectif : mesurer le temps qu'un dossier passe à chaque poste — CFS, chef
--  de brigade, T1, Balise, Bon de sortie, Porte Principale — puis en tirer des
--  moyennes journalières et une performance globale « entrée du camion → sortie
--  à la PP ».
--
--  PROBLÈME À RÉSOUDRE D'ABORD : la table portait déjà les horodatages de
--  chaque cellule d'aval (date_validation, date_t1, date_pose_gps,
--  date_bon_sortie, date_sortie) mais AUCUN pour la FIN DE CHARGEMENT — le
--  moment où le CFS rend la main et où les autres cellules commencent réellement
--  à attendre. Sans lui, on ne peut ni mesurer le temps de chargement au CFS, ni
--  distinguer l'attente d'une cellule du temps passé en amont : tout se mesure
--  depuis l'entrée du camion et se mélange.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. La colonne manquante
--    Nullable À DESSEIN : les 5 000+ cargaisons déjà migrées ne l'ont pas et
--    ne peuvent pas l'avoir (l'information n'a jamais été enregistrée). Le
--    rapport le signale au lieu d'inventer une valeur.
-- ---------------------------------------------------------------------------
alter table cargaisons add column if not exists date_fin_chargement timestamptz;

comment on column cargaisons.date_fin_chargement is
  'Moment où le CFS a terminé le chargement (passage hors des statuts de chargement). '
  'Point de départ de l''attente des cellules en aval. NULL pour les cargaisons antérieures au 2026-08.';

create index if not exists cargaisons_fin_chargement_idx
  on cargaisons (date_fin_chargement)
  where date_fin_chargement is not null;

-- ---------------------------------------------------------------------------
-- 2. Le déclencheur qui la pose
--
--    DOUZE endroits du code font passer une cargaison à « Créée » : saisie CFS
--    d'un enlèvement, finalisation d'un dépotage, pose des scellés, fin de
--    chargement explicite, correction de type, flux spéciaux (conso, magasin,
--    ouillage, véhicule)… Les modifier un par un, c'est douze occasions d'en
--    oublier un — et une de plus à chaque évolution future.
--
--    On pose donc la date EN BASE, au seul endroit par lequel tout passe
--    forcément. Le déclencheur est idempotent : la date est écrite une seule
--    fois, jamais réécrite si la cargaison repasse par un statut de chargement
--    (correction de type Dépotage ↔ Enlèvement) puis en ressort.
-- ---------------------------------------------------------------------------
create or replace function fn_marquer_fin_chargement() returns trigger
language plpgsql
set search_path = pg_catalog, public, extensions as $$
begin
  if new.date_fin_chargement is null
     and new.statut is not null
     and new.statut::text not in ('Camion créé', 'En cours de chargement', 'Véhicule ouillage créé')
  then
    new.date_fin_chargement := now();
  end if;
  return new;
end $$;

revoke all on function fn_marquer_fin_chargement() from public, anon, authenticated;

-- BEFORE INSERT couvre les flux spéciaux, qui créent directement en « Créée ».
drop trigger if exists cargaisons_fin_chargement on cargaisons;
create trigger cargaisons_fin_chargement
  before insert or update of statut on cargaisons
  for each row execute function fn_marquer_fin_chargement();

-- ---------------------------------------------------------------------------
-- 3. Pas de rattrapage sur l'historique — et c'est délibéré.
--
--    On pourrait « deviner » la fin de chargement des cargaisons anciennes en
--    prenant la première date d'aval connue (validation, T1, balise…). Ce serait
--    une valeur inventée : elle ferait apparaître un temps de chargement CFS
--    faux et une attente de cellule nulle, exactement les deux chiffres que ce
--    rapport doit produire. Un indicateur de performance fondé sur une donnée
--    fabriquée est pire que pas d'indicateur.
--
--    Les lignes antérieures gardent donc NULL ; le rapport mesure pour elles ce
--    qui est réellement mesurable (le temps global entrée → sortie PP, exact) et
--    marque le détail par poste comme indisponible.
-- ---------------------------------------------------------------------------
