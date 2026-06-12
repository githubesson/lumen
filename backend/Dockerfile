FROM golang:1.22-alpine AS build
WORKDIR /src
COPY go.mod go.sum* ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -ldflags="-s -w" -o /out/server ./cmd/server

FROM alpine:3.20
RUN apk add --no-cache ca-certificates ffmpeg font-dejavu nodejs npm tzdata \
    && addgroup -S app \
    && adduser -S -G app -h /app app
WORKDIR /app
COPY --from=build /out/server /app/server
COPY fonts /app/fonts
COPY filen-downloader/package.json /app/filen-downloader/package.json
RUN cd /app/filen-downloader && npm install --omit=dev
COPY filen-downloader/index.mjs /app/filen-downloader/index.mjs
RUN mkdir -p /cache \
    && chown -R app:app /app /cache
ENV FILEN_DOWNLOADER_SCRIPT=/app/filen-downloader/index.mjs
EXPOSE 8080
USER app
ENTRYPOINT ["/app/server"]
