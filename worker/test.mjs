// Self-check for the admin Worker against an in-memory fake of the GitHub API. Run: node worker/test.mjs
import assert from 'node:assert/strict';
import worker from './src/index.js';

const enc = s => Buffer.from(s).toString('base64');

// Just the GitHub endpoints the Worker uses, on a single-branch repo.
export function fakeGitHub(files) {
  const blobs = new Map(), trees = new Map(), commits = new Map();
  let n = 0;
  const id = () => `sha${++n}`;
  const putBlob = b64 => { const s = id(); blobs.set(s, b64); return s; };
  const root = id();
  trees.set(root, Object.fromEntries(Object.entries(files).map(([p, c]) => [p, putBlob(enc(c))])));
  let head = id();
  commits.set(head, root);

  return async (url, opts = {}) => {
    const { pathname, searchParams } = new URL(url);
    const path = pathname.replace(/^\/repos\/[^/]+\/[^/]+\//, '');
    const method = opts.method || 'GET';
    const body = opts.body && JSON.parse(opts.body);
    const ok = v => new Response(JSON.stringify(v), { status: 200 });
    if (method === 'GET' && path === 'git/ref/heads/main') return ok({ object: { sha: head } });
    if (method === 'GET' && path.startsWith('contents/')) {
      const ref = searchParams.get('ref'), tree = trees.get(commits.get(ref === 'main' ? head : ref));
      const p = path.slice('contents/'.length);
      if (tree[p]) return ok({ sha: tree[p], content: blobs.get(tree[p]) });
      return ok(Object.keys(tree).filter(k => k.startsWith(p + '/')).map(k => ({ name: k.slice(p.length + 1) })));
    }
    if (method === 'GET' && path.startsWith('git/commits/')) return ok({ tree: { sha: commits.get(path.split('/')[2]) } });
    if (method === 'POST' && path === 'git/blobs') return ok({ sha: putBlob(body.content) });
    if (method === 'POST' && path === 'git/trees') {
      const t = { ...trees.get(body.base_tree) };
      for (const e of body.tree) t[e.path] = e.sha ?? putBlob(enc(e.content));
      const s = id(); trees.set(s, t); return ok({ sha: s });
    }
    if (method === 'POST' && path === 'git/commits') { const s = id(); commits.set(s, body.tree); return ok({ sha: s }); }
    if (method === 'PATCH' && path === 'git/refs/heads/main') {
      if (commits.get(head) !== commits.get(body.sha) && !trees.has(commits.get(body.sha))) throw new Error('bad commit');
      head = body.sha; return ok({});
    }
    return new Response('not faked: ' + method + ' ' + path, { status: 404 });
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const menu = [{ name: 'Завтрак', items: [{ name: 'Каша', price: 150, ingredients: 'Овсянка', photo: 'a.webp', nutrition: [100, 3, 2, 20] }] }];
  globalThis.fetch = fakeGitHub({ 'menu.json': JSON.stringify(menu), 'photos/a.webp': 'x' });
  const env = { REPO: 'o/r', BRANCH: 'main', ALLOWED_ORIGIN: 'https://o.github.io', ADMIN_PASSWORD: 'secret pass', GITHUB_TOKEN: 't' };
  const call = async (method, body, pw = 'secret pass') => {
    const res = await worker.fetch(new Request('https://w.dev/menu', {
      method, headers: { Authorization: `Bearer ${pw}` }, body: body && JSON.stringify(body),
    }), env);
    return { status: res.status, body: await res.json(), cors: res.headers.get('Access-Control-Allow-Origin') };
  };
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]).toString('base64');

  let r = await call('GET', null, 'wrong');
  assert.equal(r.status, 401);
  r = await call('GET', null, '');
  assert.equal(r.status, 401);

  r = await call('GET');
  assert.equal(r.status, 200);
  assert.equal(r.cors, 'https://o.github.io');
  assert.deepEqual(r.body.menu, menu);
  const sha0 = r.body.sha;

  // Save: edit, add a dish with a new photo, unknown fields are dropped, text is trimmed.
  const edited = structuredClone(menu);
  edited[0].items[0].price = 175;
  edited[0].items.push({ name: '  Блины ', price: 200, ingredients: '', photo: 'new:1', evil: '<script>' });
  r = await call('POST', { sha: sha0, menu: edited, photos: { 'new:1': jpeg, 'new:2': jpeg } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const saved = r.body.menu[0].items;
  assert.equal(saved[0].price, 175);
  assert.equal(saved[1].name, 'Блины');
  assert.match(saved[1].photo, /^product_\d+_[0-9a-f]{12}\.jpg$/);
  assert.equal(saved[1].evil, undefined);
  r = await call('GET');
  assert.deepEqual(r.body.menu, (await call('GET')).body.menu);
  assert.equal(r.body.menu[0].items[1].photo, saved[1].photo);
  const photoList = await (await fetch(`https://api.github.com/repos/o/r/contents/photos?ref=main`)).json();
  assert.equal(photoList.length, 2, 'only the photo actually used is committed');

  // Stale sha (someone saved in between) is refused, not overwritten.
  r = await call('POST', { sha: sha0, menu: edited, photos: {} });
  assert.equal(r.status, 409);

  const sha1 = (await call('GET')).body.sha;
  const bad = async (m, photos = {}) => (await call('POST', { sha: sha1, menu: m, photos })).status;
  const one = it => [{ name: 'Кат', items: [{ name: 'X', price: 1, ingredients: '', photo: '', ...it }] }];
  assert.equal(await bad(one({ photo: '../index.html' })), 400);
  assert.equal(await bad(one({ photo: 'missing.webp' })), 400);
  assert.equal(await bad(one({ photo: 'new:9' })), 400);
  assert.equal(await bad(one({ photo: 'new:1' }), { 'new:1': enc('<svg/>') }), 400);
  assert.equal(await bad(one({ price: '100' })), 400);
  assert.equal(await bad(one({ price: -1 })), 400);
  assert.equal(await bad(one({ name: '  ' })), 400);
  assert.equal(await bad(one({ nutrition: [1, 2, 3] })), 400);
  assert.equal(await bad('nope'), 400);
  assert.equal((await call('GET')).body.sha, sha1, 'rejected saves change nothing');

  console.log('worker: all checks passed');
}
