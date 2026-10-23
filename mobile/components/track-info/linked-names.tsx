import { Fragment, useState } from "react";
import { Text } from "react-native";
import {
  isTrackInfoLink,
  type TrackInfoLink,
  type TrackInfoName,
} from "@music-library/core";
import { useTheme, withAlpha } from "../../theme/theme";

/**
 * Names as inline text, ", " between them, each name with a page a link of
 * its own. Render inside a `<Text>`, which sets the font and color: a link
 * keeps them and adds a faint underline, which a press turns full strength
 * over a pill of fill. Names without a page stay plain.
 */
export function LinkedNames({
  names,
  color,
  onOpen,
}: {
  names: readonly TrackInfoName[];
  /** The surrounding text's color, which the underline is drawn from. */
  color: string;
  onOpen: (link: TrackInfoLink) => void;
}) {
  return names.map((name, i) => (
    <Fragment key={`${i}:${name.name}`}>
      {i > 0 ? ", " : null}
      {isTrackInfoLink(name) ? (
        <LinkSpan link={name} color={color} onOpen={onOpen} />
      ) : (
        name.name
      )}
    </Fragment>
  ));
}

function LinkSpan({
  link,
  color,
  onOpen,
}: {
  link: TrackInfoLink;
  color: string;
  onOpen: (link: TrackInfoLink) => void;
}) {
  const theme = useTheme();
  const [pressed, setPressed] = useState(false);
  return (
    <Text
      accessibilityRole="link"
      // The pill below is the press feedback; iOS's own gray box would sit
      // on top of it.
      suppressHighlighting
      onPress={() => onOpen(link)}
      onPressIn={() => setPressed(true)}
      onPressOut={() => setPressed(false)}
      style={{
        textDecorationLine: "underline",
        textDecorationColor: pressed ? color : withAlpha(color, 0.38),
        backgroundColor: pressed ? theme.color.overlayMuted : undefined,
      }}
    >
      {link.name}
    </Text>
  );
}
