//! `core/src/admin/invites.ts`: an invite's status and labels, and
//! validating a new one.

use crate::api::Role;
use crate::api::auth::Invite;
use crate::core::dates::{self, DAY_MS};
use crate::format::pluralize;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum InviteStatus {
    Active,
    Revoked,
    Expired,
    Exhausted,
}

impl InviteStatus {
    /// `INVITE_STATUS_LABELS`.
    pub fn label(self) -> &'static str {
        match self {
            InviteStatus::Active => "Active",
            InviteStatus::Revoked => "Revoked",
            InviteStatus::Expired => "Expired",
            InviteStatus::Exhausted => "Exhausted",
        }
    }
}

/// The server stores max_uses in a Postgres INTEGER.
const MAX_INVITE_USES: u64 = 2_147_483_647;

/// In the server's order: revoked, then expired (at its expiry instant),
/// then out of uses (redemption needs `uses < max_uses`).
pub fn invite_status(inv: &Invite, now_ms: i64) -> InviteStatus {
    if inv.revoked_at.as_deref().is_some_and(|r| !r.is_empty()) {
        return InviteStatus::Revoked;
    }
    if let Some(at) = inv.expires_at.as_deref().and_then(dates::parse)
        && at <= now_ms
    {
        return InviteStatus::Expired;
    }
    if inv.uses >= inv.max_uses {
        return InviteStatus::Exhausted;
    }
    InviteStatus::Active
}

/// Active invites (redeemable, revocable) and past ones, each in the
/// server's order.
pub fn partition_invites(invites: &[Invite], now_ms: i64) -> (Vec<Invite>, Vec<Invite>) {
    invites.iter().cloned().partition(|i| invite_status(i, now_ms) == InviteStatus::Active)
}

pub fn invite_role_label(role: Role) -> &'static str {
    if role == Role::Admin { "Admin" } else { "User" }
}

/// "2 / 5".
pub fn invite_usage(inv: &Invite) -> String {
    format!("{} / {}", inv.uses, inv.max_uses)
}

pub fn invite_expiry_label(inv: &Invite, format_date: impl Fn(&str) -> String) -> String {
    match inv.expires_at.as_deref().filter(|e| !e.is_empty()) {
        Some(at) => format!("expires {}", format_date(at)),
        None => "no expiry".into(),
    }
}

/// "User · 5 uses · expires Oct 9, 2026".
pub fn invite_summary(inv: &Invite, format_date: impl Fn(&str) -> String) -> String {
    [invite_role_label(inv.target_role).to_string(), pluralize(inv.max_uses, "use"), invite_expiry_label(inv, format_date)]
        .join(" · ")
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InviteCreationValidation {
    pub max_uses: Option<u64>,
    pub expires_at: Option<String>,
    pub max_uses_error: Option<&'static str>,
    pub expires_error: Option<&'static str>,
    pub valid: bool,
}

const TOO_FAR: &str = "Expiry is too far in the future.";
/// `8.64e15`: the largest time a JavaScript `Date` holds.
const MAX_DATE_MS: i128 = 8_640_000_000_000_000;

type Expiry = (Option<String>, Option<&'static str>);

fn parse_positive_integer(s: &str) -> Option<u64> {
    if s.is_empty() || !s.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let n: u64 = s.parse().ok()?;
    (1..=9_007_199_254_740_991).contains(&n).then_some(n)
}

/// The server parses expiry as RFC 3339, which only has four-digit years.
fn expiry_at(ms: Option<i128>, now_ms: i64, invalid_date: &'static str) -> Expiry {
    let Some(ms) = ms.filter(|m| m.abs() <= MAX_DATE_MS) else { return (None, Some(invalid_date)) };
    if ms <= now_ms as i128 {
        return (None, Some("Expiry must be in the future."));
    }
    if dates::utc_parts(ms as i64).year > 9999 {
        return (None, Some(TOO_FAR));
    }
    (Some(dates::to_iso(ms as i64)), None)
}

fn with_max_uses(max_uses_input: &str, (expires_at, expires_error): Expiry) -> InviteCreationValidation {
    let max_uses = parse_positive_integer(max_uses_input.trim()).filter(|n| *n <= MAX_INVITE_USES);
    let max_uses_error = max_uses.is_none().then_some("Max uses must be a whole number from 1 to 2,147,483,647.");
    InviteCreationValidation {
        max_uses,
        expires_at,
        max_uses_error,
        expires_error,
        valid: max_uses_error.is_none() && expires_error.is_none(),
    }
}

/// An invite whose expiry is a whole number of days from now (blank for none).
pub fn validate_invite_creation_input(max_uses: &str, expires_days: &str, now_ms: i64) -> InviteCreationValidation {
    let days = expires_days.trim();
    let expiry = if days.is_empty() {
        (None, None)
    } else {
        match parse_positive_integer(days) {
            None => (None, Some("Expiry must be a whole number of days greater than 0.")),
            // Enough days overflow the Date range, which is just as far out.
            Some(d) => expiry_at(Some(now_ms as i128 + d as i128 * DAY_MS as i128), now_ms, TOO_FAR),
        }
    };
    with_max_uses(max_uses, expiry)
}

/// An invite whose expiry is a date and time (blank for none), e.g. a
/// `datetime-local` value, which reads as local time.
pub fn validate_invite_creation_with_date(max_uses: &str, expires_at: &str, now_ms: i64) -> InviteCreationValidation {
    let text = expires_at.trim();
    let expiry = if text.is_empty() {
        (None, None)
    } else {
        expiry_at(dates::parse(text).map(i128::from), now_ms, "Enter a valid expiry date.")
    };
    with_max_uses(max_uses, expiry)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn now() -> i64 {
        dates::parse("2026-10-02T12:00:00.000Z").unwrap()
    }

    fn invite(f: impl FnOnce(&mut Invite)) -> Invite {
        let mut i = Invite { id: "inv".into(), max_uses: 1, created_at: "2026-10-01T12:00:00.000Z".into(), ..Default::default() };
        f(&mut i);
        i
    }

    #[test]
    fn statuses() {
        assert_eq!(invite_status(&invite(|_| {}), now()), InviteStatus::Active);
        assert_eq!(invite_status(&invite(|i| i.expires_at = Some("2026-10-02T12:00:01.000Z".into())), now()), InviteStatus::Active);
        let past = Some("2026-10-01T00:00:00.000Z".to_string());
        let spent = |i: &mut Invite| {
            i.uses = 1;
            i.max_uses = 1;
        };
        assert_eq!(
            invite_status(
                &invite(|i| {
                    spent(i);
                    i.expires_at = past.clone();
                    i.revoked_at = past.clone();
                }),
                now()
            ),
            InviteStatus::Revoked
        );
        assert_eq!(
            invite_status(
                &invite(|i| {
                    spent(i);
                    i.expires_at = past.clone();
                }),
                now()
            ),
            InviteStatus::Expired
        );
        assert_eq!(invite_status(&invite(spent), now()), InviteStatus::Exhausted);
        assert_eq!(invite_status(&invite(|i| i.expires_at = Some(dates::to_iso(now()))), now()), InviteStatus::Expired);
        assert_eq!(invite_status(&invite(|i| i.max_uses = 0), now()), InviteStatus::Exhausted);
        assert_eq!(invite_status(&invite(|i| i.expires_at = Some("not a date".into())), now()), InviteStatus::Active);
    }

    #[test]
    fn partitions() {
        let rows = vec![
            invite(|i| i.id = "a".into()),
            invite(|i| {
                i.id = "expired".into();
                i.expires_at = Some("2026-09-01T00:00:00.000Z".into());
            }),
            invite(|i| {
                i.id = "b".into();
                i.max_uses = 3;
                i.uses = 2;
            }),
            invite(|i| {
                i.id = "spent".into();
                i.uses = 1;
            }),
            invite(|i| {
                i.id = "revoked".into();
                i.revoked_at = Some("2026-09-01T00:00:00.000Z".into());
            }),
        ];
        let (active, past) = partition_invites(&rows, now());
        let ids = |v: &[Invite]| v.iter().map(|i| i.id.clone()).collect::<Vec<_>>();
        assert_eq!(ids(&active), ["a", "b"]);
        assert_eq!(ids(&past), ["expired", "spent", "revoked"]);
    }

    #[test]
    fn labels() {
        let fmt = |iso: &str| iso[..10].to_string();
        let admin = invite(|i| {
            i.target_role = Role::Admin;
            i.max_uses = 5;
            i.expires_at = Some("2026-10-09T00:00:00Z".into());
        });
        assert_eq!(invite_summary(&admin, fmt), "Admin · 5 uses · expires 2026-10-09");
        assert_eq!(invite_summary(&invite(|_| {}), fmt), "User · 1 use · no expiry");
        assert_eq!(invite_role_label(Role::User), "User");
        assert_eq!(invite_usage(&invite(|i| {
            i.uses = 2;
            i.max_uses = 5;
        })), "2 / 5");
        assert_eq!(invite_expiry_label(&invite(|_| {}), fmt), "no expiry");
        assert_eq!(InviteStatus::Exhausted.label(), "Exhausted");
    }

    #[test]
    fn creation_validation() {
        assert_eq!(
            validate_invite_creation_input(" 1 ", " ", now()),
            InviteCreationValidation { max_uses: Some(1), expires_at: None, max_uses_error: None, expires_error: None, valid: true }
        );
        assert!(validate_invite_creation_with_date("2147483647", "", now()).valid);
        for v in ["", "0", "-1", "1.5", "1e3", "2147483648", "many"] {
            for r in [validate_invite_creation_input(v, "", now()), validate_invite_creation_with_date(v, "", now())] {
                assert!(!r.valid && r.max_uses.is_none(), "{v}");
                assert_eq!(r.max_uses_error, Some("Max uses must be a whole number from 1 to 2,147,483,647."));
            }
        }
        let r = validate_invite_creation_input("2", "3", now());
        assert_eq!((r.max_uses, r.expires_at.as_deref(), r.expires_error, r.valid), (Some(2), Some("2026-10-05T12:00:00.000Z"), None, true));
        let whole = "Expiry must be a whole number of days greater than 0.";
        for (v, msg) in [("0", whole), ("-1", whole), ("1.5", whole), ("later", whole), ("3000000", TOO_FAR), ("9007199254740991", TOO_FAR)] {
            let r = validate_invite_creation_input("1", v, now());
            assert_eq!((r.valid, r.expires_at, r.expires_error), (false, None, Some(msg)), "{v}");
        }
        let r = validate_invite_creation_with_date("3", "2026-10-09T08:30:00.000Z", now());
        assert_eq!((r.max_uses, r.expires_at.as_deref(), r.valid), (Some(3), Some("2026-10-09T08:30:00.000Z"), true));
        assert_eq!(
            validate_invite_creation_with_date("1", "2026-10-09T08:30", now()).expires_at,
            Some(dates::to_iso(dates::local_ms(2026, 9, 9, 8) + 30 * 60_000))
        );
        for (v, msg) in [
            ("2026-10-02T12:00:00.000Z", "Expiry must be in the future."),
            ("2026-01-01T00:00", "Expiry must be in the future."),
            ("+010000-01-01T00:00:00.000Z", TOO_FAR),
            ("soon", "Enter a valid expiry date."),
        ] {
            let r = validate_invite_creation_with_date("1", v, now());
            assert_eq!((r.valid, r.expires_at, r.expires_error), (false, None, Some(msg)), "{v}");
        }
    }
}
