//! Serde helpers for the server's payloads.
//!
//! The Go server writes a nil slice as `null`, which `#[serde(default)]`
//! alone doesn't cover (it only fills in a missing field), so list fields
//! take `#[serde(default, deserialize_with = "nullable")]`.

use serde::{Deserialize, Deserializer};

/// `null` (or a missing field, with `#[serde(default)]`) reads as the
/// type's default.
pub fn nullable<'de, D, T>(d: D) -> Result<T, D::Error>
where
    D: Deserializer<'de>,
    T: Default + Deserialize<'de>,
{
    Ok(Option::<T>::deserialize(d)?.unwrap_or_default())
}

/// A string the server may send as a JSON number (the API tracker's
/// `tracker_id`, or `stringValue` in the web client): either reads as text.
pub fn string_or_number<'de, D>(d: D) -> Result<String, D::Error>
where
    D: Deserializer<'de>,
{
    Ok(match Option::<serde_json::Value>::deserialize(d)? {
        None | Some(serde_json::Value::Null) => String::new(),
        Some(serde_json::Value::String(s)) => s,
        Some(other) => other.to_string(),
    })
}

/// `Number(value) || 0` for a field that may be a number, a numeric string,
/// or missing.
pub fn lenient_u64<'de, D>(d: D) -> Result<u64, D::Error>
where
    D: Deserializer<'de>,
{
    Ok(match Option::<serde_json::Value>::deserialize(d)? {
        Some(serde_json::Value::Number(n)) => n.as_f64().filter(|f| f.is_finite() && *f > 0.0).map_or(0, |f| f as u64),
        Some(serde_json::Value::String(s)) => s.trim().parse::<f64>().ok().filter(|f| *f > 0.0).map_or(0, |f| f as u64),
        _ => 0,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Deserialize, Debug, Default)]
    struct Row {
        #[serde(default, deserialize_with = "nullable")]
        items: Vec<u32>,
        #[serde(default, deserialize_with = "string_or_number")]
        id: String,
        #[serde(default, deserialize_with = "lenient_u64")]
        n: u64,
    }

    #[test]
    fn null_lists_and_loose_numbers_decode() {
        let r: Row = serde_json::from_str(r#"{"items":null,"id":42,"n":"7"}"#).unwrap();
        assert!(r.items.is_empty());
        assert_eq!(r.id, "42");
        assert_eq!(r.n, 7);
        let r: Row = serde_json::from_str("{}").unwrap();
        assert!(r.items.is_empty() && r.id.is_empty() && r.n == 0);
    }
}
