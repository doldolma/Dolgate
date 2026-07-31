// Copyright (c) Tailscale Inc & contributors
// SPDX-License-Identifier: BSD-3-Clause

package controlclient

import "testing"

func TestNewMapResponseErrorClassifiesNodeNotFound(t *testing.T) {
	for _, status := range []int{404, 400} {
		err := newMapResponseError(status, "node not found\n")
		if err.Kind != MapResponseErrorNodeNotFound {
			t.Errorf("status %d: Kind = %q, want %q", status, err.Kind, MapResponseErrorNodeNotFound)
		}
	}

	for _, tc := range []struct {
		status int
		body   string
	}{
		{500, "node not found"},
		{404, "machine not found"},
		{400, "temporary control failure"},
	} {
		if got := newMapResponseError(tc.status, tc.body).Kind; got != "" {
			t.Errorf("newMapResponseError(%d, %q).Kind = %q, want empty", tc.status, tc.body, got)
		}
	}
}
