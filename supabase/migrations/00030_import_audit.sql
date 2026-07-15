-- ============================================================================
--  CARGO TRACKER v4 — Import ponctuel du journal d'audit historique (v3.6).
--  La feuille « Historique » du Google Sheet (timestamp/username/nomComplet/
--  role/action/cargaisonId/details) est réinjectée dans audit_log.
--
--  Chaque ligne passe par le trigger fn_audit_chain (chaîne SHA-256 préservée),
--  car les INSERT successifs d'une boucle plpgsql se voient mutuellement.
--  On NE PEUT PAS le faire en un seul INSERT multi-lignes (le trigger lirait le
--  même prev_hash pour toutes les lignes → chaîne rompue).
-- ============================================================================
create or replace function fn_import_audit(p_rows jsonb)
returns integer language plpgsql security definer as $$
declare
  r jsonb;
  n integer := 0;
begin
  for r in select value from jsonb_array_elements(p_rows) as t(value) loop
    insert into audit_log (ts, username, nom_complet, role, action, cargaison_id, details, prev_hash, hash)
    values (
      coalesce((r->>'ts')::timestamptz, now()),
      coalesce(r->>'username', ''),
      coalesce(r->>'nom_complet', ''),
      coalesce(r->>'role', ''),
      coalesce(nullif(r->>'action', ''), '(action)'),
      coalesce(r->>'cargaison_id', ''),
      coalesce(r->>'details', ''),
      '', ''  -- écrasés par le trigger fn_audit_chain
    );
    n := n + 1;
  end loop;
  return n;
end $$;

-- Réservée au service_role (migration). Jamais exposée aux clients.
revoke all on function fn_import_audit(jsonb) from anon, authenticated;
