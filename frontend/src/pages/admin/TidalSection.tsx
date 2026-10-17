import {
  canLinkTidalAccount,
  tidalAccountLabel,
  tidalAccountSource,
  tidalManagementUnsupported,
  tidalProxyState,
  tidalStatusDetails,
  tidalStatusErrors,
  type TidalProxyState,
} from "@music-library/core/tidal/status";
import { useTidalDeviceLogin } from "@music-library/core/tidal/device-login";
import {
  RefreshCw as ArrowPathIcon,
  ExternalLink as ArrowTopRightOnSquareIcon,
  CircleCheck as CheckCircleIcon,
  Link as LinkIcon,
  Trash2 as TrashIcon,
} from "lucide-react";
import { api, type MusicRoot, type TidalAccount, type TidalStatus } from "../../api";
import { Button } from "../../components/Button";
import ErrorBanner from "../../components/ErrorBanner";
import {
  closeExternalWindow,
  openExternal,
  reserveExternalWindow,
} from "../../lib/platform";
import { useApiResource } from "../../lib/useApiResource";
import { useConfirm } from "../../context/Confirm";
import { TidalAutoDownloadCard } from "./TidalAutoDownloadCard";

const PROXY_BADGES: Record<TidalProxyState, string> = {
  checking: "checking",
  online: "proxy online",
  offline: "proxy offline",
};

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

export function TidalSection({ roots }: { roots: MusicRoot[] | null }) {
  const confirm = useConfirm();
  const {
    data: status,
    error: loadError,
    loading,
    reload,
  } = useApiResource<TidalStatus>(
    () => api.tidalStatus(),
    "Failed to load TIDAL status.",
    { cacheKey: "admin:tidal" },
  );
  const {
    flow,
    starting,
    unlinkingId,
    error: actionError,
    notice,
    start,
    reopen,
    unlink,
    clearError,
  } = useTidalDeviceLogin<Window | null>({
    openVerification: (url, reservedWindow) => openExternal(url, reservedWindow),
    onAccountsChanged: reload,
  });
  const busy = starting || unlinkingId !== null;
  const canLink = canLinkTidalAccount(status, { starting, unlinkingId, flow });
  const errors = tidalStatusErrors(actionError ?? loadError, status);
  const { proxy, country, quality, version } = tidalStatusDetails(status);

  const details: Array<[string, string, boolean]> = [
    ["Proxy", proxy, true],
    ["Country", country, false],
    ["Quality", quality, false],
    ["Version", version, false],
  ];

  const connected = Boolean(status?.connected);
  const accounts = status?.accounts ?? [];

  const startAuth = async () => {
    // Browser popup eligibility only lasts for the synchronous click handler.
    // Reserve the tab now, then navigate it when the API returns the TIDAL URL.
    const reservedWindow = reserveExternalWindow();
    if (!(await start(reservedWindow))) closeExternalWindow(reservedWindow);
  };

  const removeAccount = async (account: TidalAccount) => {
    const confirmed = await confirm({
      title: "Unlink this TIDAL account?",
      message: "Lumen stops using it for TIDAL. You can link it again later.",
      subject: {
        art: { icon: LinkIcon },
        name: tidalAccountLabel(account),
        detail: tidalAccountSource(account),
      },
      confirmLabel: "Unlink",
      confirmIcon: TrashIcon,
    });
    if (confirmed) await unlink(account);
  };

  return (
    <section aria-labelledby="tidal-account">
      {errors.map((message) => (
        <ErrorBanner key={message} message={message} />
      ))}

      {notice && (
        <div
          role="status"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            border: "1px solid var(--input)",
            background: "var(--accent)",
            borderRadius: 8,
            padding: "10px 12px",
            fontSize: 14,
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
              {PROXY_BADGES[tidalProxyState(status, loading)]}
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
                    i < details.length - 1 ? "1px solid var(--border)" : "none",
                }}
              >
                <span style={{ color: "var(--muted-foreground)", fontSize: 14 }}>{label}</span>
                <span
                  className={mono ? "mono" : undefined}
                  style={{ fontSize: 14, textAlign: "right", overflowWrap: "anywhere" }}
                >
                  {value}
                </span>
              </div>
            ))}
          </div>

          <div style={{ marginTop: "auto", display: "flex", justifyContent: "flex-end" }}>
            <Button
              size="sm"
              onClick={() => {
                clearError();
                reload();
              }}
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
              disabled={!canLink}
            >
              {starting ? "Starting..." : "Link account"}
            </Button>
          </div>

          <p style={{ color: "var(--muted-foreground)", fontSize: 14, margin: 0 }}>
            Subscribed accounts used for live TIDAL search and streaming.
            Credentials stay inside the private hifi-api service.
          </p>

          {/* Neither note until a status has loaded: a failed load says
              nothing about either, and its error is shown already. */}
          {tidalManagementUnsupported(status) ? (
            <div style={{ color: "var(--muted-foreground)", fontSize: 14 }}>
              Account controls require the Lumen hifi-api extension. Recreate the
              hifi-api container after updating the server.
            </div>
          ) : status && accounts.length === 0 ? (
            <div
              style={{
                border: "1px dashed var(--input)",
                borderRadius: 8,
                padding: 14,
                color: "var(--muted-foreground)",
                fontSize: 14,
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
                  background: "var(--accent)",
                  borderRadius: 8,
                  padding: "10px 12px",
                }}
              >
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 600 }}>
                    {tidalAccountLabel(account)}
                  </div>
                  <div className="mono" style={{ color: "var(--muted-foreground)", fontSize: 12 }}>
                    {tidalAccountSource(account)}
                  </div>
                </div>
                {account.removable && (
                  <Button
                    size="sm"
                    variant="danger"
                    leadingIcon={<TrashIcon className="size-3.5" />}
                    disabled={busy}
                    onClick={() => void removeAccount(account)}
                  >
                    {unlinkingId === account.id ? "Unlinking..." : "Unlink"}
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
                border: "1px solid var(--input)",
                background: "var(--accent)",
                borderRadius: 8,
                padding: 14,
              }}
            >
              <div>
                <div style={{ fontSize: 14, fontWeight: 600 }}>Finish signing in to TIDAL</div>
                <div style={{ color: "var(--muted-foreground)", fontSize: 12, marginTop: 3 }}>
                  This page will update automatically after TIDAL approves the account.
                </div>
              </div>
              {flow.user_code && (
                <div>
                  <div style={{ color: "var(--muted-foreground)", fontSize: 12, marginBottom: 4 }}>
                    Code
                  </div>
                  <code style={{ fontSize: 18, letterSpacing: 1 }}>{flow.user_code}</code>
                </div>
              )}
              <div>
                <Button
                  size="sm"
                  leadingIcon={<ArrowTopRightOnSquareIcon className="size-3.5" />}
                  onClick={() => void reopen()}
                >
                  Open TIDAL
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>

      <div style={{ marginTop: 14 }}>
        <TidalAutoDownloadCard roots={roots} />
      </div>
    </section>
  );
}
