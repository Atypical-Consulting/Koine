/**
 * css-equiv.mjs — deterministic CSS rule-set equivalence comparator
 *
 * CLI:  node scripts/css-equiv.mjs <baseline.css|scss> <candidate.css|scss>
 *         → prints EQUIVALENT + exits 0 when render-equivalent
 *         → prints a diff report + exits 1 otherwise
 *
 * Exported API: compareCss({ fileA?, fileB?, cssA?, cssB? }) → { equivalent, report }
 *   - Pass file paths OR raw CSS strings (for testing).
 *   - Paths trigger the same SCSS-syntax-mode compile as css-canon.mjs.
 */

import * as sass from 'sass-embedded';
import postcss from 'postcss';
import { readFileSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// ---------------------------------------------------------------------------
// Step 1: compile input to canonical compressed CSS (mirrors css-canon.mjs)
// ---------------------------------------------------------------------------

/**
 * Compile a CSS/SCSS file to compressed canonical CSS string.
 * .css  → compiled from string with syntax:'scss' (normalises colors identically)
 * .scss → path-based compile so @use/@forward resolve
 * Raw string (no file path) → compiled from string with syntax:'scss'
 */
async function toCanonical(filePathOrNull, rawCss) {
  if (rawCss !== undefined) {
    // Inline string (used by tests) — force SCSS syntax for consistent normalisation
    const result = await sass.compileStringAsync(rawCss, {
      syntax: 'scss',
      style: 'compressed',
      sourceMap: false,
    });
    return result.css;
  }

  const absPath = resolve(filePathOrNull);
  if (extname(absPath) === '.css') {
    const result = await sass.compileStringAsync(readFileSync(absPath, 'utf8'), {
      syntax: 'scss',
      style: 'compressed',
      sourceMap: false,
    });
    return result.css;
  } else {
    const result = await sass.compileAsync(absPath, {
      style: 'compressed',
      sourceMap: false,
    });
    return result.css;
  }
}

// ---------------------------------------------------------------------------
// Step 2: parse canonical CSS and build rule maps
// ---------------------------------------------------------------------------

/**
 * Normalise a selector string:
 *   - trim whitespace
 *   - collapse inner whitespace runs to single space
 */
function normaliseSelector(sel) {
  return sel.trim().replace(/\s+/g, ' ');
}

/**
 * Normalise an at-rule params string (e.g. "(max-width:640px)"):
 *   - trim + collapse whitespace
 */
function normaliseAtParams(params) {
  return (params || '').trim().replace(/\s+/g, ' ');
}

/**
 * Collect declarations from a postcss Rule/Declaration walk and return a
 * canonical form suitable for order-insensitive comparison.
 *
 * When all property NAMES are distinct → sorted array (benign reordering of
 * distinct properties is still reported EQUIVALENT — e.g. Phase 2 mixin inlining
 * legitimately reorders distinct properties).
 *
 * When any property NAME appears more than once (duplicate property) → the rule
 * is order-sensitive (CSS last-wins), so the canonical form is the positional
 * (source-order) list, NOT sorted.  This ensures .foo{color:red;color:blue} and
 * .foo{color:blue;color:red} are reported NOT EQUIVALENT.
 *
 * NOTE: shorthand/longhand interleaving across DIFFERENT property names (e.g.
 * background + background-color) is NOT detected here; the final visual smoke
 * test is the backstop for that edge case.
 */
function collectDeclarations(node) {
  const decls = [];
  node.each((child) => {
    if (child.type === 'decl') {
      decls.push(`${child.prop}:${child.value}`);
    }
  });

  // Check whether any property name is repeated.
  const propNames = decls.map((d) => d.slice(0, d.indexOf(':')));
  const hasDuplicateProp = propNames.length !== new Set(propNames).size;

  // Order-sensitive canonical form for duplicate-property rules; sorted otherwise.
  return hasDuplicateProp ? decls : decls.slice().sort();
}

/**
 * Build the canonical context string for a chain of at-rules wrapping a node.
 * E.g.: "@media (max-width:640px)" or "@supports (display:grid)||@media print"
 * Returns '' for top-level rules.
 */
function atContext(node) {
  const parts = [];
  let cur = node.parent;
  while (cur && cur.type !== 'root') {
    if (cur.type === 'atrule') {
      parts.unshift(`@${cur.name} ${normaliseAtParams(cur.params)}`);
    }
    cur = cur.parent;
  }
  return parts.join('||');
}

/**
 * Walk a postcss Root and return two maps:
 *
 *   ruleMap:  Map<"<at-context>||<selector>", string[]>
 *             where string[] is sorted declarations ["color:red", "margin:0", ...]
 *             Multi-selector rules are expanded: one entry per selector.
 *
 *   keyframesMap: Map<"<keyframes-name>", Map<"<selector>", string[]>>
 *             outer key = animation name, inner key = frame selector (e.g. "from","to","50%")
 *             inner value = sorted declarations
 */
function buildMaps(root) {
  const ruleMap = new Map();
  const keyframesMap = new Map();

  root.walk((node) => {
    // Handle @keyframes blocks specially
    if (node.type === 'atrule' && node.name === 'keyframes') {
      const name = normaliseAtParams(node.params);
      const frames = new Map();
      node.each((frame) => {
        if (frame.type === 'rule') {
          const frameKey = normaliseSelector(frame.selector);
          const decls = collectDeclarations(frame);
          // Merge duplicate frame selectors (shouldn't normally exist but be safe)
          if (frames.has(frameKey)) {
            const existing = frames.get(frameKey);
            const merged = Array.from(new Set([...existing, ...decls])).sort();
            frames.set(frameKey, merged);
          } else {
            frames.set(frameKey, decls);
          }
        }
      });
      keyframesMap.set(name, frames);
      // fall through: walk still descends into the frame rules, but the keyframes-parent guard below
      // keeps them out of ruleMap. (A bare return continues the walk; returning false would abort
      // the ENTIRE traversal and drop every rule after this block.)
      return;
    }

    if (node.type === 'rule') {
      // Skip rules that are directly inside @keyframes (handled above)
      if (node.parent && node.parent.type === 'atrule' && node.parent.name === 'keyframes') {
        return;
      }

      const context = atContext(node);
      const decls = collectDeclarations(node);

      // Expand comma-separated selector list → one map entry per selector.
      // Use postcss Rule#selectors (comma-aware) instead of split(',') so that
      // commas inside :is(), :where(), :not(), [attr="x,y"] etc. are not shredded.
      const selectors = node.selectors.map(normaliseSelector);

      for (const sel of selectors) {
        const key = context ? `${context}||${sel}` : sel;
        if (ruleMap.has(key)) {
          // Merge duplicate selectors (can happen after Sass expand)
          const existing = ruleMap.get(key);
          const merged = Array.from(new Set([...existing, ...decls])).sort();
          ruleMap.set(key, merged);
        } else {
          ruleMap.set(key, decls);
        }
      }
    }
  });

  return { ruleMap, keyframesMap };
}

// ---------------------------------------------------------------------------
// Step 3: compare two maps and produce a structured diff
// ---------------------------------------------------------------------------

function setsEqual(a, b) {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}
// (setsEqual is kept for potential future use; currently compareMaps uses arraysEqual)

function arraysEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Compare two Maps<key, string[]> and return diff info.
 */
function compareMaps(mapA, mapB) {
  const onlyInA = [];
  const onlyInB = [];
  const different = [];

  const keysA = new Set(mapA.keys());
  const keysB = new Set(mapB.keys());

  for (const k of keysA) {
    if (!keysB.has(k)) {
      onlyInA.push(k);
    } else if (!arraysEqual(mapA.get(k), mapB.get(k))) {
      different.push({ key: k, a: mapA.get(k), b: mapB.get(k) });
    }
  }
  for (const k of keysB) {
    if (!keysA.has(k)) onlyInB.push(k);
  }

  return { onlyInA, onlyInB, different };
}

/**
 * Compare two keyframe maps:
 *   Map<name, Map<frame-selector, string[]>>
 */
function compareKeyframesMaps(mapA, mapB) {
  const namesA = new Set(mapA.keys());
  const namesB = new Set(mapB.keys());

  const onlyInA = [];
  const onlyInB = [];
  const different = [];

  for (const name of namesA) {
    if (!namesB.has(name)) {
      onlyInA.push(`@keyframes ${name}`);
    } else {
      // Compare frame maps — order-independent
      const framesA = mapA.get(name);
      const framesB = mapB.get(name);
      const diff = compareMaps(framesA, framesB);
      if (diff.onlyInA.length || diff.onlyInB.length || diff.different.length) {
        different.push({
          key: `@keyframes ${name}`,
          frameDiff: diff,
        });
      }
    }
  }
  for (const name of namesB) {
    if (!namesA.has(name)) onlyInB.push(`@keyframes ${name}`);
  }

  return { onlyInA, onlyInB, different };
}

// ---------------------------------------------------------------------------
// Step 4: public API
// ---------------------------------------------------------------------------

/**
 * Compare two CSS/SCSS inputs for render-equivalence.
 *
 * @param {{ fileA?: string, fileB?: string, cssA?: string, cssB?: string }} opts
 *   Pass file paths OR raw CSS strings. fileA/fileB take precedence.
 *
 * @returns {{ equivalent: boolean, report: string }}
 */
export async function compareCss({ fileA, fileB, cssA, cssB }) {
  const [canonA, canonB] = await Promise.all([
    toCanonical(fileA ?? null, fileA ? undefined : cssA),
    toCanonical(fileB ?? null, fileB ? undefined : cssB),
  ]);

  const rootA = postcss.parse(canonA);
  const rootB = postcss.parse(canonB);

  const { ruleMap: ruleMapA, keyframesMap: kfMapA } = buildMaps(rootA);
  const { ruleMap: ruleMapB, keyframesMap: kfMapB } = buildMaps(rootB);

  const ruleDiff = compareMaps(ruleMapA, ruleMapB);
  const kfDiff = compareKeyframesMaps(kfMapA, kfMapB);

  const isEquivalent =
    ruleDiff.onlyInA.length === 0 &&
    ruleDiff.onlyInB.length === 0 &&
    ruleDiff.different.length === 0 &&
    kfDiff.onlyInA.length === 0 &&
    kfDiff.onlyInB.length === 0 &&
    kfDiff.different.length === 0;

  if (isEquivalent) {
    return { equivalent: true, report: 'EQUIVALENT' };
  }

  // Build human-readable diff report
  const lines = ['NOT EQUIVALENT'];

  if (ruleDiff.onlyInA.length) {
    lines.push('', `Rules only in BASELINE (${ruleDiff.onlyInA.length}):`);
    for (const k of ruleDiff.onlyInA) lines.push(`  - ${k}`);
  }
  if (ruleDiff.onlyInB.length) {
    lines.push('', `Rules only in CANDIDATE (${ruleDiff.onlyInB.length}):`);
    for (const k of ruleDiff.onlyInB) lines.push(`  + ${k}`);
  }
  if (ruleDiff.different.length) {
    lines.push('', `Rules with declaration differences (${ruleDiff.different.length}):`);
    for (const { key, a, b } of ruleDiff.different) {
      lines.push(`  ~ ${key}`);
      const setA = new Set(a);
      const setB = new Set(b);
      for (const d of a) if (!setB.has(d)) lines.push(`      - ${d}`);
      for (const d of b) if (!setA.has(d)) lines.push(`      + ${d}`);
    }
  }

  if (kfDiff.onlyInA.length) {
    lines.push('', `@keyframes only in BASELINE (${kfDiff.onlyInA.length}):`);
    for (const k of kfDiff.onlyInA) lines.push(`  - ${k}`);
  }
  if (kfDiff.onlyInB.length) {
    lines.push('', `@keyframes only in CANDIDATE (${kfDiff.onlyInB.length}):`);
    for (const k of kfDiff.onlyInB) lines.push(`  + ${k}`);
  }
  if (kfDiff.different.length) {
    lines.push('', `@keyframes with frame differences (${kfDiff.different.length}):`);
    for (const { key, frameDiff } of kfDiff.different) {
      lines.push(`  ~ ${key}`);
      for (const f of frameDiff.onlyInA) lines.push(`      - frame ${f}`);
      for (const f of frameDiff.onlyInB) lines.push(`      + frame ${f}`);
      for (const { key: fk, a, b } of frameDiff.different) {
        lines.push(`      ~ frame ${fk}`);
        const setA = new Set(a);
        const setB = new Set(b);
        for (const d of a) if (!setB.has(d)) lines.push(`          - ${d}`);
        for (const d of b) if (!setA.has(d)) lines.push(`          + ${d}`);
      }
    }
  }

  return { equivalent: false, report: lines.join('\n') };
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

// Detect direct invocation: compare import.meta.url against the resolved URL of
// the entry-point script so the check is exact (no substring false-positives).
const isMain =
  typeof process !== 'undefined' &&
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const [, , fileA, fileB] = process.argv;
  if (!fileA || !fileB) {
    console.error('usage: node scripts/css-equiv.mjs <baseline.css|scss> <candidate.css|scss>');
    process.exit(2);
  }

  try {
    const result = await compareCss({ fileA, fileB });
    console.log(result.report);
    process.exit(result.equivalent ? 0 : 1);
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(2);
  }
}
