# 1. Architecture

How CortexOne is put together, and why each decision was made.

---

## 1.1 What this project is

Two earlier projects, merged:

| Project | What it had | What survived |
|---|---|---|
| **cortex-ai** | LangGraph supervisor, 8 agents (chat, search, coding, pdf, ppt, image, vision, pdf-RAG), credits, rate limits, artifacts | The whole agent system, redesigned in TypeScript |
| **agentic-calendar-assistant** | Google Calendar tools, an MCP server, streaming chat, working memory | Calendar, MCP, SSE streaming, durable preferences |

Plus what neither had: **Gmail** and **notifications**.

## 1.2 The shape of it

```mermaid
graph TB
    subgraph Browser["Browser — React + TypeScript"]
        UI["Chat · Calendar · Mail · Alerts · Files · Insights"]
    end

    subgraph Server["Node + Express + TypeScript (one process)"]
        direction TB
        R["Routes<br/>/api/auth /api/chat /api/agent /api/calendar<br/>/api/mail /api/notifications /api/approvals /api/insights"]
        GR["Guardrails<br/>input · trust · tool · output"]
        G["LangGraph supervisor<br/>router + 9 agents"]
        GW["LLM gateway<br/>cache · timeout · retry · fallback · cost"]
        S["Services<br/>conversations · credits · rate limit<br/>notifications · scheduler · traces"]
        GO["Google layer<br/>calendar.ts · gmail.ts"]
        MCP["MCP server<br/>stdio + HTTP"]
    end

    subgraph External["Outside"]
        LLM["LLM provider<br/>Gemini / OpenAI / Groq / Claude"]
        GAPI["Google Calendar + Gmail API"]
        TAV["Tavily web search"]
    end

    DB[("SQLite via Prisma")]
    FS[("storage/ — generated files")]

    UI -->|"fetch + SSE"| R
    R --> GR
    GR --> G
    R --> S
    G --> S
    G --> GO
    G --> GW
    GW --> LLM
    G --> TAV
    MCP --> GR
    MCP --> GO
    GO --> GAPI
    S --> DB
    G --> FS

    HOST["Claude Desktop / Cursor"] -.->|"MCP"| MCP
```

**One process.** The original cortex-ai ran five services behind a gateway (auth, chat, billing, agent, gateway) with Redis, MongoDB, Qdrant and S3 behind them. That is a sensible shape for a team deploying independently; it is a bad shape for one person trying to understand a system. Everything here is one Express app, one database and one folder of files.

## 1.3 What was removed, and what replaced it

| Original | Replaced by | Why |
|---|---|---|
| Firebase auth + Descope | Google OAuth 2.0 directly | One consent screen grants sign-in *and* Calendar *and* Gmail. Two auth vendors became zero. |
| Redis sessions | Signed JWT in an httpOnly cookie | No server to run. The token carries the user id; the secret verifies it. |
| Redis chat cache | Nothing | SQLite on the same machine is already sub-millisecond. The cache was pure complexity. |
| Redis rate limiting | In-memory `Map` | Single process, so a shared store buys nothing. Swap for Redis if you ever run replicas. |
| MongoDB + Mongoose | SQLite + Prisma | Zero install, typed queries, one `schema.prisma` to read. |
| Qdrant vector DB | `ai/vector-store.ts`, ~100 lines | A document you throw away after one question does not need a database. |
| AWS S3 + presigned URLs | `storage/` on disk + `/api/files/:id` | No AWS account, and links in old transcripts never expire. |
| Razorpay billing | Credit wallet only | The wallet mechanics are the interesting part; payments need a merchant account. `grantCredits()` is the hook if you add one. |
| Nothing (new) | Four-layer guardrails | The agent reads attacker-controlled email. See [06-GUARDRAILS](06-GUARDRAILS.md). |
| Nothing (new) | LLM gateway | Retry, timeout, fallback, cache and cost accounting in one place. |
| Nothing (new) | Eval harness | 44 offline cases that run with no API key. See [07-EVALS](07-EVALS.md). |
| Mastra agent framework | LangGraph `createReactAgent` | One agent framework instead of two. |
| Next.js frontend | Vite + React | No SSR needed for an authenticated single-page app; Vite starts in under a second. |

## 1.4 The agent graph

This is the core. One router decides; one agent runs.

```mermaid
graph LR
    START(["START"]) --> ROUTER{"router"}

    ROUTER -->|"fresh info"| SEARCH["search"]
    ROUTER -->|"general"| CHAT["chat"]
    ROUTER -->|"build / review"| CODING["coding"]
    ROUTER -->|"document"| PDF["pdf"]
    ROUTER -->|"slides"| PPT["ppt"]
    ROUTER -->|"picture"| IMAGE["image"]
    ROUTER -->|"image upload"| VISION["vision"]
    ROUTER -->|"pdf upload"| DOCQA["docqa"]
    ROUTER -->|"calendar / mail"| WS["workspace"]

    SEARCH -->|"results into state"| CHAT

    CHAT --> END(["END"])
    CODING --> END
    PDF --> END
    PPT --> END
    IMAGE --> END
    VISION --> END
    DOCQA --> END
    WS --> END
```

**One special edge.** `search` does not finish the turn. It fetches results, writes them into state, and hands off to `chat`, which writes the cited answer. That keeps citation style in one place and makes the search provider swappable.

### How the router decides — three stages, cheapest first

```mermaid
flowchart TD
    A["user message arrives"] --> B{"a file attached?"}
    B -->|"image/*"| V["vision"]
    B -->|"application/pdf"| D["docqa"]
    B -->|"no"| C{"user picked an<br/>agent in the UI?"}
    C -->|"yes"| E["use it — no model call"]
    C -->|"auto"| F["ask a small model<br/>to classify intent"]
    F --> G{"valid agent name<br/>in the reply?"}
    G -->|"yes"| H["use it"]
    G -->|"no"| I["fall back to chat"]
```

Stage 3 is the only one that costs a token, which is why it is last. `vision` and `docqa` are deliberately **not** offered to the classifier: they need a file, and the model picking them from text alone would route to an agent with nothing to read.

See [`server/src/ai/router.node.ts`](../server/src/ai/router.node.ts).

### The state that flows through

Every node reads this object and returns a **partial** update to it. Default reducer is last-value-wins, so returning `{ response: "..." }` leaves everything else untouched.

```mermaid
classDiagram
    class GraphState {
        +prompt: string
        +userId: string
        +conversationId: string
        +history: HistoryTurn[]
        +file?: UploadedFile
        +onProgress: (msg) => void
        --
        +agent: AgentName | "auto"
        --
        +response: string
        +images: string[]
        +artifacts: Artifact[]
        +searchResults?: string
    }
```

`searchResults` is `string | undefined` on purpose:

- `undefined` → no search happened
- `""` → search ran and failed
- text → search ran and worked

The chat agent words its answer differently in each case.

See [`server/src/ai/state.ts`](../server/src/ai/state.ts).

## 1.5 Two kinds of agent

Most agents are **one-shot**: call the model once, format the result, done.

```
prompt → model → parse → render → response
```

The `workspace` agent is a **ReAct loop**: the model picks a tool, sees the result, decides what to do next, and repeats until it can answer.

```mermaid
sequenceDiagram
    participant U as User
    participant W as workspace agent
    participant M as Model
    participant T as Tools
    participant G as Google

    U->>W: "move my 3pm to tomorrow<br/>and tell the attendees"
    W->>M: system prompt + tools + message
    M-->>W: call list_meetings
    W->>T: list_meetings()
    T->>G: events.list
    G-->>T: events
    T-->>M: JSON
    M-->>W: call reschedule_meeting(eventId, ...)
    W->>T: reschedule_meeting()
    T->>G: events.patch (sendUpdates: all)
    G-->>T: updated event
    T-->>M: JSON
    M-->>W: final answer, no tool calls
    W-->>U: "Moved to Thu 15:00. Attendees notified."
```

The loop ends when the model returns a message with **no tool calls**. That message is the answer.

`recursionLimit: 24` caps it so a confused model cannot burn the user's quota in a loop.

See [`server/src/ai/agents/workspace.agent.ts`](../server/src/ai/agents/workspace.agent.ts).

## 1.6 The toolbelt

Calendar, Mail and Notification tools are bound together into **one** agent rather than split across three. Real requests cross all three:

> "Find the thread about the launch, book 30 minutes with everyone on it, and remind me an hour before."

An agent that can only see one of them has to hand work back to the user.

```mermaid
graph TB
    WS["workspace agent"]

    subgraph CT["calendar.tools.ts"]
        C1["list_meetings"]
        C2["get_meeting"]
        C3["create_meeting"]
        C4["reschedule_meeting"]
        C5["cancel_meeting"]
        C6["check_busy"]
        C7["find_free_slot"]
    end

    subgraph MT["mail.tools.ts"]
        M1["search_mail"]
        M2["read_mail"]
        M3["send_mail"]
        M4["reply_to_mail"]
        M5["mark_mail_read"]
        M6["mail_stats"]
    end

    subgraph NT["notify.tools.ts"]
        N1["create_reminder"]
        N2["list_notifications"]
        N3["remember_preference"]
    end

    WS --> CT
    WS --> MT
    WS --> NT

    CT --> GC["google/calendar.ts"]
    MT --> GM["google/gmail.ts"]
    NT --> NS["notification.service.ts<br/>+ Preference table"]
```

**`userId` is closed over, never a tool argument.** A model must never be in a position to name whose calendar to read.

## 1.7 Three front doors, one implementation

`google/calendar.ts` and `google/gmail.ts` are plain functions with no framework types. That is what lets three different callers share them:

```mermaid
graph LR
    A["Agent tools<br/>ai/tools/*.ts"] --> CORE
    B["REST routes<br/>routes/calendar.routes.ts<br/>routes/mail.routes.ts"] --> CORE
    C["MCP server<br/>mcp/mcp.tools.ts"] --> CORE

    CORE["google/calendar.ts<br/>google/gmail.ts"] --> G["Google APIs"]
```

| Caller | Used by | Costs an LLM call? |
|---|---|---|
| Agent tools | the chat box | yes |
| REST routes | the Calendar and Mail pages | no |
| MCP server | Claude Desktop, Cursor | their own |

Browsing your inbox should be instant and free. Asking "move my 3pm and tell everyone" is worth a model call. Both paths hit the same code.

## 1.8 Memory: three layers

```mermaid
graph TB
    subgraph L1["Within one turn"]
        A["GraphState<br/>lives for one graph.invoke()"]
    end
    subgraph L2["Within one thread"]
        B["Message table → recentHistory()<br/>last 20 turns, replayed into the model"]
    end
    subgraph L3["Across every thread, forever"]
        C["Preference table<br/>timezone, default meeting length, usual invitees"]
    end

    A -.-> B -.-> C
```

Layer 3 is what makes the assistant feel like it knows you. When the user says *"I'm in IST"*, the workspace agent calls `remember_preference`, and every future conversation gets it injected into the system prompt.

Preferences are injected as **text**, not fetched by a tool: they are small, needed almost every run, and a tool call would be a wasted round trip every time.

## 1.9 Billing and limits

The rule that matters: **charge before the work, refund if it throws.**

```mermaid
flowchart LR
    A["agent node"] --> B["checkRateLimit()"]
    B -->|"over limit"| X1["429 — nothing charged"]
    B -->|"ok"| C["charge credits<br/>atomic conditional update"]
    C -->|"balance too low"| X2["402 — nothing run"]
    C -->|"ok"| D["do the work"]
    D -->|"success"| E["return result"]
    D -->|"throws"| F["refund"] --> G["rethrow"]
```

Charging afterwards would let a user with an empty wallet burn paid LLM and image-generation calls and only find out at the end.

The charge is a single atomic statement:

```ts
prisma.user.updateMany({
  where: { id: userId, credits: { gte: cost } },   // the check
  data:  { credits: { decrement: cost } },          // the decrement
});
```

`count === 0` means the balance was too low. A read-then-write would let two parallel requests both pass the check and push the balance negative.

See [`server/src/services/credits.service.ts`](../server/src/services/credits.service.ts).

## 1.10 Streaming

Both long-lived endpoints use **Server-Sent Events**, not WebSockets. Traffic is one-directional and rides on a plain HTTP response, so there is no second server to run.

```mermaid
sequenceDiagram
    participant B as Browser
    participant R as /api/agent/chat
    participant G as Graph

    B->>R: POST (FormData: prompt, agent, file?)
    R-->>B: 200, Content-Type: text/event-stream
    R-->>B: data: {"type":"started"}
    R->>G: graph.invoke({ ..., onProgress })
    G-->>R: onProgress("Choosing the right agent")
    R-->>B: data: {"type":"progress", ...}
    G-->>R: onProgress("Searching the web")
    R-->>B: data: {"type":"progress", ...}
    G-->>R: final state
    R-->>B: data: {"type":"completed","message":{...},"wallet":{...}}
    R-->>B: stream closed
```

The browser's built-in `EventSource` can only do GET with no body, which rules it out — sending a message needs POST, often with a file. So `web/src/lib/sse.ts` reads the response body as a stream and parses the framing by hand.

**The one thing to get right:** a network chunk does not line up with an event boundary. Anything after the last blank line is kept in a buffer and completed by the next chunk.

## 1.11 Notifications

```mermaid
sequenceDiagram
    participant C as node-cron (every 5 min)
    participant S as scheduler.service
    participant G as Google
    participant DB as Notification table
    participant BUS as EventEmitter
    participant B as Browser (SSE)

    C->>S: tick()
    S->>G: meetings starting within 15 min
    S->>G: unread mail from the last hour
    S->>DB: createNotification({ dedupeKey })
    Note over DB: a seen dedupeKey writes nothing
    DB->>BUS: emit(userId, payload)
    BUS->>B: data: {"type":"notification", ...}
    Note over B: bell updates with no polling
```

`dedupeKey` is what makes it safe to run the sweep every five minutes. `meeting:<eventId>` is written once; later ticks that see the same meeting are no-ops.

## 1.12 Security

| Concern | How it is handled |
|---|---|
| Session theft | httpOnly cookie — unreadable from JavaScript; `secure` in production |
| CSRF on OAuth | random `state` minted before the redirect, required back unchanged |
| Cross-user data | every query is scoped by `userId`; conversations answer **404**, not 403, so ids do not leak |
| Model naming another user | `userId` is closed over in tool factories, never a tool argument |
| Generated code running loose | artifact preview iframe is `sandbox="allow-scripts"` **without** `allow-same-origin` |
| Credential leaks in errors | `toErrorBody()` only echoes messages from `AppError`, which the app itself creates |
| Upload abuse | 20 MB cap, PDF and images only, deleted in a `finally` block |
| Quota abuse | per-user per-agent rate limit, then the credit wallet |

## 1.13 Guardrails: four layers, one of them hard

The agent reads the user's email, which means **anyone on the internet can put
text into its context**. That single fact shapes the safety design.

```mermaid
flowchart LR
    I["1 INPUT<br/>redact secrets<br/>flag injection"] --> TR["2 TRUST<br/>wrap third-party<br/>content as data"]
    TR --> TO["3 TOOL<br/>human approval for<br/>irreversible actions"]
    TO --> O["4 OUTPUT<br/>prompt leaks<br/>unsafe links"]

    style TO fill:#1e3a8a,color:#fff
```

Layers 1, 2 and 4 are text analysis and can be talked around. **Layer 3 cannot**:
`send_mail`, `reply_to_mail` and `cancel_meeting` write a `PendingAction` row
instead of acting, and a human approves it. The server then executes the stored
arguments with **no model involved**, so what runs is exactly what the user read.

MCP gets the same gate — otherwise it would be a hole straight through the policy.

Full detail in [06-GUARDRAILS.md](06-GUARDRAILS.md).

## 1.14 The LLM gateway

Every model call goes through `invokeModel()` in
[`ai/gateway.ts`](../server/src/ai/gateway.ts) rather than `model.invoke()`:

| | |
|---|---|
| **cache** | temperature-0 roles only (the router) |
| **timeout** | a hung provider cannot hold a request open |
| **retry** | transient errors only, exponential backoff with jitter |
| **fallback** | a second provider when the first keeps failing |
| **accounting** | tokens and cost into a per-run `UsageMeter` |

`LLM_PROVIDER=openrouter` uses a hosted gateway instead; the in-process one still
applies on top.

## 1.15 Observability

One `Trace` row per run — agent, latency, tokens, cost, guardrail flags — and an
**Insights** page that answers three questions an agent app cannot answer by
default: what is this costing, which agent is slow, and which guardrails are
actually firing.

A guardrail nobody can see is a guardrail nobody will maintain.

## 1.16 Where to go next

- [02-FILE-GUIDE.md](02-FILE-GUIDE.md) — what every file does
- [03-BUILD-ORDER.md](03-BUILD-ORDER.md) — the order to write them in
- [04-DATA-FLOWS.md](04-DATA-FLOWS.md) — six requests traced end to end
- [05-SETUP.md](05-SETUP.md) — keys, OAuth and running it
- [06-GUARDRAILS.md](06-GUARDRAILS.md) — the four layers, and the attack that shapes them
- [07-EVALS.md](07-EVALS.md) — the eval harness, the gateway and observability
