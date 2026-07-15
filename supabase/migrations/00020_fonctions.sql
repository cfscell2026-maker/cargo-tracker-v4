-- ============================================================================
--  CARGO TRACKER v4 — Fonctions métier atomiques
--  Remplacent les LockService de la v3.6 par des opérations SQL atomiques.
-- ============================================================================

-- Incrémente l'apuré d'une déclaration existante ; renvoie le restant à apurer.
-- (La création d'une déclaration absente reste gérée côté Edge Function, qui
--  exige le « nombre de conteneurs déclarés ».)
create or replace function fn_apurer_inc(p_cle text, p_nb integer)
returns integer language plpgsql security definer as $$
declare v_restant integer;
begin
  update declarations
     set conteneurs_apures = conteneurs_apures + p_nb, derniere_maj = now()
   where cle = p_cle
   returning greatest(0, nombre_conteneurs - conteneurs_apures) into v_restant;
  return coalesce(v_restant, 0);
end $$;

-- Lie un conteneur du stock à une cargaison et le marque « Dépoté »
-- (idempotent : sans effet si le TC est absent). Équivalent _lierStock_.
create or replace function fn_lier_stock(p_tc text, p_cargaison_id text)
returns void language plpgsql security definer as $$
begin
  update stock
     set statut = 'Dépoté', date_depote = now(), cargaison_id = p_cargaison_id
   where numero_tc = p_tc;
end $$;

revoke all on function fn_apurer_inc(text, integer) from anon, authenticated;
revoke all on function fn_lier_stock(text, text) from anon, authenticated;
