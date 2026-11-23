FROM ubuntu:24.04@sha256:73b999393d07f2bf65a40373778a44dc9a6d54ad7718d29247d8ff9413c4d6a8 AS squid-runtime

ARG SQUID_VERSION=6.14-0ubuntu0.24.04.5
# CI 构建时使用 Ubuntu 的 Azure 镜像，保留现有软件套件与签名设置。
RUN sed -i -e 's|//archive\.ubuntu\.com/ubuntu|//azure.archive.ubuntu.com/ubuntu|g' \
           -e 's|//security\.ubuntu\.com/ubuntu|//azure.archive.ubuntu.com/ubuntu|g' \
           /etc/apt/sources.list.d/ubuntu.sources \
    && apt-get -o Acquire::Retries=5 update \
    && DEBIAN_FRONTEND=noninteractive apt-get -o Acquire::Retries=5 install --no-install-recommends -y \
       squid=${SQUID_VERSION} squid-common=${SQUID_VERSION} \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

COPY squid.conf /etc/squid/squid.conf
USER proxy
EXPOSE 3128
ENTRYPOINT ["squid", "-N", "-f", "/etc/squid/squid.conf"]

FROM squid-runtime AS isolated-business
COPY isolated-allowlist /etc/squid/allowlist
COPY hosts /etc/squid/hosts

FROM squid-runtime AS isolated-sandbox
COPY sandbox-allowlist /etc/squid/allowlist
COPY sandbox-hosts /etc/squid/hosts

FROM squid-runtime AS web-fetch
COPY fetch.conf /etc/squid/squid.conf
COPY fetch-hosts /etc/squid/hosts

FROM squid-runtime AS development
COPY allowlist /etc/squid/allowlist
COPY hosts /etc/squid/hosts
