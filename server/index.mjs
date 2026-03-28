import path from 'path';
import { fileURLToPath } from 'url';
import { startServer } from './src/app.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

startServer({ serverRoot: __dirname }).catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
