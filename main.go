package main

import (
	"embed"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"runtime/debug"

	"simpledrive/internal/config"
	"simpledrive/internal/handler"

	"golang.org/x/crypto/bcrypt"
)

//go:embed web
var webFS embed.FS

const configFile = "config.json"

func main() {
	if len(os.Args) > 1 && os.Args[1] == "setup" {
		runSetup(os.Args[2:])
		return
	}

	// One 24MP decode alone needs ~150MB; a limit under that just makes the GC spin through it.
	if os.Getenv("GOMEMLIMIT") == "" {
		debug.SetMemoryLimit(256 << 20)
	}

	fs := flag.NewFlagSet("simpledrive", flag.ExitOnError)
	addr := fs.String("addr", "", "listen address (overrides config)")
	fs.Parse(os.Args[1:])

	cfg, err := config.Load(configFile)
	if err != nil {
		log.Fatalf("config: %v", err)
	}
	if *addr != "" {
		cfg.Addr = *addr
	}

	srv := handler.New(cfg, webFS)
	log.Printf("simpledrive listening on %s, root=%s", cfg.Addr, cfg.RootDir)
	if err := http.ListenAndServe(cfg.Addr, srv); err != nil {
		log.Fatal(err)
	}
}

func runSetup(args []string) {
	fs := flag.NewFlagSet("setup", flag.ExitOnError)
	username := fs.String("username", "", "login username (required)")
	password := fs.String("password", "", "plaintext password to hash (required)")
	rootDir := fs.String("root-dir", "", "directory to serve (required)")
	addr := fs.String("addr", "", "listen address (required)")
	sessionHours := fs.Int("session-hours", 48, "session lifetime in hours")
	trashDays := fs.Int("trash-days", config.DefaultTrashDays, "days a deleted file stays in .trash; negative keeps it")
	trustedProxy := fs.Bool("trusted-proxy", false, "trust X-Real-IP; only behind a real reverse proxy")
	fs.Parse(args)

	if *username == "" || *password == "" || *rootDir == "" || *addr == "" {
		if *username == "" {
			fmt.Fprintln(os.Stderr, "error: -username is required")
		}
		if *password == "" {
			fmt.Fprintln(os.Stderr, "error: -password is required")
		}
		if *rootDir == "" {
			fmt.Fprintln(os.Stderr, "error: -root-dir is required")
		}
		if *addr == "" {
			fmt.Fprintln(os.Stderr, "error: -addr is required")
		}
		fmt.Fprintln(os.Stderr, "usage: simpledrive setup -username <name> -password <password> -root-dir <path> -addr <addr> [options]")
		fs.PrintDefaults()
		os.Exit(1)
	}
	if len(*password) < 12 {
		fmt.Fprintln(os.Stderr, "error: password must be at least 12 characters")
		os.Exit(1)
	}

	hash, err := bcrypt.GenerateFromPassword([]byte(*password), 12)
	if err != nil {
		log.Fatalf("bcrypt: %v", err)
	}

	cfg := config.Config{
		Addr:         *addr,
		RootDir:      *rootDir,
		Username:     *username,
		PasswordHash: string(hash),
		SessionHours: *sessionHours,
		TrashDays:    *trashDays,
		TrustedProxy: *trustedProxy,
	}

	data, _ := json.MarshalIndent(cfg, "", "  ")
	data = append(data, '\n')

	if err := os.WriteFile(configFile, data, 0600); err != nil {
		log.Fatalf("write %s: %v", configFile, err)
	}

	fmt.Printf("wrote %s\n", configFile)
}
