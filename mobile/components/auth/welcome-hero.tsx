import { useEffect, useState } from "react";
import {
  Image as NativeImage,
  PixelRatio,
  StyleSheet,
  useWindowDimensions,
  View,
} from "react-native";
import { Image } from "expo-image";
import Animated, { FadeIn } from "react-native-reanimated";
import {
  Canvas,
  Fill,
  ImageShader,
  Shader,
  Skia,
  type SkImage,
  type SkRuntimeEffect,
} from "@shopify/react-native-skia";
import {
  WELCOME_MESH_SHADER,
  loadWelcomeArt,
  welcomeArtRect,
  welcomeFadeHeight,
  welcomeMesh,
} from "../../lib/welcome-mesh";
import { useTheme, withAlpha } from "../../theme/theme";
import { WELCOME_MORNING, WELCOME_NIGHT } from "./welcome-art";

const ENTER = FadeIn.duration(400);
/** How much light is left in the lines between cells, per scheme. */
const LINE_LIGHT = { dark: 0.6, light: 0.88 } as const;

let meshEffect: SkRuntimeEffect | null | undefined;

/** The compiled mesh, or null if this device's Skia refuses it. */
function getMeshEffect(): SkRuntimeEffect | null {
  if (meshEffect === undefined) {
    try {
      meshEffect = Skia.RuntimeEffect.Make(WELCOME_MESH_SHADER);
    } catch {
      meshEffect = null;
    }
  }
  return meshEffect;
}

/** The decoded art for Skia: null while loading, and `failed` if it never will. */
function useWelcomeArt(source: number): { art: SkImage | null; failed: boolean } {
  const [state, setState] = useState<{ art: SkImage | null; failed: boolean }>({
    art: null,
    failed: false,
  });
  useEffect(() => {
    let live = true;
    void loadWelcomeArt(NativeImage.resolveAssetSource(source).uri, Skia).then((art) => {
      if (live) setState({ art, failed: art === null });
    });
    return () => {
      live = false;
    };
  }, [source]);
  return state;
}

/**
 * The welcome screen's scene: a record sliding out of its sleeve among the
 * clouds, at night in dark mode and in the morning in light mode, drawn through
 * a pixel mesh and fading into the page. Without the mesh it's the plain image.
 */
export function WelcomeHero({ height }: { height: number }) {
  const theme = useTheme();
  const { width } = useWindowDimensions();
  const source = theme.scheme === "dark" ? WELCOME_NIGHT : WELCOME_MORNING;
  const { art, failed } = useWelcomeArt(source);
  const effect = getMeshEffect();
  const view = { width, height };
  const fadeColor = theme.color.bg;

  return (
    <View
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[styles.hero, view]}
    >
      {effect && !failed ? (
        art ? (
          <Animated.View entering={ENTER} style={StyleSheet.absoluteFill}>
            <Canvas style={view}>
              <Fill>
                <Shader
                  source={effect}
                  uniforms={{
                    density: PixelRatio.get(),
                    ...welcomeMesh(PixelRatio.get()),
                    lineLight: LINE_LIGHT[theme.scheme],
                  }}
                >
                  <ImageShader
                    image={art}
                    // Cells cut off by the screen's edge sample past the art.
                    tx="clamp"
                    ty="clamp"
                    fit="fill"
                    rect={welcomeArtRect(view, {
                      width: art.width(),
                      height: art.height(),
                    })}
                  />
                </Shader>
              </Fill>
            </Canvas>
          </Animated.View>
        ) : null
      ) : (
        <Animated.View entering={ENTER} style={StyleSheet.absoluteFill}>
          <Image
            source={source}
            style={view}
            contentFit="cover"
            contentPosition="top center"
          />
        </Animated.View>
      )}
      <View
        style={[
          styles.fade,
          {
            height: welcomeFadeHeight(height),
            experimental_backgroundImage: `linear-gradient(to bottom, ${withAlpha(fadeColor, 0)} 0%, ${fadeColor} 100%)`,
          },
        ]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  hero: {
    position: "absolute",
    top: 0,
    left: 0,
  },
  fade: {
    position: "absolute",
    left: 0,
    right: 0,
    // One point past the edge, so no row of the mesh survives under the text.
    bottom: -1,
  },
});
