import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TITLE_WEIGHT,
  YEAR_WEIGHT,
  MATCH_THRESHOLD,
  AMBIGUITY_MARGIN,
  yearSimilarity,
  matchConfidence,
  isAmbiguous,
} from './lib/matcher';

test('pesos del matcher sumen 1 (70% títol / 30% any)', () => {
  assert.ok(Math.abs(TITLE_WEIGHT + YEAR_WEIGHT - 1) < 1e-9);
  assert.equal(TITLE_WEIGHT, 0.7);
  assert.equal(YEAR_WEIGHT, 0.3);
});

test('llindar d’acceptació 0.75 i marge d’ambigüitat 0.06', () => {
  assert.equal(MATCH_THRESHOLD, 0.75);
  assert.equal(AMBIGUITY_MARGIN, 0.06);
});

test('any idèntic → similarity 1', () => {
  assert.equal(yearSimilarity(2001, 2001), 1);
});

test('any diferent → similarity 0', () => {
  assert.equal(yearSimilarity(2001, 2003), 0);
});

test('any desconegut (qualsevol banda) → neutre 0.5', () => {
  assert.equal(yearSimilarity(null, 2001), 0.5);
  assert.equal(yearSimilarity(2001, null), 0.5);
  assert.equal(yearSimilarity(null, null), 0.5);
});

test('títol i any exactes → confiança 1', () => {
  assert.equal(matchConfidence('Bèsties Fantàstiques', 2016, { title: 'Bèsties Fantàstiques', year: 2016, confidence: 1 }), 1);
});

test('títol exacte però any erroni → 0.7 (no supera el llindar)', () => {
  const conf = matchConfidence('Bèsties Fantàstiques', 2016, { title: 'Bèsties Fantàstiques', year: 2018, confidence: 1 });
  assert.equal(conf, 0.7);
  assert.ok(conf < MATCH_THRESHOLD);
});

test('títol exacte sense any local → 0.85 (sí supera el llindar)', () => {
  const conf = matchConfidence('Monstre', null, { title: 'Monstre', year: null, confidence: 1 });
  assert.equal(conf, 0.85);
  assert.ok(conf >= MATCH_THRESHOLD);
});

test('confiança de títol baixa no arriba al llindar tot i coincidir l’any', () => {
  const conf = matchConfidence('Monstre', 2004, { title: 'Monster', year: 2004, confidence: 0.55 });
  assert.equal(conf, 0.7 * 0.55 + 0.3);
  assert.ok(conf < MATCH_THRESHOLD);
});

test('marge d’ambigüitat: segon candidat dins del marge → ambigüitat', () => {
  const best = { title: 'A', year: null, confidence: 0.95 };
  const second = { title: 'B', year: null, confidence: 0.92 };
  assert.ok(best.confidence - second.confidence < AMBIGUITY_MARGIN);
  assert.equal(isAmbiguous(best, second), true);
});

test('candidats llunyans → sense ambigüitat', () => {
  const best = { title: 'A', year: null, confidence: 0.95 };
  const second = { title: 'B', year: null, confidence: 0.7 };
  assert.equal(isAmbiguous(best, second), false);
});

test('sense segon candidat → mai ambigüitat', () => {
  assert.equal(isAmbiguous({ title: 'A', year: null, confidence: 0.5 }, undefined), false);
});

test('just al marge (0.06) → encara no ambigüitat estricta', () => {
  const best = { title: 'A', year: null, confidence: 1 };
  const second = { title: 'B', year: null, confidence: 0.94 };
  assert.equal(isAmbiguous(best, second), false);
});