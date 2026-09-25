const express = require('express');
const axios = require('axios');
require('dotenv').config();

const app = express();
app.use(express.json({ limit: '2mb' }));

const DEFAULT_MODEL = 'claude-sonnet-4-5-20250929';
const GOCAAS_TIMEOUT_MS = Number(process.env.GOCAAS_TIMEOUT_MS || 180000);

// CORS for FireWally / browser extensions
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// POC: companion IDs are remapped to Claude + a system prompt (S2S cannot run Open WebUI companions as-is).
const WSS_PROMPTS = {
  'wss--502-error-workflow': `You are an expert Website Security Support (WSS) Level II/III Analyst assisting with 502 Bad Gateway troubleshooting.
When given a domain, host type, and client status (Sucuri WAF vs GoDaddy hosting), provide structured diagnostics:
1. Verify Origin reachability and DNS resolution.
2. Check WAF / Sucuri edge response headers and error codes.
3. Diagnose Web server (Nginx/Apache) timeouts and upstream PHP-FPM / application crashes.
4. Output a clear, professional, customer-facing email explanation and internal analyst notes.`,

  'wss-email-response-companion': `You are an expert Website Security Support (WSS) companion helping analysts craft high-quality, professional customer communications for tickets regarding DNS, SSL/TLS, WAF configuration, malware remediation, and server connectivity. Keep responses clear, polite, and actionable.`,

  'wss--ai-crawler-investigation': `You are a WSS analyst specializing in AI crawler / bot traffic investigations (GPTBot, ClaudeBot, Bytespider, etc.). Help identify crawler impact, robots.txt guidance, WAF/rate-limit options, and draft clear customer-facing explanations.`,

  'website-security-waf-activation-companion': `You are a WSS companion guiding Website Security / Sucuri WAF activation and firewall setup. Provide step-by-step activation checks, common pitfalls, and professional customer responses.`,

  'wss-hosting-troubleshooting': `You are a WSS hosting troubleshooting companion. Diagnose site-down, PHP/MySQL, WordPress, cPanel, DNS, FTP/SSH, and migration issues. Give structured internal notes plus a customer-ready reply.`,

  'wss--ssl-troubleshooting': `You are a WSS SSL/TLS troubleshooting companion. Diagnose certificate errors, SAN issues, mixed content, Let's Encrypt renewals, and “Not Secure” browser warnings. Provide clear fix steps and customer-facing language.`,

  'wss---backup-setup-and-troubleshooting': `You are a WSS backup setup & troubleshooting companion (CodeGuard / site backups). Help with backup configuration, failed backups/restores, and customer guidance.`,

  'wss--provisioning-failure-companion': `You are a WSS provisioning failure companion. Diagnose failed product provisioning, check likely causes, suggest next steps, and draft professional customer updates.`,

  'wss--monitoring-setup--alerts-companion': `You are a Website Security Support (WSS) monitoring setup & alerts companion for GoDaddy Website Security / Sucuri-related uptime and performance monitoring — not WebSockets. Help analysts set up monitoring, configure alerts, troubleshoot monitoring that is not working, and write clear customer-facing instructions.`,
};

const GENERIC_WSS_PROMPT = `You are an expert Website Security Support (WSS) analyst assistant at GoDaddy (not WebSockets). Help with ticket diagnosis and professional customer communications. Be clear, actionable, and concise.`;

let cachedToken = null;
let tokenExpiresAt = 0;

async function getS2SToken() {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && tokenExpiresAt > now + 60) return cachedToken;

  console.log('[Auth] Fetching fresh S2S OAuth token...');
  const params = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: process.env.OAUTH_CLIENT_ID,
    client_secret: process.env.OAUTH_CLIENT_SECRET,
    scope: 'profile'
  });

  const response = await axios.post(process.env.GODADDY_OAUTH_URL, params.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    timeout: 30000,
  });

  cachedToken = response.data.access_token;
  tokenExpiresAt = now + (response.data.expires_in || 3600);
  console.log('[Auth] Token acquired successfully');
  return cachedToken;
}

function resolveModelAndMessages(requestedModel, messages) {
  let model = requestedModel || DEFAULT_MODEL;
  let msgs = Array.isArray(messages) ? [...messages] : [];

  if (WSS_PROMPTS[model]) {
    console.log(`[Preset] Applying system prompt for: ${model}`);
    msgs = [
      { role: 'system', content: WSS_PROMPTS[model] },
      ...msgs.filter(m => m.role !== 'system'),
    ];
    return { model: DEFAULT_MODEL, messages: msgs, remappedFrom: requestedModel };
  }

  // Any other wss-* id: remap so GoCaaS is never asked for an Open WebUI companion slug.
  if (/^wss/i.test(String(model)) || /companion/i.test(String(model))) {
    console.log(`[Preset] Generic WSS remap for unknown companion: ${model}`);
    msgs = [
      { role: 'system', content: GENERIC_WSS_PROMPT },
      ...msgs.filter(m => m.role !== 'system'),
    ];
    return { model: DEFAULT_MODEL, messages: msgs, remappedFrom: requestedModel };
  }

  return { model, messages: msgs, remappedFrom: null };
}

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'gravity-tools-relay' });
});

app.post('/api/v1/relay/chat', async (req, res) => {
  try {
    const token = await getS2SToken();
    const { model: requestedModel = DEFAULT_MODEL, messages = [], stream = false } = req.body || {};
    const resolved = resolveModelAndMessages(requestedModel, messages);

    console.log(`[Relay] ${resolved.remappedFrom ? `${resolved.remappedFrom} → ` : ''}${resolved.model} (stream: ${stream})`);

    const gocaasResponse = await axios({
      method: 'post',
      url: `${process.env.GOCAAS_BASE_URL}/api/chat/completions`,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      data: { model: resolved.model, messages: resolved.messages, stream },
      responseType: stream ? 'stream' : 'json',
      timeout: GOCAAS_TIMEOUT_MS,
    });

    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      gocaasResponse.data.pipe(res);
    } else {
      res.json(gocaasResponse.data);
    }
  } catch (err) {
    const status = err.response?.status || 500;
    const data = err.response?.data || err.message;
    const isTimeout = err.code === 'ECONNABORTED' || /timeout/i.test(String(err.message || ''));
    console.error('[Relay Error]', status, data);
    res.status(isTimeout ? 504 : status).json({
      error: isTimeout ? 'Upstream timeout' : 'Relay failed',
      status: isTimeout ? 504 : status,
      details: data,
    });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Gravity Tools Relay running on http://localhost:${PORT}`);
  console.log(`GoCaaS timeout: ${GOCAAS_TIMEOUT_MS}ms — companion IDs remap to ${DEFAULT_MODEL}`);
});
