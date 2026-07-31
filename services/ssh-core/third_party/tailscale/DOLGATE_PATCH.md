# Dolgate Tailscale patch

This directory is based on `tailscale.com v1.102.0` and is selected by the
`replace` directives in `services/ssh-core/go.mod` and `services/sync-api/go.mod`.

Dolgate needs to distinguish an unavailable control connection from a node
identity that was deleted in the control plane. Upstream v1.102.0 returns
`400 node not found` from `/machine/map`, but `ipnlocal.LocalBackend` only logs
that error. The local patch:

- wraps non-200 map responses in `controlclient.MapResponseError`;
- classifies the exact `400 node not found` response;
- carries it through `ipn.Notify.ControlError`; and
- retains it for newly attached IPN bus watchers until a map request succeeds.

Keep the response match narrow. Generic HTTP, DNS, timeout, and map polling
errors must remain transient and must never trigger automatic re-registration.
