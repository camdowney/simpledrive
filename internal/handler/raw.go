package handler

import (
	"bytes"
	"context"
	"encoding/binary"
	"fmt"
	"image"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// Raw camera files are TIFF containers holding a ready-made JPEG preview; we serve that
// rather than demosaicing the sensor, which would need a C raw library.
var rawThumbExts = map[string]bool{".arw": true}

const (
	// IFDs and the MakerNote sit near the front; the preview is then read by offset.
	rawHeaderSpan     = 1 << 20
	rawPreviewMaxSize = 32 << 20
	maxRawIFDs        = 8
	maxRawSubIFDs     = 16
)

func isRawName(name string) bool {
	return rawThumbExts[strings.ToLower(filepath.Ext(name))]
}

// rawHeader reads the leading TIFF block and returns it with its byte order and first IFD.
func rawHeader(ra io.ReaderAt, size int64) ([]byte, binary.ByteOrder, int, bool) {
	n := int64(rawHeaderSpan)
	if size < n {
		n = size
	}
	if n < 8 {
		return nil, nil, 0, false
	}
	head := make([]byte, n)
	if _, err := ra.ReadAt(head, 0); err != nil && err != io.EOF {
		return nil, nil, 0, false
	}
	order, ifd0, ok := exifByteOrder(head)
	if !ok {
		return nil, nil, 0, false
	}
	return head, order, ifd0, true
}

// rawPreview returns the largest JPEG embedded in a raw file, with EXIF orientation applied
// so browsers rotate it the way the camera recorded it.
func rawPreview(ra io.ReaderAt, size int64) ([]byte, error) {
	head, order, ifd0, ok := rawHeader(ra, size)
	if !ok {
		return nil, image.ErrFormat
	}
	off, length := largestEmbeddedJPEG(head, order, ifd0)
	if length == 0 || off+int64(length) > size {
		return nil, image.ErrFormat
	}
	buf := make([]byte, length)
	if _, err := ra.ReadAt(buf, off); err != nil && err != io.EOF {
		return nil, image.ErrFormat
	}
	if !bytes.HasPrefix(buf, []byte{0xFF, 0xD8}) {
		return nil, image.ErrFormat
	}
	return withOrientation(buf, parseExifOrientation(head)), nil
}

// largestEmbeddedJPEG scans the IFD chain, its SubIFDs and Sony's MakerNote for preview JPEGs,
// returning the biggest since cameras store a tiny thumbnail alongside a usable preview.
func largestEmbeddedJPEG(tiff []byte, order binary.ByteOrder, ifd0 int) (int64, int) {
	bestOff, bestLen := 0, 0
	consider := func(off, length int) {
		if off > 0 && length > bestLen && length <= rawPreviewMaxSize {
			bestOff, bestLen = off, length
		}
	}
	ifds := []int{ifd0}
	for i := 0; i < len(ifds) && i < maxRawIFDs; i++ {
		ifd := ifds[i]
		if off, ok := exifLong(tiff, order, ifd, 0x0201); ok {
			if length, ok := exifLong(tiff, order, ifd, 0x0202); ok {
				consider(int(off), int(length))
			}
		}
		ifds = append(ifds, exifSubIFDs(tiff, order, ifd)...)
		if exifOff, ok := exifLong(tiff, order, ifd, 0x8769); ok {
			consider(sonyPreview(tiff, order, int(exifOff)))
		}
		if next := exifNextIFD(tiff, order, ifd); next > 0 {
			ifds = append(ifds, next)
		}
	}
	return int64(bestOff), bestLen
}

// sonyPreview locates PreviewImage in the MakerNote; Sony's sub-IFD offsets are TIFF-absolute.
func sonyPreview(tiff []byte, order binary.ByteOrder, exifIFD int) (int, int) {
	_, count, valOff, ok := exifFindEntry(tiff, order, exifIFD, 0x927C)
	if !ok || count <= 4 {
		return 0, 0
	}
	mn := int(order.Uint32(tiff[valOff:]))
	if mn <= 0 || mn+12 > len(tiff) || !bytes.HasPrefix(tiff[mn:], []byte("SONY ")) {
		return 0, 0
	}
	_, length, prevOff, ok := exifFindEntry(tiff, order, mn+12, 0x2001)
	if !ok || length == 0 || length > rawPreviewMaxSize {
		return 0, 0
	}
	return int(order.Uint32(tiff[prevOff:])), int(length)
}

// exifSubIFDs returns the offsets listed in SubIFDs (0x014A), where raw previews often live.
func exifSubIFDs(tiff []byte, order binary.ByteOrder, ifdOff int) []int {
	typ, count, valOff, ok := exifFindEntry(tiff, order, ifdOff, 0x014A)
	if !ok || typ != 4 || count == 0 || count > maxRawSubIFDs {
		return nil
	}
	start := valOff
	if count > 1 {
		start = int(order.Uint32(tiff[valOff:]))
	}
	if start < 0 {
		return nil
	}
	offs := make([]int, 0, count)
	for i := 0; i < int(count); i++ {
		p := start + i*4
		if p+4 > len(tiff) {
			break
		}
		offs = append(offs, int(order.Uint32(tiff[p:])))
	}
	return offs
}

// exifNextIFD returns the offset of the IFD following ifdOff, or 0 at the end of the chain.
func exifNextIFD(tiff []byte, order binary.ByteOrder, ifdOff int) int {
	if ifdOff < 0 || ifdOff+2 > len(tiff) {
		return 0
	}
	end := ifdOff + 2 + int(order.Uint16(tiff[ifdOff:]))*12
	if end < 0 || end+4 > len(tiff) {
		return 0
	}
	return int(order.Uint32(tiff[end:]))
}

// withOrientation splices a minimal EXIF block into a preview that carries none, so the
// container's rotation isn't lost; previews that already declare one are left alone.
func withOrientation(jpg []byte, orientation int) []byte {
	if orientation <= 1 || orientation > 8 || len(jpg) < 2 {
		return jpg
	}
	if tiff := jpegExifTIFF(bytes.NewReader(jpg)); tiff != nil {
		return jpg
	}
	tiff := make([]byte, 26)
	copy(tiff, "II*\x00")
	binary.LittleEndian.PutUint32(tiff[4:], 8)
	binary.LittleEndian.PutUint16(tiff[8:], 1)
	binary.LittleEndian.PutUint16(tiff[10:], 0x0112)
	binary.LittleEndian.PutUint16(tiff[12:], 3)
	binary.LittleEndian.PutUint32(tiff[14:], 1)
	binary.LittleEndian.PutUint16(tiff[18:], uint16(orientation))

	seg := make([]byte, 0, 4+6+len(tiff))
	seg = append(seg, 0xFF, 0xE1, 0, 0)
	binary.BigEndian.PutUint16(seg[2:], uint16(2+6+len(tiff)))
	seg = append(seg, "Exif\x00\x00"...)
	seg = append(seg, tiff...)

	out := make([]byte, 0, len(jpg)+len(seg))
	out = append(out, jpg[:2]...)
	out = append(out, seg...)
	return append(out, jpg[2:]...)
}

// generateRawOutputs builds scaled JPEGs from the embedded preview instead of the sensor data.
func generateRawOutputs(srcAbs string, outs []scaledOutput) error {
	f, err := os.Open(srcAbs)
	if err != nil {
		return err
	}
	defer f.Close()
	fi, err := f.Stat()
	if err != nil {
		return err
	}
	jpg, err := rawPreview(f, fi.Size())
	if err != nil {
		return err
	}
	return writeScaledAll(bytes.NewReader(jpg), outs)
}

// readRawMeta fills dimensions and capture time from the raw file's own TIFF header.
func readRawMeta(ra io.ReaderAt, size int64, modTime time.Time, meta *fileMeta) {
	head, order, ifd0, ok := rawHeader(ra, size)
	if !ok {
		return
	}
	meta.Width, meta.Height = rawDimensions(head, order, ifd0)
	// Orientations 5-8 rotate by 90°, so the shown image swaps width and height.
	if o := parseExifOrientation(head); o >= 5 && o <= 8 {
		meta.Width, meta.Height = meta.Height, meta.Width
	}
	if t, ok := exifDateTaken(head); ok {
		meta.DateTaken = clampedRFC3339(t, modTime)
	}
}

// rawDimensions prefers the Exif pixel dimensions; IFD0 often describes only the preview.
func rawDimensions(tiff []byte, order binary.ByteOrder, ifd0 int) (int, int) {
	if exifOff, ok := exifLong(tiff, order, ifd0, 0x8769); ok {
		w, wOK := exifLong(tiff, order, int(exifOff), 0xA002)
		h, hOK := exifLong(tiff, order, int(exifOff), 0xA003)
		if wOK && hOK && w > 0 && h > 0 {
			return int(w), int(h)
		}
	}
	w, wOK := exifLong(tiff, order, ifd0, 0x0100)
	h, hOK := exifLong(tiff, order, ifd0, 0x0101)
	if wOK && hOK {
		return int(w), int(h)
	}
	return 0, 0
}

// previewHandler — GET /api/files/preview?path=<rel> serves a raw file's embedded JPEG,
// which is what the viewer shows since no browser decodes the raw container.
func (s *server) previewHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		jsonErr(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	res, err := s.resolve(r, r.URL.Query().Get("path"))
	if err != nil {
		jsonErr(w, err.Error(), http.StatusBadRequest)
		return
	}
	if res.isS3() {
		s.previewS3(w, r, res)
		return
	}
	if !isRawName(res.abs) {
		jsonErr(w, "not previewable", http.StatusUnsupportedMediaType)
		return
	}

	f, err := os.Open(res.abs)
	if err != nil {
		if os.IsNotExist(err) {
			jsonErr(w, "not found", http.StatusNotFound)
			return
		}
		jsonErr(w, "read error", http.StatusInternalServerError)
		return
	}
	defer f.Close()
	fi, err := f.Stat()
	if err != nil || !fi.Mode().IsRegular() {
		jsonErr(w, "not previewable", http.StatusUnsupportedMediaType)
		return
	}

	etag := fmt.Sprintf(`"raw-%x-%x"`, fi.ModTime().UnixNano(), fi.Size())
	if servePreviewNotModified(w, r, etag) {
		return
	}
	jpg, err := rawPreview(f, fi.Size())
	if err != nil {
		jsonErr(w, "not previewable", http.StatusUnsupportedMediaType)
		return
	}
	writePreview(w, etag, jpg)
}

func (s *server) previewS3(w http.ResponseWriter, r *http.Request, res *resolved) {
	if !isRawName(res.rest) {
		jsonErr(w, "not previewable", http.StatusUnsupportedMediaType)
		return
	}
	obj, err := res.cli.Head(r.Context(), res.key())
	if err != nil {
		s3Fail(w, err)
		return
	}
	etag := `"raw-` + strings.Trim(obj.ETag, `"`) + `"`
	if servePreviewNotModified(w, r, etag) {
		return
	}
	jpg, err := rawPreview(s3ReaderAt{ctx: r.Context(), res: res}, obj.Size)
	if err != nil {
		jsonErr(w, "not previewable", http.StatusUnsupportedMediaType)
		return
	}
	writePreview(w, etag, jpg)
}

func servePreviewNotModified(w http.ResponseWriter, r *http.Request, etag string) bool {
	if !strings.Contains(r.Header.Get("If-None-Match"), etag) {
		return false
	}
	w.Header().Set("Cache-Control", "private, max-age=604800")
	w.Header().Set("ETag", etag)
	w.WriteHeader(http.StatusNotModified)
	return true
}

func writePreview(w http.ResponseWriter, etag string, jpg []byte) {
	w.Header().Set("Content-Type", "image/jpeg")
	w.Header().Set("Cache-Control", "private, max-age=604800")
	w.Header().Set("ETag", etag)
	w.Write(jpg)
}

// s3ReaderAt reads an object by ranged GET, so a raw preview costs two small requests
// rather than downloading the whole file.
type s3ReaderAt struct {
	ctx context.Context
	res *resolved
}

func (r s3ReaderAt) ReadAt(p []byte, off int64) (int, error) {
	if len(p) == 0 {
		return 0, nil
	}
	rng := fmt.Sprintf("bytes=%d-%d", off, off+int64(len(p))-1)
	resp, err := r.res.cli.Get(r.ctx, r.res.key(), rng)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	n, err := io.ReadFull(resp.Body, p)
	if err == io.ErrUnexpectedEOF {
		err = io.EOF
	}
	return n, err
}
