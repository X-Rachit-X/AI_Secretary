# 3. Build order

The order to write the files in if you are typing this project out yourself.

Each stage ends with **something you can run and see working**. That matters more than it sounds: debugging 60 files at once is a different activity from debugging the 4 you just wrote.

---

## Stage 0 — Scaffold (15 min)

```
cortex-one/
├── package.json          workspaces: ["server", "web"]
├── .gitignore
└── .env.example
```

```bash
mkdir -p cortex-one/{server/src,web/src}
cd cortex-one && npm init -y
```

Set `"workspaces": ["server", "web"]` and `"type": "module"` in the root package.json.

**Check:** `npm install` runs without error.

---

## Stage 1 — Server skeleton (30 min)

| Order | File | Why first |
|---|---|---|
| 1 | `server/package.json` | |
| 2 | `server/tsconfig.json` | `module: NodeNext`, so imports need `.js` extensions |
| 3 | `server/src/env.ts` | everything depends on it |
| 4 | `server/prisma/schema.prisma` | the data model shapes everything after it |
| 5 | `server/src/db.ts` | |
| 6 | `server/src/lib/errors.ts` | every later file throws these |
| 7 | `server/src/app.ts` | just `/health` for now |
| 8 | `server/src/index.ts` | |

```bash
cd server && npx prisma db push && npm run dev
curl http://localhost:4000/health
```

**Check:** `{"status":"ok","database":"up"}`

> ⚠️ With `module: NodeNext`, **every relative import needs a `.js` extension**, even from a `.ts` file. `import { env } from "./env.js"`. This trips up everyone once.

---

## Stage 2 — Auth (45 min)

This is the gate everything else sits behind, so it comes before any feature.

| Order | File |
|---|---|
| 9 | `server/src/auth/session.ts` |
| 10 | `server/src/auth/google-oauth.ts` |
| 11 | `server/src/auth/require-auth.ts` |
| 12 | `server/src/routes/auth.routes.ts` |

Set up Google OAuth credentials first — see [05-SETUP.md §2](05-SETUP.md).

```bash
# open in a browser, complete consent
http://localhost:4000/api/auth/google
```

It will redirect to `http://localhost:5173/chat`, which does not exist yet — that is expected. Check the database instead:

```bash
npx prisma studio      # User and GoogleAccount should each have a row
```

**Check:** a `GoogleAccount` row exists **with a non-null `refreshToken`**. If it is null, you are missing `access_type: "offline"` + `prompt: "consent"`.

---

## Stage 3 — Google layer (45 min)

| Order | File |
|---|---|
| 13 | `server/src/lib/time.ts` |
| 14 | `server/src/google/client.ts` |
| 15 | `server/src/google/calendar.ts` |
| 16 | `server/src/google/gmail.ts` |
| 17 | `server/src/routes/calendar.routes.ts` |
| 18 | `server/src/routes/mail.routes.ts` |

Grab your session cookie from the browser devtools, then:

```bash
curl -H "Cookie: cortex_session=..." http://localhost:4000/api/calendar/meetings
curl -H "Cookie: cortex_session=..." "http://localhost:4000/api/mail/messages?q=is:unread"
```

**Check:** your real meetings and real unread mail come back as JSON. **Do not move on until this works** — every agent above it depends on these functions being right.

---

## Stage 4 — Services (30 min)

| Order | File |
|---|---|
| 19 | `server/src/services/ratelimit.service.ts` |
| 20 | `server/src/services/credits.service.ts` |
| 21 | `server/src/services/conversation.service.ts` |
| 22 | `server/src/services/notification.service.ts` |
| 23 | `server/src/routes/chat.routes.ts` |

```bash
curl -X POST -H "Cookie: ..." http://localhost:4000/api/chat/conversations
curl -H "Cookie: ..." http://localhost:4000/api/chat/conversations
```

**Check:** a conversation is created and listed back.

---

## Stage 5 — The graph, minimal (45 min)

Build it with **one agent** first. Adding the other eight afterwards is mechanical; getting the wiring right is not.

| Order | File |
|---|---|
| 24 | `server/src/ai/models.ts` |
| 25 | `server/src/ai/state.ts` |
| 26 | `server/src/ai/router.node.ts` |
| 27 | `server/src/ai/agents/chat.agent.ts` |
| 28 | `server/src/ai/graph.ts` — chat only |
| 29 | `server/src/lib/sse.ts` |
| 30 | `server/src/routes/agent.routes.ts` |

Comment out every node except `router` and `chat` in `graph.ts` for now.

```bash
curl -N -X POST -H "Cookie: ..." \
  -F "conversationId=<id>" -F "prompt=hello" -F "agent=auto" \
  http://localhost:4000/api/agent/chat
```

**Check:** you see `data: {"type":"started"}`, then progress lines, then `completed`.

This is the single most important checkpoint in the project. Everything after it is adding nodes to a graph that already runs.

---

## Stage 6 — The workspace agent (1 hr)

The calendar-and-mail brain. The most valuable agent, so it comes before the document ones.

| Order | File |
|---|---|
| 31 | `server/src/ai/tools/calendar.tools.ts` |
| 32 | `server/src/ai/tools/mail.tools.ts` |
| 33 | `server/src/ai/tools/notify.tools.ts` |
| 34 | `server/src/ai/tools/index.ts` |
| 35 | `server/src/ai/agents/workspace.agent.ts` |
| 36 | add the `workspace` node to `graph.ts` |

**Check:** send `"what's on my calendar today"` and watch the progress lines. Then try something multi-step: `"am I free at 4pm tomorrow, and if so book 30 minutes called Focus"`.

---

## Stage 7 — The remaining agents (1.5 hr)

Each is independent. Write them in whatever order you find interesting.

| Order | File | Note |
|---|---|---|
| 37 | `server/src/lib/storage.ts` | needed by pdf / ppt / image |
| 38 | `server/src/routes/file.routes.ts` | |
| 39 | `server/src/generators/pdf.generator.ts` | test with a hand-written spec, no model |
| 40 | `server/src/ai/agents/pdf.agent.ts` | |
| 41 | `server/src/generators/ppt.generator.ts` | same — test the layout first |
| 42 | `server/src/ai/agents/ppt.agent.ts` | |
| 43 | `server/src/ai/agents/search.agent.ts` | add the `search → chat` edge |
| 44 | `server/src/ai/agents/coding.agent.ts` | |
| 45 | `server/src/ai/agents/image.agent.ts` | |
| 46 | `server/src/ai/agents/vision.agent.ts` | |
| 47 | `server/src/ai/vector-store.ts` | |
| 48 | `server/src/ai/agents/docqa.agent.ts` | |
| 49 | finish `graph.ts` — all nodes and edges | |

> **Tip:** write `renderPdf` / `renderDeck` and call them from a throwaway script with a hand-written spec *before* wiring the agent. Separating "does the layout work" from "did the model produce the right shape" saves a lot of confused debugging.

---

## Stage 8 — Notifications (30 min)

| Order | File |
|---|---|
| 50 | `server/src/services/scheduler.service.ts` |
| 51 | `server/src/routes/notification.routes.ts` |
| 52 | start the scheduler in `index.ts` |

```bash
curl -X POST -H "Cookie: ..." http://localhost:4000/api/notifications/sweep
curl -H "Cookie: ..." http://localhost:4000/api/notifications
```

**Check:** if you have a meeting in the next 15 minutes, a notification appears. Run the sweep **twice** — the second run must create nothing. That proves `dedupeKey` works.

---

## Stage 9 — MCP (30 min)

| Order | File |
|---|---|
| 53 | `server/src/mcp/mcp.tools.ts` |
| 54 | `server/src/mcp/http.ts` |
| 55 | `server/src/mcp/stdio.ts` |

```bash
curl -X GET http://localhost:4000/mcp     # expect 405 with an Allow header
npm run mcp                                # expect "[mcp] cortex-one stdio server ready" on stderr
```

**Check:** wire it into Claude Desktop — config in [05-SETUP.md §5](05-SETUP.md).

**The core server now runs.** 38 files; guardrails, evals and telemetry come in stages 13-15.

---

## Stage 10 — Web foundation (45 min)

| Order | File |
|---|---|
| 56 | `web/package.json`, `tsconfig.json`, `vite.config.ts`, `index.html` |
| 57 | `web/src/index.css` |
| 58 | `web/src/lib/types.ts` |
| 59 | `web/src/lib/api.ts` |
| 60 | `web/src/lib/sse.ts` |
| 61 | `web/src/store/auth.store.ts` |
| 62 | `web/src/pages/Login.tsx` |
| 63 | `web/src/main.tsx`, `App.tsx` (Login route only) |
| 64 | `web/src/components/Layout.tsx` |

**Check:** `npm run dev` → sign in with Google → you land on a page with the left rail and your name in the header.

---

## Stage 11 — Chat UI (1 hr)

| Order | File |
|---|---|
| 65 | `web/src/store/chat.store.ts` |
| 66 | `web/src/components/Markdown.tsx` |
| 67 | `web/src/components/chat/MessageBubble.tsx` |
| 68 | `web/src/components/chat/Composer.tsx` |
| 69 | `web/src/components/chat/ConversationList.tsx` |
| 70 | `web/src/pages/Chat.tsx` |
| 71 | `web/src/components/chat/ArtifactPanel.tsx` |

**Check:** type `"what's on my calendar today"`, watch the progress line change, see the answer stream in.

---

## Stage 12 — The remaining pages (45 min)

| Order | File |
|---|---|
| 72 | `web/src/pages/Calendar.tsx` |
| 73 | `web/src/pages/Mail.tsx` |
| 74 | `web/src/store/notification.store.ts` |
| 75 | `web/src/pages/Notifications.tsx` |
| 76 | `web/src/pages/Files.tsx` |
| 77 | finish the route table in `App.tsx` |

**Check:** all five pages load with real data.


---

## Stage 13 - Guardrails (1 hr)

The safety layer. Comes after the agents work, because you need something to
guard; but before you ever point it at a real inbox.

| Order | File | Note |
|---|---|---|
| 78 | `server/src/guardrails/policy.ts` | all thresholds and patterns in one object |
| 79 | `server/src/guardrails/input.guard.ts` | redact secrets, block intents, flag injection |
| 80 | `server/src/guardrails/output.guard.ts` | prompt leaks, unsafe links |
| 81 | `server/src/guardrails/untrusted.ts` | the trust boundary |
| 82 | `server/src/guardrails/tool.guard.ts` | the approval gate |
| 83 | `server/src/guardrails/index.ts` | barrel |
| 84 | add `PendingAction` to `schema.prisma`, then `npm run db:push` | |
| 85 | `server/src/ai/tools/context.ts` | `tracked()` + `untrusted()` wrappers |
| 86 | rewrite `calendar.tools.ts` / `mail.tools.ts` / `notify.tools.ts` to take a `ToolContext` | |
| 87 | `server/src/routes/approval.routes.ts` | where an approved action actually runs |
| 88 | wire the guards into `agent.routes.ts` | input before the stream, output before persistence |

**Check:** ask the agent to email someone. It must describe the draft and
*not* send. `GET /api/approvals` should list one pending row.

---

## Stage 14 - Evals (45 min)

| Order | File |
|---|---|
| 89 | `server/src/evals/types.ts` |
| 90 | `server/src/evals/guardrails.eval.ts` |
| 91 | `server/src/evals/parsers.eval.ts` |
| 92 | `server/src/evals/router.eval.ts` |
| 93 | `server/src/evals/run.ts` |

```bash
npm run eval              # expect 44/44, in well under a second
npm run eval -- --live    # router accuracy, needs a key
```

**Check:** deliberately break a pattern in `policy.ts` and confirm the suite goes
red. An eval suite you have never seen fail is not evidence of anything.

---

## Stage 15 - The gateway and observability (45 min)

| Order | File |
|---|---|
| 94 | `server/src/ai/pricing.ts` |
| 95 | `server/src/ai/gateway.ts` |
| 96 | add `meter`, `turnId`, `suspicious`, `flags`, `toolCalls` to `ai/state.ts` |
| 97 | swap every agent from `getModel(...).invoke()` to `invokeModel(...)` |
| 98 | add `Trace` to `schema.prisma`, then `npm run db:push` |
| 99 | `server/src/services/trace.service.ts` |
| 100 | `server/src/routes/insights.routes.ts` |

**Check:** send a few messages, then `GET /api/insights`. Latency, tokens and
cost should be non-zero, and the router should report cache hits on a repeated
question.

---

## Stage 16 - The last UI pieces (30 min)

| Order | File |
|---|---|
| 101 | `web/src/components/chat/ApprovalCard.tsx` |
| 102 | `web/src/components/chat/UsageStrip.tsx` |
| 103 | approvals + usage in `web/src/store/chat.store.ts` |
| 104 | `web/src/pages/Insights.tsx` |
| 105 | add the Insights route and nav item |

**Check:** ask the agent to send an email, see the approval card with the real
body, approve it, and watch the confirmation appear in the transcript.

---

## Total

**Roughly 12–13 hours** of focused work, spread over 16 checkpoints.

| Stage | Hours |
|---|---|
| 0–4 Foundation, auth, Google, services | 2.5 |
| 5–6 Graph + workspace agent | 1.75 |
| 7 The other eight agents | 1.5 |
| 8–9 Notifications + MCP | 1.0 |
| 10–12 Frontend | 2.5 |
| 13 Guardrails | 1.0 |
| 14 Evals | 0.75 |
| 15 Gateway + observability | 0.75 |
| 16 Approval and Insights UI | 0.5 |

---

## If something breaks

| Symptom | Almost always |
|---|---|
| `Cannot find module './env'` | missing `.js` extension on a relative import |
| Every request is 401 | `credentials: "include"` missing in `api.ts`, or `APP_URL` does not match the Vite origin |
| `invalid_grant` from Google | no refresh token stored — re-consent with `prompt: "consent"` |
| SSE arrives all at once at the end | a proxy is buffering; `X-Accel-Buffering: no` is already set, check your own proxy |
| Notifications appear twice in dev | React StrictMode double-mount — `connect()` must be idempotent |
| Credits go negative | the charge is not a single atomic conditional update |
| The router always picks `chat` | the model is returning prose; check the parser takes the first *valid* word |
| An eval fails on a regex you just edited | a scripted edit may have mangled a backslash. `grep -P '[\x00-\x08]'` over `src/` finds stray control bytes |
| `send_mail` actually sent | the tool is calling Gmail directly instead of `proposeAction` |
| Approving does nothing | the tool name is missing from the `EXECUTORS` table in `approval.routes.ts` |
| Cost is always 0 | the model id is not in `ai/pricing.ts`, or the provider does not report token usage |
