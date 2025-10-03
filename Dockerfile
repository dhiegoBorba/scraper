# Usar Node LTS
FROM node:20-slim

# Variáveis de ambiente
ENV CHROME_USER_DATA_DIR=/root/.chrome_senatran_profile
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true

# Instalar dependências do Chrome e Puppeteer
RUN apt-get update && apt-get install -y \
    wget gnupg ca-certificates apt-transport-https software-properties-common \
    fonts-liberation fonts-noto fonts-noto-cjk fonts-noto-color-emoji \
    libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libxss1 libasound2 \
    libgbm1 libxshmfence1 libxrandr2 libxcomposite1 libxdamage1 libx11-xcb1 \
    libx11-6 libxrender1 xvfb x11-utils \
    && rm -rf /var/lib/apt/lists/*

# Adicionar repo do Google Chrome
RUN wget -q -O - https://dl.google.com/linux/linux_signing_key.pub | apt-key add - \
    && echo "deb [arch=amd64] http://dl.google.com/linux/chrome/deb/ stable main" > /etc/apt/sources.list.d/google-chrome.list \
    && apt-get update && apt-get install -y google-chrome-stable \
    && rm -rf /var/lib/apt/lists/*

# Criar diretório de perfil
RUN mkdir -p $CHROME_USER_DATA_DIR

# Configurar diretório de trabalho
WORKDIR /app

# Copiar package.json e instalar dependências
COPY package*.json ./
RUN npm install

# Copiar código e script de start
COPY . .
COPY start.sh .

# CMD que garante execução do script
CMD ["./start.sh"]
