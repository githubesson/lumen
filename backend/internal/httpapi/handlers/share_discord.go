package handlers

import (
	"bytes"
	"encoding/json"
	"strconv"
	"strings"
	"unicode/utf8"
)

// Discord renders a share link as a "component embed" when the page carries a
// <script id="discord:component-embed" type="application/json"> payload
// (https://docs.discord.com/developers/link-previews/component-embeds). It
// replaces the plain Open Graph card with a layout we control: the app icon
// as thumbnail, title, the preview video, and link buttons that open the
// clip downloads in the browser. (Discord renders a Section's accessory on
// the right; the format has no slot for an image on the left.) The Open Graph tags stay on the page as the
// fallback for every other scraper, and for Discord when the payload fails
// validation.
//
// Discord fetches the payload once, when the link is posted, and keeps it
// for the lifetime of the message. Every URL in it therefore has to be the
// long-lived share-signed form, never an expiring one.

// discordComponentEmbedMaxBytes is Discord's payload cap, measured on the
// serialized JSON including escape sequences.
const discordComponentEmbedMaxBytes = 3000

// Discord component type ids.
const (
	discordComponentActionRow    = 1
	discordComponentButton       = 2
	discordComponentSection      = 9
	discordComponentTextDisplay  = 10
	discordComponentThumbnail    = 11
	discordComponentMediaGallery = 12
	discordComponentSeparator    = 14
	discordComponentContainer    = 17
)

// discordButtonStyleLink is the only button style link previews accept.
const discordButtonStyleLink = 5

type discordComponent struct {
	Type        int                `json:"type"`
	AccentColor *int               `json:"accent_color,omitempty"`
	Components  []discordComponent `json:"components,omitempty"`
	Accessory   *discordComponent  `json:"accessory,omitempty"`
	Content     string             `json:"content,omitempty"`
	Media       *discordMedia      `json:"media,omitempty"`
	Items       []discordMediaItem `json:"items,omitempty"`
	Style       int                `json:"style,omitempty"`
	URL         string             `json:"url,omitempty"`
	Label       string             `json:"label,omitempty"`
	Spacing     int                `json:"spacing,omitempty"`
}

type discordMedia struct {
	URL string `json:"url"`
}

type discordMediaItem struct {
	Media       discordMedia `json:"media"`
	Description string       `json:"description,omitempty"`
}

type discordComponentEmbed struct {
	Component discordComponent `json:"component"`
}

// discordEmbedLevel selects how much of the card to emit. Level 0 is the full
// card; each higher level drops something so the payload fits under the cap
// for tracks with very long titles or hosts with very long names.
type discordEmbedLevel int

const (
	discordEmbedFull discordEmbedLevel = iota
	discordEmbedShortText
	discordEmbedNoSubtitle
	discordEmbedNoOpenButton
	discordEmbedLevels
)

// buildDiscordComponentEmbed returns the serialized payload, or ok=false when
// no variant fits under Discord's cap (the page then relies on Open Graph).
// The output is HTML-escaped by encoding/json, so "</script>" inside a title
// cannot terminate the script element it is written into.
func buildDiscordComponentEmbed(m shareMeta) (payload []byte, ok bool) {
	if m.VideoURL == "" || m.Landing == "" {
		return nil, false
	}
	for level := discordEmbedFull; level < discordEmbedLevels; level++ {
		embed := discordComponentEmbedFor(m, level)
		var buf bytes.Buffer
		enc := json.NewEncoder(&buf)
		if err := enc.Encode(embed); err != nil {
			return nil, false
		}
		out := bytes.TrimRight(buf.Bytes(), "\n")
		if len(out) <= discordComponentEmbedMaxBytes {
			return out, true
		}
	}
	return nil, false
}

func discordComponentEmbedFor(m shareMeta, level discordEmbedLevel) discordComponentEmbed {
	title := strings.TrimSpace(m.Title)
	if title == "" {
		title = "Untitled track"
	}
	artist := strings.TrimSpace(m.Artist)
	album := strings.TrimSpace(m.Album)
	if level >= discordEmbedShortText {
		title = truncateRunes(title, 80)
		artist = truncateRunes(artist, 40)
		album = truncateRunes(album, 40)
	}

	var text strings.Builder
	text.WriteString(discordHeading(title))
	if level < discordEmbedNoSubtitle {
		subtitle := artist
		if album != "" {
			if subtitle != "" {
				subtitle += " · " + album
			} else {
				subtitle = album
			}
		}
		if subtitle != "" {
			// Subtext ("-# ") is Discord's small secondary line. Starting the
			// line with it also keeps an artist called "# 1" or "> Yes" from
			// turning into a heading or a quote.
			text.WriteString("\n-# ")
			text.WriteString(escapeDiscordMarkdown(subtitle))
		}
	}

	heading := discordComponent{
		Type: discordComponentSection,
		Components: []discordComponent{{
			Type:    discordComponentTextDisplay,
			Content: text.String(),
		}},
	}
	// A Section needs an accessory: the app icon as a thumbnail. Without one
	// (the page was rendered with no icon URL) the Open button takes its
	// place so the layout still validates.
	if m.IconURL != "" {
		heading.Accessory = &discordComponent{
			Type:  discordComponentThumbnail,
			Media: &discordMedia{URL: m.IconURL},
		}
	} else {
		heading.Accessory = &discordComponent{
			Type:  discordComponentButton,
			Style: discordButtonStyleLink,
			URL:   m.Landing,
			Label: "Open",
		}
	}

	gallery := discordComponent{
		Type: discordComponentMediaGallery,
		Items: []discordMediaItem{{
			Media:       discordMedia{URL: m.VideoURL},
			Description: discordClipDescription(m.DurationSec),
		}},
	}

	buttons := make([]discordComponent, 0, 3)
	if m.IconURL != "" && level < discordEmbedNoOpenButton {
		buttons = append(buttons, discordComponent{
			Type:  discordComponentButton,
			Style: discordButtonStyleLink,
			URL:   m.Landing,
			Label: "Open in Lumen",
		})
	}
	if m.VideoDownloadURL != "" {
		buttons = append(buttons, discordComponent{
			Type:  discordComponentButton,
			Style: discordButtonStyleLink,
			URL:   m.VideoDownloadURL,
			Label: "Download video",
		})
	}
	if m.AudioDownloadURL != "" {
		buttons = append(buttons, discordComponent{
			Type:  discordComponentButton,
			Style: discordButtonStyleLink,
			URL:   m.AudioDownloadURL,
			Label: "Download audio",
		})
	}

	children := []discordComponent{heading, gallery}
	if len(buttons) > 0 {
		children = append(children,
			discordComponent{Type: discordComponentSeparator, Spacing: 1},
			discordComponent{Type: discordComponentActionRow, Components: buttons},
		)
	}

	container := discordComponent{
		Type:       discordComponentContainer,
		Components: children,
	}
	if c, ok := discordAccentColor(m.ThemeColor); ok {
		container.AccentColor = &c
	}
	return discordComponentEmbed{Component: container}
}

func discordClipDescription(durationSec int) string {
	if durationSec <= 0 {
		return "Preview clip"
	}
	return strconv.Itoa(durationSec) + "-second preview clip"
}

// discordAccentColor converts the share page's "#rrggbb" theme color into
// the integer Discord expects.
func discordAccentColor(hex string) (int, bool) {
	hex = strings.TrimPrefix(strings.TrimSpace(hex), "#")
	if len(hex) != 6 {
		return 0, false
	}
	v, err := strconv.ParseUint(hex, 16, 32)
	if err != nil {
		return 0, false
	}
	return int(v), true
}

// discordHeading renders the card's "## Title" line as plain text. It used
// to be a markdown link to the landing page, but Discord sometimes refuses
// to render a masked link and then shows the raw "[Title](https://...)"
// instead; the "Open in Lumen" button is the click target.
func discordHeading(title string) string {
	return "## " + escapeDiscordMarkdown(title)
}

// escapeDiscordMarkdown backslash-escapes the inline characters Discord's
// markdown lets a backslash neutralise (emphasis, strikethrough, code,
// spoilers), so a title like "*NSYNC" renders literally. Discord shows the
// backslash itself for anything else, brackets included, so nothing more is
// escaped here; a title like "Song [Live]" is plain text in a heading anyway. Line breaks collapse to spaces: a newline inside the heading
// would end it.
func escapeDiscordMarkdown(s string) string {
	var b strings.Builder
	b.Grow(len(s) + 8)
	for _, r := range s {
		switch r {
		case '\\', '*', '_', '~', '`', '|':
			b.WriteByte('\\')
			b.WriteRune(r)
		case '\n', '\r', '\t':
			b.WriteByte(' ')
		default:
			b.WriteRune(r)
		}
	}
	return b.String()
}

func truncateRunes(s string, max int) string {
	if utf8.RuneCountInString(s) <= max {
		return s
	}
	runes := []rune(s)
	return strings.TrimSpace(string(runes[:max-1])) + "…"
}
