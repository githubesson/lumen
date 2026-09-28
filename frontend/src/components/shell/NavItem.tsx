import { Link, NavLink } from "react-router-dom";
import { useTheme } from "../../context/Theme";

export default function NavItem({
  to,
  icon,
  label,
  end,
  active,
  badge,
}: {
  to: string;
  icon: React.ReactNode;
  label: string;
  end?: boolean;
  /** Overrides the route match, for entries that differ only by query
   *  string (NavLink compares paths alone). */
  active?: boolean;
  badge?: number;
}) {
  // Collapsed rail rows show only an icon, so surface the label on hover.
  const { layout } = useTheme();
  const content = (
    <>
      {icon}
      <span className="nav-label">{label}</span>
      {badge != null && <span className="nav-badge">{badge}</span>}
    </>
  );
  const title = layout === "compact" ? label : undefined;
  if (active !== undefined) {
    return (
      <Link
        to={to}
        title={title}
        data-tooltip-side="right"
        aria-current={active ? "page" : undefined}
        className={"nav-item" + (active ? " active" : "")}
      >
        {content}
      </Link>
    );
  }
  return (
    <NavLink
      to={to}
      end={end}
      title={title}
      data-tooltip-side="right"
      className={({ isActive }) => "nav-item" + (isActive ? " active" : "")}
    >
      {content}
    </NavLink>
  );
}
