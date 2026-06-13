import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowPathIcon,
  CheckCircleIcon,
  ExclamationTriangleIcon,
} from "@heroicons/react/16/solid";
import { api, errorMessage, type TidalStatus } from "../../api";
import { Button } from "../../components/Button";
import ErrorBanner from "../../components/ErrorBanner";
import { AdminSectionIntro, AdminSectionTitle } from "./AdminSectionTitle";

export function TidalSection() {
  const [status, setStatus] = useState<TidalStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setStatus(await api.tidalStatus());
    } catch (err) {
      setError(errorMessage(err, "Failed to load TIDAL proxy status."));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const details = useMemo(
    () => [
      ["Proxy", status?.proxy_url || "not configured"],
      ["Country", status?.country_code || "US"],
      ["Quality", status?.quality || "LOSSLESS"],
      ["Version", status?.version || "unknown"],
      ["Repository", status?.repo || "unknown"],
    ],
    [status],
  );

  const connected = Boolean(status?.connected);

  return (
    <section aria-labelledby="tidal-account" className="surface" style={{ padding: 20 }}>
      <div
        style={{
          display: "flex",
          alignItems: "start",
          justifyContent: "space-between",
          gap: 16,
          marginBottom: 16,
        }}
      >
        <AdminSectionIntro
          id="tidal-account"
          title="TIDAL proxy"
          description={
            <>
              TIDAL search and streaming are routed through the internal hifi-api
              sidecar. Tracks are proxied live and never imported into the local
              library.
            </>
          }
        />
        <span className={"badge" + (connected ? " badge-accent" : "")}>
          {loading ? "checking" : connected ? "reachable" : "unreachable"}
        </span>
      </div>

      {error && <ErrorBanner message={error} />}

      {status?.error && (
        <div
          role="alert"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            border: "1px solid var(--danger-border)",
            background: "var(--danger-soft)",
            color: "var(--danger-fg)",
            borderRadius: 8,
            padding: "10px 12px",
            fontSize: 12.5,
            marginBottom: 14,
          }}
        >
          <ExclamationTriangleIcon className="size-4" aria-hidden="true" />
          <span>{status.error}</span>
        </div>
      )}

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
          gap: 12,
          marginBottom: 16,
        }}
      >
        {details.map(([label, value]) => (
          <div key={label}>
            <AdminSectionTitle as="div" style={{ marginBottom: 4 }}>
              {label}
            </AdminSectionTitle>
            <div style={{ color: "var(--fg)", fontSize: 13, overflowWrap: "anywhere" }}>
              {value}
            </div>
          </div>
        ))}
      </div>

      <Button
        onClick={() => void load()}
        disabled={loading}
        leadingIcon={<ArrowPathIcon className="size-4" />}
      >
        Refresh
      </Button>

      <p
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          color: "var(--fg-muted)",
          fontSize: 12,
          margin: "14px 0 0",
        }}
      >
        <CheckCircleIcon className="size-4" aria-hidden="true" />
        hifi-api credentials are read from <code>./tidal-hifi/token.json</code>.
      </p>
    </section>
  );
}
