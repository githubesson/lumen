import * as http from "node:http";
import * as https from "node:https";

export function postJson(urlString: string, body: unknown): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    const target = new URL(urlString);
    const data = JSON.stringify(body);
    const lib = target.protocol === "https:" ? https : http;
    const req = lib.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (target.protocol === "https:" ? 443 : 80),
        path: target.pathname + target.search,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data),
        },
        timeout: 4000,
      },
      (res) => {
        let raw = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          raw += chunk;
        });
        res.on("end", () => {
          if ((res.statusCode ?? 500) >= 200 && (res.statusCode ?? 500) < 300) {
            resolve({ ok: true });
            return;
          }
          try {
            const parsed = JSON.parse(raw) as { error?: string };
            resolve({ ok: false, error: parsed.error ?? raw });
          } catch {
            resolve({ ok: false, error: raw || `HTTP ${res.statusCode}` });
          }
        });
      },
    );
    req.on("timeout", () => {
      req.destroy(new Error("FH6 bridge did not respond"));
    });
    req.on("error", (e) => {
      resolve({ ok: false, error: e.message });
    });
    req.end(data);
  });
}
