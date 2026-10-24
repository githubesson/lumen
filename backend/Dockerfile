FROM golang:1.26.9-alpine@sha256:3082400e369fa24d5fc60bca20edab3f6d604e0c5a690ec66b295eff4dd87ade AS build
WORKDIR /src
COPY go.mod go.sum* ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -ldflags="-s -w" -o /out/server ./cmd/server

FROM alpine:3.22@sha256:2e0b81d60597f449baa56dc25d355367869d2dca4cd57e866f1e2b52af3eb55f
# Alpine's nodejs decodes Brotli through the shared brotli-libs, so the floor
# below is what keeps the Filen helper off decoders hit by CVE-2026-111497
# (fixed upstream in 1.2.1, and in the 1.1.1 backport Alpine 3.22 ships).
RUN apk add --no-cache ca-certificates ffmpeg font-dejavu nodejs npm tzdata 'brotli-libs>=1.1.1' \
    && addgroup -S app \
    && adduser -S -G app -h /app app
WORKDIR /app
COPY --from=build /out/server /app/server
COPY fonts /app/fonts
COPY filen-downloader/package.json filen-downloader/package-lock.json /app/filen-downloader/
COPY filen-downloader/vendor /app/filen-downloader/vendor
# `npm ci`, not `npm install`: the helper had no lockfile at all, so @filen/sdk
# and its whole transitive tree resolved fresh on every image build.
RUN cd /app/filen-downloader && npm ci --omit=dev --no-audit --no-fund
COPY filen-downloader/index.mjs /app/filen-downloader/index.mjs
RUN mkdir -p /cache \
    && chown -R app:app /app /cache
ENV FILEN_DOWNLOADER_SCRIPT=/app/filen-downloader/index.mjs
EXPOSE 8080
USER app
ENTRYPOINT ["/app/server"]
