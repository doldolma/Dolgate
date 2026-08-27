# Screenshot originals

Untouched `screencapture` output at Retina @2x — the source for the images used in
`README.md` / `README.ko.md` (`../*.png`) and on the landing page (`../../../web/assets/*.webp`).
Keep these when re-cutting an asset at a different size; the delivered files are already
downscaled and cannot be scaled back up.

`command-blocks` and `autocomplete` are region captures, not whole windows — do not upscale them.

Two assets are not a straight resize of their original:

```bash
# rdp-multimonitor — drop the letterbox between the title bar and the remote screens
ffmpeg -i rdp-multimonitor.png -filter_complex \
  "[0:v]crop=3024:91:0:0[bar];[0:v]crop=3024:1038:0:472[screen];[bar][screen]vstack=inputs=2[v]" \
  -map "[v]" stitched.png

# rdp-monitor-picker — crop to the dialog
ffmpeg -i rdp-monitor-picker.png -vf "crop=1440:1380:720:210" cropped.png
```

The delivered files come from these:

```bash
# landing (web/assets) — 1600px WebP
cwebp -q 88 -sharp_yuv -metadata none -resize 1600 0 in.png -o out.webp

# README (docs/images) — 1400px palettised PNG, since GitHub does not list WebP as supported
ffmpeg -i in.png -vf \
  "scale=1400:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=256:stats_mode=full[p];[b][p]paletteuse=dither=sierra2_4a" \
  -compression_level 9 out.png
```

Both skip the resize when the original is already narrower than the target.
