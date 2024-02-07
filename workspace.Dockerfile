FROM node:20-bullseye-slim

VOLUME /usr/src/workspace
WORKDIR /usr/src/workspace

RUN yarn install
