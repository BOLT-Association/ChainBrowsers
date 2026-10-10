// Driving the bsv-browser app in the Android emulator with adb: open a URL in it, read the
// screen, tap by visible text, and send it to the background and back (which is one of the
// things that makes the app sync its header chain).
import { execFile, execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'

const ADB = process.env.ADB ?? 'adb'
export const PACKAGE = process.env.BSV_PACKAGE ?? 'org.bsvassociation.browser'
const sleep = ms => new Promise(r => setTimeout(r, ms))

// stderr is kept out of the test's output (monkey prints its arguments there); a failure still carries it.
export const adb = (...args) => execFileSync(ADB, args, { maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] })
const shell = (...args) => adb('shell', ...args).toString()
// The same without blocking the caller: reading the screen waits for the app to be idle, which can take seconds.
const adbAsync = (...args) => new Promise((resolve, reject) =>
  execFile(ADB, args, { maxBuffer: 64 * 1024 * 1024, encoding: 'buffer' }, (err, stdout) => err ? reject(err) : resolve(stdout)))

/** Open `url` in the app (its http/https intent filter opens a browser tab). */
export const openUrl = url => shell('am', 'start', '-a', 'android.intent.action.VIEW', '-d', `'${url}'`, PACKAGE)

export const launch = () => shell('monkey', '-p', PACKAGE, '-c', 'android.intent.category.LAUNCHER', '1')

/** Background the app and bring it back: the app syncs headers when it returns to the foreground. */
export async function cycleForeground () {
  shell('input', 'keyevent', 'KEYCODE_HOME')
  await sleep(1500)
  launch()
  await sleep(1500)
}

/** Every on-screen node with text or a content description, with the centre of its bounds. */
const dumpArgs = ['exec-out', 'uiautomator', 'dump', '/dev/tty']
export const screen = () => nodesOf(adb(...dumpArgs).toString())

function nodesOf (xml) {
  const nodes = []
  for (const m of xml.matchAll(/<node [^>]*>/g)) {
    const attr = name => (m[0].match(new RegExp(` ${name}="([^"]*)"`)) ?? [])[1] ?? ''
    const text = attr('text') || attr('content-desc')
    const b = attr('bounds').match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/)
    if (text && b) nodes.push({ text, x: (Number(b[1]) + Number(b[3])) >> 1, y: (Number(b[2]) + Number(b[4])) >> 1, clickable: attr('clickable') === 'true' })
  }
  return nodes
}

export const texts = () => screen().map(n => n.text)

/** Tap the first node whose text matches; returns false when nothing matches. */
export function tapText (pattern) {
  const n = screen().find(x => pattern.test(x.text))
  if (!n) return false
  shell('input', 'tap', String(n.x), String(n.y))
  return true
}

/** Wait for a node matching `pattern`, then tap it. */
export async function waitAndTap (pattern, { timeout = 30000 } = {}) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    if (tapText(pattern)) return true
    await sleep(1000)
  }
  throw new Error(`nothing on screen matches ${pattern}: ${texts().slice(0, 30).join(' | ')}`)
}

let width
const screenWidth = () => (width ??= Number((shell('wm', 'size').match(/(\d+)x\d+/) ?? [])[1] ?? 1080))
const isToast = n => n.clickable && /^!, /.test(n.text)

/**
 * Close the app's error toast (in spv mode it reports, on every start and return to the
 * foreground, that it will not fetch an exchange rate) by tapping its x. Returns its text, or null.
 */
export function dismissToast (nodes = screen()) {
  const toast = nodes.find(isToast)
  if (!toast) return null
  shell('input', 'tap', String(Math.round(screenWidth() * 0.92)), String(toast.y))
  return toast.text
}

/** Close the toast (and answer an app-not-responding dialog) whenever it shows, for the length of a test, without holding the test up. Returns a function that stops the watcher. */
export function watchToast ({ every = 4000 } = {}) {
  let busy = false
  const timer = setInterval(async () => {
    if (busy) return
    busy = true
    try {
      const nodes = nodesOf((await adbAsync(...dumpArgs)).toString())
      // Android's "<app> isn't responding" dialog covers the app until it is answered: answer "Wait".
      const wait = nodes.some(n => /isn't responding/.test(n.text)) && nodes.find(n => n.text === 'Wait')
      if (wait) await adbAsync('shell', 'input', 'tap', String(wait.x), String(wait.y))
      const toast = nodes.find(isToast)
      if (toast) await adbAsync('shell', 'input', 'tap', String(Math.round(screenWidth() * 0.92)), String(toast.y))
    } catch { /* the screen could not be read this time; the next tick looks again */ }
    busy = false
  }, every)
  return () => clearInterval(timer)
}

/** Reload the app's current tab: close the toast that can cover the bottom bar, then tap the reload button in the address bar. */
export async function reloadTab () {
  const nodes = screen()
  const width = screenWidth()
  if (dismissToast(nodes)) await sleep(800)
  const bar = nodes.filter(n => n.clickable && n.text && !/^!, /.test(n.text)).sort((a, b) => b.y - a.y)[0]
  if (!bar) return false
  shell('input', 'tap', String(Math.round(width * 0.78)), String(bar.y))
  return true
}

export const type = text => shell('input', 'text', `'${text.replace(/ /g, '%s')}'`)
export const screenshot = file => writeFileSync(file, adb('exec-out', 'screencap', '-p'))

// `node emulator.mjs texts` / `tap <regex>` / `open <url>` / `shot <file>`
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())) {
  const [cmd, arg] = process.argv.slice(2)
  if (cmd === 'texts') for (const n of screen()) console.log(`${n.clickable ? '*' : ' '} (${n.x},${n.y}) ${n.text}`)
  else if (cmd === 'tap') console.log(tapText(new RegExp(arg, 'i')))
  else if (cmd === 'open') console.log(openUrl(arg))
  else if (cmd === 'shot') screenshot(arg)
  else console.log('usage: node emulator.mjs texts | tap <regex> | open <url> | shot <file>')
}
