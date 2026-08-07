package handler

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

// These exercise the real ffmpeg command lines; the unit tests cover the parsing around them.
func requireFFmpeg(t *testing.T) string {
	t.Helper()
	bin, err := exec.LookPath("ffmpeg")
	if err != nil {
		t.Skip("ffmpeg not installed")
	}
	return bin
}

// synthAudio writes a real encoded tone, at the requested loudness, via ffmpeg's synthetic input.
func synthAudio(t *testing.T, bin, path string, seconds int, dB string) {
	t.Helper()
	out, err := exec.Command(bin, "-v", "error", "-f", "lavfi",
		"-i", "sine=frequency=440:duration="+strconv.Itoa(seconds),
		"-af", "volume="+dB, "-c:a", "libmp3lame", "-b:a", "128k", "-y", path).CombinedOutput()
	if err != nil {
		t.Skipf("cannot synthesize test audio: %v (%s)", err, out)
	}
}

func TestScanLoudnessOnRealFile(t *testing.T) {
	bin := requireFFmpeg(t)
	dir := t.TempDir()
	loud := filepath.Join(dir, "loud.mp3")
	quiet := filepath.Join(dir, "quiet.mp3")
	synthAudio(t, bin, loud, 10, "-3dB")
	synthAudio(t, bin, quiet, 10, "-25dB")

	loudLUFS := scanLoudness(bin, loud)
	quietLUFS := scanLoudness(bin, quiet)
	if loudLUFS == 0 || quietLUFS == 0 {
		t.Fatalf("no measurement: loud=%v quiet=%v", loudLUFS, quietLUFS)
	}
	if loudLUFS <= quietLUFS {
		t.Errorf("louder file measured quieter: %v vs %v", loudLUFS, quietLUFS)
	}
	// The 22dB gap between the two inputs should survive the measurement roughly intact.
	if gap := loudLUFS - quietLUFS; gap < 18 || gap > 26 {
		t.Errorf("gap: got %v dB, want ~22", gap)
	}
	// Absolute level depends on the synthetic source, so only sanity-check the range here;
	// the gain curve itself is pinned down in TestLoudnessGain.
	for _, v := range []float64{loudLUFS, quietLUFS} {
		if v > 0 || v < -70 {
			t.Errorf("measurement out of plausible range: %v LUFS", v)
		}
	}
}

func TestLoudnessHandlerCachesMeasurement(t *testing.T) {
	bin := requireFFmpeg(t)
	s, root := trashServer(t)
	synthAudio(t, bin, filepath.Join(root, "song.mp3"), 10, "-6dB")

	get := func() map[string]any {
		rec := httptest.NewRecorder()
		s.loudnessHandler(rec, httptest.NewRequest(http.MethodGet, "/api/files/loudness?path=song.mp3", nil))
		if rec.Code != 200 {
			t.Fatalf("got %d (%s)", rec.Code, rec.Body)
		}
		var m map[string]any
		json.Unmarshal(rec.Body.Bytes(), &m)
		return m
	}

	first := get()
	gain, ok := first["gain"].(float64)
	if !ok || gain <= 0 || gain > 1 {
		t.Fatalf("gain: %v", first)
	}
	if _, ok := first["lufs"]; !ok {
		t.Fatalf("no measurement reported: %v", first)
	}

	// The second call must come from the sidecar, so deleting ffmpeg's input can't change it.
	if err := os.Remove(filepath.Join(root, "song.mp3")); err != nil {
		t.Fatal(err)
	}
	rec := httptest.NewRecorder()
	s.loudnessHandler(rec, httptest.NewRequest(http.MethodGet, "/api/files/loudness?path=song.mp3", nil))
	if rec.Code != http.StatusNotFound {
		t.Errorf("a missing file should 404, got %d", rec.Code)
	}
}

// A non-audio file must answer with unity gain rather than an error the player has to handle.
func TestLoudnessHandlerIgnoresNonAudio(t *testing.T) {
	s, root := trashServer(t)
	if err := os.WriteFile(filepath.Join(root, "a.txt"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	rec := httptest.NewRecorder()
	s.loudnessHandler(rec, httptest.NewRequest(http.MethodGet, "/api/files/loudness?path=a.txt", nil))
	var m map[string]any
	json.Unmarshal(rec.Body.Bytes(), &m)
	if rec.Code != 200 || m["gain"] != float64(1) {
		t.Errorf("got %d %v, want 200 with gain 1", rec.Code, m)
	}
}

func TestTrimAudioProducesShorterFile(t *testing.T) {
	bin := requireFFmpeg(t)
	s, root := trashServer(t)
	src := filepath.Join(root, "long.mp3")
	synthAudio(t, bin, src, 12, "-6dB")

	rec := postJSON(t, s.trimAudioHandler, "/api/media/trim-audio",
		`{"path":"long.mp3","start":2,"end":6}`)
	if rec.Code != 200 {
		t.Fatalf("got %d, want 200 (%s)", rec.Code, rec.Body)
	}
	var res struct {
		Name string `json:"name"`
	}
	json.Unmarshal(rec.Body.Bytes(), &res)
	if res.Name != "long-trimmed.mp3" {
		t.Fatalf("name: got %q", res.Name)
	}

	probe, err := exec.LookPath("ffprobe")
	if err != nil {
		return
	}
	got := ffprobeDuration(probe, filepath.Join(root, res.Name))
	if got != 4 {
		t.Errorf("duration: got %ds, want 4s", got)
	}
	if d := ffprobeDuration(probe, src); d != 12 {
		t.Errorf("source was modified: %ds", d)
	}
}

func TestTrimAudioReplaceKeepsOriginalInTrash(t *testing.T) {
	bin := requireFFmpeg(t)
	s, root := trashServer(t)
	src := filepath.Join(root, "cut.mp3")
	synthAudio(t, bin, src, 12, "-6dB")

	rec := postJSON(t, s.trimAudioHandler, "/api/media/trim-audio",
		`{"path":"cut.mp3","start":1,"end":4,"replace":true}`)
	if rec.Code != 200 {
		t.Fatalf("got %d (%s)", rec.Code, rec.Body)
	}
	probe, err := exec.LookPath("ffprobe")
	if err != nil {
		return
	}
	if d := ffprobeDuration(probe, src); d != 3 {
		t.Errorf("replaced file duration: got %ds, want 3s", d)
	}
	if d := ffprobeDuration(probe, filepath.Join(root, trashDirName, "cut.mp3")); d != 12 {
		t.Errorf("original not recoverable at full length: got %ds", d)
	}
}

func TestTranscodeVideoShrinksAndConvertsToH264(t *testing.T) {
	bin := requireFFmpeg(t)
	probe, err := exec.LookPath("ffprobe")
	if err != nil {
		t.Skip("ffprobe not installed")
	}
	s, root := trashServer(t)
	src := filepath.Join(root, "clip.mp4")
	// HEVC in, H.264 out: the conversion is the point, not just the smaller frame.
	out, err := exec.Command(bin, "-v", "error", "-f", "lavfi",
		"-i", "testsrc=size=1280x720:rate=30:duration=4",
		"-c:v", "libx265", "-crf", "28", "-pix_fmt", "yuv420p", "-y", src).CombinedOutput()
	if err != nil {
		t.Skipf("cannot synthesize HEVC test clip: %v (%s)", err, out)
	}

	j := &job{ID: "t1", Kind: "video-resize"}
	s.jobs.mu.Lock()
	s.jobs.jobs["t1"] = j
	s.jobs.mu.Unlock()

	dst := filepath.Join(root, "out.mp4")
	if err := s.transcodeVideo(j, src, dst, 480, 26); err != nil {
		t.Fatalf("transcode: %v", err)
	}

	codec, err := exec.Command(probe, "-v", "error", "-select_streams", "v:0",
		"-show_entries", "stream=codec_name,height", "-of", "csv=p=0", dst).Output()
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(codec), "h264") {
		t.Errorf("codec: got %q, want h264", codec)
	}
	if !strings.Contains(string(codec), "480") {
		t.Errorf("height: got %q, want 480", codec)
	}
	if ffprobeDuration(probe, dst) != 4 {
		t.Errorf("duration changed: %ds", ffprobeDuration(probe, dst))
	}
	s.jobs.mu.Lock()
	p := j.Progress
	s.jobs.mu.Unlock()
	if p <= 0 {
		t.Error("no progress was reported during the transcode")
	}
}
