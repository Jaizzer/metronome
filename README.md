# Metronome — Neon-backed setup

Your data (routines, mastery stats, settings) now lives in Postgres on Neon
instead of browser localStorage, so it syncs across every device you sign
into.

⚠️ **First, rotate your Neon database password.** It was pasted in plaintext
earlier in this chat. In the Neon console: **Settings → Reset password**.
None of the files below use that old credential, or any raw Postgres
connection string at all — the app talks to Neon over HTTPS instead (see
"Why no connection string" at the bottom).

## 1. One-time setup in the Neon console

1. Go to https://console.neon.tech and open your project.
2. **SQL Editor** → paste the entire contents of `sql/schema.sql` → Run.
   This creates the `practices`, `mastery_counts`, and `user_settings`
   tables with Row-Level Security so each user can only ever see their own
   rows.
3. **Auth** tab (left sidebar) → **Enable Neon Auth**. This gives you
   email/password sign-in for free with no extra service to configure.
4. **Data API** tab → **Enable Data API**. Once enabled, copy the URL shown
   there (looks like `https://app-xxxxxxxx.dpl.myneon.app`).

## 2. Configure the app

```bash
cp .env.example .env
```

Open `.env` and paste the Data API URL from step 1.4 into
`VITE_NEON_DATA_API_URL`.

## 3. Install and run

```bash
npm install
npm run dev
```

Open the URL it prints (typically `http://localhost:5173`). You'll see a
sign-in screen — click "Need an account? Sign up", enter an email and
password, confirm via the email Neon Auth sends, then sign in.

## 4. Deploy it for real (optional)

`npm run dev` is for local use only. To get a URL you can open from your
phone too:

```bash
npm run build
```

This produces a `dist/` folder of static files. Deploy that folder to any
static host — Vercel, Netlify, Cloudflare Pages, GitHub Pages all work. Set
the same `VITE_NEON_DATA_API_URL` as an environment variable in that host's
dashboard before building, since Vite bakes it in at build time.

---

## Why no connection string?

Postgres connection strings (`postgresql://user:pass@host/db`) only work
over a raw TCP protocol that browsers can't speak, and they grant full
read/write access to everything — so they can never safely live in
client-side JavaScript that anyone can view via "Inspect Element."

Neon's **Data API** solves this by exposing your tables over plain HTTPS,
the way you'd call any web API. Security comes from two things instead of a
password:

- **Row-Level Security (RLS)** in `sql/schema.sql` — the database itself
  enforces that a user can only read/write rows where `owner_id` matches
  their own account, no matter what request reaches it.
- **Neon Auth** — issues each signed-in user a token proving who they are;
  the Data API checks this token on every request.

This is also why there's a sign-in screen now — without knowing _who_ is
asking, RLS has nothing to scope access by.

## File overview

| File             | Purpose                                                                                                      |
| ---------------- | ------------------------------------------------------------------------------------------------------------ |
| `sql/schema.sql` | Tables + RLS policies. Run once in Neon's SQL editor.                                                        |
| `src/db.js`      | The only file that talks to Neon. Everything else calls this.                                                |
| `src/main.js`    | App logic — metronome engine, UI, mastery tracking. Same behavior as before, persistence rewired to `db.js`. |
| `index.html`     | Markup + styles (unchanged from your original design).                                                       |
| `.env.example`   | Template for the one secret-free config value you need.                                                      |
