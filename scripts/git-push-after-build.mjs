#!/usr/bin/env node
/**
 * Runs after `vite build` (npm postbuild). Commits any staged changes and pushes.
 * Skipped in Docker (DOCKER_BUILD=1) and in CI (CI=true) unless ALLOW_POSTBUILD_PUSH=1.
 */
import { execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()

if (process.env.DOCKER_BUILD === '1') {
  console.log('[postbuild] skip git push (DOCKER_BUILD)')
  process.exit(0)
}
if (process.env.CI === 'true' && process.env.ALLOW_POSTBUILD_PUSH !== '1') {
  console.log('[postbuild] skip git push (CI)')
  process.exit(0)
}
if (!fs.existsSync(path.join(root, '.git'))) {
  console.log('[postbuild] skip git push (no .git)')
  process.exit(0)
}

function run(cmd) {
  execSync(cmd, { stdio: 'inherit', cwd: root, shell: true })
}

try {
  run('git add -A')
  let hasStaged = true
  try {
    execSync('git diff --staged --quiet', { cwd: root })
    hasStaged = false
  } catch {
    /* has changes */
  }
  if (hasStaged) {
    const msg = `build: ${new Date().toISOString()}`
    run(`git commit -m ${JSON.stringify(msg)}`)
  } else {
    console.log('[postbuild] nothing to commit')
  }
  run('git push')
  console.log('[postbuild] git push done')
} catch (e) {
  console.error('[postbuild] git failed:', e?.message || e)
  process.exit(1)
}
