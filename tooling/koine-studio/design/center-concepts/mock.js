/* Shared mock content + helpers for the center-view concept POCs.
   Exposes a global `KoineMock`. Classic script (works on file://). */
(function () {
  'use strict';

  // --- inline icons (stroke, 24-grid) -------------------------------------
  const ICONS = {
    canvas: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="6" cy="6" r="2.4"/><circle cx="18" cy="8" r="2.4"/><circle cx="9" cy="18" r="2.4"/><path d="M8 6.6 15.6 7.5M7.6 15.9 8.4 8.4M11.2 17 16 9.8"/></svg>',
    code: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M8 7 3 12l5 5M16 7l5 5-5 5M14 4l-4 16"/></svg>',
    output: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9l3 3-3 3M13.5 15H17"/></svg>',
    docs: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><path d="M5 4h10a2 2 0 0 1 2 2v14H7a2 2 0 0 1-2-2z"/><path d="M9 8h5M9 12h5"/></svg>',
    split: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M12 4v16"/></svg>',
    overview: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="3" y="3" width="8" height="8" rx="1.5"/><rect x="13" y="3" width="8" height="8" rx="1.5"/><rect x="3" y="13" width="8" height="8" rx="1.5"/><rect x="13" y="13" width="8" height="8" rx="1.5"/></svg>',
    close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>',
    plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
    spark: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l1.6 5.4L19 9l-5.4 1.6L12 16l-1.6-5.4L5 9l5.4-1.6z"/></svg>',
    chevron: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 9l6 6 6-6"/></svg>'
  };

  // --- surface registry (the four center views) ---------------------------
  const SURFACES = [
    { id: 'canvas', label: 'Canvas', tag: 'Domain diagram',   icon: ICONS.canvas, accent: 'var(--st-aggregate)', subs: ['Diagram'] },
    { id: 'code',   label: 'Code',   tag: 'ubiquitous.koi',   icon: ICONS.code,   accent: 'var(--koi-hl-keyword)', subs: ['Editor', 'Scenarios'] },
    { id: 'output', label: 'Output', tag: 'Compiler artifacts',icon: ICONS.output, accent: 'var(--st-event)', subs: ['Generated', 'Compatibility', 'Context Map'], dot: 'err' },
    { id: 'docs',   label: 'Docs',   tag: 'Glossary & ADRs',   icon: ICONS.docs,   accent: 'var(--st-entity)', subs: ['Glossary', 'ADRs', 'Notes'] }
  ];

  // --- canvas nodes + edges ----------------------------------------------
  const NODES = [
    { id: 'order',  stereo: 'aggregate', name: 'Order',      x: 0.40, y: 0.10, members: ['id: OrderId', 'lines: List', 'total: Money'] },
    { id: 'line',   stereo: 'entity',    name: 'OrderLine',  x: 0.10, y: 0.46, members: ['pizza: Pizza', 'qty: Quantity'] },
    { id: 'money',  stereo: 'value',     name: 'Money',      x: 0.40, y: 0.74, members: ['amount: decimal', 'currency: Currency'] },
    { id: 'pizza',  stereo: 'entity',    name: 'Pizza',      x: 0.70, y: 0.46, members: ['size: Size', 'toppings: List'] },
    { id: 'placed', stereo: 'event',     name: 'OrderPlaced',x: 0.71, y: 0.10, members: ['orderId: OrderId'] }
  ];
  const EDGES = [['order', 'line'], ['order', 'money'], ['line', 'pizza'], ['order', 'placed']];

  function canvasHTML() {
    let html = '<div class="k-canvas" data-canvas><svg class="kc-edges"></svg>';
    for (const n of NODES) {
      html += '<div class="kc-node" data-node="' + n.id + '" data-stereo="' + n.stereo + '"'
        + ' style="left:' + (n.x * 100) + '%;top:' + (n.y * 100) + '%">'
        + '<div class="kc-stereo">«' + n.stereo + '»</div>'
        + '<div class="kc-name">' + n.name + '</div>'
        + '<div class="kc-members">' + n.members.join('<br>') + '</div></div>';
    }
    html += '</div>';
    return html;
  }

  function drawEdges(canvasEl) {
    const svg = canvasEl.querySelector('.kc-edges');
    if (!svg) return;
    const box = canvasEl.getBoundingClientRect();
    const center = (id) => {
      const el = canvasEl.querySelector('[data-node="' + id + '"]');
      const r = el.getBoundingClientRect();
      return { x: r.left - box.left + r.width / 2, y: r.top - box.top + r.height / 2 };
    };
    let s = '';
    for (const [a, b] of EDGES) {
      const p = center(a), q = center(b);
      s += '<line x1="' + p.x + '" y1="' + p.y + '" x2="' + q.x + '" y2="' + q.y + '"/>';
    }
    svg.innerHTML = s;
  }

  function mountCanvas(canvasEl) {
    const redraw = () => drawEdges(canvasEl);
    requestAnimationFrame(redraw);
    if (window.ResizeObserver) new ResizeObserver(redraw).observe(canvasEl);
    // tiny drag affordance
    canvasEl.querySelectorAll('.kc-node').forEach((node) => {
      node.addEventListener('pointerdown', (e) => {
        const startX = e.clientX, startY = e.clientY;
        const ox = node.offsetLeft, oy = node.offsetTop;
        node.setPointerCapture(e.pointerId);
        node.style.cursor = 'grabbing';
        const move = (ev) => {
          node.style.left = (ox + ev.clientX - startX) + 'px';
          node.style.top = (oy + ev.clientY - startY) + 'px';
          redraw();
        };
        const up = () => { node.style.cursor = 'grab'; node.removeEventListener('pointermove', move); node.removeEventListener('pointerup', up); };
        node.addEventListener('pointermove', move);
        node.addEventListener('pointerup', up);
      });
    });
  }

  // --- code / output / docs content --------------------------------------
  function codeHTML() {
    const L = [
      ['<span class="tk-kw">context</span> <span class="tk-ty">Ordering</span> <span class="tk-pn">{</span>'],
      ['  <span class="tk-cm">// the price of a single line</span>'],
      ['  <span class="tk-kw">value</span> <span class="tk-ty">Money</span> <span class="tk-pn">{</span>'],
      ['    amount<span class="tk-pn">:</span> <span class="tk-ty">decimal</span>'],
      ['    currency<span class="tk-pn">:</span> <span class="tk-ty">Currency</span>'],
      ['    <span class="tk-kw">invariant</span> amount <span class="tk-pn">&gt;=</span> <span class="tk-num">0</span>'],
      ['  <span class="tk-pn">}</span>'],
      [''],
      ['  <span class="tk-kw">aggregate</span> <span class="tk-ty">Order</span> <span class="tk-pn">{</span>'],
      ['    id<span class="tk-pn">:</span> <span class="tk-ty">OrderId</span>'],
      ['    lines<span class="tk-pn">:</span> <span class="tk-ty">List</span><span class="tk-pn">&lt;</span><span class="tk-ty">OrderLine</span><span class="tk-pn">&gt;</span>'],
      ['    total<span class="tk-pn">:</span> <span class="tk-ty">Money</span>'],
      [''],
      ['    <span class="tk-kw">command</span> <span class="tk-ty">Place</span><span class="tk-pn">()</span>'],
      ['    <span class="tk-kw">event</span> <span class="tk-ty">OrderPlaced</span><span class="tk-pn">(</span>orderId<span class="tk-pn">:</span> <span class="tk-ty">OrderId</span><span class="tk-pn">)</span>'],
      ['  <span class="tk-pn">}</span>'],
      ['<span class="tk-pn">}</span>']
    ];
    let h = '<div class="k-code koi-scroll">';
    L.forEach((l, i) => { h += '<div class="ln"><span class="gut">' + (i + 1) + '</span><code>' + l[0] + '</code></div>'; });
    return h + '</div>';
  }

  function outputHTML() {
    const src =
      '<span class="tk-kw">public sealed partial record</span> <span class="tk-ty">Money</span>\n'
      + '<span class="tk-pn">{</span>\n'
      + '    <span class="tk-kw">public</span> <span class="tk-ty">decimal</span> Amount <span class="tk-pn">{ get; }</span>\n'
      + '    <span class="tk-kw">public</span> <span class="tk-ty">Currency</span> Currency <span class="tk-pn">{ get; }</span>\n\n'
      + '    <span class="tk-kw">private</span> <span class="tk-ty">Money</span><span class="tk-pn">(</span><span class="tk-ty">decimal</span> amount, <span class="tk-ty">Currency</span> currency<span class="tk-pn">)</span>\n'
      + '        <span class="tk-pn">=></span> <span class="tk-pn">(</span>Amount, Currency<span class="tk-pn">)</span> = <span class="tk-pn">(</span>amount, currency<span class="tk-pn">)</span>;\n\n'
      + '    <span class="tk-kw">public static</span> <span class="tk-ty">Result</span><span class="tk-pn">&lt;</span><span class="tk-ty">Money</span><span class="tk-pn">&gt;</span> <span class="tk-ty">Create</span><span class="tk-pn">(</span><span class="tk-ty">decimal</span> amount, <span class="tk-ty">Currency</span> currency<span class="tk-pn">)</span>\n'
      + '        <span class="tk-pn">=></span> amount <span class="tk-pn">&lt;</span> <span class="tk-num">0</span>\n'
      + '            ? <span class="tk-ty">Result</span>.Fail<span class="tk-pn">&lt;</span><span class="tk-ty">Money</span><span class="tk-pn">&gt;</span><span class="tk-pn">(</span><span class="tk-str">"amount must be &gt;= 0"</span><span class="tk-pn">)</span>\n'
      + '            : <span class="tk-ty">Result</span>.Ok<span class="tk-pn">(</span><span class="tk-kw">new</span> <span class="tk-ty">Money</span><span class="tk-pn">(</span>amount, currency<span class="tk-pn">))</span>;\n'
      + '<span class="tk-pn">}</span>';
    return '<div class="k-output koi-scroll"><div class="filehdr"><span class="lang">C#</span> Generated/Ordering/Money.g.cs <span style="flex:1"></span>regenerated on save</div><pre style="margin:0">' + src + '</pre></div>';
  }

  function docsHTML() {
    const rows = [
      ['Order', 'The aggregate root for a customer’s purchase. Owns its lines and guards the total.'],
      ['OrderLine', 'A single pizza + quantity within an Order. Has no identity outside its Order.'],
      ['Money', 'A value object: an amount in a currency. Cannot be negative (invariant).'],
      ['OrderPlaced', 'Domain event emitted when an Order is successfully placed.']
    ];
    let h = '<div class="k-docs koi-scroll"><h2>Ubiquitous language</h2><div class="sub">Ordering · bounded context glossary</div><dl>';
    for (const [t, d] of rows) h += '<dt>' + t + '</dt><dd>' + d + '</dd>';
    return h + '</dl></div>';
  }

  // --- sub-view content (the facets each surface holds) -------------------
  function scenariosHTML() {
    const kw = (w) => '<span class="tk-kw">' + w + '</span>';
    const L = [
      '<span class="scn-h">Scenario:</span> Place an order',
      '  ' + kw('Given') + ' a cart with 2 pizzas',
      '  ' + kw('When') + ' the customer confirms checkout',
      '  ' + kw('Then') + ' an <span class="tk-ty">OrderPlaced</span> event is emitted',
      '  ' + kw('And') + ' total = sum of the line prices',
      '',
      '<span class="scn-h">Scenario:</span> Reject an empty cart',
      '  ' + kw('Given') + ' an empty cart',
      '  ' + kw('When') + ' the customer confirms checkout',
      '  ' + kw('Then') + ' it fails with <span class="tk-str">"cart is empty"</span>'
    ];
    return '<div class="k-code koi-scroll">' + L.map((l, i) => '<div class="ln"><span class="gut">' + (l ? i + 1 : '') + '</span><code>' + l + '</code></div>').join('') + '</div>';
  }

  function compatHTML() {
    const rows = [
      ['ok', 'Money', 'compatible'],
      ['ok', 'Order', 'compatible'],
      ['warn', 'Order.total', 'Money → Money? · nullable widened'],
      ['err', 'OrderLine.qty', 'renamed from “quantity” · breaking'],
      ['ok', 'OrderPlaced', 'compatible']
    ];
    let h = '<div class="k-check koi-scroll"><div class="chk-h">Model compatibility — baseline <b>v0.16.0</b> → current</div>';
    for (const [s, n, d] of rows) h += '<div class="chk-row chk-' + s + '"><span class="chk-i"></span><span class="chk-n">' + n + '</span><span class="chk-d">' + d + '</span></div>';
    return h + '<div class="chk-foot"><span class="chk-i chk-err"></span>1 breaking · <span class="chk-i chk-warn"></span>1 warning · run <code>koine check</code></div></div>';
  }

  function contextMapHTML() {
    const rels = [
      ['Ordering', 'Kitchen', 'OHS / PL'],
      ['Ordering', 'Billing', 'Customer / Supplier'],
      ['Delivery', 'Ordering', 'ACL'],
      ['Ordering', 'Payments', 'Conformist']
    ];
    let h = '<div class="k-cmap koi-scroll"><div class="cmap-h">Context map — Pizzeria</div>';
    for (const [a, b, l] of rels) h += '<div class="cmap-rel"><span class="cmap-ctx">' + a + '</span><span class="cmap-edge"><span class="cmap-lbl">' + l + '</span></span><span class="cmap-ctx">' + b + '</span></div>';
    return h + '<div class="cmap-legend">OHS Open-Host Service · PL Published Language · ACL Anti-Corruption Layer</div></div>';
  }

  function adrsHTML() {
    const adrs = [
      ['ADR-0007', 'accepted', 'Money is a value object, not an entity'],
      ['ADR-0006', 'accepted', 'OrderPlaced carries only the OrderId'],
      ['ADR-0005', 'superseded', 'Use Result&lt;T&gt; for command outcomes'],
      ['ADR-0004', 'proposed', 'Split Delivery into its own context']
    ];
    let h = '<div class="k-adr koi-scroll"><h2>Decision records</h2><div class="sub">Ordering · architecture decisions</div>';
    for (const [id, st, t] of adrs) h += '<div class="adr-row"><span class="adr-id">' + id + '</span><span class="adr-st adr-' + st + '">' + st + '</span><span class="adr-t">' + t + '</span></div>';
    return h + '</div>';
  }

  function notesHTML() {
    return '<div class="k-notes koi-scroll"><h2>Open questions</h2>'
      + '<ul><li>Should an Order allow <b>zero lines</b> before checkout? (see ADR-0004)</li>'
      + '<li>Confirm currency <b>rounding rules</b> with finance.</li>'
      + '<li>Pizza toppings — cap at 8? domain expert to confirm.</li></ul>'
      + '<p class="note-meta">last edited by you · 2 days ago</p></div>';
  }

  // surface id → { sub label → content fn }
  const CONTENT = {
    canvas: { Diagram: canvasHTML },
    code: { Editor: codeHTML, Scenarios: scenariosHTML },
    output: { Generated: outputHTML, Compatibility: compatHTML, 'Context Map': contextMapHTML },
    docs: { Glossary: docsHTML, ADRs: adrsHTML, Notes: notesHTML }
  };

  // fill an element with a surface's content (opts.sub picks the facet), mounting canvas if needed
  function fill(el, id, opts) {
    opts = opts || {};
    const s = SURFACES.find((x) => x.id === id);
    const map = CONTENT[id] || {};
    const sub = (opts.sub && map[opts.sub]) ? opts.sub : (s ? s.subs[0] : Object.keys(map)[0]);
    let html = (map[sub] || canvasHTML)();
    if (opts.tag) html += '<div class="surface-tag">' + (s ? s.tag : id) + '</div>';
    el.innerHTML = html;
    if (id === 'canvas') {
      const c = el.querySelector('[data-canvas]');
      if (c) mountCanvas(c);
    }
    return el;
  }

  function surface(id) { return SURFACES.find((x) => x.id === id); }

  // theme toggle helper — wires a button + persists nothing (POC). Also honors a
  // `#theme=light|dark` hash and a postMessage from the launcher so the gallery
  // can drive the theme of the embedded concept live.
  function initTheme(btn) {
    const root = document.documentElement;
    const fromHash = (location.hash.match(/theme=(light|dark)/) || [])[1];
    if (fromHash) root.dataset.theme = fromHash;
    if (!root.dataset.theme) root.dataset.theme = 'dark';
    const sync = () => { if (btn) btn.textContent = (root.dataset.theme === 'dark' ? '☀ Light' : '☽ Dark'); };
    if (btn) btn.addEventListener('click', () => { root.dataset.theme = root.dataset.theme === 'dark' ? 'light' : 'dark'; sync(); });
    window.addEventListener('message', (e) => {
      if (e.data && e.data.type === 'koi-theme' && (e.data.theme === 'light' || e.data.theme === 'dark')) {
        root.dataset.theme = e.data.theme; sync();
      }
    });
    sync();
  }

  // build the shared app-shell around a center node. Returns the .app-center el.
  function shell(host, opts) {
    opts = opts || {};
    host.innerHTML =
      '<div class="app-shell">'
      + '<div class="app-toolbar"><div class="app-brand">Koine<span>Studio</span></div>'
      + '<span class="pill">Pizzeria · Ordering</span><span class="pill">● 6 contexts</span>'
      + '<span class="spacer"></span>'
      + '<span class="pill" style="color:var(--koi-accent)">' + (opts.concept || '') + '</span>'
      + '<button class="theme-toggle" data-theme-toggle></button></div>'
      + '<div class="app-rail">'
      + railIcon('canvas', true) + railIcon('code') + railIcon('output') + railIcon('docs')
      + '</div>'
      + '<div class="app-center"></div>'
      + '<div class="app-right"><div class="rhead">Properties</div><div class="rbody">'
      + '<div class="rrow"><span>Element</span><b>Money</b></div>'
      + '<div class="rrow"><span>Kind</span><b>value object</b></div>'
      + '<div class="rrow"><span>Invariants</span><b>1</b></div>'
      + '<div class="rrow"><span>Used by</span><b>Order</b></div>'
      + '<div style="margin-top:14px;display:flex;align-items:center;gap:6px;color:var(--koi-accent)">' + ICONS.spark + ' AI Chat</div>'
      + '</div></div>'
      + '<div class="app-status"><span class="ok">✓ 0 errors</span><span>2 warnings</span><span>Ln 6, Col 5</span><span style="flex:1"></span><span>Koine 0.17.2</span></div>'
      + '</div>';
    initTheme(host.querySelector('[data-theme-toggle]'));
    return host.querySelector('.app-center');
  }
  function railIcon(id, on) {
    const s = surface(id);
    return '<div class="ric' + (on ? ' on' : '') + '" title="' + s.label + '">' + s.icon + '</div>';
  }

  window.KoineMock = {
    ICONS, SURFACES, fill, surface, initTheme, shell, mountCanvas, drawEdges,
    canvasHTML, codeHTML, outputHTML, docsHTML
  };
})();
