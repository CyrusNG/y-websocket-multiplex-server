import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const cwd = process.cwd()
const envFile = path.join(cwd, '.env.test')

/**
 * @param {string} raw
 * @returns {Record<string, string>}
 */
const parseEnvFile = raw => {
  /** @type {Record<string, string>} */
  const parsed = {}
  raw.split(/\r?\n/).forEach(line => {
    const trimmed = line.trim()
    if (trimmed.length === 0 || trimmed.startsWith('#')) {
      return
    }
    const idx = trimmed.indexOf('=')
    if (idx <= 0) {
      return
    }
    const key = trimmed.slice(0, idx).trim()
    let value = trimmed.slice(idx + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    parsed[key] = value
  })
  return parsed
}

/** @type {Record<string, string | undefined>} */
const env = { ...process.env }
if (fs.existsSync(envFile)) {
  const raw = fs.readFileSync(envFile, 'utf8')
  const loaded = parseEnvFile(raw)
  Object.keys(loaded).forEach(key => {
    env[key] = loaded[key]
  })
}

const run = (command, args) => {
  const result = spawnSync(command, args, {
    cwd,
    env,
    stdio: 'inherit'
  })
  if (result.status !== 0) {
    process.exit(result.status === null ? 1 : result.status)
  }
}

run('npm', ['run', 'lint'])
run('node', ['--test', '--test-force-exit', 'test'])
