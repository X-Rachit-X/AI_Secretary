import type { Response } from "express";

/**
 * Server-Sent Events helper.
 *
 * Used by two endpoints: agent chat streaming (token by token) and the live
 * notification feed. SSE rather than WebSockets because the traffic is
 * one-directional and it rides on a plain HTTP response, so there is no extra
 * server to run.
 */

export type SseStream = {
  send: (event: unknown) => void;
  comment: (text: string) => void;
  close: () => void;
};

export function openSseStream(res: Response): SseStream {
  res.status(200);
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  // Stops nginx from buffering the stream into one big chunk at the end.
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  let closed = false;

  // Proxies and browsers drop idle connections. A comment line every 25s is
  // invisible to the event handler on the client but keeps the socket alive.
  const heartbeat = setInterval(() => {
    if (!closed) res.write(": ping\n\n");
  }, 25000);

  const finish = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
  };

  res.on("close", finish);

  return {
    send(event: unknown) {
      if (closed) return;
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    },
    comment(text: string) {
      if (closed) return;
      res.write(`: ${text}\n\n`);
    },
    close() {
      finish();
      res.end();
    },
  };
}
