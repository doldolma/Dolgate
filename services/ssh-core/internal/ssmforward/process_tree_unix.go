//go:build !windows

package ssmforward

import "os/exec"

type processTreeKiller interface {
	Kill() error
	Close() error
}

func attachProcessTreeKiller(_ *exec.Cmd) (processTreeKiller, error) {
	return nil, nil
}
