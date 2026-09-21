import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  // On lit .env.local ici aussi : la cible du relais est le MÊME projet Supabase
  // que celui du client, sans jamais réécrire l'adresse en dur.
  const env = loadEnv(mode, process.cwd(), '');
  const cible = env['VITE_SUPABASE_URL'] ?? '';

  /* VERSION DE LA CONSTRUCTION (2026-09-21) — l'instant du build. Elle est
     gravée dans le code ET déposée dans /version.json : l'application compare
     les deux pour savoir qu'une nouvelle version attend (lib/mise-a-jour.tsx).
     En développement, pas de version : la vérification ne tourne pas. */
  const version = mode === 'production' ? new Date().toISOString() : '';

  return {
    plugins: [
      react(),
      {
        name: 'version-app',
        apply: 'build',
        generateBundle() {
          this.emitFile({ type: 'asset', fileName: 'version.json', source: JSON.stringify({ version }) });
        },
      },
    ],
    define: { 'import.meta.env.VITE_VERSION_APP': JSON.stringify(version) },
    server: {
      // Port FIGÉ. Vite écoute sur 5173 par défaut, or ce poste héberge d'autres
      // projets Vite qui prennent le même : le premier démarré gagnait le port et
      // les suivants basculaient silencieusement ailleurs — on croyait alors
      // consulter une application en regardant l'autre.
      port: 5178,
      // Échouer bruyamment plutôt que glisser sur un autre port : si 5178 est
      // occupé, c'est qu'une instance tourne déjà, et il faut le savoir.
      strictPort: true,

      /* RELAIS DE DÉVELOPPEMENT VERS L'EDGE FUNCTION.
       *
       * SEC-07 : l'Edge Function n'accepte que les origines listées dans
       * ORIGINES_AUTORISEES, et `localhost` n'y est pas — c'est voulu, et il ne
       * faut PAS l'y ajouter : ce serait percer la liste blanche de production
       * pour une commodité de développement.
       *
       * Or le CORS est une règle appliquée par le NAVIGATEUR, pas par le
       * serveur. En passant par ce relais, le navigateur n'émet qu'une requête
       * vers localhost — même origine, donc aucun contrôle CORS — et c'est Vite
       * qui appelle Supabase, de serveur à serveur, hors de portée de la règle.
       *
       * Résultat : le développement local fonctionne sans qu'une seule ligne de
       * la configuration de production ne bouge.
       */
      proxy: {
        '/functions/v1': {
          target: cible,
          changeOrigin: true,
          configure: (proxy) => {
            // L'en-tête Origin de localhost n'a plus lieu d'être une fois côté
            // serveur : on le retire pour que l'appel soit un vrai appel
            // serveur-à-serveur, et non une origine refusée qui traîne.
            proxy.on('proxyReq', (proxyReq) => proxyReq.removeHeader('origin'));
          },
        },
      },
    },
  };
});
