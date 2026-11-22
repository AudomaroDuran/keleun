// Claude Code simulado para la UAT en una máquina sin cuenta de Claude (GitHub Actions). Habla como `claude -p
// --input-format stream-json --output-format stream-json`: lee los mensajes de la persona, escribe la transcripción donde
// la escribe Claude Code (~/.claude/projects/<carpeta>/<sesión>.jsonl) y, antes de responder, pide permiso para un
// comando por el mismo camino que el real: el servidor MCP de permisos de keleun que viene en --mcp-config (corre con
// keleun.exe como Node). Responde «listo · permiso allow» o «… deny» según lo que decida la persona en la app.
// keleun lo usa con BITACORA_CLAUDE_BIN='["<node>","<este archivo>"]'. Sin dependencias.
import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const val = (k) => (args.includes(k) ? args[args.indexOf(k) + 1] : undefined);
const sid = val('--session-id') ?? val('--resume');
const model = val('--model') ?? 'claude-simulado';
const dir = join(homedir(), '.claude', 'projects', process.cwd().replace(/[^a-zA-Z0-9]/g, '-'));
mkdirSync(dir, { recursive: true });
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const write = (o) => appendFileSync(join(dir, `${sid}.jsonl`), `${JSON.stringify({ sessionId: sid, cwd: process.cwd(), timestamp: new Date().toISOString(), uuid: `${o.type}-${Date.now()}-${Math.random().toString(36).slice(2)}`, ...o })}\n`);
out({ type: 'system', subtype: 'init', session_id: sid, model });

/* ---------- Cliente MCP mínimo (stdio, JSON por línea) para el servidor de permisos ---------- */

function permissionServer() {
  const cfg = val('--mcp-config');
  if (!cfg) return undefined;
  const s = JSON.parse(cfg).mcpServers?.cairn_permisos;
  if (!s) return undefined;
  const p = spawn(s.command, s.args ?? [], { env: { ...process.env, ...(s.env ?? {}) }, stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true });
  let buf = '';
  const waiting = new Map();
  p.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      const m = JSON.parse(line);
      if (m.id !== undefined && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); }
    }
  });
  let next = 1;
  const call = (method, params) => new Promise((res) => { const id = next++; waiting.set(id, res); p.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); });
  const ready = call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-simulado', version: '1' } })
    .then(() => p.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`));
  return {
    async approve(tool, input) {
      await ready;
      const r = await call('tools/call', { name: 'approve', arguments: { tool_name: tool, input } });
      return JSON.parse(r.result?.content?.[0]?.text ?? '{"behavior":"deny"}');
    },
    close: () => p.kill(),
  };
}
const perm = permissionServer();

/* ---------- Conversación ---------- */

let buf = '';
const queue = [];
let busy = false;
async function answer(o) {
  busy = true;
  const content = o.message.content;
  const text = Array.isArray(content) ? content.filter((c) => c.type === 'text').map((c) => c.text).join('') : String(content);
  write({ type: 'user', message: { role: 'user', content: text } });
  out({ type: 'assistant', message: { content: [{ type: 'text', text: 'Voy a correr un comando; te pido permiso.' }] } });
  const command = 'echo hola desde la UAT';
  const decision = perm ? await perm.approve('Bash', { command, description: 'Prueba de la UAT' }) : { behavior: 'allow' };
  const reply = `listo · permiso ${decision.behavior}`;
  write({ type: 'assistant', message: { role: 'assistant', model, content: [{ type: 'tool_use', id: `t${Date.now()}`, name: 'Bash', input: { command } }, { type: 'text', text: reply }] } });
  out({ type: 'assistant', message: { content: [{ type: 'text', text: reply }] } });
  out({ type: 'result', is_error: false, total_cost_usd: 0 });
  busy = false;
  const n = queue.shift();
  if (n) answer(n);
}
process.stdin.on('data', (d) => {
  buf += d;
  const lines = buf.split('\n');
  buf = lines.pop();
  for (const l of lines) {
    if (!l.trim()) continue;
    const o = JSON.parse(l);
    if (o.type === 'control_request') { out({ type: 'control_response', response: { subtype: 'success', request_id: o.request_id, response: {} } }); continue; }
    if (o.type !== 'user') continue;
    if (busy) queue.push(o); else answer(o);
  }
});
process.stdin.on('end', () => { perm?.close(); process.exit(0); });
