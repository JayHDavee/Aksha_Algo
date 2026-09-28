FROM golang:1.24-alpine AS builder

WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -o server ./cmd/server/

FROM alpine:3.20
RUN apk add --no-cache ca-certificates tzdata
WORKDIR /backend
COPY --from=builder /app/server .
EXPOSE 5000
ENTRYPOINT ["./server"]
