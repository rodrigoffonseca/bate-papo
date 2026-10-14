FROM golang:1.25-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /batepapo-server ./cmd/batepapo-server

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /batepapo-server /batepapo-server
ENV BATEPAPO_LISTEN_ADDR=:8080 \
    BATEPAPO_BLOB_DIR=/data/blobs
VOLUME /data
EXPOSE 8080
USER nonroot
ENTRYPOINT ["/batepapo-server"]
