# ============================================
# ESP32 Web IDE - Complete Docker Image
# Includes: ESP-IDF, all toolchains, esptool
# ============================================

FROM espressif/idf:v5.2.2

# Metadata
LABEL maintainer="ESP32 Web IDE"
LABEL description="Complete ESP32 development environment with web interface"

# Instalar Node.js 20 e ferramentas adicionais
RUN apt-get update && apt-get install -y \
    curl \
    git \
    cmake \
    ninja-build \
    python3-pip \
    python3-venv \
    libusb-1.0-0 \
    picocom \
    screen \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Instalar ferramentas Python do ESP-IDF
RUN pip3 install --no-cache-dir \
    esptool \
    esp-idf-monitor \
    esp-idf-size \
    esp-idf-nvs-partition-gen \
    esp-idf-kconfig \
    cryptography \
    pyserial

# Configurar ESP-IDF para todos os targets
ENV IDF_PATH=/opt/esp/idf
ENV IDF_TOOLS_PATH=/opt/esp

# Instalar toolchains para todos os chips
RUN . ${IDF_PATH}/export.sh && \
    idf.py --help > /dev/null

# Diretório de trabalho
WORKDIR /app

# Copiar package.json primeiro para cache de dependências
COPY package*.json ./

# Instalar dependências Node.js
RUN npm install --production

# Copiar código fonte
COPY . .

# Criar diretórios necessários
RUN mkdir -p /app/uploads /app/builds /app/projects /app/temp

# Permissões
RUN chmod -R 777 /app/uploads /app/builds /app/projects /app/temp

# Porta do servidor
EXPOSE 80

# Variáveis de ambiente
ENV NODE_ENV=production
ENV PORT=80
ENV UPLOAD_DIR=/app/uploads
ENV BUILD_DIR=/app/builds
ENV PROJECTS_DIR=/app/projects

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:80/api/health || exit 1

# Iniciar servidor
CMD ["node", "src/server.js"]
