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
]);

const KOINE_SRC = `context Billing {

  value Money {
    amount: Decimal
    currency: Currency
    invariant amount >= 0
      "must not be negative"
  }
  enum Currency { EUR, USD, GBP }
  aggregate Ordering root Order {
    entity Order
      identified by OrderId {
      lines: List<OrderLine>
      total: Money
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
  },
});
export const KOINE_CHARS = charCount(KOINE_LINES);

// ── Emitted output per target (right panel) ─────────────────────────────────
const CS = `public sealed record Money
{
  public Money(
    decimal amount, Currency currency)
  {
    if (amount < 0)
      throw new
        DomainInvariantViolation(
          "must not be negative");
    Amount = amount;
    Currency = currency;
  }
  public decimal Amount { get; }
  public Currency Currency { get; }
}`;

const TS = `export class Money {
  constructor(
    readonly amount: number,
    readonly currency: Currency,
  ) {
    if (amount < 0)
      throw new DomainInvariantViolation(
        "must not be negative");
  }
}`;

const PY = `@dataclass(frozen=True)
class Money:
    amount: Decimal
    currency: "Currency"

    def __post_init__(self) -> None:
        if self.amount < 0:
            raise DomainInvariantViolation(
                "must not be negative")`;

const RS = `pub struct Money {
    amount: Decimal,
    currency: Currency,
}

impl Money {
    pub fn new(
        amount: Decimal,
        currency: Currency,
    ) -> Self {
        assert!(amount >= dec!(0),
            "must not be negative");
        Self { amount, currency }
    }
}`;

const kw = (...w: string[]) => new Set(w);

export interface Target {
  name: string;
  file: string;
  lines: Line[];
}

export const TARGETS: Target[] = [
  {
    name: "C#",
    file: "Money.cs",
    lines: tokenize(CS, {
      keywords: kw("public", "sealed", "record", "class", "decimal", "if",
        "throw", "new", "get", "return", "void", "var", "string", "int", "bool"),
    }),
  },
  {
    name: "TypeScript",
    file: "money.ts",
    lines: tokenize(TS, {
      keywords: kw("export", "class", "constructor", "readonly", "number",
        "string", "if", "throw", "new", "return", "const", "boolean"),
    }),
  },
  {
    name: "Python",
    file: "money.py",
    lines: tokenize(PY, {
      lineComment: "#",
      keywords: kw("class", "def", "if", "raise", "return", "None", "self",
        "import", "from", "True", "False"),
    }),
  },
  {
    name: "Rust",
    file: "money.rs",
    lines: tokenize(RS, {
      lineComment: "//",
      keywords: kw("pub", "struct", "impl", "fn", "let", "self", "Self",
        "assert", "return", "mut", "match"),
    }),
  },
];
