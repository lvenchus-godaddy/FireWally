# FireWally

Chrome extension that adds a WSS companion chat drawer to the GoDaddy Admins ticket dashboard.

**Version:** 1.3.2  
**Relay:** local Node server at `http://localhost:8080` (S2S OAuth → GoCaaS)

> POC: companion IDs are remapped by the local relay to Claude Sonnet with WSS system prompts.

---

## How it works

```
Admins ticket page
   └─ FireWally Chrome extension
         └─ POST http://localhost:8080/api/v1/relay/chat
               └─ Local relay (S2S token)
                     └─ GoCaaS /api/chat/completions
```

Health check: `GET http://localhost:8080/health`

---

## Requirements

1. **Chrome**
2. **Local relay** running on port `8080` (separate project — e.g. `gravity-tools-server` with `node server.js` and a configured `.env`)
3. Access to **Admins**: `https://admins.gsp-plat.int.gdcorp.tools/`

Do **not** commit OAuth secrets or `.env` files.

---

## Install

1. Clone or download this repo.
2. Chrome → `chrome://extensions`
3. Enable **Developer mode**
4. **Load unpacked** → select the `chrome-extension/` folder
5. Pin the icon: puzzle piece → **FireWally** → pin
6. Start the local relay
7. Open an Admins ticket — FireWally should appear (toolbar shows green **ON** on Admins pages)

---

## Using FireWally

1. Open a ticket in Admins.
2. A companion may auto-select from ticket keywords.
3. Chat in the drawer (requests go to `localhost:8080`).
4. If **Relay Offline**, start the relay and use **Retry health check** in Settings.

---

## Repo layout

```
FireWally/
├── chrome-extension/       ← Load this folder in Chrome
│   ├── manifest.json
│   ├── background.js
│   ├── content.js          (generated — do not edit by hand)
│   ├── page-bridge.js
│   ├── popup.html / popup.js
│   └── icons/
├── FireWally.user.js       ← Source for the UI logic
├── _build_extension.js     ← Rebuilds content.js from the source
└── README.md
```

After editing `FireWally.user.js`:

```bash
node _build_extension.js
```

Then click **Reload** on the extension in `chrome://extensions`.

The local relay server lives **outside** this repo.

---

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| No UI | Extension enabled? Hard-refresh Admins |
| Relay Offline | `curl http://localhost:8080/health` — start `node server.js` if needed |
| Icon missing from toolbar | Puzzle piece → pin FireWally |
| `git push` password rejected | Use a [Personal Access Token](https://github.com/settings/tokens) or `gh auth login` |

---

## Security

- OAuth credentials stay on the local relay machine only.
- Internal tooling — not published to the Chrome Web Store.

---

## Ownership

Internal GoDaddy WSS tooling. Not for external distribution unless approved.
