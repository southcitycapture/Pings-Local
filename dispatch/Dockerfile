FROM rust:1-slim AS build
WORKDIR /src
COPY Cargo.toml Cargo.lock* ./
COPY src ./src
RUN cargo build --release

FROM debian:bookworm-slim
COPY --from=build /src/target/release/pings-dispatch /usr/local/bin/pings-dispatch
EXPOSE 43217
# DISPATCH_TEAM_KEY must be provided at run time.
ENTRYPOINT ["pings-dispatch"]
