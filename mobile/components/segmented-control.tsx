import { useCallback } from "react";
import NativeSegmentedControl from "@react-native-segmented-control/segmented-control";

interface Option<T extends string> {
  label: string;
  value: T;
}

interface Props<T extends string> {
  options: Option<T>[];
  value: T;
  onChange: (v: T) => void;
}

/**
 * Typed wrapper around the native iOS `UISegmentedControl`. The native
 * control brings free haptics, dark-mode adaptation, iOS 15+ styling, and
 * animated selection. Kept the generic string-value API from the old custom
 * version so callers don't have to change.
 */
export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
}: Props<T>) {
  const values = options.map((o) => o.label);
  const selectedIndex = Math.max(
    0,
    options.findIndex((o) => o.value === value),
  );
  const handleChange = useCallback(
    (e: { nativeEvent: { selectedSegmentIndex: number } }) => {
      const next = options[e.nativeEvent.selectedSegmentIndex];
      if (next) onChange(next.value);
    },
    [options, onChange],
  );

  return (
    <NativeSegmentedControl
      values={values}
      selectedIndex={selectedIndex}
      onChange={handleChange}
    />
  );
}
