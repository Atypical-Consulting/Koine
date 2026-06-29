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
   * Invoke the command's run() if it is enabled.
   * Guarded no-op (console.warn) for unknown or disabled commands — never throws.
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

  function run(id: string): void {
    const cmd = commands.get(id);
    if (!cmd) {
      console.warn(`[CommandRegistry] Unknown command: "${id}"`);
      return;
    }
    if (!isEnabled(id)) {
      console.warn(`[CommandRegistry] Command "${id}" is currently disabled`);
      return;
    }
    cmd.run();
  }

  return { register, get, all, isEnabled, run };
}
