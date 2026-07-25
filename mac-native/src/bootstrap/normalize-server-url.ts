/**
 * Pure server-URL parsing, kept apart from `server-url.ts` so it can be tested
 * without pulling AsyncStorage and the rest of the React Native runtime into
 * the test process.
 */

/**
 * Accept what someone would actually type — `lumen.example.com`,
 * `http://192.168.1.4:8080`, a trailing slash — and produce the origin
 * `core/api.ts` expects. Bare hosts default to https; only an explicit
 * `http://` opts out.
 */
export function normalizeServerUrl(input: string): string {
  const trimmed = input.trim();
  if (trimmed.length === 0) return '';
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  return withScheme.replace(/\/+$/, '');
}
