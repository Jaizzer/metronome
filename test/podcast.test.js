import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSpotifyLink, podcastShouldPlay } from '../src/podcast.js';

const ID = '4rOoJ6Egrf8K2IrywzwOMk';

test('parseSpotifyLink accepts episode/show/playlist links and URIs', () => {
	assert.equal(parseSpotifyLink(`https://open.spotify.com/episode/${ID}`), `spotify:episode:${ID}`);
	assert.equal(parseSpotifyLink(`https://open.spotify.com/show/${ID}?si=abc123`), `spotify:show:${ID}`);
	assert.equal(parseSpotifyLink(` open.spotify.com/playlist/${ID}?si=x&y=1 `), `spotify:playlist:${ID}`);
	assert.equal(parseSpotifyLink(`https://open.spotify.com/intl-fr/episode/${ID}`), `spotify:episode:${ID}`);
	assert.equal(parseSpotifyLink(`spotify:episode:${ID}`), `spotify:episode:${ID}`);
});

test('parseSpotifyLink rejects everything else', () => {
	for (const bad of ['', '  ', 'hello', null, undefined, 42, `https://open.spotify.com/track/${ID}`,
		`https://evil.com/open.spotify.com/episode/${ID}`, `https://open.spotify.com.evil.com/episode/${ID}`,
		'https://open.spotify.com/episode/', `spotify:track:${ID}`, 'spotify:episode:short'])
		assert.equal(parseSpotifyLink(bad), null, String(bad));
});

const base = { autoPause: true, manualPaused: false, running: true, chunkState: 'drill', resting: false };

test('pauses during a running Drill chunk', () => {
	assert.equal(podcastShouldPlay(base), false);
});

test('plays in Maintain, when resting, and when stopped', () => {
	assert.equal(podcastShouldPlay({ ...base, chunkState: 'maintain' }), true);
	assert.equal(podcastShouldPlay({ ...base, resting: true }), true);
	assert.equal(podcastShouldPlay({ ...base, running: false }), true);
});

test('manual pause wins over auto-resume', () => {
	assert.equal(podcastShouldPlay({ ...base, manualPaused: true, chunkState: 'maintain' }), false);
	assert.equal(podcastShouldPlay({ ...base, manualPaused: true, running: false }), false);
});

test('does nothing with auto-pause off or without Drill/Maintain context', () => {
	assert.equal(podcastShouldPlay({ ...base, autoPause: false }), null);
	assert.equal(podcastShouldPlay({ ...base, chunkState: null }), null);
});
