const ADMINS_RE = /:\/\/admins\.gsp-plat\.int\.gdcorp\.tools\//i;

async function refresh() {
  const dot = document.getElementById('dot');
  const label = document.getElementById('label');
  const hint = document.getElementById('hint');

  let enabled = false;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    enabled = ADMINS_RE.test(String(tab?.url || ''));
  } catch (_) {}

  dot.classList.toggle('on', enabled);
  label.textContent = enabled ? 'Enabled on this page' : 'Not active here';
  hint.innerHTML = enabled
    ? 'Drawer is injected on Admins. Relay: <strong>localhost:8080</strong>'
    : 'Open an <strong>Admins</strong> ticket page to activate FireWally.';
}

refresh();
