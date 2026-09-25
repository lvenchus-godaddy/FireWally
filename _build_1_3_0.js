#!/usr/bin/env node
/**
 * Build FireWally.user.js v1.3.0 from FireWally-1.2.71.user.js (v1.2.73 baseline).
 * Strips relay + GoCaaS API-key paths; injects Gravity Tools backend client (placeholders).
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const SRC = path.join(ROOT, 'FireWally-1.2.71.user.js');
const OUT = path.join(ROOT, 'FireWally.user.js');

const lines = fs.readFileSync(SRC, 'utf8').split('\n');
const slice = (a, b) => lines.slice(a - 1, b).join('\n');

const HEADER = `// ==UserScript==
// @name         FireWally
// @namespace    https://gravitytools.int.gdcorp.tools/
// @version      1.3.0
// @description  FireWally — unified Gravity Tools backend client (no GoCaaS relay tab).
// @author       GoDaddy WSS
// @match        *://admins.gsp-plat.int.gdcorp.tools/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_xmlhttpRequest
// @grant        GM_cookie
// @grant        unsafeWindow
// @connect      {{GRAVITY_TOOLS_BACKEND_HOST}}
// @connect      localhost
// @connect      127.0.0.1
// @connect      logic.azure.com
// @connect      *.logic.azure.com
// @connect      powerautomate.com
// @connect      *.powerautomate.com
// @connect      powerplatform.com
// @connect      *.powerplatform.com
// @connect      *.api.powerplatform.com
// ==/UserScript==

(function () {
  'use strict';

  const VERSION = '1.3.0';
  const SESSION_RESPONSE_SAMPLES = 20;
  const DEFAULT_EXPECTED_SEC = 45;
  const STUCK_MS = 90000;
  const STORE_HISTORY = 'fw_chat_';
  const STORE_PICKED = 'fw_picked_';
  const STORE_ATLASSIAN = 'fw_atlassian_auth';
  const STORE_USAGE_ON = 'fw_usage_enabled';
  const STORE_USAGE_URL = 'fw_usage_webhook';
  const STORE_USAGE_USER = 'fw_usage_user';
  const STORE_CACHED_EMAIL = 'fw_cached_user_email';
  const STORE_USAGE_LOGGED = 'fw_usage_logged_keys';
  const STORE_DEFAULT_COMPANION = 'fw_default_companion';
  const STORE_BACKEND_URL = 'fw_backend_base_url';
  const STORE_JOMAX_JWT = 'fw_jomax_jwt';
  const STORE_BACKEND_OK = 'fw_backend_ok';
  const DEFAULT_USAGE_WEBHOOK = 'https://defaultd5f1622b14a345a6b069003f8dc485.1f.environment.api.powerplatform.com:443/powerautomate/automations/direct/workflows/0eb3e3e3e76e4587b9109ddba44f1ecf/triggers/manual/paths/invoke?api-version=1&sp=%2Ftriggers%2Fmanual%2Frun&sv=1.0&sig=nF_7fwTax8gT9uu5yUvZBuY3UfcBHQ3uNjvyAPDDAXg';

  const CONFIG = {
    BACKEND_BASE_URL: 'https://{{GRAVITY_TOOLS_API_ENDPOINT}}',
    ENDPOINTS: {
      CHAT_STREAM: '/api/v1/relay/chat',
      HEALTH_CHECK: '/api/v1/health',
      USAGE_LOG: '/api/v1/telemetry/usage',
    },
    DEFAULT_MODEL: 'wss-email-response-companion',
    REQUEST_TIMEOUT_MS: 60000,
    JWT_COOKIE_NAME: 'jomax-jwt',
  };
`;

const STATE_BLOCK = `
  /* ════════════════════════════════════════
     SESSION STATE
  ════════════════════════════════════════ */
  let pendingResolve = null;
  let pendingReject = null;
  let pendingTimer = null;
  let activeRequestId = 0;
  let stuckTimer = null;
  let lastActivityAt = 0;
  let progressRef = null;
  let lastFailedSend = null;
  let activeThinkingWrap = null;
  let sendStartedAt = 0;
  let lastResponseDurationMs = 0;
  let timingModelId = null;
  let timingStepLabel = 'Starting…';
  let timingTickIv = null;
  let oauthPromptShownForRequest = false;
  let oauthWaitActive = false;
  let oauthCompleteNotified = false;
  let oauthStuckTimer = null;
  let activeXhrAbort = null;
  let backendHealthy = false;
  let globalPanel = null;
`;

const GRAVITY_CLIENT = `
  /* ════════════════════════════════════════
     GRAVITY TOOLS BACKEND CLIENT
  ════════════════════════════════════════ */
  function getBackendBaseUrl() {
    const override = String(GM_getValue(STORE_BACKEND_URL, '') || '').trim().replace(/\\/$/, '');
    if (override) return override;
    return String(CONFIG.BACKEND_BASE_URL || '').replace(/\\/$/, '');
  }

  function backendUrl(endpoint) {
    const base = getBackendBaseUrl();
    const path = endpoint.startsWith('/') ? endpoint : \`/\${endpoint}\`;
    return \`\${base}\${path}\`;
  }

  function isPlaceholderBackend() {
    const base = getBackendBaseUrl();
    return !base || base.includes('{{') || /GRAVITY_TOOLS/i.test(base);
  }

  function readCookie(name) {
    try {
      const parts = String(document.cookie || '').split(';');
      for (const part of parts) {
        const i = part.indexOf('=');
        if (i < 0) continue;
        const k = part.slice(0, i).trim();
        const v = part.slice(i + 1).trim();
        if (k === name && v) return decodeURIComponent(v);
      }
    } catch (_) {}
    return '';
  }

  function listCookiesViaGm(name) {
    return new Promise((resolve) => {
      try {
        if (typeof GM_cookie === 'undefined' || typeof GM_cookie.list !== 'function') {
          resolve('');
          return;
        }
        GM_cookie.list({ name, url: location.href }, (cookies, error) => {
          if (error || !cookies || !cookies.length) {
            resolve('');
            return;
          }
          const hit = cookies.find(c => c.name === name) || cookies[0];
          resolve(hit?.value ? String(hit.value) : '');
        });
      } catch (_) {
        resolve('');
      }
    });
  }

  async function getJomaxJwt() {
    const pasted = String(GM_getValue(STORE_JOMAX_JWT, '') || '').trim();
    const fromDoc = readCookie(CONFIG.JWT_COOKIE_NAME);
    if (fromDoc) return fromDoc;
    const fromGm = await listCookiesViaGm(CONFIG.JWT_COOKIE_NAME);
    if (fromGm) return fromGm;
    return pasted;
  }

  function isBackendReady() {
    return backendHealthy && !isPlaceholderBackend();
  }

  function cancelActiveRequest() {
    if (!busy) return;
    activeRequestId++;
    clearTimeout(pendingTimer);
    clearStuckWatch();
    stopResponseProgress();
    activeThinkingWrap?.remove();
    activeThinkingWrap = null;
    try { activeXhrAbort?.abort?.(); } catch (_) {}
    activeXhrAbort = null;
    if (pendingReject) {
      const rj = pendingReject;
      pendingResolve = null;
      pendingReject = null;
      rj(new Error('Cancelled'));
    }
    oauthPromptShownForRequest = false;
    oauthWaitActive = false;
    oauthCompleteNotified = false;
    clearOAuthStuckWatch();
    busy = false;
    if (globalPanel) {
      const sendBtn = globalPanel.querySelector('#gc-send-btn');
      const cancelBtn = globalPanel.querySelector('#gc-cancel-btn');
      if (sendBtn) sendBtn.disabled = false;
      if (cancelBtn) cancelBtn.hidden = true;
      setStatus(globalPanel, 'ready', 'Request cancelled');
    }
  }

  function startStuckWatch(panel) {
    clearStuckWatch();
    lastActivityAt = Date.now();
    stuckTimer = setInterval(() => {
      if (!busy) { clearStuckWatch(); return; }
      if (Date.now() - lastActivityAt > STUCK_MS) {
        setStatus(panel, 'loading', '⏳ Still working — Cancel to stop');
        toast('⏳ Request taking longer than usual', 4000);
      }
    }, 10000);
  }

  function clearStuckWatch() {
    clearInterval(stuckTimer);
    stuckTimer = null;
  }

  function touchActivity() {
    lastActivityAt = Date.now();
  }

  function gmBackendRequest(path, options = {}) {
    const method = (options.method || 'GET').toUpperCase();
    const url = /^https?:\\/\\//i.test(path) ? path : backendUrl(path);
    const timeout = options.timeout || CONFIG.REQUEST_TIMEOUT_MS;
    const headers = {
      Accept: options.accept || 'application/json',
      ...(options.headers || {}),
    };
    if (options.body != null && !headers['Content-Type']) {
      headers['Content-Type'] = 'application/json';
    }
    const body = options.body == null
      ? undefined
      : (typeof options.body === 'string' ? options.body : JSON.stringify(options.body));

    return new Promise(async (resolve, reject) => {
      if (isPlaceholderBackend()) {
        reject(new Error('Backend URL not configured — set Gravity Tools URL in Settings'));
        return;
      }
      let token = '';
      try { token = await getJomaxJwt(); } catch (_) {}
      if (token) headers.Authorization = \`Bearer \${token}\`;
      else if (options.requireAuth !== false) {
        reject(new Error('SSO token missing — refresh the ticket page or paste jomax-jwt in Settings'));
        return;
      }

      const details = {
        method,
        url,
        headers,
        data: body,
        timeout,
        onload(resp) {
          resolve({
            ok: resp.status >= 200 && resp.status < 300,
            status: resp.status,
            responseText: resp.responseText || '',
            responseHeaders: resp.responseHeaders || '',
          });
        },
        onerror() { reject(new Error('Network error calling Gravity Tools')); },
        ontimeout() { reject(new Error('Gravity Tools request timed out')); },
      };

      if (typeof options.onprogress === 'function') {
        details.onprogress = options.onprogress;
      }

      const handle = GM_xmlhttpRequest(details);
      if (options.trackAbort) activeXhrAbort = handle;
    });
  }

  async function checkBackendHealth() {
    if (isPlaceholderBackend()) {
      backendHealthy = false;
      try { GM_setValue(STORE_BACKEND_OK, 'false'); } catch (_) {}
      return { ok: false, reason: 'placeholder' };
    }
    try {
      const r = await gmBackendRequest(CONFIG.ENDPOINTS.HEALTH_CHECK, {
        method: 'GET',
        timeout: 15000,
        requireAuth: false,
      });
      backendHealthy = r.ok;
      try { GM_setValue(STORE_BACKEND_OK, backendHealthy ? 'true' : 'false'); } catch (_) {}
      return { ok: r.ok, status: r.status, body: r.responseText };
    } catch (e) {
      backendHealthy = false;
      try { GM_setValue(STORE_BACKEND_OK, 'false'); } catch (_) {}
      return { ok: false, error: e.message };
    }
  }

  function syncBackendUI(panel) {
    const p = panel || globalPanel;
    if (!p) return;
    const bar = p.querySelector('#gc-connect-bar');
    const status = p.querySelector('#gc-conn-status');
    const btn = p.querySelector('#gc-health-btn');
    const dot = document.querySelector('#gc-launcher .gc-indicator');
    if (isPlaceholderBackend()) {
      if (status) {
        status.textContent = '● Backend URL not set';
        status.className = 'gc-conn-status';
      }
      if (btn) { btn.hidden = false; btn.textContent = '⚙ Configure in Settings'; }
      if (dot) dot.className = 'gc-indicator gc-dot';
      bar?.classList.remove('gc-connect-compact');
      return;
    }
    if (backendHealthy) {
      if (status) {
        status.textContent = '● Ready / Connected';
        status.className = 'gc-conn-status connected';
      }
      if (btn) btn.hidden = true;
      bar?.classList.add('gc-connect-compact');
      if (dot) dot.className = 'gc-indicator gc-connected';
    } else {
      if (status) {
        status.textContent = '● Backend unreachable / SSO expired';
        status.className = 'gc-conn-status';
      }
      if (btn) { btn.hidden = false; btn.textContent = '🔄 Retry health check'; }
      bar?.classList.remove('gc-connect-compact');
      if (dot) dot.className = 'gc-indicator gc-dot';
    }
  }

  function parseSseOrJson(raw) {
    const text = String(raw || '').trim();
    if (!text) return { text: '', forms: [], events: [] };
    const events = [];
    let content = '';

    if (text.includes('data:')) {
      for (const line of text.split(/\\n/)) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const payload = trimmed.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        try {
          const j = JSON.parse(payload);
          events.push(j);
          if (j.type === 'tool_call_started' || j.event === 'tool_call_started') {
            /* signal only */
          } else if (j.type === 'streaming' || j.event === 'streaming') {
            content += j.delta || j.content || j.text || '';
          } else if (j.type === 'completed' || j.event === 'completed') {
            content = j.text || j.content || content;
          } else if (j.choices?.[0]?.delta?.content) {
            content += j.choices[0].delta.content;
          } else if (j.choices?.[0]?.message?.content) {
            content = j.choices[0].message.content;
          } else if (typeof j.content === 'string') {
            content += j.content;
          } else if (typeof j.text === 'string') {
            content = j.text;
          } else if (typeof j.delta === 'string') {
            content += j.delta;
          }
        } catch (_) {
          content += payload;
        }
      }
    } else {
      try {
        const j = JSON.parse(text);
        events.push(j);
        content = j.text || j.content || j.choices?.[0]?.message?.content || j.message || '';
        if (typeof content !== 'string') content = JSON.stringify(content);
      } catch (_) {
        content = text;
      }
    }

    return processToolCallsForGravity(content, events);
  }

  function processToolCallsForGravity(text, events) {
    const forms = [];
    let out = String(text || '');
    out = out.replace(
      /<details[^>]*name=["']request_user_input["'][^>]*arguments="([^"]*)"[^>]*>[\\s\\S]*?<\\/details>/gi,
      (match, argsRaw) => {
        try {
          const decoded = argsRaw
            .replace(/&quot;/g, '"')
            .replace(/&#x27;/g, "'")
            .replace(/&amp;/g, '&')
            .replace(/&#x2F;/g, '/')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&#x([0-9a-fA-F]+);/g, (m, hex) => String.fromCharCode(parseInt(hex, 16)));
          const first = JSON.parse(decoded);
          forms.push(typeof first === 'string' ? JSON.parse(first) : first);
          return '';
        } catch (_) {
          return '';
        }
      }
    );
    if (typeof stripToolExecutedArtifacts === 'function' && typeof replaceDetailsPreservingUrls === 'function') {
      out = stripToolExecutedArtifacts(replaceDetailsPreservingUrls(out));
    }
    for (const ev of events || []) {
      if (Array.isArray(ev.forms)) forms.push(...ev.forms);
      if (ev.form) forms.push(ev.form);
    }
    return { text: out.replace(/\\n{3,}/g, '\\n\\n').trim(), forms, events };
  }

  function buildTicketContextPayload(ticket) {
    const t = ticket || currentTicket || {};
    const tags = t.tags;
    let tagList = [];
    if (Array.isArray(tags)) {
      tagList = tags.map(x => (typeof x === 'string' ? x : x?.title || String(x || ''))).filter(Boolean);
    } else if (typeof tags === 'string' && tags.trim()) {
      tagList = tags.split(/[,;]/).map(s => s.trim()).filter(Boolean);
    }
    return {
      subject: t.title || t.subject || '',
      tags: tagList,
      domain: t.domain || t.site || '',
      hosting_ip: t.hostingIp || t.hosting_ip || '',
      waf_ip: t.wafIp || t.waf_ip || '',
      transcript: t.transcript || t.description || currentContext || '',
    };
  }

  function sendViaGravity(modelId, messages, ticketId) {
    const reqId = ++activeRequestId;
    const lastUser = [...(messages || [])].reverse().find(m => m.role === 'user');
    const prompt = lastUser ? String(lastUser.content || '') : '';
    if (!prompt.trim()) return Promise.reject(new Error('No message to send'));

    const payload = {
      ticket_id: String(ticketId || currentTicket?.ticketId || ''),
      model: modelId,
      prompt,
      ticket_context: buildTicketContextPayload(currentTicket),
      messages: (messages || []).map(m => ({
        role: m.role,
        content: typeof normalizeContent === 'function' ? normalizeContent(m.content) : String(m.content || ''),
      })),
    };

    return new Promise((resolve, reject) => {
      if (pendingResolve) pendingReject?.(new Error('Superseded by new request'));
      pendingResolve = (val) => { if (reqId !== activeRequestId) return; resolve(val); };
      pendingReject = (err) => { if (reqId !== activeRequestId) return; reject(err); };
      clearTimeout(pendingTimer);
      pendingTimer = setTimeout(() => {
        if (reqId !== activeRequestId) return;
        pendingResolve = null;
        pendingReject = null;
        reject(new Error('No response from Gravity Tools after timeout'));
      }, Math.max(CONFIG.REQUEST_TIMEOUT_MS, 300000));

      let buffer = '';
      gmBackendRequest(CONFIG.ENDPOINTS.CHAT_STREAM, {
        method: 'POST',
        body: payload,
        accept: 'text/event-stream, application/json',
        timeout: Math.max(CONFIG.REQUEST_TIMEOUT_MS, 300000),
        trackAbort: true,
        onprogress(resp) {
          if (reqId !== activeRequestId) return;
          const chunk = resp.responseText || '';
          if (chunk.length <= buffer.length) return;
          buffer = chunk;
          touchActivity();
          if (globalPanel && progressRef) {
            if (/tool_call|tool/i.test(chunk.slice(-400))) {
              bumpResponseProgress(progressRef, 10, '🔧 Tools active — companion is responding…');
            } else {
              bumpResponseProgress(progressRef, 6, '✍️ Companion is responding…');
            }
          }
        },
      }).then((r) => {
        if (reqId !== activeRequestId) return;
        clearTimeout(pendingTimer);
        const raw = r.responseText || buffer;
        if (r.status === 401 || r.status === 403) {
          backendHealthy = false;
          syncBackendUI();
          const rj = pendingReject; pendingResolve = null; pendingReject = null;
          rj?.(new Error('SSO expired — refresh the ticket page or paste a new JWT in Settings'));
          return;
        }
        if (!r.ok) {
          let msg = \`HTTP \${r.status}\`;
          try {
            const j = JSON.parse(raw);
            msg = j.detail || j.error?.message || j.message || msg;
          } catch (_) {
            if (raw) msg = raw.slice(0, 160);
          }
          const rj = pendingReject; pendingResolve = null; pendingReject = null;
          rj?.(new Error(String(msg)));
          return;
        }
        const parsed = parseSseOrJson(raw);
        for (const ev of parsed.events || []) {
          const t = ev.type || ev.event || '';
          if (t === 'tool_call_started' && progressRef) {
            bumpResponseProgress(progressRef, 12, '🔧 Tools active — companion is responding…');
          } else if (t === 'streaming' && progressRef) {
            bumpResponseProgress(progressRef, 6, '✍️ Companion is responding…');
          } else if (t === 'completed' && progressRef) {
            setResponseProgress(progressRef, 100, 'Done');
          }
        }
        backendHealthy = true;
        syncBackendUI();
        const res = pendingResolve; pendingResolve = null; pendingReject = null;
        res?.({ text: parsed.text || '(empty response)', forms: parsed.forms || [] });
      }).catch((err) => {
        if (reqId !== activeRequestId) return;
        clearTimeout(pendingTimer);
        const rj = pendingReject; pendingResolve = null; pendingReject = null;
        rj?.(err);
      });
    });
  }

  function sendRelayMessage(payload, hooks = {}) {
    const { onChunk, onDone, onError } = hooks;
    return sendViaGravity(payload.model, payload.messages || [{ role: 'user', content: payload.prompt }], payload.ticket_id)
      .then((reply) => {
        onDone?.(reply);
        return reply;
      })
      .catch((err) => {
        onError?.(err);
        throw err;
      });
  }
`;

const AUTH_STUBS = `
  /* ════════════════════════════════════════
     ATLASSIAN FLAG (backend owns OAuth flow)
  ════════════════════════════════════════ */
  function companionNeedsAuth(modelId) {
    return MODELS.find(m => m.id === modelId)?.needsAuth === true;
  }

  function isAtlassianAuthorized() {
    return GM_getValue(STORE_ATLASSIAN, 'false') === 'true';
  }

  function isOAuthStatus(label) {
    const s = (label || '').toLowerCase();
    return s.includes('oauth') || s.includes('atlassian') || s.includes('authoris');
  }

  function notifyOAuthComplete(panel) {
    if (!panel || oauthCompleteNotified) return;
    oauthCompleteNotified = true;
    oauthWaitActive = false;
    oauthPromptShownForRequest = false;
    clearOAuthStuckWatch();
    markAtlassianAuthorized();
    panel.querySelector('.gc-oauth-card')?.remove();
    sysMsg(panel, '✅ Atlassian authorization complete — your request is continuing…');
    toast('✅ Atlassian authorization complete!', 5000);
  }

  function markAtlassianAuthorized() {
    GM_setValue(STORE_ATLASSIAN, 'true');
  }

  function isAuthError(msg) {
    const s = (msg || '').toLowerCase();
    return s.includes('oauth') || s.includes('atlassian') || s.includes('authoris');
  }

  function getSelectedModel(panel) {
    const modelId = panel?.querySelector('#gc-model-sel')?.value;
    return MODELS.find(m => m.id === modelId) || MODELS[0];
  }

  function clearOAuthStuckWatch() {
    clearTimeout(oauthStuckTimer);
    oauthStuckTimer = null;
  }

  function startOAuthStuckWatch(panel, modelId) {
    clearOAuthStuckWatch();
    if (!companionNeedsAuth(modelId)) return;
    oauthStuckTimer = setTimeout(() => {
      if (!busy || !progressRef) return;
      const step = progressRef.label?.querySelector('.gc-progress-step')?.textContent || '';
      if (!isOAuthStatus(step) && !/authoris|oauth/i.test(step)) return;
      oauthPromptShownForRequest = false;
      GM_setValue(STORE_ATLASSIAN, 'false');
      maybeShowOAuthInstructions(panel, step, modelId, step);
      toast('🔐 Authorization still pending — complete Atlassian auth via Gravity Tools / GoCaaS', 6000);
    }, 12000);
  }

  function maybeShowOAuthInstructions(panel, label, modelId, friendlyHint) {
    if (!panel) return;
    const mid = modelId || panel.querySelector('#gc-model-sel')?.value;
    if (!mid || !companionNeedsAuth(mid)) return;
    const friendly = friendlyHint || label || '';
    const s = (label || '').toLowerCase();
    const isOAuthWait = /authorize|authoris|oauth|atlassian/i.test(friendly + s);
    if (!isOAuthWait || oauthPromptShownForRequest) return;
    showOAuthInstructions(panel);
  }

  function promptAuthIfNeeded(panel) {
    if (isAtlassianAuthorized()) return false;
    oauthPromptShownForRequest = true;
    setStatus(panel, 'loading', '🔐 Atlassian authorisation required');
    showOAuthInstructions(panel);
    return true;
  }

  function showOAuthInstructions(panel) {
    const msgs = panel.querySelector('#gc-messages');
    const companionName = getSelectedModel(panel)?.name || 'this companion';
    panel.querySelector('.gc-oauth-card')?.remove();
    const wrap = document.createElement('div');
    wrap.className = 'gc-msg system-msg gc-oauth-card';
    wrap.innerHTML = \`
      <div class="gc-bubble gc-oauth-bubble">
        <div class="gc-oauth-title">🔐 Atlassian Authorisation Required</div>
        <div class="gc-oauth-body">
          Some companions use Atlassian tools and need a one-time authorisation.<br>
          Complete OAuth in <strong>GoCaaS / Gravity Tools</strong> for
          <strong>\${companionName.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</strong>,
          then retry your message in FireWally.
        </div>
        <div class="gc-oauth-note">One-time setup — once authorised, companions work for your account.</div>
      </div>\`;
    msgs.appendChild(wrap);
    msgs.scrollTop = msgs.scrollHeight;
    toast('🔐 Authorization needed — complete Atlassian OAuth, then retry', 6000);
  }

  function friendlyStatus(raw) {
    const s = (raw || '').toLowerCase();
    if (s.includes('oauth') || s.includes('atlassian')) return '🔐 Authorising with Atlassian…';
    if (s.includes('tool')) return '🔧 Running tool…';
    if (s.includes('stream')) return '✍️ Companion is responding…';
    return raw && raw.length > 50 ? raw.slice(0, 50) + '…' : (raw || 'Working…');
  }
`;

const FOOTER_NAV = `
  async function handleTicketNavigation(panel, panelOpen) {
    softInvalidateRelayHandles();
    if (panelOpen) {
      setTimeout(() => {
        const d = readTicketData();
        if (d) {
          try {
            const t = parseTicket(d);
            if (t) applyTicket(panel, t);
          } catch (e) {
            console.warn('[FireWally] parseTicket failed on navigation:', e.message);
            refreshContext(panel);
          }
        } else if (panelOpen) refreshContext(panel);
      }, 400);
    }
  }

  function softInvalidateRelayHandles() {
    /* no-op — legacy name kept for nav callers */
  }
`;

function main() {
  // Keep MODELS through fwChatIsEmpty (60-183)
  const modelsBlock = slice(60, 183);

  // Usage logging (226-408) — starts at comment BACKGROUND was 185; usage at 226
  const usageBlock = slice(226, 408);

  // Timing / progress UI (1534-1690) — stop before handleRelayMessage
  // Find end of stopResponseProgress
  let timingEnd = 1690;
  for (let i = 1680; i < 1720; i++) {
    if (lines[i] && lines[i].includes('function handleRelayMessage')) {
      timingEnd = i; // exclusive in 1-based = i (0-based i means line i+1)
      break;
    }
  }
  const timingBlock = slice(1534, timingEnd);

  // Ticket scraper through CSS and createUI start — from TICKET SCRAPER to before createUI
  // We'll take 2198 through end of CSS (before createUI), then custom createUI
  let ticketStart = 2198;
  for (let i = 2190; i < 2210; i++) {
    if (lines[i] && lines[i].includes('TICKET SCRAPER')) {
      // Include the opening /* banner line immediately above
      ticketStart = (lines[i - 1] && lines[i - 1].includes('/*')) ? i : i + 1;
      break;
    }
  }

  let createUiLine = 3386;
  for (let i = 3370; i < 3400; i++) {
    if (lines[i] && lines[i].includes('function createUI()')) {
      createUiLine = i + 1;
      break;
    }
  }

  // CSS is before createUI — include from ticketStart to line before createUI
  const ticketAndCss = slice(ticketStart, createUiLine - 1);

  // Chat engine from toast through draftCustomerReply and auto-select — but we'll replace startOrSend/doSend
  // Easier: take from toast (after createUI return) ... 
  // Actually assemble createUI ourselves, then take from toast/setStatus through injectContext helpers,
  // replacing doSend/startOrSend/loadSettings/saveSettings/init.

  let toastLine = 3537;
  for (let i = 3530; i < 3560; i++) {
    if (lines[i] && lines[i].includes('function toast(')) {
      toastLine = i + 1;
      break;
    }
  }

  // slice(a,b) = lines.slice(a-1, b) → b is exclusive 0-based end (same as last 1-based line INCLUSIVE)

  let autoSelectLine = 4075;
  for (let i = 4065; i < 4090; i++) {
    if (lines[i] && lines[i].includes('COMPANION AUTO-SELECT')) {
      autoSelectLine = i + 1;
      break;
    }
  }

  // toast through line before COMPANION AUTO-SELECT (includes doSend)
  const chatEngine = slice(toastLine, autoSelectLine - 1);

  // COMPANION AUTO-SELECT through injectContext; stop before HELPERS banner /*
  let companionEndExclusive = 4286;
  for (let i = 4275; i < 4300; i++) {
    if (lines[i] && lines[i].includes('/*') && lines[i + 1] && lines[i + 1].includes('HELPERS')) {
      companionEndExclusive = i; // exclusive 0-based → excludes /*
      break;
    }
  }
  const companionBlock = slice(autoSelectLine, companionEndExclusive);

  // switchTab + autoGrow only from HELPERS; replace load/save/init
  const switchTabBlock = `  function switchTab(panel,name){
    panel.querySelectorAll('.gc-tab').forEach(t=>t.classList.toggle('active',t.dataset.tab===name));
    panel.querySelectorAll('.gc-pane').forEach(p=>p.classList.toggle('active',p.id===\`gc-pane-\${name}\`));
  }
  function autoGrow(el){el.style.height='';el.style.height=Math.min(el.scrollHeight,140)+'px';}
`;

  const CREATE_UI = `
  function createUI() {
    const style=document.createElement('style'); style.textContent=CSS; document.head.appendChild(style);
    const launcher=document.createElement('button'); launcher.id='gc-launcher'; launcher.title='FireWally';
    launcher.innerHTML=\`
      <svg viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg>
      <span class="gc-indicator gc-dot"></span>\`;
    const panel=document.createElement('div'); panel.id='gc-panel'; panel.classList.add('gc-hidden');
    panel.innerHTML=\`
      <div id="gc-header">
        <div class="gc-logo">🔥 FireWally<span> by Gravity Tools</span><span class="gc-ver">v\${VERSION}</span></div>
        <button class="gc-hbtn" id="gc-close-btn" title="Close">✕</button>
      </div>
      <div id="gc-connect-bar">
        <span class="gc-conn-status" id="gc-conn-status">● Checking backend…</span>
        <button id="gc-health-btn" type="button">🔄 Retry health check</button>
      </div>
      <div id="gc-model-bar">
        <label for="gc-model-sel">Companion</label>
        <select id="gc-model-sel">\${MODELS.map(m=>{
          const def = fwGetDefaultCompanionId();
          return \`<option value="\${m.id}"\${m.id === def ? ' selected' : ''}>\${m.name}</option>\`;
        }).join('')}</select>
        <span id="gc-model-hint" class="gc-model-hint"></span>
      </div>
      <div id="gc-tabs">
        <button class="gc-tab active" data-tab="chat">💬 Chat</button>
        <button class="gc-tab" data-tab="context">📋 Ticket</button>
        <button class="gc-tab" data-tab="settings">⚙ Settings</button>
      </div>
      <div class="gc-pane active" id="gc-pane-chat">
        <div id="gc-status-bar"><span class="gc-dot-status"></span><span id="gc-status-text">Configure Gravity Tools backend in Settings</span><button id="gc-cancel-btn" hidden type="button">✕ Cancel</button></div>
        <div id="gc-messages">
          <div class="gc-msg system-msg"><div class="gc-bubble">
            👋 Welcome to <strong>FireWally v\${VERSION}</strong><br><br>
            This build talks to the <strong>Gravity Tools</strong> backend (no GoCaaS relay tab).<br>
            Set the backend URL in <strong>Settings</strong>, then send a message when status shows Ready.
          </div></div>
        </div>
        <div id="gc-input-row">
          <textarea id="gc-input" rows="1" placeholder="Ask anything… (Enter to send, Shift+Enter for newline)"></textarea>
          <button id="gc-send-btn">➤</button>
        </div>
        <div id="gc-btn-row">
          <button class="gc-action-btn" id="gc-inject-btn">📋 Inject Context</button>
          <button class="gc-action-btn" id="gc-draft-btn">✉️ Draft Reply</button>
          <button class="gc-action-btn" id="gc-copy-response-btn">📋 Copy Response</button>
          <button class="gc-action-btn" id="gc-copy-reply-btn">📋 Copy Reply</button>
          <button class="gc-action-btn" id="gc-clear-btn">🗑 Clear</button>
        </div>
      </div>
      <div class="gc-pane" id="gc-pane-context">
        <div id="gc-ctx-scroll">
          <span id="gc-ctx-source"></span>
          <span class="gc-lbl">📌 Subject</span><div class="gc-field empty" id="gc-ctx-title">—</div>
          <span class="gc-lbl">🔄 Status</span><div class="gc-field empty" id="gc-ctx-status">—</div>
          <span class="gc-lbl">🌐 Site &amp; Infrastructure</span><div class="gc-field empty" id="gc-ctx-infra">—</div>
          <span class="gc-lbl">🏷 Tags</span><div class="gc-field empty" id="gc-ctx-tags">—</div>
          <span class="gc-lbl">👤 Assigned To</span><div class="gc-field empty" id="gc-ctx-assignments">—</div>
          <span class="gc-lbl">📝 Internal Notes</span><div class="gc-field empty" id="gc-ctx-notes">—</div>
          <span class="gc-lbl">💬 Transcript Preview</span><div class="gc-field empty" id="gc-ctx-desc">—</div>
          <div class="gc-ctx-btns">
            <button class="gc-ctx-btn gc-ctx-btn-sec" id="gc-rescan-btn">🔄 Re-scan</button>
            <button class="gc-ctx-btn gc-ctx-btn-pri" id="gc-ctx-inject-btn">💬 Chat with Context</button>
          </div>
        </div>
      </div>
      <div class="gc-pane" id="gc-pane-settings">
        <div id="gc-settings-scroll">
          <span class="gc-setting-title">🔌 Gravity Tools backend</span>
          <div class="gc-setting-group">
            <div class="gc-setting-row" style="flex-direction:column;align-items:stretch;gap:4px;">
              <label>Backend base URL (override placeholder)</label>
              <input class="gc-setting-input" id="gc-settings-backend-url" type="url" placeholder="https://gravitytools.int.gdcorp.tools or http://localhost:8080"/>
              <p class="gc-hint" id="gc-settings-backend-status" style="margin:0;">
                Default placeholder: <code>\${CONFIG.BACKEND_BASE_URL}</code>
              </p>
            </div>
            <div class="gc-setting-row" style="flex-direction:column;align-items:stretch;gap:4px;">
              <label>Jomax JWT (optional — if cookie is HttpOnly)</label>
              <input class="gc-setting-input" id="gc-settings-jomax-jwt" type="password" autocomplete="off" placeholder="Paste jomax-jwt if auto-detect fails"/>
            </div>
            <button type="button" class="gc-ctx-btn gc-ctx-btn-sec" id="gc-settings-backend-test" style="width:100%;margin-top:6px;">🧪 Test backend health</button>
          </div>
          <span class="gc-setting-title">🖥️ Panel Width</span>
          <div class="gc-setting-group">
            <div class="gc-setting-row">
              <label>Width (px) — height fills screen automatically</label>
              <input class="gc-setting-input" id="gc-settings-width" type="number" min="320" max="900" step="10" value="480" style="width:100px;flex:none;"/>
            </div>
          </div>
          <span class="gc-setting-title">📊 Usage logging (Excel Online)</span>
          <div class="gc-setting-group">
            <div class="gc-setting-row">
              <label>Enable logging to Power Automate → Excel</label>
              <input type="checkbox" id="gc-settings-usage-on" style="width:auto;flex:none;"/>
            </div>
            <div class="gc-setting-row" style="flex-direction:column;align-items:stretch;gap:4px;">
              <label>Detected user (auto from page — override only if wrong)</label>
              <input class="gc-setting-input" id="gc-settings-usage-user" type="email" placeholder="auto-detected from dashboard"/>
              <p class="gc-hint" id="gc-settings-usage-detected" style="margin:0;">Detecting…</p>
            </div>
            <div class="gc-setting-row" style="flex-direction:column;align-items:stretch;gap:4px;">
              <label>Webhook URL (optional override — team default is built in)</label>
              <input class="gc-setting-input" id="gc-settings-usage-url" type="url" placeholder="Leave blank to use built-in Power Automate URL"/>
            </div>
            <p class="gc-hint" style="margin-top:0;">
              Logs one Excel row per user + ticket + companion (first successful send).
            </p>
            <button type="button" class="gc-ctx-btn gc-ctx-btn-sec" id="gc-settings-usage-test" style="width:100%;margin-top:6px;">🧪 Send test log row</button>
          </div>
          <span class="gc-setting-title">🤖 Default companion</span>
          <div class="gc-setting-group">
            <div class="gc-setting-row" style="flex-direction:column;align-items:stretch;gap:4px;">
              <label>Used when auto-select has no strong match</label>
              <select class="gc-setting-input" id="gc-settings-default-companion"></select>
            </div>
          </div>
          <button class="gc-save-btn" id="gc-settings-save">💾 Save Settings</button>
          <hr class="gc-divider">
          <p class="gc-hint">
            <strong>FireWally v\${VERSION}</strong> — Gravity Tools backend client for WSS ticket dashboard.<br>
            Disable the legacy <strong>FireWally Relay</strong> userscript (GoCaaS tab) when using this build.
          </p>
        </div>
      </div>\`;
    document.body.appendChild(launcher); document.body.appendChild(panel);
    primeCompanionSelect(panel);
    return{launcher,panel};
  }
`;

  const SETTINGS_INIT = `
  function loadSettings(panel){
    const be = panel.querySelector('#gc-settings-backend-url');
    if (be) be.value = GM_getValue(STORE_BACKEND_URL, '') || '';
    const jwt = panel.querySelector('#gc-settings-jomax-jwt');
    if (jwt) {
      const stored = String(GM_getValue(STORE_JOMAX_JWT, '') || '');
      jwt.value = stored;
      jwt.placeholder = stored ? '••••••••••••••••' : 'Paste jomax-jwt if auto-detect fails';
    }
    const beStatus = panel.querySelector('#gc-settings-backend-status');
    if (beStatus) {
      beStatus.textContent = isPlaceholderBackend()
        ? \`Using placeholder — set a real URL. Default: \${CONFIG.BACKEND_BASE_URL}\`
        : \`Active: \${getBackendBaseUrl()}\`;
    }
    const w = parseInt(GM_getValue('gc_width', '480'));
    panel.querySelector('#gc-settings-width').value = w;
    panel.style.width = w + 'px';
    const on = panel.querySelector('#gc-settings-usage-on');
    if (on) on.checked = isUsageLoggingEnabled();
    const user = panel.querySelector('#gc-settings-usage-user');
    const manual = GM_getValue(STORE_USAGE_USER, '') || '';
    if (user) user.value = manual;
    const detectedEl = panel.querySelector('#gc-settings-usage-detected');
    if (detectedEl) {
      if (!manual) detectedUserEmail = null;
      const detected = getCurrentUserEmail();
      detectedEl.textContent = manual
        ? \`Using manual override. Auto-detect would be: \${detected && detected !== manual.toLowerCase() ? detected : '(same or unknown)'}\`
        : (detected ? \`Auto-detected: \${detected}\` : 'Could not auto-detect email — enter manually if needed');
    }
    const url = panel.querySelector('#gc-settings-usage-url');
    if (url) url.value = GM_getValue(STORE_USAGE_URL, '') || '';
    fwPopulateDefaultCompanionSelect(panel);
  }

  function saveSettings(panel){
    const be = String(panel.querySelector('#gc-settings-backend-url')?.value || '').trim().replace(/\\/$/, '');
    GM_setValue(STORE_BACKEND_URL, be);
    const jwtInput = panel.querySelector('#gc-settings-jomax-jwt');
    const jwtVal = String(jwtInput?.value || '').trim();
    if (jwtVal && !jwtVal.startsWith('•')) GM_setValue(STORE_JOMAX_JWT, jwtVal);
    const w = parseInt(panel.querySelector('#gc-settings-width').value) || 480;
    GM_setValue('gc_width', String(w));
    panel.style.width = w + 'px';
    const on = panel.querySelector('#gc-settings-usage-on')?.checked === true;
    GM_setValue(STORE_USAGE_ON, on ? 'true' : 'false');
    const user = String(panel.querySelector('#gc-settings-usage-user')?.value || '').trim();
    GM_setValue(STORE_USAGE_USER, user);
    if (user.includes('@')) {
      detectedUserEmail = user.toLowerCase();
      try { GM_setValue(STORE_CACHED_EMAIL, detectedUserEmail); } catch (_) {}
    } else {
      detectedUserEmail = null;
    }
    const url = String(panel.querySelector('#gc-settings-usage-url')?.value || '').trim();
    GM_setValue(STORE_USAGE_URL, url);
    const defSel = panel.querySelector('#gc-settings-default-companion');
    if (defSel) fwSetDefaultCompanionId(defSel.value);
    syncBackendUI(panel);
    toast(on ? '✅ Settings saved — usage logging on' : '✅ Settings saved');
  }

  function makeDraggable(panel){
    const hdr=panel.querySelector('#gc-header');let ox,oy,sx,sy,drag=false;
    hdr.addEventListener('mousedown',e=>{if(e.target.closest('button'))return;drag=true;const r=panel.getBoundingClientRect();ox=r.left;oy=r.top;sx=e.clientX;sy=e.clientY;e.preventDefault();});
    document.addEventListener('mousemove',e=>{if(!drag)return;panel.style.right='auto';panel.style.left=ox+e.clientX-sx+'px';});
    document.addEventListener('mouseup',()=>{drag=false;});
  }

  function init(){
    const{launcher,panel}=createUI();
    globalPanel=panel;makeDraggable(panel);loadSettings(panel);
    let panelOpen=false;

    launcher.addEventListener('click',()=>{
      if(panelOpen){panelOpen=false;panel.classList.add('gc-hidden');}
      else{
        panelOpen=true;panel.classList.remove('gc-hidden');refreshContext(panel);
        syncBackendUI(panel);
        checkBackendHealth().then(() => syncBackendUI(panel));
      }
    });
    panel.querySelector('#gc-close-btn').addEventListener('click',()=>{panelOpen=false;panel.classList.add('gc-hidden');});
    panel.querySelector('#gc-health-btn')?.addEventListener('click', async () => {
      if (isPlaceholderBackend()) {
        switchTab(panel, 'settings');
        toast('⚙ Set Gravity Tools backend URL in Settings', 4000);
        return;
      }
      setStatus(panel, 'loading', 'Checking backend…');
      const result = await checkBackendHealth();
      syncBackendUI(panel);
      if (result.ok) {
        setStatus(panel, 'ready', '✅ Backend ready');
        toast('✅ Gravity Tools health OK', 3000);
      } else {
        setStatus(panel, 'error', result.error || 'Backend unreachable');
        toast(\`❌ Health check failed\${result.error ? ': ' + result.error : ''}\`, 5000);
      }
    });
    panel.querySelector('#gc-model-sel').addEventListener('change',()=>{
      const modelId = panel.querySelector('#gc-model-sel').value;
      setCompanion(panel, modelId, { userInitiated: true });
      const m = MODELS.find(m => m.id === modelId) || MODELS[0];
      setStatus(panel, 'ready', \`\${m.name} — ready\`);
      fwUpdateInputPlaceholder(panel);
    });
    panel.querySelectorAll('.gc-tab').forEach(t=>t.addEventListener('click',()=>switchTab(panel,t.dataset.tab)));
    panel.querySelector('#gc-cancel-btn').addEventListener('click', () => cancelActiveRequest());
    panel.querySelector('#gc-send-btn').addEventListener('click',()=>startOrSend(panel));
    panel.querySelector('#gc-input').addEventListener('keydown',e=>{
      if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();startOrSend(panel);}
    });
    panel.querySelector('#gc-input').addEventListener('input',e=>autoGrow(e.target));
    panel.querySelector('#gc-inject-btn').addEventListener('click',()=>injectContext(panel));
    panel.querySelector('#gc-draft-btn').addEventListener('click',()=>draftCustomerReply(panel));
    panel.querySelector('#gc-copy-response-btn')?.addEventListener('click',()=>{
      const reply=getLastAssistantReply();
      copyFullResponse(reply,panel.querySelector('#gc-copy-response-btn'));
    });
    panel.querySelector('#gc-copy-reply-btn').addEventListener('click',()=>{
      const reply=getLastAssistantReply();
      copyCustomerReply(reply,panel.querySelector('#gc-copy-reply-btn'));
    });
    fwUpdateInputPlaceholder(panel);
    panel.querySelector('#gc-clear-btn').addEventListener('click',()=>{
      chatHistory=[];
      saveTicketHistory();
      panel.querySelector('#gc-messages').innerHTML='';
      sysMsg(panel,'Chat cleared for this ticket.');
    });
    panel.querySelector('#gc-rescan-btn').addEventListener('click',()=>refreshContext(panel));
    panel.querySelector('#gc-ctx-inject-btn').addEventListener('click',()=>injectContext(panel));
    panel.querySelector('#gc-settings-save').addEventListener('click',()=>saveSettings(panel));
    panel.querySelector('#gc-settings-backend-test')?.addEventListener('click', async () => {
      saveSettings(panel);
      const statusEl = panel.querySelector('#gc-settings-backend-status');
      if (statusEl) statusEl.textContent = 'Testing…';
      const result = await checkBackendHealth();
      syncBackendUI(panel);
      if (result.ok) {
        if (statusEl) statusEl.textContent = \`✅ Health OK — \${getBackendBaseUrl()}\`;
        toast('✅ Gravity Tools health OK', 3000);
      } else {
        const err = result.error || result.reason || \`HTTP \${result.status || '?'}\`;
        if (statusEl) statusEl.textContent = \`❌ \${err}\`;
        toast(\`❌ \${err}\`, 6000);
      }
    });
    panel.querySelector('#gc-settings-usage-test')?.addEventListener('click', () => {
      saveSettings(panel);
      if (!isUsageLoggingEnabled() || !getUsageWebhookUrl()) {
        toast('⚠️ Enable logging first', 4000);
        return;
      }
      trackUsage('test', { detail: 'manual test from Settings' });
      toast('📤 Test row sent — check Excel in a few seconds', 4000);
    });

    setTimeout(()=>{
      const d=readTicketData();
      if(d){
        try {
          const t=parseTicket(d);
          if(t){currentTicket=t;currentContext=buildContext(t);primeCompanionSelect(panel);}
        } catch (e) {
          console.warn('[FireWally] parseTicket failed on init:', e.message);
        }
      }
    },800);

    checkBackendHealth().then(() => {
      syncBackendUI(panel);
      if (backendHealthy) setStatus(panel, 'ready', '✅ Backend ready — send a message');
      else if (isPlaceholderBackend()) setStatus(panel, 'ready', '⚙ Set Gravity Tools URL in Settings');
      else setStatus(panel, 'ready', '⚠ Backend unreachable — check Settings / SSO');
    });

    let lastUrl=location.href;
    new MutationObserver(()=>{
      if(location.href!==lastUrl){
        lastUrl=location.href;currentTicket=null;currentContext='';
        currentHistoryKey=null;
        softInvalidateRelayHandles();
        handleTicketNavigation(panel, panelOpen).finally(() => {
          setTimeout(() => {
            const d = readTicketData();
            if (d) {
              try {
                const t = parseTicket(d);
                if (t && panelOpen) applyTicket(panel, t);
                else if (t) { currentTicket = t; currentContext = buildContext(t); primeCompanionSelect(panel); }
              } catch (e) {
                console.warn('[FireWally] parseTicket failed on navigation:', e.message);
                if (panelOpen) refreshContext(panel);
              }
            }
          }, 400);
        });
      }
    }).observe(document.body,{childList:true,subtree:true});
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
`;

  let out = [
    HEADER,
    modelsBlock,
    STATE_BLOCK,
    usageBlock,
    GRAVITY_CLIENT,
    timingBlock,
    AUTH_STUBS,
    ticketAndCss,
    CREATE_UI,
    chatEngine,
    companionBlock,
    switchTabBlock,
    SETTINGS_INIT,
  ].join('\n');

  // Patch chat engine: startOrSend / doSend readiness + transport
  out = out.replace(
    /function startOrSend\(panel\) \{\n    if \(!isGoCaaSReady\(\)\) \{\n      toast\(isApiKeyMode\(\) \? '⚠️ Add your GoCaaS API key in Settings' : '⚠️ Connect GoCaaS first'\);\n      return;\n    \}/,
    `function startOrSend(panel) {
    if (!isBackendReady() && isPlaceholderBackend()) {
      toast('⚠️ Set Gravity Tools backend URL in Settings');
      return;
    }
    if (!isBackendReady()) {
      toast('⚠️ Backend not ready — run health check in Settings');
      return;
    }`
  );

  out = out.replace(
    /function doSend\(panel, userText, opts = \{\}\) \{\n    if \(busy \|\| !userText\.trim\(\)\) return;\n    if \(!isGoCaaSReady\(\)\) \{\n      toast\(isApiKeyMode\(\) \? '⚠️ Add your GoCaaS API key in Settings' : '⚠️ Connect GoCaaS first'\);\n      return;\n    \}/,
    `function doSend(panel, userText, opts = {}) {
    if (busy || !userText.trim()) return;
    if (isPlaceholderBackend()) {
      toast('⚠️ Set Gravity Tools backend URL in Settings');
      return;
    }
    if (!backendHealthy) {
      toast('⚠️ Backend not ready — retry health check');
      return;
    }`
  );

  out = out.replace(
    /const ticketId = currentTicket\?\.ticketId \|\| '';\n    const sendFn = isApiKeyMode\(\)\n      \? \(\) => sendViaApiKey\(modelId, outbound, model\.kind, model\.needsAuth === true, ticketId\)\n      : \(\) => sendToGcTab\(modelId, outbound, model\.kind, model\.needsAuth === true, ticketId\);\n    const preflight = model\.kind === 'companion' && !isApiKeyMode\(\)\n      \? ensureRelayModel\(modelId\)\.then\(\(\) => sendFn\(\)\)\n      : sendFn\(\);\n    preflight/,
    `const ticketId = currentTicket?.ticketId || '';
    const preflight = sendViaGravity(modelId, outbound, ticketId);
    preflight`
  );

  // setCompanion: drop GoCaaS tab switchCompanion calls
  out = out.replace(
    /\n\s*if \(changed && m\.kind === 'companion' && isGoCaaSLinked\(\)\) \{\n\s*switchCompanion\(panel, modelId, \{ forceNavigate: true \}\);\n\s*\}\n/g,
    '\n'
  );
  out = out.replace(
    /\n\s*if \(m\.kind === 'companion' && isGoCaaSLinked\(\)\) \{\n\s*switchCompanion\(panel, modelId, \{ forceNavigate: true \}\);\n\s*\}\n/g,
    '\n'
  );
  out = out.replace(
    /await switchCompanion\([^)]*\);?/g,
    '/* companion switch is local-only in v1.3.0 */'
  );

  // Remove references that would break
  out = out.replace(/isGoCaaSReady\(\)/g, 'isBackendReady()');
  out = out.replace(/isApiKeyMode\(\)/g, 'false');
  out = out.replace(/isRelayAlive\(\)/g, 'backendHealthy');
  out = out.replace(/isRelayReady\(\)/g, 'backendHealthy');

  // Fix COMPANION_DEFAULT to use CONFIG
  out = out.replace(
    /const COMPANION_DEFAULT = 'wss-email-response-companion';/,
    "const COMPANION_DEFAULT = CONFIG.DEFAULT_MODEL;"
  );

  // setCompanion may reference syncConnectUI
  out = out.replace(/syncConnectUI\(\);?/g, 'syncBackendUI();');
  out = out.replace(/syncConnectUI\(panel\);?/g, 'syncBackendUI(panel);');

  // If setCompanion still calls ensureRelayModel / waitForRelay
  out = out.replace(/ensureRelayModel\([^)]*\)\.then\([^)]*\)/g, 'Promise.resolve()');
  out = out.replace(/await ensureRelayModel\([^)]*\);?/g, '');

  // Add FOOTER_NAV functions before SETTINGS if handleTicketNavigation missing
  if (!out.includes('function handleTicketNavigation')) {
    out = out.replace(switchTabBlock, FOOTER_NAV + '\n' + switchTabBlock);
  } else {
    // Replace existing handleTicketNavigation at end of companion block if present
  }

  // Remove leftover silentReconnect/switchCompanion if still in companion block - they shouldn't be in companionBlock
  // companionBlock ends before HELPERS, silentReconnect is after init in old file - not included

  // Fix duplicate globalPanel declaration if timing or auth had it
  // STATE_BLOCK has let globalPanel - old code might declare again in syncConnectUI area - we didn't include that

  // Ensure fwGetDefaultCompanionId still works with COMPANION_DEFAULT

  // Patch setCompanion if it has relay forceNavigate
  out = out.replace(
    /if \(opts\.forceNavigate[\s\S]*?switchCompanion[\s\S]*?\n/g,
    '\n'
  );

  // Style health check button like legacy connect button
  out = out.replace(
    '#gc-connect-btn{padding:4px 12px;',
    '#gc-connect-btn,#gc-health-btn{padding:4px 12px;'
  );
  out = out.replace(
    '#gc-connect-btn:hover{opacity:.82;}',
    '#gc-connect-btn:hover,#gc-health-btn:hover{opacity:.82;}'
  );

  fs.writeFileSync(OUT, out);
  console.log('Wrote', OUT, 'lines:', out.split('\n').length);
}

main();
