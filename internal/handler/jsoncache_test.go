package handler

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func writeMountsFile(t *testing.T, path string, names ...string) {
	t.Helper()
	body := "["
	for i, n := range names {
		if i > 0 {
			body += ","
		}
		body += `{"id":"` + n + `","name":"` + n + `"}`
	}
	body += "]"
	if err := os.WriteFile(path, []byte(body), 0600); err != nil {
		t.Fatal(err)
	}
}

func TestJSONCacheMissingFileIsEmpty(t *testing.T) {
	var c jsonCache[mount]
	got, err := c.load(filepath.Join(t.TempDir(), "absent.json"))
	if err != nil || got != nil {
		t.Fatalf("absent file: got %v, %v; want nil, nil", got, err)
	}
}

func TestJSONCacheServesRepeatLoadsAndSeesExternalEdits(t *testing.T) {
	p := filepath.Join(t.TempDir(), "mounts.json")
	writeMountsFile(t, p, "one")
	var c jsonCache[mount]

	for i := 0; i < 3; i++ {
		got, err := c.load(p)
		if err != nil || len(got) != 1 || got[0].Name != "one" {
			t.Fatalf("load %d: got %v, %v", i, got, err)
		}
	}

	// A file edited outside the process must still be picked up; mtime carries the change.
	time.Sleep(10 * time.Millisecond)
	writeMountsFile(t, p, "one", "two")
	got, err := c.load(p)
	if err != nil || len(got) != 2 {
		t.Fatalf("after external edit: got %v, %v; want 2 mounts", got, err)
	}
}

func TestJSONCacheCopyIsIsolated(t *testing.T) {
	p := filepath.Join(t.TempDir(), "mounts.json")
	writeMountsFile(t, p, "one")
	var c jsonCache[mount]

	first, err := c.load(p)
	if err != nil {
		t.Fatal(err)
	}
	first[0].Name = "clobbered"

	second, err := c.load(p)
	if err != nil {
		t.Fatal(err)
	}
	if second[0].Name != "one" {
		t.Fatalf("caller's mutation reached the cache: got %q, want %q", second[0].Name, "one")
	}
}

func TestJSONCacheForgetSurvivesSameTickWrite(t *testing.T) {
	p := filepath.Join(t.TempDir(), "mounts.json")
	writeMountsFile(t, p, "one")
	var c jsonCache[mount]
	if _, err := c.load(p); err != nil {
		t.Fatal(err)
	}

	// Same byte count and possibly the same mtime tick: only forget can catch this.
	c.forget()
	writeMountsFile(t, p, "two")
	got, err := c.load(p)
	if err != nil || len(got) != 1 || got[0].Name != "two" {
		t.Fatalf("after forget: got %v, %v; want the rewritten value", got, err)
	}
}
