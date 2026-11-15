# Radar Zamówień

Radar Zamówień pomaga małym i średnim firmom znajdować **niewielkie zamówienia i zapytania
ofertowe** publikowane w Biuletynie Zamówień Publicznych (platforma e-Zamówienia) i w Bazie
Konkurencyjności — i informuje firmę tylko o tych, które faktycznie do niej pasują.

```
źródła → pobranie → normalizacja → deduplikacja → dopasowanie → alert
```

> Status: **w budowie, etapami** (bieżący etap — `docs/STATE.md`). Repozytorium zawiera
> szkielet projektu, model domenowy (`Source`, `Opportunity`, `CompanyProfile`), schemat PostgreSQL z
> migracjami, repozytoria, bezpieczny klient HTTP, pierwszy adapter źródła (BZP przez oficjalne
> API platformy e-Zamówienia), drugi adapter (Baza Konkurencyjności, D-030; po migracji
> wyłączony), zapis ogłoszeń z deduplikacją i wykrywaniem zmian, zmiany
> terminów z ogłoszeń o zmianie, nadrabianie pominiętych dni, opis, kontakt i wartość ofert
> BZP odczytane z treści ogłoszenia, deterministyczny matching ofert do profilu firmy z
> wyjaśnieniem, dzienny digest e-mail, dostęp do profilu z linku w e-mailu (serwer web,
> sesja, wypis jednym kliknięciem), ekrany klienta (formularz profilu, lista dopasowań),
> samoobsługowy link logowania („Wyślij mi link”) i potwierdzanie zmiany adresu e-mail,
> ocena trafności ofert („Trafne”/„Nietrafne” z e-maila i z listy) i eksport listy do CSV,
> raport i alerty operatora, backup i odtworzenie, komendy CLI `health`, `migrate`,
> `source:preview`, `ingest`, `profile:create`, `profile:show`, `match:preview`, `digest`,
> `deliveries:pending`, `deliveries:resolve`, `serve`, `access:link`, `access:revoke`,
> `feedback:report`, `status`, `backup` i `restore` oraz artefakty
> wdrożenia na VPS (`deploy/`, [`docs/DEPLOY.md`](docs/DEPLOY.md)) — patrz
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
DATABASE_URL=postgres://… CRAWLER_CONTACT=<twój-monitorowany-kontakt> node dist/main.js source:preview bk --date 2026-11-03 --limit 20 | jq .
DATABASE_URL=postgres://… CRAWLER_CONTACT=<twój-monitorowany-kontakt> node dist/main.js ingest | jq .
```

Sprawdzenie `source:preview` (AC1): kod wyjścia 0, `normalized` > 0, a w logach
`source listing fetched` oba typy ogłoszeń (`part`) mają `records` > 0; pełna lista kontrolna w
[`docs/STATE.md`](docs/STATE.md) → „Blockers”. Dla `bk` (PR-08 AC1) jest jedna część
(`part` `announcements`) z `records` > 0 i `incomplete` najwyżej z
powodem `max_records` (gdy `--limit` jest mniejszy niż liczba ogłoszeń dnia); lista kontrolna jest w [`docs/DEPLOY.md`](docs/DEPLOY.md).

### Komendy CLI

| Komenda                                                                                     | Co robi                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `health`                                                                                    | Raport JSON na stdout: konfiguracja + połączenie z bazą (`select 1`, ograniczone timeoutem) + brak oczekujących migracji (pole `schema`). Baza niedostępna albo niewykonane migracje (`"schema":{"status":"error","reason":"not_migrated",…}`) → `"status":"error"`, kod `1`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `migrate`                                                                                   | Stosuje oczekujące migracje i wypisuje ich nazwy (`{"status":"ok","applied":[...]}`). Ponowne uruchomienie jest bezpieczne: `"applied":[]`, 0.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `source:preview <sourceId> [--date YYYY-MM-DD] [--limit N]`                                 | Pobiera ogłoszenia źródła opublikowane jednego dnia (domyślnie wczoraj według UTC) i wypisuje je znormalizowane jako JSON (liczniki, odrzucenia z powodami, `incomplete` przy osiągniętym limicie) oraz ogłoszenia o zmianie (`noticeUpdates` — liczba, `updates` — numer, `tenderId` i nowy termin albo powód pominięcia; nic nie jest stosowane). Nic nie zapisuje i nie łączy się z bazą (`DATABASE_URL` musi jednak być ustawiony — wspólna walidacja konfiguracji). `--limit`: maks. rekordów na typ ogłoszenia (BZP: zwykłe zamówienia, małe zamówienia i ogłoszenia o zmianie osobno), 1–500, domyślnie 20. Wymaga `CRAWLER_CONTACT`. Źródła: `bzp`, `bk` (Baza Konkurencyjności, D-030: `--limit` to ogłoszenia dnia, a każde wymaga jednego żądania, więc limit 5 min mieści ok. 100). `source:preview bk` działa także przy wyłączonym `bk`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `ingest [sourceId...] [--date YYYY-MM-DD \| --from YYYY-MM-DD --to YYYY-MM-DD] [--limit N]` | Pobiera ogłoszenia z dnia publikacji (`--date`), z każdego dnia zakresu (`--from`/`--to`, oba wymagane, najwyżej 31 dni) albo — bez opcji dnia — nadrabia: niepokryte dni z 31 dni kończących się wczoraj według UTC, od najwcześniejszego dnia, który źródło kiedykolwiek pobierało (źródło bez przebiegów: tylko wczoraj; brakujące dni starsze niż 31 dni w `clipped`, nie są pobierane; D-021). Zapisuje je w bazie: nowe → `inserted`, zmienione → `updated`, bez zmian → `unchanged` (bez zapisu), błędne → `rejected`. Ogłoszenia o zmianie (BZP) zmieniają termin składania ofert pierwotnego ogłoszenia (`updated`/`unchanged`) albo są pomijane z powodem w logu (`skipped`); nie tworzą ofert. Zapisana oferta BZP zawiera pola listy API oraz opis, kontakt (e-mail/telefon, inaczej `raw`) i szacunkową wartość z walutą odczytane z HTML ogłoszenia (`htmlBody`; sam HTML nie jest zapisywany); czego nie da się odczytać jednoznacznie, zostaje `null`. Oferty zapisane przed PR-03C po ponownym pobraniu są jednorazowo `updated` (uzupełnione pola — opis, kontakt, wartość — zmieniają `content_hash`; termin z ogłoszenia o zmianie zostaje), potem `unchanged`. Zapisana oferta `bk` (Baza Konkurencyjności, D-030) to ogłoszenie w bieżącej wersji: `externalId` = id ogłoszenia, wartość tylko jako suma wszystkich zamówień (inaczej `null`), waluta `PLN` tylko przy wartości, województwo tylko wspólne dla wszystkich miejsc realizacji, kontakt tylko e-mail/telefon. Bez `sourceId` — wszystkie źródła włączone w tabeli `sources` (migracje dodają `bzp` włączone i `bk` wyłączone; włączenie `bk` opisuje [`docs/DEPLOY.md`](docs/DEPLOY.md)). `--limit`: maks. rekordów na typ ogłoszenia i dzień (`bk`: ogłoszeń na dzień, najwyżej 250), 1–1000, domyślnie 1000; timeout 15 min na źródło i dzień. Źródła działają po kolei i niezależnie; każdy przebieg trafia do tabeli `ingestion_runs`. Wynik: JSON na stdout (`status`, `mode`, `from`, `to`, przebiegi z `publicationDate`, licznikami i `skippedReasons` — licznik `skipped` według powodu, np. `{"no_original":12,"superseded":1}`, tylko powody, które wystąpiły, suma = `skipped`; `notRun` — dni niewykonane po 2 kolejnych nieudanych pierwszych próbach dni źródła (`consecutive_failures`) albo po przerwaniu (`aborted`); `clipped` — `from`/`to`: pierwszy i ostatni brakujący dzień starszy niż okno nadrabiania), linia logu na przebieg. Kod `0`, gdy wszystkie źródła `succeeded` lub `incomplete` (limit), a także gdy trwa inny `ingest` (blokada w bazie — `"status":"skipped"`, nic nie jest pobierane); `1`, gdy któreś `failed`, gdy są niewykonane migracje, baza jest niedostępna albo blokada zostanie utracona w trakcie (`lock_lost`). Wymaga `CRAWLER_CONTACT` i wykonanego `migrate`. |
| `profile:create <file.json>`                                                                | Zakłada profil firmy z pliku JSON (≤ 64 KiB, UTF-8) ze wszystkimi polami: `email`, `name`, `categories` (co najmniej jedna z: `bhp`, `elektryka`, `instalacje`, `it`, `ppoz`, `remonty`, `serwis`, `sprzatanie`, `szkolenia`, `wyposazenie`), `includeKeywords`, `excludeKeywords`, `voivodeships` (nazwy 16 województw, np. „Mazowieckie” albo „woj. mazowieckie” — zapisywane w postaci kanonicznej), `counties`, `active`. Region: znane województwo oferty spoza województw profilu → poza regionem, niezależnie od powiatu (powiaty nigdy nie poszerzają profilu z województwami). W obrębie województwa z listy decyduje województwo; zawężanie powiatem nie jest zaimplementowane (żadne źródło nie podaje jeszcze powiatu). Powiaty działają samodzielnie tylko przy nieznanym województwie oferty albo w profilu bez województw — BZP nie podaje powiatu, więc taki profil dostaje oferty BZP z całego kraju jako „nieznane” (wystarczą kategoria i słowo: 70 pkt, 55 ze słowem tylko w opisie). Po utworzeniu profilu ostrzeżenia na stderr (profil i tak jest zapisany, kod `0`): powiaty bez województw, słowa krótsze niż 4 znaki (pasuje tylko dokładna forma: „gaz” nie znajdzie „gazu”) i brak słów kluczowych (małe zamówienia BZP bez CPV nigdy nie pasują); słowa kluczowe bez słów wykluczających — jedna linia „Wskazówka: …” (słowo znalezione w opisie może dopasować zamówienie z innej branży; wąskie przykłady wykluczeń: „ciągnik”, „koparka”, „dostawa paliwa” — wykluczenie działa też na opis, więc szerokie słowo, np. „dostawa”, usunie też własne przetargi firmy; sprawdź wynik w `match:preview`). Słowo kluczowe w tytule daje 30 pkt, tylko w opisie — 15: dla ofert bez CPV słowo kluczowe musi być w tytule — wybieraj słowa, które pojawiają się w tytułach. Słowa dopasowują też formy odmienione (temat bez końcowej samogłoski), także wykluczające: wykluczenie „auto” usuwa też „Automatyka”; słowo na „-nie”/„-cie” (≥ 6 znaków) także dopełniacz liczby mnogiej („szkolenie” → „szkoleń”; „pokrycie” → też „pokryć”, D-023) — wpisuj liczbę pojedynczą na „-nie”/„-cie” („szkolenie”, nie „szkolenia”), bo liczba mnoga nie znajdzie „szkoleń”; liczby tylko dokładnie; słowo ≤ 10 wyrazów. Nieznane pole → nazwa pola i lista dozwolonych. Wypisuje `{"status":"ok","id":"…"}`. Plik nieczytelny, za duży, niepoprawny JSON albo profil → kod `2` (do 5 ścieżek pól z opisem błędu, np. `email (missing)`, `categories.1 (not an allowed value)`, i dozwolone wartości przy kategoriach / województwach; bez wartości z pliku; baza nie jest otwierana); e-mail już użyty → `1`. Przykład pliku — niżej.                                                                                                                                                 |
| `profile:show <profileId>`                                                                  | Wypisuje profil jako JSON; nieznany id → `1`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `match:preview <profileId> [--limit N]`                                                     | Dopasowuje najnowsze oferty (bez `closed` i `cancelled`; `--limit` ofert do odczytu, 1–1000, domyślnie 100) do profilu (D-023) i wypisuje tekstem dopasowane — po terminie (najbliższy pierwszy, bez terminu na końcu), potem wyniku — z wynikiem, tytułem, zamawiającym, terminem (czas polski), linkiem i powodami („dlaczego: kategoria: elektryka (CPV 45310000-3); słowo: oświetlenie (tytuł); region: mazowieckie”), na końcu „dopasowane X z Y” (gdy są: „, w tym N bez słowa kluczowego (tylko kategoria i region)” — ile dopasowań daje sama kategoria; PR-09). Oferty po terminie — na samym końcu, z „(po terminie)”; nieprawidłowe zapisane wiersze ofert są pomijane (ostrzeżenie w logu, licznik w podsumowaniu, kod `0`), ale liczą się do `--limit`, więc ofert może być mniej niż N — ile pominięto, mówi podsumowanie. Bez danych kontaktowych; nic nie zapisuje ani nie wysyła. Działa też dla profilu nieaktywnego (z informacją o tym).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `digest [--dry-run] [--profile <profileId>]`                                                | Dzisiejszy digest (dzień w Polsce): każdy aktywny profil (albo tylko `--profile`) dostaje najwyżej jeden e-mail dziennie z nowymi dopasowanymi ofertami (pierwszy zapis w ostatnich 7 dniach, bez `closed`/`cancelled`, bez ofert po terminie — termin nieznany zostaje jako „nie podano”), których jeszcze nie dostał; najwyżej 50 na e-mail, najbliższy termin pierwszy (reszta w kolejnych dniach). Bez nowych ofert — bez e-maila. Domyślnie tryb `test`: e-mail trafia do plików w `EMAIL_OUTBOX_DIR`, nic nie jest wysyłane. `--dry-run`: tylko liczy, nic nie zapisuje ani nie wysyła. Wynik: jedna linia JSON (`status`, `digestDate`, `transport`, `profiles[]` z `status` i licznikami), bez adresów i tytułów. Kod `0`, gdy wszystko wysłano albo nie było czego wysłać, także gdy trwa inny `digest` (`"status":"skipped"`); `1`, gdy wysyłka się nie udała lub jej wynik jest niepewny, profil nie istnieje lub jest nieprawidłowy, są niewykonane migracje albo baza jest niedostępna. Szczegóły — niżej, „Digest (e-mail)”.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `deliveries:pending`                                                                        | Wysyłki czekające na decyzję operatora (status `pending`: wynik niepewny albo przebieg przerwany między rezerwacją a wysyłką, D-024) — jedna linia JSON: `{"status":"ok","pending":[{"profileId","transport","digestDate","offers","oldestCreatedAt"}],"truncated":false}`, po profilu, transporcie i dniu digestu (najstarszy dzień pierwszy, najwyżej 1000 grup). Tylko identyfikatory, daty i liczby — bez adresów i tytułów. Tylko odczyt; wymaga aktualnego schematu.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `deliveries:resolve <profileId> --sent\|--failed [--date YYYY-MM-DD] [--transport …]`       | Decyzja operatora o wierszach `pending` profilu w jednym transporcie (wszystkich albo z jednego dnia digestu, `--date`), w jednej transakcji; inne wiersze, transporty i profile bez zmian. `--transport test\|smtp` — domyślnie transport bieżącego `EMAIL_MODE` (jak `digest`; czytane jest samo `EMAIL_MODE`, `EMAIL_FROM`/`SMTP_URL` niepotrzebne; błędne `EMAIL_MODE` → kod `1`). `--sent` (e-mail doszedł): `sent`, `sent_at` = teraz, `attempts + 1`; `--failed` (nie doszedł): wiersze są usuwane, kolejny digest wyśle te oferty jak nowe (jeśli nadal pasują). Wypisuje `{"status":"ok","outcome":…,"transport":…,"digestDate":…,"changed":N}`. Odmowa bez zmian (kod `1`), gdy trwa `digest` albo inne `deliveries:resolve` (ten sam advisory lock, brany bez czekania; nie uruchamiaj o minucie crona `digest`) albo gdy żaden wiersz `pending` nie pasuje; oba albo żaden z `--sent`/`--failed`, zły id lub data, `--transport` podany dwa razy, bez wartości albo inny niż `test`/`smtp` → kod `2` (błąd wywołania, baza nie jest otwierana).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `serve`                                                                                     | Serwer web (PR-06A, PR-06B, PR-10): strona główna z „Wyślij mi link”, przykład digestu, strony logowania z linku, profilu, ustawień, potwierdzenia adresu, dopasowań (z ocenami i eksportem CSV, PR-12), oceny z linku i wypisu na `WEB_HOST:WEB_PORT` (domyślnie `127.0.0.1:3000`), za reverse proxy z TLS. E-maile dostępu wysyła tym samym transportem co `digest` (`EMAIL_MODE`). Wymaga `PUBLIC_BASE_URL` i aktualnego schematu bazy; działa do SIGINT/SIGTERM (łagodne zatrzymanie, kod `0`). Szczegóły — niżej, „Serwer web (`serve`)”.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `access:link <profileId>`                                                                   | Wydaje link logowania do profilu (jednorazowy, ważny 7 dni) i wypisuje `{"status":"ok","url":…,"expiresAt":…}` na stdout. **Link jest sekretem** — daje dostęp do profilu; przekazuj go tylko właścicielowi profilu. Wymaga `PUBLIC_BASE_URL`; nieznany profil → `1`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `access:revoke <profileId>`                                                                 | Unieważnia naraz wszystkie linki (logowania, wypisu, potwierdzenia adresu i oceny) i sesje profilu, w jednej transakcji — reakcja na przekazany dalej e-mail albo zgubione urządzenie. Wypisuje tylko liczby: `{"status":"ok","tokens":…,"sessions":…}`. Profil i powiadomienia bez zmian; nie wymaga `PUBLIC_BASE_URL`; nieznany profil → `1`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `feedback:report [--since YYYY-MM-DD]`                                                      | Oceny trafności klientów (PR-12, D-032) — jedna linia JSON: `total`, `profiles[]` (id profilu) i `categories[]` (kategoria MVP z kodów CPV oferty, `null` — bez kategorii), każda z `ratings`, `relevant`, `notRelevant` i `precision` (trafne / wszystkie; `null`, gdy brak ocen — nigdy `0`); `total` i profile także `delivered` (różne zamówienia wysłane, tylko `sent`; w `total` suma po profilach, czyli pary firma–zamówienie), `ratedDelivered` (z nich ocenione) i `coverage` (ocenione / wysłane; `null`, gdy nic nie wysłano; ma sens tylko dla wysyłki `EMAIL_MODE=smtp`). `--since`: tylko oceny ustawione lub zmienione i dostawy wysłane od początku tego dnia (czas polski). Bez adresów i tytułów; tylko odczyt. Kod `1` — baza niedostępna albo niewykonane migracje; `2` — zły argument. Szczegóły: [`docs/RUNBOOK.md`](docs/RUNBOOK.md) → „Oceny trafności”.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `status [--notify]`                                                                         | Raport operatora (PR-07A, D-028) — jedna linia JSON na stdout: dla każdego włączonego źródła ostatni przebieg, ostatni sukces (`succeeded`/`incomplete`) i nieudane dni z ostatnich 36 h niepokryte później, oraz wysyłki `pending` (gdy nie trwa `digest`) i `failed` od wczorajszego dnia digestu. Problemy: `source_failed`, `source_stale` (brak sukcesu od 36 h), `source_never_run`, `source_incomplete` (dwa najnowsze nie-`failed` przebiegi źródła, z dwóch różnych dni, oba `incomplete`; alert podaje ich powody `part: reason`; pojedynczy `incomplete` nie alarmuje), `no_enabled_sources`, `deliveries_pending`, `deliveries_failed`, `schema_not_ready`, `database_unavailable`, `status_internal_error` (nieoczekiwany błąd samego `status`, alert bez szczegółów), a z `BACKUP_DIR` (PR-07B) także `backup_dir_unreadable`, `backup_missing`, `backup_stale` (najnowsza kopia `radar-*.dump` starsza niż 26 h; pole `backup`). Tylko odczyt, bez blokady. Kod `0` — brak problemów, `1` — jest problem. `--notify`: przy problemie wysyła też jeden e-mail tekstowy (identyfikatory, kody, czasy, liczby — bez adresów i tytułów) na `OPERATOR_EMAIL` przez `EMAIL_MODE` (`test`: do `EMAIL_OUTBOX_DIR`); co uruchomienie, dopóki problem trwa; nieudana wysyłka → `1`. Z `HEARTBEAT_URL` (PR-07B): przy kodzie `0` jeden `GET` na ten adres (10 s, bez przekierowań i ponowień; pole `heartbeat`: `sent`/`failed`/`skipped`/`disabled`); nieudany ping nie zmienia kodu wyjścia. Co robić: [`docs/RUNBOOK.md`](docs/RUNBOOK.md) → „Alert statusu”.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `backup <dir>`                                                                              | Zrzut schematu aplikacji (`pg_dump` ≥ 16, format custom, bez właścicieli i uprawnień) do nowego pliku `<dir>/radar-<czas UTC>.dump` (`0600`, nigdy nie nadpisuje istniejącego) i `{"status":"ok","file":…,"bytes":…,"schema":…,"tables":…}` na stdout. **Plik zawiera dane osobowe** (adresy e-mail profili). Hasło z `DATABASE_URL` trafia do `pg_dump` tylko przez zmienną środowiskową procesu potomnego, nigdy przez argumenty. Błąd → `1`, bez pozostawionego pliku. Szczegóły — niżej, „Backup i odtworzenie”.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `restore <file>`                                                                            | Odtwarza backup (`pg_restore` ≥ 16, jedna transakcja — wszystko albo nic) do schematu z `DATABASE_URL`, tylko gdy ten schemat istnieje i jest **pusty** (nigdy na dane); potem sprawdza migracje jak `health` i wypisuje liczbę wierszy w każdej tabeli. Schemat niepusty, błąd odtwarzania albo oczekujące migracje → `1`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |

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

Powiat „warszawski zachodni” na razie nic nie zmienia w obrębie mazowieckiego: zawężania
powiatem nie ma, a BZP nie podaje powiatu.

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
pobiera zwykle tylko wczoraj (UTC, dzień już zamknięty), a po przerwie także pominięte dni.
Gotowy harmonogram to [`deploy/cron/radar`](deploy/cron/radar) (`/etc/cron.d/radar`,
[`docs/DEPLOY.md`](docs/DEPLOY.md)): backup 5:30, retencja 5:45, `ingest` 6:00,
`status --notify` 6:30, `digest` 7:30, `status --notify` 7:45 — czas lokalny hosta, więc strefa
hosta to `Europe/Warsaw` (cron Debiana/Ubuntu nie obsługuje `CRON_TZ`). Konfiguracja z
`/etc/radar/radar.env` przez `node --env-file=…`, nie z `.env` w katalogu kodu:

```cron
0 6 * * * radar cd /opt/radar-zamowien && /usr/bin/node --env-file=/etc/radar/radar.env dist/main.js ingest >>/var/log/radar/ingest.log 2>&1
```

`status --notify` po `ingest` (i po `digest`, niżej) wysyła operatorowi alert na `OPERATOR_EMAIL`,
gdy źródło się nie pobrało, jest nieaktualne albo wysyłki czekają na decyzję — co robić:
[`docs/RUNBOOK.md`](docs/RUNBOOK.md) → „Alert statusu”. Alert powtarza się przy każdym
uruchomieniu, dopóki problem trwa.

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
`UPDATE sources SET enabled = false WHERE id = 'bzp';` (`true` — ponowne włączenie; to samo dla
`bk`, który po migracji jest wyłączony — pierwsze włączenie: [`docs/DEPLOY.md`](docs/DEPLOY.md)). Gdy żadne
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

### Digest (e-mail)

`digest` uruchamiamy raz dziennie **po `ingest`** — w
[`deploy/cron/radar`](deploy/cron/radar) o 7:30 czasu polskiego, a o 7:45 drugi
`status --notify` sprawdza jego wysyłki.

- **Tryb `test` (domyślny, `EMAIL_MODE=test`)** — nic nie wychodzi z maszyny: każdy e-mail to
  plik `.eml` (gotowa wiadomość MIME) i `.json` (temat, tekst, HTML) w `EMAIL_OUTBOX_DIR`
  (domyślnie `./outbox`, w `.gitignore`; katalog `0700`, pliki `0600` — zawierają adres
  odbiorcy). Doręczenia zapisują się z transportem `test`, więc późniejsze przejście na `smtp`
  wyśle oferty od nowa (jeśli nadal są nowe i przed terminem).
- **Tryb `smtp` — tylko jawnie i po potwierdzeniu właściciela projektu** (wysyłka do
  prawdziwych odbiorców, `docs/SECURITY.md` §10, §14): `EMAIL_MODE=smtp`, `EMAIL_FROM`
  (obsługiwana skrzynka — odbiorcy rezygnują, odpowiadając na e-mail) i `SMTP_URL`
  (`smtps://` albo `smtp://` z wymaganym STARTTLS). Brak lub błąd którejś zmiennej → kod
  `1` przed otwarciem bazy, komunikat z nazwami zmiennych, bez wartości. Przed pierwszą
  prawdziwą wysyłką: `digest --dry-run` (ile ofert dostałby każdy profil).
- **Ponowne uruchomienie tego samego dnia nic nie wysyła** (`already_sent_today`); oferta
  trafia do profilu najwyżej raz. Nieudana wysyłka (`failed`, np. odrzucenie przez serwer) jest
  ponawiana przez kolejne uruchomienia (najwyżej 3 uruchomienia na ofertę); chwilowe błędy
  (np. odpowiedź 4xx, brak połączenia) są ponawiane od razu w tym samym przebiegu, najwyżej
  2 razy.
- **Błąd konfiguracji lub serwera zatrzymuje przebieg** (`errorCode` w podsumowaniu, komunikat
  `Digest stopped (…)`, kod `1`): `send_setup_failed` (logowanie, TLS/STARTTLS, odrzucony
  nadawca `EMAIL_FROM`, niezapisywalny outbox — bez ponawiania), `send_server_unreachable`
  (serwer nieosiągalny po ponowieniach), `send_outcome_unknown` (wynik niepewny, niżej).
  Pozostałe profile dostają `not_run`; przy dwóch pierwszych próba się nie liczy, więc po
  naprawie konfiguracji kolejne uruchomienie wyśle wszystkie oferty.
- **Wynik niepewny** (`uncertain` — połączenie zerwane w trakcie wysyłki, albo przerwany
  proces: `pending_today` / licznik `uncertain`) nie jest ponawiany automatycznie, żeby nie
  wysłać e-maila dwa razy. Każdy przebieg, który widzi takie wiersze, wypisuje na stderr
  `Digest: N deliveries are pending and need an operator decision …` (kod wyjścia bez zmian).
  Sprawdź log serwera SMTP (tryb `test`: outbox), czy wiadomość
  doszła — adres odbiorcy: `node dist/main.js profile:show <profileId>` (pole `email`; nie
  wklejaj go do zgłoszeń ani logów) — i zdecyduj (`docs/DECISIONS.md` D-024) komendami
  operatora (PR-09) — bez ręcznego SQL:

  ```bash
  node dist/main.js deliveries:pending   # profileId, transport, digestDate, liczba ofert, najstarszy wiersz
  node dist/main.js profile:show <profileId>   # adres odbiorcy: pole email
  # doszła (sent, sent_at, attempts + 1):
  node dist/main.js deliveries:resolve <profileId> --sent [--date YYYY-MM-DD] [--transport test|smtp]
  # nie doszła (wiersze usunięte; kolejny digest wyśle te oferty jak nowe):
  node dist/main.js deliveries:resolve <profileId> --failed [--date YYYY-MM-DD] [--transport test|smtp]
  ```

  Gdy wyniku nie da się ustalić, domyślnie `--sent`: oferty i tak są widoczne na
  `/dopasowania`, podwójny e-mail podważa zaufanie, a `--failed` wysłałby je jeszcze raz jako
  nowe.

  `deliveries:resolve` zmienia tylko wiersze `pending` wskazanego profilu i transportu (i dnia),
  w jednej transakcji, i odmawia (kod `1`, bez zmian), gdy właśnie trwa `digest` albo inne
  `deliveries:resolve` — zarezerwowane wiersze `digest` są wtedy `pending` do końca
  przebiegu; spróbuj po ich zakończeniu. Transport: `--transport` z grupy w
  `deliveries:pending`; bez niego — transport bieżącego `EMAIL_MODE`, jak w `digest` (czytane
  jest samo `EMAIL_MODE`, bez `EMAIL_FROM` i `SMTP_URL`).

- **Linki (PR-06A):** gdy ustawiono `PUBLIC_BASE_URL`, każdy e-mail ma w stopce link „Twój
  profil” (logowanie, jednorazowy, 7 dni) i link wypisu (60 dni), a nagłówki
  `List-Unsubscribe: <https://…/wypis/…>, <mailto:…>` i
  `List-Unsubscribe-Post: List-Unsubscribe=One-Click` — przycisk „Anuluj subskrypcję” w
  programie pocztowym wypisuje wtedy jednym kliknięciem, bez udziału operatora. Kto ma e-mail,
  ma dostęp do profilu — stopka ostrzega, żeby nie przekazywać wiadomości dalej. Bez
  `PUBLIC_BASE_URL` — jak niżej (tylko `mailto`).
- **Rezygnacja:** odbiorca odpisuje lub pisze do operatora; operator wyłącza profil
  (`UPDATE company_profiles SET active = false WHERE id = '…';`). Każdy e-mail (także plik
  `.eml` w trybie `test`) ma nagłówek
  `List-Unsubscribe: <mailto:<adres z EMAIL_FROM>?subject=wypis>` (sam adres, bez nazwy) —
  przycisk „Anuluj subskrypcję” w Gmailu czy Outlooku (jeśli program go pokaże) wysyła e-mail
  „wypis” na skrzynkę `EMAIL_FROM`, obsługiwany jak odpowiedź (z `PUBLIC_BASE_URL` — także
  link `https`, wyżej).
- Nakładające się uruchomienia są bezpieczne: drugie kończy się
  `{"status":"skipped","reason":"lock_busy",…}`, komunikatem `Digest skipped: …` i kodem `0`.
- **Karta oferty (PR-11, `src/notifications/card.ts`):** jedna czysta funkcja `offerCard`
  dla tekstu i HTML e-maila, `/dopasowania` i `/przyklad`; wszędzie ta sama treść w tej samej
  kolejności (D-030), tak żeby na telefonie 390 px pierwszy ekran mówił: ile, do kiedy,
  dlaczego. Po kolei: tytuł; „Wartość szacunkowa: 120 000,00 PLN (źródło nie podaje, netto
  czy brutto)” (brak → „nie podano”, nigdy 0; D-030), „Termin składania ofert: 18.11.2026
  (śr) 10:00 — za 12 dni” (czas polski; „dziś”, „jutro”, „za N dni”, „minął”; 0–2 dni →
  przedrostek „PILNE”; brak → „nie podano”), „Dlaczego pasuje” jednym zdaniem („Elektryka ·
  słowo „oświetlenie” w tytule · mazowieckie”); przycisk „Otwórz ogłoszenie” (tekst e-maila:
  linia „Otwórz ogłoszenie: …”; bez użytecznego linku w tym miejscu „Link: nie podano”);
  zamawiający, lokalizacja, opis (wyciąg do ok. 300 znaków, ucięty na granicy słowa, „…”
  tylko po ucięciu; e-mail ma sam wyciąg), źródło (tylko oferty Bazy Konkurencyjności —
  atrybucja wymagana regulaminem, zawsze widoczna, D-030); na końcu data publikacji
  (DD.MM.RRRR), kontakt (gdy jest) i „Szczegóły dopasowania” (kody CPV i powody techniczne,
  np. nieznany region). Na stronach te trzy są w jednym natywnym `<details>` „Więcej
  szczegółów (…)”; w e-mailu (programy pocztowe nie wszystkie obsługują `<details>`) są
  widoczne, mniejszym drukiem, jako ostatnie linie karty. Kartę zamyka ocena
  „Trafne”/„Nietrafne” (PR-12; e-mail: linki, `/dopasowania`: przyciski). Dni liczy chwila
  przebiegu digestu (strona: chwila żądania).
  **Temat:** „Radar Zamówień: 3 nowe, najbliższy termin 18.11” (1 nowe, 2–4 nowe, 5+ nowych
  z polską odmianą; najbliższy termin nieminiony, bez niego samo „Radar Zamówień: 3 nowe”),
  bez nazwy firmy i bez danych źródła.
- **Termin:** „po terminie” liczy się z zapisanego terminu. Dla małych zamówień BZP i dni
  niepobranych w kolejności termin może być nieaktualny (przedłużenie nie dotarło) — taki
  przetarg może zostać pominięty. Odwołania postępowań (ogłoszenia BZP o unieważnieniu /
  odwołaniu) nie są jeszcze pobierane, więc odwołany przetarg może trafić do digestu jako
  otwarty. E-mail przypomina, że termin mógł się zmienić, a postępowanie zostać odwołane, i
  każe sprawdzić ogłoszenie w źródle (D-024).

### Serwer web (`serve`)

`serve` to jedyny długo działający proces (PR-06A, PR-06B, PR-10, D-025–D-027, D-031): `node:http`
bez frameworka, strony HTML bez JavaScriptu. Uruchamiany jako usługa (unit systemd
[`deploy/systemd/radar-serve.service`](deploy/systemd/radar-serve.service) z `Restart=on-failure`,
za Caddy z TLS — [`deploy/caddy/Caddyfile`](deploy/caddy/Caddyfile)), nie z crona; wymaga wykonanego
`migrate`.

```sh
PUBLIC_BASE_URL=https://radar.example.invalid node dist/main.js serve
```

- **Strona główna (PR-10):** `/` mówi, czym jest serwis, skąd ma dane (BZP i Baza
  Konkurencyjności) i jak zacząć (przez operatora), ma formularz „Wyślij mi link”, link do
  `/przyklad` (przykładowe zestawienie z pseudonimizowanych danych w kodzie, bez bazy; daty
  liczone od chwili wyświetlenia; na jednej stronie najważniejsze stany karty oferty: wartość
  podana i „nie podano”, termin za kilka dni, jutro z „PILNE” i „nie podano”, opis ucięty,
  krótki i brak opisu, nieznany region, kod CPV spoza listy kategorii, oferty BZP i Bazy
  Konkurencyjności) i
  kontakt z `CONTACT_EMAIL` (bez tej zmiennej kontakt nie jest pokazywany).
- **Dostęp:** klient loguje się linkiem z e-maila (`/dostep/<token>` → przycisk „Zaloguj
  się”; samo otwarcie linku, np. przez skaner poczty, go nie zużywa; link działa raz) albo
  linkiem od operatora (`access:link <profileId>`). Sesja w ciasteczku `__Host-radar_sesja`
  (30 dni). Logowanie przyjmuje tylko formularz z tej samej strony (`Origin` albo
  `Sec-Fetch-Site: same-origin`; inaczej 403). Każdy nieważny link (zużyty, wygasły,
  nieznany) daje tę samą stronę „link nieważny” z formularzem „Wyślij mi link”.
- **„Wyślij mi link” (PR-10, D-031):** `POST /wyslij-link` z jednym polem `email` (≤ 1 KiB,
  ta sama kontrola `Origin`/`Sec-Fetch-Site` co logowanie). Każdy poprawny adres dostaje od
  razu tę samą stronę „Jeśli adres jest w bazie, link przyjdzie w ciągu kilku minut…” —
  także adres bez profilu, profil wyłączony i profil po limicie; zły zapis adresu → błąd w
  formularzu. Wyszukanie profilu i wysyłka idą po odpowiedzi (kolejka w pamięci: jedno
  zadanie naraz, najwyżej 20 czekających). Link logowania (jednorazowy, 7 dni) idzie tylko
  na bieżący adres profilu, także wyłączonego. Limity: najwyżej 3 e-maile dostępu na profil
  w 24 h (w bazie) i 10 żądań na adres IP (IPv6: na sieć /64) na godzinę (w pamięci `serve`;
  po przekroczeniu 429). Wynik każdego zadania to linia logu `access mail` z `outcome`
  (`sent`, `no_profile`, `limit_reached`, `send_failed`, `dropped`, `failed`, `not_sent`) —
  bez adresu i linku.
- **Strony klienta (PR-06B, D-027):**
  - `/profil` — nazwa, adres powiadomień i status profilu, linki do ustawień i dopasowań,
    przyciski „Wypisz” / „Włącz ponownie powiadomienia” (`POST /profil/wlacz`, bez operatora)
    i „Wyloguj”; przy zmianie adresu w toku „Oczekuje na potwierdzenie: <adres>” (po
    wygaśnięciu linku: że link wygasł) i „Anuluj zmianę” (`POST /profil/anuluj-email`);
  - `/profil/ustawienia` — formularz: nazwa, e-mail, kategorie, województwa, powiaty i słowa
    kluczowe (wpis w wierszu); błędy po polsku przy polach, po zapisie powrót na `/profil` z
    „Zapisano” (albo z prośbą o potwierdzenie nowego adresu);
  - `/dopasowania` — oferty, które pasują do profilu teraz, tymi samymi regułami co digest
    (pierwszy zapis w ostatnich 7 dniach, bez ofert po terminie), najbliższy termin pierwszy,
    najwyżej 50, z powodami dopasowania i linkiem do źródła. Pokazuje też oferty już
    wysłane e-mailem. Ta sama karta oferty co w e-mailu (niżej, „Karta oferty”); pełny opis
    pod „Pełny opis”, gdy wyciąg jest skrócony, data publikacji, kontakt, kody CPV i powody
    techniczne pod „Więcej szczegółów” (natywne `<details>`, bez JavaScriptu). Wygląd:
    nagłówek i stopka serwisu, jeden kolor akcentu, schemat ciemny (`prefers-color-scheme`),
    widoczny fokus, przy wąskim ekranie (np. 390 px) etykiety nad wartościami. Na końcu każdej
    karty (po „Więcej szczegółów”) przyciski „Trafne” / „Nietrafne”
    (`POST /dopasowania/ocena`, sesja + CSRF, powrót 303 do karty);
    ocenę można zmienić, zostaje jedna na ofertę; oferty „nietrafne” są wyszarzone i na
    końcu listy, objaśnienie ocen jest pod listą (PR-12, D-032);
  - `/dopasowania.csv` — ta sama lista (te same oferty, kolejność i limit 50) jako plik CSV
    do pobrania (link „Pobierz listę jako CSV” nad listą): separator `;`, UTF-8 z BOM, kwota z
    przecinkiem dziesiętnym, brak wartości → pusta komórka, komórki zaczynające się od `=`,
    `+`, `-`, `@`, tabulatora lub CR poprzedzone `'` (Excel nie wykona ich jako formuły). Tylko
    z sesją.
- **Ocena z e-maila (PR-12, D-032):** każda oferta w digeście (z `PUBLIC_BASE_URL`) ma
  zwykłe linki „Trafne” / „Nietrafne” (`/ocena/<token>/<oppId>/<werdykt>`). Token jeden na
  e-mail, wielokrotny, ważny 60 dni, tylko dla ofert wysłanych temu profilowi. Otwarcie
  linku (także przez skaner poczty) pokazuje tylko stronę z przyciskiem; ocenę zapisuje
  dopiero `POST` z tej strony (ta sama kontrola `Origin`/`Sec-Fetch-Site` co logowanie).
  Nieważny token, cudza lub nieznana oferta i zła ścieżka → ta sama strona „link nieważny”
  (404). Wyniki: `feedback:report`.
- **Wypis:** `/wypis/<token>` — strona z przyciskiem; POST RFC 8058 z programu pocztowego
  (`multipart/form-data` albo `application/x-www-form-urlencoded`) wypisuje bez logowania i
  odpowiada 200, nigdy przekierowaniem. Ponowny wypis niczego nie zmienia.
- **Obsługa klienta:** klient bez działającego linku prosi o nowy formularzem „Wyślij mi
  link” (strona główna i strona „link nieważny”). Gdy link nie przychodzi:
  [`docs/RUNBOOK.md`](docs/RUNBOOK.md) → „Klient nie dostaje linku”. Link od operatora:
  `node dist/main.js access:link <profileId>` i wyślij URL **tylko na adres e-mail zapisany w
  tym profilu** (link jest sekretem — nie na adres, z którego przyszła prośba, jeśli jest
  inny). Ponowne włączenie powiadomień po wypisie przez pomyłkę: klient z sesją ma przycisk
  na `/profil`; bez sesji operator:
  `UPDATE company_profiles SET active = true WHERE id = '<profileId>';`. Przekazany dalej
  e-mail z linkami albo zgubione urządzenie z otwartą sesją:
  `node dist/main.js access:revoke <profileId>` — usuwa naraz wszystkie linki (logowania,
  wypisu, potwierdzenia adresu i oceny) i sesje profilu, wypisuje tylko liczby (`{"status":"ok","tokens":…,"sessions":…}`);
  profil i powiadomienia zostają bez zmian. Potem nowy link: `access:link` jak wyżej. Po
  `access:revoke` wypis jednym kliknięciem ze starszych e-maili przestaje działać — klient
  może wypisać się odpowiedzią albo linkiem z kolejnego digestu. `<profileId>` po adresie
  e-mail (w bazie zawsze małymi literami, bez spacji na brzegach) — w `psql`; adres wklej po
  „Adres:” bez cudzysłowów, `:'adres'` sam go cytuje (bezpieczne także dla apostrofu w
  adresie):

  ```sql
  \prompt 'Adres: ' adres
  SELECT id FROM company_profiles WHERE email = lower(btrim(:'adres'));
  ```

- **Zmiana e-maila przez klienta (PR-10, D-031):** nowy adres z formularza czeka na
  potwierdzenie (`pending_email`); do potwierdzenia digest, linki i logowanie używają starego.
  Na nowy adres idzie link potwierdzający (`/potwierdz-email/<token>`, jednorazowy, 24 h;
  otwarcie pokazuje tylko przycisk, adres zmienia dopiero `POST`), na stary — powiadomienie
  bez linków i bez nowego adresu. Kolejna zmiana zastępuje oczekującą; najwyżej 3 linki
  potwierdzające na profil w 24 h (potem błąd w formularzu). Formularz nie mówi, czy adres
  ma inny profil; adres zajęty w chwili potwierdzenia → neutralna strona i brak zmiany.
  Potwierdzenie unieważnia wszystkie linki z wcześniejszych e-maili (logowania, wypisu i
  oceny) i
  wylogowuje inne urządzenia; przeglądarka z sesją tego profilu zostaje zalogowana. Gdy
  dawny właściciel zgłasza przejęcie: `access:revoke`, poprawka adresu
  (`UPDATE company_profiles SET email = …, pending_email = NULL`) i nowy link przez
  `access:link`. Gdy adres zmieni się w trakcie `digest` (z `PUBLIC_BASE_URL`), profil
  dostaje w wyniku status `address_changed` (kod 0): nic nie zostało wysłane, następny
  przebieg wyśle oferty na nowy adres.

- **Reverse proxy i TLS (PR-07):** `serve` mówi czystym HTTP i domyślnie słucha tylko na
  `127.0.0.1:3000` — nie wystawiaj go bezpośrednio. TLS, HSTS i przekierowanie z `http` robi
  proxy (np. Caddy, nginx) kierujące `PUBLIC_BASE_URL` na `WEB_HOST:WEB_PORT`. Ścieżki
  `/dostep/…`, `/wypis/…`, `/potwierdz-email/…` i `/ocena/…` zawierają tokeny: **proxy nie może ich
  zapisywać w logach dostępu** (wyłącz log albo przycinaj ścieżkę). Limit „Wyślij mi link”
  na IP bierze adres klienta z ostatniego wpisu `X-Forwarded-For`, gdy połączenie przychodzi
  z loopback (proxy na tym samym hoście): proxy musi ten nagłówek ustawiać sam, nie
  przekazywać wartości od klienta (Caddy robi to domyślnie). Przed wysyłką do prawdziwych odbiorców
  sprawdź, że **DKIM podpisuje nagłówki `List-Unsubscribe` i `List-Unsubscribe-Post`**
  (RFC 8058; bez tego duże skrzynki ignorują wypis jednym kliknięciem).
- **Koszt `/dopasowania`:** dopasowanie liczone jest na każde wejście w procesie `serve`
  (lokalnie ok. 0,8 s przy 5 000 ofert z 7 dni i typowym profilu; do kilkunastu sekund przy
  10 000 ofert i maksymalnym profilu). W tym czasie inne strony odpowiadają normalnie, ale
  naraz liczona jest tylko jedna lista, wspólnie dla wszystkich klientów: kolejne wejście na
  `/dopasowania` (także innego klienta) czeka w kolejce (najwyżej 8 wejść, najwyżej 3 s); przy
  pełnej kolejce albo po 3 s dostaje 503 z `Retry-After: 5` i prośbą o ponowienie za kilka
  sekund. Na proxy ustaw limit żądań dla tej ścieżki (PR-07).
- **Zdrowie (PR-07B, D-029):** `GET`/`HEAD /zdrowie` — `200` z treścią `ok`, gdy `serve`
  dostał odpowiedź z bazy (`select 1`) w 2 s, inaczej `503` (`niedostępne`); zwykły tekst,
  `no-store`, bez sesji i bez szczegółów błędu. Dla monitoringu dostępności i smoke testu.
- **Sprzątanie:** `serve` co godzinę usuwa wygasłe tokeny i sesje oraz zapisy limitu e-maili
  dostępu starsze niż doba (bez osobnego crona).
- **Logi:** jedna linia na żądanie (metoda, nazwa trasy, status, czas) — bez URL-i, tokenów,
  ciasteczek i adresów.

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
- **E-mail (`digest`, PR-05):** `EMAIL_MODE` (`test` — domyślnie, albo `smtp`),
  `EMAIL_FROM` (adres albo `Nazwa <adres>`; w trybie `test` domyślnie
  `Radar Zamówień <radar@example.invalid>`), `SMTP_URL` (`smtps://użytkownik:hasło@host:465`
  albo `smtp://…:587` ze STARTTLS; znaki specjalne w haśle zakodowane procentowo; bez ścieżki
  i parametrów; nigdy nie wypisywany), `EMAIL_OUTBOX_DIR` (tryb `test`, domyślnie
  `./outbox`). Czytane przez `digest`, `serve` (e-maile dostępu, PR-10) i `status --notify`;
  w trybie `smtp` `EMAIL_FROM` i `SMTP_URL` są wymagane. `deliveries:resolve` bez
  `--transport` czyta samo `EMAIL_MODE` (domyślny transport). Błąd →
  `Invalid e-mail configuration: <nazwy zmiennych>`.
- **Kontakt na stronie głównej (`serve`, PR-10):** `CONTACT_EMAIL` — opcjonalny adres
  kontaktowy pokazywany na `/`, na stronach 409 i 429 i w powiadomieniu o zmianie adresu; bez
  niego kontakt nie jest pokazywany. Sprawdzany przy starcie `serve`; błędny →
  `Invalid e-mail configuration: CONTACT_EMAIL` (bez wartości), kod `1`.
- **Web (`serve`, `access:link`, linki w `digest`; PR-06A):** `PUBLIC_BASE_URL` — adres, pod
  którym klienci widzą serwis (sam origin: `https://host[:port]`, bez ścieżki, zapytania i
  danych logowania; `http://` tylko dla `localhost`/`127.0.0.1`/`[::1]` poza
  `NODE_ENV=production`). Wymagany przez `serve` i `access:link`; w `digest` opcjonalny
  (ustawiony → linki w e-mailach). `WEB_HOST` (adres IP lub `localhost`, domyślnie
  `127.0.0.1`) i `WEB_PORT` (domyślnie `3000`) — czytane tylko przez `serve`. Błąd →
  `Invalid web configuration: <nazwy zmiennych>`.
- **Alerty operatora (`status --notify`, PR-07A):** `OPERATOR_EMAIL` — adres operatora (nie
  klienta), na który `status --notify` wysyła alert; czytany tylko przez `status --notify`
  (wraz ze zmiennymi e-mail wyżej — ten sam transport co `digest`). Brak →
  `OPERATOR_EMAIL is required for status --notify.`; błędny →
  `Invalid e-mail configuration: OPERATOR_EMAIL` (bez wartości). Kod `1`.
- **Kopia i heartbeat (`status`, PR-07B):** `BACKUP_DIR` — ścieżka bezwzględna katalogu
  backupów; ustawiona → `status` sprawdza wiek najnowszej kopii. `HEARTBEAT_URL` — adres
  `https://` (bez danych logowania i `#`) pingowany po `status` z kodem `0`; zawiera token, więc
  jest sekretem i nigdy nie jest wypisywany. Obie opcjonalne, czytane tylko przez `status`.
  Błąd → `Invalid status configuration: <nazwy zmiennych>`, kod `1`.
- **Produkcja / cron:** bezpośrednie `node dist/main.js …` **nie czyta** `.env`. Zmienne
  eksportuje środowisko uruchomieniowe (crontab, unit systemd, panel hostingu). Kto chce
  użyć pliku, podaje go jawnie: `node --env-file=/ścieżka/do/pliku dist/main.js health`.
  Wdrożenie z [`docs/DEPLOY.md`](docs/DEPLOY.md) robi tak wszędzie (unit systemd, cron):
  `/etc/radar/radar.env` (`root:radar 0640`, wzór [`deploy/radar.env.example`](deploy/radar.env.example)
  — bez cudzysłowów, `#` i `$` w wartościach).
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

### Backup i odtworzenie

`backup <dir>` zrzuca schemat aplikacji (bieżący schemat połączenia z `DATABASE_URL`, z
tabelą migracji) przez `pg_dump`; `restore <file>` odtwarza go przez `pg_restore` w jednej
transakcji. Wymagany klient PostgreSQL **16 lub nowszy** (`pg_dump`, `pg_restore` w `PATH`;
np. `apt install postgresql-client-16`) — nie starszy niż serwer.

```bash
install -d -m 0700 -o radar -g radar /var/backups/radar
node dist/main.js backup /var/backups/radar    # {"status":"ok","file":"/var/backups/radar/radar-20261102T050000Z.dump",…}
```

- Plik `radar-<RRRRMMDDTGGMMSSZ>.dump` ma prawa `0600` i **zawiera dane osobowe** (adresy
  e-mail i ustawienia profili, historia wysyłek) — trzymaj go tylko u właściciela i
  zaszyfrowany poza tą maszyną (retencja 14 kopii i zaszyfrowana kopia poza hostem:
  [`docs/DEPLOY.md`](docs/DEPLOY.md), `deploy/cron/radar`). Istniejący plik nigdy
  nie jest nadpisywany; przy błędzie nic nie zostaje.
- Hasło z `DATABASE_URL` nie trafia do argumentów ani na wyjście: narzędzia dostają adres bez
  hasła, a hasło w zmiennej `PGPASSWORD` swojego procesu. Wszystkie ustawienia
  połączenia muszą być w `DATABASE_URL`: przy niepustej zmiennej `PGHOST`, `PGHOSTADDR`,
  `PGPORT`, `PGUSER`, `PGPASSWORD`, `PGDATABASE`, `PGOPTIONS`, `PGSSLMODE` lub
  `PGSSLNEGOTIATION` komenda odmawia (`unsupported_database_url`, z nazwą zmiennej). TLS narzędzi odpowiada TLS aplikacji i nigdy
  nie jest słabszy (`pg` weryfikuje certyfikat już przy `sslmode=require`, więc narzędzia
  dostają `verify-full`). Parametru, którego nie da się przekazać z tym samym znaczeniem,
  komenda nie przyjmie (`unsupported_database_url`, z nazwą parametru).
- `restore` działa tylko do **istniejącego, pustego schematu** (bez żadnej tabeli, widoku ani
  sekwencji) — nigdy nie nadpisuje danych. Pełna procedura z próbą odtworzenia:
  [`docs/RUNBOOK.md`](docs/RUNBOOK.md) → „Backup i odtworzenie”.
- Limit czasu każdego narzędzia: 30 min (potem SIGTERM, po 5 s SIGKILL); połączenie: 10 s.

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

| Plik                                             | Zawartość                                            |
| ------------------------------------------------ | ---------------------------------------------------- |
| [`docs/MASTER_PROMPT.md`](docs/MASTER_PROMPT.md) | Konstytucja projektu — zacznij tutaj                 |
| [`docs/PRODUCT.md`](docs/PRODUCT.md)             | Produkt, użytkownik, MVP, non-goals                  |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)   | Architektura, moduły, kontrakty, model danych        |
| [`docs/ROADMAP.md`](docs/ROADMAP.md)             | Fazy rozwoju                                         |
| [`docs/PR_PLAN.md`](docs/PR_PLAN.md)             | Plan PR-ów z kryteriami akceptacji                   |
| [`docs/AGENTS.md`](docs/AGENTS.md)               | 3 role agentów i workflow review                     |
| [`docs/SECURITY.md`](docs/SECURITY.md)           | Zasady bezpieczeństwa i pozyskiwania danych          |
| [`docs/DECISIONS.md`](docs/DECISIONS.md)         | Rejestr decyzji (ADR)                                |
| [`docs/STATE.md`](docs/STATE.md)                 | Aktualny stan prac                                   |
| [`docs/RUNBOOK.md`](docs/RUNBOOK.md)             | Procedury operatora: alerty, źródła, wysyłki, backup |
| [`docs/DEPLOY.md`](docs/DEPLOY.md)               | Wdrożenie na VPS: instalacja, aktualizacja, powrót   |
