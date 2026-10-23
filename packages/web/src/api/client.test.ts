// API-Client und Formate ohne React.
import { describe, expect, it } from 'vitest';
import { datum, geld, prozent, usdAusMikro, zahl } from '../format';
import { aktuellerMonat, monatsname, verschiebeMonat } from '../monat';
import { fixtureFetch, json, UEBERSICHT } from '../test/fixtures';
import { ApiClient, ApiFehler, cookieWert, istCsrfFehler, TEXT_CSRF } from './client';
import { fehlertext } from '../komponenten/Abfrage';
import { fehlerBeimSpeichern } from '../komponenten/Formular';
import { uebersichtSchema } from './typen';

describe('ApiClient', () => {
  it('prüft Antworten mit zod und wandelt Zahlen-Text (bigint aus Postgres)', async () => {
    const alsText = {
      ...UEBERSICHT,
      anfragen: '1234',
      schatten_usd_micros: '419500000',
      nach_modell: [UEBERSICHT.nach_modell[0], { ...UEBERSICHT.nach_modell[1], anfragen: '234' }],
    };
    const { fetch } = fixtureFetch({ '/a': json(alsText) });
    const daten = await new ApiClient(fetch).get('/a', uebersichtSchema);
    expect(daten.nach_modell[1]?.anfragen).toBe(234);
    expect(daten.schatten_usd_micros).toBe(419_500_000);
    expect(daten.tokens.gesamt).toBe(485_000_000);
  });

  it('meldet Formatfehler als ApiFehler', async () => {
    const { fetch } = fixtureFetch({ '/a': json({ monat: 'Oktober' }) });
    const fehler = await new ApiClient(fetch).get('/a', uebersichtSchema).catch((e: unknown) => e);
    expect(fehler).toBeInstanceOf(ApiFehler);
    expect((fehler as ApiFehler).art).toBe('format');
  });

  it('übernimmt Status und Meldung bei HTTP-Fehlern', async () => {
    const { fetch } = fixtureFetch({ '/a': json({ fehler: 'kaputt' }, 500) });
    const fehler = (await new ApiClient(fetch)
      .get('/a', uebersichtSchema)
      .catch((e: unknown) => e)) as ApiFehler;
    expect([fehler.status, fehler.art, fehler.message]).toEqual([500, 'http', 'kaputt']);
  });

  it('meldet Netzfehler mit Status 0', async () => {
    const fehler = (await new ApiClient(() => Promise.reject(new TypeError('offline')))
      .get('/a', uebersichtSchema)
      .catch((e: unknown) => e)) as ApiFehler;
    expect([fehler.status, fehler.art]).toEqual([0, 'netz']);
  });

  it('sendet JSON mit Cookies der gleichen Herkunft', async () => {
    let init: RequestInit | undefined;
    await new ApiClient(async (_pfad, i) => {
      init = i;
      return new Response(null, { status: 204 });
    }).post('/b', { x: 1 });
    expect(init?.method).toBe('POST');
    expect(init?.credentials).toBe('same-origin');
    expect(init?.body).toBe('{"x":1}');
  });
});

describe('CSRF', () => {
  const header = (a: { headers: Record<string, string> } | undefined) =>
    a?.headers['x-seatmeter-csrf'];

  it('liest Cookies', () => {
    expect(cookieWert('a=1; seatmeter_csrf=abc%2Fdef; b=2', 'seatmeter_csrf')).toBe('abc/def');
    expect(cookieWert('a=1', 'seatmeter_csrf')).toBeNull();
    expect(cookieWert('', 'seatmeter_csrf')).toBeNull();
  });

  it('schickt den Wert des Cookies seatmeter_csrf bei PUT, POST und DELETE, nicht bei GET', async () => {
    const { fetch, aufrufe } = fixtureFetch({
      '/g': json({}),
      'PUT /p': json(null, 204),
      'POST /p': json(null, 204),
      'DELETE /p': json(null, 204),
    });
    const api = new ApiClient(fetch, () => 'andere=1; seatmeter_csrf=aus-cookie');
    api.merkeCsrf('aus-me');
    await api.anfrage('GET', '/g');
    await api.put('/p', { x: 1 });
    await api.post('/p');
    await api.delete('/p');
    expect(aufrufe.map(header)).toEqual([undefined, 'aus-cookie', 'aus-cookie', 'aus-cookie']);
  });

  it('nimmt ohne lesbares Cookie den Wert aus /auth/me', async () => {
    const { fetch, aufrufe } = fixtureFetch({ 'PUT /p': json(null, 204) });
    const api = new ApiClient(fetch, () => '');
    await api.put('/p', {});
    api.merkeCsrf('aus-me');
    await api.put('/p', {});
    expect(aufrufe.map(header)).toEqual([undefined, 'aus-me']);
  });

  it('holt nach einem CSRF-403 den neuen Token (neue Sitzung im Header-Modus) und wiederholt einmal', async () => {
    let cookie = 'seatmeter_csrf=alt';
    const { fetch, aufrufe } = fixtureFetch({
      'POST /p': (init) => {
        const gesendet = new Headers(init?.headers).get('x-seatmeter-csrf');
        if (gesendet === 'neu') return new Response(null, { status: 204 });
        // Server legt hinter dem Proxy eine neue Sitzung an und setzt das neue Cookie.
        cookie = 'seatmeter_csrf=neu';
        return Response.json({ fehler: 'CSRF-Token fehlt oder passt nicht' }, { status: 403 });
      },
      '/api/v1/auth/me': json({ csrf: 'neu' }),
    });
    await new ApiClient(fetch, () => cookie).post('/p', {});
    expect(aufrufe.map((a) => `${a.methode} ${a.pfad} ${header(a) ?? '-'}`)).toEqual([
      'POST /p alt',
      'GET /api/v1/auth/me -',
      'POST /p neu',
    ]);
  });

  it('ohne Cookie: holt nach einem CSRF-403 den Token neu aus /auth/me und wiederholt', async () => {
    const { fetch, aufrufe } = fixtureFetch({
      'POST /p': (init) =>
        new Headers(init?.headers).get('x-seatmeter-csrf') === 'neu'
          ? new Response(null, { status: 204 })
          : Response.json({ fehler: 'CSRF-Token fehlt oder passt nicht' }, { status: 403 }),
      '/api/v1/auth/me': json({ csrf: 'neu' }),
    });
    const api = new ApiClient(fetch, () => '');
    api.merkeCsrf('abgelaufen');
    await api.post('/p', {});
    expect(aufrufe.map((a) => `${a.methode} ${a.pfad} ${header(a) ?? '-'}`)).toEqual([
      'POST /p abgelaufen',
      'GET /api/v1/auth/me -',
      'POST /p neu',
    ]);
  });

  it('wiederholt nicht, wenn sich der Token nicht ändert, und meldet 403', async () => {
    const { fetch, aufrufe } = fixtureFetch({
      'POST /p': json({ fehler: 'CSRF-Token fehlt oder passt nicht' }, 403),
      '/api/v1/auth/me': json({ csrf: 'gleich' }),
    });
    const api = new ApiClient(fetch, () => '');
    api.merkeCsrf('gleich');
    const fehler = (await api.post('/p', {}).catch((e: unknown) => e)) as ApiFehler;
    expect([fehler.status, fehler.art]).toEqual([403, 'http']);
    expect(aufrufe.filter((a) => a.methode === 'POST')).toHaveLength(1);
  });

  it('erkennt die CSRF-Abweisung am Code und zeigt einen verständlichen Text', async () => {
    const { fetch, aufrufe } = fixtureFetch({
      'POST /p': json({ code: 'csrf', fehler: 'Token passt nicht' }, 403),
      '/api/v1/auth/me': json({ csrf: 'gleich' }),
    });
    const api = new ApiClient(fetch, () => '');
    api.merkeCsrf('gleich');
    const fehler = (await api.post('/p', {}).catch((e: unknown) => e)) as ApiFehler;
    // Code statt Text: der Neuversuch greift auch bei anderem Wortlaut (holt /me, gleicher Token).
    expect(aufrufe.map((a) => `${a.methode} ${a.pfad}`)).toEqual([
      'POST /p',
      'GET /api/v1/auth/me',
    ]);
    expect(fehler.code).toBe('csrf');
    expect(istCsrfFehler(fehler)).toBe(true);
    expect(fehlerBeimSpeichern(fehler)).toBe(TEXT_CSRF);
    expect(fehlertext(fehler)).toBe(TEXT_CSRF);
    const rolle = new ApiFehler(403, 'http', 'Rolle fehlt', '/p', [], 'rolle_fehlt');
    expect(istCsrfFehler(rolle)).toBe(false);
    expect(fehlerBeimSpeichern(rolle)).toBe('Dafür fehlt die Berechtigung.');
  });

  it('wiederholt andere 403 nicht', async () => {
    const { fetch, aufrufe } = fixtureFetch({ 'POST /p': json({ fehler: 'Rolle fehlt' }, 403) });
    const fehler = (await new ApiClient(fetch, () => 'seatmeter_csrf=x')
      .post('/p', {})
      .catch((e: unknown) => e)) as ApiFehler;
    expect(fehler.status).toBe(403);
    expect(aufrufe).toHaveLength(1);
  });
});

describe('Formate', () => {
  it('formatiert deutsch', () => {
    expect(zahl(1234567)).toBe('1.234.567');
    expect(zahl(null)).toBe('—');
    expect(geld(569.46).replace(/\s/g, ' ')).toBe('569,46 $');
    expect(geld(489.74, 'EUR').replace(/\s/g, ' ')).toBe('489,74 €');
    expect(prozent(97.5).replace(/\s/g, ' ')).toBe('97,5 %');
    expect(datum('2026-10-01')).toBe('01.10.2026');
  });

  it('rechnet Mikro-USD in Dollar', () => {
    expect(usdAusMikro(419_500_000).replace(/\s/g, ' ')).toBe('419,50 $');
    expect(usdAusMikro(0).replace(/\s/g, ' ')).toBe('0,00 $');
    expect(usdAusMikro(1_234).replace(/\s/g, ' ')).toBe('0,0012 $');
    expect(usdAusMikro(null)).toBe('—');
  });

  it('rechnet Monate', () => {
    expect(verschiebeMonat('2026-01', -1)).toBe('2025-12');
    expect(verschiebeMonat('2026-12', 1)).toBe('2027-01');
    expect(monatsname('2026-10')).toBe('Oktober 2026');
    // 31.12. 23:30 UTC ist in Berlin schon der 1. Januar.
    expect(aktuellerMonat(new Date('2026-12-31T23:30:00Z'))).toBe('2027-01');
  });
});
