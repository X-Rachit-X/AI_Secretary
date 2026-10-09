# 10. Deployment

From a working local app to something on the internet with HTTPS, explained from
first principles.

If you have never deployed anything, start at §10.1 and read straight through.
If you have, skip to the [environment reference](#104-every-environment-variable)
and then pick a host from §10.7.

| § | |
|---|---|
| [10.1](#101-what-deployment-actually-means) | What deployment actually means |
| [10.2](#102-the-tools-we-use-and-what-each-one-does) | The tools, and what each one does |
| [10.3](#103-the-six-things-that-must-change) | The six things that must change |
| [10.4](#104-every-environment-variable) | **Every environment variable** |
| [10.5](#105-step-by-step-part-1--prepare-the-project) | Step by step: prepare the project |
| [10.6](#106-step-by-step-part-2--prepare-google-cloud) | Step by step: prepare Google Cloud |
| [10.7](#107-step-by-step-part-3--pick-a-host) | Step by step: pick a host (4 options) |
| [10.8](#108-step-by-step-part-4--https) | Step by step: HTTPS |
| [10.9](#109-verify-the-deployment) | Verify the deployment |
| [10.10](#1010-day-two-operations) | Day-two operations |
| [10.11](#1011-ci-run-the-evals-on-every-push) | CI |
| [10.12](#1012-advanced-scaling-past-one-instance) | Advanced: scaling past one instance |
| [10.13](#1013-cost) | Cost |

---

## 10.1 What deployment actually means

Right now the app runs on your machine, in two processes:

```
your laptop
├── node (tsx)  → Express API on http://localhost:4000
└── node (vite) → the React app on http://localhost:5173
     and a file, server/prisma/dev.db, holding all the data
```

Nobody else can reach it. `localhost` means *this machine*, and it stops existing
when you close the lid.

Deployment means putting the same code on **a computer that is always on and has a
public address**, so a browser anywhere can reach it. Four problems come with that:

| Problem | Why it exists | Our answer |
|---|---|---|
| **The other machine has none of your setup** | no Node, no npm install, no files | **Docker** — ship the whole environment as one image |
| **The database file won't survive** | hosts replace containers on every deploy | **Postgres** as a separate always-on service |
| **Two processes, two ports is awkward** | one public address, not two | **`SERVE_WEB=true`** — the API serves the frontend too |
| **Browsers demand HTTPS** | cookies with `secure: true` require it | **a reverse proxy** that gets a certificate automatically |

Everything in §10.2 is those four answers in detail. The good news: **most of it is
already wired up** — the Docker image is Postgres-ready with a committed migration,
so `docker compose up --build` works on a fresh clone.

```mermaid
flowchart LR
    subgraph L["Now: your laptop"]
        V["vite :5173"] -->|"CORS + cookie"| A1["express :4000"]
        A1 --> F[("dev.db file")]
    end

    subgraph P["After: a server on the internet"]
        B["any browser"] -->|"HTTPS :443"| C["reverse proxy"]
        C --> A2["express :4000<br/>+ the built frontend"]
        A2 --> PG[("Postgres")]
        A2 --> VOL[("volume for<br/>generated files")]
    end

    L ==>|"deploy"| P
```

---

## 10.2 The tools we use, and what each one does

### Docker: ship the environment, not just the code

**The problem.** "It works on my machine" happens because your machine has Node
22, a specific npm version, a `node_modules` folder, and environment variables.
Copying only the source to another machine copies none of that.

**What Docker does.** An **image** is a snapshot of a whole filesystem — OS
libraries, Node, your dependencies, your compiled code. A **container** is a
running instance of an image. The image runs identically everywhere, because it
*is* the environment.

```
Dockerfile  ──build──▶  image  ──run──▶  container
(a recipe)              (a snapshot)     (a process)
```

**Why we need it here.** The app has native pieces — Prisma compiles a
platform-specific query engine. An image built for Linux contains the Linux
engine, which is why `prisma generate` runs *inside* the build rather than being
copied from your Windows machine.

### Our Dockerfile: why three stages

A naive Dockerfile would install everything, build, and ship the result —
including the TypeScript compiler, Vite, and all your source. Ours uses
**multi-stage builds**: later stages copy only what they need from earlier ones,
and everything else is discarded.

```mermaid
flowchart TD
    D["<b>Stage 1: deps</b><br/>copy package.json files only<br/>npm ci"] --> B["<b>Stage 2: build</b><br/>copy source<br/>prisma generate<br/>tsc + vite build<br/>npm prune --omit=dev"]
    B --> R["<b>Stage 3: runtime</b><br/>fresh node:22-alpine<br/>copy ONLY: node_modules,<br/>dist, prisma, web/dist"]
    R --> I["final image<br/>no tsc, no vite, no source"]
```

Two details worth understanding:

**Why copy `package.json` before the source.** Docker caches each instruction. If
the manifests have not changed, `npm ci` is skipped entirely on a rebuild. Copying
source first would invalidate the cache on every edit and reinstall from scratch
each time.

**Why `npm prune --omit=dev` after building.** TypeScript and Vite are needed to
build and useless at runtime. Pruning removes them. The generated Prisma client
survives because `@prisma/client` is a *production* dependency.

The container also runs as the non-root `node` user — if something is ever
compromised, it is not root inside the container.

### Postgres: why not keep SQLite

SQLite is a file, and that is both its strength and the problem.

| | SQLite | Postgres |
|---|---|---|
| Setup | none, it's a file | a separate service |
| Writers | **one at a time** | many |
| Survives container replacement | only on a mounted volume | yes, it's a different service |
| Multiple app instances | impossible | fine |

Most hosts give containers an **ephemeral filesystem** — it is wiped when the
container restarts. Your database would vanish on every deploy.

#### How Postgres is wired in: two schema files

Prisma cannot pick a provider from an environment variable, so the repo carries
two schemas:

| File | Provider | Used by |
|---|---|---|
| `server/prisma/schema.prisma` | `sqlite` | local development — **edit this one** |
| `server/prisma/postgres/schema.prisma` | `postgresql` | the Docker image — **generated**, never edited by hand |
| `server/prisma/postgres/migrations/` | `postgresql` | applied by `prisma migrate deploy` on every container boot |

The Postgres schema is produced from the SQLite one by
`server/scripts/postgres-schema.mjs` (`npm run db:pg:sync`), which copies the file
and swaps the provider. **The models cannot drift apart, because there is only one
place to write them.**

The image builds its Prisma client from the Postgres schema, and its entrypoint is:

```bash
npx prisma migrate deploy --schema=prisma/postgres/schema.prisma && node dist/index.js
```

So `docker compose up --build` works on a fresh clone with no extra steps.

#### When you change a model

```bash
# 1. edit server/prisma/schema.prisma, then update your local SQLite database
npm run db:push

# 2. regenerate the Postgres schema and create a migration for it
docker run --rm -d --name ai-secretary-pg -p 5432:5432 \
  -e POSTGRES_PASSWORD=dev -e POSTGRES_DB=ai_secretary postgres:16-alpine

DATABASE_URL="postgresql://postgres:dev@localhost:5432/ai_secretary" \
  npm run db:pg:migrate -- --name add_something

git add server/prisma && git commit -m "feat(db): add something"
docker rm -f ai-secretary-pg
```

> ⚠️ **Migrations must be committed.** The container applies committed migration
> files; it never generates them. CI enforces this twice: it fails if
> `postgres/schema.prisma` is stale (`npm run db:pg:sync -- --check`), and it
> applies the migrations to a real Postgres and fails if they do not reproduce the
> schema exactly (`prisma migrate diff --exit-code`).

#### Staying on SQLite instead

Viable for a single-instance deploy *if* the file is on a persistent volume. The
Docker image is Postgres-only, so run it directly with Node:

```bash
npm ci && npm run build
DATABASE_URL="file:/data/ai-secretary.db" npm run db:push    # /data is a persistent disk
NODE_ENV=production SERVE_WEB=true DATABASE_URL="file:/data/ai-secretary.db" npm start
```

One writer and no horizontal scaling, but genuinely fine for personal use. Be
ready to explain why you would not do it for a team.

### Migrations: why `migrate deploy`, never `db push`

Locally you have been running `prisma db push`, which makes the database match
`schema.prisma` by any means necessary — **including dropping a column** to
remove a field.

In production you want the opposite: a reviewed, ordered list of changes.

```
prisma migrate dev     → generates a SQL migration file (you commit it)
prisma migrate deploy  → applies any that haven't run yet. Skips the rest.
```

Our container entrypoint is:

```
npx prisma migrate deploy && node dist/index.js
```

Safe on every boot, because already-applied migrations are skipped.

### Volumes: so generated files survive

The PDFs, decks and images the agents create live in `server/storage/`. On an
ephemeral filesystem they are gone on the next deploy, and every download link in
every old conversation breaks.

A **volume** is storage that lives outside the container and is mounted into it.

```yaml
volumes:
  - storage:/app/server/storage
```

### A reverse proxy and HTTPS

The session cookie is set with `secure: true` in production, which means browsers
**only send it over HTTPS**. Without a certificate, nobody can stay signed in.

A **reverse proxy** sits in front of the app: it terminates HTTPS on port 443 and
forwards plain HTTP to the app on 4000.

```
browser ──HTTPS:443──▶ Caddy ──HTTP:4000──▶ your app
                         │
                         └── gets and renews certificates from Let's Encrypt
```

We use **Caddy** because it does certificates automatically with no configuration.
nginx works too and needs more setup.

> ⚠️ **The one proxy setting that matters here.** Proxies buffer responses by
> default, which breaks Server-Sent Events: progress updates arrive all at once at
> the end instead of streaming. Caddy needs `flush_interval -1`; nginx needs
> `proxy_buffering off`. This is the single most common "streaming is broken in
> production" cause, and the app looks fine locally.

### `SERVE_WEB`: one origin instead of two

In development the browser loads the UI from `:5173` and calls the API on `:4000`
— two **origins**, which means CORS headers and `credentials: "include"` on every
request.

In production we set `SERVE_WEB=true` and the API process serves the built
frontend itself:

```ts
// server/src/app.ts
if (env.serveWeb) {
  app.use(express.static(webDist, { index: false, setHeaders: /* cache rules */ }));

  // Any GET that is not an API path gets index.html, so a deep link like
  // /insights works on a hard refresh.
  const API_PREFIXES = ["/api", "/mcp", "/health"];

  app.use((req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") return next();
    if (API_PREFIXES.some((prefix) => req.path.startsWith(prefix))) return next();

    res.setHeader("Cache-Control", "no-cache");
    res.sendFile(path.join(webDist, "index.html"));
  });
}
```

One origin, so **CORS and cookie-domain problems disappear entirely**. This is the
single biggest simplification available, and it is why §10.9's Vercel option is
the *least* recommended.

Three things in that snippet exist because of bugs found while testing it:

- **`index: false` plus a separate fallback.** The fallback has to handle `/` as
  well as deep links, so static serving must not claim `/` first.
- **Prefix checks, not a regex.** Express 5 moved to path-to-regexp v8, where
  `app.get(/regex/)` no longer matches the way it did in Express 4.
- **`setHeader` before `sendFile`.** `sendFile` bypasses `express.static`'s
  `setHeaders`, so `no-cache` has to be set again or a deploy leaves browsers
  holding an index.html pointing at deleted asset hashes.

### Caching: why assets and index.html differ

Vite names assets with a content hash: `index-CXGozhPz.js`. Change the file,
change the name. So:

| File | Cache-Control | Why |
|---|---|---|
| `/assets/*` | `public, max-age=31536000, immutable` | the name changes when content changes, so cache for a year |
| `index.html` | `no-cache` | it *points at* those names, so it must be re-fetched or users stay on the old bundle |

---

## 10.3 The six things that must change

| # | Development | Production | Set by | Already done? |
|---|---|---|---|---|
| 1 | SQLite file | Postgres | `DATABASE_URL` | ✅ image is Postgres-ready |
| 2 | Vite on :5173 | API serves `web/dist` | `SERVE_WEB=true` | ✅ code, needs the var |
| 3 | `prisma db push` | `prisma migrate deploy` | Dockerfile entrypoint | ✅ with a committed migration |
| 4 | cookie `secure: false` | cookie `secure: true` | `NODE_ENV=production` | ✅ code, needs the var |
| 5 | localhost redirect URI | your real domain | `GOOGLE_REDIRECT_URI` + Google Cloud | ❌ **you must do this** |
| 6 | `storage/` on disk | a mounted volume | compose / host config | ✅ in `docker-compose.yml` |

**So in practice there are only two jobs:** set the environment variables (§10.4)
and register the redirect URI in Google Cloud (§10.6).

---

## 10.4 Every environment variable

All 30, what each does, and what to set. **Required** means the app will not work
without it.

### Core

| Variable | Required | Dev | Production | What it does |
|---|---|---|---|---|
| `SESSION_SECRET` | **yes** | any long random string | a *different* 64-char hex | Signs the session JWT. Changing it signs everyone out — the only revocation this design has. |
| `NODE_ENV` | no | `development` | **`production`** | Flips the cookie to `secure: true`, enables `trust proxy`, and quietens logs. |
| `PORT` | no | `4000` | `4000` (or what the host injects) | Which port Express listens on. Fly/Railway set this for you. |
| `APP_URL` | no | `http://localhost:5173` | `https://your-domain.com` | The allowed CORS origin, and where OAuth redirects back to after sign-in. |
| `SERVER_URL` | no | `http://localhost:4000` | `https://your-domain.com` | Used to build absolute download URLs for generated files. Wrong value = broken download links. |
| `DATABASE_URL` | **yes** | `file:./dev.db` | `postgresql://user:pass@host:5432/db` | Read by Prisma directly, not by `env.ts`. |

> ⚠️ With `SERVE_WEB=true`, `APP_URL` and `SERVER_URL` are **the same value** —
> one origin serves both.

### Serving the frontend

| Variable | Required | Dev | Production | What it does |
|---|---|---|---|---|
| `SERVE_WEB` | no | `false` | **`true`** | Serves `web/dist` from the API process. |
| `WEB_DIST_PATH` | no | `../web/dist` | `/app/web/dist` in Docker | Where the built frontend is, relative to the server's working directory. |
| `EXTRA_CORS_ORIGINS` | no | empty | only for split-host | Comma-separated extra allowed origins. Needed only when the UI is on a different domain from the API. |

### The LLM

| Variable | Required | Default | What it does |
|---|---|---|---|
| `LLM_PROVIDER` | no | `google` | Which provider: `google`, `openai`, `groq`, `anthropic`, `openrouter`. |
| `GOOGLE_API_KEY` | **effectively yes** | — | Chat when provider is `google`, **and embeddings always**. Document Q&A needs it whatever provider you pick. |
| `GOOGLE_CHAT_MODEL` | no | `gemini-2.5-flash` | Which Gemini model. |
| `GOOGLE_EMBEDDING_MODEL` | no | `gemini-embedding-001` | Used by the RAG pipeline. |
| `OPENAI_API_KEY` | if used | — | Needed when provider or fallback is `openai`. |
| `OPENAI_CHAT_MODEL` | no | `gpt-4o-mini` | |
| `GROQ_API_KEY` | if used | — | Free tier, very fast, **no vision support**. |
| `GROQ_CHAT_MODEL` | no | `llama-3.3-70b-versatile` | |
| `ANTHROPIC_API_KEY` | if used | — | |
| `ANTHROPIC_CHAT_MODEL` | no | `claude-sonnet-5` | |
| `OPENROUTER_API_KEY` | if used | — | A hosted gateway: one key in front of many models. |
| `OPENROUTER_CHAT_MODEL` | no | `google/gemini-2.5-flash` | Provider-prefixed, as OpenRouter requires. |

### The gateway (retry, timeout, fallback)

| Variable | Required | Default | Production advice |
|---|---|---|---|
| `LLM_FALLBACK_PROVIDER` | no | empty | **Set it.** Without a fallback, one provider outage is a total outage. Must differ from `LLM_PROVIDER`. |
| `LLM_TIMEOUT_MS` | no | `60000` | Ceiling on one model call, so a hung provider cannot stall a request and hold the user's credits. |
| `LLM_MAX_RETRIES` | no | `2` | Retries on transient failures (429, 5xx) before the fallback is tried. |

### Google OAuth

| Variable | Required | What it does |
|---|---|---|
| `GOOGLE_CLIENT_ID` | **yes** | From Google Cloud. Without it, sign-in, Calendar and Gmail are all disabled. |
| `GOOGLE_CLIENT_SECRET` | **yes** | Same place. Never commit this. |
| `GOOGLE_REDIRECT_URI` | **yes in prod** | Must match a URI registered in Google Cloud **character for character**, including the trailing path. |

### Optional features

| Variable | Required | Default | What it does |
|---|---|---|---|
| `TAVILY_API_KEY` | no | — | Web search. Without it the search agent degrades to plain chat and says the answer may not be current. |
| `REMINDER_CRON` | no | `*/5 * * * *` | How often the reminder sweep runs. |
| `REMINDER_LEAD_MINUTES` | no | `15` | How far ahead of a meeting to create the reminder. |

### A minimal working production set

Nine lines. Everything else has a sensible default.

```bash
NODE_ENV=production
SERVE_WEB=true
APP_URL=https://your-domain.com
SERVER_URL=https://your-domain.com
SESSION_SECRET=<64 hex chars>
DATABASE_URL=postgresql://ai_secretary:pass@db:5432/ai_secretary
GOOGLE_API_KEY=<AI Studio key>
GOOGLE_CLIENT_ID=<from Google Cloud>
GOOGLE_CLIENT_SECRET=<from Google Cloud>
GOOGLE_REDIRECT_URI=https://your-domain.com/api/auth/google/callback
```

> 💡 The startup banner prints what is configured and what is missing. Check it
> first when something does not work — it saves most of the guessing.

---

## 10.5 Step by step, part 1 — prepare the project

### Step 1.1 — confirm the database side is ready

Nothing to change: the repo already ships a generated Postgres schema and a
committed initial migration (see [§10.2](#102-the-tools-we-use-and-what-each-one-does)).
Just check they are in sync with the dev schema:

```bash
npm run db:pg:sync -- --check
```

A clean exit means the Postgres schema matches `schema.prisma`. If it fails, run
`npm run db:pg:sync` and commit the result — that is exactly what CI checks.

### Step 1.2 — generate a production session secret

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Use a **different** one from development. Anyone with it can forge a session.

### Step 1.3 — confirm the build works

```bash
npm run db:push    # on a fresh clone the evals need the dev database to exist
npm run build      # typecheck + compile both workspaces
npm run eval       # 44 offline cases, no API key needed
```

All three must pass before you deploy. If the evals fail, something is broken that
a typecheck cannot see.

---

## 10.6 Step by step, part 2 — prepare Google Cloud

You already did this for localhost ([08-SETUP §2](08-SETUP.md)). Three additions.

### Step 2.1 — add the production redirect URI

**APIs & Services → Credentials →** your OAuth client → **Authorised redirect
URIs** → Add:

```
https://your-domain.com/api/auth/google/callback
```

**Keep the localhost one** so development still works. A client can hold many.

> ⚠️ Character for character. `http` vs `https`, a trailing slash, `www` or not —
> any difference gives `Error 400: redirect_uri_mismatch`.

### Step 2.2 — decide about publishing

| Mode | Who can sign in | When to use |
|---|---|---|
| **Testing** | only addresses you list as test users (max 100) | personal use, a demo, an interview — **recommended** |
| **In production** | anyone | a real product |

Publishing with Calendar and Gmail scopes triggers Google's verification review,
which takes weeks and wants a privacy policy and a demo video. For a portfolio
project, stay in Testing and add the addresses you need.

### Step 2.3 — confirm both APIs are enabled

**APIs & Services → Enabled APIs** should list **Google Calendar API** and **Gmail
API**. If you only ever tested calendar, Gmail may be missing.

---

## 10.7 Step by step, part 3 — pick a host

| Option | Effort | Cost | Best when |
|---|---|---|---|
| **A. Docker Compose on a VPS** | medium | ~$5 | you want to understand the whole stack |
| **B. Fly.io** | low | $0–5 | you want a global edge and managed Postgres |
| **C. Railway** | lowest | $0–5 | you want it live in ten minutes |
| **D. Vercel + separate API** | highest | varies | you specifically need the UI on a CDN |

---

### Option A — Docker Compose on any VPS

Works on Hetzner, DigitalOcean, Linode, EC2 — anything running Linux.

**A.1 — get a server.** Any provider; the smallest tier is enough. Note its IP.

**A.2 — point DNS at it.** In your registrar, an `A` record:

```
Type: A    Name: @    Value: <your server IP>
```

Propagation takes minutes to an hour. Check with `dig your-domain.com +short`.

**A.3 — install Docker on the server.**

```bash
ssh root@<your server IP>
curl -fsSL https://get.docker.com | sh
docker --version
```

**A.4 — get the code and configure it.**

```bash
git clone https://github.com/X-Rachit-X/AI_Secretary.git
cd AI_Secretary

cp .env.example .env
nano .env        # paste the production set from §10.4
```

Also set a real `POSTGRES_PASSWORD` in `.env` — compose reads it:

```bash
POSTGRES_PASSWORD=<something long and random>
```

**A.5 — start it.**

```bash
docker compose up -d --build
docker compose logs -f app
```

You should see the startup banner with `Google OAuth    configured`.

**A.6 — add HTTPS.** See [§10.8](#108-step-by-step-part-4--https).

**What compose is doing:**

```mermaid
flowchart TD
    C["docker compose up"] --> DB["start postgres:16-alpine<br/>volume: db-data"]
    DB --> HC{"pg_isready?"}
    HC -->|"not yet"| HC
    HC -->|"yes"| APP["build + start app"]
    APP --> MIG["prisma migrate deploy"]
    MIG --> NODE["node dist/index.js"]
    NODE --> LIVE["listening on :4000<br/>volume: storage"]
```

The healthcheck matters: without `depends_on: condition: service_healthy`, the app
starts migrating before Postgres is accepting connections and crashes on boot.

---

### Option B — Fly.io

**B.1 — install and sign in.**

```bash
curl -L https://fly.io/install.sh | sh
fly auth login
```

**B.2 — create the app without deploying yet.**

```bash
fly launch --no-deploy
# say NO to its Postgres offer — we create it explicitly next
```

**B.3 — write `fly.toml`.**

```toml
app = "ai-secretary"
primary_region = "iad"          # pick one near you

[build]
  dockerfile = "Dockerfile"

[env]
  NODE_ENV = "production"
  PORT = "4000"
  SERVE_WEB = "true"
  WEB_DIST_PATH = "/app/web/dist"

[http_service]
  internal_port = 4000
  force_https = true            # Fly terminates TLS for you
  auto_stop_machines = "suspend"
  auto_start_machines = true
  min_machines_running = 1      # see the warning below

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

[[mounts]]
  source = "ai_secretary_storage"
  destination = "/app/server/storage"
```

> ⚠️ **`min_machines_running = 1` is deliberate.** With `0`, Fly stops the
> container when idle — which also stops `node-cron`, so meeting reminders only
> fire while someone is using the app. Either keep one machine awake, or move the
> sweep to an external scheduler hitting `POST /api/notifications/sweep`.

**B.4 — create Postgres and a volume.**

```bash
fly postgres create --name ai-secretary-db --region iad
fly postgres attach ai-secretary-db          # injects DATABASE_URL automatically

fly volumes create ai_secretary_storage --region iad --size 1
```

**B.5 — set secrets.** These are encrypted; never put them in `fly.toml`.

```bash
fly secrets set \
  SESSION_SECRET="$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')" \
  GOOGLE_API_KEY="..." \
  GOOGLE_CLIENT_ID="..." \
  GOOGLE_CLIENT_SECRET="..." \
  GOOGLE_REDIRECT_URI="https://ai-secretary.fly.dev/api/auth/google/callback" \
  APP_URL="https://ai-secretary.fly.dev" \
  SERVER_URL="https://ai-secretary.fly.dev" \
  TAVILY_API_KEY="..." \
  LLM_FALLBACK_PROVIDER="groq" \
  GROQ_API_KEY="..."
```

**B.6 — deploy.**

```bash
fly deploy
fly logs
fly open
```

HTTPS is handled for you, so §10.8 is unnecessary. Add the `.fly.dev` redirect URI
to Google Cloud.

---

### Option C — Railway

The fastest path to something live.

1. **New Project → Deploy from GitHub repo** → select `AI_Secretary`
2. Railway detects the `Dockerfile` automatically
3. **New → Database → PostgreSQL.** `DATABASE_URL` is injected
4. **Variables →** paste the production set from §10.4
5. **Settings → Networking → Generate Domain** → copy it
6. Set `APP_URL`, `SERVER_URL` and `GOOGLE_REDIRECT_URI` to that domain
7. Add the redirect URI in Google Cloud
8. **Settings → Volumes →** mount at `/app/server/storage`

Step 8 is easy to miss and generated files vanish on each deploy without it.

Render is nearly identical: **Web Service → Docker**, a managed Postgres, and a
disk mounted at the same path.

---

### Option D — Vercel + a separate API

Only if you specifically want the frontend on a CDN. **It is the most work and the
most failure modes**, so be able to justify it.

**Why it is awkward:** Vercel's serverless functions are a poor fit for this
server. SSE needs a long-lived connection and `node-cron` needs a process that
stays alive. Neither survives a function that must return quickly.

So you split:

- **Frontend** → Vercel. Root directory `web`, env `VITE_API_URL=https://api.your-domain.com`
- **API** → Fly / Railway / a VPS, with `SERVE_WEB=false`

And you are back to two origins:

```bash
# on the API
APP_URL=https://your-domain.com
EXTRA_CORS_ORIGINS=https://your-domain.com,https://www.your-domain.com
```

> ⚠️ **The cookie problem.** Cross-origin cookies need `sameSite: "none"` **and**
> `secure: true`, and `sameSite: "none"` breaks the OAuth redirect unless the API
> and UI share a parent domain. Use `api.your-domain.com` with
> `your-domain.com` — not two unrelated domains. This is the strongest argument
> for `SERVE_WEB=true`.

---

## 10.8 Step by step, part 4 — HTTPS

Skip this for Fly and Railway; they terminate TLS for you. For a VPS:

**8.1 — add Caddy to `docker-compose.yml`.**

```yaml
  caddy:
    image: caddy:2-alpine
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy-data:/data        # certificates live here — must persist
      - caddy-config:/config
    depends_on:
      - app

volumes:
  caddy-data:
  caddy-config:
```

**8.2 — create `Caddyfile`.**

```
your-domain.com {
    reverse_proxy app:4000 {
        # Do not buffer: SSE progress events must stream, not arrive in one lump.
        flush_interval -1
    }
}
```

**8.3 — stop exposing the app directly.** Remove the `ports:` block from the `app`
service so only Caddy is reachable from the internet.

**8.4 — restart.**

```bash
docker compose up -d
docker compose logs -f caddy      # watch it obtain the certificate
```

Caddy contacts Let's Encrypt, proves you control the domain over port 80, and
installs the certificate. Renewal is automatic.

**If you prefer nginx**, the equivalent of `flush_interval -1` is:

```nginx
location / {
    proxy_pass http://app:4000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;

    proxy_buffering off;          # required for SSE
    proxy_read_timeout 300s;      # agent turns can take a while
}
```

`X-Forwarded-Proto` matters: with `trust proxy` enabled the app reads it to know
the original request was HTTPS, which the secure cookie depends on.

---

## 10.9 Verify the deployment

Run all seven. Each catches a different mistake.

```bash
# 1. the app is up and the database is reachable
curl https://your-domain.com/health
# {"status":"ok","database":"up","googleOAuth":"configured","guardrails":"active"}

# 2. the UI loads
curl -I https://your-domain.com            # 200, text/html

# 3. a deep link works on a hard refresh (the SPA fallback)
curl -I https://your-domain.com/insights   # 200, text/html

# 4. an unknown API path still returns JSON, not the HTML shell
curl https://your-domain.com/api/nope      # {"title":"Not found"}

# 5. auth is enforced
curl -o /dev/null -w "%{http_code}\n" https://your-domain.com/api/chat/conversations   # 401

# 6. MCP responds
curl -o /dev/null -w "%{http_code}\n" https://your-domain.com/mcp                      # 405

# 7. assets cache, index does not
curl -I https://your-domain.com/assets/<hashed>.js   # immutable, max-age=31536000
curl -I https://your-domain.com/                     # no-cache
```

Then in a browser:

| Check | Confirms |
|---|---|
| Sign in with Google | OAuth redirect URI is right |
| *"What's on my calendar today?"* | tokens stored, Google API reachable |
| *"Email sam@example.com saying hello"* | **the approval card appears and nothing is sent** |
| Approve it | server-side execution path works |
| Watch progress lines appear one at a time | SSE is not being buffered by the proxy |
| Open **Insights** | traces are being written |
| Generate a PDF, then redeploy, then download it | the storage volume is mounted |

That last one is the test people skip and then discover three weeks later.

---

## 10.10 Day-two operations

### Logs

```bash
docker compose logs -f app          # compose
fly logs                            # Fly
# Railway: the Deployments tab
```

### Deploy an update

```bash
git pull
docker compose up -d --build        # compose
fly deploy                          # Fly
# Railway: pushing to the branch redeploys
```

### Back up the database

```bash
# compose
docker compose exec db pg_dump -U ai_secretary ai_secretary > backup-$(date +%F).sql

# Fly
fly postgres connect -a ai-secretary-db   # then \copy, or use their snapshots
```

Fly and Railway both offer automated snapshots. **Turn them on.**

### Restore

```bash
cat backup-2026-10-01.sql | docker compose exec -T db psql -U ai_secretary ai_secretary
```

### Rotate the session secret

Set a new `SESSION_SECRET` and restart. Everyone is signed out — which is also
your emergency "sign everyone out" button.

### Prune old traces

One `Trace` row per run grows without bound. A monthly job:

```sql
DELETE FROM "Trace" WHERE "createdAt" < NOW() - INTERVAL '90 days';
```

---

## 10.11 CI: run the evals on every push

Already in the repo at `.github/workflows/ci.yml`:

```yaml
name: CI

on:
  push:
    branches: [master, main]
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
      - run: npm run build
      - run: npm run eval
        env:
          SESSION_SECRET: ci-only-not-a-real-secret
          DATABASE_URL: "file:./ci.db"
```

`SESSION_SECRET` is required because `env.ts` validates it at import time — a
deliberate fail-fast that CI has to satisfy. The value signs nothing real.

> 💡 This is a *real* gate because the offline evals need no API key. An eval
> suite that requires credentials gets skipped in CI, then rots.

The real workflow has a second job, `migrations`, that starts a Postgres service,
runs `prisma migrate deploy`, and then `prisma migrate diff --exit-code` against
the schema. A model change without a migration fails CI instead of failing the
deploy.

---

## 10.12 Advanced: scaling past one instance

Three things are per-instance today. Each has a one-file fix, because the
interfaces were written narrow for exactly this reason.

```mermaid
flowchart TD
    A["ratelimit.service.ts<br/>in-memory Map"] -->|"Redis INCR + EXPIRE"| A1["shared across instances"]
    B["gateway.ts<br/>in-memory router cache"] -->|"Redis GET/SETEX"| B1["shared"]
    C["notification.service.ts<br/>EventEmitter"] -->|"Redis pub/sub"| C1["SSE works cross-instance"]
    D["lib/storage.ts<br/>local disk"] -->|"S3 + presigned URLs"| D1["works multi-host"]
```

| Today | Problem with N instances | Fix |
|---|---|---|
| `checkRateLimit()` uses a `Map` | each instance allows the full limit, so N× the intended rate | Redis `INCR` + `EXPIRE`; the function signature does not change |
| Gateway cache is in-process | lower hit rate, not incorrect | Redis, or accept it |
| Notifications use an `EventEmitter` | an SSE client on instance A never sees an event emitted on B | Redis pub/sub |
| Storage is a local volume | a file written on A is not on B | S3; rewrite `lib/storage.ts` only |
| `node-cron` runs in every instance | N duplicate sweeps | `dedupeKey` makes it *safe* but wasteful — run the sweep as a separate single-replica job |

> 💡 **Interview-worthy:** being able to name exactly which four files change, and
> why none of the call sites do, is the point of having kept those interfaces
> narrow.

### Hardening checklist, in priority order

| Priority | Change | Why |
|---|---|---|
| **High** | `LLM_FALLBACK_PROVIDER` | one provider outage = total outage otherwise |
| **High** | automated database backups | most hosts offer this |
| **High** | review `guardrails/policy.ts` | set `recipientDenyList`, consider `maxWritesPerTurn: 1` |
| Medium | error tracking (Sentry) | `console.error` does not page anyone |
| Medium | narrow `GOOGLE_SCOPES` | drop `gmail.send` if the agent never needs to send |
| Medium | prune old traces | unbounded growth |
| Low | token-level streaming | the gateway is the place to add it |

---

## 10.13 Cost

Light personal use:

| Item | Monthly |
|---|---|
| VPS or Fly machine | $5 |
| Managed Postgres | $0–7 (Fly and Railway have free tiers) |
| Gemini 2.5 Flash | <$1 at a few hundred turns |
| Tavily | free to 1000 searches |
| **Total** | **~$5–13** |

The **Insights** page shows your actual spend per agent — which is the point of
having built it.

---

## 10.14 Troubleshooting

| Symptom | Cause |
|---|---|
| `redirect_uri_mismatch` | `GOOGLE_REDIRECT_URI` does not match Google Cloud exactly |
| Signed in, then `invalid_grant` later | no refresh token stored; disconnect Google and sign in again |
| Everything 401 after deploy | `APP_URL` does not match the browser's origin, so CORS drops the cookie |
| Signed out on every refresh | cookie is `secure` but the site is HTTP, or the proxy is not forwarding `X-Forwarded-Proto` |
| Answer arrives in one lump | the proxy is buffering — `flush_interval -1` / `proxy_buffering off` |
| Download links 404 | `SERVER_URL` is wrong, or the storage volume is not mounted |
| `/insights` 404s on refresh but works when clicked | the SPA fallback is not running — check `SERVE_WEB` and that `web/dist` exists |
| Database empty after deploy | no volume, or migrations never ran |
| `Missing required env var SESSION_SECRET` | it is the one genuinely required variable |
| No reminders in production | the host suspends idle containers, stopping `node-cron` |
| `EPERM ... query_engine.dll` on `prisma generate` | a local node process holds the engine; stop the dev server |

<!-- nav -->

---

[← Build order](09-BUILD-ORDER.md) · [Index](README.md) · [Interview guide →](11-INTERVIEW-GUIDE.md)
