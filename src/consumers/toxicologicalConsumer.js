require('dotenv').config();
const {
  SQSClient,
  ReceiveMessageCommand,
  DeleteMessageBatchCommand,
} = require('@aws-sdk/client-sqs');

const ToxicologicalScraper = require('../scrapers/ToxicologicalScraper');

const client = new SQSClient({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

async function deleteBatch(messages) {
  const entries = messages.map((m) => ({
    Id: m.MessageId,
    ReceiptHandle: m.ReceiptHandle,
  }));

  if (entries.length === 0) return;

  await client.send(
    new DeleteMessageBatchCommand({
      QueueUrl: process.env.SQS_TOXICOLOGICAL_QUEUE_URL,
      Entries: entries,
    }),
  );
}

async function pollQueue() {
  try {
    console.log('CONSUMER - Poll queue ...');
    const command = new ReceiveMessageCommand({
      QueueUrl: process.env.SQS_TOXICOLOGICAL_QUEUE_URL,
      MaxNumberOfMessages: process.env.BATCH_SIZE,
      WaitTimeSeconds: process.env.WAIT_TIME_SECONDS,
    });

    const toxicologicalScraper = new ToxicologicalScraper({ maxConcurrency: 5 });

    const { Messages } = await client.send(command);

    if (Messages && Messages.length > 0) {
      const batchData = Messages.map((m) => JSON.parse(m.Body));

      console.log(`CONSUMER - Batch of ${Messages.length} messages...`);

      for await (const result of toxicologicalScraper.processBatch(batchData)) {
        console.log(`CONSUMER - Finish ${result.payload.cpf}, result ${result.result.expired_at}`);
      }

      await deleteBatch(Messages);
    }
  } catch (err) {
    console.error('Erro ao consumir a fila:', err);
  } finally {
    setImmediate(pollQueue);
  }
}

pollQueue();
