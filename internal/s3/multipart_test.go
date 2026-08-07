package s3

import (
	"bytes"
	"context"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"testing"
)

// fakeBucket answers the multipart protocol well enough to reassemble what PutStream sent.
type fakeBucket struct {
	uploadID  string
	singlePut string
	parts     map[int]string
	assembled string
	aborted   bool
	attempts  map[int]int
	// partFail optionally fails an attempt at a part; return nil to let it succeed.
	partFail func(num, attempt int) *http.Response
}

func newFakeBucket() *fakeBucket {
	return &fakeBucket{uploadID: "up-1", parts: map[int]string{}, attempts: map[int]int{}}
}

func (f *fakeBucket) roundTrip(req *http.Request) (*http.Response, error) {
	var body []byte
	if req.Body != nil {
		body, _ = io.ReadAll(req.Body)
	}
	q := req.URL.Query()

	switch {
	case req.Method == http.MethodPost && q.Has("uploads"):
		return response(200, "<InitiateMultipartUploadResult><UploadId>"+f.uploadID+
			"</UploadId></InitiateMultipartUploadResult>"), nil

	case req.Method == http.MethodPut && q.Has("partNumber"):
		num, err := strconv.Atoi(q.Get("partNumber"))
		if err != nil {
			return response(400, "<Error><Code>InvalidPart</Code></Error>"), nil
		}
		f.attempts[num]++
		if f.partFail != nil {
			if resp := f.partFail(num, f.attempts[num]); resp != nil {
				return resp, nil
			}
		}
		f.parts[num] = string(body)
		resp := response(200, "")
		resp.Header.Set("ETag", fmt.Sprintf("%q", "etag-"+q.Get("partNumber")))
		return resp, nil

	case req.Method == http.MethodPost && q.Has("uploadId"):
		var payload struct {
			Parts []completedPart `xml:"Part"`
		}
		if err := xml.Unmarshal(body, &payload); err != nil {
			return response(400, "<Error><Code>MalformedXML</Code></Error>"), nil
		}
		var b strings.Builder
		for _, p := range payload.Parts {
			if want := fmt.Sprintf("%q", "etag-"+strconv.Itoa(p.PartNumber)); p.ETag != want {
				return response(400, "<Error><Code>InvalidPart</Code></Error>"), nil
			}
			b.WriteString(f.parts[p.PartNumber])
		}
		f.assembled = b.String()
		return response(200, "<CompleteMultipartUploadResult></CompleteMultipartUploadResult>"), nil

	case req.Method == http.MethodDelete && q.Has("uploadId"):
		f.aborted = true
		return response(204, ""), nil

	case req.Method == http.MethodPut:
		f.singlePut = string(body)
		return response(200, ""), nil
	}
	return response(400, "<Error><Code>Unexpected</Code></Error>"), nil
}

func smallParts(t *testing.T, size int) {
	t.Helper()
	saved := streamPartSize
	streamPartSize = size
	t.Cleanup(func() { streamPartSize = saved })
}

func TestPutStreamUsesSinglePutBelowPartSize(t *testing.T) {
	smallParts(t, 8)
	f := newFakeBucket()
	cli := retryClient(t, f.roundTrip)

	n, err := cli.PutStream(context.Background(), "a.txt", strings.NewReader("hello"), "text/plain")
	if err != nil {
		t.Fatalf("PutStream: %v", err)
	}
	if n != 5 {
		t.Errorf("got %d bytes, want 5", n)
	}
	if f.singlePut != "hello" {
		t.Errorf("single PUT sent %q, want %q", f.singlePut, "hello")
	}
	if len(f.parts) != 0 {
		t.Errorf("used multipart for a small body: %d parts", len(f.parts))
	}
}

func TestPutStreamMultipartReassembles(t *testing.T) {
	smallParts(t, 8)
	f := newFakeBucket()
	cli := retryClient(t, f.roundTrip)

	// 2.5 parts, so the tail is a short final part rather than an exact multiple.
	want := strings.Repeat("a", 8) + strings.Repeat("b", 8) + strings.Repeat("c", 4)
	n, err := cli.PutStream(context.Background(), "big.bin", strings.NewReader(want), "application/octet-stream")
	if err != nil {
		t.Fatalf("PutStream: %v", err)
	}
	if n != int64(len(want)) {
		t.Errorf("got %d bytes, want %d", n, len(want))
	}
	if len(f.parts) != 3 {
		t.Fatalf("got %d parts, want 3", len(f.parts))
	}
	if f.assembled != want {
		t.Errorf("bucket assembled %q, want %q", f.assembled, want)
	}
	if f.singlePut != "" {
		t.Errorf("also sent a plain PUT: %q", f.singlePut)
	}
	if f.aborted {
		t.Error("aborted a successful upload")
	}
}

func TestPutStreamExactMultipleOfPartSize(t *testing.T) {
	smallParts(t, 8)
	f := newFakeBucket()
	cli := retryClient(t, f.roundTrip)

	want := strings.Repeat("a", 16)
	if _, err := cli.PutStream(context.Background(), "big.bin", strings.NewReader(want), ""); err != nil {
		t.Fatalf("PutStream: %v", err)
	}
	if len(f.parts) != 2 {
		t.Fatalf("got %d parts, want 2", len(f.parts))
	}
	if f.assembled != want {
		t.Errorf("bucket assembled %q, want %q", f.assembled, want)
	}
}

func TestPutStreamRetriesFailedPart(t *testing.T) {
	fastRetries(t)
	smallParts(t, 8)
	f := newFakeBucket()
	f.partFail = func(num, attempt int) *http.Response {
		if num == 2 && attempt == 1 {
			return response(503, "<Error><Code>ServiceUnavailable</Code><Message>busy</Message></Error>")
		}
		return nil
	}
	cli := retryClient(t, f.roundTrip)

	want := strings.Repeat("a", 8) + strings.Repeat("b", 8)
	if _, err := cli.PutStream(context.Background(), "big.bin", strings.NewReader(want), ""); err != nil {
		t.Fatalf("PutStream: %v", err)
	}
	if f.attempts[2] != 2 {
		t.Errorf("part 2 sent %d times, want 2", f.attempts[2])
	}
	if f.assembled != want {
		t.Errorf("bucket assembled %q, want %q", f.assembled, want)
	}
}

func TestPutStreamAbortsWhenAPartFails(t *testing.T) {
	fastRetries(t)
	smallParts(t, 8)
	f := newFakeBucket()
	f.partFail = func(num, attempt int) *http.Response {
		if num == 2 {
			return response(403, "<Error><Code>AccessDenied</Code><Message>nope</Message></Error>")
		}
		return nil
	}
	cli := retryClient(t, f.roundTrip)

	_, err := cli.PutStream(context.Background(), "big.bin", strings.NewReader(strings.Repeat("a", 20)), "")
	if err == nil {
		t.Fatal("PutStream: want error")
	}
	if !f.aborted {
		t.Error("left the multipart upload dangling instead of aborting it")
	}
	if f.assembled != "" {
		t.Error("completed an upload that had a failed part")
	}
}

func TestPutStreamAbortsWhenSourceFails(t *testing.T) {
	smallParts(t, 8)
	f := newFakeBucket()
	cli := retryClient(t, f.roundTrip)

	// A browser that disconnects mid-upload looks like this: good bytes, then a read error.
	src := io.MultiReader(bytes.NewReader([]byte(strings.Repeat("a", 8))), errReader{})
	_, err := cli.PutStream(context.Background(), "big.bin", src, "")
	if err == nil {
		t.Fatal("PutStream: want error")
	}
	if !f.aborted {
		t.Error("left the multipart upload dangling instead of aborting it")
	}
	if f.assembled != "" {
		t.Error("completed an upload whose source died")
	}
}

type errReader struct{}

func (errReader) Read([]byte) (int, error) { return 0, errors.New("connection reset by peer") }

func smallCopyParts(t *testing.T, size int64) {
	t.Helper()
	saved := copyPartSize
	copyPartSize = size
	t.Cleanup(func() { copyPartSize = saved })
}

// copyRanges records the source ranges a multipart copy asks the bucket for.
type copyRecorder struct {
	ranges    []string
	initiated bool
	completed []completedPart
	aborted   bool
	fail      func(num int) *http.Response
}

func (c *copyRecorder) roundTrip(req *http.Request) (*http.Response, error) {
	q := req.URL.Query()
	switch {
	case req.Method == http.MethodPost && q.Has("uploads"):
		c.initiated = true
		return response(200, "<InitiateMultipartUploadResult><UploadId>up-1</UploadId></InitiateMultipartUploadResult>"), nil

	case req.Method == http.MethodPut && q.Has("partNumber"):
		num, _ := strconv.Atoi(q.Get("partNumber"))
		if c.fail != nil {
			if resp := c.fail(num); resp != nil {
				return resp, nil
			}
		}
		c.ranges = append(c.ranges, req.Header.Get("X-Amz-Copy-Source-Range"))
		return response(200, "<CopyPartResult><ETag>\"etag-"+q.Get("partNumber")+"\"</ETag></CopyPartResult>"), nil

	case req.Method == http.MethodPost && q.Has("uploadId"):
		body, _ := io.ReadAll(req.Body)
		var payload struct {
			Parts []completedPart `xml:"Part"`
		}
		xml.Unmarshal(body, &payload)
		c.completed = payload.Parts
		return response(200, "<CompleteMultipartUploadResult></CompleteMultipartUploadResult>"), nil

	case req.Method == http.MethodDelete && q.Has("uploadId"):
		c.aborted = true
		return response(204, ""), nil
	}
	// A plain PUT with a copy-source header is the single-request path.
	if req.Method == http.MethodPut && req.Header.Get("X-Amz-Copy-Source") != "" {
		c.ranges = append(c.ranges, "single")
		return response(200, "<CopyObjectResult></CopyObjectResult>"), nil
	}
	return response(400, "<Error><Code>Unexpected</Code></Error>"), nil
}

func TestCopyUsesSingleRequestBelowLimit(t *testing.T) {
	c := &copyRecorder{}
	cli := retryClient(t, c.roundTrip)

	if err := cli.Copy(context.Background(), "a.bin", "b.bin", MaxSinglePut, "video/mp4"); err != nil {
		t.Fatalf("Copy: %v", err)
	}
	if c.initiated {
		t.Error("used multipart for an object at the single-request limit")
	}
	if len(c.ranges) != 1 || c.ranges[0] != "single" {
		t.Errorf("got %v, want one plain copy", c.ranges)
	}
}

func TestCopyMultipartCoversEveryByteExactlyOnce(t *testing.T) {
	smallCopyParts(t, 10)
	c := &copyRecorder{}
	cli := retryClient(t, c.roundTrip)

	// 25 bytes over 10-byte parts: the tail part must be short, and ranges are inclusive.
	if err := cli.copyMultipart(context.Background(), "a.bin", "b.bin", 25, "video/mp4"); err != nil {
		t.Fatalf("copyMultipart: %v", err)
	}
	want := []string{"bytes=0-9", "bytes=10-19", "bytes=20-24"}
	if len(c.ranges) != len(want) {
		t.Fatalf("got ranges %v, want %v", c.ranges, want)
	}
	for i, r := range c.ranges {
		if r != want[i] {
			t.Errorf("part %d range %q, want %q", i+1, r, want[i])
		}
	}
	if len(c.completed) != 3 {
		t.Fatalf("completed %d parts, want 3", len(c.completed))
	}
	for i, p := range c.completed {
		if p.PartNumber != i+1 {
			t.Errorf("part %d numbered %d", i+1, p.PartNumber)
		}
		if want := "\"etag-" + strconv.Itoa(i+1) + "\""; p.ETag != want {
			t.Errorf("part %d etag %q, want %q", i+1, p.ETag, want)
		}
	}
}

func TestCopyMultipartExactMultiple(t *testing.T) {
	smallCopyParts(t, 10)
	c := &copyRecorder{}
	cli := retryClient(t, c.roundTrip)

	if err := cli.copyMultipart(context.Background(), "a.bin", "b.bin", 20, ""); err != nil {
		t.Fatalf("copyMultipart: %v", err)
	}
	want := []string{"bytes=0-9", "bytes=10-19"}
	if len(c.ranges) != 2 || c.ranges[0] != want[0] || c.ranges[1] != want[1] {
		t.Errorf("got ranges %v, want %v", c.ranges, want)
	}
}

func TestCopyMultipartAbortsOnPartFailure(t *testing.T) {
	fastRetries(t)
	smallCopyParts(t, 10)
	c := &copyRecorder{fail: func(num int) *http.Response {
		if num == 2 {
			return response(403, "<Error><Code>AccessDenied</Code><Message>nope</Message></Error>")
		}
		return nil
	}}
	cli := retryClient(t, c.roundTrip)

	if err := cli.copyMultipart(context.Background(), "a.bin", "b.bin", 25, ""); err == nil {
		t.Fatal("copyMultipart: want error")
	}
	if !c.aborted {
		t.Error("left the copy's multipart upload dangling")
	}
	if c.completed != nil {
		t.Error("completed a copy with a failed part")
	}
}

// A 200 with an <Error> body is S3's documented way to fail a copy mid-flight.
func TestCopyPartRejectsErrorBodyWithOKStatus(t *testing.T) {
	fastRetries(t)
	smallCopyParts(t, 10)
	c := &copyRecorder{fail: func(num int) *http.Response {
		return response(200, "<Error><Code>InternalError</Code><Message>boom</Message></Error>")
	}}
	cli := retryClient(t, c.roundTrip)

	if err := cli.copyMultipart(context.Background(), "a.bin", "b.bin", 25, ""); err == nil {
		t.Fatal("copyMultipart: want error on an <Error> body")
	}
	if !c.aborted {
		t.Error("left the copy's multipart upload dangling")
	}
}
