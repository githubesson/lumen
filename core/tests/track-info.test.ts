import { describe, expect, it } from "vitest";
import { formatBitrate, formatCalendarDate, formatDurationMs, formatSampleRate } from "../src/format";
import { trackCredits } from "../src/api-media";
import { ApiError, type TidalTrackInfo, type TrackDetail } from "../src/api";
import {
  tidalAudioRows,
  tidalRefusalMessage,
  tidalTrackCredits,
  tidalTrackInfoResult,
  trackInfoArtistAlbumId,
  trackInfoRows,
  trackInfoTidalId,
  type TrackInfoName,
} from "../src/tidal/track-info";

// What a row reads as, leaving out its names.
const values = (rows: { label: string; value: string }[] | undefined) =>
  rows?.map(({ label, value }) => ({ label, value }));
const tidalArtist = (name: string, id: string): TrackInfoName => ({ name, kind: "artist", source: "tidal", id });
const libraryArtist = (name: string, id: string): TrackInfoName => ({ name, kind: "artist", source: "local", id });

describe("track info formatters", () => {
  it("formats sample rates in kHz with at most one decimal", () => {
    expect(formatSampleRate(44_100)).toBe("44.1 kHz");
    expect(formatSampleRate(48_000)).toBe("48 kHz");
    expect(formatSampleRate(96_000)).toBe("96 kHz");
    expect(formatSampleRate(88_200)).toBe("88.2 kHz");
  });

  it("formats bitrates in kbps", () => {
    expect(formatBitrate(320_000)).toBe("320 kbps");
    expect(formatBitrate(1_411_200)).toBe("1411 kbps");
  });

  it("shows an em dash for unknown values", () => {
    for (const value of [undefined, null, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(formatSampleRate(value)).toBe("—");
      expect(formatBitrate(value)).toBe("—");
    }
    // Duration is metadata in track info, not a clock.
    expect(formatDurationMs(0, "—")).toBe("—");
  });
});

describe("trackCredits", () => {
  it("groups credits by role in a fixed order", () => {
    expect(
      trackCredits({
        artists: [
          { id: "1", name: "A", role: "primary" },
          { id: "2", name: "B", role: "primary" },
          { id: "3", name: "F", role: "featured" },
          { id: "4", name: "C", role: "composer" },
        ],
      }),
    ).toEqual([
      { label: "Primary artist", value: "A, B" },
      { label: "Featured", value: "F" },
      { label: "Producers", value: "C" },
    ]);
  });

  it("prefers the composer tag for producers", () => {
    expect(
      trackCredits({
        composer: "  Tag Writer ",
        artists: [{ id: "4", name: "C", role: "composer" }],
      })[2],
    ).toEqual({ label: "Producers", value: "Tag Writer" });
  });

  it("shows an em dash for missing credits", () => {
    expect(trackCredits({ artists: [], composer: " " }).map((row) => row.value)).toEqual([
      "—",
      "—",
      "—",
    ]);
    expect(trackCredits({}).map((row) => row.value)).toEqual(["—", "—", "—"]);
  });
});

describe("formatCalendarDate", () => {
  it("formats a calendar day without shifting it across time zones", () => {
    expect(formatCalendarDate("2023-03-17", "en-GB")).toBe("17 Mar 2023");
    expect(formatCalendarDate("1969-01-01", "en-US")).toBe("Jan 1, 1969");
  });

  it("shows an em dash for anything else", () => {
    for (const value of [undefined, null, "", "2023", "2023-02-30", "2023-03-17T00:00:00Z", "17/03/2023"]) {
      expect(formatCalendarDate(value)).toBe("—");
    }
  });
});

describe("tidalTrackCredits", () => {
  const info = (over: Partial<TidalTrackInfo> = {}): TidalTrackInfo => ({
    id: "1",
    artists: [
      { name: "Main", role: "main" },
      { name: "Co", role: "main" },
      { name: "Guest", role: "featured" },
    ],
    credits: [
      { role: "Composer", names: ["Writer"] },
      { role: "Producer", names: ["Maker"] },
      { role: "Mixing Engineer", names: ["Mixer"] },
      { role: "producer", names: ["Maker", "Second"] },
      { role: "A&R Administrator", names: ["Scout"] },
      { role: "Vocal", names: [] },
    ],
    ...over,
  });
  // How a TIDAL row stores artists: the first primary, the rest featured.
  const stored = {
    artists: [
      { id: "a", name: "Main", role: "primary" },
      { id: "b", name: "Co", role: "featured" },
    ],
  };

  it("uses TIDAL's artists and lists every role after the producers", () => {
    expect(values(tidalTrackCredits(stored, info()))).toEqual([
      { label: "Primary artist", value: "Main, Co" },
      { label: "Featured", value: "Guest" },
      { label: "Producers", value: "Maker, Second" },
      { label: "Composer", value: "Writer" },
      { label: "Mixing engineer", value: "Mixer" },
      { label: "A&R administrator", value: "Scout" },
    ]);
  });

  it("trusts TIDAL's split once it names a main artist", () => {
    const rows = tidalTrackCredits(stored, info({ artists: [{ name: "Main", role: "main" }] }));
    expect(rows[1]).toEqual({ label: "Featured", value: "—" });
  });

  it("falls back to the stored track for what TIDAL lacks", () => {
    const rows = tidalTrackCredits(stored, info({ artists: [], credits: [] }));
    expect(values(rows)).toEqual([
      { label: "Primary artist", value: "Main" },
      { label: "Featured", value: "Co" },
      { label: "Producers", value: "—" },
    ]);
    // The stored ids are the hidden rows', which have no page.
    expect(rows[0].names).toEqual([{ name: "Main" }]);
    expect(rows[1].names).toEqual([{ name: "Co" }]);
  });

  it("links each name TIDAL gives an artist id, and leaves the rest plain", () => {
    const rows = tidalTrackCredits(
      stored,
      info({
        artists: [
          { id: "9", name: "Main", role: "main" },
          { name: "Co", role: "main" },
          { id: "7", name: "Guest", role: "featured" },
        ],
        credits: [
          { role: "Producer", names: ["Maker", "Second"], contributors: [{ id: "24", name: "Maker" }, { name: "Second" }] },
          // The same person again, with their id this time.
          { role: "producer", names: ["Second"], contributors: [{ id: "18", name: "Second" }] },
          { role: "Composer", names: ["Writer"] },
        ],
      }),
    );
    expect(rows.map((row) => row.names)).toEqual([
      [tidalArtist("Main", "9"), { name: "Co" }],
      [tidalArtist("Guest", "7")],
      [tidalArtist("Maker", "24"), tidalArtist("Second", "18")],
      // An older server's credits are names alone.
      [{ name: "Writer" }],
    ]);
    expect(rows[2].value).toBe("Maker, Second");
  });
});

describe("tidalAudioRows", () => {
  const info = (over: Partial<TidalTrackInfo>): TidalTrackInfo => ({ id: "1", artists: [], credits: [], ...over });

  it("describes the stream being served", () => {
    expect(tidalAudioRows(info({ streamed_quality: "LOSSLESS", max_quality: "HI_RES_LOSSLESS" }))).toEqual([
      { label: "Format", value: "FLAC" },
      { label: "Quality", value: "Lossless" },
      { label: "Bit depth", value: "16-bit" },
      { label: "Sample rate", value: "44.1 kHz" },
    ]);
    expect(tidalAudioRows(info({ streamed_quality: "HI_RES_LOSSLESS" }))).toContainEqual({
      label: "Sample rate",
      value: "Up to 192 kHz",
    });
    expect(tidalAudioRows(info({ streamed_quality: "HIGH" }))).toEqual([
      { label: "Format", value: "AAC" },
      { label: "Quality", value: "Lossy" },
      { label: "Bitrate", value: "320 kbps" },
    ]);
  });

  it("shows only a ceiling before anything has streamed, since playback can fall back", () => {
    expect(tidalAudioRows(info({ max_quality: "LOSSLESS" }))).toEqual([
      { label: "Quality", value: "Up to Lossless (16-bit / 44.1 kHz FLAC)", wide: true },
    ]);
    expect(tidalAudioRows(info({ max_quality: "LOW" }))[0].value).toBe("Up to AAC 96 kbps");
  });

  it("knows nothing without a tier it recognizes", () => {
    for (const unknown of [null, info({}), info({ streamed_quality: "DOLBY_ATMOS" as never })]) {
      expect(tidalAudioRows(unknown)).toEqual([{ label: "Quality", value: "—", wide: false }]);
    }
  });
});

describe("tidalRefusalMessage", () => {
  it("passes on the server's text only for a TIDAL refusal", () => {
    const refusal = "TIDAL refused this track: Not available in your region";
    expect(tidalRefusalMessage(new ApiError(502, refusal))).toBe(refusal);
    expect(tidalRefusalMessage(new ApiError(502, "tidal track unavailable"))).toBeNull();
    expect(tidalRefusalMessage(new ApiError(500, refusal))).toBeNull();
    expect(tidalRefusalMessage(new Error(refusal))).toBeNull();
  });
});

describe("tidalTrackInfoResult", () => {
  const info: TidalTrackInfo = { id: "77", artists: [], credits: [] };

  it("asks TIDAL only about TIDAL tracks", () => {
    expect(trackInfoTidalId({ source: "tidal", source_id: "77" })).toBe("77");
    expect(trackInfoTidalId({ source: "tidal" })).toBeNull();
    expect(trackInfoTidalId({ source: "local", source_id: "77" })).toBeNull();
    expect(trackInfoTidalId(null)).toBeNull();
  });

  it("keeps details only for the track asked about", () => {
    expect(tidalTrackInfoResult("77", info)).toEqual({ info, failed: false, refusal: null });
    expect(tidalTrackInfoResult("78", info)).toEqual({ info: null, failed: true, refusal: null });
    expect(tidalTrackInfoResult("77", undefined)).toEqual({ info: null, failed: true, refusal: null });
    expect(tidalTrackInfoResult(null, info)).toEqual({ info: null, failed: false, refusal: null });
  });

  it("passes on TIDAL's refusal", () => {
    const refusal = "TIDAL refused this track: Not available in your region";
    expect(tidalTrackInfoResult("77", info, new ApiError(502, refusal))).toEqual({ info: null, failed: true, refusal });
    expect(tidalTrackInfoResult("77", null, new Error("timeout")).refusal).toBeNull();
  });
});

describe("trackInfoRows", () => {
  const file = (over: Partial<TrackDetail> = {}): TrackDetail => ({
    id: "t1",
    source: "local",
    title: "Song",
    duration_ms: 185_000,
    format: "FLAC",
    file_size: 30 * 1024 * 1024,
    artists: [{ id: "a", name: "Main", role: "primary" }],
    has_cover: true,
    favorited: false,
    ...over,
  });
  const labels = (view: ReturnType<typeof trackInfoRows>, key: string) =>
    view.sections.find((section) => section.key === key)?.rows.map((r) => r.label);
  const rowsOf = (view: ReturnType<typeof trackInfoRows>, key: string) =>
    view.sections.find((section) => section.key === key)?.rows;

  it("lists a file's credits, release and audio, leaving out what it doesn't have", () => {
    const view = trackInfoRows(
      file({
        year: 2001,
        genre: "Jazz",
        track_no: 3,
        comments: "Live take",
        bitrate: 900_000,
        sample_rate: 44_100,
        channels: 2,
        file_name: "song.flac",
      }),
      null,
    );
    expect(view.note).toBeNull();
    expect(view.sections.map((s) => s.label)).toEqual(["Credits", "Release", "Audio"]);
    expect(rowsOf(view, "credits")).toEqual([
      { label: "Primary artist", value: "Main", names: [libraryArtist("Main", "a")] },
      { label: "Featured", value: "—", empty: true },
      { label: "Producers", value: "—", empty: true },
    ]);
    expect(rowsOf(view, "release")).toEqual([
      { label: "Year", value: "2001" },
      { label: "Genre", value: "Jazz" },
      { label: "Track", value: "3" },
      { label: "Comments", value: "Live take", wide: true },
    ]);
    expect(rowsOf(view, "audio")).toEqual([
      { label: "Format", value: "FLAC" },
      { label: "Bitrate", value: "900 kbps" },
      { label: "Sample rate", value: "44.1 kHz" },
      { label: "Channels", value: "2" },
      { label: "Duration", value: "3:05" },
      { label: "File size", value: "30.0 MB" },
      { label: "File", value: "song.flac", wide: true },
    ]);
  });

  it("hides an empty genre and leaves out a section with nothing in it", () => {
    const view = trackInfoRows(file({ genre: "  ", format: "", file_size: 0, duration_ms: 0 }), null);
    expect(view.sections.map((s) => s.key)).toEqual(["credits"]);
  });

  it("cleans tag text for display", () => {
    const view = trackInfoRows(
      file({ genre: "Rock Â· Pop", artists: [{ id: "a", name: "A Â· B", role: "primary" }] }),
      null,
    );
    expect(rowsOf(view, "credits")?.[0].value).toBe("A · B");
    expect(rowsOf(view, "release")?.[0]).toEqual({ label: "Genre", value: "Rock · Pop" });
  });

  const tidalTrack = file({ source: "tidal", source_id: "77", format: "", file_size: 0, year: 1999 });
  const info = (over: Partial<TidalTrackInfo> = {}): TidalTrackInfo => ({
    id: "77",
    artists: [{ name: "Main", role: "main" }],
    credits: [{ role: "Producer", names: ["Maker"] }],
    release_date: "2020-03-17",
    bpm: 120,
    key: "F♯ minor",
    isrc: "USXXX",
    copyright: "℗ 2020 Label",
    streamed_quality: "LOSSLESS",
    channels: 2,
    ...over,
  });

  it("fills a TIDAL track from TIDAL", () => {
    const view = trackInfoRows(tidalTrack, tidalTrackInfoResult("77", info()));
    expect(view.note).toBeNull();
    expect(rowsOf(view, "credits")).toEqual([
      { label: "Primary artist", value: "Main", names: [{ name: "Main" }] },
      { label: "Featured", value: "—", empty: true },
      { label: "Producers", value: "Maker", names: [{ name: "Maker" }] },
    ]);
    expect(rowsOf(view, "release")).toEqual([
      { label: "Released", value: formatCalendarDate("2020-03-17") },
      { label: "BPM", value: "120" },
      { label: "Key", value: "F♯ minor" },
      { label: "ISRC", value: "USXXX" },
      { label: "Copyright", value: "℗ 2020 Label", wide: true },
    ]);
    expect(labels(view, "audio")).toEqual([
      "Source", "Format", "Quality", "Bit depth", "Sample rate", "Channels", "Duration",
    ]);
  });

  it("falls back to the row's year, and passes on what TIDAL couldn't load", () => {
    const view = trackInfoRows(
      tidalTrack,
      tidalTrackInfoResult(
        "77",
        info({ release_date: undefined, credits_failed: true, release_failure: "Only the stream start date is known." }),
      ),
    );
    expect(rowsOf(view, "release")?.[0]).toEqual({ label: "Year", value: "1999" });
    expect(view.sections.find((s) => s.key === "credits")?.note).toBe("Couldn't load credits from TIDAL.");
    expect(view.sections.find((s) => s.key === "release")?.note).toBe("Only the stream start date is known.");
  });

  it("shows what the row has when TIDAL didn't answer, and why", () => {
    const view = trackInfoRows(tidalTrack, tidalTrackInfoResult("77", null, new Error("timeout")));
    expect(view.note).toBe("Couldn't load more from TIDAL, so some fields are missing.");
    expect(rowsOf(view, "audio")).toEqual([
      { label: "Source", value: "TIDAL" },
      { label: "Quality", value: "—", empty: true },
      { label: "Duration", value: "3:05" },
    ]);
    const refusal = "TIDAL refused this track: Not available in your region";
    expect(trackInfoRows(tidalTrack, tidalTrackInfoResult("77", null, new ApiError(502, refusal))).note).toBe(refusal);
  });

  it("links a file's artists and album to their library pages, leaving its producers plain", () => {
    const view = trackInfoRows(
      file({
        album_id: "al1",
        album_title: "Album",
        year: 2024,
        composer: "Clayco, Lukrative",
        artists: [
          { id: "a", name: "Main", role: "primary" },
          { id: "f", name: "Guest", role: "featured" },
          { id: "c", name: "Clayco, Lukrative", role: "composer" },
        ],
      }),
      null,
    );
    expect(rowsOf(view, "credits")).toEqual([
      { label: "Primary artist", value: "Main", names: [libraryArtist("Main", "a")] },
      { label: "Featured", value: "Guest", names: [libraryArtist("Guest", "f")] },
      // The composer tag is one name to the server, so it opens no page.
      { label: "Producers", value: "Clayco, Lukrative" },
    ]);
    expect(view.artists).toEqual([libraryArtist("Main", "a"), libraryArtist("Guest", "f")]);
    expect(view.album).toEqual({ name: "Album", kind: "album", source: "local", id: "al1" });
    expect(view.year).toBe("2024");
  });

  it("leaves names plain when they have no page", () => {
    const view = trackInfoRows(file({ artists: [{ id: "", name: "Main", role: "primary" }], album_title: "Loose" }), null);
    expect(rowsOf(view, "credits")?.[0]).toEqual({ label: "Primary artist", value: "Main", names: [{ name: "Main" }] });
    expect(view.album).toEqual({ name: "Loose" });
    expect(view.year).toBe("");
    expect(trackInfoRows(file(), null).album).toBeNull();
  });

  it("cleans the names it links", () => {
    const view = trackInfoRows(file({ album_id: "al1", album_title: "A Â· B", artists: [{ id: "a", name: "C Â· D", role: "primary" }] }), null);
    expect(view.artists).toEqual([libraryArtist("C · D", "a")]);
    expect(view.album?.name).toBe("A · B");
  });

  it("links a TIDAL track's names to TIDAL pages, never to the hidden rows behind it", () => {
    const track = { ...tidalTrack, album_id: "hidden", source_album_id: "500", album_title: "Album" };
    const view = trackInfoRows(
      track,
      tidalTrackInfoResult(
        "77",
        info({
          artists: [
            { id: "9", name: "Main", role: "main" },
            { id: "7", name: "Guest", role: "featured" },
          ],
          credits: [{ role: "Producer", names: ["Maker", "Other"], contributors: [{ id: "24", name: "Maker" }, { name: "Other" }] }],
        }),
      ),
    );
    expect(view.artists).toEqual([tidalArtist("Main", "9"), tidalArtist("Guest", "7")]);
    expect(rowsOf(view, "credits")?.[2].names).toEqual([tidalArtist("Maker", "24"), { name: "Other" }]);
    expect(view.album).toEqual({ name: "Album", kind: "album", source: "tidal", id: "500" });
    // TIDAL's release date beats the row's year.
    expect(view.year).toBe("2020");

    // Without TIDAL's answer, the stored artists show, unlinked.
    const failed = trackInfoRows(track, tidalTrackInfoResult("77", null, new Error("timeout")));
    expect(failed.artists).toEqual([{ name: "Main" }]);
    expect(failed.album).toEqual({ name: "Album", kind: "album", source: "tidal", id: "500" });
    expect(failed.year).toBe("1999");
  });

  describe("without TIDAL artist ids (an older server)", () => {
    const track = { ...tidalTrack, source_album_id: "500", artists: [{ id: "h", name: "Main", role: "primary" }] };
    const old = tidalTrackInfoResult("77", info({ artists: [{ name: "Main", role: "main" }, { name: "Guest", role: "featured" }] }));
    const album = { id: "500", artist: "main ", artist_id: "9" };

    it("asks for the album only then", () => {
      expect(trackInfoArtistAlbumId(track, old)).toBe("500");
      expect(trackInfoArtistAlbumId(track, tidalTrackInfoResult("77", null, new Error("timeout")))).toBe("500");
      const current = tidalTrackInfoResult("77", info({ artists: [{ id: "9", name: "Main", role: "main" }] }));
      expect(trackInfoArtistAlbumId(track, current)).toBeNull();
      expect(trackInfoArtistAlbumId({ ...track, source_album_id: undefined }, old)).toBeNull();
      expect(trackInfoArtistAlbumId({ source: "local", source_album_id: "500" }, null)).toBeNull();
      expect(trackInfoArtistAlbumId(null, old)).toBeNull();
    });

    it("links only the primary artist, through the album's artist id", () => {
      const view = trackInfoRows(track, old, album);
      expect(view.artists).toEqual([tidalArtist("Main", "9"), { name: "Guest" }]);
      expect(rowsOf(view, "credits")?.[0].names).toEqual([tidalArtist("Main", "9")]);
      expect(rowsOf(view, "credits")?.[1].names).toEqual([{ name: "Guest" }]);
      // Also when TIDAL didn't answer at all.
      const failed = trackInfoRows(track, tidalTrackInfoResult("77", null, new Error("timeout")), album);
      expect(failed.artists).toEqual([tidalArtist("Main", "9")]);
    });

    it("leaves the artist plain when the album isn't theirs or this track's", () => {
      for (const other of [
        { ...album, artist: "Various Artists" },
        { ...album, artist_id: undefined },
        { ...album, id: "501" },
      ]) {
        expect(trackInfoRows(track, old, other).artists).toEqual([{ name: "Main" }, { name: "Guest" }]);
      }
      // A library track's artists have their own pages.
      const local = trackInfoRows(file({ source_album_id: "500" }), null, album);
      expect(local.artists).toEqual([libraryArtist("Main", "a")]);
    });
  });
});
