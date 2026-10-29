# Architektura — Radar Zamówień

> **Stan:** po PR-00 istnieje tylko szkielet (`src/cli.ts`, `src/main.ts`, `src/health.ts`,
> `src/infrastructure/config.ts`, `src/infrastructure/logger.ts`). Wszystko poniżej oznaczone
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
├── cli.ts                  # routing komend; testowalny bez procesu                [PR-00]
├── health.ts               # raport health                                         [PR-00]
├── infrastructure/
│   ├── config.ts           # walidacja env (zod)                                    [PR-00]
│   ├── logger.ts           # JSON-lines logger na stderr                            [PR-00]
│   ├── db/                 # pula pg, migracje, repozytoria                    (plan, PR-01)
│   └── http/               # SafeHttpClient                                    (plan, PR-02)
├── domain/                 # typy i czyste reguły: Source, Opportunity, Profile (plan, PR-01)
├── sources/                # adaptery źródeł, po jednym pliku/katalogu na źródło(plan, PR-02)
├── ingestion/              # normalizacja wspólna, fingerprint, dedup, job     (plan, PR-03)
├── matching/               # scoring + wyjaśnienie                             (plan, PR-04)
├── notifications/          # digest, szablon, wysyłka, idempotencja            (plan, PR-05)
└── web/                    # minimalny UI renderowany po stronie serwera       (plan, PR-06)
tests/
├── *.test.ts               # unit / smoke
├── fixtures/<source>/      # zapisane, zanonimizowane odpowiedzi źródeł        (plan, PR-02)
└── integration/            # testy z prawdziwym PostgreSQL                     (plan, PR-01+)
```

Zasada zależności: `domain` nie importuje niczego z innych modułów. `sources` zależy od
`domain` i `infrastructure/http`. `matching` zależy tylko od `domain` (czyste funkcje).
`ingestion` i `notifications` orkiestrują i jako jedyne dotykają repozytoriów. `cli`/`web`
składają zależności (proste wstrzykiwanie przez parametry, bez kontenera DI).

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

### 4.2 SafeHttpClient (PR-02)

Jedyna droga do sieci dla adapterów. Wymusza: allowlistę hostów adaptera, tylko `https:`
(i `http:` tylko jeśli źródło nie ma HTTPS — wpis w DECISIONS), blokadę adresów prywatnych/
loopback/link-local po rozwiązaniu DNS, ręczną obsługę przekierowań z ponowną walidacją
(max 3), timeout, limit rozmiaru odpowiedzi (strumieniowo), rate limit per host, retry tylko
dla błędów przejściowych (max 2, backoff z jitterem, respektuje `Retry-After`), stały
User-Agent z kontaktem, logowanie `sourceId`/host/status/czas. Szczegóły: `docs/SECURITY.md`.

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

## 5. Model danych _(plan, PR-01 — ostateczny kształt w migracjach)_

### `sources`

`id text PK` (np. `baza-konkurencyjnosci`), `name`, `base_url`, `enabled bool`,
`created_at`.

### `opportunities`

| Kolumna           | Typ               | Null | Uwagi                                                                    |
| ----------------- | ----------------- | ---- | ------------------------------------------------------------------------ |
| `id`              | uuid              | nie  | PK                                                                       |
| `source_id`       | text FK → sources | nie  |                                                                          |
| `source_url`      | text              | nie  | link do oryginału                                                        |
| `external_id`     | text              | tak  | identyfikator nadany przez źródło                                        |
| `issuer_name`     | text              | nie  | zamawiający                                                              |
| `title`           | text              | nie  |                                                                          |
| `description`     | text              | tak  | skrócony, tekst bez HTML                                                 |
| `location`        | jsonb             | tak  | `{ voivodeship?, county?, city?, raw? }` — tylko to, co wynika ze źródła |
| `published_at`    | timestamptz       | tak  |                                                                          |
| `deadline`        | timestamptz       | tak  | termin składania ofert                                                   |
| `estimated_value` | numeric           | tak  | **tylko jeśli podana**; nigdy domyślne 0                                 |
| `currency`        | char(3)           | tak  | wymagana, gdy `estimated_value` nie jest null                            |
| `categories`      | text[]            | nie  | może być pusta tablica                                                   |
| `contact`         | jsonb             | tak  | tylko dane kontaktowe opublikowane przy zamówieniu                       |
| `fetched_at`      | timestamptz       | nie  | ostatnie pobranie                                                        |
| `first_seen_at`   | timestamptz       | nie  |                                                                          |
| `fingerprint`     | text              | nie  | klucz deduplikacji (patrz niżej)                                         |
| `content_hash`    | text              | nie  | wykrywanie zmian treści                                                  |
| `status`          | enum              | nie  | `open` / `closed` / `cancelled` / `unknown`                              |

Ograniczenia: `UNIQUE (source_id, external_id) WHERE external_id IS NOT NULL`,
`UNIQUE (fingerprint)`, `CHECK (estimated_value IS NULL OR estimated_value >= 0)`,
`CHECK ((estimated_value IS NULL) = (currency IS NULL))`.

**Fingerprint (PR-03):** jeśli istnieje `external_id` — hash `(source_id, external_id)`;
w przeciwnym razie hash znormalizowanych `(source_id, source_url)`, a gdy URL nie jest
stabilny — `(source_id, issuer_name, title, published_at)`. `content_hash` = hash pól
merytorycznych; zmiana → `updated`. Deduplikacja między różnymi źródłami — poza MVP.

### `company_profiles` (= subskrypcja)

`id uuid`, `email` (unikalny), `name`, `categories text[]`, `include_keywords text[]`,
`exclude_keywords text[]`, `voivodeships text[]`, `counties text[]`, `active bool`,
`created_at`, `updated_at`. Jedna tabela zamiast osobnych encji użytkownik/subskrypcja/
filtr — wystarczy dla MVP (D-009).

### Później

`ingestion_runs` (PR-03), `deliveries` (PR-05). Żadnych tabel analitycznych w MVP.

## 6. Uruchamianie

- `node dist/main.js <command>` — jedna komenda = jeden krótki proces. CLI najpierw sprawdza
  komendę i argumenty (błąd → kod 2), dopiero potem ładuje konfigurację (błąd → kod 1).
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
Każdy wpis związany z pobieraniem zawiera `sourceId`. Podsumowanie przebiegu w
`ingestion_runs`. Alerting/deployment: PR-07.
