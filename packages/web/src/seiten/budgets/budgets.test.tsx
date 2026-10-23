// Seite „Budgets und Alarme“ (Kern): Liste, Anlegen, Bearbeiten, Löschen, Alarme, Kanäle, 403, ohne ee.
import {
  CSRF,
  json,
  ME_ADMIN,
  ME_LESER,
  MONAT,
  PROJEKT_ID,
  PROJEKTE,
  rendereApp,
} from '../../test/index';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  ALARM_OFFEN,
  ALARME_ALLE,
  ALARME_LEER,
  ALARME_OFFEN,
  BUDGET_GESAMT,
  BUDGET_PROJEKT,
  BUDGETS,
  BUDGETS_LEER,
  KANAELE,
  KANAL_SMTP,
  KANAL_TEST_OK,
  KANAL_WEBHOOK,
} from '../../test/fixtures-module';

const q = `?monat=${MONAT}`;
const VERBOTEN = json({ fehler: 'keine Berechtigung' }, 403);

const routen = {
  [`/api/v1/budgets${q}`]: json(BUDGETS),
  [`/api/v1/alarme${q}&offen=1`]: json(ALARME_OFFEN),
  [`/api/v1/alarme${q}`]: json(ALARME_ALLE),
  '/api/v1/alarmkanal': json(KANAELE),
  [`/api/v1/projekte${q}`]: json(PROJEKTE),
};

const seite = `/budgets${q}`;

describe('Budgets: Liste', () => {
  it('zeigt Betrag, Verbrauch, Prognose, Auslastung, Schwellen und Auslöser', async () => {
    rendereApp(seite, routen);
    const tabelle = await screen.findByRole('table', { name: 'Budgets im Monat' });
    const t = within(tabelle);
    // mandantenweit: Projekt null → „Alle Projekte“
    expect(t.getByText('Alle Projekte')).toBeTruthy();
    expect(t.getByText('Gesamtbudget')).toBeTruthy();
    expect(t.getByText('600,00 €')).toBeTruthy(); // Betrag
    expect(t.getByText('300,00 €')).toBeTruthy(); // Verbrauch
    expect(t.getByText('570,00 €')).toBeTruthy(); // Prognose
    expect(t.getByText('95 % zum Monatsende')).toBeTruthy();
    expect(t.getByText('360,00 €')).toBeTruthy();
    expect(t.getByText('480,00 €')).toBeTruthy();
    expect(t.getByText('120 % zum Monatsende')).toBeTruthy();
    // Token-Budget in Tokens, nicht in Euro
    expect(t.getByText('2.000.000 Tokens')).toBeTruthy();
    expect(t.getByText('1.200.000 Tokens')).toBeTruthy();
    expect(t.getAllByText('50 %, 80 %, 100 %')).toHaveLength(2);
    expect(t.getByText('80 %, 100 %')).toBeTruthy();
    expect(t.getAllByText('Prognose').length).toBeGreaterThan(0);
    // Balken: Verbrauch in Prozent, auf 100 begrenzt
    const balken = t.getAllByRole('progressbar').map((b) => b.getAttribute('aria-valuenow'));
    expect(balken).toEqual(['50', '90', '60']);
  });

  it('zeigt Alarme mit Zustellstatus und Zustellfehler', async () => {
    rendereApp(seite, routen);
    const tabelle = await screen.findByRole('table', { name: 'Alarme im Monat' });
    const t = within(tabelle);
    expect(t.getByText('x-shop')).toBeTruthy();
    expect(t.getByText('80 %')).toBeTruthy();
    expect(t.getByText('360,00 € von 400,00 €')).toBeTruthy();
    expect(t.getByText('Zustellung fehlgeschlagen')).toBeTruthy();
    expect(t.getByText('Webhook antwortete mit Status 500')).toBeTruthy();
    expect(t.getByRole('button', { name: /quittieren/i })).toBeTruthy();
  });

  it('zeigt den leeren Zustand ohne Budgets', async () => {
    rendereApp(seite, { ...routen, [`/api/v1/budgets${q}`]: json(BUDGETS_LEER) });
    expect(
      await screen.findByText('Für diesen Monat sind noch keine Budgets angelegt.'),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Neues Budget' })).toBeTruthy();
  });
});

describe('Budgets: anlegen, bearbeiten, löschen', () => {
  it('sendet für mandantenweit projekt_id null und die Standard-Schwellen (POST mit CSRF)', async () => {
    const { aufrufe } = rendereApp(seite, {
      ...routen,
      'POST /api/v1/budgets': json(BUDGET_GESAMT, 201),
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Neues Budget' }));
    const formular = await screen.findByRole('form', { name: 'Neues Budget' });
    expect(
      within(formular).getByRole('option', { name: 'Alle Projekte (mandantenweit)' }),
    ).toBeTruthy();
    // Das Projekt aus /api/v1/projekte steht zur Wahl.
    expect(await within(formular).findByRole('option', { name: 'x-shop' })).toBeTruthy();
    fireEvent.change(within(formular).getByLabelText('Betrag (EUR)'), {
      target: { value: '600' },
    });
    fireEvent.click(within(formular).getByRole('button', { name: 'Speichern' }));
    expect(await screen.findByText('Budget angelegt.')).toBeTruthy();
    const post = aufrufe.find((a) => a.methode === 'POST' && a.pfad === '/api/v1/budgets');
    expect(post?.body).toEqual({
      projekt_id: null,
      bezeichnung: null,
      betrag: 600,
      waehrung: 'EUR',
      basis: 'projektpreis',
      schwellen: [50, 80, 100],
      ausloeser: 'verbrauch',
      aktiv: true,
    });
    expect(post?.headers['x-seatmeter-csrf']).toBe(CSRF);
    // Die Liste wird danach neu geladen.
    await waitFor(() =>
      expect(aufrufe.filter((a) => a.pfad === `/api/v1/budgets${q}`).length).toBe(2),
    );
  });

  it('legt ein Token-Budget für ein Projekt an (Tausenderpunkte, Schwellen sortiert)', async () => {
    const { aufrufe } = rendereApp(seite, {
      ...routen,
      'POST /api/v1/budgets': json(BUDGET_PROJEKT, 201),
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Neues Budget' }));
    const formular = await screen.findByRole('form', { name: 'Neues Budget' });
    await within(formular).findByRole('option', { name: 'x-shop' });
    const feld = (name: string, wert: string) =>
      fireEvent.change(within(formular).getByLabelText(name), { target: { value: wert } });
    feld('Projekt', PROJEKT_ID);
    feld('Basis', 'tokens');
    feld('Betrag (Tokens)', '5.000.000');
    feld('Schwellen (Prozent, durch Komma getrennt)', '90, 70; 90');
    feld('Auslöser', 'prognose');
    fireEvent.click(within(formular).getByRole('button', { name: 'Speichern' }));
    await screen.findByText('Budget angelegt.');
    const post = aufrufe.find((a) => a.methode === 'POST' && a.pfad === '/api/v1/budgets');
    expect(post?.body).toMatchObject({
      projekt_id: PROJEKT_ID,
      betrag: 5_000_000,
      basis: 'tokens',
      schwellen: [70, 90],
      ausloeser: 'prognose',
    });
  });

  it('prüft Eingaben vorab und sendet nichts bei ungültigem Betrag', async () => {
    const { aufrufe } = rendereApp(seite, routen);
    fireEvent.click(await screen.findByRole('button', { name: 'Neues Budget' }));
    const formular = await screen.findByRole('form', { name: 'Neues Budget' });
    fireEvent.click(within(formular).getByRole('button', { name: 'Speichern' }));
    expect(await within(formular).findByText('Bitte die markierten Felder prüfen.')).toBeTruthy();
    expect(within(formular).getByText('Bitte einen Betrag größer als 0 angeben.')).toBeTruthy();
    expect(aufrufe.some((a) => a.methode === 'POST')).toBe(false);
  });

  it('ändert ein Budget per PUT mit allen Feldern', async () => {
    const { aufrufe } = rendereApp(seite, {
      ...routen,
      [`PUT /api/v1/budgets/${BUDGET_PROJEKT.id}`]: json(BUDGET_PROJEKT),
    });
    // Zwei Budgets gehören zu x-shop; das erste ist das Euro-Budget.
    const knoepfe = await screen.findAllByRole('button', { name: 'Budget x-shop bearbeiten' });
    fireEvent.click(knoepfe[0] as HTMLElement);
    const formular = await screen.findByRole('form', { name: 'Budget bearbeiten' });
    expect((within(formular).getByLabelText('Betrag (EUR)') as HTMLInputElement).value).toBe('400');
    fireEvent.change(within(formular).getByLabelText('Betrag (EUR)'), {
      target: { value: '450,50' },
    });
    fireEvent.click(within(formular).getByRole('button', { name: 'Speichern' }));
    expect(await screen.findByText('Budget gespeichert.')).toBeTruthy();
    const put = aufrufe.find((a) => a.methode === 'PUT');
    expect(put?.pfad).toBe(`/api/v1/budgets/${BUDGET_PROJEKT.id}`);
    expect(put?.body).toEqual({
      projekt_id: PROJEKT_ID,
      bezeichnung: null,
      betrag: 450.5,
      waehrung: 'EUR',
      basis: 'projektpreis',
      schwellen: [50, 80, 100],
      ausloeser: 'verbrauch',
      aktiv: true,
    });
  });

  it('löscht ein Budget erst nach Bestätigung', async () => {
    const { aufrufe } = rendereApp(seite, {
      ...routen,
      [`DELETE /api/v1/budgets/${BUDGET_GESAMT.id}`]: { status: 204 },
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Budget alle Projekte löschen' }));
    expect(aufrufe.some((a) => a.methode === 'DELETE')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Ja, löschen' }));
    expect(await screen.findByText('Budget gelöscht.')).toBeTruthy();
    expect(aufrufe.find((a) => a.methode === 'DELETE')?.pfad).toBe(
      `/api/v1/budgets/${BUDGET_GESAMT.id}`,
    );
  });

  it('blendet Verwaltung und Alarmkanäle für Nicht-Admins aus', async () => {
    const { aufrufe } = rendereApp(seite, { ...routen, '/api/v1/auth/me': json(ME_LESER) });
    await screen.findByRole('table', { name: 'Budgets im Monat' });
    expect(screen.queryByRole('button', { name: 'Neues Budget' })).toBeNull();
    expect(screen.queryByRole('button', { name: /bearbeiten/ })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Alarmkanäle' })).toBeNull();
    expect(aufrufe.some((a) => a.pfad === '/api/v1/alarmkanal')).toBe(false);
  });
});

describe('Alarme', () => {
  it('quittiert einen Alarm über /quittieren und lädt die Liste neu', async () => {
    let quittiert = false;
    const { aufrufe } = rendereApp(seite, {
      ...routen,
      [`/api/v1/alarme${q}&offen=1`]: () =>
        new Response(JSON.stringify(quittiert ? ALARME_LEER : ALARME_OFFEN), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      [`POST /api/v1/alarme/${ALARM_OFFEN.id}/quittieren`]: () => {
        quittiert = true;
        return new Response(
          JSON.stringify({ ...ALARM_OFFEN, quittiert: '2026-10-15T08:00:00.000Z' }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      },
    });
    fireEvent.click(await screen.findByRole('button', { name: /quittieren/i }));
    expect(await screen.findByText('Keine offenen Alarme in diesem Monat.')).toBeTruthy();
    const post = aufrufe.find((a) => a.methode === 'POST');
    expect(post?.pfad).toBe(`/api/v1/alarme/${ALARM_OFFEN.id}/quittieren`);
    expect(post?.headers['x-seatmeter-csrf']).toBe(CSRF);
  });

  it('zeigt mit abgeschaltetem Filter auch quittierte Alarme', async () => {
    const { aufrufe } = rendereApp(seite, routen);
    await screen.findByRole('table', { name: 'Alarme im Monat' });
    fireEvent.click(screen.getByLabelText('Nur offene Alarme'));
    expect(await screen.findByText(/Quittiert am 09\.10\.2026/)).toBeTruthy();
    expect(screen.getByText('Zugestellt')).toBeTruthy();
    expect(aufrufe.some((a) => a.pfad === `/api/v1/alarme${q}`)).toBe(true);
  });

  it('meldet fehlende Berechtigung beim Quittieren auf Deutsch', async () => {
    rendereApp(seite, {
      ...routen,
      [`POST /api/v1/alarme/${ALARM_OFFEN.id}/quittieren`]: VERBOTEN,
    });
    fireEvent.click(await screen.findByRole('button', { name: /quittieren/i }));
    expect(await screen.findByText('Keine Berechtigung.')).toBeTruthy();
  });
});

describe('Alarmkanäle', () => {
  it('listet Kanäle ohne je ein Geheimnis zu zeigen', async () => {
    rendereApp(seite, routen);
    const tabelle = await screen.findByRole('table', { name: 'Alarmkanäle' });
    const t = within(tabelle);
    expect(t.getByText('Team-Webhook')).toBeTruthy();
    expect(t.getByText('https://hooks.example.com/alarm')).toBeTruthy();
    expect(t.getByText('gesetzt')).toBeTruthy();
    expect(t.getByText('Alarm-Mail')).toBeTruthy();
    expect(t.getByText('smtp.example.com:587 → team@example.com')).toBeTruthy();
    expect(t.getByText('nicht gesetzt')).toBeTruthy();
  });

  it('sendet das Geheimnis nur, wenn es ausgefüllt ist, und zeigt es nie an', async () => {
    const GEHEIM = 'tok-geheim-4711';
    const { aufrufe } = rendereApp(seite, {
      ...routen,
      'POST /api/v1/alarmkanal': json(KANAL_WEBHOOK, 201),
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Neuer Alarmkanal' }));
    const formular = await screen.findByRole('form', { name: 'Neuer Alarmkanal' });
    fireEvent.change(within(formular).getByLabelText('Bezeichnung'), {
      target: { value: 'Neuer Webhook' },
    });
    fireEvent.change(within(formular).getByLabelText('URL'), {
      target: { value: 'https://hooks.example.com/neu' },
    });
    // Ohne Geheimnis: Schlüssel fehlt im Body.
    fireEvent.click(within(formular).getByRole('button', { name: 'Speichern' }));
    await screen.findByText('Alarmkanal angelegt.');
    const ohne = aufrufe.find((a) => a.methode === 'POST');
    expect(ohne?.body).toEqual({
      typ: 'webhook',
      bezeichnung: 'Neuer Webhook',
      aktiv: true,
      konfig: { url: 'https://hooks.example.com/neu' },
    });

    // Mit Geheimnis: genau ein Schlüssel `geheimnis`, danach nirgends sichtbar.
    fireEvent.click(await screen.findByRole('button', { name: 'Neuer Alarmkanal' }));
    const zweites = await screen.findByRole('form', { name: 'Neuer Alarmkanal' });
    fireEvent.change(within(zweites).getByLabelText('Bezeichnung'), { target: { value: 'Mit' } });
    fireEvent.change(within(zweites).getByLabelText('URL'), {
      target: { value: 'https://hooks.example.com/mit' },
    });
    const feld = within(zweites).getByLabelText('Bearer-Token (optional)') as HTMLInputElement;
    expect(feld.type).toBe('password');
    fireEvent.change(feld, { target: { value: GEHEIM } });
    fireEvent.click(within(zweites).getByRole('button', { name: 'Speichern' }));
    await waitFor(() => expect(aufrufe.filter((a) => a.methode === 'POST')).toHaveLength(2));
    const mit = aufrufe.filter((a) => a.methode === 'POST')[1];
    expect(mit?.body).toMatchObject({ geheimnis: GEHEIM });
    await waitFor(() =>
      expect(screen.queryByRole('form', { name: 'Neuer Alarmkanal' })).toBeNull(),
    );
    expect(screen.queryByDisplayValue(GEHEIM)).toBeNull();
    expect(document.body.textContent).not.toContain(GEHEIM);
  });

  it('lässt beim Bearbeiten das Geheimnis weg (unverändert) oder löscht es mit null', async () => {
    const { aufrufe } = rendereApp(seite, {
      ...routen,
      [`PUT /api/v1/alarmkanal/${KANAL_WEBHOOK.id}`]: json(KANAL_WEBHOOK),
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Kanal Team-Webhook bearbeiten' }));
    const formular = await screen.findByRole('form', { name: 'Alarmkanal bearbeiten' });
    const geheimnis = within(formular).getByPlaceholderText('unverändert') as HTMLInputElement;
    expect(geheimnis.value).toBe('');
    // Der Typ eines bestehenden Kanals ist nicht änderbar.
    expect(
      within(formular)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toContain('Webhook');
    fireEvent.change(within(formular).getByLabelText('Bezeichnung'), {
      target: { value: 'Team-Webhook neu' },
    });
    fireEvent.click(within(formular).getByRole('button', { name: 'Speichern' }));
    await screen.findByText('Alarmkanal gespeichert.');
    const put = aufrufe.find((a) => a.methode === 'PUT');
    expect(put?.pfad).toBe(`/api/v1/alarmkanal/${KANAL_WEBHOOK.id}`);
    expect(put?.body).toEqual({
      typ: 'webhook',
      bezeichnung: 'Team-Webhook neu',
      aktiv: true,
      konfig: { url: 'https://hooks.example.com/alarm' },
    });
    expect(put?.body).not.toHaveProperty('geheimnis');

    // Löschen des gespeicherten Geheimnisses: `geheimnis: null`.
    fireEvent.click(await screen.findByRole('button', { name: 'Kanal Team-Webhook bearbeiten' }));
    const zweites = await screen.findByRole('form', { name: 'Alarmkanal bearbeiten' });
    fireEvent.click(within(zweites).getByLabelText('Gespeichertes Geheimnis löschen'));
    fireEvent.click(within(zweites).getByRole('button', { name: 'Speichern' }));
    await waitFor(() => expect(aufrufe.filter((a) => a.methode === 'PUT')).toHaveLength(2));
    expect(aufrufe.filter((a) => a.methode === 'PUT')[1]?.body).toMatchObject({ geheimnis: null });
  });

  it('legt einen SMTP-Kanal mit Empfängerliste und Passwort an', async () => {
    const { aufrufe } = rendereApp(seite, {
      ...routen,
      'POST /api/v1/alarmkanal': json(KANAL_SMTP, 201),
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Neuer Alarmkanal' }));
    const formular = await screen.findByRole('form', { name: 'Neuer Alarmkanal' });
    const feld = (name: string, wert: string) =>
      fireEvent.change(within(formular).getByLabelText(name), { target: { value: wert } });
    feld('Typ', 'smtp');
    feld('Bezeichnung', 'Mail');
    feld('Mailserver (Host)', 'smtp.example.com');
    feld('Absender', 'seatmeter@example.com');
    feld('Empfänger (durch Komma getrennt)', 'a@example.com, b@example.com');
    feld('Passwort', 'pw-geheim');
    fireEvent.click(within(formular).getByRole('button', { name: 'Speichern' }));
    await screen.findByText('Alarmkanal angelegt.');
    expect(aufrufe.find((a) => a.methode === 'POST')?.body).toEqual({
      typ: 'smtp',
      bezeichnung: 'Mail',
      aktiv: true,
      konfig: {
        host: 'smtp.example.com',
        port: 587,
        secure: false,
        benutzer: null,
        von: 'seatmeter@example.com',
        an: ['a@example.com', 'b@example.com'],
      },
      geheimnis: 'pw-geheim',
    });
  });

  it('prüft die Konfiguration vorab (ungültige URL)', async () => {
    const { aufrufe } = rendereApp(seite, routen);
    fireEvent.click(await screen.findByRole('button', { name: 'Neuer Alarmkanal' }));
    const formular = await screen.findByRole('form', { name: 'Neuer Alarmkanal' });
    fireEvent.change(within(formular).getByLabelText('Bezeichnung'), { target: { value: 'X' } });
    fireEvent.change(within(formular).getByLabelText('URL'), { target: { value: 'ftp://x' } });
    fireEvent.click(within(formular).getByRole('button', { name: 'Speichern' }));
    expect(
      await within(formular).findByText(
        'Bitte eine gültige URL mit http:// oder https:// angeben.',
      ),
    ).toBeTruthy();
    expect(aufrufe.some((a) => a.methode === 'POST')).toBe(false);
  });

  it('testet einen Kanal und zeigt das Ergebnis', async () => {
    const { aufrufe } = rendereApp(seite, {
      ...routen,
      [`POST /api/v1/alarmkanal/${KANAL_WEBHOOK.id}/test`]: json(KANAL_TEST_OK),
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Kanal Team-Webhook testen' }));
    expect(
      await screen.findByText('Test „Team-Webhook“: ok – Testnachricht zugestellt'),
    ).toBeTruthy();
    expect(aufrufe.some((a) => a.pfad === `/api/v1/alarmkanal/${KANAL_WEBHOOK.id}/test`)).toBe(
      true,
    );
  });

  it('löscht einen Kanal nach Bestätigung', async () => {
    const { aufrufe } = rendereApp(seite, {
      ...routen,
      [`DELETE /api/v1/alarmkanal/${KANAL_SMTP.id}`]: { status: 204 },
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Kanal Alarm-Mail löschen' }));
    fireEvent.click(screen.getByRole('button', { name: 'Ja, löschen' }));
    expect(await screen.findByText('Alarmkanal gelöscht.')).toBeTruthy();
    expect(aufrufe.find((a) => a.methode === 'DELETE')?.pfad).toBe(
      `/api/v1/alarmkanal/${KANAL_SMTP.id}`,
    );
  });
});

describe('Ohne ee und Berechtigung', () => {
  it('läuft im Kern ohne ee: me ohne ee-Block zeigt die ganze Seite', async () => {
    rendereApp(seite, { ...routen, '/api/v1/auth/me': json(ME_ADMIN) });
    expect(await screen.findByRole('table', { name: 'Budgets im Monat' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Neues Budget' })).toBeTruthy();
  });

  it('zeigt bei 403 der Kanalliste den Berechtigungshinweis', async () => {
    rendereApp(seite, { ...routen, '/api/v1/alarmkanal': VERBOTEN });
    expect(await screen.findByText('Keine Berechtigung.')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
