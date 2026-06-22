import {
  forwardRef,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ActivityIndicator,
  Alert,
  PanResponder,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  Share as NativeShare,
  useWindowDimensions,
  type LayoutChangeEvent,
} from "react-native";
import { useAudioPlayer, useAudioPlayerStatus } from "expo-audio";
import * as Clipboard from "expo-clipboard";
import Constants from "expo-constants";
import { Directory, File, Paths } from "expo-file-system";
import * as Haptics from "expo-haptics";
import { Image } from "expo-image";
import * as ImagePicker from "expo-image-picker";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { SymbolView } from "expo-symbols";
import { useMutation, useQuery } from "@tanstack/react-query";
import RNShare, { Social } from "react-native-share";
import { captureRef } from "react-native-view-shot";
import {
  ApiError,
  api,
  createTrackShareLink,
  createTrackStoryBackgroundVideo,
  getPublicTrackShare,
  streamUrl,
  type PublicTrackShare,
  type StoryBackgroundCrop,
  type TrackDetail,
} from "@music-library/core";
import { CoverArt } from "../components/cover-art";
import {
  getOptionalSwiftUI,
  swiftAccessibilityLabel,
  swiftButtonStyle,
  swiftControlSize,
  swiftDisabled,
  swiftFrame,
} from "../components/optional-swift-ui";
import { formatDurationSec } from "../lib/format";
import { qk } from "../lib/query-keys";
import { useTheme } from "../theme/theme";

const PREVIEW_DURATION_SEC = 30;
const WAVEFORM_BARS = 64;
const STORY_STICKER_WIDTH = 720;
const STORY_STICKER_HEIGHT = 925;
const STORY_STICKER_CAPTURE_SCALE = 2;
const STORY_STICKER_TITLE_LINE_HEIGHT = 56;
const STORY_STICKER_TITLE_MAX_LINES = 3;
const STORY_STICKER_TITLE_UNITS_PER_LINE = 22;
const STORY_ASPECT = 9 / 16;
const CROP_EDITOR_MAX_HEIGHT = 360;
/** How long to wait for the offscreen sticker (cover image) before capturing anyway. */
const STORY_RENDER_TIMEOUT_MS = 1800;

const expoExtra = Constants.expoConfig?.extra as
  | { instagramAppId?: string; facebookAppId?: string }
  | undefined;
const instagramAppId =
  process.env.EXPO_PUBLIC_INSTAGRAM_APP_ID ??
  expoExtra?.instagramAppId ??
  expoExtra?.facebookAppId ??
  "";

export default function ShareTrackScreen() {
  const theme = useTheme();
  const router = useRouter();
  const { trackId } = useLocalSearchParams<{
    trackId?: string;
    trackTitle?: string;
  }>();
  const [startSec, setStartSec] = useState(0);
  const [picked, setPicked] = useState(false);
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [storyBusy, setStoryBusy] = useState(false);
  const [stickerShare, setStickerShare] = useState<PublicTrackShare | null>(null);
  const [customBackground, setCustomBackground] =
    useState<PickedStoryBackground | null>(null);
  const [customCrop, setCustomCrop] = useState<StoryBackgroundCrop | null>(null);
  const stickerRef = useRef<View>(null);
  const stickerReadyRef = useRef<(() => void) | null>(null);
  const player = useAudioPlayer(undefined, { updateInterval: 100 });
  const playerStatus = useAudioPlayerStatus(player);
  const closingRef = useRef(false);

  const pausePreview = useCallback(() => {
    try {
      player.pause();
    } catch {
      // The native audio object may already be released during modal dismissal.
    }
  }, [player]);

  const seekPreview = useCallback(
    async (seconds: number) => {
      try {
        await player.seekTo(seconds);
      } catch {
        // Ignore teardown races; user-visible preview errors are handled on play.
      }
    },
    [player],
  );

  const replacePreviewSource = useCallback(
    (id: string) => {
      try {
        player.replace({ uri: streamUrl(id) });
      } catch {
        // Best effort. Preview remains unavailable if native loading fails.
      }
    },
    [player],
  );

  const trackQuery = useQuery({
    queryKey: qk.shareTrack(trackId),
    queryFn: ({ signal }) => {
      if (!trackId) throw new Error("Missing track id.");
      return api.getTrack(trackId, { signal });
    },
    enabled: !!trackId,
  });

  const durationSec = useMemo(
    () =>
      trackQuery.data
        ? Math.max(0, Math.floor(trackQuery.data.duration_ms / 1000))
        : 0,
    [trackQuery.data],
  );
  const effectivePreviewSec = Math.min(
    PREVIEW_DURATION_SEC,
    durationSec || PREVIEW_DURATION_SEC,
  );
  const maxStartSec = Math.max(0, durationSec - effectivePreviewSec);
  const endSec = Math.min(durationSec, startSec + effectivePreviewSec);
  const currentSec = playerStatus.playing ? playerStatus.currentTime : startSec;

  useEffect(() => {
    if (!trackId) return;
    closingRef.current = false;
    pausePreview();
    replacePreviewSource(trackId);
  }, [pausePreview, replacePreviewSource, trackId]);

  useEffect(() => {
    return () => {
      closingRef.current = true;
      pausePreview();
    };
  }, [pausePreview]);

  useEffect(() => {
    if (closingRef.current) return;
    if (!playerStatus.playing) return;
    if (playerStatus.currentTime >= endSec || playerStatus.currentTime < startSec - 0.25) {
      pausePreview();
      void seekPreview(startSec);
    }
  }, [
    endSec,
    pausePreview,
    playerStatus.currentTime,
    playerStatus.playing,
    seekPreview,
    startSec,
  ]);

  const generateMutation = useMutation({
    mutationFn: async () => {
      if (!trackId) throw new Error("Missing track id.");
      const res = await createTrackShareLink(trackId, startSec);
      return res.url;
    },
    onSuccess: (url) => {
      setShareUrl(url);
    },
    onError: (error) => {
      Alert.alert(
        "Couldn't create share link",
        error instanceof ApiError || error instanceof Error
          ? error.message
          : "Please try again.",
      );
    },
  });

  const onStartChange = useCallback(
    (value: number) => {
      const next = Math.max(0, Math.min(maxStartSec, Math.floor(value)));
      setStartSec(next);
      setPicked(true);
      setShareUrl(null);
      if (playerStatus.playing) {
        void seekPreview(next);
      }
    },
    [maxStartSec, playerStatus.playing, seekPreview],
  );

  const togglePreview = useCallback(async () => {
    if (!trackQuery.data || durationSec <= 0) return;
    try {
      if (playerStatus.playing) {
        pausePreview();
        return;
      }
      await seekPreview(startSec);
      player.play();
      void Haptics.selectionAsync();
    } catch {
      Alert.alert("Couldn't preview snippet", "Please try again.");
    }
  }, [
    durationSec,
    pausePreview,
    player,
    playerStatus.playing,
    seekPreview,
    startSec,
    trackQuery.data,
  ]);

  const getShareUrl = useCallback(async () => {
    if (shareUrl) return shareUrl;
    return await generateMutation.mutateAsync();
  }, [generateMutation, shareUrl]);

  const markStickerReady = useCallback(() => {
    const resolve = stickerReadyRef.current;
    stickerReadyRef.current = null;
    resolve?.();
  }, []);

  const renderStorySticker = useCallback(async (publicShare: PublicTrackShare) => {
    setStickerShare(publicShare);
    // Wait until the offscreen sticker's cover has loaded (markStickerReady),
    // the timeout fires, or there is no cover to wait for — whichever is first.
    await new Promise<void>((resolve) => {
      let done = false;
      let timeout: ReturnType<typeof setTimeout> | null = null;
      const finish = () => {
        if (done) return;
        done = true;
        if (timeout) clearTimeout(timeout);
        stickerReadyRef.current = null;
        resolve();
      };

      stickerReadyRef.current = finish;
      timeout = setTimeout(finish, STORY_RENDER_TIMEOUT_MS);
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (!publicShare.cover_url) finish();
        });
      });
    });

    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    if (!stickerRef.current) {
      throw new Error("Story sticker was not ready.");
    }
    try {
      return await captureRef(stickerRef, {
        format: "png",
        quality: 1,
        result: "tmpfile",
        width: STORY_STICKER_WIDTH * STORY_STICKER_CAPTURE_SCALE,
        height:
          getStoryStickerHeight(publicShare.title) * STORY_STICKER_CAPTURE_SCALE,
      });
    } finally {
      setStickerShare(null);
    }
  }, []);

  const pickCustomBackground = useCallback(async () => {
    let result: ImagePicker.ImagePickerResult;
    try {
      result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ["images"],
        quality: 0.92,
      });
    } catch {
      Alert.alert("Couldn't open photos", "Please try again.");
      return;
    }
    if (result.canceled || result.assets.length === 0) return;
    const asset = result.assets[0];
    const next = {
      uri: asset.uri,
      name: asset.fileName ?? "story-background.jpg",
      type: asset.mimeType ?? "image/jpeg",
      width: Math.max(1, asset.width || 1),
      height: Math.max(1, asset.height || 1),
    };
    setCustomBackground(next);
    setCustomCrop(initialStoryCrop(next.width, next.height));
    void Haptics.selectionAsync();
  }, []);

  const clearCustomBackground = useCallback(() => {
    setCustomBackground(null);
    setCustomCrop(null);
  }, []);

  const prepareStoryPayload = useCallback(async (mode: StoryBackgroundMode) => {
    if (!instagramAppId) {
      throw new Error(
        "Instagram sharing needs EXPO_PUBLIC_INSTAGRAM_APP_ID or expo.extra.instagramAppId.",
      );
    }

    const url = await getShareUrl();
    const shareRef = parseShareUrl(url);
    if (!shareRef) {
      throw new Error("Couldn't read the generated share link.");
    }

    const publicShare = await getPublicTrackShare(
      shareRef.trackId,
      shareRef.startSec,
      shareRef.sig,
    );

    const hasSplitStory = Boolean(publicShare.story_background_url);
    const storyUrl =
      publicShare.story_background_url ??
      publicShare.story_url ??
      publicShare.preview_url;
    if (!storyUrl) {
      throw new Error("The backend did not return a story video URL.");
    }

    const mediaDir = ensureStoryCacheDir();
    let videoFile: File;
    if (mode === "custom-image") {
      if (!customBackground || !customCrop) {
        throw new Error("Choose a photo first.");
      }
      const response = await createTrackStoryBackgroundVideo(
        publicShare.track_id,
        publicShare.start_sec,
        {
          uri: customBackground.uri,
          name: customBackground.name,
          type: customBackground.type,
        },
        customCrop,
      );
      videoFile = await responseToFile(
        response,
        new File(
          mediaDir,
          `${publicShare.track_id}-${publicShare.start_sec}-custom-story.mp4`,
        ),
      );
    } else {
      videoFile = await downloadToFile(
        storyUrl,
        new File(
          mediaDir,
          `${publicShare.track_id}-${publicShare.start_sec}-story.mp4`,
        ),
      );
    }
    const stickerUri = hasSplitStory
      ? await renderStorySticker(publicShare)
      : undefined;

    return {
      publicShare,
      videoUri: videoFile.uri,
      stickerUri,
    };
  }, [customBackground, customCrop, getShareUrl, renderStorySticker]);

  const copyLink = useCallback(async () => {
    if (!picked) return;
    try {
      const url = await getShareUrl();
      await Clipboard.setStringAsync(url);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      Alert.alert("Copied", "Share link copied to clipboard.");
    } catch {
      // Mutation handles the visible error state.
    }
  }, [getShareUrl, picked]);

  const shareLink = useCallback(async () => {
    if (!picked) return;
    try {
      const url = await getShareUrl();
      const title = trackQuery.data?.title ?? "Shared track";
      await NativeShare.share({
        title,
        message: `${title}\n${url}`,
        url,
      });
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (error) {
      if (isShareDismissal(error)) return;
      if (!generateMutation.isError) {
        Alert.alert("Couldn't share link", "Please try again.");
      }
    }
  }, [generateMutation.isError, getShareUrl, picked, trackQuery.data?.title]);

  const shareInstagramStory = useCallback(async (mode: StoryBackgroundMode) => {
    if (!picked || storyBusy) return;
    if (mode === "custom-image" && (!customBackground || !customCrop)) {
      await pickCustomBackground();
      return;
    }
    setStoryBusy(true);
    try {
      const { publicShare, videoUri, stickerUri } = await prepareStoryPayload(mode);
      await RNShare.shareSingle({
        appId: instagramAppId,
        attributionURL: publicShare.canonical_url,
        backgroundVideo: videoUri,
        stickerImage: stickerUri,
        linkText: "Listen on Lumen",
        linkUrl: publicShare.canonical_url,
        social: Social.InstagramStories,
      });
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (error) {
      if (isShareDismissal(error)) return;
      Alert.alert(
        "Couldn't open Instagram Story",
        error instanceof Error ? error.message : "Please try sharing the link instead.",
      );
    } finally {
      setStoryBusy(false);
    }
  }, [
    customBackground,
    customCrop,
    pickCustomBackground,
    prepareStoryPayload,
    picked,
    storyBusy,
  ]);

  const close = useCallback(() => {
    void Haptics.selectionAsync();
    closingRef.current = true;
    pausePreview();
    router.back();
  }, [pausePreview, router]);

  const busy = generateMutation.isPending;
  const canShare = Boolean(trackQuery.data && picked && !busy && !storyBusy);

  return (
    <>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        bounces={false}
        alwaysBounceVertical={false}
        alwaysBounceHorizontal={false}
        overScrollMode="never"
        style={[styles.noDragPage, { flex: 1, backgroundColor: theme.color.bg }]}
        contentContainerStyle={{
          paddingHorizontal: theme.space.lg,
          paddingTop: theme.space.lg,
          paddingBottom: theme.space.xl,
          gap: theme.space.lg,
        }}
      >
        {trackQuery.isLoading ? (
          <View style={styles.center}>
            <ActivityIndicator color={theme.color.fgMuted} />
          </View>
        ) : trackQuery.isError || !trackQuery.data ? (
          <View style={styles.center}>
            <Text style={{ color: theme.color.fgMuted }}>
              Couldn&apos;t load track.
            </Text>
          </View>
        ) : (
          <>
            <TrackHeader track={trackQuery.data} />

            <View
              style={[
                styles.panel,
                {
                  backgroundColor: theme.color.bgElev1,
                  borderColor: theme.color.separator,
                  borderRadius: theme.radius.lg,
                  padding: theme.space.lg,
                  gap: theme.space.md,
                },
              ]}
            >
              <View style={styles.panelHeader}>
                <Text
                  style={{
                    color: theme.color.fg,
                    fontSize: 17,
                    fontWeight: "700",
                  }}
                >
                  Snippet
                </Text>
                <Text
                  style={{
                    color: theme.color.fgMuted,
                    fontSize: 13,
                    fontVariant: ["tabular-nums"],
                  }}
                >
                  {formatDurationSec(startSec)} - {formatDurationSec(endSec)}
                </Text>
              </View>

              <WaveformRegionSelector
                durationSec={durationSec}
                startSec={startSec}
                endSec={endSec}
                currentSec={currentSec}
                maxStartSec={maxStartSec}
                onStartChange={onStartChange}
              />

              <View style={styles.timeRow}>
                <Text style={{ color: theme.color.fgMuted, fontSize: 12 }}>
                  0:00
                </Text>
                <Text style={{ color: theme.color.fgMuted, fontSize: 12 }}>
                  {formatDurationSec(durationSec)}
                </Text>
              </View>

              <Pressable
                onPress={() => void togglePreview()}
                disabled={durationSec <= 0}
                accessibilityRole="button"
                accessibilityLabel={
                  playerStatus.playing ? "Pause snippet preview" : "Preview snippet"
                }
                style={({ pressed }) => [
                  styles.previewButton,
                  {
                    opacity: durationSec <= 0 ? 0.45 : pressed ? 0.65 : 1,
                    backgroundColor: theme.color.bgElev2,
                  },
                ]}
              >
                <SymbolView
                  name={playerStatus.playing ? "pause.fill" : "play.fill"}
                  size={16}
                  weight="semibold"
                  tintColor={theme.color.fg}
                />
                <Text style={{ color: theme.color.fg, fontWeight: "700" }}>
                  {playerStatus.playing ? "Pause Preview" : "Preview Snippet"}
                </Text>
              </Pressable>

              <Text style={{ color: theme.color.fgMuted }}>
                {picked
                  ? "Drag the highlighted region to tune the share clip."
                  : "Drag across the waveform to choose the 30-second clip friends will hear."}
              </Text>
            </View>

            {customBackground && customCrop ? (
              <StoryBackgroundCropEditor
                image={customBackground}
                crop={customCrop}
                disabled={storyBusy}
                onChangeCrop={setCustomCrop}
                onPickPhoto={pickCustomBackground}
                onReset={clearCustomBackground}
              />
            ) : null}

            {shareUrl ? (
              <View
                style={[
                  styles.linkBox,
                  {
                    backgroundColor: theme.color.bgElev1,
                    borderColor: theme.color.separator,
                    borderRadius: theme.radius.md,
                    padding: theme.space.md,
                    gap: theme.space.xs,
                  },
                ]}
              >
                <Text style={{ color: theme.color.fgMuted, fontSize: 12 }}>
                  Share link
                </Text>
                <Text style={{ color: theme.color.fg }}>
                  {shareUrl}
                </Text>
              </View>
            ) : null}

            <View style={{ gap: theme.space.sm }}>
              <StoryShareMenuButton
                disabled={!canShare}
                loading={storyBusy}
                hasCustomBackground={Boolean(customBackground)}
                onGenerated={() => void shareInstagramStory("generated-colors")}
                onCustom={() => {
                  if (customBackground) {
                    void shareInstagramStory("custom-image");
                  } else {
                    void pickCustomBackground();
                  }
                }}
                onPickCustom={() => void pickCustomBackground()}
              />
              <ActionButton
                label={busy ? "Generating..." : "Share Link"}
                icon="square.and.arrow.up"
                disabled={!canShare}
                loading={busy}
                onPress={() => void shareLink()}
              />
              <ActionButton
                label="Copy Link"
                icon="doc.on.doc"
                disabled={!canShare}
                onPress={() => void copyLink()}
              />
            </View>
          </>
        )}
      </ScrollView>

      <Stack.Screen.Title>Share Track</Stack.Screen.Title>
      <Stack.Toolbar placement="left">
        <Stack.Toolbar.Button
          icon="xmark"
          accessibilityLabel="Close"
          onPress={close}
          separateBackground
        />
      </Stack.Toolbar>
      <StoryStickerCapture
        ref={stickerRef}
        share={stickerShare}
        onCoverLoadEnd={markStickerReady}
      />
    </>
  );
}

type StoryBackgroundMode = "generated-colors" | "custom-image";

interface PickedStoryBackground {
  uri: string;
  name: string;
  type: string;
  width: number;
  height: number;
}

function StoryShareMenuButton({
  disabled,
  loading,
  hasCustomBackground,
  onGenerated,
  onCustom,
  onPickCustom,
}: {
  disabled: boolean;
  loading: boolean;
  hasCustomBackground: boolean;
  onGenerated: () => void;
  onCustom: () => void;
  onPickCustom: () => void;
}) {
  const theme = useTheme();
  const { width } = useWindowDimensions();
  const swiftUI = getOptionalSwiftUI();
  const label = loading ? "Rendering Story..." : "Instagram Story";
  const buttonWidth = Math.max(0, width - theme.space.lg * 2);

  if (!swiftUI) {
    return (
      <ActionButton
        label={label}
        icon="camera"
        primary
        disabled={disabled}
        loading={loading}
        onPress={onGenerated}
      />
    );
  }

  const { Button, Divider, Host, Menu, RNHostView } = swiftUI;

  return (
    <Host colorScheme={theme.scheme} style={{ width: buttonWidth }}>
      <Menu
        label={
          <RNHostView matchContents style={{ width: buttonWidth }}>
            <StoryMenuLabel
              label={label}
              loading={loading}
              disabled={disabled}
              width={buttonWidth}
            />
          </RNHostView>
        }
        modifiers={[
          swiftAccessibilityLabel("Instagram Story background"),
          swiftButtonStyle("plain"),
          swiftControlSize("regular"),
          swiftFrame({ width: buttonWidth }),
          swiftDisabled(disabled),
        ]}
      >
        <Button
          label="Use Generated Colors"
          systemImage="paintpalette"
          onPress={onGenerated}
        />
        <Button
          label={hasCustomBackground ? "Use Custom Image" : "Choose Custom Image"}
          systemImage="photo"
          onPress={onCustom}
        />
        {hasCustomBackground ? (
          <>
            <Divider />
            <Button
              label="Choose Different Image"
              systemImage="photo.on.rectangle"
              onPress={onPickCustom}
            />
          </>
        ) : null}
      </Menu>
    </Host>
  );
}

function StoryMenuLabel({
  label,
  loading,
  disabled,
  width,
}: {
  label: string;
  loading: boolean;
  disabled: boolean;
  width: number;
}) {
  const theme = useTheme();
  return (
    <View
      style={[
        styles.button,
        {
          width,
          opacity: disabled ? 0.45 : 1,
          backgroundColor: theme.color.accent,
          borderColor: theme.color.accent,
        },
      ]}
    >
      {loading ? (
        <ActivityIndicator color={theme.color.onAccent} />
      ) : (
        <SymbolView
          name="camera"
          size={18}
          weight="semibold"
          tintColor={theme.color.onAccent}
        />
      )}
      <Text
        style={{
          color: theme.color.onAccent,
          fontSize: 17,
          fontWeight: "700",
        }}
      >
        {label}
      </Text>
    </View>
  );
}

function StoryBackgroundCropEditor({
  image,
  crop,
  disabled,
  onChangeCrop,
  onPickPhoto,
  onReset,
}: {
  image: PickedStoryBackground;
  crop: StoryBackgroundCrop;
  disabled: boolean;
  onChangeCrop: (crop: StoryBackgroundCrop) => void;
  onPickPhoto: () => void;
  onReset: () => void;
}) {
  const theme = useTheme();
  const [layout, setLayout] = useState({ width: 0, height: 0 });
  const layoutRef = useRef(layout);
  const cropRef = useRef(crop);

  useEffect(() => {
    layoutRef.current = layout;
  }, [layout]);
  useEffect(() => {
    cropRef.current = crop;
  }, [crop]);

  const metrics = useMemo(
    () => cropEditorMetrics(image, layout.width, layout.height, crop),
    [crop, image, layout.height, layout.width],
  );

  const setCropCenter = useCallback(
    (x: number, y: number) => {
      const currentLayout = layoutRef.current;
      const currentCrop = cropRef.current;
      const currentMetrics = cropEditorMetrics(
        image,
        currentLayout.width,
        currentLayout.height,
        currentCrop,
      );
      if (!currentMetrics) return;
      const nx =
        (x - currentMetrics.imageLeft) / Math.max(1, currentMetrics.imageWidth);
      const ny =
        (y - currentMetrics.imageTop) / Math.max(1, currentMetrics.imageHeight);
      onChangeCrop(
        clampCrop({
          ...currentCrop,
          x: nx - currentCrop.width / 2,
          y: ny - currentCrop.height / 2,
        }),
      );
    },
    [image, onChangeCrop],
  );

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => !disabled,
        onMoveShouldSetPanResponder: () => !disabled,
        onPanResponderGrant: (event) => {
          setCropCenter(event.nativeEvent.locationX, event.nativeEvent.locationY);
          void Haptics.selectionAsync();
        },
        onPanResponderMove: (event) => {
          setCropCenter(event.nativeEvent.locationX, event.nativeEvent.locationY);
        },
      }),
    [disabled, setCropCenter],
  );

  const editorHeight = layout.width
    ? cropEditorHeightForWidth(layout.width)
    : CROP_EDITOR_MAX_HEIGHT;

  return (
    <View
      style={[
        styles.panel,
        {
          backgroundColor: theme.color.bgElev1,
          borderColor: theme.color.separator,
          borderRadius: theme.radius.lg,
          padding: theme.space.lg,
          gap: theme.space.md,
        },
      ]}
    >
      <View style={styles.panelHeader}>
        <Text style={{ color: theme.color.fg, fontSize: 17, fontWeight: "700" }}>
          Story Background
        </Text>
        <View style={styles.cropActionRow}>
          <Pressable
            onPress={onPickPhoto}
            disabled={disabled}
            accessibilityRole="button"
            accessibilityLabel="Choose a different story background photo"
            style={({ pressed }) => [
              styles.cropTextButton,
              { opacity: disabled ? 0.45 : pressed ? 0.6 : 1 },
            ]}
          >
            <Text style={{ color: theme.color.accent, fontWeight: "700" }}>
              Change
            </Text>
          </Pressable>
          <Pressable
            onPress={onReset}
            disabled={disabled}
            accessibilityRole="button"
            accessibilityLabel="Remove custom story background"
            style={({ pressed }) => [
              styles.cropTextButton,
              { opacity: disabled ? 0.45 : pressed ? 0.6 : 1 },
            ]}
          >
            <Text style={{ color: theme.color.fgMuted, fontWeight: "700" }}>
              Clear
            </Text>
          </Pressable>
        </View>
      </View>

      <View
        onLayout={(event) => {
          const { width } = event.nativeEvent.layout;
          setLayout({ width, height: cropEditorHeightForWidth(width) });
        }}
        pointerEvents="box-only"
        {...panResponder.panHandlers}
        style={[
          styles.cropEditor,
          styles.dragSurface,
          {
            height: editorHeight,
            backgroundColor: theme.color.bg,
            borderColor: theme.color.separator,
          },
        ]}
      >
        {metrics ? (
          <>
            <Image
              source={{ uri: image.uri }}
              style={{
                position: "absolute",
                left: metrics.imageLeft,
                top: metrics.imageTop,
                width: metrics.imageWidth,
                height: metrics.imageHeight,
              }}
              contentFit="contain"
            />
            <View
              pointerEvents="none"
              style={[
                styles.cropWindow,
                {
                  left: metrics.cropLeft,
                  top: metrics.cropTop,
                  width: metrics.cropWidth,
                  height: metrics.cropHeight,
                  borderColor: theme.color.accent,
                  backgroundColor: selectionTint(theme.scheme),
                },
              ]}
            />
          </>
        ) : null}
      </View>

    </View>
  );
}

function cropEditorHeightForWidth(width: number) {
  return Math.min(CROP_EDITOR_MAX_HEIGHT, Math.max(260, width * 0.92));
}

/** Translucent accent fill shared by the crop window and waveform selection. */
function selectionTint(scheme: "light" | "dark") {
  return scheme === "dark"
    ? "rgba(10, 132, 255, 0.18)"
    : "rgba(10, 132, 255, 0.12)";
}

const StoryStickerCapture = forwardRef<View, {
  share: PublicTrackShare | null;
  onCoverLoadEnd: () => void;
}>(({ share, onCoverLoadEnd }, ref) => {
  const title = share?.title?.trim() || "Untitled track";
  const artist = share?.artist?.trim() || "Unknown artist";
  const titleLineCount = getStoryStickerTitleLineCount(title);
  const stickerHeight = getStoryStickerHeight(title);
  const wrappedTitle = titleLineCount > 1;

  return (
    <View
      pointerEvents="none"
      style={[
        styles.storyStickerHost,
        wrappedTitle && { height: stickerHeight },
      ]}
    >
      <View
        ref={ref}
        collapsable={false}
        style={[
          styles.storyStickerCard,
          wrappedTitle && { height: stickerHeight },
        ]}
      >
        {share?.cover_url ? (
          <Image
            source={{ uri: share.cover_url }}
            style={styles.storyStickerCover}
            contentFit="cover"
            cachePolicy="memory-disk"
            priority="high"
            transition={0}
            onLoadEnd={onCoverLoadEnd}
          />
        ) : (
          <View style={styles.storyStickerCoverFallback} />
        )}
        <Text
          numberOfLines={titleLineCount}
          ellipsizeMode="tail"
          style={styles.storyStickerTitle}
        >
          {title}
        </Text>
        <Text
          numberOfLines={1}
          style={styles.storyStickerArtist}
        >
          {artist}
        </Text>
        <View style={styles.storyStickerBrand}>
          <LumenWaveformMark />
          <Text style={styles.storyStickerBrandText}>Lumen</Text>
        </View>
      </View>
    </View>
  );
});

StoryStickerCapture.displayName = "StoryStickerCapture";

function getStoryStickerHeight(title?: string | null) {
  const lineCount = getStoryStickerTitleLineCount(
    title?.trim() || "Untitled track",
  );
  return (
    STORY_STICKER_HEIGHT +
    (lineCount - 1) * STORY_STICKER_TITLE_LINE_HEIGHT
  );
}

function getStoryStickerTitleLineCount(title: string) {
  const words = title.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return 1;

  let lineCount = 1;
  let lineUnits = 0;

  for (const word of words) {
    const wordUnits = getStoryStickerTitleUnits(word);
    const separatorUnits = lineUnits === 0 ? 0 : 0.6;

    if (
      lineUnits > 0 &&
      lineUnits + separatorUnits + wordUnits >
        STORY_STICKER_TITLE_UNITS_PER_LINE
    ) {
      lineCount += 1;
      lineUnits = wordUnits;
    } else {
      lineUnits += separatorUnits + wordUnits;
    }

    if (lineCount >= STORY_STICKER_TITLE_MAX_LINES) {
      return STORY_STICKER_TITLE_MAX_LINES;
    }
  }

  return lineCount;
}

function getStoryStickerTitleUnits(text: string) {
  return Array.from(text).reduce((total, char) => {
    if (/[A-Z]/.test(char)) return total + 1.12;
    if (/[il.,'!:;]/.test(char)) return total + 0.42;
    if (/[-&()[\]/]/.test(char)) return total + 0.65;
    return total + 0.95;
  }, 0);
}

function LumenWaveformMark() {
  return (
    <View style={styles.lumenWaveform}>
      {[
        [0, 17, 5, 17],
        [5, 17, 9, 8],
        [9, 8, 15, 29],
        [15, 29, 22, 3],
        [22, 3, 30, 33],
        [30, 33, 37, 13],
        [37, 13, 42, 17],
      ].map(([x1, y1, x2, y2], index) => {
        const dx = x2 - x1;
        const dy = y2 - y1;
        const length = Math.hypot(dx, dy);
        const angle = `${Math.atan2(dy, dx)}rad`;
        return (
          <View
            key={index}
            style={[
              styles.lumenWaveformSegment,
              {
                width: length,
                left: x1,
                top: y1,
                transform: [{ rotate: angle }],
              },
            ]}
          />
        );
      })}
    </View>
  );
}

function TrackHeader({ track }: { track: TrackDetail }) {
  const theme = useTheme();
  const artist =
    track.artists.find((item) => item.role === "primary")?.name ??
    track.artists[0]?.name ??
    "Unknown artist";

  return (
    <View style={[styles.header, { gap: theme.space.md }]}>
      <CoverArt track={track} size={72} priority="high" />
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text
          numberOfLines={2}
          style={{ color: theme.color.fg, fontSize: 22, fontWeight: "700" }}
        >
          {track.title}
        </Text>
        <Text
          numberOfLines={1}
          style={{ color: theme.color.fgMuted, fontSize: 16 }}
        >
          {artist}
          {track.album_title ? ` - ${track.album_title}` : ""}
        </Text>
        <Text style={{ color: theme.color.fgMuted, fontSize: 13 }}>
          {formatDurationSec(Math.floor(track.duration_ms / 1000))}
        </Text>
      </View>
    </View>
  );
}

function WaveformRegionSelector({
  durationSec,
  startSec,
  endSec,
  currentSec,
  maxStartSec,
  onStartChange,
}: {
  durationSec: number;
  startSec: number;
  endSec: number;
  currentSec: number;
  maxStartSec: number;
  onStartChange: (seconds: number) => void;
}) {
  const theme = useTheme();
  const [width, setWidth] = useState(0);
  const widthRef = useRef(0);
  const bars = useMemo(() => buildWaveformBars(WAVEFORM_BARS), []);
  const selectionStart = durationSec > 0 ? startSec / durationSec : 0;
  const selectionEnd = durationSec > 0 ? endSec / durationSec : 0;
  const playhead = durationSec > 0 ? currentSec / durationSec : selectionStart;

  const setFromX = useCallback(
    (x: number) => {
      const availableWidth = widthRef.current;
      if (availableWidth <= 0 || durationSec <= 0) return;
      const ratio = Math.max(0, Math.min(1, x / availableWidth));
      const centered = ratio * durationSec - (endSec - startSec) / 2;
      onStartChange(Math.max(0, Math.min(maxStartSec, centered)));
    },
    [durationSec, endSec, maxStartSec, onStartChange, startSec],
  );

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => durationSec > 0,
        onMoveShouldSetPanResponder: () => durationSec > 0,
        onPanResponderGrant: (event) => {
          setFromX(event.nativeEvent.locationX);
          void Haptics.selectionAsync();
        },
        onPanResponderMove: (event) => {
          setFromX(event.nativeEvent.locationX);
        },
      }),
    [durationSec, setFromX],
  );

  const onLayout = useCallback((event: LayoutChangeEvent) => {
    const nextWidth = event.nativeEvent.layout.width;
    widthRef.current = nextWidth;
    setWidth(nextWidth);
  }, []);

  const left = width * selectionStart;
  const selectedWidth = Math.max(18, width * Math.max(0.015, selectionEnd - selectionStart));
  const playheadLeft = width * Math.max(0, Math.min(1, playhead));

  return (
    <View
      onLayout={onLayout}
      pointerEvents="box-only"
      {...panResponder.panHandlers}
      style={[
        styles.waveform,
        styles.dragSurface,
        {
          backgroundColor: theme.color.bg,
          borderColor: theme.color.separator,
        },
      ]}
    >
      <View style={styles.waveformBars}>
        {bars.map((height, index) => {
          const center = (index + 0.5) / bars.length;
          const selected = center >= selectionStart && center <= selectionEnd;
          return (
            <View
              key={index}
              style={[
                styles.waveformBar,
                {
                  height,
                  backgroundColor: selected
                    ? theme.color.accent
                    : theme.color.bgElev2,
                },
              ]}
            />
          );
        })}
      </View>
      {width > 0 ? (
        <>
          <View
            pointerEvents="none"
            style={[
              styles.selectionRegion,
              {
                left,
                width: selectedWidth,
                borderColor: theme.color.accent,
                backgroundColor: selectionTint(theme.scheme),
              },
            ]}
          >
            <View
              style={[
                styles.selectionHandle,
                { backgroundColor: theme.color.accent, left: -2 },
              ]}
            />
            <View
              style={[
                styles.selectionHandle,
                { backgroundColor: theme.color.accent, right: -2 },
              ]}
            />
          </View>
          <View
            pointerEvents="none"
            style={[
              styles.playhead,
              {
                left: playheadLeft,
                backgroundColor: theme.color.fg,
              },
            ]}
          />
        </>
      ) : null}
    </View>
  );
}

function ActionButton({
  label,
  icon,
  primary = false,
  disabled = false,
  loading = false,
  onPress,
}: {
  label: string;
  icon: "camera" | "square.and.arrow.up" | "doc.on.doc";
  primary?: boolean;
  disabled?: boolean;
  loading?: boolean;
  onPress: () => void;
}) {
  const theme = useTheme();

  return (
    <Pressable
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        {
          opacity: disabled ? 0.45 : pressed ? 0.68 : 1,
          backgroundColor: primary ? theme.color.accent : theme.color.bgElev1,
          borderColor: primary ? theme.color.accent : theme.color.separator,
        },
      ]}
    >
      {loading ? (
        <ActivityIndicator color={theme.color.onAccent} />
      ) : (
        <SymbolView
          name={icon}
          size={18}
          weight="semibold"
          tintColor={primary ? theme.color.onAccent : theme.color.fg}
        />
      )}
      <Text
        style={{
          color: primary ? theme.color.onAccent : theme.color.fg,
          fontSize: 17,
          fontWeight: "700",
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

function buildWaveformBars(count: number) {
  return Array.from({ length: count }, (_, index) => {
    const t = index / Math.max(1, count - 1);
    const wave =
      Math.sin(t * Math.PI * 5.4) * 0.26 +
      Math.sin(t * Math.PI * 17.2) * 0.16 +
      Math.sin(t * Math.PI * 29.5) * 0.08;
    return 16 + Math.round((0.54 + wave) * 54);
  });
}

function parseShareUrl(raw: string) {
  try {
    const parsed = new URL(raw, "https://lumen.invalid");
    const parts = parsed.pathname.split("/").filter(Boolean);
    const trackIndex = parts.findIndex((part) => part === "track");
    const trackId = trackIndex >= 0 ? parts[trackIndex + 1] : "";
    const sig = parsed.searchParams.get("sig") ?? "";
    const startSec = Number.parseInt(parsed.searchParams.get("t") ?? "0", 10);
    if (!trackId || !sig || !Number.isFinite(startSec) || startSec < 0) {
      return null;
    }
    return { trackId, sig, startSec };
  } catch {
    return null;
  }
}

function initialStoryCrop(width: number, height: number): StoryBackgroundCrop {
  const imageAspect = width / Math.max(1, height);
  if (imageAspect > STORY_ASPECT) {
    const cropWidth = STORY_ASPECT / imageAspect;
    return {
      x: (1 - cropWidth) / 2,
      y: 0,
      width: cropWidth,
      height: 1,
    };
  }
  const cropHeight = imageAspect / STORY_ASPECT;
  return {
    x: 0,
    y: (1 - cropHeight) / 2,
    width: 1,
    height: cropHeight,
  };
}

function clampCrop(crop: StoryBackgroundCrop): StoryBackgroundCrop {
  const width = Math.max(0.01, Math.min(1, crop.width));
  const height = Math.max(0.01, Math.min(1, crop.height));
  return {
    x: Math.max(0, Math.min(1 - width, crop.x)),
    y: Math.max(0, Math.min(1 - height, crop.y)),
    width,
    height,
  };
}

function cropEditorMetrics(
  image: PickedStoryBackground,
  width: number,
  height: number,
  crop: StoryBackgroundCrop,
) {
  if (width <= 0 || height <= 0) return null;
  const imageAspect = image.width / Math.max(1, image.height);
  const frameAspect = width / height;
  const imageWidth =
    imageAspect > frameAspect ? width : Math.max(1, height * imageAspect);
  const imageHeight =
    imageAspect > frameAspect ? Math.max(1, width / imageAspect) : height;
  const imageLeft = (width - imageWidth) / 2;
  const imageTop = (height - imageHeight) / 2;
  const safeCrop = clampCrop(crop);
  return {
    imageLeft,
    imageTop,
    imageWidth,
    imageHeight,
    cropLeft: imageLeft + safeCrop.x * imageWidth,
    cropTop: imageTop + safeCrop.y * imageHeight,
    cropWidth: safeCrop.width * imageWidth,
    cropHeight: safeCrop.height * imageHeight,
  };
}

function ensureStoryCacheDir() {
  const dir = new Directory(Paths.cache, "instagram-stories");
  dir.create({ idempotent: true, intermediates: true });
  return dir;
}

async function downloadToFile(url: string, destination: File) {
  return await File.downloadFileAsync(url, destination, { idempotent: true });
}

async function responseToFile(response: Response, destination: File) {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("video/mp4")) {
    const message = await response.text().catch(() => "");
    throw new Error(message.trim() || "The backend did not return a story video.");
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  destination.create({ intermediates: true, overwrite: true });
  destination.write(bytes);
  return destination;
}

function isShareDismissal(error: unknown) {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return (
    message.includes("cancel") ||
    message.includes("dismiss") ||
    message.includes("did not share")
  );
}

const styles = StyleSheet.create({
  noDragPage: {
    userSelect: "none",
  },
  center: {
    minHeight: 240,
    alignItems: "center",
    justifyContent: "center",
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
  },
  panel: {
    borderWidth: StyleSheet.hairlineWidth,
    borderCurve: "continuous",
  },
  panelHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 12,
  },
  cropActionRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  cropTextButton: {
    minHeight: 32,
    alignItems: "center",
    justifyContent: "center",
  },
  cropEditor: {
    borderRadius: 14,
    borderCurve: "continuous",
    borderWidth: StyleSheet.hairlineWidth,
    overflow: "hidden",
  },
  dragSurface: {
    userSelect: "none",
  },
  cropWindow: {
    position: "absolute",
    borderWidth: 2,
    borderRadius: 12,
    borderCurve: "continuous",
  },
  waveform: {
    height: 116,
    borderRadius: 14,
    borderCurve: "continuous",
    borderWidth: StyleSheet.hairlineWidth,
    overflow: "hidden",
    justifyContent: "center",
    paddingHorizontal: 10,
  },
  waveformBars: {
    height: 82,
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
  },
  waveformBar: {
    flex: 1,
    minWidth: 2,
    borderRadius: 2,
  },
  selectionRegion: {
    position: "absolute",
    top: 8,
    bottom: 8,
    borderWidth: 2,
    borderRadius: 12,
    borderCurve: "continuous",
  },
  selectionHandle: {
    position: "absolute",
    top: 18,
    bottom: 18,
    width: 4,
    borderRadius: 2,
  },
  playhead: {
    position: "absolute",
    top: 4,
    bottom: 4,
    width: 2,
    opacity: 0.8,
  },
  storyStickerHost: {
    position: "absolute",
    left: -2000,
    top: -2000,
    width: 720,
    height: 925,
  },
  storyStickerCard: {
    width: 720,
    height: 925,
    padding: 45,
    borderRadius: 34,
    borderCurve: "continuous",
    backgroundColor: "#FFFFFF",
    overflow: "hidden",
  },
  storyStickerCover: {
    width: 630,
    height: 630,
    borderRadius: 9,
    borderCurve: "continuous",
    overflow: "hidden",
  },
  storyStickerCoverFallback: {
    width: 630,
    height: 630,
    borderRadius: 9,
    borderCurve: "continuous",
    backgroundColor: "#E8E9EE",
  },
  storyStickerTitle: {
    marginTop: 31,
    color: "#050505",
    fontSize: 50,
    lineHeight: 56,
    fontWeight: "800",
    letterSpacing: 0,
  },
  storyStickerArtist: {
    color: "#101014",
    fontSize: 44,
    lineHeight: 54,
    fontWeight: "400",
    letterSpacing: 0,
  },
  storyStickerBrand: {
    marginTop: 22,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  storyStickerBrandText: {
    color: "#BCBEC4",
    fontSize: 36,
    lineHeight: 42,
    fontWeight: "700",
    letterSpacing: 0,
  },
  lumenWaveform: {
    width: 44,
    height: 36,
  },
  lumenWaveformSegment: {
    position: "absolute",
    height: 5,
    borderRadius: 3,
    backgroundColor: "#BCBEC4",
    transformOrigin: "left center",
  },
  timeRow: {
    flexDirection: "row",
    justifyContent: "space-between",
  },
  previewButton: {
    minHeight: 44,
    borderRadius: 12,
    borderCurve: "continuous",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  linkBox: {
    borderWidth: StyleSheet.hairlineWidth,
    borderCurve: "continuous",
  },
  button: {
    minHeight: 52,
    width: "100%",
    borderRadius: 14,
    borderCurve: "continuous",
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
});
