// ============================================================
// tabview.js — everything that needs alphaTab (MPL-2.0, alphatab.net):
// reading Guitar Pro / MusicXML files, drawing a bar range as tab, and
// playing it with alphaTab's synth. main.js only loads this file with a
// dynamic import (tab import or a Tab view), so alphaTab stays out of
// the main bundle. alphaTab's "♪ alphaTab.net" attribution in the drawn
// tab is part of its licence terms and stays visible.
// ============================================================
import * as alphaTab from '@coderline/alphatab';
import bravuraWoff2 from '@coderline/alphatab/font/Bravura.woff2?url';
import bravuraWoff from '@coderline/alphatab/font/Bravura.woff?url';
import soundFontUrl from '@coderline/alphatab/soundfont/sonivox.sf2?url';

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
	s.display.padding = [4, 8]; // the panel has its own margins
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
	let playerOn = false;
	const listeners = new Set();
	const emit = (state) => listeners.forEach((fn) => fn(state));

	const rendered = () => new Promise((resolve) => {
		const off = api.renderFinished.on(() => {
			off?.();
			resolve();
		});
	});

	api.error.on((e) => emit({ error: e?.message || String(e) }));

	function finish(reason) {
		if (!playing) return;
		const p = playing;
		playing = null;
		emit({ playing: false });
		p.resolve(reason);
	}

	api.playerStateChanged.on((e) => {
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

	return {
		api,
		onState(fn) {
			listeners.add(fn);
			return () => listeners.delete(fn);
		},
		async show(score, track, start, end) {
			if (playing) this.stop();
			const same = shown && shown.score === score && shown.track === track && shown.start === start && shown.end === end;
			if (same) return;
			shown = { score, track, start, end };
			api.settings.display.startBar = start;
			api.settings.display.barCount = end - start + 1;
			const done = rendered();
			if (api.score === score && api.tracks?.[0]?.index === track) {
				api.updateSettings();
				api.render();
			} else {
				api.renderScore(score, [track]);
			}
			await done;
		},
		// Play ticks range.startTick..range.endTick of the score (the MIDI
		// always holds the whole piece) at `bpm`; the file's own tempo there
		// is `fileTempo`.
		async hear({ bpm, fileTempo, range }) {
			if (!range) throw new Error('Nothing to play');
			if (!shown) throw new Error('Nothing to play');
			if (playing) this.stop();
			emit({ loading: true });
			if (!playerOn) {
				playerOn = true;
				const ready = new Promise((resolve, reject) => {
					const offReady = api.playerReady.on(() => {
						offReady?.();
						resolve();
					});
					api.soundFontLoadFailed?.on?.(() => reject(new Error('The sound for “Hear it” couldn’t be loaded')));
				});
				api.settings.player.playerMode = alphaTab.PlayerMode.EnabledSynthesizer;
				api.updateSettings();
				api.render();
				await Promise.race([
					ready,
					new Promise((_, reject) => setTimeout(() => reject(new Error('The sound for “Hear it” took too long to load')), 30000)),
				]).catch((e) => {
					playerOn = false;
					api.settings.player.playerMode = alphaTab.PlayerMode.Disabled;
					api.updateSettings();
					emit({ loading: false });
					throw e;
				});
			}
			if (!api.isReadyForPlayback) {
				await new Promise((resolve) => {
					const off = api.playerReady.on(() => {
						off?.();
						resolve();
					});
				});
			}
			api.playbackSpeed = Math.max(0.25, Math.min(2, bpm / (fileTempo || bpm)));
			api.isLooping = false;
			api.playbackRange = { startTick: range.startTick, endTick: range.endTick };
			api.tickPosition = range.startTick;
			emit({ loading: false });
			return new Promise((resolve) => {
				playing = { resolve, endTick: range.endTick };
				if (!api.play()) finish('failed');
			});
		},
		stop() {
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
