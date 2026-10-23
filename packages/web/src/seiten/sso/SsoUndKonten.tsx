// Seite „SSO und Konten“ (/einrichtung/sso): OIDC-Anbindung, E-Mail-Domains und Konten des aktiven
// Mandanten. Sichtbar nur für Mandanten-Admins und Plattform-Admins; der Server prüft jeden Zugriff.
import { useAuth } from '../../auth/AuthTor';
import { Hinweis } from '../../komponenten/Abfrage';
import { Seitenkopf } from '../../komponenten/Bausteine';
import { Domains } from './Domains';
import { Konten } from './Konten';
import { Oidc } from './Oidc';
import { Scim } from './Scim';
import { TEXT_KEIN_MANDANT, TEXT_NUR_ADMIN } from './texte';

export function SsoUndKonten() {
  const { me } = useAuth();
  const mandantId = me?.mandant_id ?? null;
  const darf = !!me && (me.rollen.includes('mandanten_admin') || me.plattform_admin === true);
  return (
    <>
      <Seitenkopf titel="SSO und Konten" />
      {!darf ? (
        <Hinweis>{TEXT_NUR_ADMIN}</Hinweis>
      ) : !mandantId ? (
        <Hinweis>{TEXT_KEIN_MANDANT}</Hinweis>
      ) : (
        <>
          <Oidc key={`oidc-${mandantId}`} mandantId={mandantId} />
          <Domains key={`domains-${mandantId}`} mandantId={mandantId} />
          <Scim key={`scim-${mandantId}`} mandantId={mandantId} />
          <Konten key={`konten-${mandantId}`} mandantId={mandantId} />
        </>
      )}
    </>
  );
}
