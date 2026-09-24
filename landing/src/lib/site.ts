export const REPO = "githubesson/lumen";
export const REPO_URL = `https://github.com/${REPO}`;
export const RELEASES_URL = `${REPO_URL}/releases`;
export const README_URL = `${REPO_URL}#readme`;
export const MOBILE_README_URL = `${REPO_URL}/tree/main/mobile#readme`;
export const ISSUES_URL = `${REPO_URL}/issues`;
export const NGINX_EXAMPLE_URL = `${REPO_URL}/blob/main/docs/nginx.conf.example`;

export const INSTALL_STEPS = [
  { cmd: `git clone ${REPO_URL}.git && cd lumen`, note: null },
  { cmd: "cp .env.example .env", note: "then set POSTGRES_PASSWORD and COVER_SIGN_KEY" },
  { cmd: "docker compose up -d --build", note: null },
] as const;
