-- Comptages du compte rendu de sauvegarde : « libellé|valeur », une ligne chacun.
-- Lus par compte_rendu.py ; jamais affichés dans le journal (dépôt public).
select 'Dossiers (cargaisons)', count(*)::text from cargaisons
union all select 'Dossiers actifs (ni annulés ni archivés)', count(*)::text from cargaisons where annule is not true and archive is not true
union all select 'Engagements en cours', count(*)::text from cargaisons where suivi_engagement is true and engagement_effectue_le is null
union all select 'Engagements apurés', count(*)::text from cargaisons where suivi_engagement is true and engagement_effectue_le is not null
union all select 'Conteneurs au stock', count(*)::text from stock
union all select 'Comptes utilisateurs', count(*)::text from profils
union all select 'Lignes du journal d''audit', count(*)::text from audit_log
union all select 'Taille de la base', pg_size_pretty(pg_database_size(current_database()));
