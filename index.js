const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const fs = require("fs");
const path = require("path");

puppeteer.use(StealthPlugin());

// --- CONFIGURAÇÕES DE SELETORES E URL ---
const SELETOR_CPF = 'br-input[formcontrolname="cpf"] input';
const SELETOR_NASCIMENTO = 'br-date-picker[formcontrolname="dataNascimento"] input';
const SELETOR_VALIDADE = 'br-date-picker[formcontrolname="dataValidade"] input';
const SELETOR_BOTAO_PROSSEGUIR = "button.br-button.primary";
const URL_CONSULTA =
  "https://portalservicos.senatran.serpro.gov.br/#/condutor/consultar-toxicologico";
const CAMINHO_RESULTADOS = path.resolve(__dirname, "resultados.json");

// --- FUNÇÕES AUXILIARES ---
const aguardar = (ms) => new Promise((res) => setTimeout(res, ms));

function formatarDataParaDB(dataStr) {
  if (!dataStr) return null;
  const [dia, mes, ano] = dataStr.split("/").map(Number);
  const data = new Date(ano, mes - 1, dia);
  const yyyy = data.getFullYear();
  const mm = String(data.getMonth() + 1).padStart(2, "0");
  const dd = String(data.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd} 00:00:00.000`;
}

// Salva cada resultado incrementalmente no JSON
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

  await pagina.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
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

    // Extrair validade do exame
    let dataValidade = null;
    if (dadosBrutos["Prazo para realização de novo exame"]) {
      const match = dadosBrutos["Prazo para realização de novo exame"].match(/\d{2}\/\d{2}\/\d{4}/);
      if (match) dataValidade = match[0];
    }

    let expiradoEm = null;
    let status = null;
    if (dataValidade) {
      expiradoEm = formatarDataParaDB(dataValidade);
      const [d, m, a] = dataValidade.split("/").map(Number);
      const validade = new Date(a, m - 1, d);
      status = validade >= new Date() ? "valid" : "expired";
    }

    // Extrair data de coleta
    let dataColeta = null;
    const coletaRaw = dadosBrutos["Amostra para novo exame coletada em"];
    if (coletaRaw && !coletaRaw.includes("Não há registro")) {
      const match = coletaRaw.match(/\d{2}\/\d{2}\/\d{4}/);
      if (match) dataColeta = formatarDataParaDB(match[0]);
    }

    return { expired_at_senatran:expiradoEm, toxicology_status_senatran: status, collection_date_senatran: dataColeta };
  } catch (err) {
    console.error("Erro ao extrair dados da página:", err.message);
    return { expired_at_senatran: null, toxicology_status_senatran: null, collection_date_senatran: null };
  }
}

// --- EXECUTA CONSULTA PARA UM MOTORISTA ---
async function consultarMotorista(contexto, motorista, maxTentativas = 3) {
  for (let tentativa = 1; tentativa <= maxTentativas; tentativa++) {
    let pagina;
    try {
      pagina = await contexto.newPage();
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

        try { await pagina.close(); } catch {}

        if (tentativa === maxTentativas) {
          return { sucesso: false, erro: `Condutor não encontrado / erro: ${msgErro}` };
        }

        console.log(`🔄 Repetindo CPF ${motorista.cpf}...`);
        await aguardar(2000);
        continue;
      }

      console.log(`✅ Página de resultados carregada para CPF ${motorista.cpf}`);
      const dados = await extrairDadosPagina(pagina);

      try { await pagina.close(); } catch {}
      return { sucesso: true, dados };

    } catch (err) {
      console.error(`⚠️ Erro na tentativa ${tentativa} para CPF ${motorista.cpf}: ${err.message}`);
      try { await pagina.screenshot({ path: `erro_${motorista.cpf}_tentativa${tentativa}.png` }); } catch {}
      try { if (pagina && !pagina.isClosed()) await pagina.close(); } catch {}

      if (tentativa === maxTentativas) return { sucesso: false, erro: err.message };

      console.log(`🔄 Repetindo CPF ${motorista.cpf}...`);
      await aguardar(2000);
    }
  }
}

// --- PROCESSA CONSULTAS EM LOTE ---
async function iniciarConsultasEmLote(motoristas) {
  const MAX_CONCORRENCIA = 5;
  const semaforo = criarSemaforo(MAX_CONCORRENCIA);

  const navegador = await puppeteer.launch({
    headless: false, // necessário para o site
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--window-size=1920,1080"
    ],
    defaultViewport: null, 
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