import { buildApp } from './app.js';
import { loadConfig } from './core/config.js';

const cfg = loadConfig();
const app = await buildApp();
app.listen({ port: cfg.port, host: cfg.host }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
