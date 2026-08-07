package handler

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"image"
	"image/color"
	"image/jpeg"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"simpledrive/internal/config"
)

// buildARW builds a TIFF container laid out like a Sony ARW: a tiny IFD1 thumbnail, a mid-size
// SubIFD preview, and the full PreviewImage behind the MakerNote.
func buildARW(orientation uint16, dateTaken string, thumb, mid, big []byte) []byte {
	le := binary.LittleEndian
	dt := append([]byte(dateTaken), 0)
	ifdSize := func(n int) int { return 2 + 12*n + 4 }

	ifd0Off := 8
	ifd1Off := ifd0Off + ifdSize(3)
	subOff := ifd1Off + ifdSize(2)
	exifOff := subOff + ifdSize(2)
	dtOff := exifOff + ifdSize(4)
	mnOff := dtOff + len(dt)
	mnIFD := mnOff + 12
	thumbOff := mnIFD + ifdSize(1)
	midOff := thumbOff + len(thumb)
	bigOff := midOff + len(mid)

	buf := make([]byte, bigOff+len(big))
	copy(buf, "II")
	le.PutUint16(buf[2:], 0x2A)
	le.PutUint32(buf[4:], uint32(ifd0Off))

	putIFD := func(off int, entries [][4]uint32, next int) {
		le.PutUint16(buf[off:], uint16(len(entries)))
		p := off + 2
		for _, e := range entries {
			le.PutUint16(buf[p:], uint16(e[0]))
			le.PutUint16(buf[p+2:], uint16(e[1]))
			le.PutUint32(buf[p+4:], e[2])
			le.PutUint32(buf[p+8:], e[3])
			p += 12
		}
		le.PutUint32(buf[p:], uint32(next))
	}

	putIFD(ifd0Off, [][4]uint32{
		{0x0112, 3, 1, uint32(orientation)},
		{0x014A, 4, 1, uint32(subOff)},
		{0x8769, 4, 1, uint32(exifOff)},
	}, ifd1Off)
	putIFD(ifd1Off, [][4]uint32{
		{0x0201, 4, 1, uint32(thumbOff)},
		{0x0202, 4, 1, uint32(len(thumb))},
	}, 0)
	putIFD(subOff, [][4]uint32{
		{0x0201, 4, 1, uint32(midOff)},
		{0x0202, 4, 1, uint32(len(mid))},
	}, 0)
	putIFD(exifOff, [][4]uint32{
		{0xA002, 4, 1, 6000},
		{0xA003, 4, 1, 4000},
		{0x9003, 2, uint32(len(dt)), uint32(dtOff)},
		{0x927C, 7, uint32(12 + ifdSize(1)), uint32(mnOff)},
	}, 0)
	copy(buf[dtOff:], dt)
	copy(buf[mnOff:], "SONY DSC \x00\x00\x00")
	putIFD(mnIFD, [][4]uint32{{0x2001, 7, uint32(len(big)), uint32(bigOff)}}, 0)
	copy(buf[thumbOff:], thumb)
	copy(buf[midOff:], mid)
	copy(buf[bigOff:], big)
	return buf
}

func plainJPEG(t *testing.T, w, h int) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			img.Set(x, y, color.RGBA{uint8(x), uint8(y), 90, 255})
		}
	}
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, img, nil); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

// sampleARW is a portrait-orientation raw whose largest embedded preview is 800x600.
func sampleARW(t *testing.T) []byte {
	t.Helper()
	return buildARW(6, "2021:07:04 13:37:00",
		plainJPEG(t, 160, 120), plainJPEG(t, 320, 240), plainJPEG(t, 800, 600))
}

func writeARW(t *testing.T, root, name string) string {
	t.Helper()
	p := filepath.Join(root, name)
	if err := os.WriteFile(p, sampleARW(t), 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestRawPreviewPicksLargestEmbedded(t *testing.T) {
	data := sampleARW(t)
	jpg, err := rawPreview(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		t.Fatalf("rawPreview: %v", err)
	}
	cfg, _, err := image.DecodeConfig(bytes.NewReader(jpg))
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	if cfg.Width != 800 || cfg.Height != 600 {
		t.Fatalf("preview = %dx%d, want 800x600", cfg.Width, cfg.Height)
	}
	// The container's orientation must survive into a preview that carries no EXIF of its own.
	if o := jpegOrientation(bytes.NewReader(jpg)); o != 6 {
		t.Fatalf("orientation = %d, want 6", o)
	}
}

func TestRawPreviewRejectsNonTIFF(t *testing.T) {
	data := plainJPEG(t, 32, 32)
	if _, err := rawPreview(bytes.NewReader(data), int64(len(data))); err != image.ErrFormat {
		t.Fatalf("err = %v, want ErrFormat", err)
	}
}

func TestWithOrientationKeepsExistingExif(t *testing.T) {
	jpg := jpegWithExif(t, 40, 40, buildExifTIFF(3, "2024:01:02 03:04:05"))
	if got := withOrientation(jpg, 6); !bytes.Equal(got, jpg) {
		t.Fatal("preview with its own EXIF should be left untouched")
	}
}

func TestRawThumbHandler(t *testing.T) {
	root := t.TempDir()
	writeARW(t, root, "shot.arw")
	s := &server{cfg: &config.Config{RootDir: root}, thumbs: newThumbCache(t.TempDir())}

	w := httptest.NewRecorder()
	s.thumbHandler(w, httptest.NewRequest("GET", "/api/files/thumb?path=/shot.arw", nil))
	if w.Code != 200 {
		t.Fatalf("status %d: %s", w.Code, w.Body)
	}
	if ct := w.Header().Get("Content-Type"); ct != "image/jpeg" {
		t.Errorf("content type = %q", ct)
	}
	cfg, _, err := image.DecodeConfig(bytes.NewReader(w.Body.Bytes()))
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	// Orientation 6 rotates the 800x600 preview, so the thumb comes out taller than wide.
	if cfg.Height <= cfg.Width || cfg.Height > thumbMaxDim {
		t.Fatalf("thumb = %dx%d, want portrait within %d", cfg.Width, cfg.Height, thumbMaxDim)
	}
}

// A folder of raws must preview from one of them, or grids fall back to icons.
func TestRawFolderPreview(t *testing.T) {
	root := t.TempDir()
	sub := filepath.Join(root, "trip")
	if err := os.Mkdir(sub, 0755); err != nil {
		t.Fatal(err)
	}
	writeARW(t, sub, "b.arw")
	s := &server{cfg: &config.Config{RootDir: root}, thumbs: newThumbCache(t.TempDir())}

	w := httptest.NewRecorder()
	s.thumbHandler(w, httptest.NewRequest("GET", "/api/files/thumb?path=/trip", nil))
	if w.Code != 200 {
		t.Fatalf("status %d: %s", w.Code, w.Body)
	}
	if !bytes.HasPrefix(w.Body.Bytes(), []byte{0xFF, 0xD8}) {
		t.Fatal("folder preview is not a JPEG")
	}
}

func TestRawMetaHandler(t *testing.T) {
	root := t.TempDir()
	writeARW(t, root, "shot.arw")
	m := getMeta(t, root, "/shot.arw")
	// Exif records 6000x4000; orientation 6 rotates it, so the reported size swaps.
	if m.Width != 4000 || m.Height != 6000 {
		t.Fatalf("dimensions = %dx%d, want 4000x6000", m.Width, m.Height)
	}
	if m.DateTaken == "" {
		t.Fatal("expected dateTaken")
	}
}

func TestPreviewHandler(t *testing.T) {
	root := t.TempDir()
	writeARW(t, root, "shot.arw")
	s := &server{cfg: &config.Config{RootDir: root}}

	w := httptest.NewRecorder()
	s.previewHandler(w, httptest.NewRequest("GET", "/api/files/preview?path=/shot.arw", nil))
	if w.Code != 200 {
		t.Fatalf("status %d: %s", w.Code, w.Body)
	}
	if ct := w.Header().Get("Content-Type"); ct != "image/jpeg" {
		t.Errorf("content type = %q", ct)
	}
	cfg, _, err := image.DecodeConfig(bytes.NewReader(w.Body.Bytes()))
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	if cfg.Width != 800 || cfg.Height != 600 {
		t.Fatalf("preview = %dx%d, want the full 800x600 embedded JPEG", cfg.Width, cfg.Height)
	}

	etag := w.Header().Get("ETag")
	req := httptest.NewRequest("GET", "/api/files/preview?path=/shot.arw", nil)
	req.Header.Set("If-None-Match", etag)
	w2 := httptest.NewRecorder()
	s.previewHandler(w2, req)
	if w2.Code != 304 {
		t.Fatalf("revalidation status = %d, want 304", w2.Code)
	}
}

func TestPreviewHandlerRejectsNonRaw(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "photo.jpg"), plainJPEG(t, 32, 32), 0o644); err != nil {
		t.Fatal(err)
	}
	s := &server{cfg: &config.Config{RootDir: root}}
	w := httptest.NewRecorder()
	s.previewHandler(w, httptest.NewRequest("GET", "/api/files/preview?path=/photo.jpg", nil))
	if w.Code != 415 {
		t.Fatalf("status = %d, want 415", w.Code)
	}
}

// Raws in a bucket must be read by range; downloading tens of megabytes per thumbnail is the bug.
func TestRawThumbFromMountUsesRanges(t *testing.T) {
	fake := newFakeS3("my-bucket")
	defer fake.close()
	fake.put("pics/shot.arw", string(sampleARW(t)))
	s := mountedServer(t, fake, "")

	w := httptest.NewRecorder()
	s.thumbHandler(w, httptest.NewRequest("GET", "/api/files/thumb?path=/Bucket/pics/shot.arw", nil))
	if w.Code != 200 {
		t.Fatalf("status %d: %s", w.Code, w.Body)
	}
	if !bytes.HasPrefix(w.Body.Bytes(), []byte{0xFF, 0xD8}) {
		t.Fatal("mount thumb is not a JPEG")
	}

	w2 := httptest.NewRecorder()
	s.metaHandler(w2, httptest.NewRequest("GET", "/api/files/meta?path=/Bucket/pics/shot.arw", nil))
	if w2.Code != 200 {
		t.Fatalf("meta status %d: %s", w2.Code, w2.Body)
	}
	var m fileMeta
	if err := json.Unmarshal(w2.Body.Bytes(), &m); err != nil {
		t.Fatal(err)
	}
	if m.Width != 4000 || m.Height != 6000 {
		t.Fatalf("mount dimensions = %dx%d, want 4000x6000", m.Width, m.Height)
	}
}
