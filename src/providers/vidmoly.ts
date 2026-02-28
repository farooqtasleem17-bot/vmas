import type { Source } from '../types/sources';

function toAbsoluteUrl(urlOrPath: string, base: string): string {
  try {
    if (!urlOrPath) return urlOrPath;
    if (/^https?:\/\//i.test(urlOrPath)) return urlOrPath;
    return new URL(urlOrPath, base).toString();
  } catch {
    return urlOrPath;
  }
}

function base64UrlEncodeString(str: string): string {
  const bytes = new TextEncoder().encode(str);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  const b64 = btoa(binary);
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export async function extractVidmoly(baseUrl: string): Promise<Source> {
  const parsedUrl = new URL(baseUrl);
  const defaultDomain = `${parsedUrl.protocol}//${parsedUrl.hostname}/`;

  const userAgent = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Mobile Safari/537.36';

  const headers: Record<string, string> = {
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
    Referer: defaultDomain,
    'Accept-Language': 'en-GB,en-US;q=0.9,en;q=0.8',
    'sec-ch-ua': '"Not A(Brand";v="8", "Chromium";v="132"',
    'sec-ch-ua-mobile': '?1',
    'sec-ch-ua-platform': '"Android"',
    'Upgrade-Insecure-Requests': '1',
    'User-Agent': userAgent,
  };

  let res = await fetch(baseUrl, { headers });
  let html: string = await res.text();

  if (html.includes('Please wait') && html.includes('window.location.href = url')) {
    const tokenMatch = html.match(/url \+= '\?t=([^']+)'/);
    if (tokenMatch && tokenMatch[1]) {
      const redirectUrl = `${baseUrl}?t=${tokenMatch[1]}`;
      await new Promise((r) => setTimeout(r, 1500));
      res = await fetch(redirectUrl, { headers });
      html = await res.text();
    }
  }

  let setupText = '';
  const patterns = [
    /const\s+\w+\s*=\s*player\.setup\(\s*\{\s*([\s\S]*?)\s*\}\s*\);/,
    /player\.setup\(\s*\{\s*([\s\S]*?)\s*\}\s*\);/,
    /jwplayer\([^)]*\)\.setup\(\s*\{\s*([\s\S]*?)\s*\}\s*\);/,
    /var\s+player\s*=\s*jwplayer[^;]*;[\s\S]*?player\.setup\(\s*\{\s*([\s\S]*?)\s*\}\s*\);/,
    /\.setup\(\s*\{\s*([\s\S]*?)\s*\}\s*\);/,
    /(?:const|var|let)\s+\w+\s*=\s*\w+\.setup\(\s*\{\s*([\s\S]*?)\s*\}\s*\);/,
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match && match[1]) {
      setupText = `{${match[1]}}`;
      break;
    }
  }

  if (!setupText) {
    const m3u8Match = html.match(/["']([^"']*\.m3u8[^"']*)["']/);
    if (m3u8Match && m3u8Match[1]) {
      setupText = `{sources: [{file:"${m3u8Match[1]}"}], label: "auto"}`;
    } else {
      throw new Error('Vidmoly: JWPlayer setup block not found');
    }
  }

  const imageMatch = setupText.match(/image\s*:\s*["']([^"']+)["']/);
  const posterImage = imageMatch && imageMatch[1] ? toAbsoluteUrl(imageMatch[1], defaultDomain) : undefined;

  const topLabel = (setupText.match(/label\s*:\s*["']([^"']+)["']/) || [])[1];
  const topBitrate = (setupText.match(/bitrate\s*:\s*["']?([0-9]+)["']?/) || [])[1];

  const sources: Array<{ url: string; quality: string }> = [];
  const sourcesArrayMatch = setupText.match(/sources\s*:\s*\([\s\S]*?\)|sources\s*:\s*\[([\s\S]*?)\]/);
  let sourcesContent = '';
  if (sourcesArrayMatch) {
    sourcesContent = sourcesArrayMatch[1] || '';
  }
  if (sourcesContent) {
    const fileMatches = sourcesContent.match(/file\s*:\s*["']([^"']+)["']/g) || [];
    for (const fileMatch of fileMatches) {
      const urlMatch = fileMatch.match(/file\s*:\s*["']([^"']+)["']/);
      if (urlMatch && urlMatch[1]) {
        const abs = toAbsoluteUrl(urlMatch[1], defaultDomain);
        const quality = topLabel || (topBitrate ? `${topBitrate}p` : 'auto');
        sources.push({ url: abs, quality });
      }
    }
  }

  if (sources.length === 0) {
    const sourcesObjMatch = setupText.match(/sources\s*:\s*\{[\s\S]*?file\s*:\s*["']([^"']+)["'][\s\S]*?\}/);
    if (sourcesObjMatch && sourcesObjMatch[1]) {
      const url = toAbsoluteUrl(sourcesObjMatch[1], defaultDomain);
      const quality = topLabel || (topBitrate ? `${topBitrate}p` : 'auto');
      sources.push({ url, quality });
    }
  }

  if (sources.length === 0) {
    const singleFile = (setupText.match(/file\s*:\s*["']([^"']+)["']/) || [])[1];
    if (singleFile) {
      const url = toAbsoluteUrl(singleFile, defaultDomain);
      const quality = topLabel || (topBitrate ? `${topBitrate}p` : 'auto');
      sources.push({ url, quality });
    }
  }

  if (sources.length === 0) {
    const m3u8Matches = setupText.match(/["']([^"']*\.m3u8[^"']*)["']/g) || [];
    for (const m of m3u8Matches) {
      const urlMatch = m.match(/["']([^"']+)["']/);
      if (urlMatch && urlMatch[1]) {
        const url = toAbsoluteUrl(urlMatch[1], defaultDomain);
        const quality = topLabel || (topBitrate ? `${topBitrate}p` : 'auto');
        sources.push({ url, quality });
      }
    }
  }

  if (sources.length === 0) {
    throw new Error('Vidmoly: No sources found');
  }

  const tracks: Array<{ url: string; lang: string; label: string }> = [];
  const tracksBlock = setupText.match(/tracks\s*:\s*\[([\s\S]*?)\]/);
  if (tracksBlock?.[1]) {
    const itemRegex = /\{[\s\S]*?\}/g;
    const items = tracksBlock[1].match(itemRegex) || [];
    for (const item of items) {
      const file = (item.match(/file\s*:\s*["']([^"']+)["']/) || [])[1];
      if (!file) continue;
      const kind = (item.match(/kind\s*:\s*["']([^"']+)["']/) || [])[1] || '';
      const label = (item.match(/label\s*:\s*["']([^"']+)["']/) || [])[1] || kind || 'track';
      const lang = (item.match(/lang(uage)?\s*:\s*["']([^"']+)["']/) || [])[2] || (kind ? kind : 'unknown');
      const url = toAbsoluteUrl(file, defaultDomain);
      tracks.push({ url, lang, label });
    }
  }

  const proxiedSources = sources.map(({ url, quality }) => {
    const proxyPayload = {
      u: url,
      h: {
        'User-Agent': userAgent,
        Referer: defaultDomain,
      },
    };
    const encoded = base64UrlEncodeString(JSON.stringify(proxyPayload));
    const proxiedUrl = `/hls/${encoded}`;
    return { url: proxiedUrl, quality };
  });

  const source: Source = {
    sources: proxiedSources,
    tracks,
    audio: [],
    intro: { start: 0, end: 0 },
    outro: { start: 0, end: 0 },
    headers: {
      'User-Agent': userAgent,
      Referer: defaultDomain,
      ...(posterImage ? { 'X-Poster': posterImage } : {}),
    },
  };

  return source;
}