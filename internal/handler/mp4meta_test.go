package handler

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"mime/multipart"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"simpledrive/internal/config"
)

func mp4Box(name string, payload []byte) []byte {
	b := make([]byte, 8+len(payload))
	binary.BigEndian.PutUint32(b, uint32(len(b)))
	copy(b[4:], name)
	copy(b[8:], payload)
	return b
}

// buildMOV assembles a minimal ftyp+mdat+moov file with the given mvhd creation time and length.
func buildMOV(creation time.Time, version byte, length time.Duration) []byte {
	secs := uint64(creation.Sub(qtEpoch) / time.Second)
	units := uint64(length * 600 / time.Second) // mvhd duration at the classic 600 timescale
	var p []byte
	if version == 1 {
		p = make([]byte, 32)
		p[0] = 1
		binary.BigEndian.PutUint64(p[4:], secs)
		binary.BigEndian.PutUint64(p[12:], secs)
		binary.BigEndian.PutUint32(p[20:], 600)
		binary.BigEndian.PutUint64(p[24:], units)
	} else {
		p = make([]byte, 20)
		binary.BigEndian.PutUint32(p[4:], uint32(secs))
		binary.BigEndian.PutUint32(p[8:], uint32(secs))
		binary.BigEndian.PutUint32(p[12:], 600)
		binary.BigEndian.PutUint32(p[16:], uint32(units))
	}
	out := mp4Box("ftyp", []byte("qt  \x00\x00\x02\x00qt  "))
	out = append(out, mp4Box("mdat", []byte("not real video data"))...)
	out = append(out, mp4Box("moov", mp4Box("mvhd", p))...)
	return out
}

func TestMP4CreationTime(t *testing.T) {
	want := time.Date(2023, 6, 15, 10, 30, 0, 0, time.UTC)
	for _, version := range []byte{0, 1} {
		mov := buildMOV(want, version, 90*time.Second)
		got, ok := mp4CreationTime(bytes.NewReader(mov), int64(len(mov)))
		if !ok {
			t.Fatalf("v%d: expected a date", version)
		}
		if !got.Equal(want) {
			t.Fatalf("v%d: got %v, want %v", version, got, want)
		}
	}
}

func TestMP4CreationTimeAbsentOrJunk(t *testing.T) {
	zero := buildMOV(qtEpoch, 0, 90*time.Second)
	if _, ok := mp4CreationTime(bytes.NewReader(zero), int64(len(zero))); ok {
		t.Fatal("zero creation time should read as absent")
	}
	junk := []byte("RIFF....WEBPVP8 not an mp4 at all, just bytes")
	if _, ok := mp4CreationTime(bytes.NewReader(junk), int64(len(junk))); ok {
		t.Fatal("non-MP4 bytes should not yield a date")
	}
}

func TestMvhdDuration(t *testing.T) {
	when := time.Date(2023, 6, 15, 10, 30, 0, 0, time.UTC)
	for _, tc := range []struct {
		length time.Duration
		want   int
	}{
		{222 * time.Second, 222},
		{2500 * time.Millisecond, 3}, // rounds to nearest second
		{400 * time.Millisecond, 1},  // sub-second clips still show as 1s
		{0, 0},
	} {
		for _, version := range []byte{0, 1} {
			mov := buildMOV(when, version, tc.length)
			buf, n, ok := mp4Mvhd(bytes.NewReader(mov), int64(len(mov)))
			if !ok {
				t.Fatalf("v%d: mvhd not found", version)
			}
			if got := mvhdDurationSecs(buf, n); got != tc.want {
				t.Fatalf("v%d %v: duration = %d, want %d", version, tc.length, got, tc.want)
			}
		}
	}
}

func TestParseProbeDuration(t *testing.T) {
	for in, want := range map[string]int{
		"83.000000\n": 83, "2.5": 3, "0.4": 1, "0": 0, "-1": 0, "N/A": 0, "": 0,
	} {
		if got := parseProbeDuration(in); got != want {
			t.Errorf("parseProbeDuration(%q) = %d, want %d", in, got, want)
		}
	}
}

// Matroska has no mvhd, so meta answers only from the sidecar ffprobe writes at thumb time.
func TestMetaWebmSidecar(t *testing.T) {
	root := t.TempDir()
	p := filepath.Join(root, "clip.webm")
	if err := os.WriteFile(p, []byte("matroska-ish bytes"), 0o644); err != nil {
		t.Fatal(err)
	}
	s := &server{cfg: &config.Config{RootDir: root}, thumbs: newThumbCache(t.TempDir())}

	req := func() fileMeta {
		t.Helper()
		w := httptest.NewRecorder()
		s.metaHandler(w, httptest.NewRequest("GET", "/api/files/meta?path=/clip.webm", nil))
		if w.Code != 200 {
			t.Fatalf("meta status %d: %s", w.Code, w.Body)
		}
		var m fileMeta
		if err := json.Unmarshal(w.Body.Bytes(), &m); err != nil {
			t.Fatal(err)
		}
		return m
	}

	if m := req(); m.Duration != 0 {
		t.Fatalf("no sidecar yet, duration = %d", m.Duration)
	}
	fi, err := os.Stat(p)
	if err != nil {
		t.Fatal(err)
	}
	hash, err := s.thumbs.contentHash(p, fi)
	if err != nil {
		t.Fatal(err)
	}
	s.thumbs.writeDur(hash, durInfo{Duration: 83})
	if m := req(); m.Duration != 83 {
		t.Fatalf("duration = %d, want 83 from the sidecar", m.Duration)
	}
}

func TestMetaHandlerVideo(t *testing.T) {
	root := t.TempDir()
	want := time.Date(2023, 6, 15, 10, 30, 0, 0, time.UTC)
	if err := os.WriteFile(filepath.Join(root, "clip.mov"), buildMOV(want, 0, 222*time.Second), 0o644); err != nil {
		t.Fatal(err)
	}

	m := getMeta(t, root, "/clip.mov")
	dt, err := time.Parse(time.RFC3339, m.DateTaken)
	if err != nil {
		t.Fatalf("expected dateTaken, got %q (%v)", m.DateTaken, err)
	}
	if !dt.Equal(want) {
		t.Fatalf("dateTaken = %v, want %v", dt, want)
	}
	if m.Duration != 222 {
		t.Fatalf("duration = %d, want 222", m.Duration)
	}
}

// Uploads keep real dates: embedded capture time when the file has one, else the
// browser-reported lastModified sent alongside the form.
func TestUploadPreservesDates(t *testing.T) {
	root := t.TempDir()
	s := &server{cfg: &config.Config{RootDir: root}}

	taken := time.Date(2023, 6, 15, 10, 30, 0, 0, time.UTC)
	clientMod := time.Date(2024, 2, 1, 8, 0, 0, 0, time.UTC)

	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	mw.WriteField("lastModified", "1706774400000") // clientMod in unix ms
	fw, _ := mw.CreateFormFile("files", "clip.mov")
	fw.Write(buildMOV(taken, 0, 90*time.Second))
	fw, _ = mw.CreateFormFile("files", "notes.txt")
	fw.Write([]byte("no embedded date here"))
	mw.Close()

	r := httptest.NewRequest("POST", "/api/files/upload?path=/", &buf)
	r.Header.Set("Content-Type", mw.FormDataContentType())
	w := httptest.NewRecorder()
	s.uploadHandler(w, r)
	if w.Code != 200 {
		t.Fatalf("upload status %d: %s", w.Code, w.Body)
	}

	fi, err := os.Stat(filepath.Join(root, "clip.mov"))
	if err != nil {
		t.Fatal(err)
	}
	if !fi.ModTime().Equal(taken) {
		t.Errorf("clip.mov mtime = %v, want embedded %v", fi.ModTime(), taken)
	}
	fi, err = os.Stat(filepath.Join(root, "notes.txt"))
	if err != nil {
		t.Fatal(err)
	}
	if !fi.ModTime().Equal(clientMod) {
		t.Errorf("notes.txt mtime = %v, want client %v", fi.ModTime(), clientMod)
	}
}

func TestFixDates(t *testing.T) {
	root := t.TempDir()
	taken := time.Date(2023, 6, 15, 10, 30, 0, 0, time.UTC)
	wrong := time.Date(2025, 1, 1, 0, 0, 0, 0, time.UTC)
	for name, body := range map[string][]byte{
		"clip.mov":  buildMOV(taken, 0, 90*time.Second),
		"notes.txt": []byte("no embedded date"),
	} {
		p := filepath.Join(root, name)
		if err := os.WriteFile(p, body, 0o644); err != nil {
			t.Fatal(err)
		}
		if err := os.Chtimes(p, wrong, wrong); err != nil {
			t.Fatal(err)
		}
	}

	s := &server{cfg: &config.Config{RootDir: root}, thumbs: newThumbCache(t.TempDir())}
	run := func() int {
		t.Helper()
		r := httptest.NewRequest("POST", "/api/files/fixdates?path=/", nil)
		w := httptest.NewRecorder()
		s.fixDatesHandler(w, r)
		if w.Code != 200 {
			t.Fatalf("status %d: %s", w.Code, w.Body)
		}
		var out struct{ Changed int }
		if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
			t.Fatal(err)
		}
		return out.Changed
	}

	if n := run(); n != 1 {
		t.Fatalf("changed = %d, want 1", n)
	}
	fi, _ := os.Stat(filepath.Join(root, "clip.mov"))
	if !fi.ModTime().Equal(taken) {
		t.Fatalf("clip.mov mtime = %v, want %v", fi.ModTime(), taken)
	}
	fi, _ = os.Stat(filepath.Join(root, "notes.txt"))
	if !fi.ModTime().Equal(wrong) {
		t.Fatal("file without embedded date should be untouched")
	}
	if n := run(); n != 0 {
		t.Fatalf("second pass should find nothing, got %d", n)
	}
}
