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

| Kod                     | Znaczenie                                                                                                                  | Co zrobić                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `status_internal_error` | `status` zakończył się nieoczekiwanym błędem (błąd programu); alert ma tylko ten kod, bez treści błędu.                    | Uruchom `node dist/main.js status` ręcznie (kod `1`, `Internal error: …`) i `node dist/main.js health`. Powtarza się — zgłoś błąd (wersja, godzina); do naprawy sprawdzaj źródła i wysyłki zapytaniami z tego runbooka.                                                                                                                                                                                                                                                                          |
| `database_unavailable`  | `status` nie odczytał bazy (powód i kod w alercie, np. `unreachable (ECONNREFUSED)`, `authentication_failed (28P01)`).     | Sprawdź, czy PostgreSQL działa i czy `DATABASE_URL` jest aktualny: `node dist/main.js health`. Po naprawie — `status`. Inne komendy (ingest, digest) też wtedy nie działają.                                                                                                                                                                                                                                                                                                                     |
| `schema_not_ready`      | Są oczekujące migracje (np. po wdrożeniu nowej wersji); komendy odmawiają pracy.                                           | `node dist/main.js migrate`, potem `node dist/main.js health`.                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `no_enabled_sources`    | Żadne źródło nie jest włączone — nic nie jest pobierane.                                                                   | Włącz źródło (niżej, „Źródła”), jeśli wyłączenie nie było celowe.                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `source_failed`         | Ostatni przebieg źródła się nie udał albo nieudany dzień z ostatnich 36 h nie został jeszcze pobrany (`runId`, kod błędu). | Zobacz kod błędu (niżej) i `/var/log/radar/ingest.log`. Gdy przyczyna minęła: `node dist/main.js ingest <sourceId>` — nadrabianie pobiera nieudane dni samo. Dzień pobrany później przestaje być problemem.                                                                                                                                                                                                                                                                                      |
| `source_never_run`      | Włączone źródło nie ma żadnego przebiegu.                                                                                  | Pierwsze wdrożenie: `node dist/main.js ingest --from <wczoraj−30> --to <wczoraj>` (README, „Cron”). Inaczej sprawdź, czy cron w ogóle działa.                                                                                                                                                                                                                                                                                                                                                    |
| `source_stale`          | Od 36 h żaden przebieg źródła nie zakończył się `succeeded`/`incomplete`.                                                  | Sprawdź, czy cron uruchamia `ingest` (log crona, `/var/log/radar/ingest.log` — ostatnia linia z dzisiejszą datą). Uruchom `node dist/main.js ingest` ręcznie i obserwuj kod wyjścia.                                                                                                                                                                                                                                                                                                             |
| `source_incomplete`     | Dwa najnowsze przebiegi źródła (dwa różne dni) zakończyły się `incomplete` (dzień, `runId`, powody `part: reason`).        | Powody w alercie: `max_records`/`max_pages` — dzień przekroczył limit (`--limit` w cronie lub limit źródła), sprawdź liczby w `ingest.log` i zgłoś przy domyślnym limicie; `detail_missing`/`detail_invalid` — po stronie źródła (niżej, „Baza Konkurencyjności”), ponów dzień `ingest <sourceId> --date <dzień>`; `invalid_cursor`/`repeated_cursor` — zgłoś jak zmianę formatu. Nadrabianie nie ponawia dni `incomplete`. Alert znika, gdy jeden z dwóch najnowszych dni przejdzie bez braków. |
| `deliveries_pending`    | Wysyłki z niepewnym wynikiem czekają na decyzję operatora (a żaden `digest` nie trwa).                                     | Procedura „Wysyłki niepewne” niżej (`deliveries:pending`, `deliveries:resolve`). Bez decyzji te oferty nie trafią do profilu, a profil z dzisiejszym `pending` nic dziś nie dostanie.                                                                                                                                                                                                                                                                                                            |
| `deliveries_failed`     | Wysyłki z dniem digestu od wczoraj się nie udały: „do ponowienia” (kolejny `digest` spróbuje sam) i „bez dalszych prób”.   | Kody `smtp_…` w alercie. Błąd konfiguracji (logowanie, TLS) — popraw `SMTP_URL`/`EMAIL_FROM`, kolejny `digest` wyśle. Odrzucony adres (np. `smtp_550`) — sprawdź adres profilu z klientem. Alert znika, gdy wysyłka się uda albo gdy błąd jest starszy niż wczoraj.                                                                                                                                                                                                                              |
| `backup_dir_unreadable` | `BACKUP_DIR` nie da się odczytać (kod w alercie, np. `ENOENT` — brak katalogu, `EACCES` — brak uprawnień).                 | Sprawdź katalog i prawa: `ls -ld /var/backups/radar` (`radar:radar 0700`), wartość `BACKUP_DIR` w `/etc/radar/radar.env`.                                                                                                                                                                                                                                                                                                                                                                        |
| `backup_missing`        | W `BACKUP_DIR` nie ma żadnej kopii `radar-<RRRRMMDDTGGMMSSZ>.dump`.                                                        | Pierwsze wdrożenie: `node dist/main.js backup /var/backups/radar`. Inaczej — `/var/log/radar/backup.log` i niżej, „Backup i odtworzenie”.                                                                                                                                                                                                                                                                                                                                                        |
| `backup_stale`          | Najnowsza kopia (czas z nazwy pliku) jest starsza niż 26 h — nocny backup nie zadziałał (wychodzi w `status` z 7:45).      | Ostatnia linia `/var/log/radar/backup.log` (powód, np. `unreachable`, `version_mismatch`, `write_failed`), po naprawie `node dist/main.js backup /var/backups/radar` ręcznie.                                                                                                                                                                                                                                                                                                                    |

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
     stronie unitu albo w puli `serve`. Unit przepuszcza tylko loopback (`IPAddressDeny=any`,
     `IPAddressAllow=localhost`): baza na innym hoście (host w `DATABASE_URL` inny niż
     `localhost`/`127.0.0.1`) wymaga jej adresu w `IPAddressAllow=` w drop-inie, nie w samym
     unicie (`DEPLOY.md` punkt 7). Drop-in `smtp.conf`
     (`EMAIL_MODE=smtp`) zdejmuje ten filtr — `systemctl show radar-serve -p IPAddressDeny`
     pokazuje wtedy puste `IPAddressDeny=` i filtr nie jest przyczyną. Pula:
     `systemctl restart radar-serve`. `"database":{"status":"error",…}` tutaj
     (`reason`/`code`) → to problem bazy, nie `serve`.
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

Zasady: `docs/DECISIONS.md` D-024; komendy także w README, „Digest (e-mail)”.

Wynik niepewny (`pending`) — połączenie zerwane w trakcie wysyłki albo przerwany proces.
**Nie ponawiaj na ślepo** (klient mógłby dostać e-mail dwa razy):

```sh
node dist/main.js deliveries:pending | jq .
# {"status":"ok","pending":[{"profileId":"…","transport":"smtp","digestDate":"2026-11-02","offers":3,"oldestCreatedAt":"…"}],"truncated":false}
```

1. Sprawdź log serwera SMTP / skrzynkę wysłanych dla tego profilu i dnia (tryb `test`: pliki
   w `EMAIL_OUTBOX_DIR`). Adres odbiorcy — `node dist/main.js profile:show <profileId>`
   (pole `email`; nie wklejaj go do zgłoszeń ani logów):

   ```sh
   node dist/main.js profile:show <profileId> | jq -r .email
   ```

   Gdy wyniku nie da się ustalić, domyślnie `--sent` (krok 2): oferty i tak są widoczne na
   `/dopasowania`, podwójny e-mail podważa zaufanie, a `--failed` wysłałby je jeszcze raz
   jako nowe.

2. E-mail doszedł — wiersze stają się `sent` (`sent_at` teraz, `attempts + 1`):

   ```sh
   node dist/main.js deliveries:resolve <profileId> --sent --date <digestDate> --transport <transport>
   ```

3. Nie doszedł — wiersze są usuwane:

   ```sh
   node dist/main.js deliveries:resolve <profileId> --failed --date <digestDate> --transport <transport>
   ```

   Oferta wraca dopiero w kolejnym `digest` tym samym transportem i tylko wtedy, gdy w chwili
   tego przebiegu nadal spełnia warunki kandydata digestu:
   - status inny niż `closed`/`cancelled` i termin składania ofert nieminiony (`deadline` ≥
     chwila przebiegu; oferta bez terminu przechodzi);
   - pierwszy zapis (`first_seen_at`) najwyżej 7 dni (`DIGEST_NEW_DAYS`) przed chwilą
     przebiegu — starsza oferta nie jest już „nowa” i nie wróci, choć wiersz usunięto;
   - profil jest aktywny, a oferta pasuje do niego w obecnym kształcie (wynik ≥ 50, żadne
     słowo wykluczające, region nie jest niezgodny);
   - mieści się w 50 ofertach na e-mail (`DIGEST_MAX_ITEMS`; najbliższy termin pierwszy,
     nadmiar w kolejnych dniach, póki spełnia te warunki) i wśród 10 000 kandydatów przebiegu
     (`DIGEST_CANDIDATE_LIMIT`).

   Najwyżej jeden e-mail dziennie na profil i transport: gdy profil ma już tego dnia (w
   Polsce) wiersz `sent` albo `pending` w tym transporcie, oferta czeka do następnego dnia.
   W praktyce oferta wraca w najbliższym przebiegu `digest` z crona o 7:30 (jutro, gdy
   rozstrzygasz po dzisiejszym przebiegu); wcześniej — tylko po ręcznym `digest` i tylko
   wtedy, gdy profil nie ma już dziś żadnego innego wiersza `sent` ani `pending` w tym
   transporcie.

Bez `--date` komenda obejmuje wszystkie wiersze `pending` profilu w danym transporcie.
Zmienia tylko wiersze `pending` tego profilu i transportu, w jednej transakcji, i wypisuje
`{"status":"ok",…,"transport":…,"changed":N}`. Transport: `--transport test|smtp` (pole
`transport` z `deliveries:pending`); bez niego — transport bieżącego `EMAIL_MODE`, jak w
`digest` (czytane jest samo `EMAIL_MODE`, bez `EMAIL_FROM` i `SMTP_URL`; błędne
`EMAIL_MODE` → kod `1`, baza nie jest otwierana).
Odmawia (kod `1`, nic nie zmienia), gdy właśnie trwa `digest` albo inne `deliveries:resolve`
(ta sama blokada; „a digest run or another deliveries:resolve holds the lock”) — spróbuj
ponownie po ich końcu — albo gdy profil nie ma pasujących wierszy `pending`. Nie uruchamiaj
`deliveries:resolve` o minucie crona `digest` (7:30): przy zajętej blokadzie odmawia, a gdy
sam ją weźmie pierwszy, poranny `digest` jest pominięty (`skipped`) i trzeba go uruchomić
ręcznie (`node dist/main.js digest`). Brak lub oba przełączniki `--sent`/`--failed`, zła
data albo `--transport` podany dwa razy, bez wartości lub inny niż `test`/`smtp` → kod `2` z
opisem użycia, baza nie jest otwierana.

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

Unieważnia wszystkie linki (logowania, wypisu, potwierdzenia adresu i ocen „Trafne”/„Nietrafne”
z digestów) i sesje profilu naraz;
profil i powiadomienia zostają (także adres oczekujący na potwierdzenie — klient anuluje go na
`/profil` albo zapisuje ponownie). Zmiana adresu przez klienta wymaga potwierdzenia z nowej
skrzynki (D-031), a stary adres dostaje powiadomienie. Gdy ktoś mimo to przejął powiadomienia
zmianą adresu: najpierw `access:revoke`, potem poprawka adresu
(`UPDATE company_profiles SET email = '<adres>', pending_email = NULL, updated_at = now() WHERE id = '<profileId>';`)
i nowy link dla właściciela:

```sh
node dist/main.js access:link <profileId>     # link jest sekretem — tylko właścicielowi
```

## Oceny trafności (`feedback:report`, D-032)

Klienci oceniają zamówienia linkami „Trafne”/„Nietrafne” z digestu (bez logowania, 60 dni,
tylko zamówienia wysłane tej firmie; GET pokazuje stronę z przyciskiem, zapisuje dopiero
przycisk) i przyciskami na `/dopasowania`. Ocenę można zmienić; zostaje jedna na firmę i
zamówienie (tabela `match_feedback`). Odczyt:

```sh
node dist/main.js feedback:report                      # wszystkie oceny
node dist/main.js feedback:report --since 2026-11-02   # zmienione od tego dnia (czas polski)
```

Wypisuje jedną linię JSON: `total`, `profiles` (id profilu) i `categories` (kategoria MVP z
kodów CPV oferty; oferta w dwóch kategoriach liczy się w obu, bez kategorii — `null`) — każda z
`ratings`, `relevant`, `notRelevant` i `precision` (trafne / wszystkie, 3 miejsca po przecinku).
**`precision: null` znaczy brak ocen, nie zero trafnych.** Bez adresów i tytułów — wynik można
wkleić do notatek z pilotażu. Kody: `0` raport, `1` baza niedostępna albo schemat nieaktualny
(`migrate`), `2` zły argument (`--since` musi być datą `YYYY-MM-DD`). Raport liczy oceny wg
ostatniej zmiany: ocena zmieniona po `--since` liczy się z nowym werdyktem.

Tydzień pilotażu (etap 4): `feedback:report --since <poniedziałek>`; trafność to
`total.precision`. `total.precision` liczy wszystkie oceny razem, więc firma, która ocenia
dużo, waży w nim najwięcej — do decyzji go/no-go patrz też na `precision` poszczególnych
profili (`profiles[]`) albo ich medianę. Firma z wieloma „nietrafne” w jednej kategorii —
sprawdź jej profil (`match:preview <profileId>`) i słowa wykluczające razem z firmą.

Przy wdrażaniu firmy w pilotaż poleć ocenianie hurtem na `/dopasowania` (jedno kliknięcie na
zamówienie, cała lista na jednej stronie) zamiast pojedynczych linków z e-maili — więcej ocen
w krótszym czasie.

Klient może też pobrać swoją listę dopasowań jako CSV („Pobierz listę jako CSV” na
`/dopasowania`: te same zamówienia i limit co strona, separator `;`, UTF-8 z BOM — otwiera się
w Excelu i Arkuszach Google).

## E-maile dostępu i kontakt (`serve`, D-031)

`serve` wysyła sam dwa rodzaje e-maili, tym samym transportem co `digest` (`EMAIL_MODE`,
`EMAIL_FROM`, `SMTP_URL` z `/etc/radar/radar.env`): link logowania na prośbę klienta („Wyślij mi
link”) oraz potwierdzenie nowego adresu z powiadomieniem na stary. Bez potwierdzenia
właściciela `EMAIL_MODE` zostaje `test` (`docs/SECURITY.md` §10).

- **`CONTACT_EMAIL`** — adres kontaktowy na stronie głównej, na stronach 429 („Za dużo próśb
  o link”) i 409 („Nie zmieniono adresu”) oraz w powiadomieniu o zmianie adresu (na stary
  adres); opcjonalny (pusty — kontakt nie jest pokazywany). Musi to być prawdziwa, czytana skrzynka. Błędny zapis zatrzymuje start
  `serve` (`Invalid e-mail configuration: CONTACT_EMAIL`, kod `1`). Po zmianie:
  `systemctl restart radar-serve`.
- **Limity** (stałe w kodzie, bez konfiguracji):

  | Limit                                                            | Wartość                            | Gdzie                                   | Po przekroczeniu                                        |
  | ---------------------------------------------------------------- | ---------------------------------- | --------------------------------------- | ------------------------------------------------------- |
  | linki „Wyślij mi link” na profil                                 | 3 na 24 h                          | baza (`access_emails`), atomowo         | ta sama strona, nic nie wysłane (`limit_reached`)       |
  | linki potwierdzające zmianę adresu                               | 3 na 24 h                          | baza (`access_emails`), atomowo         | błąd w formularzu, nic nie zapisane                     |
  | żądania „Wyślij mi link” z jednego IP (IPv6: z jednej sieci /64) | 10 na godzinę                      | pamięć `serve` (najwyżej 10 000 kluczy) | 429 „Za dużo próśb o link”                              |
  | e-maile czekające na wysyłkę                                     | 20                                 | pamięć `serve` (jedna wysyłka naraz)    | żądanie odrzucone (`dropped`, `access_mail_queue_full`) |
  | ciało formularza „Wyślij mi link”                                | 1 KiB                              | `serve`                                 | 413                                                     |
  | wysyłka w toku przy zatrzymaniu `serve`                          | 5 s (po ≤ 10 s na otwarte żądania) | `serve`                                 | porzucona (`dropped`, `access_mail_shutdown_timeout`)   |

  Klucz limitu na IP: adres IPv4 (także zapisany jako `::ffff:a.b.c.d`) albo prefiks /64
  adresu IPv6 — klient z całą siecią /64 ma jeden licznik, niezależnie od adresu w niej i od
  zapisu adresu. Firmy za jednym adresem IPv4 (NAT) albo w jednej sieci /64 dzielą licznik.

  Limit na IP i kolejka giną przy restarcie `serve` (limit IP zaczyna się od zera; czekające
  e-maile są odrzucone z linią `access_mail_shutdown`). Limit profilu w bazie przetrwa
  restart; zapisy starsze niż doba usuwa godzinne sprzątanie `serve`.

  Zatrzymanie `serve` (`systemctl stop`/`restart`) mieści się w `TimeoutStopSec=20`: do 10 s
  na otwarte żądania, potem najwyżej 5 s na e-mail dostępu w toku (jedna wysyłka SMTP może
  czekać dłużej — limity jak przy `digest`). E-mail, który nie zdążył, dostaje linię
  `"outcome":"dropped"`, `"errorCode":"access_mail_shutdown_timeout"` (z `kind` zadania; przy
  zmianie adresu `email_change`, także gdy utknęło powiadomienie); jego zadanie nie zaczyna już
  kolejnej wysyłki. Zmiana adresu wysyła najpierw powiadomienie na stary adres, potem link
  potwierdzający na nowy (także gdy powiadomienie nie wyszło): błąd albo zatrzymanie przy
  wysyłce linku nie odbiera staremu adresowi ostrzeżenia, a zadanie porzucone przy
  powiadomieniu nie wysyła już linku. Wysyłka, która była już w toku, kończy się mimo to i po
  linii `dropped` może jeszcze zalogować własny wynik (z `kind` tego e-maila):
  `"outcome":"sent"`, gdy serwer SMTP przyjął porzucony e-mail, albo `"outcome":"send_failed"`,
  gdy wysyłka się nie udała. Proces kończy się, gdy zamknie się gniazdo SMTP, najpóźniej po
  `TimeoutStopSec`; serwer HTTP nie przyjmuje wtedy już połączeń, a transport SMTP
  (`sender.close()`) i pula połączeń z bazą (`db.destroy()`) są już zamknięte.

## Klient nie dostaje linku

Klient prosi o link sam: formularz „Wyślij mi link” na stronie głównej i na stronie „link
nieważny” (D-031). Odpowiedź jest zawsze ta sama — strona niczego nie mówi o adresie, więc
przyczynę widać tylko w logu `serve` (bez adresów; tylko `kind`, `outcome`, `profileId`,
`errorCode`):

```sh
journalctl -u radar-serve --since "-2h" | grep '"access mail"'
```

| `outcome`       | Znaczenie i reakcja                                                                                                                                                                                                                                                                                                           |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sent`          | Serwer pocztowy przyjął wiadomość. Klient sprawdza folder spam i dokładny adres. Link działa raz: na innym urządzeniu potrzebny jest nowy.                                                                                                                                                                                    |
| `no_profile`    | Żaden profil nie ma tego adresu jako bieżącego (literówka, inny adres firmy, adres jeszcze niepotwierdzony po zmianie). Profil po adresie — zapytanie w `README.md` („Obsługa klienta”); link od operatora: `access:link`.                                                                                                    |
| `limit_reached` | Profil dostał już 3 e-maile dostępu w ciągu 24 h (linki „Wyślij mi link”; osobno 3 potwierdzenia zmiany adresu). Klient używa linku z ostatniej wiadomości albo czeka; w pilnej sprawie `access:link`.                                                                                                                        |
| `send_failed`   | Wysyłka nie wyszła (`errorCode`, `failureKind` jak przy `digest`): sprawdź `SMTP_URL`, dostawcę i ruch wychodzący z `radar-serve`. Wysyłka nie jest ponawiana — klient prosi ponownie (żądanie liczy się do limitu profilu).                                                                                                  |
| `dropped`       | Kolejka pełna (`access_mail_queue_full`: ponad 20 czekających — zalew żądań) albo zatrzymanie `serve`: `access_mail_shutdown` (żądanie w trakcie zamykania; czekające — jedna linia z liczbą `count`), `access_mail_shutdown_timeout` (wysyłka w toku nie skończyła się w 5 s). Klient prosi ponownie; zmiana adresu — niżej. |
| `failed`        | Baza niedostępna w chwili zadania (`reason`, `code`): jak przy `status` → `database_unavailable`.                                                                                                                                                                                                                             |
| `not_sent`      | `email_not_configured` — tylko w testach; `serve` zawsze ma transport z `EMAIL_MODE`.                                                                                                                                                                                                                                         |

Brak linii `access mail` przy zgłoszeniu: strona dała 429 (limit 10 żądań z jednego adresu IP na
godzinę, w pamięci `serve`; mija po godzinie albo po restarcie usługi), błąd formularza (zły zapis
adresu) albo żądanie nie doszło do `serve`. W `EMAIL_MODE=test` nic nie wychodzi z maszyny:
wiadomości leżą w `EMAIL_OUTBOX_DIR`.

Zmiana adresu, której klient nie może potwierdzić (link nie przyszedł albo wygasł po 24 h):
klient zapisuje nowy adres w formularzu jeszcze raz (nowy link; najwyżej 3 na dobę) albo
anuluje zmianę na `/profil`; do tego czasu wszystko idzie na stary adres. Po wygaśnięciu
linku (albo `access:revoke`) `/profil` i ustawienia mówią wprost, że link wygasł, zamiast
„Oczekuje na potwierdzenie”.

`dropped` przy `"kind":"email_change"` (kolejka pełna albo zatrzymanie `serve`): zmiana jest
już zapisana i **liczy się do limitu 3 potwierdzeń na dobę** (licznik i token powstają przy
zapisie formularza, przed kolejką), tylko link potwierdzający nie wyszedł (przy
`access_mail_shutdown_timeout` mogło wyjść samo powiadomienie na stary adres — idzie pierwsze;
linia `"kind":"email_change","outcome":"sent"` po `dropped` znaczy, że link jednak wyszedł,
a `"outcome":"send_failed"` — że nie wyszedł);
`/profil` pokazuje „Oczekuje na potwierdzenie”. Powiedz klientowi: link nie został wysłany — niech zapisze nowy adres w
ustawieniach jeszcze raz (nowy link) albo anuluje zmianę; gdy limit dnia jest wyczerpany
(błąd w formularzu), niech spróbuje, gdy minie doba od najstarszego z trzech linków. Pilna
zmiana: tożsamość innym kanałem i poprawka w `psql` jak wyżej. `dropped` przy
`"kind":"login_link"` z `access_mail_queue_full` albo `access_mail_shutdown` niczego nie
zapisuje i nie liczy się do limitu profilu — klient po prostu prosi o link ponownie. Inaczej
`access_mail_shutdown_timeout`: zadanie było już w toku, więc link jest zwykle już wydany i
policzony do limitu profilu, a e-mail może jeszcze dojść (po linii `dropped` pojawi się wtedy
`sent`; `send_failed` znaczy, że nie dojdzie) — niech klient najpierw sprawdzi pocztę. Gdy klient nie ma już dostępu do starej skrzynki: sprawdź
tożsamość innym kanałem i popraw adres w `psql` jak wyżej.

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

Ścieżki `/dostep/…` (logowanie), `/wypis/…` (wypis), `/potwierdz-email/…` (potwierdzenie nowego
adresu) i `/ocena/…` (ocena zamówienia z digestu) zawierają tokeny dające dostęp do profilu albo
jego ocen. **Proxy nie może zapisywać tych ścieżek w logach
dostępu.** `deploy/caddy/Caddyfile` pomija je w logu dostępu (`log_skip`), a nagłówki
`Cookie`/`Authorization` Caddy domyślnie maskuje. Przy zmianie konfiguracji proxy zachowaj oba; to
samo dotyczy narzędzi monitoringu i APM przed aplikacją. HSTS ustawia sama aplikacja
(`max-age=31536000`, bez `includeSubDomains`) — proxy nie dodaje drugiego nagłówka (smoke test
sprawdza dokładnie jeden).
