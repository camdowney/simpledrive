package handler

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"mime"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// Generous enough for the cuts that re-encode; a stream copy finishes in seconds either way.
const trimTimeout = 2 * time.Minute

// minTrimSeconds keeps a mis-drag from producing a file with nothing in it.
const minTrimSeconds = 0.1

// How far ahead of the mark the index seek lands; the packets between are read and dropped.
const trimSeekLead = 10

// trimAudioHandler — POST /api/media/trim-audio
// body: {path, start, end, replace}; start and end are seconds from the beginning.
func (s *server) trimAudioHandler(w http.ResponseWriter, r *http.Request) {
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

// trimPreviewHandler — GET /api/media/trim-preview?path=<rel>&start=<s>&end=<s>
// Hands back the very bytes a trim of that span would write. A VBR file's position is an estimate
// the player interpolates, so auditioning the source would audition a different cut than it makes.
func (s *server) trimPreviewHandler(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	start, errS := strconv.ParseFloat(q.Get("start"), 64)
	end, errE := strconv.ParseFloat(q.Get("end"), 64)
	if errS != nil || errE != nil || start < 0 || end-start < minTrimSeconds {
		jsonErr(w, "bad range", http.StatusBadRequest)
		return
	}
	if s.thumbs.ffmpeg == "" {
		jsonErr(w, "ffmpeg is not installed on the server", http.StatusServiceUnavailable)
		return
	}
	abs, err := s.localEditTarget(r, q.Get("path"), audioExts)
	if err != nil {
		jsonErr(w, err.Error(), editStatus(err))
		return
	}

	format, err := trimFormat(abs)
	if err != nil {
		jsonErr(w, err.Error(), editStatus(err))
		return
	}
	ctype := mime.TypeByExtension(filepath.Ext(abs))
	if pipeTrim(format) {
		if err := streamTrim(r.Context(), s.thumbs.ffmpeg, abs, format, start, end, w, ctype); err != nil {
			jsonErr(w, "the preview failed", http.StatusInternalServerError)
		}
		return
	}

	tmp, err := os.CreateTemp("", "trim-preview-*")
	if err != nil {
		jsonErr(w, "the preview failed", http.StatusInternalServerError)
		return
	}
	tmp.Close()
	defer os.Remove(tmp.Name())
	if err := trimAudio(s.thumbs.ffmpeg, abs, tmp.Name(), start, end); err != nil {
		jsonErr(w, "the preview failed", http.StatusInternalServerError)
		return
	}
	f, err := os.Open(tmp.Name())
	if err != nil {
		jsonErr(w, "the preview failed", http.StatusInternalServerError)
		return
	}
	defer f.Close()

	w.Header().Set("Content-Type", ctype)
	w.Header().Set("Cache-Control", "no-store")
	http.ServeContent(w, r, filepath.Base(abs), time.Time{}, f)
}

// Cutting to a temp file first holds the first note back for as long as the whole span takes to
// write, which on a long selection is most of the wait; down a pipe it leaves as it is cut.
func streamTrim(ctx context.Context, bin, src, format string, start, end float64,
	w http.ResponseWriter, ctype string) error {
	ctx, cancel := context.WithTimeout(ctx, trimTimeout)
	defer cancel()
	args := trimArgs(src, "pipe:1", format, trimCodec(format), start, end, pipeMuxerArgs(format)...)
	cmd := exec.CommandContext(ctx, bin, args...)
	out, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Start(); err != nil {
		return err
	}

	// The head is held back so a cut that dies on the spot can still answer with a status; past it
	// the response is under way and a late failure can only end the clip early.
	head := make([]byte, 32*1024)
	n, _ := io.ReadFull(out, head)
	if n == 0 {
		cmd.Wait()
		return fmt.Errorf("ffmpeg: %s", strings.TrimSpace(stderr.String()))
	}
	w.Header().Set("Content-Type", ctype)
	w.Header().Set("Cache-Control", "no-store")
	if _, err := w.Write(head[:n]); err == nil {
		if f, ok := w.(http.Flusher); ok {
			f.Flush()
		}
		io.Copy(w, out)
	}
	cmd.Wait()
	return nil
}

// The mp4 and wav muxers seek back over what they wrote to fill in a header, so they need a file.
func pipeTrim(format string) bool { return format == "mp3" || format == "ogg" }

// ffmpeg cuts on packet boundaries, so marks land within ~50ms of the request.
func trimAudio(bin, src, dst string, start, end float64) error {
	// The temp file commitEdit hands over has no extension for ffmpeg to infer a muxer from.
	format, err := trimFormat(src)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), trimTimeout)
	defer cancel()

	codec, muxer := savedTrimPlan(src, format, start)
	args := trimArgs(src, dst, format, codec, start, end, muxer...)
	cmd := exec.CommandContext(ctx, bin, args...)
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

// trimArgs cuts src into dst, which is "pipe:1" when the cut is streamed rather than written.
// Muxer options belong in extra: ffmpeg reads them for the output that follows them.
func trimArgs(src, dst, format, codec string, start, end float64, extra ...string) []string {
	lead := math.Max(0, start-trimSeekLead)
	args := []string{"-nostdin", "-v", "error",
		// -ss ahead of -i seeks by index instead of decoding up to the mark.
		"-ss", secondsArg(lead), "-i", src,
		// An index seek lands on a container boundary — an Ogg page is nearly a second — so the
		// mark itself is placed by a second -ss, which drops packets after the coarse landing.
		"-ss", secondsArg(start - lead),
		// A duration is unambiguous; -to shifts meaning relative to an input seek across versions.
		"-t", secondsArg(end - start),
		"-map", "0:a", "-c:a", codec, "-map_metadata", "0"}
	args = append(args, extra...)
	return append(args, "-f", format, "-y", dst)
}

// A pipe can't be seeked back to fill in a Xing header, so the mp3 muxer must not reserve one.
func pipeMuxerArgs(format string) []string {
	if format == "mp3" {
		return []string{"-write_xing", "0"}
	}
	return nil
}

// A mid-file cut's Xing frame bursts in Firefox, yet without one a VBR length is guessed wrong.
func savedTrimPlan(src, format string, start float64) (codec string, muxer []string) {
	if format != "mp3" || start == 0 {
		return trimCodec(format), nil
	}
	constant, meanKbps, ok := mp3Bitrates(src)
	if ok && constant {
		return "copy", []string{"-write_xing", "0"}
	}
	// A re-encode gets both: LAME opens with an empty reservoir and writes a truthful header.
	return "libmp3lame", []string{"-q:a", lameQuality(meanKbps)}
}

// The thriftiest LAME VBR setting still targeting the source's own rate, so detail is not shed.
func lameQuality(meanKbps int) string {
	if meanKbps <= 0 {
		return "0"
	}
	rates := [...]int{245, 225, 190, 175, 165, 130, 115, 100, 85, 65}
	for q := len(rates) - 1; q >= 0; q-- {
		if rates[q] >= meanKbps {
			return strconv.Itoa(q)
		}
	}
	return "0"
}

// A stream copy hands the FLAC muxer the source's STREAMINFO, so the cut would keep declaring the
// original's length. Re-encoding rewrites it, and FLAC being lossless that costs only time.
func trimCodec(format string) string {
	if format == "flac" {
		return "flac"
	}
	return "copy"
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
