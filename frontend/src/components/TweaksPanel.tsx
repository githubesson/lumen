import { useRef } from "react";
import { useTheme, type Density, type Layout, type Theme } from "../context/Theme";
import { useAudioOutput } from "../lib/audioOutput";
import { useDismiss } from "../lib/useDismiss";

interface Props {
  open: boolean;
  onClose: () => void;
}

const RADII = [0, 4, 6, 10, 14, 20];
const DENSITIES: Density[] = ["airy", "balanced", "dense"];
const LAYOUTS: Layout[] = ["compact", "sidebar", "wide"];
const THEMES: Theme[] = ["light", "dark"];

export default function TweaksPanel({ open, onClose }: Props) {
  const {
    theme,
    depth,
    radius,
    density,
    layout,
    glow,
    setTheme,
    setDepth,
    setRadius,
    setDensity,
    setLayout,
    setGlow,
  } = useTheme();
  const audioOut = useAudioOutput();
  const ref = useRef<HTMLDivElement>(null);

  useDismiss(ref, {
    onDismiss: onClose,
    enabled: open,
    // The trigger button toggles the panel itself — don't treat it as outside.
    ignore: (target) =>
      !!(target as HTMLElement).closest?.("[data-tweaks-trigger]"),
  });

  if (!open) return null;

  return (
    <div ref={ref} className="tweaks" role="dialog" aria-label="Tweaks">
      <div className="tweaks-title">
        <span>Tweaks</span>
        <span className="mono">live</span>
      </div>

      <div className="tweak-row">
        <div className="tweak-label">
          <span>Theme</span>
          <span>{theme}</span>
        </div>
        <div className="tweak-seg">
          {THEMES.map((t) => (
            <button
              key={t}
              type="button"
              className={theme === t ? "active" : ""}
              onClick={() => setTheme(t)}
            >
              {t}
            </button>
          ))}
        </div>
      </div>

      <div className="tweak-row">
        <div className="tweak-label">
          <span>Depth intensity</span>
          <span>{depth}</span>
        </div>
        <input
          className="tweak-slider"
          type="range"
          min={0}
          max={4}
          step={1}
          value={depth}
          onChange={(e) => setDepth(+e.target.value)}
          aria-label="Depth intensity"
        />
        <div
          className="mono"
          style={{
            fontSize: 10,
            display: "flex",
            justifyContent: "space-between",
            color: "var(--fg-subtle)",
          }}
        >
          <span>flat</span>
          <span>heavy</span>
        </div>
      </div>

      <div className="tweak-row">
        <div className="tweak-label">
          <span>Corner radius</span>
          <span>{radius}px</span>
        </div>
        <div className="tweak-seg">
          {RADII.map((r) => (
            <button
              key={r}
              type="button"
              className={radius === r ? "active" : ""}
              onClick={() => setRadius(r)}
            >
              {r}
            </button>
          ))}
        </div>
      </div>

      <div className="tweak-row">
        <div className="tweak-label">
          <span>Density</span>
          <span>{density}</span>
        </div>
        <div className="tweak-seg">
          {DENSITIES.map((d) => (
            <button
              key={d}
              type="button"
              className={density === d ? "active" : ""}
              onClick={() => setDensity(d)}
            >
              {d}
            </button>
          ))}
        </div>
      </div>

      <div className="tweak-row">
        <div className="tweak-label">
          <span>Layout</span>
          <span>{layout}</span>
        </div>
        <div className="tweak-seg">
          {LAYOUTS.map((l) => (
            <button
              key={l}
              type="button"
              className={layout === l ? "active" : ""}
              onClick={() => setLayout(l)}
            >
              {l}
            </button>
          ))}
        </div>
      </div>

      <div className="tweak-row">
        <div className="tweak-label">
          <span>Ambient glow</span>
          <span>{glow ? "on" : "off"}</span>
        </div>
        <div className="tweak-seg">
          <button
            type="button"
            className={glow ? "active" : ""}
            onClick={() => setGlow(true)}
          >
            on
          </button>
          <button
            type="button"
            className={!glow ? "active" : ""}
            onClick={() => setGlow(false)}
          >
            off
          </button>
        </div>
      </div>

      {audioOut.supported && (
        <div className="tweak-row">
          <div className="tweak-label">
            <span>Output device</span>
            <span>{audioOut.devices.length || "—"}</span>
          </div>
          <select
            className="tweak-select"
            value={audioOut.deviceId}
            onChange={(e) => void audioOut.selectDevice(e.target.value)}
            onFocus={() => void audioOut.refresh()}
            aria-label="Audio output device"
          >
            <option value="">System default</option>
            {audioOut.devices
              .filter((d) => d.deviceId && d.deviceId !== "default")
              .map((d) => (
                <option key={d.deviceId} value={d.deviceId}>
                  {d.label}
                </option>
              ))}
          </select>
          {audioOut.error && (
            <div
              className="mono"
              style={{ fontSize: 10, color: "var(--fg-subtle)" }}
            >
              {audioOut.error}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
