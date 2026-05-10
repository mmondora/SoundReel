import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export class SsrfBlockedError extends Error {
  constructor(public readonly hostname: string, public readonly reason: string) {
    super(`SSRF blocked: ${hostname} (${reason})`);
    this.name = 'SsrfBlockedError';
  }
}

const PRIVATE_V4_BLOCKS: Array<[string, number]> = [
  ['10.0.0.0', 8],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
  ['0.0.0.0', 8],
];

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.').map((p) => Number(p));
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) return null;
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function inV4Block(ip: string, block: string, bits: number): boolean {
  const ipInt = ipv4ToInt(ip);
  const blockInt = ipv4ToInt(block);
  if (ipInt === null || blockInt === null) return false;
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (ipInt & mask) === (blockInt & mask);
}

function isPrivateV6(ip: string): boolean {
  const lc = ip.toLowerCase();
  if (lc === '::1' || lc === '::') return true;
  if (lc.startsWith('fc') || lc.startsWith('fd')) return true;     // unique local
  if (lc.startsWith('fe80')) return true;                          // link-local
  return false;
}

/**
 * Throw SsrfBlockedError if the URL is not a public http/https URL.
 * Resolves DNS so a public-looking hostname pointing to a private IP also fails.
 */
export async function assertPublicHttpUrl(rawUrl: string): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new SsrfBlockedError(rawUrl, 'invalid_url');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new SsrfBlockedError(parsed.hostname, `bad_protocol:${parsed.protocol}`);
  }

  const host = parsed.hostname;
  if (!host || host === 'localhost' || host.endsWith('.localhost')) {
    throw new SsrfBlockedError(host, 'localhost');
  }

  let ip = host;
  if (isIP(host) === 0) {
    try {
      const res = await lookup(host);
      ip = res.address;
    } catch {
      throw new SsrfBlockedError(host, 'dns_failed');
    }
  }

  if (isIP(ip) === 4) {
    for (const [block, bits] of PRIVATE_V4_BLOCKS) {
      if (inV4Block(ip, block, bits)) {
        throw new SsrfBlockedError(host, `private_v4:${block}/${bits}`);
      }
    }
  } else if (isIP(ip) === 6 && isPrivateV6(ip)) {
    throw new SsrfBlockedError(host, 'private_v6');
  }

  return parsed;
}
