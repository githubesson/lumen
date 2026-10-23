// whatwg-fetch ships Flow types only.
declare module "whatwg-fetch" {
  export const fetch: typeof globalThis.fetch;
}
