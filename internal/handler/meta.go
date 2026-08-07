package handler

import (
	"bytes"
	"encoding/binary"
	"image"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

type fileMeta struct {
	Width     int    `json:"width,omitempty"`
	Height    int    `json:"height,omitempty"`
	Duration  int    `json:"duration,omitempty"` // whole seconds; video and audio only
	DateTaken string `json:"dateTaken,omitempty"`
	Created   string `json:"created,omitempty"`
}

// metaHandler — GET /api/files/meta?path=<rel> returns a file's creation time and,
// for images, its pixel dimensions and EXIF capture time.
func (s *server) metaHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		jsonErr(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	rel := r.URL.Query().Get("path")
	res, err := s.resolve(r, rel)
	if err != nil {
		jsonErr(w, err.Error(), http.StatusBadRequest)
		return
	}
	if res.isS3() {
		s.metaS3(w, r, res)
		return
	}
	abs := res.abs
	fi, err := os.Stat(abs)
	if err != nil {
		if os.IsNotExist(err) {
			jsonErr(w, "not found", http.StatusNotFound)
			return
		}
		jsonErr(w, "read error", http.StatusInternalServerError)
		return
	}
	modTime := fi.ModTime()

	meta := fileMeta{}
	if t, ok := fileCreated(abs); ok {
		meta.Created = clampedRFC3339(t, modTime)
	}
	switch ext := strings.ToLower(filepath.Ext(abs)); {
	case imageThumbExts[ext]:
		readImageMeta(abs, modTime, &meta)
	case rawThumbExts[ext]:
		if f, err := os.Open(abs); err == nil {
			readRawMeta(f, fi.Size(), modTime, &meta)
			f.Close()
		}
	case mvhdExts[ext]:
		if f, err := os.Open(abs); err == nil {
			readVideoMeta(f, fi.Size(), modTime, &meta)
			f.Close()
		}
	case videoThumbExts[ext]:
		// Matroska/AVI carry no mvhd; thumb generation ffprobes their length into a sidecar.
		if s.thumbs != nil {
			if hash, err := s.thumbs.contentHash(abs, fi); err == nil {
				if di, ok := s.thumbs.readDur(hash); ok {
					meta.Duration = di.Duration
				}
			}
		}
	case audioExts[ext]:
		if s.thumbs != nil {
			if hash, err := s.thumbs.contentHash(abs, fi); err == nil {
				meta.Duration = s.thumbs.audioDuration(hash, abs)
			}
		}
	}

	writeJSON(w, http.StatusOK, meta)
}

// clampedRFC3339 formats t capped at mod: a stamp newer than mtime is a copy/export time, not real.
func clampedRFC3339(t, mod time.Time) string {
	if t.After(mod) {
		t = mod
	}
	return t.Format(time.RFC3339)
}

// mediaTakenTime extracts the capture time a photo or video carries inside the file itself.
func mediaTakenTime(abs string) (time.Time, bool) {
	f, err := os.Open(abs)
	if err != nil {
		return time.Time{}, false
	}
	defer f.Close()
	fi, err := f.Stat()
	if err != nil {
		return time.Time{}, false
	}
	switch ext := strings.ToLower(filepath.Ext(abs)); {
	case imageThumbExts[ext]:
		if tiff := jpegExifTIFF(f); tiff != nil {
			return exifDateTaken(tiff)
		}
	case rawThumbExts[ext]:
		if head, _, _, ok := rawHeader(f, fi.Size()); ok {
			return exifDateTaken(head)
		}
	case videoThumbExts[ext]:
		return mp4CreationTime(f, fi.Size())
	}
	return time.Time{}, false
}

// readImageMeta fills dimensions and EXIF capture time; silently leaves them unset
// if the file can't be decoded.
func readImageMeta(abs string, modTime time.Time, meta *fileMeta) {
	f, err := os.Open(abs)
	if err != nil {
		return
	}
	defer f.Close()

	cfg, _, err := image.DecodeConfig(f)
	if err != nil {
		return
	}
	meta.Width, meta.Height = cfg.Width, cfg.Height

	if _, err := f.Seek(0, io.SeekStart); err != nil {
		return
	}
	tiff := jpegExifTIFF(f)
	if tiff == nil {
		return
	}
	// Orientations 5-8 rotate by 90°, so the shown image swaps width and height.
	if o := parseExifOrientation(tiff); o >= 5 && o <= 8 {
		meta.Width, meta.Height = meta.Height, meta.Width
	}
	if t, ok := exifDateTaken(tiff); ok {
		meta.DateTaken = clampedRFC3339(t, modTime)
	}
}

// exifDateTaken returns the capture time from a TIFF-encoded EXIF block, preferring
// DateTimeOriginal, then DateTimeDigitized in the Exif sub-IFD, then IFD0's DateTime.
func exifDateTaken(tiff []byte) (time.Time, bool) {
	order, ifd0, ok := exifByteOrder(tiff)
	if !ok {
		return time.Time{}, false
	}
	if exifOff, ok := exifLong(tiff, order, ifd0, 0x8769); ok {
		for _, tag := range []uint16{0x9003, 0x9004} {
			if s, ok := exifASCII(tiff, order, int(exifOff), tag); ok {
				if t, ok := parseExifTime(s); ok {
					return t, true
				}
			}
		}
	}
	if s, ok := exifASCII(tiff, order, ifd0, 0x0132); ok {
		if t, ok := parseExifTime(s); ok {
			return t, true
		}
	}
	return time.Time{}, false
}

func exifByteOrder(tiff []byte) (binary.ByteOrder, int, bool) {
	if len(tiff) < 8 {
		return nil, 0, false
	}
	var order binary.ByteOrder
	switch {
	case bytes.HasPrefix(tiff, []byte("II")):
		order = binary.LittleEndian
	case bytes.HasPrefix(tiff, []byte("MM")):
		order = binary.BigEndian
	default:
		return nil, 0, false
	}
	return order, int(order.Uint32(tiff[4:8])), true
}

// exifFindEntry locates a tag within the IFD at ifdOff, returning its type, count,
// and the offset of its 4-byte value/offset field.
func exifFindEntry(tiff []byte, order binary.ByteOrder, ifdOff int, tag uint16) (typ uint16, count uint32, valOff int, ok bool) {
	if ifdOff < 0 || ifdOff+2 > len(tiff) {
		return
	}
	n := int(order.Uint16(tiff[ifdOff:]))
	for i := 0; i < n; i++ {
		off := ifdOff + 2 + i*12
		if off+12 > len(tiff) {
			return
		}
		if order.Uint16(tiff[off:]) != tag {
			continue
		}
		return order.Uint16(tiff[off+2:]), order.Uint32(tiff[off+4:]), off + 8, true
	}
	return
}

func exifASCII(tiff []byte, order binary.ByteOrder, ifdOff int, tag uint16) (string, bool) {
	typ, count, valOff, ok := exifFindEntry(tiff, order, ifdOff, tag)
	if !ok || typ != 2 || count == 0 {
		return "", false
	}
	start := valOff
	if count > 4 {
		start = int(order.Uint32(tiff[valOff:]))
	}
	end := start + int(count)
	if start < 0 || end > len(tiff) || end < start {
		return "", false
	}
	return string(bytes.TrimRight(tiff[start:end], "\x00 ")), true
}

func exifLong(tiff []byte, order binary.ByteOrder, ifdOff int, tag uint16) (uint32, bool) {
	typ, count, valOff, ok := exifFindEntry(tiff, order, ifdOff, tag)
	if !ok || count == 0 {
		return 0, false
	}
	switch typ {
	case 3:
		return uint32(order.Uint16(tiff[valOff:])), true
	case 4:
		return order.Uint32(tiff[valOff:]), true
	}
	return 0, false
}

// parseExifTime parses EXIF's "YYYY:MM:DD HH:MM:SS"; EXIF carries no zone, so it's read as local.
func parseExifTime(s string) (time.Time, bool) {
	t, err := time.ParseInLocation("2006:01:02 15:04:05", strings.TrimSpace(s), time.Local)
	if err != nil || t.IsZero() {
		return time.Time{}, false
	}
	return t, true
}
