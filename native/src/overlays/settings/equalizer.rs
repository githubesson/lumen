//! Local, persisted sound controls. Live drags update audio immediately but
//! write the config only on release; cancellation restores the starting value.
use super::{SettingDef, select};
use crate::app::App;
use crate::player::engine::equalizer::{LABELS, PRESETS};
use crate::theme::Theme;
use crate::ui::forms::SelectOption;
use crate::ui::kit::switch;
use crate::ui::{Btn, font, line};
use rune::{Cursor, El, col, el, row, text};

fn value(app: &App, band: usize) -> f32 {
    let s = app.tweaks.equalizer.sanitized();
    if band == 10 {
        s.preamp_db
    } else {
        s.bands[band]
    }
}

fn change(app: &mut App, band: usize, v: f32, save: bool) {
    let hi = if band == 10 { 0.0 } else { 12.0 };
    let v = (v * 2.0).round().clamp(-24.0, hi * 2.0) / 2.0;
    if band == 10 {
        app.tweaks.equalizer.preamp_db = v;
    } else {
        app.tweaks.equalizer.bands[band] = v;
    }
    if save {
        app.set_tweaks(|_| {});
    }
}

fn slider(app: &App, t: &Theme, band: usize, label: &str) -> El {
    let v = value(app, band);
    let hi = if band == 10 { 0.0 } else { 12.0 };
    let fraction = (v + 12.0) / (hi + 12.0);
    let track = el()
        .pin(Some(0.0), Some(10.0), Some(0.0), None)
        .h(4.0)
        .radius(4.0)
        .fill(t.c.muted)
        .child(
            el().pin(Some(0.0), Some(0.0), None, Some(0.0))
                .w_frac(fraction)
                .radius(4.0)
                .fill(t.c.primary)
                .inert(),
        );
    let thumb = el()
        .pin(Some(0.0), Some(0.0), None, Some(0.0))
        .w_frac(fraction)
        .items_center()
        .justify_end()
        .inert()
        .child(
            el().size(10.0, 10.0)
                .mr(-5.0)
                .radius(8.0)
                .fill(t.c.primary)
                .inert(),
        );
    let control = el()
        .key(format!("eq-band-{band}"))
        .grow(1.0)
        .min_w(50.0)
        .h(24.0)
        .cursor(Cursor::Pointer)
        .focusable(true)
        .role("slider")
        .label(format!("{label} gain in decibels"))
        .range_value(v as f64, -12.0, hi as f64)
        .help("Drag to adjust. Arrow keys: 0.5 dB. Home/End: minimum/maximum.")
        .hover(t.c.foreground.alpha(0.05))
        .radius(4.0)
        .on_step(move |app: &mut App, delta: i32, _: &mut rune::Tx| {
            change(app, band, value(app, band) + delta as f32 * 0.5, true)
        })
        .on_step_limit(move |app: &mut App, max: bool, _: &mut rune::Tx| {
            change(app, band, if max { hi } else { -12.0 }, true)
        })
        .on_drag(move |app: &mut App, d: &mut rune::Drag, _: &mut rune::Tx| {
            let at = if d.w > 0.0 {
                (d.x / d.w).clamp(0.0, 1.0)
            } else {
                0.5
            };
            match d.phase {
                rune::Phase::Down => {
                    app.overlays.settings.eq_drag = Some((band, value(app, band)));
                    change(app, band, -12.0 + at * (hi + 12.0), false);
                }
                rune::Phase::Move => change(app, band, -12.0 + at * (hi + 12.0), false),
                rune::Phase::Up => {
                    let original = app
                        .overlays
                        .settings
                        .eq_drag
                        .take()
                        .filter(|(b, _)| *b == band)
                        .map(|(_, v)| v);
                    let v = if d.cancelled() {
                        original.unwrap_or_else(|| value(app, band))
                    } else {
                        -12.0 + at * (hi + 12.0)
                    };
                    change(app, band, v, true);
                }
            }
        })
        .child(track)
        .child(thumb);
    row()
        .w_full()
        .h(26.0)
        .gap(12.0)
        .items_center()
        .child(line(label, font(12.0, 400.0), t.c.foreground).w(56.0))
        .child(control)
        .child(
            line(
                format!("{v:+.1} dB"),
                font(12.0, 400.0),
                t.c.muted_foreground,
            )
            .w(60.0),
        )
}

pub fn settings<'a>(app: &'a App, t: &'a Theme) -> Vec<SettingDef<'a>> {
    vec![SettingDef {
        keywords: "equalizer eq sound bass treble frequency bands preset preamp audio",
        rows: vec![Box::new(move |_| {
            let s = app.tweaks.equalizer.sanitized();
            let toggle = switch(t, "eq-enabled", s.enabled, false, |a| {
                a.set_tweaks(|tw| tw.equalizer.enabled = !tw.equalizer.enabled)
            })
            .label("Enable equalizer");
            let mut options: Vec<_> = PRESETS
                .iter()
                .map(|(n, _)| SelectOption::new(*n, *n))
                .collect();
            if s.preset() == "Custom" {
                options.push(SelectOption {
                    disabled: true,
                    ..SelectOption::new("Custom", "Custom")
                });
            }
            let presets = select(
                app,
                t,
                "eq-preset",
                options,
                s.preset(),
                false,
                |a, name| {
                    if let Some((_, bands)) = PRESETS.iter().find(|(n, _)| *n == name) {
                        a.set_tweaks(|tw| tw.equalizer.bands = *bands);
                    }
                },
            )
            .label("Equalizer preset");
            let mut panel = col()
                .w_full()
                .gap(6.0)
                .pt(8.0)
                .child(
                    row()
                        .w_full()
                        .h(28.0)
                        .items_center()
                        .justify_between()
                        .child(line("Enable equalizer", font(14.0, 500.0), t.c.foreground))
                        .child(toggle),
                )
                .child(
                    text(if s.enabled {
                        "Applies to audio on this device. Saved automatically."
                    } else {
                        "Off — original sound. Turn on to hear your adjustments."
                    })
                    .font(font(12.0, 400.0))
                    .color(t.c.muted_foreground)
                    .wrap(),
                )
                .child(
                    row()
                        .w_full()
                        .h(30.0)
                        .items_center()
                        .justify_between()
                        .child(line("Preset", font(14.0, 400.0), t.c.foreground))
                        .child(presets),
                );
            let mut bands = col().key("eq-bands").w_full().gap(0.0);
            for (i, label) in LABELS.iter().enumerate() {
                bands = bands.child(slider(app, t, i, label));
            }
            panel = panel.child(bands).child(slider(app, t, 10, "Preamp"))
            .child(text(format!("Automatic headroom: −{:.1} dB. Boosts lower the overall level to leave room for peaks.", s.headroom_db())).font(font(12.0, 400.0)).color(t.c.muted_foreground).wrap())
            .child(Btn::new("eq-reset", "Reset to flat").build(t).on_press(|a: &mut App| {
                a.set_tweaks(|tw| { tw.equalizer.bands = [0.0; 10]; tw.equalizer.preamp_db = 0.0; });
            }));
            panel
        })],
    }]
}
