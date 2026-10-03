import { ScrollView, StyleSheet, Text, View } from "react-native";
import { useQuery } from "@tanstack/react-query";
import { Stack, useLocalSearchParams } from "expo-router";
import {
  api,
  displayText,
  formatBitrate,
  formatCalendarDate,
  formatSampleRate,
  tidalAudioRows,
  tidalTrackCredits,
  trackCredits,
  useAuth,
} from "@music-library/core";
import { CoverArt } from "../../../../components/cover-art";
import { EmptyState } from "../../../../components/empty-state";
import { Card, SectionLabel } from "../../../../components/primitives";
import { formatBytes, formatDurationMs } from "../../../../lib/format";
import { qk } from "../../../../lib/query-keys";
import { useTheme, type ThemeTokens } from "../../../../theme/theme";

export default function TrackInfoScreen() {
  const theme = useTheme();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { me } = useAuth();
  const userId = me?.id;

  const trackQuery = useQuery({
    queryKey: qk.track(userId, id),
    queryFn: ({ signal }) => api.getTrack(id!, { signal }),
    enabled: !!userId && !!id,
  });
  // A TIDAL track's row stores little, so the rest comes live from TIDAL on
  // each visit. Without it the screen shows what the row has.
  const tidalId =
    trackQuery.data?.source === "tidal" ? trackQuery.data.source_id : undefined;
  const tidalQuery = useQuery({
    queryKey: qk.tidalTrack(userId, tidalId),
    queryFn: ({ signal }) => api.getTidalTrack(tidalId!, { signal }),
    enabled: !!userId && !!tidalId,
    // One fresh fetch per visit: nothing kept from the last visit to show
    // in its place, and no background refetch to fail behind a good answer.
    gcTime: 0,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    // Show the stored fields rather than wait on a second slow attempt.
    retry: false,
  });

  if (trackQuery.isLoading || tidalQuery.isLoading) {
    return <EmptyState fill loading />;
  }
  if (trackQuery.isError || !trackQuery.data) {
    return <EmptyState fill message="Couldn't load track." />;
  }

  const t = trackQuery.data;
  const isTidal = t.source === "tidal";
  const tidal =
    tidalId && !tidalQuery.isError && tidalQuery.data?.id === tidalId ? tidalQuery.data : null;
  // An error, or no answer at all (a paused query while offline).
  const tidalFailed = !!tidalId && !tidal;
  const credits = tidal ? tidalTrackCredits(t, tidal) : trackCredits(t);

  return (
    <>
      <Stack.Screen options={{ title: "Track Info" }} />
      <ScrollView
        style={{ flex: 1, backgroundColor: theme.color.bg }}
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{
          paddingHorizontal: theme.space.lg,
          paddingVertical: theme.space.xl,
          alignItems: "center",
          gap: theme.space.lg,
        }}
      >
        <CoverArt
          track={{ id: t.id, album_id: t.album_id, cover_url: t.cover_url, has_cover: t.has_cover }}
          size={200}
        />
        <View style={{ alignItems: "center", gap: 4 }}>
          <Text
            style={{
              fontSize: 20,
              fontWeight: "700",
              color: theme.color.fg,
              textAlign: "center",
            }}
            numberOfLines={3}
          >
            {displayText(t.title)}
          </Text>
          {t.album_title ? (
            <Text
              style={{ fontSize: 15, color: theme.color.fgMuted }}
              numberOfLines={2}
            >
              {displayText(t.album_title)}
            </Text>
          ) : null}
        </View>

        {tidalFailed ? (
          <Note theme={theme}>{"Couldn't load more from TIDAL, so some fields are missing."}</Note>
        ) : null}

        <InfoBlock title="Credits">
          {credits.map((credit) => (
            <InfoRow key={credit.label} label={credit.label} value={credit.value} theme={theme} lines={4} />
          ))}
        </InfoBlock>
        {tidal?.credits_failed ? (
          <Note theme={theme} under>
            {tidal.credits_failure ?? "Couldn't load credits from TIDAL."}
          </Note>
        ) : null}

        <InfoBlock title="Details">
          <InfoRow label="Duration" value={formatDurationMs(t.duration_ms)} theme={theme} />
          {typeof t.track_no === "number" ? (
            <InfoRow label="Track" value={String(t.track_no)} theme={theme} />
          ) : null}
          {typeof t.disc_no === "number" ? (
            <InfoRow label="Disc" value={String(t.disc_no)} theme={theme} />
          ) : null}
          {tidal?.release_date ? (
            <InfoRow label="Released" value={formatCalendarDate(tidal.release_date)} theme={theme} />
          ) : t.year ? (
            <InfoRow label="Year" value={String(t.year)} theme={theme} />
          ) : null}
          {t.genre ? (
            <InfoRow label="Genre" value={t.genre} theme={theme} />
          ) : null}
          {tidal?.bpm ? (
            <InfoRow label="BPM" value={String(tidal.bpm)} theme={theme} />
          ) : null}
          {tidal?.key ? <InfoRow label="Key" value={tidal.key} theme={theme} /> : null}
          {tidal?.isrc ? <InfoRow label="ISRC" value={tidal.isrc} theme={theme} /> : null}
          {tidal?.copyright ? (
            <InfoRow label="Copyright" value={tidal.copyright} theme={theme} lines={4} />
          ) : null}
          {isTidal ? (
            // A stream, not a file: what this server streams it at, and no
            // file size.
            <>
              <InfoRow label="Source" value="TIDAL" theme={theme} />
              {tidalAudioRows(tidal).map((row) => (
                <InfoRow key={row.label} label={row.label} value={row.value} theme={theme} />
              ))}
              {tidal?.channels ? (
                <InfoRow label="Channels" value={String(tidal.channels)} theme={theme} />
              ) : null}
            </>
          ) : (
            <>
              <InfoRow label="Format" value={t.format} theme={theme} />
              {t.bitrate ? (
                <InfoRow label="Bitrate" value={formatBitrate(t.bitrate)} theme={theme} />
              ) : null}
              {t.sample_rate ? (
                <InfoRow label="Sample rate" value={formatSampleRate(t.sample_rate)} theme={theme} />
              ) : null}
              {t.channels ? (
                <InfoRow
                  label="Channels"
                  value={String(t.channels)}
                  theme={theme}
                />
              ) : null}
              <InfoRow label="File size" value={formatBytes(t.file_size)} theme={theme} />
            </>
          )}
        </InfoBlock>
      </ScrollView>
    </>
  );
}

function InfoBlock({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <View style={{ width: "100%", gap: 6 }}>
      <SectionLabel style={{ paddingHorizontal: 4 }}>{title}</SectionLabel>
      <Card style={{ overflow: "hidden" }}>{children}</Card>
    </View>
  );
}

function Note({
  children,
  theme,
  under,
}: {
  children: React.ReactNode;
  theme: ThemeTokens;
  /** Sits under the block it's about rather than a full gap away. */
  under?: boolean;
}) {
  return (
    <Text
      style={{
        alignSelf: "stretch",
        paddingHorizontal: 4,
        marginTop: under ? -theme.space.sm : 0,
        fontSize: 13,
        color: theme.color.fgMuted,
      }}
    >
      {children}
    </Text>
  );
}

function InfoRow({
  label,
  value,
  theme,
  lines = 2,
}: {
  label: string;
  value: string;
  theme: ThemeTokens;
  /** Long credit lists and copyright lines get more room. */
  lines?: number;
}) {
  return (
    <View
      style={{
        paddingHorizontal: 14,
        paddingVertical: 10,
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: theme.color.separator,
        flexDirection: "row",
        justifyContent: "space-between",
        alignItems: "center",
        gap: 10,
      }}
    >
      <Text style={{ color: theme.color.fgMuted, fontSize: 14 }}>{label}</Text>
      <Text
        style={{
          color: theme.color.fg,
          fontSize: 14,
          flexShrink: 1,
          textAlign: "right",
        }}
        numberOfLines={lines}
      >
        {value}
      </Text>
    </View>
  );
}
