package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"flag"
	"fmt"
	"os"

	"dolssh/services/ssh-core/internal/hostsoverride"
	"dolssh/services/ssh-core/internal/hostsoverrideipc"
)

func main() {
	if len(os.Args) < 2 {
		exitWithError("usage: dolgate-dns-helper <serve|rewrite-block|clear-block|ping|shutdown> [flags]")
	}

	command := os.Args[1]
	flags := flag.NewFlagSet(command, flag.ExitOnError)
	hostsFile := flags.String("hosts-file", defaultHostsFilePath(), "path to hosts file")
	payloadBase64 := flags.String("payload-base64", "", "base64-encoded override entries JSON")
	endpoint := flags.String("endpoint", "", "named pipe or unix socket endpoint")
	authToken := flags.String("auth-token", "", "shared secret for helper IPC requests")
	flags.Parse(os.Args[2:])

	switch command {
	case "serve":
		if *endpoint == "" {
			exitWithError("--endpoint is required")
		}
		if *authToken == "" {
			exitWithError("--auth-token is required")
		}
		listener, err := hostsoverrideipc.Listen(*endpoint)
		if err != nil {
			exitWithError(fmt.Sprintf("listen helper endpoint: %v", err))
		}
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		if err := hostsoverrideipc.Serve(ctx, cancel, listener, hostsoverrideipc.ServeConfig{
			AuthToken:     *authToken,
			HostsFilePath: *hostsFile,
		}); err != nil {
			exitWithError(fmt.Sprintf("serve helper: %v", err))
		}
	case "rewrite-block":
		if *payloadBase64 == "" {
			exitWithError("--payload-base64 is required")
		}
		entries := decodeEntries(*payloadBase64)
		if err := hostsoverride.RewriteManagedHostsFile(*hostsFile, entries); err != nil {
			exitWithError(err.Error())
		}
	case "clear-block":
		if err := hostsoverride.ClearManagedHostsFile(*hostsFile); err != nil {
			exitWithError(err.Error())
		}
	case "ping", "shutdown":
		if *endpoint == "" {
			exitWithError("--endpoint is required")
		}
		if *authToken == "" {
			exitWithError("--auth-token is required")
		}
		response, err := hostsoverrideipc.SendRequest(context.Background(), *endpoint, hostsoverrideipc.Request{
			Command:   command,
			AuthToken: *authToken,
		})
		if err != nil {
			exitWithError(err.Error())
		}
		if !response.OK {
			exitWithError(response.Error)
		}
	default:
		exitWithError(fmt.Sprintf("unsupported command: %s", command))
	}
}

func decodeEntries(payloadBase64 string) []hostsoverride.Entry {
	raw, err := base64.StdEncoding.DecodeString(payloadBase64)
	if err != nil {
		exitWithError(fmt.Sprintf("decode payload: %v", err))
	}
	var entries []hostsoverride.Entry
	if err := json.Unmarshal(raw, &entries); err != nil {
		exitWithError(fmt.Sprintf("parse payload: %v", err))
	}
	return entries
}

func exitWithError(message string) {
	_, _ = fmt.Fprintln(os.Stderr, message)
	os.Exit(1)
}
