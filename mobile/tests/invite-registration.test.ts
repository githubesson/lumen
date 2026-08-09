import { describe, expect, it } from "vitest";
import {
  buildInviteRegistrationUrl,
  buildInviteShareMessage,
  extractInviteToken,
  validateInviteCreationInput,
  validateRegistrationInput,
} from "../lib/invite-registration";

const TOKEN = "abcdefghijklmnopqrstuvwxyz_ABCDEFGH-1234567";

describe("invite registration links", () => {
  it("builds the native registration URL", () => {
    expect(buildInviteRegistrationUrl(TOKEN)).toBe(
      `musiclibrarymobile://register?token=${TOKEN}`,
    );
  });

  it("percent-encodes the token query value", () => {
    expect(buildInviteRegistrationUrl("token with spaces")).toBe(
      "musiclibrarymobile://register?token=token%20with%20spaces",
    );
  });

  it("extracts a raw token with surrounding whitespace", () => {
    expect(extractInviteToken(`  ${TOKEN}\n`)).toBe(TOKEN);
  });

  it("extracts tokens from native and web registration URLs", () => {
    expect(
      extractInviteToken(
        `musiclibrarymobile://register?token=${encodeURIComponent(TOKEN)}`,
      ),
    ).toBe(TOKEN);
    expect(
      extractInviteToken(
        `https://lumen.example/register?token=${encodeURIComponent(TOKEN)}`,
      ),
    ).toBe(TOKEN);
  });

  it("extracts the token from the generated share message", () => {
    expect(extractInviteToken(buildInviteShareMessage(TOKEN))).toBe(TOKEN);
  });

  it("includes both the link and raw token in the share message", () => {
    const message = buildInviteShareMessage(TOKEN);
    expect(message).toContain(buildInviteRegistrationUrl(TOKEN));
    expect(message).toContain(`invite token:\n${TOKEN}`);
  });

  it("rejects empty text, prose, malformed tokens, and URLs without tokens", () => {
    expect(extractInviteToken("")).toBeNull();
    expect(extractInviteToken("please create an account")).toBeNull();
    expect(extractInviteToken("not+a+url-safe+token")).toBeNull();
    expect(extractInviteToken("https://lumen.example/register")).toBeNull();
  });
});

describe("registration validation", () => {
  it("trims usernames and accepts the server boundaries", () => {
    expect(validateRegistrationInput(" ab ", "12345678")).toMatchObject({
      username: "ab",
      usernameError: null,
      passwordError: null,
      valid: true,
    });
    expect(validateRegistrationInput("ab", "x".repeat(256)).valid).toBe(true);
    expect(validateRegistrationInput("ab", "😀".repeat(64)).valid).toBe(true);
  });

  it("rejects short usernames and passwords outside 8 to 256 characters", () => {
    expect(validateRegistrationInput(" a ", "12345678").usernameError).toBe(
      "Username must be at least 2 characters.",
    );
    expect(validateRegistrationInput("ab", "1234567").passwordError).toBe(
      "Password must be at least 8 characters.",
    );
    expect(validateRegistrationInput("ab", "x".repeat(257)).passwordError).toBe(
      "Password must be no more than 256 bytes.",
    );
    expect(validateRegistrationInput("ab", "😀".repeat(65)).passwordError).toBe(
      "Password must be no more than 256 bytes.",
    );
  });
});

describe("invite creation validation", () => {
  it("accepts positive whole-number uses and a blank expiry", () => {
    expect(validateInviteCreationInput("1", "")).toMatchObject({
      maxUses: 1,
      expiresAt: undefined,
      maxUsesError: null,
      expiresDaysError: null,
      valid: true,
    });
  });

  it.each(["", "0", "-1", "1.5", "2147483648", "many"])(
    "rejects invalid max uses: %s",
    (value) => {
      expect(validateInviteCreationInput(value, "").valid).toBe(false);
      expect(validateInviteCreationInput(value, "").maxUsesError).not.toBeNull();
    },
  );

  it("converts positive expiry days from an injected clock", () => {
    const now = Date.parse("2026-08-09T00:00:00.000Z");
    expect(validateInviteCreationInput("2", "3", now)).toMatchObject({
      maxUses: 2,
      expiresAt: "2026-08-12T00:00:00.000Z",
      expiresDaysError: null,
      valid: true,
    });
  });

  it.each(["0", "-1", "1.5", "3000000", "later"])(
    "rejects invalid expiry days: %s",
    (value) => {
      const result = validateInviteCreationInput("1", value);
      expect(result.valid).toBe(false);
      expect(result.expiresDaysError).not.toBeNull();
    },
  );
});
