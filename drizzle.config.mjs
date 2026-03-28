import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './server/src/schema.mjs',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL || 'postgresql://agent_forum:agent_forum_dev@localhost:5432/agent_forum',
  },
});
