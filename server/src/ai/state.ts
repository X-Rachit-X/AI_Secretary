import { Annotation } from "@langchain/langgraph";
import type { Artifact } from "../services/conversation.service.js";
import type { UsageMeter } from "./gateway.js";

/**
 * The shared state that flows through the graph.
 *
 * Read this file first when you want to understand the graph: every node reads
 * from this object and returns a PARTIAL update to it. The default reducer per
 * channel is "last value wins", so a node that returns `{ response: "..." }`
 * leaves every other field untouched.
 *
 * Fields split into three groups:
 *  - inputs  : set by the route handler before invoke()
 *  - routing : written by the router node
 *  - outputs : written by whichever agent ran
 */

/**
 * The graph's nodes.
 *
 * Shorter than it was: search / pdf / ppt / image / coding became TOOLS of the
 * studio agent, because none of them decided anything — each was one model
 * call, a parse and a render. See graph.ts.
 */
export type AgentName =
  | "chat"
  | "studio"
  | "workspace"
  | "vision"
  | "docqa";

export type UploadedFile = {
  path: string;
  mimetype: string;
  originalname: string;
  size: number;
};

export type HistoryTurn = { role: "user" | "assistant"; content: string };

/** What a node calls to report progress while it works (drives the SSE stream). */
export type ProgressFn = (message: string) => void;

export const GraphState = Annotation.Root({
  // ── inputs ────────────────────────────────────────────────────────────────
  /** The user's message for this turn. */
  prompt: Annotation<string>(),

  /** AI Secretary User.id. Needed for Google calls, credits and storage. */
  userId: Annotation<string>(),

  /** Conversation this turn belongs to. */
  conversationId: Annotation<string>(),

  /** Previous turns, oldest first, already trimmed to a sane length. */
  history: Annotation<HistoryTurn[]>({
    reducer: (_previous, next) => next,
    default: () => [],
  }),

  /** A PDF or image attached to this turn, if any. */
  file: Annotation<UploadedFile | undefined>({
    reducer: (_previous, next) => next,
    default: () => undefined,
  }),

  /** Streams status lines back to the browser. Never persisted. */
  onProgress: Annotation<ProgressFn>({
    reducer: (_previous, next) => next,
    default: () => () => {},
  }),

  /**
   * Collects token counts and cost from every model call in this run,
   * including the ones inside the ReAct loop. Written by the gateway, read by
   * the route when it records the Trace row.
   */
  meter: Annotation<UsageMeter | undefined>({
    reducer: (_previous, next) => next,
    default: () => undefined,
  }),

  /**
   * Identifies this single turn. The tool guard keys its per-turn write budget
   * on it, so counts cannot leak between turns or between users.
   */
  turnId: Annotation<string>({
    reducer: (_previous, next) => next,
    default: () => "",
  }),

  /**
   * Set when the input guard saw injection-like phrasing. Agents that read
   * external content append a defensive note to their system prompt.
   */
  suspicious: Annotation<boolean>({
    reducer: (_previous, next) => next,
    default: () => false,
  }),

  // ── routing ───────────────────────────────────────────────────────────────
  /**
   * "auto" on the way in (let the router decide), or a concrete agent when the
   * user picked one in the UI. The router node overwrites it with its answer,
   * so after the router runs this is always a real agent name.
   *
   * Stored on the assistant message and shown as the badge in the UI.
   */
  agent: Annotation<AgentName | "auto">({
    reducer: (_previous, next) => next,
    default: () => "auto",
  }),

  // ── outputs ───────────────────────────────────────────────────────────────
  /** The Markdown answer shown in the chat bubble. */
  response: Annotation<string>({
    reducer: (_previous, next) => next,
    default: () => "",
  }),

  /** Image URLs to render under the answer (search results, generated art). */
  images: Annotation<string[]>({
    reducer: (_previous, next) => next,
    default: () => [],
  }),

  /** Generated code projects / documents, rendered in the side panel. */
  artifacts: Annotation<Artifact[]>({
    reducer: (_previous, next) => next,
    default: () => [],
  }),

  /**
   * Guardrail labels raised during the run, e.g. "tool.untrusted_instruction".
   * Appended rather than replaced, because several guards can fire in one run.
   */
  flags: Annotation<string[]>({
    reducer: (previous, next) => [...new Set([...(previous ?? []), ...next])],
    default: () => [],
  }),

  /** Tool invocations this run, for the Trace row. */
  toolCalls: Annotation<number>({
    reducer: (previous, next) => (previous ?? 0) + next,
    default: () => 0,
  }),
});

export type GraphStateType = typeof GraphState.State;
