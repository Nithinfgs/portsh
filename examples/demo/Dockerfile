FROM alpine:3.20
RUN apt-get update && apt-get install -y curl
COPY . /app
RUN grep -oP 'ver=\K\d+' /app/VERSION > /app/.ver \
 && find /app -name '*.tmp' -printf '%p\n' > /tmp/tmpfiles
