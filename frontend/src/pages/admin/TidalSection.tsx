import { useCallback, useEffect, useState } from "react";
import {
  ArrowPathIcon,
  ArrowTopRightOnSquareIcon,
  CheckCircleIcon,
  LinkIcon,
  TrashIcon,
} from "@heroicons/react/16/solid";
import {
  api,
  errorMessage,
  type TidalAuthStart,
  type TidalStatus,
} from "../../api";
import { Button } from "../../components/Button";
import ErrorBanner from "../../components/ErrorBanner";
import {
  closeExternalWindow,
  openExternal,
  reserveExternalWindow,
} from "../../lib/platform";

function normalizeTidalVerificationURL(rawURL: string): string {
  const trimmed = rawURL.trim();
  if (!trimmed || /^[a-z][a-z\d+.-]*:/i.test(trimmed)) return trimmed;

  try {
    const url = new URL(`https://${trimmed.replace(/^\/{2}/, "")}`);
    if (url.hostname === "tidal.com" || url.hostname.endsWith(".tidal.com")) {
      return url.href;
    }
  } catch {
    // Let the platform URL validation return the user-facing error.
  }
  return trimmed;
}

const cardStyle = {
  padding: "16px 18px",
  display: "flex",
  flexDirection: "column",
  gap: 14,
} as const;

const cardHeadStyle = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 10,
} as const;

const cardTitleStyle = {
  fontSize: 14,
  fontWeight: 600,
  letterSpacing: "-0.01em",
  margin: 0,
} as const;

export function TidalSection() {
  const [status, setStatus] = useState<TidalStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [flow, setFlow] = useState<TidalAuthStart | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setStatus(await api.tidalStatus());
    } catch (err) {
      setError(errorMessage(err, "Failed to load TIDAL status."));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!flow) return;
    const controller = new AbortController();
    const expiresIn = Date.parse(flow.expires_at) - Date.now();
    void api
      .waitForTidalAuthorization(flow.flow_id, {
        signal: controller.signal,
        timeoutMs: Number.isFinite(expiresIn)
          ? Math.max(2500, expiresIn + 5000)
          : undefined,
      })
      .then(async (result) => {
        setFlow(null);
        if (result.state === "linked") {
          setNotice(
            result.account?.user_id
              ? `TIDAL account ${result.account.user_id} linked.`
              : "TIDAL account linked.",
          );
          await load();
          return;
        }
        setError(result.message || `TIDAL sign-in ${result.state}.`);
      })
      .catch((err) => {
        if (err instanceof Error && err.name === "AbortError") return;
        setFlow(null);
        setError(errorMessage(err, "Could not complete TIDAL sign-in."));
      });

    return () => controller.abort();
  }, [flow, load]);

  const details: Array<[string, string, boolean]> = [
    ["Proxy", status?.proxy_url || "not configured", true],
    ["Country", status?.country_code || "US", false],
    ["Quality", status?.quality || "LOSSLESS", false],
    ["Version", status?.version || "unknown", false],
  ];

  const connected = Boolean(status?.connected);
  const accounts = status?.accounts ?? [];

  const openVerification = async (url: string, reservedWindow?: Window | null) => {
    const opened = await openExternal(
      normalizeTidalVerificationURL(url),
      reservedWindow,
    );
    if (!opened.ok) {
      setError(opened.error || "Could not open the TIDAL sign-in page.");
      return;
    }
    setError(null);
  };

  const startAuth = async () => {
    // Browser popup eligibility only lasts for the synchronous click handler.
    // Reserve the tab now, then navigate it when the API returns the TIDAL URL.
    const reservedWindow = reserveExternalWindow();
    setBusy("link");
    setError(null);
    setNotice(null);
    try {
      const started = await api.startTidalAuth();
      setFlow(started);
      await openVerification(started.verification_url, reservedWindow);
    } catch (err) {
      setError(errorMessage(err, "Could not start TIDAL sign-in."));
      closeExternalWindow(reservedWindow);
    } finally {
      setBusy(null);
    }
  };

  const removeAccount = async (accountID: string, userID: string) => {
    if (!window.confirm(`Unlink TIDAL account ${userID || accountID}?`)) return;
    setBusy(accountID);
    setError(null);
    setNotice(null);
    try {
      await api.removeTidalAccount(accountID);
      setNotice("TIDAL account unlinked.");
      await load();
    } catch (err) {
      setError(errorMessage(err, "Could not unlink the TIDAL account."));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section aria-labelledby="tidal-account">
      {error && <ErrorBanner message={error} />}
      {status?.error && <ErrorBanner message={status.error} />}
      {status?.management_error && <ErrorBanner message={status.management_error} />}

      {notice && (
        <div
          role="status"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            border: "1px solid var(--border-strong)",
            background: "var(--accent-soft)",
            borderRadius: 8,
            padding: "10px 12px",
            fontSize: 12.5,
            marginBottom: 14,
          }}
        >
          <CheckCircleIcon className="size-4" aria-hidden="true" />
          <span>{notice}</span>
        </div>
      )}

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
          gap: 14,
          alignItems: "start",
        }}
      >
        <div className="surface" style={cardStyle}>
          <div style={cardHeadStyle}>
            <h2 id="tidal-account" style={cardTitleStyle}>
              Connection
            </h2>
            <span className={"badge" + (connected ? " badge-accent" : "")}>
              {loading ? "checking" : connected ? "proxy online" : "proxy offline"}
            </span>
          </div>

          <div>
            {details.map(([label, value, mono], i) => (
              <div
                key={label}
                style={{
                  display: "flex",
                  alignItems: "baseline",
                  justifyContent: "space-between",
                  gap: 12,
                  padding: "9px 0",
                  borderBottom:
                    i < details.length - 1 ? "1px solid var(--border-soft)" : "none",
                }}
              >
                <span style={{ color: "var(--fg-muted)", fontSize: 12.5 }}>{label}</span>
                <span
                  className={mono ? "mono" : undefined}
                  style={{ fontSize: 13, textAlign: "right", overflowWrap: "anywhere" }}
                >
                  {value}
                </span>
              </div>
            ))}
          </div>

          <div style={{ marginTop: "auto", display: "flex", justifyContent: "flex-end" }}>
            <Button
              size="sm"
              onClick={() => void load()}
              disabled={loading}
              leadingIcon={<ArrowPathIcon className="size-3.5" />}
            >
              Refresh
            </Button>
          </div>
        </div>

        <div className="surface" style={cardStyle}>
          <div style={cardHeadStyle}>
            <h2 style={cardTitleStyle}>Linked accounts ({accounts.length})</h2>
            <Button
              size="sm"
              variant="primary"
              leadingIcon={<LinkIcon className="size-3.5" />}
              onClick={() => void startAuth()}
              disabled={busy !== null || !!flow || !connected || !status?.management_supported}
            >
              {busy === "link" ? "Starting..." : "Link account"}
            </Button>
          </div>

          <p style={{ color: "var(--fg-muted)", fontSize: 12.5, margin: 0 }}>
            Subscribed accounts used for live TIDAL search and streaming.
            Credentials stay inside the private hifi-api service.
          </p>

          {!status?.management_supported && !loading ? (
            <div style={{ color: "var(--fg-muted)", fontSize: 12.5 }}>
              Account controls require the Lumen hifi-api extension. Recreate the
              hifi-api container after updating the server.
            </div>
          ) : accounts.length === 0 ? (
            <div
              style={{
                border: "1px dashed var(--border-strong)",
                borderRadius: 8,
                padding: 14,
                color: "var(--fg-muted)",
                fontSize: 13,
              }}
            >
              No TIDAL account is linked. Link a subscribed account to enable full playback.
            </div>
          ) : (
            accounts.map((account) => (
              <div
                key={account.id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 12,
                  border: "1px solid var(--border)",
                  background: "var(--bg-elev-3)",
                  borderRadius: 8,
                  padding: "10px 12px",
                }}
              >
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 600 }}>
                    Account {account.user_id || "unknown"}
                  </div>
                  <div className="mono" style={{ color: "var(--fg-muted)", fontSize: 11 }}>
                    {account.removable ? "Managed by Lumen" : "Configured by environment"}
                  </div>
                </div>
                {account.removable && (
                  <Button
                    size="sm"
                    variant="danger"
                    leadingIcon={<TrashIcon className="size-3.5" />}
                    disabled={busy !== null}
                    onClick={() => void removeAccount(account.id, account.user_id)}
                  >
                    {busy === account.id ? "Unlinking..." : "Unlink"}
                  </Button>
                )}
              </div>
            ))
          )}

          {flow && (
            <div
              style={{
                display: "grid",
                gap: 10,
                border: "1px solid var(--border-strong)",
                background: "var(--accent-soft)",
                borderRadius: 8,
                padding: 14,
              }}
            >
              <div>
                <div style={{ fontSize: 13, fontWeight: 600 }}>Finish signing in to TIDAL</div>
                <div style={{ color: "var(--fg-muted)", fontSize: 12, marginTop: 3 }}>
                  This page will update automatically after TIDAL approves the account.
                </div>
              </div>
              {flow.user_code && (
                <div>
                  <div style={{ color: "var(--fg-muted)", fontSize: 12, marginBottom: 4 }}>
                    Code
                  </div>
                  <code style={{ fontSize: 18, letterSpacing: 1 }}>{flow.user_code}</code>
                </div>
              )}
              <div>
                <Button
                  size="sm"
                  leadingIcon={<ArrowTopRightOnSquareIcon className="size-3.5" />}
                  onClick={() => void openVerification(flow.verification_url)}
                >
                  Open TIDAL
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
