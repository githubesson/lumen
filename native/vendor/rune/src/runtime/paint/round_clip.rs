//! Lumen patch (`native/vendor/README.md`): rounded clips a rectangle settles without a layer.
//!
//! An instance carries one clip rectangle whose corners may round, so upstream opens an offscreen
//! layer whenever an element's clip rectangle isn't exactly its rounded mask, and whenever it
//! clips with a rounded rectangle of its own inside another. Most of those masks change nothing:
//! a scroll viewport cut off at the top below its panel's corners, a zero-radius `clip_rounded`
//! deep inside a panel, a panel inset well inside the window's rounded corners. Each layer is a
//! full render pass into its own texture every frame, and a panel's layer is window-sized.
//!
//! Here a rounded mask is settled per corner against the rectangle the element and its subtree
//! paint in. A corner whose square that rectangle misses, or whose arc it clears by a pixel,
//! does nothing and drops to a square corner; a corner it shares takes the same arc on the
//! rectangle itself. Only an arc that crosses the rectangle elsewhere still needs the layer.
//! Rounded rectangles are convex, so clearing a corner's arc is a disk-in-disk test.

use super::turn::intersect;

/// How far, in device pixels, a painted corner must stay inside an arc before the arc's
/// antialiased edge can't reach it: `clip_alpha` (`clip.wgsl`) covers `0.5 - sd`.
const ARC_MARGIN: f32 = 0.5;
/// Edges this close count as the same edge.
const SAME: f32 = 1e-3;

/// A rounded mask: the rectangle (`[x0, y0, x1, y1]`) and its corner radii (top left, top right,
/// bottom right, bottom left; negative for continuous corners).
pub(super) type Round = ([f32; 4], [f32; 4]);

/// Corner `j` of `rect` and the direction into the rectangle from it.
fn corner(rect: [f32; 4], j: usize) -> ([f32; 2], [f32; 2]) {
    match j {
        0 => ([rect[0], rect[1]], [1.0, 1.0]),
        1 => ([rect[2], rect[1]], [-1.0, 1.0]),
        2 => ([rect[2], rect[3]], [-1.0, -1.0]),
        _ => ([rect[0], rect[3]], [1.0, -1.0]),
    }
}

/// What the mask `round` still does over `cut`, a rectangle inside it whose corners round
/// (circularly) by `own`: per corner, `Some(0.0)` where its arc touches nothing of `cut`,
/// `Some(radius)` where `cut` shares the corner and takes the arc as is, `None` where the arc
/// crosses `cut` elsewhere.
fn settle(cut: [f32; 4], own: [f32; 4], (mask, radii): Round) -> [Option<f32>; 4] {
    std::array::from_fn(|j| {
        let r = radii[j];
        let e = crate::render::corner_extent(r);
        if e <= 0.0 {
            return Some(0.0);
        }
        let (m, inward) = corner(mask, j);
        let (p, _) = corner(cut, j);
        let (dx, dy) = ((p[0] - m[0]) * inward[0], (p[1] - m[1]) * inward[1]);
        // `cut` starts past the corner's square on either axis.
        if dx >= e || dy >= e {
            return Some(0.0);
        }
        let ro = own[j].max(0.0);
        if dx.abs() <= SAME && dy.abs() <= SAME {
            // The same corner: the arc is `cut`'s own when it rounds alike, else `cut` takes it.
            return Some(if ro == r { 0.0 } else { r });
        }
        // Toward the mask's corner, `cut`'s outermost points are its own corner arc (its corner
        // point when square): each point of `cut` in the corner's square has one of them below
        // and left of it, and what lies outside the mask's arc there stays outside toward the
        // corner. So the arc settles when all of `cut`'s corner arc lies inside it, with room
        // for its antialiasing.
        (r > 0.0 && farthest(dx + ro - e, dy + ro - e, ro) <= e - ARC_MARGIN).then_some(0.0)
    })
}

/// The farthest a point of the quarter arc `c' - ro (cos θ, sin θ)`, θ in [0, π/2], gets from a
/// centre that `c'` sits at `(vx, vy)` from.
fn farthest(vx: f32, vy: f32, ro: f32) -> f32 {
    let len = (vx * vx + vy * vy).sqrt();
    // The least `v · (cos θ, sin θ)` over the quarter: -|v| when the quarter faces away from it.
    let least = if vx <= 0.0 && vy <= 0.0 { -len } else { vx.min(vy) };
    (len * len - 2.0 * ro * least + ro * ro).max(0.0).sqrt()
}

/// Settles this element's own rounded clip `own_round` and the one it inherits, `rounded`,
/// against its clip rectangle `clip`, which the inherited mask already bounds. A settled mask
/// drops, or becomes the clip rectangle with the radii of the corners it shares; one that
/// doesn't settle is left for the layers that draw it. `open_cache`: a cache layer applies
/// `own_round` itself.
pub(super) fn settle_rounds(clip: &mut [f32; 4], rounded: &mut Option<Round>, own_round: &mut Option<Round>, open_cache: bool) {
    // The element's own clip first: it and its subtree paint inside it.
    let (mut area, mut own) = (*clip, [0.0; 4]);
    if !open_cache && let Some((mask, radii)) = *own_round {
        let cut = intersect(*clip, mask);
        area = cut;
        if cut[2] <= cut[0] || cut[3] <= cut[1] {
            *clip = cut;
            *own_round = None;
        } else if let [Some(a), Some(b), Some(c), Some(d)] = fits(cut, settle(cut, [0.0; 4], (mask, radii))) {
            if [a, b, c, d] == [0.0; 4] {
                *clip = cut;
                *own_round = None;
            } else {
                *own_round = Some((cut, [a, b, c, d]));
                own = [a, b, c, d];
            }
        }
    }
    let Some((mask, radii)) = *rounded else { return };
    let cut = intersect(area, mask);
    if cut[2] <= cut[0] || cut[3] <= cut[1] {
        *clip = intersect(*clip, cut);
        *rounded = None;
        return;
    }
    if let [Some(a), Some(b), Some(c), Some(d)] = fits(cut, settle(cut, own, (mask, radii))) {
        if [a, b, c, d] == [0.0; 4] {
            *clip = intersect(*clip, mask);
            *rounded = None;
        } else if own_round.is_none() {
            *clip = cut;
            *rounded = Some((cut, [a, b, c, d]));
        }
    }
}

/// `radii` for `rect`, unless one of its arcs needs more room than `rect` gives it (an arc
/// wider than half an edge would be drawn smaller).
fn fits(rect: [f32; 4], radii: [Option<f32>; 4]) -> [Option<f32>; 4] {
    let half = (rect[2] - rect[0]).min(rect[3] - rect[1]) * 0.5;
    let room = radii.iter().flatten().all(|&r| crate::render::corner_extent(r) <= half + SAME);
    if room { radii } else { [None; 4] }
}

#[cfg(test)]
mod tests {
    use super::*;

    const PANEL: [f32; 4] = [0.0, 0.0, 400.0, 300.0];

    #[test]
    fn a_viewport_cut_below_the_top_corners_keeps_the_bottom_ones() {
        let mut clip = [0.0, 60.0, 400.0, 300.0];
        let mut rounded = Some((PANEL, [12.0; 4]));
        settle_rounds(&mut clip, &mut rounded, &mut None, false);
        assert_eq!(rounded, Some(([0.0, 60.0, 400.0, 300.0], [0.0, 0.0, 12.0, 12.0])));
        assert_eq!(clip, [0.0, 60.0, 400.0, 300.0]);
    }

    #[test]
    fn a_panel_inset_inside_the_window_corners_drops_the_window_mask() {
        let (mut clip, mut rounded, mut own) = (PANEL, Some((PANEL, [12.0; 4])), Some(([8.0, 8.0, 392.0, 292.0], [12.0; 4])));
        settle_rounds(&mut clip, &mut rounded, &mut own, false);
        assert_eq!(rounded, None);
        assert_eq!(own, Some(([8.0, 8.0, 392.0, 292.0], [12.0; 4])));
    }

    #[test]
    fn a_square_clip_inside_a_panel_drops_both_masks() {
        let mut clip = [0.0, 60.0, 400.0, 300.0];
        let mut rounded = Some(([0.0, 60.0, 400.0, 300.0], [0.0, 0.0, 12.0, 12.0]));
        let mut own = Some(([20.0, 100.0, 52.0, 140.0], [0.0; 4]));
        settle_rounds(&mut clip, &mut rounded, &mut own, false);
        assert_eq!((rounded, own, clip), (None, None, [20.0, 100.0, 52.0, 140.0]));
    }

    #[test]
    fn an_arc_through_the_painted_rectangle_still_needs_a_layer() {
        // Inset by one pixel: the panel's arc crosses the bottom corners.
        let mut clip = [1.0, 60.0, 399.0, 299.0];
        let mut rounded = Some((PANEL, [12.0; 4]));
        settle_rounds(&mut clip, &mut rounded, &mut None, false);
        assert_eq!(rounded, Some((PANEL, [12.0; 4])));
        // A card scrolled half out under its own top corners.
        let mut clip = [0.0, 60.0, 400.0, 300.0];
        let mut own = Some(([20.0, 55.0, 120.0, 155.0], [10.0; 4]));
        settle_rounds(&mut clip, &mut None, &mut own, false);
        assert_eq!(own, Some(([20.0, 55.0, 120.0, 155.0], [10.0; 4])));
    }

    #[test]
    fn a_card_scrolled_past_its_top_corners_squares_them() {
        let mut clip = [0.0, 60.0, 400.0, 300.0];
        let mut own = Some(([20.0, 40.0, 120.0, 140.0], [10.0; 4]));
        settle_rounds(&mut clip, &mut None, &mut own, false);
        assert_eq!(own, Some(([20.0, 60.0, 120.0, 140.0], [0.0, 0.0, 10.0, 10.0])));
    }

    #[test]
    fn concentric_inner_corners_sit_inside_the_outer_arc() {
        // CSS's padding-box radius: inset 1, radius 11, the same centres.
        let mut clip = [1.0, 60.0, 399.0, 299.0];
        let mut rounded = Some((PANEL, [12.0; 4]));
        let mut own = Some(([1.0, 60.0, 399.0, 299.0], [0.0, 0.0, 11.0, 11.0]));
        settle_rounds(&mut clip, &mut rounded, &mut own, false);
        assert_eq!(rounded, None);
    }
}
