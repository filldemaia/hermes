import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseEpisode, looksLikeEpisode, ensureUniqueEpisodes, parseMovieVersion } from './media/scanner';

test('T01x05 → temporada 1 episodi 5', () => {
  const r = parseEpisode('T01x05', '');
  assert.deepEqual(r, { season: 1, ep: 5, title: null, file: 'T01x05', isVersion: false });
});

test('S02E03 → temporada 2 episodi 3', () => {
  const r = parseEpisode('S02E03', '');
  assert.deepEqual(r, { season: 2, ep: 3, title: null, file: 'S02E03', isVersion: false });
});

test('Steins;Gate - S01E01 → temporada 1 episodi 1', () => {
  const r = parseEpisode('Steins;Gate - S01E01', 'Steins;Gate');
  assert.equal(r!.season, 1);
  assert.equal(r!.ep, 1);
});

test('OVA a soles → temporada 0, sense número', () => {
  const r = parseEpisode('OVA', '');
  assert.equal(r!.season, 0);
  assert.equal(r!.ep, null);
});

test('OVA - La pel·lícula → temporada 0 amb títol', () => {
  const r = parseEpisode('OVA - La pel·lícula', '');
  assert.equal(r!.season, 0);
  assert.equal(r!.ep, null);
  assert.equal(r!.title, 'La pel·lícula');
});

test('Monster - 01 - El Dr Tenma → temporada null, episodi 1, títol', () => {
  const r = parseEpisode('Monster - 01 - El Dr Tenma', 'Monstre');
  assert.deepEqual({ s: r!.season, e: r!.ep, t: r!.title }, { s: null, e: 1, t: 'El Dr Tenma' });
});

test('Monster - 01 (nom títol) → episodi sense títol redundant', () => {
  const r = parseEpisode('Monster - 01', 'Monster');
  assert.equal(r!.ep, 1);
  assert.equal(r!.title, null);
});

test('Episodi 3 → temporada 1 episodi 3', () => {
  const r = parseEpisode('Episodi 3', 'Sèrie');
  assert.equal(r!.season, 1);
  assert.equal(r!.ep, 3);
});

test('Episodi 3 (Títol X) → temporada 1 episodi 3', () => {
  const r = parseEpisode('Episodi 3 (Títol X)', 'Sèrie');
  assert.equal(r!.season, 1);
  assert.equal(r!.ep, 3);
});

test('cap patró → no és episodi', () => {
  assert.equal(parseEpisode('Bèsties Fantàstiques i on trobar-les (2016)', 'Bèsties Fantàstiques i on trobar-les (2016)'), null);
  assert.equal(looksLikeEpisode('Harry Potter i la Pedra Filosofal - Theatrical'), false);
});

test('looksLikeEpisode reconeix patrons d’episodi', () => {
  assert.equal(looksLikeEpisode('T01x01'), true);
  assert.equal(looksLikeEpisode('S03E07'), true);
  assert.equal(looksLikeEpisode('Episodi 2'), true);
});

test('versions de pel·lícula (season null) no es renumeren', () => {
  const parsed = [
    { season: null, ep: null, title: null, file: 'a - Theatrical', isVersion: true },
    { season: null, ep: null, title: null, file: 'a - Extended', isVersion: true },
  ];
  ensureUniqueEpisodes(parsed as never);
  assert.equal(parsed[0].ep, null);
  assert.equal(parsed[1].ep, null);
});

test('episodis duplicats es renumeren seqüencialment', () => {
  const parsed = [
    { season: 1, ep: 1, title: null, file: 'T01x01', isVersion: false },
    { season: 1, ep: 1, title: null, file: 'T01x01 - alt', isVersion: false },
  ];
  ensureUniqueEpisodes(parsed);
  assert.equal(parsed[0].ep, 1);
  assert.equal(parsed[1].ep, 2);
});

test('duplicats amb forats: se salta el primer lliure', () => {
  const parsed = [
    { season: 1, ep: 1, title: null, file: 'a', isVersion: false },
    { season: 1, ep: 3, title: null, file: 'b', isVersion: false },
    { season: 1, ep: 1, title: null, file: 'c', isVersion: false },
  ];
  ensureUniqueEpisodes(parsed);
  assert.equal(parsed[0].ep, 1);
  assert.equal(parsed[2].ep, 2);
});

test('parseMovieVersion: extensió després de guió', () => {
  assert.equal(parseMovieVersion("Pedra Filosofal - Extended", "Pedra Filosofal"), "Extended");
});

test('parseMovieVersion: mateix nom sense extensió → Pel·lícula', () => {
  assert.equal(parseMovieVersion('Bèsties Fantàstiques', 'Bèsties Fantàstiques'), 'Pel·lícula');
});