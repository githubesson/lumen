import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  api,
  fisherYatesWithAnchor,
  useAuth,
  type Playlist,
} from "@music-library/core";

import {
  useCurrentTrack,
  usePlayerControls,
  usePlayerPlayback,
} from "../context/player";
import {
  loadDefaultSiriMediaQueue,
  loadSiriMediaQueue,
  resolveSiriMediaRequest,
  trackSiriMediaItem,
} from "../lib/siri-media";
import { diagnosticsLog } from "../lib/diagnostics/log";
import { isTrackPlayableOffline } from "../lib/offline-mode";
import { qk } from "../lib/query-keys";
import { QUERY_STALE_TIME } from "../lib/query-policy";
import {
  addSiriPlayMediaRequestListener,
  completeSiriMediaPlayback,
  completeSiriMediaResolution,
  donateSiriPlayback,
  getPendingSiriMediaRequests,
  isSiriMediaAvailable,
  requestSiriAuthorization,
  setSiriPlaylistVocabulary,
  siriAuthorizationStatus,
  type SiriAuthorizationStatus,
  type SiriPlaybackResult,
  type SiriPlayMediaRequest,
} from "../modules/siri-media";

const JS_REQUEST_TIMEOUT_MS = 25_000;
const PLAYER_HANDOFF_DELAY_MS = 350;
const MAX_HANDLED_REQUESTS = 100;

function requestTitle(request: SiriPlayMediaRequest) {
  return (
    request.mediaName ??
    request.mediaContainer?.title ??
    request.mediaItems[0]?.title
  );
}

function waitForPlayerHandoff() {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, PLAYER_HANDOFF_DELAY_MS);
  });
}

/**
 * Headless bridge between SiriKit and the authenticated React player.
 *
 * Native requests may arrive before React has mounted during a background
 * launch, so the module retains them and this component drains that queue
 * after installing its live listener.
 */
export function SiriMediaBridge() {
  const { status, me } = useAuth();
  const controls = usePlayerControls();
  const current = useCurrentTrack();
  const { isPlaying, shuffle } = usePlayerPlayback();
  const handledRef = useRef(new Set<string>());
  const lastDonationRef = useRef<string | null>(null);
  const [authorization, setAuthorization] = useState<SiriAuthorizationStatus>(
    () => siriAuthorizationStatus(),
  );
  const available = isSiriMediaAvailable();

  const playlistsQuery = useQuery({
    queryKey: qk.playlists(me?.id),
    queryFn: ({ signal }) => api.listPlaylists({ signal }),
    enabled: available && authorization === "authorized" && status === "authed",
    staleTime: QUERY_STALE_TIME.default,
  });

  useEffect(() => {
    if (!available || status !== "authed") return;
    if (authorization !== "notDetermined") return;
    void requestSiriAuthorization().then(setAuthorization);
  }, [authorization, available, status]);

  useEffect(() => {
    const playlists = playlistsQuery.data;
    if (!playlists?.length) return;
    void setSiriPlaylistVocabulary(
      playlists.map((playlist: Playlist) => playlist.name),
    );
  }, [playlistsQuery.data]);

  const rememberRequest = useCallback((requestId: string) => {
    const handled = handledRef.current;
    if (handled.has(requestId)) return false;
    handled.add(requestId);
    if (handled.size > MAX_HANDLED_REQUESTS) {
      handled.delete(handled.values().next().value!);
    }
    return true;
  }, []);

  const handleRequest = useCallback(
    async (request: SiriPlayMediaRequest) => {
      // Auth hydration is normally quick. Leave the request in native pending
      // storage and let the effect below drain it again on the next render.
      if (status === "loading") return;
      if (!rememberRequest(request.requestId)) return;

      const requestedTitle = requestTitle(request);
      diagnosticsLog.append({
        scope: "siri",
        level: "info",
        event: "siri-request",
        message: `${request.phase} request received (${request.mediaType})`,
        title: requestedTitle,
      });

      if (status !== "authed") {
        diagnosticsLog.append({
          scope: "siri",
          level: "warn",
          event: "siri-auth-required",
          message: "Siri playback reached Lumen without an authenticated session.",
          title: requestedTitle,
        });
        if (request.phase === "resolve") {
          await completeSiriMediaResolution(request.requestId, []);
        } else {
          await completeSiriMediaPlayback(
            request.requestId,
            "requiresAppLaunch",
          );
        }
        return;
      }

      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(),
        JS_REQUEST_TIMEOUT_MS,
      );

      try {
        if (request.phase === "resolve") {
          const matches = await resolveSiriMediaRequest(
            request,
            controller.signal,
          );
          diagnosticsLog.append({
            scope: "siri",
            level: matches.length ? "info" : "warn",
            event: matches.length ? "siri-resolved" : "siri-no-match",
            message: `Siri resolution returned ${matches.length} match${matches.length === 1 ? "" : "es"}.`,
            title: requestedTitle,
          });
          await completeSiriMediaResolution(request.requestId, matches);
          return;
        }

        const hasRequestedMedia = Boolean(
          request.mediaName ||
            request.mediaIdentifier ||
            request.mediaItems.length ||
            request.mediaContainer,
        );
        if (!hasRequestedMedia && current && !request.playShuffled) {
          const result: SiriPlaybackResult = current ? "success" : "noContent";
          controls.resume();
          await waitForPlayerHandoff();
          diagnosticsLog.append({
            scope: "siri",
            level: "info",
            event: "siri-resumed",
            message: "Siri resumed the current queue.",
            trackId: current.id,
            title: current.title,
          });
          await completeSiriMediaPlayback(request.requestId, result);
          return;
        }

        const [entity] = hasRequestedMedia
          ? await resolveSiriMediaRequest(request, controller.signal)
          : [];
        if (hasRequestedMedia && !entity) {
          diagnosticsLog.append({
            scope: "siri",
            level: "warn",
            event: "siri-no-match",
            message: "No catalog item matched the Siri request.",
            title: requestedTitle,
          });
          await completeSiriMediaPlayback(request.requestId, "unsupported");
          return;
        }
        const loadedQueue = entity
          ? await loadSiriMediaQueue(entity, controller.signal)
          : await loadDefaultSiriMediaQueue(controller.signal);
        const playableQueue = loadedQueue.filter((track) =>
          isTrackPlayableOffline(track.id),
        );
        if (!playableQueue.length) {
          diagnosticsLog.append({
            scope: "siri",
            level: "warn",
            event: "siri-empty-queue",
            message: "The matched Siri item had no playable tracks.",
            title: entity?.title ?? requestedTitle,
          });
          await completeSiriMediaPlayback(request.requestId, "noContent");
          return;
        }

        // Match the established CarPlay shuffle handoff: pre-shuffle before
        // enabling the mode because both state updates happen in one render.
        const queue = request.playShuffled
          ? fisherYatesWithAnchor(playableQueue, null)
          : playableQueue;
        if (request.playShuffled && !shuffle) controls.setShuffle(true);
        controls.play(queue[0], queue);
        // Let React commit the queue and activate the native audio session
        // before reporting `.success` to SiriKit.
        await waitForPlayerHandoff();

        diagnosticsLog.append({
          scope: "siri",
          level: "info",
          event: "siri-playback-started",
          message: `Siri handed ${queue.length} track${queue.length === 1 ? "" : "s"} to the player.`,
          trackId: queue[0].id,
          title: queue[0].title,
          source: entity?.type,
        });

        const container = !entity || entity.type === "song" ? null : entity;
        void donateSiriPlayback(
          trackSiriMediaItem(queue[0]),
          container,
          request.playShuffled === true,
        );
        await completeSiriMediaPlayback(request.requestId, "success");
      } catch (error) {
        diagnosticsLog.append({
          scope: "siri",
          level: "error",
          event: "siri-playback-error",
          message:
            error instanceof Error
              ? error.message
              : "Unknown Siri playback failure.",
          title: requestedTitle,
        });
        if (request.phase === "resolve") {
          await completeSiriMediaResolution(request.requestId, []);
        } else {
          await completeSiriMediaPlayback(request.requestId, "failure");
        }
      } finally {
        clearTimeout(timeout);
      }
    },
    [controls, current, rememberRequest, shuffle, status],
  );

  useEffect(() => {
    if (!available) return;
    const subscription = addSiriPlayMediaRequestListener((request) => {
      void handleRequest(request);
    });
    void getPendingSiriMediaRequests().then((requests) => {
      for (const request of requests) void handleRequest(request);
    });
    return () => {
      subscription.remove();
    };
  }, [available, handleRequest]);

  useEffect(() => {
    if (authorization !== "authorized" || !current || !isPlaying) return;
    const donationKey = `${current.id}:${shuffle}`;
    if (lastDonationRef.current === donationKey) return;
    lastDonationRef.current = donationKey;
    void donateSiriPlayback(trackSiriMediaItem(current), null, shuffle);
  }, [authorization, current, isPlaying, shuffle]);

  return null;
}
