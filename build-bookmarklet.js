#!/usr/bin/env node
/*
 * Regenerates bookmarklet.txt from collect.js.
 *
 *   npm install --no-save terser
 *   node build-bookmarklet.js
 */
const fs = require('fs');
const path = require('path');
const { minify } = require('terser');

(async () => {
  const src = fs.readFileSync(path.join(__dirname, 'collect.js'), 'utf8');
  const out = await minify(src, {
    compress: { passes: 2 },
    mangle: true,
    format: { comments: false }
  });
  if (out.error) throw out.error;

  const url = 'javascript:' + encodeURIComponent(out.code);
  fs.writeFileSync(path.join(__dirname, 'bookmarklet.txt'), url + '\n');
  console.log(`bookmarklet.txt written, ${url.length} chars`);
})();
