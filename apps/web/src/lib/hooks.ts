import { useCallback, useEffect, useState } from 'react';
import { viderCacheLecture } from './rpc.ts';

/**
 * Charge une donnée asynchrone avec état {data, loading, error} + reload.
 *
 * 2026-09-12 — `reload()` VIDE LE CACHE DE LECTURE avant de relancer, tandis
 * que le chargement automatique (montage, changement de dépendances) le laisse
 * servir. La distinction est le cœur du dispositif : demander « Actualiser »,
 * c'est dire qu'on ne fait plus confiance à ce qu'on a sous les yeux — le
 * cache doit alors s'effacer, pas répondre.
 */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const run = useCallback((fraiche = false) => {
    if (fraiche) viderCacheLecture();
    setLoading(true); setError('');
    fn().then(setData).catch((e) => setError((e as Error).message)).finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => { run(false); }, [run]);
  return { data, loading, error, reload: () => run(true) };
}
