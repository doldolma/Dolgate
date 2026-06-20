// Extension denylist used ONLY to hide the in-app editor affordance for
// obviously non-text files. It is a UX hint, not an authority — the ssh-core
// ReadFile handler performs the definitive NUL-byte/size check and rejects
// anything unsuitable, which the editor store treats as a silent no-op.
const BINARY_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "gif", "bmp", "webp", "ico", "tif", "tiff", "heic",
  "mp3", "wav", "flac", "ogg", "oga", "m4a", "aac", "opus",
  "mp4", "mkv", "mov", "avi", "webm", "wmv", "flv", "m4v",
  "zip", "tar", "gz", "tgz", "bz2", "xz", "zst", "7z", "rar", "jar", "war",
  "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "ods", "odp",
  "exe", "dll", "so", "dylib", "bin", "o", "obj", "a", "lib", "class", "wasm",
  "ttf", "otf", "woff", "woff2", "eot",
  "db", "sqlite", "sqlite3", "mdb", "dat", "img", "iso", "dmg", "pkg", "deb", "rpm",
  "psd", "ai", "sketch", "blend", "key", "numbers", "pages",
]);

export function hasBinaryExtension(name: string): boolean {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) {
    return false;
  }
  return BINARY_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
}

export interface EditableCandidate {
  isDirectory: boolean;
  size: number;
  name: string;
}

// Cheap, listing-based pre-gate for whether to offer in-app editing.
export function isEditableEntry(
  entry: EditableCandidate,
  maxBytes: number,
): boolean {
  if (entry.isDirectory) {
    return false;
  }
  if (entry.size > maxBytes) {
    return false;
  }
  if (hasBinaryExtension(entry.name)) {
    return false;
  }
  return true;
}
