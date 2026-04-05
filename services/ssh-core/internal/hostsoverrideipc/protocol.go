package hostsoverrideipc

import "dolssh/services/ssh-core/internal/hostsoverride"

const (
	CommandPing         = "ping"
	CommandRewriteBlock = "rewrite-block"
	CommandClearBlock   = "clear-block"
	CommandReadHosts    = "read-hosts"
	CommandShutdown     = "shutdown"
)

type Request struct {
	Command       string                `json:"command"`
	AuthToken     string                `json:"authToken"`
	HostsFilePath string                `json:"hostsFilePath,omitempty"`
	Entries       []hostsoverride.Entry `json:"entries,omitempty"`
}

type Response struct {
	OK               bool   `json:"ok"`
	Error            string `json:"error,omitempty"`
	HostsFileContent string `json:"hostsFileContent,omitempty"`
}
