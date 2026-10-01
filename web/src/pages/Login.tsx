import { Navigate, useSearchParams } from "react-router-dom";
import { CalendarDays, FileText, Mail, Search, Sparkles } from "lucide-react";
import { api } from "@/lib/api";
import { useAuth } from "@/store/auth.store";

/**
 * Sign-in.
 *
 * One button, because one Google consent does everything: it identifies the
 * user AND grants calendar and inbox access. There is no second "connect your
 * calendar" step anywhere in the app.
 */

const ERRORS: Record<string, string> = {
  denied: "You cancelled the Google sign-in.",
  invalid_state: "That sign-in link expired. Please try again.",
  exchange_failed: "Google sign-in failed. Check the server logs and try again.",
};

const FEATURES = [
  { icon: CalendarDays, text: "Ask about your calendar, book and move meetings" },
  { icon: Mail, text: "Search, read, reply and send email in plain language" },
  { icon: FileText, text: "Generate PDFs, slide decks and code projects" },
  { icon: Search, text: "Web search with citations, and chat with any PDF" },
];

export default function Login() {
  const status = useAuth((state) => state.status);
  const [params] = useSearchParams();

  if (status === "authed") return <Navigate to="/chat" replace />;

  const error = params.get("error");

  return (
    <div className="grid h-full place-items-center px-6">
      <div className="w-full max-w-sm">
        <div className="mb-7 text-center">
          <div className="mx-auto mb-4 grid size-14 place-items-center rounded-2xl bg-brand">
            <Sparkles size={26} className="text-white" />
          </div>
          <h1 className="text-2xl font-semibold">CortexOne</h1>
          <p className="mt-1.5 text-sm text-muted">
            One assistant for your work, your calendar and your inbox.
          </p>
        </div>

        <ul className="mb-7 space-y-2.5">
          {FEATURES.map((feature) => (
            <li
              key={feature.text}
              className="flex items-start gap-3 text-sm text-muted"
            >
              <feature.icon size={16} className="mt-0.5 shrink-0 text-brand" />
              {feature.text}
            </li>
          ))}
        </ul>

        {error && (
          <div className="mb-4 rounded-xl border border-danger/40 bg-danger/10 px-4 py-2.5 text-xs text-danger">
            {ERRORS[error] ?? "Sign-in failed. Please try again."}
          </div>
        )}

        <button
          onClick={() => api.startGoogleLogin()}
          className="flex w-full items-center justify-center gap-3 rounded-xl bg-white py-3 text-sm font-medium text-slate-900 transition hover:brightness-95"
        >
          <svg viewBox="0 0 24 24" className="size-5" aria-hidden>
            <path
              fill="#4285F4"
              d="M22.5 12.2c0-.8-.1-1.4-.2-2.1H12v4h6c-.1 1-.8 2.5-2.2 3.5l3.4 2.6c2-1.8 3.3-4.6 3.3-8z"
            />
            <path
              fill="#34A853"
              d="M12 23c3 0 5.5-1 7.3-2.7l-3.5-2.7c-.9.6-2.2 1.1-3.8 1.1-2.9 0-5.3-1.9-6.2-4.5l-3.6 2.8C3.9 20.5 7.7 23 12 23z"
            />
            <path
              fill="#FBBC05"
              d="M5.8 14.2c-.2-.7-.4-1.4-.4-2.2s.1-1.5.4-2.2L2.2 7C1.4 8.5 1 10.2 1 12s.4 3.5 1.2 5l3.6-2.8z"
            />
            <path
              fill="#EA4335"
              d="M12 5.4c2 0 3.4.9 4.2 1.6l3.1-3C17.5 2.2 15 1 12 1 7.7 1 3.9 3.5 2.2 7l3.6 2.8C6.7 7.3 9.1 5.4 12 5.4z"
            />
          </svg>
          Continue with Google
        </button>

        <p className="mt-4 text-center text-[11px] leading-relaxed text-muted">
          Signing in also grants access to your Google Calendar and Gmail, which
          is what lets the assistant act on them. You can disconnect at any time
          from the Calendar page.
        </p>
      </div>
    </div>
  );
}
