const fs = require('fs');
const path = require('path');
const ToxicologicalScraper = require('../src/scrapers/ToxicologicalScraper');
const drivers = require('./data/drivers.json');

(async () => {
  console.log('--- Iniciando processo de consulta em lote ---');

  const toxicologicalScraper = new ToxicologicalScraper({ maxConcurrency: 5 });

  for await (const result of toxicologicalScraper.processBatch(drivers)) {
    console.log(result);
  }

  console.log('--- Finalizou processo de consulta em lote ---');
})();
