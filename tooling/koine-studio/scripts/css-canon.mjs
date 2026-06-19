// Compile any .scss/.css file to canonical compressed CSS and print to stdout.
// Sass infers its parsing syntax from the file extension, and CSS-syntax mode vs
// SCSS-syntax mode serialize some colors differently (e.g. CSS mode keeps
// `transparent`, SCSS mode rewrites it to `rgba(0,0,0,0)`). To compare the
// original styles.css against the new main.scss apples-to-apples, we force a .css
// input through SCSS syntax so BOTH sides normalize identically. An empty diff
// between two canonical outputs then proves the rule set + order are identical.
import * as sass from 'sass-embedded';
import { readFileSync } from 'node:fs';
import { extname } from 'node:path';

const input = process.argv[2];
if (!input) {
  console.error('usage: node scripts/css-canon.mjs <file.scss|file.css>');
  process.exit(2);
}

let result;
if (extname(input) === '.css') {
  // No @use in a plain CSS file, so compiling from a string is safe and lets us
  // pin syntax: 'scss' to match how .scss inputs are normalized.
  result = await sass.compileStringAsync(readFileSync(input, 'utf8'), {
    syntax: 'scss',
    style: 'compressed',
    sourceMap: false,
  });
} else {
  // Path-based compile so relative @use/@forward resolve from the file's directory.
  result = await sass.compileAsync(input, { style: 'compressed', sourceMap: false });
}
process.stdout.write(result.css);
