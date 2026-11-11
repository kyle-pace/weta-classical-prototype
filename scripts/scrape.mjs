// Pulls WETA Classical's public pages and writes the JSON the prototype reads.
// Runs in GitHub Actions on a schedule (see .github/workflows/scrape.yml). Node 20+, no dependencies.
//   data/live.json     playlists for today and yesterday (all three streams) + who's on air
//   data/content.json  hosts, programs, Classical Score posts
//   data/pages.json    saved copies of weta.org pages (data/pages/*.html) for the in-app web view
import { writeFile, mkdir, readFile } from 'node:fs/promises';

const BASE = 'https://weta.org';
const UA = 'Mozilla/5.0 (Local Public prototype; contact kyle@localpublic.tv)';
const STREAMS = ['classical', 'vivalavoce', 'virtuoso'];          // order of the three playlist blocks on the page
const FORMS = ['playlist-block-1', 'playlist-block-2', 'playlist-block-5'];

async function get(path){
  const r = await fetch(BASE + path, { headers: { 'user-agent': UA, accept: 'text/html' } });
  if(!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
  return r.text();
}
const decode = s => String(s ?? '')
  .replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, '')
  .replace(/&#0?39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&nbsp;/g, ' ').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
  .replace(/\s+/g, ' ').trim();
const pick = (s, re) => { const m = re.exec(s); return m ? m[1] : ''; };
const abs = u => !u ? '' : u.startsWith('http') ? u.replace(/&amp;/g, '&') : BASE + u.replace(/&amp;/g, '&');
// Drupal image styles carry a token; the original file sits at the same path without the style segment.
const original = u => u ? abs(u).replace(/\/styles\/[^/]+\/public\//, '/').replace(/\?.*$/, '') : '';

/* ---------- Playlists ---------- */
function etDate(offsetDays = 0){
  const d = new Date(Date.now() + offsetDays * 864e5);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}
function parsePlaylists(html){
  const cuts = FORMS.map(f => html.indexOf('views-exposed-form-' + f));
  const out = {};
  STREAMS.forEach((sid, i) => {
    if(cuts[i] < 0){ out[sid] = []; return; }
    const seg = html.slice(cuts[i], i < 2 && cuts[i + 1] > 0 ? cuts[i + 1] : undefined);
    out[sid] = [...seg.matchAll(/<article[^>]*playlist-item[\s\S]*?<\/article>/g)].map(m => {
      const a = m[0];
      return {
        at: pick(a, /<time datetime="([^"]+)"/),
        c: decode(pick(a, /playlist-item__composer">([\s\S]*?)<\/h4>/)),
        w: decode(pick(a, /playlist-item__title">([\s\S]*?)<\/h3>/)),
        p: decode(pick(a, /playlist-item__artist">([\s\S]*?)<\/p>/)).replace(/\s*\|\s*/g, ' · '),
        album: decode(pick(a, /playlist-item__album">([\s\S]*?)<\/div>/))
      };
    }).filter(x => x.at && (x.c || x.w));
  });
  return out;
}

/* ---------- On air (the site's own player page) ---------- */
function parseOnAir(html){
  const out = {};
  [['classical', 'weta'], ['vivalavoce', 'vlv'], ['virtuoso', 'vir']].forEach(([sid, k]) => {
    const i = html.indexOf(`class="on-air__${k}"`); if(i < 0) return;
    const seg = html.slice(i, i + 1500);
    const name = decode(pick(seg, /on-air__name">([\s\S]*?)<\/span>/)).replace(/^Host:\s*/i, '');
    out[sid] = { host: name || null, img: abs(pick(seg, /<img[^>]+src="([^"]+)"/)) };
  });
  return out;
}

/* ---------- Content ---------- */
function cards(html){
  return [...html.matchAll(/<article[^>]*class="[^"]*(?:card|teaser)[^"]*"[\s\S]*?<\/article>/g)].map(m => {
    const a = m[0];
    const img = pick(a, /<img[^>]+src="([^"]+)"/);
    return {
      title: decode(pick(a, /__title">\s*<a[^>]*>([\s\S]*?)<\/a>/)),
      url: abs(pick(a, /__title">\s*<a[^>]*href="([^"]+)"/)),
      body: decode(pick(a, /__body">([\s\S]*?)<\/div>/)),
      img: abs(img), imgLarge: original(img),
      alt: decode(pick(a, /<img[^>]+alt="([^"]*)"/))
    };
  }).filter(c => c.title);
}

/* Classical Score post: dateline, byline, body text and the interview audio from WETA's embedded player */
const ALLOWED = /^(p|h2|h3|h4|h5|h6|em|strong|i|b|a|br|ul|ol|li|blockquote)$/i;
function cleanHtml(h){
  return h.replace(/<(script|style|iframe)[\s\S]*?<\/\1>/gi, '')
    .replace(/<(\/?)([a-z0-9]+)([^>]*)>/gi, (m, close, tag, attrs) => {
      if(!ALLOWED.test(tag)) return '';
      if(tag.toLowerCase() === 'a' && !close){ const href = (attrs.match(/href="([^"]+)"/) || [])[1]; return href ? `<a href="${abs(href)}" target="_blank" rel="noopener">` : '<a>'; }
      return `<${close}${tag.toLowerCase().replace(/^h[56]$/, 'h4')}>`;
    })
    .replace(/&nbsp;/g, ' ').replace(/<p>\s*<\/p>/g, '').replace(/<[^>]*$/, '').trim();
}
async function article(url){
  try {
    const h = await get(url.replace(BASE, ''));
    const date = decode(pick(h, /page-title__dateline">([\s\S]*?)<\/p>/)).replace(/\s*-\s*/, ', ');
    const by = decode(pick(h, /field--name-field-byline[\s\S]*?field__item">([\s\S]*?)<\/div>/));
    // Each body field runs until the next content block; nested media divs are dropped by cleanHtml.
    const main = h.slice(h.indexOf('<main'), h.indexOf('</main>') > 0 ? h.indexOf('</main>') : undefined);
    const bodies = main.split(/field--name-field-body[^>]*>/).slice(1).map(seg => cleanHtml(seg.split(/l-content-flow__item|<\/section>/)[0].replace(/^[^<]*/, ''))).filter(Boolean);
    // Broadcast-time notes ("The interview can also be heard on…") read better after the article
    bodies.sort((x, y) => (/^<h4>/.test(x) ? 1 : 0) - (/^<h4>/.test(y) ? 1 : 0));
    const player = pick(h, /<iframe[^>]+src="(https:\/\/weta-rss\.streamguys1\.com\/player\/[^"]+)"/);
    let audio = '', audioDur = 0;
    if(player){ try { const ph = await (await fetch(player, { headers: { 'user-agent': UA } })).text();
      audio = pick(ph, /(https?:\/\/[^"' ]+\.(?:mp3|m4a))/); audioDur = +pick(ph, /"duration"\s*:\s*(\d+)/) || 0; } catch(e){} }
    return { date, by, body: bodies.join('\n'), audio, audioDur };
  } catch(e){ return {}; }
}

/* ---------- Saved copies of weta.org pages ----------
   weta.org won't load inside another site's frame, so the web prototype can't show live pages in its
   in-app web view. Instead it shows these copies: the page without its scripts, with the site's header,
   menus, footer and cookie banner hidden (the same rules as the iPhone app's web view kit). Refreshed hourly
   with content.json. data/pages.json lists them by path. */
const PAGE_PATHS = ['/fm', '/fm/opera', '/fm/hosts', '/fm/waystolisten', '/fm/features', '/fm/classical-score', '/support/waystogive', '/fm/opera/opera-at-eight'];
const TIDY = `header.masthead, footer.page-footer, .pbs-app-menu, #block-main-menu, .weta-play-ad__wrapper,
  [id^="js-dfp-tag"], .klaro, .cookie-notice, .cookie-modal, .skip-link, .visually-hidden-focusable { display: none !important; }
  html, body { overflow-x: hidden; }`;
const pageFile = p => 'pages/' + (p.replace(/^\/|\/$/g, '').replace(/[^a-z0-9]+/gi, '-') || 'home') + '.html';

function savedCopy(html){
  const title = decode(pick(html, /<title>([\s\S]*?)<\/title>/)).replace(/\s*\|\s*WETA.*$/i, '');
  const head = pick(html, /<head[^>]*>([\s\S]*?)<\/head>/);
  // The site's stylesheets, plus inline styles from the head (the page's banner image is set there)
  const css = [...head.matchAll(/<link[^>]+rel="stylesheet"[^>]*>|<style[^>]*>[\s\S]*?<\/style>/g)].map(m => m[0]).join('\n');
  const bodyAttrs = pick(html, /<body([^>]*)>/);
  const body = pick(html, /<body[^>]*>([\s\S]*)<\/body>/)
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, '')
    .replace(/<iframe[^>]+(googletagmanager|doubleclick)[\s\S]*?<\/iframe>/gi, '')
    .replace(/\sdata-src="([^"]+)"/g, ' src="$1"')
    .replace(/name="form_build_id" value="[^"]*"/g, '');
  const out = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><base href="${BASE}/"><title>${title}</title>
${css}
<style>${TIDY}</style></head><body${bodyAttrs}>${body}</body></html>`;
  return { title, html: out };
}

async function savePages(content){
  await mkdir('data/pages', { recursive: true });
  const paths = new Set(PAGE_PATHS);
  for(const x of [...content.programs, ...content.hosts, ...content.articles]) if(x.url) paths.add(new URL(x.url).pathname.replace(/\/$/, ''));
  const index = {};
  const list = [...paths];
  for(let i = 0; i < list.length; i += 4){
    await Promise.all(list.slice(i, i + 4).map(async p => {
      try { const { title, html } = savedCopy(await get(p)); const file = pageFile(p);
        await writeFile('data/' + file, html); index[p] = { file, title }; } catch(e){ console.warn('page', p, e.message); }
    }));
  }
  await writeFile('data/pages.json', JSON.stringify({ updated: new Date().toISOString(), pages: index }));
  console.log(`pages: ${Object.keys(index).length} saved copies`);
}

async function main(){
  await mkdir('data', { recursive: true });
  const [today, yday, player] = await Promise.all([
    get('/fm/playlists?date=' + etDate(0)),
    get('/fm/playlists?date=' + etDate(-1)).catch(() => ''),
    get('/player').catch(() => '')
  ]);
  const t = parsePlaylists(today), y = yday ? parsePlaylists(yday) : {};
  const plays = {};
  STREAMS.forEach(sid => {
    const seen = new Set();
    plays[sid] = [...(t[sid] || []), ...(y[sid] || [])]
      .filter(x => !seen.has(x.at) && seen.add(x.at))
      .sort((a, b) => a.at < b.at ? -1 : 1);
  });
  const total = STREAMS.reduce((n, s) => n + plays[s].length, 0);
  if(!total) throw new Error('No playlist items parsed; the page layout may have changed');
  const live = { updated: new Date().toISOString(), source: BASE + '/fm/playlists', onAir: player ? parseOnAir(player) : {}, plays };
  await writeFile('data/live.json', JSON.stringify(live));
  console.log('live.json:', STREAMS.map(s => `${s} ${plays[s].length}`).join(', '), JSON.stringify(live.onAir));

  // Content changes slowly: refresh it at most once an hour.
  let fresh = true, old = null;
  try { old = JSON.parse(await readFile('data/content.json', 'utf8')); fresh = Date.now() - Date.parse(old.updated) > 55 * 60e3; } catch(e){}
  if(!fresh && !process.env.FORCE_CONTENT){
    // First run with saved pages: make them from the content we already have
    try { await readFile('data/pages.json'); } catch(e){ await savePages(old); }
    return;
  }
  const [hostsH, scoreH, featH] = await Promise.all([get('/fm/hosts'), get('/fm/classical-score'), get('/fm/features')]);
  const content = {
    updated: new Date().toISOString(),
    hosts: cards(hostsH).filter(c => c.url.includes('/fm/hosts/')).map(c => ({ name: c.title, bio: c.body, img: c.img, imgLarge: c.imgLarge, url: c.url })),
    articles: cards(scoreH).filter(c => c.url.includes('/classical-score/') && !c.url.includes('/topics/')).slice(0, 16).map(c => ({ title: c.title, dek: c.body, img: c.img, imgLarge: c.imgLarge, url: c.url })),
    programs: cards(featH).filter(c => c.url.includes('/fm/features/')).map(c => ({ name: c.title, desc: c.body, img: c.img, imgLarge: c.imgLarge, url: c.url }))
  };
  for(const a of content.articles) Object.assign(a, await article(a.url));
  await writeFile('data/content.json', JSON.stringify(content));
  console.log(`content.json: ${content.hosts.length} hosts, ${content.articles.length} articles, ${content.programs.length} programs`);
  await savePages(content);
}
main().catch(e => { console.error(e); process.exit(1); });
