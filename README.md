# FireWally

Chrome extension + local relay for WSS companion chat on the GoDaddy Admins ticket dashboard.

**Version:** 1.3.2  
**Relay:** `http://localhost:8080` → GoCaaS via S2S OAuth

> POC: companion IDs are remapped by the relay to Claude Sonnet with WSS system prompts.

---

## What’s in this repo

| Path | Purpose |
|------|---------|
| `chrome-extension/` | Load unpacked in Chrome |
| `relay/` | Local Node relay (`server.js`) |
| `relay/.env.example` | Template for secrets — **no private keys** |

Your real credentials go in `relay/.env` (gitignored — never commit it).

---

## How it works

```
Admins ticket page
   └─ FireWally Chrome extension
         └─ POST http://localhost:8080/api/v1/relay/chat
               └─ relay/server.js (S2S token)
                     └─ GoCaaS /api/chat/completions
```

---

## 1. Set up the relay

```bash
cd relay
cp .env.example .env
# Edit .env — fill OAUTH_CLIENT_ID, OAUTH_CLIENT_SECRET, GODADDY_OAUTH_URL, GOCAAS_BASE_URL
npm install
node server.js
```

You should see: `Gravity Tools Relay running on http://localhost:8080`

Check: `curl http://localhost:8080/health`

### `.env` variables

| Variable | Secret? | Description |
|----------|---------|-------------|
| `OAUTH_CLIENT_ID` | yes | S2S OAuth client id |
| `OAUTH_CLIENT_SECRET` | yes | S2S OAuth client secret |
| `GODADDY_OAUTH_URL` | usually no | Token endpoint URL |
| `GOCAAS_BASE_URL` | usually no | GoCaaS base URL (no trailing slash) |
| `PORT` | no | Default `8080` |
| `GOCAAS_TIMEOUT_MS` | no | Optional upstream timeout (default `180000`) |

---

## 2. Install the Chrome extension

1. Chrome → `chrome://extensions`
2. Enable **Developer mode**
3. **Load unpacked** → select **`chrome-extension/`**
4. Pin FireWally (puzzle piece → pin)
5. With the relay running, open an Admins ticket

---

## Repo layout

```
FireWally/
├── chrome-extension/
│   ├── manifest.json
│   ├── background.js
│   ├── content.js
│   ├── page-bridge.js
│   ├── popup.html / popup.js
│   └── icons/
├── relay/
│   ├── server.js
│   ├── package.json
│   ├── .env.example          ← commit this
│   └── .env                  ← create locally; do NOT commit
└── README.md
```

---

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| Relay Offline | Start `node server.js` in `relay/`; confirm `.env` is filled |
| Auth / 401 from relay | Wrong or missing OAuth values in `.env` |
| Icon missing | Puzzle piece → pin FireWally |
| `git push` password rejected | Use a [Personal Access Token](https://github.com/settings/tokens), not your GitHub password |

---

## Security

- Commit `.env.example` only. Keep real `.env` on your machine.
- Internal tooling — not for Chrome Web Store / public secret sharing.

---

## Ownership

Internal GoDaddy WSS tooling. Not for external distribution unless approved.
