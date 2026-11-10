// Pulls WETA Classical's public pages and writes the JSON the prototype reads.
// Runs in GitHub Actions on a schedule (see .github/workflows/scrape.yml). Node 20+, no dependencies.
//   data/live.json     playlists for today and yesterday (all three streams) + who's on air
//   data/content.json  hosts, programs, Classical Score posts
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
  let fresh = true;
  try { const old = JSON.parse(await readFile('data/content.json', 'utf8')); fresh = Date.now() - Date.parse(old.updated) > 55 * 60e3; } catch(e){}
  if(!fresh && !process.env.FORCE_CONTENT) return;
  const [hostsH, scoreH, featH] = await Promise.all([get('/fm/hosts'), get('/fm/classical-score'), get('/fm/features')]);
  const content = {
    updated: new Date().toISOString(),
    hosts: cards(hostsH).filter(c => c.url.includes('/fm/hosts/')).map(c => ({ name: c.title, bio: c.body, img: c.img, imgLarge: c.imgLarge, url: c.url })),
    articles: cards(scoreH).filter(c => c.url.includes('/classical-score/') && !c.url.includes('/topics/')).slice(0, 16).map(c => ({ title: c.title, dek: c.body, img: c.img, imgLarge: c.imgLarge, url: c.url })),
    programs: cards(featH).filter(c => c.url.includes('/fm/features/')).map(c => ({ name: c.title, desc: c.body, img: c.img, imgLarge: c.imgLarge, url: c.url }))
  };
  await writeFile('data/content.json', JSON.stringify(content));
  console.log(`content.json: ${content.hosts.length} hosts, ${content.articles.length} articles, ${content.programs.length} programs`);
}
main().catch(e => { console.error(e); process.exit(1); });
