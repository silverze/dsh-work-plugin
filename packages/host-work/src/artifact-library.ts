/**
 * Artifact library: index the files a task writes into its artifact directory.
 *
 * The index lives in the `work` storageDomain; the bytes stay on disk. A scan
 * is idempotent by content hash: unchanged files keep their version, changed
 * files get version + 1.
 */

import { createHash } from 'node:crypto'
import { readFile, readdir, rm, stat, unlink } from 'node:fs/promises'
import { basename, extname, join, relative } from 'node:path'

import type { Context } from '@deepseek-ai/cordis'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'

import type { Config } from './config.js'
import type { workDomain } from './domain.js'
import type { Artifact, ArtifactKind, ArtifactListQuery } from './types.js'

const MAX_DEPTH = 3
const SKIP_DIRS = new Set(['node_modules', '.git', '.dsh-work'])

const KIND_BY_EXT: Record<string, ArtifactKind> = {
  '.docx': 'docx',
  '.pptx': 'pptx',
  '.xlsx': 'xlsx',
  '.pdf': 'pdf',
  '.md': 'md',
  '.html': 'html',
  '.htm': 'html',
  '.png': 'png',
  '.csv': 'csv',
}

export function artifactKindOf(path: string): ArtifactKind {
  return KIND_BY_EXT[extname(path).toLowerCase()] ?? 'other'
}

async function sha256Of(path: string): Promise<string> {
  const bytes = await readFile(path)
  return createHash('sha256').update(bytes).digest('hex')
}

export class ArtifactLibrary {
  private readonly table

  constructor(
    private readonly ctx: Context,
    private readonly domain: Domain<typeof workDomain>,
    private readonly config: Config = {},
  ) {
    this.table = domain.table('artifacts')
  }

  /** Root directory for one task, from config or the workspace-local default. */
  rootFor(taskId: string): string {
    const root = this.config.artifactRoot ?? join(process.cwd(), '.dsh-work', 'artifacts')
    return join(root, taskId)
  }

  async list(query: ArtifactListQuery = {}): Promise<Artifact[]> {
    const needle = query.query?.trim().toLowerCase()
    const limit = query.limit ?? 100
    const offset = query.offset ?? 0
    return Array.from(this.table.entries(), ([, artifact]) => artifact)
      .filter((artifact) => {
        if (query.taskId && artifact.taskId !== query.taskId) return false
        if (query.kind && artifact.kind !== query.kind) return false
        if (needle) {
          const haystack = `${artifact.path}\n${artifact.kind}`.toLowerCase()
          if (!haystack.includes(needle)) return false
        }
        return true
      })
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(offset, offset + Math.max(1, Math.min(limit, 500)))
  }

  async get(artifactId: string): Promise<Artifact | undefined> {
    return this.table.get(artifactId)
  }

  /** Delete every artifact row and the whole artifact root. */
  async clear(): Promise<number> {
    const artifacts = Array.from(this.table.entries(), ([, artifact]) => artifact)
    for (const artifact of artifacts) {
      await unlink(artifact.path).catch(() => undefined)
      await this.table.delete(artifact.id)
    }
    const root = this.config.artifactRoot ?? join(process.cwd(), '.dsh-work', 'artifacts')
    if (root && root !== '/' && root !== process.cwd()) {
      await rm(root, { recursive: true, force: true }).catch(() => undefined)
    }
    return artifacts.length
  }

  async remove(artifactId: string): Promise<void> {
    const artifact = this.table.get(artifactId)
    if (!artifact) return
    await this.table.delete(artifactId)
    try {
      await unlink(artifact.path)
    } catch {
      // The index is authoritative; a missing file is already gone.
    }
  }

  /**
   * Walk the task directory and upsert artifacts. Missing directories are not
   * an error: a task may finish without writing any deliverable.
   */
  async scan(taskId: string, directory = this.rootFor(taskId)): Promise<Artifact[]> {
    const files = await this.walk(directory, 0)
    const found: Artifact[] = []

    for (const path of files) {
      const info = await stat(path).catch(() => undefined)
      if (!info?.isFile() || info.size === 0) continue

      const rel = relative(directory, path).split('\\').join('/')
      const artifactId = `${taskId}:${rel}`
      const sha256 = await sha256Of(path)
      const existing = this.table.get(artifactId)
      if (existing && existing.sha256 === sha256 && existing.size === info.size) {
        found.push(existing)
        continue
      }

      const artifact: Artifact = {
        id: artifactId,
        taskId,
        kind: artifactKindOf(path),
        path,
        size: info.size,
        sha256,
        version: (existing?.version ?? 0) + 1,
        previewStatus: 'none',
        source: 'generated',
        createdAt: existing?.createdAt ?? Date.now(),
      }
      await this.table.put(artifactId, artifact)
      found.push(artifact)
    }

    return found
  }

  private async walk(directory: string, depth: number): Promise<string[]> {
    if (depth > MAX_DEPTH) return []
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
    const files: string[] = []
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name.startsWith('~$')) continue
      const path = join(directory, entry.name)
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue
        files.push(...(await this.walk(path, depth + 1)))
      } else if (entry.isFile()) {
        files.push(path)
      }
    }
    return files
  }

  /** Display name without the task directory prefix. */
  static label(artifact: Artifact): string {
    return basename(artifact.path)
  }
}
