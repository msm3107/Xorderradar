# Wdrożenie pilotażowe — Radar Zamówień

Instalacja od zera na jednym VPS (PR-07B, D-029): `serve` jako unit systemd, pozostałe
komendy z crona hosta, PostgreSQL 16 na tym samym hoście, Caddy jako reverse proxy z TLS,
heartbeat `status` do zewnętrznej usługi. Codzienna obsługa i awarie —
[`RUNBOOK.md`](RUNBOOK.md).

Artefakty (komentarze w plikach mówią, co i dlaczego):

| Plik                                             | Na hoście                                                                                |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| `deploy/systemd/radar-serve.service`             | `/etc/systemd/system/radar-serve.service`                                                |
| `deploy/systemd/radar-serve.service.d/smtp.conf` | `/etc/systemd/system/radar-serve.service.d/smtp.conf` (tylko `EMAIL_MODE=smtp`, punkt 7) |
| `deploy/cron/radar`                              | `/etc/cron.d/radar`                                                                      |
| `deploy/caddy/Caddyfile`                         | `/etc/caddy/Caddyfile`                                                                   |
| `deploy/logrotate/radar`                         | `/etc/logrotate.d/radar`                                                                 |
| `deploy/radar.env.example`                       | `/etc/radar/radar.env` (wzór)                                                            |
| `deploy/smoke.sh`                                | uruchamiany z `/opt/radar-zamowien`                                                      |

Założenia i oznaczenia: Debian 12 albo Ubuntu 24.04, polecenia jako root (`sudo -i`) chyba że
napisano inaczej; `admin` — konto administratora z `sudo` (właściciel kodu), `radar` — konto
aplikacji (bez logowania); `radar.example.invalid` — domena pilota (rekord DNS A/AAAA wskazuje
VPS). **Nie wpisuj haseł w linii poleceń** (historia powłoki, `ps`) — tylko w pliki z
ograniczonymi prawami albo w interaktywne monity.

**Pierwsze wdrożenie: postępuj według listy kontrolnej (punkt 13), od góry do dołu; punkty
1–12 to szczegóły jej kroków.** Kolejność ma znaczenie: pierwsze dane (punkt 6, „Pierwsze
dane”) przed cronem i smoke testem.

## 1. Host

```sh
apt-get update && apt-get -y upgrade
apt-get install -y ca-certificates curl gnupg git jq age rsync tmux ufw
timedatectl set-timezone Europe/Warsaw    # cron Debiana/Ubuntu nie obsługuje CRON_TZ
timedatectl                               # "Time zone: Europe/Warsaw", "NTP service: active"
```

Strefa hosta musi być `Europe/Warsaw`: godziny w `deploy/cron/radar` to czas lokalny hosta
(aplikacja sama liczy dni Polski — od strefy zależą tylko godziny startu).

**Firewall** — z zewnątrz tylko SSH, HTTP (certyfikat i przekierowanie) i HTTPS:

```sh
ufw default deny incoming
ufw default allow outgoing      # VPS ma bezpośredni wychodzący HTTPS (źródła, SMTP, heartbeat)
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw enable
ufw status verbose
```

PostgreSQL (5432) i `serve` (3000) słuchają tylko na `localhost` — nie otwieraj ich portów.

## 2. Node.js 22 (NodeSource) i pnpm

```sh
install -d -m 0755 /etc/apt/keyrings
curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
  | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg
echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" \
  > /etc/apt/sources.list.d/nodesource.list
apt-get update && apt-get install -y nodejs
node --version          # v22.19 lub nowszy; ścieżka /usr/bin/node (unit i cron jej używają)
corepack enable         # pnpm w wersji z package.json → packageManager
```

Bez repozytorium apt: oficjalne archiwum `node-v22.*-linux-x64.tar.xz` z nodejs.org (sprawdź
`SHASUMS256.txt`), rozpakowane do `/usr/local/lib/nodejs` z dowiązaniem `/usr/bin/node` — unit
i cron wywołują `/usr/bin/node`.

## 3. PostgreSQL 16 (PGDG)

```sh
install -d /usr/share/postgresql-common/pgdg
curl -fsSL -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc \
  https://www.postgresql.org/media/keys/ACCC4CF8.asc
. /etc/os-release
echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt ${VERSION_CODENAME}-pgdg main" \
  > /etc/apt/sources.list.d/pgdg.list
apt-get update && apt-get install -y postgresql-16 postgresql-client-16
pg_dump --version       # 16.x — backup/restore wymagają klienta >= 16
```

Domyślnie `listen_addresses = 'localhost'` — zostaw. Rola aplikacji **bez** uprawnień
superużytkownika, właściciel własnej bazy:

```sh
sudo -u postgres createuser --no-superuser --no-createdb --no-createrole --pwprompt radar
sudo -u postgres createdb --owner=radar radar
```

Hasło (monit `--pwprompt`) wpisz potem do `DATABASE_URL` w `/etc/radar/radar.env` (znaki
spoza `A-Za-z0-9-._~` zakoduj procentowo, np. `#` → `%23`).

## 4. Caddy

```sh
apt-get install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key \
  | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt \
  > /etc/apt/sources.list.d/caddy-stable.list
apt-get update && apt-get install -y caddy
caddy version           # >= 2.8 (dyrektywa log_skip)
```

## 5. Użytkownik i katalogi

```sh
useradd --system --home-dir /var/lib/radar --create-home --shell /usr/sbin/nologin radar
install -d -m 0750 -o root  -g radar /etc/radar
install -d -m 0750 -o radar -g radar /var/log/radar
install -d -m 0700 -o radar -g radar /var/backups/radar
install -d -m 0700 -o radar -g radar /var/lib/radar/outbox
install -d -m 0755 -o admin -g admin /opt/radar-zamowien
```

- `/opt/radar-zamowien` — kod i build; należy do `admin`, nie do `radar` (aplikacja nie może
  zmienić własnego kodu). `serve` zapisuje wyłącznie e-maile dostępu w trybie `test` (do
  `/var/lib/radar/outbox`, jedyna ścieżka zapisu w `radar-serve.service`).
- `/etc/radar` — konfiguracja z sekretami, czytelna dla grupy `radar`.
- `/var/log/radar` — logi zadań crona (rotacja: `deploy/logrotate/radar`).
- `/var/backups/radar` — kopie (`BACKUP_DIR`), `0700`: zawierają dane osobowe. Musi leżeć na
  lokalnym systemie plików z twardymi dowiązaniami (ext4, xfs).
- `/var/lib/radar/outbox` — `EMAIL_OUTBOX_DIR` w trybie `test` (digest, alerty i od PR-10
  e-maile dostępu z `serve`: „Wyślij mi link”, potwierdzenie zmiany adresu). Inna ścieżka w
  `EMAIL_OUTBOX_DIR` wymaga tej samej zmiany w `ReadWritePaths=` usługi `radar-serve`.

## 6. Kod, build, konfiguracja, migracje

Jako `admin`:

```sh
git clone <adres-repozytorium> /opt/radar-zamowien
cd /opt/radar-zamowien
git checkout <tag-wersji>                 # wersja wydana do pilota
pnpm install --frozen-lockfile
pnpm build                                # dist/
```

Konfiguracja (jako root) — wzór `deploy/radar.env.example`, każdą wartość `CHANGE_ME` i
`example.invalid` zastąp prawdziwą:

```sh
install -m 0640 -o root -g radar /opt/radar-zamowien/deploy/radar.env.example /etc/radar/radar.env
editor /etc/radar/radar.env
```

- `HEARTBEAT_URL=` zostaw puste do punktu 10 (puste = brak heartbeatu).
- `EMAIL_MODE=test` (do potwierdzenia właściciela) nie używa `SMTP_URL`: zostaw go pustym
  (`SMTP_URL=`), dopóki nie znasz danych serwera SMTP, i wpisz przed przełączeniem na `smtp`
  (punkt 13, „Próba ścieżki alertu”). Wpisany musi być poprawnym URL-em. Zmienne `EMAIL_*` i
  `SMTP_URL` czyta też `serve` (e-maile dostępu, D-031): błędna wartość zatrzymuje jego start
  (kod `1`), a po zmianie trybu zrestartuj `radar-serve` — przy `smtp` najpierw zainstaluj
  drop-in z punktu 7, bez niego unit nie wypuści `serve` do serwera SMTP.
- `CONTACT_EMAIL` — adres kontaktowy na stronie głównej, stronach 409 i 429 i w powiadomieniu
  o zmianie adresu (opcjonalny; pusty = bez kontaktu).
  W produkcji prawdziwa, czytana skrzynka; niepoprawny adres zatrzymuje start `serve`.

Reguły pliku (Node `--env-file` i systemd `EnvironmentFile=` czytają go tak samo): jedna
para `KLUCZ=wartość` w linii, komentarze tylko w osobnych liniach, w wartościach bez
cudzysłowów, `#`, `$`, `\` i spacji na brzegach — takie znaki w URL koduj procentowo. `#`
w środku wartości Node traktuje jako początek komentarza i ucina resztę.

Migracje i kontrola — jako root, z katalogu kodu; `runuser` uruchamia komendę jako
użytkownik `radar` (jak cron). Zmienna `RADAR` służy też w kolejnych punktach — w nowej
powłoce zdefiniuj ją ponownie:

```sh
cd /opt/radar-zamowien
RADAR='runuser -u radar -- /usr/bin/node --env-file=/etc/radar/radar.env dist/main.js'
$RADAR migrate
$RADAR health                             # {"status":"ok",…}
```

### Pierwsze dane (przed cronem i smoke testem)

Jako root, w `/opt/radar-zamowien`, z `$RADAR` jak wyżej:

1. **AC1 z PR-02** — prawdziwe ogłoszenia przez SafeHttpClient z tego hosta:
   `$RADAR source:preview bzp --date <dzień roboczy sprzed kilku dni> --limit 25 | jq .` —
   kod `0`, `normalized` > 0, w logu `source listing fetched` oba typy ogłoszeń (`part`) z
   `records` > 0 (README, „Szybki start”).
2. **Backfill raz**: `$RADAR ingest --from <wczoraj−30> --to <wczoraj>` (README, „Cron”; ok.
   1–1,5 h). Uruchom go w `tmux` (albo `screen`) — zerwane połączenie SSH przerwałoby
   przebieg; w nowej sesji `tmux` zdefiniuj `RADAR` ponownie. Przerwany backfill uruchom
   jeszcze raz tą samą komendą (deduplikacja nie zdubluje ogłoszeń).
3. **Pierwszy backup**: `$RADAR backup /var/backups/radar`.

### Drugie źródło: Baza Konkurencyjności

Migracja `0007_bk_source` (PR-08, D-030) dodaje źródło `bk` **wyłączone** — przy pierwszym
wdrożeniu i przy aktualizacji (punkt 15). Wyłączone `bk` nie jest pobierane, a `status` go nie
sprawdza. Włączenie to decyzja właściciela po udanym AC1. Jako root, w `/opt/radar-zamowien`,
z `$RADAR` jak wyżej, **poza oknem crona 5:30–8:00**:

1. **AC1 z PR-08** — na tym hoście, nie w kontenerze deweloperskim (SafeHttpClient nie używa
   proxy, D-014):

   ```sh
   $RADAR source:preview bk --date <dzień roboczy sprzed kilku dni> --limit 20 | jq .
   ```

   Oczekiwane:
   - kod `0` i `normalized` > 0;
   - w logu jedna część (`part` `announcements`) z `records` > 0: `source listing fetched`
     albo `source listing incomplete` z powodem `max_records` (dzień ma więcej ogłoszeń niż
     `--limit`);
   - `rejected` = 0; inaczej sprawdź `rejectionReasons` (pojedyncze odrzucenie nie blokuje
     włączenia, powtarzający się powód to sprawa dla adaptera);
   - `sourceUrl` prowadzi do `/ogloszenia/<id>` i otwiera się w przeglądarce;
   - w `contact` tylko e-mail i telefon, bez imion i nazwisk.

   Lista dnia to jedno żądanie z `limit=250` także przy `--limit 20` (D-030). Lista mieszcząca
   się na jednej stronie jest zawsze sprawdzana względem całego `meta.total`, także w podglądzie:
   gdy różnych ogłoszeń jest mniej, podgląd kończy się kodem `1` (`invalid_document`, „listing
   has fewer distinct records than its total”). Powyżej 250 ogłoszeń sprawdzenie dotyczy tylko
   budżetu (`min(meta.total, --limit)`).

   Kod `1` (np. `invalid_document`) albo `incomplete` z innym powodem (`detail_invalid`): nie
   włączaj `bk`; postępowanie — `docs/RUNBOOK.md` → „Baza Konkurencyjności”. Pojedyncze
   `detail_missing` (404, ogłoszenie wycofane w trakcie): powtórz podgląd.

2. **Włączenie** — w `psql` jak w `docs/RUNBOOK.md` (na początku, `SET ROLE radar;`):

   ```sql
   UPDATE sources SET enabled = true, updated_at = now() WHERE id = 'bk';
   ```

   Od tej chwili `status` sprawdza też `bk` i do pierwszego przebiegu zgłasza
   `source_never_run` — zrób krok 3 od razu.

3. **Backfill raz**, w `tmux` (jak w „Pierwsze dane”, krok 2):

   ```sh
   $RADAR ingest bk --from <wczoraj−30> --to <wczoraj> | tee /root/bk-backfill.json
   ```

   Trwa ok. 1–2 h (do 250 ogłoszeń na dzień, timeout 15 min na dzień). Uruchom go wieczorem,
   **najpóźniej ok. 22:00**: nawet z zapasem kończy się długo przed `ingest` z crona o 6:00,
   który w trakcie backfillu kończy się `"status":"skipped"` (blokada). Bez backfillu źródło
   bez przebiegów nadrabia tylko wczoraj.

   Po zakończeniu sprawdź podsumowanie JSON (jedna linia na stdout; same liczby i kody, bez
   treści ogłoszeń):

   ```sh
   jq '{status, notRun}' /root/bk-backfill.json
   jq -c '.runs[] | {publicationDate, status, documents, inserted, rejected, incomplete, errorCode}' /root/bk-backfill.json
   ```

   - `notRun` puste: inaczej część dni nie była czytana (np. zatrzymanie po kolejnych błędach,
     `consecutive_failures`, D-021). Te dni nie mają wpisu w `runs` — sprawdź przyczynę
     (pierwszy dzień `failed`) i uruchom je ponownie.

   - Każdy przebieg powinien mieć `status` `succeeded` albo `incomplete`. Wypisz dni `incomplete`
     i ich powody (`incomplete[].reason`).
   - `rejected` ≈ 0 w każdym dniu.
   - Dni z `detail_missing` albo `detail_invalid` powtórz pojedynczo:
     `$RADAR ingest bk --date <dzień>`. `max_records` oznacza dzień z ponad 250 ogłoszeniami
     i jest oczekiwany.
   - Dzień `failed`: kod w `errorCode`, postępowanie w `docs/RUNBOOK.md` → „Baza
     Konkurencyjności”.

   Przerwany backfill (np. zerwana sesja; podsumowania wtedy nie ma) uruchom od **pierwszego
   niedokończonego dnia**, nie od początku:
   `$RADAR ingest bk --from <pierwszy niedokończony dzień> --to <wczoraj>`. Dni są czytane od
   najstarszego, więc to dzień po ostatnim przebiegu `succeeded`/`incomplete` z zapytania
   „Ostatnie przebiegi źródła” w `docs/RUNBOOK.md` (z `'bk'`). Dzień przerwany w trakcie jest
   czytany od nowa, a deduplikacja nie zdubluje ogłoszeń.

4. **Przed pierwszym digestem po backfillu** (cron o 7:30): pierwszy digest może mieć do
   50 ofert na profil (cały backfill mieści się w oknie `first_seen_at` 7 dni, D-024). Rano,
   po `ingest` i przed 7:30, uruchom `$RADAR digest --dry-run` i sprawdź liczby ofert na
   profil w podsumowaniu (nic nie jest wysyłane). Uprzedź firmy pilotażowe, że ten e-mail
   będzie dłuższy.

5. **Następnego ranka**: `$RADAR status | jq '.sources[] | {sourceId, problems}'` — `bk` bez
   problemów; w digeście i na `/dopasowania` oferty `bk` mają pole „Źródło” z atrybucją.

Wyłączenie `bk` i reakcja na zmianę formatu — `docs/RUNBOOK.md` → „Baza Konkurencyjności”.
Cron się nie zmienia: `ingest` o 6:00 pobiera wszystkie włączone źródła po kolei.

## 7. `serve` (systemd)

```sh
install -m 0644 /opt/radar-zamowien/deploy/systemd/radar-serve.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now radar-serve
systemctl status radar-serve
journalctl -u radar-serve -n 20           # "web server listening"
systemd-analyze security radar-serve      # ocena hardeningu (im niżej, tym lepiej)
```

Unit pozwala `serve` łączyć się tylko przez loopback (`IPAddressDeny=any`,
`IPAddressAllow=localhost`): Caddy, PostgreSQL. W domyślnym `EMAIL_MODE=test` to wystarcza —
e-maile dostępu idą do outboxa. PostgreSQL na innym hoście: jego adres w `IPAddressAllow=` w
drop-inie (`/etc/systemd/system/radar-serve.service.d/`), nie w samym unicie — ponowne
`install` unitu z repozytorium nadpisałoby zmianę.

### `EMAIL_MODE=smtp`: drop-in `smtp.conf` (wymagany)

Przy `EMAIL_MODE=smtp` `serve` wysyła e-maile dostępu („Wyślij mi link”, potwierdzenie zmiany
adresu) do hosta z `SMTP_URL`. Adresy dostawcy mogą się zmieniać, więc drop-in
`deploy/systemd/radar-serve.service.d/smtp.conf` zeruje listę `IPAddressDeny=`. Z drop-inem
systemd nie ogranicza wcale ruchu wychodzącego `serve` (dowolny host i port), tak jak dla
digestu i alertów z crona (te działają bez filtra systemd); ograniczyć go może tylko firewall
hosta z regułami wyjścia. **Bez drop-inu każda wysyłka kończy się `send_failed`.** Węższa alternatywa (stałe
zakresy adresów dostawcy w `IPAddressAllow=` zamiast zerowania) — opis w komentarzu pliku.

Instalacja przy przełączeniu na `smtp` (jako root, po wpisaniu `EMAIL_MODE=smtp` i `SMTP_URL`
w `/etc/radar/radar.env`):

```sh
install -d -m 0755 /etc/systemd/system/radar-serve.service.d
install -m 0644 /opt/radar-zamowien/deploy/systemd/radar-serve.service.d/smtp.conf \
  /etc/systemd/system/radar-serve.service.d/smtp.conf
systemctl daemon-reload
systemctl restart radar-serve
systemctl show radar-serve -p IPAddressDeny   # "IPAddressDeny=" (puste), nie "…0.0.0.0/0 ::/0"
systemctl status radar-serve                  # aktywny; w wierszu „Drop-In” widać smtp.conf
```

Kontrola wysyłki: na stronie głównej „Wyślij mi link” z adresem profilu testowego, potem

```sh
journalctl -u radar-serve --since "-5min" | grep '"access mail"'
```

Oczekiwane: linia `"kind":"login_link"` z `"outcome":"sent"` i e-mail z linkiem w skrzynce
profilu testowego (sprawdź też spam). `"outcome":"send_failed"` z kodem połączenia — drop-in
nie działa albo `SMTP_URL` jest błędny (`docs/RUNBOOK.md` → „Klient nie dostaje linku”).
Powrót do `EMAIL_MODE=test`: `rm /etc/systemd/system/radar-serve.service.d/smtp.conf`,
`systemctl daemon-reload`, `systemctl restart radar-serve`.

## 8. Caddy (reverse proxy, TLS)

```sh
install -m 0644 /opt/radar-zamowien/deploy/caddy/Caddyfile /etc/caddy/Caddyfile
editor /etc/caddy/Caddyfile               # radar.example.invalid → domena z PUBLIC_BASE_URL
caddy validate --config /etc/caddy/Caddyfile
systemctl reload caddy
```

Caddy sam pobiera certyfikat (potrzebne porty 80 i 443 i rekord DNS) i przekierowuje HTTP na HTTPS.
Log dostępu (`/var/log/caddy/radar-access.log`) **pomija** ścieżki `/dostep/…`, `/wypis/…` i
`/potwierdz-email/…` (tokeny), a wszystkie logi Caddy — także log błędów w journalu (np. 502, gdy
`serve` się restartuje) — zamieniają token w ścieżce i w nagłówku `Referer` na `REDACTED`. Nagłówki
`Cookie`/`Authorization` Caddy domyślnie maskuje. HSTS ustawia aplikacja — nie dodawaj go w Caddy.
Caddy ustawia `X-Forwarded-For` na adres klienta i ignoruje nagłówek wysłany przez klienta; z niego
`serve` liczy limit „Wyślij mi link” na IP (D-031). **Nie dodawaj `trusted_proxies`**, chyba że
przed Caddy stoi kolejny proxy — inaczej klient sam wybierałby swój adres i omijał limit.

**Obowiązkowa kontrola po instalacji i po każdej zmianie Caddyfile** (zamiast
`radar.example.invalid` — prawdziwa domena; `test-redaction` to nie jest prawdziwy token):

```sh
caddy validate --config /etc/caddy/Caddyfile
curl -sI https://radar.example.invalid/ | head -n 1                 # najpierw: HTTP/2 200
systemctl stop radar-serve                # wymusza 502 → wpis w logu błędów
curl -s -o /dev/null https://radar.example.invalid/dostep/test-redaction
curl -s -o /dev/null http://radar.example.invalid/dostep/test-redaction
curl -s -o /dev/null https://radar.example.invalid/potwierdz-email/test-redaction
systemctl start radar-serve
journalctl -u caddy --since -5min | grep -c test-redaction           # musi być 0
grep -c test-redaction /var/log/caddy/radar-access.log               # musi być 0
journalctl -u caddy --since -5min | grep -c 'dostep/REDACTED'         # >= 1 (filtr działa; 0 — niżej)
journalctl -u caddy --since -5min | grep -c 'potwierdz-email/REDACTED' # >= 1
```

Pierwsze `curl -sI` musi odpowiedzieć `HTTP/2 200` — wtedy certyfikat jest wydany, a
żądania testowe naprawdę docierają do Caddy. Bez odpowiedzi (pierwszy certyfikat bywa gotowy
dopiero po minucie; `journalctl -u caddy -n 50`) poczekaj i powtórz, zanim przejdziesz dalej.

Wynik inny niż `0` w którejś z dwóch kontroli `test-redaction`: **przerwij wdrożenie** (nie
udostępniaj serwisu klientom) i zgłoś to — tokeny z linków trafiałyby do logów. (Brak pliku
`radar-access.log` też jest w porządku: `grep` wypisze błąd, a log dostępu i tak pomija te ścieżki.)
Licznik `dostep/REDACTED` albo `potwierdz-email/REDACTED` równy `0` znaczy, że żądanie testowe nie
zostawiło wpisu w logu błędów — wtedy dwa zera niczego nie dowodzą: powtórz całą kontrolę; znowu `0`
— przerwij i zgłoś jak wyżej.

## 9. Cron i logrotate

```sh
install -m 0644 -o root -g root /opt/radar-zamowien/deploy/cron/radar /etc/cron.d/radar
install -m 0644 -o root -g root /opt/radar-zamowien/deploy/logrotate/radar /etc/logrotate.d/radar
logrotate --debug /etc/logrotate.d/radar  # sprawdzenie składni, bez rotacji
```

Harmonogram (czas hosta = Polska): 5:30 `backup`, 5:45 retencja (14 najnowszych kopii), 6:00
`ingest`, 6:30 `status --notify`, 7:30 `digest`, 7:45 `status --notify`. Plik w `/etc/cron.d`
musi należeć do roota i nie może być zapisywalny dla grupy ani innych — inaczej cron go
pominie (log: `journalctl -u cron`).

`/etc/cron.d/radar` jest przy każdej aktualizacji zastępowany w całości plikiem z
`deploy/cron/radar` (punkt 15) — **nie dopisuj do niego własnych linii**; własne zadania (np.
kopia poza hostem, punkt 11) — w osobnym pliku w `/etc/cron.d`.

## 10. Heartbeat („dead man's switch”)

`$RADAR` — jak w punkcie 6 (jako root, w `/opt/radar-zamowien`):
`RADAR='runuser -u radar -- /usr/bin/node --env-file=/etc/radar/radar.env dist/main.js'`.

`status` z kodem `0` wysyła jeden `GET` na `HEARTBEAT_URL` (tylko `https://`); kod `1` — nie
pinguje. Brak pingu oznacza: problem w `status`, nieudany alert albo `status` w ogóle się nie
uruchomił (host, cron, baza). Nieudany ping nie zmienia kodu wyjścia — w `status.log` jest
wtedy `"heartbeat":"failed"` i `Heartbeat ping failed (<powód>)`.

Konfiguracja w usłudze typu healthchecks.io (albo własnej instancji):

1. Nowy check: **okres 1 dzień**, **karencja ok. 1 h** (pingi przychodzą codziennie ok. 6:30
   i 7:45 — jeden zgubiony ping pokrywa drugi; cały poranek bez pingu → alarm przed 9:00).
2. Powiadomienia checka na **inny kanał niż SMTP serwisu** (np. e-mail u innego dostawcy,
   SMS, komunikator) — inaczej awaria SMTP wyciszy oba kanały.
3. URL pingu (zawiera token — to **sekret**) do `HEARTBEAT_URL` w `/etc/radar/radar.env`.
   Aplikacja nigdy go nie loguje ani nie wypisuje.
4. Sprawdzenie: `$RADAR status` (kod `0`) → w usłudze widać ping; `"heartbeat":"sent"`.
5. W usłudze wyślij **powiadomienie testowe** kanału z kroku 2 i sprawdź, że dotarło do
   właściciela — dopiero wtedy wiadomo, że alarm za brak pingu kogoś zastanie.

Ręczne `status` z kodem `0` też pinguje i przesuwa termin w usłudze (okres liczy się od
ostatniego pingu): np. po ręcznym `status` o 12:00 poranek bez pingów następnego dnia
zaalarmuje dopiero ok. 13:00, a nie przed 9:00.

**Heartbeat nie obejmuje `serve`** — pingi wysyła `status` z crona, więc strona może nie
działać, a pingi przychodzą dalej. Dlatego dodaj w zewnętrznej usłudze monitoringu
dostępności (wiele ma bezpłatny plan) sprawdzanie `https://<domena>/zdrowie` (domena
z `PUBLIC_BASE_URL`, co kilka minut) z powiadomieniem na ten sam kanał co heartbeat.
Jeśli usługa to umożliwia, ustaw `GET` z oczekiwanym słowem kluczowym `ok` w treści; jeśli nie,
wystarczy sam kod `200` — błąd bazy daje `503`, więc kod sam go wykrywa. `/zdrowie`, a nie strona główna, bo strona główna nie dotyka
bazy: odpowiada nawet wtedy, gdy `serve` w swoim sandboksie systemd nie łączy się
z PostgreSQL. `/zdrowie` wykonuje `select 1` przez pulę `serve` i bez odpowiedzi bazy w 2 s
zwraca `503` (`docs/RUNBOOK.md`, „Heartbeat”). Nie zwraca danych ani treści błędów, nie
wymaga sesji. Caddy loguje `/zdrowie` jak zwykłą ścieżkę: `log_skip` i redakcja z punktu 8 dotyczą
tylko `/dostep/…`, `/wypis/…` i `/potwierdz-email/…`. Monitoruj tylko `/zdrowie` — nigdy ścieżek z
tokenami.

## 11. Kopia poza hostem (zaszyfrowana `age`)

Kopie w `/var/backups/radar` chronią przed błędem w danych, nie przed utratą VPS. Kopia poza
hostem — **tylko zaszyfrowana**, kluczem publicznym; klucz prywatny nigdy nie trafia na VPS.

Na komputerze właściciela (poza VPS): `age-keygen -o radar-backup.key` — plik klucza
prywatnego przechowuj offline (np. w menedżerze haseł); wypisany klucz publiczny
(`age1…`) skopiuj na VPS:

```sh
install -m 0644 -o root -g radar /dev/null /etc/radar/backup-recipient.txt
editor /etc/radar/backup-recipient.txt    # jedna linia: age1…
install -d -m 0700 -o radar -g radar /var/backups/radar-offsite
install -d -m 0700 -o radar -g radar /var/lib/radar/.ssh
runuser -u radar -- ssh-keygen -t ed25519 -f /var/lib/radar/.ssh/offsite -N '' -C radar-offsite
cat /var/lib/radar/.ssh/offsite.pub        # klucz publiczny → serwer kopii (niżej)
```

Zadania kopii poza hostem — w **osobnym** pliku `/etc/cron.d/radar-offsite` (aktualizacja
zastępuje `/etc/cron.d/radar`, punkt 9); te same wymagania co dla `/etc/cron.d/radar`: właściciel
root, `0644`, ostatnia linia zakończona znakiem nowej linii:

```sh
install -m 0644 -o root -g root /dev/null /etc/cron.d/radar-offsite
editor /etc/cron.d/radar-offsite          # treść niżej
```

Przykładowe linie (po retencji z 5:45; host i ścieżka zdalna to przykład). Zaszyfrowana kopia
najnowszego pliku, potem wysłanie katalogu zaszyfrowanych kopii kluczem SSH ograniczonym do
jednego katalogu (`rrsync` po stronie serwera kopii). Wysyłka **bez `--delete`**: przejęty VPS
nie może przez nią usunąć kopii poza hostem — retencję robi serwer kopii (niżej). Oba zadania
piszą do `/var/log/radar/offsite.log` (rotuje go `deploy/logrotate/radar`, `*.log`); jak w
`deploy/cron/radar` — stały `PATH` i bez poczty z crona:

```cron
PATH=/usr/bin:/bin
MAILTO=""
50 5 * * * radar { f=$(ls -1 /var/backups/radar/radar-*Z.dump | tail -n 1) && age -R /etc/radar/backup-recipient.txt -o "/var/backups/radar-offsite/$(basename "$f").age" "$f" && find /var/backups/radar-offsite -maxdepth 1 -name 'radar-*.dump.age' | sort | head -n -14 | xargs -r rm -f -- ; } >>/var/log/radar/offsite.log 2>&1
55 5 * * * radar rsync -a -e 'ssh -i /var/lib/radar/.ssh/offsite -o BatchMode=yes' /var/backups/radar-offsite/ backup@offsite.example.invalid:radar/ >>/var/log/radar/offsite.log 2>&1
```

Serwer kopii (konto `backup`, `rrsync` z pakietu rsync ≥ 3.2.4): klucz publiczny
`offsite.pub` w `~backup/.ssh/authorized_keys` z ograniczeniem

```text
command="rrsync -wo -no-del radar/",restrict ssh-ed25519 AAAA… radar-offsite
```

`-wo` — tylko zapis do `radar/`, `-no-del` — rsync nie może nic usuwać. Z rsync ≥ 3.3.0 dodaj
też `-no-overwrite` (bez nadpisywania istniejących plików) — najpierw sprawdź na serwerze
kopii, że `rrsync -h` wymienia tę opcję; nie wymienia — pomiń ją (nieznana opcja zablokowałaby
każdą wysyłkę), a ochronę przed nadpisaniem dają wtedy tylko migawki po stronie serwera
kopii. Retencja — w crontabie konta
`backup` na serwerze kopii, według wieku pliku (nie liczby: zalanie katalogu nowymi plikami
z przejętego VPS nie wypycha starszych kopii; cotygodniowa kontrola niżej wykrywa brak
nowych plików, zanim wiek usunie ostatnie):

```cron
30 12 * * * find /home/backup/radar -maxdepth 1 -type f -name 'radar-*.dump.age' -mtime +14 -delete
```

Przed pierwszym użyciem jednorazowo
`runuser -u radar -- ssh -i /var/lib/radar/.ssh/offsite backup@offsite.example.invalid` (jako
`radar`), aby zapisać klucz hosta w `/var/lib/radar/.ssh/known_hosts` (sesję serwer odrzuci —
`rrsync` przyjmuje tylko rsync; to oczekiwane).

**Co tydzień** sprawdź kopię poza hostem: najnowszy plik off-host ma < 48 h — na serwerze
kopii, jako `backup`:

```sh
find /home/backup/radar -maxdepth 1 -type f -name 'radar-*.dump.age' -mmin -2880 | grep -q . && echo ok || echo BRAK
```

(`ok` — jest plik młodszy niż 48 h; `BRAK` — wysyłka nie działa od co najmniej dwóch nocy),
a `/var/log/radar/offsite.log` na VPS nie ma błędów (`tail -n 20`).

Przy `BRAK` na VPS, jako root: `tail -n 50 /var/log/radar/offsite.log`, potem
`ls -l /var/backups/radar-offsite` (jest świeży plik `.age`? — nie ma: zawiodło szyfrowanie,
linia `50 5` z `/etc/cron.d/radar-offsite`). Następnie uruchom wysyłkę ręcznie jako `radar` —
polecenie z linii `55 5` bez przekierowania do logu, więc błąd (np. klucz hosta, odmowa
`rrsync`, brak sieci) widać na ekranie:

```sh
runuser -u radar -- rsync -a -e 'ssh -i /var/lib/radar/.ssh/offsite -o BatchMode=yes' /var/backups/radar-offsite/ backup@offsite.example.invalid:radar/
```

Po naprawie powtórz kontrolę na serwerze kopii (`ok`).

Opcjonalnie drugi check heartbeat (osobny check w usłudze z punktu 10, okres np. 1 dzień +
zapas 12 h) pingowany **z serwera kopii**, tylko gdy ten sam warunek < 48 h jest spełniony —
alarm przyjdzie bez pamiętania o kontroli. URL pingu to sekret: na serwerze kopii, jako `backup`,
`install -m 0600 /dev/null ~/.radar-offsite-hb`, potem `editor ~/.radar-offsite-hb` — jedna
linia `url = "https://…"` (plik `0600`, czytelny tylko dla `backup`). `curl -K` czyta URL
z tego pliku, więc nie ma go w linii crona, argumentach procesu ani logach (wpis do crontabu
konta `backup`):

```cron
15 13 * * * find /home/backup/radar -maxdepth 1 -type f -name 'radar-*.dump.age' -mmin -2880 | grep -q . && curl -fsS --max-time 10 -o /dev/null -K "$HOME/.radar-offsite-hb" >/dev/null 2>&1
```

Pingowanie z serwera kopii (nie z zadania off-host na VPS) sprawdza to, co faktycznie dotarło,
i nie daje przejętemu VPS-owi dostępu do tego URL-a. **Raz w miesiącu** odszyfruj jeden plik u właściciela (próba odszyfrowania;
pełne odtworzenie kopii spoza hosta — jednorazowo po pierwszym wdrożeniu, punkt 14). Odszyfrowanie
(tylko na maszynie z kluczem prywatnym): `age -d -i radar-backup.key -o radar-….dump radar-….dump.age`.

## 12. Smoke test

Po każdej instalacji i aktualizacji, jako root (skrypt sam uruchamia komendy jako `radar`;
`$RADAR` niżej — jak w punkcie 6):

```sh
sh /opt/radar-zamowien/deploy/smoke.sh                 # origin z PUBLIC_BASE_URL w radar.env
sh /opt/radar-zamowien/deploy/smoke.sh https://radar.example.invalid
```

Sprawdza: `health` i `status` jako `radar`, `systemctl is-active radar-serve`, stronę główną
przez proxy (`200` i dokładnie jeden nagłówek HSTS), `/zdrowie` przez proxy (`200` i `ok` —
`serve` łączy się z bazą) oraz przekierowanie HTTP → HTTPS. Wypisuje
tylko linie `PASS`/`FAIL`; kod `0` tylko, gdy wszystko przeszło. `status` daje `FAIL` przed
pierwszym `ingest` (`source_never_run`) i przed pierwszym backupem (`backup_missing`) —
szczegóły: `$RADAR status | jq .`.

## 13. Lista kontrolna pierwszego wdrożenia

1. [ ] Host: aktualizacje, strefa `Europe/Warsaw`, firewall 22/80/443, DNS domeny → VPS.
2. [ ] Node ≥ 22.19 w `/usr/bin/node`, PostgreSQL 16, `pg_dump --version` 16.x, Caddy ≥ 2.8.
3. [ ] Użytkownik `radar`, katalogi i prawa jak w punkcie 5.
4. [ ] Kod w `/opt/radar-zamowien` (tag wersji), `pnpm install --frozen-lockfile`, `pnpm build`.
5. [ ] `/etc/radar/radar.env` (`root:radar 0640`) bez placeholderów (puste `HEARTBEAT_URL=`
       i, w trybie `test`, `SMTP_URL=` są w porządku — punkt 6); `EMAIL_MODE=test` do
       potwierdzenia właściciela (`docs/SECURITY.md` §10, §14).
6. [ ] `$RADAR migrate`, `$RADAR health`.
7. [ ] **AC1 z PR-02**: punkt 6, „Pierwsze dane”, krok 1.
8. [ ] Backfill raz, przed cronem (w `tmux`): punkt 6, „Pierwsze dane”, krok 2.
9. [ ] Pierwszy backup: punkt 6, „Pierwsze dane”, krok 3.
10. [ ] `radar-serve` włączony i aktywny; Caddy z prawdziwą domeną; strona otwiera się przez
        HTTPS; kontrola redakcji tokenów w logach Caddy (punkt 8) daje `0` i `0`;
        „Wyślij mi link” dla profilu testowego zostawia e-mail w `/var/lib/radar/outbox`
        (tryb `test`) i linię `"access mail"` z `"outcome":"sent"` w `journalctl -u radar-serve`;
        strona główna pokazuje właściwy kontakt (`CONTACT_EMAIL` bez placeholdera).
11. [ ] Cron i logrotate zainstalowane; następnego ranka logi w `/var/log/radar/*.log`.
12. [ ] Heartbeat: check w usłudze, `HEARTBEAT_URL`, ping widoczny po `$RADAR status`;
        powiadomienie testowe z usługi dotarło do właściciela; monitoring dostępności
        `https://<domena>/zdrowie` (punkt 10).
13. [ ] Ścieżka alertu: po przełączeniu na `EMAIL_MODE=smtp` (za zgodą właściciela) alert
        testowy dochodzi do operatora — „Próba ścieżki alertu” niżej; potem drop-in
        `smtp.conf` i restart `radar-serve` z kontrolą wysyłki „Wyślij mi link” (punkt 7,
        „`EMAIL_MODE=smtp`: drop-in”) — e-maile dostępu idą wtedy przez SMTP.
14. [ ] Kopia poza hostem: pierwsza zaszyfrowana kopia na serwerze kopii, próbne odszyfrowanie
        u właściciela; cotygodniowa kontrola (punkt 11: najnowszy plik off-host ma < 48 h)
        w kalendarzu operatora.
15. [ ] Smoke test: wszystko `PASS`.
16. [ ] Ćwiczenie odtworzenia na VPS (punkt 14) — zakończone, baza próbna usunięta.
17. [ ] Błąd źródła widoczny w jednym cyklu (kryterium PR-07) — „Próba błędu źródła” niżej.
18. [ ] Baza Konkurencyjności (`bk`, po migracji wyłączona): AC1 z PR-08 i decyzja właściciela;
        przy włączeniu — włączenie i backfill według punktu 6, „Drugie źródło: Baza
        Konkurencyjności”.

### Próba ścieżki alertu (pozycja 13)

Celowy, nieszkodliwy problem: nieistniejący `BACKUP_DIR` podany w linii poleceń (zmienna
środowiska ma pierwszeństwo przed `--env-file`; plik konfiguracji i kopie zostają bez zmian).
Jako root:

```sh
cd /opt/radar-zamowien
runuser -u radar -- env BACKUP_DIR=/nonexistent /usr/bin/node --env-file=/etc/radar/radar.env dist/main.js status --notify | jq '{status, problems, notification, heartbeat}'
```

Kod wyjścia komendy przed `| jq` pokazuje (w bash) `echo "${PIPESTATUS[0]}"` zaraz po niej.
Oczekiwane: kod `1`, w `problems` jest `backup_dir_unreadable`, `"notification":"sent"`,
`"heartbeat":"skipped"` (problem — bez pingu), a w skrzynce operatora e-mail, którego temat
zawiera `backup_dir_unreadable` (sprawdź też spam). Z `EMAIL_MODE=test`
alert trafia tylko do `EMAIL_OUTBOX_DIR` — próba nie jest wtedy zaliczona.

### Próba błędu źródła (pozycja 17)

Odwracalna próba bez zmian w kodzie i konfiguracji: wpis w `/etc/hosts` kieruje host BZP
(`ezamowienia.gov.pl`) na `127.0.0.1`, a SafeHttpClient odrzuca adresy prywatne
(`blocked_address`) — nic nie wychodzi do źródła. Jako root, w `/opt/radar-zamowien`, z
`$RADAR` jak w punkcie 6, **poza oknem crona 5:30–8:00**; `<wczoraj>` — wczorajsza data
`RRRR-MM-DD`; kod wyjścia — jak wyżej, `echo "${PIPESTATUS[0]}"`:

```sh
echo '127.0.0.1 ezamowienia.gov.pl # radar-drill' >> /etc/hosts
getent hosts ezamowienia.gov.pl                            # 127.0.0.1
$RADAR ingest bzp --date <wczoraj> | jq '.runs[] | {status, errorCode}'
#   kod 1, {"status":"failed","errorCode":"blocked_address"}
$RADAR status --notify | jq '{status, problems, heartbeat}'
#   kod 1, problems zawiera "source_failed", "heartbeat":"skipped"; alert do operatora
sed -i '/ # radar-drill$/d' /etc/hosts
getent hosts ezamowienia.gov.pl                            # znów adres publiczny
$RADAR ingest bzp --date <wczoraj> | jq '.runs[] | {status, errorCode}'
#   kod 0, "status":"succeeded" (albo "incomplete"), "errorCode":null
$RADAR status | jq '{status, problems, heartbeat}'
#   kod 0, "status":"ok", "heartbeat":"sent"
```

Dlaczego wystarcza jeden cykl: `ingest` o 6:00 zapisuje nieudany przebieg, a `status --notify`
o 6:30 sprawdza ostatni przebieg każdego źródła — awaria źródła trafia do alertu z 6:30 tego
samego ranka (próba odtwarza tę parę ręcznie). Następnego ranka sprawdź
`grep '"checkedAt"' /var/log/radar/status.log | tail -n 2 | jq -c '{checkedAt, status, problems, heartbeat}'`:
obie linie (6:30 i 7:45) mają `"status":"ok"` i `"heartbeat":"sent"` — dzień z próby jest
pobrany ponownie, więc nie wraca jako `source_failed`. `source_failed` tam oznacza, że wpis
`# radar-drill` został w `/etc/hosts` (`grep radar-drill /etc/hosts`) albo prawdziwą awarię.

## 14. Ćwiczenie odtworzenia na VPS

Co miesiąc i po każdej zmianie wersji PostgreSQL; zawsze do **osobnej, nowej bazy**, nigdy
do produkcji (pełna procedura — `docs/RUNBOOK.md`, „Próba odtworzenia”):

```sh
sudo -u postgres createdb --owner=radar radar_restore_drill
install -m 0640 -o root -g radar /dev/null /etc/radar/restore-drill.env
editor /etc/radar/restore-drill.env       # DATABASE_URL=postgres://radar:<hasło>@localhost:5432/radar_restore_drill
cd /opt/radar-zamowien
DRILL='runuser -u radar -- env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/nonexistent /usr/bin/node --env-file=/etc/radar/restore-drill.env dist/main.js'
$DRILL restore /var/backups/radar/radar-<czas>.dump
$DRILL health
sudo -u postgres dropdb radar_restore_drill
rm /etc/radar/restore-drill.env
```

Porównaj liczby wierszy z `restore` z produkcją (zapytanie „Liczby wierszy” w
`docs/RUNBOOK.md`, „Próba odtworzenia”). Jednorazowo, po pierwszym wdrożeniu, odtwórz też kopię **spoza hosta** (odszyfrowaną u
właściciela i przeniesioną na VPS tylko na czas próby, potem usuniętą).

## 15. Aktualizacja wersji i powrót do poprzedniej

Migracje działają tylko w przód — **powrót do poprzedniej wersji po migracji oznacza
odtworzenie kopii sprzed aktualizacji**. Dlatego najpierw kopia. Jako root; `$RADAR` — jak w
punkcie 6:

```sh
cd /opt/radar-zamowien
$RADAR backup /var/backups/radar          # kopia sprzed aktualizacji — zapisz nazwę pliku
runuser -u admin -- git -C /opt/radar-zamowien rev-parse HEAD   # bieżąca wersja — zapisz
```

`git` uruchamiaj jako `admin` (właściciel repozytorium) — root dostałby błąd „dubious
ownership”. Jako `admin`: `git fetch --tags && git checkout <nowy-tag> && pnpm install
--frozen-lockfile && pnpm build`.

Potem jako root porównaj pliki z `deploy/` z zainstalowanymi i zainstaluj zmienione (jak w
punktach 7–9), np. `diff /opt/radar-zamowien/deploy/cron/radar /etc/cron.d/radar` — w
`Caddyfile` różnica w domenie jest oczekiwana. `/etc/cron.d/radar-offsite` (punkt 11) nie
pochodzi z `deploy/` — aktualizacja go nie zmienia. Dalej:

```sh
$RADAR migrate
systemctl daemon-reload                   # gdy zmienił się unit radar-serve.service albo smtp.conf
systemctl restart radar-serve
systemctl reload caddy                    # gdy zmienił się Caddyfile — potem kontrola z punktu 8
sh /opt/radar-zamowien/deploy/smoke.sh
```

Aktualizacja do wersji z PR-08 dodaje źródło `bk` wyłączone (`migrate` wypisuje
`0007_bk_source`); włączenie — punkt 6, „Drugie źródło: Baza Konkurencyjności”.

Aktualizuj poza oknem 5:30–8:00 (cron). Gdy coś nie działa — **powrót**:

1. Bez nowych migracji (`migrate` wypisał `"applied":[]`): jako `admin`
   `git checkout <poprzednia-wersja> && pnpm install --frozen-lockfile && pnpm build`, potem
   `systemctl restart radar-serve` i smoke test.
2. Z nowymi migracjami: zatrzymaj `serve` (`systemctl stop radar-serve`) i cron
   (`mv /etc/cron.d/radar /root/radar.cron.disabled`), przywróć poprzednią wersję kodu jak
   wyżej, odtwórz **kopię sprzed aktualizacji** do nowej, pustej bazy według
   `docs/RUNBOOK.md` → „Awaria: odtworzenie produkcji”, przełącz `DATABASE_URL`, uruchom
   `serve`, przywróć cron i zrób smoke test. Dane zapisane po kopii (przebiegi, wysyłki) są
   utracone; `ingest` nadrobi dni.
