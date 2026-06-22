// Command fakeaws is a cross-platform stand-in for the AWS CLI used by the
// sync-api http tests. It mirrors the subcommands the server invokes and
// prints canned JSON, replacing the previous POSIX shell-script fixtures that
// could not execute on Windows (no shebang/PATHEXT handling for extensionless
// scripts).
//
// Behaviour is selected via the FAKE_AWS_MODE environment variable:
//
//	(unset)   working AWS CLI: register-client / create-token / get-role-credentials
//	old-cli   an AWS CLI too old for the mobile SSO browser flow (stderr + exit 252)
//	timeout   hangs so the caller's probe timeout fires
package main

import (
	"fmt"
	"os"
	"time"
)

func main() {
	args := os.Args[1:]

	switch os.Getenv("FAKE_AWS_MODE") {
	case "old-cli":
		fmt.Fprintln(os.Stderr, "Unknown options: --issuer-url, --redirect-uris, --grant-types")
		os.Exit(252)
	case "timeout":
		// Sleep well past any test timeout; the parent kills us once it fires.
		time.Sleep(30 * time.Second)
		return
	}

	switch {
	case len(args) >= 2 && args[0] == "sso-oidc" && args[1] == "register-client":
		if containsArg(args, "--generate-cli-skeleton") {
			// Runtime probe: any successful JSON document is enough.
			fmt.Println(`{}`)
			return
		}
		fmt.Println(`{"clientId":"client-1","clientSecret":"secret-1"}`)
	case len(args) >= 2 && args[0] == "sso-oidc" && args[1] == "create-token":
		fmt.Println(`{"accessToken":"access-token-1","refreshToken":"refresh-token-1","expiresIn":3600}`)
	case len(args) >= 2 && args[0] == "sso" && args[1] == "get-role-credentials":
		fmt.Println(`{"roleCredentials":{"accessKeyId":"AKIASSO","secretAccessKey":"sso-secret","sessionToken":"sso-token","expiration":4102444800000}}`)
	default:
		fmt.Fprintf(os.Stderr, "unexpected command: %v\n", args)
		os.Exit(1)
	}
}

func containsArg(args []string, target string) bool {
	for _, arg := range args {
		if arg == target {
			return true
		}
	}
	return false
}
