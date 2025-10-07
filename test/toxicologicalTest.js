require('dotenv').config();
const {
  SQSClient,
  SendMessageCommand,
  SendMessageBatchCommand,
  ReceiveMessageCommand,
  DeleteMessageBatchCommand,
  GetQueueAttributesCommand,
} = require('@aws-sdk/client-sqs');
const chalk = require('chalk');
const drivers = require('./data/drivers.json');

const REQUEST_QUEUE_URL = process.env.SQS_TOXICOLOGICAL_REQUEST_QUEUE_URL;
const RESPONSE_QUEUE_URL = process.env.SQS_TOXICOLOGICAL_RESPONSE_QUEUE_URL;
const WAIT_TIME_SECONDS = Number(process.env.WAIT_TIME_SECONDS || 10);

const client = new SQSClient({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

const metrics = {
  total: drivers.length,
  sent: 0,
  received: 0,
  success: 0,
  failed: 0,
  startedAt: new Date(),
  timers: new Map(),
  durations: [],
  receivedIds: new Set(),
};

const sentIds = new Set(drivers.map((d) => d.id));

const chunkArray = (array, size) =>
  Array.from({ length: Math.ceil(array.length / size) }, (_, i) =>
    array.slice(i * size, i * size + size),
  );

function logProgress() {
  const pctSent = ((metrics.sent / metrics.total) * 100).toFixed(1);
  const pctReceived = ((metrics.received / metrics.total) * 100).toFixed(1);

  console.log(
    chalk.blueBright(
      `📤 Enviados: ${metrics.sent}/${metrics.total} (${pctSent}%) | ` +
        `📥 Processados: ${metrics.received}/${metrics.total} (${pctReceived}%) | ` +
        `✅ Sucesso: ${metrics.success} | ❌ Falha: ${metrics.failed}`,
    ),
  );
}

async function purgeResponseQueue() {
  console.log(chalk.yellowBright('\n🧹 Limpando fila de resposta antes do teste...'));
  let totalDeleted = 0;

  while (true) {
    const command = new ReceiveMessageCommand({
      QueueUrl: RESPONSE_QUEUE_URL,
      MaxNumberOfMessages: 10,
      WaitTimeSeconds: 1,
    });

    const { Messages } = await client.send(command);
    if (!Messages || Messages.length === 0) break;

    await deleteBatch(Messages);
    totalDeleted += Messages.length;
  }

  console.log(chalk.greenBright(`✅ Fila limpa (${totalDeleted} mensagens removidas)\n`));
}

async function sendMessages() {
  console.log(chalk.yellowBright('🚀 Iniciando envio de consultas toxicológicas...'));

  // Envio individual (primeiros 30)
  const individualDrivers = drivers.slice(0, 30);
  for (const driver of individualDrivers) {
    const cpf = driver.cpf;
    try {
      const command = new SendMessageCommand({
        QueueUrl: REQUEST_QUEUE_URL,
        MessageBody: JSON.stringify(driver),
      });

      await client.send(command);
      metrics.timers.set(cpf, Date.now());
      metrics.sent++;

      console.log(chalk.gray(`→ Enviado individual: ${cpf}`));
      logProgress();
    } catch (err) {
      console.error(chalk.red(`Erro ao enviar ${cpf}:`), err);
    }
  }

  // Envio em batches (restante)
  const batches = chunkArray(drivers.slice(30), 10);
  for (const batch of batches) {
    const entries = batch.map((driver) => ({
      Id: `${driver.id}`,
      MessageBody: JSON.stringify(driver),
    }));

    try {
      await client.send(
        new SendMessageBatchCommand({
          QueueUrl: REQUEST_QUEUE_URL,
          Entries: entries,
        }),
      );

      for (const driver of batch) {
        metrics.timers.set(driver.cpf, Date.now());
      }

      metrics.sent += entries.length;
      console.log(chalk.gray(`→ Enviado batch: ${batch.map((d) => d.cpf).join(', ')}`));
      logProgress();
    } catch (err) {
      console.error(chalk.red('Erro ao enviar batch:'), err);
    }
  }

  console.log(chalk.greenBright('\n✅ Todas as consultas foram enviadas.'));
  console.log(chalk.greenBright('⏳ Aguardando respostas...\n'));

  pollQueue();
}

async function pollQueue() {
  try {
    const command = new ReceiveMessageCommand({
      QueueUrl: RESPONSE_QUEUE_URL,
      MaxNumberOfMessages: 10,
      WaitTimeSeconds: WAIT_TIME_SECONDS,
    });

    const { Messages } = await client.send(command);

    if (Messages && Messages.length > 0) {
      const batchData = Messages.map((m) => JSON.parse(m.Body));

      for (const msg of batchData) {
        const id = msg.payload?.id;
        const cpf = msg.payload?.cpf;
        const success = msg.result?.success;

        metrics.receivedIds.add(id);
        const start = metrics.timers.get(cpf);
        const duration = start ? ((Date.now() - start) / 1000).toFixed(2) : '?';

        metrics.received++;

        if (success) {
          metrics.success++;
          console.log(chalk.green(`✅ ${cpf} processado (${duration}s)`));
        } else {
          metrics.failed++;
          console.log(chalk.red(`❌ ${cpf} falhou (${duration}s)`));
        }

        if (start) metrics.durations.push(Number(duration));
        metrics.timers.delete(cpf);
        logProgress();
      }

      await deleteBatch(Messages);
    }
  } catch (err) {
    console.error(chalk.red('Erro ao consumir a fila:'), err);
  } finally {
    if (metrics.received < metrics.total) {
      setImmediate(pollQueue);
    } else {
      showFinalReport();
    }
  }
}

async function deleteBatch(messages) {
  const entries = messages.map((m) => ({
    Id: m.MessageId,
    ReceiptHandle: m.ReceiptHandle,
  }));

  if (entries.length === 0) return;

  await client.send(
    new DeleteMessageBatchCommand({
      QueueUrl: RESPONSE_QUEUE_URL,
      Entries: entries,
    }),
  );
}

async function showFinalReport() {
  const totalTime = ((Date.now() - metrics.startedAt) / 1000).toFixed(2);
  const avgTime =
    metrics.durations.length > 0
      ? (metrics.durations.reduce((a, b) => a + b, 0) / metrics.durations.length).toFixed(2)
      : 0;

  console.log('\n' + chalk.bgGreen.black('🏁 FINALIZADO'));
  console.log(chalk.greenBright(`✅ Sucesso: ${metrics.success}`));
  console.log(chalk.redBright(`❌ Falha: ${metrics.failed}`));
  console.log(chalk.cyanBright(`⏱️ Tempo total: ${totalTime}s`));
  console.log(chalk.magentaBright(`⚡ Tempo médio por item: ${avgTime}s`));

  // Comparar IDs enviados e recebidos
  const missing = [...sentIds].filter((id) => !metrics.receivedIds.has(id));
  const extra = [...metrics.receivedIds].filter((id) => !sentIds.has(id));

  if (missing.length > 0)
    console.log(chalk.redBright(`\n⚠️ ${missing.length} respostas não retornaram:`), missing);
  if (extra.length > 0)
    console.log(chalk.yellowBright(`\n⚠️ ${extra.length} respostas inesperadas:`), extra);

  // Mostrar quantidade de mensagens restantes na fila
  const remaining = await getQueueMessageCount(RESPONSE_QUEUE_URL);
  console.log(chalk.cyanBright(`\n📦 Mensagens restantes na fila de resposta: ${remaining}\n`));
}

async function getQueueMessageCount(queueUrl) {
  const command = new GetQueueAttributesCommand({
    QueueUrl: queueUrl,
    AttributeNames: ['ApproximateNumberOfMessages'],
  });
  const { Attributes } = await client.send(command);
  return Attributes?.ApproximateNumberOfMessages || 0;
}

(async () => {
  await purgeResponseQueue();
  await sendMessages();
})();
