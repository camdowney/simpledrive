package handler

import (
	"bytes"
	"compress/zlib"
	"encoding/binary"
	"encoding/json"
	"errors"
	"hash/crc32"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"math"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestParseEBUR128(t *testing.T) {
	// The per-frame lines carry an "I:" of their own, ahead of the summary that actually counts.
	out := `
[Parsed_ebur128_0 @ 0x1] t: 1.2 M: -9.7 S: -10.1 I: -99.0 LUFS LRA: 0.0 LU
[Parsed_ebur128_0 @ 0x1] t: 2.4 M: -8.1 S: -9.4 I: -50.0 LUFS LRA: 1.2 LU
[Parsed_ebur128_0 @ 0x1] Summary:

  Integrated loudness:
    I:         -8.4 LUFS
    Threshold: -18.6 LUFS

  Loudness range:
    LRA:        5.1 LU
`
	if got := parseEBUR128(strings.NewReader(out)); got != -8.4 {
		t.Errorf("got %v, want -8.4", got)
	}
	if got := parseEBUR128(strings.NewReader("nothing useful here")); got != 0 {
		t.Errorf("got %v, want 0 for unparsable output", got)
	}
}

func TestLoudnessGain(t *testing.T) {
	cases := []struct {
		lufs float64
		want float64
	}{
		{loudnessTargetLUFS, 1}, // already at target
		{-8, 0.32},              // a loud master is pulled down ~10dB
		{-24, 1},                // quieter than target: volume can't boost, so leave it be
		{0, 1},                  // unmeasured
		{-80, 1},                // ffmpeg's silence floor
		{-120, 1},               // beyond the floor
	}
	for _, c := range cases {
		got := loudnessGain(c.lufs)
		if math.Abs(got-c.want) > 0.01 {
			t.Errorf("loudnessGain(%v) = %v, want %v", c.lufs, got, c.want)
		}
	}
	// Every gain must be something HTMLMediaElement.volume can actually take.
	for lufs := -70.0; lufs <= 0; lufs += 0.5 {
		if g := loudnessGain(lufs); g < 0 || g > 1 {
			t.Fatalf("loudnessGain(%v) = %v, outside [0,1]", lufs, g)
		}
	}
}

// writeTestJPEG makes a JPEG of the given size, optionally carrying metadata.
func writeTestJPEG(t *testing.T, path string, w, h int, meta jpegMeta) {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	// A gradient, not a flat fill: a solid image compresses to almost nothing at any size.
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			img.Set(x, y, color.RGBA{uint8(x), uint8(y), uint8(x ^ y), 255})
		}
	}
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, img, &jpeg.Options{Quality: 95}); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, spliceMeta(buf.Bytes(), meta), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestResizeImageKeepsEXIFAndClearsOrientation(t *testing.T) {
	s, root := trashServer(t)
	src := filepath.Join(root, "photo.jpg")
	// Orientation 6 is a 90° rotation, which resizing bakes into the pixels.
	writeTestJPEG(t, src, 1200, 800, jpegMeta{exif: buildExifTIFF(6, "2021:07:04 13:37:00")})

	rec := postJSON(t, s.resizeImageHandler, "/api/media/resize-image",
		`{"path":"photo.jpg","maxDim":400,"quality":80}`)
	if rec.Code != 200 {
		t.Fatalf("got %d, want 200 (%s)", rec.Code, rec.Body)
	}
	var res struct {
		Name string `json:"name"`
	}
	json.Unmarshal(rec.Body.Bytes(), &res)
	if res.Name != "photo-resized.jpg" {
		t.Fatalf("name: got %q", res.Name)
	}

	out := filepath.Join(root, res.Name)
	f, err := os.Open(out)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()

	cfg, _, err := image.DecodeConfig(f)
	if err != nil {
		t.Fatal(err)
	}
	// The source was landscape but orientation 6 turns it portrait; the copy must fit 400 either way.
	if cfg.Width > 400 || cfg.Height > 400 {
		t.Errorf("not scaled: %dx%d", cfg.Width, cfg.Height)
	}
	if cfg.Height <= cfg.Width {
		t.Errorf("orientation not baked in: got %dx%d, expected portrait", cfg.Width, cfg.Height)
	}

	if _, err := f.Seek(0, 0); err != nil {
		t.Fatal(err)
	}
	tiff := jpegExifTIFF(f)
	if tiff == nil {
		t.Fatal("EXIF was dropped")
	}
	if o := parseExifOrientation(tiff); o != 1 {
		t.Errorf("orientation: got %d, want 1 (rotation is already in the pixels)", o)
	}
	if _, ok := exifDateTaken(tiff); !ok {
		t.Error("capture date was lost")
	}
	if _, err := os.Stat(src); err != nil {
		t.Error("original should survive a non-replacing resize")
	}
}

// Without its profile a P3 or Adobe RGB photo is read as sRGB, which is what makes a resized
// copy look washed out; the profile is longer than one segment holds, so it must survive re-chunking.
func TestResizeImageKeepsColorProfile(t *testing.T) {
	s, root := trashServer(t)
	profile := make([]byte, 3*maxICCChunk/2)
	for i := range profile {
		profile[i] = byte(i * 7)
	}
	src := filepath.Join(root, "wide.jpg")
	writeTestJPEG(t, src, 1200, 800, jpegMeta{icc: profile})

	if got := readJPEGMeta(bytes.NewReader(readFile(t, src))).icc; !bytes.Equal(got, profile) {
		t.Fatalf("source profile didn't round-trip: got %d bytes, want %d", len(got), len(profile))
	}

	rec := postJSON(t, s.resizeImageHandler, "/api/media/resize-image",
		`{"path":"wide.jpg","maxDim":400,"quality":80}`)
	if rec.Code != 200 {
		t.Fatalf("got %d, want 200 (%s)", rec.Code, rec.Body)
	}
	out := readFile(t, filepath.Join(root, "wide-resized.jpg"))
	if got := readJPEGMeta(bytes.NewReader(out)).icc; !bytes.Equal(got, profile) {
		t.Errorf("colour profile lost: got %d bytes, want %d", len(got), len(profile))
	}
	if _, _, err := image.Decode(bytes.NewReader(out)); err != nil {
		t.Errorf("the extra segments broke the file: %v", err)
	}
}

// writeTestPNG makes a PNG carrying a profile in the chunk Go's own encoder can't write.
func writeTestPNG(t *testing.T, path string, w, h int, icc []byte, transparent bool) {
	t.Helper()
	img := image.NewNRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			a := uint8(255)
			if transparent && x >= w/2 {
				a = 0
			}
			img.Set(x, y, color.NRGBA{uint8(x), uint8(y), uint8(x ^ y), a})
		}
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatal(err)
	}
	out := buf.Bytes()
	if icc != nil {
		// IHDR runs to byte 33 and has to stay first; the profile goes in behind it.
		out = append(out[:33:33], append(iccpChunk(t, icc), out[33:]...)...)
	}
	if err := os.WriteFile(path, out, 0o644); err != nil {
		t.Fatal(err)
	}
}

// iccpChunk frames a profile as PNG's iCCP chunk: a name, then the deflated profile.
func iccpChunk(t *testing.T, icc []byte) []byte {
	t.Helper()
	var z bytes.Buffer
	zw := zlib.NewWriter(&z)
	if _, err := zw.Write(icc); err != nil {
		t.Fatal(err)
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	body := append([]byte("p\x00\x00"), z.Bytes()...)
	chunk := binary.BigEndian.AppendUint32(nil, uint32(len(body)))
	chunk = append(append(chunk, "iCCP"...), body...)
	return binary.BigEndian.AppendUint32(chunk, crc32.ChecksumIEEE(chunk[4:]))
}

// A PNG or WebP keeps its profile in a chunk rather than a JPEG segment, so re-encoding one
// to JPEG has to go and find it there.
func TestResizeImageKeepsPNGColorProfile(t *testing.T) {
	s, root := trashServer(t)
	profile := bytes.Repeat([]byte("wide-gamut"), 64)
	writeTestPNG(t, filepath.Join(root, "wide.png"), 1200, 800, profile, false)

	// Replacing, because a gradient PNG compresses small enough to trip the "no smaller" guard.
	rec := postJSON(t, s.resizeImageHandler, "/api/media/resize-image",
		`{"path":"wide.png","maxDim":400,"quality":80,"replace":true}`)
	if rec.Code != 200 {
		t.Fatalf("got %d, want 200 (%s)", rec.Code, rec.Body)
	}
	out := readFile(t, filepath.Join(root, "wide.jpg"))
	if got := readJPEGMeta(bytes.NewReader(out)).icc; !bytes.Equal(got, profile) {
		t.Errorf("colour profile lost: got %d bytes, want %d", len(got), len(profile))
	}
}

func TestWebPColorProfile(t *testing.T) {
	profile := []byte("a profile, of a sort")
	chunk := func(id string, payload []byte) []byte {
		b := append([]byte(id), binary.LittleEndian.AppendUint32(nil, uint32(len(payload)))...)
		b = append(b, payload...)
		// Odd-length chunks are padded, and a reader that misses that loses its place.
		if len(payload)%2 == 1 {
			b = append(b, 0)
		}
		return b
	}
	webp := append([]byte("RIFF\x00\x00\x00\x00WEBP"), chunk("VP8X", make([]byte, 9))...)
	webp = append(webp, chunk("ICCP", profile)...)
	if got := readChunkedICC(bytes.NewReader(webp)); !bytes.Equal(got, profile) {
		t.Errorf("got %q, want %q", got, profile)
	}
}

// The grid and the viewer both serve these re-encodes; untagged, a P3 photo renders as sRGB.
func TestScaledOutputsKeepColorProfile(t *testing.T) {
	dir := t.TempDir()
	profile := bytes.Repeat([]byte("p3"), 200)
	src := filepath.Join(dir, "photo.jpg")
	writeTestJPEG(t, src, 1200, 800, jpegMeta{icc: profile})

	outs := []scaledOutput{
		{filepath.Join(dir, "thumb.jpg"), thumbMaxDim, thumbJPEGQuality},
		{filepath.Join(dir, "display.jpg"), displayMaxDim, displayJPEGQuality},
	}
	if err := generateOutputs(src, outs); err != nil {
		t.Fatal(err)
	}
	for _, out := range outs {
		if got := readJPEGMeta(bytes.NewReader(readFile(t, out.path))).icc; !bytes.Equal(got, profile) {
			t.Errorf("%s: profile lost, got %d bytes, want %d", filepath.Base(out.path), len(got), len(profile))
		}
	}
}

// JPEG has no alpha, so a transparent PNG that isn't flattened first comes out black.
func TestResizeImageFlattensTransparency(t *testing.T) {
	s, root := trashServer(t)
	writeTestPNG(t, filepath.Join(root, "logo.png"), 1200, 800, nil, true)

	rec := postJSON(t, s.resizeImageHandler, "/api/media/resize-image",
		`{"path":"logo.png","maxDim":400,"quality":80}`)
	if rec.Code != 200 {
		t.Fatalf("got %d, want 200 (%s)", rec.Code, rec.Body)
	}
	img, _, err := image.Decode(bytes.NewReader(readFile(t, filepath.Join(root, "logo-resized.jpg"))))
	if err != nil {
		t.Fatal(err)
	}
	b := img.Bounds()
	r, g, bl, _ := img.At(b.Dx()*3/4, b.Dy()/2).RGBA()
	if r>>8 < 250 || g>>8 < 250 || bl>>8 < 250 {
		t.Errorf("transparent half didn't flatten to white: got %d,%d,%d", r>>8, g>>8, bl>>8)
	}
}

// A chunk lost in transit leaves a profile that would misrender worse than none at all.
func TestReadJPEGMetaDropsIncompleteProfile(t *testing.T) {
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, image.NewRGBA(image.Rect(0, 0, 8, 8)), nil); err != nil {
		t.Fatal(err)
	}
	jpg := spliceMeta(buf.Bytes(), jpegMeta{icc: make([]byte, 2*maxICCChunk)})
	// Renumber the first chunk, so the pair still claims a count of two but nothing is chunk one.
	i := bytes.Index(jpg, []byte(iccPrefix))
	if i < 0 {
		t.Fatal("no profile to damage")
	}
	jpg[i+len(iccPrefix)] = 2
	if got := readJPEGMeta(bytes.NewReader(jpg)).icc; got != nil {
		t.Errorf("kept %d bytes of a profile missing a chunk", len(got))
	}
}

func readFile(t *testing.T, path string) []byte {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func TestResizeImageReplaceTrashesOriginal(t *testing.T) {
	s, root := trashServer(t)
	src := filepath.Join(root, "big.jpg")
	writeTestJPEG(t, src, 2000, 1500, jpegMeta{})
	before, _ := os.Stat(src)

	rec := postJSON(t, s.resizeImageHandler, "/api/media/resize-image",
		`{"path":"big.jpg","maxDim":600,"quality":80,"replace":true}`)
	if rec.Code != 200 {
		t.Fatalf("got %d, want 200 (%s)", rec.Code, rec.Body)
	}
	after, err := os.Stat(src)
	if err != nil {
		t.Fatal(err)
	}
	if after.Size() >= before.Size() {
		t.Errorf("not smaller: %d -> %d", before.Size(), after.Size())
	}
	if !after.ModTime().Equal(before.ModTime()) {
		t.Error("mtime should carry over so sort order doesn't jump")
	}
	if _, err := os.Stat(filepath.Join(root, trashDirName, "big.jpg")); err != nil {
		t.Errorf("replaced original is not recoverable: %v", err)
	}
}

func TestResizeImageRejectsBadParams(t *testing.T) {
	s, root := trashServer(t)
	writeTestJPEG(t, filepath.Join(root, "p.jpg"), 800, 600, jpegMeta{})
	for _, body := range []string{
		`{"path":"p.jpg","maxDim":10,"quality":80}`,
		`{"path":"p.jpg","maxDim":99999,"quality":80}`,
		`{"path":"p.jpg","maxDim":400,"quality":5}`,
		`{"path":"p.jpg","maxDim":400,"quality":100}`,
	} {
		if rec := postJSON(t, s.resizeImageHandler, "/api/media/resize-image", body); rec.Code != 400 {
			t.Errorf("%s: got %d, want 400", body, rec.Code)
		}
	}
}

func TestEditTargetRejectsTrashAndWrongType(t *testing.T) {
	s, root := trashServer(t)
	if err := os.WriteFile(filepath.Join(root, "notes.txt"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, "/", nil)
	if _, err := s.localEditTarget(req, "notes.txt", imageThumbExts); err == nil {
		t.Error("a text file should not be resizable as an image")
	} else if editStatus(err) != http.StatusUnsupportedMediaType {
		t.Errorf("status: got %d", editStatus(err))
	}

	writeTestJPEG(t, filepath.Join(root, "gone.jpg"), 100, 100, jpegMeta{})
	postJSON(t, s.deleteHandler, "/api/files/delete", `{"path":"gone.jpg"}`)
	if _, err := s.localEditTarget(req, ".trash/gone.jpg", imageThumbExts); err == nil {
		t.Error("editing inside the trash should be refused")
	}
}

func TestTrimFormat(t *testing.T) {
	for ext, want := range map[string]string{
		".mp3": "mp3", ".flac": "flac", ".wav": "wav",
		".ogg": "ogg", ".opus": "ogg", ".m4a": "ipod", ".aac": "ipod",
	} {
		got, err := trimFormat("song" + ext)
		if err != nil || got != want {
			t.Errorf("%s: got %q %v, want %q", ext, got, err, want)
		}
	}
	if _, err := trimFormat("song.wma"); err == nil {
		t.Error("an unsupported container should be refused, not guessed at")
	}
}

func TestTrimRejectsBadRanges(t *testing.T) {
	s, root := trashServer(t)
	if err := os.WriteFile(filepath.Join(root, "a.mp3"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	for _, body := range []string{
		`{"path":"a.mp3","start":5,"end":5}`,
		`{"path":"a.mp3","start":10,"end":2}`,
		`{"path":"a.mp3","start":-1,"end":5}`,
		`{"path":"a.mp3","start":1,"end":1.05}`,
	} {
		if rec := postJSON(t, s.trimAudioHandler, "/api/media/trim-audio", body); rec.Code != 400 {
			t.Errorf("%s: got %d, want 400", body, rec.Code)
		}
	}
}

func TestSecondsArg(t *testing.T) {
	for in, want := range map[float64]string{0: "0.000", 12.3456: "12.346", 3600: "3600.000"} {
		if got := secondsArg(in); got != want {
			t.Errorf("secondsArg(%v) = %q, want %q", in, got, want)
		}
	}
}

func TestReadFFmpegProgress(t *testing.T) {
	out := "frame=10\nout_time_us=5000000\nfps=25\nout_time_us=50000000\nprogress=continue\n"
	var last float64
	readFFmpegProgress(strings.NewReader(out), 100, func(p float64) { last = p })
	if math.Abs(last-0.5) > 0.001 {
		t.Errorf("got %v, want 0.5", last)
	}

	// A run past the probed length must not report over 100%.
	readFFmpegProgress(strings.NewReader("out_time_us=999000000\n"), 100, func(p float64) { last = p })
	if last > 1 {
		t.Errorf("progress exceeded 1: %v", last)
	}

	// With no known duration there is nothing to divide by, so nothing is reported.
	called := false
	readFFmpegProgress(strings.NewReader("out_time_us=5000000\n"), 0, func(float64) { called = true })
	if called {
		t.Error("reported progress without a known duration")
	}
}

func TestJobQueueRunsAndReports(t *testing.T) {
	q := newJobQueue()
	done := make(chan struct{})
	j := &job{Kind: "test", Name: "x", run: func(j *job) error {
		q.setProgress(j.ID, 0.5)
		close(done)
		return nil
	}}
	if err := q.add(j); err != nil {
		t.Fatal(err)
	}
	<-done
	waitFor(t, func() bool { return statusOf(q, j.ID) == jobDone })
	for _, row := range q.list() {
		if row.ID == j.ID && row.Progress != 1 {
			t.Errorf("finished job progress: got %v, want 1", row.Progress)
		}
	}
}

func TestJobQueueRecordsFailure(t *testing.T) {
	q := newJobQueue()
	j := &job{Kind: "test", run: func(*job) error { return errors.New("boom") }}
	if err := q.add(j); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool { return statusOf(q, j.ID) == jobFailed })
	for _, row := range q.list() {
		if row.ID == j.ID && row.Error != "boom" {
			t.Errorf("error: got %q, want %q", row.Error, "boom")
		}
	}
}

func TestJobQueueCancelsQueuedWork(t *testing.T) {
	q := newJobQueue()
	release := make(chan struct{})
	blocker := &job{Kind: "test", run: func(*job) error { <-release; return nil }}
	if err := q.add(blocker); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool { return statusOf(q, blocker.ID) == jobRunning })

	queued := &job{Kind: "test", run: func(*job) error { t.Error("canceled job ran anyway"); return nil }}
	if err := q.add(queued); err != nil {
		t.Fatal(err)
	}
	if !q.cancel(queued.ID) {
		t.Fatal("cancel of a queued job returned false")
	}
	close(release)
	waitFor(t, func() bool { return statusOf(q, blocker.ID) == jobDone })
	if got := statusOf(q, queued.ID); got != jobCanceled {
		t.Errorf("status: got %q, want canceled", got)
	}
	if q.cancel("nosuchjob") {
		t.Error("cancel of an unknown id should report false")
	}
}

func statusOf(q *jobQueue, id string) jobStatus {
	q.mu.Lock()
	defer q.mu.Unlock()
	if j := q.jobs[id]; j != nil {
		return j.Status
	}
	return ""
}

func waitFor(t *testing.T, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(2 * time.Millisecond)
	}
	t.Fatal("timed out waiting for condition")
}
