package handler

import (
	"compress/gzip"
	"io"
	"net/http"
	"strconv"
	"strings"
	"sync"
)

// Below this a response costs more to compress and frame than it saves.
const minCompressSize = 1024

var gzipPool = sync.Pool{
	New: func() any {
		w, _ := gzip.NewWriterLevel(io.Discard, gzip.BestSpeed)
		return w
	},
}

// compressible reports whether a content type is text-shaped; media and archives are already packed.
func compressible(contentType string) bool {
	if i := strings.IndexByte(contentType, ';'); i >= 0 {
		contentType = contentType[:i]
	}
	contentType = strings.TrimSpace(strings.ToLower(contentType))
	switch contentType {
	case "application/json", "application/javascript", "application/manifest+json",
		"application/xml", "image/svg+xml":
		return true
	}
	return strings.HasPrefix(contentType, "text/")
}

// bodyless reports whether a status carries no body worth compressing.
func bodyless(code int) bool {
	return code < 200 || code == http.StatusNoContent || code == http.StatusNotModified ||
		code == http.StatusPartialContent
}

// gzipWriter holds the status line until the first body bytes settle Content-Type and size.
type gzipWriter struct {
	http.ResponseWriter
	gz     *gzip.Writer
	status int
	sent   bool // the underlying WriteHeader has run; headers are frozen
}

// begin freezes the headers, compressing from here on when the body is text-shaped and big enough.
func (w *gzipWriter) begin(first []byte) {
	w.sent = true
	if w.status == 0 {
		w.status = http.StatusOK
	}
	defer func() { w.ResponseWriter.WriteHeader(w.status) }()

	h := w.Header()
	// A range or an already-encoded body carries offsets the client counted on the identity bytes.
	if bodyless(w.status) || h.Get("Content-Range") != "" || h.Get("Content-Encoding") != "" {
		return
	}
	ct := h.Get("Content-Type")
	if ct == "" {
		ct = http.DetectContentType(first)
		h.Set("Content-Type", ct)
	}
	if !compressible(ct) {
		return
	}
	if n, err := strconv.Atoi(h.Get("Content-Length")); err == nil {
		if n < minCompressSize {
			return
		}
	} else if len(first) < minCompressSize {
		return
	}
	h.Del("Content-Length") // no longer the length of what goes out
	h.Set("Content-Encoding", "gzip")
	// Ranges are byte offsets into the identity body, which this no longer is.
	h.Del("Accept-Ranges")
	w.gz = gzipPool.Get().(*gzip.Writer)
	w.gz.Reset(w.ResponseWriter)
}

func (w *gzipWriter) WriteHeader(code int) {
	if w.sent {
		return
	}
	w.status = code
	// Nothing follows a bodyless status, so there is no body to wait for before settling.
	if bodyless(code) {
		w.begin(nil)
	}
}

func (w *gzipWriter) Write(b []byte) (int, error) {
	if !w.sent {
		w.begin(b)
	}
	if w.gz != nil {
		return w.gz.Write(b)
	}
	return w.ResponseWriter.Write(b)
}

// ReadFrom keeps sendfile reachable on the uncompressed path, which is how whole files go out.
func (w *gzipWriter) ReadFrom(r io.Reader) (int64, error) {
	var n int64
	if !w.sent {
		// begin decides from the leading bytes, and only Write can hand them over.
		var buf [minCompressSize]byte
		got, err := io.ReadFull(r, buf[:])
		if err != nil && err != io.EOF && err != io.ErrUnexpectedEOF {
			return 0, err
		}
		// Nothing read, so leave the headers open for whatever the handler writes next.
		if got == 0 {
			return 0, nil
		}
		if _, err := w.Write(buf[:got]); err != nil {
			return int64(got), err
		}
		n = int64(got)
	}
	if w.gz != nil {
		m, err := io.Copy(w.gz, r)
		return n + m, err
	}
	if rf, ok := w.ResponseWriter.(io.ReaderFrom); ok {
		m, err := rf.ReadFrom(r)
		return n + m, err
	}
	m, err := io.Copy(w.ResponseWriter, r)
	return n + m, err
}

func (w *gzipWriter) Flush() {
	if !w.sent {
		w.begin(nil)
	}
	if w.gz != nil {
		w.gz.Flush()
	}
	if f, ok := w.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

// close finishes the gzip stream, and answers a handler that returned without writing anything.
func (w *gzipWriter) close() {
	if !w.sent {
		w.begin(nil)
	}
	if w.gz == nil {
		return
	}
	w.gz.Close()
	gzipPool.Put(w.gz)
	w.gz = nil
}

// compress gzips text-shaped responses; a folder listing goes out at about a seventh of its size.
func compress(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Set even on the uncompressed path, so a cache can't hand these bytes to a gzip client.
		w.Header().Add("Vary", "Accept-Encoding")
		// A range wants offsets into the stored file; a HEAD must not be answered with body bytes.
		if !strings.Contains(r.Header.Get("Accept-Encoding"), "gzip") ||
			r.Header.Get("Range") != "" || r.Method == http.MethodHead {
			next.ServeHTTP(w, r)
			return
		}
		gw := &gzipWriter{ResponseWriter: w}
		defer gw.close()
		next.ServeHTTP(gw, r)
	})
}
