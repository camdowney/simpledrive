package handler

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	"image/color"
	"image/jpeg"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"runtime/debug"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	_ "image/gif"
	_ "image/png"

	_ "golang.org/x/image/bmp"
	_ "golang.org/x/image/webp"

	"golang.org/x/image/draw"
	"golang.org/x/sync/singleflight"
)

const (
	thumbMaxDim      = 320
	thumbJPEGQuality = 80
	// Viewer variant: covers a phone at 3x DPR and a 1080p laptop, at ~1/3 the pixels of 2560.
	displayMaxDim      = 1920
	displayJPEGQuality = 82
	// Above this the sharper scaler stops paying for itself; see scaleDown.
	catmullRomMaxDim = 640
	// Cap so a stray huge-file request can't pin the server hashing/decoding it.
	thumbMaxSourceSize = 100 << 20
	// Cap pixel count to block decompression bombs (tiny files, huge dimensions).
	thumbMaxPixels  = 50 << 20
	thumbMaxAge     = 30 * 24 * time.Hour
	thumbGCInterval = 24 * time.Hour
	maxHashMemo     = 4096
	// Above this, sample-hash (head+tail+length) instead of reading whole multi-GB files.
	fullHashMaxSize = 8 << 20
	partialHashSpan = 4 << 20
	ffmpegTimeout   = 30 * time.Second
	// Ceiling on a background display build, so a stalled fetch can't hold the decode slot.
	displayGenTimeout = 2 * time.Minute
	// Depth of the background display queue; past this the grid's thumb pass fills the gap.
	displayGenQueue = 8
	// Kept short: it only has to outlive the two ffmpeg attempts, and it rides in argv.
	s3ThumbURLTTL = 5 * time.Minute
	// Ceiling on parallel decodes; past this the client's 5-connection budget binds first anyway.
	maxDecodeConcurrency = 4
)

// Halved: a decode holds a full-size frame in the heap, ~70MB for a 48MP JPEG.
// GOMAXPROCS, not NumCPU, so a container capped below its host's core count is sized to its cap.
func decodeConcurrency() int {
	return min(max(runtime.GOMAXPROCS(0)/2, 1), maxDecodeConcurrency)
}

// Bounds in-process decoding, the one stage whose buffers stack in the heap.
var decodeSem = make(chan struct{}, decodeConcurrency())

// ffmpeg buffers out of process, so it queues on its own gate rather than the decode one.
var ffmpegSem = make(chan struct{}, decodeConcurrency())

var videoThumbExts = map[string]bool{
	".mp4": true, ".webm": true, ".mkv": true, ".mov": true, ".avi": true,
}

// Containers whose length mvhd parsing can read; the rest rely on the ffprobe sidecar.
var mvhdExts = map[string]bool{".mp4": true, ".mov": true}

var imageThumbExts = map[string]bool{
	".jpg": true, ".jpeg": true, ".png": true, ".gif": true, ".webp": true, ".bmp": true,
}

// Audio builds no thumbnail, so nothing sidecars its length until a meta request asks.
var audioExts = map[string]bool{
	".mp3": true, ".ogg": true, ".wav": true, ".flac": true, ".aac": true, ".m4a": true, ".opus": true,
}

func isVideoName(name string) bool {
	return videoThumbExts[strings.ToLower(filepath.Ext(name))]
}

// thumbableExt reports whether the server can build a thumbnail from this extension.
func thumbableExt(ext string, ffmpeg string) bool {
	return imageThumbExts[ext] || rawThumbExts[ext] || (videoThumbExts[ext] && ffmpeg != "")
}

type thumbCache struct {
	dir     string
	ffmpeg  string
	ffprobe string
	group   singleflight.Group

	// Bounds the display builds running off-request, so fast paging can't spawn goroutines freely.
	bgSem chan struct{}

	// Bounds concurrent loudness scans: each one decodes a whole file.
	loudSem chan struct{}

	mu       sync.Mutex
	durMu    sync.Mutex
	hashes   map[string]hashedFile
	previews map[string]folderPreview
	sizes    map[string]sizedImage
	durs     map[string]timedMedia
}

// hashedFile memoizes a file's content hash while it looks unchanged.
type hashedFile struct {
	size  int64
	mtime time.Time
	hash  string
}

// sizedImage memoizes a picture's pixel size while it looks unchanged; 0x0 means undecodable.
type sizedImage struct {
	size  int64
	mtime time.Time
	w, h  int
}

// timedMedia memoizes a track's length while it looks unchanged; the sidecar costs a hash to reach.
type timedMedia struct {
	size     int64
	mtime    time.Time
	duration int
}

// folderPreview memoizes a folder's thumbnail child ("" = none) while its mtime holds.
type folderPreview struct {
	mtime time.Time
	child string
}

func newThumbCache(dir string) *thumbCache {
	ffmpeg, err := exec.LookPath("ffmpeg")
	if err != nil {
		log.Printf("ffmpeg not found in PATH; video thumbnails disabled")
	}
	ffprobe, _ := exec.LookPath("ffprobe")
	return &thumbCache{
		dir:      dir,
		ffmpeg:   ffmpeg,
		ffprobe:  ffprobe,
		bgSem:    make(chan struct{}, displayGenQueue),
		loudSem:  make(chan struct{}, loudnessConcurrency),
		hashes:   map[string]hashedFile{},
		previews: map[string]folderPreview{},
		sizes:    map[string]sizedImage{},
		durs:     map[string]timedMedia{},
	}
}

// imageSize reports a picture's pixel size, memoized: every listing asks it of every image it shows.
func (c *thumbCache) imageSize(abs string, fi os.FileInfo) (int, int) {
	c.mu.Lock()
	cached, ok := c.sizes[abs]
	c.mu.Unlock()
	if ok && cached.size == fi.Size() && cached.mtime.Equal(fi.ModTime()) {
		return cached.w, cached.h
	}
	var m fileMeta
	readImageMeta(abs, fi.ModTime(), &m)

	c.mu.Lock()
	if len(c.sizes) >= maxHashMemo {
		clear(c.sizes)
	}
	c.sizes[abs] = sizedImage{size: fi.Size(), mtime: fi.ModTime(), w: m.Width, h: m.Height}
	c.mu.Unlock()
	return m.Width, m.Height
}

// knownImageSize is imageSize without the decode: what a listing can answer for free.
func (c *thumbCache) knownImageSize(abs string, fi os.FileInfo) (int, int, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	cached, ok := c.sizes[abs]
	if !ok || cached.size != fi.Size() || !cached.mtime.Equal(fi.ModTime()) {
		return 0, 0, false
	}
	return cached.w, cached.h, true
}

// thumbHandler — GET /api/files/thumb?path=<rel> serves a cached JPEG preview.
func (s *server) thumbHandler(w http.ResponseWriter, r *http.Request) {
	rel := r.URL.Query().Get("path")
	res, ok := s.resolvePath(w, r, rel)
	if !ok {
		return
	}
	if res.isS3() {
		s.thumbS3(w, r, res)
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

	// A folder's thumbnail is its sort-first previewable direct child's thumbnail.
	isDir := fi.IsDir()
	if isDir {
		sortBy, desc := thumbSortParams(r)
		child := s.thumbs.folderChild(abs, fi.ModTime(), sortBy, desc)
		if child == "" {
			jsonErr(w, "not thumbnailable", http.StatusUnsupportedMediaType)
			return
		}
		abs = child
		if fi, err = os.Stat(abs); err != nil {
			jsonErr(w, "read error", http.StatusInternalServerError)
			return
		}
	}

	video := isVideoName(abs)
	if !fi.Mode().IsRegular() || (video && s.thumbs.ffmpeg == "") {
		jsonErr(w, "not thumbnailable", http.StatusUnsupportedMediaType)
		return
	}
	// Videos and raws skip the size cap: both read only part of the file.
	if !video && !isRawName(abs) && fi.Size() > thumbMaxSourceSize {
		jsonErr(w, "not thumbnailable", http.StatusUnsupportedMediaType)
		return
	}

	hash, err := s.thumbs.contentHash(abs, fi)
	if err != nil {
		jsonErr(w, "read error", http.StatusInternalServerError)
		return
	}

	etag := `"` + hash + `"`
	cacheControl := thumbCacheControl(isDir)
	if thumbNotModified(w, r, etag, cacheControl) {
		return
	}

	cachePath, err := s.thumbs.ensure(abs, hash)
	serveThumb(w, cachePath, err, etag, cacheControl)
}

// displayHandler — GET /api/files/display?path=<rel> serves a screen-sized JPEG for the viewer.
func (s *server) displayHandler(w http.ResponseWriter, r *http.Request) {
	res, ok := s.resolveQuery(w, r)
	if !ok {
		return
	}
	if res.isS3() {
		s.displayS3(w, r, res)
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
	ext := strings.ToLower(filepath.Ext(abs))
	if !fi.Mode().IsRegular() || (!imageThumbExts[ext] && !rawThumbExts[ext]) {
		jsonErr(w, "not displayable", http.StatusUnsupportedMediaType)
		return
	}
	if !isRawName(abs) && fi.Size() > thumbMaxSourceSize {
		jsonErr(w, "not displayable", http.StatusUnsupportedMediaType)
		return
	}

	hash, err := s.thumbs.contentHash(abs, fi)
	if err != nil {
		jsonErr(w, "read error", http.StatusInternalServerError)
		return
	}

	s.serveDisplay(w, r, hash, isRawName(abs), func(context.Context) (string, error) {
		return s.thumbs.ensureDisplay(abs, hash)
	})
}

// serveDisplay redirects to the original when the JPEG isn't built: a cold decode buffers whole.
func (s *server) serveDisplay(w http.ResponseWriter, r *http.Request, hash string, raw bool,
	build func(context.Context) (string, error)) {

	etag := `"` + hash + `-d"`
	cacheControl := thumbCacheControl(false)
	if thumbNotModified(w, r, etag, cacheControl) {
		return
	}
	if s.thumbs.displayReady(hash) {
		cachePath, err := build(r.Context())
		serveThumb(w, cachePath, err, etag, cacheControl)
		return
	}

	base := context.WithoutCancel(r.Context())
	s.thumbs.background(func() {
		ctx, cancel := context.WithTimeout(base, displayGenTimeout)
		defer cancel()
		if _, err := build(ctx); err != nil && !errors.Is(err, image.ErrFormat) {
			log.Printf("display %s: %v", hash, err)
		}
	})
	w.Header().Set("Cache-Control", "no-store")
	// A prefetch only wants the build started; sending it the original would spend the bytes twice.
	if r.URL.Query().Get("warm") == "1" {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	http.Redirect(w, r, originalURL(r.URL.Query().Get("path"), raw), http.StatusFound)
}

// originalURL points at the untouched file; raws only render through their embedded JPEG.
func originalURL(path string, raw bool) string {
	if raw {
		return "/api/files/preview?path=" + url.QueryEscape(path)
	}
	return "/api/files/download?inline=1&path=" + url.QueryEscape(path)
}

// thumbSortParams reads the folder-preview sort query, defaulting to name ascending.
func thumbSortParams(r *http.Request) (sortBy string, desc bool) {
	sortBy = r.URL.Query().Get("sb")
	if sortBy != "date" && sortBy != "size" {
		sortBy = "name"
	}
	return sortBy, r.URL.Query().Get("sd") == "desc"
}

// Files cache hard (URL carries a version); folder previews must revalidate via ETag.
func thumbCacheControl(isDir bool) string {
	if isDir {
		return "private, no-cache"
	}
	return "private, max-age=604800"
}

// thumbNotModified answers 304 when the client already holds this ETag.
func thumbNotModified(w http.ResponseWriter, r *http.Request, etag, cacheControl string) bool {
	if !strings.Contains(r.Header.Get("If-None-Match"), etag) {
		return false
	}
	w.Header().Set("Cache-Control", cacheControl)
	w.Header().Set("ETag", etag)
	w.WriteHeader(http.StatusNotModified)
	return true
}

// serveThumb maps a generation error, else streams the cached JPEG with its caching headers.
func serveThumb(w http.ResponseWriter, cachePath string, genErr error, etag, cacheControl string) {
	if genErr != nil {
		if errors.Is(genErr, image.ErrFormat) {
			jsonErr(w, "not thumbnailable", http.StatusUnsupportedMediaType)
		} else {
			jsonErr(w, "thumbnail error", http.StatusInternalServerError)
		}
		return
	}
	f, err := os.Open(cachePath)
	if err != nil {
		jsonErr(w, "thumbnail error", http.StatusInternalServerError)
		return
	}
	defer f.Close()

	w.Header().Set("Content-Type", "image/jpeg")
	w.Header().Set("Cache-Control", cacheControl)
	w.Header().Set("ETag", etag)
	io.Copy(w, f)
}

// folderChild returns dir's sort-first previewable child ("" if none), memoized by mtime+sort.
func (c *thumbCache) folderChild(dir string, mtime time.Time, sortBy string, desc bool) string {
	key := dir + "\x00" + sortBy
	if desc {
		key += "\x00d"
	}
	c.mu.Lock()
	cached, ok := c.previews[key]
	c.mu.Unlock()
	if ok && cached.mtime.Equal(mtime) {
		return cached.child
	}
	child := c.findThumbable(dir, sortBy, desc)
	c.mu.Lock()
	if len(c.previews) >= maxHashMemo {
		clear(c.previews)
	}
	c.previews[key] = folderPreview{mtime: mtime, child: child}
	c.mu.Unlock()
	return child
}

// invalidateFolder drops dir's memo: a child's mtime changes sort order without touching dir's.
func (c *thumbCache) invalidateFolder(dir string) {
	c.mu.Lock()
	for _, sb := range []string{"name", "date", "size"} {
		delete(c.previews, dir+"\x00"+sb)
		delete(c.previews, dir+"\x00"+sb+"\x00d")
	}
	c.mu.Unlock()
}

// findThumbable returns the previewable direct child of dir that sorts first ("" if none).
func (c *thumbCache) findThumbable(dir, sortBy string, desc bool) string {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return ""
	}
	var best thumbCand
	found := false
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		ext := strings.ToLower(filepath.Ext(e.Name()))
		if !thumbableExt(ext, c.ffmpeg) {
			continue
		}
		fi, err := e.Info()
		if err != nil || !fi.Mode().IsRegular() {
			continue
		}
		if imageThumbExts[ext] && fi.Size() > thumbMaxSourceSize {
			continue
		}
		cand := thumbCand{name: e.Name(), mtime: fi.ModTime(), size: fi.Size()}
		if !found || thumbLess(cand, best, sortBy, desc) {
			best, found = cand, true
		}
	}
	if !found {
		return ""
	}
	return filepath.Join(dir, best.name)
}

// thumbCand is a preview candidate: the child fields the listing sort compares.
type thumbCand struct {
	name  string
	mtime time.Time
	size  int64
}

// thumbLess reports whether child a sorts before b, mirroring the client's listing sort.
func thumbLess(a, b thumbCand, sortBy string, desc bool) bool {
	cmp := 0
	switch sortBy {
	case "date":
		switch {
		case a.mtime.Before(b.mtime):
			cmp = -1
		case a.mtime.After(b.mtime):
			cmp = 1
		}
	case "size":
		switch {
		case a.size < b.size:
			cmp = -1
		case a.size > b.size:
			cmp = 1
		}
	}
	if cmp == 0 {
		cmp = compareFileNames(a.name, b.name)
	}
	if desc {
		cmp = -cmp
	}
	return cmp < 0
}

func (c *thumbCache) contentHash(abs string, fi os.FileInfo) (string, error) {
	c.mu.Lock()
	cached, ok := c.hashes[abs]
	c.mu.Unlock()
	if ok && cached.size == fi.Size() && cached.mtime.Equal(fi.ModTime()) {
		return cached.hash, nil
	}

	f, err := os.Open(abs)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if fi.Size() <= fullHashMaxSize {
		if _, err := io.Copy(h, f); err != nil {
			return "", err
		}
	} else {
		if _, err := io.CopyN(h, f, partialHashSpan); err != nil {
			return "", err
		}
		if _, err := f.Seek(-partialHashSpan, io.SeekEnd); err != nil {
			return "", err
		}
		if _, err := io.CopyN(h, f, partialHashSpan); err != nil {
			return "", err
		}
		binary.Write(h, binary.LittleEndian, fi.Size())
	}
	hash := hex.EncodeToString(h.Sum(nil))

	c.mu.Lock()
	if len(c.hashes) >= maxHashMemo {
		clear(c.hashes)
	}
	c.hashes[abs] = hashedFile{size: fi.Size(), mtime: fi.ModTime(), hash: hash}
	c.mu.Unlock()
	return hash, nil
}

// durInfo is the sidecar cached beside a thumb: parsed video length and capture time.
type durInfo struct {
	Duration int    `json:"duration,omitempty"`
	Taken    string `json:"taken,omitempty"`
	// Probed marks the length attempt done: a sidecar written by another field means nothing here.
	DurProbed bool `json:"durProbed,omitempty"`
	// An S3 image's pixel size, kept from the download the thumb already paid for.
	Width  int `json:"width,omitempty"`
	Height int `json:"height,omitempty"`
	// Integrated loudness in LUFS. Measured marks the attempt done: an unmeasurable file has no value.
	LUFS         float64 `json:"lufs,omitempty"`
	LUFSMeasured bool    `json:"lufsMeasured,omitempty"`
}

// updateDur read-modify-writes a sidecar, so one field's writer can't blank another's.
func (c *thumbCache) updateDur(hash string, fn func(*durInfo)) durInfo {
	c.durMu.Lock()
	defer c.durMu.Unlock()
	di, _ := c.readDur(hash)
	fn(&di)
	c.writeDur(hash, di)
	return di
}

func (c *thumbCache) durPath(hash string) string {
	return filepath.Join(c.dir, hash[:2], hash+".dur")
}

// readDur returns the sidecar for hash; ok=false means this content was never parsed.
func (c *thumbCache) readDur(hash string) (durInfo, bool) {
	var di durInfo
	p := c.durPath(hash)
	b, err := os.ReadFile(p)
	if err != nil || json.Unmarshal(b, &di) != nil {
		return durInfo{}, false
	}
	// Keep used sidecars alive; the GC sweep deletes by mtime.
	now := time.Now()
	os.Chtimes(p, now, now)
	return di, true
}

func (c *thumbCache) writeDur(hash string, di durInfo) {
	p := c.durPath(hash)
	if err := os.MkdirAll(filepath.Dir(p), 0755); err != nil {
		return
	}
	b, _ := json.Marshal(di)
	os.WriteFile(p, b, 0644)
}

// ensure returns the cached thumbnail path for hash, generating it once if missing.
func (c *thumbCache) ensure(srcAbs, hash string) (string, error) {
	return c.ensureWith(hash, func(cachePath string) error {
		if isVideoName(srcAbs) {
			return c.generateVideoThumb(srcAbs, cachePath)
		}
		err := generateOutputs(srcAbs, c.scaledOutputsFor(srcAbs, hash, false))
		// Free decode buffers now so back-to-back generations don't stack in RSS.
		debug.FreeOSMemory()
		return err
	})
}

// ensureDisplay is ensure's screen-sized sibling; "-d" keys it apart from the 320px thumb.
func (c *thumbCache) ensureDisplay(srcAbs, hash string) (string, error) {
	return c.ensureWith(hash+"-d", func(cachePath string) error {
		err := generateOutputs(srcAbs, c.scaledOutputsFor(srcAbs, hash, true))
		debug.FreeOSMemory()
		return err
	})
}

func (c *thumbCache) cachePath(hash string) string {
	return filepath.Join(c.dir, hash[:2], hash+".jpg")
}

// displayReady reports whether the screen-sized variant is on disk, touching it so the GC keeps it.
func (c *thumbCache) displayReady(hash string) bool {
	p := c.cachePath(hash + "-d")
	if _, err := os.Stat(p); err != nil {
		return false
	}
	now := time.Now()
	os.Chtimes(p, now, now)
	return true
}

// background runs gen off the request, dropping it when full: the thumb pass rebuilds it later.
func (c *thumbCache) background(gen func()) {
	select {
	case c.bgSem <- struct{}{}:
	default:
		return
	}
	go func() {
		defer func() { <-c.bgSem }()
		gen()
	}()
}

// scaledOutputsFor lists what one decode writes; the display pass throws in the near-free thumb.
func (c *thumbCache) scaledOutputsFor(name, hash string, forDisplay bool) []scaledOutput {
	var outs []scaledOutput
	add := func(suffix string, maxDim, quality int, always bool) {
		p := c.cachePath(hash + suffix)
		if _, err := os.Stat(p); err == nil && !always {
			return
		}
		outs = append(outs, scaledOutput{p, maxDim, quality})
	}
	add("", thumbMaxDim, thumbJPEGQuality, !forDisplay)
	if forDisplay {
		add("-d", displayMaxDim, displayJPEGQuality, true)
	}
	return outs
}

// ensureWith is ensure with a caller-supplied generator, so S3 objects can be fetched first.
func (c *thumbCache) ensureWith(hash string, gen func(cachePath string) error) (string, error) {
	cachePath := c.cachePath(hash)
	if _, err := os.Stat(cachePath); err == nil {
		// Keep recently-used thumbs alive; the GC sweep deletes by mtime.
		now := time.Now()
		os.Chtimes(cachePath, now, now)
		return cachePath, nil
	}

	_, err, _ := c.group.Do(hash, func() (any, error) {
		return nil, gen(cachePath)
	})
	if err != nil {
		return "", err
	}
	return cachePath, nil
}

// Seek 1s skips fade-in. src may be an https URL, which ffmpeg range-reads, so S3 stays off disk.
func (c *thumbCache) generateVideoThumb(src, cachePath string) error {
	ffmpegSem <- struct{}{}
	defer func() { <-ffmpegSem }()
	if err := os.MkdirAll(filepath.Dir(cachePath), 0755); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(cachePath), ".tmp-*")
	if err != nil {
		return err
	}
	tmp.Close()
	defer os.Remove(tmp.Name())

	scale := fmt.Sprintf("scale='min(%d,iw)':'min(%d,ih)':force_original_aspect_ratio=decrease", thumbMaxDim, thumbMaxDim)
	lastErr := "no attempt ran"
	for _, seek := range []string{"1", "0"} {
		args := []string{"-v", "error", "-nostdin"}
		if strings.HasPrefix(src, "https://") {
			// One connection for all of the demuxer's range reads, not a request per seek.
			args = append(args, "-multiple_requests", "1")
		}
		args = append(args, "-ss", seek, "-i", src,
			"-frames:v", "1", "-vf", scale, "-an", "-sn",
			"-f", "mjpeg", "-q:v", "4", "-y", tmp.Name())

		ctx, cancel := context.WithTimeout(context.Background(), ffmpegTimeout)
		cmd := exec.CommandContext(ctx, c.ffmpeg, args...)
		var stderr bytes.Buffer
		cmd.Stderr = &stderr
		runErr := cmd.Run()
		cancel()
		if runErr != nil {
			// ffmpeg spreads one diagnostic over several lines; keep it to a single log line.
			lastErr = strings.ReplaceAll(strings.TrimSpace(stderr.String()), "\n", "; ")
			if lastErr == "" {
				lastErr = runErr.Error()
			}
			continue
		}
		if fi, err := os.Stat(tmp.Name()); err != nil || fi.Size() == 0 {
			lastErr = "ffmpeg wrote no frame"
			continue
		}
		if err := os.Rename(tmp.Name(), cachePath); err != nil {
			return err
		}
		c.probeDuration(src, cachePath)
		return nil
	}
	// Without this a failed video thumbnail is invisible; ffmpeg echoes the URL, so redact it too.
	safe := withoutQuery(src)
	log.Printf("video thumbnail failed for %s: %s", safe, strings.ReplaceAll(lastErr, src, safe))
	return image.ErrFormat
}

// probeDuration sidecars ffprobe's length for containers mvhd can't read; generation time only.
func (c *thumbCache) probeDuration(src, cachePath string) {
	ext := strings.ToLower(filepath.Ext(withoutQuery(src)))
	if c.ffprobe == "" || mvhdExts[ext] {
		return
	}
	if d := ffprobeDuration(c.ffprobe, src); d > 0 {
		hash := strings.TrimSuffix(filepath.Base(cachePath), ".jpg")
		c.updateDur(hash, func(di *durInfo) { di.Duration, di.DurProbed = d, true })
	}
}

// knownDuration is durationOf without the hash: what a listing can answer for free.
func (c *thumbCache) knownDuration(abs string, fi os.FileInfo) (int, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	cached, ok := c.durs[abs]
	if !ok || cached.size != fi.Size() || !cached.mtime.Equal(fi.ModTime()) {
		return 0, false
	}
	return cached.duration, true
}

// durationOf reports a track's length, memoized: a listing asks it of every song it shows.
func (c *thumbCache) durationOf(abs string, fi os.FileInfo) int {
	if d, ok := c.knownDuration(abs, fi); ok {
		return d
	}
	hash, err := c.contentHash(abs, fi)
	if err != nil {
		return 0
	}
	d := c.audioDuration(hash, abs)

	c.mu.Lock()
	if len(c.durs) >= maxHashMemo {
		clear(c.durs)
	}
	c.durs[abs] = timedMedia{size: fi.Size(), mtime: fi.ModTime(), duration: d}
	c.mu.Unlock()
	return d
}

// audioDuration answers from the sidecar; a zero is sidecared too, so it isn't reprobed forever.
func (c *thumbCache) audioDuration(hash, src string) int {
	if di, ok := c.readDur(hash); ok && di.DurProbed {
		return di.Duration
	}
	if c.ffprobe == "" {
		return 0
	}
	// A folder of songs opens as a burst of asks; the ones sharing a file share its one probe.
	v, _, _ := c.group.Do("dur:"+hash, func() (any, error) {
		d := ffprobeDuration(c.ffprobe, src)
		c.updateDur(hash, func(di *durInfo) { di.Duration, di.DurProbed = d, true })
		return d, nil
	})
	return v.(int)
}

// ffprobeDuration reads a media file's or URL's length in whole seconds; 0 means unknown.
func ffprobeDuration(bin, src string) int {
	ctx, cancel := context.WithTimeout(context.Background(), ffmpegTimeout)
	defer cancel()
	out, err := exec.CommandContext(ctx, bin, "-v", "error",
		"-show_entries", "format=duration", "-of", "default=nw=1:nk=1", src).Output()
	if err != nil {
		return 0
	}
	return parseProbeDuration(string(out))
}

// parseProbeDuration rounds ffprobe's fractional seconds ("83.000000") to at least 1s.
func parseProbeDuration(s string) int {
	secs, err := strconv.ParseFloat(strings.TrimSpace(s), 64)
	if err != nil || secs <= 0 {
		return 0
	}
	if secs < 1 {
		return 1
	}
	return int(secs + 0.5)
}

// withoutQuery drops a presigned URL's query so signing credentials stay out of the log.
func withoutQuery(src string) string {
	if i := strings.IndexByte(src, '?'); i >= 0 && strings.HasPrefix(src, "https://") {
		return src[:i]
	}
	return src
}

// scaledOutput is one cached JPEG a single source decode should produce.
type scaledOutput struct {
	path    string
	maxDim  int
	quality int
}

// generateOutputs builds every requested cache variant from one open of the source file.
func generateOutputs(srcAbs string, outs []scaledOutput) error {
	if isRawName(srcAbs) {
		return generateRawOutputs(srcAbs, outs)
	}
	f, err := os.Open(srcAbs)
	if err != nil {
		return err
	}
	defer f.Close()
	return writeScaledAll(f, outs)
}

// writeScaledAll decodes f once, then scales, orients, and writes each output, largest first.
func writeScaledAll(f io.ReadSeeker, outs []scaledOutput) error {
	if len(outs) == 0 {
		return nil
	}
	// Gated here rather than around the whole generation: an S3 fetch holds no decode buffer.
	decodeSem <- struct{}{}
	defer func() { <-decodeSem }()
	sort.Slice(outs, func(i, j int) bool { return outs[i].maxDim > outs[j].maxDim })
	orientation := jpegOrientation(f)
	if _, err := f.Seek(0, io.SeekStart); err != nil {
		return err
	}
	icc := embeddedICC(f)
	if _, err := f.Seek(0, io.SeekStart); err != nil {
		return err
	}

	cfg, _, err := image.DecodeConfig(f)
	if err != nil || cfg.Width*cfg.Height > thumbMaxPixels {
		return image.ErrFormat
	}
	if _, err := f.Seek(0, io.SeekStart); err != nil {
		return err
	}

	src, _, err := image.Decode(f)
	if err != nil {
		return image.ErrFormat
	}

	// Smaller outputs rescale from the largest one, so the full decode is paid once.
	img := applyOrientation(scaleDown(src, outs[0].maxDim), orientation)
	for _, out := range outs {
		img = scaleDown(img, out.maxDim)
		if err := writeJPEG(img, out.path, out.quality, icc); err != nil {
			return err
		}
	}
	return nil
}

// writeJPEG writes atomically, carrying the colour profile so a wide-gamut photo isn't read sRGB.
func writeJPEG(img image.Image, cachePath string, quality int, icc []byte) error {
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, flattenOnWhite(img), &jpeg.Options{Quality: quality}); err != nil {
		return err
	}
	out := spliceMeta(buf.Bytes(), jpegMeta{icc: icc})

	if err := os.MkdirAll(filepath.Dir(cachePath), 0755); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(cachePath), ".tmp-*")
	if err != nil {
		return err
	}
	if _, err := tmp.Write(out); err != nil {
		tmp.Close()
		os.Remove(tmp.Name())
		return err
	}
	if err := tmp.Close(); err != nil {
		os.Remove(tmp.Name())
		return err
	}
	return os.Rename(tmp.Name(), cachePath)
}

// flattenOnWhite composites img over white, since JPEG has no alpha and renders it black.
func flattenOnWhite(img image.Image) image.Image {
	if o, ok := img.(interface{ Opaque() bool }); ok && o.Opaque() {
		return img
	}
	b := img.Bounds()
	flat := image.NewRGBA(image.Rect(0, 0, b.Dx(), b.Dy()))
	draw.Draw(flat, flat.Bounds(), image.NewUniform(color.White), image.Point{}, draw.Src)
	draw.Draw(flat, flat.Bounds(), img, b.Min, draw.Over)
	return flat
}

func scaleDown(src image.Image, maxDim int) image.Image {
	b := src.Bounds()
	if b.Dx() <= maxDim && b.Dy() <= maxDim {
		return src
	}
	// Pre-shrink with the cheap scaler so CatmullRom's big float buffer sees a small image.
	if b.Dx() > 4*maxDim || b.Dy() > 4*maxDim {
		pw, ph := fitWithin(b.Dx(), b.Dy(), 4*maxDim)
		pre := image.NewRGBA(image.Rect(0, 0, pw, ph))
		draw.ApproxBiLinear.Scale(pre, pre.Bounds(), src, b, draw.Src, nil)
		src, b = pre, pre.Bounds()
	}
	w, h := fitWithin(b.Dx(), b.Dy(), maxDim)
	dst := image.NewRGBA(image.Rect(0, 0, w, h))
	// Past thumb size BiLinear is 2x faster, and the extra sharpness is invisible at a 2-3x scale.
	q := draw.Interpolator(draw.CatmullRom)
	if maxDim > catmullRomMaxDim {
		q = draw.BiLinear
	}
	q.Scale(dst, dst.Bounds(), src, b, draw.Src, nil)
	return dst
}

func fitWithin(w, h, maxDim int) (int, int) {
	if w > h {
		h = h * maxDim / w
		w = maxDim
	} else {
		w = w * maxDim / h
		h = maxDim
	}
	if w < 1 {
		w = 1
	}
	if h < 1 {
		h = 1
	}
	return w, h
}

// applyOrientation bakes EXIF orientation (1-8) into pixels, after scaling.
func applyOrientation(src image.Image, orientation int) image.Image {
	if orientation <= 1 || orientation > 8 {
		return src
	}
	b := src.Bounds()
	w, h := b.Dx(), b.Dy()
	dw, dh := w, h
	if orientation >= 5 {
		dw, dh = h, w
	}
	dst := image.NewRGBA(image.Rect(0, 0, dw, dh))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			px := src.At(b.Min.X+x, b.Min.Y+y)
			switch orientation {
			case 2: // mirror horizontal
				dst.Set(w-1-x, y, px)
			case 3: // rotate 180
				dst.Set(w-1-x, h-1-y, px)
			case 4: // mirror vertical
				dst.Set(x, h-1-y, px)
			case 5: // mirror horizontal + rotate 270 CW
				dst.Set(y, x, px)
			case 6: // rotate 90 CW
				dst.Set(h-1-y, x, px)
			case 7: // mirror horizontal + rotate 90 CW
				dst.Set(h-1-y, w-1-x, px)
			case 8: // rotate 270 CW
				dst.Set(y, w-1-x, px)
			}
		}
	}
	return dst
}

// jpegOrientation reads the EXIF orientation (1-8) from a JPEG; 1 if absent/unparsable.
func jpegOrientation(r io.Reader) int {
	tiff := jpegExifTIFF(r)
	if tiff == nil {
		return 1
	}
	return parseExifOrientation(tiff)
}

// jpegExifTIFF returns the TIFF payload of a JPEG's EXIF (APP1) segment, or nil if absent.
func jpegExifTIFF(r io.Reader) []byte {
	var soi [2]byte
	if _, err := io.ReadFull(r, soi[:]); err != nil || soi != [2]byte{0xFF, 0xD8} {
		return nil
	}
	for {
		var marker [2]byte
		if _, err := io.ReadFull(r, marker[:]); err != nil || marker[0] != 0xFF {
			return nil
		}
		// Standalone markers with no length field.
		if marker[1] == 0xD8 || (marker[1] >= 0xD0 && marker[1] <= 0xD7) {
			continue
		}
		var lenBuf [2]byte
		if _, err := io.ReadFull(r, lenBuf[:]); err != nil {
			return nil
		}
		segLen := int(binary.BigEndian.Uint16(lenBuf[:])) - 2
		if segLen < 0 {
			return nil
		}
		// Scan stops at the start-of-scan marker: EXIF always precedes it.
		if marker[1] == 0xDA {
			return nil
		}
		if marker[1] != 0xE1 {
			if _, err := io.CopyN(io.Discard, r, int64(segLen)); err != nil {
				return nil
			}
			continue
		}
		seg := make([]byte, segLen)
		if _, err := io.ReadFull(r, seg); err != nil {
			return nil
		}
		if !bytes.HasPrefix(seg, []byte("Exif\x00\x00")) {
			continue
		}
		return seg[6:]
	}
}

func parseExifOrientation(tiff []byte) int {
	order, ifd0, ok := exifByteOrder(tiff)
	if !ok {
		return 1
	}
	if v, ok := exifLong(tiff, order, ifd0, 0x0112); ok && v >= 1 && v <= 8 {
		return int(v)
	}
	return 1
}

// gcLoop deletes cached thumbnails not viewed recently; orphans age out here.
func (c *thumbCache) gcLoop() {
	for {
		cutoff := time.Now().Add(-thumbMaxAge)
		filepath.WalkDir(c.dir, func(path string, d os.DirEntry, err error) error {
			if err != nil || d.IsDir() {
				return nil
			}
			if fi, err := d.Info(); err == nil && fi.ModTime().Before(cutoff) {
				os.Remove(path)
			}
			return nil
		})
		time.Sleep(thumbGCInterval)
	}
}
