// Minimaler OIDC-Provider im Testprozess: Discovery, JWKS, Token (PKCE S256, client_secret_basic), Userinfo.
// ID-Tokens sind echte RS256-JWTs; Codes legt der Test mit `code()` an.
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export const CLIENT_ID = 'seatmeter';
export const CLIENT_SECRET = 'test-geheimnis-nur-fuer-tests';

interface Code {
  challenge: string;
  nonce: string;
  claims: Record<string, unknown>;
}

const b64u = (b: Buffer | string) => Buffer.from(b).toString('base64url');

export class FakeIssuer {
  private server: Server | null = null;
  private readonly schluessel = generateKeyPairSync('rsa', { modulusLength: 2048 });
  private readonly codes = new Map<string, Code>();
  private readonly userinfo = new Map<string, Record<string, unknown>>();
  issuer = '';
  tokenAnfragen = 0;

  async starten(): Promise<void> {
    this.server = createServer((req, res) => {
      void this.antwort(req.method ?? 'GET', req.url ?? '/', req.headers.authorization, req).then(
        ([status, body]) => {
          res.writeHead(status, { 'content-type': 'application/json' });
          res.end(JSON.stringify(body));
        },
      );
    });
    await new Promise<void>((ok) => this.server!.listen(0, '127.0.0.1', ok));
    this.issuer = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stoppen(): Promise<void> {
    await new Promise<void>((ok) => this.server?.close(() => ok()));
  }

  /** Legt einen Autorisierungscode für die Parameter der Start-Weiterleitung an. */
  code(autorisierung: URL, claims: Record<string, unknown>, nonce?: string): string {
    const c = b64u(randomBytes(16));
    this.codes.set(c, {
      challenge: autorisierung.searchParams.get('code_challenge') ?? '',
      nonce: nonce ?? autorisierung.searchParams.get('nonce') ?? '',
      claims,
    });
    return c;
  }

  private jwt(claims: Record<string, unknown>): string {
    const kopf = b64u(JSON.stringify({ alg: 'RS256', kid: 'k1', typ: 'JWT' }));
    const jetzt = Math.floor(Date.now() / 1000);
    const nutz = b64u(
      JSON.stringify({ iss: this.issuer, aud: CLIENT_ID, iat: jetzt, exp: jetzt + 300, ...claims }),
    );
    const sig = sign('sha256', Buffer.from(`${kopf}.${nutz}`), this.schluessel.privateKey);
    return `${kopf}.${nutz}.${b64u(sig)}`;
  }

  private async antwort(
    methode: string,
    pfad: string,
    auth: string | undefined,
    req: NodeJS.ReadableStream,
  ): Promise<[number, unknown]> {
    const url = new URL(pfad, this.issuer);
    if (url.pathname === '/.well-known/openid-configuration') {
      return [
        200,
        {
          issuer: this.issuer,
          authorization_endpoint: `${this.issuer}/authorize`,
          token_endpoint: `${this.issuer}/token`,
          userinfo_endpoint: `${this.issuer}/userinfo`,
          jwks_uri: `${this.issuer}/jwks`,
          response_types_supported: ['code'],
          subject_types_supported: ['public'],
          id_token_signing_alg_values_supported: ['RS256'],
          code_challenge_methods_supported: ['S256'],
          token_endpoint_auth_methods_supported: ['client_secret_basic'],
        },
      ];
    }
    if (url.pathname === '/jwks') {
      return [
        200,
        {
          keys: [
            {
              ...this.schluessel.publicKey.export({ format: 'jwk' }),
              kid: 'k1',
              alg: 'RS256',
              use: 'sig',
            },
          ],
        },
      ];
    }
    if (url.pathname === '/userinfo') {
      const token = auth?.replace(/^Bearer /, '') ?? '';
      const info = this.userinfo.get(token);
      return info ? [200, info] : [401, { error: 'invalid_token' }];
    }
    if (url.pathname === '/token' && methode === 'POST') {
      this.tokenAnfragen++;
      let text = '';
      for await (const teil of req) text += String(teil);
      const form = new URLSearchParams(text);
      // client_secret_basic (RFC 6749 §2.3.1): ID und Secret form-kodiert, dann Base64.
      const [id, geheim] = Buffer.from(auth?.replace(/^Basic /, '') ?? '', 'base64')
        .toString('utf8')
        .split(':')
        .map((t) => decodeURIComponent(t.replace(/\+/g, ' ')));
      if (id !== CLIENT_ID || geheim !== CLIENT_SECRET) return [401, { error: 'invalid_client' }];
      const code = this.codes.get(form.get('code') ?? '');
      this.codes.delete(form.get('code') ?? '');
      if (!code) return [400, { error: 'invalid_grant' }];
      const challenge = createHash('sha256')
        .update(form.get('code_verifier') ?? '')
        .digest('base64url');
      if (challenge !== code.challenge)
        return [400, { error: 'invalid_grant', error_description: 'PKCE' }];
      const access = b64u(randomBytes(16));
      this.userinfo.set(access, { sub: code.claims.sub, ...code.claims });
      return [
        200,
        {
          access_token: access,
          token_type: 'Bearer',
          expires_in: 300,
          id_token: this.jwt({ nonce: code.nonce, ...code.claims }),
        },
      ];
    }
    return [404, { error: 'not_found' }];
  }
}
