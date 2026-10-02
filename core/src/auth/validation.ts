export type RegistrationValidation = {
  username: string;
  usernameError: string | null;
  passwordError: string | null;
  valid: boolean;
};

/**
 * Both clients require 2/8 Unicode characters for usernames/passwords. These
 * minima satisfy the server's byte minima, while its 256-byte password maximum
 * must be checked separately (a Unicode character can use up to four bytes).
 */
export function validateRegistrationInput(
  usernameInput: string,
  password: string,
): RegistrationValidation {
  const username = usernameInput.trim();
  const usernameError =
    Array.from(username).length >= 2
      ? null
      : "Username must be at least 2 characters.";
  const passwordError = passwordRuleError(password);

  return {
    username,
    usernameError,
    passwordError,
    valid: usernameError === null && passwordError === null,
  };
}

export type PasswordChangeValidation = {
  currentError: string | null;
  passwordError: string | null;
  confirmError: string | null;
  valid: boolean;
};

/**
 * A new password follows the registration rule. The current one is only
 * checked for presence: the server is the judge of whether it's right.
 */
export function validatePasswordChange(
  current: string,
  next: string,
  confirm: string,
): PasswordChangeValidation {
  const currentError = current ? null : "Enter your current password.";
  const passwordError = passwordRuleError(next);
  const confirmError = confirm === next ? null : "Passwords don't match.";
  return {
    currentError,
    passwordError,
    confirmError,
    valid:
      currentError === null && passwordError === null && confirmError === null,
  };
}

function passwordRuleError(password: string): string | null {
  return Array.from(password).length < 8
    ? "Password must be at least 8 characters."
    : utf8ByteLength(password) > 256
      ? "Password must be no more than 256 bytes."
      : null;
}

function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    bytes +=
      codePoint <= 0x7f
        ? 1
        : codePoint <= 0x7ff
          ? 2
          : codePoint <= 0xffff
            ? 3
            : 4;
  }
  return bytes;
}
