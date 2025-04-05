FROM node:20-alpine

WORKDIR /app

# OpenSSLの関連パッケージをインストール
RUN apk add --no-cache openssl ca-certificates

COPY package*.json ./

RUN npm ci --only=production

COPY . .

CMD ["npm", "start"] 