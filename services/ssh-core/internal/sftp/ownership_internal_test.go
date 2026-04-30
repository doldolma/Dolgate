package sftp

import (
	"strings"
	"testing"

	"dolssh/services/ssh-core/internal/protocol"
)

func TestBuildChownOwnerSpec(t *testing.T) {
	uid := 1001
	gid := 1002
	tests := []struct {
		name    string
		payload protocol.SFTPChownPayload
		want    string
		wantErr bool
	}{
		{name: "owner and group names", payload: protocol.SFTPChownPayload{Owner: "alice", Group: "deploy"}, want: "alice:deploy"},
		{name: "owner only", payload: protocol.SFTPChownPayload{Owner: "alice"}, want: "alice"},
		{name: "group only", payload: protocol.SFTPChownPayload{Group: "deploy"}, want: ":deploy"},
		{name: "uid and gid", payload: protocol.SFTPChownPayload{UID: &uid, GID: &gid}, want: "1001:1002"},
		{name: "colon rejected", payload: protocol.SFTPChownPayload{Owner: "bad:name"}, wantErr: true},
		{name: "missing target", payload: protocol.SFTPChownPayload{}, wantErr: true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got, err := buildChownOwnerSpec(test.payload)
			if test.wantErr {
				if err == nil {
					t.Fatalf("expected error, got nil")
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if got != test.want {
				t.Fatalf("expected %q, got %q", test.want, got)
			}
		})
	}
}

func TestBuildChownCommandQuotesInputs(t *testing.T) {
	command := buildChownCommand("sudo -n", "alice:deploy", "/srv/app/it's here", false)
	for _, snippet := range []string{"sudo -n chown --", "'alice:deploy'", `'/srv/app/it'"'"'s here'`} {
		if !strings.Contains(command, snippet) {
			t.Fatalf("expected command %q to include %q", command, snippet)
		}
	}
}

func TestBuildChownCommandCanBeRecursive(t *testing.T) {
	command := buildChownCommand("sudo -n", "alice:deploy", "/srv/app", true)
	for _, snippet := range []string{"sudo -n chown -R --", "'alice:deploy'", "'/srv/app'"} {
		if !strings.Contains(command, snippet) {
			t.Fatalf("expected command %q to include %q", command, snippet)
		}
	}
}

func TestParsePrincipalLine(t *testing.T) {
	user, ok := parsePrincipalLine("user", "alice:x:1001:1001:Alice Example,,,:/home/alice:/bin/bash")
	if !ok {
		t.Fatalf("expected user principal")
	}
	if user.Kind != "user" || user.Name != "alice" || user.ID != 1001 || user.DisplayName != "Alice Example" {
		t.Fatalf("unexpected user principal: %#v", user)
	}

	group, ok := parsePrincipalLine("group", "deploy:x:1002:alice,bob")
	if !ok {
		t.Fatalf("expected group principal")
	}
	if group.Kind != "group" || group.Name != "deploy" || group.ID != 1002 {
		t.Fatalf("unexpected group principal: %#v", group)
	}
}
