package handler

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"image"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestThumbFromMount(t *testing.T) {
	fake := newFakeS3("my-bucket")
	defer fake.close()
	fake.put("pics/photo.jpg", string(jpegWithExif(t, 64, 32, buildExifTIFF(1, "2024:01:02 03:04:05"))))
	s := mountedServer(t, fake, "")

	w := httptest.NewRecorder()
	s.thumbHandler(w, httptest.NewRequest("GET", "/api/files/thumb?path=/Bucket/pics/photo.jpg", nil))
	if w.Code != 200 {
		t.Fatalf("thumb status %d: %s", w.Code, w.Body)
	}
	if ct := w.Header().Get("Content-Type"); ct != "image/jpeg" {
		t.Errorf("content type = %q", ct)
	}
	if !bytes.HasPrefix(w.Body.Bytes(), []byte{0xFF, 0xD8}) {
		t.Errorf("body is not a JPEG")
	}

	// The ETag is derived from the object, so a revalidation must short-circuit.
	etag := w.Header().Get("ETag")
	r := httptest.NewRequest("GET", "/api/files/thumb?path=/Bucket/pics/photo.jpg", nil)
	r.Header.Set("If-None-Match", etag)
	w = httptest.NewRecorder()
	s.thumbHandler(w, r)
	if w.Code != http.StatusNotModified {
		t.Fatalf("revalidation status = %d, want 304", w.Code)
	}
}

// A folder's preview is its sort-first previewable child, same as on the local backend.
func TestFolderThumbFromMount(t *testing.T) {
	fake := newFakeS3("my-bucket")
	defer fake.close()
	fake.put("pics/notes.txt", "not an image")
	fake.put("pics/b.jpg", string(jpegWithExif(t, 40, 40, buildExifTIFF(1, "2024:01:02 03:04:05"))))
	s := mountedServer(t, fake, "")

	w := httptest.NewRecorder()
	s.thumbHandler(w, httptest.NewRequest("GET", "/api/files/thumb?path=/Bucket/pics", nil))
	if w.Code != 200 {
		t.Fatalf("folder thumb status %d: %s", w.Code, w.Body)
	}
	if cc := w.Header().Get("Cache-Control"); cc != "private, no-cache" {
		t.Errorf("folder previews must revalidate; Cache-Control = %q", cc)
	}
}

// Editing a child's date reorders the folder, so its date-sorted preview must follow.
func TestFolderThumbTracksDateEdit(t *testing.T) {
	fake := newFakeS3("my-bucket")
	defer fake.close()
	s := mountedServer(t, fake, "")
	album := filepath.Join(s.cfg.RootDir, "album")
	if err := os.Mkdir(album, 0755); err != nil {
		t.Fatal(err)
	}
	exif := buildExifTIFF(1, "2024:01:02 03:04:05")
	for name, w := range map[string]int{"a.jpg": 40, "b.jpg": 64} {
		if err := os.WriteFile(filepath.Join(album, name), jpegWithExif(t, w, 32, exif), 0644); err != nil {
			t.Fatal(err)
		}
	}
	old := time.Date(2024, 1, 1, 0, 0, 0, 0, time.UTC)
	os.Chtimes(filepath.Join(album, "a.jpg"), old, old)
	newer := old.AddDate(0, 5, 0)
	os.Chtimes(filepath.Join(album, "b.jpg"), newer, newer)

	width := func() int {
		t.Helper()
		w := httptest.NewRecorder()
		s.thumbHandler(w, httptest.NewRequest("GET", "/api/files/thumb?path=/album&sb=date&sd=desc", nil))
		if w.Code != 200 {
			t.Fatalf("thumb status %d: %s", w.Code, w.Body)
		}
		cfg, _, err := image.DecodeConfig(bytes.NewReader(w.Body.Bytes()))
		if err != nil {
			t.Fatal(err)
		}
		return cfg.Width
	}

	if got := width(); got != 64 {
		t.Fatalf("initial preview width = %d, want newest child b.jpg (64)", got)
	}

	// A date edit rides the rename route with From == To; the dir mtime stays untouched.
	w, _ := doJSON(t, s.renameHandler, "POST", "/api/files/rename", map[string]string{
		"dir": "/album", "from": "a.jpg", "to": "a.jpg",
		"modified": newer.AddDate(1, 0, 0).Format(time.RFC3339),
	})
	if w.Code != 200 {
		t.Fatalf("rename status %d: %s", w.Code, w.Body)
	}
	if got := width(); got != 40 {
		t.Fatalf("post-edit preview width = %d, want re-dated a.jpg (40)", got)
	}
}

// The grid must not pay the viewer's scale. Building the screen-sized sibling on every thumb cost
// ~1.5s of single-core CPU per image, nearly all of it for photos the user never opens.
func TestThumbDoesNotBuildDisplaySibling(t *testing.T) {
	fake := newFakeS3("my-bucket")
	defer fake.close()
	fake.put("pics/photo.jpg", string(jpegWithExif(t, 3000, 1500, buildExifTIFF(1, "2024:01:02 03:04:05"))))
	s := mountedServer(t, fake, "")

	w := httptest.NewRecorder()
	s.thumbHandler(w, httptest.NewRequest("GET", "/api/files/thumb?path=/Bucket/pics/photo.jpg", nil))
	if w.Code != 200 {
		t.Fatalf("thumb status %d: %s", w.Code, w.Body)
	}
	if sibs, _ := filepath.Glob(filepath.Join(s.thumbs.dir, "*", "*-d.jpg")); len(sibs) != 0 {
		t.Errorf("thumb pass built display siblings %v, want none", sibs)
	}
}

// The display pass runs the decode once, dropping the thumb out of the image it already shrank.
func TestDisplayBuildsThumbSibling(t *testing.T) {
	fake := newFakeS3("my-bucket")
	defer fake.close()
	s := mountedServer(t, fake, "")
	big := jpegWithExif(t, 3000, 1500, buildExifTIFF(1, "2024:01:02 03:04:05"))
	if err := os.WriteFile(filepath.Join(s.cfg.RootDir, "big.jpg"), big, 0644); err != nil {
		t.Fatal(err)
	}

	w := httptest.NewRecorder()
	s.displayHandler(w, httptest.NewRequest("GET", "/api/files/display?path=/big.jpg&warm=1", nil))
	if w.Code != http.StatusNoContent {
		t.Fatalf("warm status %d, want 204", w.Code)
	}
	waitForCacheFiles(t, s, "*.jpg", 2)
}

func TestDisplayLocalDownscales(t *testing.T) {
	fake := newFakeS3("my-bucket")
	defer fake.close()
	s := mountedServer(t, fake, "")
	big := jpegWithExif(t, 3000, 1500, buildExifTIFF(1, "2024:01:02 03:04:05"))
	if err := os.WriteFile(filepath.Join(s.cfg.RootDir, "big.jpg"), big, 0644); err != nil {
		t.Fatal(err)
	}

	w := httptest.NewRecorder()
	s.displayHandler(w, httptest.NewRequest("GET", "/api/files/display?path=/big.jpg&warm=1", nil))
	if w.Code != http.StatusNoContent {
		t.Fatalf("warm status %d, want 204", w.Code)
	}
	waitForDisplay(t, s)

	w = httptest.NewRecorder()
	s.displayHandler(w, httptest.NewRequest("GET", "/api/files/display?path=/big.jpg", nil))
	if w.Code != 200 {
		t.Fatalf("display status %d: %s", w.Code, w.Body)
	}
	cfg, _, err := image.DecodeConfig(bytes.NewReader(w.Body.Bytes()))
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	if cfg.Width != 1920 || cfg.Height != 960 {
		t.Errorf("display dims = %dx%d, want 1920x960", cfg.Width, cfg.Height)
	}

	// Same content hash must not collide across the thumb and display variants.
	w = httptest.NewRecorder()
	s.thumbHandler(w, httptest.NewRequest("GET", "/api/files/thumb?path=/big.jpg", nil))
	cfg, _, err = image.DecodeConfig(bytes.NewReader(w.Body.Bytes()))
	if err != nil || cfg.Width != 320 {
		t.Errorf("thumb width = %d (err %v), want 320", cfg.Width, err)
	}
}

// A viewer open must never wait on a cold decode: it redirects to the original and builds behind it.
func TestDisplayColdRedirectsToOriginal(t *testing.T) {
	fake := newFakeS3("my-bucket")
	defer fake.close()
	s := mountedServer(t, fake, "")
	big := jpegWithExif(t, 3000, 1500, buildExifTIFF(1, "2024:01:02 03:04:05"))
	if err := os.WriteFile(filepath.Join(s.cfg.RootDir, "big.jpg"), big, 0644); err != nil {
		t.Fatal(err)
	}

	w := httptest.NewRecorder()
	s.displayHandler(w, httptest.NewRequest("GET", "/api/files/display?path=/big.jpg", nil))
	if w.Code != http.StatusFound {
		t.Fatalf("cold display status = %d, want 302", w.Code)
	}
	if loc := w.Header().Get("Location"); loc != "/api/files/download?inline=1&path=%2Fbig.jpg" {
		t.Errorf("Location = %q, want the inline original", loc)
	}
	// Caching the redirect would pin the viewer to the original long after the JPEG lands.
	if cc := w.Header().Get("Cache-Control"); cc != "no-store" {
		t.Errorf("Cache-Control = %q, want no-store", cc)
	}

	waitForDisplay(t, s)

	w = httptest.NewRecorder()
	s.displayHandler(w, httptest.NewRequest("GET", "/api/files/display?path=/big.jpg", nil))
	if w.Code != 200 {
		t.Fatalf("warm display status = %d, want 200", w.Code)
	}
	if cfg, _, err := image.DecodeConfig(bytes.NewReader(w.Body.Bytes())); err != nil || cfg.Width != 1920 {
		t.Errorf("warm display width = %d (err %v), want 1920", cfg.Width, err)
	}
}

// Prefetches must start the build without being handed the original they were meant to avoid.
func TestDisplayWarmParamSkipsRedirect(t *testing.T) {
	fake := newFakeS3("my-bucket")
	defer fake.close()
	s := mountedServer(t, fake, "")
	big := jpegWithExif(t, 3000, 1500, buildExifTIFF(1, "2024:01:02 03:04:05"))
	if err := os.WriteFile(filepath.Join(s.cfg.RootDir, "big.jpg"), big, 0644); err != nil {
		t.Fatal(err)
	}

	w := httptest.NewRecorder()
	s.displayHandler(w, httptest.NewRequest("GET", "/api/files/display?path=/big.jpg&warm=1", nil))
	if w.Code != http.StatusNoContent {
		t.Fatalf("warm status = %d, want 204", w.Code)
	}
	if loc := w.Header().Get("Location"); loc != "" {
		t.Errorf("warm request redirected to %q, want no redirect", loc)
	}
	waitForDisplay(t, s)
}

func waitForDisplay(t *testing.T, s *server) {
	t.Helper()
	waitForCacheFiles(t, s, "*-d.jpg", 1)
}

// waitForCacheFiles blocks until the background build has written n matching JPEGs to the cache.
func waitForCacheFiles(t *testing.T, s *server, pattern string, n int) {
	t.Helper()
	for deadline := time.Now().Add(60 * time.Second); time.Now().Before(deadline); {
		if m, _ := filepath.Glob(filepath.Join(s.thumbs.dir, "*", pattern)); len(m) >= n {
			return
		}
		time.Sleep(25 * time.Millisecond)
	}
	t.Fatalf("background build never wrote %d cache files matching %s", n, pattern)
}

func TestDisplayFromMount(t *testing.T) {
	fake := newFakeS3("my-bucket")
	defer fake.close()
	fake.put("pics/photo.jpg", string(jpegWithExif(t, 64, 32, buildExifTIFF(1, "2024:01:02 03:04:05"))))
	s := mountedServer(t, fake, "")

	w := httptest.NewRecorder()
	s.displayHandler(w, httptest.NewRequest("GET", "/api/files/display?path=/Bucket/pics/photo.jpg&warm=1", nil))
	if w.Code != http.StatusNoContent {
		t.Fatalf("warm status %d, want 204", w.Code)
	}
	waitForDisplay(t, s)

	w = httptest.NewRecorder()
	s.displayHandler(w, httptest.NewRequest("GET", "/api/files/display?path=/Bucket/pics/photo.jpg", nil))
	if w.Code != 200 {
		t.Fatalf("display status %d: %s", w.Code, w.Body)
	}
	cfg, _, err := image.DecodeConfig(bytes.NewReader(w.Body.Bytes()))
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	// Already screen-sized: served as-is, never upscaled.
	if cfg.Width != 64 || cfg.Height != 32 {
		t.Errorf("display dims = %dx%d, want 64x32", cfg.Width, cfg.Height)
	}

	etag := w.Header().Get("ETag")
	r := httptest.NewRequest("GET", "/api/files/display?path=/Bucket/pics/photo.jpg", nil)
	r.Header.Set("If-None-Match", etag)
	w = httptest.NewRecorder()
	s.displayHandler(w, r)
	if w.Code != http.StatusNotModified {
		t.Fatalf("revalidation status = %d, want 304", w.Code)
	}
}

func TestDisplayRejectsNonImage(t *testing.T) {
	fake := newFakeS3("my-bucket")
	defer fake.close()
	fake.put("readme.txt", "hello")
	s := mountedServer(t, fake, "")

	for _, target := range []string{
		"/api/files/display?path=/Bucket/readme.txt",
		"/api/files/display?path=/Bucket",
	} {
		w := httptest.NewRecorder()
		s.displayHandler(w, httptest.NewRequest("GET", target, nil))
		if w.Code != http.StatusUnsupportedMediaType {
			t.Fatalf("%s status = %d, want 415", target, w.Code)
		}
	}
}

func TestThumbRejectsNonImageInMount(t *testing.T) {
	fake := newFakeS3("my-bucket")
	defer fake.close()
	fake.put("readme.txt", "hello")
	s := mountedServer(t, fake, "")

	w := httptest.NewRecorder()
	s.thumbHandler(w, httptest.NewRequest("GET", "/api/files/thumb?path=/Bucket/readme.txt", nil))
	if w.Code != http.StatusUnsupportedMediaType {
		t.Fatalf("status = %d, want 415", w.Code)
	}
}

func TestMetaFromMount(t *testing.T) {
	fake := newFakeS3("my-bucket")
	defer fake.close()
	fake.put("photo.jpg", string(jpegWithExif(t, 120, 80, buildExifTIFF(1, "2020:06:07 08:09:10"))))
	s := mountedServer(t, fake, "")

	w := httptest.NewRecorder()
	s.metaHandler(w, httptest.NewRequest("GET", "/api/files/meta?path=/Bucket/photo.jpg", nil))
	if w.Code != 200 {
		t.Fatalf("meta status %d: %s", w.Code, w.Body)
	}
	var meta fileMeta
	if err := json.Unmarshal(w.Body.Bytes(), &meta); err != nil {
		t.Fatal(err)
	}
	if meta.Width != 120 || meta.Height != 80 {
		t.Errorf("dimensions = %dx%d, want 120x80", meta.Width, meta.Height)
	}
	if !strings.HasPrefix(meta.Created, "2024-01-02") {
		t.Errorf("created = %q, want the object's last-modified", meta.Created)
	}
}

func TestMetaVideoFromMountUsesSidecar(t *testing.T) {
	fake := newFakeS3("my-bucket")
	defer fake.close()
	taken := time.Date(2023, 6, 15, 10, 30, 0, 0, time.UTC)
	fake.put("clip.mp4", string(buildMOV(taken, 0, 222*time.Second)))
	s := mountedServer(t, fake, "")

	get := func() fileMeta {
		t.Helper()
		w := httptest.NewRecorder()
		s.metaHandler(w, httptest.NewRequest("GET", "/api/files/meta?path=/Bucket/clip.mp4", nil))
		if w.Code != 200 {
			t.Fatalf("meta status %d: %s", w.Code, w.Body)
		}
		var m fileMeta
		if err := json.Unmarshal(w.Body.Bytes(), &m); err != nil {
			t.Fatal(err)
		}
		return m
	}

	m := get()
	if m.Duration != 222 {
		t.Fatalf("duration = %d, want 222", m.Duration)
	}
	if !strings.HasPrefix(m.DateTaken, "2023-06-15") {
		t.Fatalf("dateTaken = %q, want the mvhd time", m.DateTaken)
	}

	// The first call must sidecar its answer; doctor it to prove the second call reads it.
	durs, err := filepath.Glob(filepath.Join(s.thumbs.dir, "*", "*.dur"))
	if err != nil || len(durs) != 1 {
		t.Fatalf("sidecars = %v (err %v), want exactly one", durs, err)
	}
	if err := os.WriteFile(durs[0], []byte(`{"duration":9}`), 0o644); err != nil {
		t.Fatal(err)
	}
	if m := get(); m.Duration != 9 {
		t.Fatalf("duration = %d, want the doctored 9: box was re-parsed instead of sidecar", m.Duration)
	}
}

func TestZipFromMount(t *testing.T) {
	fake := newFakeS3("my-bucket")
	defer fake.close()
	fake.put("tree/a.txt", "A")
	fake.put("tree/deep/b.txt", "B")
	fake.put("loose.txt", "L")
	s := mountedServer(t, fake, "")

	body, _ := json.Marshal(map[string][]string{"paths": {"/Bucket/tree", "/Bucket/loose.txt"}})
	r := httptest.NewRequest("POST", "/api/files/zip", bytes.NewReader(body))
	w := httptest.NewRecorder()
	s.zipHandler(w, r)
	if w.Code != 200 {
		t.Fatalf("zip status %d", w.Code)
	}

	zr, err := zip.NewReader(bytes.NewReader(w.Body.Bytes()), int64(w.Body.Len()))
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]string{}
	for _, f := range zr.File {
		rc, err := f.Open()
		if err != nil {
			t.Fatal(err)
		}
		var buf bytes.Buffer
		buf.ReadFrom(rc)
		rc.Close()
		got[f.Name] = buf.String()
	}
	want := map[string]string{"tree/a.txt": "A", "tree/deep/b.txt": "B", "loose.txt": "L"}
	for name, content := range want {
		if got[name] != content {
			t.Errorf("zip[%q] = %q, want %q (all: %v)", name, got[name], content, got)
		}
	}
}
