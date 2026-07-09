// @vitest-environment happy-dom
// Characterization test for issue #986: pins the 38-export `@/editor/editor` public surface BEFORE
// it splits into lspExtensions.ts / outputView.ts / settingsJsonEditor.ts (+ the cmTheme.ts shared
// leaf) behind facade re-exports. GREEN against the still-whole monolith by design — its job is to
// stay green through every extraction, proving the facade keeps re-exporting every name unchanged
// (the same contract `lsp.ts`'s `export * from '@/lsp/protocol'` proved for its ~23 importers).
//
// The 14 runtime exports are asserted directly below; the 24 exported types are checked at
// COMPILE TIME by the `_EditorSurfaceTypeCheck` tuple further down — `isolatedModules` forces every
// type-only re-export to use `export type { … }`, so if a move drops one, this file fails to
// typecheck (`npm run build`) even though the runtime assertions would stay green. Together the two
// checks cover all 38 exports.
import { describe, it, expect } from 'vitest';
import {
  createKoineEditor,
  setEditorDiagnostics,
  renderSymbolTree,
  renderMarkdown,
  inlayHintsExtension,
  semanticTokensExtension,
  decodeSemanticTokens,
  SEMANTIC_TOKEN_TYPES,
  langExt,
  createOutputView,
  createJsonView,
  settingsSchemaHover,
  settingsCompletionSource,
  createJsonSettingsEditor,
} from '@/editor/editor';
import type {
  HoverFn,
  CompletionFn,
  InlayHintsFn,
  SemanticTokensFn,
  DecodedSemanticToken,
  DefinitionFn,
  NavigateFn,
  FormatFn,
  PrepareRenameFn,
  RenameFn,
  ReferencesFn,
  CodeActionsFn,
  PrepareCallHierarchyFn,
  IncomingCallsFn,
  OutgoingCallsFn,
  ApplyWorkspaceEditFn,
  NavigateLocationFn,
  UriLabelFn,
  OutputLang,
  OutputView,
  ConfigView,
  JsonSettingsEditor,
  KoineEditorOptions,
  KoineEditor,
} from '@/editor/editor';

// A pure type-position usage of all 24 exported types. `export` keeps tsc from ever flagging this
// tuple as an unused local (isolatedModules/noUnusedLocals) while still forcing every member to
// resolve — drop one of the facade's `export type { … }` re-exports during the split and this line
// fails to compile.
export type _EditorSurfaceTypeCheck = [
  HoverFn,
  CompletionFn,
  InlayHintsFn,
  SemanticTokensFn,
  DecodedSemanticToken,
  DefinitionFn,
  NavigateFn,
  FormatFn,
  PrepareRenameFn,
  RenameFn,
  ReferencesFn,
  CodeActionsFn,
  PrepareCallHierarchyFn,
  IncomingCallsFn,
  OutgoingCallsFn,
  ApplyWorkspaceEditFn,
  NavigateLocationFn,
  UriLabelFn,
  OutputLang,
  OutputView,
  ConfigView,
  JsonSettingsEditor,
  KoineEditorOptions,
  KoineEditor,
];

describe('@/editor/editor facade surface (#986)', () => {
  it('still resolves all 13 runtime function exports', () => {
    const fns = [
      createKoineEditor,
      setEditorDiagnostics,
      renderSymbolTree,
      renderMarkdown,
      inlayHintsExtension,
      semanticTokensExtension,
      decodeSemanticTokens,
      langExt,
      createOutputView,
      createJsonView,
      settingsSchemaHover,
      settingsCompletionSource,
      createJsonSettingsEditor,
    ];
    for (const fn of fns) expect(typeof fn).toBe('function');
  });

  it('still resolves SEMANTIC_TOKEN_TYPES as a non-empty array', () => {
    expect(Array.isArray(SEMANTIC_TOKEN_TYPES)).toBe(true);
    expect(SEMANTIC_TOKEN_TYPES.length).toBeGreaterThan(0);
  });
});
