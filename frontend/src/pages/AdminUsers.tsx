import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowPathIcon, UserGroupIcon } from "@heroicons/react/16/solid";
import { api, errorMessage, type AdminUser } from "../api";
import { Button } from "../components/Button";
import EmptyState from "../components/EmptyState";
import ErrorBanner from "../components/ErrorBanner";
import { useAuth } from "../context/Auth";
import { AdminSectionTitle } from "./admin/AdminSectionTitle";

function formatDateTime(value?: string) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleString();
}

function countActiveUsers(users: AdminUser[]) {
  return users.filter((u) => !u.disabled).length;
}

/**
 * Section for the unified Admin page. Shows all registered accounts with the
 * operational fields admins need most often, without changing account state.
 */
export function UsersAdminSection() {
  const { me } = useAuth();
  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    setRefreshing(true);
    setError(null);
    try {
      setUsers(await api.listAdminUsers());
    } catch (err) {
      setError(errorMessage(err, "Failed to load users."));
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const summary = useMemo(() => {
    const rows = users ?? [];
    return {
      total: rows.length,
      active: countActiveUsers(rows),
      admins: rows.filter((u) => u.role === "admin").length,
      resetRequired: rows.filter((u) => u.must_reset_password).length,
    };
  }, [users]);

  return (
    <div style={{ display: "grid", gap: 20 }}>
      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: 12,
        }}
      >
        <p
          style={{
            color: "var(--fg-muted)",
            fontSize: 13,
            margin: 0,
            maxWidth: "62ch",
          }}
        >
          View every registered account, including role, access status, reset
          requirements, and recent login activity.
        </p>
        <Button
          size="sm"
          onClick={() => void load()}
          disabled={refreshing}
          leadingIcon={<ArrowPathIcon className="size-3.5" />}
        >
          Refresh
        </Button>
      </div>

      <div className="stat-grid" aria-label="User summary">
        <div className="stat-card">
          <div className="stat-card-label">Total users</div>
          <div className="stat-card-value">{summary.total}</div>
          <div className="stat-card-sub">registered accounts</div>
        </div>
        <div className="stat-card">
          <div className="stat-card-label">Active</div>
          <div className="stat-card-value">{summary.active}</div>
          <div className="stat-card-sub">enabled accounts</div>
        </div>
        <div className="stat-card">
          <div className="stat-card-label">Admins</div>
          <div className="stat-card-value">{summary.admins}</div>
          <div className="stat-card-sub">with admin access</div>
        </div>
        <div className="stat-card">
          <div className="stat-card-label">Reset required</div>
          <div className="stat-card-value">{summary.resetRequired}</div>
          <div className="stat-card-sub">pending password change</div>
        </div>
      </div>

      {error && <ErrorBanner message={error} />}

      <section>
        <AdminSectionTitle style={{ margin: "0 0 12px" }}>
          All users
        </AdminSectionTitle>

        {users?.length === 0 ? (
          <EmptyState
            icon={<UserGroupIcon />}
            title="No users found"
            hint="Registered accounts will appear here."
          />
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Username</th>
                <th>Role</th>
                <th>Status</th>
                <th>Password</th>
                <th>Created</th>
                <th>Last login</th>
              </tr>
            </thead>
            <tbody>
              {users === null && (
                <tr>
                  <td
                    colSpan={6}
                    className="mono"
                    style={{ color: "var(--fg-subtle)" }}
                  >
                    Loading...
                  </td>
                </tr>
              )}
              {users?.map((user) => (
                <tr key={user.id}>
                  <td style={{ color: "var(--fg)" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span>{user.username}</span>
                      {user.id === me?.id && (
                        <span className="badge badge-accent">you</span>
                      )}
                    </div>
                  </td>
                  <td>
                    <span
                      className={
                        "badge" + (user.role === "admin" ? " badge-accent" : "")
                      }
                    >
                      {user.role}
                    </span>
                  </td>
                  <td>
                    <span
                      className={
                        "badge" + (!user.disabled ? " badge-accent" : "")
                      }
                    >
                      {user.disabled ? "disabled" : "active"}
                    </span>
                  </td>
                  <td>
                    <span
                      className={
                        "badge" +
                        (user.must_reset_password ? "" : " badge-accent")
                      }
                    >
                      {user.must_reset_password ? "reset required" : "set"}
                    </span>
                  </td>
                  <td className="mono" style={{ color: "var(--fg-subtle)" }}>
                    {formatDateTime(user.created_at)}
                  </td>
                  <td className="mono" style={{ color: "var(--fg-subtle)" }}>
                    {formatDateTime(user.last_login_at)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
