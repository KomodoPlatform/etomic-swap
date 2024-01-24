FROM node:20-bullseye-slim

RUN apt-get update && apt-get install -y \
    git \
    python3 \
    make \
    g++

ADD . /usr/src/rpc

WORKDIR /usr/src/rpc
RUN git config --global url."https://".insteadOf git://
RUN yarn install