import { forwardRef, useImperativeHandle, useRef } from 'react';
import {
  UIManager,
  findNodeHandle,
  requireNativeComponent,
  type NativeSyntheticEvent,
  type ViewProps,
} from 'react-native';

/* ------------------------------------------------------------- search --- */

interface NativeSearchProps extends ViewProps {
  value?: string;
  placeholder?: string;
  onSearchChange?: (e: NativeSyntheticEvent<{ text: string }>) => void;
  onSearchSubmit?: (e: NativeSyntheticEvent<{ text: string }>) => void;
}

const NativeSearchField = requireNativeComponent<NativeSearchProps>('LMSearchField');

export interface SearchFieldHandle {
  focus: () => void;
}

export interface SearchFieldProps extends Omit<ViewProps, 'children'> {
  value: string;
  onChangeText: (text: string) => void;
  placeholder?: string;
  onSubmit?: (text: string) => void;
}

/**
 * AppKit's `NSSearchField` — the real one, with the system magnifier, clear
 * button, focus ring and Liquid Glass treatment on macOS 26.
 */
export const SearchField = forwardRef<SearchFieldHandle, SearchFieldProps>(
  function SearchField({ value, onChangeText, onSubmit, ...rest }, ref) {
    const nativeRef = useRef(null);

    useImperativeHandle(ref, () => ({
      focus() {
        const tag = findNodeHandle(nativeRef.current);
        if (tag == null) return;
        // Focus goes through the view manager: AppKit first-responder status is
        // not something a JS ref can set.
        UIManager.dispatchViewManagerCommand(tag, 'focus', [tag]);
      },
    }));

    return (
      <NativeSearchField
        ref={nativeRef}
        value={value}
        onSearchChange={e => onChangeText(e.nativeEvent.text)}
        onSearchSubmit={e => onSubmit?.(e.nativeEvent.text)}
        {...rest}
      />
    );
  },
);

/* ---------------------------------------------------------- segmented --- */

interface NativeSegmentedProps extends ViewProps {
  labels?: string[];
  selectedIndex?: number;
  onSegmentChange?: (e: NativeSyntheticEvent<{ index: number }>) => void;
}

const NativeSegmentedControl =
  requireNativeComponent<NativeSegmentedProps>('LMSegmentedControl');

export interface SegmentedControlProps<T extends string>
  extends Omit<ViewProps, 'children'> {
  options: { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
}

/** AppKit's `NSSegmentedControl`. */
export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  ...rest
}: SegmentedControlProps<T>) {
  const selectedIndex = Math.max(
    0,
    options.findIndex(option => option.value === value),
  );
  return (
    <NativeSegmentedControl
      labels={options.map(option => option.label)}
      selectedIndex={selectedIndex}
      onSegmentChange={e => {
        const next = options[e.nativeEvent.index];
        if (next) onChange(next.value);
      }}
      {...rest}
    />
  );
}

/* ------------------------------------------------------------- button --- */

interface NativeButtonProps extends ViewProps {
  title?: string;
  buttonStyle?: 'normal' | 'prominent' | 'destructive' | 'plain';
  enabled?: boolean;
  symbolName?: string;
  onButtonPress?: () => void;
}

const NativeButton = requireNativeComponent<NativeButtonProps>('LMButton');

export interface NativePushButtonProps extends Omit<ViewProps, 'children'> {
  title: string;
  variant?: 'normal' | 'prominent' | 'destructive' | 'plain';
  disabled?: boolean;
  symbol?: string;
  onPress: () => void;
}

/**
 * AppKit's `NSButton`. Prominent buttons get the accent fill and the default
 * button's Return key equivalent for free.
 */
export function NativeButtonView({
  title,
  variant = 'normal',
  disabled = false,
  symbol,
  onPress,
  ...rest
}: NativePushButtonProps) {
  return (
    <NativeButton
      title={title}
      buttonStyle={variant}
      enabled={!disabled}
      symbolName={symbol ?? ''}
      onButtonPress={onPress}
      {...rest}
    />
  );
}
