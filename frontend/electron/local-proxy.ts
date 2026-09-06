import * as path from "node:path";
import * as http from "node:http";
import * as https from "node:https";
import * as fsp from "node:fs/promises";
import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

const FONT_CSS_ORIGIN = "https://fonts.googleapis.com";
const FONT_FILE_ORIGIN = "https://fonts.gstatic.com";

export interface LocalProxy {
  readonly port: number;
  start(): Promise<number>;
  close(): void;
}

export function createLocalProxy(options: {
  distDir: string;
  getBackendUrl: () => string;
}): LocalProxy {
  let port = 0;
  let server: http.Server | null = null;
  let inlineScriptHashes: string[] | null = null;

  function mimeFor(filePath: string): string {
    return MIME[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
  }

  function proxyApi(req: IncomingMessage, res: ServerResponse): void {
    const backendUrl = options.getBackendUrl();
    if (!backendUrl) {
      res.writeHead(503, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Backend not configured");
      return;
    }
    let target: URL;
    try {
      target = new URL(req.url ?? "/", backendUrl);
    } catch (error) {
      res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(`Invalid backend URL: ${(error as Error).message}`);
      return;
    }
    const transport = target.protocol === "https:" ? https : http;
    const headers = { ...req.headers, host: target.host };
    delete headers["content-length"];
    const upstream = transport.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (target.protocol === "https:" ? 443 : 80),
        path: target.pathname + target.search,
        method: req.method,
        headers,
      },
      (response) => {
        res.writeHead(response.statusCode ?? 502, response.headers);
        response.pipe(res);
      },
    );
    upstream.on("error", (error) => {
      if (!res.headersSent) {
        res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
      }
      res.end(`Bad gateway: ${error.message}`);
    });
    req.pipe(upstream);
  }

  function writeRawResponseHead(socket: Duplex, response: IncomingMessage): void {
    const statusLine = `HTTP/${response.httpVersion} ${response.statusCode ?? 502} ${response.statusMessage ?? "Bad Gateway"}`;
    const headers: string[] = [statusLine];
    for (let index = 0; index < response.rawHeaders.length; index += 2) {
      headers.push(`${response.rawHeaders[index]}: ${response.rawHeaders[index + 1]}`);
    }
    socket.write(`${headers.join("\r\n")}\r\n\r\n`);
  }

  function proxyWebSocket(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const backendUrl = options.getBackendUrl();
    if (!backendUrl) {
      socket.destroy();
      return;
    }
    let target: URL;
    try {
      target = new URL(req.url ?? "/", backendUrl);
    } catch {
      socket.destroy();
      return;
    }
    const transport = target.protocol === "https:" ? https : http;
    const upstream = transport.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || (target.protocol === "https:" ? 443 : 80),
      path: target.pathname + target.search,
      method: req.method,
      headers: { ...req.headers, host: target.host, origin: target.origin },
    });
    upstream.on("upgrade", (response, upstreamSocket, upstreamHead) => {
      writeRawResponseHead(socket, response);
      upstreamSocket.on("error", () => socket.destroy());
      if (upstreamHead.length > 0) socket.write(upstreamHead);
      if (head.length > 0) upstreamSocket.write(head);
      upstreamSocket.pipe(socket);
      socket.pipe(upstreamSocket);
    });
    upstream.on("response", (response) => {
      writeRawResponseHead(socket, response);
      response.pipe(socket);
    });
    upstream.on("error", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
    upstream.end();
  }

  async function cspHashes(): Promise<string[]> {
    if (inlineScriptHashes) return inlineScriptHashes;
    const hashes: string[] = [];
    try {
      const html = await fsp.readFile(path.join(options.distDir, "index.html"), "utf8");
      const inlineScript = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
      for (const match of html.matchAll(inlineScript)) {
        const body = match[1];
        if (!body.trim()) continue;
        const digest = createHash("sha256").update(body, "utf8").digest("base64");
        hashes.push(`'sha256-${digest}'`);
      }
    } catch {
      // A missing dev build safely produces no inline-script allowances.
    }
    inlineScriptHashes = hashes;
    return hashes;
  }

  function securityHeaders(scriptHashes: string[]): Record<string, string> {
    const self = `http://127.0.0.1:${port}`;
    return {
      "Content-Security-Policy": [
        "default-src 'self'",
        ["script-src 'self'", ...scriptHashes].join(" "),
        `style-src 'self' 'unsafe-inline' ${FONT_CSS_ORIGIN}`,
        "img-src 'self' https: data: blob:",
        "media-src 'self' data: blob:",
        `connect-src 'self' ${self} ws://127.0.0.1:${port} ${FONT_CSS_ORIGIN} ${FONT_FILE_ORIGIN}`,
        `font-src 'self' data: ${FONT_FILE_ORIGIN}`,
        "object-src 'none'",
        "frame-ancestors 'none'",
        "base-uri 'none'",
        "form-action 'none'",
      ].join("; "),
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    };
  }

  async function serveStatic(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const headers = securityHeaders(await cspHashes());
    try {
      const url = new URL(req.url ?? "/", "http://x");
      const relative = decodeURIComponent(url.pathname).replace(/^\/+/, "");
      const normalized = path.posix.normalize("/" + relative).replace(/^\/+/, "");
      let filePath = path.join(options.distDir, normalized);
      if (!filePath.startsWith(options.distDir)) throw new Error("path escape");
      const stat = await fsp.stat(filePath);
      if (stat.isDirectory()) filePath = path.join(filePath, "index.html");
      const data = await fsp.readFile(filePath);
      res.writeHead(200, {
        "Content-Type": mimeFor(filePath),
        "Cache-Control": "no-cache",
        ...headers,
      });
      res.end(data);
    } catch {
      try {
        const data = await fsp.readFile(path.join(options.distDir, "index.html"));
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-cache",
          ...headers,
        });
        res.end(data);
      } catch (error) {
        res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
        res.end(`Error: ${(error as Error).message}`);
      }
    }
  }

  return {
    get port() {
      return port;
    },
    start() {
      return new Promise<number>((resolve, reject) => {
        const nextServer = http.createServer((req, res) => {
          if (req.url?.startsWith("/api/")) proxyApi(req, res);
          else void serveStatic(req, res);
        });
        nextServer.on("upgrade", (req, socket, head) => {
          if (req.url?.startsWith("/api/")) proxyWebSocket(req, socket, head);
          else socket.destroy();
        });
        nextServer.once("error", reject);
        nextServer.listen(0, "127.0.0.1", () => {
          const address = nextServer.address();
          port = address && typeof address === "object" ? address.port : 0;
          server = nextServer;
          resolve(port);
        });
      });
    },
    close() {
      server?.close();
      server = null;
      port = 0;
    },
  };
}
