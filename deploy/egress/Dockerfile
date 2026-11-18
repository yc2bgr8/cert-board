FROM ubuntu:24.04@sha256:73b999393d07f2bf65a40373778a44dc9a6d54ad7718d29247d8ff9413c4d6a8

ARG SQUID_VERSION=6.14-0ubuntu0.24.04.5
RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install --no-install-recommends -y \
       squid=${SQUID_VERSION} squid-common=${SQUID_VERSION} \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

COPY squid.conf /etc/squid/squid.conf
COPY allowlist /etc/squid/allowlist
COPY hosts /etc/squid/hosts
USER proxy
EXPOSE 3128
ENTRYPOINT ["squid", "-N", "-f", "/etc/squid/squid.conf"]
