import { useMemo } from "react";
import { Link, useLocation, useParams } from "react-router-dom";
import { ChevronRight as ChevronRightIcon } from "lucide-react";
import type { Playlist } from "../../api";

export default function Breadcrumbs({ playlists }: { playlists: Playlist[] }) {
  const location = useLocation();
  const params = useParams();
  const crumbs = useMemo(
    () => buildCrumbs(location.pathname, params, playlists),
    [location.pathname, params, playlists],
  );

  return (
    <div className="crumbs">
      {crumbs.map((c, i) => (
        <span key={i} className="crumb">
          {i > 0 && <ChevronRightIcon className="size-3" aria-hidden="true" />}
          {c.current ? (
            <b>{c.label}</b>
          ) : c.to ? (
            <Link to={c.to}>{c.label}</Link>
          ) : (
            <span>{c.label}</span>
          )}
        </span>
      ))}
    </div>
  );
}

function buildCrumbs(
  pathname: string,
  params: Record<string, string | undefined>,
  playlists: Playlist[],
): { label: string; to?: string; current?: boolean }[] {
  if (pathname === "/") return [{ label: "Home", current: true }];
  if (pathname.startsWith("/library")) {
    return [{ label: "Library", current: true }];
  }
  if (pathname.startsWith("/favorites")) {
    return [
      { label: "Library", to: "/library" },
      { label: "Favorites", current: true },
    ];
  }
  if (pathname.startsWith("/recent")) {
    return [
      { label: "Library", to: "/library" },
      { label: "Recent", current: true },
    ];
  }
  if (pathname.startsWith("/replay")) {
    return [
      { label: "Library", to: "/library" },
      { label: "Replay", current: true },
    ];
  }
  if (pathname.startsWith("/fh6-radio")) {
    return [{ label: "Lumen Radio", current: true }];
  }
  if (pathname === "/playlists") {
    return [{ label: "Playlists", current: true }];
  }
  if (pathname === "/playlists/new") {
    return [
      { label: "Playlists", to: "/playlists" },
      { label: "New", current: true },
    ];
  }
  if (pathname.startsWith("/playlists/") && params.id) {
    const p = playlists.find((x) => x.id === params.id);
    return [
      { label: "Playlists", to: "/playlists" },
      { label: p?.name ?? "…", current: true },
    ];
  }
  if (pathname.startsWith("/invites")) {
    return [{ label: "Invites", current: true }];
  }
  if (pathname.startsWith("/admin")) {
    return [{ label: "Admin", current: true }];
  }
  if (pathname.startsWith("/reset-password")) {
    return [{ label: "Reset password", current: true }];
  }
  return [{ label: "Home", current: true }];
}
