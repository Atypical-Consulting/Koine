// Declarative command registry for Koine Studio.
//
// DOM-free and host-agnostic: no EditorView, no Tauri APIs, no document/window.
// This module is the single source of truth (SSOT) for the Command interface and
// the runtime registry that the palette, toolbar, and keymap will read from.

// ---------------------------------------------------------------------------
// Command interface (SSOT — palette.ts re-exports from here)
// ---------------------------------------------------------------------------

export interface Command {
  /** Stable, unique command identifier. */
  id: string;
  /** Human-readable label shown in the palette. */
  title: string;
  /** The effect to invoke when the command runs. */
  run(): void;
  /** Optional keyboard-chord hint displayed alongside the title. */
  hint?: string;
  /** Optional palette grouping label. */
  group?: string;
  /** Optional alias of group for future categorical grouping. */
  category?: string;
  /**
   * Optional enablement predicate. When absent the command is always enabled.
   * Evaluated on every isEnabled() / run() call (dynamic).
   */
  when?(): boolean;
  /**
   * Optional activatability predicate — a second, independent axis from `when()`.
   * When absent the command is always activatable. Use this to gate a command on
   * something like an in-flight workspace op without hiding it from the palette
   * entirely: `when()` controls visibility, `enabled()` controls whether it can
   * currently be invoked. A command visible-but-not-activatable renders as a
   * greyed-out row instead of vanishing. Evaluated on every isActivatable() / run()
   * call (dynamic).
   */
  enabled?(): boolean;
}

// ---------------------------------------------------------------------------
// Registry interface
// ---------------------------------------------------------------------------

export interface CommandRegistry {
  /**
   * Register a command. Returns a disposer that removes it from the registry.
   * Throws if a command with the same id is already registered.
   */
  register(cmd: Command): () => void;

  /** Look up a command by id. Returns undefined if not found. */
  get(id: string): Command | undefined;

  /**
   * Return all registered commands in registration order.
   * UNFILTERED: includes commands whose when() predicate currently returns false.
   */
  all(): Command[];

  /**
   * Evaluate whether the command is currently enabled.
   * Returns `when() ?? true` for a known command; false for an unknown id.
   */
  isEnabled(id: string): boolean;

  /**
   * Evaluate whether the command is currently activatable, i.e. can be run.
   * True iff isEnabled(id) (the when() visibility check) AND `enabled() ?? true`
   * (the new activatability check). False for an unknown id. A command can be
   * isEnabled (visible) but not activatable — the palette renders that as a
   * visible-but-disabled row instead of hiding it.
   */
  isActivatable(id: string): boolean;

  /**
   * Invoke the command's run() if it is activatable.
   * Guarded no-op (console.warn) for unknown or non-activatable commands — never throws.
   */
  run(id: string): void;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createCommandRegistry(): CommandRegistry {
  // Preserves insertion order (ES2015+).
  const commands = new Map<string, Command>();

  function register(cmd: Command): () => void {
    if (commands.has(cmd.id)) {
      throw new Error(`[CommandRegistry] Duplicate command id: "${cmd.id}"`);
    }
    commands.set(cmd.id, cmd);
    return () => {
      commands.delete(cmd.id);
    };
  }

  function get(id: string): Command | undefined {
    return commands.get(id);
  }

  function all(): Command[] {
    return Array.from(commands.values());
  }

  function isEnabled(id: string): boolean {
    const cmd = commands.get(id);
    if (!cmd) return false;
    return cmd.when ? cmd.when() : true;
  }

  function isActivatable(id: string): boolean {
    const cmd = commands.get(id);
    if (!cmd) return false;
    if (!isEnabled(id)) return false;
    return cmd.enabled ? cmd.enabled() : true;
  }

  function run(id: string): void {
    const cmd = commands.get(id);
    if (!cmd) {
      console.warn(`[CommandRegistry] Unknown command: "${id}"`);
      return;
    }
    if (!isActivatable(id)) {
      console.warn(`[CommandRegistry] Command "${id}" is currently disabled`);
      return;
    }
    cmd.run();
  }

  return { register, get, all, isEnabled, isActivatable, run };
}
