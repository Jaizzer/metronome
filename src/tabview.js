// ============================================================
// tabview.js — everything that needs alphaTab (MPL-2.0, alphatab.net):
// reading Guitar Pro / MusicXML files, drawing a bar range as tab, and
// playing it with alphaTab's synth. main.js only loads this file with a
// dynamic import (tab import or a Tab view), so alphaTab stays out of
// the main bundle. alphaTab's own notice (separate from its MPL-2.0
// licence) asks that the "♪ alphaTab.net" credit it draws stays visible;
// hiding it needs the maintainers' permission. We never hide it.
// ============================================================
import * as alphaTab from '@coderline/alphatab';
import bravuraWoff2 from '@coderline/alphatab/font/Bravura.woff2?url';
import bravuraWoff from '@coderline/alphatab/font/Bravura.woff?url';
import soundFontUrl from '@coderline/alphatab/soundfont/sonivox.sf2?url';
import { playedRange, playedBars, TICKS_PER_QUARTER } from './tabscore.js';

alphaTab.Logger.logLevel = alphaTab.LogLevel.Warning;

// Read a Guitar Pro (3–7, .gpx), MusicXML (.musicxml, .xml, .mxl) or
// Capella file. Throws a plain-language error when it can't.
export function parseScore(bytes) {
	const settings = new alphaTab.Settings();
	try {
		const score = alphaTab.importer.ScoreLoader.loadScoreFromBytes(new Uint8Array(bytes), settings);
		if (!score?.masterBars?.length || !score.tracks?.length) throw new Error('empty');
		return score;
	} catch {
		throw new Error('This file couldn’t be read. Use a Guitar Pro (.gp, .gp3–.gp5, .gpx) or MusicXML file, or a plain-text tab.');
	}
}

// Ink colours from DESIGN.md (stock is the page behind the SVG).
const INK = {
	staffLineColor: '#968d80', // --paper-3: lines and the alphaTab attribution stay visible
	barSeparatorColor: '#968d80',
	barNumberColor: '#c2baad',
	mainGlyphColor: '#f4efe6',
	secondaryGlyphColor: '#c2baad',
	scoreInfoColor: '#c2baad',
};

const HIDDEN = [
	'ScoreTitle',
	'ScoreSubTitle',
	'ScoreArtist',
	'ScoreAlbum',
	'ScoreWords',
	'ScoreMusic',
	'ScoreWordsAndMusic',
	'ScoreCopyright',
	'GuitarTuning',
	'TrackNames',
	'ChordDiagrams',
];

function makeSettings(scale) {
	const s = new alphaTab.Settings();
	s.core.useWorkers = false; // a few bars render fast on the main thread
	s.core.enableLazyLoading = false; // draw every bar now, not when scrolled into view
	s.core.smuflFontSources = new Map([
		[alphaTab.FontFileFormat.Woff2, bravuraWoff2],
		[alphaTab.FontFileFormat.Woff, bravuraWoff],
	]);
	s.display.staveProfile = alphaTab.StaveProfile.Tab;
	s.display.layoutMode = alphaTab.LayoutMode.Page;
	s.display.scale = scale;
	s.display.justifyLastSystem = false;
	s.display.padding = [16, 8]; // room left of the staff for 3-digit bar numbers
	for (const [k, v] of Object.entries(INK)) s.display.resources[k] = alphaTab.model.Color.fromJson(v);
	for (const k of HIDDEN) s.notation.elements.set(alphaTab.NotationElement[k], false);
	s.player.playerMode = alphaTab.PlayerMode.Disabled; // the soundfont loads only on "Hear it"
	s.player.soundFont = soundFontUrl;
	s.player.enableCursor = true;
	s.player.enableUserInteraction = false;
	s.player.scrollMode = alphaTab.ScrollMode.Off;
	return s;
}

// A tab view inside `container`. show() draws bars [start, end] of one
// track; hear() plays what's shown and resolves when it ends or stops.
export function createTabView(container, { scale = 0.9 } = {}) {
	const host = document.createElement('div');
	host.className = 'tab-score';
	container.replaceChildren(host);
	const api = new alphaTab.AlphaTabApi(host, makeSettings(scale));
	let shown = null; // { score, track, start, end }
	let playing = null; // { resolve, endTick }
	let ready = null; // Promise: the synth and soundfont are loaded
	let gen = 0; // bumped by stop(): every await in hear() checks it
	let cancelWait = null;
	const listeners = new Set();
	const emit = (state) => listeners.forEach((fn) => fn(state));

	// The next render (or alphaTab's error), with a time limit.
	const rendered = () => {
		let offs = [];
		let timer;
		return new Promise((resolve, reject) => {
			offs = [api.renderFinished.on(() => resolve()), api.error.on((e) => reject(new Error(e?.message || String(e))))];
			timer = setTimeout(() => reject(new Error('drawing took too long')), 20000);
		}).finally(() => {
			clearTimeout(timer);
			offs.forEach((off) => off?.());
		});
	};

	function finish(reason) {
		if (!playing) return;
		const p = playing;
		playing = null;
		emit({ playing: false });
		p.resolve(reason);
	}

	api.playerStateChanged.on((e) => {
		host.dataset.synth = e.state === alphaTab.synth.PlayerState.Playing ? 'playing' : 'stopped'; // read by the harness
		if (e.state === alphaTab.synth.PlayerState.Playing) host.dataset.everPlayed = 'true';
		if (e.state === alphaTab.synth.PlayerState.Playing) emit({ playing: true });
		else if (e.stopped || e.state === alphaTab.synth.PlayerState.Paused) finish('stopped');
	});
	api.playerFinished.on(() => finish('finished'));
	// Backstop for the playback range: stop once the end tick is reached.
	api.playerPositionChanged.on((e) => {
		host.dataset.tick = String(e.currentTick); // where playback is (read by the harness)
		if (playing && e.currentTick >= playing.endTick) {
			api.stop();
			finish('finished');
		}
	});

	// Turn the synth on (first Hear it only) and wait until it can play.
	function loadPlayer() {
		if (ready) return ready;
		let offs = [];
		let timer;
		ready = new Promise((resolve, reject) => {
			offs = [
				api.playerReady.on(() => resolve()),
				// A soundfont that can't be fetched (offline) surfaces as an API error.
				api.error.on(() => reject(new Error('The sound for “Hear it” couldn’t be loaded. Check your connection.'))),
			];
			timer = setTimeout(() => reject(new Error('The sound for “Hear it” took too long to load')), 30000);
		})
			.finally(() => {
				clearTimeout(timer);
				offs.forEach((off) => off?.());
			})
			.catch((e) => {
				ready = null; // try again next time
				api.settings.player.playerMode = alphaTab.PlayerMode.Disabled;
				api.updateSettings();
				throw e;
			});
		api.settings.player.playerMode = alphaTab.PlayerMode.EnabledSynthesizer;
		api.updateSettings();
		api.render();
		return ready;
	}

	// Drawn as tab when the staff has strings and frets, else as notation.
	const profileFor = (score, track) =>
		(score.tracks[track]?.staves?.[0]?.tuning?.length ?? 0) > 0 ? alphaTab.StaveProfile.Tab : alphaTab.StaveProfile.Score;

	return {
		api,
		onState(fn) {
			listeners.add(fn);
			return () => listeners.delete(fn);
		},
		// Draw bars start..end of one track. Rejects when alphaTab can't.
		async show(score, track, start, end) {
			this.stop();
			const same = shown && shown.score === score && shown.track === track && shown.start === start && shown.end === end;
			if (same) return;
			shown = { score, track, start, end };
			api.settings.display.startBar = start;
			api.settings.display.barCount = end - start + 1;
			api.settings.display.staveProfile = profileFor(score, track);
			const done = rendered();
			try {
				if (api.score === score && api.tracks?.[0]?.index === track) {
					api.updateSettings();
					api.render();
				} else {
					api.renderScore(score, [track]);
				}
				await done;
			} catch (e) {
				shown = null; // so the next show() tries again
				done.catch(() => {});
				throw e;
			}
		},
		// Play bars [start, end] (a seam: up to one beat into `end`) the first
		// time the piece plays them (repeats expanded), at `bpm`; the file's
		// own tempo there is `fileTempo`. Resolves 'finished', 'stopped' or
		// 'cancelled' (stop() while the sound was still loading).
		async hear({ bpm, fileTempo, start, end, seam = false }) {
			if (!shown) throw new Error('Nothing to play');
			this.stop();
			const my = ++gen;
			const cancelled = new Promise((resolve) => (cancelWait = () => resolve('cancelled')));
			emit({ loading: true });
			try {
				let r = await Promise.race([loadPlayer(), cancelled]);
				if (r === 'cancelled' || my !== gen) return 'cancelled';
				// A newly drawn score reloads the MIDI: wait for it once more.
				if (!api.isReadyForPlayback) {
					let off;
					r = await Promise.race([new Promise((resolve) => (off = api.playerReady.on(() => resolve()))), cancelled]).finally(() => off?.());
					if (r === 'cancelled' || my !== gen) return 'cancelled';
				}
			} finally {
				if (my === gen) {
					cancelWait = null;
					emit({ loading: false });
				}
			}
			const mb = shown.score.masterBars[end - 1];
			const beatTicks = mb ? (TICKS_PER_QUARTER * 4) / (mb.timeSignatureDenominator || 4) : TICKS_PER_QUARTER;
			const range = playedRange(playedBars(api.tickCache), start, end, { seam, beatTicks });
			if (!range) throw new Error('These bars aren’t played in this file');
			api.playbackSpeed = Math.max(0.25, Math.min(2, bpm / (fileTempo || bpm)));
			api.isLooping = false;
			api.playbackRange = range;
			api.tickPosition = range.startTick;
			return new Promise((resolve) => {
				playing = { resolve, endTick: range.endTick };
				if (!api.play()) finish('failed');
			});
		},
		// Stops playback, or cancels a Hear it that is still loading.
		stop() {
			gen++;
			if (cancelWait) {
				cancelWait();
				cancelWait = null;
				emit({ loading: false });
			}
			if (!playing) return;
			api.stop();
			finish('stopped');
		},
		get isPlaying() {
			return Boolean(playing);
		},
		destroy() {
			this.stop();
			listeners.clear();
			api.destroy();
		},
	};
}
