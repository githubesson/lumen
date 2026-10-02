import type { Invite, Role } from "../api";
import { pluralize } from "../format";

export type InviteStatus = "active" | "revoked" | "expired" | "exhausted";

export const INVITE_STATUS_LABELS: Record<InviteStatus, string> = {
  active: "Active",
  revoked: "Revoked",
  expired: "Expired",
  exhausted: "Exhausted",
};

/** The server stores max_uses in a Postgres INTEGER. */
export const MAX_INVITE_USES = 2_147_483_647;

type InviteState = Pick<Invite, "revoked_at" | "expires_at" | "uses" | "max_uses">;

/**
 * Checks in the server's order (models.Invite.Usable): revoked, then expired,
 * then out of uses. An invite expires at its expiry instant, and one with no
 * uses allowed is spent, since redemption requires `uses < max_uses`.
 */
export function inviteStatus(inv: InviteState, now = Date.now()): InviteStatus {
  if (inv.revoked_at) return "revoked";
  if (inv.expires_at) {
    const expiresAt = Date.parse(inv.expires_at);
    if (!Number.isNaN(expiresAt) && expiresAt <= now) return "expired";
  }
  if (inv.uses >= inv.max_uses) return "exhausted";
  return "active";
}

/**
 * Active invites, which can still be redeemed and revoked, and past ones.
 * Revoking a past invite would change nothing, so only active ones offer it.
 * Both keep the server's order (newest first).
 */
export function partitionInvites<T extends InviteState>(
  invites: readonly T[],
  now = Date.now(),
): { active: T[]; past: T[] } {
  const active: T[] = [];
  const past: T[] = [];
  for (const inv of invites) {
    (inviteStatus(inv, now) === "active" ? active : past).push(inv);
  }
  return { active, past };
}

export function inviteRoleLabel(role: Role): string {
  return role === "admin" ? "Admin" : "User";
}

/** "2 / 5": uses so far against the limit. */
export function inviteUsage(inv: Pick<Invite, "uses" | "max_uses">): string {
  return `${inv.uses} / ${inv.max_uses}`;
}

export function inviteExpiryLabel(
  inv: Pick<Invite, "expires_at">,
  formatDate: (iso: string) => string,
): string {
  return inv.expires_at ? `expires ${formatDate(inv.expires_at)}` : "no expiry";
}

/** "User · 5 uses · expires Oct 9, 2026": the terms an invite was created with. */
export function inviteSummary(
  inv: Pick<Invite, "target_role" | "max_uses" | "expires_at">,
  formatDate: (iso: string) => string,
): string {
  return [
    inviteRoleLabel(inv.target_role),
    pluralize(inv.max_uses, "use"),
    inviteExpiryLabel(inv, formatDate),
  ].join(" · ");
}

export type InviteCreationValidation = {
  maxUses: number | null;
  expiresAt: string | undefined;
  maxUsesError: string | null;
  expiresError: string | null;
  valid: boolean;
};

/**
 * Validates a new invite whose expiry is a whole number of days from now
 * (blank for none).
 */
export function validateInviteCreationInput(
  maxUsesInput: string,
  expiresDaysInput: string,
  now = Date.now(),
): InviteCreationValidation {
  const expiresDaysText = expiresDaysInput.trim();
  let expiry: Expiry = NO_EXPIRY;
  if (expiresDaysText) {
    const days = parsePositiveInteger(expiresDaysText);
    expiry =
      days === null
        ? invalidExpiry("Expiry must be a whole number of days greater than 0.")
        : // Enough days overflow the Date range, which is just as far out.
          expiryAt(new Date(now + days * 24 * 60 * 60 * 1000), now, TOO_FAR);
  }
  return withMaxUses(maxUsesInput, expiry);
}

/**
 * Validates a new invite whose expiry is a date and time (blank for none),
 * e.g. the value of a `datetime-local` input, which parses as local time.
 */
export function validateInviteCreationWithDate(
  maxUsesInput: string,
  expiresAtInput: string,
  now = Date.now(),
): InviteCreationValidation {
  const expiresAtText = expiresAtInput.trim();
  const expiry = expiresAtText
    ? expiryAt(new Date(expiresAtText), now, "Enter a valid expiry date.")
    : NO_EXPIRY;
  return withMaxUses(maxUsesInput, expiry);
}

type Expiry = { expiresAt: string | undefined; expiresError: string | null };

const NO_EXPIRY: Expiry = { expiresAt: undefined, expiresError: null };
const TOO_FAR = "Expiry is too far in the future.";

function invalidExpiry(expiresError: string): Expiry {
  return { expiresAt: undefined, expiresError };
}

/** The server parses expiry as RFC 3339, which only has four-digit years. */
function expiryAt(date: Date, now: number, invalidDate: string): Expiry {
  const time = date.getTime();
  if (Number.isNaN(time)) return invalidExpiry(invalidDate);
  if (time <= now) return invalidExpiry("Expiry must be in the future.");
  if (date.getUTCFullYear() > 9999) return invalidExpiry(TOO_FAR);
  return { expiresAt: date.toISOString(), expiresError: null };
}

/**
 * The server would quietly turn 0 or a negative into one use, so those are
 * rejected here rather than sent.
 */
function withMaxUses(
  maxUsesInput: string,
  expiry: Expiry,
): InviteCreationValidation {
  const parsedMaxUses = parsePositiveInteger(maxUsesInput.trim());
  const maxUses =
    parsedMaxUses !== null && parsedMaxUses <= MAX_INVITE_USES
      ? parsedMaxUses
      : null;
  const maxUsesError =
    maxUses === null
      ? "Max uses must be a whole number from 1 to 2,147,483,647."
      : null;
  return {
    maxUses,
    ...expiry,
    maxUsesError,
    valid: maxUsesError === null && expiry.expiresError === null,
  };
}

function parsePositiveInteger(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : null;
}
