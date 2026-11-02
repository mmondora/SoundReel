import { logInfo, logWarning } from '../utils/logger';

export interface RepoEnrichmentResult {
  description: string | null;
  publishedAt: string | null;
  host: 'github' | 'gitlab' | 'codeberg';
}

export interface ParsedRepoUrl {
  host: 'github' | 'gitlab' | 'codeberg';
  /** owner/repo or group/subgroup/repo for GitLab */
  path: string;
  owner: string;
  repo: string;
}

/**
 * Extract a forge repo identity from a URL. Only github.com / gitlab.com /
 * codeberg.org with at least owner/repo path segments.
 */
export function parseRepoUrl(rawUrl: string): ParsedRepoUrl | null {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  const parts = u.pathname.split('/').filter(Boolean);
  // Drop trailing junk: tree/main, blob/..., issues, pulls, …
  const noise = new Set([
    'tree', 'blob', 'issues', 'pulls', 'pull', 'wiki', 'releases',
    'actions', 'projects', 'settings', 'commit', 'commits', 'src', 'raw',
  ]);
  let clean = parts;
  for (let i = 0; i < parts.length; i++) {
    if (noise.has(parts[i].toLowerCase())) {
      clean = parts.slice(0, i);
      break;
    }
  }
  if (clean.length < 2) return null;

  if (host === 'github.com') {
    return { host: 'github', path: `${clean[0]}/${clean[1]}`, owner: clean[0], repo: clean[1] };
  }
  if (host === 'gitlab.com') {
    const path = clean.join('/');
    return {
      host: 'gitlab',
      path,
      owner: clean[0],
      repo: clean[clean.length - 1],
    };
  }
  if (host === 'codeberg.org') {
    return { host: 'codeberg', path: `${clean[0]}/${clean[1]}`, owner: clean[0], repo: clean[1] };
  }
  return null;
}

function githubHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'SoundReel/1.0',
  };
  const token = process.env.GITHUB_TOKEN?.trim();
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

async function fetchJson(url: string, headers: Record<string, string>, timeoutMs = 8000): Promise<unknown | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers, signal: ctrl.signal });
    if (!res.ok) {
      logWarning('Repo enrichment HTTP error', { url, status: res.status });
      return null;
    }
    return await res.json();
  } catch (err) {
    logWarning('Repo enrichment fetch failed', { url, error: String(err) });
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function asIso(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function asDescription(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

/** Fetch description + created_at from the forge API for a repo URL. */
export async function enrichRepoFromUrl(rawUrl: string): Promise<RepoEnrichmentResult | null> {
  const parsed = parseRepoUrl(rawUrl);
  if (!parsed) return null;

  if (parsed.host === 'github') {
    const data = await fetchJson(
      `https://api.github.com/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}`,
      githubHeaders(),
    ) as { description?: unknown; created_at?: unknown } | null;
    if (!data) return null;
    return {
      host: 'github',
      description: asDescription(data.description),
      publishedAt: asIso(data.created_at),
    };
  }

  if (parsed.host === 'gitlab') {
    const data = await fetchJson(
      `https://gitlab.com/api/v4/projects/${encodeURIComponent(parsed.path)}`,
      { 'User-Agent': 'SoundReel/1.0' },
    ) as { description?: unknown; created_at?: unknown } | null;
    if (!data) return null;
    return {
      host: 'gitlab',
      description: asDescription(data.description),
      publishedAt: asIso(data.created_at),
    };
  }

  // codeberg (Gitea)
  const data = await fetchJson(
    `https://codeberg.org/api/v1/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}`,
    { 'User-Agent': 'SoundReel/1.0' },
  ) as { description?: unknown; created_at?: unknown } | null;
  if (!data) return null;
  logInfo('Codeberg repo enriched', { path: parsed.path });
  return {
    host: 'codeberg',
    description: asDescription(data.description),
    publishedAt: asIso(data.created_at),
  };
}
