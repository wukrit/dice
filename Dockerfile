FROM node:24-bookworm-slim AS web
WORKDIR /app/web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

FROM rust:1.97-bookworm AS server
WORKDIR /app
COPY Cargo.toml Cargo.lock ./
COPY src/ ./src/
RUN cargo build --locked --release

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --uid 10001 dice
WORKDIR /app
COPY --from=server /app/target/release/dice-room /usr/local/bin/dice-room
COPY --from=web /app/web/dist /app/web/dist
ENV STATIC_DIR=/app/web/dist
ENV PORT=3000
ENV RUST_LOG=dice_room=info,tower_http=info
USER dice
EXPOSE 3000
CMD ["dice-room"]
