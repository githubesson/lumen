// Package ffsafe holds the input options every ffmpeg/ffprobe invocation must
// place in front of an untrusted input file.
//
// Ingest accepts files by extension only, and ffmpeg picks a demuxer by
// sniffing content. Without these options an upload named x.mp3 whose body is
// an HLS or concat playlist makes ffmpeg fetch arbitrary URLs (blind SSRF) or
// read other media on disk (another user's upload), which a share preview then
// re-encodes into a downloadable MP4.
package ffsafe

// audioDemuxers lists the demuxers the ingest extensions map to, plus mpegts
// for TIDAL audio assembled from .ts segments. ffmpeg matches each
// comma-separated component of a demuxer's name, so "mov" admits
// "mov,mp4,m4a,3gp,3g2,mj2" and "matroska" admits "matroska,webm". Playlist
// demuxers (hls, concat, ffconcat) and every network protocol stay out.
const audioDemuxers = "mp3,flac,ogg,mov,wav,aac,matroska,mpegts"

// imageDemuxers lists the demuxers ffmpeg picks for a JPEG, PNG or WebP
// file. PNG and WebP sniff as their *_pipe demuxer; a JPEG goes to image2 by
// its extension unless its end is within the first probe read (a small one,
// or one without an image extension sniffs as jpeg_pipe).
const imageDemuxers = "image2,jpeg_pipe,png_pipe,webp_pipe"

// InputArgs returns the options to insert immediately before "-i <path>" (or
// before ffprobe's input path) for an untrusted local audio file. They are
// per-input options: other inputs such as lavfi sources or cover images keep
// ffmpeg's defaults.
func InputArgs() []string {
	return []string{
		"-protocol_whitelist", "file",
		"-format_whitelist", audioDemuxers,
	}
}

// ImageInputArgs is InputArgs for a cover image input. Covers come from
// storage or TIDAL's CDN as bytes the extension of a temp file only guesses
// at, so the same sniffing applies.
func ImageInputArgs() []string {
	return []string{
		"-protocol_whitelist", "file",
		"-format_whitelist", imageDemuxers,
	}
}
