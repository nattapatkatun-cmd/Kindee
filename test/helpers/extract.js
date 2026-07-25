'use strict';
// Pull individual functions out of index.html so the pure calculation logic can be unit
// tested in Node, with no browser and no DOM.
//
// The app is one 12k-line HTML file with no modules and no build step, so there is nothing
// to import. Rather than duplicate the formulas into the tests — which would let the two
// drift apart and quietly stop testing anything — the source of truth is read straight
// from index.html and evaluated. If a function is renamed or deleted, extraction throws
// and the test fails loudly instead of silently passing against a stale copy.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SOURCE = path.resolve(__dirname, '..', '..', 'index.html');

/** Source text of `function <name>(...) { ... }`, brace-matched. */
function functionSource(src, name) {
  const decl = new RegExp('\\nfunction ' + name.replace(/[$]/g, '\\$') + '\\s*\\(');
  const m = decl.exec(src);
  if (!m) throw new Error('extract: function ' + name + ' not found in index.html');
  const start = m.index + 1;
  let i = src.indexOf('{', start);
  let depth = 0;
  for (;;) {
    const ch = src[i];
    if (ch === undefined) throw new Error('extract: unbalanced braces reading ' + name);
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) break;
    }
    i++;
  }
  return src.slice(start, i + 1);
}

/** Source text of a top-level `var NAME = ...;` constant. */
function constSource(src, name) {
  const m = new RegExp('\\nvar ' + name + '\\s*=\\s*[^;\\n]+;').exec(src);
  if (!m) throw new Error('extract: const ' + name + ' not found in index.html');
  return m[0];
}

/**
 * Evaluate the named functions in a sandbox.
 *
 * @param {string[]} names      functions to extract
 * @param {object}   opts.consts  top-level vars to pull in alongside them
 * @param {string}   opts.prelude stub code for collaborators the functions call
 * @returns {object} the sandbox, with every extracted name bound
 */
function load(names, { consts = [], prelude = '' } = {}) {
  const src = fs.readFileSync(SOURCE, 'utf8');
  const parts = [prelude];
  for (const c of consts) parts.push(constSource(src, c));
  for (const n of names) parts.push(functionSource(src, n));
  const sandbox = { console, Math, Date, JSON, parseFloat, parseInt, isFinite, isNaN, String, Number, Array, Object };
  vm.createContext(sandbox);
  vm.runInContext(parts.join('\n\n'), sandbox, { filename: 'index.html:extracted' });
  for (const n of names) {
    if (typeof sandbox[n] !== 'function') throw new Error('extract: ' + n + ' did not evaluate to a function');
  }
  return sandbox;
}

module.exports = { load, functionSource, constSource, SOURCE };
