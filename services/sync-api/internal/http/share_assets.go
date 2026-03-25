package http

import (
	"embed"
	"html/template"
	"io/fs"
)

//go:embed share_assets
var shareAssets embed.FS

type viewerPageData struct {
	ShareID      string
	ViewerToken  string
	AssetVersion string
}

const shareAssetVersion = "20260325-viewer-fit-v1"

func mustShareAssetFS() fs.FS {
	assetFS, err := fs.Sub(shareAssets, "share_assets")
	if err != nil {
		panic(err)
	}
	return assetFS
}

var shareViewerTemplate = template.Must(template.ParseFS(shareAssets, "share_assets/viewer.html"))
