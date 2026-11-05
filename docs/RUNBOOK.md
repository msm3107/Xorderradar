# Runbook operatora — Radar Zamówień

Procedury na co dzień i na awarie (PR-07A, D-028). Komendy uruchamiane na hoście aplikacji z
katalogu wdrożenia, ze zmiennymi środowiskowymi produkcji (jak w cronie). Instalacja i
aktualizacja — [`DEPLOY.md`](DEPLOY.md) (PR-07B, D-029); tam aplikacja działa jako użytkownik
`radar` z konfiguracją w `/etc/radar/radar.env`, więc `node dist/main.js` w przykładach niżej
oznacza (jako root):

```sh
cd /opt/radar-zamowien
runuser -u radar -- /usr/bin/node --env-file=/etc/radar/radar.env dist/main.js <komenda>
```

SQL — jako root w `psql` przez lokalne konto `postgres` (bez hasła w linii poleceń i w
historii), a pierwszym poleceniem przejdź na rolę aplikacji — zapytania i zmiany mają wtedy jej
uprawnienia, nie superużytkownika:

```sh
sudo -u postgres psql -d radar            # potem: SET ROLE radar;
```

W przykładach `<profileId>`, `<sourceId>`, `<runId>`, `<adres>` to miejsca do uzupełnienia.
**Nie wklejaj adresów e-mail klientów ani linków z tokenami do zgłoszeń, czatów i commitów** — tylko
identyfikatory.

## Harmonogram (cron)

Plik `deploy/cron/radar` (instalowany jako `/etc/cron.d/radar`, `DEPLOY.md` punkt 9). Godziny to
czas lokalny hosta — strefa hosta `Europe/Warsaw` (`timedatectl`; cron Debiana/Ubuntu nie zna
`CRON_TZ`):

| Godzina | Zadanie                                | Log                         |
| ------- | -------------------------------------- | --------------------------- |
| 5:30    | `backup /var/backups/radar`            | `/var/log/radar/backup.log` |
| 5:45    | retencja: zostaje 14 najnowszych kopii | —                           |
| 6:00    | `ingest`                               | `/var/log/radar/ingest.log` |
| 6:30    | `status --notify` (+ heartbeat)        | `/var/log/radar/status.log` |
| 7:30    | `digest`                               | `/var/log/radar/digest.log` |
| 7:45    | `status --notify` (+ heartbeat)        | `/var/log/radar/status.log` |

Logi rotuje `deploy/logrotate/radar` (codziennie, 14 dni). `serve` nie jest w cronie — to unit
systemd `radar-serve` (`journalctl -u radar-serve`).

`status --notify` wymaga `OPERATOR_EMAIL` (adres operatora) i tych samych zmiennych e-mail co
`digest` (`EMAIL_MODE=smtp`, `EMAIL_FROM`, `SMTP_URL`; w trybie `test` alert trafia tylko do
`EMAIL_OUTBOX_DIR`). Po zmianie konfiguracji sprawdź ręcznie: `node dist/main.js status` (kod
`0` — wszystko w porządku).

Ścieżkę alertu sprawdź raz po skonfigurowaniu SMTP (`EMAIL_MODE=smtp`) celowym, nieszkodliwym
problemem — nieistniejący `BACKUP_DIR` w linii poleceń (ma pierwszeństwo przed `--env-file`):

```sh
cd /opt/radar-zamowien && runuser -u radar -- env BACKUP_DIR=/nonexistent /usr/bin/node --env-file=/etc/radar/radar.env dist/main.js status --notify
```

Oczekiwane: kod `1`, `backup_dir_unreadable` w `problems`, `"heartbeat":"skipped"`, a e-mail z
`backup_dir_unreadable` w temacie dochodzi do skrzynki operatora
(`DEPLOY.md` punkt 13, „Próba ścieżki alertu”). Pamiętaj: `EMAIL_MODE=test` zapisuje alert
tylko do outboxu, nikt go nie dostanie.

## Alert statusu

Alert (temat `Radar Zamówień: problem (<kody>)`) przychodzi przy **każdym** uruchomieniu
`status --notify`, dopóki problem trwa. Brak alertu **nie** dowodzi, że wszystko działa:
problem mógł minąć, ale alert mógł się też nie wysłać albo `status` w ogóle się nie uruchomić
(niżej, „Heartbeat”) — sprawdź `/var/log/radar/status.log`. Bieżący stan zawsze pokaże:

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
| `backup_dir_unreadable` | `BACKUP_DIR` nie da się odczytać (kod w alercie, np. `ENOENT` — brak katalogu, `EACCES` — brak uprawnień).                 | Sprawdź katalog i prawa: `ls -ld /var/backups/radar` (`radar:radar 0700`), wartość `BACKUP_DIR` w `/etc/radar/radar.env`.                                                                                                                                           |
| `backup_missing`        | W `BACKUP_DIR` nie ma żadnej kopii `radar-<RRRRMMDDTGGMMSSZ>.dump`.                                                        | Pierwsze wdrożenie: `node dist/main.js backup /var/backups/radar`. Inaczej — `/var/log/radar/backup.log` i niżej, „Backup i odtworzenie”.                                                                                                                           |
| `backup_stale`          | Najnowsza kopia (czas z nazwy pliku) jest starsza niż 26 h — nocny backup nie zadziałał (wychodzi w `status` z 7:45).      | Ostatnia linia `/var/log/radar/backup.log` (powód, np. `unreachable`, `version_mismatch`, `write_failed`), po naprawie `node dist/main.js backup /var/backups/radar` ręcznie.                                                                                       |

Nieudany dzień jest w `source_failed` tylko, dopóki jego nieudany przebieg ma mniej niż 36 h;
starszy przestaje być wymieniany. Trwająca awaria nie znika jednak z alertu: kolejne nieudane
przebiegi dają dalej `source_failed` (ostatni przebieg nieudany), a brak sukcesu przez 36 h —
`source_stale`. Dzień, który wypadł z okna, nadrabia `ingest` (do 31 dni wstecz) albo
`ingest --from … --to …`.

Kody błędów przebiegu źródła (`error_code` w `ingestion_runs`): `http_status` (źródło odpowiedziało
błędem — kod HTTP w `ingest.log`), `timeout`, `network`, `dns_failed`, `budget_exhausted`
(za dużo błędów w przebiegu), `source_timeout` (15 min na dzień), `invalid_document` (źródło
zmieniło format — wymaga poprawki adaptera, zgłoś jako nowy PR), `database_error`, `lock_lost`,
`blocked_address` (host źródła wskazuje na adres prywatny — sprawdź DNS i `/etc/hosts`, np.
wpis pozostały po próbie z `DEPLOY.md` punkt 13).
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

Kody `backup_…` pojawiają się tylko z ustawionym `BACKUP_DIR` (wdrożenie z `DEPLOY.md`:
`/var/backups/radar`); wiersz `Kopia zapasowa: …` w alercie podaje stan, czas najnowszej kopii
i liczbę plików.

### Heartbeat („dead man's switch”)

`status --notify` wysyła alert tym samym SMTP i z tego samego crona co reszta systemu. Gdy leży
host, cron albo SMTP (np. `Operator alert not sent (smtp_535)` — odrzucone logowanie,
`(smtp_econnrefused)` — serwer nieosiągalny), żaden e-mail nie dojdzie. Dlatego z ustawionym
`HEARTBEAT_URL` każdy `status` z kodem `0` wysyła jeden ping do zewnętrznej usługi (konfiguracja:
`DEPLOY.md` punkt 10), a ta alarmuje innym kanałem, gdy ping nie przyjdzie. **Alarm z usługi
heartbeat** oznacza: `status` znalazł problem (wtedy był też alert e-mail — chyba że nie
doszedł), nie uruchomił się (host, cron) albo ping się nie udał. Zacznij od:

```sh
node dist/main.js status | jq .
grep '"checkedAt"' /var/log/radar/status.log | tail -n 2  # raporty z 6:30 i 7:45
journalctl -u cron --since today | grep radar             # czy cron uruchomił zadania
```

W linii JSON `status` pole `heartbeat`: `sent` (ping przyjęty), `skipped` (kod `1` — był
problem, pingu nie ma celowo), `failed` (ping nieudany; w logu `Heartbeat ping failed (<powód>)`,
np. `timeout`, `http_404` — zły URL, `network_enotfound`), `disabled` (brak `HEARTBEAT_URL`).
Nieudany ping nie zmienia kodu wyjścia ani nie jest ponawiany — kolejny `status` wyśle nowy.
Ręczne `status` z kodem `0` też pinguje i przesuwa termin w usłudze heartbeat (liczony od
ostatniego pingu) — alarm za brak porannych pingów przyjdzie wtedy później.

Heartbeat **nie** obejmuje `serve` (strony): pingi wysyła `status` z crona. Dostępność strony
sprawdza zewnętrzny monitoring `https://<domena>/zdrowie` (`DEPLOY.md` punkt 10). Alarm
monitoringu:

- **`503` z treścią `niedostępne`** — `serve` działa i odpowiada przez Caddy, ale nie dostał
  odpowiedzi bazy na `select 1` w 2 s (baza nie działa, odrzuca połączenie z sandboksu
  `serve` albo jest przeciążona). Kolejno:
  1. `systemctl status postgresql` — baza działa?
  2. `$RADAR health` (jako `radar`, poza sandboksem `serve`; `$RADAR` — `DEPLOY.md`
     punkt 6) wypisuje JSON. `"database":{"status":"ok"}` tutaj (przy migracjach
     zastosowanych całość to `"status":"ok"`, kod `0`), a `503` z `serve` → problem leży po
     stronie unitu (`IPAddressAllow`, host w `DATABASE_URL` inny niż `localhost`/`127.0.0.1`)
     albo w puli `serve` — `systemctl restart radar-serve`. `"database":{"status":"error",…}`
     tutaj (`reason`/`code`) → to problem bazy, nie `serve`.
  3. `journalctl -u radar-serve -n 200 | grep health_check_failed` — stały powód
     (`reason`/`code`, np. `unreachable`/`ECONNREFUSED`, `authentication_failed`, `timeout`);
     treści błędów ani danych w logu nie ma.
- **brak odpowiedzi, timeout albo `502`** — nie działa `serve` lub Caddy: zacznij od
  `systemctl status radar-serve`, `journalctl -u radar-serve -n 50` i
  `journalctl -u caddy -n 50`.

Bez `HEARTBEAT_URL` sprawdzaj ręcznie codziennie (np. rano po 7:45): obie linie `status` mają
dzisiejszy `checkedAt` (UTC; 6:30 i 7:45 w Polsce to ta sama data) i nie mają
`"notification":"failed"`; ostatnia linia `digest.log` ma dzisiejszy `digestDate` i
`"status":"ok"`:

```sh
grep '"digestDate"' /var/log/radar/digest.log | tail -n 1 # wynik dzisiejszego digest
```

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

### Baza Konkurencyjności (`bk`, D-030)

Migracja `0007_bk_source` dodaje `bk` **wyłączone**. Pierwsze włączenie i pobranie danych
opisuje `docs/DEPLOY.md`, punkt „Drugie źródło: Baza Konkurencyjności”: najpierw
`source:preview bk` (AC1), potem `UPDATE … enabled = true` i backfill. Źródło bez przebiegów
nadrabia tylko wczoraj, a nie 31 dni.

- **Wyłączenie** (blokada, zmiana formatu, prośba właściciela Bazy):
  `UPDATE sources SET enabled = false, updated_at = now() WHERE id = 'bk';`.
  - BZP działa dalej.
  - Zapisane oferty `bk` zostają i nadal trafiają do digestu z atrybucją, dopóki są w oknie
    7 dni.
  - Jeśli trzeba je wycofać z wysyłek, zgłoś to jako zadanie — nie kasuj wierszy ręcznie.
- **Zmiana formatu (`invalid_document`):** API Bazy jest nieudokumentowane i może się zmienić
  bez zapowiedzi. Przebieg dnia jest `failed`, a `status` z 6:30 zgłasza `source_failed` dla
  `bk`. Postępowanie:
  1. Sprawdź `ingest.log` (`errorCode`, bez treści).
  2. Uruchom ręcznie `source:preview bk --date <dzień> --limit 5` poza kontenerem i porównaj
     wynik.
  3. Wyłącz `bk`, jeśli błąd się powtarza.
  4. Zgłoś poprawkę adaptera jako nowy PR, z nowymi spseudonimizowanymi fixture'ami.

  Po poprawce i ponownym włączeniu nadrabianie ponawia nieudane dni z ostatnich 31.
  Odrzucenia pojedynczych ogłoszeń (`rejected`, powód z nazwą pola, np.
  `invalid value: deadline`) też mogą oznaczać zmianę formatu. Zgłoś
  je, gdy się powtarzają. Dzień z więcej niż 2 przeczytanymi rekordami, w którym odrzucone są
  **wszystkie**, jest `failed` z `invalid_document` („every record of the day was rejected”):
  to zmiana formatu wartości, postępowanie jak przy `invalid_document`. Taki dzień jest
  czytany w całości (typowo ok. 9 min) i dopiero potem kończy się błędem, więc każdy taki dzień
  opóźnia BZP. Gdy ten sam dzień wraca jako `failed` kolejne ranki, wyłącz `bk` (niżej,
  „Kolejność źródeł”). Dzień z 1–2 ogłoszeniami, wszystkimi odrzuconymi, nie jest `failed` —
  widać go tylko w `rejected` w wyniku `ingest`.

- **Lista krótsza niż jej `meta.total` (`invalid_document`, „listing has fewer distinct
  records than its total”, log `source listing short` z liczbami):** lista dnia (jedna strona
  250 rekordów, przy ponad 250 ogłoszeniach strony w dwóch porządkach) dała mniej różnych
  ogłoszeń, niż podaje sama. Dzień jest `failed` przed odczytem szczegółów, nic nie jest
  zapisane, a nadrabianie ponowi go następnego rana. Gdy kolejne ranki kończą się tak również
  dla nowych dni, postępuj jak przy zmianie formatu (wyżej) i wyłącz `bk` (niżej, „Kolejność
  źródeł”). Gdy powtarza się tylko jeden starszy dzień, a nowe przechodzą, zostaw `bk`
  włączone i zgłoś to (ponowienie kosztuje jedno żądanie, nie opóźnia BZP; `status` alarmuje,
  dopóki dzień nie zostanie poprawiony albo nie wyjdzie z 31-dniowego okna). Jeśli w bazie jest
  przebieg `bk` z powodem `listing_mismatch` sprzed tej zmiany, uruchom raz
  `ingest bk --date <dzień>` dla tego dnia.
- **`incomplete` w przebiegu `bk`:**
  - `max_records`: dzień miał więcej ogłoszeń niż `--limit` albo 250
    (`BK_MAX_DETAILS_PER_DAY`). Zaobserwowane maksimum to ok. 180. Powtarzające się
    `max_records` przy domyślnym limicie zgłoś: trzeba przeliczyć budżet i timeout.
  - `detail_missing`: szczegóły ogłoszenia dały 404 (np. wycofane między listą a
    szczegółami). `detail_invalid`: szczegóły nie miały oczekiwanej koperty albo pola wymaganego
    (`source detail fields invalid` w logu: id i ścieżki pól, bez wartości). Ogłoszenie jest
    pominięte (`source detail skipped` w `ingest.log`, z id), reszta dnia zapisana. Możesz
    ponowić dzień ręcznie: `ingest bk --date <dzień>`. Powtarzające się `detail_invalid` zgłoś
    jak zmianę formatu.
- **`http_status` w przebiegu `bk`:** 404 przy szczegółach pomija ogłoszenie (wyżej). Dzień
  jest `failed` dopiero przy trzecich nieczytelnych szczegółach dnia albo gdy żadne nie dały
  się odczytać. 5xx po ponowieniach także kończy dzień jako `failed`, a nadrabianie ponowi go
  następnego rana. 403/429 — jak wyżej, bez obchodzenia blokady.
  - **Kolejność źródeł:** `ingest` czyta źródła według id, czyli `bk` przed `bzp`, i każde
    źródło kończy wszystkie swoje dni, zanim zacznie następne. Każdy ponawiany dzień `bk`
    opóźnia BZP do 15 min. W najgorszym razie BZP startuje po 15 min × liczba dni `bk` do
    nadrobienia, a `ingest` kończy się po 6:30.
  - **Gdy ten sam dzień `bk` jest `failed` kolejne ranki, wyłącz `bk`** (wyżej, „Wyłączenie”)
    i zgłoś problem. BZP zaczyna wtedy znowu o 6:00.
- **`source_timeout`** (15 min): dzień `bk` to do 254 żądań po ~2,9 s. Timeout oznacza
  wolniejsze źródło niż zmierzone. Powtarzający się timeout zgłoś, nie podnoś limitu ręcznie.
- **Atrybucja:** pole „Źródło: Baza Konkurencyjności, Ministerstwo Funduszy i Polityki
  Regionalnej; pobrano …; dane przetworzone …” w e-mailu i na `/dopasowania` jest wymagane
  regulaminem Bazy. Nie usuwaj go.

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
install -d -m 0700 -o radar -g radar /var/backups/radar   # DEPLOY.md punkt 5
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
- Automatycznie (`deploy/cron/radar`): backup codziennie o 5:30, o 5:45 retencja — zostaje 14
  najnowszych plików `radar-*.dump`, starsze są usuwane. `status` (z `BACKUP_DIR`) zgłasza
  `backup_missing` (brak kopii) albo `backup_stale` (najnowsza kopia starsza niż 26 h), więc
  nieudany backup daje alert rano: jedna nieudana noc wychodzi w `status` z 7:45. Wyjątek:
  nieudana tylko noc wiosennej zmiany czasu, po której następny backup się udał, nie jest
  zgłaszana wcale; druga nieudana noc z rzędu wychodzi następnego dnia o 6:30. Przed
  aktualizacją zrób backup ręcznie (`DEPLOY.md` punkt 15). Wynik każdego backupu: ostatnia
  linia `/var/log/radar/backup.log`.
- Kopia poza hostem — zaszyfrowana kluczem publicznym `age` (`DEPLOY.md` punkt 11); klucz
  prywatny tylko u właściciela, poza VPS. Wysyłka bez usuwania (`rrsync -no-del`); retencję
  (14 dni, według wieku pliku) robi serwer kopii.
  `status` jej **nie** sprawdza — **co tydzień** ręcznie: najnowszy plik off-host ma < 48 h
  (polecenie na serwerze kopii — `DEPLOY.md` punkt 11), a `/var/log/radar/offsite.log` nie
  ma błędów (`tail -n 20 /var/log/radar/offsite.log`). Opcjonalny drugi check heartbeat
  z serwera kopii — tamże.
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

Potem, jako aplikacja, z plikiem środowiska dla bazy próbnej (poza repozytorium; czytelny
tylko dla aplikacji — przy wdrożeniu z `DEPLOY.md` `root:radar 0640`), np.
`/etc/radar/restore-drill.env` z jedną linią
`DATABASE_URL=postgres://radar:<hasło>@<host>:5432/radar_restore_drill` (ta sama rola, inna
baza; hasło nie trafia do linii poleceń). `env -i` uruchamia bez zmiennych produkcji, które
inaczej miałyby pierwszeństwo przed plikiem:

```sh
DRILL='runuser -u radar -- env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/nonexistent /usr/bin/node --env-file=/etc/radar/restore-drill.env dist/main.js'
$DRILL restore /var/backups/radar/radar-<czas>.dump
# {"status":"ok","schema":"public","tables":{"company_profiles":…,"opportunities":…,…},"pendingMigrations":[],…}
$DRILL health
```

Porównaj liczby wierszy z `tables` z wyniku `restore` z produkcją (produkcja mogła się w
międzyczasie zmienić o dzisiejsze przebiegi i wysyłki). **Liczby wierszy** produkcji
(`sudo -u postgres psql -d radar`):

```sql
SELECT 'sources' AS tabela, count(*) FROM sources
UNION ALL SELECT 'ingestion_runs', count(*) FROM ingestion_runs
UNION ALL SELECT 'opportunities', count(*) FROM opportunities
UNION ALL SELECT 'company_profiles', count(*) FROM company_profiles
UNION ALL SELECT 'deliveries', count(*) FROM deliveries
UNION ALL SELECT 'access_tokens', count(*) FROM access_tokens
UNION ALL SELECT 'sessions', count(*) FROM sessions;
```

Potem usuń bazę próbną — zawiera dane osobowe — i plik środowiska:

```sh
sudo -u postgres dropdb radar_restore_drill
rm /etc/radar/restore-drill.env
```

`restore` odmawia (`target_not_empty`), gdy w schemacie docelowym jest jakakolwiek tabela,
widok lub sekwencja, i działa w jednej transakcji: błąd (`tool_failed`) zostawia schemat
pusty. Kod `1` z `not_migrated` — backup sprzed nowszej wersji aplikacji: uruchom `migrate`.

### Awaria: odtworzenie produkcji

1. Zatrzymaj cron i `serve` (nic nie może pisać do bazy):
   `mv /etc/cron.d/radar /root/radar.cron.disabled`, `systemctl stop radar-serve`.
2. Utwórz nową, pustą bazę (`sudo -u postgres createdb --owner=radar radar_new`) i odtwórz do niej najnowszy
   backup jak w próbie wyżej; sprawdź `health` i liczby wierszy (`tables` z `restore`).
3. Przełącz `DATABASE_URL` w `/etc/radar/radar.env` na nową bazę, uruchom `serve`
   (`systemctl start radar-serve`), potem cron (plik z powrotem do `/etc/cron.d/radar`) i smoke
   test (`DEPLOY.md` punkt 12). Pierwszy `ingest` nadrobi brakujące dni (do 31).
4. Wysyłki od czasu backupu nie są zapisane: klient może dostać część ofert drugi raz.
5. Starej bazy nie usuwaj bez potwierdzenia właściciela projektu (`docs/SECURITY.md` §14).

## Reverse proxy: logi

Ścieżki `/dostep/…` (logowanie) i `/wypis/…` (wypis) zawierają tokeny dające dostęp do
profilu. **Proxy nie może zapisywać tych ścieżek w logach dostępu.** `deploy/caddy/Caddyfile`
pomija je w logu dostępu (`log_skip`), a nagłówki `Cookie`/`Authorization` Caddy domyślnie
maskuje. Przy zmianie konfiguracji proxy zachowaj oba; to samo dotyczy narzędzi monitoringu i
APM przed aplikacją. HSTS ustawia sama aplikacja (`max-age=31536000`, bez `includeSubDomains`)
— proxy nie dodaje drugiego nagłówka (smoke test sprawdza dokładnie jeden).
