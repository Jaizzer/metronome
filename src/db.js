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
const AUTH_URL = import.meta.env.VITE_NEON_AUTH_URL;
const DATA_API_URL = import.meta.env.VITE_NEON_DATA_API_URL;

export const client = createClient({
	auth: {
		adapter: SupabaseAuthAdapter(),
		url: AUTH_URL,
	},
	dataApi: {
		url: DATA_API_URL,
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

export async function fetchPractices() {
	const { data, error } = await client
		.from('practices')
		.select('id, name, loop, metronomes, position')
		.order('position', { ascending: true });
	if (error) throw error;
	return data ?? [];
}

export async function insertPractice(practice) {
	const { data, error } = await client.from('practices').insert(practice).select().single();
	if (error) throw error;
	return data;
}

export async function updatePractice(id, patch) {
	const { data, error } = await client
		.from('practices')
		.update(patch)
		.eq('id', id)
		.select()
		.single();
	if (error) throw error;
	return data;
}

export async function deletePractice(id) {
	const { error } = await client.from('practices').delete().eq('id', id);
	if (error) throw error;
}

// Persist new ordering after a drag-and-drop reorder.
// Takes an array of { id, position } pairs.
export async function reorderPractices(order) {
	for (const { id, position } of order) {
		const { error } = await client.from('practices').update({ position }).eq('id', id);
		if (error) throw error;
	}
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

export async function upsertMasteryCounts(success, fail) {
	const { error } = await client
		.from('mastery_counts')
		.upsert({ success, fail }, { onConflict: 'owner_id' });
	if (error) throw error;
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
