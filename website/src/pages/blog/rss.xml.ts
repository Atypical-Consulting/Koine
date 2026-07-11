// The blog RSS feed served as a *static* endpoint.
//
// `starlight-blog` injects its feed as the dynamic route `/[...prefix]/rss.xml`.
// Under `trailingSlash: 'always'` (astro.config.mjs) Astro cannot tell that spread
// route ends in a file extension, so it normalises the request to `/blog/rss.xml/`
// and the static build aborts with `NoMatchingStaticPathFound` (issue #948) — which
// keeps the whole docs site from deploying.
//
// A *static* endpoint whose filename carries the `.xml` extension is classified as a
// non-HTML file route and is therefore exempt from trailing-slash normalisation, so it
// emits `dist/blog/rss.xml` as a real file. Being static it also outranks the injected
// dynamic route, which Astro then harmlessly skips — so the feed is served without
// relaxing the site-wide `trailingSlash: 'always'` policy. The blog's RSS autodiscovery
// `<link>` and social icon (emitted while `rss` stays enabled) keep pointing at this same
// `/blog/rss.xml`.
//
// Expected, harmless: because the injected `/[...prefix]/rss.xml` route is now shadowed,
// `astro build` prints one WARN ("Could not render `/blog/rss.xml` … conflicts with
// higher priority route"). The build still exits 0 and this endpoint serves the feed.
//
// starlight-blog 0.28's `GET` handler resolves which blog config to render from a
// `prefix` route param and throws `Unknown blog prefix ''` when it's missing (it used to
// tolerate the empty/default prefix on 0.27). Because this static endpoint captures no
// path segments, Astro invokes it with an empty `params`, so delegating straight to the
// upstream handler (as before) no longer works. Derive the default-locale prefix the same
// way the dynamic route's own `getStaticPaths` does and inject it before calling through —
// this keeps the feed contents byte-for-byte identical to upstream.
//
// Single-locale assumption: this static route produces exactly one feed (the default
// locale, i.e. `getStaticPaths()`'s first — and only, single-locale — entry).
// starlight-blog's own dynamic route emits one feed per locale via that same
// `getStaticPaths`; we intentionally only ever take the first entry. If the site ever
// becomes multilingual (astro.config.mjs gains `locales`), revisit this — the per-locale
// feeds would need to be reinstated. See PR #954 follow-ups and issue #959.
import type { APIRoute } from 'astro';
import { GET as blogRSSHandler, getStaticPaths as getBlogRSSStaticPaths } from 'starlight-blog/routes/rss';

export const GET: APIRoute = (context) => {
  const [defaultPath] = getBlogRSSStaticPaths();
  context.params['prefix'] = defaultPath?.params['prefix'];
  return blogRSSHandler(context);
};
