import { requireNativeComponent, type NativeSyntheticEvent, type ViewProps } from 'react-native';

interface ChangeEvent {
  text: string;
}

interface FocusEvent {
  focused: boolean;
}

interface NativeProps extends ViewProps {
  value?: string;
  placeholder?: string;
  fontSize?: number;
  textColor?: string;
  editable?: boolean;
  onChangeText?: (e: NativeSyntheticEvent<ChangeEvent>) => void;
  onSubmit?: (e: NativeSyntheticEvent<ChangeEvent>) => void;
  onFocusChange?: (e: NativeSyntheticEvent<FocusEvent>) => void;
}

const NativeSecureField = requireNativeComponent<NativeProps>('LMSecureField');

export interface SecureFieldProps extends Omit<ViewProps, 'children'> {
  value: string;
  onChangeText: (text: string) => void;
  placeholder?: string;
  fontSize?: number;
  textColor?: string;
  editable?: boolean;
  onSubmitEditing?: () => void;
  onFocusChange?: (focused: boolean) => void;
}

/**
 * Password input backed by AppKit's `NSSecureTextField`.
 *
 * React Native's `<TextInput secureTextEntry>` is unusable on
 * react-native-macos: it swaps in a secure backing control that stops emitting
 * change and focus events, so typed characters render but never reach React
 * state. See `macos/LumenNative/Sources/LMSecureField.swift`.
 */
export function SecureField({
  value,
  onChangeText,
  onSubmitEditing,
  onFocusChange,
  ...rest
}: SecureFieldProps) {
  return (
    <NativeSecureField
      value={value}
      onChangeText={e => onChangeText(e.nativeEvent.text)}
      onSubmit={() => onSubmitEditing?.()}
      onFocusChange={e => onFocusChange?.(e.nativeEvent.focused)}
      {...rest}
    />
  );
}
