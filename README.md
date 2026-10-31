# Radar Zamówień

Radar Zamówień pomaga małym i średnim firmom znajdować **niewielkie zamówienia i zapytania
ofertowe** publikowane przez BIP-y, szkoły, szpitale, urzędy i inne jednostki publiczne —
i informuje firmę tylko o tych, które faktycznie do niej pasują.

```
źródła → pobranie → normalizacja → deduplikacja → dopasowanie → alert
```

> Status: **PR-04 (matching) — w toku**. Repozytorium zawiera szkielet
> projektu, model domenowy (`Source`, `Opportunity`, `CompanyProfile`), schemat PostgreSQL z
> migracjami, repozytoria, bezpieczny klient HTTP, pierwszy adapter źródła (BZP przez oficjalne
> API platformy e-Zamówienia), zapis ogłoszeń z deduplikacją i wykrywaniem zmian, zmiany
> terminów z ogłoszeń o zmianie, nadrabianie pominiętych dni, opis, kontakt i wartość ofert
> BZP odczytane z treści ogłoszenia, deterministyczny matching ofert do profilu firmy z
> wyjaśnieniem oraz komendy CLI `health`, `migrate`, `source:preview`, `ingest`,
> `profile:create`, `profile:show` i `match:preview`. Pozostałe funkcje produktu (e-mail,
> UI) powstają w kolejnych PR-ach — patrz
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
pnpm dev migrate         # {"status":"ok","applied":["0001_core_schema",…,"0003_opportunities_tender_id"]}; kolejne: "applied":[]
pnpm health              # {"status":"ok",...,"database":{"status":"ok"},"schema":{"status":"ok"}}
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

| Komenda                                                                                     | Co robi                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `health`                                                                                    | Raport JSON na stdout: konfiguracja + połączenie z bazą (`select 1`, ograniczone timeoutem) + brak oczekujących migracji (pole `schema`). Baza niedostępna albo niewykonane migracje (`"schema":{"status":"error","reason":"not_migrated",…}`) → `"status":"error"`, kod `1`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `migrate`                                                                                   | Stosuje oczekujące migracje i wypisuje ich nazwy (`{"status":"ok","applied":[...]}`). Ponowne uruchomienie jest bezpieczne: `"applied":[]`, 0.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `source:preview <sourceId> [--date YYYY-MM-DD] [--limit N]`                                 | Pobiera ogłoszenia źródła opublikowane jednego dnia (domyślnie wczoraj według UTC) i wypisuje je znormalizowane jako JSON (liczniki, odrzucenia z powodami, `incomplete` przy osiągniętym limicie) oraz ogłoszenia o zmianie (`noticeUpdates` — liczba, `updates` — numer, `tenderId` i nowy termin albo powód pominięcia; nic nie jest stosowane). Nic nie zapisuje i nie łączy się z bazą (`DATABASE_URL` musi jednak być ustawiony — wspólna walidacja konfiguracji). `--limit`: maks. rekordów na typ ogłoszenia (BZP: zwykłe zamówienia, małe zamówienia i ogłoszenia o zmianie osobno), 1–500, domyślnie 20. Wymaga `CRAWLER_CONTACT`. Źródła: `bzp`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `ingest [sourceId...] [--date YYYY-MM-DD \| --from YYYY-MM-DD --to YYYY-MM-DD] [--limit N]` | Pobiera ogłoszenia z dnia publikacji (`--date`), z każdego dnia zakresu (`--from`/`--to`, oba wymagane, najwyżej 31 dni) albo — bez opcji dnia — nadrabia: niepokryte dni z 31 dni kończących się wczoraj według UTC, od najwcześniejszego dnia, który źródło kiedykolwiek pobierało (źródło bez przebiegów: tylko wczoraj; brakujące dni starsze niż 31 dni w `clipped`, nie są pobierane; D-021). Zapisuje je w bazie: nowe → `inserted`, zmienione → `updated`, bez zmian → `unchanged` (bez zapisu), błędne → `rejected`. Ogłoszenia o zmianie (BZP) zmieniają termin składania ofert pierwotnego ogłoszenia (`updated`/`unchanged`) albo są pomijane z powodem w logu (`skipped`); nie tworzą ofert. Zapisana oferta BZP zawiera pola listy API oraz opis, kontakt (e-mail/telefon, inaczej `raw`) i szacunkową wartość z walutą odczytane z HTML ogłoszenia (`htmlBody`; sam HTML nie jest zapisywany); czego nie da się odczytać jednoznacznie, zostaje `null`. Oferty zapisane przed PR-03C po ponownym pobraniu są jednorazowo `updated` (uzupełnione pola — opis, kontakt, wartość — zmieniają `content_hash`; termin z ogłoszenia o zmianie zostaje), potem `unchanged`. Bez `sourceId` — wszystkie źródła włączone w tabeli `sources` (migracja dodaje `bzp`). `--limit`: maks. rekordów na typ ogłoszenia i dzień, 1–1000, domyślnie 1000; timeout 10 min na źródło i dzień. Źródła działają po kolei i niezależnie; każdy przebieg trafia do tabeli `ingestion_runs`. Wynik: JSON na stdout (`status`, `mode`, `from`, `to`, przebiegi z `publicationDate`, licznikami i `skippedReasons` — licznik `skipped` według powodu, np. `{"no_original":12,"superseded":1}`, tylko powody, które wystąpiły, suma = `skipped`; `notRun` — dni niewykonane po 2 kolejnych nieudanych pierwszych próbach dni źródła (`consecutive_failures`) albo po przerwaniu (`aborted`); `clipped` — `from`/`to`: pierwszy i ostatni brakujący dzień starszy niż okno nadrabiania), linia logu na przebieg. Kod `0`, gdy wszystkie źródła `succeeded` lub `incomplete` (limit), a także gdy trwa inny `ingest` (blokada w bazie — `"status":"skipped"`, nic nie jest pobierane); `1`, gdy któreś `failed`, gdy są niewykonane migracje, baza jest niedostępna albo blokada zostanie utracona w trakcie (`lock_lost`). Wymaga `CRAWLER_CONTACT` i wykonanego `migrate`. |
| `profile:create <file.json>`                                                                | Zakłada profil firmy z pliku JSON (≤ 64 KiB, UTF-8) ze wszystkimi polami: `email`, `name`, `categories` (co najmniej jedna z: `bhp`, `elektryka`, `instalacje`, `it`, `ppoz`, `remonty`, `serwis`, `sprzatanie`, `szkolenia`, `wyposazenie`), `includeKeywords`, `excludeKeywords`, `voivodeships` (nazwy 16 województw, np. „Mazowieckie” albo „woj. mazowieckie” — zapisywane w postaci kanonicznej), `counties`, `active`. Region: oferta pasuje, gdy pasuje którekolwiek województwo **lub** powiat; poza regionem jest tylko wtedy, gdy oferta podaje każdy używany wymiar i nic nie pasuje. BZP nie podaje powiatu, więc po dodaniu powiatu oferta BZP z innego województwa jest „nieznana” (potrzeba kategorii i słowa, 70 pkt), a nie poza regionem. Słowa dopasowują też formy odmienione (temat bez końcowej samogłoski), także wykluczające: wykluczenie „auto” usuwa też „Automatyka”; liczby tylko dokładnie; słowo ≤ 10 wyrazów. Nieznane pole → nazwa pola i lista dozwolonych. Wypisuje `{"status":"ok","id":"…"}`. Plik nieczytelny, za duży, niepoprawny JSON albo profil → kod `2` (do 5 ścieżek pól z opisem błędu, np. `email (missing)`, `categories.1 (not an allowed value)`, i dozwolone wartości przy kategoriach / województwach; bez wartości z pliku; baza nie jest otwierana); e-mail już użyty → `1`. Przykład pliku — niżej.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `profile:show <profileId>`                                                                  | Wypisuje profil jako JSON; nieznany id → `1`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `match:preview <profileId> [--limit N]`                                                     | Dopasowuje najnowsze oferty (bez `closed` i `cancelled`; `--limit` ofert do odczytu, 1–1000, domyślnie 100) do profilu (D-023) i wypisuje tekstem dopasowane — po terminie (najbliższy pierwszy, bez terminu na końcu), potem wyniku — z wynikiem, tytułem, zamawiającym, terminem (czas polski), linkiem i powodami („dlaczego: kategoria: elektryka (CPV 45310000-3); słowo: oświetlenie (tytuł); region: mazowieckie”), na końcu „dopasowane X z Y”. Oferty po terminie — na samym końcu, z „(po terminie)”; nieprawidłowe zapisane wiersze ofert są pomijane (ostrzeżenie w logu, licznik w podsumowaniu, kod `0`), ale liczą się do `--limit`, więc ofert może być mniej niż N — ile pominięto, mówi podsumowanie. Bez danych kontaktowych; nic nie zapisuje ani nie wysyła. Działa też dla profilu nieaktywnego (z informacją o tym).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

Kody wyjścia: `0` — OK, `1` — błąd konfiguracji/wykonania (np. baza niedostępna), `2` — błędne
użycie (komenda i argumenty są sprawdzane przed konfiguracją, więc błędne użycie zawsze daje `2`;
wyjątek: `ingest` ze źródłem niewłączonym w bazie daje `2` dopiero po odczycie bazy).

### Przykładowy profil

Plik dla `profile:create` (wszystkie pola są wymagane; listy regionów i słów mogą być puste;
przykład z [`docs/PRODUCT.md`](docs/PRODUCT.md)):

```json
{
  "email": "kontakt@example.invalid",
  "name": "Jan Kowalski Elektryka",
  "categories": ["elektryka", "ppoz"],
  "includeKeywords": ["oświetlenie", "instalacja odgromowa"],
  "excludeKeywords": ["dostawa paliwa"],
  "voivodeships": ["mazowieckie"],
  "counties": ["warszawski zachodni"],
  "active": true
}
```

```bash
pnpm dev profile:create profil.json   # {"status":"ok","id":"…"}
pnpm dev match:preview <id>
```

W `match:preview` oferty po terminie są na końcu, z dopiskiem „(po terminie)”. Zapisany wiersz
oferty, który nie przechodzi już walidacji, jest pomijany: ostrzeżenie w logu (stderr, id wiersza
i nazwy pól) i licznik w podsumowaniu („dopasowane 3 z 40, pominięto 1 nieprawidłowy wiersz”);
kod wyjścia zostaje `0`. Nieprawidłowy profil w bazie kończy komendę kodem `1`.

### Cron

`ingest` uruchamiamy raz dziennie ok. **06:00 czasu polskiego** bez opcji dnia — nadrabianie
pobiera zwykle tylko wczoraj (UTC, dzień już zamknięty), a po przerwie także pominięte dni. Przykład (crontab z obsługą `CRON_TZ`, np. cronie;
zmienne środowiskowe ustawione w crontabie lub w skrypcie opakowującym, nie w `.env`):

```cron
CRON_TZ=Europe/Warsaw
0 6 * * * cd /opt/radar-zamowien && node dist/main.js ingest >>/var/log/radar/ingest.log 2>&1
```

**Pierwsze wdrożenie — jednorazowo, przed pierwszym cronem:**

```sh
node dist/main.js ingest --from <wczoraj−30> --to <wczoraj>   # 31 dni (maksimum), UTC
```

Dlaczego: nadrabianie na świeżej bazie pobiera tylko wczoraj, a ogłoszenia o zmianie dotyczą
zwykle oryginałów sprzed kilku tygodni (dane właściciela: z ok. 670 zmian terminu z jednego
dnia tylko 2 dotyczyły ogłoszeń z dnia poprzedniego). Bez backfillu prawie wszystkie zmiany
kończyłyby się przez pierwsze tygodnie jako `no_original` (pominięte, bez ponowień). Backfill
zapisuje postępowania wciąż otwarte, a zmiany ich terminów stosuje po kolei, po oryginałach
(dni rosnąco); trwa zwykle 1–1,5 h (dzień ~2–3 min). Jego pierwszy dzień staje się też dolną
granicą nadrabiania (przesuwa ją każdy przebieg starszego dnia, także `--date`): kolejne
crony pobierają niepokryte dni z ostatnich 31 (dzień jest pokryty, gdy ma przebieg
`succeeded` lub `incomplete` uruchomiony po jego końcu), więc dzień backfillu, który się nie
udał, zostanie ponowiony automatycznie, dopóki mieści się w 31 dniach. Najstarszy dzień
backfillu wypada z okna już następnego dnia: jeśli się nie udał, pobierz go `--date`.

Plik `ingest.log` miesza JSON ze stdout z liniami logu i komunikatami tekstowymi ze stderr —
to nie są czyste linie JSON.

Nakładające się uruchomienia są bezpieczne: drugie niczego nie pobiera ani nie zapisuje (bez
wiersza w `ingestion_runs`), wypisuje
`{"status":"skipped","reason":"lock_busy","mode":…,"from":…,"to":…,"limit":…,"runs":[],"notRun":[],"clipped":[]}`, na stderr
`Ingest skipped: another ingest run holds the lock; nothing was fetched.` i kończy się kodem
`0` — to oczekiwany stan, nie awaria, więc nie powinien alarmować monitoringu (D-019). Gdy
blokada zostanie utracona w
trakcie (np. restart bazy), przebieg jest przerywany: kod `1`, `errorCode` `lock_lost` i
komunikat `Ingest aborted: the ingest lock was lost during the run (lock_lost).` — wystarczy
uruchomić `ingest` ponownie (zapisane rekordy zostaną rozpoznane jako `unchanged`). Wynik każdego przebiegu: tabela
`ingestion_runs` (np. `SELECT * FROM ingestion_runs ORDER BY started_at DESC LIMIT 10`).
Świeżość danych monitoruj po wieku najnowszego przebiegu `succeeded` w `ingestion_runs`
(np. `SELECT source_id, max(finished_at) FROM ingestion_runs WHERE status = 'succeeded' GROUP BY source_id`),
nie tylko po kodach wyjścia — `skipped` kończy się kodem `0`, a dzień bez udanego przebiegu
nie daje alarmu sam z siebie.
„Skipped” ma dwa znaczenia: `"status":"skipped"` — blokada była zajęta i nic nie pobrano;
`runs[].skipped` — rekordy przeczytane, ale celowo niezastosowane (np. ogłoszenie o zmianie bez
oryginału w bazie; powody zliczone w `runs[].skippedReasons`, każdy także w logu info
`notice update skipped`). Powody: `no_original`, `no_deadline_change`,
`not_contract_notice_change` — normalne; `superseded` — oczekiwane po backfillu lub ponowieniu
dnia, poza tym warto sprawdzić; `no_tender_id` — podejrzane (D-015).
Nieudany dzień nie zatrzymuje kolejnych dni źródła; dopiero po 2 kolejnych nieudanych
pierwszych próbach w jednym przebiegu pozostałe dni źródła są pomijane (`notRun`,
`consecutive_failures` — np. awaria źródła). Pierwsza próba to dzień, który nie miał jeszcze
żadnego przebiegu tego źródła; nieudane ponowienie dnia już próbowanego nie zwiększa ani nie
zeruje licznika, a udany dzień go zeruje.
Nieudany i niewykonany dzień nie jest pokryty, więc każdy następny `ingest` bez opcji dnia (np.
kolejny cron) pobierze go ponownie, dopóki mieści się w 31 dniach kończących się wczoraj; od
razu — `ingest` bez opcji albo `ingest --date <publicationDate z raportu>`. Ponowienie jest
bezpieczne dzięki deduplikacji. Brakujące dni starsze niż 31 dni nie są pobierane
automatycznie (te po najnowszym pokrytym dniu są w `clipped`) — trzeba je pobrać ręcznie:
`ingest --from … --to …` (najwyżej 31 dni na wywołanie). Przebieg `incomplete` (limit) pokrywa
dzień — nadrabianie go nie ponawia. Dni spoza lat 2000–2999 są odrzucane (kod `2`).

Uwagi dla operatora (D-021):

- **Po backfillu starszych dni** (`--from/--to`) pobierz ponownie dni następujące po nim aż do
  ostatniego pokrytego dnia, rosnąco, porcjami po najwyżej 31 dni. Ogłoszenie o zmianie
  przeczytane, zanim jego oryginał był w bazie, zostało pominięte (`no_original`) i nie jest
  ponawiane samo — bez ponownego pobrania jego dnia oryginał zostaje z nieaktualnym terminem.
  To samo, gdy dzień zmiany pobrano przed dniem oryginału — także po automatycznym ponowieniu
  nieudanego dnia, gdy nowsze dni pobrano już wcześniej.
- **Ręczne `--date` późniejszego dnia** nie przeskakuje wcześniejszej dziury: nadrabianie
  pobiera każdy niepokryty dzień okna, nie tylko dni po najnowszym pokrytym.
- **Dowolny przebieg starego dnia przesuwa dolną granicę nadrabiania** — nie tylko
  `--from/--to`, także ręczne `--date` dnia sprzed tygodni, nawet nieudane. Następny `ingest`
  bez opcji dnia pobierze wtedy każdy niepokryty dzień okna od tego dnia (do 31 dni naraz).
- **Dzień, który zawsze kończy się `failed`,** nie blokuje nowszych dni (jego nieudane
  ponowienia nie liczą się do limitu 2) — jest tylko ponawiany przy każdym nadrabianiu,
  dopóki mieści się w 31 dniach. Potem przestaje być
  pobierany (bez wpisu w `clipped`, gdy nowsze dni są pokryte); zapisz go jako utracony i
  zgłoś problem ze źródłem.
- **Uzupełnienie starszych ofert BZP (PR-03C, D-022):** oferty zapisane przed PR-03C mają
  `null` w opisie, kontakcie i wartości, dopóki ich dzień nie zostanie pobrany ponownie.
  Nadrabianie pobiera tylko dni jeszcze niepokryte, więc tych dni samo nie powtórzy — pobierz
  dni z wciąż otwartymi ofertami ręcznie: `ingest bzp --from … --to …` (najwyżej 31 dni na
  wywołanie), rosnąco. Każda taka oferta będzie raz `updated`, termin z ogłoszenia o zmianie
  zostaje.

Włączanie/wyłączanie źródła (bez wdrożenia, D-020):
`UPDATE sources SET enabled = false WHERE id = 'bzp';` (`true` — ponowne włączenie). Gdy żadne
źródło nie jest włączone, `ingest` kończy się `status` `succeeded` z pustym `runs` i kodem `0`
(tylko ostrzeżenie w logu).
Ruch do źródeł idzie bezpośrednio, bez proxy (D-014) — host crona musi mieć bezpośrednie
wyjście HTTPS.

Gdy baza nie odpowiada, `health` wypisuje na stdout raport z przyczyną, a na stderr jedną linię
dla operatora, np.:

```
{"status":"error","service":"radar-zamowien","environment":"production","database":{"status":"error","reason":"unreachable","code":"ECONNREFUSED"},"schema":{"status":"not_checked"}}
Database check failed: unreachable (ECONNREFUSED)
```

Gdy baza odpowiada, ale nie wykonano wszystkich migracji (np. po wdrożeniu nowej wersji bez
`migrate`), `health` kończy się kodem `1` z
`"schema":{"status":"error","reason":"not_migrated","pending":["…"]}` i linią
`` Schema check failed: not migrated; run `migrate` ``. Ten sam test (rejestr
`kysely_migration`, tylko odczyt) wykonuje `ingest` przed pobraniem.

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
