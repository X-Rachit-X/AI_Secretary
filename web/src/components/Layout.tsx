import { NavLink, useNavigate } from "react-router-dom";
import {
  Bell,
  CalendarDays,
  FileDown,
  LineChart,
  LogOut,
  Mail,
  MessageSquare,
  Sparkles,
} from "lucide-react";
import { useAuth } from "@/store/auth.store";
import { useNotifications } from "@/store/notification.store";

/**
 * The app frame: a fixed left rail of pages, a header, and the page below it.
 *
 * The rail is the whole navigation model. Chat is where the agent lives;
 * Calendar, Mail, Notifications and Files are direct views of the same data
 * the agent works with, so you can always check its work by hand.
 */

const NAV = [
  { to: "/chat", label: "Chat", icon: MessageSquare },
  { to: "/calendar", label: "Calendar", icon: CalendarDays },
  { to: "/mail", label: "Mail", icon: Mail },
  { to: "/notifications", label: "Alerts", icon: Bell },
  { to: "/files", label: "Files", icon: FileDown },
  { to: "/insights", label: "Insights", icon: LineChart },
];

export default function Layout({ children }: { children: React.ReactNode }) {
  const { user, wallet, logout } = useAuth();
  const unread = useNotifications((state) => state.unread);
  const navigate = useNavigate();

  const handleLogout = async () => {
    await logout();
    navigate("/login", { replace: true });
  };

  return (
    <div className="flex h-full">
      {/* ── Left rail ─────────────────────────────────────────────────── */}
      <aside className="flex w-[76px] flex-col items-center gap-1 border-r border-border bg-surface py-4">
        <div className="mb-4 grid size-10 place-items-center rounded-xl bg-brand">
          <Sparkles size={20} className="text-white" />
        </div>

        {NAV.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            className={({ isActive }) =>
              [
                "relative flex w-[60px] flex-col items-center gap-1 rounded-xl px-1 py-2.5 text-[10px] transition",
                isActive
                  ? "bg-surface-2 text-ink"
                  : "text-muted hover:bg-surface-2 hover:text-ink",
              ].join(" ")
            }
          >
            <item.icon size={18} />
            {item.label}

            {/* Unread badge, only on the Alerts item. */}
            {item.to === "/notifications" && unread > 0 && (
              <span className="absolute right-2 top-1.5 grid min-w-[16px] place-items-center rounded-full bg-danger px-1 text-[9px] font-semibold text-white">
                {unread > 9 ? "9+" : unread}
              </span>
            )}
          </NavLink>
        ))}

        <div className="flex-1" />

        <button
          onClick={handleLogout}
          title="Sign out"
          className="flex w-[60px] flex-col items-center gap-1 rounded-xl px-1 py-2.5 text-[10px] text-muted transition hover:bg-surface-2 hover:text-danger"
        >
          <LogOut size={18} />
          Sign out
        </button>
      </aside>

      {/* ── Main column ───────────────────────────────────────────────── */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center justify-between border-b border-border bg-surface px-5">
          <div className="text-sm font-semibold">CortexOne</div>

          <div className="flex items-center gap-4">
            <div
              className="text-xs text-muted"
              title={`${wallet.credits} of ${wallet.totalCredits} credits remaining`}
            >
              <span className="font-semibold text-ink">{wallet.credits}</span>{" "}
              credits
            </div>

            <div className="flex items-center gap-2">
              {user?.avatar ? (
                <img
                  src={user.avatar}
                  alt=""
                  className="size-7 rounded-full"
                  referrerPolicy="no-referrer"
                />
              ) : (
                <div className="grid size-7 place-items-center rounded-full bg-brand-soft text-xs font-semibold">
                  {user?.name?.[0]?.toUpperCase() ?? "?"}
                </div>
              )}
              <span className="hidden text-xs text-muted sm:block">
                {user?.name ?? user?.email}
              </span>
            </div>
          </div>
        </header>

        {/* min-h-0 lets the child own its own scrolling instead of growing the page. */}
        <main className="min-h-0 flex-1">{children}</main>
      </div>
    </div>
  );
}
