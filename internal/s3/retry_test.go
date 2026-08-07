package s3

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"
)

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func fastRetries(t *testing.T) {
	t.Helper()
	saved := retryDelays
	retryDelays = []time.Duration{0, 0, 0}
	t.Cleanup(func() { retryDelays = saved })
}

func retryClient(t *testing.T, rt roundTripFunc) *Client {
	t.Helper()
	c, err := New(Config{
		Bucket: "bkt", Region: "us-east-005",
		AccessKeyID: exampleKeyID, SecretAccessKey: exampleSecret,
		Transport: rt,
	})
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func response(status int, body string) *http.Response {
	return &http.Response{StatusCode: status, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(body))}
}

func TestPutRetriesTransientFailures(t *testing.T) {
	fastRetries(t)
	var bodies []string
	cli := retryClient(t, func(req *http.Request) (*http.Response, error) {
		b, err := io.ReadAll(req.Body)
		if err != nil {
			t.Fatalf("read body: %v", err)
		}
		bodies = append(bodies, string(b))
		switch len(bodies) {
		case 1:
			return response(503, `<Error><Code>ServiceUnavailable</Code><Message>no tomes available</Message></Error>`), nil
		case 2:
			return nil, errors.New("connection reset by peer")
		}
		return response(200, ""), nil
	})

	body := bytes.NewReader([]byte("hello"))
	if err := cli.Put(context.Background(), "a.txt", body, 5, "text/plain"); err != nil {
		t.Fatalf("Put: %v", err)
	}
	if len(bodies) != 3 {
		t.Fatalf("got %d attempts, want 3", len(bodies))
	}
	for i, b := range bodies {
		if b != "hello" {
			t.Errorf("attempt %d sent body %q, want %q", i+1, b, "hello")
		}
	}
}

func TestPutGivesUpAfterMaxRetries(t *testing.T) {
	fastRetries(t)
	attempts := 0
	cli := retryClient(t, func(req *http.Request) (*http.Response, error) {
		attempts++
		io.Copy(io.Discard, req.Body)
		return response(500, `<Error><Code>InternalError</Code><Message>boom</Message></Error>`), nil
	})

	err := cli.Put(context.Background(), "a.txt", bytes.NewReader([]byte("hi")), 2, "")
	if err == nil {
		t.Fatal("Put: want error")
	}
	if want := 1 + len(retryDelays); attempts != want {
		t.Fatalf("got %d attempts, want %d", attempts, want)
	}
}

func TestPutDoesNotRetryPermanentErrors(t *testing.T) {
	fastRetries(t)
	attempts := 0
	cli := retryClient(t, func(req *http.Request) (*http.Response, error) {
		attempts++
		io.Copy(io.Discard, req.Body)
		return response(403, `<Error><Code>AccessDenied</Code><Message>nope</Message></Error>`), nil
	})

	if err := cli.Put(context.Background(), "a.txt", bytes.NewReader([]byte("hi")), 2, ""); err == nil {
		t.Fatal("Put: want error")
	}
	if attempts != 1 {
		t.Fatalf("got %d attempts, want 1", attempts)
	}
}

func TestPutDoesNotRetryUnseekableBody(t *testing.T) {
	fastRetries(t)
	attempts := 0
	cli := retryClient(t, func(req *http.Request) (*http.Response, error) {
		attempts++
		io.Copy(io.Discard, req.Body)
		return response(503, `<Error><Code>ServiceUnavailable</Code><Message>busy</Message></Error>`), nil
	})

	unseekable := io.MultiReader(strings.NewReader("hi"))
	if err := cli.Put(context.Background(), "a.txt", unseekable, 2, ""); err == nil {
		t.Fatal("Put: want error")
	}
	if attempts != 1 {
		t.Fatalf("got %d attempts, want 1", attempts)
	}
}

func TestHeadRetriesNetworkErrors(t *testing.T) {
	fastRetries(t)
	attempts := 0
	cli := retryClient(t, func(req *http.Request) (*http.Response, error) {
		attempts++
		if attempts == 1 {
			return nil, errors.New("EOF")
		}
		return response(200, ""), nil
	})

	if _, err := cli.Head(context.Background(), "a.txt"); err != nil {
		t.Fatalf("Head: %v", err)
	}
	if attempts != 2 {
		t.Fatalf("got %d attempts, want 2", attempts)
	}
}

func TestRetryStopsOnCanceledContext(t *testing.T) {
	fastRetries(t)
	ctx, cancel := context.WithCancel(context.Background())
	attempts := 0
	cli := retryClient(t, func(req *http.Request) (*http.Response, error) {
		attempts++
		cancel()
		return response(503, `<Error><Code>ServiceUnavailable</Code><Message>busy</Message></Error>`), nil
	})

	if _, err := cli.Head(ctx, "a.txt"); err == nil {
		t.Fatal("Head: want error")
	}
	if attempts != 1 {
		t.Fatalf("got %d attempts, want 1", attempts)
	}
}
