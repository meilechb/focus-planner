# Focus Planner

A private, single-user time-blocking planner. See [`SPEC.md`](./SPEC.md) for the full build specification.

## Status

Phases 1–3 (scaffold, auth backbone, planner UI) are built. Google (Phase 4) and Zoho (Phase 5) are not wired yet — the sidebar shows clearly-labelled **demo** tasks/meetings until then.

## What's here

- **Frontend:** Vite + React SPA in `src/`.
- **Backend:** Vercel serverless functions in `api/` (9 total planned; `api/_lib/` holds shared, non-counted helpers).
- **Storage:** a single JSON doc in a **private** Vercel Blob store. OAuth refresh tokens are encrypted at rest.
- **Auth:** one shared passphrase → signed, expiring HMAC session cookie.

## Run locally

```bash
npm install
npm run dev            # UI only (mock data), no backend
```

For the full stack locally (functions + Blob), use the Vercel CLI:

```bash
npm i -g vercel
vercel link
vercel env pull .env.local   # after setting env vars in the Vercel dashboard
vercel dev
```

## Deploy

Push to the repo connected to Vercel; it auto-deploys. Required environment
variables are listed in [`.env.example`](./.env.example) and documented in
`SPEC.md` §6. Create the Blob store as **private** (Storage → Create → Blob).

## Owner setup checklist (in order)

1. Import this repo into Vercel, confirm auto-deploy, get a live URL.
2. Create a **private** Blob store (auto-sets `BLOB_READ_WRITE_TOKEN`).
3. Set `APP_PASSPHRASE` and `SESSION_SECRET`.
4. (Phase 4) Google Cloud: enable Calendar + Tasks APIs, create a **Web
   application** OAuth client, add redirect `https://<LIVE-URL>/api/google/callback`.
5. (Phase 5) Zoho: create a **Server-based Application** client, add redirect
   `https://<LIVE-URL>/api/zoho/callback`.
