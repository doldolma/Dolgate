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
// channel. If exec is unavailable, it returns empty; interactive callers can
// then use the safe cross-shell in-band probe after recognizing a real prompt.
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

// NormalizeRemoteShell returns only shells whose integration can safely be
// typed into an already-running remote PTY. PowerShell integration remains
// available to local sessions, where it is installed through startup
// arguments instead of PSReadLine-managed interactive input.
func NormalizeRemoteShell(value string) string {
	switch shell := autocomplete.NormalizeShellIntegrationShell(value); shell {
	case "bash", "zsh", "fish":
		return shell
	default:
		return ""
	}
}

func NormalizeRemoteShellProbeOutput(stdout []byte) string {
	for _, field := range strings.Fields(string(stdout)) {
		if shell := NormalizeRemoteShell(field); shell != "" {
			return shell
		}
	}
	return ""
}
