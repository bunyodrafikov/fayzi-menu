// Admin API for the menu. The admin page (site/admin/) talks only to this Worker; it holds the password and the
// GitHub token as secrets, so neither ever reaches the browser.
//   GET  /menu  -> { menu, sha }                 current menu.json and its blob sha
//   POST /menu  <- { sha, menu, photos }         photos: { "new:<key>": base64 JPEG }; items reference them as photo "new:<key>"
// A save is one commit (menu.json + new photos) on top of main; the Pages workflow then rebuilds the site.
// Every request needs header  Authorization: Bearer <ADMIN_PASSWORD>.

const MAX_PHOTO_BYTES = 6 * 1024 * 1024;
const MAX_NEW_PHOTOS = 20;
const PHOTO_NAME = /^[\w.-]+\.(jpe?g|png|webp)$/i;

export default {
  async fetch(req, env) {
    const cors = {
      'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN,
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      'Access-Control-Allow-Methods': 'GET, POST',
      'Access-Control-Max-Age': '86400',
      Vary: 'Origin',
    };
    const json = (body, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8' } });

    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (new URL(req.url).pathname !== '/menu') return json({ error: 'Not found' }, 404);
    if (!(await passwordOk(req.headers.get('Authorization'), env.ADMIN_PASSWORD))) {
      await new Promise(r => setTimeout(r, 1000)); // slows down guessing
      return json({ error: 'Неверный пароль' }, 401);
    }

    const gh = github(env);
    try {
      if (req.method === 'GET') {
        const file = await gh(`contents/menu.json?ref=${env.BRANCH}`);
        return json({ menu: JSON.parse(fromBase64Utf8(file.content)), sha: file.sha });
      }
      if (req.method === 'POST') {
        const body = await req.json().catch(() => null);
        if (!body || typeof body.sha !== 'string') return json({ error: 'Bad request' }, 400);
        return json(await save(gh, env, body));
      }
      return json({ error: 'Method not allowed' }, 405);
    } catch (e) {
      if (e instanceof UserError) return json({ error: e.message }, e.status);
      console.error(e);
      return json({ error: 'Ошибка сервера, попробуйте ещё раз' }, 502);
    }
  },
};

class UserError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

async function save(gh, env, { sha, menu, photos = {} }) {
  const head = await gh(`git/ref/heads/${env.BRANCH}`);
  const current = await gh(`contents/menu.json?ref=${head.object.sha}`);
  if (current.sha !== sha) throw new UserError('Меню изменилось с момента загрузки. Обновите страницу и повторите.', 409);

  // shortcut: the contents API lists at most 1000 files; move to the git trees API if photos/ ever grows past that.
  const existing = new Set((await gh(`contents/photos?ref=${head.object.sha}`)).map(f => f.name));
  if (typeof photos !== 'object' || photos === null) throw new UserError('Bad request');
  const keys = Object.keys(photos);
  if (keys.length > MAX_NEW_PHOTOS) throw new UserError(`Не больше ${MAX_NEW_PHOTOS} новых фото за раз`);

  // New photos get server-chosen names, so nothing the browser sends ever becomes a path.
  const names = {}, used = new Set();
  const newPhotos = keys.map(key => {
    names[key] = `product_${Date.now()}_${randomHex(6)}.jpg`;
    return { name: names[key], bytes: decodeJpeg(photos[key]) };
  });
  const clean = validateMenu(menu, photo => {
    if (photo.startsWith('new:')) {
      if (!names[photo]) throw new UserError('Фото не загружено');
      used.add(photo);
      return names[photo];
    }
    if (!PHOTO_NAME.test(photo) || !existing.has(photo)) throw new UserError(`Фото не найдено: ${photo}`);
    return photo;
  });

  const tree = [];
  for (const p of newPhotos.filter((_, i) => used.has(keys[i]))) {
    const blob = await gh('git/blobs', 'POST', { content: toBase64(p.bytes), encoding: 'base64' });
    tree.push({ path: `photos/${p.name}`, mode: '100644', type: 'blob', sha: blob.sha });
  }
  tree.push({ path: 'menu.json', mode: '100644', type: 'blob', content: JSON.stringify(clean, null, 1) + '\n' });
  const parent = await gh(`git/commits/${head.object.sha}`);
  const newTree = await gh('git/trees', 'POST', { base_tree: parent.tree.sha, tree });
  const commit = await gh('git/commits', 'POST', {
    message: 'Menu update from admin page',
    tree: newTree.sha,
    parents: [head.object.sha],
  });
  // force:false fails if main moved since we read it, so a concurrent change is never overwritten.
  await gh(`git/refs/heads/${env.BRANCH}`, 'PATCH', { sha: commit.sha, force: false }).catch(e => {
    throw e.status === 422 ? new UserError('Меню изменилось во время сохранения. Обновите страницу и повторите.', 409) : e;
  });
  const saved = await gh(`contents/menu.json?ref=${commit.sha}`);
  return { menu: clean, sha: saved.sha };
}

// Rebuilds the menu from known fields only; anything else in the request is dropped.
export function validateMenu(menu, resolvePhoto) {
  const str = (v, max, what, required) => {
    if (typeof v !== 'string') throw new UserError(`${what}: должно быть текстом`);
    v = v.trim();
    if (required && !v) throw new UserError(`${what}: обязательно`);
    if (v.length > max) throw new UserError(`${what}: слишком длинно (макс. ${max})`);
    return v;
  };
  const num = (v, what) => {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1e7) throw new UserError(`${what}: неверное число`);
    return v;
  };
  if (!Array.isArray(menu) || menu.length > 100) throw new UserError('Неверный формат меню');
  return menu.map((cat, ci) => {
    const cname = str(cat?.name, 80, `Категория ${ci + 1}`, true);
    if (!Array.isArray(cat.items) || cat.items.length > 300) throw new UserError(`${cname}: неверный список блюд`);
    return {
      name: cname,
      items: cat.items.map((it, ii) => {
        const where = `${cname} / ${typeof it?.name === 'string' && it.name.trim() ? it.name.trim() : '#' + (ii + 1)}`;
        const out = {
          name: str(it?.name, 120, `${where}: название`, true),
          price: num(it.price, `${where}: цена`),
          ingredients: str(it.ingredients ?? '', 2000, `${where}: состав`),
          photo: it.photo ? resolvePhoto(str(it.photo, 200, `${where}: фото`)) : '',
        };
        if (it.nutrition != null) {
          if (!Array.isArray(it.nutrition) || it.nutrition.length !== 4) throw new UserError(`${where}: КБЖУ — 4 числа`);
          out.nutrition = it.nutrition.map(v => Math.round(num(v, `${where}: КБЖУ`)));
        }
        return out;
      }),
    };
  });
}

function decodeJpeg(b64) {
  let bytes;
  try { bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0)); } catch { throw new UserError('Фото повреждено'); }
  if (bytes.length > MAX_PHOTO_BYTES) throw new UserError('Фото слишком большое');
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) throw new UserError('Фото должно быть JPEG');
  return bytes;
}

async function passwordOk(header, password) {
  if (!password || !header?.startsWith('Bearer ')) return false;
  // Compare hashes in constant time so response timing reveals nothing about the password.
  const hash = async s => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
  const [a, b] = await Promise.all([hash(header.slice(7)), hash(password)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

function github(env) {
  return async (path, method = 'GET', body) => {
    const res = await fetch(`https://api.github.com/repos/${env.REPO}/${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'menu-admin-worker',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body && { 'Content-Type': 'application/json' }),
      },
      body: body && JSON.stringify(body),
    });
    if (!res.ok) throw Object.assign(new Error(`GitHub ${method} ${path}: ${res.status} ${await res.text()}`), { status: res.status });
    return res.json();
  };
}

const randomHex = n => [...crypto.getRandomValues(new Uint8Array(n))].map(b => b.toString(16).padStart(2, '0')).join('');
const fromBase64Utf8 = b64 => new TextDecoder().decode(Uint8Array.from(atob(b64.replace(/\n/g, '')), c => c.charCodeAt(0)));
function toBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
