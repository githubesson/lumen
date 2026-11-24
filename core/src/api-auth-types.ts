export type Role = "user" | "admin";

export interface Me {
  id: string;
  username: string;
  role: Role;
  must_reset_password: boolean;
}

export interface LastFMStatus {
  configured: boolean;
  connected: boolean;
  pending: boolean;
  username?: string;
  last_error?: string;
}

export interface LastFMConnectResponse {
  authorization_url: string;
}

export interface LastFMAuthorizationPollOptions {
  signal?: AbortSignal;
  intervalMs?: number;
  timeoutMs?: number;
}

export interface Invite {
  id: string;
  token?: string;
  target_role: Role;
  max_uses: number;
  uses: number;
  expires_at?: string | null;
  revoked_at?: string | null;
  created_at: string;
}

/** A key scripts send as `Authorization: Bearer <key>` to call the API as its owner. */
export interface ApiKey {
  id: string;
  name: string;
  /** The key's first characters, to tell keys apart. */
  prefix: string;
  created_at: string;
  last_used_at: string | null;
  /** null: lasts until it's revoked. */
  expires_at: string | null;
}

/** A key just made, the only time the key itself is sent. */
export interface CreatedApiKey extends ApiKey {
  key: string;
}

export interface AdminUser {
  id: string;
  username: string;
  role: Role;
  disabled: boolean;
  must_reset_password: boolean;
  created_at: string;
  last_login_at?: string;
}

export interface InviteCheck {
  valid: boolean;
  target_role?: Role;
}
