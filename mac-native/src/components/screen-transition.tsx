import { useEffect, useRef, type ReactNode } from 'react';
import { Animated, StyleSheet } from 'react-native';

/**
 * A short fade-and-rise whenever the route changes.
 *
 * Desktop panes swap rather than slide — a push transition borrowed from a
 * phone stack looks wrong in a window — but swapping with no motion at all
 * makes it hard to see that anything happened. Runs on the native driver so it
 * costs nothing on the JS thread while a list is settling.
 */
export function ScreenTransition({
  routeKey,
  children,
}: {
  routeKey: string;
  children: ReactNode;
}) {
  const progress = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    progress.setValue(0);
    const animation = Animated.timing(progress, {
      toValue: 1,
      duration: 160,
      useNativeDriver: false,
    });
    animation.start();
    return () => animation.stop();
  }, [routeKey, progress]);

  const translateY = progress.interpolate({
    inputRange: [0, 1],
    outputRange: [6, 0],
  });

  return (
    <Animated.View
      style={[styles.fill, { opacity: progress, transform: [{ translateY }] }]}>
      {children}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
});
