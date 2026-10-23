// Abschnitt „Konten“ von SSO und Konten: Einladen, Rollen ändern, Deaktivieren, Rollen entziehen.
// Einladungslinks stehen nur in der Antwort des Servers und werden darum nur einmal angezeigt.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useApi } from '../../api/client';
import { datumZeit } from '../../format';
import { Abfrage, Hinweis } from '../../komponenten/Abfrage';
import { Abschnitt } from '../../komponenten/Bausteine';
import { Eingabe, Formular } from '../../komponenten/Formular';
import { KNOPF_KLEIN } from '../../komponenten/knoepfe';
import { useState } from 'react';
import { mandantPfad, ROLLEN_OPTIONEN } from '../mandant/api';
import {
  kontenSchema,
  kontoAnlegenSchema,
  kontoSchema,
  neueEinladungSchema,
  type EinladungLink,
  type Kontingent,
  type KontoZeile,
} from './api';
import { Kopierbar } from './Kopierbar';
import { absoluterLink, kontingentText, ROLLEN_NAMEN, ssoFehler } from './texte';

function EinmalLink({
  konto,
  einladung,
  onFertig,
}: {
  konto: string;
  einladung: EinladungLink;
  onFertig: () => void;
}) {
  return (
    <div
      role="status"
      className="mt-4 rounded border border-green-300 bg-green-50 p-4 text-sm text-green-900"
    >
      <p className="font-medium">
        Einladungslink für {konto} – nur jetzt sichtbar, bitte sicher weitergeben:
      </p>
      <p className="mt-2">
        <Kopierbar text={absoluterLink(einladung.url)} beschriftung="Einladungslink" />
      </p>
      {einladung.gueltig_bis && (
        <p className="mt-1 text-xs">Gültig bis {datumZeit(einladung.gueltig_bis)}.</p>
      )}
      <button
        type="button"
        onClick={onFertig}
        className="mt-3 rounded border border-green-400 bg-white px-3 py-1 hover:bg-green-100"
      >
        Weitergegeben, ausblenden
      </button>
    </div>
  );
}

function RollenWahl({
  gewaehlt,
  onAendern,
  vorsatz,
}: {
  gewaehlt: string[];
  onAendern: (rollen: string[]) => void;
  vorsatz: string;
}) {
  return (
    <fieldset className="text-sm sm:col-span-2">
      <legend className="font-medium text-slate-700">Rollen</legend>
      <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
        {ROLLEN_OPTIONEN.map(([rolle, text]) => (
          <label key={rolle} className="flex items-center gap-2">
            <input
              type="checkbox"
              aria-label={`${vorsatz}${text}`}
              checked={gewaehlt.includes(rolle)}
              onChange={(e) =>
                onAendern(
                  e.target.checked ? [...gewaehlt, rolle] : gewaehlt.filter((r) => r !== rolle),
                )
              }
            />
            {text}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function statusText(k: KontoZeile): string {
  if (k.deaktiviert) return `deaktiviert seit ${datumZeit(k.deaktiviert)}`;
  if (k.einladung_offen)
    return `Einladung offen${k.einladung_bis ? ` bis ${datumZeit(k.einladung_bis)}` : ''}`;
  return 'aktiv';
}

function KontoKarte({
  k,
  aktion,
  laeuft,
  neuerLink,
}: {
  k: KontoZeile;
  aktion: (a: Aktion) => void;
  laeuft: boolean;
  neuerLink: (k: KontoZeile) => void;
}) {
  const aktuelle = k.rollen.map((r) => r.rolle);
  const [aendern, setAendern] = useState(false);
  const [rollen, setRollen] = useState<string[]>([...new Set(aktuelle)]);
  const [entziehenFrage, setEntziehenFrage] = useState(false);
  return (
    <li
      aria-label={`Konto ${k.benutzername}`}
      className="rounded border border-slate-200 bg-white p-3 text-sm"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="font-medium">{k.benutzername}</p>
        <p className="text-xs text-slate-500">
          {k.login === 'oidc' ? 'SSO' : 'Passwort'} · {statusText(k)} · zuletzt angemeldet:{' '}
          {k.zuletzt_angemeldet ? datumZeit(k.zuletzt_angemeldet) : '–'}
        </p>
      </div>
      <p className="mt-1 text-slate-700">
        Rollen:{' '}
        {k.rollen.length === 0
          ? '–'
          : k.rollen
              .map(
                (r) =>
                  `${ROLLEN_NAMEN[r.rolle] ?? r.rolle}${r.quelle === 'oidc' ? ' (SSO-Gruppe)' : r.quelle === 'scim' ? ' (SCIM)' : ''}`,
              )
              .join(', ')}
      </p>
      <div className="mt-2 flex flex-wrap gap-2">
        <button type="button" className={KNOPF_KLEIN} onClick={() => setAendern(!aendern)}>
          {aendern ? 'Rollen schließen' : 'Rollen ändern'}
        </button>
        {k.einladung_offen && (
          <button
            type="button"
            className={KNOPF_KLEIN}
            disabled={laeuft}
            aria-label={`Neuer Einladungslink für ${k.benutzername}`}
            onClick={() => neuerLink(k)}
          >
            Neuer Einladungslink
          </button>
        )}
        <button
          type="button"
          className={KNOPF_KLEIN}
          disabled={laeuft}
          aria-label={`${k.deaktiviert ? 'Aktivieren' : 'Deaktivieren'} ${k.benutzername}`}
          onClick={() => aktion({ art: 'deaktiviert', konto: k, wert: !k.deaktiviert })}
        >
          {k.deaktiviert ? 'Aktivieren' : 'Deaktivieren'}
        </button>
        <button type="button" className={KNOPF_KLEIN} onClick={() => setEntziehenFrage(true)}>
          Alle Rollen entziehen
        </button>
      </div>
      {aendern && (
        <div className="mt-3 rounded bg-slate-50 p-3">
          <RollenWahl gewaehlt={rollen} onAendern={setRollen} vorsatz={`${k.benutzername}: `} />
          <button
            type="button"
            className={`${KNOPF_KLEIN} mt-2`}
            disabled={laeuft || rollen.length === 0}
            aria-label={`Rollen von ${k.benutzername} speichern`}
            onClick={() => aktion({ art: 'rollen', konto: k, rollen })}
          >
            Speichern
          </button>
        </div>
      )}
      {entziehenFrage && (
        <div role="alertdialog" className="mt-3 rounded border border-red-300 bg-red-50 p-3">
          <p>
            Alle Rollen von {k.benutzername} in diesem Mandanten entziehen? Das Konto verliert den
            Zugriff.
          </p>
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              className={KNOPF_KLEIN}
              disabled={laeuft}
              onClick={() => {
                setEntziehenFrage(false);
                aktion({ art: 'entziehen', konto: k });
              }}
            >
              Ja, entziehen
            </button>
            <button type="button" className={KNOPF_KLEIN} onClick={() => setEntziehenFrage(false)}>
              Abbrechen
            </button>
          </div>
        </div>
      )}
    </li>
  );
}

type Aktion =
  | { art: 'rollen'; konto: KontoZeile; rollen: string[] }
  | { art: 'deaktiviert'; konto: KontoZeile; wert: boolean }
  | { art: 'entziehen'; konto: KontoZeile };

export function Konten({ mandantId }: { mandantId: string }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const schluessel = ['sso', mandantId, 'konten'];
  const abfrage = useQuery({
    queryKey: schluessel,
    queryFn: () => api.get(mandantPfad(mandantId, '/konten'), kontenSchema),
  });
  const neu = () => void queryClient.invalidateQueries({ queryKey: schluessel });
  const kontingent: Kontingent | null = abfrage.data?.kontingent ?? null;

  const [email, setEmail] = useState('');
  const [rollen, setRollen] = useState<string[]>(['controller']);
  const [link, setLink] = useState<{ konto: string; einladung: EinladungLink } | null>(null);
  const [hinweis, setHinweis] = useState<string | null>(null);
  const [pruefung, setPruefung] = useState<string | null>(null);

  const einladen = useMutation({
    mutationFn: () =>
      api.post(
        mandantPfad(mandantId, '/konten'),
        { benutzername: email.trim(), rollen },
        kontoAnlegenSchema,
      ),
    onSuccess: (antwort) => {
      setEmail('');
      if (antwort.einladung) {
        setLink({ konto: antwort.konto.benutzername, einladung: antwort.einladung });
        setHinweis(null);
      } else {
        setLink(null);
        setHinweis(
          `${antwort.konto.benutzername} hatte schon ein Konto und hat die Rollen erhalten.`,
        );
      }
      neu();
    },
  });

  const neuerLink = useMutation({
    mutationFn: (k: KontoZeile) =>
      api
        .post(mandantPfad(mandantId, `/konten/${k.id}/einladung`), {}, neueEinladungSchema)
        .then((a) => ({ konto: k.benutzername, einladung: a.einladung })),
    onSuccess: (neuer) => {
      setLink(neuer);
      setHinweis(null);
      neu();
    },
  });

  const aendern = useMutation({
    mutationFn: async (a: Aktion): Promise<void> => {
      const konto = `/konten/${encodeURIComponent(a.konto.id)}`;
      const pfad = mandantPfad(mandantId, konto);
      if (a.art === 'rollen') await api.put(pfad, { rollen: a.rollen }, kontoSchema);
      else if (a.art === 'deaktiviert') await api.put(pfad, { deaktiviert: a.wert }, kontoSchema);
      else await api.delete(mandantPfad(mandantId, `${konto}/rollen`));
    },
    onSuccess: neu,
  });

  const fehler = einladen.error ?? neuerLink.error ?? aendern.error;
  const hatFehler = einladen.isError || neuerLink.isError || aendern.isError;

  return (
    <Abschnitt titel="Konten">
      <Abfrage abfrage={abfrage}>
        {({ konten, kontingent: kt }) => (
          <>
            <p className="text-sm font-medium">{kontingentText(kt)}</p>
            {konten.length === 0 ? (
              <Hinweis>Noch keine Konten.</Hinweis>
            ) : (
              <ul aria-label="Konten des Mandanten" className="mt-3 space-y-2">
                {konten.map((k) => (
                  <KontoKarte
                    key={k.id}
                    k={k}
                    laeuft={aendern.isPending || neuerLink.isPending}
                    aktion={(a) => aendern.mutate(a)}
                    neuerLink={(konto) => neuerLink.mutate(konto)}
                  />
                ))}
              </ul>
            )}
          </>
        )}
      </Abfrage>
      {hatFehler && (
        <p role="alert" className="mt-3 rounded bg-red-50 px-3 py-2 text-sm text-red-800">
          {ssoFehler(fehler, kontingent)}
        </p>
      )}
      {link && (
        <EinmalLink konto={link.konto} einladung={link.einladung} onFertig={() => setLink(null)} />
      )}
      {hinweis && (
        <p role="status" className="mt-3 text-sm text-green-800">
          {hinweis}
        </p>
      )}
      <Formular
        titel="Konto einladen"
        knopf="Einladen"
        onAbsenden={() => {
          if (!email.trim() || !email.includes('@')) {
            setPruefung('Bitte eine E-Mail-Adresse angeben.');
            return;
          }
          if (rollen.length === 0) {
            setPruefung('Bitte mindestens eine Rolle wählen.');
            return;
          }
          setPruefung(null);
          einladen.mutate();
        }}
        laeuft={einladen.isPending}
        meldung={pruefung}
      >
        <Eingabe beschriftung="E-Mail-Adresse" wert={email} onAendern={setEmail} />
        <RollenWahl gewaehlt={rollen} onAendern={setRollen} vorsatz="Einladen als " />
      </Formular>
    </Abschnitt>
  );
}
