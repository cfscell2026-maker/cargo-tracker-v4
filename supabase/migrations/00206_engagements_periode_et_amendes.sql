-- ============================================================================
--  00206, ENGAGEMENTS DATÉS ET AMENDES « EFFETS NON DÉCLARÉS » (2026-10-19)
--
--  Demande utilisateur, en deux volets :
--
--  1. Les rapports BFE 03 / Transit national / Transit côtier doivent être
--     PÉRIODIQUES, en camions et en conteneurs, et datés « au moment où le chef
--     (ou un admin) met l'engagement sur la cargaison ». Cette date n'existait
--     pas : on ne connaissait que l'échéance et le solde.
--
--  2. Au moment de la validation, le chef indique si le camion a payé une
--     amende pour effets non déclarés, et son montant (forfait de 250 000 FCFA,
--     ou un autre montant). Avec des statistiques : nombre de camions, de
--     conteneurs, montant encaissé.
--
--  NORMALISATION (5FN) : CE QUI EST NEUF EST STOCKÉ UNE SEULE FOIS
--  ----------------------------------------------------------------
--  · `engagement_pose_le` dépend de la seule clé de `cargaisons` (une
--    cargaison a au plus un engagement) : sa place est dans la table, comme
--    l'échéance et le solde qu'elle complète.
--
--  · L'amende est un FAIT À PART, qui n'existe que pour quelques camions. Elle a
--    sa propre table, dont l'existence d'une ligne EST le fait « amende payée » :
--      - pas de booléen « amende oui/non » à côté d'un montant, deux champs qui
--        pourraient se contredire ;
--      - pas de colonne « forfait oui/non » : c'est le montant qui le dit
--        (forfait = 250 000), on ne stocke pas ce qui se déduit ;
--      - pas de copie du camion, des conteneurs ni du nom de l'agent : on les
--        retrouve par la cargaison et par `profils` (clé étrangère), au lieu de
--        recopier des valeurs qui divergeraient au premier renommage.
--    Une seule dépendance : cargaison_id → (montant, saisie_le, saisie_par).
--    Clé simple, aucune dépendance multivaluée ni de jointure : la table est
--    en 5FN par construction.
--
--  ⚠ MIGRATION ADDITIVE. Une colonne nullable et une table neuve. La seule
--  écriture sur l'existant est le calage de la date de pose des engagements
--  déjà posés (voir plus bas), sans quoi ils disparaîtraient des rapports.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Date de pose de l'engagement
-- ---------------------------------------------------------------------------
alter table cargaisons
  add column if not exists engagement_pose_le timestamptz;

comment on column cargaisons.engagement_pose_le is
  'Moment où l''engagement a été mis sur la cargaison : à la validation (signature '
  'du chef) ou à l''ajout après validation. Date de référence des rapports '
  'périodiques par engagement. NULL quand il n''y a pas de suivi.';

-- Calage des engagements DÉJÀ posés : la date d'ajout lue au journal quand
-- l'engagement a été ajouté après la validation, sinon la date de validation
-- (avant le 2026-10-09, un engagement ne pouvait naître qu'à la signature).
update cargaisons c
   set engagement_pose_le = coalesce(
         (select max(a.ts) from audit_log a
           where a.cargaison_id = c.id
             and a.action = 'Engagement ajouté après validation'),
         c.date_validation)
 where c.suivi_engagement is true
   and c.engagement_pose_le is null;

create index if not exists cargaisons_engagement_pose_idx
  on cargaisons (engagement_pose_le)
  where suivi_engagement is true;

-- ---------------------------------------------------------------------------
-- 2. Amendes pour effets non déclarés
-- ---------------------------------------------------------------------------
create table if not exists amendes_effets (
  cargaison_id  text        primary key references cargaisons(id) on delete cascade,
  -- En francs CFA, entier : il n'y a pas de centimes en FCFA, et un entier ne
  -- connaît pas les erreurs d'arrondi d'un nombre à virgule.
  montant       bigint      not null check (montant > 0),
  saisie_le     timestamptz not null default now(),
  saisie_par    uuid        references profils(id)
);

comment on table amendes_effets is
  'Amende payée pour effets non déclarés, une ligne par cargaison concernée. '
  'Absence de ligne = pas d''amende. Forfait = 250 000 FCFA (constante '
  'AMENDE_EFFETS_FORFAIT côté domaine) ; tout autre montant est un « autre ».';

-- Les statistiques interrogent par période de saisie.
create index if not exists amendes_effets_saisie_idx on amendes_effets (saisie_le);

-- Même politique que les autres tables : fermée aux clients, seule l'Edge
-- Function (rôle service) lit et écrit, après contrôle du rôle.
alter table amendes_effets enable row level security;
revoke all on amendes_effets from public, anon, authenticated;
