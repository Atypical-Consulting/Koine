// One canonical base64url(UTF-8) encoder, shared by the playground controller (browser),
// the /playground/ redirect, and the home-page teaser (build-time). Keeping a single copy
// means the Studio `#model=` handoff round-trips no matter which surface produced the link.
// btoa + TextEncoder are global in both modern Node (the Astro build) and the browser.
export function encodeCode(code: string): string {
  const bytes = new TextEncoder().encode(code);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
