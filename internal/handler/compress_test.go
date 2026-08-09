package handler

import (
	"bytes"
	"compress/gzip"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

// serveFile copies a file straight to the response, the way the zip and thumb handlers do.
func serveFile(t *testing.T, body []byte, contentType string, r *http.Request) *httptest.ResponseRecorder {
	t.Helper()
	path := filepath.Join(t.TempDir(), "body")
	if err := os.WriteFile(path, body, 0o644); err != nil {
		t.Fatal(err)
	}
	h := compress(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		f, err := os.Open(path)
		if err != nil {
			t.Error(err)
			return
		}
		defer f.Close()
		w.Header().Set("Content-Type", contentType)
		if _, err := io.Copy(w, f); err != nil {
			t.Error(err)
		}
	}))
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w
}

func gzipRequest() *http.Request {
	r := httptest.NewRequest("GET", "/x", nil)
	r.Header.Set("Accept-Encoding", "gzip")
	return r
}

func TestOpaqueBodyPassesThroughIntact(t *testing.T) {
	body := bytes.Repeat([]byte("binary\x00payload"), 4096)
	w := serveFile(t, body, "application/octet-stream", gzipRequest())

	if enc := w.Header().Get("Content-Encoding"); enc != "" {
		t.Errorf("Content-Encoding = %q, want none for an opaque type", enc)
	}
	if !bytes.Equal(w.Body.Bytes(), body) {
		t.Errorf("body is %d bytes, want %d unchanged", w.Body.Len(), len(body))
	}
}

func TestTextBodyIsCompressed(t *testing.T) {
	body := bytes.Repeat([]byte("the quick brown fox\n"), 512)
	w := serveFile(t, body, "text/plain; charset=utf-8", gzipRequest())

	if enc := w.Header().Get("Content-Encoding"); enc != "gzip" {
		t.Fatalf("Content-Encoding = %q, want gzip", enc)
	}
	// Ranges are offsets into the identity body, which this no longer is.
	if w.Header().Get("Content-Length") != "" || w.Header().Get("Accept-Ranges") != "" {
		t.Error("a gzipped body must not carry the identity length or advertise ranges")
	}
	zr, err := gzip.NewReader(w.Body)
	if err != nil {
		t.Fatal(err)
	}
	got, err := io.ReadAll(zr)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, body) {
		t.Error("decompressed body does not match what was written")
	}
}

// Short bodies cost more to frame than they save, whichever way they reach the writer.
func TestShortBodyIsNotCompressed(t *testing.T) {
	body := []byte("tiny")
	w := serveFile(t, body, "text/plain", gzipRequest())

	if enc := w.Header().Get("Content-Encoding"); enc != "" {
		t.Errorf("Content-Encoding = %q, want none below the threshold", enc)
	}
	if !bytes.Equal(w.Body.Bytes(), body) {
		t.Errorf("body = %q, want %q", w.Body, body)
	}
}

// A cache keyed on the identity bytes must not hand them to a client that would have got gzip.
func TestVarySetOnUncompressedPath(t *testing.T) {
	for _, tc := range []struct{ name, hdr, val string }{
		{"no gzip", "Accept-Encoding", "identity"},
		{"range", "Range", "bytes=0-9"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := gzipRequest()
			r.Header.Set(tc.hdr, tc.val)
			w := serveFile(t, bytes.Repeat([]byte("a"), 4096), "text/plain", r)
			if v := w.Header().Get("Vary"); v != "Accept-Encoding" {
				t.Errorf("Vary = %q, want Accept-Encoding", v)
			}
			if enc := w.Header().Get("Content-Encoding"); enc != "" {
				t.Errorf("Content-Encoding = %q, want none", enc)
			}
		})
	}
}

// recordingWriter stands in for the net/http writer, whose ReadFrom is the one that sendfiles.
type recordingWriter struct {
	http.ResponseWriter
	body      bytes.Buffer
	readFroms int
}

func (w *recordingWriter) Write(b []byte) (int, error) { return w.body.Write(b) }

func (w *recordingWriter) ReadFrom(r io.Reader) (int64, error) {
	w.readFroms++
	return w.body.ReadFrom(r)
}

// CopyN's LimitedReader is no WriterTo, which is what makes ServeContent reach gzipWriter.ReadFrom.
func servedThrough(t *testing.T, body []byte, contentType string) *recordingWriter {
	t.Helper()
	rec := &recordingWriter{ResponseWriter: httptest.NewRecorder()}
	h := compress(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", contentType)
		if _, err := io.CopyN(w, bytes.NewReader(body), int64(len(body))); err != nil {
			t.Error(err)
		}
	}))
	h.ServeHTTP(rec, gzipRequest())
	return rec
}

// Without the delegation an opaque body copies through userspace instead of sendfile.
func TestReadFromDelegatesToUnderlyingWriter(t *testing.T) {
	body := bytes.Repeat([]byte("opaque"), 8192)
	rec := servedThrough(t, body, "application/octet-stream")

	if rec.readFroms != 1 {
		t.Errorf("underlying ReadFrom called %d times, want 1", rec.readFroms)
	}
	if !bytes.Equal(rec.body.Bytes(), body) {
		t.Errorf("body is %d bytes, want %d unchanged", rec.body.Len(), len(body))
	}
}

// A compressed body has to go through the gzip writer, never straight to the socket.
func TestReadFromBypassesUnderlyingWriterWhenCompressing(t *testing.T) {
	body := bytes.Repeat([]byte("the quick brown fox\n"), 512)
	rec := servedThrough(t, body, "text/plain")

	if rec.readFroms != 0 {
		t.Errorf("underlying ReadFrom called %d times, want 0", rec.readFroms)
	}
	if rec.body.Len() >= len(body) {
		t.Errorf("body is %d bytes, want fewer than %d", rec.body.Len(), len(body))
	}
}

func TestCompressibleNormalizesContentType(t *testing.T) {
	for _, tc := range []struct {
		ct   string
		want bool
	}{
		{"Text/HTML; charset=UTF-8", true},
		{" text/css", true},
		{"application/json", true},
		{"image/jpeg", false},
		{"video/mp4", false},
	} {
		if got := compressible(tc.ct); got != tc.want {
			t.Errorf("compressible(%q) = %v, want %v", tc.ct, got, tc.want)
		}
	}
}
