# 10. Deployment

From a working local app to something on the internet with HTTPS. Four hosting
options, in rising order of effort.

---

## 10.1 What has to change for production

Six things. Everything else works as-is.

| # | Local | Production | Why |
|---|---|---|---|
| 1 | SQLite file | **Postgres** (already wired into the Docker image) | SQLite has one writer; a restart on ephemeral disk loses it |
| 2 | Vite on :5173 | **server serves `web/dist`** | one origin, so CORS and cookie-domain problems disappear |
| 3 | `prisma db push` | **`prisma migrate deploy`** (runs on container boot) | `db push` can drop columns to match the schema |
| 4 | `secure: false` cookie | **`secure: true`** via `NODE_ENV=production` | the session cookie must be HTTPS-only |
| 5 | `localhost` redirect URI | **your real domain**, added in Google Cloud | OAuth rejects anything not listed |
| 6 | `storage/` on disk | **a mounted volume** (or S3) | generated PDFs must survive a redeploy |

Items 1–4 are already handled by the code and the Docker image; they just need
the env vars.

```mermaid
flowchart LR
    subgraph DEV["Development"]
        V["Vite :5173"] -->|"CORS + cookie"| S1["Express :4000"]
        S1 --> SQ[("SQLite file")]
    end

    subgraph PROD["Production"]
        B["Browser"] -->|"one origin, HTTPS"| S2["Express :4000<br/>+ web/dist"]
        S2 --> PG[("Postgres")]
        S2 --> VOL[("volume<br/>storage/")]
    end
```

---

## 10.2 Step 1 — Postgres: already done, here is how it works

Prisma cannot choose a database provider from an environment variable, so the
repo carries two schema files:

| File | Provider | Used by |
|---|---|---|
| `server/prisma/schema.prisma` | `sqlite` | local development (`npm run dev`) — **edit this one** |
| `server/prisma/postgres/schema.prisma` | `postgresql` | the Docker image — **generated**, never edited by hand |
| `server/prisma/postgres/migrations/` | `postgresql` | applied by `prisma migrate deploy` on every container boot |

The Postgres schema is produced by `server/scripts/postgres-schema.mjs`, which
copies the SQLite schema and swaps the provider. The models cannot drift
apart because there is only one place to write them.

The image builds its Prisma client from the Postgres schema and its entrypoint
is:

```bash
npx prisma migrate deploy --schema=prisma/postgres/schema.prisma && node dist/index.js
```

So `docker compose up --build` works on a fresh clone with no extra steps.

### When you change a model

```bash
# 1. edit server/prisma/schema.prisma, then locally:
npm run db:push                       # update your SQLite dev database

# 2. regenerate the Postgres schema and create a migration for it
docker run --rm -d --name cortex-pg -p 5432:5432 \
  -e POSTGRES_PASSWORD=dev -e POSTGRES_DB=cortex postgres:16-alpine

DATABASE_URL="postgresql://postgres:dev@localhost:5432/cortex" \
  npm run db:pg:migrate -- --name add_something

git add server/prisma && git commit -m "feat(db): add something"
docker rm -f cortex-pg
```

> ⚠️ **Migrations must be committed.** The container applies committed
> migration files; it never generates them. CI enforces this twice: it fails if
> `postgres/schema.prisma` is stale (`npm run db:pg:sync -- --check`), and it
> applies the migrations to a real Postgres and fails if they do not produce
> exactly the schema (`prisma migrate diff --exit-code`).

### Staying on SQLite instead

Viable for a single-instance deploy *if* the file is on a persistent volume. The
Docker image is Postgres-only, so run it directly with Node instead:

```bash
npm ci && npm run build
DATABASE_URL="file:/data/cortex.db" npm run db:push   # /data is a persistent disk
NODE_ENV=production SERVE_WEB=true DATABASE_URL="file:/data/cortex.db" npm start
```

One writer and no horizontal scaling, but genuinely fine for personal use. Be
ready to say why you would not do it for a team.

---

## 10.3 Step 2 — Google Cloud for a real domain

1. **APIs & Services → Credentials →** your OAuth client
2. Add to **Authorised redirect URIs**:
   ```
   https://your-domain.com/api/auth/google/callback
   ```
   Keep the localhost one so development still works.
3. **OAuth consent screen → Publish app** to lift the 100-test-user cap.
   Verification is only needed for sensitive scopes at scale; a personal
   deployment can stay in Testing with your own address as a test user.

---

## 10.4 Step 3 — generate the production secret

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

A **different** secret from development. Rotating it invalidates every session,
which is the only revocation mechanism this design has.

---

## 10.5 The production environment

```bash
NODE_ENV=production
PORT=4000

# One origin serves both the API and the UI.
APP_URL=https://your-domain.com
SERVER_URL=https://your-domain.com
SERVE_WEB=true

DATABASE_URL=postgresql://user:pass@host:5432/cortex
SESSION_SECRET=<the new 64-char hex>

LLM_PROVIDER=google
GOOGLE_API_KEY=...
# Strongly recommended: one provider outage otherwise takes the app down.
LLM_FALLBACK_PROVIDER=groq
GROQ_API_KEY=...

GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GOOGLE_REDIRECT_URI=https://your-domain.com/api/auth/google/callback

TAVILY_API_KEY=...
REMINDER_CRON=*/5 * * * *
```

`SERVE_WEB=true` is what makes the single-origin deploy work:

```ts
// server/src/app.ts — the SPA fallback, after every API route
if (env.serveWeb) {
  app.use(express.static(webDist, { index: false, setHeaders: /* cache rules */ }));
  app.get(/^\/(?!api|mcp|health).*/, (_req, res) => {
    res.sendFile(path.join(webDist, "index.html"));
  });
}
```

The negative lookahead matters: without it the fallback would swallow `/api/*` and
every API call would return the HTML shell.

---

## 10.6 Option A — Docker Compose on any VPS

The most portable option, and the one that works on a €5 box.

```bash
git clone https://github.com/X-Rachit-X/AI_Secretary.git
cd AI_Secretary

cp .env.example .env
nano .env                      # fill in the production values above

docker compose up -d --build
docker compose logs -f app
```

The stack:

```mermaid
graph LR
    I["internet :443"] --> C["Caddy<br/>auto HTTPS"]
    C --> A["app :4000<br/>API + web/dist"]
    A --> P[("postgres:16")]
    A --> V[("volume: storage/")]
```

### Adding HTTPS with Caddy

Caddy obtains and renews certificates automatically. Add to
`docker-compose.yml`:

```yaml
  caddy:
    image: caddy:2-alpine
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy-data:/data
      - caddy-config:/config
    depends_on:
      - app

volumes:
  caddy-data:
  caddy-config:
```

`Caddyfile`:

```
your-domain.com {
    reverse_proxy app:4000 {
        # SSE must not be buffered, or progress events arrive all at once.
        flush_interval -1
    }
}
```

> ⚠️ `flush_interval -1` is the SSE fix for Caddy. nginx needs
> `proxy_buffering off;` plus `proxy_read_timeout 300s;`. Without it the app
> works but every answer appears in one lump at the end — the most common
> "streaming is broken in production" cause.

Then point your DNS A record at the server and remove the `ports:` block from the
`app` service so only Caddy is exposed.

### Operating it

```bash
docker compose logs -f app              # follow logs
docker compose ps                       # health status
docker compose exec db pg_dump -U cortex cortex > backup.sql
docker compose pull && docker compose up -d --build    # deploy an update
```

---

## 10.7 Option B — Fly.io

Good fit: global edge, cheap, persistent volumes, managed Postgres.

```bash
curl -L https://fly.io/install.sh | sh
fly auth login
fly launch --no-deploy        # answer no to Postgres, we create it next
```

`fly.toml`:

```toml
app = "cortex-one"
primary_region = "iad"

[build]
  dockerfile = "Dockerfile"

[env]
  NODE_ENV = "production"
  PORT = "4000"
  SERVE_WEB = "true"
  WEB_DIST_PATH = "/app/web/dist"

[http_service]
  internal_port = 4000
  force_https = true
  auto_stop_machines = "suspend"
  auto_start_machines = true
  # The cron sweep needs a machine awake. Set this to 0 only if you are happy
  # for reminders to pause while the app is idle.
  min_machines_running = 1

  [http_service.concurrency]
    type = "requests"
    soft_limit = 50
    hard_limit = 100

[[http_service.checks]]
  interval = "30s"
  timeout = "5s"
  grace_period = "20s"
  method = "GET"
  path = "/health"

# Generated PDFs, decks and images.
[[mounts]]
  source = "cortex_storage"
  destination = "/app/server/storage"
```

```bash
fly postgres create --name cortex-db --region iad
fly postgres attach cortex-db          # sets DATABASE_URL automatically

fly volumes create cortex_storage --region iad --size 1

fly secrets set \
  SESSION_SECRET="$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')" \
  GOOGLE_API_KEY="..." \
  GOOGLE_CLIENT_ID="..." \
  GOOGLE_CLIENT_SECRET="..." \
  GOOGLE_REDIRECT_URI="https://cortex-one.fly.dev/api/auth/google/callback" \
  APP_URL="https://cortex-one.fly.dev" \
  SERVER_URL="https://cortex-one.fly.dev" \
  TAVILY_API_KEY="..."

fly deploy
fly logs
```

> ⚠️ `auto_stop_machines` with `min_machines_running = 0` stops the container when
> idle, which also stops `node-cron`. Reminders then only fire while someone is
> using the app. Keep one machine running, or move the sweep to an external
> scheduler hitting `POST /api/notifications/sweep`.

---

## 10.8 Option C — Railway

The least configuration; good for a demo you want live in ten minutes.

1. **New Project → Deploy from GitHub** → pick the repo
2. Railway detects the `Dockerfile`
3. **New → Database → PostgreSQL**. `DATABASE_URL` is injected automatically
4. **Variables →** paste the production env from §10.5
5. **Settings → Networking → Generate Domain**
6. Add `https://<domain>/api/auth/google/callback` to Google Cloud

Add a volume at `/app/server/storage` under **Settings → Volumes**, or generated
files vanish on each deploy.

Render is essentially identical: Web Service → Docker, plus a managed Postgres and
a disk mounted at the same path.

---

## 10.9 Option D — Vercel + separate API

Only if you specifically want the frontend on a CDN. **It is the most work**, so
be able to justify it.

The catch: Vercel's serverless functions are a poor fit for this server — SSE needs
a long-lived connection, and `node-cron` needs a process that stays alive. So:

- **Frontend** → Vercel, root directory `web`, `VITE_API_URL=https://api.your-domain.com`
- **API** → Fly / Railway / a VPS, with `SERVE_WEB=false`

Then you are back to two origins, so:

```bash
# on the API
APP_URL=https://your-domain.com
EXTRA_CORS_ORIGINS=https://your-domain.com,https://www.your-domain.com
```

> ⚠️ Cross-origin cookies need `sameSite: "none"` **and** `secure: true`, and
> `sameSite: "none"` breaks the OAuth redirect unless the API and UI share a
> parent domain. Use `api.your-domain.com` + `your-domain.com`, not two unrelated
> domains. This is the single best argument for `SERVE_WEB=true`.

---

## 10.10 Post-deploy checklist

```bash
# 1. health
curl https://your-domain.com/health
# {"status":"ok","database":"up","googleOAuth":"configured","guardrails":"active"}

# 2. the UI loads and the SPA fallback works on a deep link
curl -I https://your-domain.com/insights      # expect 200 text/html

# 3. an unknown API path is still JSON, not the HTML shell
curl https://your-domain.com/api/nope          # expect {"title":"Not found"}

# 4. auth is enforced
curl -o /dev/null -w "%{http_code}\n" https://your-domain.com/api/chat/conversations   # 401

# 5. MCP responds
curl -o /dev/null -w "%{http_code}\n" https://your-domain.com/mcp                      # 405

# 6. streaming is not buffered — watch events arrive one at a time
curl -N -X POST -H "Cookie: cortex_session=..." \
  -F "conversationId=<id>" -F "prompt=hello" \
  https://your-domain.com/api/agent/chat
```

Then in a browser: sign in with Google, ask *"what's on my calendar today"*, ask it
to send an email and confirm the **approval card appears and nothing is sent**, and
check the **Insights** page shows a run.

---

## 10.11 CI: run the evals on every push

The offline suite needs no API key, so it is a real gate.

`.github/workflows/ci.yml`:

```yaml
name: CI

on:
  push: { branches: [master, main] }
  pull_request:

jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm

      - run: npm ci
      # Fails if postgres/schema.prisma was not regenerated after a model change.
      - run: npm run db:pg:sync -w server -- --check
      - run: npx prisma generate --schema=server/prisma/schema.prisma

      # Typecheck + build both workspaces.
      - run: npm run build

      # 44 offline eval cases. Exit code 1 fails the job.
      - run: npm run eval
        env:
          SESSION_SECRET: ci-only-not-a-real-secret
          DATABASE_URL: "file:./ci.db"
```

`SESSION_SECRET` is required because `env.ts` validates it at import time — a
deliberate fail-fast that CI has to satisfy.

The real workflow has a second job, `migrations`, that starts a Postgres service,
runs `prisma migrate deploy`, and then `prisma migrate diff --exit-code` against
the schema. A model change without a migration fails CI instead of failing the
deploy.

---

## 10.12 Production hardening

Beyond the six changes, in priority order:

| Priority | Change | Why |
|---|---|---|
| **High** | `LLM_FALLBACK_PROVIDER` | one provider outage otherwise = total outage |
| **High** | automated Postgres backups | most hosts offer this; turn it on |
| **High** | review `guardrails/policy.ts` | set `recipientDenyList`, consider `maxWritesPerTurn: 1` |
| Medium | Redis for rate limits | the in-memory `Map` is per-instance, so N instances = N× the limit |
| Medium | S3 for storage | a volume does not work across multiple hosts |
| Medium | error tracking (Sentry) | `console.error` does not page anyone |
| Medium | narrow `GOOGLE_SCOPES` | drop `gmail.send` if the agent never needs to send |
| Low | token-level streaming | the gateway is the place to add it |
| Low | prune old traces | one row per run grows without bound |

### Scaling past one instance

Three things are per-instance today, and each has a one-file fix:

```mermaid
flowchart TD
    A["ratelimit.service.ts<br/>in-memory Map"] -->|"Redis INCR + EXPIRE"| A1["shared"]
    B["gateway.ts<br/>in-memory cache"] -->|"Redis GET/SETEX"| B1["shared"]
    C["notification.service.ts<br/>EventEmitter"] -->|"Redis pub/sub"| C1["cross-instance SSE"]
```

The interfaces were written narrow for exactly this reason: `checkRateLimit()`
keeps its signature, `lib/storage.ts` keeps `saveBuffer()` / `publicUrl()`.

Also note the scheduler: with N instances you get N sweeps. `dedupeKey` means
duplicates write nothing, so it is *safe* but wasteful. For real multi-instance,
run the sweep as a separate single-replica job.

---

## 10.13 Cost

Roughly, for light personal use:

| Item | Monthly |
|---|---|
| VPS or Fly machine | $5 |
| Managed Postgres | $0–7 (Fly and Railway both have free tiers) |
| Gemini 2.5 Flash | <$1 at a few hundred turns |
| Tavily | free to 1000 searches |
| **Total** | **~$5–13** |

The **Insights** page gives you the real number per agent — which is the point of
having built it.

---

## 10.14 Next

[**11-INTERVIEW-GUIDE**](11-INTERVIEW-GUIDE.md) is the last document: the questions
you will be asked about this project, and how to answer them.

<!-- nav -->

---

[← Build order](09-BUILD-ORDER.md) · [Index](README.md) · [Interview guide →](11-INTERVIEW-GUIDE.md)
