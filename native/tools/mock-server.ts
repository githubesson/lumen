// Serves the web frontend's UI-lint fixtures (frontend/tests/ui/mock-api.ts)
// over real HTTP, so the Rune app runs against exactly the data the React
// reference screenshots use.
//
//   frontend/node_modules/.bin/jiti native/tools/mock-server.ts [--port 4791] [--signed-out]
//
// The route table is the lint run's own; only the transport differs. Static
// assets are not served: the Rune app draws its own UI.
import http from "node:http";
import { apiRoutes } from "../../frontend/tests/ui/mock-api";

const args = process.argv.slice(2);
const port = Number(args[args.indexOf("--port") + 1] || 4791) || 4791;
let signedIn = !args.includes("--signed-out");
let routes = apiRoutes(signedIn);

type Reply =
  | { json: unknown; status?: number; headers?: Record<string, string> }
  | { body: string | Buffer; contentType: string; status?: number; headers?: Record<string, string> }
  | { status: number; text?: string };

function send(res: http.ServerResponse, reply: Reply) {
  if ("json" in reply) {
    res.writeHead(reply.status ?? 200, { "Content-Type": "application/json", ...reply.headers });
    res.end(JSON.stringify(reply.json));
    return;
  }
  if ("body" in reply) {
    // resvg reads no `hsl(h s l / a)`; give it the comma form and an opacity
    // attribute, which draw the same.
    if (reply.contentType === "image/svg+xml" && typeof reply.body === "string") {
      reply = {
        ...reply,
        body: reply.body.replace(
          /fill="hsl\(([\d.]+) ([\d.]+)% ([\d.]+)% \/ ([\d.]+)\)"/g,
          'fill="hsl($1, $2%, $3%)" fill-opacity="$4"',
        ).replace(/hsl\(([\d.]+) ([\d.]+)% ([\d.]+)%\)/g, "hsl($1, $2%, $3%)"),
      };
    }
    res.writeHead(reply.status ?? 200, {
      "Content-Type": reply.contentType,
      "Cache-Control": "max-age=3600",
      ...reply.headers,
    });
    res.end(reply.body);
    return;
  }
  res.writeHead(reply.status, { "Content-Type": "text/plain" });
  res.end(reply.text ?? "");
}

const server = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? `127.0.0.1:${port}`}`);
    const body = Buffer.concat(chunks).toString("utf8");
    // Test hooks: flip the session without restarting.
    if (url.pathname === "/__mock/session") {
      signedIn = url.searchParams.get("signed_in") !== "false";
      routes = apiRoutes(signedIn);
      res.writeHead(204).end();
      return;
    }
    if (url.pathname === "/api/auth/login" && req.method === "POST") {
      signedIn = true;
      routes = apiRoutes(signedIn);
    }
    const method = req.method === "HEAD" ? "GET" : (req.method ?? "GET");
    // The handlers read a Playwright Route; give them the parts they touch.
    const route = {
      request: () => ({
        url: () => url.toString(),
        method: () => method,
        postDataJSON: () => (body ? JSON.parse(body) : null),
        postData: () => body,
      }),
    };
    for (const [verb, pattern, handler] of routes) {
      if (verb !== method) continue;
      const match = url.pathname.match(pattern);
      if (!match) continue;
      const reply = handler(match, url, route as never) as Reply | null;
      if (reply) {
        send(res, reply);
        return;
      }
    }
    if (!url.pathname.startsWith("/api/")) {
      send(res, { status: 404, text: "not found" });
      return;
    }
    console.log(`unmocked ${req.method} ${url.pathname}${url.search}`);
    send(res, method === "GET" ? { json: [] } : { status: 204 });
  });
});

server.listen(port, "127.0.0.1", () => {
  console.log(`mock api on http://127.0.0.1:${port} (${signedIn ? "signed in" : "signed out"})`);
});
