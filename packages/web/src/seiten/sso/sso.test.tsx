// Seite „SSO und Konten“ im Kern (Fixture-fetch, nur erfundene Werte); läuft ohne ee (/me ohne `ee`).
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { json, ME_ADMIN, ME_LESER, rendereApp, type Routen } from '../../test/index';
import { describe, expect, it } from 'vitest';
import {
  KNOPF_EIGENE,
  TEXT_INAKTIV,
  TEXT_KEINE_GRUPPEN,
  TEXT_KONTEN,
  TEXT_SERVER,
  textBeide,
  textWeg,
  TITEL_SERVER,
} from './Oidc';

const ME = ME_ADMIN;
/** Kern-Route der Mandantenverwaltung für den aktiven Mandanten `m-1`. */
const M = (rest: string) => `/api/v1/mandant${rest}?mandant=m-1`;

const OIDC_LEER = {
  konfiguration: null,
  redirect_uri: null,
  start_url: '/api/v1/auth/oidc/start?mandant=beispiel',
};
const OIDC_GESETZT = {
  konfiguration: {
    issuer: 'https://idp.example.org',
    client_id: 'seatmeter',
    client_secret_gesetzt: true,
    scopes: 'openid profile email groups',
    bezeichnung: 'Beispiel SSO',
    gruppen_rollen: { 'sm-admins': ['mandanten_admin'] },
    aktiv: true,
    erstellt: '2026-10-22T08:00:00.000Z',
    geaendert: '2026-10-22T08:00:00.000Z',
    zuletzt_geprueft: null,
  },
  redirect_uri: 'https://seatmeter.example.org/api/v1/auth/oidc/callback',
  start_url: '/api/v1/auth/oidc/start?mandant=beispiel',
};

const DOMAIN_OFFEN = {
  domain: 'example.org',
  verifiziert: false,
  verifizierungs_token: 'abc123',
  verifiziert_am: null,
  quelle: null,
  erstellt: '2026-10-22T08:00:00.000Z',
  txt_name: '_seatmeter.example.org',
  txt_wert: 'seatmeter-verifizierung=abc123',
};

const KONTO = {
  id: 'b-2',
  benutzername: 'anna@example.org',
  login: 'oidc',
  rollen: [{ rolle: 'controller', projekt_ids: null, quelle: 'manuell' }],
  deaktiviert: null,
  zuletzt_angemeldet: '2026-10-22T09:00:00.000Z',
  einladung_offen: false,
  einladung_bis: null,
  plattform_admin: false,
};
const KONTO_EINGELADEN = {
  ...KONTO,
  id: 'b-3',
  benutzername: 'neu@example.org',
  login: 'lokal',
  rollen: [{ rolle: 'projektleiter', projekt_ids: null, quelle: 'manuell' }],
  zuletzt_angemeldet: null,
  einladung_offen: true,
  einladung_bis: '2026-10-30T09:00:00.000Z',
};

function render(routen: Routen, me: unknown = ME) {
  return rendereApp('/einrichtung/sso', {
    '/api/v1/auth/me': json(me),
    [M('/oidc')]: json(OIDC_LEER),
    [M('/domains')]: json({ domains: [] }),
    [M('/konten')]: json({ konten: [KONTO], kontingent: { belegt: 1, max: 5 } }),
    ...routen,
  });
}

describe('OIDC: Serverkonfiguration und eigene Anbindung', () => {
  const GLOBAL = {
    issuer: 'https://idp-server.example.org',
    client_id: 'seatmeter-server',
    bezeichnung: 'Firmen-Login',
    scopes: 'openid profile email groups',
    redirect_uri: 'https://seatmeter.example.org/api/v1/auth/oidc/callback',
    gruppen: [
      { gruppe: 'sm-leitung', rollen: ['mandanten_admin', 'controller'] },
      { gruppe: 'sm-lesen', rollen: ['controller'] },
    ],
  };
  const NOCH_KEINE = /Noch keine OIDC-Anbindung/;
  const formular = () => screen.queryByLabelText('Issuer-URL');

  it('nur Serverkonfiguration: Werte und Gruppen lesend, kein „noch keine“, Formular zugeklappt', async () => {
    render({ [M('/oidc')]: json({ ...OIDC_LEER, global: GLOBAL }) });
    expect(await screen.findByRole('heading', { name: TITEL_SERVER })).toBeTruthy();
    for (const wert of [
      'Firmen-Login',
      'https://idp-server.example.org',
      'seatmeter-server',
      'openid profile email groups',
      'https://seatmeter.example.org/api/v1/auth/oidc/callback',
    ]) {
      expect(screen.getByText(wert), wert).toBeTruthy();
    }
    expect(screen.getByText(TEXT_SERVER)).toBeTruthy();
    const tabelle = screen.getByRole('table', { name: 'Gruppen der Serverkonfiguration' });
    expect(within(tabelle).getByText('sm-leitung')).toBeTruthy();
    expect(within(tabelle).getByText('mandanten_admin, controller')).toBeTruthy();
    expect(screen.queryByText(TEXT_KEINE_GRUPPEN)).toBeNull();
    expect(screen.queryByText(NOCH_KEINE)).toBeNull();
    // Lesend: Es gibt kein Feld für die Werte der Serverkonfiguration, und das Formular ist zu.
    expect(formular()).toBeNull();
    expect(screen.getByText(new RegExp(textWeg('Firmen-Login').slice(0, 40)))).toBeTruthy();
    expect(screen.getByText(new RegExp(TEXT_KONTEN.slice(0, 40)))).toBeTruthy();

    const knopf = screen.getByRole('button', { name: KNOPF_EIGENE });
    expect(knopf.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(knopf);
    expect(knopf.getAttribute('aria-expanded')).toBe('true');
    expect(formular()).toBeTruthy();
    fireEvent.click(knopf);
    expect(formular()).toBeNull();
  });

  it('Serverkonfiguration ohne Gruppe für diesen Mandanten: sagt deutlich, dass niemand eine Rolle bekommt', async () => {
    render({ [M('/oidc')]: json({ ...OIDC_LEER, global: { ...GLOBAL, gruppen: [] } }) });
    const warnung = await screen.findByText(TEXT_KEINE_GRUPPEN);
    expect(warnung.getAttribute('role')).toBe('alert');
    expect(screen.queryByRole('table', { name: 'Gruppen der Serverkonfiguration' })).toBeNull();
  });

  it('nur eigene Anbindung: wie bisher, keine Serverkonfiguration, kein Klappknopf', async () => {
    render({ [M('/oidc')]: json({ ...OIDC_GESETZT, global: null }) });
    await waitFor(() => expect(formular()).toBeTruthy());
    expect(screen.queryByRole('heading', { name: TITEL_SERVER })).toBeNull();
    expect(screen.queryByRole('button', { name: KNOPF_EIGENE })).toBeNull();
    expect(screen.queryByText(NOCH_KEINE)).toBeNull();
    expect(screen.queryByText(new RegExp(TEXT_KONTEN.slice(0, 40)))).toBeNull();
  });

  it('beide: beide stehen da, und es steht dabei, welche wann gilt', async () => {
    render({ [M('/oidc')]: json({ ...OIDC_GESETZT, global: GLOBAL }) });
    expect(await screen.findByRole('heading', { name: TITEL_SERVER })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Eigene Anbindung dieses Mandanten' })).toBeTruthy();
    expect(formular()).toBeTruthy();
    expect(screen.queryByRole('button', { name: KNOPF_EIGENE })).toBeNull();
    const text = screen.getByText(/Beide gelten/).textContent ?? '';
    expect(text).toContain(textBeide('Firmen-Login', 'Beispiel SSO'));
    expect(text).toContain(TEXT_KONTEN);
    expect(screen.queryByText(NOCH_KEINE)).toBeNull();
  });

  it('beide, eigene inaktiv: Es gilt nur die Serverkonfiguration', async () => {
    render({
      [M('/oidc')]: json({
        ...OIDC_GESETZT,
        konfiguration: { ...OIDC_GESETZT.konfiguration, aktiv: false },
        global: GLOBAL,
      }),
    });
    expect(await screen.findByText(TEXT_INAKTIV)).toBeTruthy();
    expect(screen.queryByText(/Beide gelten/)).toBeNull();
    expect(formular()).toBeTruthy();
  });

  it('keine von beiden: Hinweis und offenes Formular wie bisher', async () => {
    render({ [M('/oidc')]: json({ ...OIDC_LEER, global: null }) });
    expect(await screen.findByText(NOCH_KEINE)).toBeTruthy();
    expect(formular()).toBeTruthy();
    expect(screen.queryByRole('heading', { name: TITEL_SERVER })).toBeNull();
    expect(screen.queryByRole('button', { name: KNOPF_EIGENE })).toBeNull();
  });
});

describe('SSO und Konten', () => {
  it('läuft im Kern ohne ee: /me ohne `ee`, Abschnitte über /api/v1/mandant/…', async () => {
    const { aufrufe } = render({}, ME_ADMIN);
    expect(await screen.findByRole('heading', { name: 'SSO und Konten' })).toBeTruthy();
    expect(await screen.findByText('anna@example.org')).toBeTruthy();
    expect(screen.queryByText(/Lizenz/)).toBeNull();
    expect(aufrufe.some((a) => a.pfad === M('/konten'))).toBe(true);
    expect(aufrufe.some((a) => a.pfad.startsWith('/api/v1/ee/'))).toBe(false);
  });

  it('Nicht-Admins sehen nur den Hinweis', async () => {
    render({}, ME_LESER);
    expect(await screen.findByText('Nur für Mandanten-Admins.')).toBeTruthy();
    expect(screen.queryByText('Konten')).toBeNull();
  });

  it('OIDC speichern: Secret geht hin, kommt nicht zurück; Verbindung prüfen zeigt Endpunkte', async () => {
    const { aufrufe } = render({
      [M('/oidc')]: json(OIDC_GESETZT),
      [`PUT ${M('/oidc')}`]: json(OIDC_GESETZT),
      [`POST ${M('/oidc/pruefen')}`]: json({
        ok: true,
        fehler: null,
        issuer: 'https://idp.example.org',
        endpunkte: {
          authorization: 'https://idp.example.org/auth',
          token: 'https://idp.example.org/token',
          userinfo: null,
          end_session: null,
        },
        geprueft: '2026-10-23T08:00:00.000Z',
      }),
    });
    const form = await screen.findByRole('form', { name: 'OIDC-Anbindung' });
    // Gespeichertes Secret wird nie angezeigt: nur „gesetzt“ und leerer Platzhalter.
    expect(within(form).getByText('Client-Secret ist gesetzt.')).toBeTruthy();
    expect(
      screen.getByText('https://seatmeter.example.org/api/v1/auth/oidc/callback'),
    ).toBeTruthy();
    fireEvent.click(within(form).getByRole('button', { name: 'Speichern' }));
    await screen.findByText('Gespeichert.');
    const ohne = aufrufe.find((a) => a.methode === 'PUT' && a.pfad === M('/oidc'));
    expect(ohne?.body).toMatchObject({
      issuer: 'https://idp.example.org',
      client_id: 'seatmeter',
      bezeichnung: 'Beispiel SSO',
      gruppen_rollen: { 'sm-admins': ['mandanten_admin'] },
      aktiv: true,
    });
    expect(ohne?.body).not.toHaveProperty('client_secret');

    fireEvent.change(within(form).getByLabelText('Client-Secret'), {
      target: { value: 'neues-secret' },
    });
    fireEvent.click(within(form).getByRole('button', { name: 'Speichern' }));
    await waitFor(() =>
      expect(aufrufe.filter((a) => a.methode === 'PUT').at(-1)?.body).toHaveProperty(
        'client_secret',
        'neues-secret',
      ),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Verbindung prüfen' }));
    expect(await screen.findByText(/Verbindung in Ordnung/)).toBeTruthy();
    expect(screen.getByText(/Authorization: https:\/\/idp.example.org\/auth/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Testanmeldung' }).getAttribute('href')).toBe(
      '/api/v1/auth/oidc/start?mandant=beispiel&ziel=%2Feinrichtung%2Fsso',
    );
  });

  it('OIDC ohne Konfiguration verlangt beim ersten Speichern ein Secret', async () => {
    const { aufrufe } = render({});
    const form = await screen.findByRole('form', { name: 'OIDC-Anbindung' });
    const felder = within(form).getAllByRole('textbox');
    fireEvent.change(felder[0]!, { target: { value: 'https://idp.example.org' } });
    fireEvent.change(felder[1]!, { target: { value: 'seatmeter' } });
    fireEvent.change(felder[2]!, { target: { value: 'Beispiel SSO' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Speichern' }));
    expect(
      await within(form).findByText('Beim ersten Speichern ist ein Client-Secret nötig.'),
    ).toBeTruthy();
    expect(aufrufe.some((a) => a.methode === 'PUT')).toBe(false);
  });

  it('Domain hinzufügen zeigt die TXT-Anleitung; 409 und 400 haben deutsche Texte', async () => {
    let domains: unknown[] = [];
    let antwort = json(DOMAIN_OFFEN, 201);
    const { aufrufe } = render({
      [M('/domains')]: () => Response.json({ domains }),
      [`POST ${M('/domains')}`]: (init?: RequestInit) => {
        if (antwort.status === 201) domains = [DOMAIN_OFFEN];
        void init;
        return Response.json(antwort.body, { status: antwort.status });
      },
    });
    const form = await screen.findByRole('form', { name: 'Domain hinzufügen' });
    const feld = within(form).getByRole('textbox');

    antwort = json({ fehler: 'x', code: 'domain_vergeben' }, 409);
    fireEvent.change(feld, { target: { value: 'fremd.example' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Hinzufügen' }));
    expect(
      await screen.findByText('Diese Domain gehört schon zu einem anderen Mandanten.'),
    ).toBeTruthy();

    antwort = json({ fehler: 'x', code: 'domain_oeffentlich' }, 400);
    fireEvent.click(within(form).getByRole('button', { name: 'Hinzufügen' }));
    expect(
      await screen.findByText(
        'Öffentliche E-Mail-Anbieter (z. B. gmail.com) können nicht verifiziert werden.',
      ),
    ).toBeTruthy();

    antwort = json(DOMAIN_OFFEN, 201);
    fireEvent.change(feld, { target: { value: 'Example.org' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Hinzufügen' }));
    expect(await screen.findByText('_seatmeter.example.org')).toBeTruthy();
    expect(screen.getByText('seatmeter-verifizierung=abc123')).toBeTruthy();
    expect(
      aufrufe.filter((a) => a.methode === 'POST' && a.pfad === M('/domains')).at(-1)?.body,
    ).toEqual({ domain: 'example.org' });
  });

  it('„Jetzt prüfen“ zeigt den Fehlertext der DNS-Prüfung', async () => {
    render({
      [M('/domains')]: json({ domains: [DOMAIN_OFFEN] }),
      [`POST ${M('/domains/example.org/pruefen')}`]: json({
        verifiziert: false,
        fehler: 'TXT-Eintrag nicht gefunden',
        domain: DOMAIN_OFFEN,
      }),
    });
    fireEvent.click(await screen.findByRole('button', { name: 'example.org jetzt prüfen' }));
    expect(await screen.findByText(/TXT-Eintrag nicht gefunden/)).toBeTruthy();
  });

  it('Konten: Kontingent, Einladen zeigt den Link einmal absolut, Kontingent-Fehler', async () => {
    let antwort = json(
      {
        konto: KONTO_EINGELADEN,
        einladung: { url: '/einladung/tok-xyz', gueltig_bis: '2026-10-30T09:00:00.000Z' },
      },
      201,
    );
    const { aufrufe } = render({
      [`POST ${M('/konten')}`]: (): Response =>
        Response.json(antwort.body, { status: antwort.status }),
    });
    expect(await screen.findByText('Konten: 1 von 5')).toBeTruthy();
    expect(screen.getByRole('listitem', { name: 'Konto anna@example.org' })).toBeTruthy();
    const form = screen.getByRole('form', { name: 'Konto einladen' });

    antwort = json({ fehler: 'x', code: 'konten_kontingent' }, 409);
    fireEvent.change(within(form).getByRole('textbox'), { target: { value: 'neu@example.org' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Einladen' }));
    expect(
      await screen.findByText(
        'Das Kontenkontingent ist ausgeschöpft (1 von 5). Bitte den Plattform-Betreiber kontaktieren.',
      ),
    ).toBeTruthy();

    antwort = json(
      {
        konto: KONTO_EINGELADEN,
        einladung: { url: '/einladung/tok-xyz', gueltig_bis: '2026-10-30T09:00:00.000Z' },
      },
      201,
    );
    fireEvent.click(within(form).getByRole('button', { name: 'Einladen' }));
    expect(await screen.findByText(`${window.location.origin}/einladung/tok-xyz`)).toBeTruthy();
    expect(
      aufrufe.filter((a) => a.methode === 'POST' && a.pfad === M('/konten')).at(-1)?.body,
    ).toEqual({ benutzername: 'neu@example.org', rollen: ['controller'] });
    fireEvent.click(screen.getByRole('button', { name: 'Weitergegeben, ausblenden' }));
    expect(screen.queryByText(`${window.location.origin}/einladung/tok-xyz`)).toBeNull();
  });

  it('Rollen ändern, deaktivieren, Rollen entziehen (letzter Admin: deutscher Text)', async () => {
    let letzterAdmin = false;
    const { aufrufe } = render({
      [M('/konten')]: json({
        konten: [KONTO, KONTO_EINGELADEN],
        kontingent: { belegt: 2, max: null },
      }),
      [`PUT ${M('/konten/b-2')}`]: () => Response.json(KONTO),
      [`DELETE ${M('/konten/b-2/rollen')}`]: () =>
        letzterAdmin
          ? Response.json({ fehler: 'x', code: 'letzter_admin' }, { status: 409 })
          : new Response(null, { status: 204 }),
      [`POST ${M('/konten/b-3/einladung')}`]: json(
        { einladung: { url: '/einladung/neuer', gueltig_bis: null } },
        201,
      ),
    });
    expect(await screen.findByText('Konten: 2 von unbegrenzt')).toBeTruthy();
    const anna = screen.getByRole('listitem', { name: 'Konto anna@example.org' });
    fireEvent.click(within(anna).getByRole('button', { name: 'Rollen ändern' }));
    fireEvent.click(within(anna).getByLabelText('anna@example.org: Projektleiter'));
    fireEvent.click(
      within(anna).getByRole('button', { name: 'Rollen von anna@example.org speichern' }),
    );
    await waitFor(() =>
      expect(aufrufe.find((a) => a.methode === 'PUT' && a.pfad === M('/konten/b-2'))?.body).toEqual(
        {
          rollen: ['controller', 'projektleiter'],
        },
      ),
    );
    fireEvent.click(within(anna).getByRole('button', { name: 'Deaktivieren anna@example.org' }));
    await waitFor(() =>
      expect(aufrufe.filter((a) => a.methode === 'PUT').at(-1)?.body).toEqual({
        deaktiviert: true,
      }),
    );

    letzterAdmin = true;
    fireEvent.click(within(anna).getByRole('button', { name: 'Alle Rollen entziehen' }));
    fireEvent.click(within(anna).getByRole('button', { name: 'Ja, entziehen' }));
    expect(
      await screen.findByText(
        'Der letzte Mandanten-Admin kann nicht entfernt oder deaktiviert werden.',
      ),
    ).toBeTruthy();

    const neu = screen.getByRole('listitem', { name: 'Konto neu@example.org' });
    expect(within(neu).getByText(/Einladung offen bis/)).toBeTruthy();
    fireEvent.click(
      within(neu).getByRole('button', { name: 'Neuer Einladungslink für neu@example.org' }),
    );
    expect(await screen.findByText(`${window.location.origin}/einladung/neuer`)).toBeTruthy();
  });
});
