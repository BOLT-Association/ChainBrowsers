# Target browsers

| # | Browser | Repo | Stack | Notes |
|---|---------|------|-------|-------|
| 1 | Hodos Browser (desktop) | https://github.com/BOLT-Association/Hodos-Browser | CEF C++ shell, Rust wallet (Actix, SQLite), React/Vite frontend | Keys stay in the Rust process. BEEF/SPV via a background monitor. Endpoints: WhatsOnChain, GorillaPool; port config in `cef-native/include/core/PortConfig.h`. Set `HODOS_ARCADE_URL=http://localhost:8080` to use Arcade for broadcast, status and proofs instead of ARC (branch `arcade-provider`); header, raw-tx and UTXO chains still use mainnet providers. |
| 2 | BSV Browser (mobile) | https://github.com/BOLT-Association/bsv-browser | React Native / Expo, WebView + CWI provider, SQLite wallet | Chain endpoints are env-configurable: `EXPO_PUBLIC_ARC_URL`, `EXPO_PUBLIC_CHAINTRACKS_URL`; supports mainnet/testnet/teratest. Point at Arcade (`:8080`) and chaintracks (`:8083/chaintracks/v2`). Arcade has no `/v1` tx path and returns 202 on submit; check the client accepts that. From an emulator/device use the host LAN IP, not localhost. |

Clone each into `browsers/<name>/` (gitignored; we integrate via patches or submodules, decided when work starts).
