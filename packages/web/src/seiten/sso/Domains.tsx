// Abschnitt „E-Mail-Domains“ von SSO und Konten: Domains des Mandanten, die zur SSO-Anmeldung führen.
// Eine Domain gilt erst nach Verifikation (DNS-TXT-Eintrag oder Plattform-Admin).
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useApi } from '../../api/client';
import { datum } from '../../format';
import { Abfrage, Hinweis } from '../../komponenten/Abfrage';
import { Abschnitt, Tabelle } from '../../komponenten/Bausteine';
import { Eingabe, Formular } from '../../komponenten/Formular';
import { KNOPF_KLEIN } from '../../komponenten/knoepfe';
import { useState } from 'react';
import { domainPruefungSchema, domainSchema, domainsSchema, type DomainZeile } from './api';
import { mandantPfad } from '../mandant/api';
import { Kopierbar } from './Kopierbar';
import { ssoFehler } from './texte';

function Anleitung({ d, mandantId }: { d: DomainZeile; mandantId: string }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const name = d.txt_name ?? `_seatmeter.${d.domain}`;
  const wert = d.txt_wert ?? `seatmeter-verifizierung=${d.verifizierungs_token ?? ''}`;
  const pruefen = useMutation({
    mutationFn: () =>
      api.post(
        mandantPfad(mandantId, `/domains/${encodeURIComponent(d.domain)}/pruefen`),
        {},
        domainPruefungSchema,
      ),
    onSuccess: () =>
      void queryClient.invalidateQueries({ queryKey: ['sso', mandantId, 'domains'] }),
  });
  return (
    <div className="mt-2 rounded border border-slate-200 bg-slate-50 p-3 text-sm">
      <p>
        Lege für <strong>{d.domain}</strong> einen DNS-TXT-Eintrag an:
      </p>
      <p className="mt-1">
        Name: <Kopierbar text={name} beschriftung={`TXT-Name ${d.domain}`} />
      </p>
      <p className="mt-1">
        Wert: <Kopierbar text={wert} beschriftung={`TXT-Wert ${d.domain}`} />
      </p>
      <button
        type="button"
        className={`${KNOPF_KLEIN} mt-2`}
        disabled={pruefen.isPending}
        onClick={() => pruefen.mutate()}
        aria-label={`${d.domain} jetzt prüfen`}
      >
        {pruefen.isPending ? 'Prüfe …' : 'Jetzt prüfen'}
      </button>
      {pruefen.isError && (
        <p role="alert" className="mt-2 text-red-800">
          {ssoFehler(pruefen.error)}
        </p>
      )}
      {pruefen.data && !pruefen.data.verifiziert && (
        <p role="alert" className="mt-2 text-red-800">
          Noch nicht verifiziert: {pruefen.data.fehler ?? 'Der TXT-Eintrag wurde nicht gefunden.'}
        </p>
      )}
    </div>
  );
}

export function Domains({ mandantId }: { mandantId: string }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const [neueDomain, setNeueDomain] = useState('');
  const schluessel = ['sso', mandantId, 'domains'];
  const abfrage = useQuery({
    queryKey: schluessel,
    queryFn: () => api.get(mandantPfad(mandantId, '/domains'), domainsSchema),
  });
  const neu = () => void queryClient.invalidateQueries({ queryKey: schluessel });
  const hinzufuegen = useMutation({
    mutationFn: () =>
      api.post(
        mandantPfad(mandantId, '/domains'),
        { domain: neueDomain.trim().toLowerCase() },
        domainSchema,
      ),
    onSuccess: () => {
      setNeueDomain('');
      neu();
    },
  });
  const entfernen = useMutation({
    mutationFn: (domain: string) =>
      api.delete(mandantPfad(mandantId, `/domains/${encodeURIComponent(domain)}`)),
    onSuccess: neu,
  });
  return (
    <Abschnitt titel="E-Mail-Domains">
      <Abfrage abfrage={abfrage}>
        {({ domains }) => (
          <>
            {domains.length === 0 ? (
              <Hinweis>
                Noch keine Domain. Mit einer verifizierten Domain führt die Anmeldung per E-Mail zum
                SSO des Mandanten.
              </Hinweis>
            ) : (
              <Tabelle<DomainZeile>
                beschriftung="E-Mail-Domains"
                zeilen={domains}
                schluessel={(d) => d.domain}
                spalten={[
                  { titel: 'Domain', wert: (d) => d.domain },
                  {
                    titel: 'Status',
                    wert: (d) =>
                      d.verifiziert
                        ? `verifiziert${d.verifiziert_am ? ` am ${datum(d.verifiziert_am)}` : ''}`
                        : 'offen',
                  },
                  {
                    titel: 'Quelle',
                    wert: (d) =>
                      d.quelle === 'dns'
                        ? 'DNS-Eintrag'
                        : d.quelle === 'plattform_admin'
                          ? 'Plattform-Admin'
                          : '–',
                  },
                  {
                    titel: 'Aktion',
                    wert: (d) => (
                      <button
                        type="button"
                        className={KNOPF_KLEIN}
                        aria-label={`${d.domain} entfernen`}
                        disabled={entfernen.isPending}
                        onClick={() => entfernen.mutate(d.domain)}
                      >
                        Entfernen
                      </button>
                    ),
                  },
                ]}
              />
            )}
            {entfernen.isError && (
              <p role="alert" className="mt-2 text-sm text-red-800">
                {ssoFehler(entfernen.error)}
              </p>
            )}
            {domains
              .filter((d) => !d.verifiziert)
              .map((d) => (
                <Anleitung key={d.domain} d={d} mandantId={mandantId} />
              ))}
          </>
        )}
      </Abfrage>
      <Formular
        titel="Domain hinzufügen"
        knopf="Hinzufügen"
        onAbsenden={() => neueDomain.trim() && hinzufuegen.mutate()}
        laeuft={hinzufuegen.isPending}
        meldung={hinzufuegen.isError ? ssoFehler(hinzufuegen.error) : null}
      >
        <Eingabe
          beschriftung="Domain (z. B. example.org)"
          wert={neueDomain}
          onAendern={setNeueDomain}
        />
      </Formular>
    </Abschnitt>
  );
}
