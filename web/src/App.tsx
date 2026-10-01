import { useEffect } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { useAuth } from "./store/auth.store";
import { useNotifications } from "./store/notification.store";
import Layout from "./components/Layout";
import Login from "./pages/Login";
import Chat from "./pages/Chat";
import Calendar from "./pages/Calendar";
import Mail from "./pages/Mail";
import Notifications from "./pages/Notifications";
import Files from "./pages/Files";
import Insights from "./pages/Insights";

/**
 * Routing and the auth gate.
 *
 * One session check runs on mount. Until it answers, `status` is "loading" and
 * a spinner is shown; rendering the login page during that window would make
 * every refresh flash the sign-in screen.
 */

function Protected({ children }: { children: React.ReactNode }) {
  const status = useAuth((state) => state.status);
  const location = useLocation();

  if (status === "loading") {
    return (
      <div className="flex h-full items-center justify-center text-muted">
        <span className="dot">.</span>
        <span className="dot">.</span>
        <span className="dot">.</span>
      </div>
    );
  }

  if (status === "anon") {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }

  return <Layout>{children}</Layout>;
}

export default function App() {
  const { status, load } = useAuth();
  const { connect, disconnect, load: loadNotifications } = useNotifications();

  useEffect(() => {
    void load();
  }, [load]);

  // The notification stream can only open once there is a session to
  // authenticate it, so it is tied to `status` rather than to mount.
  useEffect(() => {
    if (status !== "authed") return;

    void loadNotifications();
    connect();

    return () => disconnect();
  }, [status, connect, disconnect, loadNotifications]);

  return (
    <Routes>
      <Route path="/login" element={<Login />} />

      <Route
        path="/chat"
        element={
          <Protected>
            <Chat />
          </Protected>
        }
      />
      <Route
        path="/calendar"
        element={
          <Protected>
            <Calendar />
          </Protected>
        }
      />
      <Route
        path="/mail"
        element={
          <Protected>
            <Mail />
          </Protected>
        }
      />
      <Route
        path="/notifications"
        element={
          <Protected>
            <Notifications />
          </Protected>
        }
      />
      <Route
        path="/files"
        element={
          <Protected>
            <Files />
          </Protected>
        }
      />

      <Route
        path="/insights"
        element={
          <Protected>
            <Insights />
          </Protected>
        }
      />

      <Route path="*" element={<Navigate to="/chat" replace />} />
    </Routes>
  );
}
