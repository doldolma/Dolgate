import type { TerminalFontFamilyId, TerminalThemeId, TerminalThemePreset } from '@shared';

export interface TerminalThemeDefinition extends TerminalThemePreset {
  description: string;
  preview: {
    background: string;
    foreground: string;
    accent: string;
  };
  theme: {
    background: string;
    foreground: string;
    cursor: string;
    cursorAccent?: string;
    selectionBackground: string;
    selectionForeground?: string;
    black: string;
    red: string;
    green: string;
    yellow: string;
    blue: string;
    magenta: string;
    cyan: string;
    white: string;
    brightBlack: string;
    brightRed: string;
    brightGreen: string;
    brightYellow: string;
    brightBlue: string;
    brightMagenta: string;
    brightCyan: string;
    brightWhite: string;
  };
}

export interface TerminalFontOption {
  id: TerminalFontFamilyId;
  title: string;
  stack: string;
}

export const terminalFontOptions: TerminalFontOption[] = [
  { id: 'sf-mono', title: 'SF Mono', stack: '"SF Mono", "SFMono-Regular", Menlo, Monaco, Consolas, monospace' },
  { id: 'menlo', title: 'Menlo', stack: 'Menlo, Monaco, "SF Mono", Consolas, monospace' },
  { id: 'monaco', title: 'Monaco', stack: 'Monaco, Menlo, "SF Mono", Consolas, monospace' },
  { id: 'consolas', title: 'Consolas', stack: 'Consolas, "Cascadia Mono", Menlo, Monaco, monospace' },
  { id: 'cascadia-mono', title: 'Cascadia Mono', stack: '"Cascadia Mono", Consolas, "SF Mono", monospace' },
  { id: 'jetbrains-mono', title: 'JetBrains Mono', stack: '"JetBrains Mono", "Cascadia Mono", Consolas, monospace' },
  { id: 'fira-code', title: 'Fira Code', stack: '"Fira Code", "JetBrains Mono", Consolas, monospace' },
  { id: 'ibm-plex-mono', title: 'IBM Plex Mono', stack: '"IBM Plex Mono", "SF Mono", Menlo, Consolas, monospace' },
  { id: 'source-code-pro', title: 'Source Code Pro', stack: '"Source Code Pro", "SF Mono", Menlo, Consolas, monospace' }
];

export const terminalThemePresets: TerminalThemeDefinition[] = [
  {
    id: 'dolssh-dark',
    title: 'Dolssh Dark',
    description: '기본 다크',
    preview: { background: '#0b1220', foreground: '#d9e4ee', accent: '#8ed1c2' },
    theme: {
      background: '#0b1220',
      foreground: '#d9e4ee',
      cursor: '#8ed1c2',
      cursorAccent: '#0b1220',
      selectionBackground: 'rgba(142, 209, 194, 0.2)',
      black: '#101826',
      red: '#ef6f6c',
      green: '#8ad7a5',
      yellow: '#e6c384',
      blue: '#7fb4ca',
      magenta: '#c4a7e7',
      cyan: '#7ad5d6',
      white: '#c8d3f5',
      brightBlack: '#556079',
      brightRed: '#ff8f88',
      brightGreen: '#b7f59b',
      brightYellow: '#ffd98c',
      brightBlue: '#95c5ff',
      brightMagenta: '#d7b7ff',
      brightCyan: '#7fe7f1',
      brightWhite: '#f5f7ff'
    }
  },
  {
    id: 'dolssh-light',
    title: 'Dolssh Light',
    description: '기본 라이트',
    preview: { background: '#f5f7fb', foreground: '#243041', accent: '#2468ff' },
    theme: {
      background: '#f5f7fb',
      foreground: '#243041',
      cursor: '#2468ff',
      cursorAccent: '#f5f7fb',
      selectionBackground: 'rgba(36, 104, 255, 0.18)',
      black: '#3b4252',
      red: '#c45557',
      green: '#3d8d6d',
      yellow: '#b57e2f',
      blue: '#4b76d1',
      magenta: '#8a63d2',
      cyan: '#2f8d9f',
      white: '#dfe6f0',
      brightBlack: '#687385',
      brightRed: '#d96a6a',
      brightGreen: '#50a880',
      brightYellow: '#cc9948',
      brightBlue: '#5f8ef0',
      brightMagenta: '#9b78ea',
      brightCyan: '#3fa4b8',
      brightWhite: '#ffffff'
    }
  },
  {
    id: 'kanagawa-wave',
    title: 'Kanagawa Wave',
    description: '깊은 잉크 블루',
    preview: { background: '#1f1f28', foreground: '#dcd7ba', accent: '#7e9cd8' },
    theme: {
      background: '#1f1f28',
      foreground: '#dcd7ba',
      cursor: '#c8c093',
      selectionBackground: 'rgba(124, 153, 213, 0.25)',
      black: '#090618',
      red: '#c34043',
      green: '#76946a',
      yellow: '#c0a36e',
      blue: '#7e9cd8',
      magenta: '#957fb8',
      cyan: '#6a9589',
      white: '#c8c093',
      brightBlack: '#727169',
      brightRed: '#e82424',
      brightGreen: '#98bb6c',
      brightYellow: '#e6c384',
      brightBlue: '#7fb4ca',
      brightMagenta: '#938aa9',
      brightCyan: '#7aa89f',
      brightWhite: '#dcd7ba'
    }
  },
  {
    id: 'kanagawa-dragon',
    title: 'Kanagawa Dragon',
    description: '따뜻한 잿빛',
    preview: { background: '#181616', foreground: '#c5c9c5', accent: '#8ba4b0' },
    theme: {
      background: '#181616',
      foreground: '#c5c9c5',
      cursor: '#c5c9c5',
      selectionBackground: 'rgba(138, 164, 176, 0.2)',
      black: '#0d0c0c',
      red: '#c4746e',
      green: '#8a9a7b',
      yellow: '#c4b28a',
      blue: '#8ba4b0',
      magenta: '#a292a3',
      cyan: '#8ea4a2',
      white: '#c8c093',
      brightBlack: '#625e5a',
      brightRed: '#e46876',
      brightGreen: '#87a987',
      brightYellow: '#e6c384',
      brightBlue: '#7fb4ca',
      brightMagenta: '#938aa9',
      brightCyan: '#7aa89f',
      brightWhite: '#c5c9c5'
    }
  },
  {
    id: 'kanagawa-lotus',
    title: 'Kanagawa Lotus',
    description: '부드러운 종이 톤',
    preview: { background: '#f2ecbc', foreground: '#545464', accent: '#4d699b' },
    theme: {
      background: '#f2ecbc',
      foreground: '#545464',
      cursor: '#4d699b',
      cursorAccent: '#f2ecbc',
      selectionBackground: 'rgba(77, 105, 155, 0.18)',
      black: '#1f1f28',
      red: '#c84053',
      green: '#6f894e',
      yellow: '#77713f',
      blue: '#4d699b',
      magenta: '#b35b79',
      cyan: '#597b75',
      white: '#545464',
      brightBlack: '#716e61',
      brightRed: '#d7474b',
      brightGreen: '#6e915f',
      brightYellow: '#836f4a',
      brightBlue: '#6693bf',
      brightMagenta: '#b35b79',
      brightCyan: '#5e857a',
      brightWhite: '#43436c'
    }
  },
  {
    id: 'everforest-dark',
    title: 'Everforest Dark',
    description: '숲빛 다크',
    preview: { background: '#2d353b', foreground: '#d3c6aa', accent: '#a7c080' },
    theme: {
      background: '#2d353b',
      foreground: '#d3c6aa',
      cursor: '#a7c080',
      selectionBackground: 'rgba(167, 192, 128, 0.2)',
      black: '#343f44',
      red: '#e67e80',
      green: '#a7c080',
      yellow: '#dbbc7f',
      blue: '#7fbbb3',
      magenta: '#d699b6',
      cyan: '#83c092',
      white: '#d3c6aa',
      brightBlack: '#475258',
      brightRed: '#f85552',
      brightGreen: '#8da101',
      brightYellow: '#dfa000',
      brightBlue: '#3a94c5',
      brightMagenta: '#df69ba',
      brightCyan: '#35a77c',
      brightWhite: '#fffbef'
    }
  },
  {
    id: 'everforest-light',
    title: 'Everforest Light',
    description: '숲빛 라이트',
    preview: { background: '#fdf6e3', foreground: '#5c6a72', accent: '#8da101' },
    theme: {
      background: '#fdf6e3',
      foreground: '#5c6a72',
      cursor: '#8da101',
      cursorAccent: '#fdf6e3',
      selectionBackground: 'rgba(141, 161, 1, 0.16)',
      black: '#5c6a72',
      red: '#f85552',
      green: '#8da101',
      yellow: '#dfa000',
      blue: '#3a94c5',
      magenta: '#df69ba',
      cyan: '#35a77c',
      white: '#f3ead3',
      brightBlack: '#7a8478',
      brightRed: '#f57d26',
      brightGreen: '#93b259',
      brightYellow: '#d0af5f',
      brightBlue: '#6c8cbe',
      brightMagenta: '#b67996',
      brightCyan: '#6f9f8f',
      brightWhite: '#fff9e8'
    }
  },
  {
    id: 'night-owl',
    title: 'Night Owl',
    description: '선명한 야간 대비',
    preview: { background: '#011627', foreground: '#d6deeb', accent: '#82aaff' },
    theme: {
      background: '#011627',
      foreground: '#d6deeb',
      cursor: '#80a4c2',
      selectionBackground: 'rgba(130, 170, 255, 0.22)',
      black: '#011627',
      red: '#ef5350',
      green: '#22da6e',
      yellow: '#c5e478',
      blue: '#82aaff',
      magenta: '#c792ea',
      cyan: '#21c7a8',
      white: '#ffffff',
      brightBlack: '#575656',
      brightRed: '#ef5350',
      brightGreen: '#22da6e',
      brightYellow: '#ffeb95',
      brightBlue: '#82aaff',
      brightMagenta: '#c792ea',
      brightCyan: '#7fdbca',
      brightWhite: '#ffffff'
    }
  },
  {
    id: 'light-owl',
    title: 'Light Owl',
    description: '밝은 종이와 선명한 청색',
    preview: { background: '#fbfbfb', foreground: '#403f53', accent: '#2c5dff' },
    theme: {
      background: '#fbfbfb',
      foreground: '#403f53',
      cursor: '#2c5dff',
      cursorAccent: '#fbfbfb',
      selectionBackground: 'rgba(44, 93, 255, 0.14)',
      black: '#403f53',
      red: '#de3d3b',
      green: '#08916a',
      yellow: '#c96900',
      blue: '#2c5dff',
      magenta: '#a44185',
      cyan: '#0c969b',
      white: '#fbfbfb',
      brightBlack: '#989fb1',
      brightRed: '#de3d3b',
      brightGreen: '#08916a',
      brightYellow: '#c96900',
      brightBlue: '#2c5dff',
      brightMagenta: '#a44185',
      brightCyan: '#0c969b',
      brightWhite: '#ffffff'
    }
  },
  {
    id: 'rose-pine',
    title: 'Rosé Pine',
    description: '은은한 로즈 톤',
    preview: { background: '#191724', foreground: '#e0def4', accent: '#c4a7e7' },
    theme: {
      background: '#191724',
      foreground: '#e0def4',
      cursor: '#ebbcba',
      selectionBackground: 'rgba(196, 167, 231, 0.22)',
      black: '#26233a',
      red: '#eb6f92',
      green: '#31748f',
      yellow: '#f6c177',
      blue: '#9ccfd8',
      magenta: '#c4a7e7',
      cyan: '#ebbcba',
      white: '#e0def4',
      brightBlack: '#6e6a86',
      brightRed: '#eb6f92',
      brightGreen: '#31748f',
      brightYellow: '#f6c177',
      brightBlue: '#9ccfd8',
      brightMagenta: '#c4a7e7',
      brightCyan: '#ebbcba',
      brightWhite: '#ffffff'
    }
  },
  {
    id: 'hacker-green',
    title: 'Hacker Green',
    description: '형광 녹색 콘솔',
    preview: { background: '#041607', foreground: '#57ff6a', accent: '#1be24d' },
    theme: {
      background: '#041607',
      foreground: '#57ff6a',
      cursor: '#57ff6a',
      selectionBackground: 'rgba(27, 226, 77, 0.2)',
      black: '#031104',
      red: '#1be24d',
      green: '#57ff6a',
      yellow: '#8eff93',
      blue: '#39f169',
      magenta: '#3af18f',
      cyan: '#75ffb5',
      white: '#d7ffe1',
      brightBlack: '#2b5f35',
      brightRed: '#31ff65',
      brightGreen: '#75ff8c',
      brightYellow: '#b8ff84',
      brightBlue: '#74ff9a',
      brightMagenta: '#7effbd',
      brightCyan: '#acffd3',
      brightWhite: '#f2fff5'
    }
  },
  {
    id: 'hacker-blue',
    title: 'Hacker Blue',
    description: '냉한 청색 콘솔',
    preview: { background: '#07101f', foreground: '#55c7ff', accent: '#20a4ff' },
    theme: {
      background: '#07101f',
      foreground: '#55c7ff',
      cursor: '#55c7ff',
      selectionBackground: 'rgba(32, 164, 255, 0.2)',
      black: '#06101a',
      red: '#1d8dff',
      green: '#3fb8ff',
      yellow: '#76d0ff',
      blue: '#20a4ff',
      magenta: '#2c8bff',
      cyan: '#7ad7ff',
      white: '#d8f4ff',
      brightBlack: '#31506d',
      brightRed: '#39a0ff',
      brightGreen: '#5cc5ff',
      brightYellow: '#9ae4ff',
      brightBlue: '#62bcff',
      brightMagenta: '#76b7ff',
      brightCyan: '#a8ecff',
      brightWhite: '#f5fcff'
    }
  },
  {
    id: 'hacker-red',
    title: 'Hacker Red',
    description: '강한 적색 콘솔',
    preview: { background: '#180607', foreground: '#ff7272', accent: '#ff3b3b' },
    theme: {
      background: '#180607',
      foreground: '#ff7272',
      cursor: '#ff7272',
      selectionBackground: 'rgba(255, 59, 59, 0.2)',
      black: '#140304',
      red: '#ff3b3b',
      green: '#ff6a6a',
      yellow: '#ff9b7a',
      blue: '#ff5c5c',
      magenta: '#ff8383',
      cyan: '#ffaaaa',
      white: '#ffe1e1',
      brightBlack: '#6e3131',
      brightRed: '#ff5757',
      brightGreen: '#ff8686',
      brightYellow: '#ffc17a',
      brightBlue: '#ff8b8b',
      brightMagenta: '#ffadad',
      brightCyan: '#ffd0d0',
      brightWhite: '#fff5f5'
    }
  }
];

export function getTerminalThemePreset(themeId: TerminalThemeId | null | undefined): TerminalThemeDefinition {
  return terminalThemePresets.find((preset) => preset.id === themeId) ?? terminalThemePresets[0];
}

export function getTerminalFontOption(fontId: TerminalFontFamilyId | null | undefined): TerminalFontOption {
  return terminalFontOptions.find((option) => option.id === fontId) ?? terminalFontOptions[0];
}
