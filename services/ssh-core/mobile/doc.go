// Package mobile is the in-process SSH engine surface for the iOS/Android
// apps, exposed to them through gomobile bind.
//
// The desktop app talks to ssh-core as a subprocess over the stdio protocol in
// internal/protocol, and its session managers push events outward
// (internal/sshsession, internal/sftp). Mobile cannot spawn a subprocess, and
// pushing every terminal chunk across the React Native bridge is too expensive,
// so this package keeps a different shape: an in-process library whose terminal
// output lands in a byte-budgeted ring buffer that the app pulls from by cursor.
//
// What it does not re-implement is the connection itself. internal/sshconn is
// plain library code with no protocol or emitter coupling, so dialing, the jump
// chain, host key policy, auth precedence, certificates and key handling are
// reused from there rather than written twice.
//
// The exported surface in bind.go is shaped by gomobile's type restrictions
// rather than by what would be natural in Go; see the notes there before
// changing it.
package mobile
