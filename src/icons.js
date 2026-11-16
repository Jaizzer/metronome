// ============================================================
// icons.js — the app's icon set: 24px grid, 2.25 stroke, round caps
// (stroke styling lives in style.css under svg.icon).
// ============================================================

const svg = (body, cls = '') =>
	`<svg class="icon ${cls}" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${body}</svg>`;

export const icons = {
	check: svg('<path d="M4.5 12.5l5 5L19.5 7"/>'),
	cross: svg('<path d="M6 6l12 12M18 6L6 18"/>'),
	undo: svg('<path d="M9 14L4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 010 11H11"/>'),
	back: svg('<path d="M15 5l-7 7 7 7"/>'),
	minus: svg('<path d="M5 12h14"/>'),
	plus: svg('<path d="M12 5v14M5 12h14"/>'),
	prev: svg('<path d="M6 5v14"/><path d="M18 5l-9 7 9 7z"/>'),
	next: svg('<path d="M18 5v14"/><path d="M6 5l9 7-9 7z"/>'),
	play: svg('<path d="M7 4.5v15a1 1 0 001.5.86l12.5-7.5a1 1 0 000-1.72L8.5 3.64A1 1 0 007 4.5z"/>'),
	pause: svg('<rect x="6" y="4" width="4.5" height="16" rx="1"/><rect x="13.5" y="4" width="4.5" height="16" rx="1"/>'),
	grip: svg('<path d="M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01" stroke-width="3.5"/>'),
	trash: svg('<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>'),
	reset: svg('<path d="M4 4v6h6"/><path d="M5.5 15a7 7 0 101.6-7.3L4 10"/>'),
	forward: svg('<path d="M9 5l7 7-7 7"/>'),
	signout: svg('<path d="M15 4h3a2 2 0 012 2v12a2 2 0 01-2 2h-3"/><path d="M10 17l-5-5 5-5"/><path d="M5 12h11"/>'),
	list: svg('<path d="M9 6h11M9 12h11M9 18h11"/><path d="M4.5 6h.01M4.5 12h.01M4.5 18h.01" stroke-width="3"/>'),
	slides: svg('<rect x="6.5" y="4" width="11" height="16" rx="2"/><path d="M3 7.5v9M21 7.5v9"/>'),
	ramp: svg('<path d="M3 18l6-6 4 4 8-8"/><path d="M15 8h6v6"/>'),
	clock: svg('<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>'),
	loop: svg('<path d="M17 3l3 3-3 3"/><path d="M4 11V9.5A3.5 3.5 0 017.5 6H20"/><path d="M7 21l-3-3 3-3"/><path d="M20 13v1.5a3.5 3.5 0 01-3.5 3.5H4"/>'),
	layers: svg('<path d="M12 3.5l8.5 4.5L12 12.5 3.5 8z"/><path d="M3.5 12.5L12 17l8.5-4.5"/>'),
	metronome: svg('<path d="M6.5 20.5h11L14 3.5h-4z"/><path d="M12 15.5l5.5-9"/><path d="M8 15.5h8"/>'),
	cloud: svg('<path d="M7 18.5a4.5 4.5 0 01-.6-8.96A6 6 0 0118 9.5a4.5 4.5 0 01-.5 9z"/><path d="M9.5 14l2 2 3.5-3.5"/>'),
	song: svg('<path d="M9 18V5.5l11-2V16"/><circle cx="6" cy="18" r="3"/><circle cx="17" cy="16" r="3"/>'),
	sliders: svg('<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>'),
	target: svg('<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4.5"/><path d="M12 12h.01" stroke-width="3"/>'),
	importFile: svg('<path d="M14 3.5H7A2 2 0 005 5.5v13a2 2 0 002 2h10a2 2 0 002-2V8.5z"/><path d="M14 3.5v5h5"/><path d="M12 11.5v6M9 14.5l3 3 3-3"/>'),
	tab: svg('<path d="M3.5 6h17M3.5 10h17M3.5 14h17M3.5 18h17"/><path d="M8 4v16M16 4v16" stroke-width="1.5"/>'),
	speaker: svg('<path d="M4 9.5v5h3.5l5 4v-13l-5 4z"/><path d="M16 9a4 4 0 010 6M18.5 6.5a7.5 7.5 0 010 11"/>'),
	stop: svg('<rect x="6" y="6" width="12" height="12" rx="1.5"/>'),
	merge: svg('<path d="M5 4l7 7 7-7"/><path d="M12 11v9"/>'),
	split: svg('<path d="M12 3.5v17"/><path d="M8 8l-4 4 4 4M16 8l4 4-4 4"/>'),
	pencil: svg('<path d="M4 20l1-4.5L15.5 5a2 2 0 012.8 0l.7.7a2 2 0 010 2.8L8.5 19z"/><path d="M13.5 7l3.5 3.5"/>'),
	countin: svg('<path d="M4 16.5v-3M9.33 16.5v-6M14.67 16.5v-9M20 16.5v-12"/><path d="M3 20.5h18"/>'),
	expand: svg('<path d="M14 4h6v6M10 20H4v-6"/><path d="M20 4l-7 7M4 20l7-7"/>'),
	clickOnly: svg('<path d="M4 9.5v5h3.5l5 4v-13l-5 4z"/><path d="M16 9.5l5 5M21 9.5l-5 5"/>'),
	unlock: svg('<rect x="5" y="11" width="14" height="9.5" rx="2"/><path d="M8.5 11V7.5a3.5 3.5 0 016.8-1.2"/>'),
	paste: svg('<rect x="5.5" y="4.5" width="13" height="16" rx="2"/><path d="M9 4.5V3h6v1.5M9 10h6M9 14h6"/>'),
};
