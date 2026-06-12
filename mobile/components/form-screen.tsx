import { type ReactNode } from "react";
import {
  KeyboardAvoidingView,
  ScrollView,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { useTheme } from "../theme/theme";

/**
 * Keyboard-aware scrollable shell shared by every form screen.
 * `centered` floats the content mid-screen (auth flows); `top` starts the
 * form under the header (metadata/admin forms).
 */
export function FormScreen({
  variant = "top",
  style,
  contentContainerStyle,
  children,
}: {
  variant?: "centered" | "top";
  style?: StyleProp<ViewStyle>;
  contentContainerStyle?: StyleProp<ViewStyle>;
  children: ReactNode;
}) {
  const theme = useTheme();
  const centered = variant === "centered";
  return (
    <KeyboardAvoidingView
      behavior={process.env.EXPO_OS === "ios" ? "padding" : undefined}
      style={[{ flex: 1, backgroundColor: theme.color.bg }, style]}
    >
      <ScrollView
        style={{ flex: 1 }}
        contentInsetAdjustmentBehavior={centered ? "automatic" : "never"}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={[
          centered
            ? {
                flexGrow: 1,
                justifyContent: "center",
                paddingHorizontal: theme.space.xl,
                gap: theme.space.lg,
              }
            : {
                paddingHorizontal: theme.space.lg,
                paddingTop: theme.space.lg,
                paddingBottom: theme.space.xl * 2,
                gap: theme.space.lg,
              },
          contentContainerStyle,
        ]}
      >
        {children}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
