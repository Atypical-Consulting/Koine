// Unit tests for the pure helper functions extracted from ide.ts into ideUtils.ts.
// These are module-scope stateless functions — no DOM, no host, no vitest DOM environment needed.
import { describe, expect, test } from 'vitest';
import {
  pathToFileUri,
  fileUriToPath,
  isSafeShareRelPath,
  diagnosticsInRange,
} from '@/shell/ideUtils';
import type { LspDiagnostic, Range } from '@/lsp/lsp';

// ---------------------------------------------------------------------------
// pathToFileUri / fileUriToPath — round-trip tests
// ---------------------------------------------------------------------------

describe('pathToFileUri', () => {
  test('encodes a POSIX absolute path to a file:// URI', () => {
    expect(pathToFileUri('/home/user/my model.koi')).toBe('file:///home/user/my%20model.koi');
  });

  test('encodes a POSIX path with no special characters', () => {
    expect(pathToFileUri('/home/user/model.koi')).toBe('file:///home/user/model.koi');
  });

  test('encodes a Windows drive path with backslashes to file:///C:/ form', () => {
    expect(pathToFileUri('C:\\Users\\user\\model.koi')).toBe('file:///C:/Users/user/model.koi');
  });

  test('encodes a Windows drive path with forward slashes', () => {
    expect(pathToFileUri('C:/Users/user/model.koi')).toBe('file:///C:/Users/user/model.koi');
  });
});

describe('fileUriToPath', () => {
  test('returns null for a non-file:// URI', () => {
    expect(fileUriToPath('https://example.com/foo')).toBeNull();
  });

  test('decodes a POSIX file:// URI back to an absolute path', () => {
    expect(fileUriToPath('file:///home/user/model.koi')).toBe('/home/user/model.koi');
  });

  test('decodes an encoded POSIX file:// URI back to an absolute path', () => {
    expect(fileUriToPath('file:///home/user/my%20model.koi')).toBe('/home/user/my model.koi');
  });

  test('decodes a Windows file:///C:/ URI back to C:/… form', () => {
    expect(fileUriToPath('file:///C:/Users/user/model.koi')).toBe('C:/Users/user/model.koi');
  });
});

describe('pathToFileUri / fileUriToPath round-trip', () => {
  test('round-trips a POSIX absolute path', () => {
    const path = '/home/user/my model/main.koi';
    expect(fileUriToPath(pathToFileUri(path))).toBe(path);
  });

  test('round-trips a Windows drive path (forward slashes)', () => {
    const path = 'C:/Users/user/models/main.koi';
    expect(fileUriToPath(pathToFileUri(path))).toBe(path);
  });

  test('round-trips a Windows drive path (backslashes)', () => {
    // pathToFileUri normalises backslashes → the round-trip yields forward slashes
    const winPath = 'C:\\Users\\user\\main.koi';
    const uri = pathToFileUri(winPath);
    // Decoded form uses forward slashes (normalised by pathToFileUri)
    expect(fileUriToPath(uri)).toBe('C:/Users/user/main.koi');
  });
});

// ---------------------------------------------------------------------------
// isSafeShareRelPath
// ---------------------------------------------------------------------------

describe('isSafeShareRelPath', () => {
  test('accepts a simple file name', () => {
    expect(isSafeShareRelPath('model.koi')).toBe(true);
  });

  test('accepts a nested relative path', () => {
    expect(isSafeShareRelPath('billing/model.koi')).toBe(true);
  });

  test('accepts a filename that CONTAINS ".." as a substring (not a traversal segment)', () => {
    expect(isSafeShareRelPath('My..Context.koi')).toBe(true);
  });

  test('rejects an empty string', () => {
    expect(isSafeShareRelPath('')).toBe(false);
  });

  test('rejects a ".." traversal SEGMENT', () => {
    expect(isSafeShareRelPath('../escape.koi')).toBe(false);
  });

  test('rejects a ".." segment embedded in a path', () => {
    expect(isSafeShareRelPath('billing/../escape.koi')).toBe(false);
  });

  test('rejects a backslash separator', () => {
    expect(isSafeShareRelPath('billing\\model.koi')).toBe(false);
  });

  test('rejects a path with an absolute leading slash (empty leading segment)', () => {
    expect(isSafeShareRelPath('/model.koi')).toBe(false);
  });

  test('rejects a path with a trailing slash (empty trailing segment)', () => {
    expect(isSafeShareRelPath('billing/')).toBe(false);
  });

  test('rejects a path with a double slash (empty middle segment)', () => {
    expect(isSafeShareRelPath('billing//model.koi')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// diagnosticsInRange
// ---------------------------------------------------------------------------

function makeDiag(
  startLine: number,
  startChar: number,
  endLine: number,
  endChar: number,
): LspDiagnostic {
  return {
    range: {
      start: { line: startLine, character: startChar },
      end: { line: endLine, character: endChar },
    },
    message: `diag @${startLine}:${startChar}`,
    severity: 1,
  } as LspDiagnostic;
}

describe('diagnosticsInRange', () => {
  const diags: LspDiagnostic[] = [
    makeDiag(0, 0, 0, 5),   // line 0 only
    makeDiag(2, 3, 2, 10),  // line 2 only
    makeDiag(5, 0, 6, 0),   // lines 5–6
    makeDiag(10, 0, 10, 5), // line 10 only
  ];

  test('returns empty array when no diagnostics intersect the range', () => {
    const range: Range = { start: { line: 7, character: 0 }, end: { line: 9, character: 0 } };
    expect(diagnosticsInRange(diags, range)).toHaveLength(0);
  });

  test('returns a single diagnostic that exactly covers the range', () => {
    const range: Range = { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } };
    const result = diagnosticsInRange(diags, range);
    expect(result).toHaveLength(1);
    expect(result[0].message).toContain('0:0');
  });

  test('returns diagnostics that overlap the range', () => {
    const range: Range = { start: { line: 2, character: 0 }, end: { line: 5, character: 2 } };
    const result = diagnosticsInRange(diags, range);
    // diag at 2:3-2:10 and 5:0-6:0 both intersect
    expect(result).toHaveLength(2);
  });

  test('returns all diagnostics for a wide range', () => {
    const range: Range = { start: { line: 0, character: 0 }, end: { line: 99, character: 0 } };
    expect(diagnosticsInRange(diags, range)).toHaveLength(diags.length);
  });

  test('filters to only the diagnostic on the requested line', () => {
    const range: Range = { start: { line: 10, character: 0 }, end: { line: 10, character: 5 } };
    const result = diagnosticsInRange(diags, range);
    expect(result).toHaveLength(1);
    expect(result[0].message).toContain('10:0');
  });
});
