//! Text placement calibration against Chromium: the rows in
//! frontend/public/__calib/index.html, drawn with Rune.
use rune::{AppSpec, Color, Cx, El, TextStyle, el, text};

struct S;

fn view(_: &S, _: &mut Cx<S>) -> El {
    let sizes = [11.0f32, 12., 13., 14., 16., 18., 20., 24., 28., 32.];
    let weights = [400.0f32, 500., 600.];
    let mut root = el().w_full().h_full().fill(Color::BLACK);
    let mut y = 0.0;
    for s in sizes {
        for w in weights {
            let lh = (s * 1.45 * 100.0).round() / 100.0;
            root = root.child(
                text("Hxgy Weather Over Low Country 0:42")
                    .font(TextStyle { line_height: lh, ..TextStyle::new(s, w) })
                    .color(Color::WHITE)
                    .absolute(10.0, y),
            );
            y += (s * 1.45).ceil() + 6.0;
        }
    }
    root
}

fn main() {
    let smooth = std::env::var("CALIB_SMOOTH").is_ok();
    let spec = AppSpec {
        fonts: &[include_bytes!("../assets/fonts/Geist-Variable.ttf"), include_bytes!("../assets/fonts/GeistMono-Variable.ttf")],
        families: ("Geist", "Geist Mono"),
        ..AppSpec::new("calib", (700.0, 1500.0), || S, view)
    };
    let app = rune::App::new(spec);
    let app = if smooth { app.font_smoothing(rune::FontSmoothing::On) } else { app };
    app.run();
}
