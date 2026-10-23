// Anmeldung (E-Mail zuerst, SSO je Mandant) und Einladung annehmen, über das ganze Dashboard.
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { json, ME_ADMIN } from '../test/fixtures';
import { rendereApp } from '../test/hilfen';

const NICHT_ANGEMELDET = {
  '/api/v1/auth/me': json({}, 401),
  '/api/v1/auth/setup': json({ noetig: false }),
};
const ANBIETER = { anbieter: [{ name: 'lokal', titel: 'Anmelden', start: null }] };
const OIDC = { bezeichnung: 'Beispiel SSO', start_url: '/api/v1/auth/oidc/start?mandant=beispiel' };

function emailEingeben(wert: string) {
  fireEvent.change(screen.getByLabelText('E-Mail-Adresse oder Login'), { target: { value: wert } });
  fireEvent.click(screen.getByRole('button', { name: 'Weiter' }));
}

describe('Anmeldeseite (E-Mail zuerst)', () => {
  it('E-Mail mit Domain-Treffer zeigt „Weiter zu …“ mit Start-URL und den Passwort-Ausweg', async () => {
    const { aufrufe } = rendereApp('/', {
      ...NICHT_ANGEMELDET,
      '/api/v1/auth/anbieter?email=anna%40example.org': json({ ...ANBIETER, oidc: OIDC }),
    });
    await screen.findByLabelText('E-Mail-Adresse oder Login');
    emailEingeben('anna@example.org');
    const link = await screen.findByRole('link', { name: 'Weiter zu Beispiel SSO' });
    expect(link.getAttribute('href')).toBe(OIDC.start_url);
    fireEvent.click(screen.getByRole('button', { name: 'Stattdessen mit Passwort anmelden' }));
    expect(await screen.findByLabelText('Passwort')).toBeTruthy();
    expect(aufrufe.some((a) => a.pfad.startsWith('/api/v1/auth/anbieter?email='))).toBe(true);
  });

  it('E-Mail ohne Treffer führt zum Passwortfeld und meldet mit dem Login an', async () => {
    let angemeldet = false;
    const { aufrufe } = rendereApp('/', {
      '/api/v1/auth/me': () =>
        angemeldet ? Response.json(ME_ADMIN) : Response.json({}, { status: 401 }),
      '/api/v1/auth/setup': json({ noetig: false }),
      '/api/v1/auth/anbieter?email=anna%40example.org': json({ ...ANBIETER, oidc: null }),
      'POST /api/v1/auth/login': () => {
        angemeldet = true;
        return Response.json(ME_ADMIN);
      },
    });
    await screen.findByLabelText('E-Mail-Adresse oder Login');
    emailEingeben('anna@example.org');
    fireEvent.change(await screen.findByLabelText('Passwort'), {
      target: { value: 'geheim-genug-1' },
    });
    expect((screen.getByLabelText('Login') as HTMLInputElement).value).toBe('anna@example.org');
    fireEvent.click(screen.getByRole('button', { name: 'Anmelden' }));
    await waitFor(() =>
      expect(
        aufrufe.find((a) => a.methode === 'POST' && a.pfad === '/api/v1/auth/login')?.body,
      ).toEqual({
        login: 'anna@example.org',
        passwort: 'geheim-genug-1',
      }),
    );
  });

  it('alter Server ohne SSO-Abfrage (404) verhält sich wie bisher: Passwortschritt', async () => {
    rendereApp('/', NICHT_ANGEMELDET);
    await screen.findByLabelText('E-Mail-Adresse oder Login');
    emailEingeben('anna@example.org');
    expect(await screen.findByLabelText('Passwort')).toBeTruthy();
  });

  it('Anmeldung über das Mandanten-Kürzel: Treffer und kein Treffer', async () => {
    rendereApp('/', {
      ...NICHT_ANGEMELDET,
      '/api/v1/auth/anbieter?mandant=beispiel': json({ ...ANBIETER, oidc: OIDC }),
      '/api/v1/auth/anbieter?mandant=unbekannt': json({ ...ANBIETER, oidc: null }),
    });
    await screen.findByLabelText('E-Mail-Adresse oder Login');
    fireEvent.click(screen.getByRole('button', { name: 'Anmeldung über Mandanten-Kürzel' }));
    const feld = screen.getByLabelText('Mandanten-Kürzel');
    fireEvent.change(feld, { target: { value: 'unbekannt' } });
    fireEvent.click(screen.getByRole('button', { name: 'Weiter' }));
    expect(
      await screen.findByText('Für dieses Kürzel ist keine SSO-Anmeldung eingerichtet.'),
    ).toBeTruthy();
    fireEvent.change(feld, { target: { value: 'beispiel' } });
    fireEvent.click(screen.getByRole('button', { name: 'Weiter' }));
    expect(
      (await screen.findByRole('link', { name: 'Weiter zu Beispiel SSO' })).getAttribute('href'),
    ).toBe(OIDC.start_url);
  });

  it('429 bei der Abfrage zeigt den Hinweis zu vielen Versuchen', async () => {
    rendereApp('/', {
      ...NICHT_ANGEMELDET,
      '/api/v1/auth/anbieter?email=anna%40example.org': json({ fehler: 'zu viele' }, 429),
    });
    await screen.findByLabelText('E-Mail-Adresse oder Login');
    emailEingeben('anna@example.org');
    expect(
      await screen.findByText('Zu viele Versuche. Bitte später erneut versuchen.'),
    ).toBeTruthy();
    expect(screen.queryByLabelText('Passwort')).toBeNull();
  });
});

describe('Einladung annehmen', () => {
  const PRUEFEN = {
    'POST /api/v1/auth/einladung/pruefen': json({
      benutzername: 'neu@example.org',
      gueltig_bis: null,
    }),
  };

  it('prüft den Link ohne Anmeldung, setzt das Passwort und wechselt zum Dashboard', async () => {
    let angemeldet = false;
    const { aufrufe } = rendereApp('/einladung/tok-abc', {
      '/api/v1/auth/me': () =>
        angemeldet ? Response.json(ME_ADMIN) : Response.json({}, { status: 401 }),
      ...PRUEFEN,
      'POST /api/v1/auth/einladung': () => {
        angemeldet = true;
        return Response.json(ME_ADMIN);
      },
    });
    expect(
      await screen.findByRole('heading', { name: 'Konto neu@example.org einrichten' }),
    ).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Passwort'), { target: { value: 'kurz' } });
    fireEvent.change(screen.getByLabelText('Passwort wiederholen'), { target: { value: 'kurz' } });
    fireEvent.click(screen.getByRole('button', { name: 'Konto einrichten' }));
    expect(screen.getByText('Das Passwort braucht mindestens 12 Zeichen.')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Passwort'), { target: { value: 'lang-genug-1234' } });
    fireEvent.change(screen.getByLabelText('Passwort wiederholen'), {
      target: { value: 'lang-genug-1234' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Konto einrichten' }));
    expect(await screen.findByRole('heading', { name: 'Übersicht' })).toBeTruthy();
    const post = aufrufe.find((a) => a.methode === 'POST' && a.pfad === '/api/v1/auth/einladung');
    expect(post?.body).toEqual({ token: 'tok-abc', passwort: 'lang-genug-1234' });
    expect(aufrufe.find((a) => a.pfad.endsWith('/pruefen'))?.body).toEqual({ token: 'tok-abc' });
  });

  it('ungültiger Link zeigt den Hinweis', async () => {
    rendereApp('/einladung/alt', {
      '/api/v1/auth/me': json({}, 401),
      'POST /api/v1/auth/einladung/pruefen': json(
        { fehler: 'ungültig', code: 'einladung_ungueltig' },
        404,
      ),
    });
    expect(
      await screen.findByText('Der Einladungslink ist ungültig, schon benutzt oder abgelaufen.'),
    ).toBeTruthy();
    expect(screen.queryByLabelText('Passwort')).toBeNull();
  });
});
