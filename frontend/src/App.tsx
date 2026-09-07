import { Suspense, lazy, useEffect } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { useAuth } from "./context/Auth";
import Login from "./pages/Login";
import Register from "./pages/Register";
import ForceReset from "./pages/ForceReset";
import SharePreview from "./pages/SharePreview";
import Shell from "./components/Shell";
import WindowControls from "./components/WindowControls";
import StartupConnection from "./components/StartupConnection";
import { PlaylistsProvider } from "./context/Playlists";

const loadHome = () => import("./pages/Home");
const Home = lazy(loadHome);
const Library = lazy(() => import("./pages/Library"));
const Favorites = lazy(() => import("./pages/Favorites"));
const Recent = lazy(() => import("./pages/Recent"));
const Replay = lazy(() => import("./pages/Replay"));
const Playlists = lazy(() => import("./pages/Playlists"));
const PlaylistNew = lazy(() => import("./pages/PlaylistNew"));
const PlaylistDetail = lazy(() => import("./pages/PlaylistDetail"));
const PendingInvites = lazy(() => import("./pages/PendingInvites"));
const Admin = lazy(() => import("./pages/Admin"));
const FH6Radio = lazy(() => import("./pages/FH6Radio"));

const PageFallback = () => (
  <div
    style={{
      display: "grid",
      placeItems: "center",
      height: "100%",
      color: "var(--fg-subtle)",
      fontSize: 11,
    }}
  >
    Loading...
  </div>
);

export default function App() {
  const { status, me, refreshError } = useAuth();
  const { pathname } = useLocation();

  useEffect(() => {
    // Fetch/parse the landing route while /me is in flight. Its data requests
    // still begin only after authentication permits the route to mount.
    if (pathname === "/") void loadHome().catch(() => {});
  }, [pathname]);

  if (status === "loading" || (!me && refreshError && pathname !== "/register" && !pathname.startsWith("/shared/"))) {
    return (
      <>
        <WindowControls className="root-window-controls" />
        <StartupConnection key={status} />
      </>
    );
  }

  return (
    <>
      {!me && <WindowControls className="root-window-controls" />}
      <Routes>
        <Route path="/login" element={me ? <Navigate to="/" replace /> : <Login />} />
        <Route path="/register" element={<Register />} />
        <Route path="/shared/track/:id" element={<SharePreview />} />

        <Route element={me ? (
          <PlaylistsProvider key={`${me.id}:${me.must_reset_password}`}><Shell /></PlaylistsProvider>
        ) : <Navigate to="/login" replace />}>
          <Route
            path="/"
            element={
              <Suspense fallback={<PageFallback />}>
                {me?.must_reset_password ? <Navigate to="/reset-password" replace /> : <Home />}
              </Suspense>
            }
          />
          <Route path="/reset-password" element={<ForceReset />} />
          <Route path="/library" element={<Suspense fallback={<PageFallback />}><Library /></Suspense>} />
          <Route path="/favorites" element={<Suspense fallback={<PageFallback />}><Favorites /></Suspense>} />
          <Route path="/recent" element={<Suspense fallback={<PageFallback />}><Recent /></Suspense>} />
          <Route path="/replay" element={<Suspense fallback={<PageFallback />}><Replay /></Suspense>} />
          <Route path="/playlists" element={<Suspense fallback={<PageFallback />}><Playlists /></Suspense>} />
          <Route path="/playlists/new" element={<Suspense fallback={<PageFallback />}><PlaylistNew /></Suspense>} />
          <Route path="/playlists/:id" element={<Suspense fallback={<PageFallback />}><PlaylistDetail /></Suspense>} />
          <Route path="/invites" element={<Suspense fallback={<PageFallback />}><PendingInvites /></Suspense>} />
          <Route path="/fh6-radio" element={<Suspense fallback={<PageFallback />}><FH6Radio /></Suspense>} />
          <Route
            path="/admin"
            element={
              <Suspense fallback={<PageFallback />}>
                {me?.role === "admin" ? <Admin /> : <Navigate to="/" replace />}
              </Suspense>
            }
          />
          <Route
            path="/admin/invites"
            element={<Navigate to="/admin?section=invites" replace />}
          />
          <Route
            path="/admin/users"
            element={<Navigate to="/admin?section=users" replace />}
          />
          <Route
            path="/admin/library"
            element={<Navigate to="/admin" replace />}
          />
        </Route>

        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </>
  );
}
