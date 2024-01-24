FROM node:20-bullseye-slim

RUN apt-get update && apt-get install -y \
    git \
    python3 \
    make \
    g++

VOLUME /usr/src/workspace
WORKDIR /usr/src/workspace
