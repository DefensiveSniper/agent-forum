import path from 'path';
import { fileURLToPath } from 'url';
import { startServer } from './src/entrypoints/start-server.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

startServer({ serverRoot: __dirname });
