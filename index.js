const express = require('express');
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));
const { execSync } = require('child_process');
const app = express();

app.use(express.json());
app.use((req, res, next) => { req.startTime = Date.now(); next(); });

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const HEADERS = {
  'User-Agent': UA,
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Connection': 'keep-alive',
  'Upgrade-Insecure-Requests': '1',
};

const JSON_HEADERS = {
  'User-Agent': UA,
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
};

// ─── Retry wrapper ────────────────────────────────────────────────────────────
const RETRIABLE = ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT'];

async function withRetry(fn, maxAttempts = 3, label = '') {
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await fn();
      if (result.status === 'success') return result;
      const msg = (result.error || '').toLowerCase();
      if (msg.includes('not found') || msg.includes('404') || msg.includes('no slug') || msg.includes('invalid url') || msg.includes('premium') || msg.includes('cloudflare') || msg.includes('does not exist')) {
        return result;
      }
      lastErr = result;
      if (attempt < maxAttempts) await sleep(Math.min(300 * 2 ** (attempt - 1), 2000));
    } catch (e) {
      const code = e.cause?.code || e.code || '';
      const isRetriable = RETRIABLE.some(r => code.includes(r) || e.message.includes(r) || e.type === 'request-timeout');
      if (!isRetriable) return { status: 'error', error: `${label}: ${e.message}` };
      lastErr = { status: 'error', error: `${label} (attempt ${attempt}/${maxAttempts}): ${e.message}` };
      if (attempt < maxAttempts) await sleep(Math.min(300 * 2 ** (attempt - 1), 2000));
    }
  }
  return lastErr || { status: 'error', error: `${label}: all ${maxAttempts} attempts failed` };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─── Content helpers ──────────────────────────────────────────────────────────
function decodeHtmlEntities(str) {
  if (!str) return '';
  return str
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)));
}

function stripHtmlTags(html) {
  if (!html) return '';
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function extractFirstUrl(text) {
  if (!text) return null;
  const m = text.match(/https?:\/\/[^\s<>"'\)\]]+/);
  return m ? m[0].replace(/[.,;!?]+$/, '') : null;
}

function pasteResult(content) {
  if (!content || !content.trim()) return { status: 'error', error: 'Paste is empty' };
  const clean = decodeHtmlEntities(stripHtmlTags(content)).trim();
  const url = extractFirstUrl(clean);
  return { status: 'success', result: url || clean, rawContent: clean };
}

// ─── HTML helpers ─────────────────────────────────────────────────────────────
function extractDestFromHtml(html, pageUrl) {
  if (!html) return { status: 'error', error: 'Empty HTML' };
  const candidates = [];

  const img = html.match(/p\['PUBLISHER_IMAGE'\]\s*=\s*['"]([^'"]+)['"]/);
  if (img?.[1]?.startsWith('http') && !img[1].match(/\.(png|jpg|gif|webp|svg)/i)) candidates.push(img[1]);

  const wl = [...html.matchAll(/window\.location(?:\.href)?\s*=\s*["']([^"']{10,})['"]/g)];
  for (const m of wl) if (m[1].startsWith('http') && m[1] !== pageUrl) candidates.push(m[1]);

  const mr = html.match(/<meta[^>]+http-equiv=["']refresh["'][^>]+content=["'][^;]+;\s*url=['"]?([^'">\s]+)/i);
  if (mr?.[1]?.startsWith('http')) candidates.push(mr[1]);

  const og = html.match(/<meta[^>]+property=["']og:url["'][^>]+content=["']([^'"]+)['"]/i);
  if (og?.[1]?.startsWith('http') && og[1] !== pageUrl) candidates.push(og[1]);

  const canon = html.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^'"]+)['"]/i);
  if (canon?.[1]?.startsWith('http') && canon[1] !== pageUrl) candidates.push(canon[1]);

  const du = [...html.matchAll(/data-(?:url|href|link|dest|destination)=["'](https?:\/\/[^'"]{10,})['"]/g)];
  for (const m of du) candidates.push(m[1]);

  const jsonUrls = [...html.matchAll(/"(?:url|link|destination|redirect|target|href)"\s*:\s*"(https?:\/\/[^"]{10,})"/g)];
  for (const m of jsonUrls) if (m[1] !== pageUrl) candidates.push(m[1]);

  const jsUrl = [...html.matchAll(/(?:url|link|href|dest|redirect)\s*=\s*["'](https?:\/\/[^'"]{10,})["']/gi)];
  for (const m of jsUrl) if (m[1] !== pageUrl) candidates.push(m[1]);

  const trackingPatterns = /google|facebook|twitter|analytics|hotjar|tinybird|cloudflare|jquery|bootstrap|cdn|fonts|gstatic|gtag|pixel|adsbygoogle|clerk\./i;
  const filtered = [...new Set(candidates)].filter(u => {
    try { const p = new URL(u); return !trackingPatterns.test(p.hostname); } catch { return false; }
  });

  if (filtered.length > 0) return { status: 'success', result: filtered[0] };
  return { status: 'error', error: 'Could not extract destination URL from page' };
}

// ─── curl-based redirect (bypasses Cloudflare bot blocks that stop node-fetch) ─
function curlEffectiveUrl(url, timeout = 10) {
  try {
    const cmd = `curl -s -o /dev/null -w '%{url_effective}' -L --max-time ${timeout} \
      -A '${UA}' \
      -H 'Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' \
      -H 'Accept-Language: en-US,en;q=0.9' \
      -H 'Connection: keep-alive' \
      '${url.replace(/'/g, "'\\''")}'`;
    return execSync(cmd, { encoding: 'utf8', timeout: (timeout + 2) * 1000 }).trim();
  } catch (_) { return null; }
}

// ─── URL Shorteners (generic fast redirect follower) ─────────────────────────
async function bypassShortener(url) {
  const origin = new URL(url).origin;
  const inputHost = new URL(url).hostname;

  // Strategy 0a: manual redirect — capture Location header directly (no JS)
  try {
    const manual = await fetch(url, {
      method: 'GET',
      headers: { ...HEADERS, 'Referer': origin + '/' },
      redirect: 'manual',
      signal: AbortSignal.timeout(8000),
    });
    const loc = manual.headers.get('location');
    if (loc && loc !== url && loc.startsWith('http')) {
      if (!loc.includes('interstitial') && !loc.includes('safety') && !loc.includes('warning')) {
        return { status: 'success', result: loc };
      }
    }
  } catch (_) {}

  // Strategy 0b: curl redirect follow (bypasses Cloudflare TLS bot check)
  try {
    const effective = curlEffectiveUrl(url, 10);
    if (effective && effective.startsWith('http') && effective !== url) {
      try {
        const baseDomain = h => h.replace(/^www\./, '');
        const effBase = baseDomain(new URL(effective).hostname);
        const inpBase = baseDomain(inputHost);
        if (effBase && effBase !== inpBase) {
          return { status: 'success', result: effective };
        }
      } catch (_) {}
    }
  } catch (_) {}

  // Strategy 1: HEAD request — fastest, follow redirects silently
  try {
    const head = await fetch(url, {
      method: 'HEAD',
      headers: { ...HEADERS, 'Referer': origin + '/' },
      redirect: 'follow',
      signal: AbortSignal.timeout(10000),
    });
    if (head.url && head.url !== url) {
      const dest = head.url;
      if (!dest.includes('interstitial') && !dest.includes('safety') && !dest.includes('warning')) {
        return { status: 'success', result: dest };
      }
    }
  } catch (_) {}

  // Strategy 2: GET request, follow redirect, grab final URL
  try {
    const resp = await fetch(url, {
      headers: { ...HEADERS, 'Referer': origin + '/' },
      redirect: 'follow',
      signal: AbortSignal.timeout(12000),
    });
    if (resp.url && resp.url !== url) {
      return { status: 'success', result: resp.url };
    }
    // Strategy 3: parse HTML for JS/meta redirect
    const html = await resp.text();
    const extracted = extractDestFromHtml(html, resp.url || url);
    if (extracted.status === 'success') return extracted;

    // Strategy 4: meta refresh
    const metaRefresh = html.match(/<meta[^>]+http-equiv=["']?refresh["']?[^>]+content=["'][^"']*url=([^"'\s>]+)/i);
    if (metaRefresh?.[1]) return { status: 'success', result: decodeHtmlEntities(metaRefresh[1]) };

    // Strategy 5: location.href in script
    const locMatch = html.match(/location\.(?:href|replace|assign)\s*[\(=]\s*['"]([^'"]{10,})['"]/);
    if (locMatch?.[1]?.startsWith('http')) return { status: 'success', result: locMatch[1] };

  } catch (e) {
    return { status: 'error', error: `Shortener fetch failed: ${e.message}` };
  }

  return { status: 'error', error: `Could not resolve destination for ${new URL(url).hostname}` };
}

// ─── bit.ly ───────────────────────────────────────────────────────────────────
async function bypassBitly(url) {
  // bit.ly /expand API (no auth needed for simple expand)
  try {
    const parts = new URL(url).pathname.split('/').filter(Boolean);
    const code = parts[parts.length - 1];
    if (code) {
      const api = await fetch(`https://api-ssl.bitly.com/v3/expand?shortUrl=${encodeURIComponent(url)}&login=bitlyapidemo&apiKey=R_0da49e0a9118ff35f52f629d2d71bf07`, {
        headers: JSON_HEADERS, signal: AbortSignal.timeout(8000),
      });
      if (api.ok) {
        const data = await api.json().catch(() => null);
        const long = data?.data?.expand?.[0]?.long_url;
        if (long) return { status: 'success', result: long };
      }
    }
  } catch (_) {}
  return bypassShortener(url);
}

// ─── t.co (Twitter/X) ────────────────────────────────────────────────────────
async function bypassTco(url) {
  // t.co redirects via Location header
  try {
    const resp = await fetch(url, {
      headers: { ...HEADERS, 'Referer': 'https://t.co/' },
      redirect: 'follow',
      signal: AbortSignal.timeout(10000),
    });
    if (resp.url && resp.url !== url) return { status: 'success', result: resp.url };
    const html = await resp.text();
    const card = html.match(/card_url=([^&"'\s]+)/);
    if (card?.[1]) return { status: 'success', result: decodeURIComponent(card[1]) };
    const extracted = extractDestFromHtml(html, url);
    if (extracted.status === 'success') return extracted;
  } catch (e) {
    return { status: 'error', error: `t.co: ${e.message}` };
  }
  return { status: 'error', error: 't.co: could not resolve destination' };
}

// ─── tinyurl.com ─────────────────────────────────────────────────────────────
async function bypassTinyurl(url) {
  try {
    const parts = new URL(url).pathname.split('/').filter(Boolean);
    const code = parts[parts.length - 1];
    if (code) {
      // TinyURL preview page trick
      const preview = await fetch(`https://preview.tinyurl.com/${code}`, {
        headers: HEADERS, redirect: 'follow', signal: AbortSignal.timeout(10000),
      });
      const html = await preview.text();
      const dest = html.match(/id="preview_link"[^>]+href="([^"]+)"/i)
        || html.match(/class="preview-link"[^>]+href="([^"]+)"/i)
        || html.match(/<a[^>]+href="(https?:\/\/[^"]{10,})"[^>]*>.*?Visit this link/i);
      if (dest?.[1]) return { status: 'success', result: decodeHtmlEntities(dest[1]) };
    }
  } catch (_) {}
  return bypassShortener(url);
}

// ─── rebrand.ly ───────────────────────────────────────────────────────────────
async function bypassRebrandly(url) {
  // Strategy 1: curl redirect follow (node-fetch blocked by Cloudflare on rebrand.ly)
  try {
    const effective = curlEffectiveUrl(url, 10);
    if (effective && effective.startsWith('http')) {
      try {
        const effHost = new URL(effective).hostname;
        if (!effHost.includes('rebrandly') && !effHost.includes('rebrand.ly')) {
          return { status: 'success', result: effective };
        }
      } catch (_) {}
    }
  } catch (_) {}
  return bypassShortener(url);
}

// ─── is.gd / v.gd ────────────────────────────────────────────────────────────
async function bypassIsgd(url) {
  try {
    const parsed = new URL(url);
    const code = parsed.pathname.replace(/^\//, '').split('/')[0];
    // API requires full short URL including domain e.g. "is.gd/abc123"
    const shorturl = `${parsed.hostname}/${code}`;
    const api = await fetch(`https://is.gd/forward.php?format=json&shorturl=${encodeURIComponent(shorturl)}`, {
      headers: JSON_HEADERS, signal: AbortSignal.timeout(8000),
    });
    if (api.ok) {
      const data = await api.json().catch(() => null);
      if (data?.url) return { status: 'success', result: data.url };
    }
  } catch (_) {}
  return bypassShortener(url);
}

// ─── Platorelay / Platoboost ──────────────────────────────────────────────────
async function bypassPlatorelay(url) {
  const parsed = new URL(url);
  const ticket = parsed.searchParams.get('d');
  if (!ticket) return { status: 'error', error: "No 'd' parameter found in URL" };
  const origin = parsed.origin;
  try {
    const resp = await fetch(`${origin}/api/session/status?ticket=${encodeURIComponent(ticket)}`, {
      headers: { ...JSON_HEADERS, 'Referer': url, 'Origin': origin },
      signal: AbortSignal.timeout(15000),
    });
    if (!resp.ok) return { status: 'error', error: `Platorelay API returned HTTP ${resp.status}` };
    const data = await resp.json();
    if (!data.success) return { status: 'error', error: data.message || 'Platorelay API returned failure' };
    const key = data.data?.key;
    if (!key) return { status: 'error', error: 'No key in Platorelay response' };
    return { status: 'success', result: key, minutesLeft: data.data?.minutesLeft };
  } catch (e) {
    return { status: 'error', error: `Platorelay: ${e.message}` };
  }
}

// ─── Linkvertise (GraphQL) ────────────────────────────────────────────────────
function lvGql(query, referer) {
  const escaped = JSON.stringify({ query }).replace(/'/g, "'\\''");
  const cmd = `curl -s -X POST 'https://publisher.linkvertise.com/graphql' \
    -H 'Content-Type: application/json' \
    -H 'User-Agent: ${UA}' \
    -H 'Origin: https://linkvertise.com' \
    -H 'Referer: ${referer}' \
    -H 'sec-fetch-site: same-site' \
    -H 'sec-fetch-mode: cors' \
    -H 'Accept: application/json, text/plain, */*' \
    --data '${escaped}' --max-time 15`;
  try {
    const out = execSync(cmd, { encoding: 'utf8', timeout: 20000 });
    return JSON.parse(out);
  } catch (e) {
    throw new Error(`lvGql execSync failed: ${e.message}`);
  }
}

async function bypassLinkvertise(url) {
  const parsed = new URL(url);
  const parts = parsed.pathname.split('/').filter(Boolean);
  if (parts.length < 2) return { status: 'error', error: 'Invalid Linkvertise URL. Expected: linkvertise.com/USER_ID/LINK_ID' };
  const userId = parts[0];
  const linkId = parts[1];
  const referer = `https://linkvertise.com/${userId}/${linkId}?o=sharing`;
  const input = `userIdAndUrl: { user_id: ${userId}, url: "${linkId}" }`;
  const contentQ = `{ getContent(input: { ${input} }) { __typename ... on ContentAccessTaskSet { tasks { __typename ... on WaitTask { id } ... on AdTask { id } ... on SocialTask { id } ... on PremiumTask { id } } } ... on DetailPageTargetData { type url paste } } }`;
  try {
    for (let round = 0; round < 15; round++) {
      const res = lvGql(contentQ, referer);
      const data = res.data?.getContent;
      if (!data) return { status: 'error', error: 'Linkvertise GraphQL returned no data' };
      if (data.__typename === 'DetailPageTargetData') {
        const result = data.url || data.paste;
        if (!result) return { status: 'error', error: 'Linkvertise: content unlocked but no URL/paste found' };
        return { status: 'success', result };
      }
      const tasks = (data.tasks || []).filter(t => t.__typename !== 'PremiumTask');
      if (tasks.length === 0) return { status: 'error', error: 'Linkvertise: premium subscription required — cannot bypass' };
      for (const task of tasks) {
        try { lvGql(`mutation { startTask(input: { ${input} }, task_id: "${task.id}") { __typename } }`, referer); } catch (_) {}
        try { lvGql(`mutation { completeTask(input: { ${input} }, task_id: "${task.id}") { __typename } }`, referer); } catch (_) {}
      }
    }
  } catch (e) {
    return { status: 'error', error: `Linkvertise: ${e.message}` };
  }
  return { status: 'error', error: 'Linkvertise: max task rounds exceeded' };
}

async function bypassLinkvertisePowered(url) {
  const parsed = new URL(url);
  const parts = parsed.pathname.split('/').filter(Boolean);
  if (parts.length < 2) return { status: 'error', error: `Invalid URL for ${parsed.hostname}. Expected: ${parsed.hostname}/USER_ID/LINK_ID` };
  return bypassLinkvertise(`https://linkvertise.com/${parts[0]}/${parts[1]}?o=sharing`);
}

// ─── Rekonise ─────────────────────────────────────────────────────────────────
async function bypassRekonise(url) {
  const slug = new URL(url).pathname.split('/').filter(Boolean)[0];
  if (!slug) return { status: 'error', error: 'No slug found in Rekonise URL' };
  const apiBase = 'https://api.rekonise.com';
  const headers = { ...JSON_HEADERS, 'Origin': 'https://rekonise.com', 'Referer': url };
  try {
    const infoResp = await fetch(`${apiBase}/social-unlocks/${slug}`, { headers, signal: AbortSignal.timeout(15000) });
    if (!infoResp.ok) return { status: 'error', error: `Rekonise API returned HTTP ${infoResp.status}` };
    const info = await infoResp.json();
    const unlock = info.unlock || info;
    const stepIds = (unlock.steps || []).map(s => s.id);
    const done = await fetch(`${apiBase}/social-unlocks/${slug}/complete`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ steps: stepIds }),
      signal: AbortSignal.timeout(15000),
    });
    if (!done.ok) return { status: 'error', error: `Rekonise complete API returned HTTP ${done.status}` };
    const doneData = await done.json();
    const result = doneData.destinationUrl || doneData.url || doneData.result;
    if (!result) return { status: 'error', error: 'No destination URL from Rekonise' };
    return { status: 'success', result };
  } catch (e) {
    return { status: 'error', error: `Rekonise: ${e.message}` };
  }
}

// ─── link-unlock.com / rkns.link ─────────────────────────────────────────────
async function bypassLinkUnlock(url) {
  const parsed = new URL(url);
  const slug = parsed.pathname.split('/').filter(Boolean)[0];
  if (!slug) return { status: 'error', error: `No slug found in ${parsed.hostname} URL` };

  // rkns.link is a redirect frontend for link-unlock.com
  let apiBase = 'https://api.link-unlock.com';
  let siteOrigin = 'https://link-unlock.com';
  if (parsed.hostname.includes('rkns.link')) {
    siteOrigin = 'https://rkns.link';
    // Follow redirect to get real slug — may land on link-unlock.com or another known service
    try {
      const redir = await fetch(url, { headers: HEADERS, redirect: 'follow', signal: AbortSignal.timeout(10000) });
      if (redir.url && !redir.url.includes('rkns.link')) {
        const redirHost = new URL(redir.url).hostname;
        // Dispatch to the correct bypass for the resolved hostname
        return dispatchByHost(redirHost, redir.url);
      }
    } catch (_) {}
  }

  const headers = { ...JSON_HEADERS, 'Origin': siteOrigin, 'Referer': url };
  try {
    const infoResp = await fetch(`${apiBase}/u/${slug}`, { headers, signal: AbortSignal.timeout(15000) });
    if (!infoResp.ok) return { status: 'error', error: `${parsed.hostname} API returned HTTP ${infoResp.status}` };
    const info = await infoResp.json();
    if (!info.success || !info.unlock) return { status: 'error', error: `${parsed.hostname} returned no unlock data` };
    const stepIds = (info.unlock.steps || []).map(s => s.id);
    const done = await fetch(`${apiBase}/u/${slug}/complete`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ steps: stepIds }),
      signal: AbortSignal.timeout(15000),
    });
    if (!done.ok) return { status: 'error', error: `${parsed.hostname} complete returned HTTP ${done.status}` };
    const doneData = await done.json();
    const result = doneData.destinationUrl || doneData.url || doneData.result;
    if (!result) return { status: 'error', error: `No destination URL from ${parsed.hostname}` };
    return { status: 'success', result };
  } catch (e) {
    return { status: 'error', error: `${parsed.hostname}: ${e.message}` };
  }
}

// ─── paste-drop.com ───────────────────────────────────────────────────────────
async function bypassPasteDrop(url) {
  const parts = new URL(url).pathname.split('/').filter(Boolean);
  const slug = parts[parts.length - 1];
  if (!slug) return { status: 'error', error: 'No slug found in paste-drop.com URL' };
  try {
    const resp = await fetch(`https://paste-drop.com/raw/${slug}`, {
      headers: { ...HEADERS, 'Referer': url, 'Origin': 'https://paste-drop.com' },
      signal: AbortSignal.timeout(15000),
    });
    if (!resp.ok) return { status: 'error', error: `paste-drop returned HTTP ${resp.status}` };
    const html = await resp.text();
    const match = html.match(/<div class="content">([\s\S]*?)<\/div>/i);
    if (!match) return { status: 'error', error: 'Could not find content div in paste-drop page' };
    const content = decodeHtmlEntities(match[1].trim());
    if (!content) return { status: 'error', error: 'paste-drop content is empty' };
    return { status: 'success', result: content };
  } catch (e) {
    return { status: 'error', error: `paste-drop: ${e.message}` };
  }
}

// ─── work.ink ─────────────────────────────────────────────────────────────────
async function bypassWorkInk(url) {
  try {
    const resp = await fetch(url, {
      headers: { ...HEADERS, 'Referer': 'https://work.ink/', 'Sec-Fetch-Dest': 'document', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Site': 'none', 'Sec-Fetch-User': '?1' },
      redirect: 'follow', signal: AbortSignal.timeout(15000),
    });
    if (resp.url && resp.url !== url) return { status: 'success', result: resp.url };
    const html = await resp.text();
    if (html.includes('cf-mitigated') || html.includes('Just a second') || html.includes('challenge-platform')) {
      return { status: 'error', error: 'work.ink is protected by Cloudflare bot challenge' };
    }
    const m = html.match(/window\.location(?:\.href)?\s*=\s*["']([^"']+)["']/);
    if (m && m[1] !== url) return { status: 'success', result: m[1] };
    return { status: 'error', error: 'work.ink: no redirect detected' };
  } catch (e) {
    return { status: 'error', error: `work.ink: ${e.message}` };
  }
}

// ─── loot-link.com / lootlabs.gg / lootdest.org ──────────────────────────────
async function bypassLootLink(url) {
  const parsed = new URL(url);
  let lootlabsUrl = url;
  try {
    if (!parsed.hostname.includes('lootlabs.gg')) {
      const redir = await fetch(url, {
        headers: { ...HEADERS, 'Referer': parsed.origin + '/' },
        redirect: 'follow', signal: AbortSignal.timeout(15000),
      });
      lootlabsUrl = redir.url;
      if (!lootlabsUrl || lootlabsUrl === url) {
        const html = await redir.text();
        const m = html.match(/p\['PUBLISHER_IMAGE'\]\s*=\s*['"]([^'"]+)['"]/);
        if (m && m[1].startsWith('http') && !m[1].match(/\.(png|jpg|jpeg|gif|webp|svg)(\?|#|$)/i)) {
          return { status: 'success', result: m[1] };
        }
        return { status: 'error', error: `Could not follow ${parsed.hostname} redirect to lootlabs.gg` };
      }
    }

    const resp = await fetch(lootlabsUrl, {
      headers: { ...HEADERS, 'Referer': parsed.origin + '/', 'Origin': 'https://links.lootlabs.gg' },
      signal: AbortSignal.timeout(15000),
    });
    if (!resp.ok) return { status: 'error', error: `lootlabs page returned HTTP ${resp.status}` };
    const html = await resp.text();

    const imgMatch = html.match(/p\['PUBLISHER_IMAGE'\]\s*=\s*['"]([^'"]+)['"]/);
    if (imgMatch?.[1]) {
      const result = imgMatch[1];
      if (result.startsWith('http') && !result.match(/\.(png|jpg|jpeg|gif|webp|svg)(\?|#|$)/i)) {
        return { status: 'success', result };
      }
    }
    return extractDestFromHtml(html, lootlabsUrl);
  } catch (e) {
    return { status: 'error', error: `lootlink: ${e.message}` };
  }
}

// ─── sub2unlock family (extended) ────────────────────────────────────────────
// Covers: sub2unlock.com/io/net/online/top, sub2get.com,
//         sub4unlock.com/pro/io, subfinal.com, unlocknow.net, ytsubme.com
async function bypassSub2Unlock(url) {
  const parsed = new URL(url);
  const h = parsed.hostname.replace(/^www\./, '');
  const parts = parsed.pathname.split('/').filter(Boolean);
  const slug = parts[parts.length - 1];
  if (!slug) return { status: 'error', error: `No slug found in ${h} URL` };

  // Map hostname → [siteBase, apiBase]
  const SITE_MAP = {
    'sub2unlock.com':    ['https://sub2unlock.com',    'https://api.sub2unlock.com'],
    'sub2unlock.io':     ['https://sub2unlock.io',     'https://api.sub2unlock.io'],
    'sub2unlock.net':    ['https://sub2unlock.net',    'https://api.sub2unlock.net'],
    'sub2unlock.online': ['https://sub2unlock.online', 'https://api.sub2unlock.online'],
    'sub2unlock.top':    ['https://sub2unlock.top',    'https://api.sub2unlock.top'],
    'sub2get.com':       ['https://www.sub2get.com',   'https://api.sub2get.com'],
    'sub4unlock.com':    ['https://sub4unlock.com',    'https://api.sub4unlock.com'],
    'sub4unlock.pro':    ['https://sub4unlock.pro',    'https://api.sub4unlock.pro'],
    'sub4unlock.io':     ['https://sub4unlock.io',     'https://api.sub4unlock.io'],
    'subfinal.com':      ['https://subfinal.com',      'https://api.subfinal.com'],
    'unlocknow.net':     ['https://unlocknow.net',     'https://api.unlocknow.net'],
    'ytsubme.com':       ['https://ytsubme.com',       'https://api.ytsubme.com'],
  };

  let [siteBase, apiBase] = SITE_MAP[h] || [`https://${h}`, `https://api.${h}`];

  try {
    // Step 1: Fetch page and extract __NEXT_DATA__
    const pageResp = await fetch(`${siteBase}/${slug}`, {
      headers: { ...HEADERS, 'Referer': siteBase + '/' },
      signal: AbortSignal.timeout(15000),
    });
    if (!pageResp.ok) return { status: 'error', error: `${h} page returned HTTP ${pageResp.status}` };
    const html = await pageResp.text();

    // Try __NEXT_DATA__ (Next.js)
    const dataMatch = html.match(/<script id="__NEXT_DATA__"[^>]*>({[\s\S]*?})<\/script>/);
    if (dataMatch) {
      let nextData;
      try { nextData = JSON.parse(dataMatch[1]); } catch { return { status: 'error', error: `${h}: failed to parse __NEXT_DATA__` }; }
      const props = nextData?.props?.pageProps;
      if (props?.statusCode === 404) return { status: 'error', error: `${h}: link not found (${slug})` };
      const sink = props?.sink?.data;

      if (sink?.unlocked_link) return { status: 'success', result: sink.unlocked_link };

      if (sink) {
        const actionHeaders = { ...JSON_HEADERS, 'Content-Type': 'application/json', 'Origin': siteBase, 'Referer': `${siteBase}/${slug}` };
        const blocks = props?.blocks || [];

        await Promise.all(blocks.map(block =>
          fetch(`${apiBase}/api/actions`, {
            method: 'POST', headers: actionHeaders,
            body: JSON.stringify({ block_id: block.id, action: 'unlocked' }),
            signal: AbortSignal.timeout(10000),
          }).catch(() => {})
        ));

        const sinkResp = await fetch(`${apiBase}/api/actions`, {
          method: 'POST', headers: actionHeaders,
          body: JSON.stringify({ sink_id: sink.id, action: 'unlocked' }),
          signal: AbortSignal.timeout(10000),
        }).catch(() => null);

        if (sinkResp?.ok) {
          const sinkData = await sinkResp.json().catch(() => ({}));
          const result = sinkData?.unlocked_link || sinkData?.data?.unlocked_link || sinkData?.url;
          if (result) return { status: 'success', result };
        }

        // Retry page
        const retry = await fetch(`${siteBase}/${slug}`, {
          headers: { ...HEADERS, 'Referer': siteBase + '/' }, signal: AbortSignal.timeout(15000),
        }).catch(() => null);
        if (retry?.ok) {
          const retryHtml = await retry.text();
          const rm = retryHtml.match(/<script id="__NEXT_DATA__"[^>]*>({[\s\S]*?})<\/script>/);
          if (rm) {
            try {
              const rd = JSON.parse(rm[1]);
              const link = rd?.props?.pageProps?.sink?.data?.unlocked_link;
              if (link) return { status: 'success', result: link };
            } catch {}
          }
        }
        return { status: 'error', error: `${h}: could not retrieve unlocked_link` };
      }
    }

    // Fallback: try HTML extraction
    const extracted = extractDestFromHtml(html, url);
    if (extracted.status === 'success') return extracted;

    // Last resort: universal API probe
    return bypassUniversal(url);
  } catch (e) {
    return { status: 'error', error: `${h}: ${e.message}` };
  }
}

// ─── pastebin.com ─────────────────────────────────────────────────────────────
async function bypassPastebin(url) {
  const parts = new URL(url).pathname.split('/').filter(Boolean);
  const id = parts[parts.length - 1];
  if (!id) return { status: 'error', error: 'No paste ID found in pastebin.com URL' };
  try {
    const resp = await fetch(`https://pastebin.com/raw/${id}`, {
      headers: { ...HEADERS, 'Referer': url },
      signal: AbortSignal.timeout(15000),
    });
    if (resp.status === 404) return { status: 'error', error: `pastebin.com: paste '${id}' not found` };
    if (!resp.ok) return { status: 'error', error: `pastebin.com returned HTTP ${resp.status}` };
    const text = await resp.text();
    if (!text.trim()) return { status: 'error', error: 'pastebin.com: paste is empty' };
    return pasteResult(text);
  } catch (e) {
    return { status: 'error', error: `pastebin: ${e.message}` };
  }
}

// ─── rentry.org / rentry.co ───────────────────────────────────────────────────
async function bypassRentry(url) {
  const parsed = new URL(url);
  const parts = parsed.pathname.split('/').filter(Boolean);
  const slug = parts.find(p => p !== 'raw') || parts[parts.length - 1];
  if (!slug) return { status: 'error', error: 'No slug found in rentry URL' };
  try {
    const resp = await fetch(`https://rentry.co/${slug}`, {
      headers: { ...HEADERS, 'Referer': 'https://rentry.co/' },
      redirect: 'follow', signal: AbortSignal.timeout(15000),
    });
    if (resp.status === 404) return { status: 'error', error: `rentry: paste '${slug}' not found` };
    if (!resp.ok) return { status: 'error', error: `rentry returned HTTP ${resp.status}` };
    const html = await resp.text();
    const entryIdx = html.indexOf('entry-text');
    if (entryIdx >= 0) {
      const chunk = html.slice(entryIdx, entryIdx + 8000);
      const artM = chunk.match(/<article[^>]*>([\s\S]{0,6000}?)<\/article>/i);
      if (artM?.[1]) {
        const text = decodeHtmlEntities(stripHtmlTags(artM[1])).trim();
        if (text && text.length > 2) return pasteResult(text);
      }
      const text = decodeHtmlEntities(stripHtmlTags(chunk)).trim();
      if (text && text.length > 2) return pasteResult(text);
    }
    return { status: 'error', error: `rentry: could not extract content for paste '${slug}'` };
  } catch (e) {
    return { status: 'error', error: `rentry: ${e.message}` };
  }
}

// ─── justpaste.it / jpst.it ───────────────────────────────────────────────────
async function bypassJustPaste(url) {
  const parsed = new URL(url);
  let justpasteUrl = url;
  try {
    if (parsed.hostname.includes('jpst.it')) {
      const redir = await fetch(url, { headers: HEADERS, redirect: 'follow', signal: AbortSignal.timeout(10000) });
      justpasteUrl = redir.url;
      if (!justpasteUrl.includes('justpaste.it')) {
        justpasteUrl = url.replace('jpst.it', 'justpaste.it');
      }
    }

    const parsedJP = new URL(justpasteUrl);
    const parts = parsedJP.pathname.split('/').filter(Boolean);
    const slug = parts[parts.length - 1];
    if (!slug) return { status: 'error', error: 'No slug found in justpaste.it URL' };

    const rawResp = await fetch(`https://justpaste.it/raw/${slug}`, {
      headers: { ...HEADERS, 'Referer': justpasteUrl },
      signal: AbortSignal.timeout(15000),
    });
    if (rawResp.ok) {
      const rawHtml = await rawResp.text();
      const contentMatch = rawHtml.match(/<div[^>]+class="[^"]*published-content[^"]*"[^>]*>([\s\S]*?)<\/div>/i)
        || rawHtml.match(/<div[^>]+id="article-data"[^>]*>([\s\S]*?)<\/div>/i)
        || rawHtml.match(/<article[^>]*>([\s\S]*?)<\/article>/i);
      if (contentMatch) {
        const text = decodeHtmlEntities(stripHtmlTags(contentMatch[1])).trim();
        if (text && text.length > 1) return pasteResult(text);
      }
      if (!rawHtml.trim().startsWith('<!DOCTYPE') && !rawHtml.trim().startsWith('<html')) {
        return pasteResult(rawHtml);
      }
      const stripped = decodeHtmlEntities(stripHtmlTags(rawHtml)).trim();
      if (stripped.length > 10) return pasteResult(stripped);
    }
    return { status: 'error', error: `justpaste.it: paste not found or content unavailable` };
  } catch (e) {
    return { status: 'error', error: `justpaste: ${e.message}` };
  }
}

// ─── goldpaster.pro (improved) ────────────────────────────────────────────────
async function bypassGoldPaster(url) {
  const parsed = new URL(url);
  const parts = parsed.pathname.split('/').filter(Boolean);
  const slug = parts[parts.length - 1];
  if (!slug) return { status: 'error', error: 'No slug found in goldpaster.pro URL' };

  try {
    // Strategy 1: Next.js __NEXT_DATA__ page props (most reliable)
    const pageResp = await fetch(url, {
      headers: { ...HEADERS, 'Referer': 'https://goldpaster.pro/' },
      redirect: 'follow', signal: AbortSignal.timeout(15000),
    });

    // If redirect happened to a DIFFERENT domain, result is immediate
    if (pageResp.url && pageResp.url !== url) {
      try {
        const redirOrigin = new URL(pageResp.url).origin;
        if (redirOrigin !== 'https://goldpaster.pro') return { status: 'success', result: pageResp.url };
      } catch {}
    }

    const html = await pageResp.text();

    // Check __NEXT_DATA__
    const nd = html.match(/<script id="__NEXT_DATA__"[^>]*>({[\s\S]*?})<\/script>/);
    if (nd) {
      try {
        const json = JSON.parse(nd[1]);
        const props = json?.props?.pageProps;
        const dest = props?.link?.destination || props?.link?.url || props?.destination || props?.url
          || props?.data?.destination || props?.data?.url;
        if (dest && dest.startsWith('http')) return { status: 'success', result: dest };
        // Sometimes it's in initialState/Redux
        const content = props?.content || props?.paste;
        if (content) return pasteResult(content);
      } catch {}
    }

    // Strategy 2: probe common REST endpoints
    const apiEndpoints = [
      `https://goldpaster.pro/api/link?slug=${slug}`,
      `https://goldpaster.pro/api/link?id=${slug}`,
      `https://goldpaster.pro/api/link/${slug}`,
      `https://goldpaster.pro/api/links/${slug}`,
      `https://goldpaster.pro/api/pastes/${slug}`,
      `https://goldpaster.pro/api/v1/link/${slug}`,
    ];
    for (const ep of apiEndpoints) {
      try {
        const r = await fetch(ep, {
          headers: { ...JSON_HEADERS, 'Referer': url, 'Origin': 'https://goldpaster.pro' },
          signal: AbortSignal.timeout(6000),
        });
        if (r.ok) {
          const data = await r.json().catch(() => null);
          if (data) {
            const link = data.url || data.destination || data.redirect || data.link
              || data.data?.url || data.data?.destination || data.content || data.data?.content;
            if (link && typeof link === 'string' && link.startsWith('http')) {
              // Filter out same-origin results (e.g. goldpaster.pro returning its own homepage)
              try { if (new URL(link).origin === 'https://goldpaster.pro') break; } catch {}
              return { status: 'success', result: link };
            }
            if (link && typeof link === 'string') return pasteResult(link);
          }
        }
      } catch {}
    }

    // Strategy 3: HTML extraction (filter out same-origin results)
    const extracted = extractDestFromHtml(html, url);
    if (extracted.status === 'success') {
      try {
        if (new URL(extracted.result).origin !== 'https://goldpaster.pro') return extracted;
      } catch { return extracted; }
    }

    // Strategy 4: look for paste content in HTML
    const preMatch = html.match(/<pre[^>]*>([\s\S]{3,}?)<\/pre>/i)
      || html.match(/<textarea[^>]*>([\s\S]{3,}?)<\/textarea>/i)
      || html.match(/<code[^>]*>([\s\S]{3,}?)<\/code>/i);
    if (preMatch?.[1]) {
      const text = decodeHtmlEntities(stripHtmlTags(preMatch[1])).trim();
      if (text && text.length > 2) return pasteResult(text);
    }
  } catch (e) {
    return { status: 'error', error: `goldpaster.pro: ${e.message}` };
  }

  return { status: 'error', error: `goldpaster.pro: could not resolve destination for '${slug}'` };
}

// ─── pastescript.com ──────────────────────────────────────────────────────────
async function bypassPasteScript(url) {
  const parts = new URL(url).pathname.split('/').filter(Boolean);
  const id = parts[parts.length - 1];
  if (!id) return { status: 'error', error: 'No paste ID found in pastescript.com URL' };
  try {
    const resp = await fetch(`https://pastescript.com/api/pastes?id=${encodeURIComponent(id)}`, {
      headers: { ...JSON_HEADERS, 'Referer': url },
      signal: AbortSignal.timeout(15000),
    });
    if (!resp.ok) return { status: 'error', error: `pastescript.com API returned HTTP ${resp.status}` };
    const data = await resp.json().catch(() => null);
    if (!data?.success) return { status: 'error', error: 'pastescript.com: API returned failure' };
    const paste = Array.isArray(data.data) ? data.data[0] : data.data;
    if (!paste) return { status: 'error', error: `pastescript.com: paste '${id}' not found` };
    const content = paste.content;
    if (!content) return { status: 'error', error: 'pastescript.com: paste has no content' };
    return pasteResult(content);
  } catch (e) {
    return { status: 'error', error: `pastescript: ${e.message}` };
  }
}

// ─── pastelink.net ────────────────────────────────────────────────────────────
async function bypassPasteLinkNet(url) {
  const parts = new URL(url).pathname.split('/').filter(Boolean);
  const slug = parts[parts.length - 1];
  if (!slug) return { status: 'error', error: 'No slug found in pastelink.net URL' };
  try {
    const resp = await fetch(`https://pastelink.net/${slug}`, {
      headers: { ...HEADERS, 'Referer': 'https://pastelink.net/' },
      signal: AbortSignal.timeout(15000),
    });
    if (resp.status === 404) return { status: 'error', error: `pastelink.net: paste '${slug}' not found` };
    if (!resp.ok) return { status: 'error', error: `pastelink.net returned HTTP ${resp.status}` };
    const html = await resp.text();
    const bodyDisplayMatch = html.match(/<div[^>]+id="body-display"[^>]*>([\s\S]{0,8000}?)<\/div>/i);
    if (bodyDisplayMatch?.[1]) {
      const text = decodeHtmlEntities(stripHtmlTags(bodyDisplayMatch[1])).trim();
      if (text && text.length > 2) return pasteResult(text);
    }
    const fallbacks = [
      html.match(/<div[^>]+id="[^"]*content[^"]*"[^>]*>([\s\S]{10,5000}?)<\/div>/i),
      html.match(/<article[^>]*>([\s\S]{10,5000}?)<\/article>/i),
      html.match(/<pre[^>]*>([\s\S]{2,}?)<\/pre>/i),
    ];
    for (const m of fallbacks) {
      if (m?.[1]) {
        const text = decodeHtmlEntities(stripHtmlTags(m[1])).trim();
        if (text && text.length > 2) return pasteResult(text);
      }
    }
    return { status: 'error', error: `pastelink.net: could not extract content from paste '${slug}'` };
  } catch (e) {
    return { status: 'error', error: `pastelink: ${e.message}` };
  }
}

// ─── pastehill.com ────────────────────────────────────────────────────────────
async function bypassPasteHill(url) {
  const parts = new URL(url).pathname.split('/').filter(Boolean);
  const slug = parts[parts.length - 1];
  if (!slug) return { status: 'error', error: 'No slug found in pastehill.com URL' };
  try {
    const resp = await fetch(`https://pastehill.com/${slug}`, {
      headers: { ...HEADERS, 'Referer': 'https://pastehill.com/' },
      signal: AbortSignal.timeout(15000),
    });
    if (resp.status === 404) return { status: 'error', error: `pastehill.com: paste '${slug}' not found` };
    if (!resp.ok) return { status: 'error', error: `pastehill.com returned HTTP ${resp.status}` };
    const html = await resp.text();
    const selectors = [
      html.match(/<pre[^>]+id="[^"]*(?:paste|code|content)[^"]*"[^>]*>([\s\S]*?)<\/pre>/i),
      html.match(/<div[^>]+class="[^"]*(?:paste-content|code-content|raw-paste)[^"]*"[^>]*>([\s\S]*?)<\/div>/i),
      html.match(/<pre[^>]*>([\s\S]{3,}?)<\/pre>/i),
      html.match(/<code[^>]*>([\s\S]{3,}?)<\/code>/i),
      html.match(/<div[^>]+class="[^"]*(?:card-body)[^"]*"[^>]*>([\s\S]{10,500}?)<\/div>/i),
    ];
    for (const m of selectors) {
      if (m?.[1]) {
        const text = decodeHtmlEntities(stripHtmlTags(m[1])).trim();
        if (text && text.length > 2) return pasteResult(text);
      }
    }
    return { status: 'error', error: `pastehill.com: could not extract content from paste '${slug}'` };
  } catch (e) {
    return { status: 'error', error: `pastehill: ${e.message}` };
  }
}

// ─── pastemode.com ────────────────────────────────────────────────────────────
async function bypassPasteMode(url) {
  const parts = new URL(url).pathname.split('/').filter(Boolean);
  const slug = parts[parts.length - 1];
  if (!slug) return { status: 'error', error: 'No slug found in pastemode.com URL' };
  try {
    const rawResp = await fetch(`https://pastemode.com/raw/${slug}`, {
      headers: { ...HEADERS, 'Referer': url }, signal: AbortSignal.timeout(15000),
    });
    if (rawResp.ok) {
      const rawText = await rawResp.text();
      if (rawText.trim() && !rawText.trim().startsWith('<!DOCTYPE') && !rawText.trim().startsWith('<html')) {
        return pasteResult(rawText);
      }
      const m = rawText.match(/<pre[^>]*>([\s\S]{3,}?)<\/pre>/i);
      if (m?.[1]) {
        const text = decodeHtmlEntities(stripHtmlTags(m[1])).trim();
        if (text && text.length > 2) return pasteResult(text);
      }
    }
    const pageResp = await fetch(`https://pastemode.com/${slug}`, {
      headers: { ...HEADERS, 'Referer': 'https://pastemode.com/' }, signal: AbortSignal.timeout(15000),
    });
    if (!pageResp.ok) return { status: 'error', error: `pastemode.com returned HTTP ${pageResp.status}` };
    const html = await pageResp.text();
    const selectors = [
      html.match(/<pre[^>]+id="[^"]*(?:paste|code|content)[^"]*"[^>]*>([\s\S]*?)<\/pre>/i),
      html.match(/<pre[^>]*class="[^"]*(?:hljs|language|code|paste)[^"]*"[^>]*>([\s\S]*?)<\/pre>/i),
      html.match(/<pre[^>]*>([\s\S]{3,}?)<\/pre>/i),
      html.match(/<textarea[^>]+id="[^"]*(?:paste|code|content)[^"]*"[^>]*>([\s\S]*?)<\/textarea>/i),
    ];
    for (const m of selectors) {
      if (m?.[1]) {
        const text = decodeHtmlEntities(stripHtmlTags(m[1])).trim();
        if (text && text.length > 2) return pasteResult(text);
      }
    }
    return { status: 'error', error: `pastemode.com: could not extract content from paste '${slug}'` };
  } catch (e) {
    return { status: 'error', error: `pastemode: ${e.message}` };
  }
}

// ─── pastecanyon.com ──────────────────────────────────────────────────────────
async function bypassPasteCanyon(url) {
  const parts = new URL(url).pathname.split('/').filter(Boolean);
  const slug = parts[parts.length - 1];
  if (!slug) return { status: 'error', error: 'No slug found in pastecanyon.com URL' };
  try {
    for (const rawPath of [`/raw/${slug}`, `/paste/raw/${slug}`, `/p/${slug}/raw`]) {
      try {
        const r = await fetch(`https://pastecanyon.com${rawPath}`, {
          headers: { ...HEADERS, 'Referer': url }, signal: AbortSignal.timeout(10000),
        });
        if (r.ok) {
          const text = await r.text();
          if (text.trim() && !text.trim().startsWith('<!DOCTYPE') && !text.trim().startsWith('<html')) {
            return pasteResult(text);
          }
        }
      } catch {}
    }
    const resp = await fetch(`https://pastecanyon.com/${slug}`, {
      headers: { ...HEADERS, 'Referer': 'https://pastecanyon.com/' }, signal: AbortSignal.timeout(15000),
    });
    if (!resp.ok) return { status: 'error', error: `pastecanyon.com returned HTTP ${resp.status}` };
    const html = await resp.text();
    const m = html.match(/<pre[^>]*>([\s\S]{3,}?)<\/pre>/i)
      || html.match(/<textarea[^>]*>([\s\S]{3,}?)<\/textarea>/i)
      || html.match(/<code[^>]*>([\s\S]{3,}?)<\/code>/i);
    if (m?.[1]) {
      const text = decodeHtmlEntities(stripHtmlTags(m[1])).trim();
      if (text && text.length > 2) return pasteResult(text);
    }
    return { status: 'error', error: `pastecanyon.com: could not extract paste content for '${slug}'` };
  } catch (e) {
    return { status: 'error', error: `pastecanyon: ${e.message}` };
  }
}

// ─── Universal multi-strategy extractor / fallback ────────────────────────────
async function bypassUniversal(url) {
  let parsed;
  try { parsed = new URL(url); } catch { return { status: 'error', error: 'Invalid URL' }; }

  try {
    const resp = await fetch(url, {
      headers: HEADERS, redirect: 'follow', signal: AbortSignal.timeout(15000),
    });
    if (resp.url && resp.url !== url) {
      const r = await dispatchByHost(new URL(resp.url).hostname, resp.url);
      if (r.status === 'success') return r;
    }
    const html = await resp.text();
    const extracted = extractDestFromHtml(html, resp.url || url);
    if (extracted.status === 'success') return extracted;
  } catch {}

  const slug = parsed.pathname.split('/').filter(Boolean).pop() || parsed.searchParams.get('id') || '';
  const origin = parsed.origin;
  if (slug) {
    const apiCandidates = [
      `${origin}/api/links/${slug}`,
      `${origin}/api/unlock/${slug}`,
      `${origin}/api/get/${slug}`,
      `${origin}/api/social-unlocks/${slug}`,
      `${origin}/api/v1/links/${slug}`,
      `${origin}/api/pastes/${slug}`,
    ];
    for (const apiUrl of apiCandidates) {
      try {
        const r = await fetch(apiUrl, { headers: { ...JSON_HEADERS, 'Referer': url, 'Origin': origin }, signal: AbortSignal.timeout(6000) });
        if (r.ok) {
          const data = await r.json().catch(() => null);
          if (data) {
            const link = data.url || data.link || data.destination || data.redirect || data.unlocked_link || data.destinationUrl || data.content || data.data?.content || data.data?.url;
            if (link && typeof link === 'string') return pasteResult(link);
          }
        }
      } catch {}
    }
  }

  return { status: 'error', error: `No bypass strategy worked for ${parsed.hostname}` };
}

// ─── Dispatch by hostname ─────────────────────────────────────────────────────
async function dispatchByHost(hostname, url) {
  const h = hostname.replace(/^www\./, '');

  // ── URL Shorteners ──────────────────────────────────────────────────────────
  if (h === 'bit.ly' || h === 'bitly.com')                                          return bypassBitly(url);
  if (h === 't.co')                                                                  return bypassTco(url);
  if (h === 'tinyurl.com')                                                           return bypassTinyurl(url);
  if (h === 'rebrand.ly')                                                            return bypassRebrandly(url);
  if (h === 'is.gd' || h === 'v.gd')                                                return bypassIsgd(url);
  if (h === 'cl.gy' || h === 'cutt.ly' || h === 'shorter.me' ||
      h === 'tiny.cc' || h === 'tinylink.onl' ||
      h === '6x.work' || h === 'ify.ac')                                            return bypassShortener(url);

  // ── Unlock/Gate bypass ──────────────────────────────────────────────────────
  if (h.includes('platorelay.com') || h.includes('platoboost'))                     return bypassPlatorelay(url);
  if (h.includes('linkvertise.com'))                                                 return bypassLinkvertise(url);
  if (h.includes('direct-link.net') || h.includes('link-hub.net') || h.includes('link-to.net')) return bypassLinkvertisePowered(url);
  if (h.includes('rekonise.com'))                                                    return bypassRekonise(url);
  if (h.includes('link-unlock.com') || h.includes('rkns.link'))                     return bypassLinkUnlock(url);
  if (h.includes('paste-drop.com'))                                                  return bypassPasteDrop(url);
  if (h.includes('work.ink'))                                                        return bypassWorkInk(url);
  if (h.includes('loot-link.com') || h.includes('lootlabs.gg') || h.includes('lootdest.org')) return bypassLootLink(url);
  if (h.includes('sub2unlock') || h.includes('sub2get') ||
      h.includes('sub4unlock') || h === 'subfinal.com' ||
      h === 'unlocknow.net' || h === 'ytsubme.com')                                 return bypassSub2Unlock(url);

  // ── Paste services ──────────────────────────────────────────────────────────
  if (h === 'pastebin.com')                                                          return bypassPastebin(url);
  if (h === 'rentry.org' || h === 'rentry.co')                                      return bypassRentry(url);
  if (h === 'justpaste.it' || h === 'jpst.it')                                      return bypassJustPaste(url);
  if (h === 'goldpaster.pro')                                                        return bypassGoldPaster(url);
  if (h === 'pastescript.com')                                                       return bypassPasteScript(url);
  if (h === 'pastelink.net')                                                         return bypassPasteLinkNet(url);
  if (h === 'pastehill.com')                                                         return bypassPasteHill(url);
  if (h === 'pastemode.com')                                                         return bypassPasteMode(url);
  if (h === 'pastecanyon.com')                                                       return bypassPasteCanyon(url);

  return bypassUniversal(url);
}

// ─── Routes ────────────────────────────────────────────────────────────────────
app.get('/api/bypass', async (req, res) => {
  const url = req.query.url;
  const elapsed = () => `${((Date.now() - req.startTime) / 1000).toFixed(2)}s`;
  if (!url) return res.status(400).json({ status: 'error', error: "Missing 'url' query parameter", duration: elapsed() });
  let parsed;
  try { parsed = new URL(url); } catch { return res.status(400).json({ status: 'error', error: 'Invalid URL', duration: elapsed() }); }

  const bypassFn = () => dispatchByHost(parsed.hostname, url);
  const result = await withRetry(bypassFn, 3, parsed.hostname);
  result.duration = elapsed();
  return res.status(result.status === 'success' ? 200 : 500).json(result);
});

app.get('/', (req, res) => {
  res.json({
    api: 'GET /api/bypass?url=<encoded_url>',
    supports: {
      Hotdomain: [
        'bit.ly', 'cl.gy', 'cutt.ly', 'is.gd', 'rebrand.ly',
        'rkns.link', 'shorter.me', 't.co', 'tiny.cc', 'tinylink.onl',
        'tinyurl.com', '6x.work', 'ify.ac', 'v.gd',
        'platorelay.com / platoboost',
        'linkvertise.com',
        'direct-link.net / link-hub.net / link-to.net (Linkvertise-powered)',
        'rekonise.com',
        'link-unlock.com / rkns.link',
        'paste-drop.com',
        'loot-link.com / lootlabs.gg / lootdest.org',
        'sub2unlock.com / sub2unlock.io / sub2unlock.net / sub2unlock.online / sub2unlock.top',
        'sub2get.com',
        'sub4unlock.com / sub4unlock.pro / sub4unlock.io',
        'subfinal.com / unlocknow.net / ytsubme.com',
        'work.ink (best-effort)',
        'pastebin.com', 'rentry.org / rentry.co', 'justpaste.it / jpst.it',
        'goldpaster.pro', 'pastescript.com', 'pastelink.net',
        'pastehill.com', 'pastemode.com', 'pastecanyon.com',
      ],
    },
  });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, '0.0.0.0', () => console.log(`Bypass server on port ${PORT}`));
