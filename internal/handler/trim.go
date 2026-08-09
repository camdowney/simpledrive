package handler

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// A stream copy rewrites no samples, so even a long file finishes in seconds.
const trimTimeout = 2 * time.Minute

// minTrimSeconds keeps a mis-drag from producing a file with nothing in it.
const minTrimSeconds = 0.1

// trimAudioHandler — POST /api/media/trim-audio
// body: {path, start, end, replace}; start and end are seconds from the beginning.
func (s *server) trimAudioHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		jsonErr(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var body struct {
		Path    string  `json:"path"`
		Start   float64 `json:"start"`
		End     float64 `json:"end"`
		Replace bool    `json:"replace"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		jsonErr(w, "bad request", http.StatusBadRequest)
		return
	}
	if body.Start < 0 || body.End <= body.Start {
		jsonErr(w, "the end must come after the start", http.StatusBadRequest)
		return
	}
	if body.End-body.Start < minTrimSeconds {
		jsonErr(w, "that selection is too short", http.StatusBadRequest)
		return
	}
	if s.thumbs.ffmpeg == "" {
		jsonErr(w, "ffmpeg is not installed on the server", http.StatusServiceUnavailable)
		return
	}

	abs, err := s.localEditTarget(r, body.Path, audioExts)
	if err != nil {
		jsonErr(w, err.Error(), editStatus(err))
		return
	}
	fi, err := os.Stat(abs)
	if err != nil {
		jsonErr(w, "not found", http.StatusNotFound)
		return
	}

	name := suffixedName(filepath.Base(abs), "-trimmed", "")
	saved, err := s.commitEdit(abs, name, body.Replace, func(dst string) error {
		return trimAudio(s.thumbs.ffmpeg, abs, dst, body.Start, body.End)
	})
	if err != nil {
		if _, ok := err.(*editError); ok {
			jsonErr(w, err.Error(), editStatus(err))
			return
		}
		jsonErr(w, "the trim failed", http.StatusInternalServerError)
		return
	}
	os.Chtimes(saved, fi.ModTime(), fi.ModTime())
	s.thumbs.invalidateFolder(filepath.Dir(saved))

	out, _ := os.Stat(saved)
	res := map[string]any{"status": "ok", "path": s.relOf(saved), "name": filepath.Base(saved)}
	if out != nil {
		res["size"] = out.Size()
	}
	writeJSON(w, http.StatusOK, res)
}

// No re-encode: ffmpeg cuts on frame boundaries, so marks land within ~26ms (MP3) of the request.
func trimAudio(bin, src, dst string, start, end float64) error {
	// The temp file commitEdit hands over has no extension for ffmpeg to infer a muxer from.
	format, err := trimFormat(src)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), trimTimeout)
	defer cancel()

	cmd := exec.CommandContext(ctx, bin, "-nostdin", "-v", "error",
		// -ss ahead of -i seeks by index instead of decoding up to the mark.
		"-ss", secondsArg(start), "-i", src,
		// A duration is unambiguous; -to shifts meaning relative to an input seek across versions.
		"-t", secondsArg(end-start),
		"-map", "0:a", "-c", "copy", "-map_metadata", "0",
		"-f", format, "-y", dst)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		if msg := strings.TrimSpace(stderr.String()); msg != "" {
			return fmt.Errorf("ffmpeg: %s", strings.ReplaceAll(msg, "\n", "; "))
		}
		return err
	}
	if fi, err := os.Stat(dst); err != nil || fi.Size() == 0 {
		return &editError{"the trim produced an empty file", http.StatusUnsupportedMediaType}
	}
	return nil
}

// trimFormat maps an extension to the muxer name ffmpeg needs when the output has no extension.
func trimFormat(src string) (string, error) {
	switch strings.ToLower(filepath.Ext(src)) {
	case ".mp3":
		return "mp3", nil
	case ".flac":
		return "flac", nil
	case ".wav":
		return "wav", nil
	case ".ogg", ".opus":
		return "ogg", nil
	case ".m4a", ".aac":
		// Raw AAC can't be stream-copied into an MP4 without a bitstream filter; ipod is the m4a muxer.
		return "ipod", nil
	}
	return "", &editError{"this audio format can't be trimmed", http.StatusUnsupportedMediaType}
}

// secondsArg formats a timestamp at millisecond precision, which is finer than a frame boundary.
func secondsArg(v float64) string { return strconv.FormatFloat(v, 'f', 3, 64) }
