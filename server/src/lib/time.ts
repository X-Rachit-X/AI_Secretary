/**
 * Small date helpers shared by the calendar tools, the reminder cron and the
 * agent prompts. Kept here so "what counts as today" has exactly one answer.
 */

export function nowIso() {
  return new Date().toISOString();
}

export function startOfToday(date = new Date()) {
  const start = new Date(date);
  start.setHours(0, 0, 0, 0);
  return start;
}

export function endOfToday(date = new Date()) {
  const end = new Date(date);
  end.setHours(23, 59, 59, 999);
  return end;
}

export function addMinutes(date: Date, minutes: number) {
  return new Date(date.getTime() + minutes * 60000);
}

/** Compact, unambiguous timestamp for chat replies: "Thu, 2 Oct, 14:30". */
export function humanTime(iso: string | null | undefined) {
  if (!iso) return "unknown time";

  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;

  return date.toLocaleString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * Message.images and Message.artifacts are stored as JSON text because SQLite
 * has no array column. Parsing never throws: a corrupt value becomes [].
 */
export function parseJsonArray<T>(value: string | null | undefined): T[] {
  if (!value) return [];

  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}
