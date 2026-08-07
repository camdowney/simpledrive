package s3

import (
	"context"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"
)

const (
	exampleKeyID  = "AKIAIOSFODNN7EXAMPLE"
	exampleSecret = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"
)

var exampleTime = time.Date(2013, 5, 24, 0, 0, 0, 0, time.UTC)

// authSignature pulls the hex signature out of an Authorization header.
func authSignature(t *testing.T, req *http.Request) string {
	t.Helper()
	auth := req.Header.Get("Authorization")
	i := strings.Index(auth, "Signature=")
	if i < 0 {
		t.Fatalf("no signature in %q", auth)
	}
	return auth[i+len("Signature="):]
}

// Expected signatures come from botocore's S3SigV4Auth for the same requests, so this pins
// our signing against a reference implementation rather than against itself.
func TestSignaturesMatchBotocore(t *testing.T) {
	cases := []struct {
		name        string
		endpoint    string
		method      string
		key         string
		query       url.Values
		contentType string
		payloadHash string
		want        string
	}{
		{
			name: "virtual host get", method: http.MethodGet, key: "test.txt",
			payloadHash: emptyPayloadHash,
			want:        "2e46714501b0d9bc603dc14b792d5c58689e101d7de843b268d12fa638eb4bda",
		},
		{
			name: "list with encoded space", method: http.MethodGet,
			query:       url.Values{"list-type": {"2"}, "prefix": {"my folder/"}},
			payloadHash: emptyPayloadHash,
			want:        "044a90690c1d0e43db27aac206fff942e90e4c067b85808dd0f9b7d140e13834",
		},
		{
			name: "put unsigned payload", method: http.MethodPut, key: "dir/a b.txt",
			contentType: "text/plain; charset=utf-8", payloadHash: unsignedPayload,
			want: "686b84ceaaa7739e2930845ebe272d627b0a0c8dd516873896a589a9d8053f53",
		},
		{
			name: "path style endpoint", endpoint: "https://acct.r2.cloudflarestorage.com",
			method: http.MethodGet, key: "dir/a.txt", payloadHash: emptyPayloadHash,
			want: "696d3ca7a4f354099832da9f0bda24b13e8e749f795f3c8d891b9dce5a463723",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			bucket := "examplebucket"
			if tc.endpoint != "" {
				bucket = "my-bucket"
			}
			c, err := New(Config{Bucket: bucket, Region: "us-east-1", Endpoint: tc.endpoint,
				AccessKeyID: exampleKeyID, SecretAccessKey: exampleSecret})
			if err != nil {
				t.Fatal(err)
			}
			req, err := c.newRequest(context.Background(), tc.method, tc.key, tc.query, nil)
			if err != nil {
				t.Fatal(err)
			}
			if tc.contentType != "" {
				req.Header.Set("Content-Type", tc.contentType)
			}
			c.signAt(req, tc.payloadHash, exampleTime)
			if got := authSignature(t, req); got != tc.want {
				t.Errorf("signature = %s, want %s", got, tc.want)
			}
		})
	}
}

// Expected signatures come from botocore's S3SigV4QueryAuth for the same URLs and expiry.
func TestPresignMatchesBotocore(t *testing.T) {
	cases := []struct {
		name     string
		bucket   string
		region   string
		endpoint string
		key      string
		want     string
	}{
		{
			name: "virtual host", bucket: "examplebucket", region: "us-east-1", key: "test.txt",
			want: "45fdb68b1f57d075c9f493fcd5103b7ed1f4d51fb93be9fa153e6ab4b471aa64",
		},
		{
			name: "encoded space", bucket: "examplebucket", region: "us-east-1", key: "dir/a b.txt",
			want: "a5e3c033cac4cfa60843cf9f0526ab48fdc652b70e7fbe2c582222e364777150",
		},
		{
			name: "path style endpoint", bucket: "my-bucket", region: "auto",
			endpoint: "https://acct.r2.cloudflarestorage.com", key: "dir/a.txt",
			want: "a8d845f7d70eff503255dc39f460ad51876592494b51ac8cf9ca7eabe6788448",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			c, err := New(Config{Bucket: tc.bucket, Region: tc.region, Endpoint: tc.endpoint,
				AccessKeyID: exampleKeyID, SecretAccessKey: exampleSecret})
			if err != nil {
				t.Fatal(err)
			}
			raw, err := c.presignAt(tc.key, 5*time.Minute, exampleTime)
			if err != nil {
				t.Fatal(err)
			}
			u, err := url.Parse(raw)
			if err != nil {
				t.Fatal(err)
			}
			if got := u.Query().Get("X-Amz-Signature"); got != tc.want {
				t.Errorf("signature = %s, want %s", got, tc.want)
			}
			if got := u.Query().Get("X-Amz-Expires"); got != "300" {
				t.Errorf("expires = %s, want 300", got)
			}
			// The signature covers the path, so the sent one must match the signed one byte for byte.
			if got, want := u.EscapedPath(), uriEncode(c.basePath()+"/"+tc.key, true); got != want {
				t.Errorf("sent path %q, signed path %q", got, want)
			}
		})
	}
}

func TestCanonicalRequestShape(t *testing.T) {
	c, err := New(Config{Bucket: "examplebucket", Region: "us-east-1",
		AccessKeyID: "AKIAIOSFODNN7EXAMPLE", SecretAccessKey: "secret"})
	if err != nil {
		t.Fatal(err)
	}
	req, err := c.newRequest(context.Background(), http.MethodGet, "test.txt", nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("X-Amz-Date", "20130524T000000Z")
	req.Header.Set("X-Amz-Content-Sha256", emptyPayloadHash)

	signed, canon := canonicalRequest(req, emptyPayloadHash)
	if signed != "host;x-amz-content-sha256;x-amz-date" {
		t.Fatalf("signed headers = %q", signed)
	}
	want := "GET\n/test.txt\n\n" +
		"host:examplebucket.s3.us-east-1.amazonaws.com\n" +
		"x-amz-content-sha256:" + emptyPayloadHash + "\n" +
		"x-amz-date:20130524T000000Z\n\n" +
		"host;x-amz-content-sha256;x-amz-date\n" +
		emptyPayloadHash
	if canon != want {
		t.Fatalf("canonical request:\n%q\nwant:\n%q", canon, want)
	}

	sts := stringToSign(canon, "20130524T000000Z", "20130524/us-east-1/s3/aws4_request")
	lines := strings.Split(sts, "\n")
	if len(lines) != 4 || lines[0] != "AWS4-HMAC-SHA256" || lines[1] != "20130524T000000Z" ||
		lines[2] != "20130524/us-east-1/s3/aws4_request" || len(lines[3]) != 64 {
		t.Fatalf("string to sign = %q", sts)
	}
}

// Query values must be canonicalized with %20, not the "+" that url.Values.Encode emits.
func TestCanonicalQueryEncodesSpaces(t *testing.T) {
	c, _ := New(Config{Bucket: "b", Region: "us-east-1", AccessKeyID: "k", SecretAccessKey: "s"})
	req, err := c.newRequest(context.Background(), http.MethodGet, "",
		url.Values{"prefix": {"my folder/"}, "list-type": {"2"}}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if got := req.URL.RawQuery; got != "list-type=2&prefix=my%20folder%2F" {
		t.Fatalf("raw query = %q", got)
	}
	if got := canonicalQuery(req); got != req.URL.RawQuery {
		t.Fatalf("canonical query %q != sent query %q", got, req.URL.RawQuery)
	}
}

// The signed path and the sent path must be byte-identical or S3 rejects the signature.
func TestPathEncodingIsStable(t *testing.T) {
	c, _ := New(Config{Bucket: "b", Region: "us-east-1", AccessKeyID: "k", SecretAccessKey: "s"})
	for _, key := range []string{"a b.txt", "dir/sub dir/x+y.png", "üñî.jpg", "100%.txt"} {
		req, err := c.newRequest(context.Background(), http.MethodGet, key, nil, nil)
		if err != nil {
			t.Fatalf("%s: %v", key, err)
		}
		if got, want := req.URL.EscapedPath(), uriEncode("/"+key, true); got != want {
			t.Errorf("%s: sent path %q, signed path %q", key, got, want)
		}
	}
}

func TestPathStyleEndpointKeepsBucketSegment(t *testing.T) {
	c, err := New(Config{Bucket: "my-bucket", Region: "auto", Endpoint: "https://acct.r2.cloudflarestorage.com",
		AccessKeyID: "k", SecretAccessKey: "s"})
	if err != nil {
		t.Fatal(err)
	}
	req, err := c.newRequest(context.Background(), http.MethodGet, "dir/a.txt", nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if req.URL.Host != "acct.r2.cloudflarestorage.com" || req.URL.Path != "/my-bucket/dir/a.txt" {
		t.Fatalf("url = %s", req.URL)
	}
}

func TestSignAtProducesStableAuthorization(t *testing.T) {
	c, _ := New(Config{Bucket: "b", Region: "us-east-1", AccessKeyID: "AKIATEST", SecretAccessKey: "s"})
	req, _ := c.newRequest(context.Background(), http.MethodGet, "x.txt", nil, nil)
	at := time.Date(2024, 3, 4, 5, 6, 7, 0, time.UTC)

	c.signAt(req, emptyPayloadHash, at)
	first := req.Header.Get("Authorization")
	if !strings.HasPrefix(first, "AWS4-HMAC-SHA256 Credential=AKIATEST/20240304/us-east-1/s3/aws4_request, ") {
		t.Fatalf("authorization = %q", first)
	}

	c.signAt(req, emptyPayloadHash, at)
	if second := req.Header.Get("Authorization"); second != first {
		t.Fatalf("re-signing changed the header:\n%s\n%s", first, second)
	}
}
