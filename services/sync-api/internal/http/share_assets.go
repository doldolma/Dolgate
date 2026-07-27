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
	// T 는 서버가 그리는 마크업용, TextJSON 은 viewer.js 가 런타임에 읽는 같은 문구 집합이다.
	T        viewerText
	TextJSON string
}

const shareAssetVersion = "20260727-session-share-i18n-v1"

func mustShareAssetFS() fs.FS {
	assetFS, err := fs.Sub(shareAssets, "share_assets")
	if err != nil {
		panic(err)
	}
	return assetFS
}

var shareViewerTemplate = template.Must(template.ParseFS(shareAssets, "share_assets/viewer.html"))
