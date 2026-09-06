import { describe, expect, it } from "vitest";
import { validateRegistrationInput } from "../src/auth/validation";

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
