// Slim, static subset of a Fig autocomplete spec (withfig/autocomplete, MIT).
// Only the parts that can be matched client-side without running the shell are
// kept. Dynamic `generators` are mostly dropped during conversion; the one
// exception is a plain string `script` generator (no token interpolation),
// which we can run verbatim on the host's auxiliary channel.
// See scripts/generate-command-specs.cjs.

export interface CommandSpec {
  name: string;
  description?: string;
  subcommands?: CommandSpec[];
  options?: OptionSpec[];
  args?: ArgSpec[];
}

export interface OptionSpec {
  /** All spellings of the flag, e.g. ['-m', '--message']. */
  names: string[];
  description?: string;
  /** Whether the flag takes a value (informational; used for display). */
  takesArg?: boolean;
  /** Value(s) the flag accepts — used for path/generator completion. */
  args?: ArgSpec[];
}

export interface ArgSpec {
  name?: string;
  optional?: boolean;
  /** Whether this arg repeats (e.g. `cat file1 file2 …`). Non-variadic args are
   * completed once; the matcher must not keep offering them for later tokens. */
  variadic?: boolean;
  /** Fig arg template: drives file/folder completion via the aux channel. */
  template?: 'filepaths' | 'folders';
  /**
   * This arg carries a runnable Fig generator (script/custom). The generator
   * itself lives in the bundled JS spec module (generated/command-spec-modules);
   * this flag lets the matcher prefer dynamic value completion over the path
   * heuristic without loading that module. See scripts/generate-command-specs.cjs.
   */
  hasGenerator?: boolean;
}
