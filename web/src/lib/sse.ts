import { API_URL } from "./api";
import type { AgentId, AgentStreamEvent } from "./types";

/**
 * Reading Server-Sent Events from a POST.
 *
 * The browser's built-in EventSource can only issue GET requests with no body,
 * which rules it out: sending a chat message needs a POST, often with a file
 * attached. So the response body is read as a stream and the SSE framing is
 * parsed by hand.
 *
 * The format is simple. Events are separated by a blank line, and each line of
 * interest starts with "data: ":
 *
 *     data: {"type":"progress","message":"Searching the web"}
 *     <blank line>
 *
 * The one thing to get right is that a network chunk does NOT line up with an
 * event boundary. A chunk can split an event in half, so anything after the
 * last blank line is kept in `buffer` and completed by the next chunk.
 */

async function readEventStream(
  response: Response,
  onEvent: (event: AgentStreamEvent) => void,
) {
  if (!response.body) throw new Error("The server returned no stream.");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  for (;;) {
    const { value, done } = await reader.read();

    buffer += decoder.decode(value, { stream: !done });

    const blocks = buffer.split("\n\n");
    // The final element is either an incomplete event or an empty string.
    buffer = blocks.pop() ?? "";

    for (const block of blocks) {
      for (const line of block.split("\n")) {
        // ":" prefixed lines are heartbeat comments. Ignore them.
        if (!line.startsWith("data:")) continue;

        const payload = line.slice(5).trim();
        if (!payload) continue;

        try {
          onEvent(JSON.parse(payload) as AgentStreamEvent);
        } catch {
          // A malformed event must not kill the rest of the stream.
          console.warn("[sse] could not parse event:", payload);
        }
      }
    }

    if (done) break;
  }
}

/** Send a chat turn and receive progress events until the answer arrives. */
export async function streamAgentChat(
  input: {
    conversationId: string;
    prompt: string;
    agent: AgentId;
    file?: File | null;
  },
  onEvent: (event: AgentStreamEvent) => void,
) {
  // FormData rather than JSON so the same endpoint handles an attachment.
  const form = new FormData();
  form.set("conversationId", input.conversationId);
  form.set("prompt", input.prompt);
  form.set("agent", input.agent);
  if (input.file) form.set("file", input.file);

  const response = await fetch(`${API_URL}/api/agent/chat`, {
    method: "POST",
    credentials: "include",
    body: form,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(text || `Agent request failed (${response.status})`);
  }

  await readEventStream(response, onEvent);
}

/**
 * Subscribe to the live notification feed.
 *
 * This one IS a plain GET, so EventSource would work; using the same manual
 * reader keeps one parsing implementation and lets the caller abort cleanly.
 * Returns a function that closes the connection.
 */
export function subscribeToNotifications(
  onEvent: (event: unknown) => void,
): () => void {
  const controller = new AbortController();

  (async () => {
    try {
      const response = await fetch(`${API_URL}/api/notifications/stream`, {
        credentials: "include",
        signal: controller.signal,
        headers: { Accept: "text/event-stream" },
      });

      if (!response.ok) return;

      await readEventStream(response, onEvent as never);
    } catch {
      // Aborted on unmount, or the user signed out. Neither is worth reporting.
    }
  })();

  return () => controller.abort();
}
