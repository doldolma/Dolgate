//go:build tools

package mobile

// gomobile bind generates a Go file that imports golang.org/x/mobile/bind and
// compiles it against this module, so the module has to require x/mobile even
// though no shipping source file imports it. Without a reference somewhere,
// `go mod tidy` drops the requirement and the next bind fails to resolve it.
// The tools build tag keeps this out of every real build while still counting
// as an import for tidy, which loads all build configurations.
import _ "golang.org/x/mobile/bind"
