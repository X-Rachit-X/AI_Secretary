import Markdown from "../Markdown";
import type { Artifact, ChatMessage } from "@/lib/types";

/**
 * One turn in the transcript.
 *
 * User turns are plain text in a filled bubble; assistant turns are rendered
 * Markdown on the page background. Deliberately asymmetric: the assistant
 * writes long structured answers, and boxing those in a bubble makes tables
 * and code blocks cramped.
 */

/** Short, human label for the agent that produced an answer. */
const AGENT_LABEL: Record<string, string> = {
  chat: "Chat",
  search: "Web search",
  coding: "Code",
  pdf: "PDF",
  ppt: "Slides",
  image: "Image",
  vision: "Vision",
  docqa: "Document",
  workspace: "Calendar & Mail",
};

export default function MessageBubble({
  message,
  onOpenArtifact,
}: {
  message: ChatMessage;
  onOpenArtifact: (artifact: Artifact) => void;
}) {
  if (message.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[78%] whitespace-pre-wrap rounded-2xl rounded-br-sm bg-brand px-4 py-2.5 text-sm text-white">
          {message.content}
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-[88%]">
      {message.agent && (
        <div className="mb-1.5 inline-flex items-center gap-1.5 rounded-full border border-border bg-surface px-2.5 py-0.5 text-[10px] uppercase tracking-wide text-muted">
          <span className="size-1.5 rounded-full bg-brand" />
          {AGENT_LABEL[message.agent] ?? message.agent}
        </div>
      )}

      <Markdown>{message.content}</Markdown>

      {/* Image strip from the search and image agents. */}
      {message.images.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          {message.images.slice(0, 6).map((url) => (
            <a key={url} href={url} target="_blank" rel="noreferrer">
              <img
                src={url}
                alt=""
                loading="lazy"
                className="size-28 rounded-lg border border-border object-cover transition hover:brightness-110"
              />
            </a>
          ))}
        </div>
      )}

      {/* Generated code projects open in the side panel. */}
      {message.artifacts.map((artifact) => (
        <button
          key={artifact.id}
          onClick={() => onOpenArtifact(artifact)}
          className="mt-3 flex w-full items-center gap-3 rounded-xl border border-border bg-surface px-4 py-3 text-left transition hover:border-brand"
        >
          <div className="grid size-9 shrink-0 place-items-center rounded-lg bg-brand-soft text-xs font-bold">
            {artifact.files.length}
          </div>
          <div className="min-w-0">
            <div className="truncate text-sm font-medium">{artifact.title}</div>
            <div className="text-xs text-muted">
              {artifact.files.map((file) => file.name).join(" · ")}
            </div>
          </div>
        </button>
      ))}
    </div>
  );
}
