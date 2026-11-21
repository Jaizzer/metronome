import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSpotifyLink, podcastShouldPlay, spotifyVolumeMode } from '../src/podcast.js';

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
		'https://open.spotify.com/episode/', `spotify:track:${ID}`, 'spotify:episode:short', `https://open.spotify.com/episode/${ID}extra1234`])
		assert.equal(parseSpotifyLink(bad), null, String(bad));
});

const base = { autoPause: true, manualPaused: false, running: true, chunkState: 'drill', resting: false };

test('pauses during a running Drill chunk', () => {
	assert.equal(podcastShouldPlay(base), false);
});

test('resumes in Maintain, when resting, and when stopped only after our own pause', () => {
	assert.equal(podcastShouldPlay({ ...base, chunkState: 'maintain', wePaused: true }), true);
	assert.equal(podcastShouldPlay({ ...base, resting: true, wePaused: true }), true);
	assert.equal(podcastShouldPlay({ ...base, running: false, wePaused: true }), true);
});

test('never starts a podcast the user did not start', () => {
	assert.equal(podcastShouldPlay({ ...base, chunkState: 'maintain' }), null);
	assert.equal(podcastShouldPlay({ ...base, resting: true }), null);
	assert.equal(podcastShouldPlay({ ...base, running: false }), null);
});

test('manual pause wins over auto-resume', () => {
	assert.equal(podcastShouldPlay({ ...base, manualPaused: true, chunkState: 'maintain' }), false);
	assert.equal(podcastShouldPlay({ ...base, manualPaused: true, running: false }), false);
});

test('does nothing with auto-pause off or without Drill/Maintain context', () => {
	assert.equal(podcastShouldPlay({ ...base, autoPause: false }), null);
	assert.equal(podcastShouldPlay({ ...base, chunkState: null }), null);
});

test('resumes after our own pause when the context goes away (Stop, non-Song routine)', () => {
	assert.equal(podcastShouldPlay({ ...base, chunkState: null, running: false, wePaused: true }), true);
	assert.equal(podcastShouldPlay({ ...base, chunkState: null, wePaused: false }), null);
	assert.equal(podcastShouldPlay({ ...base, autoPause: false, wePaused: true }), true);
	assert.equal(podcastShouldPlay({ ...base, chunkState: null, wePaused: true, manualPaused: true }), false);
});

test('user play during Drill wins until the next chunk', () => {
	assert.equal(podcastShouldPlay({ ...base, userOverride: true }), null);
	assert.equal(podcastShouldPlay({ ...base, userOverride: true, chunkState: 'maintain' }), null);
});

test('spotifyVolumeMode: app volume only on a connected Spotify app device that reports one', () => {
	assert.equal(spotifyVolumeMode({ connected: true, playHere: false, deviceVolume: 40 }), 'app');
	assert.equal(spotifyVolumeMode({ connected: true, playHere: false, deviceVolume: 0 }), 'app');
	assert.equal(spotifyVolumeMode({ connected: true, playHere: false, deviceVolume: null }), 'none');
	assert.equal(spotifyVolumeMode({ connected: true, playHere: false }), 'none');
	// Embedded player: the Spotify iFrame API has no volume call.
	assert.equal(spotifyVolumeMode({ connected: true, playHere: true, deviceVolume: 40 }), 'embed');
	assert.equal(spotifyVolumeMode({ connected: false, playHere: false, deviceVolume: 40 }), 'embed');
});
