/* FireWally MV3 service worker — toolbar badge + GM_xmlhttpRequest proxy. */

const pending = new Map();
const ADMINS_RE = /:\/\/admins\.gsp-plat\.int\.gdcorp\.tools\//i;

function headersToString(headers) {
  try {
    const parts = [];
    headers.forEach((value, key) => parts.push(`${key}: ${value}`));
    return parts.join('\r\n');
  } catch (_) {
    return '';
  }
}

async function setToolbarState(tabId, enabled) {
  if (tabId == null) return;
  try {
    await chrome.action.setBadgeText({
      tabId,
      text: enabled ? 'ON' : '',
    });
    await chrome.action.setBadgeBackgroundColor({
      tabId,
      color: '#16a34a',
    });
    await chrome.action.setBadgeTextColor?.({
      tabId,
      color: '#ffffff',
    });
    await chrome.action.setTitle({
      tabId,
      title: enabled
        ? 'FireWally — enabled on this page'
        : 'FireWally — open Admins to activate',
    });
  } catch (_) {
    // Tab may have closed
  }
}

async function refreshTab(tabId, url) {
  await setToolbarState(tabId, ADMINS_RE.test(String(url || '')));
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.action.setBadgeBackgroundColor({ color: '#16a34a' });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' || changeInfo.url) {
    refreshTab(tabId, changeInfo.url || tab.url);
  }
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    await refreshTab(tabId, tab.url);
  } catch (_) {}
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return false;

  if (msg.type === 'fw_content_ready') {
    const tabId = sender.tab?.id;
    if (tabId != null) setToolbarState(tabId, true);
    sendResponse({ ok: true });
    return false;
  }

  if (msg.type === 'fw_xhr_abort') {
    const entry = pending.get(msg.id);
    if (entry) {
      try { entry.controller.abort(); } catch (_) {}
      clearTimeout(entry.timer);
      pending.delete(msg.id);
    }
    return false;
  }

  if (msg.type !== 'fw_xhr') return false;

  const id = msg.id;
  const controller = new AbortController();
  const timeoutMs = Number(msg.timeout) > 0 ? Number(msg.timeout) : 120000;
  const timer = setTimeout(() => {
    try { controller.abort('timeout'); } catch (_) {}
  }, timeoutMs);

  pending.set(id, { controller, timer });

  const init = {
    method: (msg.method || 'GET').toUpperCase(),
    headers: msg.headers || {},
    signal: controller.signal,
  };
  if (msg.data != null && init.method !== 'GET' && init.method !== 'HEAD') {
    init.body = msg.data;
  }

  fetch(msg.url, init)
    .then(async (resp) => {
      const responseText = await resp.text();
      sendResponse({
        ok: true,
        status: resp.status,
        responseText,
        responseHeaders: headersToString(resp.headers),
      });
    })
    .catch((err) => {
      const aborted = err?.name === 'AbortError' || String(err?.message || '').includes('timeout');
      sendResponse({
        ok: false,
        error: aborted ? 'timeout' : (err?.message || 'network error'),
        timeout: aborted,
      });
    })
    .finally(() => {
      clearTimeout(timer);
      pending.delete(id);
    });

  return true;
});
