import { useCallback, useEffect, useState } from "react";
import {
  CalendarDays,
  ExternalLink,
  Plus,
  RefreshCw,
  Trash2,
  Unlink,
  Users,
  Video,
} from "lucide-react";
import { api, ApiError } from "@/lib/api";
import { useAuth } from "@/store/auth.store";
import type { Meeting } from "@/lib/types";

/**
 * The Calendar page: see what is scheduled, create a meeting, cancel one.
 *
 * Everything here goes straight to Google through /api/calendar with no model
 * in the path. The agent is for "move my 3pm and tell everyone"; this page is
 * for the ordinary case where you just want to look.
 */

/** <input type="datetime-local"> wants local time with no zone suffix. */
function toLocalInput(date: Date) {
  const offset = date.getTimezoneOffset() * 60000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function defaultStart() {
  const date = new Date();
  date.setMinutes(0, 0, 0);
  date.setHours(date.getHours() + 1);
  return date;
}

function groupByDay(meetings: Meeting[]) {
  const groups = new Map<string, Meeting[]>();

  for (const meeting of meetings) {
    const key = meeting.start
      ? new Date(meeting.start).toDateString()
      : "Unscheduled";

    groups.set(key, [...(groups.get(key) ?? []), meeting]);
  }

  return [...groups.entries()];
}

export default function Calendar() {
  const { google, disconnectGoogle } = useAuth();

  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);

  const start = defaultStart();
  const [form, setForm] = useState({
    title: "",
    start: toLocalInput(start),
    end: toLocalInput(new Date(start.getTime() + 30 * 60000)),
    attendees: "",
    description: "",
    addGoogleMeet: true,
  });

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const data = await api.listMeetings({ maxResults: 20 });
      setMeetings(data.meetings);
    } catch (caught) {
      setError(
        caught instanceof ApiError ? caught.message : "Could not load meetings.",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const create = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);

    try {
      await api.createMeeting({
        title: form.title,
        // datetime-local has no zone, so new Date() reads it as local and
        // toISOString converts to the UTC instant Google expects.
        startIso: new Date(form.start).toISOString(),
        endIso: new Date(form.end).toISOString(),
        attendeeEmails: form.attendees
          .split(",")
          .map((email) => email.trim())
          .filter(Boolean),
        description: form.description || undefined,
        addGoogleMeet: form.addGoogleMeet,
      });

      setShowForm(false);
      setForm({ ...form, title: "", attendees: "", description: "" });
      await load();
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? caught.message
          : "Could not create the meeting.",
      );
    }
  };

  const cancel = async (eventId: string) => {
    if (!confirm("Cancel this meeting and notify the attendees?")) return;

    await api.cancelMeeting(eventId).catch(() => {});
    await load();
  };

  if (!google.connected) {
    return (
      <div className="grid h-full place-items-center px-6 text-center">
        <div>
          <CalendarDays size={34} className="mx-auto mb-3 text-muted" />
          <p className="text-sm text-muted">
            Google is not connected. Sign out and sign in again to grant access.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto px-6 py-6">
      <div className="mx-auto max-w-3xl">
        <div className="mb-5 flex items-center justify-between">
          <div>
            <h1 className="text-lg font-semibold">Calendar</h1>
            <p className="text-xs text-muted">Your next 20 events</p>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => void load()}
              title="Refresh"
              className="grid size-9 place-items-center rounded-xl border border-border text-muted transition hover:text-ink"
            >
              <RefreshCw size={15} className={loading ? "animate-spin" : ""} />
            </button>

            <button
              onClick={() => setShowForm(!showForm)}
              className="flex items-center gap-2 rounded-xl bg-brand px-3.5 py-2 text-sm font-medium text-white transition hover:brightness-110"
            >
              <Plus size={15} />
              New
            </button>

            <button
              onClick={() => void disconnectGoogle()}
              title="Disconnect Google"
              className="grid size-9 place-items-center rounded-xl border border-border text-muted transition hover:text-danger"
            >
              <Unlink size={15} />
            </button>
          </div>
        </div>

        {showForm && (
          <form
            onSubmit={create}
            className="mb-6 space-y-3 rounded-2xl border border-border bg-surface p-4"
          >
            <input
              required
              placeholder="Meeting title"
              value={form.title}
              onChange={(event) =>
                setForm({ ...form, title: event.target.value })
              }
              className="w-full rounded-lg border border-border bg-canvas px-3 py-2 text-sm outline-none focus:border-brand"
            />

            <div className="grid grid-cols-2 gap-3">
              <label className="text-xs text-muted">
                Starts
                <input
                  required
                  type="datetime-local"
                  value={form.start}
                  onChange={(event) =>
                    setForm({ ...form, start: event.target.value })
                  }
                  className="mt-1 w-full rounded-lg border border-border bg-canvas px-3 py-2 text-sm text-ink outline-none focus:border-brand"
                />
              </label>

              <label className="text-xs text-muted">
                Ends
                <input
                  required
                  type="datetime-local"
                  value={form.end}
                  onChange={(event) =>
                    setForm({ ...form, end: event.target.value })
                  }
                  className="mt-1 w-full rounded-lg border border-border bg-canvas px-3 py-2 text-sm text-ink outline-none focus:border-brand"
                />
              </label>
            </div>

            <input
              placeholder="Invite by email, comma separated"
              value={form.attendees}
              onChange={(event) =>
                setForm({ ...form, attendees: event.target.value })
              }
              className="w-full rounded-lg border border-border bg-canvas px-3 py-2 text-sm outline-none focus:border-brand"
            />

            <textarea
              rows={2}
              placeholder="Agenda (optional)"
              value={form.description}
              onChange={(event) =>
                setForm({ ...form, description: event.target.value })
              }
              className="w-full resize-none rounded-lg border border-border bg-canvas px-3 py-2 text-sm outline-none focus:border-brand"
            />

            <div className="flex items-center justify-between">
              <label className="flex items-center gap-2 text-xs text-muted">
                <input
                  type="checkbox"
                  checked={form.addGoogleMeet}
                  onChange={(event) =>
                    setForm({ ...form, addGoogleMeet: event.target.checked })
                  }
                />
                Add a Google Meet link
              </label>

              <button
                type="submit"
                className="rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white transition hover:brightness-110"
              >
                Create meeting
              </button>
            </div>
          </form>
        )}

        {error && (
          <div className="mb-4 rounded-xl border border-danger/40 bg-danger/10 px-4 py-2.5 text-sm text-danger">
            {error}
          </div>
        )}

        {!loading && meetings.length === 0 && (
          <p className="py-16 text-center text-sm text-muted">
            Nothing scheduled.
          </p>
        )}

        {groupByDay(meetings).map(([day, dayMeetings]) => (
          <section key={day} className="mb-6">
            <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">
              {day}
            </h2>

            <div className="space-y-2">
              {dayMeetings.map((meeting) => (
                <article
                  key={meeting.id}
                  className="group rounded-xl border border-border bg-surface p-3.5"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h3 className="truncate text-sm font-medium">
                        {meeting.title}
                      </h3>

                      <p className="mt-0.5 text-xs text-muted">
                        {meeting.start
                          ? new Date(meeting.start).toLocaleTimeString([], {
                              hour: "2-digit",
                              minute: "2-digit",
                            })
                          : "No time"}
                        {meeting.end &&
                          ` – ${new Date(meeting.end).toLocaleTimeString([], {
                            hour: "2-digit",
                            minute: "2-digit",
                          })}`}
                      </p>

                      {meeting.attendees.length > 0 && (
                        <p className="mt-1.5 flex items-center gap-1.5 text-xs text-muted">
                          <Users size={12} />
                          {meeting.attendees.slice(0, 3).join(", ")}
                          {meeting.attendees.length > 3 &&
                            ` +${meeting.attendees.length - 3}`}
                        </p>
                      )}
                    </div>

                    <div className="flex shrink-0 items-center gap-1">
                      {meeting.meetLink && (
                        <a
                          href={meeting.meetLink}
                          target="_blank"
                          rel="noreferrer"
                          title="Join Meet"
                          className="grid size-8 place-items-center rounded-lg text-muted hover:bg-surface-2 hover:text-success"
                        >
                          <Video size={15} />
                        </a>
                      )}

                      {meeting.htmlLink && (
                        <a
                          href={meeting.htmlLink}
                          target="_blank"
                          rel="noreferrer"
                          title="Open in Google Calendar"
                          className="grid size-8 place-items-center rounded-lg text-muted hover:bg-surface-2 hover:text-ink"
                        >
                          <ExternalLink size={15} />
                        </a>
                      )}

                      {meeting.id && (
                        <button
                          onClick={() => void cancel(meeting.id!)}
                          title="Cancel"
                          className="grid size-8 place-items-center rounded-lg text-muted opacity-0 transition hover:bg-surface-2 hover:text-danger group-hover:opacity-100"
                        >
                          <Trash2 size={15} />
                        </button>
                      )}
                    </div>
                  </div>

                  {meeting.description && (
                    <p className="mt-2 line-clamp-2 text-xs text-muted">
                      {meeting.description}
                    </p>
                  )}
                </article>
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
