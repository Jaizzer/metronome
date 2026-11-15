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
};
