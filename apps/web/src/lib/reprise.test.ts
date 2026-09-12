/**
 * Tests de la reprise sur panne de plateforme.
 *
 * Ce qui est vérifié ici n'est pas « est-ce que ça rejoue », mais surtout
 * « est-ce que ça NE rejoue PAS ce qu'il ne faut pas ». Un rejeu d'écriture sur
 * un outil douanier, c'est une double validation : le défaut sûr compte plus
 * que le cas passant.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  attenteAvantReprise, estSansEffet, estTransitoire, messageTechnique, REPRISES_MAX,
} from './reprise.ts';

test('toutes les lectures `report.*` sont rejouables', () => {
  for (const a of ['report.validationdecl', 'report.cfs', 'report.engagements', 'report.archive']) {
    assert.equal(estSansEffet(a), true, a);
  }
});

test('les lectures nommées une à une sont rejouables', () => {
  for (const a of ['cargo.get', 'cargo.search', 'cargo.checkdup', 'dashboard.stats', 'user.list', 'account.me']) {
    assert.equal(estSansEffet(a), true, a);
  }
});

test('AUCUNE écriture n\'est rejouable', () => {
  const ecritures = [
    'cargo.valider', 'cargo.validerlot', 'cargo.createcamion', 'cargo.delete',
    'cargo.sortie', 'cargo.gps', 'decl.apurementedit', 'user.create',
    'stock.pointage', 'entrepot.sortie', 'account.changepwd',
  ];
  for (const a of ecritures) assert.equal(estSansEffet(a), false, a);
});

test('les pièges du registre restent du côté « écriture »', () => {
  // `cargo.lotcamions` vit dans ecriture.ts et `cargo.ouillagedecl` dans
  // speciaux.ts, malgré des noms qui sonnent comme des lectures.
  assert.equal(estSansEffet('cargo.lotcamions'), false);
  assert.equal(estSansEffet('cargo.ouillagedecl'), false);
});

test('une action inconnue est traitée comme une écriture', () => {
  // Le défaut sûr : une action ajoutée au registre sans être déclarée ici ne
  // devient pas rejouable par accident.
  assert.equal(estSansEffet('cargo.actionQuiNExistePasEncore'), false);
});

test('546 et les pannes de passerelle sont transitoires, pas 429 ni 400', () => {
  for (const s of [0, 502, 503, 504, 546]) assert.equal(estTransitoire(s), true, String(s));
  // 429 arrive dans une enveloppe normale : le rejouer aggraverait la limite.
  for (const s of [200, 400, 401, 429, 500]) assert.equal(estTransitoire(s), false, String(s));
});

test('l\'attente croît et l\'ensemble reste sous la seconde et demie', () => {
  assert.ok(attenteAvantReprise(2) > attenteAvantReprise(1));
  let total = 0;
  for (let i = 1; i <= REPRISES_MAX; i++) total += attenteAvantReprise(i);
  assert.ok(total <= 1500, `total ${total} ms`);
});

test('le 546 ne produit plus jamais « Erreur inconnue »', () => {
  const corps = { code: 'WORKER_RESOURCE_LIMIT', message: 'Function failed due to not having enough compute resources' };
  for (const sansEffet of [true, false]) {
    const m = messageTechnique(546, corps, sansEffet);
    assert.ok(!/inconnue/i.test(m), m);
    assert.ok(m.includes('546'), m);
  }
});

test('après une ÉCRITURE ratée, le message avertit du doublon possible', () => {
  const m = messageTechnique(546, { code: 'WORKER_RESOURCE_LIMIT' }, false);
  assert.match(m, /PEUT-ÊTRE été enregistrée/);
  assert.match(m, /vérifi/i);
  // La lecture, elle, se relance sans risque : pas d'avertissement inutile.
  assert.doesNotMatch(messageTechnique(546, { code: 'WORKER_RESOURCE_LIMIT' }, true), /PEUT-ÊTRE/);
});

test('une coupure réseau sur une écriture dit que rien n\'est parti', () => {
  assert.match(messageTechnique(0, null, false), /n'est pas partie/);
  assert.match(messageTechnique(0, null, true), /réseau/i);
});

test('un statut inattendu reprend le message du serveur et cite le code', () => {
  const m = messageTechnique(503, { message: 'upstream connect error' }, true);
  assert.match(m, /503/);
  assert.match(m, /upstream connect error/);
});

test('un corps sans message exploitable le dit, plutôt que de rester muet', () => {
  const m = messageTechnique(500, null, true);
  assert.match(m, /500/);
  assert.match(m, /sans message exploitable/);
});

/* ---- Le message d'une extraction trop vaste — 2026-09-12 ---------------
 *
 * Mesuré en production : `report.cargaisons` passe avec un critère et échoue
 * sans. Le message doit donc distinguer les deux, sans quoi il envoie l'agent
 * recliquer indéfiniment sur une demande qui ne passera jamais.
 */
test('extraction SANS critère : le message dit de restreindre, pas d\'attendre', () => {
  const m = messageTechnique(546, {}, true, { action: 'report.cargaisons', data: { format: 'xlsx' } });
  assert.match(m, /Restreignez/);
  assert.doesNotMatch(m, /patientez/i, 'réessayer ne changera rien : ne pas le suggérer');
});

test('extraction AVEC un critère : on retombe sur le message de saturation', () => {
  for (const critere of [{ du: '2026-09-01' }, { statut: 'Créée' }, { etape: 'T1' }, { search: 'TG' }]) {
    const m = messageTechnique(546, {}, true, {
      action: 'report.cargaisons', data: { format: 'xlsx', ...critere },
    });
    assert.match(m, /patientez/i, `un critère (${Object.keys(critere)[0]}) rend la demande légitime`);
  }
});

test('une lecture ordinaire garde le message de saturation', () => {
  const m = messageTechnique(546, {}, true, { action: 'cargo.list', data: {} });
  assert.match(m, /patientez/i);
});

test('sans origine connue, le comportement d\'avant est conservé', () => {
  assert.match(messageTechnique(546, {}, true), /patientez/i);
});

test('une ÉCRITURE interrompue avertit toujours du doute sur l\'enregistrement', () => {
  const m = messageTechnique(546, {}, false, { action: 'cargo.valider', data: {} });
  assert.match(m, /PEUT-ÊTRE/);
});
