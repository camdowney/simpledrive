package handler

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// fakeS3 is an in-memory stand-in for the subset of the S3 REST API this app uses.
type fakeS3 struct {
	srv    *httptest.Server
	bucket string

	mu      sync.Mutex
	objects map[string][]byte
	// signed records the Authorization header of every request, so tests can assert signing.
	signed []string
}

func newFakeS3(bucket string) *fakeS3 {
	f := &fakeS3{bucket: bucket, objects: map[string][]byte{}}
	f.srv = httptest.NewTLSServer(http.HandlerFunc(f.serve))
	return f
}

func (f *fakeS3) close() { f.srv.Close() }

func (f *fakeS3) put(key, body string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.objects[key] = []byte(body)
}

func (f *fakeS3) get(key string) (string, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	b, ok := f.objects[key]
	return string(b), ok
}

func (f *fakeS3) keys() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]string, 0, len(f.objects))
	for k := range f.objects {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

func (f *fakeS3) serve(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	f.signed = append(f.signed, r.Header.Get("Authorization"))
	f.mu.Unlock()

	if r.Header.Get("Authorization") == "" || r.Header.Get("X-Amz-Content-Sha256") == "" {
		writeS3Error(w, http.StatusForbidden, "AccessDenied", "unsigned request")
		return
	}

	path := strings.TrimPrefix(r.URL.Path, "/")
	if !strings.HasPrefix(path, f.bucket) {
		writeS3Error(w, http.StatusNotFound, "NoSuchBucket", "no such bucket")
		return
	}
	key := strings.TrimPrefix(strings.TrimPrefix(path, f.bucket), "/")

	switch r.Method {
	case http.MethodGet:
		if key == "" && r.URL.Query().Get("list-type") == "2" {
			f.list(w, r)
			return
		}
		f.getObject(w, r, key)
	case http.MethodHead:
		f.headObject(w, key)
	case http.MethodPut:
		f.putObject(w, r, key)
	case http.MethodDelete:
		f.mu.Lock()
		delete(f.objects, key)
		f.mu.Unlock()
		w.WriteHeader(http.StatusNoContent)
	default:
		writeS3Error(w, http.StatusMethodNotAllowed, "MethodNotAllowed", "nope")
	}
}

func (f *fakeS3) list(w http.ResponseWriter, r *http.Request) {
	prefix := r.URL.Query().Get("prefix")
	delim := r.URL.Query().Get("delimiter")
	// Real S3 only escapes keys when asked; the client must ask, or odd keys break the XML.
	if r.URL.Query().Get("encoding-type") != "url" {
		writeS3Error(w, http.StatusBadRequest, "InvalidArgument", "expected encoding-type=url")
		return
	}

	f.mu.Lock()
	keys := make([]string, 0, len(f.objects))
	for k := range f.objects {
		if strings.HasPrefix(k, prefix) {
			keys = append(keys, k)
		}
	}
	f.mu.Unlock()
	sort.Strings(keys)

	var b strings.Builder
	b.WriteString(`<?xml version="1.0" encoding="UTF-8"?><ListBucketResult>`)
	b.WriteString("<IsTruncated>false</IsTruncated>")
	seen := map[string]bool{}
	for _, k := range keys {
		rest := strings.TrimPrefix(k, prefix)
		if delim != "" {
			if i := strings.Index(rest, delim); i >= 0 {
				cp := prefix + rest[:i+len(delim)]
				if !seen[cp] {
					seen[cp] = true
					fmt.Fprintf(&b, "<CommonPrefixes><Prefix>%s</Prefix></CommonPrefixes>", urlEncodeKey(cp))
				}
				continue
			}
		}
		f.mu.Lock()
		size := len(f.objects[k])
		f.mu.Unlock()
		fmt.Fprintf(&b, "<Contents><Key>%s</Key><Size>%d</Size>"+
			"<LastModified>2024-01-02T03:04:05.000Z</LastModified><ETag>&quot;etag-%s&quot;</ETag></Contents>",
			urlEncodeKey(k), size, urlEncodeKey(k))
	}
	b.WriteString("</ListBucketResult>")

	w.Header().Set("Content-Type", "application/xml")
	w.Write([]byte(b.String()))
}

func (f *fakeS3) getObject(w http.ResponseWriter, r *http.Request, key string) {
	f.mu.Lock()
	body, ok := f.objects[key]
	f.mu.Unlock()
	if !ok {
		writeS3Error(w, http.StatusNotFound, "NoSuchKey", "no such key")
		return
	}
	f.setObjectHeaders(w, key, len(body))
	if rng := r.Header.Get("Range"); strings.HasPrefix(rng, "bytes=") {
		var start, end int
		n, _ := fmt.Sscanf(rng, "bytes=%d-%d", &start, &end)
		// Real S3 clamps a range end past EOF rather than ignoring the range.
		if end >= len(body) {
			end = len(body) - 1
		}
		if n == 2 && start <= end && end < len(body) {
			w.Header().Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", start, end, len(body)))
			w.Header().Set("Content-Length", strconv.Itoa(end-start+1))
			w.WriteHeader(http.StatusPartialContent)
			w.Write(body[start : end+1])
			return
		}
	}
	w.Write(body)
}

func (f *fakeS3) headObject(w http.ResponseWriter, key string) {
	f.mu.Lock()
	body, ok := f.objects[key]
	f.mu.Unlock()
	if !ok {
		writeS3Error(w, http.StatusNotFound, "NoSuchKey", "no such key")
		return
	}
	f.setObjectHeaders(w, key, len(body))
	w.WriteHeader(http.StatusOK)
}

func (f *fakeS3) setObjectHeaders(w http.ResponseWriter, key string, size int) {
	w.Header().Set("Content-Length", strconv.Itoa(size))
	w.Header().Set("ETag", `"etag-`+url.PathEscape(key)+`"`)
	w.Header().Set("Last-Modified", time.Date(2024, 1, 2, 3, 4, 5, 0, time.UTC).Format(http.TimeFormat))
	w.Header().Set("Accept-Ranges", "bytes")
}

func (f *fakeS3) putObject(w http.ResponseWriter, r *http.Request, key string) {
	if src := r.Header.Get("X-Amz-Copy-Source"); src != "" {
		srcKey, err := url.PathUnescape(strings.TrimPrefix(strings.TrimPrefix(src, "/"), f.bucket+"/"))
		if err != nil {
			writeS3Error(w, http.StatusBadRequest, "InvalidRequest", "bad copy source")
			return
		}
		f.mu.Lock()
		body, ok := f.objects[srcKey]
		if ok {
			f.objects[key] = append([]byte(nil), body...)
		}
		f.mu.Unlock()
		if !ok {
			writeS3Error(w, http.StatusNotFound, "NoSuchKey", "no such key")
			return
		}
		w.Write([]byte(`<CopyObjectResult><ETag>"copied"</ETag></CopyObjectResult>`))
		return
	}

	// A chunked body means Content-Length was lost, which real S3 rejects without chunk signing.
	if r.ContentLength < 0 {
		writeS3Error(w, http.StatusNotImplemented, "MissingContentLength", "content-length required")
		return
	}
	buf := make([]byte, r.ContentLength)
	if _, err := readFull(r.Body, buf); err != nil {
		writeS3Error(w, http.StatusBadRequest, "IncompleteBody", err.Error())
		return
	}
	f.mu.Lock()
	f.objects[key] = buf
	f.mu.Unlock()
	w.WriteHeader(http.StatusOK)
}

func readFull(r interface{ Read([]byte) (int, error) }, buf []byte) (int, error) {
	total := 0
	for total < len(buf) {
		n, err := r.Read(buf[total:])
		total += n
		if err != nil {
			if total == len(buf) {
				return total, nil
			}
			return total, err
		}
	}
	return total, nil
}

// urlEncodeKey mirrors how S3 escapes keys under encoding-type=url.
func urlEncodeKey(k string) string {
	return strings.ReplaceAll(url.QueryEscape(k), "+", "%20")
}

func writeS3Error(w http.ResponseWriter, status int, code, msg string) {
	w.Header().Set("Content-Type", "application/xml")
	w.WriteHeader(status)
	fmt.Fprintf(w, "<Error><Code>%s</Code><Message>%s</Message></Error>", code, msg)
}
