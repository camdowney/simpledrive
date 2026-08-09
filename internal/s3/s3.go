// Package s3 is a minimal S3 REST client: SigV4 plus the few operations SimpleDrive needs,
// avoiding the AWS SDK to keep the binary small.
package s3

import (
	"bytes"
	"context"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

type Config struct {
	Bucket          string
	Region          string
	Endpoint        string
	AccessKeyID     string
	SecretAccessKey string
	// Transport overrides the shared pooled transport; nil is the normal case.
	Transport http.RoundTripper
}

type Client struct {
	cfg Config
	// scheme://host, plus the bucket segment when using path-style addressing.
	base string
	hc   *http.Client
}

type Object struct {
	Key      string
	Size     int64
	Modified time.Time
	ETag     string
}

type Listing struct {
	Objects  []Object
	Prefixes []string
}

// Error carries the S3 error code so callers can distinguish "missing" from "denied".
type Error struct {
	Status  int
	Code    string
	Message string
}

func (e *Error) Error() string {
	if e.Message != "" {
		return e.Message
	}
	if e.Code != "" {
		return e.Code
	}
	return "s3: status " + strconv.Itoa(e.Status)
}

func IsNotFound(err error) bool {
	var e *Error
	return errors.As(err, &e) && (e.Status == http.StatusNotFound || e.Code == "NoSuchKey" || e.Code == "NoSuchBucket")
}

// Timeouts are generous: listings and copies of large objects run on this client too.
var sharedTransport = &http.Transport{
	MaxIdleConnsPerHost:   8,
	IdleConnTimeout:       90 * time.Second,
	TLSHandshakeTimeout:   10 * time.Second,
	ResponseHeaderTimeout: 60 * time.Second,
}

func New(cfg Config) (*Client, error) {
	if cfg.Bucket == "" || cfg.Region == "" {
		return nil, errors.New("s3: bucket and region are required")
	}
	base := "https://" + cfg.Bucket + ".s3." + cfg.Region + ".amazonaws.com"
	if cfg.Endpoint != "" {
		u, err := url.Parse(cfg.Endpoint)
		if err != nil || u.Host == "" {
			return nil, errors.New("s3: invalid endpoint")
		}
		// Path-style for custom endpoints: R2/MinIO don't all resolve per-bucket hostnames.
		base = "https://" + u.Host + strings.TrimSuffix(u.Path, "/") + "/" + uriEncode(cfg.Bucket, false)
	}
	tr := cfg.Transport
	if tr == nil {
		tr = sharedTransport
	}
	return &Client{cfg: cfg, base: base, hc: &http.Client{Transport: tr}}, nil
}

// newRequest builds a signed request for key (may be empty) with the given query.
func (c *Client) newRequest(ctx context.Context, method, key string, query url.Values, body io.Reader) (*http.Request, error) {
	raw := c.base + "/" + uriEncode(key, true)
	if len(query) > 0 {
		// Not url.Values.Encode: it writes "+" for spaces, which SigV4 canonicalization won't match.
		raw += "?" + canonicalizeQuery(query)
	}
	req, err := http.NewRequestWithContext(ctx, method, raw, body)
	if err != nil {
		return nil, err
	}
	// Keep the sent path byte-identical to the signed one; Go's escaping differs from S3's.
	req.URL.Path = "/" + strings.TrimPrefix(c.basePath()+"/"+key, "/")
	req.URL.RawPath = uriEncode(req.URL.Path, true)
	return req, nil
}

func (c *Client) basePath() string {
	if i := strings.Index(c.base[len("https://"):], "/"); i >= 0 {
		p, _ := url.PathUnescape(c.base[len("https://")+i:])
		return strings.TrimSuffix(p, "/")
	}
	return ""
}

// B2 sheds load with transient 500/503s that clients are expected to retry, as the AWS SDKs do.
var retryDelays = []time.Duration{250 * time.Millisecond, time.Second, 3 * time.Second}

// Status 0 means the request never got a response (reset, stale pooled connection, timeout).
func retryable(err error) bool {
	var e *Error
	if !errors.As(err, &e) {
		return false
	}
	return e.Status == 0 || e.Status >= 500 || e.Code == "RequestTimeout"
}

// do sends req, retrying transient failures. rewind replays the body; nil forbids body replay.
func (c *Client) do(req *http.Request, payloadHash string, rewind func() error) (*http.Response, error) {
	for attempt := 0; ; attempt++ {
		resp, err := c.send(req, payloadHash)
		if err == nil || !retryable(err) || attempt == len(retryDelays) || req.Context().Err() != nil {
			return resp, err
		}
		if req.Body != nil {
			if rewind == nil || rewind() != nil {
				return nil, err
			}
		}
		log.Printf("s3: %s %s failed, retrying in %v: %v", req.Method, req.URL.Path, retryDelays[attempt], err)
		select {
		case <-req.Context().Done():
			return nil, err
		case <-time.After(retryDelays[attempt]):
		}
	}
}

// send signs and sends req once, converting any non-2xx response into an *Error.
func (c *Client) send(req *http.Request, payloadHash string) (*http.Response, error) {
	c.sign(req, payloadHash)
	resp, err := c.hc.Do(req)
	if err != nil {
		// Unwrap url.Error so the message doesn't repeat the full request URL back to the user.
		var ue *url.Error
		if errors.As(err, &ue) {
			err = ue.Err
		}
		return nil, &Error{Message: "couldn't reach the bucket: " + err.Error()}
	}
	if resp.StatusCode >= 300 {
		defer resp.Body.Close()
		return nil, parseError(resp)
	}
	return resp, nil
}

func parseError(resp *http.Response) *Error {
	e := &Error{Status: resp.StatusCode}
	var payload struct {
		Code    string `xml:"Code"`
		Message string `xml:"Message"`
	}
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<16))
	if xml.Unmarshal(body, &payload) == nil {
		e.Code, e.Message = payload.Code, payload.Message
	}
	if e.Message == "" {
		e.Message = "bucket request failed (" + resp.Status + ")"
	}
	return e
}

type listResult struct {
	IsTruncated bool   `xml:"IsTruncated"`
	NextToken   string `xml:"NextContinuationToken"`
	Contents    []struct {
		Key          string    `xml:"Key"`
		Size         int64     `xml:"Size"`
		LastModified time.Time `xml:"LastModified"`
		ETag         string    `xml:"ETag"`
	} `xml:"Contents"`
	CommonPrefixes []struct {
		Prefix string `xml:"Prefix"`
	} `xml:"CommonPrefixes"`
}

// urlDecode reverses encoding-type=url, leaving the value alone if it isn't valid encoding.
func urlDecode(s string) string {
	if decoded, err := url.QueryUnescape(s); err == nil {
		return decoded
	}
	return s
}

// List pages through prefix; "/" as delimiter yields folder-like Prefixes, limit caps objects.
func (c *Client) List(ctx context.Context, prefix, delimiter string, limit int) (*Listing, error) {
	out := &Listing{}
	for token := ""; ; {
		// encoding-type=url: without it, keys holding XML-hostile bytes break the response.
		q := url.Values{"list-type": {"2"}, "encoding-type": {"url"}, "prefix": {prefix}}
		if delimiter != "" {
			q.Set("delimiter", delimiter)
		}
		if token != "" {
			q.Set("continuation-token", token)
		}
		req, err := c.newRequest(ctx, http.MethodGet, "", q, nil)
		if err != nil {
			return nil, err
		}
		resp, err := c.do(req, emptyPayloadHash, nil)
		if err != nil {
			return nil, err
		}
		var page listResult
		err = xml.NewDecoder(resp.Body).Decode(&page)
		resp.Body.Close()
		if err != nil {
			return nil, fmt.Errorf("s3: bad listing response: %w", err)
		}

		for _, o := range page.Contents {
			out.Objects = append(out.Objects, Object{
				Key:      urlDecode(o.Key),
				Size:     o.Size,
				Modified: o.LastModified,
				ETag:     strings.Trim(o.ETag, `"`),
			})
		}
		for _, p := range page.CommonPrefixes {
			out.Prefixes = append(out.Prefixes, urlDecode(p.Prefix))
		}
		if !page.IsTruncated || page.NextToken == "" {
			return out, nil
		}
		if limit > 0 && len(out.Objects) >= limit {
			return out, nil
		}
		token = page.NextToken
	}
}

func (c *Client) Head(ctx context.Context, key string) (*Object, error) {
	req, err := c.newRequest(ctx, http.MethodHead, key, nil, nil)
	if err != nil {
		return nil, err
	}
	resp, err := c.do(req, emptyPayloadHash, nil)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	obj := &Object{Key: key, ETag: strings.Trim(resp.Header.Get("ETag"), `"`)}
	obj.Size, _ = strconv.ParseInt(resp.Header.Get("Content-Length"), 10, 64)
	if t, err := http.ParseTime(resp.Header.Get("Last-Modified")); err == nil {
		obj.Modified = t
	}
	return obj, nil
}

// Get returns a live response; the caller must close its body. rng is an optional Range header.
func (c *Client) Get(ctx context.Context, key, rng string) (*http.Response, error) {
	req, err := c.newRequest(ctx, http.MethodGet, key, nil, nil)
	if err != nil {
		return nil, err
	}
	if rng != "" {
		req.Header.Set("Range", rng)
	}
	return c.do(req, emptyPayloadHash, nil)
}

// Put uploads size bytes. Size must be known; S3 rejects chunked bodies without chunk signing.
func (c *Client) Put(ctx context.Context, key string, body io.Reader, size int64, contentType string) error {
	var rewind func() error
	if s, ok := body.(io.ReadSeeker); ok {
		if start, err := s.Seek(0, io.SeekCurrent); err == nil {
			rewind = func() error { _, err := s.Seek(start, io.SeekStart); return err }
			// NopCloser keeps the transport from closing the caller's file between retries.
			body = io.NopCloser(body)
		}
	}
	req, err := c.newRequest(ctx, http.MethodPut, key, nil, body)
	if err != nil {
		return err
	}
	req.ContentLength = size
	// NoBody, not a wrapped empty reader: it's what makes Go send Content-Length: 0, not chunked.
	if size == 0 {
		req.Body, rewind = http.NoBody, nil
	}
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	resp, err := c.do(req, unsignedPayload, rewind)
	if err != nil {
		return err
	}
	resp.Body.Close()
	return nil
}

// MaxSinglePut is the largest object S3 takes in one PUT or one CopyObject; past it, use multipart.
const MaxSinglePut = 5 << 30

// A multipart upload caps at 10,000 parts, so 16 MiB parts reach 160 GiB.
var streamPartSize = 16 << 20

const maxParts = 10000

type completedPart struct {
	PartNumber int    `xml:"PartNumber"`
	ETag       string `xml:"ETag"`
}

// PutStream uploads a body of unknown length via multipart past one part, holding one part in RAM.
func (c *Client) PutStream(ctx context.Context, key string, body io.Reader, contentType string) (int64, error) {
	buf := make([]byte, streamPartSize)
	n, err := readPart(body, buf)
	if err != nil {
		return 0, err
	}
	if n < len(buf) {
		return int64(n), c.Put(ctx, key, bytes.NewReader(buf[:n]), int64(n), contentType)
	}

	uploadID, err := c.createMultipart(ctx, key, contentType)
	if err != nil {
		return 0, err
	}
	var total int64
	var parts []completedPart
	for n > 0 {
		if len(parts) == maxParts {
			c.abortMultipart(key, uploadID)
			return 0, &Error{Code: "TooManyParts", Message: "file is too large to upload"}
		}
		etag, err := c.uploadPart(ctx, key, uploadID, len(parts)+1, buf[:n])
		if err != nil {
			c.abortMultipart(key, uploadID)
			return 0, err
		}
		parts = append(parts, completedPart{PartNumber: len(parts) + 1, ETag: etag})
		total += int64(n)

		if n, err = readPart(body, buf); err != nil {
			c.abortMultipart(key, uploadID)
			return 0, err
		}
	}
	if err := c.completeMultipart(ctx, key, uploadID, parts); err != nil {
		c.abortMultipart(key, uploadID)
		return 0, err
	}
	return total, nil
}

// readPart fills buf, treating either EOF form as a successful short read.
func readPart(r io.Reader, buf []byte) (int, error) {
	n, err := io.ReadFull(r, buf)
	if err == io.EOF || err == io.ErrUnexpectedEOF {
		return n, nil
	}
	return n, err
}

func (c *Client) createMultipart(ctx context.Context, key, contentType string) (string, error) {
	req, err := c.newRequest(ctx, http.MethodPost, key, url.Values{"uploads": {""}}, nil)
	if err != nil {
		return "", err
	}
	req.ContentLength = 0
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	resp, err := c.do(req, emptyPayloadHash, nil)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	var out struct {
		UploadID string `xml:"UploadId"`
	}
	if err := xml.NewDecoder(resp.Body).Decode(&out); err != nil || out.UploadID == "" {
		return "", &Error{Status: resp.StatusCode, Code: "BadInitiate", Message: "couldn't start a multipart upload"}
	}
	return out.UploadID, nil
}

func (c *Client) uploadPart(ctx context.Context, key, uploadID string, num int, data []byte) (string, error) {
	q := url.Values{"partNumber": {strconv.Itoa(num)}, "uploadId": {uploadID}}
	// data outlives the request, so a retry replays the part rather than failing the whole upload.
	r := bytes.NewReader(data)
	req, err := c.newRequest(ctx, http.MethodPut, key, q, r)
	if err != nil {
		return "", err
	}
	req.ContentLength = int64(len(data))
	resp, err := c.do(req, unsignedPayload, func() error { _, err := r.Seek(0, io.SeekStart); return err })
	if err != nil {
		return "", err
	}
	resp.Body.Close()
	etag := resp.Header.Get("ETag")
	if etag == "" {
		return "", &Error{Status: resp.StatusCode, Code: "NoETag", Message: "bucket returned no part ETag"}
	}
	return etag, nil
}

func (c *Client) completeMultipart(ctx context.Context, key, uploadID string, parts []completedPart) error {
	payload, err := xml.Marshal(struct {
		XMLName xml.Name        `xml:"CompleteMultipartUpload"`
		Parts   []completedPart `xml:"Part"`
	}{Parts: parts})
	if err != nil {
		return err
	}
	r := bytes.NewReader(payload)
	req, err := c.newRequest(ctx, http.MethodPost, key, url.Values{"uploadId": {uploadID}}, r)
	if err != nil {
		return err
	}
	req.ContentLength = int64(len(payload))
	req.Header.Set("Content-Type", "application/xml")
	resp, err := c.do(req, sha256hex(payload), func() error { _, err := r.Seek(0, io.SeekStart); return err })
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	// Completion can fail after a 200 header; the body carries the real outcome, as with Copy.
	b, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<16))
	if strings.Contains(string(b), "<Error") {
		return &Error{Status: resp.StatusCode, Code: "CompleteFailed", Message: "couldn't finish the upload"}
	}
	return nil
}

// Abort gets its own context: the request's is usually already dead when the upload fails.
func (c *Client) abortMultipart(key, uploadID string) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	req, err := c.newRequest(ctx, http.MethodDelete, key, url.Values{"uploadId": {uploadID}}, nil)
	if err != nil {
		return
	}
	resp, err := c.do(req, emptyPayloadHash, nil)
	if err != nil {
		// Orphaned parts still bill, so leave a trail when cleanup fails.
		log.Printf("s3: couldn't abort multipart upload %s for %s: %v", uploadID, key, err)
		return
	}
	resp.Body.Close()
}

func (c *Client) Delete(ctx context.Context, key string) error {
	req, err := c.newRequest(ctx, http.MethodDelete, key, nil, nil)
	if err != nil {
		return err
	}
	resp, err := c.do(req, emptyPayloadHash, nil)
	if err != nil {
		return err
	}
	resp.Body.Close()
	return nil
}

// Copy is a server-side copy; it avoids pulling object bytes through this process.
func (c *Client) Copy(ctx context.Context, srcKey, dstKey string, size int64, contentType string) error {
	if size > MaxSinglePut {
		return c.copyMultipart(ctx, srcKey, dstKey, size, contentType)
	}
	req, err := c.newRequest(ctx, http.MethodPut, dstKey, nil, nil)
	if err != nil {
		return err
	}
	req.ContentLength = 0
	req.Header.Set("X-Amz-Copy-Source", "/"+uriEncode(c.cfg.Bucket, false)+"/"+uriEncode(srcKey, true))
	resp, err := c.do(req, emptyPayloadHash, nil)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	// A copy can fail after a 200 header; the body carries the real outcome.
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<16))
	if strings.Contains(string(body), "<Error") {
		return &Error{Status: resp.StatusCode, Code: "CopyFailed", Message: "copy failed"}
	}
	return nil
}

// Server-side ranges cost no bandwidth here, so parts are large: 1 GiB still allows a 10 TiB object.
var copyPartSize int64 = 1 << 30

// copyMultipart copies range by range, the only way past CopyObject's single-request ceiling.
func (c *Client) copyMultipart(ctx context.Context, srcKey, dstKey string, size int64, contentType string) error {
	uploadID, err := c.createMultipart(ctx, dstKey, contentType)
	if err != nil {
		return err
	}
	var parts []completedPart
	for off := int64(0); off < size; off += copyPartSize {
		end := off + copyPartSize - 1
		if end >= size {
			end = size - 1
		}
		etag, err := c.copyPart(ctx, srcKey, dstKey, uploadID, len(parts)+1, off, end)
		if err != nil {
			c.abortMultipart(dstKey, uploadID)
			return err
		}
		parts = append(parts, completedPart{PartNumber: len(parts) + 1, ETag: etag})
	}
	if err := c.completeMultipart(ctx, dstKey, uploadID, parts); err != nil {
		c.abortMultipart(dstKey, uploadID)
		return err
	}
	return nil
}

func (c *Client) copyPart(ctx context.Context, srcKey, dstKey, uploadID string, num int, start, end int64) (string, error) {
	q := url.Values{"partNumber": {strconv.Itoa(num)}, "uploadId": {uploadID}}
	req, err := c.newRequest(ctx, http.MethodPut, dstKey, q, nil)
	if err != nil {
		return "", err
	}
	req.ContentLength = 0
	req.Header.Set("X-Amz-Copy-Source", "/"+uriEncode(c.cfg.Bucket, false)+"/"+uriEncode(srcKey, true))
	req.Header.Set("X-Amz-Copy-Source-Range", fmt.Sprintf("bytes=%d-%d", start, end))
	resp, err := c.do(req, emptyPayloadHash, nil)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	// Unlike UploadPart, the ETag comes back in the body, and a copy can still fail after a 200.
	var out struct {
		ETag string `xml:"ETag"`
	}
	if err := xml.NewDecoder(resp.Body).Decode(&out); err != nil || out.ETag == "" {
		return "", &Error{Status: resp.StatusCode, Code: "CopyFailed", Message: "copy failed"}
	}
	return out.ETag, nil
}
