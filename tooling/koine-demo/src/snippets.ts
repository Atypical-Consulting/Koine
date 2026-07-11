import { P } from "./palette";

export type Span = { text: string; color: string };
export type Line = Span[];

interface LangCfg {
  keywords: Set<string>;
  lineComment?: string;
  // koine only: an identifier immediately following one of these keywords is a
  // *declared concept name* and gets the concept color (value=blue, enum=amber, …).
  concept?: Record<string, string>;
}

const TOKEN =
  /(\s+)|("(?:[^"\\]|\\.)*"?)|([A-Za-z_][A-Za-z0-9_]*)|(\d+(?:\.\d+)?)|([^\sA-Za-z0-9_]+)/g;

export function tokenize(code: string, cfg: LangCfg): Line[] {
  return code.split("\n").map((raw) => {
    const spans: Span[] = [];
    let prevWord: string | null = null;
    let m: RegExpExecArray | null;
    TOKEN.lastIndex = 0;
    while ((m = TOKEN.exec(raw)) !== null) {
      const [full, ws, str, ident, num, punct] = m;
      if (ws) {
        spans.push({ text: ws, color: P.punct });
        continue;
      }
      if (cfg.lineComment && full.startsWith(cfg.lineComment)) {
        spans.push({ text: raw.slice(m.index), color: P.comment });
        break;
      }
      if (str) {
        spans.push({ text: str, color: P.string });
        prevWord = null;
        continue;
      }
      if (num) {
        spans.push({ text: num, color: P.number });
        prevWord = null;
        continue;
      }
      if (ident) {
        let color: string = P.text;
        if (cfg.keywords.has(ident)) color = P.keyword;
        else if (/^[A-Z]/.test(ident)) color = P.type;
        if (cfg.concept && prevWord && cfg.concept[prevWord])
          color = cfg.concept[prevWord];
        spans.push({ text: ident, color });
        prevWord = ident;
        continue;
      }
      spans.push({ text: punct ?? full, color: P.punct });
      prevWord = null;
    }
    return spans;
  });
}

export function charCount(lines: Line[]): number {
  return lines.reduce(
    (n, line) => n + line.reduce((k, s) => k + s.text.length, 0),
    0,
  );
}

// ── The .koi model (left panel) ────────────────────────────────────────────
const KOINE_KEYWORDS = new Set([
  "context", "value", "entity", "aggregate", "root", "identified", "by",
  "invariant", "enum", "command", "event", "service", "usecase", "policy",
  "repository", "readmodel", "query", "import", "module", "when", "matches",
  "requires", "emit",
]);

// EXACTLY the source that produces the numbers below. Verified with the real
// CLI: `koine build ordering.koi --target csharp` → 11 files, 365 lines.
// If you edit this, re-run the compile and update KOI_LINE_COUNT + GEN_FILES.
const KOINE_SRC = `context Ordering {

  value Money {
    amount: Decimal
    invariant amount >= 0  "must not be negative"
  }

  enum OrderStatus { Draft, Placed }

  aggregate Sales root Order {

    event OrderPlaced { orderId: OrderId }

    entity Order identified by OrderId {
      total:  Money
      status: OrderStatus = Draft

      command place {
        requires status == Draft  "already placed"
        status -> Placed
        emit OrderPlaced(orderId: id)
      }
    }
  }
}`;

export const KOINE_LINES = tokenize(KOINE_SRC, {
  keywords: KOINE_KEYWORDS,
  concept: {
    value: P.value,
    enum: P.enumC,
    aggregate: P.aggregate,
    entity: P.entity,
    event: P.eventC,
    command: P.commandC,
  },
});
export const KOINE_CHARS = charCount(KOINE_LINES);
export const KOI_LINE_COUNT = KOINE_SRC.split("\n").length; // 25

// ── The generated files (right wall) ────────────────────────────────────────
// One entry per file the compiler actually wrote, in stamping order. `loc` is
// the file's real line count; `peek` lines are verbatim lines from the emitted
// C# (leading indentation trimmed). `src` is the 1-based line range of the
// .koi construct that produces the file, used for the highlight sweep.

const CS_KW = new Set([
  "public", "sealed", "class", "record", "interface", "readonly", "static",
  "new", "void", "if", "throw", "get", "init", "set", "private", "protected",
  "override", "abstract", "string", "int", "decimal", "bool", "using",
  "namespace", "return", "yield",
]);

const cs = (code: string) => tokenize(code, { keywords: CS_KW });

export interface GenFile {
  file: string;
  dir: string;
  loc: number;
  accent: string;
  peek?: Line[];
  src?: [number, number];
  runtime?: boolean;
}

export const GEN_FILES: GenFile[] = [
  {
    file: "Money.cs",
    dir: "Ordering/ValueObjects",
    loc: 32,
    accent: P.value,
    src: [3, 6],
    peek: cs(
      `public sealed class Money : ValueObject
if (amount < 0)
throw new DomainInvariantViolationException(`,
    ),
  },
  {
    file: "OrderStatus.cs",
    dir: "Ordering/Enums",
    loc: 81,
    accent: P.enumC,
    src: [8, 8],
    peek: cs(
      `public static readonly OrderStatus Draft = new("Draft", 0);
public static OrderStatus FromName(string name)
public static IReadOnlyList<OrderStatus> All { get; }`,
    ),
  },
  {
    file: "OrderPlaced.cs",
    dir: "Ordering/Events",
    loc: 18,
    accent: P.eventC,
    src: [12, 12],
    peek: cs(
      `public sealed record OrderPlaced : IDomainEvent
public DateTimeOffset OccurredOn { get; init; }
public OrderPlaced(OrderId orderId)`,
    ),
  },
  {
    file: "OrderId.cs",
    dir: "Ordering/ValueObjects",
    loc: 25,
    accent: P.value,
    src: [14, 14],
    peek: cs(
      `public sealed class OrderId : ValueObject
public Guid Value { get; }
public static OrderId New()`,
    ),
  },
  {
    file: "Order.cs",
    dir: "Ordering",
    loc: 58,
    accent: P.entity,
    src: [14, 23],
    peek: cs(
      `public void Place()
Status = OrderStatus.Placed;
_domainEvents.Add(new OrderPlaced(Id));`,
    ),
  },
  {
    file: "IOrderRepository.cs",
    dir: "Ordering/Repositories",
    loc: 19,
    accent: P.aggregate,
    src: [10, 10],
    peek: cs(
      `public interface IOrderRepository
Task<Order?> GetByIdAsync(OrderId id, CancellationToken ct = default);
Task AddAsync(Order aggregate, CancellationToken ct = default);`,
    ),
  },
  {
    file: "IUnitOfWork.cs",
    dir: "Ordering/Abstractions",
    loc: 15,
    accent: P.aggregate,
    src: [10, 10],
    peek: cs(
      `public interface IUnitOfWork
IOrderRepository Orders { get; }
Task<int> SaveChangesAsync(CancellationToken ct = default);`,
    ),
  },
  { file: "ValueObject.cs", dir: "Koine/Runtime", loc: 82, accent: P.brandLite, runtime: true },
  {
    file: "DomainInvariantViolationException.cs",
    dir: "Koine/Runtime",
    loc: 16,
    accent: P.brandLite,
    runtime: true,
  },
  { file: "IDomainEvent.cs", dir: "Koine/Runtime", loc: 12, accent: P.brandLite, runtime: true },
  { file: "IAggregateRoot.cs", dir: "Koine/Runtime", loc: 7, accent: P.brandLite, runtime: true },
];

export const TOTAL_FILES = GEN_FILES.length; // 11
export const TOTAL_LOC = GEN_FILES.reduce((n, f) => n + f.loc, 0); // 365

// ── Outro chips: every ship-ready emitter target ────────────────────────────
export const LANG_CHIPS: { name: string; accent: string }[] = [
  { name: "C#", accent: "#8a63ff" },
  { name: "TypeScript", accent: "#3aa0ff" },
  { name: "Python", accent: "#f0b429" },
  { name: "Java", accent: "#f89820" },
  { name: "Kotlin", accent: "#c792ea" },
  { name: "PHP", accent: "#8993be" },
  { name: "Rust", accent: "#ff7043" },
];
