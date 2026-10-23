// Seite „Tokens und Orgs“ (/mandant, Einrichtung): Mandanten-Tokens, Org-Positivliste und Rollen des aktiven
// Mandanten für dessen Mandanten-Admin. Der Server prüft jeden Zugriff.
import { useAuth } from '../../auth/AuthTor';
import { Seitenkopf } from '../../komponenten/Bausteine';
import { KeinMandant, MandantOrgs, MandantRollen, MandantTokens } from './Verwaltung';

export function Mandant() {
  const { me } = useAuth();
  const mandantId = me?.mandant_id ?? null;
  return (
    <>
      <Seitenkopf titel="Tokens und Orgs" />
      {!mandantId ? (
        <KeinMandant />
      ) : (
        <>
          <MandantTokens key={`tokens-${mandantId}`} mandantId={mandantId} />
          <MandantOrgs key={`orgs-${mandantId}`} mandantId={mandantId} />
          <MandantRollen key={`rollen-${mandantId}`} mandantId={mandantId} />
        </>
      )}
    </>
  );
}
