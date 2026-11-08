/**
 * Self-service API key for the Mondrop app — "login from the device".
 *
 *   GET  /mondrop/connect?device=…   confirm page (Authelia login happens first)
 *   POST /mondrop/connect            issue/rotate the key, hand it to the app
 *
 * The app opens the GET page in a system web-auth sheet (ASWebAuthenticationSession),
 * the user logs into Authelia if needed, taps the button, and the result page
 * redirects to `mondrop://auth?key=…&user=…&device=…` which the app intercepts.
 * In plain Safari the same page shows the key and an "Apri Mondrop" link.
 *
 * SECURITY: identity is the Authelia `Remote-User` header. This path MUST stay
 * behind the `auth-family` Traefik middleware. Never move it under `/api/mondrop`
 * or make it `/api/share` — those routers bypass Authelia (geekom-hub
 * traefik/dynamic/routers.yml), so `Remote-User` would become client-controlled
 * and anyone could mint keys.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { remoteUserFromRequest, FAMILY_DISPLAY, type FamilyUserId } from '../utils/requestUser';
import { issueUserApiKey, normalizeDeviceLabel, guessDeviceLabel } from '../services/apiKeyIssue';
import { Logger } from '../services/debugLogger';

function esc(value: string): string {
  return value.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      default: return '&#39;';
    }
  });
}

const STYLE = `
:root{color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px 16px;background:#121216;color:#f2f2f4;font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
main{width:100%;max-width:420px;background:#1c1c22;border:1px solid #2a2a32;border-radius:20px;padding:24px}
h1{margin:0 0 8px;font-size:1.5rem}h1 span{color:#ffd60a}
p{margin:0 0 14px}.muted{color:#9a9aa3;font-size:.9rem}.err{color:#ff6b6b}
label{display:block;margin:16px 0 6px;font-size:.85rem;color:#9a9aa3}
input{width:100%;padding:12px 14px;border-radius:12px;border:1px solid #34343e;background:#121216;color:inherit;font:inherit}
button,.btn{display:block;width:100%;margin-top:18px;padding:14px;border:0;border-radius:14px;background:#ffd60a;color:#1a1500;font:inherit;font-weight:700;text-align:center;text-decoration:none;cursor:pointer}
code{display:block;word-break:break-all;margin-top:8px;padding:12px;border-radius:10px;background:#121216;border:1px solid #34343e;font-size:.85rem;-webkit-user-select:all;user-select:all}
details{margin-top:18px}summary{cursor:pointer;color:#9a9aa3}
`;

function page(title: string, body: string, head = ''): string {
  return `<!doctype html>
<html lang="it"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark"><meta name="referrer" content="no-referrer">
<title>${esc(title)}</title>${head}<style>${STYLE}</style></head>
<body><main>${body}</main></body></html>`;
}

function renderConnectPage(userId: FamilyUserId, device: string): string {
  return page('Collega Mondrop', `
<h1>Collega <span>Mondrop</span></h1>
<p class="muted">Accesso come <strong>${esc(FAMILY_DISPLAY[userId])}</strong> (${esc(userId)}).</p>
<form method="post" action="/mondrop/connect">
  <label for="device">Nome di questo dispositivo</label>
  <input id="device" name="device" value="${esc(device)}" maxlength="60" autocomplete="off" autocapitalize="off">
  <button type="submit">Genera API key</button>
</form>
<p class="muted" style="margin-top:16px">Crea una key personale per questo dispositivo. Se ne esiste già una con lo stesso nome viene sostituita: la vecchia smette di funzionare.</p>`);
}

function renderIssuedPage(userId: FamilyUserId, device: string, key: string, replaced: boolean): string {
  const callback =
    `mondrop://auth?key=${encodeURIComponent(key)}` +
    `&user=${encodeURIComponent(userId)}&device=${encodeURIComponent(device)}`;
  return page(
    'Mondrop collegato',
    `
<h1>Mondrop <span>collegato</span> ✓</h1>
<p><strong>${esc(FAMILY_DISPLAY[userId])}</strong> · ${esc(device)}${replaced ? '<br><span class="muted">La key precedente di questo dispositivo è stata revocata.</span>' : ''}</p>
<a class="btn" href="${esc(callback)}">Apri Mondrop</a>
<details><summary>Se l’app non si apre</summary>
<p class="muted" style="margin-top:10px">Copia la key e incollala in Mondrop → Impostazioni → API key.</p>
<code>${esc(key)}</code></details>`,
    `<meta http-equiv="refresh" content="0;url=${esc(callback)}">`,
  );
}

function renderError(title: string, message: string): string {
  return page(title, `<h1>${esc(title)}</h1><p class="err">${esc(message)}</p>`);
}

/** Resolve the Authelia family user, or answer 401/403 and return null. */
function requireFamilyUser(req: FastifyRequest, reply: FastifyReply): FamilyUserId | null {
  const userId = remoteUserFromRequest(req);
  if (userId) return userId;
  const present = Boolean(req.headers['remote-user']);
  reply
    .code(present ? 403 : 401)
    .header('Cache-Control', 'no-store')
    .type('text/html; charset=utf-8')
    .send(renderError(
      present ? 'Utente non abilitato' : 'Login richiesto',
      present ? 'Questo utente Authelia non fa parte della famiglia.' : 'Accedi con Authelia e riprova.',
    ));
  return null;
}

/** CSRF guard for the POST: same-origin form submits only. */
function isSameOrigin(req: FastifyRequest): boolean {
  if (req.headers['sec-fetch-site'] === 'cross-site') return false;
  const origin = req.headers.origin;
  if (typeof origin === 'string' && origin !== 'null') {
    try {
      return new URL(origin).host === String(req.headers.host ?? '');
    } catch {
      return false;
    }
  }
  return true;
}

export function registerMondropConnectRoutes(app: FastifyInstance): void {
  const log = new Logger('mondrop-connect');

  // Encapsulated so the form parser (+ nothing else) stays local to these routes.
  void app.register(async (scope) => {
    scope.addContentTypeParser(
      'application/x-www-form-urlencoded',
      { parseAs: 'string' },
      (_req, body, done) => {
        try {
          done(null, Object.fromEntries(new URLSearchParams(String(body))));
        } catch (err) {
          done(err instanceof Error ? err : new Error(String(err)), undefined);
        }
      },
    );

    scope.get('/mondrop/connect', async (req, reply) => {
      const userId = requireFamilyUser(req, reply);
      if (!userId) return reply;
      const q = (req.query ?? {}) as { device?: unknown };
      const device = normalizeDeviceLabel(q.device, guessDeviceLabel(req.headers['user-agent']));
      return reply
        .header('Cache-Control', 'no-store')
        .header('Referrer-Policy', 'no-referrer')
        .type('text/html; charset=utf-8')
        .send(renderConnectPage(userId, device));
    });

    scope.post('/mondrop/connect', async (req, reply) => {
      const userId = requireFamilyUser(req, reply);
      if (!userId) return reply;
      if (!isSameOrigin(req)) {
        return reply
          .code(403)
          .type('text/html; charset=utf-8')
          .send(renderError('Richiesta bloccata', 'Richiesta cross-site non consentita.'));
      }
      const body = (req.body ?? {}) as { device?: unknown };
      const device = normalizeDeviceLabel(body.device, guessDeviceLabel(req.headers['user-agent']));
      try {
        const issued = await issueUserApiKey(userId, device);
        log.info('API key issued', { user: userId, device, replaced: issued.replaced });
        return reply
          .header('Cache-Control', 'no-store')
          .header('Referrer-Policy', 'no-referrer')
          .type('text/html; charset=utf-8')
          .send(renderIssuedPage(userId, device, issued.key, issued.replaced));
      } catch (err) {
        log.error('API key issue failed', err instanceof Error ? err : new Error(String(err)));
        return reply
          .code(500)
          .type('text/html; charset=utf-8')
          .send(renderError('Errore', 'Non sono riuscito a creare la key. Riprova tra poco.'));
      }
    });
  });
}
