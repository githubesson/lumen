const INVITE_SCHEME = "musiclibrarymobile";
const MAX_INVITE_USES = 2_147_483_647;
const INVITE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,}$/;
const URL_CANDIDATE_PATTERN = /(?:https?:\/\/|musiclibrarymobile:\/\/)[^\s<>"']+/gi;

export type InviteCreationValidation = {
  maxUses: number | null;
  expiresAt: string | undefined;
  maxUsesError: string | null;
  expiresDaysError: string | null;
  valid: boolean;
};

/**
 * Accept a raw invite token, a registration URL, or the complete message shared
 * by an admin. Tokens stay opaque here; the public invite-check endpoint is the
 * authority on whether one is real and still usable.
 */
export function extractInviteToken(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  if (isInviteToken(trimmed)) return trimmed;

  for (const candidate of trimmed.match(URL_CANDIDATE_PATTERN) ?? []) {
    const token = tokenFromUrl(candidate.replace(/[),.;]+$/, ""));
    if (token) return token;
  }

  const labeledToken = trimmed.match(
    /(?:invite\s+token|token)\s*:\s*([A-Za-z0-9_-]{16,})/i,
  )?.[1];
  return labeledToken && isInviteToken(labeledToken) ? labeledToken : null;
}

export function buildInviteRegistrationUrl(token: string): string {
  return `${INVITE_SCHEME}://register?token=${encodeURIComponent(token)}`;
}

export function buildInviteShareMessage(token: string): string {
  const url = buildInviteRegistrationUrl(token);
  return [
    "You've been invited to Lumen.",
    "",
    "Open this link on a device with Lumen installed:",
    url,
    "",
    "If the link doesn't open, open Lumen, choose Create account, and paste this invite token:",
    token,
  ].join("\n");
}

export function validateInviteCreationInput(
  maxUsesInput: string,
  expiresDaysInput: string,
  now = Date.now(),
): InviteCreationValidation {
  const maxUsesText = maxUsesInput.trim();
  const expiresDaysText = expiresDaysInput.trim();

  const parsedMaxUses = parsePositiveInteger(maxUsesText);
  const maxUses =
    parsedMaxUses !== null && parsedMaxUses <= MAX_INVITE_USES
      ? parsedMaxUses
      : null;
  const maxUsesError =
    maxUses === null
      ? "Max uses must be a whole number from 1 to 2,147,483,647."
      : null;

  const expiresDays = expiresDaysText
    ? parsePositiveInteger(expiresDaysText)
    : null;
  let expiresDaysError =
    expiresDaysText && expiresDays === null
      ? "Expiry must be a whole number of days greater than 0."
      : null;
  let expiresAt: string | undefined;
  if (expiresDays !== null) {
    const expiresDate = new Date(now + expiresDays * 24 * 60 * 60 * 1000);
    if (
      Number.isNaN(expiresDate.getTime()) ||
      expiresDate.getUTCFullYear() > 9999
    ) {
      expiresDaysError = "Expiry is too far in the future.";
    } else {
      expiresAt = expiresDate.toISOString();
    }
  }

  return {
    maxUses,
    expiresAt,
    maxUsesError,
    expiresDaysError,
    valid: maxUsesError === null && expiresDaysError === null,
  };
}

function tokenFromUrl(candidate: string): string | null {
  try {
    const token = new URL(candidate).searchParams.get("token")?.trim() ?? "";
    return isInviteToken(token) ? token : null;
  } catch {
    return null;
  }
}

function isInviteToken(value: string): boolean {
  return INVITE_TOKEN_PATTERN.test(value);
}

function parsePositiveInteger(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : null;
}
