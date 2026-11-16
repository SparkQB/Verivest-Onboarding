# Verivest Handover — project synopsis

> **Open security work:** see "Security review — 2026-11-16" below. Step 1 is urgent.

Written 2026-11-16 to hand this project to a new Claude account. Everything
below reflects production as of commit `76d48ea` on `main`.

## What the app is

**onboarding.verivest.com** — a 6-step form Sales fills in when a deal closes.
On submit it:

1. Downloads the uploaded files from Supabase storage (bucket `onboarding-docs`)
2. Extracts their text (PDF, DOCX, XLSX, PPTX, TXT/CSV, ZIP)
3. Runs 2–3 parallel Claude calls to write a handover brief
4. Creates a ClickUp task (status "pending sales review") with the brief as its
   description, fills custom fields, and attaches the contract file

| Piece | Where |
|---|---|
| Code | GitHub `SparkQB/Verivest-Onboarding`, branch `main` |
| Hosting | Vercel project `verivest-onboarding` (team "admin-69135851's projects"), Pro plan, deploys automatically from `main` |
| Files | Supabase project "Verivest Onboarding" (ref `bxjtftykcnlbcnhykoch`), bucket `onboarding-docs`. Uploads are deleted right after their ClickUp task is created; `api/cleanup.js` runs daily at 09:00 UTC and removes anything older than 3 days |
| AI | Anthropic API, model `claude-sonnet-4-5`, prepaid credits with auto-reload |
| Tasks | ClickUp list `901702902471` |
| CRM | HubSpot account `5708692` (read-only) |

## Files

| File | Purpose |
|---|---|
| `public/index.html` | The whole frontend: sign-in screen, 6-step form, HubSpot pre-fill box, uploads, duplicate prompt, result screen |
| `api/handover.js` | Main function (300s timeout): extraction → Claude → ClickUp |
| `api/hubspot.js` | Reads a HubSpot deal and returns form values plus notes for Claude |
| `api/login.js` | Checks @verivest.com email plus team password, issues a 30-day session |
| `api/_auth.js` | Shared session helpers (the `_` prefix means Vercel doesn't expose it as an endpoint) |
| `api/cleanup.js` | Daily cron: deletes Supabase uploads older than 3 days (protected by `CRON_SECRET`) |
| `vercel.json` | Function timeouts, cron schedule, output directory |

## Environment variables (set in Vercel → Settings → Environment Variables)

Names only; values live in Vercel and are marked Sensitive.

| Name | Used for |
|---|---|
| `ANTHROPIC_API_KEY` | Claude calls |
| `CLICKUP_API_KEY`, `CLICKUP_LIST_ID` | ClickUp task creation |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY` | File downloads (server) |
| `SITE_PASSWORD` | Team sign-in password (Production, Preview, Development) |
| `HUBSPOT_TOKEN` | HubSpot **service key** (Production, Preview, Development) |
| `CRON_SECRET` | Cleanup cron auth (Vercel sends it automatically) — **not set as of 2026-11-16**; the job refuses to run until it is |

The Supabase URL and the *public* anon key are also hard-coded in
`public/index.html` for browser uploads. That's normal for Supabase anon keys.

## What was built, in order

| Commit | Change |
|---|---|
| `feb5f19` | **PDF/extraction hardening.** PDFs try pdf-parse → unpdf (modern pdf.js) → raw stream scan. Unreadable or near-empty files are skipped and listed under "DOCUMENT EXTRACTION NOTES" in the brief instead of breaking the Claude calls. Claude calls retry 429/5xx/529 and log the real error. ClickUp fields are type-checked (phone → `+1 555 000 0000`); rejected text fields retry as one shorter line; field errors are logged and returned. |
| `b47d194` | **Duplicate-document prompt.** Uploading two files with the same base name (e.g. `OA.pdf` + `OA.docx`) asks "You've uploaded two versions of this… which version?". The server also drops near-identical documents (≥70% text overlap) and notes it in the brief. |
| `d810e83` | **Contract attached to the ClickUp task.** Files named like Verivest's contract (Fund Admin / Services Agreement, Engagement Letter, Contract, MSA, SOW, Order Form, "Verivest … Agreement") get a "📎 Will attach to ClickUp" tag and are uploaded to the task. Operating, Subscription and Partnership agreements are excluded. |
| `97aac31` | **Sign-in.** @verivest.com email plus team password (`SITE_PASSWORD`). 30-day sessions; changing the password signs everyone out; fails closed if unset. ClickUp tasks start with "Submitted by: name@verivest.com". |
| `76d48ea` | **HubSpot pre-fill.** "Start from HubSpot" box on Step 1. Paste a deal link or Record ID and steps 1–3 fill in from the deal, its linked Entity, the primary contact and the "Sales New Deal Playbook" note. Filled fields get an orange HubSpot tag, followed by warnings and a "please fill in" list. Playbook and other notes go to Claude for the brief. |

## Root cause of the original "analysis failed" bug

The Anthropic account had **run out of credits**. The old code threw the error
away, so the visible pdf-parse warnings ("Crypt not supported") looked like the
cause. Credits were topped up ($200) and auto-reload turned on. Claude failures
now show the real reason in the brief and the Vercel logs.

## HubSpot details

- Access is a HubSpot **service key** (Development → Keys; HubSpot no longer
  allows new private apps). Read-only scopes: deals, contacts, companies,
  custom objects, owners, line items, quotes, plus schema reads.
- **Entity** is custom object `2-9561141`. On a deal, the link appears as
  association key `p5708692_entity`. Many older deals have no Entity linked;
  Sales can paste the Entity link in the second box.
- **Playbook:** the HubSpot playbook writes most answers straight into deal
  properties. Remaining answers (key promises, non-standard terms, add-ons,
  anecdotal company/fund/address) are parsed from the note HTML
  (`<div><b>Question</b><ul><li>Answer</li><li><p>Notes:</p>…`). The playbook
  is new, so deals from before ~Nov 2026 mostly fill Step 1 only.
- **Mapping decisions (confirmed with the owner):**
  - Entity Type: Greenfield = new, Brownfield = conversion. HubSpot stores
    these values literally in `entity_type_s_`.
  - Service: when a deal has several Products, take the first and flag it.
    Product value `Admin` → "Full Fund Admin", `Investor Servicing` →
    "Investor Servicing Only"; other matches are 1:1 (see `SERVICE_MAP`).
  - Entity Name order: Entity record → deal `entity_name` → playbook
    "Fund:"/"Company:" line → deal name before the last "-" (flagged).
- **Finding a Record ID:** it's the last number in the HubSpot URL
  (`app.hubspot.com/contacts/5708692/record/0-3/<ID>`), or Actions → View all
  properties → "Record ID".

## How to operate it

- **Deploy:** push to `main`, and Vercel builds production automatically
  (~20s). Other branches get preview URLs, which require a Vercel login.
- **After changing an env var:** redeploy (Vercel → Deployments → ⋯ →
  Redeploy). Running deployments don't pick up new values.
- **Rotate the team password:** edit `SITE_PASSWORD` in Vercel, redeploy,
  and share the new one. Everyone is signed out.
- **Rollback:** Vercel → Deployments → pick an earlier production deploy →
  Promote.
- **Debugging:** Vercel → Logs. Useful prefixes: `[extract]`, `[dedupe]`,
  `[fund-docs]`, `[transcripts]`, `[clickup]`, `[hubspot]`, `[login]`.

## Known limitations / ideas not built

- **Cleanup cron never worked before 2026-11-16.** `CRON_SECRET` was unset
  and the job only listed the bucket root. Fixed in code (see Security
  review, step 2); it still needs `CRON_SECRET` set in Vercel.

- Each document group sent to Claude is capped at 150K characters. Ideas
  discussed: share the space fairly across documents instead of cutting the
  tail, raise the cap, or switch to `claude-sonnet-5` (cheaper, larger context).
- Scanned (image-only) PDFs can't be read; they're listed as skipped. Possible
  fix: send those PDFs to Claude directly as documents.
- The contract is detected by file name only. A contract named e.g.
  `CityPads_final.pdf` won't be attached.
- `.doc` (old Word) files aren't readable; `.docx` is.
- Browser uploads go straight to Supabase with the public anon key. The site
  sign-in hides the form, but Supabase storage policies were not tightened.
- The sign-in is one shared password. An upgrade path discussed:
  "Sign in with Google" limited to @verivest.com.
- When Claude fails, the task is still created and the form still shows
  success; only the brief text says the analysis failed.
- Cost: roughly $0.15–$0.40 of Claude usage per handover.

## Security review — 2026-11-16 (IN PROGRESS)

Sensitive client documents (PPMs, operating/subscription agreements,
financials, transcripts) pass through this app. The owner asked for stronger
protection and for assurance that no AI provider trains on the documents.

### Findings

1. **URGENT — Supabase bucket readable by anyone.** The `onboarding-docs`
   bucket (Supabase project "Verivest Onboarding", ref `bxjtftykcnlbcnhykoch`)
   is not marked public, but has a storage policy **"Allow anon downloads
   1l9vkj1_0"** (`SELECT` to `anon` on `bucket_id = 'onboarding-docs'`). The
   anon key is embedded in `public/index.html`, so anyone who loads the site
   can list and download every file. The site sign-in does not protect the
   bucket. The app does not need this policy: the browser only uploads
   (policy "Allow anon uploads 1l9vkj1_0", `INSERT` to `anon`) and the server
   downloads with the service-role key.
2. **Old files never deleted.** On 2026-11-16 the bucket held 182 files dated
   2026-08-24 to 2026-11-03. The cleanup cron isn't working (`CRON_SECRET`
   not set; see Known limitations).
3. **Uploads don't require sign-in.** Anyone with the anon key can upload to
   the bucket (they can't read anything once finding 1 is fixed).

### Agreed plan and status

| # | Step | Status |
|---|---|---|
| 1 | Remove the anon download policy: `drop policy if exists "Allow anon downloads 1l9vkj1_0" on storage.objects;` | **DONE 2026-11-16.** Verified: as the `anon` role, 0 of 182 files are visible. Only "Allow anon uploads" remains. |
| 2 | Delete all files older than **3 days**. Must go through the Storage API (service-role key); deleting rows from `storage.objects` with SQL does not remove the stored files. `api/cleanup.js` rewritten: walks every folder (the old version only listed the bucket root, so it never found the files in `fund/`, `transcripts/`…), keeps **3 days**, refuses to run without `CRON_SECRET`, runs **daily** at 09:00 UTC (`vercel.json`). Remaining: owner adds `CRON_SECRET` (any long random string) in Vercel (Production); deploy; owner clicks **Run** in Vercel → Settings → Cron Jobs; confirm with `select count(*), min(created_at) from storage.objects where bucket_id='onboarding-docs';` | **Code done and tested;** waiting on `CRON_SECRET` + deploy + first run |
| 3 | **Auto-delete after each handover:** in `api/handover.js`, once the ClickUp task is created successfully, delete that submission's files from Supabase (service-role key). The contract stays on the ClickUp task. The 3-day cron remains as a safety net for abandoned uploads. Files are only deleted after the task exists; if ClickUp task creation fails, nothing is deleted. | **Code done and tested** (`deleteUploads` in `api/handover.js`); deploys with step 2 |
| 4 | Signed-in-only uploads: server issues one-time signed upload URLs (`createSignedUploadUrl`) to signed-in users; then drop the anon upload policy so the public key can do nothing. | **Code done and tested** on branch `claude/happy-babbage-n7r3d5`: new `api/upload-url.js` (requires sign-in, server picks the path), `public/index.html` uploads with `uploadToSignedUrl`, and `api/handover.js` only accepts paths the form creates. Remaining: merge to `main` and deploy, test one upload on the live site, **then** run `drop policy if exists "Allow anon uploads 1l9vkj1_0" on storage.objects;` in Supabase → SQL Editor. Dropping the policy before the deploy would break uploads. |
| 5 | Company-owned Anthropic API key (company Console org) in `ANTHROPIC_API_KEY`; ask Anthropic about zero data retention if required | Owner to decide |
| 6 | Check AI/data settings in ClickUp ("ClickUp Brain") and HubSpot ("Breeze"), and who can see the ClickUp list | Owner to check |
| 7 | Optional: per-person "Sign in with Google" (@verivest.com) instead of the shared password | Idea only |

### AI training — what was said (verify against current terms)

- **Anthropic API** (what the app uses): covered by Anthropic's commercial
  terms. API inputs/outputs are not used for training by default; data is
  kept for a limited period; zero data retention can be arranged for
  qualifying organizations. Confirm on Anthropic's site.
- **Supabase / Vercel**: storage and hosting providers. Data is encrypted at
  rest and in transit, and DPAs are available; they are not known to train AI
  on customer files. Fine to keep **provided access is locked down** (steps
  1–4).
- **ClickUp / HubSpot**: hold the brief, contract and CRM data and have their
  own AI features; check their workspace AI settings (step 6).
- **Claude chat used for development**: has seen HubSpot client names and
  emails. Moving to the company enterprise account puts future chats under
  business terms; on personal plans check the "Help improve Claude" setting.

## Moving to a new Claude account — checklist

None of the running app depends on the Claude account. GitHub, Vercel,
Supabase, ClickUp, HubSpot and the Anthropic API key are separate services, so
the site keeps working throughout the move.

1. **Keep `main` as the source of truth.** All work is merged there; the
   working branch `claude/happy-babbage-n7r3d5` is identical to `main` apart
   from this file, if it hasn't been merged yet.
2. **Reconnect GitHub** in the new account (claude.ai → Settings → Connectors /
   Claude Code GitHub app) and give it access to `SparkQB/Verivest-Onboarding`.
   If the repo belongs to a GitHub organization, an org owner may need to
   approve the Claude GitHub App installation.
3. **Vercel needs no change.** Its GitHub link deploys from `main` regardless
   of which Claude account pushes. Optional: reconnect the Vercel connector in
   the new account so Claude can read logs and deployments.
4. **HubSpot access for Claude sessions** (only needed for future HubSpot
   work): the old account stored the service key as a cloud-environment
   network secret for `api.hubapi.com`. That does not transfer. In the new
   account, have Claude request it again with its secure credential form, and
   never paste it in chat. The app itself uses `HUBSPOT_TOKEN` in Vercel, which
   is unaffected.
5. **Clean up the old account** once the new one works: remove the
   `api.hubapi.com` network secret from the old account's Default cloud
   environment, and delete its `verivest-onboarding` environment if it's no
   longer wanted. Optionally rotate the HubSpot service key (HubSpot →
   Development → Keys) and update `HUBSPOT_TOKEN` in Vercel, then redeploy.
6. **Finish the open security steps** in "Security review — 2026-11-16" (step 1 first).
7. **Give a new Claude session this file first**: "Read docs/HANDOFF.md" is
   enough context to continue.
