/**
 * Vérifie que CHAQUE action de la matrice PERMISSIONS possède un handler dans le
 * routeur (registry.ts), et inversement — garantit qu'aucune action n'est
 * exposée sans implémentation, ni implémentée sans contrôle de permission.
 * (Lit registry.ts comme TEXTE pour éviter d'importer le runtime Deno.)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { PERMISSIONS } from '../../_shared/domaine/src/index.ts';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, 'registry.ts'), 'utf8');

// Clés déclarées dans ACTIONS (chaînes entre quotes suivies de « : »).
const declarees = new Set(
  [...src.matchAll(/'([a-z]+\.[a-z0-9]+)'\s*:/gi)].map((m) => m[1]!),
);

test('chaque action de PERMISSIONS a un handler dans le routeur', () => {
  const manquantes = Object.keys(PERMISSIONS).filter((a) => !declarees.has(a));
  assert.deepEqual(manquantes, [], 'Actions sans handler : ' + manquantes.join(', '));
});

test('chaque handler du routeur correspond à une permission connue', () => {
  const inconnues = [...declarees].filter((a) => !(a in PERMISSIONS));
  assert.deepEqual(inconnues, [], 'Handlers sans permission : ' + inconnues.join(', '));
});

test('le routeur couvre les 61 actions attendues', () => {
  assert.ok(Object.keys(PERMISSIONS).length >= 61, 'PERMISSIONS incomplet');
});
