import { useState } from "react";
import {
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { SymbolView } from "expo-symbols";
import * as Haptics from "expo-haptics";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRemotePlayback } from "../context/player";
import { useTheme } from "../theme/theme";
import { AdaptiveGlass } from "./adaptive-glass";
import {
  getOptionalSwiftUI,
  swiftAccessibilityLabel,
  swiftButtonStyle,
  swiftControlSize,
  swiftDisabled,
  swiftFrame,
  swiftLabelStyle,
} from "./optional-swift-ui";

export function PlaybackDeviceButton({
  size = 44,
  glass = false,
  tintColor,
  style,
}: {
  size?: number;
  glass?: boolean;
  tintColor?: string;
  style?: StyleProp<ViewStyle>;
}) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const {
    connected,
    remoteDevices,
    targetDeviceId,
    targetDevice,
    commandPending,
    lastCommandResult,
    selectTarget,
  } = useRemotePlayback();
  const [open, setOpen] = useState(false);
  const commandError =
    lastCommandResult && lastCommandResult.status !== "applied"
      ? lastCommandResult.error || `Command ${lastCommandResult.status}`
      : null;

  const swiftUI = getOptionalSwiftUI();

  if (swiftUI) {
    const { Button, Divider, Host, Menu, RNHostView, Section } = swiftUI;
    const accessibilityLabel = targetDevice
      ? `Playback device: ${targetDevice.deviceName}`
      : "Choose playback device";

    return (
      <Host colorScheme={theme.scheme} style={{ width: size, height: size }}>
        <Menu
          label={
            <RNHostView style={{ width: size, height: size }}>
              <PlaybackDeviceTriggerVisual
                size={size}
                glass={glass}
                tintColor={tintColor}
                style={style}
                targetSelected={!!targetDevice}
                commandPending={commandPending}
                commandError={!!commandError}
              />
            </RNHostView>
          }
          modifiers={[
            swiftAccessibilityLabel(accessibilityLabel),
            swiftButtonStyle("plain"),
            swiftControlSize("small"),
            swiftLabelStyle("iconOnly"),
            swiftFrame({ width: size, height: size }),
          ]}
        >
          <Section title={connected ? "Playback Device" : "Reconnecting…"}>
            <Button
              label="This iPhone"
              systemImage={targetDeviceId ? "iphone" : "checkmark"}
              onPress={() => {
                void Haptics.selectionAsync();
                selectTarget(null);
              }}
            />
            {remoteDevices.map((device) => (
              <Button
                key={device.deviceId}
                label={device.deviceName}
                systemImage={
                  targetDeviceId === device.deviceId
                    ? "checkmark"
                    : "desktopcomputer"
                }
                onPress={() => {
                  void Haptics.selectionAsync();
                  selectTarget(device.deviceId);
                }}
              />
            ))}
          </Section>
          {!remoteDevices.length ? (
            <>
              <Divider />
              <Button
                label="No Other Devices Available"
                systemImage="wifi.slash"
                modifiers={[swiftDisabled()]}
              />
            </>
          ) : null}
          {commandError ? (
            <>
              <Divider />
              <Button
                label="Last Command Failed"
                systemImage="exclamationmark.triangle"
                modifiers={[swiftDisabled()]}
              />
            </>
          ) : null}
        </Menu>
      </Host>
    );
  }

  const trigger = (
    <Pressable
      onPress={() => {
        void Haptics.selectionAsync();
        setOpen(true);
      }}
      hitSlop={10}
      accessibilityRole="button"
      accessibilityLabel={
        targetDevice
          ? `Playback device: ${targetDevice.deviceName}`
          : "Choose playback device"
      }
      accessibilityState={{ selected: !!targetDevice }}
      style={({ pressed }) => [
        styles.trigger,
        { width: size, height: size, opacity: pressed ? 0.55 : 1 },
        !glass ? style : null,
      ]}
    >
      <SymbolView
        name={targetDevice ? "hifispeaker.2.fill" : "hifispeaker.2"}
        size={Math.round(size * 0.52)}
        tintColor={
          commandError
            ? theme.color.danger
            : targetDevice
              ? theme.color.accent
              : tintColor ?? theme.color.fgMuted
        }
      />
      {targetDevice ? (
        <View
          style={[
            styles.liveDot,
            {
              backgroundColor: commandError
                ? theme.color.danger
                : theme.color.success,
              borderColor: theme.color.bgElev1,
            },
          ]}
        />
      ) : null}
      {commandPending ? (
        <View
          style={[styles.pendingRing, { borderColor: theme.color.accent }]}
        />
      ) : null}
    </Pressable>
  );

  return (
    <>
      {glass ? (
        <AdaptiveGlass
          interactive
          style={[
            {
              width: size,
              height: size,
              borderRadius: size / 2,
              overflow: "hidden",
            },
            style,
          ]}
        >
          {trigger}
        </AdaptiveGlass>
      ) : (
        trigger
      )}

      <Modal
        visible={open}
        transparent
        animationType="fade"
        statusBarTranslucent
        onRequestClose={() => setOpen(false)}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Close playback device picker"
          style={styles.backdrop}
          onPress={() => setOpen(false)}
        >
          <Pressable
            accessibilityRole="none"
            onPress={(event) => event.stopPropagation()}
            style={[
              styles.sheet,
              {
                paddingBottom: Math.max(insets.bottom, 16),
                backgroundColor: theme.color.bgElev1,
                borderColor: theme.color.separator,
                boxShadow:
                  theme.scheme === "dark"
                    ? "0 -12px 40px rgba(0,0,0,0.55)"
                    : "0 -12px 40px rgba(0,0,0,0.18)",
              },
            ]}
          >
            <View style={styles.grabberRow}>
              <View
                style={[
                  styles.grabber,
                  { backgroundColor: theme.color.overlayGrabber },
                ]}
              />
            </View>
            <View style={styles.header}>
              <View style={{ flex: 1, gap: 2 }}>
                <Text
                  selectable
                  style={[styles.eyebrow, { color: theme.color.fgMuted }]}
                >
                  CONNECT
                </Text>
                <Text
                  selectable
                  style={[styles.title, { color: theme.color.fg }]}
                >
                  Playback device
                </Text>
              </View>
              <View style={styles.connectionState}>
                <View
                  style={[
                    styles.connectionDot,
                    {
                      backgroundColor: connected
                        ? theme.color.success
                        : theme.color.fgMuted,
                    },
                  ]}
                />
                <Text
                  selectable
                  style={[styles.connectionText, { color: theme.color.fgMuted }]}
                >
                  {connected ? "Live" : "Reconnecting"}
                </Text>
              </View>
            </View>

            <DeviceRow
              icon="iphone"
              name="This device"
              detail="Play locally on this phone"
              selected={!targetDeviceId}
              onPress={() => {
                void Haptics.selectionAsync();
                selectTarget(null);
                setOpen(false);
              }}
            />

            <Text
              selectable
              style={[styles.sectionLabel, { color: theme.color.fgMuted }]}
            >
              AVAILABLE DEVICES
            </Text>
            {remoteDevices.length ? (
              remoteDevices.map((device) => (
                <DeviceRow
                  key={device.deviceId}
                  icon="desktopcomputer"
                  name={device.deviceName}
                  detail={
                    device.activity
                      ? `${device.activity.is_playing ? "Playing" : "Paused"} · ${device.activity.title}`
                      : "Online · Nothing playing"
                  }
                  online
                  selected={targetDeviceId === device.deviceId}
                  onPress={() => {
                    void Haptics.selectionAsync();
                    selectTarget(device.deviceId);
                    setOpen(false);
                  }}
                />
              ))
            ) : (
              <Text
                selectable
                style={[styles.empty, { color: theme.color.fgMuted }]}
              >
                Open Lumen on another device to control it from here.
              </Text>
            )}

            {commandError ? (
              <Text
                selectable
                accessibilityRole="alert"
                style={[
                  styles.error,
                  {
                    color: theme.color.danger,
                    borderColor: theme.color.separator,
                  },
                ]}
              >
                {commandError}
              </Text>
            ) : null}
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}

function PlaybackDeviceTriggerVisual({
  size,
  glass,
  tintColor,
  style,
  targetSelected,
  commandPending,
  commandError,
}: {
  size: number;
  glass: boolean;
  tintColor?: string;
  style?: StyleProp<ViewStyle>;
  targetSelected: boolean;
  commandPending: boolean;
  commandError: boolean;
}) {
  const theme = useTheme();
  const content = (
    <View style={[styles.trigger, { width: size, height: size }]}>
      <SymbolView
        name={targetSelected ? "hifispeaker.2.fill" : "hifispeaker.2"}
        size={Math.round(size * 0.52)}
        tintColor={
          commandError
            ? theme.color.danger
            : targetSelected
              ? theme.color.accent
              : tintColor ?? theme.color.fgMuted
        }
      />
      {targetSelected ? (
        <View
          style={[
            styles.liveDot,
            {
              backgroundColor: commandError
                ? theme.color.danger
                : theme.color.success,
              borderColor: theme.color.bgElev1,
            },
          ]}
        />
      ) : null}
      {commandPending ? (
        <View
          style={[styles.pendingRing, { borderColor: theme.color.accent }]}
        />
      ) : null}
    </View>
  );

  if (!glass) {
    return <View style={style}>{content}</View>;
  }

  return (
    <AdaptiveGlass
      interactive
      style={[
        {
          width: size,
          height: size,
          borderRadius: size / 2,
          overflow: "hidden",
        },
        style,
      ]}
    >
      {content}
    </AdaptiveGlass>
  );
}

function DeviceRow({
  icon,
  name,
  detail,
  online = false,
  selected,
  onPress,
}: {
  icon: Parameters<typeof SymbolView>[0]["name"];
  name: string;
  detail: string;
  online?: boolean;
  selected: boolean;
  onPress: () => void;
}) {
  const theme = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${name}. ${detail}`}
      accessibilityState={{ selected }}
      style={({ pressed }) => [
        styles.deviceRow,
        {
          opacity: pressed ? 0.62 : 1,
          backgroundColor: selected
            ? theme.scheme === "dark"
              ? "rgba(10,132,255,0.16)"
              : "rgba(0,122,255,0.10)"
            : "transparent",
        },
      ]}
    >
      <View
        style={[
          styles.deviceIcon,
          {
            backgroundColor: theme.color.bgElev2,
            borderColor: selected ? theme.color.accent : theme.color.separator,
          },
        ]}
      >
        <SymbolView
          name={icon}
          size={19}
          tintColor={selected ? theme.color.accent : theme.color.fgMuted}
        />
        {online ? (
          <View
            style={[
              styles.deviceOnline,
              {
                backgroundColor: theme.color.success,
                borderColor: theme.color.bgElev1,
              },
            ]}
          />
        ) : null}
      </View>
      <View style={styles.deviceCopy}>
        <Text
          selectable
          numberOfLines={1}
          style={[styles.deviceName, { color: theme.color.fg }]}
        >
          {name}
        </Text>
        <Text
          selectable
          numberOfLines={1}
          style={[styles.deviceDetail, { color: theme.color.fgMuted }]}
        >
          {detail}
        </Text>
      </View>
      {selected ? (
        <SymbolView name="checkmark" size={16} tintColor={theme.color.accent} />
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  trigger: {
    alignItems: "center",
    justifyContent: "center",
  },
  liveDot: {
    position: "absolute",
    right: 5,
    bottom: 5,
    width: 8,
    height: 8,
    borderRadius: 4,
    borderWidth: 2,
  },
  pendingRing: {
    position: "absolute",
    width: 34,
    height: 34,
    borderRadius: 17,
    borderWidth: 1,
    opacity: 0.5,
  },
  backdrop: {
    flex: 1,
    justifyContent: "flex-end",
    backgroundColor: "rgba(0,0,0,0.48)",
  },
  sheet: {
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    borderCurve: "continuous",
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 12,
  },
  grabberRow: {
    height: 22,
    alignItems: "center",
    justifyContent: "center",
  },
  grabber: {
    width: 38,
    height: 5,
    borderRadius: 3,
  },
  header: {
    minHeight: 54,
    paddingHorizontal: 8,
    paddingBottom: 10,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  eyebrow: {
    fontSize: 10,
    fontWeight: "600",
    letterSpacing: 1.2,
  },
  title: {
    fontSize: 18,
    fontWeight: "700",
  },
  connectionState: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  connectionDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
  },
  connectionText: {
    fontSize: 12,
  },
  sectionLabel: {
    paddingHorizontal: 10,
    paddingTop: 16,
    paddingBottom: 6,
    fontSize: 10,
    fontWeight: "600",
    letterSpacing: 1.1,
  },
  deviceRow: {
    minHeight: 62,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 16,
    borderCurve: "continuous",
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  deviceIcon: {
    position: "relative",
    width: 38,
    height: 38,
    borderRadius: 11,
    borderCurve: "continuous",
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: "center",
    justifyContent: "center",
  },
  deviceOnline: {
    position: "absolute",
    right: -3,
    bottom: -3,
    width: 10,
    height: 10,
    borderRadius: 5,
    borderWidth: 2,
  },
  deviceCopy: {
    flex: 1,
    minWidth: 0,
    gap: 3,
  },
  deviceName: {
    fontSize: 15,
    fontWeight: "600",
  },
  deviceDetail: {
    fontSize: 12,
  },
  empty: {
    paddingHorizontal: 18,
    paddingVertical: 22,
    textAlign: "center",
    fontSize: 13,
    lineHeight: 18,
  },
  error: {
    marginTop: 8,
    paddingHorizontal: 10,
    paddingTop: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    fontSize: 12,
  },
});
