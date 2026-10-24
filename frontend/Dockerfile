FROM node:24.22.1-alpine@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53 AS build
WORKDIR /app
# Core must land at /core: the app's package.json, tsconfig paths, and Vite
# aliases all reference it as ../core relative to /app.
COPY frontend/package.json frontend/package-lock.json ./
COPY core /core
# `npm ci`, not `npm install`: install ignores the lockfile that was just
# copied, so semver ranges float at build time and the shipped image can carry a
# different dependency tree than the one CI tested.
RUN npm ci --no-audit --no-fund
# core's sources are type-checked as part of the app build and resolve React's
# types from their own package. Installing core's dev deps is how CI does it and
# it avoids the symlink cycle the previous `ln -s /app/node_modules
# /core/node_modules` created (/app/node_modules/@music-library/core already
# points back at /core), which recursive file walkers can loop on.
RUN cd /core && npm ci --no-audit --no-fund
COPY frontend ./
RUN npm run build

FROM nginx:1.27-alpine@sha256:65645c7bb6a0661892a8b03b89d0743208a18dd2f3f17a54ef4b76fb8e2f2a10
COPY --from=build /app/dist /usr/share/nginx/html
COPY frontend/nginx.conf /etc/nginx/conf.d/default.conf
RUN chown -R nginx:nginx /usr/share/nginx/html /var/cache/nginx /var/log/nginx /var/run /run /etc/nginx/conf.d
EXPOSE 8080
USER nginx
