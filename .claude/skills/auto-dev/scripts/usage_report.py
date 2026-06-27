#!/usr/bin/env python3
"""auto-dev cost accounting — aggregate token usage across the orchestrator + every
background worker session, so you can track tokens/merge and $/merge across runs.

Background workers run as their OWN Claude sessions (tmux panes) inside the same
worktree, so their transcripts live alongside the orchestrator's in the project dir:
    ~/.claude/projects/<url-encoded-worktree-path>/<session-id>.jsonl

Usage:
    python usage_report.py [PROJECT_DIR] [--main SESSION_ID] [--top N]

  PROJECT_DIR   the ~/.claude/projects/<...> dir holding the .jsonl transcripts.
                Defaults to auto-detecting it from $PWD (the encoded worktree path).
  --main        session-id of the orchestrator, to split it out from the workers.
  --top         how many sessions to list (default 40).

IMPORTANT — billing caveat: the $ figures are **API list-price equivalents** computed
from on-disk token counts. On a Max/Pro subscription your marginal cash cost is ~$0
(usage is included, bounded by rate limits). Treat $ as a *relative scalability* signal
— where the tokens go — and as "rate-limit budget consumed", not necessarily a bill.
The authoritative cash number for the CURRENT session is the built-in `/cost` command;
this script is more complete because it also sees the tmux worker sessions /cost can't.
"""
import json, glob, os, sys

# Per-model pricing, $ / 1M tokens: (input, output, cache_write_5m, cache_read).
# Keyed by a substring of the model id. Update when rates change.
PRICING = {
    "opus":   (15.0, 75.0, 18.75, 1.50),
    "sonnet": ( 3.0, 15.0,  3.75, 0.30),
    "haiku":  ( 1.0,  5.0,  1.25, 0.10),
}
DEFAULT = PRICING["sonnet"]  # unknown model → price conservatively as Sonnet

def rate_for(model):
    if model:
        for key, r in PRICING.items():
            if key in model:
                return r, key
    return DEFAULT, "?"

def detect_project_dir():
    # Claude encodes the cwd as the project-dir name: '/' and '.' → '-'.
    home = os.path.expanduser("~")
    enc = os.getcwd().replace("/", "-").replace(".", "-")
    cand = os.path.join(home, ".claude", "projects", enc)
    if os.path.isdir(cand):
        return cand
    # Fallback: newest project dir under ~/.claude/projects
    base = os.path.join(home, ".claude", "projects")
    dirs = [os.path.join(base, d) for d in os.listdir(base)] if os.path.isdir(base) else []
    dirs = [d for d in dirs if os.path.isdir(d)]
    return max(dirs, key=os.path.getmtime) if dirs else None

def first_user_label(path):
    try:
        with open(path) as f:
            for line in f:
                try: o = json.loads(line)
                except Exception: continue
                if o.get("type") == "user":
                    c = o.get("message", {}).get("content")
                    txt = c if isinstance(c, str) else next(
                        (p.get("text") for p in c if isinstance(p, dict) and p.get("type") == "text"),
                        None) if isinstance(c, list) else None
                    if txt:
                        return " ".join(txt.split())[:80]
    except Exception:
        pass
    return ""

def scan(path):
    tin = tout = tcw = tcr = nmsg = 0
    model = None
    with open(path) as f:
        for line in f:
            try: o = json.loads(line)
            except Exception: continue
            msg = o.get("message")
            if not isinstance(msg, dict): continue
            if msg.get("model"): model = msg["model"]
            u = msg.get("usage")
            if not isinstance(u, dict): continue
            tin  += u.get("input_tokens", 0) or 0
            tout += u.get("output_tokens", 0) or 0
            tcw  += u.get("cache_creation_input_tokens", 0) or 0
            tcr  += u.get("cache_read_input_tokens", 0) or 0
            nmsg += 1
    (pi, po, pcw, pcr), mk = rate_for(model)
    cost = tin/1e6*pi + tout/1e6*po + tcw/1e6*pcw + tcr/1e6*pcr
    return dict(tin=tin, tout=tout, tcw=tcw, tcr=tcr, nmsg=nmsg, cost=cost, model=mk)

def main(argv):
    proj = None; main_id = None; top = 40
    i = 0
    pos = [a for a in argv if not a.startswith("--")]
    if pos: proj = pos[0]
    if "--main" in argv: main_id = argv[argv.index("--main")+1]
    if "--top"  in argv: top = int(argv[argv.index("--top")+1])
    proj = proj or detect_project_dir()
    if not proj or not os.path.isdir(proj):
        print(f"project dir not found: {proj}", file=sys.stderr); return 2

    rows = []
    for p in glob.glob(os.path.join(proj, "*.jsonl")):
        sid = os.path.basename(p)[:-6]
        r = scan(p); r["sid"] = sid; r["label"] = first_user_label(p)
        rows.append(r)
    rows.sort(key=lambda r: r["cost"], reverse=True)

    def f(n): return f"{n:,}"
    g = {k: sum(r[k] for r in rows) for k in ("tin","tout","tcw","tcr","nmsg","cost")}
    tot_tok = g["tin"]+g["tout"]+g["tcw"]+g["tcr"]

    print(f"SESSIONS: {len(rows)} in {proj}\n")
    print(f"{'$equiv':>9}  {'model':>6}  {'output':>11}  {'cacheRead':>14}  {'msgs':>5}  session / label")
    print("-"*120)
    for r in rows[:top]:
        tag = "  <<< ORCHESTRATOR" if r["sid"] == main_id else ""
        print(f"{r['cost']:9.2f}  {r['model']:>6}  {f(r['tout']):>11}  {f(r['tcr']):>14}  {r['nmsg']:>5}  {r['sid'][:8]} {r['label']}{tag}")
    print("-"*120)

    print(f"\n=== GRAND TOTAL ({len(rows)} sessions) ===")
    print(f"  output {f(g['tout'])} | input {f(g['tin'])} | cacheWrite {f(g['tcw'])} | cacheRead {f(g['tcr'])}")
    print(f"  total tokens {f(tot_tok)} | assistant msgs {f(g['nmsg'])}")
    print(f"  EST COST (API list-price equiv): ${g['cost']:,.2f}   [subscription users: ~$0 cash; this = rate-limit budget]")

    # cost by token type (at blended rates actually applied)
    print(f"\n=== COST DRIVERS (share of $equiv) ===")
    parts = []
    for name, tok, price_key in (("cache read", g['tcr'], 3), ("cache write", g['tcw'], 2),
                                  ("output", g['tout'], 1), ("input", g['tin'], 0)):
        # approximate $ using Opus rates only for the *share* illustration is misleading post-tiering;
        # instead report token share, which is model-agnostic.
        parts.append((name, tok))
    for name, tok in parts:
        print(f"  {name:<12}: {f(tok):>16} tok  ({tok/tot_tok*100:4.1f}% of tokens)")

    if main_id:
        m = next((r for r in rows if r["sid"] == main_id), None)
        if m:
            rest = g["cost"] - m["cost"]
            print(f"\n=== ORCHESTRATOR vs WORKERS ===")
            print(f"  orchestrator : ${m['cost']:,.2f}  ({m['cost']/g['cost']*100:.0f}%)")
            print(f"  workers+other: ${rest:,.2f}  ({rest/g['cost']*100:.0f}%) over {len(rows)-1} sessions, avg ${rest/max(1,len(rows)-1):,.2f}")

    # per-model rollup — shows the tiering payoff
    bym = {}
    for r in rows:
        d = bym.setdefault(r["model"], {"n":0,"cost":0.0,"tok":0})
        d["n"]+=1; d["cost"]+=r["cost"]; d["tok"]+=r["tin"]+r["tout"]+r["tcw"]+r["tcr"]
    print(f"\n=== BY MODEL (the tiering payoff) ===")
    for mk, d in sorted(bym.items(), key=lambda kv: kv[1]["cost"], reverse=True):
        print(f"  {mk:>6}: {d['n']:>3} sessions | {f(d['tok']):>16} tok | ${d['cost']:,.2f}")
    return 0

if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
