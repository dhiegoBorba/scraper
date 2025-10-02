const fs = require('fs');
const path = require('path');
const { processDriverBatch } = require('../src/scrapings/toxicologicalScraping');

(async () => {
  console.log('--- Iniciando processo de consulta em lote ---');

  const caminhoMotoristas = path.resolve(__dirname, 'data/drivers.json');
  if (!fs.existsSync(caminhoMotoristas)) {
    console.error('Arquivo drivers.json não encontrado!');

    process.exit(1);
  }

  const motoristas = JSON.parse(fs.readFileSync(caminhoMotoristas, 'utf8'));

  for await (const resultado of processDriverBatch(motoristas)) {
    console.log('aquiiiiiiiiii ', resultado);
  }
})();
