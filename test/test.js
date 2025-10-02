const fs = require('fs');
const path = require('path');
const { iniciarConsultasEmLote } = require('../index');

(async () => {
  console.log('--- Iniciando processo de consulta em lote ---');

  const caminhoMotoristas = path.resolve(__dirname, 'motoristas.json');
  if (!fs.existsSync(caminhoMotoristas)) {
    console.error('Arquivo motoristas.json não encontrado!');

    process.exit(1);
  }

  const motoristas = JSON.parse(fs.readFileSync(caminhoMotoristas, 'utf8'));
  await iniciarConsultasEmLote(motoristas);
})();
