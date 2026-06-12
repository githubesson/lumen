import type { ReactNode } from "react";

interface Props {
  title: string;
  intro?: ReactNode;
  children: ReactNode;
}

export default function CenteredCard({ title, intro, children }: Props) {
  return (
    <div className="auth-wrap">
      <div className="auth-card">
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 12,
            textAlign: "center",
            marginBottom: 24,
            position: "relative",
          }}
        >
          <div
            className="brand-mark"
            style={{ width: 38, height: 38, fontSize: 16 }}
          >
            L
          </div>
          <div>
            <h1
              style={{
                fontSize: 22,
                fontWeight: 600,
                letterSpacing: "-0.02em",
                margin: 0,
                color: "var(--fg)",
              }}
            >
              {title}
            </h1>
            {intro && (
              <p
                style={{
                  marginTop: 6,
                  fontSize: 13,
                  color: "var(--fg-muted)",
                }}
              >
                {intro}
              </p>
            )}
          </div>
        </div>
        <div style={{ position: "relative" }}>{children}</div>
      </div>
    </div>
  );
}
