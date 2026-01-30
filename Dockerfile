# ESP32 Web Flasher - Dockerfile for Dokploy
# Baseado na imagem oficial do ESP-IDF

FROM espressif/idf:v5.1.2

# Instalar Node.js 20
RUN apt-get update && apt-get install -y curl \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Diretório de trabalho
WORKDIR /app

# Copiar package.json primeiro para cache de dependências
COPY package*.json ./

# Instalar dependências Node.js
RUN npm install --production

# Copiar código fonte
COPY . .

# Criar diretórios necessários
RUN mkdir -p /app/uploads /app/builds /app/temp

# Porta do servidor
EXPOSE 80

# Variáveis de ambiente
ENV NODE_ENV=production
ENV PORT=80
ENV UPLOAD_DIR=/app/uploads
ENV BUILD_DIR=/app/builds

# Iniciar servidor
CMD ["node", "src/server.js"]
