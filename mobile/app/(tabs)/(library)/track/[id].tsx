import { ScrollView, StyleSheet, Text, View } from "react-native";
import { useQuery } from "@tanstack/react-query";
import { Stack, useLocalSearchParams } from "expo-router";
import { api, useAuth } from "@music-library/core";
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

  if (trackQuery.isLoading) {
    return <EmptyState fill loading />;
  }
  if (trackQuery.isError || !trackQuery.data) {
    return <EmptyState fill message="Couldn't load track." />;
  }

  const t = trackQuery.data;

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
        <CoverArt track={{ id: t.id, album_id: t.album_id }} size={200} />
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
            {t.title}
          </Text>
          {t.album_title ? (
            <Text
              style={{ fontSize: 15, color: theme.color.fgMuted }}
              numberOfLines={2}
            >
              {t.album_title}
            </Text>
          ) : null}
        </View>

        <InfoBlock title="Artists" theme={theme}>
          {t.artists.length === 0 ? (
            <InfoRow label="—" value="" theme={theme} />
          ) : (
            t.artists.map((a) => (
              <InfoRow key={a.id} label={a.role} value={a.name} theme={theme} />
            ))
          )}
        </InfoBlock>

        <InfoBlock title="Details" theme={theme}>
          <InfoRow label="Duration" value={formatDurationMs(t.duration_ms)} theme={theme} />
          {typeof t.track_no === "number" ? (
            <InfoRow label="Track" value={String(t.track_no)} theme={theme} />
          ) : null}
          {typeof t.disc_no === "number" ? (
            <InfoRow label="Disc" value={String(t.disc_no)} theme={theme} />
          ) : null}
          {t.year ? (
            <InfoRow label="Year" value={String(t.year)} theme={theme} />
          ) : null}
          {t.genre ? (
            <InfoRow label="Genre" value={t.genre} theme={theme} />
          ) : null}
          <InfoRow label="Format" value={t.format} theme={theme} />
          {t.bitrate ? (
            <InfoRow
              label="Bitrate"
              value={`${Math.round(t.bitrate / 1000)} kbps`}
              theme={theme}
            />
          ) : null}
          {t.sample_rate ? (
            <InfoRow
              label="Sample rate"
              value={`${(t.sample_rate / 1000).toFixed(1)} kHz`}
              theme={theme}
            />
          ) : null}
          {t.channels ? (
            <InfoRow
              label="Channels"
              value={String(t.channels)}
              theme={theme}
            />
          ) : null}
          <InfoRow label="File size" value={formatBytes(t.file_size)} theme={theme} />
        </InfoBlock>
      </ScrollView>
    </>
  );
}

function InfoBlock({
  title,
  children,
  theme,
}: {
  title: string;
  children: React.ReactNode;
  theme: ThemeTokens;
}) {
  return (
    <View style={{ width: "100%", gap: 6 }}>
      <SectionLabel style={{ paddingHorizontal: 4 }}>{title}</SectionLabel>
      <Card style={{ overflow: "hidden" }}>{children}</Card>
    </View>
  );
}

function InfoRow({
  label,
  value,
  theme,
}: {
  label: string;
  value: string;
  theme: ThemeTokens;
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
        numberOfLines={2}
      >
        {value}
      </Text>
    </View>
  );
}
