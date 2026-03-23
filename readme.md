# THIS IS WORK IN PROGRESS
# TiddeliTrade
This application enables simple "robot"/rules based trading on an IG (www.ig.com) platform.

One use-case is to enable "ripple trading" (aka "scalping"). This means trading on small price variations of a reasonable stable instrument. Many positions, less risk, low profit.

The application interfaces with the IG (ig.com) trading platform. Users will need an IG account and API-key. It is intended to be used *in parallell* with the IG web GUI. There are for example no diagrams and some operation can only be done in the IG GUI. 

TiddeliTrade allows "manual" (no rules) placement of oders and deals. Just using these features, provides almost* no benefit over using the IG GUI.

*) The one single benefit is that you can place a time limit on a deal. If the limit expires, TiddelTrade will close the corresponding open position (regadless of profit or loss). This can for example be used to prevent cross-day trades.

# Disclaimers
Some data points may differ compared with IG. In particular related to IG fees for various instruments. To be sure check IG documentation.

*IG and related marks are trademarks of IG Group. This software is not affiliated with, endorsed by, or sponsored by IG.  Users must comply with IG's terms of service and API usage policies.*

# Usage hint, getting started
- Get an IG demo account and explore their GUI
- Focus on a specific instrument ("EPIC"), preferrably one that has low incremental trade cost (for example just the spread).
- Set up the intervals in the three TiddeliTrade "probes" (or use default values)
- In the IG GUI, set up 3 diagrams that maps the TiddeliTrade probes
- Do (many) manual transcations using IG GUI. Visually look at the diagrams when you close a deal with profit. After a while you will hopefully develop some "visual intuitions" of the conditions for a profitable trade
- Try to map this intuition to TidddeliTrade rules
- Run the Rules engine, initially let it just suggest the trade and then you approve manually.
- After a while let the engine trade by itself.
- When all feels good, change to the live account.
- Then be careful, always use stop loss
Good luck



# Installation and configuration

**Requirements:** Node.js 18+

```bash
npm install
npm run build
```

**Configuration:**
1. Copy `config.example.json` to `config.json`
2. Copy `.env.example` to `.env` (optional; credentials can also be set via the Settings UI)
3. Configure IG API key, username and password in Settings (or in `.env`)

**Run:**
- `npm start` – run built app (port from .env or 3000)
- `npm run dev` – development with ts-node
- `npm run dev:watch` – development with auto-reload (port from .env, default 3001)

# Operations
See on-line help/tooltip

# Limitations, and potential future release todos
- Positions can only be placed sequentially by the rules engine. Once an open postion is closed, it starts trade again. (This is to prevent accelerating losses)
- Currently, the rules engine can either take a long (buy) position OR a sell. The direction is determined by the deals "panel".
- Rules can only be expressed with AND (implied) not OR
- There is limited on-line help
- The "historic playback" for ruels is not yet supported
- No AI support (yet)
- On deals "Netting" cannot be set in the UI (uses IG default)
- The GUI terminology is aligned with Swedish IG UI with respect to Sell/Buy Short/Long would maybe have been better
- Rules cannot impact deal parameters as part of the rule (for example dynamically change stop loss)

# Some things are best done in IG GUI 
- Change and open position limits
- Change of field in placed orders 

# Security
The app is single user and designed to run in a secure enviroment under full control of the user. For example in a laptop. All configuration data is stored in clear text files. 

# License

This software is free to use. You may use it for trading and keep any profits you make. You may copy and modify it for your own use. You may however not sell, redistribute, or commercially license the software itself without the authors approval. The authors and contributors disclaim all liability for any loss, damage, or consequence arising from the use of this software. Use at your own risk.

# Third-party software

| Package | Purpose | License |
|---------|---------|---------|
| better-sqlite3 | SQLite database for price recording | MIT |
| dotenv | Environment variable loading | BSD-2-Clause |
| express | Web server | MIT |
| lightstreamer-client-node | IG real-time price streaming | Apache 2.0 |
| socket.io | WebSocket communication | MIT |
| stay-awake | Prevent system sleep during trading | MIT |
| Tailwind CSS | UI styling (CDN) | MIT |
