import { StyleSheet, type StyleProp, type ViewStyle } from "react-native";
import Animated, {
  interpolate,
  useAnimatedStyle,
  type SharedValue,
} from "react-native-reanimated";
import { SymbolView } from "expo-symbols";

const MARK_SIZE = 12;

/**
 * The small pink heart a favorite carries outside the Favorites list, before
 * the row's trailing detail: favorites are the exception there, so they're
 * the ones marked. `pop` runs 0 to 1 as it drops in after a swipe and rests
 * at 1. VoiceOver hears it through the row's accessibility value instead.
 */
export function FavoriteMark({
  pop,
  color,
  style,
}: {
  pop: SharedValue<number>;
  color: string;
  style?: StyleProp<ViewStyle>;
}) {
  const popStyle = useAnimatedStyle(() => {
    const p = pop.get();
    return {
      opacity: interpolate(p, [0, 0.6, 1], [0, 1, 1]),
      transform: [
        { translateY: interpolate(p, [0, 0.6, 1], [-12, 1, 0]) },
        { scale: interpolate(p, [0, 0.6, 1], [1.9, 0.9, 1]) },
      ],
    };
  });
  return (
    <Animated.View
      accessible={false}
      importantForAccessibility="no-hide-descendants"
      style={[styles.mark, style, popStyle]}
    >
      <SymbolView
        name="heart.fill"
        size={MARK_SIZE}
        tintColor={color}
        style={styles.icon}
      />
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  mark: {
    marginRight: 7,
    // The mock sets it a hair under the text's centre line.
    marginTop: 1,
  },
  icon: {
    width: MARK_SIZE,
    height: MARK_SIZE,
  },
});
