import { useState } from "react";
import { Check, ShieldAlert, X } from "lucide-react";
import { useChat } from "@/store/chat.store";
import type { PendingApproval } from "@/lib/types";

/**
 * The human-in-the-loop gate, as a UI.
 *
 * The agent has proposed something irreversible and nothing has happened yet.
 * This card is the only path from "proposed" to "done".
 *
 * Design rule: **show the whole payload, not a summary.** The user is about to
 * authorise an email going out under their own name, so they need the real
 * recipients and the real body — not the agent's description of them, which is
 * exactly what an injected instruction would have tampered with. The fields
 * rendered here come straight from the stored arguments the server will execute.
 */

/** Renders the arguments in a readable shape, per tool. */
function Details({ approval }: { approval: PendingApproval }) {
  const args = approval.args;

  if (approval.tool === "send_mail") {
    return (
      <dl className="mt-2.5 space-y-1.5 text-xs">
        <Field label="To" value={(args.to as string[])?.join(", ")} />
        {Array.isArray(args.cc) && (args.cc as string[]).length > 0 && (
          <Field label="Cc" value={(args.cc as string[]).join(", ")} />
        )}
        <Field label="Subject" value={String(args.subject ?? "")} />
        <div>
          <dt className="text-muted">Body</dt>
          <dd className="mt-1 whitespace-pre-wrap rounded-lg border border-border bg-canvas p-2.5 text-ink/90">
            {String(args.body ?? "")}
          </dd>
        </div>
      </dl>
    );
  }

  if (approval.tool === "reply_to_mail") {
    return (
      <dl className="mt-2.5 space-y-1.5 text-xs">
        <Field label="Thread" value={String(args.messageId ?? "")} />
        <div>
          <dt className="text-muted">Reply</dt>
          <dd className="mt-1 whitespace-pre-wrap rounded-lg border border-border bg-canvas p-2.5 text-ink/90">
            {String(args.body ?? "")}
          </dd>
        </div>
      </dl>
    );
  }

  if (approval.tool === "cancel_meeting") {
    return (
      <p className="mt-2.5 text-xs text-muted">
        Event <code className="text-ink">{String(args.eventId ?? "")}</code> will
        be deleted and every attendee emailed. This cannot be undone.
      </p>
    );
  }

  // Unknown tool: show the raw arguments rather than hiding them.
  return (
    <pre className="mt-2.5 overflow-x-auto rounded-lg border border-border bg-canvas p-2.5 text-[11px]">
      {JSON.stringify(args, null, 2)}
    </pre>
  );
}

function Field({ label, value }: { label: string; value?: string }) {
  if (!value) return null;

  return (
    <div className="flex gap-2">
      <dt className="w-14 shrink-0 text-muted">{label}</dt>
      <dd className="min-w-0 break-words text-ink/90">{value}</dd>
    </div>
  );
}

export default function ApprovalCard({
  approval,
}: {
  approval: PendingApproval;
}) {
  const { approve, reject } = useChat();
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null);

  const run = async (action: "approve" | "reject") => {
    setBusy(action);
    if (action === "approve") await approve(approval.id);
    else await reject(approval.id);
    setBusy(null);
  };

  return (
    <article className="rounded-xl border border-warn/50 bg-warn/5 p-4">
      <header className="flex items-start gap-2.5">
        <ShieldAlert size={17} className="mt-0.5 shrink-0 text-warn" />
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-medium">Needs your approval</h3>
          <p className="mt-0.5 text-xs text-muted">{approval.summary}</p>
        </div>
      </header>

      <Details approval={approval} />

      <footer className="mt-3.5 flex items-center gap-2">
        <button
          onClick={() => void run("approve")}
          disabled={busy !== null}
          className="flex items-center gap-1.5 rounded-lg bg-success px-3.5 py-2 text-xs font-medium text-white transition hover:brightness-110 disabled:opacity-50"
        >
          <Check size={14} />
          {busy === "approve" ? "Running" : "Approve and run"}
        </button>

        <button
          onClick={() => void run("reject")}
          disabled={busy !== null}
          className="flex items-center gap-1.5 rounded-lg border border-border px-3.5 py-2 text-xs text-muted transition hover:text-danger disabled:opacity-50"
        >
          <X size={14} />
          Discard
        </button>

        <span className="ml-auto text-[10px] text-muted">
          Nothing has been sent yet
        </span>
      </footer>
    </article>
  );
}
