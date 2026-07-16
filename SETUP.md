# Making the self-updating pipeline live

The site itself (`index.html` + `data/projects.json`) works right now with zero setup —
it's a static page. The autonomous part (daily GitHub scan → drafted project card →
email approval → auto-publish) needs four secrets that only you can create, added as
**Vercel → Project → Settings → Environment Variables**.

| Env var | What it's for | How to get it |
|---|---|---|
| `PORTFOLIO_GITHUB_TOKEN` | Reads your repos (incl. private) and commits `data/*.json` back to this repo | GitHub → Settings → Developer settings → **Fine-grained tokens** → new token scoped to your account, with **Contents: Read & write** on this repo and **Metadata/Contents: Read-only** on all repos (so it can see private repos to detect them) |
| `ANTHROPIC_API_KEY` | Drafts the problem/approach/outcome copy for a new project in your voice | [console.anthropic.com](https://console.anthropic.com) → API Keys |
| `RESEND_API_KEY` | Sends you the daily review email | [resend.com](https://resend.com) → API Keys. Free tier's `onboarding@resend.dev` sender works fine for emailing yourself — no domain verification needed to start |
| `APPROVAL_SECRET` | Signs the Publish/Skip links in the email so they can't be forged | Any long random string, e.g. `openssl rand -hex 32` |

## Analytics

Both `index.html` and `thesis.html` load `/_vercel/insights/script.js` — enable
**Web Analytics** for this project under the Vercel dashboard's Analytics tab and
it starts recording automatically. Cookie-free, no consent banner needed, nothing
to configure in code. Note: since `thesis.html` is also embedded via iframe inside
the portfolio's Research view, opening that tab counts as a `thesis.html` pageview
too — that's intentional signal for "did visitors actually engage with the demo,"
not double-counting to worry about.

Also set:
- `OWNER_EMAIL` = `briaynomwamba@gmail.com`
- `SITE_URL` = `https://port-three-taupe.vercel.app`
- `CV_URL` — a shareable link to your CV (Google Drive share link, Dropbox, etc.).
  Never committed to the repo, so the CV itself stays private; approved requesters
  get this link by email.
- `CRON_SECRET` — **required**: any random string, also add it as a Vercel Cron secret.
  Without it, `/api/scan` refuses to run at all (503) rather than running unauthenticated —
  it would otherwise be a public trigger for paid Anthropic calls, GitHub writes, and email.
- `MEDIUM_FEED` — optional; defaults to `https://medium.com/feed/@MatokeBryan`.

## What runs once those are set

- **Daily at 06:00 UTC** (`vercel.json` cron → `/api/scan`): scans all your non-fork
  GitHub repos, recomputes language stats and commits them straight to
  `data/projects.json` (no approval needed — it's just numbers), and for any repo not
  yet in `data/known-repos.json` drafts a project card with Claude and emails you two
  links: **Publish** and **Skip for now**.
- **Clicking Publish** (`/api/approve`): commits the drafted card into
  `data/projects.json`, which Vercel auto-redeploys — no code changes needed.
- **Clicking Skip**: marks the repo as dismissed so you won't be asked again unless it changes.
- **Medium articles** (`/api/medium`): the Writing view lists your latest posts by
  proxying your Medium RSS feed, edge-cached for an hour. No key needed — new posts
  appear automatically.
- **Contact form** (`/api/contact`): messages land in your inbox with reply-to set to
  the sender, honeypot-filtered against bots. Needs `RESEND_API_KEY` + `OWNER_EMAIL`.
- **Gated CV** (`/api/cv`): a visitor requests your CV with name/email/reason; you get
  an email with an Approve button; clicking it emails them the `CV_URL` link. No
  approval, no CV. Signed tokens, 14-day expiry, no database.
- **CV parser** (`/api/cv-sync`): reads the PDF at `CV_URL` (via Claude's native PDF
  support) and drafts updated `experience`/`education`/`focusAreas` entries in the
  site's existing voice, then emails an Approve link — same human-in-the-loop
  pattern as the project scanner, so a new CV never auto-publishes without a look
  first. Not on a schedule yet (there's no "CV changed" signal to poll); trigger it
  manually after updating your CV:
  ```
  curl -X POST https://your-site.vercel.app/api/cv-sync \
    -H "Authorization: Bearer $CRON_SECRET"
  ```
  or POST `{"text": "...pasted CV text..."}` instead of relying on `CV_URL`/PDF fetch.

## Known gaps / next decisions

- **Sheria AI** has no confirmed repo slug in `data/known-repos.json` yet, so the first
  scan may flag it as "new" once — just click Skip or Publish and it'll settle.
- The GitHub token's scan endpoint is currently uncapped at 5 new repos per run
  (`MAX_NEW_REPOS_PER_RUN` in `api/scan.js`) to avoid a slow first run or a large
  Anthropic bill if you bulk-create repos.
