// ============================================================
// api/auth-proxy.js — same-origin proxy to Neon Auth.
//
// vercel.json rewrites /api/auth/<path> here as ?__path=<path> (catch-all
// file names like [...path].js only match one segment outside Next.js).
//
// Why: Neon Auth only trusts the origin http://localhost:5173. Any other
// Origin (e.g. the Vercel URL) gets 403 INVALID_ORIGIN, and we can't
// change Neon's trusted domains from here. So the browser talks to
// `${location.origin}/api/auth/*` (same origin, first-party cookies) and
// this function forwards each request to Neon Auth with the trusted
// Origin header.
//
// CSRF: Better Auth's own origin check is what we're bypassing, so we
// re-implement it here: the request's Origin must be this app's own
// origin. Requests without an Origin header are only allowed for GET.
//
// REMOVE THIS PROXY once the production domain is added to Neon Auth's
// trusted domains (Neon console → Auth → Configuration → Domains): delete
// this file, its rewrite in vercel.json, and the `useProxy` branch in
// src/db.js. See README.md.
// ============================================================

const UPSTREAM_ORIGIN = 'http://localhost:5173';

// Request headers we forward. Everything else (host, origin, referer,
// cookies for other paths, Vercel's x-* headers) is dropped or replaced.
const FORWARD_REQUEST_HEADERS = [
	'accept',
	'accept-language',
	'authorization',
	'content-type',
	'cookie',
	'user-agent',
	'x-neon-client-info',
];

// Response headers we must not copy verbatim: fetch() already decoded the
// body, CORS headers are meaningless same-origin, and Set-Cookie is
// rewritten below.
const DROP_RESPONSE_HEADERS = new Set([
	'content-encoding',
	'content-length',
	'transfer-encoding',
	'connection',
	'keep-alive',
	'set-cookie',
	'access-control-allow-origin',
	'access-control-allow-credentials',
	'access-control-allow-headers',
	'access-control-allow-methods',
	'access-control-expose-headers',
]);

function json(status, body) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
	});
}

// The app's own origin as the browser sees it. Vercel sets x-forwarded-*;
// fall back to the request URL (vercel dev, tests).
export function appOrigin(request) {
	const url = new URL(request.url);
	const host = request.headers.get('x-forwarded-host') || request.headers.get('host') || url.host;
	const proto = (request.headers.get('x-forwarded-proto') || url.protocol.replace(':', '')).split(',')[0];
	return `${proto}://${host}`;
}

// Drop the Domain attribute so the cookie becomes host-only on the app's
// domain. Secure, SameSite, HttpOnly, Path, Expires/Max-Age are kept.
export function rewriteSetCookie(cookie) {
	return cookie
		.split(';')
		.filter((part) => !/^\s*domain\s*=/i.test(part))
		.join(';');
}

export function isAllowedOrigin(request) {
	const origin = request.headers.get('origin');
	if (!origin) return request.method === 'GET' || request.method === 'HEAD';
	return origin === appOrigin(request);
}

export async function proxy(request, upstreamBase = process.env.NEON_AUTH_URL) {
	if (!upstreamBase) return json(500, { code: 'PROXY_NOT_CONFIGURED', message: 'NEON_AUTH_URL is not set' });
	if (!isAllowedOrigin(request)) {
		return json(403, { code: 'PROXY_INVALID_ORIGIN', message: 'Cross-origin request rejected' });
	}

	const url = new URL(request.url);
	// /api/auth/sign-in/email?x=1 → <upstream>/sign-in/email?x=1. The
	// rewrite hands the sub-path over as ?__path=; fall back to the
	// pathname in case the platform passes the original URL through.
	let subPath;
	if (url.searchParams.has('__path')) {
		subPath = '/' + url.searchParams.get('__path').replace(/^\/+/, '');
		url.searchParams.delete('__path');
	} else {
		subPath = url.pathname.replace(/^\/api\/auth(-proxy)?/, '');
	}
	const target = upstreamBase.replace(/\/$/, '') + subPath + url.search;

	const headers = new Headers();
	for (const name of FORWARD_REQUEST_HEADERS) {
		const value = request.headers.get(name);
		if (value) headers.set(name, value);
	}
	headers.set('origin', UPSTREAM_ORIGIN);

	const hasBody = !['GET', 'HEAD'].includes(request.method);
	let upstream;
	try {
		upstream = await fetch(target, {
			method: request.method,
			headers,
			body: hasBody ? await request.arrayBuffer() : undefined,
			redirect: 'manual',
		});
	} catch (e) {
		return json(502, { code: 'PROXY_UPSTREAM_ERROR', message: String(e?.message || e) });
	}

	const out = new Headers();
	upstream.headers.forEach((value, name) => {
		if (!DROP_RESPONSE_HEADERS.has(name.toLowerCase())) out.set(name, value);
	});
	for (const cookie of upstream.headers.getSetCookie?.() ?? []) {
		out.append('set-cookie', rewriteSetCookie(cookie));
	}
	out.set('cache-control', upstream.headers.get('cache-control') || 'no-store');

	return new Response(request.method === 'HEAD' ? null : await upstream.arrayBuffer(), {
		status: upstream.status,
		statusText: upstream.statusText,
		headers: out,
	});
}

// Vercel passes (request, context); only the request is used.
export const GET = (req) => proxy(req);
export const HEAD = (req) => proxy(req);
export const POST = (req) => proxy(req);
export const PUT = (req) => proxy(req);
export const PATCH = (req) => proxy(req);
export const DELETE = (req) => proxy(req);
export const OPTIONS = (req) => proxy(req);
