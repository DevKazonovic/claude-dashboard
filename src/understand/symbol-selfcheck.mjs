import assert from 'node:assert/strict';

const { TreeSitterPlugin, builtinLanguageConfigs } = await import('./core/index.js');
const { compareFileSymbols } = await import('./scripts/validate-incremental-symbols.mjs');
const parser = new TreeSitterPlugin(builtinLanguageConfigs.filter((config) => config.treeSitter));
await parser.init();

function check(path, before, after, target) {
  const dot = target.indexOf('.');
  const owner = !target.startsWith('class ') && dot > 0 ? target.slice(0, dot) : null;
  const node = target.startsWith('class ')
    ? { id: `class:${path}:${target.slice(6)}`, type: 'class', name: target.slice(6), filePath: path }
    : { id: `function:${path}:${target}`, type: 'function', name: owner ? target.slice(dot + 1) : target, filePath: path };
  const cls = owner && { id: `class:${path}:${owner}`, type: 'class', name: owner, filePath: path };
  const previous = { filePath: path, nodes: cls ? [cls, node] : [node], edges: cls ? [{ source: cls.id, target: node.id, type: 'contains' }] : [] };
  const current = { filePath: path, nodes: cls ? [cls] : [], edges: [] };
  const base = parser.analyzeFileStrict(path, before);
  const head = parser.analyzeFileStrict(path, after);
  assert.equal(base.status, 'succeeded', `${path} base parse`);
  assert.equal(head.status, 'succeeded', `${path} head parse`);
  return compareFileSymbols(previous, current, base, head).missing.map((entry) => entry.status).join();
}

const php = (body) => `<?php\nnamespace App;\n\nuse Foo\\Bar;\n\nclass A extends Bar\n{\n    use HasThing;\n    protected $fillable = ['run'];\n${body}\n}\n`;
const run = '    public function run() {}';
const keep = '    public function keep() { return $this->run(); }';
const cases = [
  ['app/A.php', php(`${run}\n${keep}`), php(keep), 'A.run', 'deleted'],
  ['app/A.php', php(`${run}\n${keep}`), php(`${run}\n${keep}`), 'A.run', 'still-present'],
  ['app/A.php', php(`${run}\n${keep}`), php(`    public function Run() {}\n${keep}`), 'A.run', 'still-present'],
  ['app/A.php', php(`${run}\n${keep}`), `${php(keep)}class B { public function run() {} }\n`, 'A.run', 'deleted'],
  ['app/A.php', php(`${run}\n${keep}`), `${php(keep)}trait T { public function run() {} }\n`, 'A.run', 'deleted'],
  ['app/A.php', php(`${run}\n${keep}`), php(`    use T { keep as run; }\n${keep}`), 'A.run', 'unknown'],
  ['app/A.php', php(`${run}\n${keep}`), php(`    use T { keep as other; }\n${keep}`), 'A.run', 'deleted'],
  ['app/A.php', php(`${run}\n${keep}`), php(`    public function keep() { eval('1;'); }`), 'A.run', 'unknown'],
  ['app/f.php', '<?php\nfunction run() {}\nfunction keep() {}\n', '<?php\nfunction keep() {}\n', 'run', 'deleted'],
  ['app/f.php', '<?php\nfunction run() {}\nfunction keep() {}\n', "<?php\nif (!function_exists('run')) { function run() {} }\nfunction keep() {}\n", 'run', 'unknown'],
  ['app/c.php', '<?php\nclass A {}\nclass B {}\n', '<?php\nclass B {}\n', 'class A', 'deleted'],
  ['app/c.php', '<?php\nclass A {}\nclass B {}\n', "<?php\nclass B {}\nclass_alias(B::class, 'A');\n", 'class A', 'unknown'],
  ['app/c.php', '<?php\nclass A {}\nclass B {}\n', "<?php\nclass B {}\nclass_alias(B::class, 'Other');\n", 'class A', 'deleted'],
  ['app/e.php', '<?php\nenum E { case A; function run() {} function keep() {} }\n', '<?php\nenum E { case A; function keep() {} }\n', 'E.run', 'deleted'],
  ['app/t.php', '<?php\ntrait T { function run() {} function keep() {} }\n', '<?php\ntrait T { function keep() {} }\n', 'T.run', 'deleted'],
  ['app/t.php', '<?php\ntrait T { function run() {} function keep() {} }\n', '<?php\ntrait T { function run() {} function keep() {} }\n', 'T.run', 'still-present'],
  ['app/i.php', '<?php\ninterface I { public function run(); public function keep(); }\n', '<?php\ninterface I { public function keep(); }\n', 'I.run', 'deleted'],
  ['app/i.php', '<?php\ninterface I { public function run(); public function keep(); }\n', '<?php\ninterface I { public function run(); public function keep(); }\n', 'I.run', 'still-present'],
  ['lib/a.dart', 'class A {\n  A(this.x);\n  final int x;\n  void run() {}\n  void keep() {}\n}\n', 'class A {\n  A(this.x);\n  final int x;\n  void keep() {}\n}\n', 'A.run', 'deleted'],
  ['lib/a.dart', 'class A {\n  void run() {}\n  void keep() {}\n}\n', 'class A {\n  void run() {}\n  void keep() {}\n}\n', 'A.run', 'still-present'],
  ['lib/a.dart', 'class A {\n  void run() {}\n  void keep() {}\n}\n', 'class A {\n  final void Function() run = () {};\n  void keep() {}\n}\n', 'A.run', 'unknown'],
  ['lib/a.dart', 'class A {\n  void run() {}\n  void keep() {}\n}\n', 'class A {\n  void keep() {}\n}\nclass B {\n  void run() {}\n}\n', 'A.run', 'deleted'],
  ['lib/a.dart', 'class A {\n  A(this.x);\n  final int x;\n}\n', 'class A {\n  const A(this.x);\n  final int x;\n}\n', 'A.A', 'unknown'],
  ['lib/m.dart', 'mixin M {\n  void run() {}\n  void keep() {}\n}\n', 'mixin M {\n  void keep() {}\n}\n', 'M.run', 'deleted'],
  ['lib/x.dart', 'extension X on String {\n  int get run => 1;\n  int keep() => 2;\n}\n', 'extension X on String {\n  int keep() => 2;\n}\n', 'X.run', 'deleted'],
  ['lib/f.dart', 'void run() {}\nvoid keep() {}\n', 'void keep() {}\n', 'run', 'deleted'],
  ['lib/f.dart', 'void run() {}\nvoid keep() {}\n', 'final run = () {};\nvoid keep() {}\n', 'run', 'unknown'],
  ['src/C.vue', '<template><b/></template>\n<script setup lang="ts">\nfunction run() {}\nfunction keep() {}\n</script>\n', '<template><b/></template>\n<script setup lang="ts">\nfunction keep() {}\n</script>\n', 'run', 'deleted'],
  ['src/C.vue', '<template><b/></template>\n<script setup lang="ts">\nfunction run() {}\nfunction keep() {}\n</script>\n', '<template><b/></template>\n<script setup lang="ts">\nfunction run() {}\nfunction keep() {}\n</script>\n', 'run', 'still-present'],
  ['src/a.js', 'class A { run() {} keep() {} }\n', 'class A { keep() {} }\n', 'A.run', 'deleted'],
  ['src/a.js', 'class A { run() {} keep() {} }\n', 'class A { keep() {} }\nObject.defineProperty(A.prototype, "run", {});\n', 'A.run', 'unknown'],
  ['src/A.java', 'class A { void run() {} void keep() {} }\n', 'class A { void keep() {} }\n', 'A.run', 'unknown'],
];
for (const [path, before, after, target, expected] of cases) {
  assert.equal(check(path, before, after, target), expected, `${path} ${target}: ${after}`);
}
console.log(`symbol selfcheck ok (${cases.length} cases)`);
