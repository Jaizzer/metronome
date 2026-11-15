// ============================================================
// dom.js — the tiny element builder shared by main.js and the tab
// import / tab view modules.
// ============================================================
import { icons } from './icons.js';

// h('button', { class: 'btn', onclick }, 'Label'). Strings become text
// nodes, so user content is never parsed as HTML.
export function h(tag, props = {}, ...children) {
	const el = document.createElement(tag);
	for (const [k, v] of Object.entries(props)) {
		if (v === undefined || v === null || v === false) continue;
		if (k === 'class') el.className = v;
		else if (k === 'html') el.innerHTML = v; // only ever our own icon markup
		else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
		else if (k in el && typeof v !== 'string') el[k] = v;
		else el.setAttribute(k, v === true ? '' : v);
	}
	for (const c of children.flat()) {
		if (c === null || c === undefined || c === false) continue;
		el.append(c instanceof Node ? c : document.createTextNode(String(c)));
	}
	return el;
}

export const iconEl = (name) => h('span', { html: icons[name], style: 'display:contents' });
