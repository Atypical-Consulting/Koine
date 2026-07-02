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
// relaxing the site-wide `trailingSlash: 'always'` policy. Re-exporting starlight-blog's
// own handler keeps the feed contents byte-for-byte identical to upstream; the blog's
// RSS autodiscovery `<link>` and social icon (emitted while `rss` stays enabled) keep
// pointing at this same `/blog/rss.xml`.
//
// Expected, harmless: because the injected `/[...prefix]/rss.xml` route is now shadowed,
// `astro build` prints one WARN ("Could not render `/blog/rss.xml` … conflicts with
// higher priority route"). The build still exits 0 and this endpoint serves the feed.
//
// Single-locale assumption: this static route produces exactly one feed (the default
// locale). starlight-blog's own dynamic route emits one feed per locale via its
// `getStaticPaths`; we intentionally omit that (a static route takes no `getStaticPaths`).
// If the site ever becomes multilingual (astro.config.mjs gains `locales`), revisit this —
// the per-locale feeds would need to be reinstated. See PR #954 follow-ups.
export { GET } from 'starlight-blog/routes/rss';
