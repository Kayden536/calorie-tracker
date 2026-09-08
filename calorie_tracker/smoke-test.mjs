import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = path.resolve('public');
const pages = fs.readdirSync(root).filter(f => f.endsWith('.html')).sort();
const failures = [];

for (const file of pages) {
  const full = path.join(root, file);
  const html = fs.readFileSync(full, 'utf8');
  if (!/^<!doctype html>/i.test(html.trim())) failures.push(`${file}: missing HTML5 doctype`);
  const ids = [...html.matchAll(/\bid=["']([^"']+)["']/gi)].map(m => m[1]);
  const dup = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (dup.length) failures.push(`${file}: duplicate ids: ${[...new Set(dup)].join(', ')}`);
  for (const match of html.matchAll(/(?:href|src)=["']([^"']+)["']/gi)) {
    const ref = match[1];
    if (!ref || /^(?:https?:|data:|#|mailto:|javascript:)/i.test(ref)) continue;
    const target = path.resolve(path.dirname(full), ref);
    if (!fs.existsSync(target)) failures.push(`${file}: missing local reference ${ref}`);
  }
}

for (const dir of ['public/js', 'server']) {
  for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.js'))) {
    try { execFileSync(process.execPath, ['--check', path.join(dir, file)], { stdio: 'pipe' }); }
    catch { failures.push(`${dir}/${file}: JavaScript syntax check failed`); }
  }
}

if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log(`MacroSync V55 smoke test passed: ${pages.length} HTML pages and JavaScript syntax checks are clean.`);
