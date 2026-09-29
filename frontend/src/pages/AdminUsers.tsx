import { useMemo, useState } from "react";
import {
  RefreshCw as ArrowPathIcon,
  UserCheck as UserCheckIcon,
  Users as UserGroupIcon,
  UserX as UserXIcon,
  Trash2 as TrashIcon,
} from "lucide-react";
import { api, errorMessage, type AdminUser } from "../api";
import { Button } from "../components/Button";
import EmptyState from "../components/EmptyState";
import ErrorBanner from "../components/ErrorBanner";
import { useAuth } from "../context/Auth";
import AdminPanel from "../components/admin/AdminPanel";
import AdminSection from "../components/admin/AdminSection";
import { fmtDate, fmtDateTime, pluralize } from "../lib/format";
import { useApiResource } from "../lib/useApiResource";
import { DeleteUserDialog } from "./admin/DeleteUserDialog";

/**
 * "4 users · 1 admin · 1 disabled": the total, then only the counts that
 * aren't zero.
 */
function summaryLine(users: AdminUser[]): string {
  const admins = users.filter((u) => u.role === "admin").length;
  const disabled = users.filter((u) => u.disabled).length;
  const reset = users.filter((u) => u.must_reset_password).length;
  return [
    pluralize(users.length, "user"),
    admins > 0 && pluralize(admins, "admin"),
    disabled > 0 && `${disabled} disabled`,
    reset > 0 && `${reset} must reset their password`,
  ]
    .filter(Boolean)
    .join(" · ");
}

/**
 * Section for the unified Admin page. Lists every account with badges only
 * for what's unusual (admin, disabled, password reset pending), and lets an
 * admin disable, re-enable or delete other accounts.
 */
export function UsersAdminSection() {
  const { me } = useAuth();
  const {
    data: users,
    error: loadError,
    loading: refreshing,
    reload,
  } = useApiResource<AdminUser[]>(
    () => api.listAdminUsers(),
    "Failed to load users.",
    { cacheKey: "admin:users" },
  );
  const [actionError, setActionError] = useState<string | null>(null);
  const error = actionError ?? loadError;
  const [busy, setBusy] = useState<Set<string>>(() => new Set());
  // The target stays set through the dialog's exit fade; the nonce remounts
  // it on every open so its playlist preview is fresh.
  const [deleteTarget, setDeleteTarget] = useState<{ user: AdminUser; nonce: number } | null>(
    null,
  );
  const [deleteOpen, setDeleteOpen] = useState(false);

  const summary = useMemo(() => (users ? summaryLine(users) : ""), [users]);

  const setBusyFor = (id: string, on: boolean) =>
    setBusy((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  const toggleDisabled = async (user: AdminUser) => {
    if (
      !user.disabled &&
      !window.confirm(
        `Disable ${user.username}?\n\nThey're signed out everywhere and can't sign in until you enable the account again.`,
      )
    ) {
      return;
    }
    setActionError(null);
    setBusyFor(user.id, true);
    try {
      if (user.disabled) await api.enableUser(user.id);
      else await api.disableUser(user.id);
      await reload();
    } catch (err) {
      setActionError(
        errorMessage(err, `Couldn't ${user.disabled ? "enable" : "disable"} ${user.username}.`),
      );
    } finally {
      setBusyFor(user.id, false);
    }
  };

  const startDelete = (user: AdminUser) => {
    setActionError(null);
    setDeleteTarget((prev) => ({ user, nonce: (prev?.nonce ?? 0) + 1 }));
    setDeleteOpen(true);
  };

  return (
    <AdminPanel>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
        }}
      >
        <p style={{ color: "var(--muted-foreground)", fontSize: 14, margin: 0 }}>
          {summary}
        </p>
        <Button
          size="sm"
          onClick={reload}
          disabled={refreshing}
          leadingIcon={<ArrowPathIcon className="size-3.5" />}
        >
          Refresh
        </Button>
      </div>

      {error && <ErrorBanner message={error} />}

      <AdminSection title="All users">
        {users?.length === 0 ? (
          <EmptyState
            icon={<UserGroupIcon />}
            title="No users found"
            hint="Registered accounts will appear here."
          />
        ) : (
          <table className="table table-static">
            <thead>
              <tr>
                <th>User</th>
                <th>Created</th>
                <th>Last login</th>
                <th className="col-acts" />
              </tr>
            </thead>
            <tbody>
              {users === null && (
                <tr>
                  <td
                    colSpan={4}
                    className="mono"
                    style={{ color: "var(--muted-foreground)" }}
                  >
                    Loading...
                  </td>
                </tr>
              )}
              {users?.map((user) => {
                const isMe = user.id === me?.id;
                const rowBusy = busy.has(user.id);
                return (
                  <tr key={user.id}>
                    <td>
                      <div className="row-name">
                        <span
                          className="track-title"
                          style={user.disabled ? { color: "var(--muted-foreground)" } : undefined}
                        >
                          {user.username}
                        </span>
                        {isMe && <span className="badge">you</span>}
                        {user.role === "admin" && <span className="badge">admin</span>}
                        {user.disabled && <span className="badge">disabled</span>}
                        {user.must_reset_password && (
                          <span className="badge">reset required</span>
                        )}
                      </div>
                    </td>
                    <td className="mono" style={{ color: "var(--muted-foreground)" }}>
                      {fmtDate(user.created_at)}
                    </td>
                    <td className="mono" style={{ color: "var(--muted-foreground)" }}>
                      {user.last_login_at ? fmtDateTime(user.last_login_at) : "Never"}
                    </td>
                    <td className="col-acts">
                      {!isMe && (
                        <div className="admin-actions">
                          <button
                            type="button"
                            className="iconbtn"
                            onClick={() => void toggleDisabled(user)}
                            disabled={rowBusy}
                            aria-label={`${user.disabled ? "Enable" : "Disable"} ${user.username}`}
                            title={user.disabled ? "Enable account" : "Disable account"}
                          >
                            {user.disabled ? (
                              <UserCheckIcon className="size-4" aria-hidden="true" />
                            ) : (
                              <UserXIcon className="size-4" aria-hidden="true" />
                            )}
                          </button>
                          <button
                            type="button"
                            className="iconbtn iconbtn-danger"
                            onClick={() => startDelete(user)}
                            disabled={rowBusy}
                            aria-label={`Delete ${user.username}`}
                            title="Delete account"
                          >
                            <TrashIcon className="size-4" aria-hidden="true" />
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </AdminSection>

      {deleteTarget && users && (
        <DeleteUserDialog
          key={`${deleteTarget.user.id}:${deleteTarget.nonce}`}
          user={deleteTarget.user}
          users={users}
          meId={me?.id}
          open={deleteOpen}
          onClose={() => setDeleteOpen(false)}
          onDeleted={async () => {
            setDeleteOpen(false);
            await reload();
          }}
        />
      )}
    </AdminPanel>
  );
}
