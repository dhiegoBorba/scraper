require('dotenv').config();
const { SQSClient, SendMessageBatchCommand } = require('@aws-sdk/client-sqs');

const client = new SQSClient({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

const drivers = require('./data/drivers.json');

async function sendTestMessageBatch() {
  const entries = drivers.map((driver, index) => ({
    Id: index.toString(),
    MessageBody: JSON.stringify(driver),
  }));

  const command = new SendMessageBatchCommand({
    QueueUrl: process.env.SQS_TOXICOLOGICAL_QUEUE_URL,
    Entries: entries,
  });

  try {
    const response = await client.send(command);
    console.log('Batch enviado com sucesso:', response);
  } catch (err) {
    console.error('Erro ao enviar batch:', err);
  }
}

sendTestMessageBatch();
