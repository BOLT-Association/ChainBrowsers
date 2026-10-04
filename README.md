# ChainBrowsers

Test environment for integrating **BOLT** (Bitcoin Original Layer-1 Token) protocol handling into Bitcoin-enabled browsers, each running its own **SPV client** against the local private regtest chain from [spv-testnet](https://github.com/BOLT-Association/spv-testnet) (**Teranode** + **Arcade**).

## Goals

1. Each browser does its own SPV: it holds block headers and verifies transactions via Merkle paths (BUMP/BEEF). This repo provides the chain stack and tests, not an SPV library.
2. Browsers parse, validate and spend BOLT tokens (mint, transfer, split, merge, melt) by checking the covenant lineage via SPV proofs.
3. Reorgs are handled correctly: header chain switches, BOLT token state and pending transactions are re-evaluated.
4. Everything runs locally and reproducibly, with scripted scenarios (including forced reorgs).

## Architecture (target)

```
 Browser(s)                         spv-testnet (Docker)
┌──────────────────────┐          ┌──────────────────────────────┐
│ BOLT handler (b017)  │    API   │ Arcade  ──libp2p──┐          │
│ Browser's own SPV:   │ ───────► │ (broadcast/status)│          │
│  - header chain      │          │ merkle-service ───┤          │
│  - merkle verify     │ ◄─────── │ Teranode regtest ◄┘          │
│  - reorg handling    │ headers  │ (+ block generator)          │
└──────────────────────┘ + proofs └──────────────────────────────┘
```

| Dir | Purpose |
|-----|---------|
| `packages/bolt/` | BOLT token integration layer (wraps [b017](https://github.com/BOLT-Association/b017)) |
| `browsers/` | Target browsers: [Hodos](https://github.com/BOLT-Association/Hodos-Browser) (desktop), [BSV Browser](https://github.com/BOLT-Association/bsv-browser) (mobile); see `browsers/README.md` |
| `docs/` | Roadmap |
| `SPV_HEADERS_FINDINGS.md` | Audit of how Hodos and bsv-browser handle block headers |

## Status

The chain stack and its tests live in the private repo [BOLT-Association/spv-testnet](https://github.com/BOLT-Association/spv-testnet) (Teranode + merkle-service + Arcade, tx round trip and reorg tests passing on a fresh chain). Start it with `cd stack; .\stack.ps1 up` in that repo (Arcade on `:8080`, chaintracks on `:8083`). Here, the BOLT layer and scenarios are still scaffold; browser work has two opt-in spv modes that use only Arcade and a header chain the browser verifies itself, both regtest-only so far: Hodos ([docs/hodos-spv.md](docs/hodos-spv.md)) and BSV Browser ([docs/bsv-browser-spv.md](docs/bsv-browser-spv.md)); see `browsers/README.md`. Next steps are in [docs/roadmap.md](docs/roadmap.md).

## References

- [BOLT-Association/b017](https://github.com/BOLT-Association/b017) – BOLT token library (TypeScript)
- [bsv-blockchain/arcade](https://github.com/bsv-blockchain/arcade) – broadcaster for Teranode
- [bsv-blockchain/overlay-services](https://github.com/bitcoin-sv/overlay-services) – overlay engine, Merkle path forwarding to SPV wallets
