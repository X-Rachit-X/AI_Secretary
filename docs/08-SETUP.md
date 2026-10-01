# 8. Setup

From a clean machine to a running app.

---

## 1. Prerequisites

- **Node.js 20.11 or newer** — `node -v`
- A Google account
- One LLM API key (free tier is fine)

No Docker, no database server, no Redis. SQLite is a file.

---

## 2. Google Cloud — OAuth credentials

This is the only fiddly part. Ten minutes, once.

1. Open <https://console.cloud.google.com/> and **create a project**.

2. **Enable two APIs.** *APIs & Services → Library*, then enable:
   - **Google Calendar API**
   - **Gmail API**

3. **Configure the consent screen.** *APIs & Services → OAuth consent screen*
   - User type: **External**
   - Fill in app name, your email for support and developer contact
   - **Scopes:** you can skip adding them here; the app requests them at runtime
   - **Test users:** add your own Gmail address

   > While the app is in *Testing*, only listed test users can sign in. That is
   > fine — and preferable — for a project you are running yourself.

4. **Create the credential.** *APIs & Services → Credentials →
   Create credentials → OAuth client ID*
   - Application type: **Web application**
   - **Authorised redirect URIs** — add exactly:
     ```
     http://localhost:4000/api/auth/google/callback
     ```
   - Create, then copy the **Client ID** and **Client secret**

> ⚠️ The redirect URI must match `GOOGLE_REDIRECT_URI` **character for
> character**, trailing slash included. A mismatch gives
> `Error 400: redirect_uri_mismatch`.

---

## 3. An LLM key

Pick one. The app is provider-agnostic; `LLM_PROVIDER` chooses at boot.

| Provider | Where | Notes |
|---|---|---|
| **Google Gemini** *(default)* | <https://aistudio.google.com/apikey> | Free tier. One key covers chat, vision **and** embeddings. |
| OpenAI | <https://platform.openai.com/api-keys> | Paid. |
| Groq | <https://console.groq.com/keys> | Free tier, very fast. **No vision support.** |
| Anthropic | <https://console.anthropic.com/> | Paid. |
| **OpenRouter** | <https://openrouter.ai/keys> | A hosted LLM *gateway*: one key in front of hundreds of models, with its own failover. Set `LLM_PROVIDER=openrouter`. |

### Gateway settings (all optional)

```bash
# Try a second provider when the primary keeps failing. Must differ from
# LLM_PROVIDER to have any effect.
LLM_FALLBACK_PROVIDER=groq

# Hard ceiling on one model call. A hung provider cannot stall a request.
LLM_TIMEOUT_MS=60000

# Retries on transient failures (429, 5xx) before the fallback is tried.
LLM_MAX_RETRIES=2
```

These are applied by the in-process gateway in
[`ai/gateway.ts`](../server/src/ai/gateway.ts), and they apply **on top of**
OpenRouter if you use it. The two are not alternatives.

> `GOOGLE_API_KEY` is used for **embeddings regardless of provider**, because
> document Q&A needs them and Gemini is the one with a free embedding tier. If
> you set `LLM_PROVIDER=openai` and still want the docqa agent, set both keys.

**Optional — web search.** <https://tavily.com> gives 1000 free searches a
month. Without it the search agent degrades to plain chat and says the answer
may not be current.

---

## 4. Install and run

```bash
cd cortex-one

# 1. dependencies for both workspaces
npm install

# 2. environment
cp .env.example server/.env
cp web/.env.example web/.env

# 3. a session secret
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
# paste the output into SESSION_SECRET in server/.env

# 4. create the database
npm run db:push

# 8. start both
npm run dev
```

Fill in `server/.env`:

```bash
SESSION_SECRET=<the random hex from step 3>

LLM_PROVIDER=google
GOOGLE_API_KEY=<your AI Studio key>

GOOGLE_CLIENT_ID=<from Google Cloud>
GOOGLE_CLIENT_SECRET=<from Google Cloud>
GOOGLE_REDIRECT_URI=http://localhost:4000/api/auth/google/callback

TAVILY_API_KEY=<optional>
```

Open **<http://localhost:5173>** and sign in.

The server banner tells you what is configured:

```
  CortexOne server
  http://localhost:4000

  LLM provider    google
  Google OAuth    configured
  Web search      configured
  MCP endpoint    POST http://localhost:4000/mcp
  Web app origin  http://localhost:5173
```

---

## 5. MCP — using the tools from Claude Desktop or Cursor

**Sign in through the web app first.** The stdio server reads the Google tokens
your sign-in stored; it has no browser of its own to run a consent flow in.

### Claude Desktop

Edit `claude_desktop_config.json`:

| OS | Path |
|---|---|
| macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Windows | `%APPDATA%\Claude\claude_desktop_config.json` |

```json
{
  "mcpServers": {
    "cortex-one": {
      "command": "npx",
      "args": ["tsx", "src/mcp/stdio.ts"],
      "cwd": "C:/path/to/cortex-one/server",
      "env": { "CORTEX_USER_EMAIL": "you@gmail.com" }
    }
  }
}
```

Restart Claude Desktop. Ten tools appear: `list_meetings`, `create_meeting`,
`cancel_meeting`, `check_busy`, `find_free_slot`, `search_mail`, `read_mail`,
`send_mail`, `create_reminder`, `list_notifications`.

If exactly one account exists in the database you can omit `CORTEX_USER_EMAIL`.

### Over HTTP

```bash
curl -X POST http://localhost:4000/mcp \
  -H "Content-Type: application/json" \
  -H "Cookie: cortex_session=<your cookie>" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

---

## 6. Useful commands

```bash
npm run dev            # server + web together
npm run dev:server     # server only
npm run dev:web        # web only
npm run build          # typecheck and build both
npm run db:push        # apply schema.prisma to the database
npm run db:studio      # browse the data in a GUI
npm run mcp            # MCP stdio server

npm run eval           # 44 offline eval cases: guardrails + parsers. No API key.
npm run eval:live      # also router accuracy (costs a few model calls)
```

Run `npm run eval` after touching anything in `server/src/guardrails/` or either
output parser. It takes under a second and needs no credentials, so there is no
reason to skip it.

---

## 7. Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `Error 400: redirect_uri_mismatch` | `GOOGLE_REDIRECT_URI` does not match the Google Cloud entry exactly. Compare character by character. |
| `Access blocked: has not completed verification` | Add your email under *Test users* on the consent screen. |
| Signed in, but calendar calls fail with `invalid_grant` | No refresh token stored. Disconnect Google from the Calendar page, then sign in again. |
| Everything returns 401 | `APP_URL` in `server/.env` must exactly match the Vite origin (`http://localhost:5173`), or CORS drops the cookie. |
| `Missing required env var SESSION_SECRET` | Step 3 above. |
| `GOOGLE_API_KEY is not set` on a PDF upload | Embeddings always use Google. Set `GOOGLE_API_KEY` even when `LLM_PROVIDER` is something else. |
| "The configured LLM_PROVIDER cannot read images" | Groq has no vision model. Switch to `google`, `openai` or `anthropic`. |
| The reply arrives in one lump, not streaming | A proxy is buffering. `X-Accel-Buffering: no` is already sent; check your own proxy config. |
| No notifications ever appear | You need a meeting within `REMINDER_LEAD_MINUTES`. Press **Check now** on the Alerts page to run the sweep immediately. |
| `Cannot find module './env'` | Add the `.js` extension. `module: NodeNext` requires it on relative imports, even in `.ts` files. |
| The agent describes an email but never sends it | **Working as intended.** `send_mail` requires approval; press Approve on the card. See [06-GUARDRAILS](06-GUARDRAILS.md). |
| An MCP host cannot send mail | Also intended. MCP proposes; you confirm in CortexOne. |
| A legitimate message is blocked | Loosen the pattern in `guardrails/policy.ts`, then add a false-positive eval case so it stays loose. |
| Insights shows $0.00 for everything | Your model id is not in `ai/pricing.ts`, or the provider does not report token counts. |
| `EPERM ... query_engine-windows.dll.node` on `prisma generate` | A node process is holding the engine. Stop the dev server first. |

---

## 8. Going to production

This runs as-is on one box. Before putting it in front of other people:

| Change | Why |
|---|---|
| Deploy the Docker image, which uses Postgres (`prisma/postgres/`) | SQLite does not do concurrent writers well |
| Replace the `Map` in `ratelimit.service.ts` with Redis | counters must be shared if you run more than one instance |
| Replace `lib/storage.ts` with S3 or similar | local disk does not survive a redeploy; the interface is already narrow enough that this is one file |
| `NODE_ENV=production` | makes the session cookie `secure`, so it only travels over HTTPS |
| Publish the OAuth consent screen | removes the 100-test-user cap |
| Set `APP_URL` / `SERVER_URL` / `GOOGLE_REDIRECT_URI` to real domains | and add the new redirect URI in Google Cloud |
| Add a payment provider | `grantCredits()` in `credits.service.ts` is the hook — call it from a verified webhook |
| Review `guardrails/policy.ts` | Set `recipientDenyList`, tighten `maxWritesPerTurn`, and consider gating `create_meeting` too |
| Narrow `GOOGLE_SCOPES` | If the agent never needs to send, drop `gmail.send` and use `gmail.readonly` |
| Run `npm run eval` in CI | Exit code is 1 on failure, so it gates a merge with no API key needed |
| Set `LLM_FALLBACK_PROVIDER` | A single provider outage otherwise takes the whole app down |

<!-- nav -->

---

[← Evals and gateway](07-EVALS.md) · [Index](README.md) · [Build order →](09-BUILD-ORDER.md)
