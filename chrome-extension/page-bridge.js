/* MAIN-world bridge: expose page ticketData to the isolated content script. */
(function () {
  'use strict';

  function publish() {
    let data = null;
    try {
      data = window.ticketData ?? null;
      if (typeof data === 'string' && data.length > 10) {
        try { data = JSON.parse(data); } catch (_) {}
      }
    } catch (_) {
      data = null;
    }
    window.postMessage({ source: 'firewally-bridge', type: 'ticketData', data }, '*');
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || msg.source !== 'firewally' || msg.type !== 'requestTicketData') return;
    publish();
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', publish, { once: true });
  } else {
    publish();
  }

  // Admins is a SPA — refresh cache periodically and on history changes.
  setInterval(publish, 1500);
  const _push = history.pushState;
  const _replace = history.replaceState;
  history.pushState = function () {
    const r = _push.apply(this, arguments);
    setTimeout(publish, 50);
    return r;
  };
  history.replaceState = function () {
    const r = _replace.apply(this, arguments);
    setTimeout(publish, 50);
    return r;
  };
  window.addEventListener('popstate', () => setTimeout(publish, 50));
})();
