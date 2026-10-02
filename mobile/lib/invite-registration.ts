const INVITE_SCHEME = "musiclibrarymobile";
const INVITE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,}$/;
const URL_CANDIDATE_PATTERN = /(?:https?:\/\/|musiclibrarymobile:\/\/)[^\s<>"']+/gi;

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
