import { ApiError } from "../api";

// Anything that isn't an ApiError never got an HTTP response: the request
// failed in the network or hit the client's deadline.
const UNREACHABLE = "Couldn't reach the server. Check your connection and try again.";

export function loginErrorMessage(err: unknown): string {
  if (!(err instanceof ApiError)) return UNREACHABLE;
  switch (err.status) {
    case 401:
      return "Invalid username or password.";
    // The server only says so after a correct password.
    case 403:
      return "This account has been disabled.";
    case 429:
      return "Too many sign-in attempts. Try again later.";
    default:
      return "Sign in failed. Please try again.";
  }
}

export function registrationErrorMessage(err: unknown): string {
  if (!(err instanceof ApiError)) {
    return "Couldn't create your account. Check your connection and try again.";
  }
  if (err.status === 409) return "That username is already taken.";
  if (err.status === 429) return "Too many registration attempts. Try again later.";
  // "invalid invite" or "invite is no longer usable", both 400s.
  if (err.message.includes("invite")) {
    return "This invite is no longer usable. Ask an admin for a new one.";
  }
  return err.message || `Registration failed (${err.status}).`;
}

/** For the public invite check, which answers `valid: false` for a dead invite. */
export function inviteCheckErrorMessage(err: unknown): string {
  if (err instanceof ApiError && err.status === 429) {
    return "Too many invite checks. Wait a minute and try again.";
  }
  return err instanceof ApiError
    ? "Couldn't verify this invite. Try again."
    : "Couldn't verify this invite. Check your connection and try again.";
}

export function passwordChangeErrorMessage(err: unknown): string {
  if (!(err instanceof ApiError)) return UNREACHABLE;
  if (err.status === 401) return "Your current password is incorrect.";
  if (err.status === 429) return "Too many attempts. Try again later.";
  return err.message || "Couldn't change your password.";
}
