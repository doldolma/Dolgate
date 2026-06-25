// Bundled monospace fonts, so the terminal and the font picker render them
// regardless of what's installed on the user's system (otherwise uninstalled
// fonts silently fall back to the OS default monospace). Latin subset, regular
// + bold only — CJK and other scripts fall back to system fonts via the preset
// stacks in `lib/terminal-presets.ts`. The @font-face family names below must
// match the first family in each preset stack:
//   match each preset stack's first family in `lib/terminal-presets.ts`.
// SF Mono / Menlo / Monaco (macOS) and Consolas (Windows) stay system-provided.
import '@fontsource/fira-code/latin-400.css';
import '@fontsource/fira-code/latin-700.css';
import '@fontsource/jetbrains-mono/latin-400.css';
import '@fontsource/jetbrains-mono/latin-700.css';
import '@fontsource/ibm-plex-mono/latin-400.css';
import '@fontsource/ibm-plex-mono/latin-700.css';
import '@fontsource/source-code-pro/latin-400.css';
import '@fontsource/source-code-pro/latin-700.css';
import '@fontsource/cascadia-mono/latin-400.css';
import '@fontsource/cascadia-mono/latin-700.css';
import '@fontsource/cascadia-code/latin-400.css';
import '@fontsource/cascadia-code/latin-700.css';
import '@fontsource/geist-mono/latin-400.css';
import '@fontsource/geist-mono/latin-700.css';
import '@fontsource/roboto-mono/latin-400.css';
import '@fontsource/roboto-mono/latin-700.css';
import '@fontsource/ubuntu-mono/latin-400.css';
import '@fontsource/ubuntu-mono/latin-700.css';
import '@fontsource/space-mono/latin-400.css';
import '@fontsource/space-mono/latin-700.css';
import '@fontsource/inconsolata/latin-400.css';
import '@fontsource/inconsolata/latin-700.css';
import '@fontsource/victor-mono/latin-400.css';
import '@fontsource/victor-mono/latin-700.css';
