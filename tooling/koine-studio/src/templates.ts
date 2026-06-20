// The studio's example-domain templates. The data lives in the repo's top-level `templates/`
// directory (the single validated source of truth, issue #101); `scripts/generate-templates.mjs`
// reads each `template.json` + its sibling `.koi` files and emits `src/templates.generated.ts`
// (git-ignored, regenerated on dev/build/test). This module owns the SHAPE and re-exports the data,
// so consumers (welcome.ts, ide.ts) import `Template` / `TEMPLATES` from here, never from the
// generated file directly.

/** A single `.koi` file inside a template's folder. `relPath` is folder-relative, forward-slashed. */
export interface TemplateFile {
  relPath: string;
  contents: string;
}

/**
 * A Koine example domain, assembled from a `templates/<id>/template.json` manifest plus its sibling
 * `.koi` sources. A superset of the old `Example` shape: `source`/`files` drive how it opens in the
 * editor, while the manifest metadata (tagline, difficulty, tags, contexts, …) backs richer listings.
 */
export interface Template {
  /** Stable id; equals the template's folder name. */
  id: string;
  /** Human-readable display name (e.g. "Billing"). */
  name: string;
  /** One-line summary shown in the gallery (the old `Example.blurb`). */
  tagline: string;
  /** A paragraph describing what the template models and demonstrates. */
  description: string;
  /** Relative complexity, used to order and badge templates. */
  difficulty: 'starter' | 'beginner' | 'intermediate' | 'advanced';
  /** Free-form keywords for search and filtering. */
  tags: string[];
  /** Names of the bounded contexts the template defines. */
  contexts: string[];
  /** The headline aggregate that anchors the template. */
  coreAggregate: string;
  /** The primary `.koi` file opened first; its contents are `source`. */
  entryFile: string;
  /** The Koine concepts / DDD patterns a learner picks up from this template. */
  teaches: string[];
  /** An icon identifier (emoji or icon name) for the template card. */
  icon: string;
  /**
   * The model opened in single-file scratch mode — the `entryFile`'s contents. For a multi-file
   * template this is also the representative file used as the fallback when the host can't
   * materialize a workspace.
   */
  source: string;
  /**
   * Every `.koi` file in the template's folder. A template with more than one file opens as a real
   * multi-file workspace (folder mode → the explorer); in directory mode every `.koi` compiles as
   * one model, so the files can span bounded contexts and a context map that references them all.
   */
  files?: TemplateFile[];
}

export { TEMPLATES } from './templates.generated';
