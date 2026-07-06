/* ============================================================================
   Koine Launcher — a Spotlight/Alfred-class command bar for the Koine Studio.
   Vanilla JS. Owns: the domain catalog, fuzzy ranking, prefix modes, grouped
   results, live preview pane, per-result quick actions + ⌘K action menu,
   full keyboard nav, and the host Tweaks protocol.
   ========================================================================== */
(function () {
  "use strict";

  /* ----------------------------------------------------------------------- */
  /* DDD kind metadata — chip code + token color                             */
  /* ----------------------------------------------------------------------- */
  const KIND = {
    aggregate:  { code: "AR", color: "--koi-ddd-aggregate", word: "aggregate root" },
    entity:     { code: "EN", color: "--koi-ddd-entity",    word: "entity" },
    value:      { code: "VO", color: "--koi-ddd-value",     word: "value object" },
    enum:       { code: "EM", color: "--koi-ddd-enum",      word: "enum" },
    service:    { code: "SV", color: "--koi-ddd-service",   word: "domain service" },
    repository: { code: "RP", color: "--koi-ddd-repository",word: "repository" },
    command:    { code: "CM", color: "--koi-ddd-command",   word: "command" },
    query:      { code: "QY", color: "--koi-ddd-query",     word: "query" },
    event:      { code: "EV", color: "--koi-ddd-event",     word: "domain event" },
    integration:{ code: "IE", color: "--koi-ddd-integration-event", word: "integration event" },
  };

  /* ----------------------------------------------------------------------- */
  /* Line icons (utility rows)                                               */
  /* ----------------------------------------------------------------------- */
  const I = {
    action: '<path d="M4.5 4 8 7.5 4.5 11M8.5 11.5h4"/>',
    file:   '<path d="M4 2.4h4.5l3 3v8H4z"/><path d="M8.5 2.4v3h3"/>',
    gloss:  '<path d="M4 3.2h6a1.4 1.4 0 0 1 1.4 1.4v8.2M4 3.2A1.2 1.2 0 0 0 2.8 4.4v8.4A1.2 1.2 0 0 0 4 14h7.4"/><path d="M5.4 6h4M5.4 8.2h4"/>',
    rule:   '<path d="M8 2.2 3.2 4v3.4c0 3 2 5 4.8 6.4 2.8-1.4 4.8-3.4 4.8-6.4V4z"/>',
    state:  '<circle cx="4" cy="8" r="1.7"/><circle cx="12" cy="8" r="1.7"/><path d="M5.7 8h4.6M8.6 6.3 10.3 8 8.6 9.7"/>',
    commit: '<circle cx="8" cy="8" r="2.4"/><path d="M8 2v3.6M8 10.4V14"/>',
    search: '<circle cx="7" cy="7" r="4.2"/><path d="M10.2 10.2 14 14"/>',
    open:   '<path d="M2 8s2.5-4 6-4 6 4 6 4-2.5 4-6 4-6-4-6-4Z"/><circle cx="8" cy="8" r="1.8"/>',
    goto:   '<path d="M3 8h8M8 5l3 3-3 3"/>',
    ref:    '<circle cx="8" cy="8" r="2"/><path d="M8 2v2M8 12v2M2 8h2M12 8h2"/>',
    copy:   '<rect x="5" y="5" width="8" height="8" rx="1.4"/><path d="M3 10.5V4a1 1 0 0 1 1-1h6.5"/>',
    rename: '<path d="M9.5 3.5 12.5 6.5 6 13H3v-3z"/>',
    peek:   '<rect x="2.5" y="3.5" width="11" height="9" rx="1.4"/><path d="M2.5 6.5h11"/>',
    run:    '<path d="M5 3.5 12 8l-7 4.5z"/>',
    docs:   '<path d="M8 4.2C6.8 3.2 5 3.2 3.5 3.6v8c1.5-.4 3.3-.4 4.5.6 1.2-1 3-1 4.5-.6v-8C11 3.2 9.2 3.2 8 4.2Z"/><path d="M8 4.2v8"/>',
    diff:   '<path d="M4 3.5v6M4 12.5v.01M4 9.5a1.5 1.5 0 0 0 1.5 1.5h3M12 12.5v-6M12 3.5v.01"/>',
    bolt:   '<path d="M8.5 2 4 9h3.2L7 14l4.5-7H8.3z"/>',
  };
  const ic = (p) => '<svg class="lx-ic" viewBox="0 0 16 16">' + p + "</svg>";

  /* ----------------------------------------------------------------------- */
  /* Prefix modes                                                            */
  /* ----------------------------------------------------------------------- */
  const MODES = {
    all: { key: "all", prefix: "", label: "All", hint: "everything" },
    ">": { key: ">", prefix: ">", label: "Commands", hint: "run a command", cats: ["action"] },
    "@": { key: "@", prefix: "@", label: "Symbols", hint: "go to a domain symbol", cats: ["symbol"] },
    "#": { key: "#", prefix: "#", label: "Events", hint: "find an event", cats: ["event"] },
    "/": { key: "/", prefix: "/", label: "Files", hint: "open a file", cats: ["file"] },
    ":": { key: ":", prefix: ":", label: "Glossary", hint: "look up a term", cats: ["glossary"] },
  };
  const PREFIX_CHARS = [">", "@", "#", "/", ":"];

  /* Group order + labels for the results list */
  const GROUPS = [
    ["action",   "Commands"],
    ["symbol",   "Domain symbols"],
    ["event",    "Events"],
    ["rule",     "Rules & states"],
    ["file",     "Files"],
    ["glossary", "Glossary"],
    ["commit",   "Recent commits"],
  ];

  /* ----------------------------------------------------------------------- */
  /* Small helpers for building preview HTML                                 */
  /* ----------------------------------------------------------------------- */
  const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
  const kv = (label, val) => `<div class="pv-k">${label}</div><div class="pv-v">${val}</div>`;
  const chipHTML = (kind) => {
    const k = KIND[kind];
    return `<span class="lx-kind" style="--kc:var(${k.color})">${k.code}</span>`;
  };

  /* ----------------------------------------------------------------------- */
  /* The catalog                                                             */
  /* ----------------------------------------------------------------------- */
  const DATA = [];
  let uid = 0;
  const add = (o) => { o.id = "e" + uid++; DATA.push(o); return o; };

  // ---- domain symbols ----
  add({ cat: "symbol", kind: "aggregate", title: "Order", sub: "aggregate root", ctx: "Ordering",
    file: "src/domain/ordering.koi", keywords: "order sales root",
    preview: () => symbolPreview({
      kind: "aggregate", name: "Order", ctx: "Ordering", file: "ordering.koi · line 15",
      code: [
        ['<span class="k">entity</span> <span class="t">Order</span> <span class="k">identified by</span> <span class="t">OrderId</span> <span class="pu">{</span>'],
        ['  <span class="pr">lines</span><span class="pu">:</span>  <span class="t">List</span><span class="pu">&lt;</span><span class="t">OrderLine</span><span class="pu">&gt;</span>'],
        ['  <span class="pr">status</span><span class="pu">:</span> <span class="t">OrderStatus</span> <span class="op">=</span> <span class="t">Draft</span>'],
        ['  <span class="pr">total</span><span class="pu">:</span>  <span class="t">Money</span> <span class="op">=</span> <span class="k">sum</span> <span class="pr">lines.subtotal</span>'],
        ['<span class="pu">}</span>'],
      ],
      rows: [ ["Kind", "aggregate root"], ["Context", "Ordering"], ["Members", "3 fields · 1 list"],
        ["Emits", '<span class="pv-pill" style="--kc:var(--koi-ddd-event)">OrderPlaced</span> <span class="pv-pill" style="--kc:var(--koi-ddd-event)">OrderShipped</span>'],
        ["Invariants", "2"], ["Used by", "Billing · Shipping"] ],
      states: ["Draft", "Placed", "Shipped", "Cancelled"],
    }) });

  add({ cat: "symbol", kind: "value", title: "OrderLine", sub: "value object", ctx: "Ordering",
    file: "src/domain/ordering.koi", keywords: "line item quantity price subtotal",
    preview: () => symbolPreview({
      kind: "value", name: "OrderLine", ctx: "Ordering", file: "ordering.koi · line 5",
      code: [
        ['<span class="k">value</span> <span class="t">OrderLine</span> <span class="pu">{</span>'],
        ['  <span class="pr">product</span><span class="pu">:</span>   <span class="t">ProductId</span>'],
        ['  <span class="pr">quantity</span><span class="pu">:</span>  <span class="t">Int</span>'],
        ['  <span class="pr">unitPrice</span><span class="pu">:</span> <span class="t">Money</span>'],
        ['  <span class="pr">subtotal</span><span class="pu">:</span>  <span class="t">Money</span> <span class="op">=</span> <span class="pr">unitPrice</span> <span class="op">*</span> <span class="pr">quantity</span>'],
        ['<span class="pu">}</span>'],
      ],
      rows: [ ["Kind", "value object"], ["Context", "Ordering"], ["Immutable", "yes"],
        ["Invariants", '<span class="pv-code">quantity &gt; 0</span>, <span class="pv-code">unitPrice ≥ 0</span>'],
        ["Used by", "Order"] ],
    }) });

  add({ cat: "symbol", kind: "enum", title: "OrderStatus", sub: "enum · 4 members", ctx: "Ordering",
    file: "src/domain/ordering.koi", keywords: "status draft placed shipped cancelled state",
    preview: () => symbolPreview({
      kind: "enum", name: "OrderStatus", ctx: "Ordering", file: "ordering.koi · line 3",
      code: [
        ['<span class="k">enum</span> <span class="t">OrderStatus</span> <span class="pu">{</span>'],
        ['  <span class="t">Draft</span><span class="pu">,</span> <span class="t">Placed</span><span class="pu">,</span> <span class="t">Shipped</span><span class="pu">,</span> <span class="t">Cancelled</span>'],
        ['<span class="pu">}</span>'],
      ],
      rows: [ ["Kind", "enum"], ["Members", "Draft · Placed · Shipped · Cancelled"],
        ["Drives", "Order.status state machine"], ["Default", "Draft"] ],
      states: ["Draft", "Placed", "Shipped", "Cancelled"],
    }) });

  add({ cat: "symbol", kind: "value", title: "OrderId", sub: "identity", ctx: "Ordering",
    file: "src/domain/ordering.koi", keywords: "id identity key" });
  add({ cat: "symbol", kind: "value", title: "ProductId", sub: "identity", ctx: "Catalog",
    file: "src/domain/catalog.koi", keywords: "id product sku" });
  add({ cat: "symbol", kind: "value", title: "Money", sub: "value object", ctx: "Shared kernel",
    file: "src/shared/money.koi", keywords: "amount currency price decimal",
    preview: () => symbolPreview({
      kind: "value", name: "Money", ctx: "Shared kernel", file: "money.koi · line 1",
      code: [
        ['<span class="k">value</span> <span class="t">Money</span> <span class="pu">{</span>'],
        ['  <span class="pr">amount</span><span class="pu">:</span>   <span class="t">Decimal</span>'],
        ['  <span class="pr">currency</span><span class="pu">:</span> <span class="t">Currency</span> <span class="op">=</span> <span class="t">EUR</span>'],
        ['<span class="pu">}</span>'],
      ],
      rows: [ ["Kind", "value object"], ["Shared by", "Ordering · Billing"], ["Immutable", "yes"] ],
    }) });
  add({ cat: "symbol", kind: "aggregate", title: "Customer", sub: "aggregate root", ctx: "Customers",
    file: "src/domain/customers.koi", keywords: "customer buyer account" });
  add({ cat: "symbol", kind: "aggregate", title: "Payment", sub: "aggregate root", ctx: "Billing",
    file: "src/domain/billing.koi", keywords: "payment charge capture money" });
  add({ cat: "symbol", kind: "entity", title: "Invoice", sub: "entity", ctx: "Billing",
    file: "src/domain/billing.koi", keywords: "invoice bill receipt" });
  add({ cat: "symbol", kind: "service", title: "PricingService", sub: "domain service", ctx: "Ordering",
    file: "src/domain/pricing.koi", keywords: "pricing discount calculate total service" });
  add({ cat: "symbol", kind: "repository", title: "OrderRepository", sub: "repository", ctx: "Ordering",
    file: "src/domain/ordering.koi", keywords: "repository persistence load save" });
  add({ cat: "symbol", kind: "command", title: "PlaceOrder", sub: "command", ctx: "Ordering",
    file: "src/domain/ordering.koi", keywords: "place submit order command",
    preview: () => symbolPreview({
      kind: "command", name: "PlaceOrder", ctx: "Ordering", file: "ordering.koi · line 31",
      code: [
        ['<span class="k">command</span> <span class="t">PlaceOrder</span> <span class="pu">{</span>'],
        ['  <span class="pr">order</span><span class="pu">:</span>    <span class="t">OrderId</span>'],
        ['  <span class="pr">customer</span><span class="pu">:</span> <span class="t">CustomerId</span>'],
        ['<span class="pu">}</span> <span class="op">→</span> <span class="t">OrderPlaced</span>'],
      ],
      rows: [ ["Kind", "command"], ["Handled by", "Order"], ["Guards", '<span class="pv-code">status = Draft</span>'],
        ["Emits", '<span class="pv-pill" style="--kc:var(--koi-ddd-event)">OrderPlaced</span>'] ],
    }) });
  add({ cat: "symbol", kind: "command", title: "CancelOrder", sub: "command", ctx: "Ordering",
    file: "src/domain/ordering.koi", keywords: "cancel void order command" });
  add({ cat: "symbol", kind: "query", title: "OpenOrdersByCustomer", sub: "query", ctx: "Ordering",
    file: "src/read/orders.koi", keywords: "query read open orders customer projection" });

  // ---- events ----
  add({ cat: "event", kind: "event", title: "OrderPlaced", sub: "domain event", ctx: "Ordering",
    file: "src/domain/ordering.koi", keywords: "order placed event submitted",
    preview: () => eventPreview({
      kind: "event", name: "OrderPlaced", ctx: "Ordering",
      fields: [["orderId", "OrderId"], ["customerId", "CustomerId"], ["total", "Money"], ["placedAt", "Instant"]],
      raisedBy: "Order · PlaceOrder", consumers: ["Billing", "Shipping", "Notifications"],
    }) });
  add({ cat: "event", kind: "event", title: "OrderShipped", sub: "domain event", ctx: "Ordering",
    file: "src/domain/ordering.koi", keywords: "order shipped event dispatch",
    preview: () => eventPreview({
      kind: "event", name: "OrderShipped", ctx: "Ordering",
      fields: [["orderId", "OrderId"], ["trackingNo", "String"], ["shippedAt", "Instant"]],
      raisedBy: "Order · ShipOrder", consumers: ["Notifications"],
    }) });
  add({ cat: "event", kind: "event", title: "OrderCancelled", sub: "domain event", ctx: "Ordering",
    file: "src/domain/ordering.koi", keywords: "order cancelled event void" });
  add({ cat: "event", kind: "integration", title: "PaymentCaptured", sub: "integration event", ctx: "Billing",
    file: "src/domain/billing.koi", keywords: "payment captured integration cross context",
    preview: () => eventPreview({
      kind: "integration", name: "PaymentCaptured", ctx: "Billing → Ordering",
      fields: [["orderId", "OrderId"], ["amount", "Money"], ["capturedAt", "Instant"]],
      raisedBy: "Payment · CapturePayment", consumers: ["Ordering", "Ledger"],
      note: "Crosses the Billing → Ordering context boundary via the published-language contract.",
    }) });
  add({ cat: "event", kind: "event", title: "InvoiceIssued", sub: "domain event", ctx: "Billing",
    file: "src/domain/billing.koi", keywords: "invoice issued event bill" });

  // ---- studio commands / actions ----
  const action = (title, sub, kbd, keywords, preview) =>
    add({ cat: "action", title, sub, kbd, keywords, preview });
  action("Generate", "Compile the model → C#", "⌘↵", "generate build compile emit run",
    () => actionPreview("Generate", "Compiles the active model and emits target sources. Runs invariants and scenario checks first; stops on any error.", "⌘↵", "5 files · Ordering, Billing, Shipping"));
  action("Change emit target…", "C#, TypeScript, Python, PHP, Rust", null, "emit target language output c# typescript python",
    () => actionPreview("Change emit target", "Pick the destination language the generator emits. The model is language-agnostic; only the codegen backend changes.", null, "current: C#"));
  action("Format document", "Re-flow the active .koi file", "⇧⌥F", "format prettify indent tidy",
    () => actionPreview("Format document", "Normalises spacing, alignment and member ordering in the active file per the Koine style rules.", "⇧⌥F", "ordering.koi"));
  action("Toggle theme", "Switch dark / light", null, "theme dark light appearance color",
    () => actionPreview("Toggle theme", "Flip between the dark and light Studio themes. Every color token re-resolves; no reload needed.", null, "current: Dark"));
  action("Open Settings", "Workspace & editor preferences", "⌘,", "settings preferences config options",
    () => actionPreview("Open Settings", "Opens the workspace settings page — emit targets, formatting, glossary rules, generation hooks.", "⌘,", null));
  action("New bounded context…", "Scaffold a new context module", null, "new context bounded module create scaffold",
    () => actionPreview("New bounded context", "Creates a new context with its own ubiquitous language, folder and manifest entry.", null, null));
  action("Commit staged changes", "Commit to main", "⌘↵", "commit git save source control vcs",
    () => actionPreview("Commit staged changes", "Commits everything currently staged in Source Control to the active branch.", "⌘↵", "1 staged · branch main"));
  action("Show relationships graph", "Open the model relationship view", null, "relationships graph diagram map dependencies",
    () => actionPreview("Show relationships graph", "Opens the interactive graph of aggregates, events and context boundaries.", null, null));
  action("Run scenario tests", "Execute the .koi scenarios", "⌘R", "test scenario run check verify",
    () => actionPreview("Run scenario tests", "Runs every scenario block against the model and reports pass / fail inline.", "⌘R", "12 scenarios"));

  // ---- files ----
  const fileEntry = (name, dir, lang, meta, preview) =>
    add({ cat: "file", title: name, sub: dir, ctx: dir, lang, meta, keywords: (name + " " + dir).toLowerCase(), preview });
  fileEntry("ordering.koi", "src/domain", "Koine", "+4 −1",
    () => filePreview("src/domain/ordering.koi", "Koine · 27 lines", true));
  fileEntry("billing.koi", "src/domain", "Koine", null,
    () => filePreview("src/domain/billing.koi", "Koine · 41 lines", false));
  fileEntry("shipping.koi", "src/domain", "Koine", null,
    () => filePreview("src/domain/shipping.koi", "Koine · 18 lines", false));
  fileEntry("money.koi", "src/shared", "Koine", null,
    () => filePreview("src/shared/money.koi", "Koine · 6 lines", false));
  fileEntry("ubiquitous.koi", "src", "Koine", null,
    () => filePreview("src/ubiquitous.koi", "Koine · 12 lines", false));
  fileEntry("glossary.md", "docs", "Markdown", null,
    () => filePreview("docs/glossary.md", "Markdown · 88 lines", false));
  fileEntry("koine.config.json", "", "JSON", null,
    () => filePreview("koine.config.json", "JSON · 34 lines", false));

  // ---- glossary ----
  const term = (word, def, see) => add({ cat: "glossary", title: word, sub: "glossary term", ctx: "Ubiquitous language",
    keywords: word.toLowerCase(), preview: () => glossPreview(word, def, see) });
  term("Aggregate", "A cluster of domain objects — an entity root plus its owned values and entities — treated as one consistency boundary. Nothing outside may hold a reference to its internals; every change goes through the root.", ["Order", "Payment", "Customer"]);
  term("Ubiquitous Language", "The shared, rigorous vocabulary agreed by domain experts and engineers, used verbatim in the model, the code and the conversation. Koine enforces it: names in .koi are the glossary.", ["Glossary", "Bounded Context"]);
  term("Invariant", "A rule that must always hold for an aggregate to be valid. Koine checks invariants at every state transition and refuses to emit code that could violate them.", ["OrderLine", "Order"]);
  term("Bounded Context", "An explicit boundary within which a model and its language are consistent. Ordering, Billing and Shipping are separate contexts with their own meaning of “Order”.", ["Ordering", "Billing"]);
  term("Value Object", "An immutable type defined only by its attributes, with no identity of its own. Two values with equal attributes are interchangeable — like Money or OrderLine.", ["Money", "OrderLine"]);
  term("Domain Event", "A record that something meaningful happened in the domain, named in the past tense. Events are the seams between aggregates and between contexts.", ["OrderPlaced", "PaymentCaptured"]);

  // ---- rules & states ----
  const rule = (title, sub, ctx, kind, preview) => add({ cat: "rule", title, sub, ctx, rkind: kind, keywords: title.toLowerCase(), preview });
  rule("quantity > 0", "invariant · OrderLine", "Ordering", "rule",
    () => rulePreview("invariant", "quantity &gt; 0", '"Quantity must be at least one"', "OrderLine", "Checked on every write to an OrderLine and before Order is placed."));
  rule("unitPrice ≥ 0", "invariant · OrderLine", "Ordering", "rule",
    () => rulePreview("invariant", "unitPrice ≥ 0", '"Unit price cannot be negative"', "OrderLine", "Checked on construction and re-pricing."));
  rule("Draft → Placed", "transition · Order", "Ordering", "state",
    () => transitionPreview("Draft", "Placed", "Order", "Triggered by PlaceOrder. Guard: order has at least one line."));
  rule("Placed → Shipped", "transition · Order", "Ordering", "state",
    () => transitionPreview("Placed", "Shipped", "Order", "Triggered by ShipOrder. Guard: payment captured."));
  rule("Placed → Cancelled", "transition · Order", "Ordering", "state",
    () => transitionPreview("Placed", "Cancelled", "Order", "Triggered by CancelOrder. Emits OrderCancelled."));

  // ---- commits ----
  const commit = (hash, msg, who, when, files) => add({ cat: "commit", title: msg, sub: hash + " · " + when, ctx: who,
    hash, keywords: (msg + " " + hash).toLowerCase(), preview: () => commitPreview(hash, msg, who, when, files) });
  commit("c9344ef", "add OrderLine invariants", "Philippe Matray", "2h ago",
    [["M", "src/domain/ordering.koi", "+4 −1"]]);
  commit("9147d2b", "initial commit", "Philippe Matray", "5h ago",
    [["A", "src/domain/ordering.koi", "+26"], ["A", "koine.config.json", "+34"]]);

  /* ----------------------------------------------------------------------- */
  /* Preview builders                                                        */
  /* ----------------------------------------------------------------------- */
  function pvHead(kind, name, sub, isDomain) {
    const badge = isDomain ? chipHTML(kind) : ic(I[kind] || I.file);
    return `<div class="pv-head">${isDomain ? badge : `<span class="lx-glyph">${badge}</span>`}
      <div class="pv-title"><div class="pv-name">${esc(name)}</div><div class="pv-sub">${sub}</div></div></div>`;
  }
  function codeBlock(lines) {
    return `<pre class="pv-code-block"><code>${lines.map((l) => l[0]).join("\n")}</code></pre>`;
  }
  function metaGrid(rows) {
    return `<div class="pv-grid">${rows.map(([k, v]) => kv(k, v)).join("")}</div>`;
  }
  function statesLine(states) {
    return `<div class="pv-section">State machine</div><div class="pv-states">${
      states.map((s, i) => `<span class="pv-state">${s}</span>${i < states.length - 1 ? '<span class="pv-arrow">→</span>' : ""}`).join("")
    }</div>`;
  }
  function symbolPreview(o) {
    return pvHead(o.kind, o.name, `${KIND[o.kind].word} · ${o.ctx}`, true)
      + `<div class="pv-file">${ic(I.file)}${o.file}</div>`
      + codeBlock(o.code)
      + metaGrid(o.rows)
      + (o.states ? statesLine(o.states) : "");
  }
  function eventPreview(o) {
    return pvHead(o.kind, o.name, `${KIND[o.kind].word} · ${o.ctx}`, true)
      + `<div class="pv-section">Payload</div>`
      + `<div class="pv-fields">${o.fields.map(([n, t]) => `<div class="pv-field"><span class="pr">${n}</span><span class="pf-t">${t}</span></div>`).join("")}</div>`
      + metaGrid([["Raised by", o.raisedBy], ["Consumed by", o.consumers.map((c) => `<span class="pv-pill">${c}</span>`).join(" ")]])
      + (o.note ? `<div class="pv-note">${ic(I.ref)}${o.note}</div>` : "");
  }
  function actionPreview(name, desc, kbd, meta) {
    return pvHead("action", name, "command", false)
      + `<div class="pv-desc">${desc}</div>`
      + metaGrid([].concat(kbd ? [["Shortcut", `<span class="pv-kbd">${kbd}</span>`]] : [], meta ? [["Scope", meta]] : []))
      + `<div class="pv-run">${ic(I.run)}Press <span class="pv-kbd">↵</span> to run</div>`;
  }
  function filePreview(path, meta, isDiff) {
    const diff = [
      ['ctx', '      <span class="pr">subtotal</span><span class="pu">:</span>  <span class="t">Money</span>'],
      ['add', '      <span class="k">invariant</span> <span class="pr">quantity</span> <span class="op">&gt;</span> <span class="n">0</span>'],
      ['add', '      <span class="k">invariant</span> <span class="pr">unitPrice</span> <span class="op">≥</span> <span class="n">0</span>'],
      ['add', '      <span class="k">invariant</span> <span class="pr">subtotal</span> <span class="op">=</span> <span class="pr">unitPrice</span> <span class="op">*</span> <span class="pr">quantity</span>'],
      ['del', '      <span class="c">// TODO: add guards</span>'],
      ['ctx', '    <span class="pu">}</span>'],
    ];
    const plain = [
      ['ctx', '<span class="k">context</span> <span class="t">Billing</span> <span class="pu">{</span>'],
      ['ctx', '  <span class="k">aggregate</span> <span class="k">root</span> <span class="t">Payment</span> <span class="pu">{</span>'],
      ['ctx', '    <span class="pr">amount</span><span class="pu">:</span> <span class="t">Money</span>'],
      ['ctx', '    <span class="pr">status</span><span class="pu">:</span> <span class="t">PaymentStatus</span>'],
      ['ctx', '  <span class="pu">}</span>'],
      ['ctx', '<span class="pu">}</span>'],
    ];
    const rows = isDiff ? diff : plain;
    return pvHead("file", path.split("/").pop(), path, false)
      + `<div class="pv-file">${ic(isDiff ? I.diff : I.file)}${meta}${isDiff ? '  ·  <span class="pv-diffn"><span class="add">+4</span> <span class="del">−1</span></span>' : ""}</div>`
      + `<pre class="pv-code-block ${isDiff ? "pv-diff" : ""}"><code>${rows.map(([m, l]) => `<span class="dl dl-${m}">${l}</span>`).join("\n")}</code></pre>`;
  }
  function glossPreview(word, def, see) {
    return pvHead("gloss", word, "ubiquitous language", false)
      + `<div class="pv-desc">${def}</div>`
      + `<div class="pv-section">Appears in</div>`
      + `<div class="pv-pills">${see.map((s) => `<span class="pv-pill">${s}</span>`).join("")}</div>`;
  }
  function rulePreview(kind, expr, msg, where, note) {
    return pvHead("rule", where, kind, false)
      + `<pre class="pv-code-block"><code><span class="k">${kind}</span> ${expr} <span class="s">${msg}</span></code></pre>`
      + metaGrid([["Enforced on", where], ["Message", `<span class="s">${msg}</span>`]])
      + `<div class="pv-note">${ic(I.rule)}${note}</div>`;
  }
  function transitionPreview(from, to, where, note) {
    return pvHead("state", from + " → " + to, "state transition · " + where, false)
      + `<div class="pv-states big"><span class="pv-state on">${from}</span><span class="pv-arrow">→</span><span class="pv-state on">${to}</span></div>`
      + metaGrid([["Aggregate", where], ["Kind", "state transition"]])
      + `<div class="pv-note">${ic(I.state)}${note}</div>`;
  }
  function commitPreview(hash, msg, who, when, files) {
    const initials = who.split(" ").map((w) => w[0]).join("").slice(0, 2);
    return pvHead("commit", msg, "commit", false)
      + metaGrid([["Commit", `<span class="pv-code">${hash}</span>`], ["Author", `<span class="pv-av">${initials}</span> ${who}`], ["When", when]])
      + `<div class="pv-section">Files changed</div>`
      + `<div class="pv-files">${files.map(([s, p, n]) => `<div class="pv-frow"><span class="sc-glyph ${s === "M" ? "modified" : s === "A" ? "added" : "deleted"}">${s}</span><span class="pv-fpath">${p}</span><span class="pv-fn">${n}</span></div>`).join("")}</div>`;
  }

  /* ----------------------------------------------------------------------- */
  /* Per-result quick actions                                                */
  /* ----------------------------------------------------------------------- */
  function actionsFor(e) {
    switch (e.cat) {
      case "symbol": return [["Go to definition", "↵", I.goto], ["Find usages", "⇧↵", I.ref], ["Peek", "⌥↵", I.peek], ["Rename symbol", "F2", I.rename], ["Copy name", "⌘C", I.copy]];
      case "event": return [["Go to definition", "↵", I.goto], ["Show producers & consumers", "⇧↵", I.ref], ["Trace flow", "⌥↵", I.state]];
      case "action": return [["Run", "↵", I.run]];
      case "file": return [["Open", "↵", I.file], ["Open changes", "⇧↵", I.diff], ["Reveal in Explorer", "⌥↵", I.peek], ["Copy path", "⌘C", I.copy]];
      case "glossary": return [["Open glossary", "↵", I.gloss], ["Find in model", "⇧↵", I.search]];
      case "rule": return [["Go to rule", "↵", I.goto], ["Peek", "⌥↵", I.peek]];
      case "commit": return [["View commit", "↵", I.commit], ["Copy hash", "⌘C", I.copy], ["Revert", "⇧⌫", I.diff]];
      default: return [["Open", "↵", I.open]];
    }
  }

  /* ----------------------------------------------------------------------- */
  /* Fuzzy scoring — subsequence with boundary / consecutive bonuses         */
  /* ----------------------------------------------------------------------- */
  function fuzzy(q, text) {
    if (!q) return { score: 0, ranges: [] };
    const t = text.toLowerCase(), s = q.toLowerCase();
    let ti = 0, prev = -2, score = 0;
    const ranges = [];
    for (let si = 0; si < s.length; si++) {
      const ch = s[si];
      let found = -1;
      for (let k = ti; k < t.length; k++) { if (t[k] === ch) { found = k; break; } }
      if (found === -1) return null;
      let bonus = 1;
      if (found === prev + 1) bonus += 3;                                   // consecutive
      if (found === 0 || /[^a-z0-9]/i.test(t[found - 1])) bonus += 4;       // word boundary
      if (/[A-Z]/.test(text[found]) && found > 0) bonus += 3;               // camelCase hump
      score += bonus;
      ranges.push(found);
      prev = found; ti = found + 1;
    }
    score -= (t.length - s.length) * 0.15;                                  // prefer tight matches
    if (t.startsWith(s)) score += 12;
    return { score, ranges };
  }
  function highlight(text, ranges) {
    if (!ranges || !ranges.length) return esc(text);
    let out = "", set = new Set(ranges);
    for (let i = 0; i < text.length; i++) {
      const c = esc(text[i]);
      out += set.has(i) ? `<mark>${c}</mark>` : c;
    }
    return out;
  }

  /* Rank the catalog for a query within an optional category filter set */
  function rank(query, cats) {
    const pool = cats ? DATA.filter((e) => cats.includes(e.cat)) : DATA;
    if (!query) return pool.map((e) => ({ e, score: 0, ranges: [] }));
    const out = [];
    for (const e of pool) {
      const primary = fuzzy(query, e.title);
      if (primary) { out.push({ e, score: primary.score, ranges: primary.ranges }); continue; }
      // secondary: keywords / context (no title highlight)
      const hay = (e.keywords || "") + " " + (e.ctx || "") + " " + (e.sub || "");
      const sec = fuzzy(query, hay);
      if (sec) out.push({ e, score: sec.score * 0.4 - 2, ranges: [] });
    }
    out.sort((a, b) => b.score - a.score || a.e.title.length - b.e.title.length);
    return out;
  }

  /* Curated default set when the query is empty */
  const DEFAULT_IDS = ["e0", "e1", "e14", "e26", "e33", "e19"]; // Order, OrderLine, OrderPlaced, Generate, ordering.koi, PlaceOrder(≈)
  function defaultResults() {
    const pick = (id) => DATA.find((e) => e.id === id);
    const hits = ["Order", "OrderLine", "OrderStatus", "OrderPlaced"].map((t) => DATA.find((e) => e.title === t));
    const recent = [DATA.find((e) => e.title === "Generate"), DATA.find((e) => e.title === "ordering.koi"), DATA.find((e) => e.title === "OrderPlaced"), DATA.find((e) => e.title === "quantity > 0")];
    return { hits: hits.filter(Boolean), recent: recent.filter(Boolean) };
  }

  /* Expose */
  window.KoineLauncher = {
    DATA, MODES, PREFIX_CHARS, GROUPS, KIND, I, ic,
    rank, fuzzy, highlight, actionsFor, defaultResults,
    chipHTML,
    catGlyph(e) {
      if (e.cat === "symbol" || e.cat === "event") return chipHTML(e.kind);
      const map = { action: I.action, file: I.file, glossary: I.gloss, commit: I.commit };
      let path = map[e.cat] || I.open;
      if (e.cat === "rule") path = e.rkind === "state" ? I.state : I.rule;
      return `<span class="lx-glyph">${ic(path)}</span>`;
    },
  };
})();
