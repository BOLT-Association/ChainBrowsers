// Build b017 at a pinned commit and pack it into vendor/ (gitignored), where package.json expects it.
// b017 publishes only dist/, and a git dependency would arrive unbuilt, so it is packed here instead.
//
//   npm run vendor && npm install
import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, readdirSync, copyFileSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = 'https://github.com/BOLT-Association/b017.git'
const COMMIT = '9e2d8bfca57d5fc2d423ffc22d23a847344cff87' // branch auth-bolt-plus-zf, 2026-10-05

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const VENDOR = join(PKG, 'vendor')
const SRC = join(VENDOR, 'src')
const run = (cmd, cwd) => execSync(cmd, { cwd, stdio: 'inherit' })

mkdirSync(VENDOR, { recursive: true })
if (existsSync(SRC)) rmSync(SRC, { recursive: true, force: true })
run(`git clone --quiet ${REPO} src`, VENDOR)
run(`git checkout --quiet ${COMMIT}`, SRC)
run('npm ci --silent', SRC)
run('npm run build', SRC)
run('npm pack --silent', SRC)
for (const f of readdirSync(SRC)) if (f.endsWith('.tgz')) copyFileSync(join(SRC, f), join(VENDOR, f))
rmSync(SRC, { recursive: true, force: true })
console.log('b017 packed into', VENDOR)
