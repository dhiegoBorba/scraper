const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const fs = require("fs");
const path = require("path");
const os = require("os");

puppeteer.use(StealthPlugin());

const SELETOR_CPF = 'br-input[formcontrolname="cpf"] input';
const SELETOR_NASCIMENTO = 'br-date-picker[formcontrolname="dataNascimento"] input';
const SELETOR_VALIDADE = 'br-date-picker[formcontrolname="dataValidade"] input';
const SELETOR_BOTAO_PROSSEGUIR = "button.br-button.primary";
const URL_CONSULTA = "https://portalservicos.senatran.serpro.gov.br/#/condutor/consultar-toxicologico";
const CAMINHO_RESULTADOS = path.resolve(__dirname, "resultados.json");
const ERROR_SCREENSHOT_DIR = path.resolve(__dirname, "error_screenshots");


const CHROME_PROFILE_DIR = path.resolve(os.homedir(), ".chrome_senatran_profile");

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

function formatarData(dataStr) {
  if (!dataStr) return null;

  const [dia, mes, ano] = dataStr.split("/").map(Number);
  const data = new Date(ano, mes - 1, dia);
  const yyyy = data.getFullYear();
  const mm = String(data.getMonth() + 1).padStart(2, "0");
  const dd = String(data.getDate()).padStart(2, "0");

  return `${yyyy}-${mm}-${dd} 00:00:00.000`;
}

function salvarResultadoIncremental(resultado) {
  let resultadosExistentes = [];

  if (fs.existsSync(CAMINHO_RESULTADOS)) {
    try {
      resultadosExistentes = JSON.parse(fs.readFileSync(CAMINHO_RESULTADOS, "utf8"));
    } catch (err) {
      console.error(
        "Erro ao ler resultados.json existente. Criando novo arquivo.",
        err.message
      );
      resultadosExistentes = [];
    }
  }

  resultadosExistentes.push(resultado);

  try {
    fs.writeFileSync(
      CAMINHO_RESULTADOS,
      JSON.stringify(resultadosExistentes, null, 2),
      "utf8"
    );
    console.log(`✅ Resultado do CPF ${resultado.cpf} salvo com sucesso.`);
  } catch (err) {
    console.error(`❌ Erro ao salvar resultado do CPF ${resultado.cpf}:`, err.message);
  }
}

// --- SEMÁFORO PARA LIMITAR CONCORRÊNCIA ---
function criarSemaforo(max) {
  let contador = 0;
  const fila = [];

  return {
    async adquirir() {
      if (contador < max) {
        contador++;
        return;
      }

      await new Promise((resolver) => fila.push(resolver));
      contador++;
    },
    liberar() {
      contador--;

      if (fila.length) fila.shift()();
    },
  };
}

// --- CONFIGURAÇÃO DE PÁGINA PARA EVITAR TRACKING ---
// Patches extras para reduzir fingerprinting (navigator, plugins, webgl, languages, etc.)
async function configurarPagina(pagina) {
  await pagina.setRequestInterception(true);

  pagina.on("request", (req) => {
    const url = req.url().toLowerCase();

    if (
      ["image", "font"].includes(req.resourceType()) ||
      url.includes("googlesyndication") ||
      url.includes("doubleclick") ||
      url.includes("analytics")
    ) {
      return req.abort();
    }

    req.continue();
  });

  // Cabeçalhos
  await pagina.setExtraHTTPHeaders({
    "Accept-Language": "pt-BR,pt;q=0.9",
  });

  // Avaliações injetadas antes de qualquer script da página
  await pagina.evaluateOnNewDocument(() => {
    // navigator.webdriver
    Object.defineProperty(navigator, "webdriver", { get: () => false });

    // languages
    Object.defineProperty(navigator, "languages", { get: () => ["pt-BR", "pt"] });
    Object.defineProperty(navigator, "language", { get: () => "pt-BR" });

    // plugins & mimeTypes (suficientemente crível)
    Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3, 4, 5] });
    Object.defineProperty(navigator, "mimeTypes", { get: () => [{type:'application/pdf'}] });

    // hardwareConcurrency
    try {
      Object.defineProperty(navigator, "hardwareConcurrency", { get: () => 4 });
    } catch (e) {}

    // spoof do WebGL (UNMASKED_VENDOR_WEBGL / UNMASKED_RENDERER_WEBGL)
    try {
      const getParameter = WebGLRenderingContext.prototype.getParameter;

      WebGLRenderingContext.prototype.getParameter = function(parameter) {
        if (parameter === 37445) return "Intel Inc."; // UNMASKED_VENDOR_WEBGL
        if (parameter === 37446) return "Intel Iris OpenGL Engine"; // UNMASKED_RENDERER_WEBGL

        return getParameter(parameter);
      };
    } catch (e) {}

    // AudioContext falsificado minimamente
    try {
      window.AudioContext = window.AudioContext || window.webkitAudioContext;
      const orig = AudioContext.prototype.constructor;

      AudioContext.prototype.constructor = function() {
        return new orig();
      };
    } catch (e) {}

    // remover sinal de automação (por precaução)
    try {
      delete navigator.__proto__.webdriver;
    } catch (e) {}
  });
}

// --- EXTRAÇÃO DE DADOS DA PÁGINA ---
async function extrairDadosPagina(pagina) {
  try {
    const dadosBrutos = await pagina.evaluate(() => {
      const resultados = {};
      const linhas = document.querySelectorAll("app-consulta-toxicologico table tr");

      linhas.forEach((linha) => {
        const colunas = linha.querySelectorAll("td");
        if (colunas.length === 2) {
          resultados[colunas[0].innerText.trim()] = colunas[1].innerText.trim();
        }
      });

      return resultados;
    });

    let dataValidade = null;

    if (dadosBrutos["Prazo para realização de novo exame"]) {
      const match = dadosBrutos["Prazo para realização de novo exame"].match(/\d{2}\/\d{2}\/\d{4}/);
      if (match) dataValidade = match[0];
    }

    let expiradoEm = null;
    let status = null;

    if (dataValidade) {
      expiradoEm = formatarData(dataValidade);
      const [d, m, a] = dataValidade.split("/").map(Number);
      const validade = new Date(a, m - 1, d);
      status = validade >= new Date() ? "valid" : "expired";
    }

    // Extrair data de coleta
    let dataColeta = null;
    const coletaRaw = dadosBrutos["Amostra para novo exame coletada em"];

    if (coletaRaw && !coletaRaw.includes("Não há registro")) {
      const match = coletaRaw.match(/\d{2}\/\d{2}\/\d{4}/);
      if (match) dataColeta = formatarData(match[0]);
    }

    return { 
      expired_at_senatran: expiradoEm, 
      toxicology_status_senatran: status, 
      collection_date_senatran: dataColeta 
    };
  } catch (err) {
    console.error("Erro ao extrair dados da página:", err.message);
    return { expired_at_senatran: null, toxicology_status_senatran: null, collection_date_senatran: null };
  }
}

// --- EXECUTA CONSULTA PARA UM MOTORISTA ---
async function consultarMotorista(contexto, motorista, maxTentativas = 3) {
  const userAgent = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

  for (let tentativa = 1; tentativa <= maxTentativas; tentativa++) {
    let pagina = null;
    
    try {
      pagina = await contexto.newPage();
      await pagina.setUserAgent(userAgent);
      await pagina.setViewport({ width: 1920, height: 1080 });
      await configurarPagina(pagina);

      console.log(`Tentativa ${tentativa}/${maxTentativas} para CPF ${motorista.cpf}...`);
      await pagina.goto(URL_CONSULTA, { waitUntil: "networkidle2", timeout: 30000 });

      // Preenche formulário
      await pagina.waitForSelector(SELETOR_CPF, { visible: true, timeout: 30000 });
      await pagina.click(SELETOR_CPF, { clickCount: 3 });
      await pagina.type(SELETOR_CPF, motorista.cpf, { delay: 120 });

      await pagina.click(SELETOR_NASCIMENTO, { clickCount: 3 });
      await pagina.type(SELETOR_NASCIMENTO, motorista.birthday, { delay: 120 });

      await pagina.click(SELETOR_VALIDADE, { clickCount: 3 });
      await pagina.type(SELETOR_VALIDADE, motorista.cnh_due_at, { delay: 120 });

      await pagina.click(SELETOR_BOTAO_PROSSEGUIR);

      // Espera página de resultados ou mensagem de erro
      const resultado = await Promise.race([
        pagina.waitForSelector("h3.text-primary", { visible: true, timeout: 30000 }).then(() => "ok"),
        pagina.waitForSelector(".br-message.is-danger", { visible: true, timeout: 30000 }).then(() => "erro"),
      ]);

      if (resultado === "erro") {
        let msgErro = "Mensagem de erro desconhecida";

        try {
          msgErro = await pagina.$eval(".br-message.is-danger .title", el => el.innerText.trim());
        } catch {}

        if (tentativa === maxTentativas) {
          await screenshot(pagina, motorista.cpf, tentativa);
          try { await pagina.close(); } catch {}

          return { sucesso: false, erro: `Condutor não encontrado / erro: ${msgErro}` };
        }

        console.log(`🔄 Repetindo CPF ${motorista.cpf} (erro detectado): ${msgErro}`);

        try { await pagina.close(); } catch {}

        await sleep(500);

        continue;
      }

      console.log(`✅ Página de resultados carregada para CPF ${motorista.cpf}`);
      const dados = await extrairDadosPagina(pagina);

      try { await pagina.close(); } catch {}
      return { sucesso: true, dados };

    } catch (err) {
      console.error(`⚠️ Erro na tentativa ${tentativa} para CPF ${motorista.cpf}: ${err.message}`);

      if (tentativa === maxTentativas) {
        await screenshot(pagina, motorista.cpf, tentativa);

        try { if (pagina && !pagina.isClosed()) await pagina.close(); } catch {}
        return { sucesso: false, erro: err.message };
      }

      try { if (pagina && !pagina.isClosed()) await pagina.close(); } catch {}
      console.log(`🔄 Repetindo CPF ${motorista.cpf}...`);
      await sleep(500);
    }
  }

  return { sucesso: false, erro: "Falha desconhecida ao consultar motorista" };
}

async function screenshot(pagina, cpf, tentativa) {
  if (!pagina) return;

  try {
    const arquivoScreenshot = path.join(ERROR_SCREENSHOT_DIR, `erro_${cpf}_tentativa${tentativa}.png`);

    await pagina.screenshot({ path: arquivoScreenshot, fullPage: true });

  } catch (e) {
    console.error("❌ Falha ao salvar screenshot de erro:", e.message);
  }
}


// --- PROCESSA CONSULTAS EM LOTE ---
async function iniciarConsultasEmLote(motoristas) {
  const MAX_CONCORRENCIA = 5;
  const semaforo = criarSemaforo(MAX_CONCORRENCIA);

  // cria pasta de perfil se não existir
  if (!fs.existsSync(CHROME_PROFILE_DIR)) {
    fs.mkdirSync(CHROME_PROFILE_DIR, { recursive: true });
    console.log(`✔️ Criado perfil Chrome em ${CHROME_PROFILE_DIR}`);
  }

  const navegador = await puppeteer.launch({
    headless: false, // necessário para o site
    // use o caminho do chrome instalado no servidor
    executablePath: "/usr/bin/google-chrome-stable",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--window-size=1920,1080",
      "--disable-blink-features=AutomationControlled",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-infobars",
    ],
    defaultViewport: null, 
    userDataDir: CHROME_PROFILE_DIR,
  });

  const tarefas = motoristas.map((motorista, idx) => (async () => {
    await semaforo.adquirir();
    
    try {
      console.log(`\n--- [${idx + 1}/${motoristas.length}] Consultando CPF: ${motorista.cpf} ---`);
      const contexto = await navegador.createBrowserContext();

      const resultado = await consultarMotorista(contexto, motorista);

      if (resultado.sucesso) {
        salvarResultadoIncremental({ ...motorista, ...resultado.dados, search_status_senatran: "success" });
      } else {
        salvarResultadoIncremental({ ...motorista, search_status_senatran: "error", error: resultado.erro });
      }

      await contexto.close();
    } finally {
      semaforo.liberar();
    }
  })());

  await Promise.all(tarefas);
  await navegador.close();

  console.log("\n--- Todas as consultas foram processadas ---");
}

// --- MAIN ---
(async () => {
  console.log("--- Iniciando processo de consulta em lote ---");

  const caminhoMotoristas = path.resolve(__dirname, "motoristas.json");
  if (!fs.existsSync(caminhoMotoristas)) {

    console.error("Arquivo motoristas.json não encontrado!");
    
    process.exit(1);
  }

  const motoristas = JSON.parse(fs.readFileSync(caminhoMotoristas, "utf8"));
  await iniciarConsultasEmLote(motoristas);
})();

