// Build b017 and pack it into vendor/ (gitignored), where package.json expects it.
//
// Prefers the local working clone at ChainBrowsers/b017 (branch async-signer) when it exists, so the
// handler builds against the in-progress lib; otherwise clones the pinned public commit. b017 ships
// only dist/, so it is built and packed here rather than consumed as a git/workspace dependency.
//
//   npm run vendor && npm install
import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, readdirSync, copyFileSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = 'https://github.com/BOLT-Association/b017.git'
const COMMIT = '9e2d8bfca57d5fc2d423ffc22d23a847344cff87' // auth-bolt-plus-zf, 2026-10-05 (fallback when no local clone)

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const VENDOR = join(PKG, 'vendor')
const LOCAL = resolve(PKG, '..', '..', 'b017') // ChainBrowsers/b017 working clone
const run = (cmd, cwd) => execSync(cmd, { cwd, stdio: 'inherit' })

mkdirSync(VENDOR, { recursive: true })
for (const f of readdirSync(VENDOR)) if (f.endsWith('.tgz')) rmSync(join(VENDOR, f))

let src
if (existsSync(join(LOCAL, 'package.json'))) {
  console.log('vendoring the local b017 clone:', LOCAL)
  run('git -C "' + LOCAL + '" rev-parse --abbrev-ref HEAD', PKG)
  src = LOCAL
  run('npm run build', src)
} else {
  const checkout = join(VENDOR, 'src')
  if (existsSync(checkout)) rmSync(checkout, { recursive: true, force: true })
  run(`git clone --quiet ${REPO} src`, VENDOR)
  run(`git checkout --quiet ${COMMIT}`, checkout)
  run('npm ci --silent', checkout)
  run('npm run build', checkout)
  src = checkout
}
run('npm pack --silent', src)
for (const f of readdirSync(src)) if (f.endsWith('.tgz')) { copyFileSync(join(src, f), join(VENDOR, f)); rmSync(join(src, f)) }
if (src !== LOCAL) rmSync(src, { recursive: true, force: true })
console.log('b017 packed into', VENDOR)
