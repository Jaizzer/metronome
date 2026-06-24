// ============================================================
// db.js — all communication with Neon goes through this file.
// Nothing else in the app should know about @neondatabase/neon-js.
//
// We use SupabaseAuthAdapter rather than the native API because the
// native client.auth doesn't expose onAuthStateChange — only the
// Supabase-compatible adapter does, and main.js needs that to detect
// sign-in/out. Source: github.com/neondatabase/neon-js packages/neon-js
// README (still beta as of writing — re-check that README on upgrade).
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
