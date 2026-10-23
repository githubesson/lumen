import { useEffect } from "react";
import { StyleSheet, type StyleProp, type ViewStyle } from "react-native";
import {
  BlurMask,
  Canvas,
  Group,
  Path,
  Skia,
  type SkPath,
  type SkSize,
} from "@shopify/react-native-skia";
import {
  cancelAnimation,
  Easing,
  ReduceMotion,
  useDerivedValue,
  useSharedValue,
  withDelay,
  withTiming,
  type SharedValue,
} from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import {
  COMET_TAIL_MS,
  cometHead,
  cometOpacity,
  cometOutline,
  cometPerimeter,
  cometRingOpacity,
  cometRingStart,
  cometTrim,
  type CometOutlineInset,
} from "../../lib/swipe-actions";
import { withAlpha } from "../../theme/theme";

/**
 * The comet's layers: dashes of one rounded-rect outline that all end at the
 * head, widest and softest at the tail, white-hot at the head. Lengths and
 * opacities are the mock's; widths and blurs are a little tighter so the
 * glow stays inside the row, which can't draw over its neighbours.
 */
const LAYERS = [
  { key: "halo", width: 8, length: 240, opacity: 0.3, blur: 3.5, tone: "color" },
  { key: "tail", width: 4, length: 200, opacity: 0.34, blur: 2, tone: "color" },
  { key: "body", width: 2.4, length: 130, opacity: 0.6, blur: 0.8, tone: "color" },
  { key: "neck", width: 2.2, length: 60, opacity: 0.95, blur: 0.4, tone: "hot" },
  { key: "head", width: 5, length: 10, opacity: 0.95, blur: 2.5, tone: "white" },
] as const;
const LONGEST = LAYERS[0].length;

/** The reduced-motion stand-in: the outline glows once, in place. */
const STATIC_GLOW = { in: 160, hold: 260, out: 420 } as const;

/** `color` mixed 60% toward white, for the comet's bright neck. */
function hotTone(color: string): string {
  const match = /^#([0-9a-f]{6})$/i.exec(color);
  if (!match) return "#FFFFFF";
  const n = Number.parseInt(match[1], 16);
  const mix = (c: number) => Math.round(c + (255 - c) * 0.6);
  const r = mix((n >> 16) & 255);
  const g = mix((n >> 8) & 255);
  const b = mix(n & 255);
  return `rgb(${r}, ${g}, ${b})`;
}

/**
 * One lap of a comet in `color` around `box`'s rounded outline, clockwise
 * from the side the swipe came from; the outline breathes once as the loop
 * closes, then it all fades. Mount it for the animation only (keyed per run)
 * and unmount it on `onDone`: idle rows carry no canvas. Under reduced
 * motion the outline just glows once. On a light background a white-hot
 * head would vanish, so there the head and neck keep the colour.
 */
export function CometGlow({
  outline,
  from,
  color,
  lapMs,
  delayMs = 0,
  reducedMotion,
  onLight = false,
  onDone,
  style,
}: {
  /** Where the outline sits inside the canvas, which fills `style`. */
  outline: CometOutlineInset;
  from: "left" | "right";
  color: string;
  lapMs: number;
  delayMs?: number;
  reducedMotion: boolean;
  onLight?: boolean;
  onDone: () => void;
  style?: StyleProp<ViewStyle>;
}) {
  // The outline follows the canvas's own size, on the UI thread: nothing on
  // the JS side has to know how wide the row is.
  const size = useSharedValue<SkSize>({ width: 0, height: 0 });
  const box = useDerivedValue(() => {
    const { width, height } = size.get();
    return {
      x: outline.insetX,
      y: outline.insetY,
      width: Math.max(0, width - outline.insetX * 2),
      height: Math.max(0, height - outline.insetY * 2),
      radius: outline.radius,
    };
  });
  const path = useDerivedValue<SkPath>(() => {
    const b = box.get();
    if (b.width <= 0 || b.height <= 0) return Skia.Path.Make();
    return Skia.Path.MakeFromSVGString(cometOutline(b, from)) ?? Skia.Path.Make();
  });
  const perimeter = useDerivedValue(() => cometPerimeter(box.get()));
  const totalMs = reducedMotion
    ? STATIC_GLOW.in + STATIC_GLOW.hold + STATIC_GLOW.out
    : lapMs + COMET_TAIL_MS;
  const clock = useSharedValue(0);

  useEffect(() => {
    // Driven by hand below, reduced motion included: the delay must hold
    // under Reduce Motion too, or the glow would start early.
    clock.set(
      withDelay(
        delayMs,
        withTiming(
          totalMs,
          { duration: totalMs, easing: Easing.linear, reduceMotion: ReduceMotion.Never },
          (finished) => {
            if (finished) scheduleOnRN(onDone);
          },
        ),
        ReduceMotion.Never,
      ),
    );
    // Unmounted early (a new run, a recycled row): no late onDone.
    return () => cancelAnimation(clock);
    // One run per mount: the parent keys it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const lap = useDerivedValue(() => Math.min(1, clock.get() / lapMs));
  const groupOpacity = useDerivedValue(() => {
    if (!reducedMotion) return cometOpacity(lap.get());
    const t = clock.get();
    if (t <= 0) return 0;
    if (t < STATIC_GLOW.in) return t / STATIC_GLOW.in;
    if (t < STATIC_GLOW.in + STATIC_GLOW.hold) return 1;
    return Math.max(0, 1 - (t - STATIC_GLOW.in - STATIC_GLOW.hold) / STATIC_GLOW.out);
  });
  const ringOpacity = useDerivedValue(() =>
    reducedMotion
      ? 0.6
      : cometRingOpacity(clock.get() - cometRingStart(perimeter.get(), LONGEST) * lapMs),
  );
  const head = useDerivedValue(() => cometHead(lap.get(), perimeter.get(), LONGEST));
  const hot = onLight ? color : hotTone(color);
  const white = onLight ? color : "#FFFFFF";

  return (
    <Canvas pointerEvents="none" onSize={size} style={style ?? StyleSheet.absoluteFill}>
      <Group opacity={groupOpacity}>
        {reducedMotion ? (
          <Path
            path={path}
            style="stroke"
            strokeWidth={6}
            color={withAlpha(color, 0.35)}
          >
            <BlurMask blur={3} style="normal" />
          </Path>
        ) : null}
        <Path
          path={path}
          style="stroke"
          strokeWidth={1.6}
          color={color}
          opacity={ringOpacity}
        >
          <BlurMask blur={0.6} style="normal" />
        </Path>
        {reducedMotion
          ? null
          : LAYERS.map((layer) => (
              <CometLayer
                key={layer.key}
                path={path}
                head={head}
                perimeter={perimeter}
                length={layer.length}
                width={layer.width}
                opacity={layer.opacity}
                blur={layer.blur}
                color={layer.tone === "color" ? color : layer.tone === "hot" ? hot : white}
              />
            ))}
      </Group>
    </Canvas>
  );
}

function CometLayer({
  path,
  head,
  perimeter,
  length,
  width,
  opacity,
  blur,
  color,
}: {
  path: SharedValue<SkPath>;
  head: SharedValue<number>;
  perimeter: SharedValue<number>;
  length: number;
  width: number;
  opacity: number;
  blur: number;
  color: string;
}) {
  const start = useDerivedValue(() => cometTrim(head.get(), length, perimeter.get())[0]);
  const end = useDerivedValue(() => cometTrim(head.get(), length, perimeter.get())[1]);
  return (
    <Path
      path={path}
      style="stroke"
      strokeWidth={width}
      strokeCap="round"
      color={color}
      opacity={opacity}
      start={start}
      end={end}
    >
      <BlurMask blur={blur} style="normal" />
    </Path>
  );
}
