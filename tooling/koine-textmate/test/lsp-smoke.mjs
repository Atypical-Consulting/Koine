#!/usr/bin/env node
// LSP smoke test: drives the real Koine language server over stdio (JSON-RPC,
// Content-Length framed) and proves the four custom koine/* requests return the
// documented shapes. Exits nonzero on any mismatch.
//
// Run:  node test/lsp-smoke.mjs   (or `npm run test:lsp`)
//
// No dependencies beyond Node built-ins; this does NOT load the extension or
// vscode — it speaks raw LSP to the same dll the extension spawns at runtime.

import { spawn } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");
const DLL = join(
  REPO_ROOT,
  "src",
  "Koine.Cli",
  "bin",
  "Debug",
  "net10.0",
  "Koine.Cli.dll"
);

// Source samples shipped in the repo.
const BILLING_SRC = join(REPO_ROOT, "examples", "billing.koi");
// Purpose-built evolution pair: v2 drops/changes a published surface vs v1,
// so CompatibilityChecker reports real changes (drives koine/check meaningfully).
const SALES_V1_SRC = join(REPO_ROOT, "examples", "versioning", "v1", "sales.koi");
const SALES_V2_SRC = join(REPO_ROOT, "examples", "versioning", "v2", "sales.koi");

const CONTEXTMAP_SRC =
  "context A { value X { v: String } }\n" +
  "context B { value Y { v: String } }\n" +
  "contextmap { A -> B : conformist }\n";

const failures = [];
function check(cond, message) {
  if (!cond) {
    failures.push(message);
    console.error(`  FAIL: ${message}`);
  } else {
    console.log(`  ok:   ${message}`);
  }
}

function die(message) {
  console.error(`FATAL: ${message}`);
  process.exit(2);
}

// --- JSON-RPC over stdio (Content-Length framed) -----------------------------

class LspConn {
  constructor(child) {
    this.child = child;
    this.buf = Buffer.alloc(0);
    this.nextId = 1;
    this.pending = new Map();
    child.stdout.on("data", (chunk) => this.onData(chunk));
    child.stderr.on("data", (d) => process.stderr.write(`[server stderr] ${d}`));
  }

  onData(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    for (;;) {
      const headerEnd = this.buf.indexOf("\r\n\r\n");
      if (headerEnd < 0) {
        return;
      }
      const header = this.buf.slice(0, headerEnd).toString("ascii");
      const m = /Content-Length:\s*(\d+)/i.exec(header);
      if (!m) {
        die("malformed LSP header (no Content-Length)");
      }
      const len = Number(m[1]);
      const bodyStart = headerEnd + 4;
      if (this.buf.length < bodyStart + len) {
        return;
      }
      const body = this.buf.slice(bodyStart, bodyStart + len).toString("utf8");
      this.buf = this.buf.slice(bodyStart + len);
      let msg;
      try {
        msg = JSON.parse(body);
      } catch (e) {
        die(`invalid JSON body: ${e}`);
      }
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) {
          reject(new Error(JSON.stringify(msg.error)));
        } else {
          resolve(msg.result);
        }
      }
      // notifications / server-initiated requests are ignored for the smoke test
    }
  }

  send(obj) {
    const json = JSON.stringify(obj);
    const payload = Buffer.from(json, "utf8");
    this.child.stdin.write(`Content-Length: ${payload.length}\r\n\r\n`);
    this.child.stdin.write(payload);
  }

  request(method, params) {
    const id = this.nextId++;
    const p = new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`request '${method}' timed out`));
        }
      }, 30000);
    });
    this.send({ jsonrpc: "2.0", id, method, params });
    return p;
  }

  notify(method, params) {
    this.send({ jsonrpc: "2.0", method, params });
  }
}

// --- main --------------------------------------------------------------------

async function main() {
  if (!existsSync(DLL)) {
    die(
      `Koine.Cli.dll not found at ${DLL}. Build it first:\n` +
        `  dotnet build ${join(REPO_ROOT, "src", "Koine.Cli", "Koine.Cli.csproj")}`
    );
  }
  if (!existsSync(BILLING_SRC)) {
    die(`sample not found: ${BILLING_SRC}`);
  }

  // Isolated workspace: the server merges every .koi under the workspace root
  // into one model (directory semantics). Pointing it at the repo's examples/
  // tree would pull in the versioning samples, which intentionally conflict.
  // Copy billing.koi alone into a temp dir so the merged model is clean and the
  // emit assertions are deterministic.
  const workDir = mkdtempSync(join(tmpdir(), "koine-smoke-"));
  const BILLING = join(workDir, "billing.koi");
  copyFileSync(BILLING_SRC, BILLING);

  const child = spawn("dotnet", [DLL, "lsp"], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      DOTNET_NOLOGO: "1",
      DOTNET_CLI_TELEMETRY_OPTOUT: "1",
    },
  });
  child.on("error", (e) => die(`failed to spawn dotnet: ${e.message}`));

  const conn = new LspConn(child);

  // 1. initialize
  const billingUri = pathToFileURL(BILLING).toString();
  const rootUri = pathToFileURL(workDir).toString();
  const initResult = await conn.request("initialize", {
    processId: process.pid,
    rootUri,
    capabilities: {},
    workspaceFolders: [{ uri: rootUri, name: "koine-smoke" }],
  });
  const exp = initResult?.capabilities?.experimental ?? {};
  check(!!exp.koineEmitPreview, "initialize advertises experimental.koineEmitPreview");
  check(!!exp.koineGlossary, "initialize advertises experimental.koineGlossary");
  check(!!exp.koineContextMap, "initialize advertises experimental.koineContextMap");
  check(!!exp.koineCheck, "initialize advertises experimental.koineCheck");

  // 2. initialized
  conn.notify("initialized", {});

  // 3. didOpen
  conn.notify("textDocument/didOpen", {
    textDocument: {
      uri: billingUri,
      languageId: "koine",
      version: 1,
      text: readFileSync(BILLING, "utf8"),
    },
  });

  // 4. emitPreview csharp
  const emit = await conn.request("koine/emitPreview", {
    textDocument: { uri: billingUri },
    target: "csharp",
  });
  check(emit && emit.target === "csharp", "emitPreview: target === 'csharp'");
  check(Array.isArray(emit?.files), "emitPreview: files is an array");
  check(Array.isArray(emit?.diagnostics), "emitPreview: diagnostics is an array");
  check("error" in (emit ?? {}), "emitPreview: has 'error' field");
  check(
    emit?.error === null && emit.files.length > 0,
    "emitPreview: billing.koi emits files with no error"
  );
  if (emit?.files?.length) {
    const f = emit.files[0];
    check(
      typeof f.path === "string" && typeof f.contents === "string",
      "emitPreview: file has {path, contents} strings"
    );
  }

  // 5. glossary
  const glossary = await conn.request("koine/glossary", {
    textDocument: { uri: billingUri },
  });
  check(
    glossary && typeof glossary.markdown === "string",
    "glossary: markdown is a string"
  );
  check(
    (glossary?.markdown ?? "").trim().length > 0,
    "glossary: markdown is non-empty"
  );

  // 6a. contextMap with NO contextmap declared -> contexts present, relations empty.
  const cmapEmpty = await conn.request("koine/contextMap", {
    textDocument: { uri: billingUri },
  });
  check(Array.isArray(cmapEmpty?.contexts), "contextMap: contexts is an array");
  check(
    Array.isArray(cmapEmpty?.relations) && cmapEmpty.relations.length === 0,
    "contextMap: no contextmap -> relations empty"
  );

  // 6b. Open a model that DOES declare a contextmap (merged into the workspace) and
  //     assert the relation-bearing path: a non-empty, well-shaped relation.
  const cmapUri = pathToFileURL(join(workDir, "cmap.koi")).toString();
  conn.notify("textDocument/didOpen", {
    textDocument: { uri: cmapUri, languageId: "koine", version: 1, text: CONTEXTMAP_SRC },
  });
  const cmap = await conn.request("koine/contextMap", {
    textDocument: { uri: cmapUri },
  });
  check(
    Array.isArray(cmap?.relations) && cmap.relations.length > 0,
    "contextMap: declared contextmap -> non-empty relations"
  );
  const rel = cmap?.relations?.[0];
  check(
    rel &&
      typeof rel.upstream === "string" &&
      typeof rel.downstream === "string" &&
      typeof rel.kind === "string" &&
      Array.isArray(rel.sharedTypes) &&
      Array.isArray(rel.acl),
    "contextMap: relation has {upstream, downstream, kind, sharedTypes[], acl[]}"
  );
  check(
    rel?.upstream === "A" && rel?.downstream === "B" && rel?.kind === "Conformist",
    "contextMap: relation reflects 'A -> B : conformist'"
  );

  // shutdown the billing/contextmap connection
  try {
    await conn.request("shutdown", null);
    conn.notify("exit", null);
  } catch {
    // ignore — we're done regardless
  }
  child.kill();

  // 7. koine/check on a DEDICATED workspace: current = sales v2, baseline = sales v1
  //    (a purpose-built evolution pair), so the comparison yields real changes and
  //    the documented per-change fields are asserted unconditionally.
  if (existsSync(SALES_V1_SRC) && existsSync(SALES_V2_SRC)) {
    const salesWork = mkdtempSync(join(tmpdir(), "koine-sales-cur-"));
    const salesBaseline = mkdtempSync(join(tmpdir(), "koine-sales-base-"));
    copyFileSync(SALES_V2_SRC, join(salesWork, "sales.koi"));
    copyFileSync(SALES_V1_SRC, join(salesBaseline, "sales.koi"));

    const child2 = spawn("dotnet", [DLL, "lsp"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, DOTNET_NOLOGO: "1", DOTNET_CLI_TELEMETRY_OPTOUT: "1" },
    });
    child2.on("error", (e) => die(`failed to spawn dotnet (check): ${e.message}`));
    const conn2 = new LspConn(child2);

    const salesRoot = pathToFileURL(salesWork).toString();
    const salesUri = pathToFileURL(join(salesWork, "sales.koi")).toString();
    await conn2.request("initialize", {
      processId: process.pid,
      rootUri: salesRoot,
      capabilities: {},
      workspaceFolders: [{ uri: salesRoot, name: "koine-sales" }],
    });
    conn2.notify("initialized", {});
    conn2.notify("textDocument/didOpen", {
      textDocument: {
        uri: salesUri,
        languageId: "koine",
        version: 1,
        text: readFileSync(join(salesWork, "sales.koi"), "utf8"),
      },
    });

    const checkRes = await conn2.request("koine/check", {
      textDocument: { uri: salesUri },
      baseline: salesBaseline,
    });
    check(
      typeof checkRes?.hasBreakingChanges === "boolean",
      "check: hasBreakingChanges is a boolean"
    );
    check(
      Array.isArray(checkRes?.changes) && checkRes.changes.length > 0,
      "check: v1->v2 evolution yields changes"
    );
    const c = checkRes?.changes?.[0];
    check(
      c &&
        (c.impact === "Breaking" || c.impact === "NonBreaking") &&
        typeof c.code === "string" &&
        typeof c.message === "string",
      "check: change has {impact, code, message}"
    );

    try {
      await conn2.request("shutdown", null);
      conn2.notify("exit", null);
    } catch {
      // ignore
    }
    child2.kill();
  } else {
    die(`versioning fixtures missing: ${SALES_V1_SRC} / ${SALES_V2_SRC}`);
  }

  if (failures.length > 0) {
    console.error(`\nSMOKE TEST FAILED: ${failures.length} assertion(s) failed.`);
    process.exit(1);
  }
  console.log("\nSMOKE TEST PASSED: all custom koine/* requests verified.");
  process.exit(0);
}

main().catch((e) => die(e?.stack ?? String(e)));
