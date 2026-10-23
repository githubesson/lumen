import { StyleSheet, Text, View } from "react-native";
import {
  isTrackInfoLink,
  type TrackInfoLink,
  type TrackInfoRow,
  type TrackInfoSection,
} from "@music-library/core";
import { Card, SectionLabel } from "../primitives";
import { trackInfoGridLines } from "../../lib/track-info";
import { useTheme, type ThemeTokens } from "../../theme/theme";
import { LinkedNames } from "./linked-names";

/**
 * One section of Track Info as a two-column grid of label-over-value cells,
 * hairlines between them. A wide row spans both columns.
 */
export function InfoGrid({
  section,
  onOpen,
}: {
  section: TrackInfoSection;
  onOpen: (link: TrackInfoLink) => void;
}) {
  const theme = useTheme();
  return (
    <View style={{ gap: 6 }}>
      <SectionLabel style={{ paddingHorizontal: 4 }}>{section.label}</SectionLabel>
      <Card style={{ overflow: "hidden" }}>
        {trackInfoGridLines(section.rows).map((line, i) => (
          <View
            key={`${i}:${line.cells[0].label}`}
            style={[
              styles.line,
              i > 0 && {
                borderTopWidth: StyleSheet.hairlineWidth,
                borderTopColor: theme.color.separator,
              },
            ]}
          >
            {line.cells.map((row, column) => (
              <View
                key={row?.label ?? "empty"}
                style={[
                  styles.cell,
                  column > 0 && {
                    borderLeftWidth: StyleSheet.hairlineWidth,
                    borderLeftColor: theme.color.separator,
                  },
                ]}
              >
                {row ? (
                  <Cell
                    row={row}
                    // Every credited name should stay reachable.
                    lines={section.key === "credits" ? undefined : 4}
                    theme={theme}
                    onOpen={onOpen}
                  />
                ) : null}
              </View>
            ))}
          </View>
        ))}
      </Card>
    </View>
  );
}

function Cell({
  row,
  lines,
  theme,
  onOpen,
}: {
  row: TrackInfoRow;
  lines?: number;
  theme: ThemeTokens;
  onOpen: (link: TrackInfoLink) => void;
}) {
  const color = row.empty ? theme.color.fgMuted : theme.color.fg;
  return (
    <>
      <Text style={{ color: theme.color.fgMuted, fontSize: 12, lineHeight: 16 }}>
        {row.label}
      </Text>
      <Text
        style={{ color, fontSize: 15, lineHeight: 20, marginTop: 2 }}
        numberOfLines={lines}
      >
        {row.names?.some(isTrackInfoLink) ? (
          <LinkedNames names={row.names} color={color} onOpen={onOpen} />
        ) : (
          row.value
        )}
      </Text>
    </>
  );
}

const styles = StyleSheet.create({
  line: {
    flexDirection: "row",
  },
  cell: {
    flex: 1,
    minWidth: 0,
    paddingHorizontal: 14,
    paddingTop: 10,
    paddingBottom: 11,
  },
});
