import {
  inviteExpiryLabel,
  inviteRoleLabel,
  inviteStatus,
  inviteUsage,
  partitionInvites,
  validateInviteCreationWithDate,
} from "@music-library/core/admin/invites";
import { FormEvent, useState } from "react";
import {
  Check as CheckIcon,
  Clipboard as ClipboardIcon,
  Plus as PlusIcon,
  Ticket as TicketIcon,
  Trash2 as TrashIcon,
} from "lucide-react";
import { api, errorMessage, type Invite, type Role } from "../api";
import { Button } from "../components/Button";
import ErrorBanner from "../components/ErrorBanner";
import { Field, TextInput } from "../components/Field";
import { Select } from "../components/Select";
import AdminPanel from "../components/admin/AdminPanel";
import AdminSection from "../components/admin/AdminSection";
import Disclosure from "../components/admin/Disclosure";
import { copyText } from "../lib/clipboard";
import { useDesktopConfig } from "../lib/desktopConfig";
import { fmtDate, fmtDateTime } from "../lib/format";
import { isElectron } from "../lib/platform";
import { useApiResource } from "../lib/useApiResource";
import { useCopiedFlag } from "../lib/useCopiedFlag";
import { useConfirm } from "../context/Confirm";

/**
 * The web registration link for `token`, on the server's origin. The web app
 * is served by the server itself; the desktop app's pages come from a
 * loopback proxy, so there the link takes the server it's configured with.
 */
function inviteUrl(token: string, server: string): string {
  const url = new URL("/register", server);
  url.searchParams.set("token", token);
  return url.toString();
}

/**
 * Section for the unified Admin page. Handles invite CRUD. The parent page
 * owns the `.view` wrapper and page title.
 */
export function InvitesAdminSection() {
  const {
    data: rows,
    error: loadError,
    reload,
  } = useApiResource<Invite[]>(
    () => api.listInvites(),
    "Failed to load invites.",
    { cacheKey: "admin:invites" },
  );
  const [actionError, setActionError] = useState<string | null>(null);
  const confirm = useConfirm();
  const error = actionError ?? loadError;

  const [role, setRole] = useState<Role>("user");
  const [maxUses, setMaxUses] = useState("1");
  const [expiresAt, setExpiresAt] = useState("");
  const validation = validateInviteCreationWithDate(maxUses, expiresAt);
  const [justCreated, setJustCreated] = useState<Invite | null>(null);
  const [creating, setCreating] = useState(false);
  const { copied, flash: flashCopied, reset: resetCopied } = useCopiedFlag(2000);
  const desktopServer = useDesktopConfig()?.backendUrl;
  const server = (isElectron() ? desktopServer : null) || window.location.origin;

  const create = async (e: FormEvent) => {
    e.preventDefault();
    // A second submit while one is out would make a second invite.
    if (creating) return;
    // Checked against the clock now, not when the form last rendered.
    const input = validateInviteCreationWithDate(maxUses, expiresAt);
    if (!input.valid || input.maxUses === null) return;
    setActionError(null);
    setCreating(true);
    try {
      const created = await api.createInvite({
        target_role: role,
        max_uses: input.maxUses,
        expires_at: input.expiresAt,
      });
      setJustCreated(created.token ? created : null);
      if (!created.token) {
        setActionError(
          "The invite was made, but the server didn't send its link. Revoke it and create another.",
        );
      }
      resetCopied();
      await reload();
    } catch (err) {
      setActionError(errorMessage(err, "Failed to create invite."));
    } finally {
      setCreating(false);
    }
  };

  const revoke = async (inv: Invite) => {
    const confirmed = await confirm({
      title: "Revoke this invite?",
      message: "Its link stops working, so no one else can sign up with it.",
      subject: {
        art: { icon: TicketIcon },
        name: `${inviteRoleLabel(inv.target_role)} invite`,
        detail: `${inviteUsage(inv)} used · ${inviteExpiryLabel(inv, fmtDate)}`,
      },
      confirmLabel: "Revoke",
      confirmIcon: TrashIcon,
    });
    if (!confirmed) return;
    try {
      await api.revokeInvite(inv.id);
      await reload();
    } catch (err) {
      setActionError(errorMessage(err, "Failed to revoke."));
    }
  };

  const copy = async (text: string) => {
    if (await copyText(text)) flashCopied();
  };

  const { active, past } = partitionInvites(rows ?? []);

  return (
    <AdminPanel>
      <p
        style={{
          color: "var(--muted-foreground)",
          fontSize: 14,
          margin: 0,
          maxWidth: "60ch",
        }}
      >
        Generate single-use registration links. The token appears once, right
        after creation — copy it then.
      </p>

      <AdminSection
        title="New invite"
        titleId="new-invite"
        surface
      >
        <form
          onSubmit={create}
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: 12,
            alignItems: "end",
          }}
        >
          <div style={{ width: 160 }}>
            <Field label="Role">
              <Select
                value={role}
                onChange={(v) => setRole(v as Role)}
                name="role"
                options={[
                  { value: "user", label: "User" },
                  { value: "admin", label: "Admin" },
                ]}
              />
            </Field>
          </div>
          <div style={{ width: 120 }}>
            <Field label="Max uses" error={validation.maxUsesError ?? undefined}>
              <TextInput
                type="number"
                name="max_uses"
                min={1}
                value={maxUses}
                onChange={(e) => setMaxUses(e.target.value)}
              />
            </Field>
          </div>
          <div style={{ width: 240 }}>
            <Field
              label="Expires (optional)"
              error={validation.expiresError ?? undefined}
            >
              <TextInput
                type="datetime-local"
                name="expires_at"
                value={expiresAt}
                onChange={(e) => setExpiresAt(e.target.value)}
              />
            </Field>
          </div>
          <Button
            type="submit"
            variant="primary"
            leadingIcon={<PlusIcon className="size-4" />}
            disabled={!validation.valid || creating}
          >
            {creating ? "Creating…" : "Create"}
          </Button>
        </form>
      </AdminSection>

      {justCreated?.token && (
        <section
          role="status"
          aria-live="polite"
          className="surface"
          style={{
            padding: 16,
            background: "var(--muted)",
          }}
        >
          <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
            <CheckIcon
              className="size-4 shrink-0"
              style={{ color: "var(--primary)", marginTop: 2 }}
              aria-hidden="true"
            />
            <div style={{ flex: 1, minWidth: 0 }}>
              <p style={{ fontSize: 14, fontWeight: 500, margin: 0 }}>
                Invite ready — copy this link now. It won't be shown again.
              </p>
              <p
                className="surface-inset font-mono"
                style={{
                  marginTop: 8,
                  padding: "8px 10px",
                  fontSize: 12,
                  wordBreak: "break-all",
                }}
              >
                {inviteUrl(justCreated.token, server)}
              </p>
            </div>
            <Button
              size="sm"
              onClick={() => copy(inviteUrl(justCreated.token!, server))}
              leadingIcon={
                copied ? (
                  <CheckIcon className="size-3.5" />
                ) : (
                  <ClipboardIcon className="size-3.5" />
                )
              }
            >
              {copied ? "Copied" : "Copy"}
            </Button>
          </div>
        </section>
      )}

      {error && <ErrorBanner message={error} />}

      <AdminSection title="Active invites">
        <InviteTable
          rows={active}
          emptyLabel={
            rows === null
              ? "Loading…"
              : "No active invites. Create one above to get started."
          }
          onRevoke={revoke}
        />
        {past.length > 0 && (
          <Disclosure label="Used, expired and revoked" count={past.length}>
            <InviteTable rows={past} showStatus />
          </Disclosure>
        )}
      </AdminSection>
    </AdminPanel>
  );
}

/**
 * Invites table. Active invites need no status column but can be revoked; the
 * past ones say why they stopped working.
 */
function InviteTable({
  rows,
  emptyLabel,
  showStatus = false,
  onRevoke,
}: {
  rows: Invite[];
  emptyLabel?: string;
  showStatus?: boolean;
  onRevoke?: (inv: Invite) => void;
}) {
  const columns = (showStatus ? 5 : 4) + (onRevoke ? 1 : 0);
  return (
    <table className="table table-static">
      <thead>
        <tr>
          <th>Role</th>
          <th>Uses</th>
          <th>Expires</th>
          {showStatus && <th>Status</th>}
          <th>Created</th>
          {onRevoke && <th className="col-acts" />}
        </tr>
      </thead>
      <tbody>
        {rows.length === 0 && emptyLabel && (
          <tr>
            <td colSpan={columns} style={{ color: "var(--muted-foreground)" }}>
              {emptyLabel}
            </td>
          </tr>
        )}
        {rows.map((inv) => (
          <tr key={inv.id}>
            <td style={{ color: "var(--foreground)" }}>
              {inviteRoleLabel(inv.target_role)}
            </td>
            <td className="mono" style={{ color: "var(--muted-foreground)" }}>
              {inviteUsage(inv)}
            </td>
            <td className="mono" style={{ color: "var(--muted-foreground)" }}>
              {inv.expires_at ? fmtDateTime(inv.expires_at) : "—"}
            </td>
            {showStatus && (
              <td>
                <span className="badge">{inviteStatus(inv)}</span>
              </td>
            )}
            <td className="mono" style={{ color: "var(--muted-foreground)" }}>
              {fmtDate(inv.created_at)}
            </td>
            {onRevoke && (
              <td className="col-acts">
                <div className="admin-actions">
                  <button
                    type="button"
                    className="iconbtn iconbtn-danger"
                    onClick={() => onRevoke(inv)}
                    aria-label={`Revoke ${inv.target_role} invite created ${fmtDate(inv.created_at)}`}
                    title="Revoke"
                  >
                    <TrashIcon className="size-4" aria-hidden="true" />
                  </button>
                </div>
              </td>
            )}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
