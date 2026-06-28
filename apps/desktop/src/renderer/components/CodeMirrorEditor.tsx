import { useEffect, useMemo, useState } from "react";
import CodeMirror, { EditorView } from "@uiw/react-codemirror";
import { vscodeDark, vscodeLight } from "@uiw/codemirror-theme-vscode";
import type { Extension } from "@codemirror/state";
import { resolveLanguage } from "../lib/language-detection";

interface CodeMirrorEditorProps {
  value: string;
  fileName: string;
  fontFamily: string;
  fontSize: number;
  onChange: (value: string) => void;
}

const FALLBACK_MONO =
  '"JetBrains Mono", "SFMono-Regular", "SF Mono", Menlo, Consolas, "Liberation Mono", monospace';

// Isolated so the heavy CodeMirror dependency is code-split behind React.lazy
// and only enters the module graph when a file is actually opened.
export default function CodeMirrorEditor({
  value,
  fileName,
  fontFamily,
  fontSize,
  onChange,
}: CodeMirrorEditorProps) {
  const [languageExtensions, setLanguageExtensions] = useState<Extension[]>([]);
  const [languageName, setLanguageName] = useState("Plain Text");
  const [cursor, setCursor] = useState({ line: 1, col: 1 });

  useEffect(() => {
    let cancelled = false;
    void resolveLanguage(fileName).then((resolved) => {
      if (!cancelled) {
        setLanguageExtensions(resolved.extensions);
        setLanguageName(resolved.name);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [fileName]);

  const isDarkTheme =
    typeof document !== "undefined" &&
    document.documentElement.dataset.theme !== "light";

  // Typography + spacing to match the app rather than CodeMirror's bare default.
  const appearance = useMemo(
    () =>
      EditorView.theme({
        "&": { fontSize: `${fontSize}px`, height: "100%" },
        ".cm-scroller": {
          fontFamily: fontFamily || FALLBACK_MONO,
          lineHeight: "1.65",
        },
        ".cm-gutters": { fontFamily: fontFamily || FALLBACK_MONO },
        ".cm-content": { paddingBlock: "10px" },
        ".cm-lineNumbers .cm-gutterElement": { padding: "0 10px 0 16px" },
        ".cm-foldGutter": { paddingRight: "4px" },
      }),
    [fontFamily, fontSize],
  );

  return (
    <div className="flex h-[62vh] flex-col">
      <CodeMirror
        value={value}
        height="100%"
        className="min-h-0 flex-1 overflow-hidden"
        theme={isDarkTheme ? vscodeDark : vscodeLight}
        extensions={[...languageExtensions, appearance]}
        basicSetup={{
          lineNumbers: true,
          highlightActiveLine: true,
          highlightActiveLineGutter: true,
          foldGutter: true,
          bracketMatching: true,
          closeBrackets: true,
          autocompletion: true,
          highlightSelectionMatches: true,
        }}
        onChange={(next) => onChange(next)}
        onUpdate={(viewUpdate) => {
          if (viewUpdate.selectionSet || viewUpdate.docChanged) {
            const pos = viewUpdate.state.selection.main.head;
            const line = viewUpdate.state.doc.lineAt(pos);
            setCursor({ line: line.number, col: pos - line.from + 1 });
          }
        }}
      />
      <div className="flex shrink-0 items-center justify-between border-t border-[var(--border)] bg-[var(--surface-secondary)] px-3 py-[0.25rem] text-[0.7rem] text-[var(--text-soft)]">
        <span>{languageName}</span>
        <span>
          Ln {cursor.line}, Col {cursor.col} · UTF-8
        </span>
      </div>
    </div>
  );
}
