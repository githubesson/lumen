FROM node:20-alpine AS build
WORKDIR /app
# Core must land at /core: the app's package.json, tsconfig paths, and Vite
# aliases all reference it as ../core relative to /app.
COPY frontend/package.json frontend/package-lock.json* ./
COPY core /core
RUN npm install --no-audit --no-fund
RUN ln -s /app/node_modules /core/node_modules
COPY frontend ./
RUN npm run build

FROM nginx:1.27-alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY frontend/nginx.conf /etc/nginx/conf.d/default.conf
RUN chown -R nginx:nginx /usr/share/nginx/html /var/cache/nginx /var/log/nginx /var/run /run /etc/nginx/conf.d
EXPOSE 8080
USER nginx
