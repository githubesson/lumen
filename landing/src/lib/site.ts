export const REPO_URL = "https://github.com/githubesson/lumen";
export const RELEASES_URL = `${REPO_URL}/releases`;
export const RELEASES_API =
  "https://api.github.com/repos/githubesson/lumen/releases?per_page=10";

export const DOCS = {
  runIt: `${REPO_URL}#run-it`,
  compose: `${REPO_URL}/blob/main/docker-compose.yml`,
  envExample: `${REPO_URL}/blob/main/.env.example`,
  nginx: `${REPO_URL}/blob/main/docs/nginx.conf.example`,
  backend: `${REPO_URL}/tree/main/backend`,
  frontend: `${REPO_URL}/tree/main/frontend`,
  mobile: `${REPO_URL}/tree/main/mobile`,
  issues: `${REPO_URL}/issues`,
} as const;

/** Prefix a public/ asset with Vite's base so it resolves under the GitHub
 *  Pages project path. index.html and CSS get this rewrite for free; JSX
 *  attributes do not. */
export function asset(path: string): string {
  return `${import.meta.env.BASE_URL}${path.replace(/^\//, "")}`;
}
