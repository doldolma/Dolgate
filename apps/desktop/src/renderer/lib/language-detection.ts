import { languages } from "@codemirror/language-data";
import type { Extension } from "@codemirror/state";

export interface ResolvedLanguage {
  extensions: Extension[];
  name: string;
}

function extensionOf(fileName: string): string {
  const lower = fileName.toLowerCase();
  const dot = lower.lastIndexOf(".");
  return dot >= 0 ? lower.slice(dot + 1) : "";
}

// Lazily resolve a CodeMirror language for the given filename, along with a
// human label for the status bar. Falls back to plain text when nothing matches
// so the editor always renders.
export async function resolveLanguage(fileName: string): Promise<ResolvedLanguage> {
  const ext = extensionOf(fileName);
  const description =
    languages.find((language) => language.extensions.includes(ext)) ??
    languages.find((language) => language.filename?.test(fileName) ?? false);
  if (!description) {
    return { extensions: [], name: "Plain Text" };
  }
  try {
    const support = await description.load();
    return { extensions: [support], name: description.name };
  } catch {
    return { extensions: [], name: "Plain Text" };
  }
}
