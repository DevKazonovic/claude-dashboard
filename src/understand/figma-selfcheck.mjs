import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const home = realpathSync(mkdtempSync(join(tmpdir(), 'ua-figma-selfcheck-')));
const run = (name, args, env = {}) => {
  const r = spawnSync(process.execPath, [fileURLToPath(new URL(`./scripts/${name}`, import.meta.url)), ...args], { env: { ...process.env, HOME: home, ...env }, encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
};
const dirOf = (fileKey, name) => JSON.parse(run('data-dir.mjs', ['--figma', fileKey, name]).out);
const read = (...p) => JSON.parse(readFileSync(join(...p), 'utf8'));
const KEY = 'AbCdEfGhIjKlMnOpQrStUv';

try {
  const a = dirOf(KEY, 'My App: Design!');
  assert.equal(a.key, 'figma-My-App--Design-');
  assert.deepEqual(read(a.dataDir, 'project.json'), { ...read(a.dataDir, 'project.json'), key: a.key, kind: 'design', figmaFileKey: KEY, figmaFileName: 'My App: Design!' });
  assert.equal(dirOf(KEY, 'Renamed later').key, a.key);
  assert.match(dirOf(`Zz${KEY}`, 'My App: Design!').key, /^figma-My-App--Design--[0-9a-f]{6}$/);
  assert.equal(dirOf(`Yy${KEY}`, 'تصميم').key, `figma-Yy${KEY}`);
  assert.match(dirOf(`Xx${KEY}`, 'x'.repeat(99)).key, /^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,59}$/u);
  assert.equal(run('data-dir.mjs', ['--figma', KEY]).code, 1);
  mkdirSync(join(home, 'code', 'proj'), { recursive: true });
  assert.equal(JSON.parse(run('data-dir.mjs', [join(home, 'code', 'proj')]).out).key, 'proj');

  const raw = join(a.dataDir, 'intermediate', 'figma');
  const writeRaw = () => {
    mkdirSync(raw, { recursive: true });
    writeFileSync(join(raw, 'pages.json'), JSON.stringify([{ id: '0:1', name: 'App' }, { id: '2:1', name: 'Components' }, { id: '3-1', name: 'Settings' }, { id: '4:1', name: 'Empty' }]));
    writeFileSync(join(raw, 'page-0-1.xml'), `<canvas id="0:1" name="App">
  <frame id="1:2" name="Login" x="0" y="0" width="390" height="844" hasMotion="true">
    <instance id="1:3" name="Button" x="20" y="700" width="350" height="48" />
    <text id="1:4" name="Title &amp; &#x2192;" x="20" y="40" width="200" height="30" />
    <frame id="1:5" name="Form" x="20" y="200" width="350" height="300"><instance id="1:6" name="Input" x="0" y="0" width="350" height="40"/></frame>
  </frame>
  <section id="1:7" name="Onboarding"><frame id="1:8" name="Welcome" width="390" height="844"><instance id="1:9" name="Button" width="350" height="48"/></frame></section>
</canvas>`);
    writeFileSync(join(raw, 'page-2-1.xml'), `<?xml version="1.0"?><document><symbol id="2:2" name="Input" width="300" height="40"/>
<frame id="2:3" name="Button" width="200" height="120"><symbol id="2:4" name="State=Default" width="80" height="40"/><symbol id="2:5" name="State=Hover" width="80" height="40"/></frame></document>`);
    writeFileSync(join(raw, 'page-3-1.xml'), JSON.stringify([{ type: 'text', text: '<frame id="3:2" name="Privacy &amp; Data" width="390" height="844"/>' }]));
  };
  writeRaw();

  let r = run('figma-scan.mjs', [a.dataDir, KEY]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.err, /Figma scan: 4 pages, 3 screens, 3 components, 1 sets, 3 instances, 0 tokens/);
  assert.match(r.err, /\[warning\] no metadata for page 4:1/);
  const targets = read(raw, 'targets.json');
  assert.deepEqual(targets.variableDefs, ['1:2', '1:8', '2:2', '2:3', '3:2']);
  assert.deepEqual(targets.screenshots.map((s) => s.file), ['screen-1-2', 'screen-1-8', 'screen-3-2'].map((f) => join(a.dataDir, 'thumbnails', `${f}.png`)));

  writeFileSync(join(raw, 'vars.json'), JSON.stringify({ '1:2': { 'color/primary': '#4F46E5', 'spacing/md': '16', 'Heading/H1': 'Font(family: "Inter", style: Bold, size: 32)' }, '1-8': { 'color/primary': '#4F46E5', flag: 'true' }, '2:3': { 'Shadow/sm': 'Effect(type: DROP_SHADOW)' } }));
  writeFileSync(targets.screenshots[0].file, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]));
  writeFileSync(targets.screenshots[1].file, '<Error>AccessDenied</Error>');
  r = run('figma-scan.mjs', [a.dataDir, KEY]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.err, /4 tokens/);
  const m = read(a.dataDir, 'intermediate', 'scan-manifest.json');
  const node = (id) => m.nodes.find((n) => n.id === id);
  const edge = (s, t, type) => m.edges.some((e) => e.source === s && e.target === t && e.type === type);
  assert.deepEqual(node('screen:1:2').figmaMeta.dimensions, { width: 390, height: 844 });
  assert.equal(node('screen:3:2').name, 'Privacy & Data');
  assert.ok(node('screen:1:8') && node('componentSet:2:3') && node('page:4:1') && !node('instance:1:4'));
  assert.ok(edge('instance:1:3', 'component:2:4', 'instance_of') && edge('instance:1:6', 'component:2:2', 'instance_of'));
  assert.ok(edge('component:2:5', 'componentSet:2:3', 'variant_of') && edge('page:0:1', 'screen:1:8', 'contains'));
  assert.ok(edge('screen:1:2', 'token:spacing:spacing-md', 'uses_token') && edge('screen:1:8', 'token:color:color-primary', 'uses_token'));
  assert.ok(edge('componentSet:2:3', 'token:effect:shadow-sm', 'uses_token') && edge('screen:1:2', 'token:type:heading-h1', 'uses_token'));
  assert.equal(node('token:color:color-primary').figmaMeta.tokenValue, '#4F46E5');
  assert.equal(node('screen:1:2').figmaMeta.thumbnailUrl, `/api/understand/thumb?project=${a.key}&id=screen-1-2`);
  assert.equal(node('screen:1:8').figmaMeta.thumbnailUrl, undefined);
  assert.equal(existsSync(targets.screenshots[1].file), false);
  const batches = read(a.dataDir, 'intermediate', 'design-batches.json');
  assert.deepEqual(batches.batches.flat().map((n) => n.id).sort(), m.nodes.map((n) => n.id).sort());
  assert.deepEqual(batches.batches.flat().find((n) => n.id === 'screen:1:2').tokenUsage.sort(), ['Heading/H1', 'color/primary', 'spacing/md']);

  const inter = join(a.dataDir, 'intermediate');
  writeFileSync(join(inter, 'analysis-batch-1.json'), JSON.stringify({ nodes: [{ id: 'screen:1:2', summary: 'Sign-in screen.', tags: ['auth'] }], edges: [{ source: 'screen:1:2', target: 'screen:1:8', type: 'related', direction: 'forward', weight: 0.5 }] }));
  writeFileSync(join(inter, 'analysis-batch-2.json'), '{ broken');
  r = run('figma-merge.mjs', [a.dataDir]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.err, /skipped analysis-batch-2\.json/);
  const g = read(a.dataDir, 'knowledge-graph.json');
  assert.equal(g.kind, 'design');
  assert.equal(g.nodes.find((n) => n.id === 'screen:1:2').summary, 'Sign-in screen.');
  assert.ok(g.edges.some((e) => e.type === 'related') && g.layers.some((l) => l.id === 'layer:design-system'));
  assert.equal(g.tour[0].title, 'Design System');
  assert.equal(read(a.dataDir, 'meta.json').figmaVersion, m.figmaVersion);

  for (const f of readdirSync(inter)) if (f !== 'scan-manifest.json') rmSync(join(inter, f), { recursive: true, force: true });
  writeRaw();
  r = run('figma-scan.mjs', [a.dataDir, KEY]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.err, /UP_TO_DATE\s*$/);
  assert.equal(existsSync(join(raw, 'targets.json')), false);
  assert.match(run('figma-scan.mjs', [a.dataDir, KEY], { UNDERSTAND_FIGMA_FORCE: '1' }).err, /Figma scan:/);
  assert.equal(run('figma-scan.mjs', [a.dataDir, `Zz${KEY}`]).code, 1);
  assert.equal(run('figma-merge.mjs', [join(home, '.claude', 'understand', 'proj')]).code, 1);
  console.log('figma selfcheck ok');
} finally {
  rmSync(home, { recursive: true, force: true });
}
