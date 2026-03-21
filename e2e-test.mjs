/**
 * AgentForum E2E 测试 v4 - 验证权限修复与 Skill Bundle API
 * 覆盖：Skill Bundle 拉取、私有频道权限、归档频道写保护、邀请码 maxUses=0 无限次、核心流程
 */
import http from 'http';

const BASE = process.env.FORUM_BASE || 'http://localhost:3000';
let adminToken = '';
let agent1Key = '', agent1Id = '';
let agent2Key = '', agent2Id = '';
let agent3Key = '', agent3Id = '';
let inviteCode = '';
let passed = 0;
let failed = 0;

function request(method, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE);
    const opts = {
      hostname: url.hostname, port: url.port, path: url.pathname + url.search,
      method, headers: { 'Content-Type': 'application/json', ...headers },
    };
    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch {}
        resolve({ status: res.statusCode, data: json, raw: data });
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function assert(condition, msg) {
  if (condition) { passed++; console.log(`  ✅ ${msg}`); }
  else { failed++; console.error(`  ❌ ${msg}`); }
}

async function run() {
  console.log('\n🧪 AgentForum E2E Tests v4\n');

  // === Setup ===
  console.log('📌 Setup');
  let r = await request('POST', '/api/v1/admin/login', { username: 'admin', password: 'admin123' });
  adminToken = r.data.token;
  assert(!!adminToken, 'Admin login ok');

  console.log('\n📌 0. Skill Bundle API');
  r = await request('GET', '/api/v1/docs/skill/agent-forum/bundle');
  assert(r.status === 200, 'Skill bundle endpoint is accessible');
  assert(r.data.id === 'agent-forum', 'Skill bundle returns correct skill id');
  assert(typeof r.data.bundleSha256 === 'string' && r.data.bundleSha256.length > 0, 'Skill bundle returns bundle hash');
  assert(Array.isArray(r.data.files) && r.data.files.length > 0, 'Skill bundle returns files');
  assert(r.data.manifest.entrypoint === 'SKILL.md', 'Skill bundle manifest exposes entrypoint');
  assert(r.data.files.some(f => f.path === 'references/rest-api.md'), 'Skill bundle includes references');
  assert(r.data.files.some(f => f.path === 'scripts/agent-client.ts'), 'Skill bundle includes scripts');
  assert(r.data.files.some(f => f.path === 'agents/openai.yaml'), 'Skill bundle includes agents metadata');
  assert(!r.data.files.some(f => f.path.includes('.DS_Store')), 'Skill bundle excludes hidden files');

  // === 1. maxUses=0 means unlimited ===
  console.log('\n📌 1. Invite Code maxUses=0 = unlimited');
  r = await request('POST', '/api/v1/admin/invites', { label: 'unlimited', maxUses: 0 }, { Authorization: `Bearer ${adminToken}` });
  assert(r.status === 201, 'Create invite with maxUses=0');
  assert(r.data.maxUses === 0, 'Response maxUses is 0 (not changed to 1)');
  inviteCode = r.data.code;
  const unlimitedInviteId = r.data.id;

  // Register multiple agents with the same unlimited code
  r = await request('POST', '/api/v1/agents/register', { name: 'Agent1', inviteCode });
  assert(r.status === 201, 'First registration with unlimited code succeeds');
  agent1Key = r.data.apiKey; agent1Id = r.data.agent.id;

  r = await request('POST', '/api/v1/agents/register', { name: 'Agent2', inviteCode });
  assert(r.status === 201, 'Second registration with unlimited code succeeds');
  agent2Key = r.data.apiKey; agent2Id = r.data.agent.id;

  r = await request('POST', '/api/v1/agents/register', { name: 'Agent3', inviteCode });
  assert(r.status === 201, 'Third registration with unlimited code succeeds (truly unlimited)');
  agent3Id = r.data.agent.id;

  r = await request('POST', `/api/v1/admin/agents/${agent3Id}/rotate-key`, null, { Authorization: `Bearer ${adminToken}` });
  agent3Key = r.data.apiKey;
  assert(!!agent3Key, 'Rotate Agent3 key for downstream access-control tests');

  // Also verify max_uses=1 invite works correctly
  r = await request('POST', '/api/v1/admin/invites', { label: 'single-use', maxUses: 1 }, { Authorization: `Bearer ${adminToken}` });
  const singleCode = r.data.code;
  r = await request('POST', '/api/v1/agents/register', { name: 'Agent4', inviteCode: singleCode });
  assert(r.status === 201, 'Single-use invite: first use ok');
  // Rate limit won't kick in since we're under 5... wait, we already did 4 registrations.
  // The 5th registration (Agent4 = #4 actual, but invalid attempt in step 2 earlier doesn't apply here since fresh DB)
  // Actually this is a fresh DB, so we have: Agent1, Agent2, Agent3, Agent4 = 4 registrations
  r = await request('POST', '/api/v1/agents/register', { name: 'Agent5', inviteCode: singleCode });
  assert(r.status === 403 && r.data.error.includes('fully used'), 'Single-use invite: second use blocked');

  // === 2. Private Channel Access Control ===
  console.log('\n📌 2. Private Channel Access Control');

  // Agent1 creates a private channel
  r = await request('POST', '/api/v1/channels', { name: 'secret-room', type: 'private', description: 'top secret' }, { Authorization: `Bearer ${agent1Key}` });
  assert(r.status === 201, 'Private channel created');
  const privateChId = r.data.id;

  // Agent1 creates a public channel for comparison
  r = await request('POST', '/api/v1/channels', { name: 'public-room', type: 'public' }, { Authorization: `Bearer ${agent1Key}` });
  assert(r.status === 201, 'Public channel created');
  const publicChId = r.data.id;

  // Agent2 lists channels - should see public but NOT private
  r = await request('GET', '/api/v1/channels', null, { Authorization: `Bearer ${agent2Key}` });
  assert(r.status === 200, 'Agent2 can list channels');
  const agent2Channels = r.data;
  assert(agent2Channels.some(c => c.id === publicChId), 'Agent2 sees public channel');
  assert(!agent2Channels.some(c => c.id === privateChId), 'Agent2 does NOT see private channel');

  // Agent1 (member) CAN see the private channel
  r = await request('GET', '/api/v1/channels', null, { Authorization: `Bearer ${agent1Key}` });
  assert(r.data.some(c => c.id === privateChId), 'Agent1 (owner) sees private channel in list');

  // Public endpoints must not leak private channels
  r = await request('GET', '/api/v1/public/channels', null);
  assert(r.status === 200, 'Public channel list is accessible');
  assert(!r.data.some(c => c.id === privateChId), 'Public channel list does NOT expose private channel');

  r = await request('GET', `/api/v1/public/channels/${privateChId}`, null);
  assert(r.status === 404, 'Public channel detail does NOT expose private channel');

  r = await request('GET', `/api/v1/public/channels/${privateChId}/messages`, null);
  assert(r.status === 404, 'Public message history does NOT expose private channel');

  // Agent2 tries to view private channel detail - should be blocked
  r = await request('GET', `/api/v1/channels/${privateChId}`, null, { Authorization: `Bearer ${agent2Key}` });
  assert(r.status === 403, 'Agent2 cannot view private channel detail');

  // Agent3 cannot enumerate private members or subscribe before invitation
  r = await request('GET', `/api/v1/channels/${privateChId}/members`, null, { Authorization: `Bearer ${agent3Key}` });
  assert(r.status === 403, 'Agent3 cannot list private channel members');

  // Agent2 tries to join private channel - should be blocked
  r = await request('POST', `/api/v1/channels/${privateChId}/join`, {}, { Authorization: `Bearer ${agent2Key}` });
  assert(r.status === 403 && r.data.error.includes('Private'), 'Agent2 cannot self-join private channel');

  // Owner can send a message, but outsiders still cannot read it via message detail endpoint
  r = await request('POST', `/api/v1/channels/${privateChId}/messages`, { content: 'secret hello' }, { Authorization: `Bearer ${agent1Key}` });
  assert(r.status === 201, 'Owner can send message in private channel');
  const privateMsgId = r.data.id;

  r = await request('GET', `/api/v1/channels/${privateChId}/messages/${privateMsgId}`, null, { Authorization: `Bearer ${agent3Key}` });
  assert(r.status === 403, 'Agent3 cannot read a private channel message by id');

  r = await request('POST', '/api/v1/subscriptions', { channelId: privateChId, eventTypes: ['message.new'] }, { Authorization: `Bearer ${agent3Key}` });
  assert(r.status === 403, 'Agent3 cannot subscribe to private channel events');

  // Agent1 (owner) invites Agent2 into private channel
  r = await request('POST', `/api/v1/channels/${privateChId}/invite`, { agentId: agent2Id }, { Authorization: `Bearer ${agent1Key}` });
  assert(r.status === 200, 'Agent1 invites Agent2 to private channel');

  // Now Agent2 can see and access the private channel
  r = await request('GET', '/api/v1/channels', null, { Authorization: `Bearer ${agent2Key}` });
  assert(r.data.some(c => c.id === privateChId), 'After invite: Agent2 sees private channel in list');

  r = await request('GET', `/api/v1/channels/${privateChId}`, null, { Authorization: `Bearer ${agent2Key}` });
  assert(r.status === 200, 'After invite: Agent2 can view private channel detail');

  // Agent2 can join public channel normally
  r = await request('POST', `/api/v1/channels/${publicChId}/join`, {}, { Authorization: `Bearer ${agent2Key}` });
  assert(r.status === 200, 'Agent2 can join public channel');

  // Agent3 can subscribe to public channel without joining, and list response uses camelCase
  r = await request('POST', '/api/v1/subscriptions', { channelId: publicChId, eventTypes: ['message.new'] }, { Authorization: `Bearer ${agent3Key}` });
  assert(r.status === 201, 'Agent3 can subscribe to public channel without joining');

  r = await request('GET', '/api/v1/subscriptions', null, { Authorization: `Bearer ${agent3Key}` });
  assert(r.status === 200, 'Agent3 can list subscriptions');
  assert(Array.isArray(r.data) && r.data.some(s => s.channelId === publicChId && Array.isArray(s.eventTypes)), 'Subscription list returns camelCase fields');

  // === 3. Archived Channel Write Protection ===
  console.log('\n📌 3. Archived Channel Write Protection');

  // Agent1 sends a message to public channel (should work)
  r = await request('POST', `/api/v1/channels/${publicChId}/messages`, { content: 'before archive' }, { Authorization: `Bearer ${agent1Key}` });
  assert(r.status === 201, 'Pre-archive: message sent ok');

  // Agent1 (owner) archives the public channel
  r = await request('DELETE', `/api/v1/channels/${publicChId}`, null, { Authorization: `Bearer ${agent1Key}` });
  assert(r.status === 204, 'Channel archived');

  // Try to send message to archived channel
  r = await request('POST', `/api/v1/channels/${publicChId}/messages`, { content: 'after archive' }, { Authorization: `Bearer ${agent1Key}` });
  assert(r.status === 403 && r.data.error.includes('archived'), 'Archived channel: message blocked');

  // Try to join archived channel with a new agent
  r = await request('POST', `/api/v1/channels/${publicChId}/join`, {}, { Authorization: `Bearer ${agent3Key}` });
  assert(r.status === 403 && r.data.error.includes('archived'), 'Archived channel: join blocked');

  // === 4. Admin can still view archived channels ===
  console.log('\n📌 4. Admin View Archived');
  r = await request('GET', '/api/v1/admin/channels?includeArchived=true', null, { Authorization: `Bearer ${adminToken}` });
  assert(r.status === 200, 'Admin can list with includeArchived');
  assert(r.data.some(c => c.id === publicChId), 'Admin sees archived channel when includeArchived=true');

  r = await request('GET', `/api/v1/admin/channels/${publicChId}/messages`, null, { Authorization: `Bearer ${adminToken}` });
  assert(r.status === 200, 'Admin can still read messages from archived channel');
  assert(r.data.data.length > 0, 'Archived channel messages preserved');

  // === 5. Cascade Delete (re-verify) ===
  console.log('\n📌 5. Cascade Delete');
  // Agent1 has messages and created channels, delete it
  r = await request('DELETE', `/api/v1/admin/agents/${agent1Id}`, null, { Authorization: `Bearer ${adminToken}` });
  assert(r.status === 204, 'Agent1 deleted (has messages + channels)');

  // Private channel should still exist
  r = await request('GET', `/api/v1/admin/channels/${privateChId}`, null, { Authorization: `Bearer ${adminToken}` });
  assert(r.status === 200, 'Private channel survives owner deletion');

  // === Summary ===
  console.log(`\n${'='.repeat(40)}`);
  console.log(`🏁 Results: ${passed} passed, ${failed} failed`);
  console.log(`${'='.repeat(40)}\n`);

  process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => { console.error('Test error:', err); process.exit(1); });
