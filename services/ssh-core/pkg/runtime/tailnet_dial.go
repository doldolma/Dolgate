package runtime

import (
	"strings"

	"dolssh/services/ssh-core/internal/sshconn"
	"dolssh/services/ssh-core/internal/tailnetservice"
)

var (
	ErrTailnetMismatch        = tailnetservice.ErrTailnetMismatch
	ErrTailnetLoginRejected   = tailnetservice.ErrTailnetLoginRejected
	ErrTailnetNeedsAuth       = tailnetservice.ErrTailnetNeedsAuth
	ErrTailnetNeedsApproval   = tailnetservice.ErrTailnetNeedsApproval
	ErrTailnetExpired         = tailnetservice.ErrTailnetExpired
	ErrTailnetIdentityInvalid = tailnetservice.ErrTailnetIdentityInvalid
)

// TailnetRoute remains an alias so existing runtime consumers do not need to
// know where Tailnet orchestration is implemented.
type TailnetRoute = tailnetservice.TailnetRoute

func (runtime *Runtime) tailnetDial(route TailnetRoute) (sshconn.DialFunc, error) {
	if strings.TrimSpace(route.ID) == "" {
		return nil, nil
	}
	if runtime.tailnetService == nil {
		return nil, errTailnetDisabled
	}
	return runtime.tailnetService.Dial(route)
}
