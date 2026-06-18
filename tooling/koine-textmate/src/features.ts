import { basename } from "node:path";
import * as vscode from "vscode";
import { LanguageClient } from "vscode-languageclient/node";

/**
 * UI for the four custom `koine/*` LSP requests the language server exposes.
 *
 * The standard LSP features (diagnostics, hover, completion, go-to-definition,
 * rename, formatting, semantic tokens) are handled by the LanguageClient itself
 * and are NOT re-implemented here. This module only adds the commands that drive
 * the server's experimental, Koine-specific requests and renders their results
 * with built-in VS Code APIs (a read-only virtual-document provider plus the
 * built-in markdown preview) — no extra runtime dependencies.
 */

const SCHEME = "koine-view";

// --- Result shapes (mirror src/Koine.Cli/LspServer.cs exactly) ----------------

interface EmitFile {
  path: string;
  contents: string;
}

interface EmitPreviewResult {
  target: string;
  files: EmitFile[];
  diagnostics: LspDiagnosticLike[];
  error: string | null;
}

interface LspDiagnosticLike {
  uri?: string;
  message?: string;
  severity?: number;
  range?: { start?: { line?: number; character?: number } };
}

interface GlossaryResult {
  markdown: string;
}

interface AclMapping {
  upstreamContext: string;
  upstreamType: string;
  localContext: string;
  localType: string;
}

interface ContextRelation {
  upstream: string;
  downstream: string;
  kind: string;
  bidirectional: boolean;
  sharedTypes: string[];
  acl: AclMapping[];
}

interface ContextMapResult {
  contexts: string[];
  relations: ContextRelation[];
}

interface CheckChange {
  impact: "Breaking" | "NonBreaking";
  code: string;
  message: string;
}

interface CheckResult {
  error?: string;
  hasBreakingChanges: boolean;
  changes: CheckChange[];
}

// --- Read-only virtual-document provider -------------------------------------

/**
 * Serves text/markdown for `koine-view:` URIs. The scheme has no
 * FileSystemProvider, so opened documents are inherently read-only. Content is
 * keyed by the *full* uri string (query included) so the uniquifying query in
 * {@link makeUri} forces a fresh document on every re-run.
 */
export class KoineViewProvider implements vscode.TextDocumentContentProvider {
  private readonly docs = new Map<string, string>();
  private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this._onDidChange.event;

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.docs.get(uri.toString()) ?? "";
  }

  set(uri: vscode.Uri, contents: string): void {
    this.docs.set(uri.toString(), contents);
    this._onDidChange.fire(uri);
  }
}

function makeUri(kind: string, name: string, ext: string): vscode.Uri {
  return vscode.Uri
    .parse(`${SCHEME}:/${kind}/${name}.${ext}`)
    .with({ query: `t=${Date.now()}` });
}

// --- Shared helpers ----------------------------------------------------------

type ClientAccessor = () => Promise<LanguageClient | undefined>;

/** Returns the active editor's document uri iff it is a `.koi` file. */
function activeKoineUri(): vscode.Uri | undefined {
  const ed = vscode.window.activeTextEditor;
  if (!ed || ed.document.languageId !== "koine") {
    void vscode.window.showWarningMessage("Koine: open a .koi file first.");
    return undefined;
  }
  return ed.document.uri;
}

function docName(uri: vscode.Uri): string {
  return basename(uri.fsPath, ".koi");
}

/** Resolves the active uri + a ready client, surfacing friendly warnings. */
async function context(
  getClient: ClientAccessor
): Promise<{ uri: vscode.Uri; client: LanguageClient } | undefined> {
  const uri = activeKoineUri();
  if (!uri) {
    return undefined;
  }
  const client = await getClient();
  if (!client) {
    void vscode.window.showErrorMessage(
      "Koine: language server is not running."
    );
    return undefined;
  }
  return { uri, client };
}

async function openMarkdownPreview(
  provider: KoineViewProvider,
  kind: string,
  name: string,
  markdown: string
): Promise<void> {
  const uri = makeUri(kind, name, "md");
  provider.set(uri, markdown);
  // The built-in markdown preview reads the content via our provider (the
  // virtual doc stays the backing source so "View Source" works). No Mermaid.
  await vscode.commands.executeCommand("markdown.showPreview", uri);
}

function escapeCell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

// --- Command handlers --------------------------------------------------------

async function previewEmit(
  provider: KoineViewProvider,
  getClient: ClientAccessor
): Promise<void> {
  const ctx = await context(getClient);
  if (!ctx) {
    return;
  }

  const pick = await vscode.window.showQuickPick(
    [
      { label: "C#", target: "csharp" },
      { label: "TypeScript", target: "typescript" },
    ],
    { placeHolder: "Select an emit target" }
  );
  if (!pick) {
    return; // cancelled — abort silently
  }
  const target = pick.target;

  let res: EmitPreviewResult;
  try {
    res = await ctx.client.sendRequest<EmitPreviewResult>(
      "koine/emitPreview",
      { textDocument: { uri: ctx.uri.toString() }, target }
    );
  } catch (err) {
    void vscode.window.showErrorMessage(`Koine: emit preview failed. (${err})`);
    return;
  }

  if (res.error) {
    void vscode.window.showErrorMessage(res.error);
    return;
  }

  const name = docName(ctx.uri);

  if (res.files.length === 0) {
    const n = res.diagnostics.length;
    void vscode.window.showWarningMessage(
      `Koine: cannot emit — the model has ${n} diagnostic(s). Fix them and retry.`
    );
    const lines = res.diagnostics.map((d) => {
      const sev = severityLabel(d.severity);
      const line = (d.range?.start?.line ?? 0) + 1;
      const col = (d.range?.start?.character ?? 0) + 1;
      return `${sev} ${d.uri ?? ""} ${line}:${col} ${d.message ?? ""}`.trim();
    });
    const summary = [
      `Koine emit preview (${target}) — model has errors, nothing emitted.`,
      "",
      ...(lines.length > 0 ? lines : ["(no diagnostics reported)"]),
    ].join("\n");
    const uri = makeUri("emit", `${name}.${target}`, "txt");
    provider.set(uri, summary);
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc, {
      viewColumn: vscode.ViewColumn.Beside,
      preview: true,
    });
    return;
  }

  const combined = res.files
    .map((f) => `// ===== ${f.path} =====\n${f.contents}`)
    .join("\n\n");

  const uri = makeUri("emit", `${name}.${target}`, "txt");
  provider.set(uri, combined);
  const doc = await vscode.workspace.openTextDocument(uri);
  await vscode.languages.setTextDocumentLanguage(
    doc,
    target === "typescript" ? "typescript" : "csharp"
  );
  await vscode.window.showTextDocument(doc, {
    viewColumn: vscode.ViewColumn.Beside,
    preview: true,
  });
}

function severityLabel(severity?: number): string {
  switch (severity) {
    case 1:
      return "[error]";
    case 2:
      return "[warning]";
    case 3:
      return "[info]";
    case 4:
      return "[hint]";
    default:
      return "[diagnostic]";
  }
}

async function showGlossary(
  provider: KoineViewProvider,
  getClient: ClientAccessor
): Promise<void> {
  const ctx = await context(getClient);
  if (!ctx) {
    return;
  }

  let res: GlossaryResult;
  try {
    res = await ctx.client.sendRequest<GlossaryResult>("koine/glossary", {
      textDocument: { uri: ctx.uri.toString() },
    });
  } catch (err) {
    void vscode.window.showErrorMessage(`Koine: glossary failed. (${err})`);
    return;
  }

  if (!res.markdown || res.markdown.trim().length === 0) {
    void vscode.window.showWarningMessage(
      "Koine: glossary is empty (the model may have syntax errors)."
    );
    return;
  }

  await openMarkdownPreview(provider, "glossary", docName(ctx.uri), res.markdown);
}

async function showContextMap(
  provider: KoineViewProvider,
  getClient: ClientAccessor
): Promise<void> {
  const ctx = await context(getClient);
  if (!ctx) {
    return;
  }

  let res: ContextMapResult;
  try {
    res = await ctx.client.sendRequest<ContextMapResult>("koine/contextMap", {
      textDocument: { uri: ctx.uri.toString() },
    });
  } catch (err) {
    void vscode.window.showErrorMessage(`Koine: context map failed. (${err})`);
    return;
  }

  await openMarkdownPreview(
    provider,
    "contextmap",
    docName(ctx.uri),
    renderContextMap(res)
  );
}

function renderContextMap(res: ContextMapResult): string {
  const out: string[] = ["# Context Map", ""];

  out.push("## Contexts", "");
  if (res.contexts.length === 0) {
    out.push("_No contexts._", "");
  } else {
    for (const c of res.contexts) {
      out.push(`- ${c}`);
    }
    out.push("");
  }

  out.push("## Relations", "");
  if (res.relations.length === 0) {
    out.push("_No context map declared._", "");
  } else {
    out.push(
      "| Upstream | Direction | Downstream | Kind | Shared Types | ACL |",
      "| --- | --- | --- | --- | --- | --- |"
    );
    for (const r of res.relations) {
      const direction = r.bidirectional ? "<->" : "->";
      const shared =
        r.sharedTypes.length > 0 ? r.sharedTypes.join(", ") : "—";
      const acl =
        r.acl.length > 0
          ? r.acl
              .map(
                (a) =>
                  `${a.upstreamContext}.${a.upstreamType} -> ${a.localContext}.${a.localType}`
              )
              .join("<br>")
          : "—";
      out.push(
        `| ${escapeCell(r.upstream)} | ${escapeCell(direction)} | ${escapeCell(
          r.downstream
        )} | ${escapeCell(r.kind)} | ${escapeCell(shared)} | ${escapeCell(
          acl
        )} |`
      );
    }
    out.push("");
  }

  return out.join("\n");
}

async function checkCompatibility(
  provider: KoineViewProvider,
  getClient: ClientAccessor
): Promise<void> {
  const ctx = await context(getClient);
  if (!ctx) {
    return;
  }

  const picked = await vscode.window.showOpenDialog({
    canSelectFolders: true,
    canSelectFiles: false,
    canSelectMany: false,
    openLabel: "Select baseline model folder",
    defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri,
  });
  if (!picked || picked.length === 0) {
    return; // cancelled — abort silently
  }

  let res: CheckResult;
  try {
    res = await ctx.client.sendRequest<CheckResult>("koine/check", {
      textDocument: { uri: ctx.uri.toString() },
      baseline: picked[0].fsPath,
    });
  } catch (err) {
    void vscode.window.showErrorMessage(
      `Koine: compatibility check failed. (${err})`
    );
    return;
  }

  if (res.error) {
    void vscode.window.showErrorMessage(
      "Koine compatibility check failed: " + res.error
    );
    return;
  }

  const markdown = renderCheck(res);
  await openMarkdownPreview(provider, "check", docName(ctx.uri), markdown);

  if (res.hasBreakingChanges) {
    void vscode.window.showWarningMessage(
      "Koine: baseline check found breaking changes — see the report."
    );
  } else {
    void vscode.window.showInformationMessage(
      "Koine: no breaking changes vs baseline."
    );
  }
}

function renderCheck(res: CheckResult): string {
  const out: string[] = [];
  out.push(
    res.hasBreakingChanges
      ? "# ⚠️ Breaking changes detected"
      : "# ✅ No breaking changes"
  );
  out.push("");

  const breaking = res.changes.filter((c) => c.impact === "Breaking").length;
  const nonBreaking = res.changes.length - breaking;
  out.push(
    `${res.changes.length} change(s): ${breaking} breaking, ${nonBreaking} non-breaking.`,
    ""
  );

  if (res.changes.length === 0) {
    out.push("_No changes detected._", "");
  } else {
    out.push("| Impact | Code | Message |", "| --- | --- | --- |");
    for (const c of res.changes) {
      out.push(
        `| ${escapeCell(c.impact)} | ${escapeCell(c.code)} | ${escapeCell(
          c.message
        )} |`
      );
    }
    out.push("");
  }

  return out.join("\n");
}

// --- Registration ------------------------------------------------------------

/**
 * Registers the virtual-document provider and the four `koine.*` commands.
 * `getClient` resolves to the started/ready LanguageClient (or undefined).
 */
export function registerKoineFeatures(
  context: vscode.ExtensionContext,
  getClient: ClientAccessor
): void {
  const provider = new KoineViewProvider();
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(SCHEME, provider)
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("koine.previewEmit", () =>
      previewEmit(provider, getClient)
    ),
    vscode.commands.registerCommand("koine.showGlossary", () =>
      showGlossary(provider, getClient)
    ),
    vscode.commands.registerCommand("koine.showContextMap", () =>
      showContextMap(provider, getClient)
    ),
    vscode.commands.registerCommand("koine.checkCompatibility", () =>
      checkCompatibility(provider, getClient)
    )
  );
}
