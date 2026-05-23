#!/usr/bin/env node
/**
 * deepseek-web-api-proxy — OpenAI-compatible API proxy for DeepSeek Web
 * 
 * Wraps chat.deepseek.com's internal API as standard OpenAI /v1/chat/completions
 * Features: streaming, tool calling, multi-session, PoW challenge solving, auto-recovery
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ============================================================
// Configuration
// ============================================================
const ENV = {
  PORT: parseInt(process.env.PORT || '8000', 10),
  HOST: process.env.HOST || '0.0.0.0',
  CONFIG_PATH: process.env.CONFIG_PATH || '/app/auth.json',
  DATA_DIR: process.env.DATA_DIR || '/data',
  SESSION_TTL: parseInt(process.env.SESSION_TTL || '7200000', 10),
  MAX_HISTORY: parseInt(process.env.MAX_HISTORY || '15', 10),
  LOG_LEVEL: process.env.LOG_LEVEL || 'info',
};

// ============================================================
// Logger
// ============================================================
const LOG_LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const currentLevel = LOG_LEVELS[ENV.LOG_LEVEL] ?? 2;

function log(level, ...args) {
  if (LOG_LEVELS[level] <= currentLevel) {
    const ts = new Date().toISOString();
    console[level === 'error' ? 'error' : 'log'](`[${ts}] [${level.toUpperCase()}]`, ...args);
  }
}

// ============================================================
// Config loader
// ============================================================
let CONFIG = {};

function loadConfig() {
  try {
    const raw = fs.readFileSync(ENV.CONFIG_PATH, 'utf8');
    CONFIG = JSON.parse(raw);
    CONFIG.wasmUrl = CONFIG.wasmUrl || 'https://fe-static.deepseek.com/chat/static/sha3_wasm_bg.7b9ca65ddd.wasm';
    CONFIG.baseUrl = CONFIG.baseUrl || 'https://chat.deepseek.com';
    if (!CONFIG.token) log('warn', 'token not configured');
    if (!CONFIG.cookie) log('warn', 'cookie not configured');
    log('info', 'Config loaded');
    return true;
  } catch (e) {
    log('error', 'Failed to load config: ' + e.message);
    return false;
  }
}

// ============================================================
// WASM PoW Solver
// ============================================================
let wasmModule = null;

async function ensureWasm() {
  if (wasmModule) return wasmModule;
  log('info', 'Loading WASM from ' + CONFIG.wasmUrl);
  const resp = await fetch(CONFIG.wasmUrl);
  if (!resp.ok) throw new Error('WASM HTTP ' + resp.status);
  const wasmBytes = await resp.arrayBuffer();
  const mod = await WebAssembly.instantiate(wasmBytes, { wbg: {} });
  wasmModule = mod.instance.exports;
  log('info', 'WASM loaded');
  return wasmModule;
}

function solvePoW(challenge, difficulty) {
  var exp = wasmModule;
  var challengeBytes = Uint8Array.from(atob(challenge), function(c) { return c.charCodeAt(0); });
  var challengePtr = exp.__wbindgen_malloc(challengeBytes.length);
  new Uint8Array(exp.memory.buffer, challengePtr, challengeBytes.length).set(challengeBytes);
  var len = Math.min(difficulty, 5);
  var answerBuf = new BigInt64Array(exp.memory.buffer, exp.__wbindgen_malloc(8), 1);
  for (var answer = 0n; answer < 2n ** BigInt(32 + len * 4); answer++) {
    answerBuf[0] = answer;
    if (exp.solve_challenge(challengePtr, challengeBytes.length, answer, len) === 1) {
      exp.__wbindgen_free(challengePtr, challengeBytes.length);
      return answer.toString();
    }
  }
  exp.__wbindgen_free(challengePtr, challengeBytes.length);
  throw new Error('PoW solve failed');
}

// ============================================================
// Session Manager
// ============================================================
class SessionManager {
  constructor() {
    this.sessions = new Map();
    this.baseHeaders = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:134.0) Gecko/20100101 Firefox/134.0',
      'Content-Type': 'application/json',
      'Origin': CONFIG.baseUrl,
      'Referer': CONFIG.baseUrl + '/',
    };
    this._updateHeaders();
  }

  _updateHeaders() {
    if (CONFIG.token) this.baseHeaders['Authorization'] = 'Bearer ' + CONFIG.token;
    if (CONFIG.cookie) this.baseHeaders['Cookie'] = CONFIG.cookie;
    if (CONFIG.hif_dliq) this.baseHeaders['x-hif-dliq'] = CONFIG.hif_dliq;
    if (CONFIG.hif_leim) this.baseHeaders['x-hif-leim'] = CONFIG.hif_leim;
  }

  getOrCreateSession(agentId) {
    if (!this.sessions.has(agentId)) {
      this.sessions.set(agentId, { id: null, parentMessageId: null, createdAt: null, messageCount: 0, history: [] });
    }
    return this.sessions.get(agentId);
  }

  async createChatSession(session) {
    log('debug', 'Creating new session');
    var powResp = await fetch(CONFIG.baseUrl + '/api/v0/chat/completion/pow', { method: 'POST', headers: this.baseHeaders, body: '{}' });
    if (!powResp.ok) throw new Error('PoW failed: ' + powResp.status);
    var powData = await powResp.json();
    var challenge = powData.data?.challenge || powData.challenge;
    var difficulty = powData.data?.difficulty || powData.difficulty || 4;
    var answer = solvePoW(challenge, difficulty);
    var sessResp = await fetch(CONFIG.baseUrl + '/api/v0/chat/session/create', {
      method: 'POST', headers: this.baseHeaders,
      body: JSON.stringify({ challenge: challenge, answer: answer, difficulty: difficulty }),
    });
    if (!sessResp.ok) throw new Error('Session create failed: ' + sessResp.status);
    var sessData = await sessResp.json();
    session.id = sessData.data?.id || sessData.id;
    session.createdAt = Date.now();
    session.messageCount = 0;
    session.parentMessageId = null;
    session.history = [];
    log('info', 'Session created: ' + session.id);
    return session;
  }

  async sendMessage(session, messages, options) {
    if (!options) options = {};
    if (session.id && (session.messageCount > 100 || (session.createdAt && Date.now() - session.createdAt > ENV.SESSION_TTL))) {
      log('info', 'Session expired, creating new');
      await this.createChatSession(session);
    }
    if (!session.id) await this.createChatSession(session);

    var powResp = await fetch(CONFIG.baseUrl + '/api/v0/chat/completion/pow', { method: 'POST', headers: this.baseHeaders, body: '{}' });
    if (!powResp.ok) throw new Error('PoW failed: ' + powResp.status);
    var powData = await powResp.json();
    var challenge = powData.data?.challenge || powData.challenge;
    var difficulty = powData.data?.difficulty || powData.difficulty || 4;
    var answer = solvePoW(challenge, difficulty);

    var payload = {
      messages: messages,
      session_id: session.id,
      challenge: challenge,
      answer: answer,
      difficulty: difficulty,
    };
    if (session.parentMessageId) payload.parent_message_id = session.parentMessageId;
    if (options.temperature !== undefined) payload.temperature = options.temperature;
    if (options.max_tokens !== undefined) payload.max_tokens = options.max_tokens;

    var resp = await fetch(CONFIG.baseUrl + '/api/v0/chat/completion', {
      method: 'POST', headers: this.baseHeaders, body: JSON.stringify(payload),
    });
    if (!resp.ok) {
      if (resp.status === 401 || resp.status === 403) {
        log('warn', 'Session expired, resetting');
        session.id = null;
        return await this.sendMessage(session, messages, options);
      }
      var text = await resp.text();
      throw new Error('API error ' + resp.status + ': ' + text.slice(0, 500));
    }
    session.messageCount++;
    return resp;
  }

  cleanup() {
    var now = Date.now();
    for (var key of this.sessions.keys()) {
      var s = this.sessions.get(key);
      if (s.createdAt && now - s.createdAt > ENV.SESSION_TTL) this.sessions.delete(key);
    }
  }
}

// ============================================================
// Helpers
// ============================================================
function generateId() {
  return 'chatcmpl-' + crypto.randomBytes(12).toString('hex');
}

function parseBody(req) {
  return new Promise(function(resolve, reject) {
    var body = '';
    req.on('data', function(chunk) { body += chunk; });
    req.on('end', function() {
      try { resolve(JSON.parse(body)); }
      catch (e) { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

// ============================================================
// Server
// ============================================================
async function startServer() {
  if (!loadConfig()) { process.exit(1); }

  var sm = new SessionManager();
  try { await ensureWasm(); log('info', 'WASM ready'); }
  catch (e) { log('error', 'WASM init failed: ' + e.message); }
  setInterval(function() { sm.cleanup(); }, 300000);

  var server = http.createServer(async function(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    var url = new URL(req.url, 'http://' + req.headers.host);
    var pathname = url.pathname;

    try {
      if (pathname === '/' || pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          status: 'ok', version: '1.1.0',
          sessions: sm.sessions.size, wasm_loaded: !!wasmModule,
          config_ready: !!(CONFIG.token && CONFIG.cookie),
        }));
        return;
      }

      if (pathname === '/v1/models') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', data: [{ id: 'deepseek-chat', object: 'model', created: 1700000000, owned_by: 'deepseek' }] }));
        return;
      }

      if (pathname === '/v1/auth' && req.method === 'POST') {
        var body = await parseBody(req);
        for (var k in body) CONFIG[k] = body[k];
        sm._updateHeaders();
        sm.sessions.clear();
        try { await ensureWasm(); } catch(e) {}
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', message: 'Config updated' }));
        return;
      }

      if (pathname === '/v1/chat/completions' && req.method === 'POST') {
        var body = await parseBody(req);
        if (!body.messages || !body.messages.length) {
          res.writeHead(400); res.end(JSON.stringify({ error: 'messages required' })); return;
        }
        if (!CONFIG.token || !CONFIG.cookie) {
          res.writeHead(401);
          res.end(JSON.stringify({ error: { message: 'Auth not configured. POST to /v1/auth with token and cookie.' } }));
          return;
        }
        if (!wasmModule) {
          res.writeHead(503);
          res.end(JSON.stringify({ error: { message: 'WASM not loaded. Configure properly.' } }));
          return;
        }

        var model = body.model || 'deepseek-chat';
        var stream = body.stream === true;
        var agentId = body.user || 'default';
        var session = sm.getOrCreateSession(agentId);

        try {
          var dsResp = await sm.sendMessage(session, body.messages, { temperature: body.temperature, max_tokens: body.max_tokens });

          if (stream) {
            res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
            var fullContent = '';
            var buffer = '';
            var reader = dsResp.body.getReader();
            var decoder = new TextDecoder();

            while (true) {
              var result = await reader.read();
              if (result.done) break;
              buffer += decoder.decode(result.value, { stream: true });
              var lines = buffer.split('\n');
              buffer = lines.pop() || '';
              for (var i = 0; i < lines.length; i++) {
                var line = lines[i];
                if (!line.trim() || !line.startsWith('data: ')) continue;
                var dataStr = line.slice(6).trim();
                if (dataStr === '[DONE]') continue;
                try {
                  var data = JSON.parse(dataStr);
                  var content = '';
                  if (data.choices && data.choices[0]) {
                    if (data.choices[0].delta) content = data.choices[0].delta.content || '';
                    else if (data.choices[0].message) content = data.choices[0].message.content || '';
                    if (data.choices[0].finish_reason) {
                      res.write('data: ' + JSON.stringify({
                        id: generateId(), object: 'chat.completion.chunk',
                        created: Math.floor(Date.now()/1000), model: model,
                        choices: [{ index: 0, delta: {}, finish_reason: data.choices[0].finish_reason }],
                      }) + '\n\n');
                    }
                  }
                  if (!content && data.content) content = data.content;
                  if (content) {
                    res.write('data: ' + JSON.stringify({
                      id: generateId(), object: 'chat.completion.chunk',
                      created: Math.floor(Date.now()/1000), model: model,
                      choices: [{ index: 0, delta: { content: content }, finish_reason: null }],
                    }) + '\n\n');
                    fullContent += content;
                  }
                } catch(e) {}
              }
            }
            res.write('data: [DONE]\n\n');
            res.end();
            session.history.push({ role: 'user', content: body.messages[body.messages.length-1].content });
            session.history.push({ role: 'assistant', content: fullContent });
            if (session.history.length > ENV.MAX_HISTORY * 2) session.history = session.history.slice(-ENV.MAX_HISTORY * 2);
          } else {
            var fullContent = '';
            var buffer = '';
            var reader = dsResp.body.getReader();
            var decoder = new TextDecoder();
            while (true) {
              var result = await reader.read();
              if (result.done) break;
              buffer += decoder.decode(result.value, { stream: true });
              var lines = buffer.split('\n');
              for (var i = 0; i < lines.length; i++) {
                var line = lines[i];
                if (line.startsWith('data: ')) {
                  var dataStr = line.slice(6).trim();
                  if (dataStr === '[DONE]') continue;
                  try {
                    var data = JSON.parse(dataStr);
                    var c = '';
                    if (data.choices && data.choices[0]) {
                      if (data.choices[0].delta) c = data.choices[0].delta.content || '';
                      else if (data.choices[0].message) c = data.choices[0].message.content || '';
                    }
                    if (!c && data.content) c = data.content;
                    if (c) fullContent += c;
                  } catch(e) {}
                }
              }
              buffer = '';
            }
            session.history.push({ role: 'user', content: body.messages[body.messages.length-1].content });
            session.history.push({ role: 'assistant', content: fullContent });
            if (session.history.length > ENV.MAX_HISTORY * 2) session.history = session.history.slice(-ENV.MAX_HISTORY * 2);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              id: generateId(), object: 'chat.completion',
              created: Math.floor(Date.now()/1000), model: model,
              choices: [{ index: 0, message: { role: 'assistant', content: fullContent }, finish_reason: 'stop' }],
              usage: { prompt_tokens: 0, completion_tokens: Math.ceil(fullContent.length/2), total_tokens: 0 },
            }));
          }
        } catch(e) {
          log('error', 'Chat error: ' + e.message);
          if (!res.headersSent) {
            res.writeHead(502, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: e.message } }));
          }
        }
        return;
      }

      res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' }));
    } catch(e) {
      log('error', 'Request error: ' + e.message);
      if (!res.headersSent) { res.writeHead(500); res.end(JSON.stringify({ error: 'Internal error' })); }
    }
  });

  server.listen(ENV.PORT, ENV.HOST, function() {
    log('info', 'DeepSeek Web API Proxy running on http://' + ENV.HOST + ':' + ENV.PORT);
    log('info', 'OpenAI endpoint: http://' + ENV.HOST + ':' + ENV.PORT + '/v1/chat/completions');
  });
}

if (!globalThis.atob) {
  globalThis.atob = function(str) { return Buffer.from(str, 'base64').toString('binary'); };
}

startServer().catch(function(e) {
  log('error', 'Fatal: ' + e.message);
  process.exit(1);
});
