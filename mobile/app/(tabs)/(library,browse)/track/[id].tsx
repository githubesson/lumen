import { Fragment } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { useQuery } from "@tanstack/react-query";
import { Stack, useLocalSearchParams } from "expo-router";
import {
  api,
  displayText,
  tidalTrackInfoResult,
  trackInfoRows,
  trackInfoTidalId,
  useAuth,
} from "@music-library/core";
import { CoverArt } from "../../../../components/cover-art";
import { EmptyState } from "../../../../components/empty-state";
import { Card, SectionLabel } from "../../../../components/primitives";
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
  const tidalId = trackInfoTidalId(trackQuery.data);
  const tidalQuery = useQuery({
    queryKey: qk.tidalTrack(userId, tidalId ?? undefined),
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
  // TIDAL's answer counts only when this visit's fetch got one: a failed
  // fetch keeps the last answer beside its error, and a paused one (offline)
  // has none.
  const view = trackInfoRows(
    t,
    tidalTrackInfoResult(
      tidalId,
      tidalQuery.data,
      tidalQuery.isError ? tidalQuery.error : null,
    ),
  );

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

        {view.note ? <Note theme={theme}>{view.note}</Note> : null}

        {view.sections.map((section) => (
          <Fragment key={section.key}>
            {section.rows.length > 0 ? (
              <InfoBlock title={section.label}>
                {section.rows.map((row) => (
                  <InfoRow
                    key={row.label}
                    label={row.label}
                    value={row.value}
                    empty={row.empty}
                    // Credit lists, comments and copyright lines run long.
                    lines={section.key === "credits" || row.wide ? 4 : 2}
                    theme={theme}
                  />
                ))}
              </InfoBlock>
            ) : null}
            {section.note ? (
              <Note theme={theme} under={section.rows.length > 0}>
                {section.note}
              </Note>
            ) : null}
          </Fragment>
        ))}
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
  empty,
  theme,
  lines = 2,
}: {
  label: string;
  value: string;
  /** The value is a "—" for nothing to show; it's faded. */
  empty?: boolean;
  theme: ThemeTokens;
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
          color: empty ? theme.color.fgMuted : theme.color.fg,
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
