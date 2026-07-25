import { forwardRef, useState, type ReactNode } from 'react';
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  TextInput,
  View,
  type TextInputProps,
  type TextProps,
} from 'react-native';
import { useTheme } from '../theme/theme';
import { SecureField } from '../native/secure-field';
import { NativeButtonView } from '../native/controls';
import { useHover } from './hoverable';

/* ---------------------------------------------------------------- text --- */

const textStyles = StyleSheet.create({
  title: { fontSize: 28, fontWeight: '700', letterSpacing: -0.4 },
  heading: { fontSize: 17, fontWeight: '600' },
  body: { fontSize: 13 },
  label: { fontSize: 13, fontWeight: '500' },
  caption: { fontSize: 11 },
});

export type TextVariant = keyof typeof textStyles;

export interface AppTextProps extends TextProps {
  variant?: TextVariant;
  muted?: boolean;
  subtle?: boolean;
}

export function AppText({
  variant = 'body',
  muted,
  subtle,
  style,
  ...rest
}: AppTextProps) {
  const t = useTheme();
  const color = muted ? t.color.fgMuted : subtle ? t.color.fgSubtle : t.color.fg;
  return <Text style={[textStyles[variant], { color }, style]} {...rest} />;
}

/* -------------------------------------------------------------- button --- */

export interface ButtonProps {
  title: string;
  variant?: 'primary' | 'secondary' | 'plain' | 'danger';
  pending?: boolean;
  fullWidth?: boolean;
  symbol?: string;
  disabled?: boolean;
  onPress?: () => void;
}

const BUTTON_VARIANT = {
  primary: 'prominent',
  danger: 'destructive',
  secondary: 'normal',
  plain: 'plain',
} as const;

/**
 * AppKit's `NSButton`. Using the real control means the accent fill, pressed
 * and disabled states, focus ring and the macOS 26 glass treatment all come
 * from the system rather than being approximated.
 */
export function Button({
  title,
  variant = 'secondary',
  pending = false,
  fullWidth = false,
  symbol,
  disabled,
  onPress,
}: ButtonProps) {
  const isDisabled = disabled === true || pending;

  if (pending) {
    return (
      <View style={[buttonStyles.host, fullWidth ? buttonStyles.full : null]}>
        <ActivityIndicator size="small" />
      </View>
    );
  }

  return (
    <View style={[buttonStyles.host, fullWidth ? buttonStyles.full : null]}>
      <NativeButtonView
        title={title}
        variant={BUTTON_VARIANT[variant]}
        disabled={isDisabled}
        symbol={symbol}
        onPress={() => onPress?.()}
        style={buttonStyles.control}
      />
    </View>
  );
}

const buttonStyles = StyleSheet.create({
  // Yoga does not read AppKit's intrinsic size, so the host supplies the box.
  host: { height: 28, minWidth: 84, alignSelf: 'flex-start' },
  full: { alignSelf: 'stretch' },
  control: { flex: 1 },
});

/* --------------------------------------------------------------- field --- */

export interface FieldProps extends TextInputProps {
  label?: string;
  /**
   * Render an AppKit secure field instead of a `TextInput`. Not the same as
   * `secureTextEntry`, which is broken on react-native-macos — see
   * `src/native/secure-field.tsx`.
   */
  secure?: boolean;
}

/**
 * A text field with AppKit's focus ring suppressed in favour of an accent
 * border, so fields keep the app's rounded geometry instead of picking up the
 * default square bezel.
 */
export const Field = forwardRef<TextInput, FieldProps>(function Field(
  { label, style, onFocus, onBlur, secure, ...rest },
  ref,
) {
  const t = useTheme();
  const { hovered, hoverProps } = useHover();
  const [focused, setFocused] = useState(false);

  const boxStyle = {
    color: t.color.fg,
    backgroundColor: t.color.bgElev1,
    borderRadius: t.radius.md,
    borderColor: focused
      ? t.color.accent
      : hovered
        ? t.color.fgMuted
        : t.color.separator,
  };

  if (secure) {
    return (
      <View style={fieldStyles.wrapper} {...hoverProps}>
        {label ? (
          <AppText variant="label" subtle>
            {label}
          </AppText>
        ) : null}
        <SecureField
          value={typeof rest.value === 'string' ? rest.value : ''}
          onChangeText={rest.onChangeText ?? (() => {})}
          onSubmitEditing={rest.onSubmitEditing as (() => void) | undefined}
          onFocusChange={setFocused}
          placeholder={rest.placeholder}
          editable={rest.editable !== false}
          fontSize={13}
          textColor={t.color.fg}
          style={[fieldStyles.secureBox, boxStyle]}
        />
      </View>
    );
  }

  return (
    <View style={fieldStyles.wrapper} {...hoverProps}>
      {label ? (
        <AppText variant="label" subtle>
          {label}
        </AppText>
      ) : null}
      <TextInput
        ref={ref}
        enableFocusRing={false}
        placeholderTextColor={t.color.fgMuted}
        style={[fieldStyles.input, boxStyle, style]}
        onFocus={e => {
          setFocused(true);
          onFocus?.(e);
        }}
        onBlur={e => {
          setFocused(false);
          onBlur?.(e);
        }}
        {...rest}
      />
    </View>
  );
});

const fieldStyles = StyleSheet.create({
  wrapper: { gap: 6 },
  input: {
    height: 34,
    paddingHorizontal: 10,
    fontSize: 13,
    borderWidth: 1,
  },
  // The AppKit field draws and insets its own text, so this only supplies the
  // chrome — no text styles, which a plain native view cannot accept.
  secureBox: { height: 34, borderWidth: 1 },
});

/* ---------------------------------------------------------------- misc --- */

export function Spinner({ label }: { label?: string }) {
  const t = useTheme();
  return (
    <View style={miscStyles.centered}>
      <ActivityIndicator color={t.color.fgMuted} />
      {label ? (
        <AppText variant="caption" muted>
          {label}
        </AppText>
      ) : null}
    </View>
  );
}

export function ErrorText({ children }: { children?: ReactNode }) {
  const t = useTheme();
  if (!children) return null;
  return <Text style={[textStyles.body, { color: t.color.danger }]}>{children}</Text>;
}

export function Separator() {
  const t = useTheme();
  return <View style={{ height: 1, backgroundColor: t.color.separator }} />;
}

export function EmptyState({ title, detail }: { title: string; detail?: string }) {
  return (
    <View style={miscStyles.centered}>
      <AppText variant="heading" muted>
        {title}
      </AppText>
      {detail ? (
        <AppText variant="body" muted style={miscStyles.centeredText}>
          {detail}
        </AppText>
      ) : null}
    </View>
  );
}

const miscStyles = StyleSheet.create({
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    padding: 24,
  },
  centeredText: { textAlign: 'center' },
});
