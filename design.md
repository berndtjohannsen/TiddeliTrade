# TiddeliTrade
This file contains technical details on the TiddeliTrade App. The app is targeting to assist in "Ripple Trading" (commonly known as scalping) ie. trying to make money based on small price variations on a price that is "rippling" around an average. It is designed to interface with the IG trading platform (https://ig.com) using its API (https://labs.ig.com/).

This is a "companion app" to the IG web interface. The additional functionality is e.g:
- extract some specific ripple trading paramters
- being able to auto place and order based on certain conditions.
- being able to close a position based on more conditions than limit.
- by plugin, allow for AI driven trade support (future)

The app has a UI that is mainly to be used in a laptop web browser.  User documentation is mainly provided by help in the UI. The UI is companion a UI and should be used together with the standard IG UI.

To use this app the user will need an IG account (username and password and IG API-key).

Some limitations:
- This is a single user system.
- Only one trade at the time


# UI

The main user interface mockup is in `TiddeliTradeUI.png`.



# Tech stack

- **Runtime:** Node.js
- **Language:** TypeScript
- **Backend:** Express (HTTP API, static assets)
- **Real-time:** Socket.io (server ↔ browser), Lightstreamer client (IG streaming)
- **HTTP client:** native fetch (Node 18+, IG REST API calls)
- **Config:** dotenv (.env for credentials), config.json (user preferences)
- **Frontend:** Plain HTML/CSS/JS served by Express (no framework; Tailwind via CDN for styling)

# File structure

```
TiddeliTrade/
├── src/
│   ├── index.ts              # Entry point
│   ├── version.ts            # App version (single place to update)
│   ├── config.ts             # User config load/save
│   ├── server.ts             # Express + Socket.io setup
│   ├── routes/
│   │   ├── api.ts            # REST API (config, etc.)
│   │   └── pages.ts          # HTML page routes
│   ├── services/
│   │   ├── ig.ts             # IG REST client (session, watchlists, orders)
│   │   └── stream.ts         # Lightstreamer subscription logic
│   └── socket/
│       └── handlers.ts       # Socket.io event handlers
├── public/
│   ├── index.html
│   ├── css/
│   │   └── main.css
│   └── js/
│       ├── app.js            # Main entry, init
│       └── ...               # Add modules as needed
├── config.example.json
├── .env
├── package.json
├── tsconfig.json
└── design.md
```

**Naming:** Entry `index.ts`; routes `api.ts`, `pages.ts`; services by domain `ig.ts`, `stream.ts`; public assets `app.js`, `main.css`. Add subfolders when files grow.

# User configuration

User preferences are stored in `config.json` (gitignored). Copy `config.example.json` to `config.json` to start. Fields:

- `igApiKey`, `igUsername`, `igPassword` – IG credentials (via settings UI)
- `watchlistId`, `epic` – last selected market
- `defaultSize`, `defaultExpiry`, `currencyCode` – order defaults
- `ui.theme`, `ui.maPeriod` – UI preferences

Load on startup; save when user changes settings.

# Security

- Credentials (API key, username, password) in `config.json` (via settings UI) or `.env`; never in code or exposed in API responses.
- Session tokens (CST, X-SECURITY-TOKEN) kept server-side, not exposed to browser.


# Testing

- TBD