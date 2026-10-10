# Cross-wallet e2e: Hodos and BSV Browser paying each other in spv mode

`tests/cross-wallet/run.mjs` runs the **Hodos browser** (desktop) and **BSV Browser** (the app, in an Android emulator) side by side, funds each wallet from the regtest chain and has them pay each other both ways. Both wallets are in spv mode against the local Arcade (`:8080` API, `:8083` chaintracks, `:8082` SSE; from the emulator the same ports on `10.0.2.2`): no public indexer, no MessageBox, and each wallet verifies proofs against its own header chain.

Each browser shows the same page (`tests/cross-wallet/page/index.html`), which lists every wallet call and its answer as the test makes them.

## What it does

1. **Fund** one wallet, chosen at random (`FUNDED=hodos` or `bsv` fixes it), with 200,000 sats from a mined coinbase spend, handed to the wallet as an Atomic BEEF through its page.
2. **The funded wallet pays the other** 30,000 sats, then **the other pays 15,000 back** out of what it has just received and proven. Each payment is unmined when the receiver takes it.
3. For each payment, before the real hand-over, the receiver is given the same BEEF with a **tampered proof** and then with a **wrong derivation suffix**; both must be refused and the balance must not move.
4. The payment is **mined** by hand, and each wallet must then show it `completed`, which in spv mode means a proof verified against the wallet's own headers.

A payment is BRC-29 ("wallet payment"), the only kind of received output both wallets count as balance in spv mode. Neither wallet has a usable channel to the other in spv mode (Hodos refuses PeerPay, and nothing in BSV Browser's is tested without a MessageBox), so **the test relays** the Atomic BEEF and the three derivation fields (sender identity key, prefix, suffix) from the sender's `createAction` to the receiver's `internalizeAction`. The sender broadcasts through Arcade first; both receivers refuse a transaction Arcade has not seen.

Each printed line carries the seconds since the start; the test itself takes about a minute. Each page shows only what concerns its own wallet, and a line for every block header Arcade pushes, with how soon the wallet had verified it. BSV Browser shows an error toast in spv mode (it will not fetch an exchange rate from a public indexer); the test closes it whenever it appears. The run prints `ok` lines and ends with `PASS cross-wallet` (exit 0) or `FAIL` (exit 1). At the end it saves a screenshot of each browser to `tests/cross-wallet/out/` (gitignored).

## How the test reaches each wallet

| | Hodos | BSV Browser |
|---|---|---|
| Page URL | `http://localhost:8095/?role=hodos` | `http://localhost:8095/?role=bsv`, through `adb reverse tcp:8095 tcp:8095` |
| Wallet access from the page | `fetch('http://localhost:3321/<method>')`, which the browser intercepts and forwards to its wallet (Hodos injects `window.CWI` only into https pages on non-loopback hosts) | `window.CWI` |
| Prompts | The page's domain is approved once through the wallet's own API; the payment modal Hodos still raises is clicked through the dev build's DevTools port (`:9322`) | None for these calls from a `localhost` page |
| Balance seen by the test | `GET /wallet/balance` on the wallet process | Net of the run's labelled actions (`listActions`) |
| Header sync | On Arcade's push (chaintracks tip stream); every 30 s as the fallback | On Arcade's push (the same stream); every 10 s in spv mode as the fallback |

Things that shaped this, all found by running it:

- **BSV Browser refuses wallet calls from a page served from an IP address** ("IP address originators are not permitted"), so `10.0.2.2` cannot be the page's host; the relay port is forwarded and the page is `localhost` in the emulator too.
- **BSV Browser keeps the BRC-29 protocol for its own pay screens** and refuses `getPublicKey` with it to a page. For BSV Browser → Hodos the test derives Hodos's payment key with a one-off sender key and BSV Browser pays the resulting script. Hodos receives an ordinary BRC-29 output whose sender is the one-off key, not BSV Browser's identity key. Hodos → BSV Browser uses Hodos's own derivation.
- **Neither wallet lets a page list its `default` basket**, which is why the balances are read as in the table.
- **Hodos raises a payment modal on every `createAction` from a page when it has no BSV price** ("USD price unavailable"), whatever the domain's limits are. The modal's DevTools target keeps the URL `…/brc100-auth?type=idle` while it is showing a request, so the test looks for an enabled Approve button rather than at the URL.
- **Arcade's health endpoint occupies port 8081**, Metro's default; Metro runs on 8089.

## Running it

**One command**, once the builds below exist:

```powershell
.\e2e.ps1              # Docker Desktop, the stack (submodule spv-testnet), emulator, Hodos, Metro, the app, then the test
.\e2e.ps1 -NoTest      # the same, without running the test
.\e2e.ps1 -Stop        # stop the browsers, Metro and the emulator; add -StackDown to stop the stack
```

It starts only what is not running, puts the Hodos window and the emulator beside each other, addresses the emulator by serial (only the AVD `xw_spv`), and writes the test's output to `tests/cross-wallet/out/run.log`. Ten seconds after a pass it brings everything down again, the stack included (the chain data is kept); `-KeepOpen` leaves it running, as does a failure. It builds nothing and does not create the app's wallet. The steps it performs are the ones below.

The stack runs from the submodule (`git submodule update --init`). Teranode's chain is in `spv-testnet/stack/data`, the rest in Docker volumes of the compose project, so a clone of spv-testnet elsewhere shares the volumes but not the chain; the script refuses to start on that mix. After `stack.ps1 reset` both test wallets hold headers of the old chain: delete `tests/cross-wallet/out/hodos`, and in the emulator `adb shell pm clear org.bsvassociation.browser` and create the wallet again.

Prerequisites: the `spv-testnet` stack up, both browser clones under `browsers/`, `npm install` in `tests/hodos-spv` (the test uses its `lib.mjs` and `@bsv/sdk`), an Android SDK with an x86_64 system image, JDK 17.

**1. Hodos browser** (dev build of `browsers/Hodos-Browser`, branch `arcade-provider`):

```powershell
cd tests\cross-wallet
.\start-hodos.ps1          # wallet (spv, Arcade), frontend dev server, browser; creates a scratch wallet
.\start-hodos.ps1 -Stop    # stops only this clone's processes
```

The script starts the wallet first so the browser adopts it, and keeps everything Hodos writes under `tests/cross-wallet/out/hodos` (`HODOS_DATA_DIR` for the wallet, `APPDATA` for the browser's profile), so the real `HodosBrowserDev` data is never opened. Building the browser needs the CEF 150 binaries (`-DCEF_ROOT=<a cef-binaries directory>` works without copying them into the clone), the vcpkg packages (`-DVCPKG_INSTALLED_DIR=…` with `-DVCPKG_MANIFEST_INSTALL=OFF` reuses an existing set) and `external/winsparkle/WinSparkle-0.8.1`; see the Hodos repo's `build-instructions/WINDOWS_BUILD_INSTRUCTIONS.md`.

**2. BSV Browser** in an emulator (a separate AVD keeps an existing install and its data out of the way):

```bash
cd browsers/bsv-browser
export JAVA_HOME="C:\Program Files\Java\jdk-17" ANDROID_HOME="C:\Android"
npx expo prebuild --platform android --no-install        # generates android/ (gitignored)
(cd android && ./gradlew.bat app:installDebug -PreactNativeArchitectures=x86_64)

export EXPO_PUBLIC_CHAIN_MODE=spv EXPO_PUBLIC_SPV_RULES=regtest \
  EXPO_PUBLIC_SPV_ANCHOR_HEIGHT=0 \
  EXPO_PUBLIC_SPV_ANCHOR_HASH=0f9188f13cb7b2c71f2a335e3a4fc328bf5beb436012afca590b1a11466e2206 \
  EXPO_PUBLIC_SPV_SSE_URL=http://10.0.2.2:8082 \
  EXPO_PUBLIC_ARC_URL=http://10.0.2.2:8080 EXPO_PUBLIC_CHAINTRACKS_URL=http://10.0.2.2:8083/chaintracks/v1 \
  EXPO_PUBLIC_TERATEST_ARC_URL=http://10.0.2.2:8080 EXPO_PUBLIC_TERATEST_CHAINTRACKS_URL=http://10.0.2.2:8083/chaintracks/v1
CI=1 npx expo start --dev-client --port 8089              # Metro, with the spv settings in its environment
adb shell am start -a android.intent.action.VIEW \
  -d "bsv-browser://expo-development-client/?url=http%3A%2F%2F10.0.2.2%3A8089" org.bsvassociation.browser
```

Then, once, in the app: menu → Wallet → Get paid → Continue creates the wallet. The settings are passed as shell environment rather than a `.env.local`, which the jest setup would also pick up.

Notes on the Android build:

- On Windows one native module (`@bsv/react-native-localpay-transport`) fails with `ninja: error: manifest 'build.ninja' still dirty after 100 tries` when the checkout path is long (260-character limit). Staging its CMake build in a short directory fixes it; add to the generated `android/build.gradle`:
  ```gradle
  subprojects { p ->
    if (p.name == 'bsv_react-native-localpay-transport') {
      p.plugins.withId('com.android.library') {
        p.android.externalNativeBuild.cmake.buildStagingDirectory = new File('C:/xwb/lpt')
      }
    }
  }
  ```
- The wallet is built on the app's `main` network slot, because the default chain is hard-coded and `EXPO_PUBLIC_DEFAULT_CHAIN` is read nowhere; with the un-prefixed URLs pointing at the local stack and regtest rules, that slot is the regtest chain. Switching to teratest in the wallet-config screen was not tried.
- A fresh emulator plus the app's first header sync from genesis takes a few seconds for ~1,600 headers.

**3. The test:**

```bash
cd tests/cross-wallet
node run.mjs
```

It opens (or reloads) the page in both browsers itself, sets the port forward, approves the page's domain in Hodos, and restores `cb-block-generator` to the state it found it in. Do not run it while something else is using the stack's chain.

| Env | Meaning |
|---|---|
| `PACE_MS` | Pause between visible steps (default 500) |
| `FUNDED` | `hodos` or `bsv`: the wallet funded from the chain (default: random) |
| `HODOS_AUTO_APPROVE=off` | Do not open the Hodos tab, approve the domain or click its modals |
| `BSV_ADB=off` | Do not drive the emulator (page open, reload, closing the app's error toast) |
| `SKIP_BSV_PROOF=1` | Diagnostic: carry on past BSV Browser's proof check. The run then ends `INCOMPLETE`, never `PASS` |
| `WALLET_URL`, `ARCADE_URL`, `RPC_URL`, `HODOS_CDP`, `RELAY_PORT` | Endpoints, defaults as in the scripts |

Files: `run.mjs` (the scenario), `server.mjs` (relay between the test and the two pages), `page/index.html`, `hodos.mjs` (wallet API, DevTools: open tab, approve modals, screenshot), `emulator.mjs` (adb: open URL, read the screen, tap, foreground cycle, screenshot), `start-hodos.ps1`.

## Headless check (no browsers)

The same exchange between the two wallet cores, without either browser: BSV Browser's wallet headless inside jest and a running Hodos wallet process over HTTP. It is quicker to run and was the first thing to pass.

```bash
cd browsers/bsv-browser
SPV_LIVE=1 SPV_HODOS=1 npx jest __tests__/spv/live/crosswallet --runInBand
```

It needs a Hodos wallet in spv mode on a scratch data directory (`docs/hodos-spv.md`), and is skipped without `SPV_HODOS=1` so a run of the whole live directory does not need one.

## What the first runs found

- **BSV Browser never proved a payment it received unmined** on regtest: the toolbox monitor checks every header it handles against the mainnet proof-of-work limit, so its new-header task failed on every poll and the proof task was never triggered (the only fallback is a two-hour timer). The headless tests did not see it because they run the proof task by hand. Fixed in the fork's `spv-hardening` patch (`core/spv/monitorHeaders.ts`): in spv mode the monitor validates headers under the rules of the wallet's own verified chain.
- **BSV Browser took about two minutes to prove each mined payment, and only after the app was sent to the background and back**: its header chain advanced only at start, on return to the foreground and every ten minutes, and the monitor looked for a new tip once a minute and sought proofs one poll later. Fixed in the fork's patch (`core/spv/monitorHeaders.ts`): in spv mode each new-header poll first syncs the header chain, the poll runs every 10 s, and a failed poll is retried after 30 s instead of five minutes (which also covers the first poll, made before the header store is open). A proof now arrives about 25 s after the block, with the app left alone.
- **Both wallets waited for a timer to learn of a new block** (Hodos up to 30 s, BSV Browser up to 10 s after the fix above). Arcade's chaintracks pushes each new tip on `/chaintracks/v2/tip/stream`; both wallets now listen to it and run their ordinary header sync, then the proof check, when a frame arrives. The frame is only a trigger: the headers are fetched and validated as before. A wallet has the new header 0.1 to 0.2 s after the push, and the test went from about 110 s to about 55 s.
- **The emulator can stall the run.** Android's "BSV Browser isn't responding" dialog covers the app until it is answered (the script and the test answer "Wait"). On 2026-10-05 one emulator boot froze with that dialog for several system apps at once, and in another run the emulator dropped its open connections to the PC (the app logged "Cannot connect to Expo CLI" with Metro still up) and then exited; the cause was not found. The app's tip stream now reopens itself after 60 s of silence, since a dropped stream raises no error. Reading the emulator's screen (`uiautomator dump`) takes 5 s or more while the page is busy, so nothing in the test may block on it.
- **Metro started with `CI=1` does not reload changed files** ("reloads are disabled"): after editing the app's code, including the toolbox under `node_modules`, restart Metro and the app (`e2e.ps1 -RestartMetro`).
- Hodos: see "Known gaps" in `docs/hodos-spv.md` (the receiver cannot broadcast a payment it is handed; the price-unavailable modal).
