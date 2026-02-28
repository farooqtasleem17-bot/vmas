import type { Source } from '../types/sources';

type KimServer = 'vhserver' | 'tserver';

function toAbsoluteUrl(urlOrPath: string, base: string): string {
  try {
    if (!urlOrPath) return urlOrPath;
    if (/^https?:\/\//i.test(urlOrPath)) return urlOrPath;
    if (urlOrPath.startsWith('//')) return `https:${urlOrPath}`;
    return new URL(urlOrPath, base).toString();
  } catch {
    return urlOrPath;
  }
}

function extractIframeSrc(htmlFragment: string): string | undefined {
  const m = String(htmlFragment).match(/<iframe[^>]*?src=["']([^"']+)["'][^>]*?>/i);
  if (m?.[1]) return m[1];
  const m2 = String(htmlFragment).match(/src=\"([^\"]+)\"/);
  if (m2?.[1]) return m2[1];
  return undefined;
}

function parseSourcesFromIframePage(html: string): Array<{ url: string; quality: string }> {
  const sources: Array<{ url: string; quality: string }> = [];
  const text = String(html);
  const blockMatch = text.match(/sources\s*:\s*\[([\s\S]*?)\]/);
  const block = blockMatch ? blockMatch[1] : text;

  const itemRegex = /\{[\s\S]*?\}/g;
  const items = block?.match(itemRegex) || [];
  for (const item of items) {
    const file = (item.match(/file\s*:\s*"([^"]+)"/) || [])[1]
      || (item.match(/"file"\s*:\s*"([^"]+)"/) || [])[1];
    if (!file) continue;
    const label = (item.match(/label\s*:\s*"([^"]+)"/) || [])[1]
      || (item.match(/"label"\s*:\s*"([^"]+)"/) || [])[1] || 'auto';
    sources.push({ url: file, quality: label });
  }

  if (sources.length === 0) {
    const single = (text.match(/file\s*:\s*"([^"]+)"/) || [])[1]
      || (text.match(/"file"\s*:\s*"([^"]+)"/) || [])[1];
    if (single) sources.push({ url: single, quality: 'auto' });
  }
  return sources;
}

function base64UrlEncodeString(str: string): string {
  const bytes = new TextEncoder().encode(str);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  const b64 = btoa(binary);
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export async function extractKimcartoon(episodeId: string, server: KimServer): Promise<Source> {
  const origin = 'https://kimcartoon.si';
  const defaultDomain = `${origin}/`;

  if (!episodeId || typeof episodeId !== 'string') {
    throw new Error('KIMCARTOON: missing episode id');
  }

  const ajaxUrl = `${origin}/ajax/anime/load_episodes_v2?s=${server}`;
  const body = new URLSearchParams({ episode_id: episodeId }).toString();

  const ajaxHeaders: Record<string, string> = {
    'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64; rv:141.0) Gecko/20100101 Firefox/141.0',
    'Accept': 'application/json, text/javascript, */*; q=0.01',
    'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
    'X-Requested-With': 'XMLHttpRequest',
    'Origin': origin,
    'Referer': defaultDomain,
  };

  const ajaxResp = await fetch(ajaxUrl, { method: 'POST', headers: ajaxHeaders, body });
  const text = await ajaxResp.text();
  let payload: any;
  try { payload = JSON.parse(text); } catch { payload = {}; }
  if (!payload?.status) throw new Error('KIMCARTOON: API returned status=false');
  const valueHtml: string | undefined = payload?.value;
  if (!valueHtml) throw new Error('KIMCARTOON: empty iframe html');

  const iframeSrc = extractIframeSrc(valueHtml);
  if (!iframeSrc) throw new Error('KIMCARTOON: iframe src not found');

  const iframeHeaders: Record<string, string> = {
    'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64; rv:141.0) Gecko/20100101 Firefox/141.0',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.5',
    'Sec-Fetch-Dest': 'iframe',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'cross-site',
    'Referer': defaultDomain,
    'Connection': 'keep-alive',
  };

  const iframeResp = await fetch(iframeSrc, { headers: iframeHeaders });
  const iframeHtml = await iframeResp.text();
  const sources = parseSourcesFromIframePage(iframeHtml);
  if (sources.length === 0) throw new Error('KIMCARTOON: no sources found in iframe page');

  const proxiedSources = sources.map((s) => {
    const proxyPayload = {
      u: s.url,
      h: {
        Referer: 'https://em.vidstream.vip/',
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64; rv:141.0) Gecko/20100101 Firefox/141.0',
      },
    };
    const encoded = base64UrlEncodeString(JSON.stringify(proxyPayload));
    const proxiedUrl = `/hls/${encoded}.m3u8`;
    return { url: proxiedUrl, quality: s.quality };
  });

  const source: Source = {
    sources: proxiedSources,
    tracks: [],
    audio: [],
    intro: { start: 0, end: 0 },
    outro: { start: 0, end: 0 },
    headers: {
      Referer: 'https://em.vidstream.vip/',
      'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64; rv:141.0) Gecko/20100101 Firefox/141.0',
    },
  };

  return source;
}