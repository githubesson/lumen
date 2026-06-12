import { type ReactNode } from "react";

interface Props {
  label: string;
  value: ReactNode;
  sublabel?: ReactNode;
  /** Native tooltip shown on hover (e.g. exact figure behind a rounded value). */
  title?: string;
}

export default function StatCard({ label, value, sublabel, title }: Props) {
  return (
    <div className="stat-card" title={title}>
      <div className="stat-card-label">{label}</div>
      <div className="stat-card-value">{value}</div>
      {sublabel && <div className="stat-card-sub">{sublabel}</div>}
    </div>
  );
}
