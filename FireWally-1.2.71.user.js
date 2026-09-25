// ==UserScript==
// @name         FireWally
// @namespace    https://caas.open-webui.godaddy.com/
// @version      1.2.73
// @description  FireWally — GoCaaS relay or optional API key auth. Ticket dashboard overlay.
// @author       GoDaddy WSS
// @match        *://admins.gsp-plat.int.gdcorp.tools/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_xmlhttpRequest
// @connect      caas.open-webui.godaddy.com
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

  const VERSION         = '1.2.73';
  const CONNECT_WAIT_MS   = 120000;
  const RECONNECT_COUNTDOWN_SEC = 8;
  const SESSION_RESPONSE_SAMPLES = 20;
  const DEFAULT_EXPECTED_SEC = 45;
  const RELAY_TS_KEY    = 'fw_last_relay_at';
  const RELAY_ALIVE_MS  = 45000;
  const STUCK_MS        = 90000;
  const BC_CHANNEL      = 'firewally-relay-v1';
  const STORE_HISTORY   = 'fw_chat_';
  const STORE_PICKED    = 'fw_picked_';
  const OWUI          = 'https://caas.open-webui.godaddy.com';
  const WARMUP_MODEL  = 'wss--502-error-workflow';
  const STORE_KEY       = 'gc_owui_api_key';
  const STORE_AUTH_MODE = 'fw_auth_mode';
  const STORE_KEY_VALID = 'fw_api_key_valid';
  const STORE_API_AUTH  = 'fw_api_auth_style';
  const API_SESSION_KEY = 'fw_api_session_id';
  const WSS_TOOL_SERVER = 'server:4f829971-888c-4b23-a4b2-aac4074c8df7';
  const API_POLL_MAX    = 120;
  const API_POLL_DELAY  = 1000;
  const API_STABLE_DONE = 3;
  const STORE_CONNECTED = 'fw_gocaas_connected';
  const STORE_ATLASSIAN = 'fw_atlassian_auth';
  const STORE_USAGE_ON  = 'fw_usage_enabled';
  const STORE_USAGE_URL = 'fw_usage_webhook';
  const STORE_USAGE_USER = 'fw_usage_user';
  const STORE_CACHED_EMAIL = 'fw_cached_user_email';
  const STORE_USAGE_LOGGED = 'fw_usage_logged_keys';
  const STORE_DEFAULT_COMPANION = 'fw_default_companion';
  /* Default Power Automate HTTP webhook → Excel Online table. Override in Settings if needed. */
  const DEFAULT_USAGE_WEBHOOK = 'https://defaultd5f1622b14a345a6b069003f8dc485.1f.environment.api.powerplatform.com:443/powerautomate/automations/direct/workflows/0eb3e3e3e76e4587b9109ddba44f1ecf/triggers/manual/paths/invoke?api-version=1&sp=%2Ftriggers%2Fmanual%2Frun&sv=1.0&sig=nF_7fwTax8gT9uu5yUvZBuY3UfcBHQ3uNjvyAPDDAXg';
  const GC_ORIGIN       = 'https://caas.open-webui.godaddy.com';
  const RELAY_WIN       = 'firewally-relay-tab';
  const RELAY_FEATURES  = 'width=900,height=700,menubar=no,toolbar=no,location=no,status=no';

  const MODELS = [
    { id: 'wss--502-error-workflow',                   name: 'WSS- 502 Error Workflow',        kind: 'companion', needsAuth: true  },
    { id: 'wss--ai-crawler-investigation',           name: 'WSS- AI Crawler Investigation',  kind: 'companion', needsAuth: true  },
    { id: 'website-security-waf-activation-companion', name: 'WSS- WAF Activation Companion',  kind: 'companion', needsAuth: true  },
    { id: 'wss-email-response-companion',              name: 'WSS- Ticket Response Companion', kind: 'companion', needsAuth: true  },
    { id: 'wss-hosting-troubleshooting',               name: 'WSS- Hosting Troubleshooting',   kind: 'companion', needsAuth: true  },
    { id: 'wss--ssl-troubleshooting',                  name: 'WSS- SSL Troubleshooting',         kind: 'companion', needsAuth: true  },
    { id: 'wss---backup-setup-and-troubleshooting',    name: 'WSS- Backup Setup & Troubleshooting', kind: 'companion', needsAuth: true  },
    { id: 'wss--provisioning-failure-companion',       name: 'WSS- Provisioning Failure Companion', kind: 'companion', needsAuth: true  },
    { id: 'wss--monitoring-setup--alerts-companion',   name: 'WSS- Monitoring Setup & Alerts',    kind: 'companion', needsAuth: true  },
  ];

  /* In-memory only — refines estimates during this page session; never persisted. */
  const sessionResponseDurations = {};

  /* Keyword rules for auto-selecting WSS companions (higher priority wins). */
  const COMPANION_RULES = [
    { id: 'wss--502-error-workflow', priority: 100, label: '502/gateway error',
      patterns: [
        /(?<![0-9])502(?![0-9])(?!\s*error\s*workflow)/i,
        /bad gateway/i, /gateway error/i,
        /(?<![0-9])503(?![0-9])\s+service/i, /503\s+service\s+unavailable/i,
        /(?<![0-9])504(?![0-9])\s+gateway/i, /504\s+gateway\s+timeout/i,
        /error\s+502\b/i, /error\s+503\b/i, /error\s+504\b/i,
        /http\s+502\b/i, /http\s+503\b/i, /http\s+504\b/i,
      ] },
    { id: 'website-security-waf-activation-companion', priority: 95, label: 'WAF/firewall',
      patterns: [/waf/i, /web application firewall/i, /firewall activ/i, /activate.{0,20}firewall/i, /set\s*up.{0,20}firewall/i, /firewall.{0,20}set\s*up/i, /cloudproxy/i, /cloud proxy/i, /sucuri\s+(waf|firewall|plugin)/i, /sucuri website firewall/i] },
    { id: 'wss--ai-crawler-investigation', priority: 90, label: 'AI crawler/bot',
      patterns: [/ai crawler/i, /gptbot/i, /claudebot/i, /anthropic-ai/i, /bytespider/i, /cohere-ai/i, /ccbot/i, /petalbot/i, /robots\.txt/i, /\bcrawler\b/i, /\bbot traffic\b/i] },
    { id: 'wss--ssl-troubleshooting', priority: 92, label: 'SSL/certificate',
      patterns: [/\bssl\b/i, /ssl error/i, /\btls\b/i, /certificate/i, /cert expired/i, /cert renewal/i, /\bsan\b/i, /mixed content/i, /not secure/i, /certificate authority/i, /\bletsencrypt\b/i, /let's encrypt/i] },
    { id: 'wss---backup-setup-and-troubleshooting', priority: 94, label: 'backup/restore',
      patterns: [/\bbackups?\b/i, /site backups?/i, /website backups?/i, /backup restore/i, /restore backups?/i, /backups? failed/i, /restore failed/i, /codeguard/i, /automated backups?/i, /scheduled backups?/i, /backup storage/i, /setting up backups?/i, /setup.{0,30}backups?/i, /backups are not running/i, /help setting up backups/i, /gdbackup/i, /website security and backups/i, /configure.{0,20}backups?/i] },
    { id: 'wss--provisioning-failure-companion', priority: 88, label: 'provisioning failure',
      patterns: [/provisioning fail/i, /failed to provision/i, /provisioning error/i, /provision failed/i, /provisioning issue/i, /provisioning problem/i, /provisioning.{0,20}fail/i, /fail.{0,20}provision/i] },
    { id: 'wss--monitoring-setup--alerts-companion', priority: 97, label: 'monitoring/alerts',
      patterns: [
        /cannot setup monitoring/i, /can'?t setup monitoring/i, /unable to setup monitoring/i,
        /help setting up monitoring/i, /needs help setting up monitoring/i, /setting up monitoring/i,
        /monitoring setup/i, /setup.{0,20}monitoring/i, /monitoring.{0,20}setup/i,
        /monitoring is not working/i, /monitoring not working/i, /monitoring.{0,20}incorrectly/i,
        /set\s*up.{0,20}alerts?/i, /alerts? setup/i, /setup.{0,20}alerts?/i,
        /configure.{0,20}monitoring/i, /configure.{0,20}alerts?/i,
        /uptime monitoring/i, /website monitoring/i, /site monitoring/i,
        /monitoring alerts?/i, /alert notifications?/i, /performance monitoring/i,
        /\bmonitoring\b/i,
      ] },
    { id: 'wss-hosting-troubleshooting', priority: 80, label: 'hosting issue',
      patterns: [/hosting/i, /site down/i, /website down/i, /downtime/i, /\bphp\b/i, /\bmysql\b/i, /wordpress/i, /cpanel/i, /internal server error/i, /\bdns\b/i, /\bftp\b/i, /\bssh\b/i, /migration/i, /database/i] },
  ];
  const COMPANION_DEFAULT = 'wss-email-response-companion';
  const FW_RESPONSE_COMPANION_ID = 'wss-email-response-companion';

  function fwIsResponseCompanion(modelId) {
    return String(modelId || '') === FW_RESPONSE_COMPANION_ID;
  }

  function fwGetDefaultCompanionId() {
    try {
      const saved = String(GM_getValue(STORE_DEFAULT_COMPANION, '') || '').trim();
      if (saved && MODELS.some(m => m.id === saved && m.kind === 'companion')) {
        return saved;
      }
    } catch (_) {}
    return COMPANION_DEFAULT;
  }

  function fwSetDefaultCompanionId(modelId) {
    const id = String(modelId || '').trim();
    if (!MODELS.some(m => m.id === id && m.kind === 'companion')) {
      toast('⚠️ Invalid companion');
      return false;
    }
    GM_setValue(STORE_DEFAULT_COMPANION, id);
    return true;
  }

  function fwPopulateDefaultCompanionSelect(panel) {
    const sel = panel.querySelector('#gc-settings-default-companion');
    if (!sel) return;
    const current = fwGetDefaultCompanionId();
    sel.innerHTML = MODELS
      .filter(m => m.kind === 'companion')
      .map(m => `<option value="${m.id}"${m.id === current ? ' selected' : ''}>${m.name}</option>`)
      .join('');
  }

  function fwUpdateInputPlaceholder(panel) {
    const input = panel.querySelector('#gc-input');
    if (!input) return;
    const modelId = panel.querySelector('#gc-model-sel')?.value || fwGetDefaultCompanionId();
    input.placeholder = fwIsResponseCompanion(modelId)
      ? 'Provide additional information… (Enter to send, Shift+Enter for newline)'
      : 'Ask anything… (Enter to send, Shift+Enter for newline)';
  }

  function fwTicketMetadataBlock(ticket) {
    const lines = [];
    if (ticket?.customerEmail) lines.push('Customer email: ' + ticket.customerEmail);
    if (ticket?.siteId) lines.push('Site / domain: ' + ticket.siteId);
    if (ticket?.ticketId) lines.push('Ticket ID: ' + ticket.ticketId);
    return lines.length ? lines.join('\n') + '\n\n' : '';
  }

  function fwBuildInitialSeedMessage(ticketContext, additional, ticket) {
    const additionalText = String(additional || '').trim();
    const body = String(ticketContext || '').trim();
    return (
      fwTicketMetadataBlock(ticket) +
      (additionalText ? 'Additional context from me:\n' + additionalText + '\n\n---\n\n' : '') +
      'Ticket (use this context; only ask for clarification if something essential is still missing):\n\n---\n' +
      body +
      '\n---\n\n' +
      'Please help me draft/support a concise response, and stay in conversation for follow-ups.\n' +
      'On follow-ups in this chat, do not repeat customer-facing replies you already drafted unless I ask for a revision.\n\n' +
      'When providing a customer-ready reply, put the customer-facing section clearly labeled ' +
      '(e.g. Customer-Facing Summary) so Copy Reply works.'
    );
  }

  function fwChatIsEmpty() {
    return !chatHistory.length;
  }

  /* ════════════════════════════════════════
     BACKGROUND TAB MANAGER
     Connection state = relay heartbeats (not window.closed).
  ════════════════════════════════════════ */
  let gcTab          = null;
  let activeRelayWindow = null;
  let gcTabReady     = false;
  let lastRelayAt    = 0;
  let lastRelayVersion = '';
  let pendingResolve = null;
  let pendingReject  = null;
  let pendingTimer   = null;
  let autoConnected  = false;
  let activeRelayModel = null;
  let pendingConnectPanel = null;
  let connectWaitTimer = null;
  let completingConnect = false;
  let relaySignalWaiters = [];
  let activeRequestId = 0;
  let stuckTimer = null;
  let lastActivityAt = 0;
  let progressRef = null;
  let lastFailedSend = null;
  let activeThinkingWrap = null;
  let silentReconnecting = false;
  let companionSwitchId = null;
  let reconnectCountdownIv = null;
  let reconnectFailed = false;
  let sendStartedAt = 0;
  let lastResponseDurationMs = 0;
  let timingModelId = null;
  let timingStepLabel = 'Starting…';
  let timingTickIv = null;
  let oauthPromptShownForRequest = false;
  let oauthWaitActive = false;
  let oauthCompleteNotified = false;
  let namedProbeBlockedUntil = 0;
  let oauthStuckTimer = null;
  let relayBC = null;
  try { relayBC = new BroadcastChannel(BC_CHANNEL); } catch (_) {}

  /* ════════════════════════════════════════
     USAGE LOGGING → Excel Online (Power Automate)
     POST JSON rows to an HTTP webhook that appends
     to an Excel table. Off by default until configured.
     User email detection mirrors WSS Queue Enforcer
     (logout link → header → page scan → cache).
  ════════════════════════════════════════ */
  let detectedUserEmail = null;

  function isNoiseEmail(email) {
    const lower = String(email || '').toLowerCase();
    return !lower.includes('@')
      || lower.includes('noreply')
      || lower.includes('support')
      || lower.includes('info')
      || lower.includes('admin@')
      || lower.includes('contact')
      || lower.includes('help@');
  }

  function getCurrentUserEmail() {
    if (detectedUserEmail) return detectedUserEmail;

    try {
      const manual = String(GM_getValue(STORE_USAGE_USER, '') || '').trim();
      if (manual.includes('@')) {
        detectedUserEmail = manual.toLowerCase();
        return detectedUserEmail;
      }
    } catch (_) {}

    try {
      const cached = GM_getValue(STORE_CACHED_EMAIL, null);
      if (cached && String(cached).includes('@')) {
        detectedUserEmail = String(cached).toLowerCase();
        return detectedUserEmail;
      }
    } catch (_) {}

    const logoutSelectors = [
      'a.header__top__menus__logout',
      'a[title*="Logout"]',
      'a[href*="logout"]',
      '.logout',
      '[data-logout]',
    ];
    for (const selector of logoutSelectors) {
      try {
        const logoutLink = document.querySelector(selector);
        if (!logoutLink) continue;
        const title = logoutLink.getAttribute('title') || logoutLink.textContent || '';
        const match = title.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);
        if (match && !isNoiseEmail(match[1])) {
          detectedUserEmail = match[1].toLowerCase();
          try { GM_setValue(STORE_CACHED_EMAIL, detectedUserEmail); } catch (_) {}
          return detectedUserEmail;
        }
      } catch (_) {}
    }

    const headerSelectors = [
      'header', '.header', 'nav', '.navbar',
      '.user-info', '.user-menu',
      '[class*="user"]', '[class*="profile"]',
    ];
    for (const selector of headerSelectors) {
      try {
        const element = document.querySelector(selector);
        if (!element) continue;
        const text = element.textContent || element.innerHTML || '';
        const match = text.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);
        if (match && !isNoiseEmail(match[1])) {
          detectedUserEmail = match[1].toLowerCase();
          try { GM_setValue(STORE_CACHED_EMAIL, detectedUserEmail); } catch (_) {}
          return detectedUserEmail;
        }
      } catch (_) {}
    }

    try {
      const pageText = document.body?.textContent || '';
      const emailMatches = pageText.match(/([a-zA-Z0-9._%+-]+@(?:godaddy\.com|sucuri\.net))/gi);
      if (emailMatches?.length) {
        const filtered = emailMatches.map(e => e.toLowerCase()).filter(e => !isNoiseEmail(e));
        if (filtered.length) {
          detectedUserEmail = filtered[0];
          try { GM_setValue(STORE_CACHED_EMAIL, detectedUserEmail); } catch (_) {}
          return detectedUserEmail;
        }
      }
    } catch (_) {}

    return null;
  }

  function guessAnalystId() {
    return getCurrentUserEmail() || 'unknown';
  }

  function getUsageWebhookUrl() {
    const custom = String(GM_getValue(STORE_USAGE_URL, '') || '').trim();
    return custom || DEFAULT_USAGE_WEBHOOK;
  }

  function isUsageLoggingEnabled() {
    // Default ON when a webhook is available (built-in or custom).
    const stored = GM_getValue(STORE_USAGE_ON, '');
    if (stored === 'true' || stored === 'false') return stored === 'true';
    return !!getUsageWebhookUrl();
  }

  function trackUsage(event, props = {}) {
    try {
      if (!isUsageLoggingEnabled()) return;
      const url = getUsageWebhookUrl();
      if (!url || !/^https:\/\//i.test(url)) return;
      if (typeof GM_xmlhttpRequest !== 'function') return;

      const modelId = props.companion
        || globalPanel?.querySelector('#gc-model-sel')?.value
        || '';
      const model = MODELS.find(m => m.id === modelId);
      const durationMs = props.durationMs != null && props.durationMs !== ''
        ? Math.max(0, Math.round(Number(props.durationMs) || 0))
        : null;
      const payload = {
        Timestamp: new Date().toISOString(),
        User: guessAnalystId(),
        Event: String(event || 'unknown'),
        Companion: modelId || '',
        CompanionName: props.companionName || model?.name || '',
        TicketId: String(props.ticketId || currentTicket?.ticketId || ''),
        Detail: String(props.detail || '').slice(0, 500),
        DurationMs: durationMs != null ? String(durationMs) : '',
        version: VERSION,
        Version: VERSION,
        PageUrl: String(location.href || '').slice(0, 300),
      };

      GM_xmlhttpRequest({
        method: 'POST',
        url,
        headers: { 'Content-Type': 'application/json' },
        data: JSON.stringify(payload),
        anonymous: true,
        timeout: 8000,
        onload() {},
        onerror() {},
        ontimeout() {},
      });
    } catch (_) {}
  }

  /** One Excel row per user + ticket + companion (first successful send only). */
  function trackCompanionTicketUsage(modelId, modelName, opts = {}) {
    try {
      const companion = modelId || globalPanel?.querySelector('#gc-model-sel')?.value || '';
      const ticketId = String(opts.ticketId || currentTicket?.ticketId || '').trim();
      if (!companion || !ticketId) return;

      const user = guessAnalystId();
      const key = `${user}|${ticketId}|${companion}`;
      let logged = {};
      try { logged = JSON.parse(GM_getValue(STORE_USAGE_LOGGED, '{}') || '{}') || {}; } catch (_) { logged = {}; }
      if (logged[key]) return;

      logged[key] = Date.now();
      // Keep map from growing forever — drop entries older than 30 days.
      const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
      for (const k of Object.keys(logged)) {
        if (typeof logged[k] !== 'number' || logged[k] < cutoff) delete logged[k];
      }
      try { GM_setValue(STORE_USAGE_LOGGED, JSON.stringify(logged)); } catch (_) {}

      trackUsage('companion_usage', {
        companion,
        companionName: modelName || '',
        ticketId,
        durationMs: opts.durationMs,
        detail: opts.detail || 'first_send',
      });
    } catch (_) {}
  }

  function getCachedRelayTab() {
    const tryTab = (tab) => {
      if (!tab || tab === window) return null;
      try { if (tab.closed) return null; } catch (_) { return tab; }
      return tab;
    };
    return tryTab(activeRelayWindow) || tryTab(gcTab)
      || (() => { try { return tryTab(window.top.__fw_relay_source); } catch (_) { return null; } })();
  }

  function collectRelayTargets() {
    const targets = [];
    const seen = new Set();
    const add = (tab) => {
      if (!tab || tab === window) return;
      try { if (tab.closed) return; } catch (_) {}
      if (seen.has(tab)) return;
      seen.add(tab);
      targets.push(tab);
    };
    add(activeRelayWindow);
    add(gcTab);
    try { add(window.top.__fw_relay_source); } catch (_) {}
    return targets;
  }

  function postToRelay(msg) {
    const targets = collectRelayTargets();
    if (!targets.length) return false;
    let sent = false;
    for (const tab of targets) {
      try {
        tab.postMessage(msg, GC_ORIGIN);
        sent = true;
      } catch (_) {}
    }
    try {
      relayBC?.postMessage({ ...msg, origin: 'firewally-ticket' });
    } catch (_) {}
    return sent;
  }

  function companionUrl(modelId) {
    return `${OWUI}/?model=${modelId}`;
  }

  function isRelayAlive() {
    return Date.now() - lastRelayAt < RELAY_ALIVE_MS;
  }

  function isRelayReady() {
    return isRelayAlive() && !!getRelayTab();
  }

  function hydrateRelayTimestamp() {
    try {
      const ts = parseInt(sessionStorage.getItem(RELAY_TS_KEY) || '0', 10);
      if (ts && Date.now() - ts < RELAY_ALIVE_MS) lastRelayAt = ts;
    } catch (_) {}
  }

  /** Re-acquire relay tab from in-memory cache only — never opens browser windows. */
  function restoreCachedRelayTab() {
    const cached = getCachedRelayTab();
    if (cached) { gcTab = cached; return cached; }
    return null;
  }

  /** Drop in-memory tab refs on ticket nav; keep cached opener source for fast re-bind. */
  function softInvalidateRelayHandles() {
    gcTab = null;
    activeRelayWindow = null;
  }

  function isGoCaaSLinked() {
    return GM_getValue(STORE_CONNECTED, 'false') === 'true' || autoConnected;
  }

  function touchRelay() {
    lastRelayAt = Date.now();
    try { sessionStorage.setItem(RELAY_TS_KEY, String(lastRelayAt)); } catch (_) {}
    gcTabReady = true;
    markConnected(true);
    syncConnectUI();
  }

  function loadPersistedRelayState() {
    if (GM_getValue(STORE_CONNECTED, 'false') === 'true') autoConnected = true;
    hydrateRelayTimestamp();
  }

  /** Re-acquire relay tab from cache only — never focuses GoCaaS unless useNamedLookup. */
  function restoreRelayTabRef(useNamedLookup = false) {
    const cached = getCachedRelayTab();
    if (cached) { gcTab = cached; return cached; }
    if (useNamedLookup) {
      const named = lookupNamedRelayTab();
      if (named) {
        gcTab = named;
        activeRelayWindow = named;
        return named;
      }
    }
    return null;
  }

  function markConnected(connected) {
    autoConnected = connected;
    GM_setValue(STORE_CONNECTED, connected ? 'true' : 'false');
  }

  /** Look up named relay window — user gesture only (connect/send). Never call from timers. */
  function lookupNamedRelayTab() {
    if (Date.now() < namedProbeBlockedUntil) return null;
    try {
      const tab = window.open('', RELAY_WIN);
      if (!tab || tab.closed) return null;
      try {
        const href = tab.location.href;
        if (!href || href === 'about:blank' || href.startsWith('about:')) {
          tab.close();
          namedProbeBlockedUntil = Date.now() + 60000;
          return null;
        }
        return href.includes('caas.open-webui.godaddy.com') ? tab : null;
      } catch (_) {
        return tab;
      }
    } catch (_) {}
    return null;
  }

  function acquireRelayTab(modelId, openIfMissing = true) {
    const existing = restoreCachedRelayTab();
    if (existing) return existing;
    if (!openIfMissing) return null;
    const id = modelId || fwGetDefaultCompanionId();
    return window.open(companionUrl(id), RELAY_WIN, RELAY_FEATURES);
  }

  /** Remember relay tab from incoming postMessage (works even without named window). */
  function captureRelaySource(event) {
    try {
      if (event?.source && event.source !== window) {
        activeRelayWindow = event.source;
        gcTab = event.source;
        try { window.top.__fw_relay_source = event.source; } catch (_) {}
      }
    } catch (_) {}
  }

  /** Get relay tab for postMessage — uses cached handle only (never focuses GoCaaS). */
  function getRelayTab(useNamedLookup = false) {
    const cached = getCachedRelayTab();
    if (cached) { gcTab = cached; return cached; }
    if (useNamedLookup) {
      const named = lookupNamedRelayTab();
      if (named) { gcTab = named; return named; }
    }
    return null;
  }

  /** Open GoCaaS tab — user gesture only. Opens or navigates the named window directly (no blank probe). */
  function openRelayTab(modelId) {
    const id = modelId || fwGetDefaultCompanionId();
    const tab = window.open(companionUrl(id), RELAY_WIN, RELAY_FEATURES);
    if (tab) {
      gcTab = tab;
      activeRelayWindow = tab;
      try { window.top.__fw_relay_source = tab; } catch (_) {}
    }
    return tab;
  }

  function pingGcTab() {
    postToRelay({ type: 'gc-ping' });
  }

  function cancelActiveRequest() {
    if (!busy) return;
    activeRequestId++;
    clearTimeout(pendingTimer);
    clearStuckWatch();
    stopResponseProgress();
    activeThinkingWrap?.remove();
    activeThinkingWrap = null;
    if (pendingReject) {
      const rj = pendingReject;
      pendingResolve = null;
      pendingReject = null;
      rj(new Error('Cancelled'));
    }
    postToRelay({ type: 'gc-cancel' });
    if (isApiKeyMode()) {
      apiKeyCancelled = true;
      apiPollGeneration += 1;
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
        const hint = isApiKeyMode()
          ? '⏳ Still working — companion may be running tools (Cancel to stop)'
          : '⏳ Still working — check GoCaaS tab or Cancel';
        setStatus(panel, 'loading', hint);
        toast(isApiKeyMode()
          ? '⏳ Request taking longer than usual'
          : '⏳ Request taking longer than usual — check GoCaaS tab', 4000);
      }
    }, 10000);
  }

  /* ════════════════════════════════════════
     API KEY MODE — direct GoCaaS calls (no relay tab)
  ════════════════════════════════════════ */
  const apiChatCache = Object.create(null);
  let apiPollGeneration = 0;
  let apiKeyCancelled = false;

  function getAuthMode() {
    return GM_getValue(STORE_AUTH_MODE, 'relay') === 'apikey' ? 'apikey' : 'relay';
  }

  function isApiKeyMode() {
    return getAuthMode() === 'apikey';
  }

  function getStoredApiKey() {
    return String(GM_getValue(STORE_KEY, '') || '').trim();
  }

  function isApiKeyReady() {
    return isApiKeyMode() && getStoredApiKey().length >= 8;
  }

  function isGoCaaSReady() {
    if (isApiKeyMode()) return isApiKeyReady();
    return isRelayAlive() || gcTabReady;
  }

  function fwUid() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
  }

  function getApiSessionId() {
    let sid = String(GM_getValue(API_SESSION_KEY, '') || '').trim();
    if (!sid) {
      sid = fwUid();
      try { GM_setValue(API_SESSION_KEY, sid); } catch (_) {}
    }
    return sid;
  }

  function fwNowVars() {
    const now = new Date();
    const pad = n => String(n).padStart(2, '0');
    const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    const time = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    return {
      date,
      time,
      datetime: `${date} ${time}`,
      weekday: days[now.getDay()],
      tz: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Unknown',
    };
  }

  function normalizeApiKey(raw) {
    let key = String(raw || '').trim();
    if (/^bearer\s+/i.test(key)) key = key.replace(/^bearer\s+/i, '').trim();
    if ((key.startsWith('"') && key.endsWith('"')) || (key.startsWith("'") && key.endsWith("'"))) {
      key = key.slice(1, -1).trim();
    }
    return key;
  }

  function describeApiKeyFormat(key) {
    const k = normalizeApiKey(key);
    if (!k) return 'Key is empty';
    if (k.startsWith('eyJ')) {
      return 'This looks like a JWT/session token, not an API key — generate a key under GoCaaS Settings → Account → API keys (starts with sk-)';
    }
    if (!k.startsWith('sk-')) {
      return 'Expected an API key starting with sk- (from GoCaaS Settings → Account → API keys)';
    }
    return '';
  }

  function parseGoCaaSError(raw) {
    try {
      const j = JSON.parse(raw || '{}');
      const d = j.detail ?? j.error?.message ?? j.message;
      if (typeof d === 'string') return d;
      if (Array.isArray(d)) return d.map(x => x?.msg || x?.message || String(x)).filter(Boolean).join('; ');
      if (d && typeof d === 'object') return d.message || JSON.stringify(d);
    } catch (_) {}
    const text = String(raw || '').trim();
    return text ? text.slice(0, 160) : 'Not authenticated';
  }

  function apiAuthHeaderSets(key) {
    const token = normalizeApiKey(key);
    return [
      { style: 'bearer', headers: { Authorization: `Bearer ${token}` } },
      { style: 'x-api-key', headers: { 'x-api-key': token } },
      { style: 'x-openwebui-key', headers: { 'X-OpenWebUI-Key': token } },
    ];
  }

  function getPreferredApiAuthStyle() {
    const stored = String(GM_getValue(STORE_API_AUTH, '') || '').trim();
    return stored || 'bearer';
  }

  function setPreferredApiAuthStyle(style) {
    if (style) try { GM_setValue(STORE_API_AUTH, style); } catch (_) {}
  }

  function gmOwuiPublicGet(path, timeout = 15000) {
    const url = /^https?:\/\//i.test(path) ? path : `${OWUI}${path}`;
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url,
        headers: { Accept: 'application/json' },
        timeout,
        anonymous: true,
        onload(resp) {
          resolve({
            ok: resp.status >= 200 && resp.status < 300,
            status: resp.status,
            responseText: resp.responseText || '',
          });
        },
        onerror: () => reject(new Error('Network error calling GoCaaS')),
        ontimeout: () => reject(new Error('GoCaaS request timed out')),
      });
    });
  }

  async function fetchGoCaaSPlatformConfig() {
    try {
      const r = await gmOwuiPublicGet('/api/config');
      if (!r.ok) return null;
      return JSON.parse(r.responseText || '{}');
    } catch (_) {
      return null;
    }
  }

  function apiKeysEnabledOnPlatform(cfg) {
    return cfg?.features?.enable_api_keys === true;
  }

  function apiKeyPlatformBlockedMessage(cfg) {
    const gocode = cfg?.godaddy?.enable_gocode_key_generation === true;
    let msg = 'GoCaaS has Open WebUI API keys disabled platform-wide (enable_api_keys: false). '
      + 'Keys from Settings → Account will not authenticate until a GoCaaS admin enables API keys '
      + '(Admin Panel → Settings → Authentication → API Keys).';
    if (gocode) {
      msg += ' Note: GoCode key generation is enabled, but that is separate from Open WebUI API key auth — use Relay mode until API keys are enabled.';
    } else {
      msg += ' Use Relay mode (Connect GoCaaS tab) in the meantime.';
    }
    return msg;
  }

  function gmOwuiRequest(path, options = {}) {
    const apiKey = normalizeApiKey(options.apiKey || getStoredApiKey());
    if (!apiKey) return Promise.reject(new Error('GoCaaS API key not configured — add it in Settings'));
    const url = /^https?:\/\//i.test(path) ? path : `${OWUI}${path}`;
    const method = (options.method || 'GET').toUpperCase();
    const authStyle = options.authStyle || getPreferredApiAuthStyle();
    const authSet = apiAuthHeaderSets(apiKey).find(s => s.style === authStyle)
      || apiAuthHeaderSets(apiKey)[0];
    const headers = {
      Accept: 'application/json',
      ...authSet.headers,
      ...(options.headers || {}),
    };
    if (options.body != null && !headers['Content-Type']) {
      headers['Content-Type'] = 'application/json';
    }
    const body = options.body == null
      ? undefined
      : (typeof options.body === 'string' ? options.body : JSON.stringify(options.body));
    const timeout = options.timeout || 300000;
    return new Promise((resolve, reject) => {
      if (apiKeyCancelled) {
        reject(new Error('Cancelled'));
        return;
      }
      GM_xmlhttpRequest({
        method,
        url,
        headers,
        data: body,
        timeout,
        anonymous: true,
        onload(resp) {
          resolve({
            ok: resp.status >= 200 && resp.status < 300,
            status: resp.status,
            responseText: resp.responseText || '',
            authStyle: authSet.style,
            async text() { return resp.responseText || ''; },
          });
        },
        onerror() { reject(new Error('Network error calling GoCaaS')); },
        ontimeout() { reject(new Error('GoCaaS request timed out')); },
      });
    });
  }

  async function testApiKeyConnection(apiKeyOverride) {
    const key = normalizeApiKey(apiKeyOverride || getStoredApiKey());
    if (!key) throw new Error('Enter an API key first');

    const platformCfg = await fetchGoCaaSPlatformConfig();
    if (platformCfg && !apiKeysEnabledOnPlatform(platformCfg)) {
      throw new Error(apiKeyPlatformBlockedMessage(platformCfg));
    }

    const formatHint = describeApiKeyFormat(key);
    const paths = ['/api/models', '/api/v1/models', '/api/v1/users/user'];
    const preferred = getPreferredApiAuthStyle();
    const authSets = apiAuthHeaderSets(key);
    authSets.sort((a, b) => (a.style === preferred ? -1 : b.style === preferred ? 1 : 0));

    let lastDetail = '';
    let lastStatus = 0;

    for (const authSet of authSets) {
      for (const path of paths) {
        try {
          const r = await gmOwuiRequest(path, { apiKey: key, authStyle: authSet.style, timeout: 20000 });
          if (r.ok) {
            setPreferredApiAuthStyle(r.authStyle || authSet.style);
            return { ok: true, path, authStyle: r.authStyle || authSet.style };
          }
          lastStatus = r.status;
          lastDetail = parseGoCaaSError(r.responseText);
          if (r.status !== 401 && r.status !== 403) continue;
        } catch (e) {
          if (e.message.includes('Network error') || e.message.includes('timed out')) throw e;
        }
      }
    }

    const detail = lastDetail || 'Not authenticated';
    if (/^not authenticated$/i.test(detail.trim()) && platformCfg && !apiKeysEnabledOnPlatform(platformCfg)) {
      throw new Error(apiKeyPlatformBlockedMessage(platformCfg));
    }
    let msg = `GoCaaS rejected the key (HTTP ${lastStatus || 401}): ${detail}`;
    if (formatHint) msg += `. ${formatHint}`;
    else if (/invalid|expired|not authenticated/i.test(detail)) {
      msg += '. Generate a fresh key at GoCaaS → Settings → Account → API keys. Confirm API keys are enabled for your account.';
    }
    throw new Error(msg);
  }

  function apiChatCacheKey(ticketId, modelId) {
    const tid = String(ticketId || '').trim() || '_none';
    return `${tid}|${modelId || ''}`;
  }

  function apiCompanionShortName(modelId) {
    const id = String(modelId || '');
    if (id.includes('502')) return '502';
    if (id.includes('ai-crawler')) return 'AI-Crawler';
    if (id.includes('waf')) return 'WAF';
    if (id.includes('email')) return 'Ticket-Response';
    if (id.includes('hosting')) return 'Hosting';
    if (id.includes('ssl')) return 'SSL';
    if (id.includes('backup')) return 'Backup';
    if (id.includes('provisioning')) return 'Provisioning';
    if (id.includes('monitoring')) return 'Monitoring';
    return id.slice(0, 24) || 'Companion';
  }

  function apiChatTitle(modelId, ticketId) {
    const name = apiCompanionShortName(modelId);
    const tid = String(ticketId || '').trim();
    return tid ? `FireWally · ${name} · ${tid}` : `FireWally · ${name}`;
  }

  function apiBuildChatStructure(modelId, messages) {
    const ts = Math.floor(Date.now() / 1000);
    const historyMessages = {};
    let prevId = null;
    const flatList = [];
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      const id = fwUid();
      const entry = {
        id, role: m.role, content: normalizeContent(m.content),
        timestamp: ts + i, childrenIds: [],
      };
      if (m.role === 'user') entry.models = [modelId];
      if (m.role === 'assistant') {
        entry.model = modelId;
        entry.modelName = modelId;
        entry.modelIdx = 0;
        entry.done = true;
      }
      if (prevId) {
        entry.parentId = prevId;
        historyMessages[prevId].childrenIds.push(id);
      }
      historyMessages[id] = entry;
      flatList.push(entry);
      prevId = id;
    }
    const assistantMsgId = fwUid();
    const assistantEntry = {
      id: assistantMsgId,
      role: 'assistant',
      content: '',
      parentId: prevId,
      childrenIds: [],
      model: modelId,
      modelName: modelId,
      modelIdx: 0,
      done: false,
      timestamp: ts + messages.length,
    };
    if (prevId) historyMessages[prevId].childrenIds.push(assistantMsgId);
    historyMessages[assistantMsgId] = assistantEntry;
    flatList.push(assistantEntry);
    return { flatList, historyMessages, assistantMsgId };
  }

  function apiGetCachedChat(ticketId, modelId) {
    return apiChatCache[apiChatCacheKey(ticketId, modelId)] || null;
  }

  function apiSetCachedChat(ticketId, modelId, chatId, currentId) {
    apiChatCache[apiChatCacheKey(ticketId, modelId)] = { chatId, currentId, updatedAt: Date.now() };
  }

  function apiClearCachedChat(ticketId, modelId) {
    delete apiChatCache[apiChatCacheKey(ticketId, modelId)];
  }

  async function apiCreateChatSession(modelId, messages, ticketId) {
    const { flatList, historyMessages, assistantMsgId } = apiBuildChatStructure(modelId, messages);
    const body = {
      chat: {
        title: apiChatTitle(modelId, ticketId),
        models: [modelId],
        messages: flatList,
        history: { currentId: assistantMsgId, messages: historyMessages },
      },
    };
    for (const endpoint of ['/api/v1/chats/new', '/api/chats/new']) {
      try {
        const r = await gmOwuiRequest(endpoint, { method: 'POST', body });
        const raw = await r.text();
        if (!r.ok) continue;
        const j = JSON.parse(raw);
        const chatId = j.id || j.chat?.id;
        if (chatId) {
          apiSetCachedChat(ticketId, modelId, chatId, assistantMsgId);
          return { chatId, assistantMsgId, reused: false };
        }
      } catch (_) {}
    }
    throw new Error('Could not create GoCaaS chat session');
  }

  async function apiAppendChatSession(chatId, modelId, messages, parentId, ticketId) {
    const lastUser = [...(messages || [])].reverse().find(m => m.role === 'user');
    if (!lastUser) throw new Error('No user message to append');
    if (!parentId) throw new Error('Missing parent message id for chat reuse');
    const userMsgId = fwUid();
    const assistantMsgId = fwUid();
    const ts = Math.floor(Date.now() / 1000);
    const body = {
      chat: {
        title: apiChatTitle(modelId, ticketId),
        models: [modelId],
        history: {
          currentId: assistantMsgId,
          messages: {
            [parentId]: { id: parentId, childrenIds: [userMsgId] },
            [userMsgId]: {
              id: userMsgId,
              role: 'user',
              content: normalizeContent(lastUser.content),
              parentId,
              childrenIds: [assistantMsgId],
              models: [modelId],
              timestamp: ts,
            },
            [assistantMsgId]: {
              id: assistantMsgId,
              role: 'assistant',
              content: '',
              parentId: userMsgId,
              childrenIds: [],
              model: modelId,
              modelName: modelId,
              modelIdx: 0,
              done: false,
              timestamp: ts + 1,
            },
          },
        },
      },
    };
    for (const endpoint of [`/api/v1/chats/${chatId}`, `/api/chats/${chatId}`]) {
      try {
        const r = await gmOwuiRequest(endpoint, { method: 'POST', body });
        if (r.status === 404 || r.status === 401) return null;
        if (!r.ok) continue;
        apiSetCachedChat(ticketId, modelId, chatId, assistantMsgId);
        return { chatId, assistantMsgId, reused: true };
      } catch (_) {}
    }
    return null;
  }

  async function apiPrepareChatSession(modelId, messages, ticketId) {
    const cached = apiGetCachedChat(ticketId, modelId);
    if (cached?.chatId && cached?.currentId) {
      const updated = await apiAppendChatSession(
        cached.chatId, modelId, messages, cached.currentId, ticketId
      );
      if (updated) return updated;
      apiClearCachedChat(ticketId, modelId);
    }
    return apiCreateChatSession(modelId, messages, ticketId);
  }

  function apiValidMessages(messages) {
    return (messages || [])
      .map(m => ({ role: m.role, content: normalizeContent(m.content) }))
      .filter(m => (m.role === 'user' || m.role === 'assistant') && String(m.content || '').trim());
  }

  function apiBuildPayload(modelId, modelKind, messages, chatSession, needsAuth) {
    const chatMessages = apiValidMessages(messages);
    const base = {
      model: modelId,
      messages: chatMessages,
      stream: false,
      session_id: getApiSessionId(),
      params: {},
    };
    if (chatSession?.chatId) {
      base.chat_id = chatSession.chatId;
      base.id = chatSession.assistantMsgId;
    }
    if (modelKind === 'llm') return base;
    const now = fwNowVars();
    const email = getCurrentUserEmail() || '';
    const variables = {
      '{{USER_NAME}}': email ? email.split('@')[0] : 'Analyst',
      '{{USER_EMAIL}}': email,
      '{{USER_LOCATION}}': 'Unknown',
      '{{USER_LANGUAGE}}': 'en-US',
      '{{CURRENT_DATE}}': now.date,
      '{{CURRENT_TIME}}': now.time,
      '{{CURRENT_DATETIME}}': now.datetime,
      '{{CURRENT_WEEKDAY}}': now.weekday,
      '{{CURRENT_TIMEZONE}}': now.tz,
    };
    if (!needsAuth) {
      return {
        ...base,
        sdm_mode: true,
        tool_ids: [],
        tool_servers: [],
        features: {
          image_generation: false,
          code_interpreter: false,
          web_search: false,
          deep_research: false,
          memory: false,
        },
        background_tasks: { follow_up_generation: false },
        variables,
      };
    }
    return {
      ...base,
      sdm_mode: true,
      tool_ids: [WSS_TOOL_SERVER],
      tool_servers: [],
      features: {
        image_generation: false,
        code_interpreter: true,
        web_search: true,
        deep_research: false,
        memory: true,
      },
      background_tasks: { follow_up_generation: true },
      variables,
    };
  }

  function apiParseFormArgs(argsRaw) {
    const decoded = argsRaw
      .replace(/&quot;/g, '"')
      .replace(/&#x27;/g, "'")
      .replace(/&amp;/g, '&')
      .replace(/&#x2F;/g, '/')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&#x([0-9a-fA-F]+);/g, (m, hex) => String.fromCharCode(parseInt(hex, 16)));
    const firstParse = JSON.parse(decoded);
    return typeof firstParse === 'string' ? JSON.parse(firstParse) : firstParse;
  }

  function apiProcessToolCalls(text) {
    if (!text) return { text: '', forms: [] };
    const forms = [];
    let out = text.replace(
      /<details[^>]*name=["']request_user_input["'][^>]*arguments="([^"]*)"[^>]*>[\s\S]*?<\/details>/gi,
      (match, argsRaw) => {
        try {
          forms.push(apiParseFormArgs(argsRaw));
          return '';
        } catch (_) {
          return '';
        }
      }
    );
    out = stripToolExecutedArtifacts(replaceDetailsPreservingUrls(out));
    return { text: out.replace(/\n{3,}/g, '\n\n').trim(), forms };
  }

  function apiCoalesceContent(c, depth) {
    depth = depth || 0;
    if (depth > 10 || c == null) return '';
    if (typeof c === 'string') return c;
    if (Array.isArray(c)) return c.map(x => apiCoalesceContent(x, depth + 1)).join('');
    if (typeof c === 'object') {
      if (typeof c.text === 'string') return c.text;
      if (typeof c.content === 'string') return c.content;
      if (c.content != null) return apiCoalesceContent(c.content, depth + 1);
    }
    return '';
  }

  function apiExtractAssistantText(chatJson, assistantMessageId) {
    if (!assistantMessageId) return '';
    const chat = chatJson?.chat || (Array.isArray(chatJson?.messages) ? chatJson : null);
    if (!chat) return '';
    const hist = chat.history?.messages;
    if (hist && typeof hist === 'object' && !Array.isArray(hist)) {
      const hm = hist[assistantMessageId];
      if (hm) {
        const t = apiCoalesceContent(hm.content) || apiCoalesceContent(hm.text) || '';
        if (String(t).trim()) return String(t).trim();
      }
    }
    const lists = [];
    if (Array.isArray(chat.messages)) lists.push(chat.messages);
    if (Array.isArray(hist)) lists.push(hist);
    else if (hist && typeof hist === 'object') lists.push(Object.values(hist).filter(Boolean));
    for (const list of lists) {
      for (const m of list) {
        if (m?.id === assistantMessageId) {
          const t = apiCoalesceContent(m.content) || apiCoalesceContent(m.text) || '';
          if (String(t).trim()) return String(t).trim();
        }
      }
    }
    return '';
  }

  async function apiFetchChatDocument(chatId) {
    for (const endpoint of [`/api/v1/chats/${chatId}`, `/api/chats/${chatId}`]) {
      try {
        const r = await gmOwuiRequest(endpoint, { method: 'GET' });
        if (!r.ok) continue;
        return JSON.parse(await r.text());
      } catch (_) {}
    }
    return null;
  }

  async function apiPollAssistant(chatId, assistantMessageId, gen, onProgress) {
    let tries = 0;
    let last = '';
    let stable = 0;
    while (tries < API_POLL_MAX) {
      tries += 1;
      if (gen !== apiPollGeneration || apiKeyCancelled) return '';
      const json = await apiFetchChatDocument(chatId);
      const text = (json ? apiExtractAssistantText(json, assistantMessageId) : '').trim();
      if (text) {
        if (text.includes('<details') && onProgress) onProgress('🔧 Tools active — companion is responding…');
        else if (onProgress && tries > 2) onProgress('✍️ Companion is responding…');
        if (text === last) {
          stable += 1;
          if (stable >= API_STABLE_DONE) return last;
        } else {
          last = text;
          stable = 1;
        }
      } else if (onProgress && tries === 3) {
        onProgress('⏳ Waiting for companion response…');
      }
      await new Promise(r => setTimeout(r, API_POLL_DELAY));
    }
    return last;
  }

  function apiHttpError(raw, status) {
    let msg = `HTTP ${status}`;
    try { msg = JSON.parse(raw)?.detail || JSON.parse(raw)?.error?.message || msg; } catch (_) {}
    if (typeof msg === 'object') msg = msg.message || JSON.stringify(msg);
    return String(msg);
  }

  async function sendViaApiKey(modelId, messages, modelKind = 'companion', needsAuth = false, ticketId = '') {
    if (!isApiKeyReady()) throw new Error('GoCaaS API key not configured — open Settings and add your key');
    const platformCfg = await fetchGoCaaSPlatformConfig();
    if (platformCfg && !apiKeysEnabledOnPlatform(platformCfg)) {
      throw new Error(apiKeyPlatformBlockedMessage(platformCfg));
    }
    apiKeyCancelled = false;
    const gen = ++apiPollGeneration;
    const resolvedTicketId = ticketId || currentTicket?.ticketId || '';
    const chatMessages = apiValidMessages(messages);
    if (!chatMessages.some(m => m.role === 'user')) {
      throw new Error('No message to send — type a message and try again.');
    }

    let chatSession = null;
    if (modelKind === 'companion') {
      chatSession = await apiPrepareChatSession(modelId, chatMessages, resolvedTicketId);
    }

    const payload = apiBuildPayload(modelId, modelKind, chatMessages, chatSession, needsAuth === true);
    const onProgress = (label) => {
      touchActivity();
      if (globalPanel) {
        if (progressRef) bumpResponseProgress(progressRef, 8, label);
        else setStatus(globalPanel, 'loading', `⏳ ${label}`);
      }
    };

    onProgress('Sending to GoCaaS…');
    const r = await gmOwuiRequest('/api/chat/completions', { method: 'POST', body: payload });
    const raw = await r.text();
    if (gen !== apiPollGeneration || apiKeyCancelled) throw new Error('Cancelled');

    if (!r.ok) {
      const msg = apiHttpError(raw, r.status);
      if (r.status === 401 || r.status === 403) {
        try { GM_setValue(STORE_KEY_VALID, 'false'); } catch (_) {}
        throw new Error('Invalid GoCaaS API key — check Settings');
      }
      throw new Error(msg);
    }

    let inlineContent = null;
    if (raw && raw.trim() && raw.trim() !== 'null') {
      try {
        const j = JSON.parse(raw);
        inlineContent = j?.choices?.[0]?.message?.content ?? j?.content ?? null;
        if (!inlineContent && j?.task_id && chatSession?.chatId) {
          onProgress('Companion queued — waiting for response…');
        }
      } catch (_) {}
    }

    if (!inlineContent && chatSession?.chatId && chatSession?.assistantMsgId) {
      onProgress('Waiting for companion response…');
      inlineContent = await apiPollAssistant(
        chatSession.chatId, chatSession.assistantMsgId, gen, onProgress
      );
    }

    if (gen !== apiPollGeneration || apiKeyCancelled) throw new Error('Cancelled');
    if (!inlineContent) throw new Error('Timed out waiting for companion response');

    try { GM_setValue(STORE_KEY_VALID, 'true'); } catch (_) {}
    return apiProcessToolCalls(inlineContent);
  }

  function syncAuthModeUI(panel) {
    const modeSel = panel?.querySelector('#gc-settings-auth-mode');
    const block = panel?.querySelector('#gc-settings-apikey-block');
    const connectBar = panel?.querySelector('#gc-connect-bar');
    const isApi = modeSel?.value === 'apikey';
    if (block) block.style.display = isApi ? '' : 'none';
    if (connectBar) connectBar.style.display = isApi ? 'none' : '';
  }

  function clearStuckWatch() {
    clearInterval(stuckTimer);
    stuckTimer = null;
  }

  function touchActivity() {
    lastActivityAt = Date.now();
  }

  function stopConnectWait() {
    clearInterval(connectWaitTimer);
    connectWaitTimer = null;
  }

  function startConnectWait(panel) {
    pendingConnectPanel = panel;
    stopConnectWait();
    connectWaitTimer = setInterval(pingGcTab, 2500);
    pingGcTab();
  }

  async function completeConnect(panel) {
    if (!panel || completingConnect || !isRelayAlive()) return;
    completingConnect = true;
    try {
      await finishConnect(panel);
      pendingConnectPanel = null;
      stopConnectWait();
      touchRelay();
      syncConnectUI();
    } catch (e) {
      setStatus(panel, 'loading', 'GoCaaS connected — finishing setup…');
      if (!connectWaitTimer && pendingConnectPanel) startConnectWait(panel);
    } finally {
      completingConnect = false;
    }
  }

  function onRelayAlive() {
    resolveRelaySignalWaiters();
    if (!pendingConnectPanel) return;
    completeConnect(pendingConnectPanel);
  }

  function openGcTab(modelId) {
    const tab = openRelayTab(modelId);
    if (!tab) throw new Error('Popup blocked — please allow popups for this site then try again.');
    if (tab.closed) throw new Error('GoCaaS tab was closed');
    gcTab = tab;
    return gcTab;
  }

  const RELAY_ALIVE_TYPES = new Set([
    'gc-relay-ready', 'gc-pong', 'gc-heartbeat', 'gc-model-ready', 'gc-response', 'gc-status', 'gc-chunk',
  ]);

  function resolveRelaySignalWaiters() {
    if (!isRelayAlive()) return;
    const waiters = relaySignalWaiters.splice(0);
    for (const w of waiters) w();
  }

  /** Wait until relay heartbeats arrive — tab open alone is not enough (e.g. mid sign-in). */
  function waitForRelaySignal(maxMs = 90000) {
    if (isRelayAlive()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const idx = relaySignalWaiters.indexOf(done);
        if (idx >= 0) relaySignalWaiters.splice(idx, 1);
        resolve();
      };
      relaySignalWaiters.push(done);
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        const idx = relaySignalWaiters.indexOf(done);
        if (idx >= 0) relaySignalWaiters.splice(idx, 1);
        reject(new Error('Timed out waiting for GoCaaS relay'));
      }, maxMs);
      pingGcTab();
    });
  }

  function waitForRelayAlive(maxMs = 90000) {
    if (isRelayAlive() && getRelayTab()) return Promise.resolve();
    return waitForRelaySignal(maxMs).then(() => {
      if (getRelayTab()) return;
      return waitForRelayHandle(maxMs);
    });
  }

  /** Wait for relay tab via cache restore or incoming heartbeats — never opens windows. */
  function waitForRelayHandle(maxMs = 15000, { allowNamedLookup = false } = {}) {
    const tryTab = () => getRelayTab() || restoreRelayTabRef(false)
      || (allowNamedLookup ? lookupNamedRelayTab() : null);
    const existing = tryTab();
    if (existing && isRelayAlive()) return Promise.resolve(existing);

    return new Promise((resolve, reject) => {
      let settled = false;
      let namedLookupDone = false;
      const finish = (tab) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearInterval(poll);
        window.removeEventListener('message', onMsg);
        const t = tab || getRelayTab() || restoreRelayTabRef(false);
        if (t) { gcTab = t; touchRelay(); resolve(t); }
        else reject(new Error('Lost GoCaaS tab handle — click Reconnect GoCaaS'));
      };
      const onMsg = (event) => {
        if (event.origin !== GC_ORIGIN) return;
        captureRelaySource(event);
        if (RELAY_ALIVE_TYPES.has(event.data?.type) && getRelayTab()) finish(getRelayTab());
      };
      const poll = setInterval(() => {
        const tab = getRelayTab() || restoreRelayTabRef(false);
        if (tab) finish(tab);
      }, 300);
      const timer = setTimeout(() => {
        if (allowNamedLookup && !namedLookupDone) {
          namedLookupDone = true;
          const named = lookupNamedRelayTab();
          if (named) { finish(named); return; }
        }
        finish(getRelayTab() || restoreRelayTabRef(false));
      }, maxMs);
      window.addEventListener('message', onMsg);
      if (getRelayTab()) pingGcTab();
    });
  }

  function ensureGcTab(modelId) {
    if (restoreCachedRelayTab()) return Promise.resolve();
    if (isRelayAlive() && getRelayTab()) return Promise.resolve();
    if (getRelayTab()) return waitForRelayAlive(18000);
    openGcTab(modelId);
    return waitForRelayAlive(90000);
  }

  function ensureRelayModel(modelId, { forceNavigate = false } = {}) {
    return waitForRelayHandle(20000).then((tab) => new Promise((resolve, reject) => {
      if (!forceNavigate && activeRelayModel === modelId && gcTabReady && isRelayAlive() && getRelayTab()) {
        resolve();
        return;
      }
      gcTab = tab;
      if (forceNavigate) activeRelayModel = null;
      postToRelay({ type: 'gc-switch-model', modelId });
      const timeout = setTimeout(() => {
        window.removeEventListener('message', onReady);
        reject(new Error('Timed out loading companion. Check the GoCaaS tab is logged in.'));
      }, 45000);
      const onReady = (event) => {
        if (event.origin !== GC_ORIGIN) return;
        captureRelaySource(event);
        if (event.data?.type === 'gc-model-ready' && event.data?.modelId === modelId) {
          clearTimeout(timeout);
          window.removeEventListener('message', onReady);
          activeRelayModel = modelId;
          touchRelay();
          resolve();
        }
      };
      window.addEventListener('message', onReady);
    }));
  }

  function sendToGcTab(modelId, messages, modelKind = 'companion', needsAuth = false, ticketId = '') {
    const reqId = ++activeRequestId;
    const resolvedTicketId = ticketId || currentTicket?.ticketId || '';
    const dispatch = () => waitForRelayHandle(8000)
      .catch(() => waitForRelayHandle(0, { allowNamedLookup: true }))
      .then((tab) => new Promise((resolve, reject) => {
      gcTab = tab;
      if (pendingResolve) pendingReject(new Error('Superseded by new request'));
      pendingResolve = (val) => { if (reqId !== activeRequestId) return; resolve(val); };
      pendingReject  = (err) => { if (reqId !== activeRequestId) return; reject(err); };
      clearTimeout(pendingTimer);
      pendingTimer = setTimeout(() => {
        if (reqId !== activeRequestId) return;
        pendingResolve = null; pendingReject = null;
        reject(new Error('No response from GoCaaS after 5 min'));
      }, 300000);
      postToRelay({
        type: 'gc-send', modelId, modelKind, needsAuth,
        ticketId: resolvedTicketId,
        messages: messages.map(m => ({ role: m.role, content: normalizeContent(m.content) })),
      });
    })).catch((err) => {
      if (err?.message?.includes('Lost GoCaaS tab handle')) {
        throw new Error(isRelayAlive()
          ? 'Reconnecting to GoCaaS — wait a moment and try again'
          : 'GoCaaS tab is not open. Click Connect GoCaaS first.');
      }
      throw err;
    });

    if (modelKind === 'companion') {
      activeRelayModel = modelId;
      return dispatch();
    }
    return dispatch();
  }

  function recordResponseDuration(modelId, ms) {
    if (!modelId || ms < 500) return;
    const arr = (sessionResponseDurations[modelId] || []).concat(Math.round(ms));
    sessionResponseDurations[modelId] = arr.slice(-SESSION_RESPONSE_SAMPLES);
  }

  function getModelExpectedSec(modelId) {
    const m = MODELS.find(x => x.id === modelId);
    return m?.expectedSec ?? DEFAULT_EXPECTED_SEC;
  }

  function isOAuthTimingStep(stepLabel) {
    return /authorize|authoris|oauth/i.test(stepLabel || timingStepLabel || '');
  }

  function medianMs(nums) {
    if (!nums.length) return null;
    const s = [...nums].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
  }

  function formatDurationSec(sec) {
    const s = Math.max(0, Math.round(sec));
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    const r = s % 60;
    return r ? `${m}m ${r}s` : `${m}m`;
  }

  function formatResponseDuration(ms) {
    if (!ms || ms < 500) return '';
    return formatDurationSec(Math.max(1, Math.round(ms / 1000)));
  }

  function formatMsgMeta(role, responseMs) {
    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    if (role !== 'assistant') return time;
    const duration = formatResponseDuration(responseMs);
    return duration ? `${time} · ${duration} response` : time;
  }

  function getExpectedResponseSec(modelId) {
    return getModelExpectedSec(modelId || timingModelId);
  }

  function formatTimingSuffix(modelId) {
    const elapsed = sendStartedAt ? Math.max(0, Math.round((Date.now() - sendStartedAt) / 1000)) : 0;
    let s = `${formatDurationSec(elapsed)} elapsed`;
    if (isOAuthTimingStep()) {
      s += ' · OAuth in progress (time varies)';
      return s;
    }
    const expected = getExpectedResponseSec(modelId);
    if (expected != null) {
      s += ` · ${formatDurationSec(expected)} or less`;
      if (elapsed > expected) s += ' (longer than usual)';
    }
    return s;
  }

  function updateResponseTimingUI(panel) {
    if (!sendStartedAt) return;
    const step = timingStepLabel || 'Working…';
    const timing = formatTimingSuffix();
    if (progressRef?.label) {
      const stepEl = progressRef.label.querySelector('.gc-progress-step');
      const timingEl = progressRef.label.querySelector('.gc-progress-timing');
      if (stepEl) stepEl.textContent = step;
      if (timingEl) timingEl.textContent = timing;
    }
    if (panel) {
      const shortStep = step.length > 36 ? `${step.slice(0, 36)}…` : step;
      setStatus(panel, 'loading', `⏳ ${shortStep} · ${timing}`);
    }
  }

  function stopResponseTiming() {
    clearInterval(timingTickIv);
    timingTickIv = null;
    if (sendStartedAt) lastResponseDurationMs = Date.now() - sendStartedAt;
    sendStartedAt = 0;
    timingModelId = null;
    timingStepLabel = 'Starting…';
  }

  function consumeResponseDurationMs() {
    const ms = lastResponseDurationMs || (sendStartedAt ? Date.now() - sendStartedAt : 0);
    lastResponseDurationMs = 0;
    return ms;
  }

  function startResponseTiming(panel, modelId) {
    stopResponseTiming();
    lastResponseDurationMs = 0;
    sendStartedAt = Date.now();
    timingModelId = modelId;
    timingStepLabel = 'Starting…';
    updateResponseTimingUI(panel);
    timingTickIv = setInterval(() => updateResponseTimingUI(panel), 1000);
  }

  function setTimingStep(label, panel) {
    if (!sendStartedAt) return;
    timingStepLabel = label || timingStepLabel;
    updateResponseTimingUI(panel || globalPanel);
  }

  function createResponseProgress(bubble) {
    bubble.innerHTML = `
      <div class="gc-progress">
        <div class="gc-progress-label">
          <span class="gc-progress-step">Starting…</span>
          <span class="gc-progress-timing"></span>
        </div>
        <div class="gc-progress-track"><div class="gc-progress-fill" style="width:6%"></div></div>
      </div>`;
    return {
      bubble,
      fill: bubble.querySelector('.gc-progress-fill'),
      label: bubble.querySelector('.gc-progress-label'),
      pct: 6,
      timer: null,
    };
  }

  function setResponseProgress(ref, pct, labelText) {
    if (!ref) return;
    ref.pct = Math.min(96, Math.max(ref.pct, pct));
    if (ref.fill) ref.fill.style.width = `${ref.pct}%`;
    if (labelText) setTimingStep(labelText, globalPanel);
  }

  function bumpResponseProgress(ref, delta, labelText) {
    if (!ref) return;
    setResponseProgress(ref, ref.pct + delta, labelText);
    if (labelText?.includes('Authorize in GoCaaS') && globalPanel) {
      const modelId = globalPanel.querySelector('#gc-model-sel')?.value;
      maybeShowOAuthInstructions(globalPanel, labelText, modelId, labelText);
    }
  }

  function startResponseProgressCreep(ref) {
    if (!ref) return;
    clearInterval(ref.timer);
    ref.timer = setInterval(() => {
      if (ref.pct < 40) setResponseProgress(ref, ref.pct + 2);
    }, 4000);
  }

  function stopResponseProgress() {
    stopResponseTiming();
    clearOAuthStuckWatch();
    if (!progressRef) return;
    clearInterval(progressRef.timer);
    progressRef = null;
  }

  function handleRelayMessage(data, event) {
    if (data?.origin === 'firewally-ticket') return;
    if (event?.origin && event.origin !== GC_ORIGIN && data?.origin !== 'firewally-relay') return;
    captureRelaySource(event);
    const { type, text, error, label, done } = data || {};

    if (RELAY_ALIVE_TYPES.has(type)) {
      touchRelay();
      resolveRelaySignalWaiters();
    }
    touchActivity();

    if (type === 'gc-pong') {
      onRelayAlive();
      return;
    }
    if (type === 'gc-relay-ready' || type === 'gc-heartbeat') {
      onRelayAlive();
      if (data.relayVersion) lastRelayVersion = String(data.relayVersion);
      return;
    }
    if (type === 'gc-model-ready') {
      activeRelayModel = data?.modelId || activeRelayModel;
      return;
    }

    if (type === 'gc-status' && globalPanel) {
      const modelId = globalPanel.querySelector('#gc-model-sel')?.value;
      const friendly = friendlyStatus(label, modelId);
      if (progressRef) {
        if (done) setResponseProgress(progressRef, 94, 'Finishing up…');
        else bumpResponseProgress(progressRef, 10, friendly);
      } else {
        setStatus(globalPanel, 'loading', done ? `${friendly} ✅` : `⏳ ${friendly}`);
      }
      if (!done) {
        maybeShowOAuthInstructions(globalPanel, label, modelId, friendly);
        if (isOAuthStatus(label) || friendly.includes('Authorize in GoCaaS') || friendly.includes('Authorising')) {
          oauthWaitActive = true;
        }
      } else if (isOAuthStatus(label) && (oauthWaitActive || globalPanel.querySelector('.gc-oauth-card'))) {
        notifyOAuthComplete(globalPanel);
      }
      return;
    }

    if (type === 'gc-chunk' && globalPanel) {
      const phase = data?.phase || 'stream';
      const friendly = phase === 'tool'
        ? '🔧 Tools active — companion is responding…'
        : '✍️ Companion is responding…';
      if (progressRef) {
        bumpResponseProgress(progressRef, phase === 'tool' ? 15 : 8, friendly);
      } else {
        setStatus(globalPanel, 'loading', `⏳ ${friendly}`);
      }
      return;
    }

    if (type === 'gc-response') {
      clearTimeout(pendingTimer);
      clearStuckWatch();
      if (progressRef) setResponseProgress(progressRef, 100, 'Done');
      stopResponseProgress();
      const r = pendingResolve; pendingResolve = null; pendingReject = null;
      if (r) r({
        text: text || '(empty response)',
        forms: data?.forms || [],
      });
      if (globalPanel) {
        const cancelBtn = globalPanel.querySelector('#gc-cancel-btn');
        if (cancelBtn) cancelBtn.hidden = true;
      }
      return;
    }
    if (type === 'gc-error') {
      clearTimeout(pendingTimer);
      clearStuckWatch();
      stopResponseProgress();
      const rj = pendingReject; pendingResolve = null; pendingReject = null;
      if (globalPanel) {
        const cancelBtn = globalPanel.querySelector('#gc-cancel-btn');
        if (cancelBtn) cancelBtn.hidden = true;
      }
      if (rj) rj(new Error(error || 'Unknown error from GoCaaS tab'));
      return;
    }
  }

  function onRelayMessageEvent(event) {
    if (event.origin !== GC_ORIGIN) return;
    handleRelayMessage(event.data || {}, event);
  }

  window.addEventListener('message', onRelayMessageEvent);
  try { if (window.top !== window) window.top.addEventListener('message', onRelayMessageEvent); } catch (_) {}

  relayBC?.addEventListener('message', (event) => {
    handleRelayMessage(event.data || {}, null);
  });

  function friendlyStatus(raw, modelId) {
    const s = (raw || '').toLowerCase();
    const showOAuth = !modelId || companionNeedsAuth(modelId);
    if (s.includes('oauth') && showOAuth && s.includes('progress')) {
      const seconds = raw.match(/waited (\d+)s/)?.[1];
      if (seconds && parseInt(seconds) >= 9) {
        return `🔐 Authorize in GoCaaS tab (${seconds}s elapsed)`;
      }
      return '🔐 Authorising with Atlassian…';
    }
    if (s.includes('oauth') && showOAuth) return '🔐 Authorising with Atlassian…';
    if (s.includes('oauth'))              return 'Working…';
    if (s.includes('knowledge'))      return '📚 Searching knowledge base…';
    if (s.includes('sources'))        return '📎 Retrieving sources…';
    if (s.includes('queries'))        return '🔍 Generating queries…';
    if (s.includes('web_search') || s.includes('web search')) return '🌐 Searching the web…';
    if (s.includes('tool'))           return '🔧 Running tool…';
    if (s.includes('code'))           return '💻 Running code…';
    if (s.includes('memory'))         return '🧠 Accessing memory…';
    return raw && raw.length > 50 ? raw.slice(0, 50) + '…' : (raw || 'Working…');
  }

  function stopReconnectCountdown() {
    clearInterval(reconnectCountdownIv);
    reconnectCountdownIv = null;
  }

  function startReconnectCountdown(panel, prefix = 'Reconnecting to GoCaaS') {
    stopReconnectCountdown();
    reconnectFailed = false;
    const status = panel?.querySelector('#gc-conn-status');
    const btn = panel?.querySelector('#gc-connect-btn');
    const bar = panel?.querySelector('#gc-connect-bar');
    bar?.classList.remove('gc-connect-compact');
    if (btn) { btn.hidden = false; btn.textContent = '🔗 Reconnect GoCaaS'; }
    const deadline = Date.now() + RECONNECT_COUNTDOWN_SEC * 1000;
    const tick = () => {
      const left = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      if (status) {
        status.textContent = left > 0
          ? `● ${prefix}… ${left}s`
          : '● Reconnect timed out — click Reconnect GoCaaS above';
        status.className = left > 0 ? 'gc-conn-status connecting' : 'gc-conn-status';
      }
      if (left <= 0) {
        stopReconnectCountdown();
        reconnectFailed = true;
      }
    };
    tick();
    reconnectCountdownIv = setInterval(tick, 250);
  }

  function waitForRelayWithCountdown(panel, maxMs, prefix) {
    const tab = restoreCachedRelayTab();
    if (tab) {
      pingGcTab();
      touchRelay();
      reconnectFailed = false;
      return Promise.resolve(tab);
    }
    startReconnectCountdown(panel, prefix);
    return waitForRelayHandle(maxMs, { allowNamedLookup: false })
      .then((tab) => {
        stopReconnectCountdown();
        reconnectFailed = false;
        return tab;
      })
      .catch((err) => {
        stopReconnectCountdown();
        throw err;
      });
  }

  let globalPanel = null;

  function syncConnectUI() {
    if (!globalPanel) return;
    if (isApiKeyMode()) {
      stopReconnectCountdown();
      const bar = globalPanel.querySelector('#gc-connect-bar');
      if (bar) bar.style.display = 'none';
      const dot = document.querySelector('#gc-launcher .gc-indicator');
      if (isApiKeyReady()) {
        if (dot) dot.className = 'gc-indicator gc-connected';
        const statusText = globalPanel.querySelector('#gc-status-text');
        if (statusText && !busy && statusText.textContent.includes('Connect GoCaaS')) {
          setStatus(globalPanel, 'ready', '✅ API key configured — ready to send');
        }
      } else if (dot) {
        dot.className = 'gc-indicator gc-dot';
      }
      return;
    }
    const bar = globalPanel.querySelector('#gc-connect-bar');
    if (bar) bar.style.display = '';
    if (pendingConnectPanel) {
      bar?.classList.remove('gc-connect-compact');
      const status = globalPanel.querySelector('#gc-conn-status');
      const btn = globalPanel.querySelector('#gc-connect-btn');
      if (status) {
        status.textContent = '● Waiting for GoCaaS sign-in…';
        status.className = 'gc-conn-status connecting';
      }
      if (btn) { btn.textContent = '⏳ Connecting…'; btn.className = ''; btn.hidden = false; }
      return;
    }
    if (isRelayReady()) {
      stopReconnectCountdown();
      reconnectFailed = false;
      updateConnectUI(true);
    } else if (isGoCaaSLinked()) {
      gcTabReady = false;
      bar?.classList.remove('gc-connect-compact');
      if (reconnectFailed) {
        updateConnectUI(false, '● Reconnect timed out — click Reconnect GoCaaS above');
        return;
      }
      if (reconnectCountdownIv) return;
      if (companionSwitchId) {
        const m = MODELS.find(x => x.id === companionSwitchId);
        updateConnectUI(false, `● Switching to ${m?.name || 'companion'}…`);
      } else if (silentReconnecting) {
        return;
      } else if (getRelayTab() || restoreRelayTabRef(false) || isRelayAlive()) {
        if (globalPanel && !silentReconnecting && !companionSwitchId) {
          silentReconnect(globalPanel);
        }
      } else {
        markConnected(false);
        updateConnectUI(false, '● Click Connect GoCaaS to get started');
      }
    }
  }

  function updateConnectUI(connected, label) {
    if (!globalPanel) return;
    const bar    = globalPanel.querySelector('#gc-connect-bar');
    const btn    = globalPanel.querySelector('#gc-connect-btn');
    const status = globalPanel.querySelector('#gc-conn-status');
    const dot    = document.querySelector('#gc-launcher .gc-indicator');
    if (!btn || !status) return;
    if (connected) {
      stopReconnectCountdown();
      reconnectFailed = false;
      bar?.classList.add('gc-connect-compact');
      btn.hidden = true;
      status.textContent = '● GoCaaS connected';
      status.className = 'gc-conn-status connected';
      status.title = 'GoCaaS relay is active — use ⤢ in header to open tab';
      if (dot) dot.className = 'gc-indicator gc-connected';
    } else {
      bar?.classList.remove('gc-connect-compact');
      btn.hidden = false;
      btn.textContent = '🔗 Reconnect GoCaaS';
      btn.className = '';
      status.textContent = label || '● Disconnected';
      status.className = 'gc-conn-status';
      status.title = '';
      if (dot) dot.className = 'gc-indicator gc-dot';
    }
  }

  setInterval(() => {
    if (isApiKeyMode() || autoConnected || pendingConnectPanel) syncConnectUI();
  }, 5000);

  /* ════════════════════════════════════════
     ATLASSIAN AUTH (per-companion + lazy detect)
     needsAuth on each companion — set false to skip
     the authorize step. OAuth errors on send still
     trigger auth for any companion as a fallback.
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
    const model = getSelectedModel(panel);
    setStatus(panel, 'loading', busy
      ? `✅ Authorized — ${model?.name || 'companion'} working…`
      : '✅ Atlassian authorized — ready');
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

  function authCompanionModel(panel) {
    const model = getSelectedModel(panel);
    if (model?.kind === 'companion' && companionNeedsAuth(model.id)) return model;
    return MODELS.find(m => m.id === WARMUP_MODEL) || model;
  }

  function warmUpCompanion(panel) {
    if (isApiKeyMode()) {
      if (!isApiKeyReady()) {
        toast('⚠️ Add your GoCaaS API key in Settings first');
        return;
      }
      const authModel = authCompanionModel(panel);
      setStatus(panel, 'loading', '🔐 Checking Atlassian tools…');
      sendViaApiKey(authModel.id, [{ role: 'user', content: 'authorize' }], 'companion', true, '')
        .then(() => {
          notifyOAuthComplete(panel);
          setStatus(panel, 'ready', '✅ Ready — Atlassian authorised');
        })
        .catch(err => {
          const msg = (err?.message || '').toLowerCase();
          if (isAuthError(msg)) {
            setStatus(panel, 'loading', '🔐 Atlassian authorisation required — see instructions below');
            showOAuthInstructions(panel);
          } else {
            setStatus(panel, 'ready', 'Connected — select a companion and start');
          }
        });
      return;
    }
    if (!isRelayAlive()) return;
    const authModel = authCompanionModel(panel);
    setStatus(panel, 'loading', '🔐 Authorising Atlassian tools…');

    sendToGcTab(authModel.id, [{ role: 'user', content: 'authorize' }], 'companion', true, '')
      .then(() => {
        notifyOAuthComplete(panel);
        setStatus(panel, 'ready', '✅ Ready — Atlassian authorised');
      })
      .catch(err => {
        const msg = (err?.message || '').toLowerCase();
        if (isAuthError(msg)) {
          setStatus(panel, 'loading', '🔐 Atlassian authorisation required — see instructions below');
          showOAuthInstructions(panel);
          setTimeout(() => warmUpCompanion(panel), 40000);
        } else {
          setStatus(panel, 'ready', 'Connected — select a companion and start');
        }
      });
  }

  async function finishConnect(panel) {
    const modelId = panel.querySelector('#gc-model-sel').value;
    const model = MODELS.find(m => m.id === modelId) || MODELS[0];

    if (model.kind === 'companion') {
      setStatus(panel, 'loading', `Loading ${model.name}…`);
      await ensureRelayModel(modelId, { forceNavigate: true });
      activeRelayModel = modelId;
    }

    if (model.kind === 'companion' && companionNeedsAuth(modelId) && !isAtlassianAuthorized()) {
      warmUpCompanion(panel);
    } else {
      panel.querySelector('.gc-oauth-card')?.remove();
      setStatus(panel, 'ready', '✅ Connected — ready');
      syncConnectUI();
      toast(`✅ GoCaaS connected!${model.kind === 'companion' ? ` (${model.name})` : ''}`, 3000);
    }
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
      if (!step.includes('Authorize in GoCaaS') && !step.includes('Authorising')) return;
      oauthPromptShownForRequest = false;
      GM_setValue(STORE_ATLASSIAN, 'false');
      maybeShowOAuthInstructions(panel, step, modelId, step);
      toast('🔐 Authorization still pending — follow the steps in chat', 6000);
    }, 12000);
  }

  function maybeShowOAuthInstructions(panel, label, modelId, friendlyHint) {
    if (!panel) return;
    const mid = modelId || panel.querySelector('#gc-model-sel')?.value;
    if (!mid || !companionNeedsAuth(mid)) return;

    const friendly = friendlyHint || friendlyStatus(label || '', mid);
    const s = (label || '').toLowerCase();
    const isOAuthWait = friendly.includes('Authorize in GoCaaS')
      || friendly.includes('Authorising with Atlassian')
      || s.includes('oauth') || s.includes('atlassian') || s.includes('authoris');

    if (!isOAuthWait) return;

    const seconds = parseInt((label || '').match(/(\d+)\s*s(?:ec)?/i)?.[1] || '0', 10);
    const readyToPrompt = friendly.includes('Authorize in GoCaaS')
      || seconds >= 3
      || s.includes('progress')
      || s.includes('wait')
      || s.includes('authoris');

    if (!readyToPrompt) return;
    if (oauthPromptShownForRequest) return;

    // Server is waiting on OAuth — local "already authorised" flag may be stale (e.g. after cookie clear).
    if (friendly.includes('Authorize in GoCaaS') || seconds >= 3) {
      GM_setValue(STORE_ATLASSIAN, 'false');
    }

    oauthPromptShownForRequest = true;
    showOAuthInstructions(panel);
    setStatus(panel, 'loading', '🔐 Atlassian authorisation required — see instructions below');
  }

  function promptAuthIfNeeded(panel) {
    if (isAtlassianAuthorized()) return false;
    oauthPromptShownForRequest = true;
    setStatus(panel, 'loading', '🔐 Atlassian authorisation required');
    showOAuthInstructions(panel);
    warmUpCompanion(panel);
    return true;
  }

  function showOAuthInstructions(panel) {
    const msgs = panel.querySelector('#gc-messages');
    const authModel = authCompanionModel(panel);
    const companionName = authModel?.name || 'this companion';
    const apiMode = isApiKeyMode();
    panel.querySelector('.gc-oauth-card')?.remove();
    const wrap = document.createElement('div');
    wrap.className = 'gc-msg system-msg gc-oauth-card';
    wrap.innerHTML = `
      <div class="gc-bubble gc-oauth-bubble">
        <div class="gc-oauth-title">🔐 Atlassian Authorisation Required</div>
        <div class="gc-oauth-body">
          Some companions use Atlassian tools and need a one-time authorisation.<br>
          ${apiMode
            ? `Open <strong>GoCaaS</strong> in your browser and use the <strong>${companionName.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</strong> companion for this step.<br>
          Complete these steps <strong>on the GoCaaS website</strong>:`
            : `Use the <strong>${companionName.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</strong> companion in the GoCaaS tab for this step.<br>
          Complete these steps <strong>in the GoCaaS tab</strong>:`}
        </div>
        <div class="gc-oauth-steps">
          <div class="gc-oauth-step">
            <span class="gc-oauth-num">1</span>
            <span>Type <strong class="gc-oauth-code">authorize</strong> in the chat and press <strong>Enter</strong></span>
          </div>
          <div class="gc-oauth-step">
            <span class="gc-oauth-num">2</span>
            <span>Log in to <strong>Atlassian</strong> when the login page appears</span>
          </div>
          <div class="gc-oauth-step">
            <span class="gc-oauth-num">3</span>
            <span>In the <em>"Use app on:"</em> dropdown, select <strong class="gc-oauth-domain">godaddy-corp.atlassian.net</strong></span>
          </div>
          <div class="gc-oauth-step">
            <span class="gc-oauth-num">4</span>
            <span>Click <strong class="gc-oauth-authorize">Authorize</strong> at the bottom of the page</span>
          </div>
        </div>
        <div class="gc-oauth-note">One-time setup — once authorised, all companions work (502, AI Crawler, WAF, SSL, Backup, Provisioning Failure, Monitoring/Alerts, Ticket Response, Hosting).</div>
        <button class="gc-oauth-focus-btn" id="gc-oauth-open-btn">
          👁 ${apiMode ? 'Open GoCaaS website' : 'Switch to GoCaaS tab'}
        </button>
      </div>`;
    if (!apiMode) window.__fw_tab = gcTab;
    msgs.appendChild(wrap);
    wrap.querySelector('#gc-oauth-open-btn')?.addEventListener('click', () => {
      if (apiMode) {
        window.open(`${OWUI}/?model=${encodeURIComponent(authModel?.id || WARMUP_MODEL)}`, '_blank');
      } else {
        try { if (gcTab && !gcTab.closed) gcTab.focus(); } catch (_) {}
      }
    });
    msgs.scrollTop = msgs.scrollHeight;
    toast(apiMode
      ? '🔐 Authorization needed — complete steps on the GoCaaS website'
      : '🔐 Authorization needed — switch to the GoCaaS tab using the button below', 6000);
  }

  /* ════════════════════════════════════════
     TICKET SCRAPER
  ════════════════════════════════════════ */
  const pageWindow = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;

  function readTicketData() {
    try {
      const raw = pageWindow.ticketData;
      if (!raw) return null;
      if (typeof raw === 'object') return raw;
      if (typeof raw === 'string' && raw.length > 10) return JSON.parse(raw);
    } catch (e) { console.warn('[FireWally]', e.message); }
    return null;
  }

  function formatTicketTags(tags) {
    if (!tags) return '';
    if (typeof tags === 'string') return tags.trim();
    if (!Array.isArray(tags)) return String(tags).trim();
    return tags.map(t => {
      if (t == null) return '';
      if (typeof t === 'string') return t.trim();
      if (typeof t === 'object' && t.title) return String(t.title).trim();
      return String(t).trim();
    }).filter(Boolean).join(', ');
  }

  function parseTicket(d) {
    if (!d || typeof d !== 'object') return null;
    const si = d.site_info || {};
    const sp = [];
    const rawStatus = (d.raw_status || d.status || '').trim();
    const isRealStatus = rawStatus &&
      !rawStatus.includes('@') &&
      !/^[a-z0-9._%+-]+@/.test(rawStatus) &&
      rawStatus.length < 60;
    if (isRealStatus) sp.push(rawStatus);
    if (d.queue)                    sp.push(`Queue: ${d.queue}`);
    if (d.sla_type)                 sp.push(`SLA: ${d.sla_type}`);
    if (d.sla_remaining_time_human) sp.push(`SLA remaining: ${d.sla_remaining_time_human}`);
    const notes = typeof d.notes==='string' ? d.notes.replace(/\\n/g,'\n').trim() : '';
    const transcript = (d.responses||[]).map(r => {
      const who  = r.display_name||r.email||'Unknown';
      const when = r.created_at
        ? new Date(parseInt(r.created_at)*1000).toISOString().replace('T',' ').slice(0,16)+' UTC' : '';
      const msg  = typeof r.message==='string' ? r.message.replace(/\\n/g,'\n').trim() : '';
      const sts  = (r.status||[]).length ? `\n  → Status: ${r.status.join(', ')}` : '';
      return `[${when}] ${who}:\n${msg}${sts}`;
    }).join('\n\n---\n\n');
    const description = typeof d.description==='string' ? d.description.replace(/\\n/g,'\n').trim() : '';
    return {
      ticketId:d.email_id||'', title:d.subject||'', status:sp.join(' | '),
      queue:d.queue||'',
      customerEmail:d.email||'', tags:formatTicketTags(d.tags),
      assignments:(d.assignments||[]).join(', '),
      siteId:si.site||'', hostingIp:si.hosting_ip||'', firewallIp:si.firewall_ip||'',
      firewallActive:typeof si.firewall_active==='boolean'?(si.firewall_active?'Yes':'No'):'',
      customerIp:d.customer_ip||'', notes, transcript, description,
      url:window.location.href, source:'ticketData',
    };
  }

  function scrapeDOM() {
    const get = sels => { for(const s of sels){try{const el=document.querySelector(s);if(el?.innerText?.trim())return el.innerText.trim().substring(0,1500);}catch(_){}}return''; };
    const hv  = id => document.getElementById(id)?.value||'';
    const hostingIp=(()=>{for(const li of document.querySelectorAll('.fieldset li')){const lbl=li.querySelector('span');if(lbl?.innerText?.includes('Hosting IP'))return li.innerText.replace('Hosting IP:','').trim();}return'';})();
    const replyEls=document.querySelectorAll('.ticket__response__message');
    const replyHdrs=document.querySelectorAll('.ticket__response h4');
    let transcript='';
    replyEls.forEach((el,i)=>{const hdr=replyHdrs[i]?.innerText?.trim()||'';const msg=el.innerText.trim();if(msg)transcript+=(hdr?`${hdr}:\n`:'')+msg+'\n\n---\n\n';});
    return {
      ticketId:hv('current-ticket-id'), title:get(['.box__heading','h2','h1']),
      status:get(['.fieldset h3']), queue:'',
      customerEmail:hv('ticket-account'),
      tags:[...document.querySelectorAll('.tag__find-tickets')].map(e=>e.innerText.trim()).join(', '),
      assignments:'', siteId:hv('ticket-site'), hostingIp,
      firewallIp:'', firewallActive:'', customerIp:'',
      notes:document.querySelector('.ticket__notes textarea')?.value?.trim()||'',
      transcript:transcript.trim(), description:'', url:window.location.href, source:'dom',
    };
  }

  function getTicket() {
    const d = readTicketData();
    if (d) {
      try {
        const t = parseTicket(d);
        if (t) return t;
      } catch (e) {
        console.warn('[FireWally] parseTicket failed, using DOM fallback:', e.message);
      }
    }
    return scrapeDOM();
  }

  function buildContext(t) {
    if(!t)return'';
    const L=[];
    if(t.ticketId)      L.push(`**Ticket ID:** ${t.ticketId}`);
    if(t.title)         L.push(`**Subject:** ${t.title}`);
    if(t.status&&t.status!==t.ticketId) L.push(`**Status:** ${t.status}`);
    if(t.customerEmail) L.push(`**Customer Email:** ${t.customerEmail}`);
    if(t.tags)          L.push(`**Tags:** ${t.tags}`);
    if(t.assignments)   L.push(`**Assigned to:** ${t.assignments}`);
    if(t.url)           L.push(`**URL:** ${t.url}`);
    if(t.siteId||t.hostingIp||t.firewallIp||t.customerIp){
      L.push('');L.push('**Site & Infrastructure:**');
      if(t.siteId)         L.push(`  - Site: ${t.siteId}`);
      if(t.hostingIp)      L.push(`  - Hosting IP: ${t.hostingIp}`);
      if(t.firewallIp)     L.push(`  - Firewall IP: ${t.firewallIp}`);
      if(t.firewallActive) L.push(`  - Firewall Active: ${t.firewallActive}`);
      if(t.customerIp)     L.push(`  - Client IP: ${t.customerIp}`);
    }
    if(t.notes)       {L.push('');L.push('**Internal Notes:**');              L.push(t.notes.substring(0,2000));}
    if(t.description) {L.push('');L.push('**Original Ticket Description:**'); L.push(t.description.substring(0,3000));}
    if(t.transcript)  {L.push('');L.push('**Conversation Transcript:**');     L.push(t.transcript);}
    return L.join('\n').trim();
  }

  /* ════════════════════════════════════════
     PLAIN TEXT / CUSTOMER REPLY
     Smart extraction: find customer-facing start,
     cut at internal sections, fall back to email heuristics.
  ════════════════════════════════════════ */
  function normalizeContent(content) {
    if (content == null) return '';
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content.map(p => {
        if (typeof p === 'string') return p;
        if (p?.type === 'text') return p.text || '';
        return '';
      }).filter(Boolean).join('\n');
    }
    return String(content);
  }

  function escHtml(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }
  function escAttr(s) {
    return String(s).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/'/g,'&#39;').replace(/</g,'&lt;');
  }

  function collectUrls(fragment) {
    const urls = new Set();
    if (!fragment) return urls;
    for (const m of fragment.matchAll(/https?:\/\/[^\s<>"')\]]+/g)) urls.add(m[0].replace(/[.,;:!?)]+$/, ''));
    for (const m of fragment.matchAll(/href=["'](https?:\/\/[^"']+)["']/gi)) urls.add(m[1]);
    return urls;
  }

  function isInternalToolDetails(attrs, summary) {
    const a = attrs || '';
    const s = summary || '';
    if (/type=["']tool_calls["']/i.test(a)) return true;
    if (/name=["']request_user_input["']/i.test(a)) return true;
    if (/Tool Executed/i.test(s)) return true;
    if (/^(Calling|Running|Executed)\s+(tool|function)/i.test(s)) return true;
    return false;
  }

  function stripToolExecutedArtifacts(text) {
    if (!text) return text;
    return text
      .replace(/\n*\*{0,2}Tool Executed\*{0,2}\s*\n+"[\s\S]*?"\s*/gi, '\n')
      .replace(/\n*\*{0,2}Tool Executed\*{0,2}\s*\n+\{[\s\S]*?\}\s*/gi, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function replaceDetailsPreservingUrls(text) {
    if (!text) return text;
    return text.replace(/<details([^>]*)>([\s\S]*?)<\/details>/gi, (match, attrs, inner) => {
      const summary = inner.match(/<summary[^>]*>([\s\S]*?)<\/summary>/i)?.[1]?.replace(/<[^>]+>/g, '').trim() || '';
      if (isInternalToolDetails(attrs, summary)) return '';

      let body = inner.replace(/<summary[^>]*>[\s\S]*?<\/summary>/gi, '');
      body = body.replace(/<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
        (m, href, label) => `[${label.replace(/<[^>]+>/g, '').trim() || href}](${href})`);
      const urls = collectUrls(body);
      body = convertHtmlListsToMarkdown(body);
      body = body.replace(/<[^>]+>/g, '\n').replace(/[ \t]+/g, ' ').replace(/\n{2,}/g, '\n').trim();
      for (const url of urls) { if (!body.includes(url)) body += (body ? '\n' : '') + url; }
      const parts = [];
      if (summary) parts.push(`**${summary}**`);
      if (body) parts.push(body);
      return parts.length ? `\n${parts.join('\n')}\n` : '';
    }).replace(/<\/?(?:details|summary)[^>]*>/gi, '');
  }

  function toPlainText(text) {
    if (!text) return '';
    let t = replaceDetailsPreservingUrls(String(text))
      .replace(/<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href, label) => {
        const lt = label.replace(/<[^>]+>/g, '').trim();
        return lt && lt !== href ? `${lt} (${href})` : href;
      })
      .replace(/<(https?:\/\/[^>\s]+)>/g, '$1')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>\s*<p[^>]*>/gi, '\n\n');
    t = convertHtmlListsToMarkdown(t);
    t = t
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&#39;/g, "'")
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));

    t = t
      .replace(/```[\w]*\n?([\s\S]*?)```/g, '$1')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/\*\*(.+?)\*\*/g, '$1')
      .replace(/__(.+?)__/g, '$1')
      .replace(/\*(.+?)\*/g, '$1')
      .replace(/_(.+?)_/g, '$1')
      .replace(/^>\s?/gm, '')
      .replace(/^#{1,6}\s+/gm, '')
      .replace(/^\s*[-*+]\s+/gm, '• ')
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)')
      .replace(/[ \t]+\n/g, '\n');

    return t.replace(/\n{3,}/g, '\n\n').trim();
  }

  const CUSTOMER_START_PATTERNS = [
    /(?:^|\n)\s*(?:#{1,6}\s*|\*{0,2}|[_~]{0,2}|[📝✉️📧]*\s*)?(?:recommended\s+)?customer[- ]facing(?:\s+(?:response|reply|summary|email))?[^\n]{0,60}/i,
    /(?:^|\n)\s*(?:#{1,6}\s*|\*{0,2})?(?:suggested|draft|proposed|recommended)\s+(?:customer[- ]facing\s+)?(?:customer\s+)?(?:reply|response|email|message)[^\n]{0,40}/i,
    /(?:^|\n)\s*(?:#{1,6}\s*|\*{0,2})?(?:reply|response|email)\s+to\s+(?:the\s+)?customer[^\n]{0,40}/i,
    /(?:^|\n)\s*(?:#{1,6}\s*|\*{0,2})?(?:customer\s+)?(?:email\s+)?(?:draft|reply|response)\s*:?\s*$/im,
    /(?:^|\n)\s*(?:#{1,6}\s*|\*{0,2})?here(?:'| i)?s\s+(?:a\s+)?(?:suggested\s+)?(?:customer\s+)?(?:facing\s+)?(?:reply|response|email)[^\n]{0,40}/i,
  ];

  const CUSTOMER_END_PATTERNS = [
    /(?:^|\n)\s*(?:#{1,6}\s*|\*{0,2}|[_~]{0,2})*internal\s+notes?\b[^\n]*/i,
    /(?:^|\n)\s*(?:#{1,6}\s*|\*{0,2})*no\s+escalation\b[^\n]*/i,
    /(?:^|\n)\s*(?:#{1,6}\s*|\*{0,2})*(?:agent[\s-]only|for\s+(?:the\s+)?agent|analyst\s+notes?)\b[^\n]*/i,
    /(?:^|\n)\s*(?:#{1,6}\s*|\*{0,2})*(?:ticket\s+analysis|technical\s+analysis|root\s+cause|workflow\s+steps?|key\s+findings?|evidence\s+from|primary\s+cause|investigation\s+notes?|troubleshooting\s+(?:steps|notes?)|backend\s+details?)\b[^\n]*/i,
    /(?:^|\n)\s*(?:#{1,6}\s*|\*{0,2})*(?:recommended\s+actions|next\s+steps\s+\(internal\)|resolution\s+summary)\b[^\n]*/i,
    /(?:^|\n)\s*-{3,}\s*(?:\n|$)/,
  ];

  const INTERNAL_ONLY_HINTS = [
    /this response follows the appropriate protocols/i,
    /client confirmed/i,
    /advised client to contact/i,
    /waf deactivated per client/i,
    /no escalation needed/i,
    /assign(?:ed)? to/i,
  ];

  function findEarliestMatch(text, patterns) {
    let best = null;
    for (const re of patterns) {
      const m = text.match(re);
      if (!m) continue;
      const idx = text.indexOf(m[0]);
      if (idx < 0) continue;
      if (!best || idx < best.index) best = { index: idx, length: m[0].length, text: m[0] };
    }
    return best;
  }

  function trimCustomerSlice(slice) {
    const end = findEarliestMatch(slice, CUSTOMER_END_PATTERNS);
    if (end) slice = slice.slice(0, end.index);
    return slice.replace(/^\s*[:\-–—]+\s*/, '').replace(/\n{3,}/g, '\n\n').trim();
  }

  function looksLikeCustomerEmail(text) {
    if (!text || text.length < 40) return false;
    const hasGreeting = /(?:^|\n)\s*(?:hi|hello|dear|good\s+(?:morning|afternoon|evening))\b/i.test(text);
    const hasSubject = /(?:^|\n)\s*subject\s*:/i.test(text);
    const hasSignoff = /(?:^|\n)\s*(?:thanks|thank you|best regards|kind regards|sincerely|regards)\b/i.test(text);
    const hasQuestions = /please let us know if you have any questions/i.test(text);
    const bulletHeavy = (text.match(/^\s*[•\-*]\s+/gm) || []).length >= 3
      && (text.match(/^\s*[•\-*]\s+/gm) || []).length > text.split(/\n+/).length * 0.5;
    if (bulletHeavy && !hasGreeting && !hasSubject) return false;
    return hasSubject || (hasGreeting && (hasSignoff || hasQuestions || text.length > 120));
  }

  function looksLikeInternalOnly(text) {
    if (!text) return true;
    if (looksLikeCustomerEmail(text)) return false;
    const lines = text.split(/\n/).map(l => l.trim()).filter(Boolean);
    const bulletLines = lines.filter(l => /^[•\-*]\s+/.test(l) || /^\d+\.\s+/.test(l));
    const internalHits = INTERNAL_ONLY_HINTS.filter(re => re.test(text)).length;
    if (bulletLines.length >= 3 && bulletLines.length >= lines.length * 0.6 && !/(?:^|\n)\s*(?:hi|hello|dear)\b/i.test(text)) {
      return true;
    }
    if (internalHits >= 2 && !/(?:^|\n)\s*(?:hi|hello|dear|subject\s*:)/i.test(text)) return true;
    return false;
  }

  function extractEmailHeuristic(plain) {
    // Prefer content starting at Subject: ...
    const subjectMatch = plain.match(/(?:^|\n)\s*(subject\s*:[^\n]*)/i);
    if (subjectMatch) {
      const start = plain.indexOf(subjectMatch[1]);
      const slice = trimCustomerSlice(plain.slice(start).trim());
      if (looksLikeCustomerEmail(slice)) return slice;
    }

    // Or from a greeting line to internal end
    const greetMatch = plain.match(/(?:^|\n)\s*((?:hi|hello|dear|good\s+(?:morning|afternoon|evening))[^\n]*)/i);
    if (greetMatch) {
      const start = plain.indexOf(greetMatch[1]);
      const slice = trimCustomerSlice(plain.slice(start).trim());
      if (looksLikeCustomerEmail(slice)) return slice;
    }

    // Split on Internal Note and take the part before if it looks like email
    const splitInternal = plain.split(/(?:^|\n)\s*(?:#{1,6}\s*|\*{0,2})*internal\s+notes?\b/i);
    if (splitInternal.length > 1) {
      const before = splitInternal[0].trim();
      const fromSubject = before.match(/(subject\s*:[\s\S]+)/i);
      const fromGreet = before.match(/((?:hi|hello|dear|good\s+(?:morning|afternoon|evening))\b[\s\S]+)/i);
      const candidate = (fromSubject && fromSubject[1]) || (fromGreet && fromGreet[1]) || before;
      const slice = trimCustomerSlice(candidate.trim());
      if (looksLikeCustomerEmail(slice)) return slice;
    }

    return '';
  }

  function extractCustomerReply(text) {
    const plain = toPlainText(text);
    if (!plain) return '';

    // 1) Explicit customer-facing / suggested-reply headings
    const start = findEarliestMatch(plain, CUSTOMER_START_PATTERNS);
    if (start) {
      const after = plain.slice(start.index + start.length);
      const trimmed = trimCustomerSlice(after);
      if (trimmed && !looksLikeInternalOnly(trimmed)) return trimmed;
      if (trimmed && looksLikeCustomerEmail(trimmed)) return trimmed;
    }

    // 2) Email-shaped body (Subject: / Hi …) cut before Internal Note
    const heuristic = extractEmailHeuristic(plain);
    if (heuristic) return heuristic;

    // 3) Whole message is already a short customer email (no internal sections)
    if (looksLikeCustomerEmail(plain) && !looksLikeInternalOnly(plain)) {
      const trimmed = trimCustomerSlice(plain);
      if (trimmed) return trimmed;
    }

    return '';
  }

  function copyText(text) {
    if (navigator.clipboard?.writeText) {
      return navigator.clipboard.writeText(text);
    }
    return new Promise((resolve, reject) => {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.cssText = 'position:fixed;left:-9999px;top:0';
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        resolve();
      } catch (e) { reject(e); }
    });
  }

  function copyCustomerReply(rawText, btn) {
    const plain = extractCustomerReply(rawText);
    if (!plain) {
      toast('⚠️ No customer reply found — companion output looks internal-only', 4000);
      return;
    }
    copyText(plain)
      .then(() => {
        toast('📋 Customer reply copied (plain text)', 2500);
        if (btn) {
          const prev = btn.textContent;
          btn.textContent = '✅ Copied!';
          setTimeout(() => { btn.textContent = prev; }, 2000);
        }
      })
      .catch(() => toast('❌ Copy failed — try selecting text manually', 4000));
  }

  function copyFullResponse(rawText, btn) {
    const plain = toPlainText(rawText).trim();
    if (!plain) {
      toast('⚠️ Nothing to copy', 3000);
      return;
    }
    copyText(plain)
      .then(() => {
        toast('📋 Response copied', 2500);
        if (btn) {
          const prev = btn.textContent;
          btn.textContent = '✅ Copied!';
          setTimeout(() => { btn.textContent = prev; }, 2000);
        }
      })
      .catch(() => toast('❌ Copy failed — try selecting text manually', 4000));
  }

  function fwExtractFirstCodeBlock(text) {
    if (!text || typeof text !== 'string') return null;
    const m = text.match(/```(?:\w+)?\s*\n?([\s\S]*?)```/);
    if (m && m[1] != null) return String(m[1]).trim();
    return null;
  }

  function fwScrollTicketNewReplyIntoView(textarea) {
    if (!textarea || !textarea.scrollIntoView) return;
    const run = (behavior) => {
      try {
        textarea.scrollIntoView({ block: 'center', inline: 'nearest', behavior: behavior || 'smooth' });
      } catch (_) {
        try { textarea.scrollIntoView(true); } catch (_2) {}
      }
    };
    run('smooth');
    requestAnimationFrame(() => requestAnimationFrame(() => run('smooth')));
    [100, 280, 550, 1100].forEach((ms) => {
      setTimeout(() => run(ms >= 550 ? 'auto' : 'smooth'), ms);
    });
  }

  function fwInsertIntoCustomerReply(text) {
    const textarea = document.querySelector('textarea.ticket__response__new-message');
    if (!textarea) {
      toast('⚠️ Could not find the ticket reply box', 5000);
      return false;
    }
    textarea.value = String(text || '');
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    textarea.focus();
    fwScrollTicketNewReplyIntoView(textarea);
    toast('✅ Inserted into ticket reply', 2500);
    return true;
  }

  function fwResolveInsertText(rawText) {
    const fromCustomer = extractCustomerReply(rawText);
    if (fromCustomer && String(fromCustomer).trim()) return String(fromCustomer).trim();
    const fromFence = fwExtractFirstCodeBlock(rawText);
    if (fromFence) return fromFence;
    return String(toPlainText(rawText) || '').trim();
  }

  function fwInsertCustomerReply(rawText, btn) {
    const plain = fwResolveInsertText(rawText);
    if (!plain) {
      toast('⚠️ No customer reply found — companion output looks internal-only', 4000);
      return;
    }
    const ok = fwInsertIntoCustomerReply(plain);
    if (ok && btn) {
      const prev = btn.textContent;
      btn.textContent = '✅ Inserted';
      setTimeout(() => { btn.textContent = prev; }, 2000);
    }
  }

  function getLastAssistantReply() {
    for (let i = chatHistory.length - 1; i >= 0; i--) {
      if (chatHistory[i].role === 'assistant') return chatHistory[i].content;
    }
    return '';
  }

  /* ════════════════════════════════════════
     MARKDOWN → HTML
  ════════════════════════════════════════ */
  function linkify(text) {
    text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, url) =>
      `<a class="gc-link" href="${escAttr(url)}" target="_blank" rel="noopener noreferrer">${escHtml(label)}</a>`);
    text = text.replace(/(^|[\s(>])((https?:\/\/)[^\s<>"')\]]+)/g, (_, pre, url) =>
      `${pre}<a class="gc-link" href="${escAttr(url)}" target="_blank" rel="noopener noreferrer">${escHtml(url)}</a>`);
    return text;
  }

  function stripInlineHtmlTags(s) {
    return String(s)
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/<\/p>\s*<p[^>]*>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&#39;/g, "'")
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function convertHtmlTablesToMarkdown(html) {
    if (!html) return html;
    return html.replace(/<table[^>]*>([\s\S]*?)<\/table>/gi, (_, inner) => {
      const rows = [];
      inner.replace(/<tr[^>]*>([\s\S]*?)<\/tr>/gi, (m, trInner) => {
        const cells = [];
        trInner.replace(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi, (m2, cell) => {
          cells.push(stripInlineHtmlTags(cell));
        });
        if (cells.length) rows.push(cells);
      });
      if (!rows.length) return '';
      const lines = ['|' + rows[0].join('|') + '|', '|' + rows[0].map(() => '---').join('|') + '|'];
      for (let r = 1; r < rows.length; r++) lines.push('|' + rows[r].join('|') + '|');
      return '\n' + lines.join('\n') + '\n';
    });
  }

  /** GoCaaS often emits one <ol> per <li> — merge so numbering survives conversion. */
  function mergeConsecutiveOrderedLists(html) {
    if (!html) return html;
    let prev;
    let text = html;
    do {
      prev = text;
      text = text.replace(/<\/ol>\s*<ol[^>]*>/gi, '');
    } while (text !== prev);
    return text;
  }

  /** GoCaaS sends <ol>/<ul> HTML — browser shows numbers, but tag-stripping loses them. */
  function convertHtmlListsToMarkdown(html) {
    if (!html) return html;
    let text = mergeConsecutiveOrderedLists(html);
    text = text.replace(/<ol[^>]*>([\s\S]*?)<\/ol>/gi, (_, inner) => {
      let n = 0;
      const lines = [];
      inner.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_, content) => {
        n++;
        lines.push(`${n}. ${stripInlineHtmlTags(content)}`);
      });
      return lines.length ? `\n${lines.join('\n')}\n` : '';
    });
    text = text.replace(/<ul[^>]*>([\s\S]*?)<\/ul>/gi, (_, inner) => {
      const lines = [];
      inner.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_, content) => {
        lines.push(`- ${stripInlineHtmlTags(content)}`);
      });
      return lines.length ? `\n${lines.join('\n')}\n` : '';
    });
    text = text.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_, content) => `\n- ${stripInlineHtmlTags(content)}\n`);
    return text;
  }

  function markdownListsToHtml(text) {
    const lines = text.split('\n');
    const out = [];
    let i = 0;
    while (i < lines.length) {
      const ol = lines[i].match(/^(\s*)(\d+)\.\s+(.*)$/);
      const ul = lines[i].match(/^(\s*)[-*+]\s+(.*)$/);
      if (ol || ul) {
        const items = [];
        const isOl = !!ol;
        while (i < lines.length) {
          if (lines[i].trim() === '') {
            let j = i + 1;
            while (j < lines.length && lines[j].trim() === '') j++;
            const peekOl = j < lines.length && lines[j].match(/^(\s*)(\d+)\.\s+(.*)$/);
            const peekUl = j < lines.length && lines[j].match(/^(\s*)[-*+]\s+(.*)$/);
            if ((isOl && peekOl) || (!isOl && peekUl)) { i++; continue; }
          }
          const mOl = lines[i].match(/^(\s*)(\d+)\.\s+(.*)$/);
          const mUl = lines[i].match(/^(\s*)[-*+]\s+(.*)$/);
          const m = isOl ? mOl : mUl;
          if (!m) break;
          const indent = (m[1] || '').length;
          const content = isOl ? m[3] : m[2];
          items.push({ indent, content });
          i++;
        }
        const build = (start, minIndent) => {
          let html = isOl ? '<ol>' : '<ul>';
          while (start < items.length) {
            const cur = items[start];
            if (cur.indent > minIndent) { start++; continue; }
            if (cur.indent < minIndent) break;
            html += `<li>${linkify(applyInlineMarkdown(escHtml(cur.content)))}`;
            if (start + 1 < items.length && items[start + 1].indent > cur.indent) {
              const sub = build(start + 1, items[start + 1].indent);
              html += sub.html;
              start = sub.next;
            } else {
              start++;
            }
            html += '</li>';
          }
          html += isOl ? '</ol>' : '</ul>';
          return { html, next: start };
        };
        out.push(build(0, items[0]?.indent || 0).html);
        continue;
      }
      out.push(lines[i]);
      i++;
    }
    return out.join('\n');
  }

  const HTML_BLOCK_PATTERNS = [
    /<div class="gc-(?:code-wrap|blockquote|callout|ip-list)[^"]*">[\s\S]*?<\/div>/gi,
    /<table class="gc-table">[\s\S]*?<\/table>/gi,
    /<[ou]l>[\s\S]*?<\/[ou]l>/gi,
    /<h[2-5][^>]*>[\s\S]*?<\/h[2-5]>/gi,
    /<pre>[\s\S]*?<\/pre>/gi,
    /<hr[^>]*>/gi,
  ];

  function stashHtmlBlocksIterative(text, stashFn) {
    let out = String(text);
    let changed = true;
    while (changed) {
      changed = false;
      for (const re of HTML_BLOCK_PATTERNS) {
        const next = out.replace(re, (m) => {
          changed = true;
          return stashFn(m);
        });
        out = next;
      }
    }
    return out;
  }

  function nl2brPreservingBlocks(text) {
    const blocks = [];
    const stash = (html) => {
      const key = `\x00FWB${blocks.length}B\x00`;
      blocks.push(html);
      return key;
    };
    let out = stashHtmlBlocksIterative(text, stash);
    out = out.replace(/\n{2,}/g, '<br><br>');
    out = out.replace(/\n/g, '<br>');
    blocks.forEach((html, i) => {
      // Keep newlines inside <pre>/code blocks — stripping them merges bash
      // tokens (e.g. "do\necho" → "doecho"). Other HTML ignores whitespace.
      const keepNewlines = /<pre[\s>]|gc-code-wrap/i.test(html);
      out = out.replace(`\x00FWB${i}B\x00`, keepNewlines ? html : html.replace(/\n/g, ''));
    });
    return out;
  }

  function codeBlockWithCopy(code) {
    return `<div class="gc-code-wrap"><button type="button" class="gc-code-copy-btn" title="Copy code" aria-label="Copy code">📋</button><pre><code>${code}</code></pre></div>`;
  }

  /** Inline code: copy for any useful snippet (all companions), not only shell. */
  function wrapInlineCopyableCode(html) {
    return String(html).replace(/<code>([^<]+)<\/code>/gi, (match, inner, offset, str) => {
      const inBlockquote = str.lastIndexOf('gc-blockquote', offset) > str.lastIndexOf('</div>', offset);
      const inCallout = str.lastIndexOf('gc-callout', offset) > str.lastIndexOf('</div>', offset);
      if (inBlockquote || inCallout) return match;
      const lastPre = str.lastIndexOf('<pre', offset);
      const lastPreClose = str.lastIndexOf('</pre>', offset);
      if (lastPre > lastPreClose) return match;
      const wrapOpen = str.lastIndexOf('gc-code-inline-wrap', offset);
      const wrapClose = str.lastIndexOf('</span>', offset);
      if (wrapOpen > wrapClose) return match;
      const text = String(inner || '').trim();
      if (!text || text.length < 3) return match;
      return (
        '<span class="gc-code-inline-wrap">' +
          '<code>' + inner + '</code>' +
          '<button type="button" class="gc-code-copy-btn gc-inline" title="Copy code" aria-label="Copy code">📋</button>' +
        '</span>'
      );
    });
  }

  /** After md() → HTML: wrap any bare <pre><code> that missed the fence path. */
  function ensurePreCodeCopyWraps(root) {
    if (!root) return;
    root.querySelectorAll('pre > code').forEach((codeEl) => {
      const pre = codeEl.parentElement;
      if (!pre || pre.closest('.gc-code-wrap')) return;
      const wrap = document.createElement('div');
      wrap.className = 'gc-code-wrap';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'gc-code-copy-btn';
      btn.title = 'Copy code';
      btn.setAttribute('aria-label', 'Copy code');
      btn.textContent = '📋';
      pre.parentNode.insertBefore(wrap, pre);
      wrap.appendChild(btn);
      wrap.appendChild(pre);
    });
  }

  /** Linkify bare URLs / markdown links in text nodes only (skips inside existing <a>). */
  function linkifyHtmlFragments(html) {
    let anchorDepth = 0;
    return String(html).replace(/(<[^>]+>)|([^<]+)/g, (m, tag, text) => {
      if (tag) {
        if (/^<\s*a\b/i.test(tag)) anchorDepth++;
        else if (/^<\s*\/\s*a\s*>/i.test(tag)) anchorDepth = Math.max(0, anchorDepth - 1);
        return tag;
      }
      if (!text || anchorDepth > 0) return text;
      return linkify(text);
    });
  }

  /** Add a copy button next to every http(s) link in companion responses. */
  function wrapCopyableUrls(html) {
    return String(html).replace(
      /<a\s+([^>]*class=["'][^"']*gc-link[^"']*["'][^>]*)>([\s\S]*?)<\/a>/gi,
      (match, attrs, label, offset, str) => {
        const lastPre = str.lastIndexOf('<pre', offset);
        const lastPreClose = str.lastIndexOf('</pre>', offset);
        if (lastPre > lastPreClose) return match;
        // Already wrapped
        const wrapOpen = str.lastIndexOf('gc-url-wrap', offset);
        const wrapClose = str.lastIndexOf('</span>', offset);
        if (wrapOpen > wrapClose) return match;

        const hrefMatch = attrs.match(/href=["']([^"']+)["']/i);
        const href = hrefMatch?.[1]?.trim() || '';
        if (!/^https?:\/\//i.test(href)) return match;

        return `<span class="gc-url-wrap"><a ${attrs}>${label}</a><button type="button" class="gc-code-copy-btn gc-inline gc-url-copy-btn" data-copy-url="${escAttr(href)}" title="Copy URL" aria-label="Copy URL">📋</button></span>`;
      }
    );
  }

  function wireCodeCopyButtons(root) {
    if (!root) return;
    ensurePreCodeCopyWraps(root);
    root.querySelectorAll('.gc-code-copy-btn').forEach(btn => {
      if (btn.dataset.wired) return;
      btn.dataset.wired = '1';
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const url = btn.getAttribute('data-copy-url')?.trim() || '';
        const wrap = btn.closest('.gc-code-wrap, .gc-code-inline-wrap, .gc-url-wrap');
        const text = url || wrap?.querySelector('code')?.textContent?.trim() || '';
        if (!text) { toast('⚠️ Nothing to copy'); return; }
        copyText(text)
          .then(() => {
            const prev = btn.textContent;
            btn.textContent = '✅';
            setTimeout(() => { btn.textContent = prev; }, 1500);
            if (url) toast('🔗 URL copied', 1500);
            else toast('📋 Code copied', 1500);
          })
          .catch(() => toast('❌ Copy failed — try selecting text manually', 3000));
      });
    });
  }

  function applyInlineMarkdown(text) {
    if (!text) return '';
    return String(text).split(/(<pre[\s\S]*?<\/pre>)/gi).map(part => {
      if (/^<pre/i.test(part)) return part;
      return part
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/\*(.+?)\*/g, '<em>$1</em>');
    }).join('');
  }

  function applyHeadings(text) {
    return text
      .replace(/^##### (.+)$/gm, '<h5>$1</h5>')
      .replace(/^#### (.+)$/gm, '<h4 class="gc-h4">$1</h4>')
      .replace(/^### (.+)$/gm, '<h4>$1</h4>')
      .replace(/^## (.+)$/gm, '<h3>$1</h3>')
      .replace(/^# (.+)$/gm, '<h2>$1</h2>');
  }

  function renderCitationRefs(text) {
    return String(text).split(/(<code[^>]*>[\s\S]*?<\/code>)/gi).map(part => {
      if (/^<code/i.test(part)) return part;
      return part.replace(/\[(\d+)\]/g, '<span class="gc-cite">[$1]</span>');
    }).join('');
  }

  function renderKbFilePills(text) {
    return String(text).split(/(`[^`]+`|<code[^>]*>[\s\S]*?<\/code>)/gi).map(part => {
      if (part.startsWith('`') || /^<code/i.test(part)) return part;
      return part.replace(/\b([A-Za-z0-9][A-Za-z0-9+_.-]*\.txt)\b/g, '<span class="gc-kb-file">$1</span>');
    }).join('');
  }

  function renderSourcePills(text) {
    return text.replace(/\b(\d+)\s+Sources?\b/gi, '<span class="gc-sources-pill">📎 $1 Sources</span>');
  }

  function renderAttachmentChipsInText(text) {
    return text.replace(/\b(attachment|uploaded file|log file)\b/gi,
      (m) => `<span class="gc-attach-chip">${m}</span>`);
  }

  function parseTableRow(line) {
    if (!/^\s*\|/.test(line)) return null;
    return line.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
  }

  function isTableSeparator(line) {
    return /^\s*\|[\s\-:|]+\|\s*$/.test(line);
  }

  function markdownTablesToHtml(text) {
    const lines = text.split('\n');
    const out = [];
    let i = 0;
    while (i < lines.length) {
      const header = parseTableRow(lines[i]);
      if (header && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
        i += 2;
        let html = '<table class="gc-table"><thead><tr>';
        header.forEach(c => { html += `<th>${linkify(applyInlineMarkdown(c))}</th>`; });
        html += '</tr></thead><tbody>';
        while (i < lines.length) {
          const row = parseTableRow(lines[i]);
          if (!row) break;
          html += '<tr>';
          row.forEach(c => { html += `<td>${linkify(applyInlineMarkdown(c))}</td>`; });
          html += '</tr>';
          i++;
        }
        html += '</tbody></table>';
        out.push(html);
        continue;
      }
      out.push(lines[i]);
      i++;
    }
    return out.join('\n');
  }

  function isCidrLine(line) {
    const l = String(line || '').trim().replace(/^>\s?/, '').replace(/>\s*$/, '');
    if (!l) return false;
    return /\d+\.\d+\.\d+\.\d+\/\d+/.test(l) || /^2a[0-9a-f:.]+\/\d+/i.test(l);
  }

  function convertCidrRunsToLists(text) {
    const lines = text.split('\n');
    const out = [];
    let i = 0;
    while (i < lines.length) {
      const bare = lines[i].trim().replace(/^>\s?/, '');
      if (isCidrLine(bare)) {
        const items = [];
        while (i < lines.length) {
          const item = lines[i].trim().replace(/^>\s?/, '').replace(/>\s*$/, '');
          if (!isCidrLine(item)) break;
          items.push(item);
          i++;
        }
        out.push(`<ul class="gc-ip-list">${items.map(ip => `<li>${escHtml(ip)}</li>`).join('')}</ul>`);
        continue;
      }
      out.push(lines[i]);
      i++;
    }
    return out.join('\n');
  }

  function convertCodeFences(text, stashHtml) {
    return String(text).replace(/```[\w-]*\n?([\s\S]*?)```/g, (_, code) => {
      const normalized = String(code).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
      const lines = normalized.replace(/^\n+|\n+$/g, '').split('\n').map(l => l.replace(/^>\s?/, ''));
      const nonempty = lines.map(l => l.trim()).filter(Boolean);
      if (nonempty.length && nonempty.every(isCidrLine)) {
        const ul = `<ul class="gc-ip-list">${nonempty.map(l => `<li>${escHtml(l)}</li>`).join('')}</ul>`;
        return `\n${stashHtml(ul)}\n`;
      }
      // Preserve blank lines and indentation — required for readable bash/scripts.
      return `\n${stashHtml(codeBlockWithCopy(escHtml(lines.join('\n'))))}\n`;
    });
  }

  function mapPlainParts(text, fn) {
    return String(text).split(/(\x00FWH\d+\x00)/g).map(part => (
      /^\x00FWH\d+\x00$/.test(part) ? part : fn(part)
    )).join('');
  }

  function stashInlineHtml(text, stashHtml) {
    return stashHtmlBlocksIterative(text, stashHtml);
  }

  function restoreHtmlTokens(text, htmlStash) {
    let out = String(text);
    htmlStash.forEach((html, i) => { out = out.split(`\x00FWH${i}\x00`).join(html); });
    return out;
  }

  function normalizeBlockquoteLine(raw) {
    let s = String(raw || '').replace(/^>\s?/, '');
    s = s.replace(/>\s+(?=[0-9.:/\da-fA-F(])/gi, '\n');
    s = s.replace(/>\s*$/, '');
    return s;
  }

  function finalizeBlockquoteInner(inner) {
    inner = convertCidrRunsToLists(inner);
    inner = applyHeadings(inner);
    inner = markdownTablesToHtml(inner);
    inner = markdownListsToHtml(inner);
    inner = inner.split('\n').map(line => {
      const t = line.trim();
      if (!t) return '';
      if (/^\x00FWH\d+\x00$/.test(t)) return t;
      if (/^<(ul|ol|table|h[2-5]|\/)/i.test(t) || /^<(li|tr|td|th|thead|tbody)/i.test(t)) return line;
      return applyInlineMarkdown(escHtml(line));
    }).join('<br>');
    // Linkify after list/heading conversion so URLs in blockquotes get anchors + copy buttons.
    return linkifyHtmlFragments(inner);
  }

  function renderBlockquotesAndRules(text, stashHtml) {
    const lines = text.split('\n');
    const out = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (/^\x00FWH\d+\x00$/.test(line.trim())) {
        out.push(line.trim());
        i++;
        continue;
      }
      if (/^>\s?/.test(line)) {
        const bqLines = [];
        while (i < lines.length && /^>\s?/.test(lines[i])) {
          bqLines.push(normalizeBlockquoteLine(lines[i]));
          i++;
        }
        const inner = finalizeBlockquoteInner(bqLines.join('\n'));
        const isTip = /💡|Tip:/i.test(inner);
        out.push(stashHtml(`<div class="${isTip ? 'gc-callout gc-tip' : 'gc-blockquote'}">${inner}</div>`));
        continue;
      }
      if (/^-{3,}\s*$/.test(line.trim())) {
        out.push('<hr class="gc-hr">');
        i++;
        continue;
      }
      out.push(line);
      i++;
    }
    return out.join('\n');
  }

  function md(text) {
    if (!text) return '';
    const htmlStash = [];
    const stashHtml = (html) => {
      htmlStash.push(html);
      return `\x00FWH${htmlStash.length - 1}\x00`;
    };

    let clean = replaceDetailsPreservingUrls(text);
    clean = clean.replace(/<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
      (_, url, label) => `[${stripInlineHtmlTags(label) || url}](${url})`);
    clean = clean.replace(/<(https?:\/\/[^>\s]+)>/g, '$1');
    clean = clean.replace(/<br\s*\/?>/gi, '\n');
    clean = clean.replace(/<\/p>\s*<p[^>]*>/gi, '\n\n');
    clean = convertHtmlTablesToMarkdown(clean);
    clean = convertHtmlListsToMarkdown(clean);
    clean = clean.replace(/<\/?[ou]l[^>]*>/gi, '\n');
    clean = clean.replace(/<\/?li[^>]*>/gi, '\n');
    clean = clean.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_, inner) => {
      const code = inner.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, '$1').replace(/<[^>]+>/g, '');
      return `\n\`\`\`\n${code.trim()}\n\`\`\`\n`;
    });
    clean = clean.replace(/<\/(p|div|h[1-6]|li|tr|blockquote)>/gi, '\n');
    clean = clean.replace(/<br\s*\/?>/gi, '\n');
    clean = clean.replace(/<[^>]+>/g, '');
    clean = clean.replace(/&nbsp;/g, ' ').replace(/&#x27;/g, "'").replace(/&quot;/g, '"');
    clean = convertCodeFences(clean, stashHtml);
    clean = renderBlockquotesAndRules(clean, stashHtml);
    clean = applyHeadings(clean);
    clean = markdownTablesToHtml(clean);
    clean = markdownListsToHtml(clean);
    clean = stashInlineHtml(clean, stashHtml);
    clean = mapPlainParts(clean, escHtml);
    clean = mapPlainParts(clean, applyInlineMarkdown);
    clean = mapPlainParts(clean, renderKbFilePills);
    clean = mapPlainParts(clean, linkify);
    clean = mapPlainParts(clean, renderCitationRefs);
    clean = mapPlainParts(clean, renderSourcePills);
    clean = mapPlainParts(clean, renderAttachmentChipsInText);
    clean = mapPlainParts(clean, stripToolExecutedArtifacts);
    clean = restoreHtmlTokens(clean, htmlStash);
    clean = linkifyHtmlFragments(clean);
    clean = wrapInlineCopyableCode(clean);
    clean = wrapCopyableUrls(clean);
    return nl2brPreservingBlocks(clean);
  }

  /* ════════════════════════════════════════
     CSS
  ════════════════════════════════════════ */
  const CSS = `
    #gc-toast{position:fixed;bottom:80px;right:80px;background:#1a2a1a;border:1px solid #2a5a2a;color:#7dff9a;font-family:'Inter','Segoe UI',sans-serif;font-size:12px;font-weight:600;padding:9px 14px;border-radius:10px;z-index:2147483648;opacity:0;transform:translateY(6px);transition:opacity .25s,transform .25s;pointer-events:none;}
    #gc-toast.show{opacity:1;transform:translateY(0);}
    #gc-launcher{position:fixed;bottom:24px;right:24px;width:52px;height:52px;border-radius:50%;background:linear-gradient(135deg,#c0392b,#e74c3c);border:none;cursor:pointer;box-shadow:0 4px 20px rgba(200,50,50,.5);z-index:2147483646;display:flex;align-items:center;justify-content:center;transition:transform .2s,box-shadow .2s;}
    #gc-launcher:hover{transform:scale(1.08);box-shadow:0 6px 28px rgba(200,50,50,.7);}
    #gc-launcher svg{width:24px;height:24px;fill:#fff;pointer-events:none;}
    #gc-launcher .gc-indicator{position:absolute;top:-2px;right:-2px;width:14px;height:14px;border-radius:50%;border:2px solid #1a0a0a;pointer-events:none;}
    #gc-launcher .gc-dot{background:#ff4444;}
    #gc-launcher .gc-connected{background:#3dbb5a;}
    #gc-panel{position:fixed;top:16px;bottom:88px;right:16px;width:480px;background:#0f1122;border:1px solid #3a1a1a;border-radius:16px;box-shadow:0 16px 64px rgba(0,0,0,.7);z-index:2147483647;display:flex;flex-direction:column;overflow:hidden;font-family:'Inter','Segoe UI',sans-serif;font-size:13px;color:#d8daf8;transition:opacity .2s,transform .2s;transform-origin:bottom right;}
    #gc-panel.gc-hidden{opacity:0;transform:scale(0.96) translateY(8px);pointer-events:none;}
    #gc-header{display:flex;align-items:center;gap:8px;padding:11px 14px;background:linear-gradient(135deg,#5a1a1a,#3a0808);cursor:move;flex-shrink:0;border-radius:16px 16px 0 0;}
    .gc-logo{font-size:15px;font-weight:700;color:#ff8888;flex:1;letter-spacing:.5px;}
    .gc-logo span{color:#fff;}
    .gc-logo .gc-ver{font-size:9px;color:#664444;margin-left:6px;font-weight:400;vertical-align:middle;}
    .gc-hbtn{background:none;border:none;color:#aa7777;cursor:pointer;width:28px;height:28px;border-radius:6px;font-size:13px;display:flex;align-items:center;justify-content:center;transition:background .15s,color .15s;}
    .gc-hbtn:hover{background:rgba(255,255,255,.12);color:#fff;}
    #gc-connect-bar{display:flex;align-items:center;gap:8px;padding:6px 12px;background:#08091a;border-bottom:1px solid #1a1d38;flex-shrink:0;transition:padding .2s;}
    #gc-connect-bar.gc-connect-compact{padding:3px 12px;}
    #gc-connect-bar.gc-connect-compact .gc-conn-status{font-size:10px;}
    .gc-conn-status{font-size:11px;flex:1;color:#445;}
    .gc-conn-status.connected{color:#3dbb5a;}
    .gc-conn-status.connecting{color:#e0a030;}
    #gc-connect-btn{padding:4px 12px;border:none;border-radius:7px;font-size:11px;font-weight:600;cursor:pointer;background:linear-gradient(135deg,#1e3a20,#102a38);border:1px solid #204530;color:#5dff8a;transition:opacity .15s;white-space:nowrap;}
    #gc-connect-btn:hover{opacity:.82;}
    #gc-connect-btn.connected{background:#12141e;color:#334;border-color:#1a1e28;cursor:default;}
    #gc-model-bar{display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:6px 12px;background:#0c0e1e;border-bottom:1px solid #1a1d38;flex-shrink:0;}
    #gc-model-bar label{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:#664444;white-space:nowrap;}
    #gc-model-sel{flex:1;min-width:160px;background:#0f1122;color:#d8a0a0;border:1px solid #3a1a1a;border-radius:7px;padding:5px 8px;font-size:12px;outline:none;cursor:pointer;}
    #gc-model-sel:focus{border-color:#e74c3c;}
    #gc-model-hint{flex:1 1 100%;font-size:10px;color:#3a5a3a;padding-left:2px;}
    #gc-model-hint.manual{color:#554466;}
    #gc-tabs{display:flex;background:#090b18;border-bottom:1px solid #1a1d38;flex-shrink:0;}
    .gc-tab{flex:1;padding:7px 0;text-align:center;font-size:11px;font-weight:600;color:#334;cursor:pointer;border:none;background:none;border-bottom:2px solid transparent;transition:color .15s,border-color .15s;}
    .gc-tab.active{color:#ff8888;border-bottom-color:#e74c3c;}
    .gc-tab:hover:not(.active){color:#99b;}
    .gc-pane{display:none;flex:1;flex-direction:column;overflow:hidden;min-height:0;}
    .gc-pane.active{display:flex;}
    #gc-status-bar{padding:4px 14px;background:#0c0e1e;border-bottom:1px solid #1a1d38;font-size:11px;color:#7a4a4a;flex-shrink:0;display:flex;align-items:center;gap:6px;}
    #gc-cancel-btn{margin-left:auto;padding:2px 8px;border:1px solid #5a2020;border-radius:6px;background:#2a1010;color:#ff8888;font-size:10px;font-weight:600;cursor:pointer;}
    #gc-cancel-btn:hover{opacity:.85;}
    #gc-cancel-btn[hidden]{display:none;}
    #gc-status-bar .gc-dot-status{width:7px;height:7px;border-radius:50%;background:#4a1a1a;flex-shrink:0;}
    #gc-status-bar.ready   .gc-dot-status{background:#3dbb5a;}
    #gc-status-bar.loading .gc-dot-status{background:#e0a030;animation:gc-pulse 1s infinite;}
    #gc-status-bar.error   .gc-dot-status{background:#e04040;}
    @keyframes gc-pulse{0%,100%{opacity:1}50%{opacity:.3}}
    #gc-messages{flex:1;overflow-y:auto;padding:14px 14px 8px;display:flex;flex-direction:column;gap:12px;scroll-behavior:smooth;}
    #gc-messages::-webkit-scrollbar{width:5px;}
    #gc-messages::-webkit-scrollbar-thumb{background:#1e2248;border-radius:4px;}
    .gc-msg{display:flex;flex-direction:column;max-width:90%;gap:3px;}
    .gc-msg.user{align-self:flex-end;align-items:flex-end;}
    .gc-msg.assistant{align-self:flex-start;align-items:flex-start;}
    .gc-msg.system-msg{align-self:flex-start;max-width:100%;}
    .gc-bubble{padding:9px 13px;border-radius:14px;font-size:12.5px;line-height:1.6;word-break:break-word;text-align:left;}
    .gc-msg.user      .gc-bubble{background:linear-gradient(135deg,#6a1a1a,#8a2020);color:#ffe8e8;border-radius:14px 14px 4px 14px;}
    .gc-msg.assistant .gc-bubble{background:#151830;color:#ccd0f0;border:1px solid #1e2248;border-radius:14px 14px 14px 4px;}
    .gc-msg.system-msg .gc-bubble{background:#0d1028;color:#445;font-size:11px;border:1px dashed #1a1e38;border-radius:8px;}
    .gc-bubble code{background:#0a0c1a;color:#88aaff;padding:1px 5px;border-radius:4px;font-size:11.5px;font-family:'Consolas','Fira Code',monospace;}
    .gc-code-wrap{position:relative;margin:6px 0;}
    .gc-code-wrap pre{margin:0;padding:10px 40px 10px 10px;}
    .gc-code-inline-wrap{display:inline-flex;align-items:center;gap:4px;max-width:100%;vertical-align:middle;}
    .gc-code-inline-wrap code{flex:1;min-width:0;word-break:break-all;}
    .gc-url-wrap{display:inline-flex;align-items:flex-start;gap:4px;max-width:100%;vertical-align:baseline;}
    .gc-url-wrap .gc-link{flex:1;min-width:0;}
    .gc-code-copy-btn{position:absolute;top:6px;right:6px;padding:2px 7px;border:1px solid #2a3060;border-radius:5px;background:#12162e;color:#8898bb;font-size:10px;line-height:1.3;cursor:pointer;opacity:.8;transition:opacity .15s,background .15s,color .15s;}
    .gc-code-copy-btn.gc-inline{position:static;flex-shrink:0;padding:1px 5px;font-size:9px;}
    .gc-url-copy-btn{margin-top:1px;}
    .gc-code-copy-btn:hover{opacity:1;background:#1a2040;color:#aabbee;}
    .gc-bubble pre{background:#0a0c1a;border:1px solid #1a1e38;border-radius:8px;padding:10px;overflow-x:auto;margin:6px 0;white-space:pre;tab-size:2;}
    .gc-bubble pre code{background:none;padding:0;font-size:11px;white-space:inherit;}
    .gc-bubble h2,.gc-bubble h3,.gc-bubble h4,.gc-bubble h5{margin:10px 0 4px;color:#a0b0ff;font-weight:600;}
    .gc-bubble h4.gc-h4{font-size:13px;color:#b8c4ff;}
    .gc-bubble ol,.gc-bubble ul{margin:4px 0;padding-left:20px;}
    .gc-bubble ol{list-style:decimal;}
    .gc-bubble ul{list-style:disc;}
    .gc-bubble li{margin:2px 0;}
    .gc-blockquote,.gc-callout{margin:8px 0;padding:10px 12px;border-left:3px solid #3a4080;background:#0c0e20;border-radius:0 8px 8px 0;line-height:1.55;}
    .gc-callout.gc-tip{border-left-color:#c99030;background:#141008;}
    .gc-blockquote ul,.gc-callout ul{margin:6px 0 0;padding-left:18px;}
    .gc-blockquote li,.gc-callout li{margin:3px 0;}
    .gc-ip-list{margin:8px 0;padding-left:20px;list-style:disc;}
    .gc-ip-list li{margin:4px 0;font-family:'Consolas','Fira Code',monospace;font-size:12px;color:#b8c0e8;}
    .gc-blockquote .gc-table,.gc-callout .gc-table{margin:6px 0;}
    .gc-hr{border:none;border-top:1px solid #1e2248;margin:10px 0;}
    .gc-table{width:100%;border-collapse:collapse;margin:10px 0;font-size:11.5px;}
    .gc-table th,.gc-table td{border:1px solid #2a3060;padding:8px 10px;text-align:left;vertical-align:top;line-height:1.45;}
    .gc-table thead th{background:#12162e;color:#a8b4ff;font-weight:600;}
    .gc-table tbody td{color:#c8d0f0;}
    .gc-table tbody tr:nth-child(even){background:rgba(12,14,28,.85);}
    .gc-bubble .gc-table{max-width:100%;display:table;}
    .gc-cite{display:inline-block;background:#1a2040;border:1px solid #3a4080;border-radius:4px;padding:0 4px;font-size:9px;color:#8898ff;margin:0 1px;vertical-align:super;line-height:1.2;}
    .gc-kb-file{display:inline-block;background:#1a2830;border:1px solid #2a5060;border-radius:6px;padding:1px 7px;font-size:10px;color:#7ec8ff;margin:0 2px;}
    .gc-bubble strong{color:#d0d8ff;}
    .gc-bubble a.gc-link{color:#7ec8ff;text-decoration:underline;word-break:break-all;}
    .gc-bubble a.gc-link:hover{color:#a8dcff;}
    .gc-meta{font-size:10px;color:#2a3060;margin:0 4px;}
    .gc-msg-actions{display:flex;flex-wrap:wrap;gap:6px;margin:2px 4px 0;}
    .gc-copy-btn{padding:3px 9px;border:1px solid #1e2248;border-radius:6px;background:#0c0e1e;color:#7788bb;font-size:10px;font-weight:600;cursor:pointer;transition:background .15s,color .15s,border-color .15s;}
    .gc-copy-btn:hover{background:#151830;color:#aabbee;border-color:#2a3060;}
    .gc-retry-btn,.gc-followup-btn{padding:3px 9px;border:1px solid #1e2248;border-radius:6px;background:#0c0e1e;color:#7788bb;font-size:10px;font-weight:600;cursor:pointer;transition:background .15s,color .15s,border-color .15s;}
    .gc-retry-btn:hover,.gc-followup-btn:hover{background:#151830;color:#aabbee;border-color:#2a3060;}
    .gc-sources-pill{display:inline-block;background:#1a2040;border:1px solid #3a4080;border-radius:999px;padding:1px 8px;font-size:10px;color:#8898ff;margin:0 2px;}
    .gc-attach-chip{display:inline-block;background:#1a2830;border:1px solid #2a5060;border-radius:6px;padding:1px 6px;font-size:10px;color:#7ec8ff;}
    .gc-followups{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px;}
    .gc-thinking .gc-bubble{min-width:180px;max-width:92%;padding:12px 14px;}
    .gc-progress{display:flex;flex-direction:column;gap:8px;width:100%;}
    .gc-progress-label{display:flex;flex-direction:column;gap:2px;font-size:11px;color:#8890b8;line-height:1.4;}
    .gc-progress-step{color:#a8b0d8;}
    .gc-progress-timing{font-size:10px;color:#667;}
    .gc-progress-track{height:6px;background:#1a1e38;border-radius:999px;overflow:hidden;}
    .gc-progress-fill{height:100%;width:6%;background:linear-gradient(90deg,#c0392b,#e74c3c);border-radius:999px;transition:width .45s ease;}
    #gc-input-row{display:flex;align-items:flex-end;gap:8px;padding:10px 12px 4px;background:#090b18;border-top:1px solid #141630;flex-shrink:0;}
    #gc-input{flex:1;background:#0f1122;color:#c8d0f0;border:1px solid #3a1a1a;border-radius:10px;padding:9px 12px;font-size:12.5px;font-family:inherit;resize:none;outline:none;min-height:38px;max-height:140px;overflow-y:auto;line-height:1.5;transition:border-color .15s;}
    #gc-input:focus{border-color:#e74c3c;}
    #gc-input::placeholder{color:#2a3060;}
    #gc-send-btn{width:36px;height:36px;border-radius:10px;flex-shrink:0;background:linear-gradient(135deg,#c0392b,#e74c3c);border:none;cursor:pointer;color:#fff;font-size:16px;display:flex;align-items:center;justify-content:center;transition:opacity .15s;align-self:flex-end;}
    #gc-send-btn:hover{opacity:.85;}
    #gc-send-btn:disabled{opacity:.35;cursor:not-allowed;}
    #gc-btn-row{display:flex;gap:6px;padding:6px 12px 10px;background:#090b18;flex-shrink:0;}
    .gc-action-btn{flex:1;padding:7px 0;border:none;border-radius:8px;font-size:11px;font-weight:600;cursor:pointer;transition:opacity .15s;}
    .gc-action-btn:hover{opacity:.82;}
    #gc-inject-btn{background:linear-gradient(135deg,#163a20,#102a38);border:1px solid #204530;color:#5dff8a;}
    #gc-copy-reply-btn{background:linear-gradient(135deg,#1a2a4a,#102038);border:1px solid #203060;color:#88bbff;}
    #gc-copy-response-btn{background:linear-gradient(135deg,#1a2a3a,#102028);border:1px solid #203050;color:#99ccee;}
    #gc-clear-btn{background:#10121e;color:#5566aa;border:1px solid #1a1e38;}
    #gc-ctx-scroll{flex:1;overflow-y:auto;padding:14px;}
    .gc-lbl{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;color:#334;margin-bottom:5px;display:block;}
    .gc-field{background:#090b18;border:1px solid #181c38;border-radius:8px;padding:7px 10px;font-size:11px;color:#7080a0;white-space:pre-wrap;word-break:break-word;max-height:80px;overflow-y:auto;margin-bottom:12px;line-height:1.5;}
    .gc-field.empty{color:#1e2240;font-style:italic;}
    #gc-ctx-source{font-size:10px;color:#334;margin-bottom:10px;padding:4px 8px;background:#090b18;border-radius:6px;display:inline-block;}
    .gc-ctx-btns{display:flex;gap:8px;margin-top:4px;}
    .gc-ctx-btn{flex:1;padding:8px 0;border:none;border-radius:8px;font-size:11px;font-weight:600;cursor:pointer;transition:opacity .15s;}
    .gc-ctx-btn:hover{opacity:.82;}
    .gc-ctx-btn-sec{background:#10121e;color:#5566aa;border:1px solid #1a1e38;}
    .gc-ctx-btn-pri{background:linear-gradient(135deg,#c0392b,#e74c3c);color:#fff;}
    #gc-settings-scroll{flex:1;overflow-y:auto;padding:14px;}
    .gc-setting-title{font-size:11px;font-weight:700;color:#aa5555;margin-bottom:8px;display:block;}
    .gc-setting-group{margin-bottom:18px;}
    .gc-setting-row{display:flex;align-items:center;gap:8px;margin-bottom:8px;}
    .gc-setting-row label{font-size:12px;color:#7080a0;flex:1;}
    .gc-setting-input{background:#090b18;color:#c8d0f0;border:1px solid #1e2248;border-radius:7px;padding:5px 10px;font-size:12px;outline:none;width:100%;}
    .gc-setting-input:focus{border-color:#e74c3c;}
    .gc-save-btn{width:100%;padding:9px;border:none;border-radius:8px;background:linear-gradient(135deg,#c0392b,#e74c3c);color:#fff;font-size:12px;font-weight:600;cursor:pointer;transition:opacity .15s;}
    .gc-save-btn:hover{opacity:.85;}
    .gc-hint{font-size:10px;color:#2a3050;margin-top:4px;line-height:1.5;}
    .gc-divider{border:none;border-top:1px solid #141630;margin:14px 0;}
    .gc-oauth-card{max-width:100%!important;}
    .gc-oauth-bubble{background:#130d00!important;border:1px solid #664400!important;border-radius:12px;padding:14px 16px!important;}
    .gc-oauth-title{font-size:13px;font-weight:700;color:#ffaa44;margin-bottom:10px;}
    .gc-oauth-body{color:#c0b090;font-size:12px;line-height:1.7;margin-bottom:12px;}
    .gc-oauth-steps{display:flex;flex-direction:column;gap:8px;}
    .gc-oauth-step{display:flex;align-items:flex-start;gap:10px;font-size:12px;color:#ccd0f0;line-height:1.5;}
    .gc-oauth-num{background:#664400;color:#ffaa44;font-weight:700;font-size:11px;min-width:20px;height:20px;border-radius:50%;display:flex;align-items:center;justify-content:center;flex-shrink:0;margin-top:1px;}
    .gc-oauth-code{background:#1a1000;color:#ffdd88;padding:1px 6px;border-radius:4px;font-family:'Consolas',monospace;border:1px solid #443300;}
    .gc-oauth-domain{color:#7ec8ff;}
    .gc-oauth-authorize{color:#5dff8a;}
    .gc-oauth-note{margin-top:12px;font-size:11px;color:#554433;border-top:1px solid #332200;padding-top:8px;}
    .gc-oauth-focus-btn{margin-top:10px;width:100%;padding:7px;border:none;border-radius:8px;background:linear-gradient(135deg,#4a3000,#332200);color:#ffaa44;font-size:11px;font-weight:600;cursor:pointer;border:1px solid #664400;transition:opacity .15s;}
    .gc-oauth-focus-btn:hover{opacity:.82;}
    .gc-form-card{margin-top:10px;padding:14px;background:#12162e;border:1px solid #2a3060;border-radius:12px;display:flex;flex-direction:column;gap:12px;max-width:100%;}
    .gc-form-title{font-size:13px;font-weight:700;color:#e8ecff;}
    .gc-form-desc{font-size:12px;color:#8890b8;line-height:1.5;}
    .gc-form-fields{display:flex;flex-direction:column;gap:14px;}
    .gc-form-field{display:flex;flex-direction:column;gap:6px;}
    .gc-form-field.gc-form-field-error .gc-form-input,.gc-form-field.gc-form-field-error .gc-form-textarea,.gc-form-field.gc-form-field-error .gc-form-select{border-color:#e74c3c;}
    .gc-form-label{font-size:12px;font-weight:600;color:#c8d0f0;line-height:1.4;}
    .gc-form-req{color:#e74c3c;}
    .gc-form-input,.gc-form-textarea,.gc-form-select{width:100%;box-sizing:border-box;background:#0a0c1a;color:#e0e4ff;border:1px solid #2a3060;border-radius:8px;padding:8px 10px;font-size:12px;font-family:inherit;outline:none;}
    .gc-form-input:focus,.gc-form-textarea:focus,.gc-form-select:focus{border-color:#5a7aff;}
    .gc-form-textarea{min-height:72px;resize:vertical;line-height:1.5;}
    .gc-form-radio-group{display:flex;flex-direction:column;gap:8px;}
    .gc-form-radio-opt{display:flex;align-items:flex-start;gap:8px;font-size:12px;color:#c8d0f0;cursor:pointer;line-height:1.4;}
    .gc-form-radio-opt input{margin-top:2px;accent-color:#e74c3c;flex-shrink:0;}
    .gc-form-submit{align-self:flex-end;padding:8px 18px;border:none;border-radius:8px;background:#f0f2ff;color:#1a1030;font-size:12px;font-weight:700;cursor:pointer;transition:opacity .15s;}
    .gc-form-submit:hover{opacity:.88;}
    .gc-form-submit:disabled{opacity:.45;cursor:not-allowed;}
    .gc-form-error{font-size:11px;color:#ff8888;}
    .gc-form-submitted{opacity:.75;pointer-events:none;}
    .gc-msg.assistant:has(.gc-form-card){max-width:96%;}
  `;

  /* ════════════════════════════════════════
     BUILD DOM
  ════════════════════════════════════════ */
  function createUI() {
    const style=document.createElement('style'); style.textContent=CSS; document.head.appendChild(style);
    const launcher=document.createElement('button'); launcher.id='gc-launcher'; launcher.title='FireWally';
    launcher.innerHTML=`
      <svg viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg>
      <span class="gc-indicator gc-dot"></span>`;
    const panel=document.createElement('div'); panel.id='gc-panel'; panel.classList.add('gc-hidden');
    panel.innerHTML=`
      <div id="gc-header">
        <div class="gc-logo">🔥 FireWally<span> by GoCaaS</span><span class="gc-ver">v${VERSION}</span></div>
        <button class="gc-hbtn" id="gc-popout-btn" title="Open GoCaaS companion">⤢</button>
        <button class="gc-hbtn" id="gc-close-btn" title="Close">✕</button>
      </div>
      <div id="gc-connect-bar">
        <span class="gc-conn-status" id="gc-conn-status">● Not connected</span>
        <button id="gc-connect-btn">🔗 Connect GoCaaS</button>
      </div>
      <div id="gc-model-bar">
        <label for="gc-model-sel">Companion</label>
        <select id="gc-model-sel">${MODELS.map(m=>{
          const def = fwGetDefaultCompanionId();
          return `<option value="${m.id}"${m.id === def ? ' selected' : ''}>${m.name}</option>`;
        }).join('')}</select>
        <span id="gc-model-hint" class="gc-model-hint"></span>
      </div>
      <div id="gc-tabs">
        <button class="gc-tab active" data-tab="chat">💬 Chat</button>
        <button class="gc-tab" data-tab="context">📋 Ticket</button>
        <button class="gc-tab" data-tab="settings">⚙ Settings</button>
      </div>
      <div class="gc-pane active" id="gc-pane-chat">
        <div id="gc-status-bar"><span class="gc-dot-status"></span><span id="gc-status-text">Click "Connect GoCaaS" or configure an API key in Settings</span><button id="gc-cancel-btn" hidden type="button">✕ Cancel</button></div>
        <div id="gc-messages">
          <div class="gc-msg system-msg"><div class="gc-bubble">
            👋 Welcome to <strong>FireWally v${VERSION}</strong><br><br>
            <strong>Relay mode (default):</strong> Click <strong>Connect GoCaaS</strong> to begin.<br>
            <strong>API key mode:</strong> Settings → paste your GoCaaS API key (Settings → Account on GoCaaS).<br><br>
            Atlassian authorisation is required for all companions (502, AI Crawler, WAF, SSL, Backup, Provisioning Failure, Monitoring/Alerts, Ticket Response, Hosting).
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
          <span class="gc-setting-title">🔑 GoCaaS authentication</span>
          <div class="gc-setting-group">
            <div class="gc-setting-row" style="flex-direction:column;align-items:stretch;gap:6px;">
              <label>Connection method</label>
              <select class="gc-setting-input" id="gc-settings-auth-mode">
                <option value="relay">Relay — Connect GoCaaS tab (default)</option>
                <option value="apikey">API key — direct (no background tab)</option>
              </select>
            </div>
            <div id="gc-settings-apikey-block" style="display:none;">
              <div class="gc-setting-row" style="flex-direction:column;align-items:stretch;gap:4px;">
                <label>GoCaaS API key</label>
                <input class="gc-setting-input" id="gc-settings-api-key" type="password" autocomplete="off" placeholder="sk-… from GoCaaS Settings → Account"/>
                <p class="gc-hint" id="gc-settings-apikey-status" style="margin:0;">
                  Requires GoCaaS admin to enable <strong>API Keys</strong> (Admin → Settings → Authentication).<br>
                  Then create a key: <strong>Settings → Account → API keys</strong> (<code>sk-…</code>).<br>
                  If API keys are disabled on the platform, use <strong>Relay mode</strong> instead.
                </p>
              </div>
              <button type="button" class="gc-ctx-btn gc-ctx-btn-sec" id="gc-settings-apikey-test" style="width:100%;margin-top:6px;">🧪 Test API key</button>
            </div>
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
              Includes <strong>version</strong> (script) and <strong>DurationMs</strong> (first response time).
              Map those fields in Power Automate → Excel if columns are empty.
            </p>
            <button type="button" class="gc-ctx-btn gc-ctx-btn-sec" id="gc-settings-usage-test" style="width:100%;margin-top:6px;">🧪 Send test log row</button>
          </div>
          <span class="gc-setting-title">🤖 Default companion</span>
          <div class="gc-setting-group">
            <div class="gc-setting-row" style="flex-direction:column;align-items:stretch;gap:4px;">
              <label>Used when auto-select has no strong match</label>
              <select class="gc-setting-input" id="gc-settings-default-companion"></select>
              <p class="gc-hint" style="margin:0;">
                Auto-select from ticket keywords still overrides this when confidence is high.
                Manual picks on a ticket are still remembered for that ticket.
              </p>
            </div>
          </div>
          <button class="gc-save-btn" id="gc-settings-save">💾 Save Settings</button>
          <hr class="gc-divider">
          <p class="gc-hint">
            <strong>FireWally v${VERSION}</strong> — GoCaaS companion overlay for WSS ticket dashboard.<br>
            To add companions, update the MODELS array in the script.<br>
            Set <strong>needsAuth: true</strong> on companions that require Atlassian authorisation.<br>
            Companion IDs: caas.open-webui.godaddy.com/discover?agent=<strong>id</strong>
          </p>
        </div>
      </div>`;
    document.body.appendChild(launcher); document.body.appendChild(panel);
    primeCompanionSelect(panel);
    return{launcher,panel};
  }

  /* ════════════════════════════════════════
     TOAST / STATUS
  ════════════════════════════════════════ */
  let toastTimer;
  function toast(msg,ms=3500){
    let el=document.getElementById('gc-toast');
    if(!el){el=document.createElement('div');el.id='gc-toast';document.body.appendChild(el);}
    el.textContent=msg;el.classList.add('show');
    clearTimeout(toastTimer);toastTimer=setTimeout(()=>el.classList.remove('show'),ms);
  }
  function setStatus(panel,state,text){
    panel.querySelector('#gc-status-bar').className=state;
    panel.querySelector('#gc-status-text').textContent=text;
  }

  /* ════════════════════════════════════════
     CHAT ENGINE
  ════════════════════════════════════════ */
  let chatHistory=[],busy=false;
  let nextFormId = 0;
  let currentHistoryKey = null;

  function ticketHistoryKey(ticket) {
    if (!ticket) return 'unknown';
    return String(ticket.ticketId || ticket.url || ticket.title || 'unknown').slice(0, 120);
  }

  function saveTicketHistory() {
    if (!currentHistoryKey) return;
    try {
      sessionStorage.setItem(STORE_HISTORY + currentHistoryKey, JSON.stringify(chatHistory.slice(-50)));
    } catch (_) {}
  }

  function loadUserPickedFlag(key) {
    try { return sessionStorage.getItem(STORE_PICKED + key) === 'true'; } catch (_) { return false; }
  }

  function saveUserPickedFlag(key, picked) {
    try { sessionStorage.setItem(STORE_PICKED + key, picked ? 'true' : 'false'); } catch (_) {}
  }

  function loadTicketHistory(panel, ticket) {
    const key = ticketHistoryKey(ticket);
    if (key === currentHistoryKey) return;
    saveTicketHistory();
    currentHistoryKey = key;
    userPickedModel = loadUserPickedFlag(key);
    try {
      const saved = sessionStorage.getItem(STORE_HISTORY + key);
      chatHistory = saved ? JSON.parse(saved) : [];
    } catch (_) { chatHistory = []; }
    renderChatFromHistory(panel, ticket);
  }

  function renderChatFromHistory(panel, ticket) {
    const msgs = panel.querySelector('#gc-messages');
    msgs.innerHTML = '';
    if (!chatHistory.length) {
      sysMsg(panel, `Chat for ticket <strong>${escHtml(ticket?.ticketId || '—')}</strong> — history is saved per ticket.`);
      return;
    }
    chatHistory.forEach(m => {
      if (m.role === 'user') addMsg(panel, 'user', md(normalizeContent(m.content)), { skipSave: true });
      else if (m.role === 'assistant') addMsg(panel, 'assistant', md(normalizeContent(m.content)), {
        rawText: normalizeContent(m.content),
        skipSave: true,
        responseMs: m.responseMs,
      });
    });
  }

  function validateFormField(field, value) {
    const label = (field.label || field.name || '').toLowerCase();
    const type = (field.type || '').toLowerCase();
    if (type === 'file') return value ? true : !field.required;
    if (!value) return !field.required;
    if (label.includes('domain') || label.includes('hostname') || label.includes('website')) {
      return /^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i.test(value) || /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(value);
    }
    if (label.includes(' ip') || label.startsWith('ip') || label.includes('address')) {
      return /^\d{1,3}(\.\d{1,3}){3}(\/\d{1,2})?$/.test(value);
    }
    return true;
  }

  function formFieldKey(field, idx) {
    return field.name || field.id || `field_${idx}`;
  }

  function formatFormSubmission(formDef, values) {
    const lines = [];
    (formDef.fields || []).forEach((field, idx) => {
      const val = values[formFieldKey(field, idx)];
      if (val) lines.push(`${field.label}: ${val}`);
    });
    const body = lines.join('\n');
    return formDef.submit_label ? `${formDef.submit_label}\n\n${body}` : body;
  }

  function collectFormValues(formEl, formDef) {
    const values = {};
    let valid = true;
    const errEl = formEl.querySelector('.gc-form-error');
    const fid = formEl.dataset.formId;

    (formDef.fields || []).forEach((field, idx) => {
      const key = formFieldKey(field, idx);
      const fieldWrap = formEl.querySelectorAll('.gc-form-field')[idx];
      fieldWrap?.classList.remove('gc-form-field-error');

      const hasOptions = field.options?.length > 0;
      const useRadio = hasOptions && field.type !== 'select';

      if (useRadio) {
        const checked = formEl.querySelector(`input[name="${fid}-${key}"]:checked`);
        values[key] = checked?.value || '';
      } else if (hasOptions) {
        values[key] = fieldWrap?.querySelector('select')?.value || '';
      } else {
        const fileInput = fieldWrap?.querySelector('input[type="file"]');
        if (fileInput) {
          values[key] = fileInput.files?.[0]?.name || '';
        } else {
          const input = fieldWrap?.querySelector('.gc-form-input, .gc-form-textarea');
          values[key] = input?.value?.trim() || '';
        }
      }

      if (field.required && !values[key]) {
        valid = false;
        fieldWrap?.classList.add('gc-form-field-error');
      } else if (values[key] && !validateFormField(field, values[key])) {
        valid = false;
        fieldWrap?.classList.add('gc-form-field-error');
        if (errEl) { errEl.textContent = `Invalid ${field.label || 'value'}.`; errEl.hidden = false; }
      }
    });

    if (!valid) {
      if (errEl && !errEl.textContent) { errEl.textContent = 'Please fill in all required fields.'; errEl.hidden = false; }
      return null;
    }
    if (errEl) errEl.hidden = true;
    return values;
  }

  function addCompanionForms(panel, wrap, forms) {
    if (!forms?.length) return;
    forms.forEach(formDef => {
      if (!formDef?.fields?.length) return;

      const formEl = document.createElement('form');
      formEl.className = 'gc-form-card';
      const fid = `fw-form-${++nextFormId}`;
      formEl.dataset.formId = fid;

      if (formDef.title) {
        const h = document.createElement('div');
        h.className = 'gc-form-title';
        h.textContent = formDef.title;
        formEl.appendChild(h);
      }
      if (formDef.description) {
        const d = document.createElement('div');
        d.className = 'gc-form-desc';
        d.textContent = formDef.description;
        formEl.appendChild(d);
      }

      const fieldsWrap = document.createElement('div');
      fieldsWrap.className = 'gc-form-fields';

      (formDef.fields || []).forEach((field, idx) => {
        const key = formFieldKey(field, idx);
        const fieldWrap = document.createElement('div');
        fieldWrap.className = 'gc-form-field';
        fieldWrap.dataset.fieldKey = key;

        const label = document.createElement('label');
        label.className = 'gc-form-label';
        label.textContent = field.label || '';
        if (field.required) {
          const req = document.createElement('span');
          req.className = 'gc-form-req';
          req.textContent = ' *';
          label.appendChild(req);
        }
        fieldWrap.appendChild(label);

        const hasOptions = field.options?.length > 0;
        const useRadio = hasOptions && field.type !== 'select';

        if (useRadio) {
          const group = document.createElement('div');
          group.className = 'gc-form-radio-group';
          field.options.forEach(opt => {
            const optLabel = document.createElement('label');
            optLabel.className = 'gc-form-radio-opt';
            const input = document.createElement('input');
            input.type = 'radio';
            input.name = `${fid}-${key}`;
            input.value = String(opt.value ?? opt.label ?? '');
            if (field.required) input.required = true;
            const span = document.createElement('span');
            span.textContent = opt.label || opt.value || '';
            optLabel.appendChild(input);
            optLabel.appendChild(span);
            group.appendChild(optLabel);
          });
          fieldWrap.appendChild(group);
        } else if (hasOptions) {
          const sel = document.createElement('select');
          sel.className = 'gc-form-select';
          if (field.required) sel.required = true;
          const placeholder = document.createElement('option');
          placeholder.value = '';
          placeholder.textContent = field.placeholder || 'Select…';
          sel.appendChild(placeholder);
          field.options.forEach(opt => {
            const o = document.createElement('option');
            o.value = String(opt.value ?? opt.label ?? '');
            o.textContent = opt.label || opt.value || '';
            sel.appendChild(o);
          });
          fieldWrap.appendChild(sel);
        } else {
          const multiline = field.type === 'textarea';
          const isFile = field.type === 'file';
          const input = document.createElement(multiline ? 'textarea' : 'input');
          input.className = multiline ? 'gc-form-textarea' : 'gc-form-input';
          if (isFile) {
            input.type = 'file';
            input.accept = field.accept || '.log,.txt,.csv,.json,.zip';
          } else if (!multiline) {
            input.type = 'text';
          }
          input.placeholder = field.placeholder || '';
          if (field.required) input.required = true;
          if (isFile) {
            input.addEventListener('change', () => {
              const file = input.files?.[0];
              if (file) input.dataset.fileName = file.name;
            });
          }
          fieldWrap.appendChild(input);
        }

        fieldsWrap.appendChild(fieldWrap);
      });

      formEl.appendChild(fieldsWrap);

      const errEl = document.createElement('div');
      errEl.className = 'gc-form-error';
      errEl.hidden = true;
      formEl.appendChild(errEl);

      const submit = document.createElement('button');
      submit.type = 'submit';
      submit.className = 'gc-form-submit';
      submit.textContent = formDef.submit_label || 'Submit';
      formEl.appendChild(submit);

      formEl.addEventListener('submit', async (e) => {
        e.preventDefault();
        if (busy) return;
        const values = collectFormValues(formEl, formDef);
        if (!values) return;
        formEl.classList.add('gc-form-submitted');
        formEl.querySelectorAll('input, select, textarea, button').forEach(el => { el.disabled = true; });
        doSend(panel, formatFormSubmission(formDef, values));
      });

      wrap.appendChild(formEl);
    });
  }

  function extractFollowUps(text) {
    if (!text) return [];
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
    const ups = [];
    for (const line of lines.slice(-8)) {
      const bullet = line.match(/^[-*•]\s+(.+\?)\s*$/);
      const plain = line.match(/^(.+\?)\s*$/);
      const candidate = bullet?.[1] || (plain && !line.startsWith('>') ? plain[1] : null);
      if (candidate && candidate.length < 120) ups.push(candidate);
    }
    return [...new Set(ups)].slice(0, 4);
  }

  function addFollowUpButtons(panel, wrap, text) {
    const followUps = extractFollowUps(text);
    if (!followUps.length) return;
    const row = document.createElement('div');
    row.className = 'gc-followups';
    followUps.forEach(q => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'gc-followup-btn';
      btn.textContent = q.length > 48 ? q.slice(0, 45) + '…' : q;
      btn.title = q;
      btn.addEventListener('click', () => doSend(panel, q));
      row.appendChild(btn);
    });
    wrap.appendChild(row);
  }

  function addMsg(panel, role, html, opts = {}) {
    const options = opts === true ? { thinking: true } : opts;
    const thinking = !!options.thinking;
    const rawText  = options.rawText || '';
    const isError  = rawText.startsWith('❌') || html.includes('❌');

    const msgs = panel.querySelector('#gc-messages');
    const wrap = document.createElement('div');
    wrap.className = `gc-msg ${role}${thinking ? ' gc-thinking' : ''}`;
    const bubble = document.createElement('div');
    bubble.className = 'gc-bubble';
    bubble.innerHTML = thinking
      ? `<div class="gc-progress"><div class="gc-progress-label">Working…</div><div class="gc-progress-track"><div class="gc-progress-fill" style="width:6%"></div></div></div>`
      : html;
    if (!thinking) wireCodeCopyButtons(bubble);
    wrap.appendChild(bubble);

    if (options.forms?.length) {
      addCompanionForms(panel, wrap, options.forms);
    }

    if (role === 'assistant' && !thinking && rawText && !isError && !options.forms?.length) {
      const actions = document.createElement('div');
      actions.className = 'gc-msg-actions';

      const copyFullBtn = document.createElement('button');
      copyFullBtn.className = 'gc-copy-btn';
      copyFullBtn.textContent = '📋 Copy response';
      copyFullBtn.addEventListener('click', () => copyFullResponse(rawText, copyFullBtn));
      actions.appendChild(copyFullBtn);

      const copyReplyBtn = document.createElement('button');
      copyReplyBtn.className = 'gc-copy-btn';
      copyReplyBtn.textContent = '📋 Copy customer reply';
      copyReplyBtn.addEventListener('click', () => copyCustomerReply(rawText, copyReplyBtn));
      actions.appendChild(copyReplyBtn);

      const insertBtn = document.createElement('button');
      insertBtn.className = 'gc-copy-btn gc-insert-btn';
      insertBtn.textContent = '📥 Insert into reply';
      insertBtn.title = 'Put customer-facing reply into the ticket response box';
      insertBtn.addEventListener('click', () => fwInsertCustomerReply(rawText, insertBtn));
      actions.appendChild(insertBtn);

      wrap.appendChild(actions);
      addFollowUpButtons(panel, wrap, rawText);
    }

    if (role === 'assistant' && isError && lastFailedSend) {
      const actions = document.createElement('div');
      actions.className = 'gc-msg-actions';
      const retryBtn = document.createElement('button');
      retryBtn.className = 'gc-retry-btn';
      retryBtn.textContent = '↻ Retry';
      retryBtn.addEventListener('click', () => {
        chatHistory.pop();
        saveTicketHistory();
        doSend(panel, lastFailedSend.text, { isRetry: true });
      });
      actions.appendChild(retryBtn);
      wrap.appendChild(actions);
    }

    const meta = document.createElement('div');
    meta.className = 'gc-meta';
    meta.textContent = formatMsgMeta(role, options.responseMs);
    wrap.appendChild(meta);
    msgs.appendChild(wrap);
    msgs.scrollTop = msgs.scrollHeight;
    if (!options.skipSave && !thinking) saveTicketHistory();
    return { wrap, bubble };
  }
  function sysMsg(panel,text){addMsg(panel,'system-msg',text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'));}

  function startOrSend(panel) {
    if (!isGoCaaSReady()) {
      toast(isApiKeyMode() ? '⚠️ Add your GoCaaS API key in Settings' : '⚠️ Connect GoCaaS first');
      return;
    }

    const input = panel.querySelector('#gc-input');
    const typed = String(input?.value || '').trim();
    const modelId = panel.querySelector('#gc-model-sel')?.value || fwGetDefaultCompanionId();

    // Ticket Response + empty chat → auto seed; Ask anything = additional context only
    if (fwIsResponseCompanion(modelId) && fwChatIsEmpty()) {
      if (!currentContext) refreshContext(panel);
      if (!currentContext) {
        toast('⚠️ No ticket context found');
        return;
      }
      const seed = fwBuildInitialSeedMessage(currentContext, typed, currentTicket);
      if (input) {
        input.value = '';
        autoGrow(input);
      }
      doSend(panel, seed);
      return;
    }

    // All other companions / follow-ups: typed text is the full message
    doSend(panel, typed);
  }

  function doSend(panel, userText, opts = {}) {
    if (busy || !userText.trim()) return;
    if (!isGoCaaSReady()) {
      toast(isApiKeyMode() ? '⚠️ Add your GoCaaS API key in Settings' : '⚠️ Connect GoCaaS first');
      return;
    }
    const modelId = panel.querySelector('#gc-model-sel').value;
    const model = MODELS.find(m => m.id === modelId) || MODELS[0];
    const modelName = model.name;
    const sendBtn = panel.querySelector('#gc-send-btn');
    const cancelBtn = panel.querySelector('#gc-cancel-btn');
    const input = panel.querySelector('#gc-input');
    busy = true;
    oauthPromptShownForRequest = false;
    oauthCompleteNotified = false;
    sendBtn.disabled = true;
    if (cancelBtn) cancelBtn.hidden = false;
    if (!opts.isRetry) input.value = '';
    input.style.height = '';
    setStatus(panel, 'loading', `${modelName} — working…`);
    startStuckWatch(panel);
    if (model.needsAuth) startOAuthStuckWatch(panel, modelId);
    if (!opts.isRetry) {
      addMsg(panel, 'user', md(userText));
      chatHistory.push({ role: 'user', content: userText });
      saveTicketHistory();
    }
    lastFailedSend = { text: userText, modelId };
    const { wrap: tw, bubble } = addMsg(panel, 'assistant', '', { thinking: true });
    progressRef = createResponseProgress(bubble);
    startResponseTiming(panel, modelId);
    startResponseProgressCreep(progressRef);
    activeThinkingWrap = tw;
    const outbound = chatHistory.filter(m =>
      (m.role === 'user' || m.role === 'assistant') && String(m.content || '').trim());
    if (!outbound.some(m => m.role === 'user')) {
      if (opts.isRetry && lastFailedSend?.text) {
        outbound.push({ role: 'user', content: lastFailedSend.text });
        chatHistory.push({ role: 'user', content: lastFailedSend.text });
        saveTicketHistory();
      } else {
        busy = false;
        sendBtn.disabled = false;
        if (cancelBtn) cancelBtn.hidden = true;
        tw.remove();
        toast('⚠️ Type a message first');
        return;
      }
    }
    const ticketId = currentTicket?.ticketId || '';
    const sendFn = isApiKeyMode()
      ? () => sendViaApiKey(modelId, outbound, model.kind, model.needsAuth === true, ticketId)
      : () => sendToGcTab(modelId, outbound, model.kind, model.needsAuth === true, ticketId);
    const preflight = model.kind === 'companion' && !isApiKeyMode()
      ? ensureRelayModel(modelId).then(() => sendFn())
      : sendFn();
    preflight
      .then(reply => {
        const text = typeof reply === 'string' ? reply : (reply?.text || '');
        const forms = typeof reply === 'object' && reply ? (reply.forms || []) : [];
        const responseMs = consumeResponseDurationMs();
        if (responseMs >= 500) recordResponseDuration(modelId, responseMs);
        clearOAuthStuckWatch();
        stopResponseProgress();
        tw.remove();
        activeThinkingWrap = null;
        addMsg(panel, 'assistant', md(text), { rawText: text, forms, responseMs });
        const historyEntry = { role: 'assistant', content: text };
        if (responseMs >= 500) historyEntry.responseMs = responseMs;
        chatHistory.push(historyEntry);
        saveTicketHistory();
        lastFailedSend = null;
        setStatus(panel, 'ready', `${modelName} — ready`);
        busy = false;
        sendBtn.disabled = false;
        if (cancelBtn) cancelBtn.hidden = true;
        clearStuckWatch();
        trackCompanionTicketUsage(modelId, modelName, {
          durationMs: Math.max(0, Math.round(Number(responseMs) || 0)),
          detail: opts.isRetry ? 'retry_first_send' : 'first_send',
        });
        input.focus();
        panel.querySelector('#gc-messages').scrollTop = 99999;
      })
      .catch(err => {
        clearOAuthStuckWatch();
        stopResponseProgress();
        tw.remove();
        activeThinkingWrap = null;
        clearStuckWatch();
        const msg = err?.message || String(err);
        if (msg === 'Cancelled') {
          sysMsg(panel, 'Request cancelled.');
          busy = false;
          sendBtn.disabled = false;
          if (cancelBtn) cancelBtn.hidden = true;
          setStatus(panel, 'ready', `${modelName} — ready`);
          return;
        }
        if (model.kind === 'companion' && isAuthError(msg) && !isAtlassianAuthorized()) {
          chatHistory.pop();
          saveTicketHistory();
          busy = false;
          sendBtn.disabled = false;
          if (cancelBtn) cancelBtn.hidden = true;
          promptAuthIfNeeded(panel);
          return;
        }
        addMsg(panel, 'assistant', md(`❌ ${msg}`), { rawText: `❌ ${msg}` });
        setStatus(panel, 'error', `Error: ${msg.slice(0, 50)}`);
        if (msg.includes('closed') || msg.includes('not open')) { gcTabReady = false; syncConnectUI(); }
        busy = false;
        sendBtn.disabled = false;
        if (cancelBtn) cancelBtn.hidden = true;
      });
  }

  function draftCustomerReply(panel) {
    if (!currentContext) refreshContext(panel);
    switchTab(panel, 'chat');
    const prompt = [
      'Draft a professional, customer-facing email reply for this support ticket.',
      'Be concise, empathetic, and actionable. Do not include internal notes or jargon.',
      '',
      currentContext || '(No ticket context loaded — inject context first.)',
    ].join('\n');
    doSend(panel, prompt);
  }


  /* ════════════════════════════════════════
     COMPANION AUTO-SELECT
  ════════════════════════════════════════ */
  let userPickedModel = false;

  function normalizeHaystack(text) {
    let s = String(text || '')
      .replace(/[\w.+-]+@[\w.-]+\.\w+/g, ' ')
      .replace(/https?:\/\/[^\s<>"']+/gi, ' ')
      .replace(/\bwww\.[^\s<>"']+/gi, ' ');
    for (const m of MODELS) {
      if (m.name) s = s.replace(new RegExp(m.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), ' ');
    }
    return s;
  }

  function ticketHaystack(ticket) {
    const transcript = (ticket.transcript || '')
      .slice(0, 2500)
      .replace(/\n\s*→\s*Status:.*$/gim, ' ');
    const raw = [
      ticket.title, ticket.tags, ticket.status, ticket.queue,
      ticket.description, ticket.notes, transcript,
    ].filter(Boolean).join(' ');
    return normalizeHaystack(raw);
  }

  function ticketPrimaryHaystack(ticket) {
    const raw = [ticket.title, ticket.tags, ticket.description, ticket.notes].filter(Boolean).join(' ');
    return normalizeHaystack(raw);
  }

  function ticketGatewayHaystack(ticket) {
    return ticketPrimaryHaystack(ticket);
  }

  function suggestCompanion(ticket) {
    if (!ticket) return null;
    const primaryHay = ticketPrimaryHaystack(ticket);
    const gatewayHay = ticketGatewayHaystack(ticket);
    const hay = ticketHaystack(ticket);
    const matches = [];
    const PRIMARY_BOOST = 15;
    const GATEWAY_RULE_ID = 'wss--502-error-workflow';

    for (const rule of COMPANION_RULES) {
      for (const pat of rule.patterns) {
        const primary = primaryHay.match(pat);
        if (primary) {
          matches.push({ id: rule.id, priority: rule.priority + PRIMARY_BOOST, reason: rule.label, match: primary[0] });
          break;
        }
        const scopeHay = rule.id === GATEWAY_RULE_ID ? gatewayHay : hay;
        const m = scopeHay.match(pat);
        if (m) {
          matches.push({ id: rule.id, priority: rule.priority, reason: rule.label, match: m[0] });
          break;
        }
      }
    }

    if (ticket.firewallIp || /\bwaf\b/i.test(hay) || /web application firewall/i.test(hay)) {
      matches.push({ id: 'website-security-waf-activation-companion', priority: 96, reason: 'WAF/firewall IP', match: 'firewall IP' });
    }
    if (ticket.hostingIp && !ticket.firewallIp) {
      matches.push({ id: 'wss-hosting-troubleshooting', priority: 75, reason: 'hosting infrastructure' });
    }

    if (!matches.length && /\bbackups?\b/i.test(primaryHay)) {
      matches.push({ id: 'wss---backup-setup-and-troubleshooting', priority: 94, reason: 'backup/restore', match: 'backup' });
    }

    // Trust subject/tags for monitoring — customer replies often mention firewall/cert noise.
    if (/\bmonitoring\b/i.test(primaryHay) || /setup.{0,20}alerts?|alerts? setup/i.test(primaryHay)) {
      matches.push({
        id: 'wss--monitoring-setup--alerts-companion',
        priority: 112,
        reason: 'monitoring/alerts',
        match: (primaryHay.match(/\bmonitoring\b/i) || primaryHay.match(/alerts?/i) || ['monitoring'])[0],
      });
    }

    matches.sort((a, b) => b.priority - a.priority);
    const pick = matches[0] || { id: fwGetDefaultCompanionId(), reason: 'your default companion' };
    const model = MODELS.find(m => m.id === pick.id && m.kind === 'companion');
    if (!model) return null;
    return { id: model.id, name: model.name, reason: pick.reason, match: pick.match || '' };
  }

  function updateModelHint(panel, reason, manual, matchDetail) {
    const hint = panel.querySelector('#gc-model-hint');
    if (!hint) return;
    if (manual || userPickedModel) {
      hint.textContent = '✋ Manual selection — auto-select paused for this ticket';
      hint.className = 'gc-model-hint manual';
    } else if (reason) {
      const detail = matchDetail ? ` (matched “${matchDetail}”)` : '';
      hint.textContent = `🤖 Auto-selected: ${reason}${detail}`;
      hint.className = 'gc-model-hint';
    } else {
      hint.textContent = '';
    }
  }

  function setCompanion(panel, modelId, { userInitiated = false, reason = '', matchDetail = '' } = {}) {
    const sel = panel.querySelector('#gc-model-sel');
    if (!sel) return false;
    const m = MODELS.find(x => x.id === modelId);
    if (!m) return false;

    const changed = sel.value !== modelId;
    if (changed) sel.value = modelId;
    fwUpdateInputPlaceholder(panel);

    if (userInitiated) {
      userPickedModel = true;
      if (currentHistoryKey) saveUserPickedFlag(currentHistoryKey, true);
      if (changed && m.kind === 'companion' && isGoCaaSLinked()) {
        switchCompanion(panel, modelId, { forceNavigate: true });
      }
      updateModelHint(panel, '', true);
      return changed;
    }

    if (changed) {
      sysMsg(panel, `Auto-selected <strong>${m.name}</strong> — ${reason || 'based on ticket content'}.`);
      if (m.kind === 'companion' && isGoCaaSLinked()) {
        switchCompanion(panel, modelId, { forceNavigate: true });
      }
    }
    updateModelHint(panel, reason, false, matchDetail);
    return changed;
  }

  function autoSelectCompanion(panel, ticket) {
    if (!panel || !ticket) return;
    const suggestion = suggestCompanion(ticket);
    if (!suggestion) return;
    const highConfidence = suggestion.reason !== 'your default companion';
    if (userPickedModel && !highConfidence) {
      updateModelHint(panel, suggestion.reason, true, suggestion.match);
      return;
    }
    if (userPickedModel && highConfidence) {
      userPickedModel = false;
      if (currentHistoryKey) saveUserPickedFlag(currentHistoryKey, false);
    }
    setCompanion(panel, suggestion.id, { reason: suggestion.reason, matchDetail: suggestion.match });
  }

  function primeCompanionSelect(panel) {
    if (!panel || userPickedModel) return;
    const ticket = getTicket();
    if (!ticket || !(ticket.title || ticket.tags || ticket.transcript)) return;
    const suggestion = suggestCompanion(ticket);
    if (!suggestion || suggestion.reason === 'your default companion') return;
    const sel = panel.querySelector('#gc-model-sel');
    if (sel && sel.value !== suggestion.id) sel.value = suggestion.id;
  }

  /* ════════════════════════════════════════
     CONTEXT
  ════════════════════════════════════════ */
  let currentTicket=null,currentContext='';

  function applyTicket(panel,ticket){
    if(!ticket)return;
    currentTicket=ticket;currentContext=buildContext(ticket);
    loadTicketHistory(panel, ticket);
    const set=(id,val)=>{const el=panel.querySelector(id);if(!el)return;el.textContent=val||'—';el.classList.toggle('empty',!val);};
    set('#gc-ctx-title',ticket.title);
    set('#gc-ctx-status',ticket.status!==ticket.ticketId?ticket.status:'');
    set('#gc-ctx-tags',ticket.tags);
    set('#gc-ctx-assignments',ticket.assignments);
    set('#gc-ctx-notes',ticket.notes);
    set('#gc-ctx-infra',[
      ticket.siteId    &&`Site: ${ticket.siteId}`,
      ticket.hostingIp &&`Hosting IP: ${ticket.hostingIp}`,
      ticket.firewallIp&&`Firewall IP: ${ticket.firewallIp}`,
      ticket.customerIp&&`Client IP: ${ticket.customerIp}`,
    ].filter(Boolean).join('\n')||'');
    const preview=ticket.transcript
      ?ticket.transcript.substring(0,300)+(ticket.transcript.length>300?'…':'')
      :ticket.description?ticket.description.substring(0,300)+'…':'';
    set('#gc-ctx-desc',preview);
    const srcEl=panel.querySelector('#gc-ctx-source');
    if(srcEl)srcEl.textContent=ticket.source==='ticketData'?'✅ ticketData JSON':'⚠️ DOM fallback';
    autoSelectCompanion(panel, ticket);
    if(!!(ticket.title||ticket.transcript||ticket.siteId))toast('✅ Ticket loaded',2000);
  }

  function refreshContext(panel){
    const ticket=getTicket();applyTicket(panel,ticket);
    if(ticket.source==='dom'){
      let attempts=0;
      const poll=setInterval(()=>{
        attempts++;const d=readTicketData();
        if(d){clearInterval(poll);const t=parseTicket(d);if(t)applyTicket(panel,t);}
        else if(attempts>=10)clearInterval(poll);
      },500);
    }
  }

  function injectContext(panel){
    if(!currentContext)refreshContext(panel);
    if(!currentContext){toast('⚠️ No ticket context found');return;}
    switchTab(panel,'chat');
    const input=panel.querySelector('#gc-input');
    input.value=currentContext;autoGrow(input);input.focus();
    toast('📋 Context loaded — review and hit Send ➤',4000);
  }

  /* ════════════════════════════════════════
     HELPERS
  ════════════════════════════════════════ */
  function switchTab(panel,name){
    panel.querySelectorAll('.gc-tab').forEach(t=>t.classList.toggle('active',t.dataset.tab===name));
    panel.querySelectorAll('.gc-pane').forEach(p=>p.classList.toggle('active',p.id===`gc-pane-${name}`));
  }
  function autoGrow(el){el.style.height='';el.style.height=Math.min(el.scrollHeight,140)+'px';}
  function loadSettings(panel){
    const modeSel = panel.querySelector('#gc-settings-auth-mode');
    if (modeSel) modeSel.value = getAuthMode();
    const apiKeyInput = panel.querySelector('#gc-settings-api-key');
    if (apiKeyInput) {
      const stored = getStoredApiKey();
      apiKeyInput.value = stored;
      apiKeyInput.placeholder = stored ? '••••••••••••••••' : 'sk-… from GoCaaS Settings → Account';
    }
    const apiStatus = panel.querySelector('#gc-settings-apikey-status');
    if (apiStatus) {
      const valid = GM_getValue(STORE_KEY_VALID, '') === 'true';
      if (getStoredApiKey() && valid) apiStatus.textContent = '✅ Last test succeeded';
      else if (getStoredApiKey()) apiStatus.textContent = 'Key saved — click Test to verify';
    }
    syncAuthModeUI(panel);
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
      // Clear in-memory cache so Settings re-reads the page / storage.
      if (!manual) detectedUserEmail = null;
      const detected = getCurrentUserEmail();
      detectedEl.textContent = manual
        ? `Using manual override. Auto-detect would be: ${detected && detected !== manual.toLowerCase() ? detected : '(same or unknown)'}`
        : (detected ? `Auto-detected: ${detected}` : 'Could not auto-detect email — enter manually if needed');
    }
    const url = panel.querySelector('#gc-settings-usage-url');
    if (url) url.value = GM_getValue(STORE_USAGE_URL, '') || '';
    fwPopulateDefaultCompanionSelect(panel);
  }
  function saveSettings(panel){
    const modeSel = panel.querySelector('#gc-settings-auth-mode');
    const prevMode = getAuthMode();
    const newMode = modeSel?.value === 'apikey' ? 'apikey' : 'relay';
    GM_setValue(STORE_AUTH_MODE, newMode);
    const apiKeyInput = panel.querySelector('#gc-settings-api-key');
    const enteredKey = normalizeApiKey(apiKeyInput?.value || '');
    if (enteredKey && !enteredKey.startsWith('•')) {
      GM_setValue(STORE_KEY, enteredKey);
      GM_setValue(STORE_KEY_VALID, 'false');
    }
    syncAuthModeUI(panel);
    syncConnectUI();
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
    const modeMsg = newMode === 'apikey'
      ? (getStoredApiKey() ? ' — API key mode' : ' — API key mode (add key above)')
      : (prevMode !== newMode ? ' — relay mode restored' : '');
    toast(on ? `✅ Settings saved — usage logging on${modeMsg}` : `✅ Settings saved${modeMsg}`);
  }
  function makeDraggable(panel){
    const hdr=panel.querySelector('#gc-header');let ox,oy,sx,sy,drag=false;
    hdr.addEventListener('mousedown',e=>{if(e.target.closest('button'))return;drag=true;const r=panel.getBoundingClientRect();ox=r.left;oy=r.top;sx=e.clientX;sy=e.clientY;e.preventDefault();});
    document.addEventListener('mousemove',e=>{if(!drag)return;panel.style.right='auto';panel.style.left=ox+e.clientX-sx+'px';});
    document.addEventListener('mouseup',()=>{drag=false;});
  }

  /* ════════════════════════════════════════
     INIT
  ════════════════════════════════════════ */
  function init(){
    const{launcher,panel}=createUI();
    globalPanel=panel;makeDraggable(panel);loadSettings(panel);
    let panelOpen=false;

    launcher.addEventListener('click',()=>{
      if(panelOpen){panelOpen=false;panel.classList.add('gc-hidden');}
      else{panelOpen=true;panel.classList.remove('gc-hidden');refreshContext(panel);
        syncConnectUI();
        if (!isApiKeyMode() && autoConnected && !isRelayAlive())
          setTimeout(() => silentReconnect(panel), 300);}
    });
    panel.querySelector('#gc-close-btn').addEventListener('click',()=>{panelOpen=false;panel.classList.add('gc-hidden');});
    panel.querySelector('#gc-popout-btn').addEventListener('click',()=>{
      const modelId = panel.querySelector('#gc-model-sel')?.value || fwGetDefaultCompanionId();
      const tab = restoreCachedRelayTab() || openRelayTab(modelId);
      try { if (tab && !tab.closed) tab.focus(); } catch (_) {}
    });
    panel.querySelector('#gc-connect-btn').addEventListener('click',async()=>{
      const btn=panel.querySelector('#gc-connect-btn');
      const status=panel.querySelector('#gc-conn-status');
      if(btn?.classList.contains('connected'))return;
      reconnectFailed = false;
      stopReconnectCountdown();
      const modelId = panel.querySelector('#gc-model-sel')?.value || fwGetDefaultCompanionId();
      btn.textContent='⏳ Connecting…';status.textContent='● Connecting…';status.className='gc-conn-status connecting';
      setStatus(panel,'loading','Opening GoCaaS tab…');
      try{
        openGcTab(modelId);
        startConnectWait(panel);
        setStatus(panel,'loading','Sign in to GoCaaS if prompted…');
        updateConnectUI(false,'● Waiting for GoCaaS sign-in…');
        try {
          await waitForRelayAlive(CONNECT_WAIT_MS);
          if (pendingConnectPanel) await completeConnect(panel);
        } catch (_) {
          setStatus(panel,'loading','Complete sign-in in GoCaaS — connecting automatically…');
          toast('👋 Sign in to GoCaaS — FireWally will connect when you\'re done', 6000);
        }
      }catch(e){
        stopConnectWait();
        pendingConnectPanel=null;
        updateConnectUI(false,`● Failed: ${e.message.slice(0,50)}`);
        setStatus(panel,'error',e.message.slice(0,60));
        toast(`❌ ${e.message}`,6000);
      }
    });
    panel.querySelector('#gc-model-sel').addEventListener('change',()=>{
      const modelId = panel.querySelector('#gc-model-sel').value;
      setCompanion(panel, modelId, { userInitiated: true });
      const m = MODELS.find(m => m.id === modelId) || MODELS[0];
      setStatus(panel, 'ready', `${m.name} — ready`);
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
    panel.querySelector('#gc-settings-auth-mode')?.addEventListener('change', () => syncAuthModeUI(panel));
    panel.querySelector('#gc-settings-apikey-test')?.addEventListener('click', async () => {
      const input = panel.querySelector('#gc-settings-api-key');
      const statusEl = panel.querySelector('#gc-settings-apikey-status');
      const raw = String(input?.value || '').trim();
      const key = raw.startsWith('•') ? getStoredApiKey() : normalizeApiKey(raw);
      if (!key) {
        toast('⚠️ Enter an API key first', 4000);
        return;
      }
      const formatHint = describeApiKeyFormat(key);
      if (formatHint) toast(`⚠️ ${formatHint}`, 7000);
      if (statusEl) statusEl.textContent = 'Testing…';
      try {
        saveSettings(panel);
        const result = await testApiKeyConnection(key);
        GM_setValue(STORE_KEY_VALID, 'true');
        const via = result.authStyle === 'bearer' ? 'Bearer' : result.authStyle;
        if (statusEl) statusEl.textContent = `✅ Verified via ${via} (${result.path})`;
        syncConnectUI();
        setStatus(panel, 'ready', '✅ API key verified — ready to send');
        toast('✅ GoCaaS API key works', 4000);
      } catch (e) {
        GM_setValue(STORE_KEY_VALID, 'false');
        const errMsg = e.message || 'API key test failed';
        if (statusEl) statusEl.textContent = `❌ ${errMsg.slice(0, 120)}`;
        toast(`❌ ${errMsg}`, 8000);
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

    loadPersistedRelayState();

    if (isApiKeyMode() && isApiKeyReady()) {
      syncConnectUI();
      setStatus(panel, GM_getValue(STORE_KEY_VALID, '') === 'true'
        ? '✅ API key configured — ready to send'
        : '⚙️ API key saved — test in Settings to verify');
    } else if (GM_getValue(STORE_CONNECTED, 'false') === 'true') {
      if (restoreCachedRelayTab() || isRelayAlive()) {
        setTimeout(() => silentReconnect(panel), 400);
      } else {
        markConnected(false);
        syncConnectUI();
      }
    }

    let lastUrl=location.href;
    new MutationObserver(()=>{
      if(location.href!==lastUrl){
        lastUrl=location.href;currentTicket=null;currentContext='';
        currentHistoryKey=null;
        softInvalidateRelayHandles();
        loadPersistedRelayState();
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

  async function silentReconnect(panel) {
    if (!panel || !isGoCaaSLinked() || silentReconnecting) return;
    silentReconnecting = true;
    loadPersistedRelayState();
    try {
      await waitForRelayWithCountdown(panel, RECONNECT_COUNTDOWN_SEC * 1000, 'Reconnecting to GoCaaS');
      syncConnectUI();
      const modelId = panel.querySelector('#gc-model-sel')?.value;
      if (modelId && modelId !== activeRelayModel && !companionSwitchId) {
        await switchCompanion(panel, modelId, { forceNavigate: true });
      } else if (!panel.classList.contains('gc-hidden') && isRelayReady()) {
        setStatus(panel, 'ready', 'Connected — ready');
      }
    } catch (_) {
      stopReconnectCountdown();
      reconnectFailed = true;
      updateConnectUI(false, '● Reconnect timed out — click Reconnect GoCaaS above');
      toast('⏱️ Could not reach GoCaaS — click Reconnect GoCaaS', 5000);
    } finally {
      silentReconnecting = false;
    }
  }

  async function switchCompanion(panel, modelId, { forceNavigate = false } = {}) {
    if (!modelId || !isGoCaaSLinked()) return;
    const m = MODELS.find(x => x.id === modelId);
    if (!m || m.kind !== 'companion') return;
    if (companionSwitchId === modelId) return;

    companionSwitchId = modelId;
    if (panel) setStatus(panel, 'loading', `Loading ${m.name}…`);
    syncConnectUI();

    try {
      const tab = await waitForRelayHandle(20000)
        .catch(() => waitForRelayHandle(0, { allowNamedLookup: true }));
      gcTab = tab;
      await ensureRelayModel(modelId, { forceNavigate });
      activeRelayModel = modelId;
      syncConnectUI();
      if (panel) setStatus(panel, 'ready', `${m.name} — ready`);
    } catch (_) {
      try {
        await waitForRelayHandle(25000);
        await ensureRelayModel(modelId, { forceNavigate: true });
        activeRelayModel = modelId;
        syncConnectUI();
        if (panel) setStatus(panel, 'ready', `${m.name} — ready`);
      } catch (_2) {
        if (panel) setStatus(panel, 'error', 'Could not switch companion — reconnecting…');
        await silentReconnect(panel);
      }
    } finally {
      companionSwitchId = null;
      syncConnectUI();
    }
  }

  async function handleTicketNavigation(panel, panelOpen) {
    if (!isGoCaaSLinked() || reconnectFailed) return;
    softInvalidateRelayHandles();
    loadPersistedRelayState();
    restoreCachedRelayTab();
    if (getRelayTab()) { pingGcTab(); touchRelay(); syncConnectUI(); return; }
    if (!panelOpen) return;
    try {
      await waitForRelayWithCountdown(panel, RECONNECT_COUNTDOWN_SEC * 1000, 'Reconnecting to GoCaaS');
    } catch (_) {
      if (!reconnectFailed && !isRelayAlive()) await silentReconnect(panel);
      else syncConnectUI();
    }
  }

  async function attemptAutoReconnect(panel){
    setStatus(panel,'loading','Reconnecting to GoCaaS…');
    try{
      const modelId = panel.querySelector('#gc-model-sel')?.value || fwGetDefaultCompanionId();
      try {
        await waitForRelayHandle(15000);
      } catch (_) {
        restoreRelayTabRef(true);
      }
      if (!getRelayTab() && !isRelayAlive()) {
        await ensureGcTab(modelId);
      } else if (getRelayTab()) {
        pingGcTab();
        await waitForRelayAlive(18000);
      }
      syncConnectUI();
      setStatus(panel,'ready','Reconnected ✅');
      toast('✅ GoCaaS reconnected');
    }catch(e){
      updateConnectUI(false,'● Auto-reconnect failed — click to retry');
      setStatus(panel,'error','Reconnect failed');
    }
  }

  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);
  else init();
})();