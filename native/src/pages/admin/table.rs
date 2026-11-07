//! The admin tables (`.table.table-static` in `library.css` and
//! `main-content.css`), laid out as a browser lays out an auto-width HTML
//! table: each column gets its cells' min- and max-content widths, then the
//! table's width is shared out the way Chromium does it (fixed columns keep
//! their width, auto columns split what's left in proportion to their
//! max-content width, or grow from their minimum when there isn't enough).

use std::cell::RefCell;
use std::collections::HashMap;
use std::hash::{Hash, Hasher};

use rune::{Color, El, TextStyle, col, el, row, text};

use crate::app::App;
use crate::theme::Theme;
use super::parts::{css_lh, line_box, lines_of};
use crate::ui::tooltip::TipExt;
use crate::ui::{css_border_bottom, font, mono, tnum};

/// How a column is sized.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum ColKind {
    /// Content decides.
    Auto,
    /// `.col-num`: 96 px, right-aligned tabular numbers.
    Num,
    /// `.col-acts`: 80 px (at least its buttons), right-aligned.
    Acts,
}

#[derive(Clone, Debug)]
pub struct Col {
    pub head: String,
    pub kind: ColKind,
}

impl Col {
    pub fn auto(head: &str) -> Col {
        Col { head: head.into(), kind: ColKind::Auto }
    }
    pub fn num(head: &str) -> Col {
        Col { head: head.into(), kind: ColKind::Num }
    }
    pub fn acts() -> Col {
        Col { head: String::new(), kind: ColKind::Acts }
    }
    fn fixed(&self) -> Option<f32> {
        match self.kind {
            ColKind::Auto => None,
            ColKind::Num => Some(96.0),
            ColKind::Acts => Some(80.0),
        }
    }
    fn right(&self) -> bool {
        self.kind != ColKind::Auto
    }
}

/// How a line of text breaks.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Wrap {
    /// At spaces and other break opportunities.
    Normal,
    /// `word-break: break-all`: anywhere, filling each line.
    BreakAll,
    /// `white-space: nowrap`.
    NoWrap,
}

/// One block of text in a cell (a `<div>` of it).
#[derive(Clone, Debug)]
pub struct Line {
    pub text: String,
    pub style: TextStyle,
    pub color: Color,
    pub wrap: Wrap,
}

impl Line {
    pub fn new(text: impl Into<String>, style: TextStyle, color: Color) -> Line {
        Line { text: text.into(), style, color, wrap: Wrap::Normal }
    }
    pub fn break_all(mut self) -> Line {
        self.wrap = Wrap::BreakAll;
        self
    }
    pub fn nowrap(mut self) -> Line {
        self.wrap = Wrap::NoWrap;
        self
    }

    /// (min-content, max-content) widths.
    pub fn widths(&self) -> (f32, f32) {
        let key = (self.text.clone(), StyleKey(self.style), self.wrap);
        MEASURED.with(|m| memo(&mut m.borrow_mut().widths, key, || self.measure()))
    }

    fn measure(&self) -> (f32, f32) {
        let max = advance(&self.text, self.style);
        let min = match self.wrap {
            Wrap::NoWrap => max,
            Wrap::Normal => rune::text::measure(&self.text, &[], self.style, Some(0.0)).0.min(max),
            Wrap::BreakAll => self.text.chars().map(|c| advance(c.encode_utf8(&mut [0; 4]), self.style)).fold(0.0, f32::max),
        };
        (min, max)
    }

    /// The line laid out `width` wide, as tall as its CSS line boxes.
    pub fn build(self, width: f32) -> El {
        let lh = css_lh(self.style);
        match self.wrap {
            Wrap::NoWrap => line_box(text(self.text).font(self.style).color(self.color), self.style),
            Wrap::Normal => {
                let n = lines_of(&self.text, &[], self.style, width);
                if n == 1 {
                    return line_box(text(self.text).font(self.style).color(self.color), self.style);
                }
                col().w(width).h(lh * n as f32).child(text(self.text).font(self.style).color(self.color).wrap().w(width))
            }
            Wrap::BreakAll => {
                let mut c = col();
                for l in breaks(&self.text, self.style, width) {
                    c = c.child(line_box(text(l).font(self.style).color(self.color), self.style));
                }
                c
            }
        }
    }
}

/// The unrounded width of `s` on one line.
pub fn advance(s: &str, style: TextStyle) -> f32 {
    if s.is_empty() { 0.0 } else { rune::text::advance(s, style) }
}

/// A text style as a map key (`TextStyle` hashes as it compares, and no
/// style here is NaN).
#[derive(Clone, Copy, PartialEq)]
struct StyleKey(TextStyle);

impl Eq for StyleKey {}

impl Hash for StyleKey {
    fn hash<H: Hasher>(&self, state: &mut H) {
        self.0.hash(state);
    }
}

/// What the tables measured, by text and style (and wrap, or width): they
/// rebuild every frame, and breaking a path anywhere measures it a prefix
/// at a time.
#[derive(Default)]
struct Measured {
    widths: HashMap<(String, StyleKey, Wrap), (f32, f32)>,
    breaks: HashMap<(String, StyleKey, u32), Vec<String>>,
}

thread_local! {
    static MEASURED: RefCell<Measured> = RefCell::default();
}

/// Entries a cache holds before it starts over (resizing the window leaves
/// a trail of widths).
const MEASURED_CAP: usize = 4096;

fn memo<K: Hash + Eq, V: Clone>(map: &mut HashMap<K, V>, key: K, measure: impl FnOnce() -> V) -> V {
    if let Some(v) = map.get(&key) {
        return v.clone();
    }
    if map.len() >= MEASURED_CAP {
        map.clear();
    }
    let v = measure();
    map.insert(key, v.clone());
    v
}

/// [`break_all`], once per text, style and width.
fn breaks(s: &str, style: TextStyle, width: f32) -> Vec<String> {
    let key = (s.to_string(), StyleKey(style), width.to_bits());
    MEASURED.with(|m| memo(&mut m.borrow_mut().breaks, key, || break_all(s, style, width)))
}

/// `word-break: break-all`: fill each line to `width`, breaking between any
/// two characters the line-breaking rules still allow (never before closing
/// punctuation, `/` or a hyphen, nor after an opening bracket, UAX #14
/// LB13/LB14/LB21); spaces at a break are dropped.
fn break_all(s: &str, style: TextStyle, width: f32) -> Vec<String> {
    let chars: Vec<char> = s.chars().collect();
    let allowed = |i: usize| -> bool {
        // A break before chars[i].
        let (a, b) = (chars[i - 1], chars[i]);
        if b == ' ' {
            return false;
        }
        if a == ' ' {
            return true;
        }
        !(matches!(b, '/' | ',' | '.' | ':' | ';' | '!' | '?' | ')' | ']' | '}' | '-' | '%') || matches!(a, '(' | '[' | '{'))
    };
    let fits = |from: usize, to: usize| advance(chars[from..to].iter().collect::<String>().trim_end(), style) <= width + 0.01;
    let mut lines = Vec::new();
    let mut start = 0;
    while start < chars.len() {
        let mut end = start + 1;
        while end < chars.len() && fits(start, end + 1) {
            end += 1;
        }
        if end < chars.len() {
            // Back up to the last break opportunity on the line.
            let mut cut = end;
            while cut > start + 1 && !allowed(cut) {
                cut -= 1;
            }
            if cut > start + 1 || allowed(cut) {
                end = cut;
            }
        }
        lines.push(chars[start..end].iter().collect::<String>().trim_end().to_string());
        start = end;
        while start < chars.len() && chars[start] == ' ' {
            start += 1;
        }
    }
    if lines.is_empty() {
        lines.push(String::new());
    }
    lines
}

type Build = Box<dyn FnOnce(f32) -> El>;

/// A cell's content and its min- and max-content widths (padding excluded).
pub struct Cell {
    pub min: f32,
    pub max: f32,
    build: Build,
}

impl Cell {
    /// Content that doesn't depend on the column's width.
    pub fn el(content: El, min: f32, max: f32) -> Cell {
        Cell { min, max, build: Box::new(move |_| content) }
    }
    /// Content built for the column's content width.
    pub fn with(min: f32, max: f32, build: impl FnOnce(f32) -> El + 'static) -> Cell {
        Cell { min, max, build: Box::new(build) }
    }
    /// Lines stacked as blocks, each `gap` apart.
    pub fn lines(lines: Vec<Line>) -> Cell {
        Cell::stack(lines.into_iter().map(Part::Line).collect(), 0.0)
    }
    /// One line of text.
    pub fn text(line: Line) -> Cell {
        Cell::lines(vec![line])
    }
    /// Blocks stacked top to bottom, `gap` apart.
    pub fn stack(parts: Vec<Part>, gap: f32) -> Cell {
        let (mut min, mut max) = (0f32, 0f32);
        for p in &parts {
            let (a, b) = p.widths();
            min = min.max(a);
            max = max.max(b);
        }
        Cell::with(min, max, move |w| {
            let mut c = col().gap(gap);
            for p in parts {
                c = c.child(p.build(w));
            }
            c
        })
    }
    /// Nothing.
    pub fn empty() -> Cell {
        Cell::el(el(), 0.0, 0.0)
    }
}

/// A block inside a cell.
pub enum Part {
    Line(Line),
    /// A flex row of items `gap` apart, each (element, min, max); text items
    /// may shrink and wrap.
    Row(Vec<(El, f32, f32)>, f32),
    /// An element of a known size.
    Fixed(El, f32),
}

impl Part {
    fn widths(&self) -> (f32, f32) {
        match self {
            Part::Line(l) => l.widths(),
            Part::Row(items, gap) => {
                let gaps = gap * items.len().saturating_sub(1) as f32;
                let min: f32 = items.iter().map(|i| i.1).sum::<f32>() + gaps;
                let max: f32 = items.iter().map(|i| i.2).sum::<f32>() + gaps;
                (min, max)
            }
            Part::Fixed(_, w) => (*w, *w),
        }
    }
    fn build(self, width: f32) -> El {
        match self {
            Part::Line(l) => l.build(width),
            Part::Row(items, gap) => {
                // A row of one-line items: the title's 14 px line box sets its height.
                let mut r = row().h(css_lh(font(14.0, 400.0))).gap(gap).items_center();
                for (e, _, _) in items {
                    r = r.child(e);
                }
                r
            }
            Part::Fixed(e, _) => e,
        }
    }
}

pub struct Row {
    pub key: String,
    pub cells: Vec<Cell>,
}

/// The column widths an auto-layout table `total` wide gives, from each
/// column's (min, max) content widths, padding included.
pub fn distribute(cols: &[Col], widths: &[(f32, f32)], total: f32) -> Vec<f32> {
    let n = cols.len();
    let mut min = vec![0f32; n];
    let mut max = vec![0f32; n];
    for i in 0..n {
        min[i] = widths[i].0;
        max[i] = widths[i].1.max(min[i]);
        if let Some(f) = cols[i].fixed() {
            max[i] = f.max(min[i]);
        }
    }
    let fixed: Vec<bool> = cols.iter().map(|c| c.fixed().is_some()).collect();
    let min_total: f32 = min.iter().sum();
    let max_total: f32 = max.iter().sum();
    if total <= min_total {
        return min;
    }
    if total >= max_total {
        let extra = total - max_total;
        let auto_max: f32 = (0..n).filter(|&i| !fixed[i]).map(|i| max[i]).sum();
        let autos = (0..n).filter(|&i| !fixed[i]).count();
        let mut out = max.clone();
        if autos > 0 {
            for i in (0..n).filter(|&i| !fixed[i]) {
                out[i] += if auto_max > 0.0 { extra * max[i] / auto_max } else { extra / autos as f32 };
            }
        } else if max_total > 0.0 {
            for i in 0..n {
                out[i] += extra * max[i] / max_total;
            }
        }
        return out;
    }
    // Between: fixed columns grow to their width first, then auto columns
    // from their minimum towards their maximum.
    let specified: f32 = (0..n).map(|i| if fixed[i] { max[i] } else { min[i] }).sum();
    let mut out = min.clone();
    if total <= specified {
        let room: f32 = (0..n).filter(|&i| fixed[i]).map(|i| max[i] - min[i]).sum();
        for i in (0..n).filter(|&i| fixed[i]) {
            if room > 0.0 {
                out[i] += (max[i] - min[i]) * (total - min_total) / room;
            }
        }
    } else {
        let room: f32 = (0..n).filter(|&i| !fixed[i]).map(|i| max[i] - min[i]).sum();
        for i in 0..n {
            if fixed[i] {
                out[i] = max[i];
            } else if room > 0.0 {
                out[i] += (max[i] - min[i]) * (total - specified) / room;
            }
        }
    }
    out
}

/// `.table thead th` text.
pub fn head_style() -> TextStyle {
    font(12.0, 500.0)
}

/// What fills the table when it has no rows: a muted line across it.
pub struct Empty {
    pub label: String,
    /// `className="mono"` (tabular numbers).
    pub mono: bool,
}

/// A `.table.table-static`, `width` wide. `hover` lights rows under the
/// pointer (every `.table` does).
pub fn table(t: &Theme, key: &str, cols: &[Col], rows: Vec<Row>, empty: Option<Empty>, width: f32) -> El {
    let head = head_style();
    let mut widths: Vec<(f32, f32)> = cols
        .iter()
        .map(|c| {
            let w = advance(&c.head, head) + 16.0;
            (w, w)
        })
        .collect();
    for r in &rows {
        for (i, c) in r.cells.iter().enumerate().take(cols.len()) {
            widths[i].0 = widths[i].0.max(c.min + 16.0);
            widths[i].1 = widths[i].1.max(c.max + 16.0);
        }
    }
    let colw = distribute(cols, &widths, width);

    let mut header = row().key(format!("{key}-head")).h(40.0).pb(1.0).fill(t.c.background);
    header = css_border_bottom(header, 1.0, t.c.border);
    for (i, c) in cols.iter().enumerate() {
        let mut cell = col().w(colw[i]).h_full().px(8.0).justify_center();
        if c.right() {
            cell = cell.items_end();
        }
        if !c.head.is_empty() {
            cell = cell.child(line_box(text(c.head.clone()).font(head).color(t.c.muted_foreground), head));
        }
        header = header.child(cell);
    }
    let mut body = col().key(key.to_string()).w(width).child(header);

    if rows.is_empty() {
        if let Some(e) = empty {
            let style = if e.mono { tnum(font(14.0, 400.0)) } else { font(14.0, 400.0) };
            let r = row().min_h(t.row_h()).pb(1.0).px(8.0).items_center().hover(t.c.ghost_hover);
            body = body.child(css_border_bottom(r, 1.0, t.c.border).child(line_box(text(e.label).font(style).color(t.c.muted_foreground), style)));
        }
    }
    for r in rows {
        let mut tr = row().key(r.key).w(width).min_h(t.row_h()).pb(1.0).items_stretch().hover(t.c.ghost_hover);
        tr = css_border_bottom(tr, 1.0, t.c.border);
        for (i, cell) in r.cells.into_iter().enumerate().take(cols.len()) {
            let inner = colw[i] - 16.0;
            let mut td = col().w(colw[i]).px(8.0).justify_center();
            if cols[i].right() {
                td = td.items_end();
            }
            tr = tr.child(td.child((cell.build)(inner)));
        }
        body = body.child(tr);
    }
    body
}

/// `.track-title`: 14 px medium foreground.
pub fn title_style() -> TextStyle {
    font(14.0, 500.0)
}

/// `.track-sub`: 12 px muted.
pub fn sub_style() -> TextStyle {
    font(12.0, 400.0)
}

/// `.track-sub.font-mono`.
pub fn sub_mono() -> TextStyle {
    mono(12.0, 400.0)
}

/// `.badge` (`badge-accent` when `accent`): its element and width.
pub fn badge(t: &Theme, label: &str, accent: bool) -> (El, f32) {
    let style = font(12.0, 500.0);
    let w = advance(label, style) + 18.0;
    let (bg, ink) = if accent { (t.c.primary, t.c.primary_foreground) } else { (t.c.secondary, t.c.secondary_foreground) };
    let e = row()
        .w(w)
        .h(20.0)
        .px(9.0)
        .items_center()
        .radius(999.0)
        .fill(bg)
        .child(text(label.to_string()).font(style).color(ink));
    (e, w)
}

/// A `.badge` inline in a cell's text: baseline-aligned in the 14 px line,
/// whose box it makes 21.70 px tall, sitting 1.70 px down. The strut's
/// baseline is 15 px down (`css_baseline(14, 20.3)`), the badge's 13.3 px
/// (its border, the 0.3 px its 17.4 px line is centred by, and
/// `css_baseline(12, 17.4)`), in LayoutUnits.
pub fn inline_badge(t: &Theme, label: &str, accent: bool) -> Part {
    let (b, w) = badge(t, label, accent);
    Part::Fixed(el().h(21.703125).child(b.mt(1.703125)), w)
}

/// A row action (`.admin-actions .iconbtn`): a muted 32 px icon button that
/// lights on hover, red for `danger`.
pub struct Action {
    pub key: String,
    pub glyph: &'static rune::Icon,
    pub label: String,
    pub help: String,
    pub danger: bool,
    pub disabled: bool,
    /// `.active` (a pressed toggle).
    pub active: bool,
}

impl Action {
    pub fn new(key: impl Into<String>, glyph: &'static rune::Icon, label: impl Into<String>, help: impl Into<String>) -> Action {
        Action { key: key.into(), glyph, label: label.into(), help: help.into(), danger: false, disabled: false, active: false }
    }
    pub fn danger(mut self) -> Action {
        self.danger = true;
        self
    }
    pub fn disabled(mut self, d: bool) -> Action {
        self.disabled = d;
        self
    }
    pub fn active(mut self, a: bool) -> Action {
        self.active = a;
        self
    }

    pub fn build(self, t: &Theme, on_press: impl Fn(&mut App) + 'static) -> El {
        let ink = if self.active { t.c.foreground } else { t.c.muted_foreground };
        let hot = if self.danger { t.c.destructive } else { t.c.foreground };
        let mut b = el()
            .size(32.0, 32.0)
            .radius(t.radius_lg())
            .center()
            .role("button")
            .label(self.label)
            .checked(self.active)
            .tip(&self.key, &self.help);
        if self.active {
            b = b.fill(t.c.muted);
        }
        if self.disabled {
            b.child(crate::ui::ico(self.glyph, 16.0, ink)).opacity(0.4).disabled(true).cursor(rune::Cursor::NotAllowed)
        } else {
            let over = if self.danger { t.c.destructive_soft } else { t.c.ghost_hover };
            b.child(crate::ui::ico(self.glyph, 16.0, ink).group_color(hot))
                .hover(over)
                .press_scale(0.95)
                .cursor(rune::Cursor::Pointer)
                .focusable(true)
                .on_press(on_press)
        }
    }
}

/// `.admin-actions`: row actions 8 px apart, and the cell's width for them.
pub fn actions(buttons: Vec<El>) -> Cell {
    let n = buttons.len() as f32;
    let w = if buttons.is_empty() { 0.0 } else { n * 32.0 + (n - 1.0) * 8.0 };
    let mut r = row().gap(8.0).items_center();
    for b in buttons {
        r = r.child(b);
    }
    Cell::el(r, w, w)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn breaks_are_measured_once() {
        MEASURED.with(|m| *m.borrow_mut() = Measured::default());
        let style = mono(12.0, 400.0);
        let path = "/mnt/external/flac/Velvet Meridian/Demo 1.flac";
        let w = advance("/mnt/external/flac/", style) + 1.0;
        assert_eq!(breaks(path, style, w), break_all(path, style, w));
        assert_eq!(breaks(path, style, w), break_all(path, style, w));
        let line = Line::new(path, style, Color::BLACK).break_all();
        assert_eq!(line.widths(), line.measure());
        assert!(MEASURED.with(|m| m.borrow().breaks.len() == 1 && m.borrow().widths.len() == 1));
    }

    #[test]
    fn auto_columns_share_the_rest() {
        let cols = [Col::auto("a"), Col::num("n"), Col::acts()];
        // Plenty of room: the auto column takes everything the fixed ones don't.
        let w = distribute(&cols, &[(50.0, 100.0), (40.0, 60.0), (88.0, 88.0)], 956.0);
        assert_eq!(w, vec![956.0 - 96.0 - 88.0, 96.0, 88.0]);
        // Two auto columns split the extra in proportion to their max.
        let cols = [Col::auto("a"), Col::auto("b")];
        let w = distribute(&cols, &[(10.0, 100.0), (10.0, 300.0)], 800.0);
        assert_eq!(w, vec![200.0, 600.0]);
        // Too narrow for both maxima: each grows from its minimum.
        let w = distribute(&cols, &[(10.0, 100.0), (10.0, 300.0)], 220.0);
        assert!((w[0] - (10.0 + 90.0 * 200.0 / 380.0)).abs() < 1e-3);
    }
}
