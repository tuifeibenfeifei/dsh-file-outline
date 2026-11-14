/**
 * Workspace confinement for user-supplied paths.
 *
 * Host plugins run in-process with plain `node:fs`, so the Harness file sandbox
 * does not sit between this code and the disk. Every path is therefore resolved
 * against the Session's working directory and refused when it escapes it.
 *
 * @module dsh-file-outline/lib/path
 */
import path from 'node:path'
import fsp from 'node:fs/promises'
import { OutlineError } from './engine.js'

/**
 * Resolve `input` under `root` and refuse anything that lands outside it.
 * @param {string} root absolute workspace directory
 * @param {string} input absolute or workspace-relative path
 * @returns {string} the canonical absolute path
 */
export function resolveInside(root, input) {
  if (typeof input !== 'string' || input.trim() === '') {
    throw new OutlineError('PATH_REQUIRED', 'path is required')
  }
  const raw = input.trim()
  const absolute = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(root, raw)
  const relative = path.relative(path.resolve(root), absolute)
  const escapes = relative.startsWith('..') || path.isAbsolute(relative)
  if (escapes) {
    throw new OutlineError(
      'OUTSIDE_WORKSPACE',
      `${input} is outside the workspace (${root}). Pass a path inside the workspace, or absolute path under it.`,
    )
  }
  return absolute
}

/**
 * Assert that a resolved path is an existing readable regular file.
 * @param {string} absolute resolved path
 * @returns {Promise<void>} resolves when readable
 */
export async function assertReadableFile(absolute) {
  let stat
  try {
    stat = await fsp.stat(absolute)
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      throw new OutlineError('NOT_FOUND', `${absolute} does not exist`)
    }
    throw new OutlineError('UNREADABLE', `cannot stat ${absolute}: ${error.message}`)
  }
  if (stat.isDirectory()) {
    throw new OutlineError(
      'IS_DIRECTORY',
      `${absolute} is a directory. This tool maps a single file; use glob to list files first.`,
    )
  }
  if (!stat.isFile()) {
    throw new OutlineError('NOT_A_FILE', `${absolute} is not a regular file`)
  }
}
