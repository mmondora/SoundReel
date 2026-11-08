/**
 * Where a request comes from: the home network or the internet.
 *
 * Public traffic reaches Traefik through Cloudflare, which stamps `CF-Ray` / `CF-Connecting-IP` on every
 * request; a client on the home network talks to Traefik directly and carries neither. That is the rule
 * Mondrop's `/api/mondrop/net` always used, and the web player's "Sorgente: Auto" switch uses it too
 * (spec 2026-11-07-web-player-ux-design.md, S2/W7). The browser cannot work this out by itself.
 */
import type { IncomingHttpHeaders } from 'node:http';

export type NetworkKind = 'internal' | 'external';

export interface NetworkInfo {
  network: NetworkKind;
  viaCloudflare: boolean;
}

export function classifyNetwork(headers: IncomingHttpHeaders): NetworkInfo {
  const viaCloudflare = Boolean(headers['cf-ray'] || headers['cf-connecting-ip']);
  return { network: viaCloudflare ? 'external' : 'internal', viaCloudflare };
}
