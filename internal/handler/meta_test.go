package handler

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"simpledrive/internal/config"
)

// buildExifTIFF builds a little-endian TIFF block with an orientation and a
// DateTimeOriginal, matching the layout jpegExifTIFF hands to the parsers.
func buildExifTIFF(orientation uint16, dateTaken string) []byte {
	le := binary.LittleEndian
	dt := append([]byte(dateTaken), 0)

	const ifd0Off = 8
	ifd0Size := 2 + 2*12 + 4 // count + 2 entries + next-IFD offset
	exifIFDOff := ifd0Off + ifd0Size
	exifIFDSize := 2 + 12 + 4
	dtOff := exifIFDOff + exifIFDSize

	buf := make([]byte, dtOff+len(dt))
	copy(buf, "II")
	le.PutUint16(buf[2:], 0x2A)
	le.PutUint32(buf[4:], ifd0Off)

	le.PutUint16(buf[ifd0Off:], 2)
	e := ifd0Off + 2
	le.PutUint16(buf[e:], 0x0112) // Orientation
	le.PutUint16(buf[e+2:], 3)    // SHORT
	le.PutUint32(buf[e+4:], 1)
	le.PutUint16(buf[e+8:], orientation)
	e += 12
	le.PutUint16(buf[e:], 0x8769) // ExifIFDPointer
	le.PutUint16(buf[e+2:], 4)    // LONG
	le.PutUint32(buf[e+4:], 1)
	le.PutUint32(buf[e+8:], uint32(exifIFDOff))

	le.PutUint16(buf[exifIFDOff:], 1)
	e = exifIFDOff + 2
	le.PutUint16(buf[e:], 0x9003) // DateTimeOriginal
	le.PutUint16(buf[e+2:], 2)    // ASCII
	le.PutUint32(buf[e+4:], uint32(len(dt)))
	le.PutUint32(buf[e+8:], uint32(dtOff))

	copy(buf[dtOff:], dt)
	return buf
}

// jpegWithExif encodes a solid image, then splices an EXIF APP1 segment in after the SOI.
func jpegWithExif(t *testing.T, w, h int, tiff []byte) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			img.Set(x, y, color.RGBA{200, 100, 50, 255})
		}
	}
	var raw bytes.Buffer
	if err := jpeg.Encode(&raw, img, nil); err != nil {
		t.Fatalf("encode: %v", err)
	}
	body := raw.Bytes()

	payload := append([]byte("Exif\x00\x00"), tiff...)
	seg := make([]byte, 4+len(payload))
	seg[0], seg[1] = 0xFF, 0xE1
	binary.BigEndian.PutUint16(seg[2:], uint16(len(payload)+2))
	copy(seg[4:], payload)

	out := append([]byte{}, body[:2]...) // SOI
	out = append(out, seg...)
	out = append(out, body[2:]...)
	return out
}

func TestExifDateTaken(t *testing.T) {
	tiff := buildExifTIFF(6, "2021:07:04 13:37:00")
	got, ok := exifDateTaken(tiff)
	if !ok {
		t.Fatal("expected a date")
	}
	if got.Year() != 2021 || got.Month() != 7 || got.Day() != 4 || got.Hour() != 13 || got.Minute() != 37 {
		t.Fatalf("unexpected date: %v", got)
	}
	if o := parseExifOrientation(tiff); o != 6 {
		t.Fatalf("orientation = %d, want 6", o)
	}
}

func TestMetaHandler(t *testing.T) {
	root := t.TempDir()
	// Orientation 6 rotates 90°, so 1024x768 stored should report as 768x1024.
	jpg := jpegWithExif(t, 1024, 768, buildExifTIFF(6, "2021:07:04 13:37:00"))
	if err := os.WriteFile(filepath.Join(root, "photo.jpg"), jpg, 0o644); err != nil {
		t.Fatal(err)
	}

	s := &server{cfg: &config.Config{RootDir: root}}
	req := httptest.NewRequest("GET", "/api/files/meta?path=/photo.jpg", nil)
	rr := httptest.NewRecorder()
	s.metaHandler(rr, req)

	if rr.Code != 200 {
		t.Fatalf("status %d: %s", rr.Code, rr.Body.String())
	}
	var m fileMeta
	if err := json.Unmarshal(rr.Body.Bytes(), &m); err != nil {
		t.Fatal(err)
	}
	if m.Width != 768 || m.Height != 1024 {
		t.Fatalf("dimensions = %dx%d, want 768x1024", m.Width, m.Height)
	}
	if m.DateTaken == "" {
		t.Fatal("expected dateTaken")
	}
}

// The viewer sizes a photo's stand-in before it opens anything, so the listing must carry the size.
func TestListingCarriesImageDims(t *testing.T) {
	root := t.TempDir()
	// Orientation 6 rotates 90°, so the listing must report the shown size, not the stored one.
	jpg := jpegWithExif(t, 1024, 768, buildExifTIFF(6, "2021:07:04 13:37:00"))
	if err := os.WriteFile(filepath.Join(root, "photo.jpg"), jpg, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "notes.txt"), []byte("hi"), 0o644); err != nil {
		t.Fatal(err)
	}

	s := &server{cfg: &config.Config{RootDir: root}, thumbs: newThumbCache(t.TempDir())}
	list := func() map[string]entry {
		t.Helper()
		rr := httptest.NewRecorder()
		s.filesHandler(rr, httptest.NewRequest("GET", "/api/files?path=/", nil))
		if rr.Code != 200 {
			t.Fatalf("status %d: %s", rr.Code, rr.Body.String())
		}
		var out struct {
			Entries []entry `json:"entries"`
		}
		if err := json.Unmarshal(rr.Body.Bytes(), &out); err != nil {
			t.Fatal(err)
		}
		byName := map[string]entry{}
		for _, e := range out.Entries {
			byName[e.Name] = e
		}
		return byName
	}

	got := list()
	if got["photo.jpg"].Width != 768 || got["photo.jpg"].Height != 1024 {
		t.Errorf("dimensions = %dx%d, want 768x1024", got["photo.jpg"].Width, got["photo.jpg"].Height)
	}
	if got["notes.txt"].Width != 0 {
		t.Errorf("a text file reported a size: %v", got["notes.txt"])
	}

	// Memoized by the listing, so a folder of photos decodes its headers once, not once per visit.
	abs := filepath.Join(root, "photo.jpg")
	fi, err := os.Stat(abs)
	if err != nil {
		t.Fatal(err)
	}
	if w, h, ok := s.thumbs.knownImageSize(abs, fi); !ok || w != 768 || h != 1024 {
		t.Errorf("memo after listing = %dx%d ok=%v, want 768x1024 true", w, h, ok)
	}
}

func TestMetaHandlerImageWithoutExif(t *testing.T) {
	root := t.TempDir()
	p := filepath.Join(root, "shot.png")
	var buf bytes.Buffer
	if err := png.Encode(&buf, image.NewRGBA(image.Rect(0, 0, 320, 200))); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, buf.Bytes(), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, ok := fileCreated(p); !ok {
		t.Skip("filesystem does not record birth time")
	}

	m := getMeta(t, root, "/shot.png")
	if m.Width != 320 || m.Height != 200 {
		t.Fatalf("dimensions = %dx%d, want 320x200", m.Width, m.Height)
	}
	if m.DateTaken != "" {
		t.Fatalf("no EXIF, so dateTaken should be empty, got %q", m.DateTaken)
	}
	if m.Created == "" {
		t.Fatal("expected created time")
	}
}

func TestMetaHandlerNonImage(t *testing.T) {
	root := t.TempDir()
	p := filepath.Join(root, "notes.txt")
	if err := os.WriteFile(p, []byte("hello"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, ok := fileCreated(p); !ok {
		t.Skip("filesystem does not record birth time")
	}

	m := getMeta(t, root, "/notes.txt")
	if m.Width != 0 || m.Height != 0 || m.DateTaken != "" {
		t.Fatalf("non-image should carry only created time, got %+v", m)
	}
	if m.Created == "" {
		t.Fatal("expected created time for non-image file")
	}
}

// A file copied in after its original edit has a birth time newer than mtime; the
// copy time isn't meaningful, so Created clamps to modified but still displays.
func TestMetaHandlerCreatedNewerThanModified(t *testing.T) {
	root := t.TempDir()
	p := filepath.Join(root, "copied.txt")
	if err := os.WriteFile(p, []byte("hello"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, ok := fileCreated(p); !ok {
		t.Skip("filesystem does not record birth time")
	}
	past := time.Date(2000, 1, 1, 0, 0, 0, 0, time.UTC)
	if err := os.Chtimes(p, past, past); err != nil {
		t.Fatal(err)
	}

	m := getMeta(t, root, "/copied.txt")
	ct, err := time.Parse(time.RFC3339, m.Created)
	if err != nil {
		t.Fatalf("Created should always display, got %q (%v)", m.Created, err)
	}
	if !ct.Equal(past) {
		t.Fatalf("Created should clamp to modified %v, got %v", past, ct)
	}
}

// EXIF capture time that post-dates mtime is clamped to modified the same way.
func TestMetaHandlerDateTakenNewerThanModified(t *testing.T) {
	root := t.TempDir()
	p := filepath.Join(root, "future.jpg")
	jpg := jpegWithExif(t, 64, 64, buildExifTIFF(1, "2099:01:01 00:00:00"))
	if err := os.WriteFile(p, jpg, 0o644); err != nil {
		t.Fatal(err)
	}
	past := time.Date(2000, 1, 1, 0, 0, 0, 0, time.UTC)
	if err := os.Chtimes(p, past, past); err != nil {
		t.Fatal(err)
	}

	m := getMeta(t, root, "/future.jpg")
	dt, err := time.Parse(time.RFC3339, m.DateTaken)
	if err != nil {
		t.Fatalf("DateTaken should always display, got %q (%v)", m.DateTaken, err)
	}
	if !dt.Equal(past) {
		t.Fatalf("DateTaken should clamp to modified %v, got %v", past, dt)
	}
}

func getMeta(t *testing.T, root, path string) fileMeta {
	t.Helper()
	s := &server{cfg: &config.Config{RootDir: root}}
	req := httptest.NewRequest("GET", "/api/files/meta?path="+path, nil)
	rr := httptest.NewRecorder()
	s.metaHandler(rr, req)
	if rr.Code != 200 {
		t.Fatalf("status %d: %s", rr.Code, rr.Body.String())
	}
	var m fileMeta
	if err := json.Unmarshal(rr.Body.Bytes(), &m); err != nil {
		t.Fatal(err)
	}
	return m
}
