# Architektura — Radar Zamówień

> **Stan:** po PR-01 istnieją: szkielet CLI (`src/cli.ts`, `src/main.ts`, `src/health.ts`,
> `src/infrastructure/config.ts`, `src/infrastructure/logger.ts`), model domenowy
> (`src/domain/`) oraz warstwa bazy danych (`src/infrastructure/db/`: pula, migracje,
> repozytoria; komendy `health` z kontrolą bazy i `migrate`). PR-02 dodał `SafeHttpClient`
> (`src/infrastructure/http/`, część A) oraz kontrakt adaptera, pierwszy adapter — BZP przez
> oficjalne API (`src/sources/`, D-015) — i komendę `source:preview` (część B), bez zapisu do
> bazy. PR-03 część A dodaje zapis: `src/ingestion/` (fingerprint, `content_hash`, przebieg
> `runIngestion`, blokada), tabelę `ingestion_runs` (migracja `0002_ingestion_runs`), kolumnę
> `opportunities.tender_id` (migracja `0003`) i komendę `ingest`; część B — obsługę zmian
> ogłoszeń BZP (`NoticeUpdateNotice`, D-015; migracja `0004_notice_updates`) i nadrabianie
> pominiętych dni (`ingest --from/--to`, D-021); część C — później: helpery normalizacji (białe
> znaki, HTML → tekst, daty Europe/Warsaw, województwa/powiaty, CPV → kategorie, fallback
> kontaktu do `contact.raw`). Wszystko poniżej oznaczone
> _(plan, PR-xx)_ to projekt docelowy — kontrakty mogą zostać doprecyzowane w danym PR, a
> zmiana musi trafić do tego dokumentu i do `docs/DECISIONS.md`.

## 1. Styl: modularny monolit

Jedna aplikacja TypeScript/Node.js, jedna baza PostgreSQL, komendy CLI uruchamiane przez cron.
Moduły komunikują się zwykłymi wywołaniami funkcji przez jawne typy. Brak kolejek, brokerów,
cache'y i osobnych serwisów — przy 10–100 klientach i dziesiątkach źródeł nie ma do tego
podstaw (patrz `docs/DECISIONS.md` D-001).

```
              cron                              cron
               │                                 │
     ┌─────────▼─────────┐             ┌─────────▼─────────┐
     │  cli: ingest      │             │  cli: digest      │
     └─────────┬─────────┘             └─────────┬─────────┘
               │                                 │
 PUBLIC SOURCE │                                 │
      │        ▼                                 ▼
      │  sources/<adapter>  ──►  ingestion  ──►  PostgreSQL  ◄──  matching ──► notifications ──► e-mail
      │  fetch → extract →      fingerprint,     (opportunities,   score +      digest, idempotent
      └► normalize              dedup, upsert     profiles, ...)   explanation  delivery
               ▲
     infrastructure/http (bezpieczny klient HTTP: SSRF, timeout, limit rozmiaru, rate limit)
```

## 2. Struktura katalogów

Katalog powstaje dopiero razem z kodem, który go wypełnia.

```
src/
├── main.ts                 # granica procesu (process.argv/env/exitCode)          [PR-00]
├── cli.ts                  # routing komend, wstrzykiwana baza; bez procesu        [PR-00/01]
├── health.ts               # raport health (+ połączenie z bazą, migracje)         [PR-00/01]
├── infrastructure/
│   ├── config.ts           # walidacja env (zod)                                    [PR-00]
│   ├── logger.ts           # JSON-lines logger na stderr                            [PR-00]
│   ├── db/                 # pula pg + Kysely, migracje, repozytoria, mapowanie błędów [PR-01]
│   └── http/               # SafeHttpClient: polityka URL/IP, retry, limity      [PR-02]
├── domain/                 # typy + schematy zod: Source, Opportunity, CompanyProfile [PR-01]
├── sources/                # kontrakt adaptera, rejestr, podgląd; bzp/ = BZP    [PR-02]
│                           # warsaw-time.ts: czas lokalny Europe/Warsaw → UTC   [PR-03B]
├── ingestion/              # fingerprint, content_hash, runIngestion, blokada ingest [PR-03A]
│                           # catch-up.ts: plan dni nadrabiania                  [PR-03B]
├── matching/               # scoring + wyjaśnienie                             (plan, PR-04)
├── notifications/          # digest, szablon, wysyłka, idempotencja            (plan, PR-05)
└── web/                    # minimalny UI renderowany po stronie serwera       (plan, PR-06)
tests/
├── *.test.ts               # unit / smoke                                           [PR-00]
├── fixtures/<source>/      # prawdziwe odpowiedzi źródeł + README (pseudonimizacja) [PR-02]
└── integration/            # testy z prawdziwym PostgreSQL (TEST_DATABASE_URL)      [PR-01]
```

Fixture'y źródeł to prawdziwe odpowiedzi, zapisane bajt w bajt **z wyjątkiem** danych
kontaktowych osób w wartościach `htmlBody`, pseudonimizowanych zamianą tekstu na surowym pliku
(bez ponownej serializacji JSON): każdy e-mail → `kontakt@example.invalid`, każdy numer
telefonu/faksu → `000 000 000`, imię i nazwisko osoby fizycznej → `Jan Kowalski` (nazwy i
adresy instytucji zostają). Ta sama zasada obowiązuje przyszłe fixture'y (m.in. HTML w PR-03);
lista zamian — w `tests/fixtures/<source>/README.md`.

Zasada zależności: `domain` nie importuje niczego z innych modułów. `sources` zależy od
`domain` i `infrastructure/http`. `matching` zależy tylko od `domain` (czyste funkcje).
`ingestion` i `notifications` orkiestrują i jako jedyne dotykają repozytoriów. `cli`/`web`
składają zależności (proste wstrzykiwanie przez parametry, bez kontenera DI).

### Warstwa bazy danych (PR-01)

- `domain/` — typy i schematy zod; importuje tylko `zod`. Brak wartości = `null` (nigdy `0`
  ani `""`); kwoty jako string dziesiętny (`numeric` bez floatów); teksty muszą być poprawnym
  Unicode (bez samotnych surogatów UTF-16); linki zapisywane w postaci kanonicznej (`url.href`,
  bez białych znaków i znaków sterujących); błąd domenowy `DomainError` z kodem
  `invalid_input | duplicate | unknown_reference | constraint_violation | invalid_stored_row`
  (ostatni: wiersz odczytany z bazy nie spełnia schematu domenowego — np. ręcznie zmieniony
  jsonb; zawiera `rowId` i ścieżki pól, bez wartości).
- `infrastructure/db/` — Kysely + `pg` (D-007). Repozytoria to zwykłe funkcje
  `(db, input) → wynik`, które walidują wejście schematem domenowym, budują wyłącznie
  parametryzowane zapytania i zamieniają naruszenia ograniczeń PostgreSQL (SQLSTATE 23505,
  23503, 23514, 23502, klasa 22) na `DomainError` — bez komunikatu i `detail` serwera
  (zawierają wartości). Listy mają limit (domyślnie 100, max 1000).
- Repozytoria w PR-01: `sources` (upsert, get, lista włączonych), `opportunities` (atomowy
  upsert po `fingerprint`, zwraca `inserted`/`updated`; get), `company_profiles`
  (create/get/update/delete). PR-03A: `opportunities.ingestOpportunity` (upsert z wykrywaniem
  zmian, zwraca `inserted`/`updated`/`unchanged`, §5) i `ingestion-runs.recordIngestionRun`
  (zapis podsumowania przebiegu, §5).

## 3. Przepływ danych (pierwszy vertical slice)

```
PUBLIC SOURCE → SOURCE ADAPTER → RAW DOCUMENT → NORMALIZER → OPPORTUNITY
  → DEDUPLICATION → MATCHING → USER SUBSCRIPTION (profil) → EMAIL DIGEST / ALERT
```

| Krok         | Moduł                                  | Wejście → wyjście                                          | PR  |
| ------------ | -------------------------------------- | ---------------------------------------------------------- | --- |
| Pobranie     | `sources/<id>` + `infrastructure/http` | dzień publikacji + limit → `FetchResult` (`RawDocument[]`) | 02  |
| Ekstrakcja   | `sources/<id>`                         | `RawDocument` → rekordy źródła (walidowane każdy osobno)   | 02  |
| Normalizacja | `sources/<id>`                         | rekord → `OpportunityCandidate` albo odrzucenie z powodem  | 02  |
| Fingerprint  | `ingestion`                            | `OpportunityCandidate` → `OpportunityDraft`                | 03  |
| Deduplikacja | `ingestion`                            | `OpportunityDraft` → insert / update / skip                | 03  |
| Dopasowanie  | `matching`                             | `Opportunity` × `CompanyProfile` → `MatchResult`           | 04  |
| Alert        | `notifications`                        | dopasowania profilu → jeden digest, idempotentnie          | 05  |

## 4. Kontrakty modułów _(plan — doprecyzowanie w odpowiednich PR)_

### 4.1 Adapter źródła (PR-02, zaimplementowany)

`src/sources/types.ts`:

```ts
interface SourceAdapter<TNotice = unknown> {
  readonly sourceId: string; // stabilny identyfikator (sourceIdSchema), np. "bzp"
  readonly allowedHosts: readonly string[]; // jedyne hosty klienta HTTP tego źródła
  fetch(ctx: FetchContext): Promise<FetchResult>; // tylko przez ctx.http (SafeHttpClient)
  extract(doc: RawDocument): TNotice[]; // czyste, deterministyczne; bez I/O
  normalize(notice: TNotice): NormalizeResult; // czyste; kandydat albo odrzucenie z powodem
}
```

- `FetchContext` = `{ http, signal, publicationDate, maxRecords, now, logger, onDocument? }` —
  `http` to wąski interfejs `get` (`SourceHttpClient`); w produkcji zawsze `SafeHttpClient`, w
  testach skryptowany fake. `signal` ogranicza cały przebieg (timeout przebiegu), `maxRecords` —
  liczbę rekordów. `onDocument` (PR-03A, tryb strumieniowy `ingest`): gdy jest ustawiony,
  adapter przekazuje każdy pobrany dokument do tego callbacku, czeka na niego przed kolejnym
  żądaniem i nie przechowuje dokumentu (`FetchResult.documents` jest wtedy puste) — pamięć
  ograniczona do jednej strony (D-008); odrzucenie callbacku przerywa `fetch` i jest
  propagowane bez zmian. Bez `onDocument` (`source:preview`) dokumenty są zbierane i zwracane.
- `FetchResult` = `{ documents: RawDocument[], incomplete: { part, reason }[] }`. Osiągnięcie
  limitu (`max_records`, `max_pages`) albo niemożność bezpiecznej kontynuacji paginacji
  (`invalid_cursor`, `repeated_cursor`) nigdy nie jest ciche: trafia do `incomplete` i do
  logu (warn).
- `RawDocument` = `{ sourceId, url, fetchedAt, contentType, body }` — tylko w pamięci (D-008).
- Model błędów: błąd HTTP → `HttpClientError` z klienta (propagowany bez zmian); dokument
  bezużyteczny jako całość (nie UTF-8, nie JSON, nie ta struktura, za dużo rekordów) →
  `SourceFormatError` (stały powód, nigdy treść dokumentu); oba przerywają przebieg. Problem z
  jednym rekordem nie jest wyjątkiem: `normalize` zwraca
  `{ ok: false, externalId, reason }`, gdzie `reason` to stały tekst z nazwami pól (bez
  wartości ze źródła), więc można go logować i grupować.
- `normalize` zwraca `OpportunityCandidate` (`src/domain/opportunity.ts`) = `OpportunityDraft`
  bez `fingerprint` i `contentHash`: te liczy ingestion (PR-03) według reguł z §5, więc
  adapter nie zna ich definicji. Wspólny kształt pól, ta sama reguła waluty. Od PR-03B wynik
  ma `kind`: `opportunity` (`candidate`) albo `notice_update` (`update`: `NoticeUpdate` z
  `src/domain/notice-update.ts` — `sourceId`, `externalId` = numer ogłoszenia o zmianie,
  `tenderId` lub `null`, `publishedAt`, `fetchedAt`, `change` = `{kind: "deadline", deadline}`
  albo `{kind: "none", reason}`); zmiany nie są ofertami — stosuje je ingestion.
- `src/sources/registry.ts` — statyczna mapa `sourceId → adapter`; `src/sources/preview.ts` —
  `previewSource` (fetch → extract → normalize, bez zapisu; odrzucenia liczone i logowane;
  zmiany ogłoszeń tylko wypisywane w `updates`, nigdy stosowane).

Adapter **nie zawiera**: logiki dopasowania, wysyłki e-maili, UI, billingu, dostępu do bazy.

**BZP (`src/sources/bzp/`, D-015):** `GET /mo-board/api/v1/notice` na `ezamowienia.gov.pl`,
typy `ContractNotice`, `SmallContractNotice` i `NoticeUpdateNotice` (PR-03B) po kolei, każdy
z własnym limitem rekordów i stron (jeden typ nie wypiera drugiego). Paginacja keyset: `PageSize` = min(25, pozostały
limit typu), `SearchAfter` = `objectId` ostatniego rekordu
(tylko poprawny GUID). Koniec typu: pusta lub krótsza strona; przerwanie: limit rekordów,
40 stron na typ, brak/niepoprawny kursor, powtórzony kursor (strona kończąca się już użytym
kursorem powtarza zebrane rekordy, więc jest odrzucana), przerwany `signal`. Strona
dłuższa niż żądany `PageSize` → `SourceFormatError`. Ekstrakcja waliduje tylko używane pola
(każde ≤ 20 000 znaków), resztę — w tym `htmlBody` ofert — odrzuca. Mapowanie: `sourceUrl` = strona
ogłoszenia (`/mo-client-board/bzp/notice-details/id/{objectId}`), `externalId` =
`noticeNumber`, `tenderId` = identyfikator OCDS postępowania (brak, pusty, nie-tekst, dłuższy
niż 200 znaków, z niepoprawnym Unicode albo ze znakami sterującymi → `null`, bez odrzucania
rekordu), daty tylko w ścisłym formacie UTC (niepoprawna data publikacji lub terminu →
odrzucenie), lokalizacja = siedziba zamawiającego (miasto + województwo ze statycznej mapy
kodów `PLxx`, nieznany kod → brak województwa), kategorie = kody CPV w kolejności publikacji
bez duplikatów, `status` = `open`/`closed` względem `fetchedAt` albo `unknown` bez terminu;
opis, kontakt i wartość — `null` (brak pól strukturalnych; kontakt, a czasem wartość, bywają
tylko w odrzucanym `htmlBody` — kandydat na „HTML → tekst” w PR-03).
**Zmiany ogłoszeń BZP (PR-03B, D-015):** BZP publikuje je jako osobne `NoticeUpdateNotice`
(własny `noticeNumber`, powiązanie z pierwotnym ogłoszeniem tylko przez `tenderId`, nowy
termin tylko w `htmlBody`). Rekord jest rozpoznawany po własnym `noticeType`; dla zmiany
ekstrakcja czyta `noticeNumber`, `publicationDate`, `tenderId` i `htmlBody` (≤ 1 000 000
znaków, dłuższy → odrzucenie). `src/sources/bzp/notice-update.ts` (`extractDeadlineChange`)
czyta `htmlBody` liniowo jako tekst między znacznikami (bez komentarzy, `<script>`, `<style>`
i atrybutów; niedomknięty znacznik, komentarz, `<script>` lub `<style>` → odrzucenie;
normalizacja NFC tylko segmentów ≤ 256 znaków, bo jest kwadratowa w ciągu znaków łączących, a
dłuższy segment i tak nie może być etykietą ani datą) i zwraca tylko nowy termin z bloku „3.4.1.)” / „8.1. Termin składania ofert” /
„Po zmianie:” (`YYYY-MM-DD HH:MM` Europe/Warsaw → UTC, `src/sources/warsaw-time.ts`; godzina
pominięta lub powtórzona przy zmianie czasu → odrzucenie), gdy zmieniane ogłoszenie to
„Ogłoszenie o zamówieniu” (sekcja 3.1). Inna zmiana → `change.kind = "none"` ze stałym
powodem; niejednoznaczna lub niepoprawna → odrzucenie ze stałym powodem. HTML nie jest
zapisywany ani logowany.

### 4.2 SafeHttpClient (PR-02, zaimplementowany)

Jedyna droga do sieci dla adapterów (`src/infrastructure/http/`, D-014). `http:` nie jest
obsługiwany — źródło bez HTTPS wymagałoby wpisu w DECISIONS i zmiany kodu.

- `address-policy.ts` — `parseRequestUrl` (WHATWG `URL`, tylko `https:`, bez danych
  logowania, tylko domyślny port, bez hostów IP, host z allowlisty — dokładne dopasowanie bez
  rozróżniania wielkości liter, bez wildcardów; fragment usuwany), `normalizeAllowedHosts`,
  `isBlockedAddress` (zakresy w `docs/SECURITY.md` §2);
- `errors.ts` — `HttpClientError` z zamkniętym zbiorem `code`: `invalid_url`,
  `host_not_allowed`, `blocked_address`, `dns_failed`, `timeout`, `too_large`,
  `too_many_redirects`, `http_status` (+ `status`), `network`, `unsupported_encoding`,
  `decompression_failed`, `budget_exhausted`, `aborted`; stały komunikat (bez URL-a, zapytania,
  treści), pola `host`, `status`, `causeCode` (np. `ECONNRESET`), `retryable`;
- `safe-http-client.ts` — klasa `SafeHttpClient`:

```ts
new SafeHttpClient({
  sourceId, allowedHosts, logger,
  contact, // AppConfig.crawlerContact (CRAWLER_CONTACT); brak/niepoprawny → ConfigError
  minIntervalMs?, // domyślnie 2000, minimum 1000
  errorBudget?, // domyślnie 10 nieudanych prób
});
client.get(url, { signal? }): Promise<HttpResponse>; // tylko GET
interface HttpResponse { url: string; status: number; contentType: string | null; body: Buffer }
```

Przebieg `get`: walidacja URL-a → (na każdą próbę) odstęp per host → DNS (wszystkie adresy;
jeśli którykolwiek jest zablokowany → `blocked_address`; łączymy się z pierwszym IPv4, a gdy
go brak — z pierwszym IPv6) → `node:https` z własnym `lookup`, który zwraca **zweryfikowany**
adres (SNI, weryfikacja certyfikatu i nagłówek `Host` zostają przy nazwie hosta; nowe
połączenie na każde żądanie, bez puli keep-alive i bez proxy ze zmiennych środowiskowych) →
odpowiedź:

- 2xx: odczyt treści z limitem 5 MB w trakcie strumienia (`Content-Length` > limitu →
  odrzucenie od razu, ale nagłówkowi nie ufamy), potem dekompresja `gzip`/`x-gzip`/`deflate`
  (z nagłówkiem zlib albo surowy DEFLATE)/`br` z tym samym limitem na wyniku
  (`maxOutputLength`); inne lub łączone `Content-Encoding` → `unsupported_encoding`;
  dekodowanie tekstu należy do adaptera;
- 301/302/303/307/308 z `Location`: następny hop (względny `Location` względem bieżącego
  URL-a) walidowany jak nowe żądanie, max 3 przekierowania; treści przekierowań i błędów nie
  czytamy;
- pozostałe statusy → `http_status`.

Timeouty: połączenie (TCP + TLS) 10 s, cała wymiana (DNS, połączenie, nagłówki, treść) 30 s
na próbę; opcjonalny `signal` wywołującego przerywa też czekanie na rate limit i backoff
(`aborted`, bez retry). Retry tylko dla: `timeout`, przejściowych błędów sieci (`ECONNRESET`,
`ECONNREFUSED`, `ECONNABORTED`, `EPIPE`, `ETIMEDOUT`, `ENETUNREACH`, `EHOSTUNREACH`,
`EAI_AGAIN`), 429, 502, 503, 504; max 2 ponowienia; backoff `1 s × 2^(n-1) × (1 + los[0,1))`,
a przy `Retry-After` (sekundy lub HTTP-date) czekamy dłużej z tych dwóch; `Retry-After` > 60 s
→ błąd bez czekania. `Retry-After` (dowolnej długości, przy 429/502/503/504) jest też
zapamiętywany jako termin dla hosta — także gdy ponowień już nie ma: kolejne żądania do tego
hosta czekają do terminu, a dopóki zostało do niego > 60 s, kończą się od razu `http_status`
(ze statusem, który termin ustawił) bez ruchu sieciowego. Żądania jednego klienta są ściśle
sekwencyjne; między końcem żądania a startem następnego do tego samego hosta mija co najmniej
`minIntervalMs`. Odstępy, backoff i terminy liczone zegarem monotonicznym
(`performance.now()`); zegar ścienny tylko do przeliczenia `Retry-After` w formie HTTP-date.
Budżet błędów: każda nieudana próba (także odrzucenie przez politykę URL lub termin
`Retry-After`) zużywa jednostkę; po wyczerpaniu
każde kolejne `get` kończy się `budget_exhausted`, a retry, którego budżet by nie dopuścił,
nie jest podejmowany. Jeden klient = jeden przebieg źródła.

Logi (JSON-lines): `sourceId`, `host`, `method`, `status`, `durationMs` (bez czekania na rate
limit), `attempt`, `bytes`, `errorCode`, `causeCode`, `willRetry` — nigdy pełny URL, ścieżka,
zapytanie, nagłówki ani treść. User-Agent: `RadarZamowien/0.1 (+<CRAWLER_CONTACT>)` (e-mail
jako `mailto:`).

Seamy `SafeHttpClientDeps` (resolver, transport, zegary, sleep, losowość, limity) istnieją
**wyłącznie dla testów**: własny transport lub resolver omija przypinanie adresu i ochronę
SSRF, własny zegar/sleep — rate limit. Kod produkcyjny tworzy klienta tylko z `options`;
pilnuje tego reguła ESLint `no-restricted-syntax` dla `src/**` (zakaz drugiego argumentu
konstruktora, argumentów rozwijanych `...` i dziedziczenia po `SafeHttpClient` — także przez
import przestrzeni nazw `ns.SafeHttpClient` — oraz importu pod inną nazwą; test w
`tests/http-client-lint-guard.test.ts`), a obejścia, których lint nie wykryje
(`const C = SafeHttpClient`, `Reflect.construct`), wyłapuje review. Limity w seamie można
tylko zaostrzyć.

### 4.3 Ingestion (PR-03A, PR-03B, zaimplementowany)

`src/ingestion/run.ts`:

```ts
interface IngestionDeps {
  db; adapters; createHttpClient(adapter); now; logger; sourceTimeoutMs; signal?;
}
runIngestion(deps: IngestionDeps, request: IngestionRequest): Promise<IngestionOutcome>;
interface IngestionRequest { sourceIds?: string[]; days: IngestionDays; maxRecords: number }
type IngestionDays = { mode: "range"; from: string; to: string } | { mode: "catch_up" };
interface IngestionOutcome {
  runs: IngestionRunResult[]; // źródło po źródle, w każdym dni rosnąco
  notRun: { sourceId; publicationDate; reason: "consecutive_failures" | "aborted" }[];
  clipped: { sourceId; from; to }[]; // brakujące dni starsze niż okno nadrabiania
  from: string | null; to: string | null; // zaplanowane dni (null: nic do zrobienia)
}
// IngestionRunResult = IngestionRunSummary (src/domain/ingestion-run.ts) + runId (null = nie zapisano)
//   + skippedReasons (licznik `skipped` wg powodu, tylko w raporcie, bez kolumny w bazie)
```

- **Wybór źródeł:** bez `sourceIds` — wszystkie źródła włączone w bazie (`sources.enabled`);
  włączone źródło bez adaptera w tej wersji programu → przebieg `failed` z kodem `no_adapter`
  (zapisany i zalogowany, pozostałe źródła działają; D-020). Jawne `sourceIds` muszą być
  włączone w bazie **i** mieć adapter, inaczej `IngestionRequestError` przed jakimkolwiek
  pobraniem (CLI: kod 2). Niewykonana którakolwiek migracja (`pendingMigrations`, odczyt
  rejestru `kysely_migration`) → `SchemaNotReadyError` przed pobraniem (ingest nie migruje
  sam; CLI: kod 1; D-020).
- **Dni (PR-03B, D-021):** `range` — każdy dzień od `from` do `to` (dni z lat 2000–2999,
  najwyżej 31, `INGEST_MAX_DAYS` — liczone arytmetycznie przed zbudowaniem listy; inaczej
  `IngestionRequestError`). `catch_up` — per źródło, pod blokadą: `catchUpHistory`
  (`src/infrastructure/db/ingestion-runs-repository.ts`, jedno zapytanie: pokryte i próbowane
  dni w oknie 31 dni kończącym się wczoraj — pokryty = przebieg `succeeded`/`incomplete`
  rozpoczęty po końcu dnia, UTC — najnowszy pokryty dzień i najwcześniejszy dzień dowolnego
  przebiegu; daty przez `to_char`) → `planCatchUp`
  (`src/ingestion/catch-up.ts`): niepokryte dni okna od najwcześniejszego dnia przebiegu
  źródła, rosnąco; źródło bez przebiegów — tylko wczoraj; brakujące dni starsze niż okno →
  `clipped` (log warn), nigdy nie pobierane automatycznie; nic do zrobienia → log info
  `nothing to catch up`. Źródła po kolei, w każdym dni rosnąco, jeden przebieg na dzień;
  `failed` dnia nie zatrzymuje kolejnych dni; po 2 kolejnych nieudanych pierwszych próbach
  (`INGEST_MAX_CONSECUTIVE_FAILED_DAYS`, `failureStreak`; pierwsza próba = dzień bez
  wcześniejszego przebiegu źródła, z `catchUpHistory.attempted` — w trybie `range` to samo
  zapytanie ograniczone do zakresu; nieudane ponowienie nie zwiększa ani nie zeruje
  licznika) reszta dni źródła w `notRun` (`consecutive_failures`, log warn), inne źródła
  działają dalej; przerwany sygnał → reszta w `notRun` (`aborted`).
- **Przebieg źródła** (sekwencyjnie, każde izolowane): nowy klient HTTP, `signal` =
  timeout przebiegu źródła i dnia (`AbortSignal.timeout`, CLI: 10 min, D-018) połączony z sygnałem całego
  przebiegu (CLI: sygnał blokady ingest, przerywany przy jej utracie, D-019); `adapter.fetch`
  w trybie `onDocument`, każdy dokument od razu: `extract` → `normalize` → ponowna walidacja
  kandydata → `fingerprint`/`contentHash` → `ingestOpportunity`; zmiana ogłoszenia
  (`kind: "notice_update"`, ponowna walidacja `noticeUpdateSchema`, `sourceId` musi być
  źródłem przebiegu) → `applyDeadlineUpdate` (PR-03B). Po przerwaniu sygnału nie
  startuje kolejny zapis; zapis w toku ogranicza timeout zapytania (30/35 s). Przerwany sygnał
  całego przebiegu → kolejne źródła nie startują (log `ingestion aborted, sources not run`).
- **Wyniki rekordu:** `inserted` / `updated` / `unchanged` / `rejected` / `skipped`
  (PR-03B: zmiana ogłoszenia przeczytana, ale celowo niezastosowana — `no_tender_id`,
  `not_contract_notice_change`, `no_deadline_change`, `no_original`, `superseded`; log info
  `notice update skipped` ze stałym powodem). Zmiana z nowym terminem zapisana → `updated`,
  ta sama już zapisana → `unchanged`. Odrzucenie przez
  `normalize` lub `DomainError` repozytorium (np. `duplicate`, `invalid_input`) → `rejected`,
  log warn z kodem i nazwą constraintu, przebieg trwa dalej. Inny błąd zapisu (połączenie,
  timeout) → przebieg źródła `failed` (`database_error`).
- **Status przebiegu:** `failed` gdy błąd (`error_code`: kod `HttpClientError`,
  `invalid_document`, `source_timeout`, `lock_lost`, `database_error`, `no_adapter`,
  `internal_error`);
  rekordy zapisane przed błędem zostają. `incomplete` gdy adapter zgłosił `incomplete`
  (limit rekordów/stron, przerwana paginacja). W pozostałych przypadkach `succeeded`.
- Każdy przebieg trafia do `ingestion_runs` (`recordIngestionRun`) i do jednej linii logu
  `source ingestion finished`; nieudany zapis podsumowania → `runId: null`, log error
  `ingestion run not recorded` (z kodem SQLSTATE, bez komunikatu), a całość liczy się jako
  `failed` (CLI: `run_not_recorded` na stderr, kod 1).
- `overallStatus(results)`: `failed`, gdy któreś źródło `failed` lub niezapisane; inaczej
  `incomplete`, gdy któreś `incomplete`; inaczej `succeeded`.

`src/ingestion/fingerprint.ts` — `fingerprint` i `contentHash` (reguły w §5).
`src/ingestion/lock.ts` — `withIngestLock` (§6).

### 4.4 Matching (PR-04)

```ts
matchOpportunity(opportunity: Opportunity, profile: CompanyProfile): MatchResult;
interface MatchResult { score: number; matched: boolean; reasons: MatchReason[] }
```

Czysta funkcja, deterministyczna, bez I/O i bez LLM. Punkt wyjścia reguł (do kalibracji):

| Reguła                                   | Punkty |
| ---------------------------------------- | ------ |
| kategoria profilu ∈ kategorie zamówienia | +40    |
| słowo kluczowe profilu w tytule/opisie   | +30    |
| region zgodny                            | +20    |
| więcej niż jedno słowo kluczowe          | +10    |
| słowo wykluczające                       | −100   |

Każda przyznana/odjęta wartość generuje `MatchReason` (co, gdzie znaleziono), który trafia do
e-maila jako „dlaczego pasuje”. Dopasowanie tekstu po normalizacji (małe litery, usunięcie
diakrytyków tylko do porównań, granice słów).

### 4.5 Notifications (PR-05)

`buildDigest(profile, matches)` (czyste) → `EmailMessage`; `EmailSender` z dwiema
implementacjami: `test` (zapis do lokalnego outboxa/logu) i `smtp`. Idempotencja przez
unikalny wpis `deliveries(profile_id, opportunity_id)` zapisywany transakcyjnie przed/po
wysyłce wg strategii opisanej w PR-05.

## 5. Model danych

Stan zgodny z migracjami `0001_core_schema` … `0004_notice_updates`
(`src/infrastructure/db/migrations.ts`) — źródłem
prawdy są migracje. Wszystkie kolumny czasu to `timestamptz`; `id` typu uuid generuje
`gen_random_uuid()`. Statusy to `text` + `CHECK` (a nie typ `enum` PostgreSQL): dodanie
wartości to zwykła zmiana constraintu w migracji, bez `ALTER TYPE`. Nazwy constraintów są
jawne, bo trafiają do `DomainError.constraint`.

### `sources`

| Kolumna      | Typ         | Null | Uwagi                               |
| ------------ | ----------- | ---- | ----------------------------------- |
| `id`         | text        | nie  | PK, np. `baza-konkurencyjnosci`     |
| `name`       | text        | nie  |                                     |
| `base_url`   | text        | nie  | kanoniczny `href` (http/https)      |
| `enabled`    | boolean     | nie  | domyślnie `true`                    |
| `created_at` | timestamptz | nie  | domyślnie `now()`                   |
| `updated_at` | timestamptz | nie  | domyślnie `now()`; upsert → `now()` |

### `opportunities`

| Kolumna           | Typ               | Null | Uwagi                                                                     |
| ----------------- | ----------------- | ---- | ------------------------------------------------------------------------- |
| `id`              | uuid              | nie  | PK, `gen_random_uuid()`                                                   |
| `source_id`       | text FK → sources | nie  |                                                                           |
| `source_url`      | text              | nie  | link do oryginału; kanoniczny `href` (http/https)                         |
| `external_id`     | text              | tak  | identyfikator nadany przez źródło                                         |
| `tender_id`       | text              | tak  | identyfikator postępowania w źródle (BZP: OCDS `tenderId`); migracja 0003 |
| `issuer_name`     | text              | nie  | zamawiający                                                               |
| `title`           | text              | nie  |                                                                           |
| `description`     | text              | tak  | skrócony, tekst bez HTML                                                  |
| `location`        | jsonb             | tak  | `{ voivodeship?, county?, city?, raw? }` — tylko to, co wynika ze źródła  |
| `published_at`    | timestamptz       | tak  |                                                                           |
| `deadline`        | timestamptz       | tak  | termin składania ofert                                                    |
| `estimated_value` | numeric           | tak  | **tylko jeśli podana**; nigdy domyślne 0; w kodzie string dziesiętny      |
| `currency`        | char(3)           | tak  | wymagana, gdy `estimated_value` nie jest null                             |
| `categories`      | text[]            | nie  | może być pusta tablica (domyślnie `'{}'`)                                 |
| `contact`         | jsonb             | tak  | tylko dane kontaktowe opublikowane przy zamówieniu                        |
| `fetched_at`      | timestamptz       | nie  | pobranie, przy którym treść ostatnio zapisano (nie przy `unchanged`)      |
| `first_seen_at`   | timestamptz       | nie  | `now()` przy pierwszym zapisie; upsert go nie zmienia                     |
| `updated_at`      | timestamptz       | nie  | `now()` przy każdym zapisie (insert i update)                             |
| `fingerprint`     | text              | nie  | klucz deduplikacji (patrz niżej)                                          |
| `content_hash`    | text              | nie  | wykrywanie zmian treści                                                   |
| `status`          | text + CHECK      | nie  | `open` / `closed` / `cancelled` / `unknown`; bez wartości domyślnej       |

Od migracji `0004_notice_updates` (PR-03B, D-015) — pochodzenie terminu ustawionego przez
ogłoszenie o zmianie: `deadline_update_notice text` (numer ogłoszenia o zmianie) i
`deadline_update_published_at timestamptz` (jego publikacja), obie `NULL`, dopóki żadna
zmiana nie została zastosowana.

Ograniczenia:

- `opportunities_source_external_id_key` — indeks częściowy
  `UNIQUE (source_id, external_id) WHERE external_id IS NOT NULL`,
- `opportunities_fingerprint_key` — `UNIQUE (fingerprint)`,
- `opportunities_source_id_fkey` — `source_id → sources(id)`,
- `opportunities_estimated_value_check` — odrzuca też `NaN` i `±Infinity` (`numeric` je przyjmuje):
  `estimated_value IS NULL OR (estimated_value >= 0 AND estimated_value < 'Infinity')`,
- `opportunities_value_currency_check` — `(estimated_value IS NULL) = (currency IS NULL)`,
- `opportunities_currency_check` — `currency ~ '^[A-Z]{3}$'`,
- `opportunities_status_check` — `status IN ('open','closed','cancelled','unknown')`,
- `opportunities_location_check`, `opportunities_contact_check` — jsonb jest obiektem,
- `opportunities_deadline_update_check` — obie kolumny pochodzenia `NULL` albo obie ustawione,
  `opportunities_deadline_update_notice_check` — numer niepusty, najwyżej 200 znaków (0004),
- `opportunities_source_tender_id_idx` — indeks częściowy (nieunikalny, jedno postępowanie ma
  kilka ogłoszeń) `(source_id, tender_id) WHERE tender_id IS NOT NULL` (migracja 0003; pod
  wyszukiwanie pierwotnego ogłoszenia w PR-03B).

`location` i `contact` w kodzie mają jawne, ograniczone schematy (`src/domain/opportunity.ts`):
tylko pola wymienione wyżej (`contact`: `name`, `email`, `phone`, `raw`), limity długości, co
najmniej jedno pole — brak danych to `null`, nie pusty obiekt.

**Upsert (PR-01):** `INSERT … ON CONFLICT (fingerprint) DO UPDATE` w jednym poleceniu; update
nadpisuje pola merytoryczne, `fetched_at`, `content_hash`, `status`, `updated_at`, a nie
zmienia `id`, `first_seen_at` ani `source_id` (ten sam fingerprint z innego źródła →
`DomainError duplicate`). Wynik `inserted`/`updated` rozpoznawany po `xmax = 0`. Decyzja
„czy treść się zmieniła” (`unchanged`) należy do ingestion (PR-03).

**Fingerprint (PR-03A, D-016):** SHA-256 (hex) z `JSON.stringify([source_id, "external",
external_id])`, a gdy źródło nie podaje identyfikatora — z `[source_id, "url", source_url]`
(`source_url` jest już kanoniczny, §2). Tablica JSON zamiast sklejania z separatorem: części
nie mogą się „przesunąć”, a identyfikator nigdy nie zrówna się z URL-em o tym samym tekście.
Liczony z kandydata po walidacji. **Odłożone:** wariant dla źródeł bez stabilnego
identyfikatora i URL-a — `(source_id, issuer_name, title, published_at)` — powstanie razem z
pierwszym takim źródłem (żadne obecne go nie potrzebuje; D-016).

**`content_hash` (PR-03A, D-016):** SHA-256 (hex) z JSON-a par `[nazwa, wartość]` w stałej
kolejności pól: `issuerName`, `title`, `description`, `location`, `publishedAt`, `deadline`,
`estimatedValue`, `currency`, `categories`, `contact`, `status`, `sourceUrl`, `externalId`,
`tenderId`. Daty jako ISO 8601 (UTC), obiekty zagnieżdżone z posortowanymi kluczami, tablice w kolejności
źródła. `null`, `""` i brak pola dają różne hashe (brak = para pominięta). Nie obejmuje
`fetchedAt` (kiedy patrzyliśmy to nie treść) ani `sourceId` (jest w fingerprincie). Zmiana
listy pól lub kodowania zmienia hash każdego wiersza, ale `updated` dostaną tylko wiersze
pobrane ponownie. Codzienny cron pobiera tylko wczorajszy dzień, więc starsze wiersze nie są
ani oznaczane jako `updated`, ani uzupełniane, dopóki operator nie uruchomi
`ingest --date …` dla tych dni. To akceptowalne, ale wymaga wpisu w DECISIONS.

**Wykrywanie zmian (PR-03A, D-017):** `ingestOpportunity` = ten sam `INSERT … ON CONFLICT
(fingerprint) DO UPDATE`, ale z warunkiem `WHERE opportunities.source_id = excluded.source_id
AND opportunities.content_hash IS DISTINCT FROM excluded.content_hash … RETURNING (xmax = 0)`.
Zwrócony wiersz → `inserted`/`updated`; brak wiersza → `SELECT` po fingerprincie: to samo
źródło → `unchanged` (nic nie zapisano), inne źródło → `DomainError duplicate`. `unchanged`
**nie odświeża** `fetched_at` ani `updated_at`: brak zapisu = brak martwych krotek i WAL przy
codziennym ponownym pobieraniu tych samych ogłoszeń, a `updated_at` znaczy „treść się
zmieniła”. Równoległe zapisy tego samego fingerprintu dają jeden wiersz (`inserted` +
`unchanged`/`updated`); konflikt zgłoszony przez drugi indeks unikalny `(source_id,
external_id)` zamiast `fingerprint` jest ponawiany jeden raz (D-017). `status` wchodzi do
`content_hash`, więc ogłoszenie pobrane ponownie po terminie (`closed`) jest raz `updated`
(zamierzone). Kiedy rekord był ostatnio widziany, wynika z `ingestion_runs`; kolumna
`last_seen_at` powstanie dopiero, gdy coś będzie jej potrzebować (np. wygaszanie zniknięć).
`upsertOpportunity` (PR-01) działa bez zmian (zawsze nadpisuje). Deduplikacja między różnymi
źródłami — poza MVP.

**Termin ze zmiany (PR-03B, D-015):** `applyDeadlineUpdate` — jedno `UPDATE` starszego wiersza
`(source_id, tender_id)` (`published_at ASC NULLS LAST, first_seen_at ASC, id ASC`), tylko gdy
jego `(deadline_update_published_at, deadline_update_notice)` jest puste albo mniejsze niż w
zmianie; ustawia `deadline`, `status`, pochodzenie i `updated_at`, nie zmienia `fetched_at`,
`content_hash` ani `fingerprint`. Nic nie zapisano → odczyt rozróżnia `no_original`,
`unchanged` (ta sama zmiana) i `superseded` (nowsza już zapisana). Upserty (`ingestOpportunity`,
`upsertOpportunity`) przy wierszu z pochodzeniem zostawiają jego `deadline` i liczą `status` z
tego terminu i nowego `fetched_at` — ponowne pobranie oryginału nie cofa przedłużenia.

### `company_profiles` (= subskrypcja)

`id uuid` (PK, `gen_random_uuid()`), `email text` (`company_profiles_email_key` UNIQUE;
`company_profiles_email_check`: zapisany w postaci znormalizowanej `lower(btrim(email))`),
`name text`, `categories`, `include_keywords`, `exclude_keywords`, `voivodeships`, `counties`
(wszystkie `text[] NOT NULL DEFAULT '{}'`), `active bool` (domyślnie `true`), `created_at`,
`updated_at`. Wszystkie kolumny `NOT NULL`. Przy tworzeniu profilu kod wymaga podania
wszystkich pól (bez ukrytych wartości domyślnych). Jedna tabela zamiast osobnych encji
użytkownik/subskrypcja/filtr — wystarczy dla MVP (D-009).

### Migracje

Jawny SQL w `src/infrastructure/db/migrations.ts` (statyczny rekord, bez skanowania katalogu —
działa tak samo z `src/` i `dist/`), uruchamiany przez Migrator Kysely: komenda `migrate`,
wszystkie oczekujące migracje w jednej transakcji, blokada advisory lock, stan w tabelach
`kysely_migration`/`kysely_migration_lock` w bieżącym schemacie (`current_schema()`). Brak
migracji w dół. Zmieniamy schemat wyłącznie nową migracją.

### `ingestion_runs` (PR-03A, migracja `0002_ingestion_runs`)

Jeden wiersz na przebieg jednego źródła: `id uuid` (PK), `source_id` (FK →
`sources`, `ingestion_runs_source_id_fkey`), `publication_date date`, `max_records int`
(`> 0`), `started_at`/`finished_at timestamptz` (`finished_at >= started_at`), `status`
(`succeeded`/`incomplete`/`failed`), liczniki `documents`, `extracted`, `inserted`, `updated`,
`unchanged`, `rejected`, `skipped` (migracja `0004`, domyślnie 0) (`int >= 0`), `incomplete jsonb` (tablica `{part, reason}`, domyślnie
`[]`), `error_code text` (tylko kod `^[a-z][a-z0-9_]{0,63}$`, nigdy komunikat). Wszystko
`NOT NULL` poza `error_code`. Constrainty nazwane `ingestion_runs_*_check`; indeks
`ingestion_runs_source_started_idx (source_id, started_at DESC)` pod „ostatnie przebiegi
źródła”. Spójność „`failed` ⇔ jest `error_code`” pilnuje schemat domenowy
(`src/domain/ingestion-run.ts`) i sama baza (`ingestion_runs_error_code_status_check`). Migracja dodaje też źródło `bzp` (`INSERT … ON CONFLICT (id)
DO NOTHING` — istniejący wiersz, np. wyłączony przez operatora, zostaje bez zmian).

### Później

`deliveries` (PR-05). Żadnych tabel analitycznych w MVP.

## 6. Uruchamianie

- `node dist/main.js <command>` — jedna komenda = jeden krótki proces. CLI najpierw sprawdza
  komendę i argumenty (błąd → kod 2), dopiero potem ładuje konfigurację (błąd → kod 1), a na
  końcu otwiera bazę; pula jest zamykana przed zakończeniem komendy na każdej ścieżce.
- `source:preview <sourceId> [--date YYYY-MM-DD] [--limit N]` (PR-02) — jeden ograniczony
  przebieg źródła (domyślnie wczoraj według UTC i 20 rekordów na typ ogłoszenia, maks. 500;
  timeout przebiegu 5 min) przez nowy `SafeHttpClient`, wynik jako JSON na stdout (rekordy znormalizowane,
  liczniki, odrzucenia, `incomplete`), bez zapisu. Wymaga `CRAWLER_CONTACT` (brak → kod 1,
  zanim padnie jakiekolwiek żądanie). Nie otwiera bazy, ale `DATABASE_URL` jest walidowany jak
  przy każdej komendzie (wspólna konfiguracja). Adaptery i fabryka klienta HTTP są
  wstrzykiwane (`CliDeps.sources`), więc testy CLI działają bez sieci.
- Komendy bazodanowe: `health` (konfiguracja + `select 1` + brak oczekujących migracji — pole
  `schema`, ten sam test gotowości co `ingest`; kod 1, gdy któraś kontrola nie przejdzie),
  `migrate` (oczekujące migracje). Pula `pg`:
  max 5 połączeń, 5 s na połączenie, `statement_timeout` 30 s (+ timeout po stronie klienta
  35 s), bezczynne połączenia zamykane po 10 s — stałe w `src/infrastructure/db/database.ts`.
- Konfiguracja wyłącznie ze zmiennych środowiskowych; pusta wartość = wartość domyślna.
  Lokalnie skrypty `pnpm dev|health|start` dodają `--env-file-if-exists=.env` (Node), przy
  czym prawdziwe zmienne środowiskowe mają pierwszeństwo; bezpośrednie `node dist/main.js`
  (produkcja, cron) `.env` nie czyta — zmienne eksportuje środowisko.
- `ingest [sourceId...] [--date YYYY-MM-DD | --from YYYY-MM-DD --to YYYY-MM-DD] [--limit N]`
  (PR-03A, zakresy i nadrabianie PR-03B, D-021) — pobiera i zapisuje ogłoszenia z dnia
  publikacji (`--date`), z każdego dnia zakresu (`--from/--to`, najwyżej 31 dni) albo —
  domyślnie — z niepokrytych dni z 31 kończących się wczoraj według UTC (nadrabianie; źródło
  bez przebiegów: wczoraj) wybranych źródeł (domyślnie wszystkich włączonych w bazie), do N rekordów na typ ogłoszenia i dzień (domyślnie i maks. 1000),
  timeout 10 min na źródło i dzień (D-018, D-021). Kolejność kontroli: argumenty (kod 2) → konfiguracja (w
  tym `CRAWLER_CONTACT`, kod 1) → baza. Nie migruje sama (oczekujące migracje → kod 1). Wynik:
  JSON na stdout (`status`, `mode` = `date`/`range`/`catch_up`, `from`, `to`, `limit`,
  przebiegi z `publicationDate`, licznikami, `skippedReasons`, `runId`, `errorCode`, `notRun`,
  `clipped`) +
  linia logu na przebieg. Kod 0, gdy każde źródło `succeeded` lub `incomplete`, a także gdy blokada jest
  zajęta (`status: "skipped"`, nic nie uruchomiono); 1, gdy któreś `failed`, podsumowania nie
  zapisano, blokada została utracona w trakcie (`lock_lost`) albo baza niedostępna; 2 — błąd
  użycia (także źródło niewłączone w bazie).
- **Blokada ingest (D-019):** `pg_try_advisory_lock(7206120309001)` na sesji jednego,
  dedykowanego połączenia z puli (`db.connection().execute`), zwalniana w `finally`
  (`pg_advisory_unlock`); zerwane połączenie zwalnia ją samo. Zajęta → stdout
  `{"status":"skipped","reason":"lock_busy",…,"runs":[],"notRun":[],"clipped":[]}`, komunikat „Ingest skipped: …” na
  stderr, log `ingest lock busy` (warn), kod 0, bez pobierania i bez wiersza w
  `ingestion_runs`. Połączenie z blokadą jest sprawdzane co 5 s;
  utrata → przerwanie przebiegu (`lock_lost`, log `ingest lock lost`, komunikat
  „Ingest aborted: …”, kod 1). Nieudane zwolnienie jest tylko logowane (`ingest lock release
failed`) — wynik zostaje, a blokada znika z końcem sesji. Każde połączenie puli ma listener
  `error` i TCP keepalive, więc zerwane połączenie nie zabija procesu. Klucz (`INGEST_LOCK_KEY` w
  `src/ingestion/lock.ts`) jest wspólny dla całej bazy (advisory locki nie znają schematów),
  inny niż blokada Migratora Kysely; nowy klucz dla innej komendy = nowa stała tutaj.
- Planowany harmonogram (przykład w README; ten PR nie dodaje artefaktu cron/wdrożenia):
  `ingest` raz dziennie ok. 06:00 Europe/Warsaw bez opcji dnia (nadrabianie: zwykle tylko
  wczoraj UTC, dzień już zamknięty; po przerwie — pominięte dni); `digest` (PR-05) — rano, po `ingest`.

## 7. Obserwowalność

JSON-lines na stderr (`infrastructure/logger.ts`), stdout zarezerwowany na wynik komendy.
Serializacja pól nie rzuca (`Error` → `{name, message}`, `bigint` → string, cykle →
`"[Circular]"`); logger nie redaguje pól (`docs/SECURITY.md` §12).
Błędy bazy w CLI (`health`, `migrate`, `ingest`) są raportowane jako stały powód + kod SQLSTATE/errno,
nigdy jako komunikat sterownika/serwera.
Każdy wpis `SafeHttpClient` zawiera `sourceId` i host (PR-02); `source:preview` loguje
koniec przebiegu (`sourceId`, `status`, `durationMs`, liczniki, `incomplete`), każde
odrzucenie (`sourceId`, `externalId`, powód) i przerwane listingi. `ingest` (PR-03A) loguje: koniec przebiegu źródła
(`source ingestion finished`: `sourceId`, `runId`, `status`, `durationMs`, liczniki,
`incomplete`, `errorCode`), błąd źródła (`sourceId`, `errorCode`, `httpStatus`), odrzucenia
(`sourceId`, `externalId`, powód albo `errorCode` + `constraint`), pominięte zmiany ogłoszeń
(`notice update skipped`: `sourceId`, `externalId`, `tenderId`, stały powód), plan dni
(`nothing to catch up`, `catch-up clipped, older missing days not run`, `days not run after
consecutive failed days`), niezapisane podsumowanie
(`sourceId`, `errorCode` = SQLSTATE), zajętą, utraconą i niezwolnioną blokadę (`lockKey`,
`errorCode`) oraz pominięte po przerwaniu źródła (`sourceIds`) — bez treści
dokumentów, tytułów, danych kontaktowych i adresu bazy. Podsumowanie każdego przebiegu jest w
`ingestion_runs`. Alerting/deployment: PR-07.
