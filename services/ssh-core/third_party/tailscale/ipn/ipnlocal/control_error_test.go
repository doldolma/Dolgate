// Copyright (c) Tailscale Inc & contributors
// SPDX-License-Identifier: BSD-3-Clause

package ipnlocal

import (
	"fmt"
	"testing"

	"tailscale.com/control/controlclient"
	"tailscale.com/ipn"
)

func TestControlErrorFromStatusError(t *testing.T) {
	err := fmt.Errorf("PollNetMap: %w", &controlclient.MapResponseError{
		Kind:       controlclient.MapResponseErrorNodeNotFound,
		StatusCode: 400,
		Body:       "node not found",
	})

	got := controlErrorFromStatusError(err)
	if got == nil {
		t.Fatal("controlErrorFromStatusError returned nil")
	}
	if got.Kind != ipn.ControlErrorNodeNotFound || got.StatusCode != 400 {
		t.Fatalf("control error = %#v", got)
	}
}
