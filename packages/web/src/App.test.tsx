// Dashboard als Ganzes: Navigation, Anmelde-Tor und Systemzustand.
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { json, ME_ADMIN } from './test/fixtures';
import { rendereApp } from './test/hilfen';

describe('Dashboard', () => {
  it('zeigt die Kern-Navigation auf Deutsch', async () => {
    rendereApp('/einstellungen', {});
    const nav = await screen.findByRole('navigation', { name: 'Hauptnavigation' });
    for (const titel of [
      'Übersicht',
      'Projekte',
      'Personen',
      'Preise & Sitzkosten',
      'Rechner/Agenten',
      'Ausrollen',
      'Datenqualität',
      'Berichte',
      'Einstellungen',
      'Budgets und Alarme',
      'Projekt-Hinweise',
      'Abgleich',
      'Tokens und Orgs',
      'SSO und Konten',
      'Systemzustand',
    ]) {
      expect(within(nav).getByRole('link', { name: titel })).toBeTruthy();
    }
    expect(within(nav).queryByText('Mandanten')).toBeNull();
  });

  it('zeigt Budgets, Hinweise und Abgleich ohne ee als Kernseiten (kein Platzhalter)', async () => {
    rendereApp('/budgets', {});
    expect(await screen.findByRole('heading', { name: 'Budgets und Alarme' })).toBeTruthy();
    expect(screen.queryByText('Diese Seite entsteht in einer der nächsten Phasen.')).toBeNull();
  });

  it('reicht den Monat in der Navigation weiter', async () => {
    rendereApp('/einstellungen?monat=2026-09', {});
    const link = await screen.findByRole('link', { name: 'Projekte' });
    expect(link.getAttribute('href')).toBe('/projekte?monat=2026-09');
    expect(screen.getByRole('link', { name: 'Preise & Sitzkosten' }).getAttribute('href')).toBe(
      '/preise',
    );
  });

  it('zeigt die Berichte-Seite statt eines Platzhalters', async () => {
    rendereApp('/berichte', {});
    expect(await screen.findByRole('heading', { name: 'Berichte' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Betriebsrats-Bericht' })).toBeTruthy();
    expect(screen.queryByText('Diese Seite entsteht in einer der nächsten Phasen.')).toBeNull();
  });

  it('führt Projektpreise in der Navigation mit Monat', async () => {
    rendereApp('/einstellungen?monat=2026-09', {});
    const link = await screen.findByRole('link', { name: 'Projektpreise' });
    expect(link.getAttribute('href')).toBe('/projektpreise?monat=2026-09');
    expect(screen.getByRole('link', { name: 'Berichte' }).getAttribute('href')).toBe(
      '/berichte?monat=2026-09',
    );
  });

  it('rendert Systemzustand mit Datenempfang', async () => {
    rendereApp('/system', {
      '/api/health': json({ status: 'ok', db: 'ok' }),
      '/api/health/ingest': json({
        status: 'ok',
        // Vertrag `ingestHealthSchema` in shared (health.ts).
        quellen: {
          a: {
            letzte_annahme: null,
            stille_stunden: null,
            anfragen_24h: 0,
            abgelehnt_429_24h: 0,
            heute: {
              angenommen: 0,
              verworfen_inhalt: 0,
              verworfen_api: 0,
              verworfen_fremd_org: 0,
              unzugeordnet: 0,
            },
          },
          b: {
            letzte_annahme: '2026-10-22T10:00:00Z',
            stille_stunden: 2.5,
            anfragen_24h: 1500,
            abgelehnt_429_24h: 0,
            heute: {
              angenommen: 420,
              verworfen_inhalt: 1,
              verworfen_api: 2,
              verworfen_fremd_org: 3,
              unzugeordnet: 4,
            },
          },
        },
        agenten: {
          gesamt: 1,
          aktiv_48h: 1,
          aeltester_heartbeat_stunden: 0.2,
          juengster_heartbeat_stunden: 0.2,
          stille_trotz_heartbeat_stunden: 0,
          luecke_zu_a_stunden: 0,
        },
        ratenlimit: {
          seit: '2026-10-22T08:00:00.000Z',
          abgelehnt_429_24h_je_art: {
            ip: 0,
            fehlversuch: 0,
            token: 0,
            rechner: 0,
            enroll: 0,
            enroll_fehlversuch: 0,
          },
        },
      }),
    });
    expect(screen.getByText('Prüfe Anmeldung …')).toBeTruthy();
    expect(await screen.findByText('1.500')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Datenempfang (Ingest)' })).toBeTruthy();
    expect(screen.getByText('noch keine')).toBeTruthy();
    expect(screen.getByText('2,5 h')).toBeTruthy();
    expect(screen.getByText('420')).toBeTruthy();
    expect(screen.getByText('6')).toBeTruthy();
    expect(screen.getAllByText('in Ordnung')).toHaveLength(2);
  });
});

describe('Anmelde-Tor', () => {
  it('200 auf /auth/me zeigt direkt das Dashboard', async () => {
    rendereApp('/einstellungen', {});
    expect(await screen.findByRole('heading', { name: 'Einstellungen' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Anmelden' })).toBeNull();
    expect(screen.queryByText('Anmeldung im Server noch nicht aktiv.')).toBeNull();
    expect(screen.getAllByText('admin').length).toBeGreaterThan(0);
  });

  it('401 und Einrichtung nötig zeigt die Ersteinrichtung und prüft das Passwort', async () => {
    const { aufrufe } = rendereApp('/', {
      '/api/v1/auth/me': json({ fehler: 'nicht angemeldet' }, 401),
      '/api/v1/auth/setup': json({ noetig: true }),
      'POST /api/v1/auth/setup': json({}, 201),
    });
    expect(await screen.findByRole('heading', { name: 'Ersteinrichtung' })).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Einrichtungs-Token'), { target: { value: 'tok-123' } });
    fireEvent.change(screen.getByLabelText('Login'), { target: { value: 'admin' } });
    fireEvent.change(screen.getByLabelText('Passwort'), { target: { value: 'kurz' } });
    fireEvent.change(screen.getByLabelText('Passwort wiederholen'), {
      target: { value: 'kurz' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Konto anlegen' }));
    expect(await screen.findByText('Das Passwort braucht mindestens 12 Zeichen.')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Passwort'), {
      target: { value: 'lang-genug-1234' },
    });
    fireEvent.change(screen.getByLabelText('Passwort wiederholen'), {
      target: { value: 'lang-genug-1234' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Konto anlegen' }));
    await waitFor(() => expect(aufrufe.some((a) => a.methode === 'POST')).toBe(true));
    expect(aufrufe.find((a) => a.methode === 'POST')).toMatchObject({
      methode: 'POST',
      pfad: '/api/v1/auth/setup',
      body: { token: 'tok-123', login: 'admin', passwort: 'lang-genug-1234' },
    });
  });

  it('401 ohne Einrichtung zeigt die Anmeldung und lädt danach das Dashboard', async () => {
    let angemeldet = false;
    rendereApp('/einstellungen', {
      '/api/v1/auth/me': () =>
        angemeldet
          ? Response.json(ME_ADMIN)
          : Response.json({ fehler: 'nicht angemeldet' }, { status: 401 }),
      '/api/v1/auth/setup': json({ noetig: false }),
      'POST /api/v1/auth/login': (init) => {
        const body = JSON.parse(String(init?.body)) as { passwort: string };
        angemeldet = body.passwort === 'richtig-und-lang';
        // Server antwortet wie /auth/me (AuthMe) und setzt Sitzungs- und CSRF-Cookie.
        return angemeldet
          ? Response.json(ME_ADMIN)
          : Response.json({ fehler: 'Anmeldung fehlgeschlagen' }, { status: 401 });
      },
    });
    expect(await screen.findByRole('heading', { name: 'Anmelden' })).toBeTruthy();
    // Schritt 1: reiner Login (ohne „@“) geht ohne Abfrage zum Passwort.
    fireEvent.change(screen.getByLabelText('E-Mail-Adresse oder Login'), {
      target: { value: 'admin' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Weiter' }));
    fireEvent.change(await screen.findByLabelText('Passwort'), { target: { value: 'falsch' } });
    fireEvent.click(screen.getByRole('button', { name: 'Anmelden' }));
    expect(await screen.findByText('Login oder Passwort ist falsch.')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Passwort'), { target: { value: 'richtig-und-lang' } });
    fireEvent.click(screen.getByRole('button', { name: 'Anmelden' }));
    expect(await screen.findByRole('heading', { name: 'Einstellungen' })).toBeTruthy();
  });

  it('404 auf /auth/me zeigt das Dashboard mit Hinweis', async () => {
    rendereApp('/einstellungen', { '/api/v1/auth/me': json({}, 404) });
    expect(await screen.findByText('Anmeldung im Server noch nicht aktiv.')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Einstellungen' })).toBeTruthy();
  });

  it('Netzfehler auf /auth/me zeigt ebenfalls das Dashboard mit Hinweis', async () => {
    rendereApp('/einstellungen', {
      '/api/v1/auth/me': () => {
        throw new TypeError('Failed to fetch');
      },
    });
    expect(await screen.findByText('Anmeldung im Server noch nicht aktiv.')).toBeTruthy();
  });

  it('Anmeldeseite zeigt den SSO-Knopf, wenn der Server einen Anbieter meldet (ee: OIDC)', async () => {
    rendereApp('/', {
      '/api/v1/auth/me': json({ fehler: 'nicht angemeldet' }, 401),
      '/api/v1/auth/setup': json({ noetig: false }),
      '/api/v1/auth/anbieter': json({
        anbieter: [
          { name: 'lokal', titel: 'Anmelden', start: null },
          { name: 'oidc', titel: 'Mit weeberwrk SSO anmelden', start: '/api/v1/auth/oidc/start' },
        ],
      }),
    });
    fireEvent.change(await screen.findByLabelText('E-Mail-Adresse oder Login'), {
      target: { value: 'admin' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Weiter' }));
    const knopf = await screen.findByRole('link', { name: 'Mit weeberwrk SSO anmelden' });
    expect(knopf.getAttribute('href')).toBe('/api/v1/auth/oidc/start');
    expect(screen.getByRole('button', { name: 'Anmelden' })).toBeTruthy();
  });

  it('Lizenzwarnung aus /me erscheint als Hinweis über jeder Seite', async () => {
    rendereApp('/einstellungen', {
      '/api/v1/auth/me': json({
        ...ME_ADMIN,
        ee: {
          aktiv: true,
          module: ['mandanten'],
          gueltig_bis: '2026-10-10',
          warnung: 'Die seatmeter-Lizenz ist am 10.10.2026 abgelaufen.',
        },
      }),
    });
    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      'Die seatmeter-Lizenz ist am 10.10.2026 abgelaufen.',
    );
  });

  it('Abmelden führt zurück zur Anmeldung', async () => {
    let angemeldet = true;
    rendereApp('/einstellungen', {
      '/api/v1/auth/me': () =>
        angemeldet ? Response.json(ME_ADMIN) : Response.json({}, { status: 401 }),
      '/api/v1/auth/setup': json({ noetig: false }),
      'POST /api/v1/auth/logout': () => {
        angemeldet = false;
        return new Response(null, { status: 204 });
      },
    });
    await screen.findByRole('heading', { name: 'Einstellungen' });
    fireEvent.click(screen.getAllByRole('button', { name: 'Abmelden' })[0]!);
    expect(await screen.findByRole('heading', { name: 'Anmelden' })).toBeTruthy();
  });
});
