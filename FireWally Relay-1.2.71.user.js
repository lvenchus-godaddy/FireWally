// ==UserScript==
// @name         FireWally Relay
// @namespace    https://caas.open-webui.godaddy.com/
// @version      1.2.72
// @description  FireWally Relay — persistent connection across ticket navigation.
// @author       GoDaddy WSS
// @match        https://caas.open-webui.godaddy.com/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const VERSION = '1.2.72';

  let relayBC = null;
  const BC_CHANNEL = 'firewally-relay-v1';
  const PENDING_MODEL_KEY = 'fw-pending-model';
  const ACTIVE_MODEL_KEY  = 'fw-active-model';
  const TICKET_ORIGINS = [
    'https://admins.gsp-plat.int.gdcorp.tools',
    'http://admins.gsp-plat.int.gdcorp.tools',
  ];
  function isTicketOrigin(origin) {
    if (!origin) return false;
    if (TICKET_ORIGINS.includes(origin)) return true;
    try {
      const host = new URL(origin).hostname.toLowerCase();
      return host === 'admins.gsp-plat.int.gdcorp.tools'
        || host.endsWith('.admins.gsp-plat.int.gdcorp.tools');
    } catch (_) {
      return false;
    }
  }
  const WSS_TOOL_SERVER = 'server:4f829971-888c-4b23-a4b2-aac4074c8df7';

  /* Chat-doc poll fallback when WS misses the final done event (companions). */
  const POLL_DELAY_MS = 1000;
  const POLL_MAX_TRIES = 120; // ~2 min; WS remains primary
  const STABLE_COUNT_TO_FINISH = 3;

  const _origFetch = window.fetch.bind(window);
  const _fetch = _origFetch;

  let currentSessionId  = null;
  let responseReceived  = false;
  let ticketSource      = null;
  let activeAbort       = null;
  let pollGeneration    = 0;
  /** Reuse GoCaaS chats: key = ticketId|modelId → { chatId, currentId } */
  const chatCache = Object.create(null);
  const _contentTracker = {};
  const _chunkNotifyState = {};

  function normalizeContent(content) {
    if (content == null) return '';
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content.map(p => {
        if (typeof p === 'string') return p;
        if (p?.type === 'text') return p.text || '';
        if (p?.type === 'image_url') return '[image attached]';
        return '';
      }).filter(Boolean).join('\n');
    }
    if (typeof content === 'object' && content.text != null) return String(content.text);
    return String(content);
  }

  try { relayBC = new BroadcastChannel(BC_CHANNEL); } catch (_) {}

  function uid() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
  }

  function buildChatStructure(modelId, messages) {
    const ts = Math.floor(Date.now() / 1000);
    const historyMessages = {};
    let prevId = null;
    const flatList = [];

    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      const id = uid();
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

    const assistantMsgId = uid();
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

  function chatCacheKey(ticketId, modelId) {
    const tid = String(ticketId || '').trim() || '_none';
    return `${tid}|${modelId || ''}`;
  }

  function companionShortName(modelId) {
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
    const parts = id.split(/-+/).filter(Boolean);
    return parts[parts.length - 1] || id.slice(0, 24) || 'Companion';
  }

  function fireWallyChatTitle(modelId, ticketId) {
    const name = companionShortName(modelId);
    const tid = String(ticketId || '').trim();
    return tid ? `FireWally · ${name} · ${tid}` : `FireWally · ${name}`;
  }

  function getCachedChat(ticketId, modelId) {
    return chatCache[chatCacheKey(ticketId, modelId)] || null;
  }

  function setCachedChat(ticketId, modelId, chatId, currentId) {
    chatCache[chatCacheKey(ticketId, modelId)] = { chatId, currentId, updatedAt: Date.now() };
  }

  function clearCachedChat(ticketId, modelId) {
    delete chatCache[chatCacheKey(ticketId, modelId)];
  }

  async function createChatSession(modelId, messages, ticketId) {
    const { flatList, historyMessages, assistantMsgId } = buildChatStructure(modelId, messages);
    const title = fireWallyChatTitle(modelId, ticketId);
    const body = {
      chat: {
        title,
        models: [modelId],
        messages: flatList,
        history: { currentId: assistantMsgId, messages: historyMessages },
      },
    };

    for (const endpoint of ['/api/v1/chats/new', '/api/chats/new']) {
      try {
        const r = await _fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify(body),
        });
        const raw = await r.text();
        dbg('fetch', 'NEW CHAT', `${endpoint} HTTP ${r.status} | ${raw.slice(0, 120)}`);
        if (!r.ok) continue;
        const j = JSON.parse(raw);
        const chatId = j.id || j.chat?.id;
        if (chatId) {
          setCachedChat(ticketId, modelId, chatId, assistantMsgId);
          return { chatId, assistantMsgId, reused: false };
        }
      } catch (e) {
        dbg('error', 'NEW CHAT', `${endpoint}: ${e.message}`);
      }
    }
    throw new Error('Could not create GoCaaS chat session');
  }

  async function appendChatSession(chatId, modelId, messages, parentId, ticketId) {
    const lastUser = [...(messages || [])].reverse().find(m => m.role === 'user');
    if (!lastUser) throw new Error('No user message to append');
    if (!parentId) throw new Error('Missing parent message id for chat reuse');

    const userMsgId = uid();
    const assistantMsgId = uid();
    const ts = Math.floor(Date.now() / 1000);
    const body = {
      chat: {
        title: fireWallyChatTitle(modelId, ticketId),
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
        const r = await _fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify(body),
        });
        const raw = await r.text();
        dbg('fetch', 'UPDATE CHAT', `${endpoint} HTTP ${r.status} | ${raw.slice(0, 120)}`);
        if (r.status === 404 || r.status === 401) return null;
        if (!r.ok) continue;
        setCachedChat(ticketId, modelId, chatId, assistantMsgId);
        return { chatId, assistantMsgId, reused: true };
      } catch (e) {
        dbg('error', 'UPDATE CHAT', `${endpoint}: ${e.message}`);
      }
    }
    return null;
  }

  async function prepareChatSession(modelId, messages, ticketId) {
    const cached = getCachedChat(ticketId, modelId);
    if (cached?.chatId && cached?.currentId) {
      const updated = await appendChatSession(
        cached.chatId, modelId, messages, cached.currentId, ticketId
      );
      if (updated) {
        dbg('ok', 'CHAT REUSE', `chat_id=${updated.chatId} ticket=${ticketId || '_none'}`, true);
        return updated;
      }
      dbg('info', 'CHAT REUSE FAIL', `clearing cache for ${chatCacheKey(ticketId, modelId)}`);
      clearCachedChat(ticketId, modelId);
    }
    return createChatSession(modelId, messages, ticketId);
  }

  /* ════════════════════ USER INFO ════════════════════ */
  function getUserEmail() {
    try {
      for (const key of ['user','auth','session','token']) {
        const stored = localStorage.getItem(key);
        if (!stored) continue;
        const parsed = JSON.parse(stored);
        const email  = parsed?.email || parsed?.user?.email || parsed?.data?.email;
        if (email && email.includes('@')) return email;
      }
    } catch(_) {}
    return '';
  }

  function getUserName() {
    try {
      for (const key of ['user','auth','session','token']) {
        const stored = localStorage.getItem(key);
        if (!stored) continue;
        const parsed = JSON.parse(stored);
        const name   = parsed?.name || parsed?.user?.name || parsed?.data?.name;
        if (name) return name;
        const email  = parsed?.email || parsed?.user?.email;
        if (email) return email.split('@')[0];
      }
    } catch(_) {}
    return 'Analyst';
  }

  function getNow() {
    const now  = new Date();
    const pad  = n => String(n).padStart(2,'0');
    const date = `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}`;
    const time = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
    const days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    return { date, time, datetime:`${date} ${time}`, weekday:days[now.getDay()], tz:Intl.DateTimeFormat().resolvedOptions().timeZone||'Unknown' };
  }

  function collectUrls(fragment) {
    const urls = new Set();
    if (!fragment) return urls;
    for (const m of fragment.matchAll(/https?:\/\/[^\s<>"')\]]+/g)) urls.add(m[0].replace(/[.,;:!?)]+$/, ''));
    for (const m of fragment.matchAll(/href=["'](https?:\/\/[^"']+)["']/gi)) urls.add(m[1]);
    return urls;
  }

  function stripInlineHtmlTags(s) {
    return String(s)
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/<\/p>\s*<p[^>]*>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

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

  function unwrapDetailsPreservingUrls(text) {
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

  /* ════════════════════════════════════════
     TOOL CALL PROCESSOR
     Extracts request_user_input forms for FireWally UI.
  ════════════════════════════════════════ */
  function parseRequestUserInputArgs(argsRaw) {
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

  function processToolCalls(text) {
    if (!text) return { text: '', forms: [] };
    const forms = [];

    text = text.replace(
      /<details[^>]*name=["']request_user_input["'][^>]*arguments="([^"]*)"[^>]*>[\s\S]*?<\/details>/gi,
      (match, argsRaw) => {
        try {
          forms.push(parseRequestUserInputArgs(argsRaw));
          return '';
        } catch (_) {
          return '';
        }
      }
    );

    return {
      text: stripToolExecutedArtifacts(
        unwrapDetailsPreservingUrls(text).replace(/\n{3,}/g, '\n\n').trim()
      ),
      forms,
    };
  }

  function coalesceContent(c, depth) {
    depth = depth || 0;
    if (depth > 10 || c == null) return '';
    if (typeof c === 'string') return c;
    if (Array.isArray(c)) return c.map(x => coalesceContent(x, depth + 1)).join('');
    if (typeof c === 'object') {
      if (typeof c.text === 'string') return c.text;
      if (typeof c.content === 'string') return c.content;
      if (c.content != null) return coalesceContent(c.content, depth + 1);
    }
    return '';
  }

  function extractAssistantTextByMessageId(chatJson, assistantMessageId) {
    if (!assistantMessageId) return '';
    const chat = chatJson?.chat || (Array.isArray(chatJson?.messages) ? chatJson : null);
    if (!chat) return '';
    const hist = chat.history?.messages;
    if (hist && typeof hist === 'object' && !Array.isArray(hist)) {
      const hm = hist[assistantMessageId];
      if (hm) {
        const t = coalesceContent(hm.content) || coalesceContent(hm.text) || '';
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
          const t = coalesceContent(m.content) || coalesceContent(m.text) || '';
          if (String(t).trim()) return String(t).trim();
        }
      }
    }
    return '';
  }

  async function fetchChatDocument(chatId) {
    for (const endpoint of [`/api/v1/chats/${chatId}`, `/api/chats/${chatId}`]) {
      try {
        const r = await _fetch(endpoint, { method: 'GET', credentials: 'include' });
        if (!r.ok) continue;
        return JSON.parse(await r.text());
      } catch (e) {
        dbg('error', 'GET CHAT', `${endpoint}: ${e.message}`);
      }
    }
    return null;
  }

  async function pollChatForAssistant(chatId, assistantMessageId, gen) {
    let tries = 0, last = '', stable = 0;
    while (tries < POLL_MAX_TRIES) {
      tries += 1;
      if (gen !== pollGeneration || responseReceived) return '';
      const json = await fetchChatDocument(chatId);
      const text = (json ? extractAssistantTextByMessageId(json, assistantMessageId) : '').trim();
      if (text) {
        if (text === last) {
          stable += 1;
          if (stable >= STABLE_COUNT_TO_FINISH) return last;
        } else {
          last = text;
          stable = 1;
        }
      }
      await new Promise(r => setTimeout(r, POLL_DELAY_MS));
    }
    return last;
  }

  async function waitForCompanionViaPoll(chatSession) {
    if (!chatSession?.chatId || !chatSession?.assistantMsgId) return;
    const gen = pollGeneration;
    dbg('ok', 'POLL START', `chat=${chatSession.chatId} msg=${chatSession.assistantMsgId}`);
    setSt('Waiting for WS + chat poll…', 'wait');
    const polled = await pollChatForAssistant(chatSession.chatId, chatSession.assistantMsgId, gen);
    if (gen !== pollGeneration || responseReceived) return;
    if (polled) {
      responseReceived = true;
      const processed = processToolCalls(polled);
      sendToOpener({ type: 'gc-response', text: processed.text || '', forms: processed.forms });
      setSt('Response sent ✅ (poll)', 'ok');
      dbg('ok', '✅ POLL RESPONSE', processed.text.slice(0, 120), true);
    } else {
      sendToOpener({ type: 'gc-error', error: 'Timed out waiting for companion response (WS + chat poll).' });
      setSt('Timeout', 'err');
      dbg('error', 'POLL TIMEOUT', `chat=${chatSession.chatId}`);
    }
  }

  /* ════════════════════ DEBUG PANEL ════════════════════ */
  let debugPanel, debugLog, logCount = 0;

  function createDebugPanel() {
    if (document.getElementById('fw-relay-panel')) return;
    const style = document.createElement('style');
    style.textContent = `
      #fw-relay-panel{position:fixed;bottom:16px;left:16px;width:460px;max-height:340px;background:#0a0c1a;border:1px solid #2a3060;border-radius:10px;box-shadow:0 8px 32px rgba(0,0,0,.6);z-index:2147483647;font-family:'Consolas','Fira Code',monospace;font-size:11px;display:flex;flex-direction:column;overflow:hidden;}
      #fw-rh{display:flex;align-items:center;padding:7px 12px;background:#10142a;border-bottom:1px solid #1a1e38;flex-shrink:0;gap:8px;}
      #fw-rh .t{color:#7ec8ff;font-weight:700;font-size:12px;flex:1;}
      #fw-rh .s{font-size:10px;padding:2px 8px;border-radius:10px;background:#1a1e38;color:#445;}
      #fw-rh .s.ok{background:#1a3a20;color:#3dbb5a;}
      #fw-rh .s.wait{background:#3a2a00;color:#e0a030;animation:rp 1s infinite;}
      #fw-rh .s.err{background:#3a1010;color:#ff5555;}
      #fw-rh button{background:none;border:none;color:#445;cursor:pointer;font-size:13px;padding:0 4px;}
      #fw-rh button:hover{color:#aaa;}
      @keyframes rp{0%,100%{opacity:1}50%{opacity:.4}}
      #fw-rl{flex:1;overflow-y:auto;padding:8px 12px;display:flex;flex-direction:column;gap:2px;}
      #fw-rl::-webkit-scrollbar{width:4px;}
      #fw-rl::-webkit-scrollbar-thumb{background:#1e2248;border-radius:4px;}
      .fe{padding:2px 0;border-bottom:1px solid #0e1020;line-height:1.4;}
      .fe .ft{color:#2a3060;margin-right:5px;}
      .fe.info .fk{color:#5588ff;} .fe.ws .fk{color:#aa55ff;} .fe.fetch .fk{color:#55aaff;}
      .fe.send .fk{color:#55ffaa;} .fe.relay .fk{color:#ffaa55;} .fe.error .fk{color:#ff5555;}
      .fe.ok .fk{color:#55ff88;} .fe .fb{color:#7080a0;word-break:break-all;}
      .fe .fc{color:#aaffaa;word-break:break-all;font-weight:600;}
      #fw-rf{padding:5px 12px;background:#10142a;border-top:1px solid #1a1e38;flex-shrink:0;display:flex;gap:6px;align-items:center;}
      #fw-rf .sid{font-size:9px;color:#334;flex:2;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
      #fw-rf button{flex:1;padding:4px 0;border:none;border-radius:6px;font-size:10px;font-weight:600;cursor:pointer;background:#1a1e38;color:#5566aa;}
      #fw-rf button:hover{background:#252850;color:#88aaff;}
    `;
    document.head.appendChild(style);
    debugPanel = document.createElement('div');
    debugPanel.id = 'fw-relay-panel';
    debugPanel.innerHTML = `
      <div id="fw-rh">
        <span class="t">🔥 FireWally Relay v${VERSION}</span>
        <span class="s ok" id="fw-rs">Ready</span>
        <button id="fw-rc">🗑</button>
        <button id="fw-rm">−</button>
      </div>
      <div id="fw-rl"></div>
      <div id="fw-rf">
        <span class="sid" id="fw-sid">session: waiting…</span>
        <button id="fw-rcp">📋 Copy</button>
        <button id="fw-rsig">📡 Signal</button>
      </div>`;
    document.body.appendChild(debugPanel);
    debugLog = document.getElementById('fw-rl');
    document.getElementById('fw-rc').onclick  = () => { debugLog.innerHTML=''; logCount=0; };
    document.getElementById('fw-rm').onclick  = () => {
      const l=document.getElementById('fw-rl'),f=document.getElementById('fw-rf'),b=document.getElementById('fw-rm');
      const h=l.style.display==='none'; l.style.display=h?'':'none'; f.style.display=h?'':'none'; b.textContent=h?'−':'+';
    };
    document.getElementById('fw-rcp').onclick = () =>
      navigator.clipboard.writeText([...debugLog.querySelectorAll('.fe')].map(e=>e.innerText).join('\n')).catch(()=>{});
    document.getElementById('fw-rsig').onclick = signalReady;
  }

  function dbg(type, tag, body, isContent=false) {
    if (!debugLog) return;
    if (++logCount > 500) debugLog.firstChild?.remove();
    const now = new Date().toLocaleTimeString([],{hour:'2-digit',minute:'2-digit',second:'2-digit'});
    const row = document.createElement('div');
    row.className = `fe ${type}`;
    row.innerHTML = `<span class="ft">${now}</span><span class="fk">[${tag}]</span> <span class="${isContent?'fc':'fb'}">${esc(String(body).slice(0,400))}</span>`;
    debugLog.appendChild(row); debugLog.scrollTop=debugLog.scrollHeight;
  }
  const esc = s => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  function setSt(txt, cls='ok') { const e=document.getElementById('fw-rs'); if(e){e.textContent=txt;e.className=`s ${cls}`;} }
  function setSession(id) {
    currentSessionId = id;
    const e = document.getElementById('fw-sid');
    if (e) e.textContent = `session: ${id}`;
    dbg('ok', 'SESSION', `sid=${id}`, true);
    signalPendingModelReady();
    sendToOpener({ type: 'gc-heartbeat', relayVersion: VERSION });
  }

  function getActiveModel() {
    return sessionStorage.getItem(ACTIVE_MODEL_KEY) || '';
  }

  function setActiveModel(modelId) {
    if (modelId) sessionStorage.setItem(ACTIVE_MODEL_KEY, modelId);
  }

  function pageHasModel(modelId) {
    const q = window.location.search;
    return q.includes(`model=${modelId}`) || q.includes(`models=${modelId}`);
  }

  function signalPendingModelReady() {
    if (!currentSessionId) return;
    const pending = sessionStorage.getItem(PENDING_MODEL_KEY);
    if (pending) {
      sessionStorage.removeItem(PENDING_MODEL_KEY);
      setActiveModel(pending);
      sendToOpener({ type: 'gc-model-ready', modelId: pending });
      dbg('ok', 'MODEL READY', pending, true);
      return;
    }
    const active = getActiveModel();
    if (active) {
      sendToOpener({ type: 'gc-model-ready', modelId: active });
      dbg('ok', 'MODEL READY', `${active} (cached)`, true);
    }
  }

  /* ════════════════════ WEBSOCKET INTERCEPTOR ════════════════════ */
  const _WS = window.WebSocket;

  window.WebSocket = function(url, protocols) {
    const ws = protocols ? new _WS(url, protocols) : new _WS(url);

    ws.addEventListener('open',  () => dbg('ws','WS OPEN',url.slice(-50)));
    ws.addEventListener('close', e  => dbg('ws','WS CLOSE',`code=${e.code}`));
    ws.addEventListener('error', () => dbg('error','WS ERR','error'));

    ws.addEventListener('message', (event) => {
      const raw = typeof event.data==='string' ? event.data : '';
      if (!raw) return;
      const frameNum = raw.match(/^(\d+)/)?.[1]||'';

      if (frameNum==='40') {
        try { const j=JSON.parse(raw.replace(/^\d+/,'')); if(j?.sid) setSession(j.sid); } catch(_){}
        return;
      }
      if (frameNum==='0'||frameNum==='2'||frameNum==='3') return;

      try {
        const jsonStr = raw.replace(/^\d+/,'');
        if (!jsonStr.startsWith('[')&&!jsonStr.startsWith('{')) return;

        const parsed  = JSON.parse(jsonStr);
        const evtName = Array.isArray(parsed) ? parsed[0] : '?';
        const payload = Array.isArray(parsed) ? parsed[1] : parsed;
        if (!payload) return;

        if (evtName==='chat-events'||evtName==='message') {
          const innerType = payload?.data?.type;
          const innerData = payload?.data?.data;
          const chatId    = payload?.chat_id || 'default';

          // ── Complete response ──
          if (innerType==='chat:completion' && innerData?.done===true) {
            const finalContent   = innerData?.content || '';
            const trackedContent = _contentTracker[chatId] || '';
            delete _contentTracker[chatId];
            clearStreamChunkState(chatId);

            // Use whichever is richer — tracked content may contain
            // tool call blocks that disappear from the final done event
            let content = trackedContent.length > finalContent.length
              ? trackedContent
              : finalContent;

            dbg('info','CONTENT',`final=${finalContent.length} tracked=${trackedContent.length} using=${content.length} hasTool=${content.includes('<details')}`);

            const processed = processToolCalls(content);

            if ((processed.text || processed.forms.length) && !responseReceived) {
              responseReceived = true;
              dbg('ok','✅ RESPONSE',`${processed.text.slice(0,120)} forms=${processed.forms.length}`,true);
              sendToOpener({ type: 'gc-response', text: processed.text || '', forms: processed.forms });
              setSt('Response sent ✅','ok');
            }
            return;
          }

          // ── Streaming chunks — track richest content seen ──
          if (innerType==='chat:completion' && innerData?.content && !innerData?.done) {
            const fullSoFar = innerData.content;
            const prev      = _contentTracker[chatId] || '';
            if (fullSoFar.length >= prev.length) {
              _contentTracker[chatId] = fullSoFar;
            }
            if (fullSoFar.includes('<details')) {
              dbg('info','CHUNK+TOOL',`len=${fullSoFar.length}`);
            }
            notifyStreamChunk(chatId, fullSoFar);
            return;
          }

          // ── Error / cancel ──
          if (innerType==='chat:message:error'||innerType==='chat:tasks:cancel') {
            dbg('error','ERROR DETAIL',JSON.stringify(innerData||{}).slice(0,400));
            const errObj = innerData?.error;
            const errMsg = (typeof errObj==='string')
              ? errObj
              : (errObj?.content||errObj?.message||innerData?.message||
                (typeof innerData==='string'?innerData:innerType));
            dbg('error','TASK ERROR',String(errMsg));
            setSt(`Error: ${String(errMsg).slice(0,40)}`,'err');
            if (!responseReceived) {
              responseReceived = true;
              sendToOpener({type:'gc-error',error:String(errMsg)});
            }
            delete _contentTracker[chatId];
            clearStreamChunkState(chatId);
            return;
          }

          // ── Status ──
          if (innerType==='status') {
            const action      = innerData?.action      || '';
            const description = innerData?.description || '';
            const done        = innerData?.done;
            const label       = description || action;
            dbg('info','STATUS',`${label} done=${done}`);
            setSt((label.slice(0,38)||'Working')+(done?' ✅':'…'),done?'ok':'wait');
            sendToOpener({type:'gc-status',label,done:!!done,action,description});
          }
        }
      } catch(e) {
        dbg('error','WS PARSE',e.message);
      }
    });

    return ws;
  };
  window.WebSocket.prototype = _WS.prototype;
  Object.keys(_WS).forEach(k=>{try{window.WebSocket[k]=_WS[k];}catch(_){}});

  function notifyStreamChunk(chatId, fullSoFar) {
    const hasTool = fullSoFar.includes('<details');
    const state = _chunkNotifyState[chatId] || { started: false, tool: false, lastAt: 0 };
    const now = Date.now();
    const emit = (phase) => {
      sendToOpener({
        type: 'gc-chunk',
        phase,
        hasTool: phase === 'tool' || hasTool,
        contentLength: fullSoFar.length,
      });
      state.lastAt = now;
      _chunkNotifyState[chatId] = state;
    };

    if (fullSoFar.length > 20 && !state.started) {
      state.started = true;
      emit('stream');
    }
    if (hasTool && !state.tool) {
      state.tool = true;
      emit('tool');
    } else if (state.started && now - state.lastAt > 8000) {
      emit('stream');
    }
  }

  function clearStreamChunkState(chatId) {
    if (chatId) delete _chunkNotifyState[chatId];
    else {
      for (const k of Object.keys(_chunkNotifyState)) delete _chunkNotifyState[k];
    }
  }

  function validChatMessages(messages) {
    return (messages || [])
      .map(m => ({ role: m.role, content: normalizeContent(m.content) }))
      .filter(m => (m.role === 'user' || m.role === 'assistant') && String(m.content || '').trim());
  }

  /* ════════════════════ PAYLOAD BUILDER ════════════════════ */
  function buildChatPayload(modelId, modelKind, messages, chatSession, needsAuth) {
    const chatMessages = validChatMessages(messages);
    const base = {
      model:      modelId,
      messages:   chatMessages,
      stream:     true,
      session_id: currentSessionId,
      params:     {},
    };

    if (chatSession?.chatId) {
      base.chat_id = chatSession.chatId;
      base.id = chatSession.assistantMsgId;
    }

    if (modelKind === 'llm') return base;

    const now = getNow();
    const variables = {
      '{{USER_NAME}}':        getUserName(),
      '{{USER_EMAIL}}':       getUserEmail(),
      '{{USER_LOCATION}}':    'Unknown',
      '{{USER_LANGUAGE}}':    'en-US',
      '{{CURRENT_DATE}}':     now.date,
      '{{CURRENT_TIME}}':     now.time,
      '{{CURRENT_DATETIME}}': now.datetime,
      '{{CURRENT_WEEKDAY}}':  now.weekday,
      '{{CURRENT_TIMEZONE}}': now.tz,
    };

    if (!needsAuth) {
      return {
        ...base,
        sdm_mode:     true,
        tool_ids:     [],
        tool_servers: [],
        features: {
          image_generation: false,
          code_interpreter: false,
          web_search:       false,
          deep_research:    false,
          memory:           false,
        },
        background_tasks: { follow_up_generation: false },
        variables,
      };
    }

    return {
      ...base,
      sdm_mode:     true,
      tool_ids:     [WSS_TOOL_SERVER],
      tool_servers: [],
      features: {
        image_generation: false,
        code_interpreter: true,
        web_search:       true,
        deep_research:    false,
        memory:           true,
      },
      background_tasks: { follow_up_generation: true },
      variables,
    };
  }

  async function handleTicketCommand(data, source) {
    if (source) ticketSource = source;
    const { type, modelId, modelKind, needsAuth, messages, ticketId } = data || {};

    if (type === 'gc-ping') {
      if (source) ticketSource = source;
      sendToOpener({ type: 'gc-pong', pingId: data.pingId ?? null, sentAt: data.sentAt ?? Date.now() });
      return;
    }

    if (type === 'gc-cancel') {
      activeAbort?.abort();
      activeAbort = null;
      responseReceived = true;
      pollGeneration += 1;
      setSt('Cancelled', 'err');
      dbg('info', 'CANCEL', 'request aborted');
      return;
    }

    if (type === 'gc-switch-model') {
      if (!modelId) return;
      dbg('info', 'SWITCH MODEL', modelId);
      if (getActiveModel() === modelId && currentSessionId && pageHasModel(modelId)) {
        sendToOpener({ type: 'gc-model-ready', modelId });
        return;
      }
      sessionStorage.setItem(PENDING_MODEL_KEY, modelId);
      setActiveModel(modelId);
      currentSessionId = null;
      window.location.href = `/?model=${encodeURIComponent(modelId)}`;
      return;
    }

    if (type !== 'gc-send') return;

    if (!currentSessionId) {
      dbg('error','NO SESSION','session_id not captured yet');
      sendToOpener({type:'gc-error',error:'Session not ready — wait a moment and try again.'});
      return;
    }

    const kind = modelKind || 'companion';
    const useAuth = needsAuth === true;
    const chatMessages = validChatMessages(messages);
    if (!chatMessages.some(m => m.role === 'user')) {
      dbg('error', 'NO MSG', 'no user messages in payload');
      sendToOpener({ type: 'gc-error', error: 'No message to send — type a message and try again.' });
      setSt('No message', 'err');
      return;
    }
    dbg('send','RECV',`model=${modelId} kind=${kind} auth=${useAuth} ticket=${ticketId || '_none'} active=${getActiveModel()} session=${currentSessionId} msgs=${chatMessages.length}`);
    setSt('Sending…','wait');
    responseReceived = false;
    pollGeneration += 1;
    const thisPollGen = pollGeneration;
    clearStreamChunkState();

    let chatSession = null;
    if (kind === 'companion') {
      try {
        chatSession = await prepareChatSession(modelId, chatMessages, ticketId);
        dbg('ok', 'CHAT SESSION', `chat_id=${chatSession.chatId} reused=${!!chatSession.reused}`, true);
      } catch (e) {
        dbg('error', 'CHAT SESSION', e.message);
        sendToOpener({ type: 'gc-error', error: e.message });
        setSt('Chat session error', 'err');
        return;
      }
    }

    const payload = buildChatPayload(modelId, kind, chatMessages, chatSession, useAuth);
    if (kind === 'companion') setActiveModel(modelId);
    dbg('fetch','POST',`kind=${kind} chat_id=${chatSession?.chatId || 'none'} session=${currentSessionId}`);

    activeAbort?.abort();
    activeAbort = new AbortController();
    try {
      const r   = await _fetch('/api/chat/completions',{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        credentials:'include',
        body:JSON.stringify(payload),
        signal: activeAbort.signal,
      });
      const raw = await r.text();
      dbg('fetch','RESP',`HTTP ${r.status} | ${raw.slice(0,150)}`);

      if (r.status<200||r.status>=300) {
        let msg=`HTTP ${r.status}`;
        try{msg=JSON.parse(raw)?.detail||msg;}catch(_){}
        sendToOpener({type:'gc-error',error:msg});
        setSt(`Error: ${msg.slice(0,40)}`,'err');
        return;
      }

      const needsWsWait = !raw || raw.trim() === 'null' || raw.trim() === '';
      let taskQueued = false;
      let inlineContent = null;

      if (!needsWsWait) {
        try {
          const j = JSON.parse(raw);
          if (j?.task_id) {
            taskQueued = true;
            dbg('ok','TASK',`id=${j.task_id} — watching WS`);
          } else {
            inlineContent = j?.choices?.[0]?.message?.content ?? j?.content ?? null;
          }
        } catch (_) {}
      }

      if (inlineContent && !responseReceived) {
        responseReceived = true;
        const processed = processToolCalls(inlineContent);
        sendToOpener({ type: 'gc-response', text: processed.text || '', forms: processed.forms });
        setSt('Response sent ✅','ok');
        return;
      }

      if (needsWsWait || taskQueued) {
        if (needsWsWait) {
          dbg('ok','NULL RESP','Waiting for WebSocket response…');
          setSt('Waiting for WS response…','wait');
        } else {
          setSt('Task queued — watching WS…','wait');
        }
        if (kind === 'companion' && chatSession?.chatId && chatSession?.assistantMsgId && thisPollGen === pollGeneration) {
          waitForCompanionViaPoll(chatSession);
        }
        return;
      }

    } catch(e) {
      if (e?.name === 'AbortError') {
        dbg('info', 'ABORT', 'fetch cancelled');
        return;
      }
      dbg('error','ERR',e.message);
      sendToOpener({type:'gc-error',error:e.message});
      setSt('Error','err');
    } finally {
      activeAbort = null;
    }
  }

  /* ════════════════════ MESSAGE LISTENER ════════════════════ */
  window.addEventListener('message', (event) => {
    if (!isTicketOrigin(event.origin)) return;
    if (event.source) ticketSource = event.source;
    handleTicketCommand(event.data || {}, event.source);
  });

  relayBC?.addEventListener('message', (event) => {
    const data = event.data || {};
    if (data.origin !== 'firewally-ticket') return;
    handleTicketCommand(data, null);
  });

  /* ════════════════════ HELPERS ════════════════════ */
  function collectTicketTargets() {
    const targets = [];
    const seen = new Set();
    const add = (t) => {
      if (!t) return;
      try { if (t.closed) return; } catch (_) {}
      if (seen.has(t)) return;
      seen.add(t);
      targets.push(t);
    };
    try {
      if (window.opener && !window.opener.closed) {
        ticketSource = window.opener;
        add(window.opener);
        try { add(window.opener.top); } catch (_) {}
        try {
          if (window.opener.frames) {
            for (let i = 0; i < window.opener.frames.length; i++) add(window.opener.frames[i]);
          }
        } catch (_) {}
      }
    } catch (_) {}
    add(ticketSource);
    return targets;
  }

  function sendToOpener(msg) {
    const envelope = { ...msg, origin: 'firewally-relay', ts: Date.now() };
    try { relayBC?.postMessage(envelope); } catch (_) {}
    try {
      if (window.opener && !window.opener.closed) ticketSource = window.opener;
    } catch (_) {}
    const targets = collectTicketTargets();
    if (!targets.length) { dbg('error','NO OPENER','no ticket window to send to'); return; }
    const origins = [...TICKET_ORIGINS, '*'];
    for (const target of targets) {
      for (const origin of origins) {
        try { target.postMessage(msg, origin); dbg('relay','→ TICKET',`type=${msg.type}`); }
        catch(e) { dbg('error','POST ERR',e.message); }
      }
    }
  }

  function signalReady() {
    sendToOpener({ type: 'gc-relay-ready', relayVersion: VERSION });
    sendToOpener({ type: 'gc-heartbeat', relayVersion: VERSION });
    setSt('Ready ✅', 'ok');
    dbg('relay', 'SIGNAL', 'gc-relay-ready sent');
  }

  /* ════════════════════ INIT ════════════════════ */
  function init() {
    createDebugPanel();
    const urlModel = new URLSearchParams(window.location.search).get('model')
      || new URLSearchParams(window.location.search).get('models');
    if (urlModel) setActiveModel(urlModel);
    dbg('info','FIREWALLY RELAY',`v${VERSION} — active=${getActiveModel() || 'none'}`);
    signalReady();
    setTimeout(signalPendingModelReady, 800);
    setTimeout(signalPendingModelReady, 2500);
  }

  const waitForBody = setInterval(()=>{ if(document.body){clearInterval(waitForBody);init();} },30);
  window.addEventListener('load', () => setTimeout(signalReady, 500));
  window.addEventListener('pageshow', () => setTimeout(signalReady, 300));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') signalReady();
  });
  setInterval(() => sendToOpener({ type: 'gc-heartbeat', relayVersion: VERSION }), 2000);

})();