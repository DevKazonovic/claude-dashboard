import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = realpathSync(mkdtempSync(join(tmpdir(), 'ua-selfcheck-')));
process.env.HOME = home;
const { resolveUaDir, TreeSitterPlugin, builtinLanguageConfigs } = await import('./core/index.js');

try {
  const root = join(home, '.claude', 'understand');
  const mk = (...p) => { const d = join(home, ...p); mkdirSync(d, { recursive: true }); return realpathSync(d); };
  const a = mk('x', 'proj'), b = mk('y', 'proj'), c = mk('z', 'y', 'proj'), odd = mk('w', '..my app!');

  assert.equal(resolveUaDir(a), join(root, 'proj'));
  assert.equal(JSON.parse(readFileSync(join(root, 'proj', 'project.json'), 'utf8')).projectRoot, a);
  assert.equal(resolveUaDir(b), join(root, 'y-proj'));
  assert.match(resolveUaDir(c), /\/proj-[0-9a-f]{6}$/);
  assert.equal(resolveUaDir(a), join(root, 'proj'));
  assert.equal(resolveUaDir(odd), join(root, 'my-app-'));
  assert.equal(resolveUaDir(join(home, 'missing', 'ghost')), join(root, 'ghost'));
  assert.equal(existsSync(join(root, 'ghost')), false);

  const ts = new TreeSitterPlugin(builtinLanguageConfigs.filter((cfg) => cfg.treeSitter));
  await ts.init();
  const sfc = [
    '<template>',
    '  <div>{{ total }}</div>',
    '</template>',
    '<script setup lang="ts" generic="T extends Record<string, unknown>">',
    "import { ref } from 'vue'",
    "import Child from './Child.vue'",
    'function total(n: number): number {',
    '  return n * 2',
    '}',
    '</script>',
    '<script lang="ts">',
    'export default { name: "Demo" }',
    '</script>',
    '',
  ].join('\n');
  const s = ts.analyzeFile('src/Demo.vue', sfc);
  assert.deepEqual(s.imports.map((i) => [i.source, i.lineNumber]), [['vue', 5], ['./Child.vue', 6]]);
  assert.deepEqual(s.functions.map((f) => [f.name, f.lineRange]), [['total', [7, 9]]]);
  assert.equal(ts.analyzeFileStrict('src/Demo.vue', sfc).status, 'succeeded');
  assert.ok(existsSync(new URL('./grammars/tree-sitter-dart.wasm', import.meta.url)));
  assert.equal(ts.analyzeFile('lib/a.dart', 'class A { void b() {} }\n').classes[0]?.name, 'A');
  console.log('selfcheck ok');
} finally {
  rmSync(home, { recursive: true, force: true });
}
