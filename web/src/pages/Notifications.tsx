import {
  Bell,
  CalendarClock,
  CheckCheck,
  Mail,
  RefreshCw,
  Sparkles,
  Trash2,
} from "lucide-react";
import { useNotifications } from "@/store/notification.store";
import type { Notification } from "@/lib/types";

/**
 * The notification centre.
 *
 * The list is kept live by the SSE subscription opened in App.tsx, so anything
 * the reminder cron creates appears here without a refresh. "Check now" exists
 * so you can trigger the sweep instead of waiting for the next cron tick.
 */

const ICONS: Record<Notification["kind"], typeof Bell> = {
  meeting: CalendarClock,
  mail: Mail,
  agent: Sparkles,
  system: Bell,
};

const KIND_COLOR: Record<Notification["kind"], string> = {
  meeting: "text-brand",
  mail: "text-success",
  agent: "text-warn",
  system: "text-muted",
};

/** "3m ago", "2h ago", "5d ago" — precise enough, far shorter than a date. */
function relativeTime(iso: string) {
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);

  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;

  return `${Math.floor(seconds / 86400)}d ago`;
}

export default function Notifications() {
  const { items, unread, markRead, clear, sweep, connected } =
    useNotifications();

  return (
    <div className="h-full overflow-y-auto px-6 py-6">
      <div className="mx-auto max-w-2xl">
        <div className="mb-5 flex items-center justify-between">
          <div>
            <h1 className="flex items-center gap-2 text-lg font-semibold">
              Notifications
              {unread > 0 && (
                <span className="rounded-full bg-danger px-2 py-0.5 text-[11px] font-semibold text-white">
                  {unread}
                </span>
              )}
            </h1>
            <p className="text-xs text-muted">
              {connected ? "Live" : "Reconnecting"} · meeting reminders and mail
              nudges
            </p>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => void sweep()}
              title="Check for new reminders now"
              className="flex items-center gap-1.5 rounded-xl border border-border px-3 py-2 text-xs text-muted transition hover:text-ink"
            >
              <RefreshCw size={14} />
              Check now
            </button>

            <button
              onClick={() => void markRead()}
              title="Mark all read"
              className="grid size-9 place-items-center rounded-xl border border-border text-muted transition hover:text-ink"
            >
              <CheckCheck size={15} />
            </button>

            <button
              onClick={() => void clear()}
              title="Clear all"
              className="grid size-9 place-items-center rounded-xl border border-border text-muted transition hover:text-danger"
            >
              <Trash2 size={15} />
            </button>
          </div>
        </div>

        {items.length === 0 && (
          <div className="py-20 text-center">
            <Bell size={30} className="mx-auto mb-3 text-muted" />
            <p className="text-sm text-muted">Nothing here yet.</p>
            <p className="mt-1 text-xs text-muted">
              Reminders appear automatically before your meetings.
            </p>
          </div>
        )}

        <div className="space-y-2">
          {items.map((item) => {
            const Icon = ICONS[item.kind];

            return (
              <article
                key={item.id}
                onClick={() => void markRead(item.id)}
                className={[
                  "flex cursor-pointer gap-3 rounded-xl border p-3.5 transition",
                  item.read
                    ? "border-border bg-surface"
                    : "border-brand/40 bg-brand-soft/20",
                ].join(" ")}
              >
                <Icon
                  size={17}
                  className={`mt-0.5 shrink-0 ${KIND_COLOR[item.kind]}`}
                />

                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline justify-between gap-2">
                    <h3 className="truncate text-sm font-medium">
                      {item.title}
                    </h3>
                    <span className="shrink-0 text-[10px] text-muted">
                      {relativeTime(item.createdAt)}
                    </span>
                  </div>

                  {item.body && (
                    <p className="mt-0.5 text-xs text-muted">{item.body}</p>
                  )}

                  {item.link && (
                    <a
                      href={item.link}
                      target="_blank"
                      rel="noreferrer"
                      // Stops the row's mark-read handler from also firing.
                      onClick={(event) => event.stopPropagation()}
                      className="mt-1.5 inline-block text-xs text-brand underline underline-offset-2"
                    >
                      Open
                    </a>
                  )}
                </div>

                {!item.read && (
                  <span className="mt-1.5 size-2 shrink-0 rounded-full bg-brand" />
                )}
              </article>
            );
          })}
        </div>
      </div>
    </div>
  );
}
