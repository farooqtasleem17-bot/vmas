import { Hono } from "hono";
import { extractKimcartoon } from "./providers/kimcartoon";
import type { Source } from "./types/sources";
import { handleHlsProxy } from "./proxy/index";
import { extractVidmoly } from "./providers/vidmoly";
const app = new Hono<{ Bindings: CloudflareBindings }>();
app.options("/sources", (c) =>
  c.body(null, 204, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  })
);
app.options("/hls/:encoded", (c) =>
  c.body(null, 200, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
    "Access-Control-Allow-Headers": "Range, Content-Type",
    "Access-Control-Max-Age": "86400",
  })
);
app.get("/hls/:encoded", async (c) => {
  return handleHlsProxy(c.req.raw);
});
app.get("/sources", async (c) => {
  const urlParam = c.req.query("id");
  const host = (c.req.query("host") || "").toLowerCase();
  if (urlParam) {
    try {
      let data: Source;
      switch (host) {
        case "t":
          data = await extractKimcartoon(urlParam, "tserver");
          break;
        case "vh":
          data = await extractKimcartoon(urlParam, "vhserver");
          break;
        case "vm":
          data = await extractVidmoly(`https://vidmoly.to/embed-${urlParam}.html`);
          break;
        default:
          throw new Error("Invalid host");
      }
      return c.json(
        { success: true, data },
        200,
        { "Access-Control-Allow-Origin": "*" }
      );
    } catch (err: any) {
      const message = err?.message || "Internal error";
      return c.json(
        { success: false, error: message },
        500,
        { "Access-Control-Allow-Origin": "*" }
      );
    }
  }
});

export default app;