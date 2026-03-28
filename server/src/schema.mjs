import { pgTable, text, integer, primaryKey, index } from 'drizzle-orm/pg-core';

// ─── admin_users ───────────────────────────────────────────────
export const adminUsers = pgTable('admin_users', {
  id: text('id').primaryKey(),
  username: text('username').unique().notNull(),
  password_hash: text('password_hash').notNull(),
  role: text('role').default('admin'),
  created_at: text('created_at'),
});

// ─── invite_codes ──────────────────────────────────────────────
export const inviteCodes = pgTable('invite_codes', {
  id: text('id').primaryKey(),
  code: text('code').unique().notNull(),
  label: text('label'),
  created_by: text('created_by'),
  used_by: text('used_by'),
  max_uses: integer('max_uses').default(1),
  uses_count: integer('uses_count').default(0),
  expires_at: text('expires_at'),
  revoked: integer('revoked').default(0),
  created_at: text('created_at'),
}, (table) => [
  index('idx_invite_codes_code').on(table.code),
]);

// ─── agents ────────────────────────────────────────────────────
export const agents = pgTable('agents', {
  id: text('id').primaryKey(),
  name: text('name').unique().notNull(),
  description: text('description'),
  api_key_hash: text('api_key_hash').notNull(),
  invite_code_id: text('invite_code_id'),
  status: text('status').default('active'),
  metadata: text('metadata'),
  created_at: text('created_at'),
  last_seen_at: text('last_seen_at'),
}, (table) => [
  index('idx_agents_api_key').on(table.api_key_hash),
]);

// ─── channels ──────────────────────────────────────────────────
export const channels = pgTable('channels', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description'),
  type: text('type').default('public'),
  created_by: text('created_by'),
  max_members: integer('max_members').default(100),
  is_archived: integer('is_archived').default(0),
  created_at: text('created_at'),
  updated_at: text('updated_at'),
});

// ─── messages ──────────────────────────────────────────────────
export const messages = pgTable('messages', {
  id: text('id').primaryKey(),
  channel_id: text('channel_id').notNull(),
  sender_id: text('sender_id').notNull(),
  content: text('content'),
  content_type: text('content_type').default('text'),
  reply_to: text('reply_to'),
  created_at: text('created_at'),
  mentions: text('mentions'),
  reply_target_agent_id: text('reply_target_agent_id'),
  discussion_session_id: text('discussion_session_id'),
  discussion_state: text('discussion_state'),
}, (table) => [
  index('idx_messages_channel').on(table.channel_id),
  index('idx_messages_created').on(table.created_at),
  index('idx_messages_discussion_session').on(table.discussion_session_id),
]);

// ─── discussion_sessions ───────────────────────────────────────
export const discussionSessions = pgTable('discussion_sessions', {
  id: text('id').primaryKey(),
  channel_id: text('channel_id').notNull(),
  root_message_id: text('root_message_id').notNull(),
  participant_agent_ids: text('participant_agent_ids').notNull(),
  current_index: integer('current_index').default(0),
  completed_rounds: integer('completed_rounds').default(0),
  max_rounds: integer('max_rounds').notNull(),
  next_agent_id: text('next_agent_id'),
  last_message_id: text('last_message_id'),
  status: text('status').default('active'),
  created_by: text('created_by'),
  created_at: text('created_at'),
  updated_at: text('updated_at'),
  closed_at: text('closed_at'),
}, (table) => [
  index('idx_discussion_sessions_channel').on(table.channel_id),
  index('idx_discussion_sessions_status').on(table.status),
]);

// ─── channel_members ───────────────────────────────────────────
export const channelMembers = pgTable('channel_members', {
  channel_id: text('channel_id').notNull(),
  agent_id: text('agent_id').notNull(),
  role: text('role').default('member'),
  joined_at: text('joined_at'),
}, (table) => [
  primaryKey({ columns: [table.channel_id, table.agent_id] }),
]);

// ─── subscriptions ─────────────────────────────────────────────
export const subscriptions = pgTable('subscriptions', {
  id: text('id').primaryKey(),
  agent_id: text('agent_id').notNull(),
  channel_id: text('channel_id').notNull(),
  event_types: text('event_types'),
  created_at: text('created_at'),
});

// ─── skill_docs ────────────────────────────────────────────────
export const skillDocs = pgTable('skill_docs', {
  id: text('id').primaryKey(),
  content: text('content').notNull(),
  updated_at: text('updated_at'),
  updated_by: text('updated_by'),
});
