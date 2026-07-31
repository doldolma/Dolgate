// Copyright (c) Tailscale Inc & contributors
// SPDX-License-Identifier: BSD-3-Clause

package controlclient

import (
	"fmt"
	"strings"
)

// MapResponseErrorKind identifies control-plane responses that callers need to
// handle differently from transient map polling failures.
type MapResponseErrorKind string

const (
	// MapResponseErrorNodeNotFound means the control plane no longer recognizes
	// the persisted node identity. Retrying with the same node key cannot recover.
	MapResponseErrorNodeNotFound MapResponseErrorKind = "nodeNotFound"
)

// MapResponseError is a non-200 response to a /machine/map request.
type MapResponseError struct {
	Kind       MapResponseErrorKind
	StatusCode int
	Body       string
}

func (e *MapResponseError) Error() string {
	if e == nil {
		return "map request failed"
	}
	return fmt.Sprintf("initial fetch failed %d: %s", e.StatusCode, e.Body)
}

func newMapResponseError(statusCode int, body string) *MapResponseError {
	body = strings.TrimSpace(body)
	err := &MapResponseError{StatusCode: statusCode, Body: body}
	// The official control plane returns 404 when an administrator deleted the
	// node. Some compatible control planes historically returned 400 for the
	// same response, so keep both status codes while requiring the exact body.
	if (statusCode == 404 || statusCode == 400) && strings.EqualFold(body, "node not found") {
		err.Kind = MapResponseErrorNodeNotFound
	}
	return err
}
