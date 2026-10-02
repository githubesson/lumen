import { describe, expect, it } from "vitest";
import type { Invite } from "../src/api";
import {
  inviteExpiryLabel,
  inviteRoleLabel,
  inviteStatus,
  inviteSummary,
  inviteUsage,
  partitionInvites,
  validateInviteCreationInput,
  validateInviteCreationWithDate,
} from "../src/admin/invites";

const NOW = Date.parse("2026-10-02T12:00:00.000Z");

function invite(overrides: Partial<Invite> = {}): Invite {
  return {
    id: "inv",
    target_role: "user",
    max_uses: 1,
    uses: 0,
    created_at: "2026-10-01T12:00:00.000Z",
    ...overrides,
  };
}

describe("invite status", () => {
  it("is active while unrevoked, unexpired and with uses left", () => {
    expect(inviteStatus(invite(), NOW)).toBe("active");
    expect(
      inviteStatus(invite({ expires_at: "2026-10-02T12:00:01.000Z" }), NOW),
    ).toBe("active");
    expect(inviteStatus(invite({ expires_at: null, revoked_at: null }), NOW)).toBe(
      "active",
    );
  });

  it("checks revoked, then expired, then exhausted, like the server", () => {
    const spent = { uses: 1, max_uses: 1 };
    const past = "2026-10-01T00:00:00.000Z";
    expect(
      inviteStatus(invite({ ...spent, expires_at: past, revoked_at: past }), NOW),
    ).toBe("revoked");
    // Both expired and used up: the server's Usable reports expiry first.
    expect(inviteStatus(invite({ ...spent, expires_at: past }), NOW)).toBe(
      "expired",
    );
    expect(inviteStatus(invite(spent), NOW)).toBe("exhausted");
  });

  it("treats the expiry instant itself as expired", () => {
    expect(
      inviteStatus(invite({ expires_at: new Date(NOW).toISOString() }), NOW),
    ).toBe("expired");
  });

  it("counts an invite allowing no uses as exhausted, since redemption needs uses < max_uses", () => {
    expect(inviteStatus(invite({ max_uses: 0 }), NOW)).toBe("exhausted");
  });

  it("ignores an unreadable expiry rather than calling the invite expired", () => {
    expect(inviteStatus(invite({ expires_at: "not a date" }), NOW)).toBe(
      "active",
    );
  });

  it("splits active from past invites, keeping their order", () => {
    const rows = [
      invite({ id: "a" }),
      invite({ id: "expired", expires_at: "2026-09-01T00:00:00.000Z" }),
      invite({ id: "b", max_uses: 3, uses: 2 }),
      invite({ id: "spent", uses: 1 }),
      invite({ id: "revoked", revoked_at: "2026-09-01T00:00:00.000Z" }),
    ];
    const { active, past } = partitionInvites(rows, NOW);
    expect(active.map((i) => i.id)).toEqual(["a", "b"]);
    expect(past.map((i) => i.id)).toEqual(["expired", "spent", "revoked"]);
  });
});

describe("invite labels", () => {
  const fmt = (iso: string) => iso.slice(0, 10);

  it("summarises the terms an invite was created with", () => {
    expect(
      inviteSummary(
        invite({ target_role: "admin", max_uses: 5, expires_at: "2026-10-09T00:00:00Z" }),
        fmt,
      ),
    ).toBe("Admin · 5 uses · expires 2026-10-09");
    expect(inviteSummary(invite(), fmt)).toBe("User · 1 use · no expiry");
  });

  it("labels role, usage and expiry on their own", () => {
    expect(inviteRoleLabel("user")).toBe("User");
    expect(inviteRoleLabel("admin")).toBe("Admin");
    expect(inviteUsage(invite({ uses: 2, max_uses: 5 }))).toBe("2 / 5");
    expect(inviteExpiryLabel(invite({ expires_at: null }), fmt)).toBe("no expiry");
    expect(
      inviteExpiryLabel(invite({ expires_at: "2026-10-09T00:00:00Z" }), fmt),
    ).toBe("expires 2026-10-09");
  });
});

describe("invite creation validation", () => {
  it("accepts positive whole-number uses and a blank expiry", () => {
    expect(validateInviteCreationInput(" 1 ", " ")).toEqual({
      maxUses: 1,
      expiresAt: undefined,
      maxUsesError: null,
      expiresError: null,
      valid: true,
    });
    expect(validateInviteCreationWithDate("2147483647", "").valid).toBe(true);
  });

  it.each(["", "0", "-1", "1.5", "1e3", "2147483648", "many"])(
    "rejects max uses %j on both input shapes, instead of letting the server turn it into 1",
    (value) => {
      for (const result of [
        validateInviteCreationInput(value, ""),
        validateInviteCreationWithDate(value, ""),
      ]) {
        expect(result.valid).toBe(false);
        expect(result.maxUses).toBeNull();
        expect(result.maxUsesError).toBe(
          "Max uses must be a whole number from 1 to 2,147,483,647.",
        );
      }
    },
  );

  it("turns expiry days into an instant from the injected clock", () => {
    expect(validateInviteCreationInput("2", "3", NOW)).toMatchObject({
      maxUses: 2,
      expiresAt: "2026-10-05T12:00:00.000Z",
      expiresError: null,
      valid: true,
    });
  });

  it.each([
    ["0", "Expiry must be a whole number of days greater than 0."],
    ["-1", "Expiry must be a whole number of days greater than 0."],
    ["1.5", "Expiry must be a whole number of days greater than 0."],
    ["later", "Expiry must be a whole number of days greater than 0."],
    ["3000000", "Expiry is too far in the future."],
    // Beyond what a Date can hold at all.
    ["9007199254740991", "Expiry is too far in the future."],
  ])("rejects expiry days %j", (value, message) => {
    const result = validateInviteCreationInput("1", value, NOW);
    expect(result.valid).toBe(false);
    expect(result.expiresAt).toBeUndefined();
    expect(result.expiresError).toBe(message);
  });

  it("accepts an expiry date in the future", () => {
    expect(
      validateInviteCreationWithDate("3", "2026-10-09T08:30:00.000Z", NOW),
    ).toMatchObject({
      maxUses: 3,
      expiresAt: "2026-10-09T08:30:00.000Z",
      expiresError: null,
      valid: true,
    });
  });

  it("reads a datetime-local value as local time", () => {
    expect(
      validateInviteCreationWithDate("1", "2026-10-09T08:30", NOW).expiresAt,
    ).toBe(new Date(2026, 9, 9, 8, 30).toISOString());
  });

  it.each([
    ["2026-10-02T12:00:00.000Z", "Expiry must be in the future."],
    ["2026-01-01T00:00", "Expiry must be in the future."],
    ["+010000-01-01T00:00:00.000Z", "Expiry is too far in the future."],
    ["soon", "Enter a valid expiry date."],
  ])("rejects expiry date %j", (value, message) => {
    const result = validateInviteCreationWithDate("1", value, NOW);
    expect(result.valid).toBe(false);
    expect(result.expiresAt).toBeUndefined();
    expect(result.expiresError).toBe(message);
  });
});
