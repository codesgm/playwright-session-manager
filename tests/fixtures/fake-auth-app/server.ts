import { createServer, type Server } from 'node:http';

/**
 * App HTTP fake para testar o session manager sem depender de um sistema real.
 *
 * Rotas:
 *   GET  /login          → página com form (seta localStorage.token no submit via JS)
 *   POST /api/login      → valida credenciais fixas, responde com token + Set-Cookie
 *   GET  /whoami         → 200 se cookie `auth` presente e não expirado; senão 401
 *   GET  /dashboard      → página autenticada simples
 *   GET  /               → home; mostra "logado" se cookie válido
 *
 * Expiração: o cookie `auth` carrega um timestamp de expiração. Use ?ttlMs= no POST
 * /api/login para controlar a validade (default curto para testar rotação).
 */

const USER = 'user@example.com';
const PASS = 's3cr3t';

function parseCookies(header?: string): Record<string, string> {
  const out: Record<string, string> = {};
  (header ?? '').split(';').forEach((part) => {
    const idx = part.indexOf('=');
    if (idx > -1) out[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
  });
  return out;
}

/** Token = base64("<email>|<expiresAtEpochMs>"). */
function makeToken(email: string, ttlMs: number): string {
  const expiresAt = Date.now() + ttlMs;
  return Buffer.from(`${email}|${expiresAt}`).toString('base64');
}

function tokenValid(token?: string): boolean {
  if (!token) return false;
  try {
    const [, exp] = Buffer.from(token, 'base64').toString('utf8').split('|');
    return Number(exp) > Date.now();
  } catch {
    return false;
  }
}

export interface FakeApp {
  server: Server;
  url: string;
  /** Quantas vezes POST /api/login foi chamado (mede quantos re-logins ocorreram). */
  loginCount: () => number;
  reset: () => void;
  close: () => Promise<void>;
}

export async function startFakeApp(): Promise<FakeApp> {
  let logins = 0;

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const cookies = parseCookies(req.headers.cookie);

    if (req.method === 'POST' && url.pathname === '/api/login') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        let creds: { email?: string; password?: string } = {};
        try {
          creds = JSON.parse(body || '{}');
        } catch {
          /* ignore */
        }
        const ttlMs = Number(url.searchParams.get('ttlMs') ?? 3_600_000);
        if (creds.email === USER && creds.password === PASS) {
          logins += 1;
          const token = makeToken(USER, ttlMs);
          res.writeHead(200, {
            'Content-Type': 'application/json',
            'Set-Cookie': `auth=${token}; Path=/; SameSite=Lax`,
          });
          res.end(JSON.stringify({ ok: true, token }));
        } else {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false }));
        }
      });
      return;
    }

    if (url.pathname === '/whoami') {
      if (tokenValid(cookies.auth)) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ email: USER }));
      } else {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'unauthorized' }));
      }
      return;
    }

    if (url.pathname === '/login') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<!doctype html><html><body>
        <h1>Login</h1>
        <input id="email" />
        <input id="password" type="password" />
        <button id="submit">Log In</button>
        <script>
          document.getElementById('submit').addEventListener('click', async () => {
            const email = document.getElementById('email').value;
            const password = document.getElementById('password').value;
            const ttlMs = new URLSearchParams(location.search).get('ttlMs');
            const res = await fetch('/api/login' + (ttlMs ? ('?ttlMs=' + ttlMs) : ''), {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ email, password }),
            });
            const data = await res.json();
            if (data.ok) { localStorage.setItem('token', data.token); location.href = '/dashboard'; }
          });
        </script>
      </body></html>`);
      return;
    }

    if (url.pathname === '/dashboard') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<!doctype html><html><body>
        <h1 id="dash">Dashboard</h1>
        <div id="status">${tokenValid(cookies.auth) ? 'logado' : 'deslogado'}</div>
      </body></html>`);
      return;
    }

    // home
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<!doctype html><html><body>
      <div id="home-status">${tokenValid(cookies.auth) ? 'logado' : 'deslogado'}</div>
    </body></html>`);
  });

  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  return {
    server,
    url: `http://localhost:${port}`,
    loginCount: () => logins,
    reset: () => {
      logins = 0;
    },
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}
