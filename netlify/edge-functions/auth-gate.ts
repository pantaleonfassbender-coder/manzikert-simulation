import type { Config } from '@netlify/edge-functions';

// Site-wide HTTP Basic Auth gate.
//
// This runs at the edge in front of EVERYTHING on the site — the dashboard UI
// and, crucially, the serverless function endpoints (`play-round`,
// `batch-games-background`, `list-games`, `set-run-control`). Those endpoints
// spend AI Gateway tokens on every call, and without a gate anyone who finds
// the URL could trigger them (a single POST to the background run fans out into
// thousands of model calls). Putting the check here means an unauthenticated
// request is rejected before any token is ever spent.
//
// Protection is keyed on the SITE_PASSWORD environment variable:
//   - Set it (Netlify UI → Site settings → Environment variables, or
//     `netlify env:set SITE_PASSWORD <value>`) to turn the gate ON.
//   - While it is unset the gate passes everything through, so deploying this
//     file can never lock the site out before a password has been chosen.
//
// The browser's native Basic Auth dialog asks for a username and password; the
// username is ignored here, only the password is checked. Once the browser has
// authenticated, it automatically attaches the credentials to every same-origin
// request, including the dashboard's fetch() calls to the function endpoints.
export default async (req: Request) => {
  const password = Netlify.env.get('SITE_PASSWORD');

  // No password configured yet → gate disabled, request proceeds normally.
  if (!password) {
    return;
  }

  const header = req.headers.get('authorization') || '';
  if (header.startsWith('Basic ')) {
    try {
      const decoded = atob(header.slice('Basic '.length));
      const supplied = decoded.slice(decoded.indexOf(':') + 1);
      if (timingSafeEqual(supplied, password)) {
        return; // authenticated → fall through to the app / functions
      }
    } catch {
      // Malformed header → fall through to the 401 challenge below.
    }
  }

  return new Response('Authentication required.', {
    status: 401,
    headers: {
      'WWW-Authenticate': 'Basic realm="Manzikert Simulation", charset="UTF-8"',
      'Content-Type': 'text/plain',
      'Cache-Control': 'no-store',
    },
  });
};

// Length-independent constant-time-ish comparison to avoid leaking the password
// length / contents through response timing.
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export const config: Config = {
  path: '/*',
};
