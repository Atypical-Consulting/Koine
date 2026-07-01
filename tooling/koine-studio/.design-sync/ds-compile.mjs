// One-off: compile the Studio's 7-1 SCSS entry to plain CSS for the design-sync bundle.
// Not part of the app build — used only to produce ds-bundle/_ds_bundle.css.
import * as sass from 'sass-embedded';
import { writeFileSync } from 'node:fs';

const result = await sass.compile('src/styles/main.scss', {
  style: 'expanded',
  loadPaths: ['src/styles'],
});
writeFileSync('ds-bundle/_ds_bundle.css', result.css);
console.log('compiled', result.css.length, 'bytes');
