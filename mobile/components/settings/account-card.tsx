import { useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { SymbolView } from "expo-symbols";
import { useAuth } from "@music-library/core";
import {
  getOptionalSwiftUI,
  swiftAccessibilityLabel,
  swiftButtonStyle,
  swiftControlSize,
  swiftDisabled,
} from "../optional-swift-ui";
import { SETTINGS_INSET, SettingsCard } from "./settings-card";
import { showActionMenu } from "../../lib/action-menu";
import { accountInitials, roleLabel } from "../../lib/settings/account";
import { useTheme } from "../../theme/theme";

const AVATAR = 44;
const MORE = 32;
/** The ••• button's touch target; the visible circle sits inside it. */
const MORE_TARGET = 44;

/**
 * The account the app is signed in to: avatar, username and role. Sign out
 * lives in the ••• menu, so it stays with the account it signs out of and
 * takes a second, deliberate tap.
 */
export function AccountCard() {
  const theme = useTheme();
  const { me, logout } = useAuth();
  const [signingOut, setSigningOut] = useState(false);
  const swiftUI = getOptionalSwiftUI();

  const onSignOut = async () => {
    if (signingOut) return;
    setSigningOut(true);
    try {
      // `api.logout()` clears the backend session; the auth provider's
      // sign-out hook in the root layout clears the native cookie jar.
      await logout();
    } finally {
      setSigningOut(false);
    }
  };

  const username = me?.username ?? "—";
  const role = roleLabel(me?.role);

  const moreButton = (
    <View style={styles.moreTarget}>
      <View style={[styles.more, { backgroundColor: theme.color.bgElev2 }]}>
        {signingOut ? (
          <ActivityIndicator size="small" color={theme.color.fgMuted} />
        ) : (
          <SymbolView
            name="ellipsis"
            size={16}
            weight="semibold"
            tintColor={theme.color.fg}
          />
        )}
      </View>
    </View>
  );

  return (
    <SettingsCard>
      <View style={styles.row}>
        <View
          accessible
          accessibilityLabel={`Signed in as ${username}${role ? `, ${role}` : ""}`}
          style={styles.who}
        >
          <View
            style={[
              styles.avatar,
              {
                experimental_backgroundImage: `linear-gradient(140deg, #B47CFF 0%, ${theme.color.brand} 45%, #5B2BD9 100%)`,
              },
            ]}
          >
            <Text style={styles.initials}>{accountInitials(me?.username)}</Text>
          </View>
          <View style={{ flex: 1, gap: 1 }}>
            <Text
              numberOfLines={1}
              style={{ color: theme.color.fg, fontSize: 17, fontWeight: "600" }}
            >
              {username}
            </Text>
            {role ? (
              <Text style={{ color: theme.color.fgMuted, fontSize: 13 }}>{role}</Text>
            ) : null}
          </View>
        </View>

        {swiftUI ? (
          <swiftUI.Host matchContents colorScheme={theme.scheme}>
            <swiftUI.Menu
              label={
                <swiftUI.RNHostView matchContents>{moreButton}</swiftUI.RNHostView>
              }
              modifiers={[
                swiftAccessibilityLabel("Account actions"),
                swiftButtonStyle("plain"),
                swiftControlSize("regular"),
                swiftDisabled(signingOut),
              ]}
            >
              <swiftUI.Button
                label="Sign Out"
                systemImage="rectangle.portrait.and.arrow.right"
                role="destructive"
                onPress={() => void onSignOut()}
              />
            </swiftUI.Menu>
          </swiftUI.Host>
        ) : (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Account actions"
            accessibilityState={{ disabled: signingOut, busy: signingOut }}
            disabled={signingOut}
            onPress={() =>
              showActionMenu({
                title: username,
                items: [
                  {
                    label: "Sign Out",
                    destructive: true,
                    onPress: () => void onSignOut(),
                  },
                ],
                tintColor: theme.color.accent,
                userInterfaceStyle: theme.scheme,
              })
            }
            style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}
          >
            {moreButton}
          </Pressable>
        )}
      </View>
    </SettingsCard>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 12,
    paddingLeft: SETTINGS_INSET,
    // The ••• target overhangs its circle; this keeps the circle on the inset.
    paddingRight: SETTINGS_INSET - (MORE_TARGET - MORE) / 2,
  },
  who: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  avatar: {
    width: AVATAR,
    height: AVATAR,
    borderRadius: AVATAR / 2,
    alignItems: "center",
    justifyContent: "center",
  },
  initials: {
    color: "#FFFFFF",
    fontSize: 16,
    fontWeight: "600",
    letterSpacing: 0.2,
  },
  moreTarget: {
    width: MORE_TARGET,
    height: MORE_TARGET,
    alignItems: "center",
    justifyContent: "center",
  },
  more: {
    width: MORE,
    height: MORE,
    borderRadius: MORE / 2,
    alignItems: "center",
    justifyContent: "center",
  },
});
