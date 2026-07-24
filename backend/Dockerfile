FROM golang:1.24-alpine@sha256:8bee1901f1e530bfb4a7850aa7a479d17ae3a18beb6e09064ed54cfd245b7191 AS build
WORKDIR /src
COPY go.mod go.sum* ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -ldflags="-s -w" -o /out/server ./cmd/server

FROM alpine:3.20@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc
RUN apk add --no-cache ca-certificates ffmpeg font-dejavu nodejs npm tzdata \
    && addgroup -S app \
    && adduser -S -G app -h /app app
WORKDIR /app
COPY --from=build /out/server /app/server
COPY fonts /app/fonts
COPY filen-downloader/package.json filen-downloader/package-lock.json /app/filen-downloader/
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
