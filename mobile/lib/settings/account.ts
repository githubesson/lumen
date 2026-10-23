import type { Role } from "@music-library/core";

/** The avatar's letters: the username's first two, as the desktop sidebar shows. */
export function accountInitials(username: string | null | undefined): string {
  const name = username?.trim();
  if (!name) return "?";
  // By code point, so a name starting with an emoji keeps it whole.
  return Array.from(name).slice(0, 2).join("").toUpperCase();
}

/** The role under the username, worded as the invitation form words it. */
export function roleLabel(role: Role | null | undefined): string {
  switch (role) {
    case "admin":
      return "Admin";
    case "user":
      return "User";
    default:
      return "";
  }
}
