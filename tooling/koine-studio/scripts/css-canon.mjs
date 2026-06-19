// Compile any .scss/.css file to canonical compressed CSS and print to stdout.
// CSS is valid SCSS, so this canonicalizes the original styles.css and the new
// main.scss through the SAME pipeline — comments stripped, whitespace normalized.
// An empty diff between two canonical outputs proves the rule set + order are identical.
import * as sass from 'sass-embedded';

const input = process.argv[2];
if (!input) {
  console.error('usage: node scripts/css-canon.mjs <file.scss|file.css>');
  process.exit(2);
}
const result = await sass.compileAsync(input, { style: 'compressed', sourceMap: false });
process.stdout.write(result.css);
