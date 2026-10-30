# Architektura — Radar Zamówień

> **Stan:** po PR-01 istnieją: szkielet CLI (`src/cli.ts`, `src/main.ts`, `src/health.ts`,
> `src/infrastructure/config.ts`, `src/infrastructure/logger.ts`), model domenowy
> (`src/domain/`) oraz warstwa bazy danych (`src/infrastructure/db/`: pula, migracje,
> repozytoria; komendy `health` z kontrolą bazy i `migrate`). PR-02 (część A) dodał
> `SafeHttpClient` (`src/infrastructure/http/`) — bez adapterów i wywołań produkcyjnych do
> czasu wyboru źródła (część B). Wszystko poniżej oznaczone
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
├── health.ts               # raport health (+ połączenie z bazą)                   [PR-00/01]
├── infrastructure/
│   ├── config.ts           # walidacja env (zod)                                    [PR-00]
│   ├── logger.ts           # JSON-lines logger na stderr                            [PR-00]
│   ├── db/                 # pula pg + Kysely, migracje, repozytoria, mapowanie błędów [PR-01]
│   └── http/               # SafeHttpClient: polityka URL/IP, retry, limity      [PR-02]
├── domain/                 # typy + schematy zod: Source, Opportunity, CompanyProfile [PR-01]
├── sources/                # adaptery źródeł, po jednym pliku/katalogu na źródło(plan, PR-02)
├── ingestion/              # normalizacja wspólna, fingerprint, dedup, job     (plan, PR-03)
├── matching/               # scoring + wyjaśnienie                             (plan, PR-04)
├── notifications/          # digest, szablon, wysyłka, idempotencja            (plan, PR-05)
└── web/                    # minimalny UI renderowany po stronie serwera       (plan, PR-06)
tests/
├── *.test.ts               # unit / smoke                                           [PR-00]
├── fixtures/<source>/      # zapisane, zanonimizowane odpowiedzi źródeł        (plan, PR-02)
└── integration/            # testy z prawdziwym PostgreSQL (TEST_DATABASE_URL)      [PR-01]
```

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
  (create/get/update/delete).

## 3. Przepływ danych (pierwszy vertical slice)

```
PUBLIC SOURCE → SOURCE ADAPTER → RAW DOCUMENT → NORMALIZER → OPPORTUNITY
  → DEDUPLICATION → MATCHING → USER SUBSCRIPTION (profil) → EMAIL DIGEST / ALERT
```

| Krok         | Moduł                                                  | Wejście → wyjście                                          | PR    |
| ------------ | ------------------------------------------------------ | ---------------------------------------------------------- | ----- |
| Pobranie     | `sources/<id>` + `infrastructure/http`                 | konfiguracja źródła → `RawDocument[]`                      | 02    |
| Ekstrakcja   | `sources/<id>`                                         | `RawDocument` → `ExtractedNotice[]` (pola surowe, stringi) | 02    |
| Normalizacja | `sources/<id>` + wspólne helpery `ingestion/normalize` | `ExtractedNotice` → `OpportunityDraft`                     | 02/03 |
| Deduplikacja | `ingestion`                                            | `OpportunityDraft` → insert / update / skip                | 03    |
| Dopasowanie  | `matching`                                             | `Opportunity` × `CompanyProfile` → `MatchResult`           | 04    |
| Alert        | `notifications`                                        | dopasowania profilu → jeden digest, idempotentnie          | 05    |

## 4. Kontrakty modułów _(plan — doprecyzowanie w odpowiednich PR)_

### 4.1 Adapter źródła (PR-02)

```ts
interface SourceAdapter {
  readonly sourceId: string; // stabilny identyfikator, np. "baza-konkurencyjnosci"
  readonly allowedHosts: readonly string[]; // jedyne hosty, z którymi adapter może się łączyć
  fetch(ctx: FetchContext): Promise<RawDocument[]>; // tylko przez ctx.http (SafeHttpClient)
  extract(doc: RawDocument): ExtractedNotice[]; // czyste, deterministyczne; bez I/O
  normalize(notice: ExtractedNotice): NormalizeResult; // czyste; OpportunityDraft | odrzucenie z powodem
}
```

Adapter **nie zawiera**: logiki dopasowania, wysyłki e-maili, UI, billingu, dostępu do bazy.
`extract`/`normalize` są czyste, więc testujemy je na fixture'ach bez sieci.
`RawDocument` = `{ sourceId, url, fetchedAt, contentType, body }` — w MVP tylko w pamięci
(D-008).

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

### 4.3 Ingestion (PR-03)

```ts
type IngestOutcome = "inserted" | "updated" | "unchanged" | "rejected";
runIngestion(deps, sourceIds?): Promise<IngestionRunSummary>;
```

Jeden przebieg na źródło, sekwencyjnie. Błąd jednego źródła nie przerywa pozostałych.
Każdy przebieg zapisany w `ingestion_runs` (licznik nowych/zmienionych/odrzuconych, błąd).

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

Stan zgodny z migracją `0001_core_schema` (`src/infrastructure/db/migrations.ts`) — źródłem
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

| Kolumna           | Typ               | Null | Uwagi                                                                    |
| ----------------- | ----------------- | ---- | ------------------------------------------------------------------------ |
| `id`              | uuid              | nie  | PK, `gen_random_uuid()`                                                  |
| `source_id`       | text FK → sources | nie  |                                                                          |
| `source_url`      | text              | nie  | link do oryginału; kanoniczny `href` (http/https)                        |
| `external_id`     | text              | tak  | identyfikator nadany przez źródło                                        |
| `issuer_name`     | text              | nie  | zamawiający                                                              |
| `title`           | text              | nie  |                                                                          |
| `description`     | text              | tak  | skrócony, tekst bez HTML                                                 |
| `location`        | jsonb             | tak  | `{ voivodeship?, county?, city?, raw? }` — tylko to, co wynika ze źródła |
| `published_at`    | timestamptz       | tak  |                                                                          |
| `deadline`        | timestamptz       | tak  | termin składania ofert                                                   |
| `estimated_value` | numeric           | tak  | **tylko jeśli podana**; nigdy domyślne 0; w kodzie string dziesiętny     |
| `currency`        | char(3)           | tak  | wymagana, gdy `estimated_value` nie jest null                            |
| `categories`      | text[]            | nie  | może być pusta tablica (domyślnie `'{}'`)                                |
| `contact`         | jsonb             | tak  | tylko dane kontaktowe opublikowane przy zamówieniu                       |
| `fetched_at`      | timestamptz       | nie  | ostatnie pobranie (z draftu)                                             |
| `first_seen_at`   | timestamptz       | nie  | `now()` przy pierwszym zapisie; upsert go nie zmienia                    |
| `updated_at`      | timestamptz       | nie  | `now()` przy każdym zapisie (insert i update)                            |
| `fingerprint`     | text              | nie  | klucz deduplikacji (patrz niżej)                                         |
| `content_hash`    | text              | nie  | wykrywanie zmian treści                                                  |
| `status`          | text + CHECK      | nie  | `open` / `closed` / `cancelled` / `unknown`; bez wartości domyślnej      |

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
- `opportunities_location_check`, `opportunities_contact_check` — jsonb jest obiektem.

`location` i `contact` w kodzie mają jawne, ograniczone schematy (`src/domain/opportunity.ts`):
tylko pola wymienione wyżej (`contact`: `name`, `email`, `phone`, `raw`), limity długości, co
najmniej jedno pole — brak danych to `null`, nie pusty obiekt.

**Upsert (PR-01):** `INSERT … ON CONFLICT (fingerprint) DO UPDATE` w jednym poleceniu; update
nadpisuje pola merytoryczne, `fetched_at`, `content_hash`, `status`, `updated_at`, a nie
zmienia `id`, `first_seen_at` ani `source_id` (ten sam fingerprint z innego źródła →
`DomainError duplicate`). Wynik `inserted`/`updated` rozpoznawany po `xmax = 0`. Decyzja
„czy treść się zmieniła” (`unchanged`) należy do ingestion (PR-03).

**Fingerprint (PR-03):** jeśli istnieje `external_id` — hash `(source_id, external_id)`;
w przeciwnym razie hash znormalizowanych `(source_id, source_url)`, a gdy URL nie jest
stabilny — `(source_id, issuer_name, title, published_at)`. `content_hash` = hash pól
merytorycznych; zmiana → `updated`. Deduplikacja między różnymi źródłami — poza MVP.

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

### Później

`ingestion_runs` (PR-03), `deliveries` (PR-05). Żadnych tabel analitycznych w MVP.

## 6. Uruchamianie

- `node dist/main.js <command>` — jedna komenda = jeden krótki proces. CLI najpierw sprawdza
  komendę i argumenty (błąd → kod 2), dopiero potem ładuje konfigurację (błąd → kod 1), a na
  końcu otwiera bazę; pula jest zamykana przed zakończeniem komendy na każdej ścieżce.
- Komendy: `health` (konfiguracja + `select 1`), `migrate` (oczekujące migracje). Pula `pg`:
  max 5 połączeń, 5 s na połączenie, `statement_timeout` 30 s (+ timeout po stronie klienta
  35 s), bezczynne połączenia zamykane po 10 s — stałe w `src/infrastructure/db/database.ts`.
- Konfiguracja wyłącznie ze zmiennych środowiskowych; pusta wartość = wartość domyślna.
  Lokalnie skrypty `pnpm dev|health|start` dodają `--env-file-if-exists=.env` (Node), przy
  czym prawdziwe zmienne środowiskowe mają pierwszeństwo; bezpośrednie `node dist/main.js`
  (produkcja, cron) `.env` nie czyta — zmienne eksportuje środowisko.
- Cron (PR-03/05): np. `ingest` co 2–4 h, `digest` raz dziennie rano.
- Nakładające się uruchomienia tej samej komendy blokowane przez PostgreSQL advisory lock
  (PR-03) — bez zewnętrznego lockera.

## 7. Obserwowalność

JSON-lines na stderr (`infrastructure/logger.ts`), stdout zarezerwowany na wynik komendy.
Serializacja pól nie rzuca (`Error` → `{name, message}`, `bigint` → string, cykle →
`"[Circular]"`); logger nie redaguje pól (`docs/SECURITY.md` §12).
Błędy bazy w CLI (`health`, `migrate`) są raportowane jako stały powód + kod SQLSTATE/errno,
nigdy jako komunikat sterownika/serwera.
Każdy wpis `SafeHttpClient` zawiera `sourceId` i host (PR-02); _(plan, PR-03)_ podsumowanie
przebiegu w `ingestion_runs`. Alerting/deployment: PR-07.
