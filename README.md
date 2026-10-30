# Radar Zamówień

Radar Zamówień pomaga małym i średnim firmom znajdować **niewielkie zamówienia i zapytania
ofertowe** publikowane przez BIP-y, szkoły, szpitale, urzędy i inne jednostki publiczne —
i informuje firmę tylko o tych, które faktycznie do niej pasują.

```
źródła → pobranie → normalizacja → deduplikacja → dopasowanie → alert
```

> Status: **PR-03 część A (Ingestion core) — w toku**. Repozytorium zawiera szkielet
> projektu, model domenowy (`Source`, `Opportunity`, `CompanyProfile`), schemat PostgreSQL z
> migracjami, repozytoria, bezpieczny klient HTTP, pierwszy adapter źródła (BZP przez oficjalne
> API platformy e-Zamówienia), zapis ogłoszeń z deduplikacją i wykrywaniem zmian oraz komendy
> CLI `health`, `migrate`, `source:preview` i `ingest`. Pozostałe funkcje produktu (matching,
> e-mail, UI) powstają w kolejnych PR-ach — patrz
> [`docs/PR_PLAN.md`](docs/PR_PLAN.md) i [`docs/STATE.md`](docs/STATE.md).

## Wymagania

- Node.js **≥ 22.19** (`.nvmrc`; testy transportu HTTP używają `tls.setDefaultCACertificates`)
- pnpm **10** (wersja przypięta w `package.json` → `packageManager`; najprościej `corepack enable`)
- PostgreSQL **16** (lokalnie lub zarządzany; patrz „Baza danych”)
- do testów: CLI `openssl` w `PATH` (testy transportu HTTP generują jednorazowy certyfikat
  TLS w katalogu tymczasowym)

## Szybki start

```bash
corepack enable          # jednorazowo, udostępnia przypiętą wersję pnpm
pnpm install
cp .env.example .env     # zawiera DATABASE_URL dla lokalnej bazy radar_dev (patrz „Baza danych”)
pnpm dev migrate         # {"status":"ok","applied":["0001_core_schema","0002_ingestion_runs"]}; kolejne: "applied":[]
pnpm health              # {"status":"ok",...,"database":{"status":"ok"}}
TEST_DATABASE_URL=postgres://radar:radar@localhost:5432/radar_test pnpm check
```

Wersja produkcyjna (zmienne eksportuje środowisko — `node dist/main.js` nie czyta `.env`):

```bash
pnpm build
DATABASE_URL=postgres://… node dist/main.js migrate
DATABASE_URL=postgres://… node dist/main.js health
DATABASE_URL=postgres://… CRAWLER_CONTACT=<twój-monitorowany-kontakt> node dist/main.js source:preview bzp --date 2026-10-29 --limit 25 | jq .
DATABASE_URL=postgres://… CRAWLER_CONTACT=<twój-monitorowany-kontakt> node dist/main.js ingest | jq .
```

Sprawdzenie `source:preview` (AC1): kod wyjścia 0, `normalized` > 0, a w logach
`source listing fetched` oba typy ogłoszeń (`part`) mają `records` > 0; pełna lista kontrolna w
[`docs/STATE.md`](docs/STATE.md) → „Blockers”.

### Komendy CLI

| Komenda                                                     | Co robi                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `health`                                                    | Raport JSON na stdout: konfiguracja + połączenie z bazą (`select 1`, ograniczone timeoutem). Baza niedostępna → `"status":"error"`, kod `1`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `migrate`                                                   | Stosuje oczekujące migracje i wypisuje ich nazwy (`{"status":"ok","applied":[...]}`). Ponowne uruchomienie jest bezpieczne: `"applied":[]`, 0.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `source:preview <sourceId> [--date YYYY-MM-DD] [--limit N]` | Pobiera ogłoszenia źródła opublikowane jednego dnia (domyślnie wczoraj według UTC) i wypisuje je znormalizowane jako JSON (liczniki, odrzucenia z powodami, `incomplete` przy osiągniętym limicie). Nic nie zapisuje i nie łączy się z bazą (`DATABASE_URL` musi jednak być ustawiony — wspólna walidacja konfiguracji). `--limit`: maks. rekordów na typ ogłoszenia (BZP: zwykłe i małe zamówienia osobno), 1–500, domyślnie 20. Wymaga `CRAWLER_CONTACT`. Źródła: `bzp`.                                                                                                                                                                                                                                                                                                         |
| `ingest [sourceId...] [--date YYYY-MM-DD] [--limit N]`      | Pobiera ogłoszenia z dnia publikacji (domyślnie wczoraj według UTC) i zapisuje je w bazie: nowe → `inserted`, zmienione → `updated`, bez zmian → `unchanged` (bez zapisu), błędne → `rejected`. Bez `sourceId` — wszystkie źródła włączone w tabeli `sources` (migracja dodaje `bzp`). `--limit`: maks. rekordów na typ ogłoszenia, 1–1000, domyślnie 1000; timeout 10 min na źródło. Źródła działają po kolei i niezależnie; każdy przebieg trafia do tabeli `ingestion_runs`. Wynik: JSON (`status` + przebiegi z licznikami) na stdout, linia logu na źródło. Kod `0`, gdy wszystkie źródła `succeeded` lub `incomplete` (limit); `1`, gdy któreś `failed` albo trwa inny `ingest` (blokada w bazie — nic nie jest pobierane). Wymaga `CRAWLER_CONTACT` i wykonanego `migrate`. |

Kody wyjścia: `0` — OK, `1` — błąd konfiguracji/wykonania (np. baza niedostępna), `2` — błędne
użycie (komenda i argumenty są sprawdzane przed konfiguracją, więc błędne użycie zawsze daje `2`;
wyjątek: `ingest` ze źródłem niewłączonym w bazie daje `2` dopiero po odczycie bazy).

### Cron

`ingest` uruchamiamy raz dziennie ok. **06:00 czasu polskiego** — domyślny dzień publikacji to
wczoraj (UTC), więc jest już zamknięty. Przykład (crontab z obsługą `CRON_TZ`, np. cronie;
zmienne środowiskowe ustawione w crontabie lub w skrypcie opakowującym, nie w `.env`):

```cron
CRON_TZ=Europe/Warsaw
0 6 * * * cd /opt/radar-zamowien && node dist/main.js ingest >>/var/log/radar/ingest.log 2>&1
```

Plik `ingest.log` miesza JSON ze stdout z liniami logu i komunikatami tekstowymi ze stderr —
to nie są czyste linie JSON.

Nakładające się uruchomienia są bezpieczne: drugie kończy się kodem `1` z komunikatem
`Another ingest run holds the lock; nothing was fetched.` Gdy blokada zostanie utracona w
trakcie (np. restart bazy), przebieg jest przerywany: kod `1`, `errorCode` `lock_lost` i
komunikat `Ingest aborted: the ingest lock was lost during the run (lock_lost).` — wystarczy
uruchomić `ingest` ponownie (zapisane rekordy zostaną rozpoznane jako `unchanged`). Wynik każdego przebiegu: tabela
`ingestion_runs` (np. `SELECT * FROM ingestion_runs ORDER BY started_at DESC LIMIT 10`).
Po nieudanym przebiegu uruchom `ingest --date <publicationDate z raportu>` — ponowienie jest
bezpieczne dzięki deduplikacji. Domyślna data to „wczoraj według UTC”, więc ponowienie po
północy UTC wymaga jawnego `--date`.
Włączanie/wyłączanie źródła (bez wdrożenia, D-020):
`UPDATE sources SET enabled = false WHERE id = 'bzp';` (`true` — ponowne włączenie). Gdy żadne
źródło nie jest włączone, `ingest` kończy się `status` `succeeded` z pustym `runs` i kodem `0`
(tylko ostrzeżenie w logu).
Ruch do źródeł idzie bezpośrednio, bez proxy (D-014) — host crona musi mieć bezpośrednie
wyjście HTTPS.

Gdy baza nie odpowiada, `health` wypisuje na stdout raport z przyczyną, a na stderr jedną linię
dla operatora, np.:

```
{"status":"error","service":"radar-zamowien","environment":"production","database":{"status":"error","reason":"unreachable","code":"ECONNREFUSED"}}
Database check failed: unreachable (ECONNREFUSED)
```

`reason` to jedna z wartości: `unreachable` (sieć/DNS), `timeout`, `tls_failed`,
`authentication_failed`, `database_not_found`, `no_current_schema` (`migrate`: `search_path` nie
wskazuje istniejącego schematu), `query_failed`, `unknown`; `code` to kod SQLSTATE lub kod błędu
systemu (albo `null`). Komunikaty błędów z bazy/sterownika **nigdy** nie są wypisywane — mogą
zawierać host, fragment URL-a lub dane — więc hasło z `DATABASE_URL` nie trafia na stdout/stderr.
Nieoczekiwany błąd wewnętrzny kończy komendę kodem `1` ze stałym komunikatem
`Internal error: the command failed unexpectedly.` (bez treści błędu i stack trace).

## Konfiguracja

Aplikacja czyta konfigurację **wyłącznie ze zmiennych środowiskowych** procesu
(`src/infrastructure/config.ts`); sam kod nie otwiera żadnego pliku.

- **`.env` służy do lokalnego developmentu.** Skrypty `pnpm dev`, `pnpm health` i `pnpm start`
  uruchamiają Node z wbudowaną flagą `--env-file-if-exists=.env` (bez dodatkowej zależności),
  więc wczytują `.env` z katalogu głównego projektu, jeśli istnieje. Gdy pliku nie ma, Node
  wypisuje na stderr jedną linię `.env not found. Continuing without it.` i działa dalej.
- **Zmienne ustawione w środowisku mają pierwszeństwo przed plikiem** — także ustawione na
  pustą wartość (np. `LOG_LEVEL=warn pnpm health` nadpisuje `LOG_LEVEL` z `.env`).
- **Pusta wartość oznacza „nie ustawiono”** i używana jest wartość domyślna
  (`NODE_ENV=development`, `LOG_LEVEL=info`). `DATABASE_URL` nie ma wartości domyślnej — jest
  wymagany (`postgres://` lub `postgresql://`); jego wartość nie pojawia się w żadnym komunikacie.
  Dla zarządzanego PostgreSQL z TLS dodaj parametr, np. `?sslmode=verify-full`.
- **`CRAWLER_CONTACT`** — publiczny kontakt operatora (adres e-mail albo URL `https://` bez
  danych logowania, max 200 znaków, bez spacji i nawiasów), wysyłany w nagłówku User-Agent
  pobierania źródeł: `RadarZamowien/0.1 (+mailto:…)` lub `RadarZamowien/0.1 (+https://…)`.
  Opcjonalny dla `health`/`migrate`; komendy pobierające źródła (od PR-02) bez niego się nie
  uruchomią. Musi to być prawdziwy, obsługiwany kontakt — nie wymyślamy go. Błędna wartość →
  `Invalid environment configuration: CRAWLER_CONTACT` (bez wartości).
- **Produkcja / cron:** bezpośrednie `node dist/main.js …` **nie czyta** `.env`. Zmienne
  eksportuje środowisko uruchomieniowe (crontab, unit systemd, panel hostingu). Kto chce
  użyć pliku, podaje go jawnie: `node --env-file=/ścieżka/do/pliku dist/main.js health`.
- Testy (`pnpm test`) nie czytają `.env` — przekazują jawne, minimalne środowisko.

## Baza danych

PostgreSQL **16** (wersja, na której testujemy; wymagane ≥ 13 ze względu na wbudowane
`gen_random_uuid()`). Aplikacja łączy się **osobnym użytkownikiem bez praw superusera**, który
jest właścicielem swojej bazy (`docs/SECURITY.md` §1). Lokalnie (np. Ubuntu, `apt install
postgresql-16`):

```bash
sudo -u postgres psql <<'SQL'
CREATE ROLE radar LOGIN PASSWORD 'radar';      -- tylko lokalnie; na produkcji silne hasło
CREATE DATABASE radar_dev  OWNER radar;
CREATE DATABASE radar_test OWNER radar;        -- tylko dla testów integracyjnych
SQL
```

Migracje (`src/infrastructure/db/migrations.ts`) to jawny SQL, wersjonowany w kodzie:

- `pnpm dev migrate` (ze źródeł, czyta `.env`) lub `node dist/main.js migrate` (build);
- uruchamiaj po każdym wdrożeniu przed innymi komendami; ponowne uruchomienie nic nie zmienia;
- wszystkie oczekujące migracje wykonują się w **jednej transakcji** (błąd = schemat bez zmian),
  a równoległe uruchomienia są serializowane blokadą (PostgreSQL advisory lock). Blokada jest
  **jedna na bazę danych**, nie na schemat — migracje różnych schematów tej samej bazy też
  czekają na siebie;
- `statement_timeout` (30 s, patrz niżej) ogranicza także czekanie na tę blokadę i każdą
  migrację: drugie, równoległe `migrate`, które czeka dłużej niż 30 s, kończy się
  `Migration failed: timeout (57014)` (kod 1). To bezpieczne — nic nie zostało zastosowane, bo
  migracje biegną w jednej transakcji — wystarczy uruchomić `migrate` ponownie. Przyszła
  migracja, która może trwać dłużej (np. przebudowa dużej tabeli), musi sama podnieść limit:
  `SET LOCAL statement_timeout = '10min'` na początku swojego `up`;
- stan migracji: tabele `kysely_migration` i `kysely_migration_lock` w tym samym schemacie;
- brak migracji „w dół” — wycofanie to odtworzenie z backupu albo nowa migracja.

Pula połączeń ma stałe limity (`src/infrastructure/db/database.ts`): max 5 połączeń, 5 s na
nawiązanie połączenia, `statement_timeout` 30 s, zamykanie bezczynnych połączeń po 10 s. Każda
komenda zamyka pulę przed zakończeniem.

## Testy

`pnpm check` uruchamia format, lint, typecheck i wszystkie testy (Vitest):

- testy jednostkowe i smoke (`tests/*.test.ts`) — bez bazy, poza jednym smoke testem
  `health` z `"status":"ok"`, który wymaga działającej bazy;
- testy integracyjne (`tests/integration/`) na **prawdziwym PostgreSQL** z `TEST_DATABASE_URL`:

```bash
TEST_DATABASE_URL=postgres://radar:radar@localhost:5432/radar_test pnpm check
```

Bez `TEST_DATABASE_URL` testy wymagające bazy są **pomijane** (Vitest pokazuje je jako
`skipped`, a na początku przebiegu pojawia się `NOTICE: TEST_DATABASE_URL is not set …`) — taki
przebieg nie jest pełną weryfikacją. Każdy plik testowy pracuje we własnym, losowo nazwanym
schemacie (`search_path`), więc pliki mogą działać równolegle; schematy są usuwane po
zakończeniu całego przebiegu. Użytkownik testowy musi móc tworzyć schematy w bazie testowej
(właściciel bazy może). Nie wskazuj `TEST_DATABASE_URL` na bazę z danymi.

W CI (ustawiona zmienna `CI`) albo z `REQUIRE_DB_TESTS=1` brak `TEST_DATABASE_URL` **przerywa
przebieg błędem** zamiast pomijać testy — tam pominięty zestaw integracyjny nie może przejść
jako zielony (`REQUIRE_DB_TESTS=1 pnpm check` przed oddaniem PR-a). Wartości `0`/`false`/pusta
oznaczają „nie ustawiono”.

## Dokumentacja

| Plik                                             | Zawartość                                     |
| ------------------------------------------------ | --------------------------------------------- |
| [`docs/MASTER_PROMPT.md`](docs/MASTER_PROMPT.md) | Konstytucja projektu — zacznij tutaj          |
| [`docs/PRODUCT.md`](docs/PRODUCT.md)             | Produkt, użytkownik, MVP, non-goals           |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)   | Architektura, moduły, kontrakty, model danych |
| [`docs/ROADMAP.md`](docs/ROADMAP.md)             | Fazy rozwoju                                  |
| [`docs/PR_PLAN.md`](docs/PR_PLAN.md)             | Plan PR-ów z kryteriami akceptacji            |
| [`docs/AGENTS.md`](docs/AGENTS.md)               | 3 role agentów i workflow review              |
| [`docs/SECURITY.md`](docs/SECURITY.md)           | Zasady bezpieczeństwa i pozyskiwania danych   |
| [`docs/DECISIONS.md`](docs/DECISIONS.md)         | Rejestr decyzji (ADR)                         |
| [`docs/STATE.md`](docs/STATE.md)                 | Aktualny stan prac                            |
