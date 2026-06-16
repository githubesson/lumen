import { FormEvent, useCallback, useEffect, useState } from "react";
import {
  CheckIcon,
  ClipboardIcon,
  PlusIcon,
  TrashIcon,
} from "@heroicons/react/16/solid";
import { api, errorMessage, type Invite, type Role } from "../api";
import { Button } from "../components/Button";
import ErrorBanner from "../components/ErrorBanner";
import { Field, TextInput } from "../components/Field";
import { Select } from "../components/Select";
import AdminPanel from "../components/admin/AdminPanel";
import AdminSection from "../components/admin/AdminSection";
import { copyText } from "../lib/clipboard";

type Status = "active" | "revoked" | "exhausted" | "expired";

function statusOf(inv: Invite): Status {
  if (inv.revoked_at) return "revoked";
  if (inv.uses >= inv.max_uses) return "exhausted";
  if (inv.expires_at && new Date(inv.expires_at).getTime() < Date.now())
    return "expired";
  return "active";
}

/**
 * Section for the unified Admin page. Handles invite CRUD. The parent page
 * owns the `.view` wrapper and page title.
 */
export function InvitesAdminSection() {
  const [rows, setRows] = useState<Invite[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [role, setRole] = useState<Role>("user");
  const [maxUses, setMaxUses] = useState(1);
  const [expiresAt, setExpiresAt] = useState("");
  const [justCreated, setJustCreated] = useState<Invite | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    try {
      setRows(await api.listInvites());
    } catch (err) {
      setError(errorMessage(err, "Failed to load invites."));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      const created = await api.createInvite({
        target_role: role,
        max_uses: maxUses,
        expires_at: expiresAt ? new Date(expiresAt).toISOString() : undefined,
      });
      setJustCreated(created);
      setCopied(false);
      await load();
    } catch (err) {
      setError(errorMessage(err, "Failed to create invite."));
    }
  };

  const revoke = async (id: string) => {
    if (!window.confirm("Revoke this invite?")) return;
    try {
      await api.revokeInvite(id);
      await load();
    } catch (err) {
      setError(errorMessage(err, "Failed to revoke."));
    }
  };

  const inviteUrl = (token: string) =>
    `${window.location.origin}/register?token=${encodeURIComponent(token)}`;

  const copy = async (text: string) => {
    if (await copyText(text)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <AdminPanel>
      <p
        style={{
          color: "var(--fg-muted)",
          fontSize: 13,
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
            <Field label="Max uses">
              <TextInput
                type="number"
                name="max_uses"
                min={1}
                value={maxUses}
                onChange={(e) =>
                  setMaxUses(parseInt(e.target.value || "1", 10))
                }
              />
            </Field>
          </div>
          <div style={{ width: 240 }}>
            <Field label="Expires" hint="Optional">
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
          >
            Create
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
            borderColor: "color-mix(in oklch, var(--accent) 40%, var(--border))",
            background:
              "color-mix(in oklch, var(--accent) 10%, var(--bg-elev-2))",
          }}
        >
          <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
            <CheckIcon
              className="size-4 shrink-0"
              style={{ color: "var(--accent)", marginTop: 2 }}
              aria-hidden="true"
            />
            <div style={{ flex: 1, minWidth: 0 }}>
              <p style={{ fontSize: 13, fontWeight: 500, margin: 0 }}>
                Invite ready — copy this link now. It won't be shown again.
              </p>
              <p
                className="surface-inset mono"
                style={{
                  marginTop: 8,
                  padding: "8px 10px",
                  fontSize: 11,
                  wordBreak: "break-all",
                }}
              >
                {inviteUrl(justCreated.token)}
              </p>
            </div>
            <Button
              size="sm"
              onClick={() => copy(inviteUrl(justCreated.token!))}
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

      <AdminSection title="All invites">
        <table className="table">
          <thead>
            <tr>
              <th>Role</th>
              <th>Uses</th>
              <th>Expires</th>
              <th>Status</th>
              <th>Created</th>
              <th className="col-acts" />
            </tr>
          </thead>
          <tbody>
            {rows === null && (
              <tr>
                <td colSpan={6} className="mono" style={{ color: "var(--fg-subtle)" }}>
                  Loading…
                </td>
              </tr>
            )}
            {rows?.length === 0 && (
              <tr>
                <td colSpan={6} style={{ color: "var(--fg-muted)" }}>
                  No invites yet. Create one above to get started.
                </td>
              </tr>
            )}
            {rows?.map((inv) => {
              const s = statusOf(inv);
              return (
                <tr key={inv.id}>
                  <td style={{ color: "var(--fg)" }}>{inv.target_role}</td>
                  <td className="mono" style={{ color: "var(--fg-muted)" }}>
                    {inv.uses} / {inv.max_uses}
                  </td>
                  <td className="mono" style={{ color: "var(--fg-subtle)" }}>
                    {inv.expires_at
                      ? new Date(inv.expires_at).toLocaleString()
                      : "—"}
                  </td>
                  <td>
                    <span
                      className={"badge" + (s === "active" ? " badge-accent" : "")}
                    >
                      {s}
                    </span>
                  </td>
                  <td className="mono" style={{ color: "var(--fg-subtle)" }}>
                    {new Date(inv.created_at).toLocaleDateString()}
                  </td>
                  <td className="col-acts">
                    {!inv.revoked_at && (
                      <Button
                        size="sm"
                        variant="danger"
                        onClick={() => revoke(inv.id)}
                        leadingIcon={<TrashIcon className="size-3.5" />}
                      >
                        Revoke
                      </Button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </AdminSection>
    </AdminPanel>
  );
}
