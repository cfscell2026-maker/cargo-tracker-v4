-- ============================================================================
--  00217 — L'ARCHIVAGE MET LES STATISTIQUES À JOUR (2026-10-29)
--
--  ⚠ SANS CECI, L'ARCHIVAGE N'ACCÉLÈRE RIEN LA PREMIÈRE NUIT.
--
--  `fn_archiver_termines` modifie 19 568 lignes en une passe. Deux effets que
--  la mesure a mis au jour :
--
--  1. LE PLANIFICATEUR RAISONNE SUR DES CHIFFRES PÉRIMÉS. Ses statistiques
--     disent encore que 22 264 dossiers sont vivants ; il continue donc
--     d'estimer que l'index partiel `cargaisons_actifs_idx` ne filtre presque
--     rien, et préfère balayer la table. L'index existe, et il est ignoré.
--
--  2. UNE MISE À JOUR DE MASSE LAISSE AUTANT DE LIGNES MORTES. Tant que
--     l'autovacuum n'est pas passé, la table occupe le double de blocs et les
--     balayages sont PLUS LENTS qu'avant l'archivage. Le gain arriverait, mais
--     après coup, et entre-temps l'application paraîtrait avoir ralenti.
--
--  `analyze` répond au premier point tout de suite. Le second se résorbe seul,
--  et `analyze` le signale à l'autovacuum au passage.
--
--  Les deux commandes sont dans le même bloc protégé que la trace : une
--  statistique non rafraîchie ne doit jamais annuler un archivage déjà fait.
-- ============================================================================

create or replace function fn_archiver_termines(p_jours int default null)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_jours int := coalesce(p_jours, fn_archivage_delai_jours());
  v_seuil timestamptz := now() - make_interval(days => v_jours);
  v_n int;
begin
  with vises as (
    select c.id
    from cargaisons c
    where c.statut = 'Sortie Enregistrée'
      and c.date_sortie is not null
      and c.date_sortie < v_seuil
      and coalesce(c.archive_auto, false) = false
      and coalesce(c.archive, false) = false
      and coalesce(c.annule, false) = false
      -- L'ENGAGEMENT OUVERT RETIENT LE DOSSIER. Le camion est parti, mais la
      -- brigade attend encore : l'archiver le ferait disparaître de
      -- l'échéancier et le retard ne serait plus réclamé par personne.
      and not (coalesce(c.suivi_engagement, false) = true
               and c.engagement_effectue_le is null)
  )
  update cargaisons c
     set archive_auto    = true,
         archive_auto_le = now()
    from vises v
   where c.id = v.id;

  get diagnostics v_n = row_count;

  if v_n > 0 then
    -- SANS CECI L'INDEX PARTIEL RESTE IGNORÉ : le planificateur croirait
    -- encore que presque tous les dossiers sont vivants.
    begin
      analyze cargaisons;
    exception when others then
      raise notice 'Archivage : statistiques non rafraîchies (%).', sqlerrm;
    end;

    begin
      insert into audit_log (username, nom_complet, role, action, cargaison_id, details, prev_hash, hash)
      values ('systeme', 'Archivage automatique', 'SYSTEME', 'Archivage automatique', '',
              v_n || ' dossier(s) sorti(s) depuis plus de ' || v_jours || ' jours', '', '');
    exception when others then
      -- La trace a manqué, l'archivage tient : on ne défait pas un travail
      -- fait parce que le journal est momentanément indisponible.
      raise notice 'Archivage automatique : trace non écrite (%).', sqlerrm;
    end;
  end if;

  return v_n;
end;
$$;

comment on function fn_archiver_termines is
  'Archive (archive_auto) les dossiers SORTIS depuis plus de N jours, puis rafraîchit les statistiques pour que l''index partiel soit réellement employé. N''archive jamais un dossier en cours, annulé, ou dont l''engagement reste ouvert. Les rapports continuent de les lire. Réversible.';

revoke all on function fn_archiver_termines(int) from public, anon, authenticated;
grant execute on function fn_archiver_termines(int) to service_role;

-- Le retour en arrière rafraîchit aussi : rouvrir 19 568 dossiers sans le dire
-- au planificateur laisserait l'index partiel surestimé dans l'autre sens.
create or replace function fn_desarchiver_auto()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare v_n int;
begin
  update cargaisons set archive_auto = false, archive_auto_le = null where archive_auto = true;
  get diagnostics v_n = row_count;
  if v_n > 0 then
    begin
      analyze cargaisons;
    exception when others then
      raise notice 'Désarchivage : statistiques non rafraîchies (%).', sqlerrm;
    end;
  end if;
  return v_n;
end;
$$;

revoke all on function fn_desarchiver_auto() from public, anon, authenticated;
grant execute on function fn_desarchiver_auto() to service_role;
