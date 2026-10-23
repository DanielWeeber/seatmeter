// Seite „Ausrollen“ mit Fixture-Antworten: Werte, Reiter, Mandanten-Token, Einmalcode, 403.
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AUSROLLEN, CSRF, json, ME_LESER } from '../test/fixtures';
import { rendereApp } from '../test/hilfen';

const TOKEN = 'smi_frischErzeugt0123456789';

const schnipsel = (id: string) => screen.getByTestId(`schnipsel-${id}`).textContent ?? '';

describe('Ausrollen', () => {
  it('steht in der Navigation und zeigt Werte und Reiter', async () => {
    rendereApp('/ausrollen', { '/api/v1/ausrollen': json(AUSROLLEN) });
    const nav = await screen.findByRole('navigation', { name: 'Hauptnavigation' });
    expect(within(nav).getByRole('link', { name: 'Ausrollen' })).toBeTruthy();
    expect(await screen.findByText('https://ingest.example.org')).toBeTruthy();
    expect(screen.getByText('https://ingest.example.org/otlp')).toBeTruthy();
    expect(screen.getByText('11111111-1111-4111-8111-111111111111')).toBeTruthy();
    const reiter = screen.getAllByRole('tab').map((t) => t.textContent);
    expect(reiter).toEqual([
      'Managed Settings (MDM)',
      'Server-Managed Settings (Team/Enterprise)',
      'Benutzer-Einstellungen',
      'Start-Wrapper (Shell)',
      'Agent installieren',
    ]);
    // Standard: Helper-Variante mit Festlegung auf beide Orgs, kein Token.
    const mdm = JSON.parse(schnipsel('mdm')) as Record<string, unknown>;
    expect(mdm.otelHeadersHelper).toBe('$HOME/.seatmeter/bin/seatmeter-agent otel-headers');
    expect(mdm.forceLoginOrgUUID).toHaveLength(2);
    expect(schnipsel('mdm')).not.toContain('smi_');
    expect(screen.queryByText(/SEATMETER_INGEST_URL/)).toBeNull();
  });

  it('warnt, wenn die Ingest-URL nur aus der Anfrage stammt', async () => {
    rendereApp('/ausrollen', {
      '/api/v1/ausrollen': json({ ...AUSROLLEN, ingest_url_quelle: 'anfrage' }),
    });
    expect(await screen.findByText(/aus der Anfrage an das Dashboard abgeleitet/)).toBeTruthy();
    expect(screen.getByText('SEATMETER_INGEST_URL')).toBeTruthy();
  });

  it('setzt ein neues Mandanten-Token in die Schnipsel ein (POST mit CSRF)', async () => {
    const { aufrufe } = rendereApp('/ausrollen', {
      '/api/v1/ausrollen': json(AUSROLLEN),
      'POST /api/v1/ausrollen/mandanten-token': json(
        { token: TOKEN, praefix: 'smi_frisch', erstellt: '2026-10-22T10:00:00.000Z' },
        201,
      ),
    });
    fireEvent.click(await screen.findByLabelText(/Fester Mandanten-Token/));
    expect(screen.getByText(/alle Rechner teilen sich einen Token/i)).toBeTruthy();
    expect(schnipsel('mdm')).toContain('Authorization=Bearer <MANDANTEN-TOKEN>');
    expect(schnipsel('mdm')).not.toContain('otelHeadersHelper');

    fireEvent.click(screen.getByRole('button', { name: 'Neues Mandanten-Token erzeugen' }));
    expect(
      await screen.findByText('Nur jetzt sichtbar – sofort in die Verteilung übernehmen.'),
    ).toBeTruthy();
    const mdm = JSON.parse(schnipsel('mdm')) as { env: Record<string, string> };
    expect(mdm.env.OTEL_EXPORTER_OTLP_HEADERS).toBe(`Authorization=Bearer ${TOKEN}`);
    const post = aufrufe.find((a) => a.pfad === '/api/v1/ausrollen/mandanten-token');
    expect(post?.methode).toBe('POST');
    expect(post?.headers['x-seatmeter-csrf']).toBe(CSRF);

    // Auch in Server-Managed und Benutzer-Einstellungen, nie im Start-Wrapper.
    fireEvent.click(screen.getByRole('tab', { name: 'Benutzer-Einstellungen' }));
    expect(schnipsel('benutzer')).toContain(TOKEN);
    fireEvent.click(screen.getByRole('tab', { name: 'Start-Wrapper (Shell)' }));
    expect(schnipsel('wrapper')).not.toContain(TOKEN);
    expect(schnipsel('wrapper')).toContain('otelHeadersHelper');

    // Zurück zur Helper-Variante: Token verschwindet aus den Schnipseln.
    fireEvent.click(screen.getByLabelText(/Rechner-Token über den Agenten/));
    fireEvent.click(screen.getByRole('tab', { name: 'Managed Settings (MDM)' }));
    expect(schnipsel('mdm')).not.toContain(TOKEN);

    // Ausblenden verwirft das Token endgültig.
    fireEvent.click(screen.getByLabelText(/Fester Mandanten-Token/));
    expect(schnipsel('mdm')).toContain(TOKEN);
    fireEvent.click(screen.getByRole('button', { name: 'Token ausblenden' }));
    expect(schnipsel('mdm')).toContain('<MANDANTEN-TOKEN>');
    expect(screen.queryByText(new RegExp(TOKEN))).toBeNull();
  });

  it('nimmt Agent-Pfad und Org-Festlegung in die Schnipsel auf', async () => {
    rendereApp('/ausrollen', { '/api/v1/ausrollen': json(AUSROLLEN) });
    const pfad = await screen.findByLabelText('Agent-Pfad');
    fireEvent.change(pfad, { target: { value: '/opt/seatmeter/agent' } });
    fireEvent.click(screen.getByLabelText(/Anmeldung auf die Org festlegen/));
    const mdm = JSON.parse(schnipsel('mdm')) as Record<string, unknown>;
    expect(mdm.otelHeadersHelper).toBe('/opt/seatmeter/agent otel-headers');
    expect(mdm.forceLoginMethod).toBeUndefined();
  });

  it('erzeugt den Start-Wrapper aus den Pfaden und meldet ungültige Zeilen', async () => {
    rendereApp('/ausrollen', { '/api/v1/ausrollen': json(AUSROLLEN) });
    fireEvent.click(await screen.findByRole('tab', { name: 'Start-Wrapper (Shell)' }));
    expect(schnipsel('wrapper')).toContain('"$HOME/kunden"/*)');
    fireEvent.change(screen.getByLabelText('Pfade (einer je Zeile)'), {
      target: { value: '~/kunden\nrelativ\n/srv/Meine Kunden/' },
    });
    expect(schnipsel('wrapper')).toContain('"$HOME/kunden"/*|"/srv/Meine Kunden"/*)');
    expect(screen.getByRole('alert').textContent).toContain('Zeile 2');
  });

  it('zeigt im Reiter Agent den Einmalcode im enroll-Befehl', async () => {
    const { aufrufe } = rendereApp('/ausrollen', {
      '/api/v1/ausrollen': json(AUSROLLEN),
      'POST /api/v1/rechner/einmalcode': () =>
        Response.json(
          { code: 'CODE-7', laeuft_ab: '2026-10-23T10:00:00Z', person_id: null, bezeichnung: 'NB' },
          { status: 201 },
        ),
    });
    fireEvent.click(await screen.findByRole('tab', { name: 'Agent installieren' }));
    expect(schnipsel('agent-install')).toContain(
      '/v0.1.0/agent-install.sh | SEATMETER_RELEASE_URL=https://git.example.org/beispiel/seatmeter/releases/download/v0.1.0 sh',
    );
    expect(schnipsel('agent-enroll')).toContain('enroll <EINMALCODE> --server');
    expect(schnipsel('agent-sweeper')).toContain('--sweeper-only --include $HOME/kunden');

    fireEvent.change(screen.getByLabelText('Bezeichnung (optional)'), { target: { value: 'NB' } });
    fireEvent.click(screen.getByRole('button', { name: 'Einmalcode erzeugen' }));
    await waitFor(() =>
      expect(schnipsel('agent-enroll')).toBe(
        '$HOME/.seatmeter/bin/seatmeter-agent enroll CODE-7 --server https://ingest.example.org\n',
      ),
    );
    expect(aufrufe.find((a) => a.pfad === '/api/v1/rechner/einmalcode')?.body).toEqual({
      bezeichnung: 'NB',
    });
    fireEvent.click(screen.getByRole('button', { name: 'Ausblenden' }));
    expect(schnipsel('agent-enroll')).not.toContain('CODE-7');
  });

  it('meldet eine fehlende Release-URL', async () => {
    rendereApp('/ausrollen', {
      '/api/v1/ausrollen': json({ ...AUSROLLEN, agent: { ...AUSROLLEN.agent, release_url: null } }),
    });
    fireEvent.click(await screen.findByRole('tab', { name: 'Agent installieren' }));
    expect(screen.getByText('SEATMETER_AGENT_RELEASE_URL')).toBeTruthy();
    expect(screen.queryByTestId('schnipsel-agent-install')).toBeNull();
  });

  it('zeigt Nicht-Admins bei 403 nur einen Hinweis', async () => {
    rendereApp('/ausrollen', {
      '/api/v1/auth/me': json(ME_LESER),
      '/api/v1/ausrollen': json({ fehler: 'Keine Berechtigung' }, 403),
    });
    expect(await screen.findByText(/nur Mandanten-Admins/)).toBeTruthy();
    expect(screen.queryByRole('tab')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Erneut versuchen' })).toBeNull();
  });

  it('kopiert einen Schnipsel und zeigt ohne Zwischenablage den Hinweis', async () => {
    rendereApp('/ausrollen', { '/api/v1/ausrollen': json(AUSROLLEN) });
    const knopf = await screen.findByRole('button', { name: 'managed-settings.json kopieren' });
    const original = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    let kopiert = '';
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: (t: string) => ((kopiert = t), Promise.resolve()) },
    });
    try {
      fireEvent.click(knopf);
      await waitFor(() => expect(knopf.textContent).toBe('Kopiert'));
      expect(kopiert).toBe(schnipsel('mdm'));

      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: () => Promise.reject(new Error('verweigert')) },
      });
      fireEvent.click(screen.getByRole('tab', { name: 'Benutzer-Einstellungen' }));
      fireEvent.click(screen.getByRole('button', { name: '~/.claude/settings.json kopieren' }));
      expect(await screen.findByText(/Automatisches Kopieren ist hier nicht möglich/)).toBeTruthy();
    } finally {
      if (original) Object.defineProperty(navigator, 'clipboard', original);
      else Reflect.deleteProperty(navigator, 'clipboard');
    }
  });
});
