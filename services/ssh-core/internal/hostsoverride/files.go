package hostsoverride

import (
	"fmt"
	"os"
)

func RewriteManagedHostsFile(targetPath string, entries []Entry) error {
	current, err := readHostsFile(targetPath)
	if err != nil {
		return err
	}
	next, changed := RewriteManagedBlock(current, entries)
	if !changed {
		return nil
	}
	return writeFileAtomically(targetPath, []byte(next))
}

func ClearManagedHostsFile(targetPath string) error {
	current, err := readHostsFile(targetPath)
	if err != nil {
		return err
	}
	next, changed := ClearManagedBlock(current)
	if !changed {
		return nil
	}
	return writeFileAtomically(targetPath, []byte(next))
}

func ReadHostsFile(targetPath string) (string, error) {
	return readHostsFile(targetPath)
}

func readHostsFile(targetPath string) (string, error) {
	content, err := os.ReadFile(targetPath)
	if err != nil && !os.IsNotExist(err) {
		return "", fmt.Errorf("read hosts file: %w", err)
	}
	return string(content), nil
}

func writeFileAtomically(targetPath string, content []byte) error {
	if err := writeManagedHostsFile(targetPath, content); err != nil {
		return fmt.Errorf("replace hosts file: %w", err)
	}
	return nil
}
