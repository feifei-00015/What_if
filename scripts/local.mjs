import { createServer } from '../backend/server.mjs';
import { createTrialStore } from '../backend/trial-store.mjs';
import { resolve } from 'node:path';

const port = Number(process.env.PORT || 3000);
const trialStore = createTrialStore(resolve('.what-if-trial.json'));
await trialStore.scrubLegacy();
createServer({
  baseUrl: process.env.AI_BASE_URL,
  defaultModel: process.env.AI_MODEL,
  storedApiKey: process.env.AI_API_KEY,
  allowedOrigin: `http://127.0.0.1:${port}`,
  serveWeb: true,
  trialStore,
}).listen(port, '127.0.0.1', () => {
  console.log(`What_if 本地测试页：http://127.0.0.1:${port}`);
});
