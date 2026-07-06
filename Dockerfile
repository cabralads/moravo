FROM node:20-slim

# Instala dependências do sistema necessárias para compilar pacotes nativos (como bcrypt), se necessário.
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copia os arquivos de dependências primeiro (aproveita cache de camadas do Docker)
COPY package*.json ./

# Instala apenas as dependências de produção
RUN npm ci --only=production

# Copia o restante do código da aplicação
COPY . .

# Garante que a pasta de uploads existe
RUN mkdir -p uploads/imoveis uploads/perfis

EXPOSE 3000

ENV NODE_ENV=production
ENV PORT=3000

CMD ["node", "server.js"]
