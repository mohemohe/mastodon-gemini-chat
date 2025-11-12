FROM node:22-alpine

WORKDIR /app

RUN apk add --no-cache \
    python3 \
    py3-pip \
    curl \
    bash \
    git \
    docker \
    openssl \
    ca-certificates \
    && ln -sf python3 /usr/bin/python

RUN curl -LsSf https://astral.sh/uv/install.sh | sh
ENV PATH="/root/.local/bin:$PATH"
RUN uv --version && uvx --version

COPY package*.json ./

RUN npm ci

COPY . .

CMD ["npm", "start"]
