import { NavLink } from "react-router-dom";
import { useTheme } from "../../context/Theme";

export default function NavItem({
  to,
  icon,
  label,
  end,
  badge,
}: {
  to: string;
  icon: React.ReactNode;
  label: string;
  end?: boolean;
  badge?: number;
}) {
  // Collapsed rail rows show only an icon, so surface the label on hover.
  const { layout } = useTheme();
  return (
    <NavLink
      to={to}
      end={end}
      title={layout === "compact" ? label : undefined}
      data-tooltip-side="right"
      className={({ isActive }) => "nav-item" + (isActive ? " active" : "")}
    >
      {icon}
      <span className="nav-label">{label}</span>
      {badge != null && <span className="nav-badge">{badge}</span>}
    </NavLink>
  );
}
