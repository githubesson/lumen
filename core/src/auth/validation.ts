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
  const passwordError =
    Array.from(password).length < 8
      ? "Password must be at least 8 characters."
      : utf8ByteLength(password) > 256
        ? "Password must be no more than 256 bytes."
        : null;

  return {
    username,
    usernameError,
    passwordError,
    valid: usernameError === null && passwordError === null,
  };
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
