import { View, type TextStyle } from "react-native";
import Animated, {
  FadeInDown,
  useAnimatedStyle,
  type SharedValue,
} from "react-native-reanimated";

/** Seconds between waves rippling through the letters. */
const WAVE_EVERY = 4.2;
/** Seconds each letter spends in the air. */
const HOP = 0.32;
/** Seconds between neighboring letters taking off. */
const HOP_STAGGER = 0.07;

/**
 * A word whose letters drop in one by one on mount, then periodically hop in
 * a left-to-right wave. Read as one header by VoiceOver.
 */
export function BouncingTitle({
  text,
  clock,
  style,
}: {
  text: string;
  clock: SharedValue<number>;
  style: TextStyle;
}) {
  const letters = Array.from(text);
  return (
    <View
      accessible
      accessibilityRole="header"
      accessibilityLabel={text}
      style={{ flexDirection: "row" }}
    >
      {letters.map((letter, index) => (
        <Animated.View
          key={index}
          entering={FadeInDown.delay(150 + index * 60)
            .springify()
            .damping(11)}
        >
          <HoppingLetter
            letter={letter}
            index={index}
            clock={clock}
            style={style}
          />
        </Animated.View>
      ))}
    </View>
  );
}

function HoppingLetter({
  letter,
  index,
  clock,
  style,
}: {
  letter: string;
  index: number;
  clock: SharedValue<number>;
  style: TextStyle;
}) {
  const animatedStyle = useAnimatedStyle(() => {
    // The first wave lands after the drop-in settles.
    const local = ((clock.value + WAVE_EVERY - 1.6) % WAVE_EVERY) - index * HOP_STAGGER;
    const hop = local > 0 && local < HOP ? Math.sin((Math.PI * local) / HOP) : 0;
    return { transform: [{ translateY: -7 * hop }] };
  });
  return <Animated.Text style={[style, animatedStyle]}>{letter}</Animated.Text>;
}
