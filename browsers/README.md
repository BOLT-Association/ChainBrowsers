# Target browsers

| # | Browser | Repo | Stack | Notes |
|---|---------|------|-------|-------|
| 1 | Hodos Browser (desktop) | https://github.com/BOLT-Association/Hodos-Browser | CEF C++ shell, Rust wallet (Actix, SQLite), React/Vite frontend | Keys stay in the Rust process. BEEF/SPV via a background monitor. Endpoints: WhatsOnChain, GorillaPool; port config in `cef-native/include/core/PortConfig.h`. Make chain endpoints point at the local stack. |
| 2 | BSV Browser (mobile) | https://github.com/BOLT-Association/bsv-browser | React Native / Expo, WebView + CWI provider, SQLite wallet | Chain endpoints are env-configurable: `EXPO_PUBLIC_ARC_URL`, `EXPO_PUBLIC_CHAINTRACKS_URL`; supports mainnet/testnet/teratest. Point at Arcade (`:8080`) and chaintracks (`:8083`). From an emulator/device use the host LAN IP, not localhost. |

Clone each into `browsers/<name>/` (gitignored; we integrate via patches or submodules, decided when work starts).
