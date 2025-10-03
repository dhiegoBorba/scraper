const fs = require('fs');
const path = require('path');
const ToxicologicalScraper = require('../src/scrapers/ToxicologicalScraper');
const toxicologicalScraper = new ToxicologicalScraper({ maxConcurrency: 5 });

(async () => {
  console.log('--- Iniciando processo de consulta em lote ---');

  const caminhoMotoristas = path.resolve(__dirname, 'data/drivers.json');
  if (!fs.existsSync(caminhoMotoristas)) {
    console.error('Arquivo drivers.json não encontrado!');

    process.exit(1);
  }

  const motoristas = JSON.parse(fs.readFileSync(caminhoMotoristas, 'utf8'));

  for await (const resultado of toxicologicalScraper.processBatch(motoristas)) {
    console.log('Retorno: ', resultado);
  }
})();
