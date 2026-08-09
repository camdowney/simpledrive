package handler

import (
	"bytes"
	"compress/zlib"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"image"
	"image/jpeg"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

const (
	// Bounds on what the client may ask for, so a request can't order a 1px or an upscaled copy.
	minResizeDim     = 240
	maxResizeDim     = 8192
	minResizeQuality = 40
	maxResizeQuality = 95
	// A segment's length field is 16 bits and counts itself, so this is all one of them can carry.
	maxSegmentPayload = 65533

	exifPrefix   = "Exif\x00\x00"
	iccPrefix    = "ICC_PROFILE\x00"
	pngSignature = "\x89PNG\r\n\x1a\n"
	// Each ICC chunk spends part of its segment on the marker and its own number/count pair.
	maxICCChunk = maxSegmentPayload - len(iccPrefix) - 2
	// Profiles are numbered in a single byte, so nothing longer than this can be re-attached.
	maxICCProfile = 255 * maxICCChunk
)

// resizeImageHandler — POST /api/media/resize-image
// body: {path, maxDim, quality, replace}
func (s *server) resizeImageHandler(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Path    string `json:"path"`
		MaxDim  int    `json:"maxDim"`
		Quality int    `json:"quality"`
		Replace bool   `json:"replace"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		jsonErr(w, "bad request", http.StatusBadRequest)
		return
	}
	if body.MaxDim < minResizeDim || body.MaxDim > maxResizeDim {
		jsonErr(w, fmt.Sprintf("size must be between %d and %d", minResizeDim, maxResizeDim), http.StatusBadRequest)
		return
	}
	if body.Quality < minResizeQuality || body.Quality > maxResizeQuality {
		jsonErr(w, fmt.Sprintf("quality must be between %d and %d", minResizeQuality, maxResizeQuality), http.StatusBadRequest)
		return
	}

	abs, err := s.localEditTarget(r, body.Path, imageThumbExts)
	if err != nil {
		jsonErr(w, err.Error(), editStatus(err))
		return
	}
	fi, err := os.Stat(abs)
	if err != nil {
		jsonErr(w, "not found", http.StatusNotFound)
		return
	}

	out, err := resizeJPEG(abs, body.MaxDim, body.Quality)
	if err != nil {
		jsonErr(w, "this image couldn't be resized", http.StatusUnsupportedMediaType)
		return
	}

	// Re-encoding a photo that's already smaller than the target only costs quality.
	if int64(len(out)) >= fi.Size() && !body.Replace {
		jsonErr(w, "the resized copy would be no smaller than the original", http.StatusConflict)
		return
	}

	name := suffixedName(filepath.Base(abs), "-resized", ".jpg")
	saved, err := s.commitEdit(abs, name, body.Replace, func(dst string) error {
		return os.WriteFile(dst, out, 0o644)
	})
	if err != nil {
		jsonErr(w, "write error", http.StatusInternalServerError)
		return
	}
	// Capture time lives in the EXIF this carries over, but mtime is what the browser sorts on.
	os.Chtimes(saved, fi.ModTime(), fi.ModTime())
	s.thumbs.invalidateFolder(filepath.Dir(saved))

	writeJSON(w, http.StatusOK, map[string]any{
		"status":  "ok",
		"path":    s.relOf(saved),
		"name":    filepath.Base(saved),
		"size":    len(out),
		"wasSize": fi.Size(),
	})

}

// suffixedName marks an edited copy, keeping the source extension unless ext overrides it.
func suffixedName(name, suffix, ext string) string {
	srcExt := filepath.Ext(name)
	if ext == "" {
		ext = srcExt
	}
	return strings.TrimSuffix(name, srcExt) + suffix + ext
}

// resizeJPEG scales an image to fit maxDim and re-encodes it, carrying the source's metadata across.
func resizeJPEG(abs string, maxDim, quality int) ([]byte, error) {
	f, err := os.Open(abs)
	if err != nil {
		return nil, err
	}
	defer f.Close()

	cfg, _, err := image.DecodeConfig(f)
	if err != nil || cfg.Width*cfg.Height > thumbMaxPixels {
		return nil, image.ErrFormat
	}
	if _, err := f.Seek(0, 0); err != nil {
		return nil, err
	}
	meta := readJPEGMeta(f)
	if meta.icc == nil {
		if _, err := f.Seek(0, 0); err != nil {
			return nil, err
		}
		meta.icc = readChunkedICC(f)
	}
	if _, err := f.Seek(0, 0); err != nil {
		return nil, err
	}
	src, _, err := image.Decode(f)
	if err != nil {
		return nil, image.ErrFormat
	}

	orientation := 1
	if meta.exif != nil {
		orientation = parseExifOrientation(meta.exif)
		// The rotation is baked into the pixels now, so a carried-over tag would rotate them twice.
		clearEXIFOrientation(meta.exif)
	}
	img := applyOrientation(scaleDown(src, maxDim), orientation)
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, flattenOnWhite(img), &jpeg.Options{Quality: quality}); err != nil {
		return nil, err
	}
	return spliceMeta(buf.Bytes(), meta), nil
}

// jpegMeta is what a re-encode carries over from the source.
type jpegMeta struct {
	exif []byte // TIFF payload of the APP1 segment
	icc  []byte // colour profile, reassembled from its APP2 chunks
}

// readJPEGMeta keeps the segments worth carrying: without the profile a P3 photo reads as sRGB.
func readJPEGMeta(r io.Reader) jpegMeta {
	var m jpegMeta
	iccChunks := map[byte][]byte{}
	iccCount := 0

	var soi [2]byte
	if _, err := io.ReadFull(r, soi[:]); err != nil || soi != [2]byte{0xFF, 0xD8} {
		return m
	}
	for {
		var marker [2]byte
		if _, err := io.ReadFull(r, marker[:]); err != nil || marker[0] != 0xFF {
			break
		}
		// Standalone markers with no length field.
		if marker[1] == 0xD8 || (marker[1] >= 0xD0 && marker[1] <= 0xD7) {
			continue
		}
		var lenBuf [2]byte
		if _, err := io.ReadFull(r, lenBuf[:]); err != nil {
			break
		}
		segLen := int(binary.BigEndian.Uint16(lenBuf[:])) - 2
		// Metadata always precedes the start-of-scan marker.
		if segLen < 0 || marker[1] == 0xDA {
			break
		}
		if marker[1] != 0xE1 && marker[1] != 0xE2 {
			if _, err := io.CopyN(io.Discard, r, int64(segLen)); err != nil {
				break
			}
			continue
		}
		seg := make([]byte, segLen)
		if _, err := io.ReadFull(r, seg); err != nil {
			break
		}
		switch {
		case marker[1] == 0xE1 && m.exif == nil && bytes.HasPrefix(seg, []byte(exifPrefix)):
			m.exif = seg[len(exifPrefix):]
		case marker[1] == 0xE2 && bytes.HasPrefix(seg, []byte(iccPrefix)) && len(seg) > len(iccPrefix)+2:
			n, total := seg[len(iccPrefix)], seg[len(iccPrefix)+1]
			if n >= 1 && n <= total {
				iccChunks[n] = seg[len(iccPrefix)+2:]
				iccCount = int(total)
			}
		}
	}

	for n := 1; n <= iccCount; n++ {
		chunk, ok := iccChunks[byte(n)]
		if !ok {
			// A profile missing a chunk is unusable, and a partial one would misrender worse than none.
			return jpegMeta{exif: m.exif}
		}
		m.icc = append(m.icc, chunk...)
	}
	return m
}

// embeddedICC returns the colour profile the source carries, whatever container it arrives in.
func embeddedICC(r io.ReadSeeker) []byte {
	if icc := readJPEGMeta(r).icc; icc != nil {
		return icc
	}
	if _, err := r.Seek(0, io.SeekStart); err != nil {
		return nil
	}
	return readChunkedICC(r)
}

// readChunkedICC returns a PNG's or WebP's profile; a JPEG's comes back with readJPEGMeta.
func readChunkedICC(r io.Reader) []byte {
	var head [12]byte
	if _, err := io.ReadFull(r, head[:]); err != nil {
		return nil
	}
	switch {
	case string(head[:8]) == pngSignature:
		// The four bytes past the signature are already the first chunk's length.
		return pngICC(io.MultiReader(bytes.NewReader(head[8:]), r))
	case string(head[:4]) == "RIFF" && string(head[8:]) == "WEBP":
		return webpICC(r)
	}
	return nil
}

// pngICC walks the chunks ahead of the pixel data looking for a compressed iCCP profile.
func pngICC(r io.Reader) []byte {
	for {
		var hdr [8]byte
		if _, err := io.ReadFull(r, hdr[:]); err != nil {
			return nil
		}
		size := int64(binary.BigEndian.Uint32(hdr[:4]))
		typ := string(hdr[4:])
		// Metadata precedes the image data, so past that there is nothing left to find.
		if typ == "IDAT" || typ == "IEND" {
			return nil
		}
		if typ != "iCCP" || size > int64(maxICCProfile) {
			// Every chunk carries a 4-byte CRC after its payload.
			if _, err := io.CopyN(io.Discard, r, size+4); err != nil {
				return nil
			}
			continue
		}
		seg := make([]byte, size)
		if _, err := io.ReadFull(r, seg); err != nil {
			return nil
		}
		return inflateICCP(seg)
	}
}

// inflateICCP unpacks an iCCP chunk: a profile name, then the zlib-compressed profile itself.
func inflateICCP(seg []byte) []byte {
	i := bytes.IndexByte(seg, 0)
	// A compression-method byte follows the name, and deflate is the only one defined.
	if i < 0 || i+2 > len(seg) || seg[i+1] != 0 {
		return nil
	}
	zr, err := zlib.NewReader(bytes.NewReader(seg[i+2:]))
	if err != nil {
		return nil
	}
	defer zr.Close()
	icc, err := io.ReadAll(io.LimitReader(zr, int64(maxICCProfile)))
	if err != nil {
		return nil
	}
	return icc
}

// webpICC walks the RIFF chunks for the ICCP one, which an extended-format file puts first.
func webpICC(r io.Reader) []byte {
	for {
		var hdr [8]byte
		if _, err := io.ReadFull(r, hdr[:]); err != nil {
			return nil
		}
		size := int64(binary.LittleEndian.Uint32(hdr[4:]))
		if string(hdr[:4]) != "ICCP" {
			// Odd-length chunks are padded to the next even byte.
			if _, err := io.CopyN(io.Discard, r, size+size%2); err != nil {
				return nil
			}
			continue
		}
		if size > int64(maxICCProfile) {
			return nil
		}
		icc := make([]byte, size)
		if _, err := io.ReadFull(r, icc); err != nil {
			return nil
		}
		return icc
	}
}

// spliceMeta re-attaches the carried metadata directly after the JPEG's SOI marker.
func spliceMeta(jpg []byte, m jpegMeta) []byte {
	if len(jpg) < 2 || jpg[0] != 0xFF || jpg[1] != 0xD8 {
		return jpg
	}
	var segs []byte
	if len(m.exif) > 0 {
		if payload := append([]byte(exifPrefix), m.exif...); len(payload) <= maxSegmentPayload {
			segs = append(segs, appSegment(0xE1, payload)...)
		}
	}
	if len(m.icc) > 0 && len(m.icc) <= maxICCProfile {
		total := (len(m.icc) + maxICCChunk - 1) / maxICCChunk
		for i := 0; i < total; i++ {
			end := min(len(m.icc), (i+1)*maxICCChunk)
			payload := append([]byte(iccPrefix), byte(i+1), byte(total))
			segs = append(segs, appSegment(0xE2, append(payload, m.icc[i*maxICCChunk:end]...))...)
		}
	}

	out := make([]byte, 0, len(jpg)+len(segs))
	out = append(out, jpg[:2]...)
	out = append(out, segs...)
	return append(out, jpg[2:]...)
}

// appSegment frames a payload as an APPn segment.
func appSegment(marker byte, payload []byte) []byte {
	seg := make([]byte, 0, 4+len(payload))
	seg = append(seg, 0xFF, marker)
	seg = binary.BigEndian.AppendUint16(seg, uint16(len(payload)+2))
	return append(seg, payload...)
}

// clearEXIFOrientation rewrites IFD0's orientation tag to 1, in place.
func clearEXIFOrientation(tiff []byte) {
	order, ifd0, ok := exifByteOrder(tiff)
	if !ok {
		return
	}
	typ, _, valOff, ok := exifFindEntry(tiff, order, ifd0, 0x0112)
	if !ok || typ != 3 || valOff+2 > len(tiff) {
		return
	}
	order.PutUint16(tiff[valOff:], 1)
}

// editError carries the HTTP status a media edit should answer with.
type editError struct {
	msg    string
	status int
}

func (e *editError) Error() string { return e.msg }

func editStatus(err error) int {
	if e, ok := err.(*editError); ok {
		return e.status
	}
	return http.StatusBadRequest
}

// localEditTarget resolves a path an edit is allowed to write: local, regular, and of a known type.
func (s *server) localEditTarget(r *http.Request, rel string, allowed map[string]bool) (string, error) {
	res, err := s.resolve(r, rel)
	if err != nil {
		return "", &editError{err.Error(), http.StatusBadRequest}
	}
	// Editing a mounted object would mean a full download and re-upload, billed per byte.
	if res.isS3() {
		return "", &editError{"files in a connected bucket can't be edited here", http.StatusBadRequest}
	}
	if s.inTrash(res.abs) {
		return "", &editError{"this file is in the trash; move it out first", http.StatusBadRequest}
	}
	fi, err := os.Stat(res.abs)
	if err != nil {
		return "", &editError{"not found", http.StatusNotFound}
	}
	if !fi.Mode().IsRegular() {
		return "", &editError{"not a file", http.StatusBadRequest}
	}
	if !allowed[strings.ToLower(filepath.Ext(res.abs))] {
		return "", &editError{"unsupported file type", http.StatusUnsupportedMediaType}
	}
	return res.abs, nil
}

// commitEdit lands write's output as a sibling, or over the original, whose bytes go to the trash.
func (s *server) commitEdit(srcAbs, outName string, replace bool, write func(dst string) error) (string, error) {
	dir := filepath.Dir(srcAbs)
	tmp, err := os.CreateTemp(dir, ".edit-*")
	if err != nil {
		return "", err
	}
	tmpName := tmp.Name()
	tmp.Close()
	defer os.Remove(tmpName)

	if err := write(tmpName); err != nil {
		return "", err
	}

	if !replace {
		f, err := createUnique(dir, outName)
		if err != nil {
			return "", err
		}
		dest := f.Name()
		f.Close()
		if err := os.Rename(tmpName, dest); err != nil {
			os.Remove(dest)
			return "", err
		}
		return dest, nil
	}

	// The replaced original is recoverable for the trash window, so a bad setting isn't permanent.
	if err := s.moveToTrash(srcAbs); err != nil {
		return "", err
	}
	dest := srcAbs
	// A replace that changes container lands under the new extension, beside the old name.
	if ext := filepath.Ext(outName); ext != "" && !strings.EqualFold(ext, filepath.Ext(srcAbs)) {
		dest = strings.TrimSuffix(srcAbs, filepath.Ext(srcAbs)) + ext
	}
	if err := os.Rename(tmpName, dest); err != nil {
		return "", err
	}
	return dest, nil
}

// relOf turns an absolute path under the root back into the slash path the client addresses it by.
func (s *server) relOf(abs string) string {
	rel := strings.TrimPrefix(strings.TrimPrefix(abs, s.cfg.RootDir), string(filepath.Separator))
	return "/" + filepath.ToSlash(rel)
}
