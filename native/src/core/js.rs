//! JavaScript's number parsing, where the web code leans on it.

/// `Number.parseInt(s, 10)`: leading whitespace and a sign, then digits up
/// to the first other character; `None` (NaN) without any.
pub fn parse_int(s: &str) -> Option<i64> {
    let s = s.trim_start();
    let (sign, rest) = match s.strip_prefix('-') {
        Some(r) => (-1, r),
        None => (1, s.strip_prefix('+').unwrap_or(s)),
    };
    let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
    if digits.is_empty() {
        return None;
    }
    Some(sign * digits.parse::<i64>().unwrap_or(i64::MAX))
}

/// `parseInt(s || "0", 10) || 0`: a form field as a whole number, 0 when
/// it has none.
pub fn int_or_zero(s: &str) -> i64 {
    parse_int(if s.is_empty() { "0" } else { s }).unwrap_or(0)
}

/// `Number(s)`: the whole trimmed string as a finite number; "" is 0.
pub fn number(s: &str) -> Option<f64> {
    let t = s.trim();
    if t.is_empty() {
        return Some(0.0);
    }
    t.parse::<f64>().ok().filter(|n| n.is_finite())
}

/// `s.length`: UTF-16 code units, which the web's length rules count.
pub fn utf16_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// `s.slice(0, max)`: the first `max` UTF-16 code units, never splitting a
/// surrogate pair (a character the cut would split is left out whole).
pub fn slice_utf16(s: &str, max: usize) -> &str {
    let mut units = 0;
    for (i, c) in s.char_indices() {
        units += c.len_utf16();
        if units > max {
            return &s[..i];
        }
    }
    s
}

/// JavaScript's `\s`: what `String.prototype.trim` removes.
pub fn is_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}'
            | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}'
    )
}

/// `s.trim()`, which (unlike Rust's) also takes the byte order mark U+FEFF
/// and leaves U+0085 alone.
pub fn trim(s: &str) -> &str {
    s.trim_matches(is_space)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_like_js() {
        assert_eq!(parse_int("12abc"), Some(12));
        assert_eq!(parse_int("  -5"), Some(-5));
        assert_eq!(parse_int("abc"), None);
        assert_eq!(parse_int(""), None);
        assert_eq!(int_or_zero(""), 0);
        assert_eq!(int_or_zero("x"), 0);
        assert_eq!(int_or_zero("2020"), 2020);
        assert_eq!(number("2.5"), Some(2.5));
        assert_eq!(number(""), Some(0.0));
        assert_eq!(number("1e999"), None);
        assert_eq!(number("12px"), None);
        assert_eq!(utf16_len("a🎵"), 3);
    }
}
