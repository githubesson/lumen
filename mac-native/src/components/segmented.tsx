import { StyleSheet, View } from 'react-native';
import { SegmentedControl } from '../native/controls';

/**
 * Thin wrapper over AppKit's `NSSegmentedControl`, kept so call sites keep the
 * same shape they had when this was hand-drawn.
 */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  width,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
  width?: number;
}) {
  return (
    <View style={[styles.host, width != null ? { width } : null]}>
      <SegmentedControl
        options={options}
        value={value}
        onChange={onChange}
        style={styles.control}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  // AppKit reports an intrinsic size that Yoga does not read, so the host gives
  // the control a concrete box to fill.
  host: { height: 24, minWidth: 180 },
  control: { flex: 1 },
});
