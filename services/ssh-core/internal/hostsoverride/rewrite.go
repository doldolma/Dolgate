package hostsoverride

import (
	"fmt"
	"slices"
	"strings"
)

const (
	StartMarker = "# >>> dolssh managed dns overrides >>>"
	EndMarker   = "# <<< dolssh managed dns overrides <<<"
)

type Entry struct {
	Address  string `json:"address"`
	Hostname string `json:"hostname"`
}

func RewriteManagedBlock(content string, entries []Entry) (string, bool) {
	lineEnding := detectLineEnding(content)
	trimmedContent, hadTrailingNewline := splitContent(content)
	remainingLines := stripManagedBlockLines(trimmedContent)
	normalizedEntries := normalizeEntries(entries)

	var nextLines []string
	nextLines = append(nextLines, remainingLines...)
	if len(normalizedEntries) > 0 {
		nextLines = append(nextLines, StartMarker)
		for _, entry := range normalizedEntries {
			nextLines = append(nextLines, fmt.Sprintf("%s %s", entry.Address, entry.Hostname))
		}
		nextLines = append(nextLines, EndMarker)
	}

	var rebuilt strings.Builder
	if len(nextLines) > 0 {
		rebuilt.WriteString(strings.Join(nextLines, lineEnding))
		if hadTrailingNewline || len(normalizedEntries) > 0 {
			rebuilt.WriteString(lineEnding)
		}
	}

	next := rebuilt.String()
	return next, next != content
}

func ClearManagedBlock(content string) (string, bool) {
	return RewriteManagedBlock(content, nil)
}

func detectLineEnding(content string) string {
	if strings.Contains(content, "\r\n") {
		return "\r\n"
	}
	return "\n"
}

func splitContent(content string) ([]string, bool) {
	if content == "" {
		return nil, false
	}
	normalized := strings.ReplaceAll(content, "\r\n", "\n")
	hadTrailingNewline := strings.HasSuffix(normalized, "\n")
	normalized = strings.TrimSuffix(normalized, "\n")
	if normalized == "" {
		return nil, hadTrailingNewline
	}
	return strings.Split(normalized, "\n"), hadTrailingNewline
}

func stripManagedBlockLines(lines []string) []string {
	if len(lines) == 0 {
		return nil
	}

	remaining := make([]string, 0, len(lines))
	insideManagedBlock := false
	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		switch trimmed {
		case StartMarker:
			insideManagedBlock = true
			continue
		case EndMarker:
			insideManagedBlock = false
			continue
		}
		if insideManagedBlock {
			continue
		}
		remaining = append(remaining, line)
	}
	return remaining
}

func normalizeEntries(entries []Entry) []Entry {
	if len(entries) == 0 {
		return nil
	}

	normalized := make([]Entry, 0, len(entries))
	seen := make(map[string]struct{}, len(entries))
	for _, entry := range entries {
		address := strings.TrimSpace(entry.Address)
		hostname := strings.ToLower(strings.TrimSpace(entry.Hostname))
		if address == "" || hostname == "" {
			continue
		}
		key := address + "\x00" + hostname
		if _, exists := seen[key]; exists {
			continue
		}
		seen[key] = struct{}{}
		normalized = append(normalized, Entry{
			Address:  address,
			Hostname: hostname,
		})
	}

	slices.SortFunc(normalized, func(left, right Entry) int {
		if compare := strings.Compare(left.Hostname, right.Hostname); compare != 0 {
			return compare
		}
		return strings.Compare(left.Address, right.Address)
	})
	return normalized
}
