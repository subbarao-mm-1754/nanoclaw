import fs from 'fs';
import path from 'path';

function walk(d, acc = []) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (e.name.endsWith('.ts') && !e.name.endsWith('.test.ts')) acc.push(p);
  }
  return acc;
}

function importsOf(file) {
  const t = fs.readFileSync(file, 'utf8');
  const re = /from\s+['"]([^'"]+)['"]/g;
  const m = [];
  let x;
  while ((x = re.exec(t))) m.push(x[1]);
  return m;
}

function resolveShared(fromFile, spec, allowRoots) {
  if (!spec.startsWith('.')) return null;
  const dir = path.dirname(fromFile);
  let abs = path.normalize(path.join(dir, spec.replace(/\.js$/, '.ts')));
  const src = path.resolve('src');
  let rel = path.relative(src, abs).replace(/\\/g, '/');
  if (rel.startsWith('..')) return null;
  // strip extension variants
  rel = rel.replace(/\.ts$/, '');
  const top = rel.split('/')[0];
  if (allowRoots.has(top)) return null; // stay inside own tree
  return rel;
}

function collect(root, ownTop) {
  const files = walk(root);
  const shared = new Map();
  for (const f of files) {
    for (const spec of importsOf(f)) {
      const s = resolveShared(f, spec, new Set([ownTop]));
      if (s) {
        if (!shared.has(s)) shared.set(s, []);
        shared.get(s).push(path.relative('src', f).replace(/\\/g, '/'));
      }
    }
  }
  return [...shared.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

// Transitive closure of shared deps starting from direct imports
function transitiveFrom(entryFiles) {
  const src = path.resolve('src');
  const visited = new Set();
  const queue = [...entryFiles];
  const sharedModules = new Map(); // module -> importers

  while (queue.length) {
    const f = queue.shift();
    const key = path.relative(src, f).replace(/\\/g, '/');
    if (visited.has(key)) continue;
    visited.add(key);
    if (!fs.existsSync(f)) continue;
    for (const spec of importsOf(f)) {
      if (!spec.startsWith('.')) continue;
      const abs = path.normalize(path.join(path.dirname(f), spec.replace(/\.js$/, '.ts')));
      let rel = path.relative(src, abs).replace(/\\/g, '/');
      if (rel.startsWith('..')) continue;
      rel = rel.replace(/\.ts$/, '');
      const top = rel.split('/')[0];
      // follow into all of src except node_modules
      if (!sharedModules.has(rel)) sharedModules.set(rel, []);
      sharedModules.get(rel).push(key);
      const nextTs = path.join(src, rel + '.ts');
      const nextIndex = path.join(src, rel, 'index.ts');
      if (fs.existsSync(nextTs)) queue.push(nextTs);
      else if (fs.existsSync(nextIndex)) queue.push(nextIndex);
    }
  }
  return [...sharedModules.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

console.log('=== GATEWAY direct shared imports ===');
for (const [m, from] of collect('src/gateway', 'gateway')) {
  console.log(m + '  <- ' + [...new Set(from)].slice(0, 4).join(', '));
}

console.log('\n=== WORKER direct shared imports ===');
for (const [m, from] of collect('src/worker', 'worker')) {
  console.log(m + '  <- ' + [...new Set(from)].slice(0, 4).join(', '));
}

const gwFiles = walk('src/gateway');
const wkFiles = walk('src/worker');

console.log('\n=== GATEWAY transitive closure (all src modules touched) ===');
const gwT = transitiveFrom(gwFiles);
const ownGw = gwT.filter(([m]) => !m.startsWith('gateway/') && !m.startsWith('worker/'));
for (const [m] of ownGw) console.log(m);

console.log('\n=== WORKER transitive closure (all src modules touched) ===');
const wkT = transitiveFrom(wkFiles);
const ownWk = wkT.filter(([m]) => !m.startsWith('gateway/') && !m.startsWith('worker/'));
for (const [m] of ownWk) console.log(m);

console.log('\n=== Classic-host-only candidates (in src root+db+cli+channels+modules, not in gw/wk transitive) ===');
const needed = new Set([...ownGw, ...ownWk].map(([m]) => m));
// also mark gateway/worker themselves as needed
for (const [m] of [...gwT, ...wkT]) needed.add(m);

const allSrc = walk('src').map((f) => path.relative('src', f).replace(/\\/g, '/').replace(/\.ts$/, ''));
const classicish = allSrc.filter((m) => {
  if (m.startsWith('gateway/') || m.startsWith('worker/')) return false;
  if (m.endsWith('.test') || m.includes('.test.')) return false;
  return !needed.has(m);
});
for (const m of classicish.sort()) console.log(m);
