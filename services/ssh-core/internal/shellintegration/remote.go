package shellintegration

import (
	"strings"
	"time"

	"dolssh/services/ssh-core/internal/autocomplete"
	"dolssh/services/ssh-core/internal/sshcmd"

	"golang.org/x/crypto/ssh"
)

const remoteShellProbeTimeout = 2 * time.Second

const remoteShellProbeCommand = `test -n "$BASH_VERSION" && printf 'bash\n'; test -n "$ZSH_VERSION" && printf 'zsh\n'; test -n "$version" && printf 'fish\n'; printf '%s\n' "$SHELL"`

// DetectRemoteShell identifies the login shell over a non-interactive SSH exec
// channel. If exec is unavailable, it returns empty and callers leave the PTY
// untouched; guessing POSIX syntax would print errors on Windows OpenSSH.
func DetectRemoteShell(client *ssh.Client) string {
	if client == nil {
		return ""
	}
	stdout, _, err := sshcmd.RunWithTimeout(client, remoteShellProbeCommand, remoteShellProbeTimeout)
	if err != nil {
		return ""
	}
	return NormalizeRemoteShellProbeOutput(stdout)
}

func NormalizeRemoteShellProbeOutput(stdout []byte) string {
	for _, field := range strings.Fields(string(stdout)) {
		if shell := autocomplete.NormalizeShellIntegrationShell(field); shell != "" {
			return shell
		}
	}
	return ""
}
