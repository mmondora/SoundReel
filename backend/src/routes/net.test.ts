import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { classifyNetwork } from '../utils/network';
import { registerNetRoutes } from './net';

const app = () => {
  const a = Fastify();
  registerNetRoutes(a);
  return a;
};

describe('classifyNetwork', () => {
  it('a request that carries Cloudflare headers comes from the internet', () => {
    expect(classifyNetwork({ 'cf-ray': '8a1b-MXP' })).toEqual({ network: 'external', viaCloudflare: true });
    expect(classifyNetwork({ 'cf-connecting-ip': '203.0.113.9' })).toEqual({ network: 'external', viaCloudflare: true });
  });

  it('a request that reached Traefik directly is on the home network', () => {
    expect(classifyNetwork({ host: 'soundreel.casamon.dev' })).toEqual({ network: 'internal', viaCloudflare: false });
  });
});

describe('GET /api/net (web player: Sorgente → Auto)', () => {
  it('says "internal" from the home network and is never cached', async () => {
    const res = await app().inject({ method: 'GET', url: '/api/net' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ network: 'internal' });
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('says "external" through Cloudflare and leaks nothing else (no address)', async () => {
    const res = await app().inject({ method: 'GET', url: '/api/net', headers: { 'cf-ray': 'x', 'cf-connecting-ip': '203.0.113.9' } });
    expect(res.json()).toEqual({ network: 'external' });
    expect(res.body).not.toContain('203.0.113.9');
  });
});
