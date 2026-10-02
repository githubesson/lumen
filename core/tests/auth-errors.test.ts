import { describe, expect, it } from "vitest";
import { ApiError } from "../src/api";
import {
  inviteCheckErrorMessage,
  loginErrorMessage,
  passwordChangeErrorMessage,
  registrationErrorMessage,
} from "../src/auth/errors";

// What fetch rejects with when the server can't be reached, and what the
// transport's deadline abort looks like.
const offline = new TypeError("Network request failed");
const timedOut = Object.assign(new Error("The operation was aborted."), {
  name: "AbortError",
});
const unreachable =
  "Couldn't reach the server. Check your connection and try again.";

describe("login errors", () => {
  it("maps the server's statuses", () => {
    expect(loginErrorMessage(new ApiError(401, "invalid credentials"))).toBe(
      "Invalid username or password.",
    );
    expect(loginErrorMessage(new ApiError(403, "account disabled"))).toBe(
      "This account has been disabled.",
    );
    expect(
      loginErrorMessage(
        new ApiError(429, "too many failed attempts; try again later"),
      ),
    ).toBe("Too many sign-in attempts. Try again later.");
    expect(loginErrorMessage(new ApiError(429, "rate limit exceeded"))).toBe(
      "Too many sign-in attempts. Try again later.",
    );
  });

  it("doesn't show other raw server text, which may be a proxy's error page", () => {
    expect(loginErrorMessage(new ApiError(503, "service unavailable"))).toBe(
      "Sign in failed. Please try again.",
    );
    expect(
      loginErrorMessage(new ApiError(502, "<html><body>Bad Gateway</body></html>")),
    ).toBe("Sign in failed. Please try again.");
  });

  it("says so when the server couldn't be reached", () => {
    expect(loginErrorMessage(offline)).toBe(unreachable);
    expect(loginErrorMessage(timedOut)).toBe(unreachable);
    expect(loginErrorMessage("boom")).toBe(unreachable);
  });
});

describe("registration errors", () => {
  it("maps taken usernames, rate limits and dead invites", () => {
    expect(registrationErrorMessage(new ApiError(409, "username taken"))).toBe(
      "That username is already taken.",
    );
    expect(
      registrationErrorMessage(new ApiError(429, "rate limit exceeded")),
    ).toBe("Too many registration attempts. Try again later.");
    const deadInvite =
      "This invite is no longer usable. Ask an admin for a new one.";
    expect(registrationErrorMessage(new ApiError(400, "invalid invite"))).toBe(
      deadInvite,
    );
    expect(
      registrationErrorMessage(new ApiError(400, "invite is no longer usable")),
    ).toBe(deadInvite);
  });

  it("passes other server messages through", () => {
    expect(registrationErrorMessage(new ApiError(400, "password too long"))).toBe(
      "password too long",
    );
    expect(registrationErrorMessage(new ApiError(500, ""))).toBe(
      "Registration failed (500).",
    );
  });

  it("says so when the server couldn't be reached", () => {
    expect(registrationErrorMessage(offline)).toBe(
      "Couldn't create your account. Check your connection and try again.",
    );
  });
});

describe("invite check errors", () => {
  it("never reads as a dead invite", () => {
    expect(inviteCheckErrorMessage(offline)).toBe(
      "Couldn't verify this invite. Check your connection and try again.",
    );
    expect(inviteCheckErrorMessage(new ApiError(500, "internal error"))).toBe(
      "Couldn't verify this invite. Try again.",
    );
    expect(inviteCheckErrorMessage(new ApiError(429, "rate limit exceeded"))).toBe(
      "Too many invite checks. Wait a minute and try again.",
    );
  });
});

describe("password change errors", () => {
  it("maps a wrong current password and rate limits", () => {
    expect(
      passwordChangeErrorMessage(new ApiError(401, "invalid credentials")),
    ).toBe("Your current password is incorrect.");
    expect(
      passwordChangeErrorMessage(new ApiError(429, "rate limit exceeded")),
    ).toBe("Too many attempts. Try again later.");
  });

  it("passes other server messages through", () => {
    expect(
      passwordChangeErrorMessage(
        new ApiError(400, "password too short (min 8 chars)"),
      ),
    ).toBe("password too short (min 8 chars)");
    expect(passwordChangeErrorMessage(new ApiError(500, ""))).toBe(
      "Couldn't change your password.",
    );
  });

  it("says so when the server couldn't be reached", () => {
    expect(passwordChangeErrorMessage(offline)).toBe(unreachable);
  });
});
