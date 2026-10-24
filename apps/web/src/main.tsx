import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { prechargerExcel } from './lib/excel.ts';

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

// La bibliothèque Excel arrive APRÈS le premier affichage (voir lib/excel.ts).
prechargerExcel();
