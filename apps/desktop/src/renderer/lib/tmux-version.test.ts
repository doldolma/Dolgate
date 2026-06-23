import { describe, expect, it } from 'vitest';
import {
  parseTmuxVersion,
  tmuxAtLeast,
  supportsTmuxControlMode,
} from './tmux-version';

describe('parseTmuxVersion', () => {
  it('parses major.minor and ignores letter suffix', () => {
    expect(parseTmuxVersion('3.0a')).toEqual({ major: 3, minor: 0, known: true });
    expect(parseTmuxVersion('2.6')).toEqual({ major: 2, minor: 6, known: true });
    expect(parseTmuxVersion('3.5a')).toEqual({ major: 3, minor: 5, known: true });
    expect(parseTmuxVersion('tmux 2.6')).toEqual({ major: 2, minor: 6, known: true });
    expect(parseTmuxVersion('3')).toEqual({ major: 3, minor: 0, known: true });
  });

  it('returns known=false for unparseable input', () => {
    expect(parseTmuxVersion('')).toEqual({ major: 0, minor: 0, known: false });
    expect(parseTmuxVersion(undefined)).toEqual({ major: 0, minor: 0, known: false });
    expect(parseTmuxVersion('next-3.4')).toEqual({ major: 0, minor: 0, known: false });
  });
});

describe('tmuxAtLeast', () => {
  it('compares major.minor', () => {
    expect(tmuxAtLeast('2.6', 2, 6)).toBe(true);
    expect(tmuxAtLeast('2.6', 2, 9)).toBe(false);
    expect(tmuxAtLeast('3.0a', 2, 9)).toBe(true);
    expect(tmuxAtLeast('2.8', 3, 0)).toBe(false);
  });

  it('treats unknown version as latest (true)', () => {
    expect(tmuxAtLeast('', 3, 1)).toBe(true);
    expect(tmuxAtLeast(undefined, 2, 6)).toBe(true);
  });
});

describe('supportsTmuxControlMode', () => {
  it('gates control mode at floor 2.6', () => {
    expect(supportsTmuxControlMode('2.6')).toBe(true);
    expect(supportsTmuxControlMode('3.0a')).toBe(true);
    expect(supportsTmuxControlMode('2.5')).toBe(false);
    expect(supportsTmuxControlMode('1.8')).toBe(false);
  });

  it('assumes control mode when version unknown', () => {
    expect(supportsTmuxControlMode('')).toBe(true);
    expect(supportsTmuxControlMode(undefined)).toBe(true);
  });
});
