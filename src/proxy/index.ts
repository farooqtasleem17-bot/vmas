interface ProxyPayload {
    u: string;
    h: Record<string, string>;
  }
  
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
  
  function base64UrlEncode(str: string): string {
    const bytes = new TextEncoder().encode(str);
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
    const b64 = btoa(bin);
    return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  }
  
  function base64UrlDecode(str: string): string {
    let base64 = str.replace('.m3u8', '');
    let padded = base64.replace(/-/g, '+').replace(/_/g, '/');
    while (padded.length % 4 !== 0) padded += '=';
    const bin = atob(padded);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)!;
    return new TextDecoder().decode(bytes);
  }
  
  function rewriteM3u8Content(content: string, baseUrl: string, headers: Record<string, string>): string {
    const lines = content.split(/\r?\n/);
    const rewritten: string[] = [];
  
    for (const line of lines) {
      if (line.startsWith('#')) {
        if (line.includes('URI=')) {
          const uriMatch = line.match(/URI="([^"]+)"/);
          if (uriMatch && uriMatch[1]) {
            const absoluteUri = toAbsoluteUrl(uriMatch[1], baseUrl);
            const payload: ProxyPayload = { u: absoluteUri, h: headers };
            const encoded = base64UrlEncode(JSON.stringify(payload));
            const proxiedLine = line.replace(/URI="[^"]+"/, `URI="/hls/${encoded}"`);
            rewritten.push(proxiedLine);
          } else {
            rewritten.push(line);
          }
        } else {
          rewritten.push(line);
        }
      } else if (line.trim() && !line.startsWith('#')) {
        const absoluteUri = toAbsoluteUrl(line.trim(), baseUrl);
        const payload: ProxyPayload = { u: absoluteUri, h: headers };
        const encoded = base64UrlEncode(JSON.stringify(payload));
        rewritten.push(`/hls/${encoded}`);
      } else {
        rewritten.push(line);
      }
    }
  
    return rewritten.join('\n');
  }
  
  export async function handleHlsProxy(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const pathParts = url.pathname.split('/');
      if (req.method === 'OPTIONS') {
      return new Response(null, {
        status: 200,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
          'Access-Control-Allow-Headers': 'Range, Content-Type',
          'Access-Control-Max-Age': '86400',
        },
      });
    }
  
    if (pathParts.length < 3 || pathParts[1] !== 'hls') {
      return new Response(JSON.stringify({ error: 'Invalid HLS proxy path' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  
    const base64Payload = pathParts[2];
    if (!base64Payload) {
      return new Response(JSON.stringify({ error: 'Missing base64 payload' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  
    let payload: ProxyPayload;
    try {
      const decoded = base64UrlDecode(base64Payload);
      payload = JSON.parse(decoded);
    } catch {
      return new Response(JSON.stringify({ error: 'Invalid base64 payload' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  
    if (!payload.u || typeof payload.u !== 'string') {
      return new Response(JSON.stringify({ error: 'Invalid payload: missing URL' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  
    try {
      const targetUrl = payload.u;
      const proxyHeaders = payload.h || {};
      const requestHeaders: Record<string, string> = { ...proxyHeaders };
  
      const rangeHeader = req.headers.get('Range');
      if (rangeHeader) requestHeaders['Range'] = rangeHeader;
  
      const upstream = await fetch(targetUrl, { headers: requestHeaders, redirect: 'follow' });
      const corsHeaders = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Content-Type',
      };
      const contentType = upstream.headers.get('content-type') || '';
      const isM3u8 =
        contentType.includes('mpegurl') ||
        contentType.includes('m3u8') ||
        /\.m3u8(\?|$)/i.test(targetUrl);
      const isMp4 = contentType.includes('video/mp4') || /\.mp4(\?|$)/i.test(targetUrl);
  
      if (isM3u8) {
        const textContent = await upstream.text();
        const rewrittenContent = rewriteM3u8Content(textContent, upstream.url || targetUrl, proxyHeaders);
        return new Response(rewrittenContent, {
          status: upstream.status,
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/vnd.apple.mpegurl',
            'Cache-Control': 'public, max-age=30',
          },
        });
      } else {
        const body = upstream.body;
        const headers = new Headers({
          ...corsHeaders,
          'Cache-Control': 'public, max-age=600',
        });
        const forwardHeaders = ['content-length', 'content-range', 'content-type', 'accept-ranges'];
        for (const h of forwardHeaders) {
          const v = upstream.headers.get(h);
          if (v) {
            const canonical = h
              .split('-')
              .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
              .join('-');
            headers.set(canonical, v);
          }
        }
        if (isMp4) {
          if (!headers.has('Content-Type')) headers.set('Content-Type', 'video/mp4');
          if (!headers.has('Accept-Ranges')) headers.set('Accept-Ranges', 'bytes');
        }
        let status = upstream.status;
        if (isMp4) {
          const hasContentRange = headers.has('Content-Range');
          const requestedRange = req.headers.get('Range');
          if (hasContentRange && requestedRange && status === 200) {
            status = 206;
          }
        }

        return new Response(body, { status, headers });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Proxy request failed';
      return new Response(JSON.stringify({ error: message }), {
        status: 500,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        },
      });
    }
  }