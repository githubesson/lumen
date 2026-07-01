import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  ScrollView,
  StyleSheet,
  Text,
  View,
  Share as NativeShare,
} from "react-native";
import { useAudioPlayer, useAudioPlayerStatus } from "expo-audio";
import * as Clipboard from "expo-clipboard";
import Constants from "expo-constants";
import { Directory, File, Paths } from "expo-file-system";
import * as Haptics from "expo-haptics";
import * as ImagePicker from "expo-image-picker";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
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
} from "@music-library/core";
import { ShareActionButton } from "../components/share/share-action-button";
import { ShareLinkBox } from "../components/share/share-link-box";
import { SnippetPanel } from "../components/share/snippet-panel";
import { StoryBackgroundCropEditor } from "../components/share/story-background-crop-editor";
import {
  initialStoryCrop,
  type PickedStoryBackground,
} from "../components/share/story-crop";
import { StoryShareMenuButton } from "../components/share/story-share-menu-button";
import {
  STORY_STICKER_CAPTURE_SCALE,
  STORY_STICKER_WIDTH,
  StoryStickerCapture,
  getStoryStickerHeight,
} from "../components/share/story-sticker-capture";
import { TrackHeader } from "../components/share/track-header";
import { qk } from "../lib/query-keys";
import { useTheme } from "../theme/theme";

const PREVIEW_DURATION_SEC = 30;
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

            <SnippetPanel
              durationSec={durationSec}
              startSec={startSec}
              endSec={endSec}
              currentSec={currentSec}
              maxStartSec={maxStartSec}
              picked={picked}
              playing={playerStatus.playing}
              onStartChange={onStartChange}
              onTogglePreview={() => void togglePreview()}
            />

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

            {shareUrl ? <ShareLinkBox url={shareUrl} /> : null}

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
              <ShareActionButton
                label={busy ? "Generating..." : "Share Link"}
                icon="square.and.arrow.up"
                disabled={!canShare}
                loading={busy}
                onPress={() => void shareLink()}
              />
              <ShareActionButton
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
});
