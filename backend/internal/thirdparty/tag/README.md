# tag

Lumen's fork of [github.com/dhowden/tag](https://github.com/dhowden/tag) at
commit `3d75831295e8` (`v0.0.0-20240417053706-3d75831295e8`), the version Lumen
pinned before forking. Every uploaded or watched audio file goes through this
parser, and upstream has no fixes for the crashes and resource exhaustion a
crafted file can cause, so the code lives here where Lumen can patch it. It is
used under the upstream BSD licence in [LICENSE](LICENSE).

Left out, since Lumen never uses them: `cmd/` (command-line tools), `mbz/`
(MusicBrainz helpers), the module's `go.mod`, CI files, and `testdata/` (2 MB of
sample audio). `TestReadFrom` builds its samples in `fixtures_test.go` instead.

The rest is kept as upstream wrote it, so a diff against an upstream checkout
shows only the changes below.

## Changes from upstream

- gofmt, and the import path of `internal/id3v1_test`.
- MP4: `readAtoms` stops after descending into 32 container atoms. Each level
  recursed, so a file of nested `moov` headers overflowed the goroutine stack,
  a fatal error no `recover` catches.
- Accessors use checked type assertions, so a value of the wrong type reads as
  absent. In MP4 the file picks the type (a data atom's class, or a custom
  `----` atom named like a standard one), and `Title()` and friends panicked.
