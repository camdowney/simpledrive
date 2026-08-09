package handler

import (
	"io"
	"os"
	"path/filepath"
)

// The server never sees a passphrase or any plaintext; it stores these files without reading them.
// The names are fixed so RECOVERY.md's instructions apply to every vault ever made.
const (
	vaultKeyName      = "vault.key.age"      // the vault identity, under the passphrase
	vaultRecoveryName = "vault.recovery.age" // the same identity, under the recovery code
	vaultIndexName    = "index.age"          // blob id -> real filename
	vaultRecoveryDoc  = "RECOVERY.md"        // plaintext, so a backup explains itself
)

// isVaultDir reports whether abs is a vault, which the key file alone identifies.
func isVaultDir(abs string) bool {
	fi, err := os.Stat(filepath.Join(abs, vaultKeyName))
	return err == nil && fi.Mode().IsRegular()
}

// saveOverwrite replaces name in one step, so a vault's index is never read half-written.
func saveOverwrite(dir, name string, src io.Reader) (string, error) {
	tmp, err := os.CreateTemp(dir, ".upload-*.tmp")
	if err != nil {
		return "", err
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)
	if _, err := io.Copy(tmp, src); err != nil {
		tmp.Close()
		return "", err
	}
	if err := tmp.Close(); err != nil {
		return "", err
	}
	// CreateTemp makes 0600; match what createUnique leaves behind for every other upload.
	if err := os.Chmod(tmpName, 0o644); err != nil {
		return "", err
	}
	if err := os.Rename(tmpName, filepath.Join(dir, name)); err != nil {
		return "", err
	}
	return name, nil
}
