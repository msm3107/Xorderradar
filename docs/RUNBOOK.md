# Runbook operatora — Radar Zamówień

Procedury na co dzień i na awarie (PR-07A, D-028). Komendy uruchamiane na hoście aplikacji z
katalogu wdrożenia, ze zmiennymi środowiskowymi produkcji (jak w cronie):

```sh
cd /opt/radar-zamowien
node dist/main.js <komenda>
```

SQL — w `psql` połączonym z bazą aplikacji tym samym użytkownikiem co aplikacja (np.
`psql "$DATABASE_URL"` — nie wpisuj hasła w linii poleceń ani do historii). W przykładach
`<profileId>`, `<sourceId>`, `<runId>`, `<adres>` to miejsca do uzupełnienia. **Nie wklejaj
adresów e-mail klientów ani linków z tokenami do zgłoszeń, czatów i commitów** — tylko
identyfikatory.

## Harmonogram (cron)

```cron
CRON_TZ=Europe/Warsaw
0 6 * * *  cd /opt/radar-zamowien && node dist/main.js ingest >>/var/log/radar/ingest.log 2>&1
30 6 * * * cd /opt/radar-zamowien && node dist/main.js status --notify >>/var/log/radar/status.log 2>&1
30 7 * * * cd /opt/radar-zamowien && node dist/main.js digest >>/var/log/radar/digest.log 2>&1
45 7 * * * cd /opt/radar-zamowien && node dist/main.js status --notify >>/var/log/radar/status.log 2>&1
```

`status --notify` wymaga `OPERATOR_EMAIL` (adres operatora) i tych samych zmiennych e-mail co
`digest` (`EMAIL_MODE=smtp`, `EMAIL_FROM`, `SMTP_URL`; w trybie `test` alert trafia tylko do
`EMAIL_OUTBOX_DIR`). Po zmianie konfiguracji sprawdź ręcznie: `node dist/main.js status` (kod
`0` — wszystko w porządku).

Ścieżkę alertu sprawdź raz po skonfigurowaniu SMTP (`EMAIL_MODE=smtp`): np. pierwsze
`node dist/main.js status --notify` przed pierwszym `ingest` zgłasza `source_never_run` — ten
e-mail musi dojść do skrzynki operatora. Pamiętaj: `EMAIL_MODE=test` zapisuje alert tylko do
outboxu, nikt go nie dostanie.

## Alert statusu

Alert (temat `Radar Zamówień: problem (<kody>)`) przychodzi przy **każdym** uruchomieniu
`status --notify`, dopóki problem trwa. Brak alertu **nie** dowodzi, że wszystko działa:
problem mógł minąć, ale alert mógł się też nie wysłać albo `status` w ogóle się nie uruchomić
(niżej, „Znane ograniczenie”) — sprawdź `/var/log/radar/status.log`. Bieżący stan zawsze pokaże:

```sh
node dist/main.js status | jq .
```

Kody problemów i co zrobić (kilka kodów naraz — zacznij od pierwszego):

| Kod                     | Znaczenie                                                                                                                  | Co zrobić                                                                                                                                                                                                                                                           |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `status_internal_error` | `status` zakończył się nieoczekiwanym błędem (błąd programu); alert ma tylko ten kod, bez treści błędu.                    | Uruchom `node dist/main.js status` ręcznie (kod `1`, `Internal error: …`) i `node dist/main.js health`. Powtarza się — zgłoś błąd (wersja, godzina); do naprawy sprawdzaj źródła i wysyłki zapytaniami z tego runbooka.                                             |
| `database_unavailable`  | `status` nie odczytał bazy (powód i kod w alercie, np. `unreachable (ECONNREFUSED)`, `authentication_failed (28P01)`).     | Sprawdź, czy PostgreSQL działa i czy `DATABASE_URL` jest aktualny: `node dist/main.js health`. Po naprawie — `status`. Inne komendy (ingest, digest) też wtedy nie działają.                                                                                        |
| `schema_not_ready`      | Są oczekujące migracje (np. po wdrożeniu nowej wersji); komendy odmawiają pracy.                                           | `node dist/main.js migrate`, potem `node dist/main.js health`.                                                                                                                                                                                                      |
| `no_enabled_sources`    | Żadne źródło nie jest włączone — nic nie jest pobierane.                                                                   | Włącz źródło (niżej, „Źródła”), jeśli wyłączenie nie było celowe.                                                                                                                                                                                                   |
| `source_failed`         | Ostatni przebieg źródła się nie udał albo nieudany dzień z ostatnich 36 h nie został jeszcze pobrany (`runId`, kod błędu). | Zobacz kod błędu (niżej) i `/var/log/radar/ingest.log`. Gdy przyczyna minęła: `node dist/main.js ingest <sourceId>` — nadrabianie pobiera nieudane dni samo. Dzień pobrany później przestaje być problemem.                                                         |
| `source_never_run`      | Włączone źródło nie ma żadnego przebiegu.                                                                                  | Pierwsze wdrożenie: `node dist/main.js ingest --from <wczoraj−30> --to <wczoraj>` (README, „Cron”). Inaczej sprawdź, czy cron w ogóle działa.                                                                                                                       |
| `source_stale`          | Od 36 h żaden przebieg źródła nie zakończył się `succeeded`/`incomplete`.                                                  | Sprawdź, czy cron uruchamia `ingest` (log crona, `/var/log/radar/ingest.log` — ostatnia linia z dzisiejszą datą). Uruchom `node dist/main.js ingest` ręcznie i obserwuj kod wyjścia.                                                                                |
| `deliveries_pending`    | Wysyłki z niepewnym wynikiem czekają na decyzję operatora (a żaden `digest` nie trwa).                                     | Procedura „Wysyłki niepewne” niżej. Bez decyzji te oferty nie trafią do profilu, a profil z dzisiejszym `pending` nic dziś nie dostanie.                                                                                                                            |
| `deliveries_failed`     | Wysyłki z dniem digestu od wczoraj się nie udały: „do ponowienia” (kolejny `digest` spróbuje sam) i „bez dalszych prób”.   | Kody `smtp_…` w alercie. Błąd konfiguracji (logowanie, TLS) — popraw `SMTP_URL`/`EMAIL_FROM`, kolejny `digest` wyśle. Odrzucony adres (np. `smtp_550`) — sprawdź adres profilu z klientem. Alert znika, gdy wysyłka się uda albo gdy błąd jest starszy niż wczoraj. |

Nieudany dzień jest w `source_failed` tylko, dopóki jego nieudany przebieg ma mniej niż 36 h;
starszy przestaje być wymieniany. Trwająca awaria nie znika jednak z alertu: kolejne nieudane
przebiegi dają dalej `source_failed` (ostatni przebieg nieudany), a brak sukcesu przez 36 h —
`source_stale`. Dzień, który wypadł z okna, nadrabia `ingest` (do 31 dni wstecz) albo
`ingest --from … --to …`.

Kody błędów przebiegu źródła (`error_code` w `ingestion_runs`): `http_status` (źródło odpowiedziało
błędem — kod HTTP w `ingest.log`), `timeout`, `network`, `dns_failed`, `budget_exhausted`
(za dużo błędów w przebiegu), `source_timeout` (10 min na dzień), `invalid_document` (źródło
zmieniło format — wymaga poprawki adaptera, zgłoś jako nowy PR), `database_error`, `lock_lost`.
Przy `http_status` 403/429 **nie obchodzimy blokady** (brak CAPTCHA/anti-bot bypass,
`docs/SECURITY.md` §7): poczekaj na kolejny cykl, a gdy trwa dłużej — wyłącz źródło i skontaktuj
się z jego właścicielem.

Ostatnie przebiegi źródła:

```sql
SELECT id, publication_date::text, status, error_code, started_at, finished_at
  FROM ingestion_runs WHERE source_id = '<sourceId>'
  ORDER BY started_at DESC LIMIT 10;
```

Sam alert nie przyszedł, a powinien: sprawdź `/var/log/radar/status.log` (linia JSON z
`"notification":"failed"` i komunikat `Operator alert not sent (<kod>)`) oraz skrzynkę
spamu operatora.

**Znane ograniczenie — brak „dead man's switch” (do PR-07B).** `status --notify` wysyła
alert tym samym SMTP i z tego samego crona co reszta systemu. Gdy leży host, cron albo SMTP
(np. `Operator alert not sent (smtp_535)` — odrzucone logowanie, `(smtp_econnrefused)` —
serwer nieosiągalny), operator nie dostaje żadnego e-maila — cisza **nie** oznacza, że
wszystko w porządku. Do czasu PR-07B sprawdzaj ręcznie codziennie (np. rano po 7:45):

```sh
grep '"checkedAt"' /var/log/radar/status.log | tail -n 2  # raporty z 6:30 i 7:45
grep '"digestDate"' /var/log/radar/digest.log | tail -n 1 # wynik dzisiejszego digest
```

Obie linie `status` mają dzisiejszy `checkedAt` (UTC; 6:30 i 7:45 w Polsce to ta sama data) i
nie mają `"notification":"failed"`; linia `digest` ma dzisiejszy `digestDate` i
`"status":"ok"`. Brak linii, stara data albo `"failed"` — zacznij od
`node dist/main.js status` i logu crona. PR-07B doda zewnętrzny heartbeat (ping do
zewnętrznego endpointu po `status` z kodem `0`, alarm przy braku pingu) albo drugi kanał (np.
`MAILTO` crona przez inny serwer pocztowy).

## Źródła: włączanie i wyłączanie

Źródła są w tabeli `sources`; `ingest` bez argumentów pobiera wszystkie włączone, `status`
raportuje tylko włączone.

```sql
SELECT id, name, enabled, updated_at FROM sources ORDER BY id;
-- wyłączenie (np. źródło blokuje nas albo zmieniło format):
UPDATE sources SET enabled = false, updated_at = now() WHERE id = '<sourceId>';
-- ponowne włączenie:
UPDATE sources SET enabled = true, updated_at = now() WHERE id = '<sourceId>';
```

Po ponownym włączeniu `ingest` nadrabia najwyżej 31 ostatnich dni. **Nowe źródło** to zawsze
nowy PR (adapter, fixture'y, review; `docs/PR_PLAN.md`) — wiersz w `sources` dodaje jego
migracja. Nie dodawaj wiersza ręcznie dla źródła bez adaptera (`ingest` skończy się
`no_adapter`).

## Wysyłki niepewne i ponowne wysłanie

Zasady: `docs/DECISIONS.md` D-024; zapytania także w README, „Digest (e-mail)”.

Wynik niepewny (`pending`) — połączenie zerwane w trakcie wysyłki albo przerwany proces.
**Nie ponawiaj na ślepo** (klient mógłby dostać e-mail dwa razy):

```sql
SELECT profile_id, digest_date::text, count(*) AS offers
  FROM deliveries WHERE status = 'pending'
  GROUP BY profile_id, digest_date ORDER BY digest_date;
```

1. Sprawdź log serwera SMTP / skrzynkę wysłanych dla tego profilu i dnia (tryb `test`: pliki
   w `EMAIL_OUTBOX_DIR`).
2. E-mail doszedł:

   ```sql
   UPDATE deliveries SET status = 'sent', sent_at = now(), attempts = attempts + 1
     WHERE status = 'pending' AND profile_id = '<profileId>';
   ```

3. Nie doszedł — kolejny `digest` wyśle te oferty jak nowe (jeśli nadal się kwalifikują):

   ```sql
   DELETE FROM deliveries WHERE status = 'pending' AND profile_id = '<profileId>';
   ```

Wysyłki `failed` z wyczerpanymi próbami (`attempts` = 3) nie są już ponawiane. Po usunięciu
przyczyny (np. poprawiony adres profilu) można je wysłać ponownie, usuwając te wiersze:

```sql
SELECT profile_id, opportunity_id, digest_date::text, attempts, error_code
  FROM deliveries WHERE status = 'failed' ORDER BY digest_date DESC LIMIT 50;
DELETE FROM deliveries
  WHERE status = 'failed' AND attempts >= 3 AND profile_id = '<profileId>';
```

Przed pierwszą prawdziwą wysyłką i po każdej zmianie SMTP: `node dist/main.js digest --dry-run`.

## Skrzynka odpowiedzi (`EMAIL_FROM`)

Odbiorcy rezygnują, odpowiadając na e-mail albo przyciskiem „Anuluj subskrypcję” (wiadomość
„wypis” na `EMAIL_FROM`). Na tę skrzynkę trafiają też zwroty (bounce). **Sprawdzaj ją
codziennie, w dni robocze** — rezygnację realizujemy bez zwłoki.

- Rezygnacja / prośba o wypis:

  ```sql
  SELECT id, active FROM company_profiles WHERE email = '<adres>';
  UPDATE company_profiles SET active = false, updated_at = now() WHERE id = '<profileId>';
  ```

  (Wypis jednym kliknięciem przez link `https` działa sam, bez operatora.)

- Zwrot „adres nie istnieje” — wyłącz profil jak wyżej i skontaktuj się z klientem innym
  kanałem.
- Prośba o usunięcie danych — to usuwanie danych (`docs/SECURITY.md` §14): potwierdzenie
  właściciela projektu; dane zostają w starszych backupach do końca ich retencji.

## Dostęp klienta: przekazany e-mail, zgubione urządzenie

Kto ma e-mail z linkiem albo sesję, ma dostęp do profilu. Odebranie dostępu:

```sh
node dist/main.js access:revoke <profileId>   # {"status":"ok","tokens":…,"sessions":…}
```

Unieważnia wszystkie linki (logowania i wypisu) i sesje profilu naraz; profil i powiadomienia
zostają. Gdy ktoś przejął powiadomienia zmianą adresu: najpierw `access:revoke`, potem
poprawka adresu
(`UPDATE company_profiles SET email = '<adres>', updated_at = now() WHERE id = '<profileId>';`)
i nowy link dla właściciela:

```sh
node dist/main.js access:link <profileId>     # link jest sekretem — tylko właścicielowi
```

## Backup i odtworzenie

Wymagany klient PostgreSQL ≥ 16 (`pg_dump --version`, `pg_restore --version`).

```sh
install -d -m 0700 /var/backups/radar
node dist/main.js backup /var/backups/radar
# {"status":"ok","file":"/var/backups/radar/radar-<RRRRMMDDTGGMMSSZ>.dump","bytes":…,"schema":"public","tables":…}
```

- Wszystkie ustawienia połączenia (host, port, użytkownik, hasło, baza, `options`, TLS) muszą
  być w `DATABASE_URL`. Niepusta zmienna `PGHOST`, `PGHOSTADDR`, `PGPORT`, `PGUSER`,
  `PGPASSWORD`, `PGDATABASE`, `PGOPTIONS`, `PGSSLMODE` lub `PGSSLNEGOTIATION` w środowisku →
  odmowa `unsupported_database_url` z samą nazwą zmiennej (aplikacja by jej użyła, a
  `pg_dump`/`pg_restore` dostają czyste środowisko — mogłyby połączyć się gdzie indziej albo
  bez TLS). Usuń zmienną i przenieś ustawienie do `DATABASE_URL`.
- Katalog backupu musi leżeć na **lokalnym** systemie plików z obsługą twardych dowiązań (np.
  ext4, xfs): plik powstaje pod nazwą tymczasową i jest dowiązywany pod nazwę docelową, bez
  nadpisywania. Bez twardych dowiązań (np. część udziałów sieciowych, FAT/exFAT) → `write_failed`.
- Plik ma prawa `0600` i **zawiera dane osobowe**. Kopia poza hostem — tylko zaszyfrowana
  (np. `age`/`gpg` przed wysłaniem) i w miejscu z ograniczonym dostępem.
- **Do PR-07B backup i jego pilnowanie są ręczne.** `status` nie sprawdza backupów (PR-07B
  doda kontrolę wieku najnowszego `radar-*.dump`): nieudany albo nieuruchomiony backup nie da
  alertu. Dopisz backup do crona sam (codziennie przed `ingest`), sprawdzaj jego log i kod
  wyjścia (np. przy cotygodniowym przeglądzie: dzisiejszy plik w `/var/backups/radar` i
  `"status":"ok"` w ostatniej linii logu), kasuj ręcznie pliki starsze niż uzgodniona retencja
  i rób ręcznie zaszyfrowaną kopię poza hostem. Przykładowa linia crona (ścieżki i plik logu
  — przykład; w tej samej tabeli z `CRON_TZ=Europe/Warsaw`):

  ```cron
  30 5 * * * cd /opt/radar-zamowien && node dist/main.js backup /var/backups/radar >>/var/log/radar/backup.log 2>&1
  ```

- Błąd → kod `1` i stały powód, np. `tool_not_found` (brak klienta 16+), `version_mismatch`
  (klient starszy niż serwer), `authentication_failed`, `unreachable`, `file_exists`
  (backup z tej samej sekundy już jest). Nic nie zostaje na dysku.

Odtwarzaj **tylko** pliki utworzone przez nasz `backup` — z katalogu backupu (dostęp tylko dla
właściciela) albo z zaszyfrowanej kopii poza hostem, po jej odszyfrowaniu. Dump wykonuje swój
SQL jako rola aplikacji: obcy lub podmieniony plik może zapisać w bazie dowolne dane, do których
ta rola ma dostęp. Pliku z niepewnego źródła nie odtwarzaj wcale.

### Próba odtworzenia (co miesiąc i po każdej zmianie wersji PostgreSQL)

Odtwarzamy do **osobnej, nowej bazy** (jej schemat `public` jest pusty) — nigdy do produkcji.
Jako administrator PostgreSQL:

```sh
sudo -u postgres createdb --owner=radar radar_restore_drill
```

Potem, jako aplikacja, z plikiem środowiska dla bazy próbnej (prawa `0600`, poza
repozytorium), np. `/etc/radar/restore-drill.env` z jedną linią
`DATABASE_URL=postgres://radar:<hasło>@<host>:5432/radar_restore_drill` (ta sama rola, inna
baza; hasło nie trafia do linii poleceń). `env -i` uruchamia bez zmiennych produkcji, które
inaczej miałyby pierwszeństwo przed plikiem:

```sh
DRILL='env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/nonexistent node --env-file=/etc/radar/restore-drill.env dist/main.js'
$DRILL restore /var/backups/radar/radar-<czas>.dump
# {"status":"ok","schema":"public","tables":{"company_profiles":…,"opportunities":…,…},"pendingMigrations":[],…}
$DRILL health
```

Porównaj liczby wierszy z produkcją
(`SELECT count(*) FROM company_profiles;` itd.; produkcja mogła się w międzyczasie zmienić
o dzisiejsze przebiegi). Potem usuń bazę próbną — zawiera dane osobowe:

```sh
sudo -u postgres dropdb radar_restore_drill
```

`restore` odmawia (`target_not_empty`), gdy w schemacie docelowym jest jakakolwiek tabela,
widok lub sekwencja, i działa w jednej transakcji: błąd (`tool_failed`) zostawia schemat
pusty. Kod `1` z `not_migrated` — backup sprzed nowszej wersji aplikacji: uruchom `migrate`.

### Awaria: odtworzenie produkcji

1. Zatrzymaj cron i `serve` (nic nie może pisać do bazy).
2. Utwórz nową, pustą bazę (`createdb --owner=radar radar_new`) i odtwórz do niej najnowszy
   backup jak w próbie wyżej; sprawdź `health` i liczby wierszy.
3. Przełącz `DATABASE_URL` aplikacji na nową bazę, uruchom `serve`, potem cron. Pierwszy
   `ingest` nadrobi brakujące dni (do 31).
4. Wysyłki od czasu backupu nie są zapisane: klient może dostać część ofert drugi raz.
5. Starej bazy nie usuwaj bez potwierdzenia właściciela projektu (`docs/SECURITY.md` §14).

## Reverse proxy: logi

Ścieżki `/dostep/…` (logowanie) i `/wypis/…` (wypis) zawierają tokeny dające dostęp do
profilu. **Proxy nie może zapisywać tych ścieżek w logach dostępu** — wyłącz log dla tych
ścieżek albo zapisuj ścieżkę przyciętą (np. tylko `/dostep`). To samo dotyczy narzędzi
monitoringu i APM przed aplikacją. HSTS ustawia sama aplikacja (`max-age=31536000`, bez
`includeSubDomains`) — proxy nie dodaje drugiego nagłówka. Konfiguracja proxy i hostingu —
PR-07B.
