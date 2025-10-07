require('dotenv').config();
const {
  SQSClient,
  ReceiveMessageCommand,
  SendMessageCommand,
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
  if (!messages || messages.length === 0) return;

  const entries = messages.map((m) => ({
    Id: m.MessageId,
    ReceiptHandle: m.ReceiptHandle,
  }));

  try {
    await client.send(
      new DeleteMessageBatchCommand({
        QueueUrl: process.env.SQS_TOXICOLOGICAL_REQUEST_QUEUE_URL,
        Entries: entries,
      }),
    );
  } catch (err) {
    console.error('Erro ao deletar mensagens do batch:', err);
  }
}

async function pollQueue() {
  try {
    console.log(`\nCONSUMER - ${new Date().toISOString()} | Polling queue...`);

    const command = new ReceiveMessageCommand({
      QueueUrl: process.env.SQS_TOXICOLOGICAL_REQUEST_QUEUE_URL,
      MaxNumberOfMessages: process.env.BATCH_SIZE,
      WaitTimeSeconds: process.env.WAIT_TIME_SECONDS,
    });

    const { Messages } = await client.send(command);

    if (Messages && Messages.length > 0) {
      console.log(
        `CONSUMER - ${new Date().toISOString()} | Batch of ${Messages.length} messages...`,
      );

      const toxicologicalScraper = new ToxicologicalScraper({
        maxConcurrency: process.env.MAX_CONCURRENCY,
      });
      const batchData = Messages.map((m) => JSON.parse(m.Body));

      for await (const result of toxicologicalScraper.processBatch(batchData)) {
        console.log(
          `CONSUMER - ${new Date().toISOString()} | Finished ${result.payload.cpf}, result: ${
            result.result.expired_at
          }`,
        );

        const sendCommand = new SendMessageCommand({
          QueueUrl: process.env.SQS_TOXICOLOGICAL_RESPONSE_QUEUE_URL,
          MessageBody: JSON.stringify(result),
        });

        try {
          await client.send(sendCommand);
        } catch (err) {
          console.error('Erro ao enviar mensagem individual:', err);
        }
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
