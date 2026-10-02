import { describe, expect, it } from "vitest";
import {
  validatePasswordChange,
  validateRegistrationInput,
} from "../src/auth/validation";

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

describe("password change validation", () => {
  it("accepts a present current password and a matching new one", () => {
    expect(validatePasswordChange("old", "12345678", "12345678")).toEqual({
      currentError: null,
      passwordError: null,
      confirmError: null,
      valid: true,
    });
  });

  it("applies the registration rule to the new password in code points", () => {
    // Eight UTF-16 units but four characters: an HTML minLength would pass it.
    expect(validatePasswordChange("old", "😀".repeat(4), "😀".repeat(4))).toMatchObject({
      passwordError: "Password must be at least 8 characters.",
      valid: false,
    });
    expect(validatePasswordChange("old", "1234567", "1234567").passwordError).toBe(
      "Password must be at least 8 characters.",
    );
    expect(
      validatePasswordChange("old", "x".repeat(257), "x".repeat(257)).passwordError,
    ).toBe("Password must be no more than 256 bytes.");
  });

  it("requires the current password and a matching confirmation", () => {
    expect(validatePasswordChange("", "12345678", "12345678")).toMatchObject({
      currentError: "Enter your current password.",
      valid: false,
    });
    expect(validatePasswordChange("old", "12345678", "12345679")).toMatchObject({
      confirmError: "Passwords don't match.",
      valid: false,
    });
    expect(validatePasswordChange("old", "12345678", "").confirmError).toBe(
      "Passwords don't match.",
    );
  });
});
