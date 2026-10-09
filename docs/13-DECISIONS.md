# 13. Decisions

Why the architecture is what it is — one record per decision, each with the
trade-off it carries and the trigger that would change it.

Short, numbered, and written so you can defend them. The last column is the
important one: **a decision you cannot say "revisit when…" about is a guess.**

| # | Decision | Status |
|---|---|---|
| [1](#adr-1-one-process-not-microservices) | One process, not microservices | accepted |
| [2](#adr-2-no-redis) | No Redis | accepted, with a migration path |
| [3](#adr-3-no-vector-database) | No vector database | accepted |
| [4](#adr-4-sqlite-in-development-postgres-in-production) | SQLite in dev, Postgres in prod | accepted |
| [5](#adr-5-local-file-storage-not-s3) | Local file storage, not S3 | accepted |
| [6](#adr-6-one-google-oauth-client-for-sign-in-and-data) | One Google OAuth client for both jobs | accepted |
| [7](#adr-7-signed-cookie-sessions-not-a-session-store) | Signed-cookie sessions | accepted, with a known limit |
| [8](#adr-8-langgraph-for-the-agent-system) | LangGraph, and only LangGraph | accepted |
| [9](#adr-9-one-agent-holds-all-16-google-tools) | One agent holds all 16 Google tools | accepted |
| [10](#adr-10-human-approval-as-the-hard-safety-boundary) | Human approval as the hard boundary | accepted |
| [11](#adr-11-an-in-process-llm-gateway) | An in-process LLM gateway | accepted |
| [12](#adr-12-tagged-text-not-json-for-structured-output) | Tagged text, not JSON | accepted |
| [13](#adr-13-sse-not-websockets) | SSE, not WebSockets | accepted |
| [14](#adr-14-offline-first-evals) | Offline-first evals | accepted |
| [15](#adr-15-a-trace-table-not-a-tracing-sdk) | A table, not a tracing SDK | accepted |
| [16](#adr-16-content-capabilities-are-tools-not-agents) | Content capabilities are tools, not agents | accepted, replaced ADR 16 v1 |
| [17](#adr-17-cache-three-of-the-six-layers) | Cache three of the six layers | accepted |
| [18](#adr-18-cron-in-process-with-a-worker-escape-hatch) | Cron in-process, with a worker escape hatch | accepted |
| [19](#adr-19-vision-and-docqa-stay-nodes-for-now) | `vision` and `docqa` stay nodes, for now | **accepted with a known inconsistency** |
| [20](#adr-20-the-credit-system-stays-though-it-is-not-needed) | The credit system stays, though it is not needed | **accepted, deliberately unnecessary** |
| [21](#adr-21-studio-and-workspace-do-not-collaborate) | `studio` and `workspace` do not collaborate | **accepted limitation** |

---

## ADR 1: One process, not microservices

**Decision.** One Express application containing routes, agents, tools, Google
integration, guardrails, the scheduler and the MCP server.

**Why.** Every piece scales with the same traffic — a chat turn uses the router,
an agent, the Google layer and the database together. Splitting them buys
independent deployment that nobody here needs, and costs a reader the ability to
follow one request end to end.

**Trade-off.** One process is one blast radius: a crash takes everything. One
deploy ships everything. You cannot scale the PDF generator separately from the
router.

**Why that is acceptable.** The interfaces are narrow on purpose, so splitting
later is mechanical rather than a rewrite — `lib/storage.ts` is two functions,
`checkRateLimit()` is one.

**Revisit when** a component develops a genuinely different scaling profile —
for example document ingestion becoming a long-running background job.

---

## ADR 2: No Redis

**Decision.** The rate limiter and the gateway cache are in-process `Map`s. The
notification fan-out is a Node `EventEmitter`.

**Why.** All three are correct for a single process, and Redis is a service to
run, secure, back up and pay for.

**Trade-off, stated precisely.** With N instances:

| Component | What breaks |
|---|---|
| `ratelimit.service.ts` | each instance allows the full limit, so the effective limit is N× the intended one |
| `gateway.ts` cache | lower hit rate. Not incorrect, just less useful |
| `notification.service.ts` | an SSE client on instance A never sees an event emitted on B |

**The migration path, already designed for.** `checkRateLimit(userId, agent)`
keeps its exact signature when the body becomes Redis `INCR` + `EXPIRE`. The
cache key already includes provider and model id
([`gateway.ts`](../server/src/ai/gateway.ts)) precisely so it is safe to share
across processes. Notifications become Redis pub/sub behind the same `bus`
interface.

**Revisit when** you run more than one instance. Not before.

---

## ADR 3: No vector database

**Decision.** Document Q&A uses
[`ai/vector-store.ts`](../server/src/ai/vector-store.ts) — about 100 lines of
cosine similarity over an in-memory array, built per request and discarded.

**Why.** The current feature is: upload one PDF, ask one question. The index
lives for one request. The *embeddings* are the cost; the database would be pure
operations work. A linear scan over the few hundred chunks a document produces
is microseconds.

**Trade-off.** Honestly:

- a follow-up question **re-embeds the whole document**
- no persistence, so no searching across documents
- no metadata filtering, no per-user document isolation, no citations to a
  stored source
- O(n) per query, which is fine at hundreds of vectors and not at millions

**Cheap improvement available now.** Persist the store keyed by file hash and the
re-embedding goes away in about ten lines.

**Revisit when** document Q&A becomes a durable knowledge base — several
documents, repeated queries, per-user isolation. Then evaluate **Postgres with
`pgvector` first**, because the database is already there and it is one
extension rather than one more service. Choose a dedicated vector database only
if its retrieval features or scale genuinely justify the extra component.

If you do: you also need document ids, chunk metadata, source citations,
deletion, access control and a repeatable ingestion path. That is a feature, not
a swap.

---

## ADR 4: SQLite in development, Postgres in production

**Decision.** Two generated schema files. `prisma/schema.prisma` is SQLite and
hand-edited; `prisma/postgres/schema.prisma` is Postgres and generated from it
by `npm run db:pg:sync`.

**Why.** Zero install locally — SQLite is a file, so `git clone && npm run setup`
works with nothing else installed. Postgres in production because SQLite has one
writer and most hosts give containers an ephemeral filesystem.

**Why generated rather than two hand-maintained files.** Hand-maintaining both is
how they drift apart. There is one place to write a model, and CI fails if the
generated file is stale.

**Trade-off.** Two files to keep in step, and a model change is a two-step
process (`db:push`, then `db:pg:migrate`). Prisma cannot pick a provider from an
environment variable, so this is the available option.

**Revisit when** Prisma supports a runtime provider, or if the two-step flow
causes a missed migration in practice.

---

## ADR 5: Local file storage, not S3

**Decision.** Generated PDFs, decks and images go to `server/storage/<userId>/`,
indexed by a `StoredFile` row and served by an authenticated
`GET /api/files/:id`.

**Why.** No cloud account to set up. And because the app serves the bytes,
**links in old conversations never expire** — the presigned-URL approach gives
every transcript a 24-hour shelf life.

**Trade-off.** Does not work across multiple hosts; needs a mounted volume to
survive a redeploy; file serving uses app bandwidth.

**The migration path.** `lib/storage.ts` exposes `saveBuffer()` and
`publicUrl()` and nothing else. Swapping to S3 means rewriting that one file.

**Revisit when** you run on more than one host.

---

## ADR 6: One Google OAuth client for sign-in and data

**Decision.** A single consent grants `openid email profile` **and** the Calendar
and Gmail scopes. Signing in *is* the data grant.

**Why.** The obvious alternative is one provider for identity and another for
outbound API grants — two vendors, two consent screens, two token stores, and a
user who connects their calendar as a separate step they can forget.

**Trade-off.** The consent screen asks for a lot up front, which is a higher bar
to click through. And it is Google-only: there is no "sign in with GitHub" path
without adding an identity layer back.

**Revisit when** you need non-Google sign-in, or when the scopes get broad enough
that asking for everything at sign-up hurts conversion.

---

## ADR 7: Signed-cookie sessions, not a session store

**Decision.** A JWT in an httpOnly, `sameSite: "lax"`, `secure`-in-production
cookie. Seven-day expiry.

**Why.** No store to run. The secret verifies the token, so there is no lookup
per request.

**Trade-off — and this is a real limitation.** You cannot revoke one session.
Rotating `SESSION_SECRET` signs **everyone** out; that is the only revocation
mechanism, and it doubles as the emergency "sign everyone out" button.

**What reduces the exposure.** Seven-day expiry keeps the window short, and
`require-auth.ts` loads the user **row** on every request rather than trusting
the token alone — so a deleted account cannot keep using an old cookie, and a
credit change takes effect immediately.

**Revisit when** you need per-session revocation, an admin "log this user out"
button, or visible active-session management.

---

## ADR 8: LangGraph for the agent system

**Decision.** LangChain for models and tools, LangGraph for the graph. No second
agent framework on top.

**Why.** An explicit state machine with one inspectable state object, and
compile-time validation of the wiring so a typo in a destination fails at boot
rather than mid-conversation.

**Trade-off, honestly.** For five nodes, a `switch` statement would also work.
The graph is justified by state being one inspectable object and by compile-time
validation of the wiring, not by necessity at this size.

**Why not a second framework.** Two agent abstractions means debugging through
both, and one is enough.

**Revisit when** flows become genuinely branching — a planner that
decomposes work, retries individual sub-steps, or runs agents in parallel. That
is where a graph stops being a nicety.

---

## ADR 9: One agent holds all 16 Google tools

**Decision.** `workspace` has all seven calendar, six mail and three
notification tools, rather than separate calendar and mail agents.

**Why.** Real requests cross domains: *"find the thread about the launch, book
30 minutes with everyone on it, and remind me an hour before"* is mail, calendar
and notifications in one sentence. An agent that could only see one would have
to hand work back to the user.

**Trade-off.** Sixteen tool descriptions compete for the model's attention, and
tool-selection accuracy degrades as the toolbelt grows. The descriptions do the
disambiguation work, which puts real weight on them.

**Revisit when** the count passes roughly 25, or when a live eval shows
selection accuracy dropping. Then split by domain and put a planner above them
— but get the evidence from
[`router.eval.ts`](../server/src/evals/router.eval.ts) first, rather than
assuming.

---

## ADR 10: Human approval as the hard safety boundary

**Decision.** `send_mail`, `reply_to_mail` and `cancel_meeting` do not act. They
write a `PendingAction` row and return `approval_required`. The user approves,
and the server then executes the **stored arguments with no model involved**.

**Why.** The agent reads email, so anyone on the internet can put text into its
context. Text-based defences — pattern matching, delimiters, a firm system
prompt — can all be talked around, because the attacker writes the text. A
database row and a button cannot.

**Trade-off.** Two round trips for any send, and an MCP host **cannot send mail
at all** — it can draft and propose, and the human confirms in the app. That is
intended behaviour, not a limitation, and it is the right default when the
alternative is an unsupervised agent with a mailbox.

**The boundary question people ask.** The REST routes
(`POST /api/mail/messages`) *do* send directly without approval. That is not a
bypass: those are a human clicking Send in the Mail UI. The model cannot make
HTTP requests — it only has the tools it was given — so it cannot reach them.
The gate is on **agent-initiated** actions, which is where the risk is.

**Revisit when** a specific action is proven safe to automate, with an audit
trail. Per-recipient allowlists would be the gentle version.

---

## ADR 11: An in-process LLM gateway

**Decision.** Every model call goes through `invokeModel()` in
[`ai/gateway.ts`](../server/src/ai/gateway.ts) — cache, timeout, retry with
jittered backoff, fallback provider, and token/cost accounting.

**Why.** The alternative was `model.invoke()` scattered across every agent and
content function: a copy of the retry logic in each, several that forget the
timeout, and no way to answer "what did today cost".

**Explicitly not a deployed gateway service.** It is a function. A hosted
provider router (OpenRouter, LiteLLM, Portkey) is a *different* layer and can
sit behind it — set `LLM_PROVIDER=openrouter` and both apply. They are not
alternatives.

**On the cache.** Restricted to an explicit `CACHEABLE_ROLES` allowlist, which
today holds only `router`. The key includes role, provider and model id — because
*"temperature is 0"* is not on its own a sufficient reason to cache: a
deterministic model is only deterministic for a **fixed** model. The user id is
deliberately **not** in the key, because cacheable roles return a bounded label
from a fixed vocabulary (one agent name), never user content — so a shared hit
leaks nothing. Any role returning user-specific text would have to be keyed per
user, which is exactly why the allowlist is short and explicit.

**Trade-off.** In-process means the cache is lost on restart and not shared
across instances, and the circuit breaker is per instance.

**Revisit when** you run multiple instances (move the cache to Redis — the key
is already safe for it), or when you want request-level cost attribution across
services.

---

## ADR 12: Tagged text, not JSON, for structured output

**Decision.** The PDF and PPT agents ask for `TITLE:` / `SECTION:` / `P:` /
`SLIDE:` lines and parse them line by line, rather than requesting JSON.

**Why.** Model JSON fails in a dozen ways — a trailing comma, a smart quote, a
stray ```` ```json ```` fence — and every failure throws away a call you already
paid for. A line format **degrades**: an unrecognised line is skipped and the
rest still renders. A chatty preamble does not break it.

**Trade-off.** A bespoke parser to maintain, and no schema validation. Mitigated
by 14 eval cases in
[`parsers.eval.ts`](../server/src/evals/parsers.eval.ts) covering the malformed
inputs explicitly, including one where unusable output must yield **zero**
slides so the agent refunds instead of charging.

**Revisit when** you adopt provider-native structured output (strict JSON
schema / constrained decoding), which removes the failure mode this works around.
Keep the degradation tests either way.

---

## ADR 13: SSE, not WebSockets

**Decision.** Server-Sent Events for agent progress and the notification feed.

**Why.** The traffic is one-directional — the browser sends one request and
receives many updates — and SSE rides on a plain HTTP response, so there is no
second server, no upgrade handshake, and automatic reconnection semantics.

**Trade-off.** The browser's `EventSource` only does GET with no body, and
sending a message needs POST with an optional file. So the response body is read
as a stream and the framing parsed by hand in
[`web/src/lib/sse.ts`](../web/src/lib/sse.ts) — about 40 lines, with one subtle
requirement: a network chunk does not align with an event boundary, so the
incomplete tail must be buffered for the next chunk.

Also: proxies buffer by default, which silently breaks streaming in production
unless configured (`flush_interval -1` in Caddy, `proxy_buffering off` in nginx).

**Revisit when** you need bidirectional, low-latency traffic — collaborative
editing or voice.

---

## ADR 14: Offline-first evals

**Decision.** Two suites. Offline (44 cases: guardrails, parsers, vector store,
attachment routing) needs **no API key** and runs in ~40ms. Live (21 router
cases) is opt-in behind `--live`.

**Why.** The usual failure mode for an eval suite is that it needs credentials,
so it is slow and costs money, so it gets skipped in CI, so it rots. The offline
suite covers every guardrail and both output parsers — exactly the code you least
want to regress — and there is no excuse not to run it.

**Trade-off.** The offline suite cannot measure answer quality or routing
accuracy, which are the things a user notices. That is what `--live` is for, and
it needs running deliberately before a prompt change.

**Evidence it works.** The suite found three real bugs on its first run,
written up in [07-EVALS §7.5](07-EVALS.md).

**Revisit when** you want regression testing of answer quality — then add an
LLM-judge suite, accepting that it is non-deterministic and costs money.

---

## ADR 15: A `Trace` table, not a tracing SDK

**Decision.** One row per run in a `Trace` table, plus a page that aggregates it.
No OpenTelemetry, no vendor SDK.

**Why.** The questions are "what did this cost", "which agent is slow" and
"which guardrails fired". All three are a `SELECT` away. A tracing SDK answers a
different question — correlating spans across services — and there is one
service.

**Trade-off.** No distributed tracing, no span-level timing (model vs tool time),
no alerting, no retention policy by default.

**Revisit when** there is a second process to correlate across — a queue, a
worker, a split service. Then OpenTelemetry, and it will be the right choice
*because* of that, not because it looks impressive.

---

## ADR 16: Content capabilities are tools, not agents

**Decision.** `search`, `pdf`, `ppt`, `image` and `coding` are **tools** of a
single ReAct agent (`studio`), not graph nodes. The graph has five nodes: `chat`,
`studio`, `workspace`, `vision`, `docqa`.

**Why.** The test is *does it decide anything?* Each of those five did exactly
one model call, a parse and a render. No loop, no branch, nothing learned at
runtime. They were tools, and treating them as agents forced the **graph** to do
their deciding — in advance, from the prompt alone.

That produced two wrong designs in sequence:

1. **One agent per request.** *"Research RAG and make a deck"* was impossible.
   A hardcoded `search → chat` edge existed as the single exception, which was
   the design admitting the gap.
2. **A plan.** The router returned an ordered list and the graph walked it.
   Worked, but needed two state channels, a `parsePlan` with four correction
   rules, a `nextInPlan` edge function, a `withPlanAdvance` wrapper and 15 eval
   cases — a scheduler, written because the scheduled things could not decide.

**What the refactor deleted.** `state.plan`, `state.planStep`, `parsePlan`,
`nextInPlan`, `withPlanAdvance`, four graph nodes, and the 15 plan eval cases.
Graph state went from 17 channels to 15.

**What it gained** — things a fixed plan structurally cannot do: reacting to an
empty search instead of writing an unresearched document; re-querying when the
first search was too narrow; skipping research that turns out to be unnecessary;
and producing two artefacts in one turn.

**Trade-off.** A ReAct loop is less predictable than a plan: the model chooses
how many tool calls to make, so cost per turn varies. Mitigated by per-turn
budgets in `content.tools.ts` (3 searches, 2 generations) and
`recursionLimit: 18`. Tool-selection accuracy also matters more now, which puts
real weight on the tool descriptions.

**Why `studio` and `workspace` are separate loops.** Merging them would mean 21
tool descriptions competing for attention in one prompt, and the Google tools
carry a human-approval gate and a very different system prompt. Two focused
loops beat one crowded one.

**Why `chat` is still one-shot.** A plain question should not pay for a loop
whose only decision is that it needs no tools.

**Revisit when** a content capability starts needing to make a runtime choice —
then it becomes an agent, and the honest move is to give it its own loop rather
than branch inside a tool.

---

## ADR 17: Cache three of the six layers

**Decision.** Cache exact-match responses (router only), embeddings, and HTTP
assets. Do not use provider prompt caching, semantic caching, or tool-result
caching.

**Why each.**

| Layer | Decision | Reason |
|---|---|---|
| Exact-match response | ✓ router only | the router returns a bounded label, so a shared hit leaks nothing and cannot be creative |
| Embedding | ✓ | an embedding is a **pure function** of (text, model), so caching cannot change a result — only skip paid work |
| HTTP / CDN | ✓ | Vite hashes asset names, so they are immutable; `index.html` is `no-cache` because it points at those names |
| Provider prompt cache | ✗ | the system prompt is ~1,500 tokens (under most minimums) and embeds the current time plus per-user preferences, so it differs every call |
| Semantic cache | ✗ | *"am I free at 4pm"* and *"at 5pm"* are neighbours in embedding space with different correct answers. Silent wrong answers are the worst failure mode available |
| Tool results | ✗ | the calendar is the thing being asked about; a stale answer about your own day is worse than a slow one |

**The key design point.** `"temperature is 0"` is not on its own a sufficient
caching rule — a deterministic model is only deterministic for a **fixed**
model. So the response-cache key is `role | provider | modelId | hash(input)`,
and `CACHEABLE_ROLES` is a short explicit allowlist rather than a predicate.
The user id is deliberately absent, because cacheable roles never return user
content.

**Trade-off.** Both caches are in-process: lost on restart, not shared across
instances. The embedding cache is bounded at 5,000 entries and evicts oldest
first, so a very large corpus would thrash it.

**Revisit when** the system prompt is restructured into a static prefix plus a
dynamic suffix — that unlocks provider prompt caching, which is the highest-value
remaining win. Or when you run multiple instances and want a shared cache in
Redis (the response key is already safe for it).

---

## ADR 18: Cron in-process, with a worker escape hatch

**Decision.** `node-cron` runs the reminder sweep inside the web process by
default. `ENABLE_SCHEDULER=false` plus `npm run worker` splits it out.

**Why in-process.** One recurring job, idempotent, finishing in milliseconds. A
queue (BullMQ) would mean Redis, a worker process and a dashboard to run one
function on a timer.

**Why the escape hatch exists.** Two things break the default, and both are
real in production:

1. **N instances run N sweeps.** Every web process has its own cron. `dedupeKey`
   makes the duplicates harmless — a repeat writes nothing — but it is still N×
   the Google quota for one result.
2. **Idle hosts suspend containers.** Fly, Railway and Render stop a container
   with no traffic, which stops the cron. Reminders then only fire while someone
   is using the app, which is exactly backwards for a feature meant to tell you
   about something *before* it happens.

So [`worker.ts`](../server/src/worker.ts) runs the scheduler and nothing else —
no HTTP server, so a host scaling on request volume leaves it alone. It refuses
to start when `ENABLE_SCHEDULER` is false rather than idling silently.

**Trade-off.** One worker replica, enforced by convention rather than by a lock.
Two would reintroduce duplicate sweeps. A real distributed lock or a queue with
a single consumer is the next step up.

**Revisit when** you need more than one kind of background job, retries with
backoff per job, or a job that takes minutes rather than milliseconds. Then a
queue earns its keep.

---

## ADR 19: `vision` and `docqa` stay nodes, for now

**Status: accepted, with a known inconsistency.** This one does not fully hold
up, and saying so is more useful than pretending otherwise.

**Decision.** `vision` and `docqa` remain graph nodes rather than becoming tools
of the studio agent.

**Why it is inconsistent.** [ADR 16](#adr-16-content-capabilities-are-tools-not-agents)
established the rule: *an agent decides, a tool does.* Apply it honestly:

| Node | What it does | Decides anything? |
|---|---|---|
| `vision` | read file → one model call → answer | **no** |
| `docqa` | extract → chunk → embed → search → one model call → answer | **no** |

Neither loops. Neither branches on anything learned at runtime. By the same rule
that turned `pdf`, `ppt`, `image`, `coding` and `search` into tools, **these are
tools too** — `analyze_image` and `read_document`.

**Why they are still nodes.** The router selects them deterministically from the
upload's MIME type, which made keeping them as nodes the smaller change at the
time. But that is an argument about *routing convenience*, not evidence they
make decisions. The rule does not have an exception for "the router already
knows".

**What it costs, concretely.** A real request is impossible today:

> *"Summarise this PDF and make slides from it."*

`docqa` answers and the turn ends. As a studio tool it would be
`read_document` then `make_deck`. Same for *"what's in this screenshot? put it in
a doc"*.

**What fixing it looks like.** Move both into `ai/content/`, wrap as tools, and
have the router send any file upload to `studio` with the file in state. The
graph drops to three nodes — `chat`, `studio`, `workspace` — and the change
deletes more code than it adds.

**Revisit when** someone asks for a document-plus-generation request, or sooner
if consistency matters more than the hour it takes. It is tracked rather than
hidden because an inconsistency you can name is a different thing from one you
have not noticed.

---

## ADR 20: The credit system stays, though it is not needed

**Status: accepted, deliberately unnecessary.**

**Decision.** Keep `services/credits.service.ts`, the wallet columns and
`runBilled`, even though a single-user personal assistant has no billing
problem to solve.

**The honest position.** This is complexity without a requirement. There is one
user. They own the API keys. Charging themselves credits protects nobody, and
the per-agent rate limiter already caps runaway loops — so the two together are
belt-and-braces for an audience of one.

**Why it stays anyway.** It is a working demonstration of two things that are
genuinely hard to get right and that interviewers ask about:

```ts
// the check and the decrement in ONE statement
const result = await prisma.user.updateMany({
  where: { id: userId, credits: { gte: cost } },
  data:  { credits: { decrement: cost } },
});
if (result.count === 0) throw AppError.insufficientCredits(cost, have);
```

A read-then-write would let two parallel requests both pass the balance check
and push it negative. And `runBilled` is a **compensating transaction**: charge,
run, refund on throw — so a malformed model response costs the user nothing.

**Trade-off.** Roughly 120 lines and one mental concept that a reader has to
carry while learning the rest of the system.

**Revisit when** the project is being judged on minimalism rather than on
breadth, or if it ever genuinely becomes single-user-only with no intention of
showing the pattern. Removing it is a clean deletion: drop the service, the two
columns, the header counter, and unwrap `runBilled`.

---

## ADR 21: `studio` and `workspace` do not collaborate

**Status: accepted limitation.**

**Decision.** The two ReAct loops are siblings under the router. Neither can
call the other, and there is no supervisor above them.

**What that costs.** Requests spanning both fail:

> *"Summarise my unread mail into a PDF."*
> *"Make a deck from my Q3 meeting notes."*

`workspace` can read the mail and `studio` can make the PDF, but no path does
both. The router picks one, and that one does what it can.

**Why it is this way.** The alternative is a supervisor that delegates to both —
which is the re-planning supervisor argued against in
[ADR 16](#adr-16-content-capabilities-are-tools-not-agents). It costs a model
call per delegation, it can loop, and it reintroduces the orchestration layer
just deleted.

The two loops are also deliberately separate: 21 tool descriptions in one prompt
degrades selection, and the Google tools carry a human-approval gate and a very
different system prompt. Merging them would dilute both.

**The honest framing.** This is the price of two focused loops instead of one
crowded one, and it is a real price — not a non-issue.

**Revisit when** cross-domain requests actually come up. The cheapest fix is not
a full supervisor: give `studio` a single read-only `fetch_my_mail` tool, so the
common direction (workspace data → studio artefact) works without a new
orchestration layer and without the approval-gated write tools leaking into the
studio prompt.

---

## How to add a decision

When you make an architectural choice, add a record with the same five parts:

```markdown
## ADR n: <the decision, as a statement>

**Decision.** What is true now.
**Why.** The reason, in terms of a problem the code actually has.
**Trade-off.** What this costs. Be specific; vague is unconvincing.
**Revisit when** the condition that would flip it.
```

> 💡 In an interview, the fourth and fifth parts are what distinguish someone who
> made a choice from someone who copied one. Being able to say *"no Redis,
> because one process — and here are the exact three things that break at two
> instances"* is a much stronger answer than either "I used Redis" or "I didn't
> need Redis".

<!-- nav -->

---

[← Observability](12-OBSERVABILITY.md) · [Index](README.md)
