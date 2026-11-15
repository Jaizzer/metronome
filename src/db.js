// ============================================================
// db.js — all communication with Neon goes through this file.
// Nothing else in the app should know about @neondatabase/neon-js.
//
// Two clients, same Auth URL, sharing the same session/cookies:
//
// 1. `client` — wrapped in SupabaseAuthAdapter. Used for everything:
//    signUp, signInWithPassword, getSession, onAuthStateChange, and all
//    `.from(...)` database queries. Chosen because the native client
//    doesn't expose onAuthStateChange, which main.js needs.
//
// 2. `authNative` — same Auth URL, no adapter. Used ONLY for
//    emailOtp.verifyEmail(), because that method lives on the default
//    Better Auth surface and is NOT part of SupabaseAuthAdapter's
//    documented API (confirmed against both the npm page and GitHub
//    README for @neondatabase/neon-js — signUp/signInWithPassword/
//    getSession/getUser/signOut/onAuthStateChange is the full adapter
//    surface, no emailOtp.*). Calling client.auth.emailOtp.verifyEmail
//    throws "undefined is not an object" because that path simply isn't
//    proxied through the adapter.
//
// Still a beta package as of writing — re-check the README on upgrade
// in case the adapter surface changes.
// ============================================================
import { createClient, SupabaseAuthAdapter } from '@neondatabase/neon-js';

// Set in .env (see .env.example). Vite exposes VITE_-prefixed vars
// on import.meta.env at build time.
const DIRECT_AUTH_URL = import.meta.env.VITE_NEON_AUTH_URL;
const DATA_API_URL = import.meta.env.VITE_NEON_DATA_API_URL;

// Neon Auth only trusts http://localhost:5173 (the Vite dev server), so
// that origin talks to Neon directly. Every other origin (Vercel, vercel
// dev) goes through the same-origin proxy in api/auth-proxy.js, which
// also makes the session cookie first-party. Once the production domain is
// in Neon Auth's trusted domains, drop the proxy and use DIRECT_AUTH_URL
// everywhere.
const TRUSTED_DEV_ORIGIN = 'http://localhost:5173';
const useProxy = location.origin !== TRUSTED_DEV_ORIGIN;
const AUTH_URL = useProxy ? `${location.origin}/api/auth` : DIRECT_AUTH_URL;

// While the page is being hidden/closed, Data API requests go out with
// `keepalive` so the final save isn't cancelled by the page unloading.
let keepalive = false;
export function setKeepalive(on) {
	keepalive = on;
}
const dataFetch = (input, init = {}) => fetch(input, keepalive ? { ...init, keepalive: true } : init);

export const client = createClient({
	auth: {
		adapter: SupabaseAuthAdapter(),
		url: AUTH_URL,
	},
	dataApi: {
		url: DATA_API_URL,
		options: { global: { fetch: dataFetch } },
	},
});

// Auth-only, unadapted client — same Auth URL, shares session storage
// with `client` above, used solely for the emailOtp.verifyEmail call.
const authNative = createClient({
	auth: { url: AUTH_URL },
	dataApi: { url: DATA_API_URL },
});

// ---------- Auth ----------

export async function signUp(email, password) {
	const { data, error } = await client.auth.signUp({ email, password });
	if (error) throw error;
	return data;
}

export async function signIn(email, password) {
	const { data, error } = await client.auth.signInWithPassword({ email, password });
	if (error) throw error;
	return data;
}

export async function signOut() {
	await client.auth.signOut();
}

// Verifies the OTP code Neon Auth emails after sign-up. On success this
// may auto-sign-in the user (data.session present) or just mark the email
// verified, depending on Neon's project config — main.js checks for a
// session and routes accordingly either way.
export async function verifyEmail(email, otp) {
	const { data, error } = await authNative.auth.emailOtp.verifyEmail({ email, otp });
	if (error) throw error;
	return data;
}

// Re-sends the sign-up verification code, in case the first one expired
// (Neon's codes expire after 10 minutes) or never arrived.
export async function resendVerification(email) {
	const { error } = await authNative.auth.sendVerificationEmail({ email });
	if (error) throw error;
}

export async function getSession() {
	const { data } = await client.auth.getSession();
	return data?.session ?? null;
}

export function onAuthChange(callback) {
	client.auth.onAuthStateChange((_event, session) => callback(session));
}

// ---------- Practices ----------

const PRACTICE_COLS = 'id, name, loop, metronomes, position, updated_at';

export async function fetchPractices() {
	const { data, error } = await client
		.from('practices')
		.select(PRACTICE_COLS)
		.order('position', { ascending: true });
	if (error) throw error;
	return data ?? [];
}

export async function insertPractice(practice) {
	const { data, error } = await client.from('practices').insert(practice).select().single();
	if (error) throw error;
	return data;
}

export async function fetchPractice(id) {
	const { data, error } = await client.from('practices').select(PRACTICE_COLS).eq('id', id).maybeSingle();
	if (error) throw error;
	return data;
}

// Compare-and-swap: only writes if the row is unchanged since we read it
// (updated_at is bumped by a trigger on every write). Returns the new row,
// or null when someone else wrote first. See sync.js.
export async function casUpdatePractice(id, updatedAt, patch) {
	const { data, error } = await client
		.from('practices')
		.update(patch)
		.eq('id', id)
		.eq('updated_at', updatedAt)
		.select(PRACTICE_COLS);
	if (error) throw error;
	return data?.[0] ?? null;
}

export async function deletePractice(id) {
	const { error } = await client.from('practices').delete().eq('id', id);
	if (error) throw error;
}

// ---------- Mastery counts ----------

export async function fetchMasteryCounts() {
	const { data, error } = await client
		.from('mastery_counts')
		.select('success, fail')
		.maybeSingle();
	if (error) throw error;
	return data ?? { success: 0, fail: 0 };
}

export async function fetchTotalsRow() {
	const { data, error } = await client
		.from('mastery_counts')
		.select('success, fail, updated_at')
		.maybeSingle();
	if (error) throw error;
	return data;
}

// RLS limits this to the caller's own single row.
export async function casUpdateTotals(updatedAt, success, fail) {
	const { data, error } = await client
		.from('mastery_counts')
		.update({ success, fail })
		.eq('updated_at', updatedAt)
		.select('success, fail, updated_at');
	if (error) throw error;
	return data?.[0] ?? null;
}

// First-ever write. Returns null if another device created the row first
// (unique owner_id), so the caller re-reads and merges instead.
export async function insertTotals(success, fail) {
	const { data, error } = await client
		.from('mastery_counts')
		.insert({ success, fail })
		.select('success, fail, updated_at');
	if (error) {
		if (error.code === '23505') return null;
		throw error;
	}
	return data?.[0] ?? null;
}

// ---------- User settings ----------

export async function fetchSettings() {
	const { data, error } = await client
		.from('user_settings')
		.select('show_stats, volume')
		.maybeSingle();
	if (error) throw error;
	return data ?? { show_stats: true, volume: 0.8 };
}

export async function upsertSettings(showStats, volume) {
	const { error } = await client
		.from('user_settings')
		.upsert({ show_stats: showStats, volume }, { onConflict: 'owner_id' });
	if (error) throw error;
}
