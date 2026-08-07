package s3

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"
)

// unsignedPayload signs a request without hashing its body; only valid over TLS.
const unsignedPayload = "UNSIGNED-PAYLOAD"

var emptyPayloadHash = sha256hex(nil)

func sha256hex(b []byte) string {
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

func hmacSHA256(key []byte, data string) []byte {
	h := hmac.New(sha256.New, key)
	h.Write([]byte(data))
	return h.Sum(nil)
}

// uriEncode percent-encodes per RFC 3986; S3 signing keeps "/" literal in paths only.
func uriEncode(s string, keepSlash bool) string {
	const hexDigits = "0123456789ABCDEF"
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case c >= 'A' && c <= 'Z', c >= 'a' && c <= 'z', c >= '0' && c <= '9',
			c == '-', c == '_', c == '.', c == '~':
			b.WriteByte(c)
		case c == '/' && keepSlash:
			b.WriteByte(c)
		default:
			b.WriteByte('%')
			b.WriteByte(hexDigits[c>>4])
			b.WriteByte(hexDigits[c&0xf])
		}
	}
	return b.String()
}

// sign adds the SigV4 Authorization header. payloadHash is a hex digest or unsignedPayload.
func (c *Client) sign(req *http.Request, payloadHash string) {
	c.signAt(req, payloadHash, time.Now().UTC())
}

func (c *Client) signAt(req *http.Request, payloadHash string, now time.Time) {
	amzDate := now.Format("20060102T150405Z")
	dateStamp := now.Format("20060102")

	req.Header.Set("X-Amz-Date", amzDate)
	req.Header.Set("X-Amz-Content-Sha256", payloadHash)

	signed, canonReq := canonicalRequest(req, payloadHash)
	scope := dateStamp + "/" + c.cfg.Region + "/s3/aws4_request"
	sts := stringToSign(canonReq, amzDate, scope)
	sig := hex.EncodeToString(hmacSHA256(signingKey(c.cfg.SecretAccessKey, dateStamp, c.cfg.Region, "s3"), sts))

	req.Header.Set("Authorization", "AWS4-HMAC-SHA256 Credential="+c.cfg.AccessKeyID+"/"+scope+
		", SignedHeaders="+signed+", Signature="+sig)
}

// Presign returns a URL granting unauthenticated GET on key for ttl, signed in the query string.
func (c *Client) Presign(key string, ttl time.Duration) (string, error) {
	return c.presignAt(key, ttl, time.Now().UTC())
}

func (c *Client) presignAt(key string, ttl time.Duration, now time.Time) (string, error) {
	amzDate := now.Format("20060102T150405Z")
	scope := now.Format("20060102") + "/" + c.cfg.Region + "/s3/aws4_request"
	query := canonicalizeQuery(url.Values{
		"X-Amz-Algorithm":     {"AWS4-HMAC-SHA256"},
		"X-Amz-Credential":    {c.cfg.AccessKeyID + "/" + scope},
		"X-Amz-Date":          {amzDate},
		"X-Amz-Expires":       {strconv.Itoa(int(ttl.Seconds()))},
		"X-Amz-SignedHeaders": {"host"},
	})

	raw := c.base + "/" + uriEncode(key, true) + "?" + query
	req, err := http.NewRequest(http.MethodGet, raw, nil)
	if err != nil {
		return "", err
	}
	// Keep the signed path byte-identical to the sent one, as newRequest does.
	req.URL.Path = "/" + strings.TrimPrefix(c.basePath()+"/"+key, "/")
	req.URL.RawPath = uriEncode(req.URL.Path, true)

	_, canonReq := canonicalRequest(req, unsignedPayload)
	sts := stringToSign(canonReq, amzDate, scope)
	sig := hex.EncodeToString(hmacSHA256(signingKey(c.cfg.SecretAccessKey, now.Format("20060102"), c.cfg.Region, "s3"), sts))
	return raw + "&X-Amz-Signature=" + sig, nil
}

// canonicalRequest returns the signed-header list and the canonical request block.
func canonicalRequest(req *http.Request, payloadHash string) (string, string) {
	signed, canonHeaders := canonicalHeaders(req)
	return signed, strings.Join([]string{
		req.Method,
		uriEncode(req.URL.Path, true),
		canonicalQuery(req),
		canonHeaders,
		signed,
		payloadHash,
	}, "\n")
}

func stringToSign(canonReq, amzDate, scope string) string {
	return strings.Join([]string{
		"AWS4-HMAC-SHA256",
		amzDate,
		scope,
		sha256hex([]byte(canonReq)),
	}, "\n")
}

func signingKey(secret, dateStamp, region, service string) []byte {
	key := hmacSHA256([]byte("AWS4"+secret), dateStamp)
	key = hmacSHA256(key, region)
	key = hmacSHA256(key, service)
	return hmacSHA256(key, "aws4_request")
}

// canonicalHeaders returns the signed-header list and the canonical header block.
func canonicalHeaders(req *http.Request) (string, string) {
	names := make([]string, 0, len(req.Header)+1)
	values := map[string]string{}
	for name, vs := range req.Header {
		lower := strings.ToLower(name)
		// Only sign what S3 requires; Go may add others (User-Agent) after signing.
		if lower != "host" && lower != "content-type" && !strings.HasPrefix(lower, "x-amz-") {
			continue
		}
		names = append(names, lower)
		values[lower] = strings.Join(vs, ",")
	}
	if _, ok := values["host"]; !ok {
		names = append(names, "host")
		values["host"] = req.URL.Host
	}
	sort.Strings(names)

	var b strings.Builder
	for _, n := range names {
		b.WriteString(n)
		b.WriteByte(':')
		b.WriteString(strings.TrimSpace(values[n]))
		b.WriteByte('\n')
	}
	return strings.Join(names, ";"), b.String()
}

func canonicalQuery(req *http.Request) string {
	return canonicalizeQuery(req.URL.Query())
}

func canonicalizeQuery(q url.Values) string {
	keys := make([]string, 0, len(q))
	for k := range q {
		keys = append(keys, k)
	}
	sort.Strings(keys)

	parts := make([]string, 0, len(keys))
	for _, k := range keys {
		vs := append([]string(nil), q[k]...)
		sort.Strings(vs)
		for _, v := range vs {
			parts = append(parts, uriEncode(k, false)+"="+uriEncode(v, false))
		}
	}
	return strings.Join(parts, "&")
}
