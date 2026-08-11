package config

import (
	"encoding/json"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strings"
	"time"
)

type Config struct {
	Addr         string `json:"addr"`
	RootDir      string `json:"root_dir"`
	Username     string `json:"username"`
	PasswordHash string `json:"password_hash"`
	SessionHours int    `json:"session_hours"`
	// Days a deleted file waits in .trash before auto-purge. 0 uses the default; negative never purges.
	TrashDays int `json:"trash_days"`

	// Derived: sit next to config.json, which must stay outside RootDir since some hold secrets.
	ThumbCacheDir  string `json:"-"`
	PrefsPath      string `json:"-"`
	TagsPath       string `json:"-"`
	MountsPath     string `json:"-"`
	SharesPath     string `json:"-"`
	TrashIndexPath string `json:"-"`
}

// DefaultTrashDays is the retention applied when trash_days is unset.
const DefaultTrashDays = 7

// TrashRetention resolves the configured retention; ok=false means keep forever.
func (c *Config) TrashRetention() (time.Duration, bool) {
	if c.TrashDays < 0 {
		return 0, false
	}
	days := c.TrashDays
	if days == 0 {
		days = DefaultTrashDays
	}
	return time.Duration(days) * 24 * time.Hour, true
}

// ValidateAddr rejects up front what ListenAndServe would only reject at startup.
func ValidateAddr(addr string) error {
	_, port, err := net.SplitHostPort(addr)
	if err != nil || port == "" {
		return fmt.Errorf("addr %q must be host:port, e.g. :8080 or 127.0.0.1:8080", addr)
	}
	if _, err := net.LookupPort("tcp", port); err != nil {
		return fmt.Errorf("addr %q has an invalid port %q", addr, port)
	}
	return nil
}

func Load(path string) (*Config, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("open %s: %w", path, err)
	}
	defer f.Close()

	cfg := &Config{
		Addr:         ":8080",
		SessionHours: 24,
	}
	if err := json.NewDecoder(f).Decode(cfg); err != nil {
		return nil, fmt.Errorf("decode: %w", err)
	}
	if err := ValidateAddr(cfg.Addr); err != nil {
		return nil, err
	}
	if cfg.Username == "" {
		return nil, fmt.Errorf("username is required")
	}
	if cfg.PasswordHash == "" {
		return nil, fmt.Errorf("password_hash is required")
	}
	if cfg.RootDir == "" {
		return nil, fmt.Errorf("root_dir is required")
	}
	abs, err := filepath.Abs(cfg.RootDir)
	if err != nil {
		return nil, fmt.Errorf("root_dir: %w", err)
	}
	cfg.RootDir = abs

	configAbs, err := filepath.Abs(path)
	if err != nil {
		return nil, fmt.Errorf("config path: %w", err)
	}
	dir := filepath.Dir(configAbs)
	if dir == cfg.RootDir || strings.HasPrefix(dir, cfg.RootDir+string(filepath.Separator)) {
		return nil, fmt.Errorf("config.json must live outside root_dir")
	}
	cfg.ThumbCacheDir = filepath.Join(dir, "thumbcache")
	cfg.PrefsPath = filepath.Join(dir, "prefs.json")
	cfg.TagsPath = filepath.Join(dir, "tags.json")
	cfg.MountsPath = filepath.Join(dir, "mounts.json")
	cfg.SharesPath = filepath.Join(dir, "shares.json")
	cfg.TrashIndexPath = filepath.Join(dir, "trash.json")
	return cfg, nil
}
