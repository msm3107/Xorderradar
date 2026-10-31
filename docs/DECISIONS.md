# Decisions — Radar Zamówień

Rejestr decyzji architektonicznych. Każda decyzja: kontekst, decyzja, konsekwencje, status.
Statusy: **Accepted** (obowiązuje), **Proposed** (kierunek; ostatecznie w wskazanym PR),
**Superseded** (zastąpiona — link do nowej).

---

## D-001 — Modularny monolit: TypeScript + Node.js + PostgreSQL + cron

- **Status:** Accepted (PR-00)
- **Kontekst:** 10–100 klientów, dziesiątki źródeł, przetwarzanie wsadowe kilka razy dziennie.
- **Decyzja:** jedna aplikacja TypeScript na Node.js 22 LTS; jeden PostgreSQL; komendy CLI
  (`health`, później `ingest`, `digest`) uruchamiane przez systemowy cron. Bez mikroserwisów,
  kolejek, Redis, Kafki, Kubernetesa, ElasticSearch, CQRS, event sourcingu.
- **Konsekwencje:** minimum operacji i kosztów; skalowanie pionowe wystarczy na długo.
  Pełnotekstowe wyszukiwanie, jeśli kiedyś potrzebne — najpierw PostgreSQL FTS.

## D-002 — pnpm 10 zamiast npm

- **Status:** Accepted (PR-00)
- **Kontekst:** npm 10.9.4 dołączony do Node 22.22 kończy `npm install` błędem
  `Cannot read properties of null (reading 'edgesOut')` przy rozwiązywaniu peer-dependencies
  Vitest 4/5 (zreprodukowane na czystym katalogu; npm 11 i pnpm instalują poprawnie).
  Vitest < 4.1.11 ma podatności (GHSA-82fw-gwwq-j7x9, GHSA-qxg6-89mg-rqv8; tinypool
  GHSA-5gmw-xhrv-c9v3), więc cofnięcie się do Vitest 3 nie wchodzi w grę.
- **Decyzja:** pnpm `10.28.0` przypięty w `packageManager` (dostępny przez `corepack enable`).
  Lockfile `pnpm-lock.yaml` w repo.
- **Konsekwencje:** deterministyczne instalacje; skrypty instalacyjne zależności domyślnie
  zablokowane (esbuild jawnie na `ignoredBuiltDependencies` — działa przez binarkę z
  optionalDependencies, tsx/testy przechodzą). Wymaga corepack/pnpm u kontrybutorów.

## D-003 — TypeScript 6.0, nie 7.x

- **Status:** Accepted (PR-00)
- **Kontekst:** `typescript-eslint` 8.71 wspiera `typescript >=4.8.4 <6.1.0`.
- **Decyzja:** TypeScript `6.0.3`, `strict` + `noUncheckedIndexedAccess` +
  `exactOptionalPropertyTypes` + `verbatimModuleSyntax`, moduły `NodeNext` (ESM).
- **Konsekwencje:** pełne lintowanie z informacją o typach. Migrację na TS 7 rozważyć, gdy
  typescript-eslint ją oficjalnie wspiera.

## D-004 — Narzędzia: ESLint 10 (strictTypeChecked), Prettier, Vitest, tsx

- **Status:** Accepted (PR-00)
- **Decyzja:** ESLint `10.12.0` + `typescript-eslint` `strictTypeChecked` +
  `eslint-config-prettier`; Prettier `3.9.10`; Vitest `5.0.4`; `tsx` do uruchamiania
  źródeł w dev i smoke teście; `tsc` do builda produkcyjnego (`dist/`). Wersje przypięte
  dokładnie, opublikowane ≥ 2 tygodnie przed decyzją.
- **Konsekwencje:** `pnpm check` = jedna komenda weryfikacji lokalnie i w przyszłym CI (PR-07).

## D-005 — zod do walidacji danych w runtime

- **Status:** Accepted (PR-00)
- **Kontekst:** każda granica zaufania (env, odpowiedzi źródeł, formularze) wymaga walidacji
  w runtime; typy statyczne tego nie zapewniają.
- **Decyzja:** zod `4.6.7` (wersje < 4.6.6 mają GHSA-mrhx-c7xc-m3w5).
- **Konsekwencje:** jedna biblioteka schematów w całym projekcie.

## D-006 — CLI zamiast serwera HTTP w PR-00; framework web dopiero w PR-06

- **Status:** Accepted (PR-00)
- **Kontekst:** rdzeń produktu to praca wsadowa (cron). UI jest potrzebne dopiero w fazie 3.
- **Decyzja:** PR-00 dostarcza CLI (`health`). Wybór frameworka web (kierunek: lekki serwer
  HTTP z renderowaniem po stronie serwera; Next.js tylko jeśli realnie uprości PR-06)
  zapada w PR-06.
- **Konsekwencje:** brak nieużywanych zależności i otwartych portów do PR-06.

## D-007 — Dostęp do bazy i migracje: Kysely + pg

- **Status:** Accepted (PR-01)
- **Kryteria:** jawny SQL w migracjach, obsługa częściowych indeksów unikalnych, CHECK,
  `jsonb`, `text[]`, brak magii runtime, aktywne utrzymanie, brak znanych podatności.
- **Decyzja:** Kysely `0.29.6` (query builder) + sterownik `pg` `8.23.1` (+ dev
  `@types/pg` `8.23.1`), wersje przypięte dokładnie. PostgreSQL 16.
  - Kysely nie ma zależności runtime; typowany query builder parametryzuje wartości z
    konstrukcji (SQL injection wymagałby jawnego `sql.raw`, którego nie używamy).
  - Wbudowany `Migrator`: blokada (advisory lock) przeciw równoległym uruchomieniom i
    transakcyjny DDL na PostgreSQL. Migracje to jawny SQL w szablonie `sql` (indeks
    częściowy, CHECK, `jsonb`, `text[]` zapisane wprost), podawane statycznym providerem
    (bez skanowania katalogu, więc działa z `dist/`). Brak kroku codegen — typy tabel
    (`src/infrastructure/db/schema.ts`) utrzymywane ręcznie, rozjazd łapią testy integracyjne.
- **Odrzucone:** Drizzle ORM + drizzle-kit — na razie: przejście 0.45 → 1.0-rc (zmiany API),
  a drizzle-kit to osobne narzędzie generujące migracje. Sam `pg` + własny migrator — typowane
  zapytania zmniejszają ryzyko błędów w repozytoriach rozwijanych w kolejnych PR-ach, kosztem
  jednej biblioteki bez zależności. Kysely `0.29.7` pominięta: opublikowana 2026-10-17, < 2
  tygodnie przed decyzją (`docs/SECURITY.md` §13).
- **Konsekwencje:** zależności tranzytywne tylko od `pg` (`pg-pool`, `pg-protocol`,
  `pg-types`, `pg-connection-string`, `pgpass` …); `pnpm audit` czysty w chwili decyzji.
  Migrator przy starcie listuje tabele we wszystkich widocznych schematach, zanim weźmie
  blokadę — dlatego testy usuwają swoje schematy dopiero po całym przebiegu
  (`tests/integration/global-setup.ts`).

## D-008 — RawDocument tylko w pamięci w MVP

- **Status:** Proposed (PR-02/PR-03)
- **Decyzja:** surowe odpowiedzi źródeł nie są trwale zapisywane w bazie; do testów służą
  fixture'y. Zapisujemy znormalizowane `opportunities` + `content_hash`.
- **Konsekwencje:** mniej danych (w tym osobowych) i mniejsza baza; ponowne parsowanie
  historii wymaga ponownego pobrania. Do rewizji, jeśli debugowanie parserów w pilocie
  okaże się zbyt trudne.

## D-009 — Profil firmy = subskrypcja (jedna tabela)

- **Status:** Accepted (PR-01)
- **Decyzja:** `company_profiles` łączy odbiorcę (e-mail) i preferencje dopasowania. Bez
  osobnych tabel użytkowników, organizacji, filtrów.
- **Konsekwencje:** prosty model dla MVP; wiele osób na firmę / wiele profili na konto —
  dopiero, gdy pilot to uzasadni.

## D-010 — E-mail jako jedyny kanał; provider przez SMTP

- **Status:** Proposed → decyzja w PR-05
- **Decyzja:** wysyłka przez SMTP (niezależnie od dostawcy), domyślny tryb `test` bez
  prawdziwej wysyłki.

## D-011 — Matching regułowy, bez LLM

- **Status:** Accepted (PR-00, realizacja PR-04)
- **Decyzja:** deterministyczny scoring na kategoriach, słowach kluczowych, wykluczeniach i
  regionie, z listą powodów. LLM ewentualnie później jako warstwa pomocnicza (faza 5).

## D-012 — Agenci jako projektowe subagenty Claude Code

- **Status:** Accepted (PR-00)
- **Kontekst:** Claude Code 2.1.312 obsługuje definicje subagentów w `.claude/agents/*.md`
  (frontmatter: `name`, `description`, `tools`, `model`).
- **Decyzja:** dokładnie trzy pliki: `coder.md`, `code-and-safety-reviewer.md`,
  `quality-reviewer.md`. Reviewerzy bez Edit/Write (Read, Grep, Glob, Bash).
- **Konsekwencje:** definicje ładują się przy starcie sesji. W sesji PR-00, w której pliki
  powstały, reviewerzy zostali uruchomieni jako osobne subagenty z treścią tych definicji
  (patrz `docs/STATE.md`).
- **Ograniczenia (egzekwowanie):** read-only reviewerów i limit „dokładnie 3 agentów” są
  egzekwowane **instrukcjami i procesem, nie technicznie**. Brak Edit/Write nie czyni
  reviewera read-only — `Bash` pozwala zapisywać pliki; nic też nie blokuje dodania czwartej
  definicji w `.claude/agents/`. Kontrola wykrywająca: koordynator zapisuje odcisk drzewa
  roboczego przed i po każdym uruchomieniu reviewera, a każdą zmianę traktuje jako nieudane
  review (`docs/AGENTS.md` → „Kontrola read-only reviewerów”); nowe pliki w `.claude/agents/`
  są widoczne w diffie PR i sprawdzane w review.

## D-013 — Język dokumentacji

- **Status:** Accepted (PR-00)
- **Decyzja:** dokumentacja produktowa i procesowa po polsku; kod, identyfikatory,
  komunikaty CLI, `CLAUDE.md`, `docs/STATE.md` i definicje agentów po angielsku (stabilne
  dla narzędzi).
  Treści dla użytkownika końcowego (e-mail, UI) po polsku.

## D-014 — SafeHttpClient na `node:https` z przypiętym adresem, bez biblioteki HTTP

- **Status:** Accepted (PR-02, część A)
- **Kontekst:** ochrona SSRF wymaga, by połączenie trafiło dokładnie na adres sprawdzony po
  rozwiązaniu DNS (bez okna na DNS rebinding), a redirecty, limit rozmiaru i dekompresja muszą
  być pod naszą kontrolą. Wbudowany `fetch` (undici) nie pozwala podać zweryfikowanego adresu
  bez dodatkowej zależności (`undici` `Agent` z `connect.lookup`) i sam dekompresuje treść.
- **Decyzja:**
  - transport: `node:https` z `agent: false` (nowe połączenie na żądanie) i własną funkcją
    `lookup`, która zwraca wcześniej zweryfikowany adres; nazwa hosta zostaje dla SNI,
    certyfikatu i `Host`. Brak nowej zależności;
  - DNS: `dns.promises.lookup(host, { all: true, verbatim: true })` (resolver systemowy, ten
    sam, którego użyłby system; `verbatim` zachowuje kolejność odpowiedzi resolvera zamiast
    przestawiać IPv4 na początek — wybór adresu robimy sami); odrzucamy host, jeśli **którykolwiek** adres jest zablokowany; łączymy się
    z pierwszym IPv4 (a bez IPv4 — z pierwszym IPv6). Zakresy przez `net.BlockList`; IPv6
    jako allowlista `2000::/3` minus zakresy specjalne (ostrzej niż lista zakazów);
  - dekompresja: wysyłamy `Accept-Encoding: gzip, deflate, br` (mniej transferu dla źródeł;
    `deflate` rozpoznaje po nagłówku zlib, a bez niego rozpakowuje surowy DEFLATE, który
    wysyłają niektóre serwery);
    treść jest najpierw czytana strumieniowo z limitem 5 MB, potem rozpakowywana synchronicznie
    `zlib.*Sync` z `maxOutputLength` = 5 MB. Prostsze niż strumień dekompresji, a tak samo
    odporne na zip bomb (rozpakowanie przerywane po przekroczeniu limitu). Koszt: krótka
    blokada pętli zdarzeń przy ≤ 5 MB — bez znaczenia dla krótkich komend CLI;
  - seamy testowe (`SafeHttpClientDeps`) jako drugi argument konstruktora zamiast osobnej
    fabryki: kod w `src/` nie może go przekazać (reguła ESLint `no-restricted-syntax` z
    testem), reszta po stronie review;
  - kontakt w User-Agent z nowej zmiennej `CRAWLER_CONTACT` (opcjonalnej w `loadConfig`, by
    `health`/`migrate` działały bez niej; wymaganej przez konstruktor klienta).
- **Konsekwencje:** brak obsługi proxy HTTP(S) ze zmiennych środowiskowych (połączenia
  bezpośrednie); brak „happy eyeballs” — jeśli wybrany adres jest nieosiągalny, próba kończy się
  błędem sieci (retry z tym samym adresem po ponownym DNS). Jeśli źródło będzie wymagało
  któregoś z tych mechanizmów, decyzję trzeba zrewidować.
- **Node `engines` ≥ 22.19:** minimum wynika wyłącznie z `tls.setDefaultCACertificates`
  w `tests/http-transport.test.ts` (testy na prawdziwym TLS); kod produkcyjny w `src/` działałby
  na 22.13. Zostawiamy, bo 22.19+ to bieżąca wersja w linii 22 LTS, a alternatywą byłby proces
  potomny z `NODE_EXTRA_CA_CERTS`. Do rewizji, jeśli host produkcyjny zostanie przypięty do
  wersji poniżej 22.19.

## D-015 — Pierwsze źródło: BZP przez oficjalne „API BZP (WebService)” platformy e-Zamówienia

- **Status:** Accepted (PR-02, część B)
- **Kontekst:** krok 0 PR-02 — wybór jednego publicznego źródła małych zamówień (regulamin,
  `robots.txt`, API/feed, licencja, częstotliwość, pokrycie małych zamówień). Badanie wykonane
  2026-10-30 zapytaniami przez proxy kontenera (curl); SafeHttpClient nie był używany, bo
  ignoruje proxy (D-014).
- **Decyzja:** pierwszym źródłem jest **Biuletyn Zamówień Publicznych (BZP)** czytany przez
  oficjalną usługę „API BZP (WebService)” platformy e-Zamówienia; adapter `bzp`
  (`src/sources/bzp/`), allowlista `["ezamowienia.gov.pl"]`, wyłącznie `https`.
  - **Podstawa korzystania:** Regulamin platformy e-Zamówienia §11
    (https://ezamowienia.gov.pl/pl/regulamin/): „Korzystanie z usługi jest bezpłatne. Usługa
    udostępnia metody pozwalające na dostęp do danych z publikowanych ogłoszeń… a. Odczyt
    danych opublikowanych ogłoszeń według zadanych kryteriów, b. Odczyt ilości…” oraz „Usługa
    dostępna jest pod adresem: http://ezamowienia.gov.pl/mo-board/api/v1/notice” (działa też
    przez `https`; używamy tylko `https`). Regulamin nie ogranicza odczytu przez WebService.
  - **`robots.txt`** (`https://ezamowienia.gov.pl/robots.txt`): 200 `text/plain`, treść to
    2 bajty `as` — brak obowiązujących reguł (nic nie jest zabronione). Nie sprawdzamy go w
    runtime; operator sprawdza `robots.txt` i regulamin ponownie przy przeglądzie źródła
    (przed włączeniem crona i przy każdej zmianie adaptera).
  - **Licencja:** brak jawnej licencji; ogłoszenia są publiczne z mocy prawa (obowiązek
    publikacji w BZP wynika z ustawy Pzp). Pobieramy wyłącznie dane publiczne, bez logowania,
    bez CAPTCHA, z rate limitem SafeHttpClient (min. 2 s między żądaniami do hosta), w
    ograniczonej liczbie stron.
  - **Pokrycie i częstotliwość:** setki ogłoszeń dziennie (wewnętrzna tablica platformy
    pokazywała 966 ogłoszeń od 2026-10-29 do rana 2026-10-30). Pobieramy dwa typy ofert:
    `ContractNotice` (krajowe ogłoszenia o zamówieniu poniżej progów UE, od 130 tys. zł) i
    `SmallContractNotice` („Ogłoszenie dotyczące zamówienia, dla którego nie ma obowiązku
    stosowania ustawy Pzp” — małe zamówienia, które zamawiający dobrowolnie publikują w BZP),
    a od PR-03B także ogłoszenia o zmianie (`NoticeUpdateNotice`, niżej).
    Planowany przebieg: raz dziennie (cron w kolejnym PR), dzień publikacji = wczoraj.
  - **Znane ograniczenie pokrycia:** 2026-10-28 w całym kraju było 331 `ContractNotice`, ale
    tylko 7 `SmallContractNotice` — wszystkie z pustym `cpvCode`, 3 bez terminu składania
    ofert. Większość małych zamówień (< 130 000 zł) nie trafia do BZP, więc drugie źródło jest
    warunkiem wartości produktu dla małych firm (`docs/ROADMAP.md`), a dopasowanie w PR-04 musi
    korzystać ze słów kluczowych w tytule, nie tylko z CPV (`docs/STATE.md`).
  - **Znane ograniczenie — zmiany ogłoszeń** (źródło: przegląd właściciela, zapytanie na żywo
    2026-10-28): zmiany publikowane są jako osobny typ `NoticeUpdateNotice`, którego `ingest`
    do PR-03B nie pobierał. Tego dnia było ich co najmniej 100 (`PageSize=100` zwróciło pełną stronę; dla
    porównania 331 `ContractNotice`); w 96 ze 100 `htmlBody` dotyczy terminu składania ofert.
    Ogłoszenie o zmianie ma własny `noticeNumber` i łączy się z pierwotnym ogłoszeniem tylko
    przez `tenderId` (`ocds-148610-…`, obecny w 100/100); jego `submittingOffersDate` jest
    `null` — nowy termin jest tylko w `htmlBody`. Wszystkie 100 miały sufiks `/01`, więc
    ryzyko nowej wersji pierwotnego ogłoszenia jako `…/02` (osobny wiersz) nie jest
    potwierdzone. Skutek: zapisany `deadline` ogłoszenia BZP może być nieaktualny (zwykle za
    wczesny), a ponowne pobranie pierwotnego ogłoszenia go nie poprawi. Obsługa zmian →
    PR-03B (`docs/PR_PLAN.md`); do tego czasu nic, co filtruje po terminie, nie może na nim
    polegać dla BZP. **Rozwiązane w PR-03B** (punkt niżej) dla `ContractNotice` — **z
    wyjątkiem małych zamówień:** oba zarejestrowane oryginały `SmallContractNotice`
    (fixture 2026-10-29) mają `tenderId` = `null`, więc żadnej zmiany nie da się z nimi
    powiązać (powiązanie tylko przez `tenderId`), niezależnie od treści sekcji 3.1. Termin
    małego zamówienia nadal może być nieaktualny.
  - **Zmiany ogłoszeń — obsługa (PR-03B, decyzje właściciela).** `ingest` i `source:preview`
    pobierają trzeci typ, `NoticeUpdateNotice` (ten sam endpoint listy, po `ContractNotice` i
    `SmallContractNotice`, z tymi samymi limitami stron i rekordów na typ). Rekord jest
    rozpoznawany po własnym `noticeType`; inny nieznany typ jest odrzucany (`noticeType`).
    - **Co czytamy:** tylko numer (`noticeNumber`), `publicationDate`, `tenderId` i
      `htmlBody` (do 1 000 000 znaków — zaobserwowane 4 379–32 895 dnia 2026-10-29 i do 255 562
      dnia 2026-10-27, przegląd właściciela; dłuższy → odrzucenie `invalid source fields: htmlBody`,
      bez przycinania; limit 20 000 znaków dla pozostałych pól go nie dotyczy). Treść
      `htmlBody` nie jest zapisywana ani logowana — z niej wychodzi wyłącznie sparsowany
      termin. `submittingOffersDate` ogłoszenia o zmianie jest zawsze `null` i nie jest
      używane.
    - **Parsowanie `htmlBody`** (`src/sources/bzp/notice-update.ts`; od PR-03C skaner jest
      wspólny — `src/sources/normalize/html-text.ts`, zachowanie bez zmian, D-022): liniowy przegląd tekstu
      między znacznikami (komentarze, `<script>`, `<style>` i atrybuty pomijane; kilka encji
      dekodowanych; normalizacja NFC tylko segmentów ≤ 256 znaków — jest kwadratowa w ciągu
      znaków łączących, a dłuższy segment nie może być etykietą ani datą, więc zostaje
      nieznormalizowany i przegląd pozostaje liniowy). Niedomknięty znacznik, komentarz, `<script>` albo `<style>` w dowolnym
      miejscu → odrzucenie `invalid source fields: htmlBody` (treść ucięta lub zepsuta — nie
      wiadomo, czy przeczytano całe ogłoszenie, więc nie ma też pominięcia „brak zmiany”).
      Rodzaj zmienianego
      ogłoszenia = tekst po etykiecie „3.1.) Nazwa zmienianego ogłoszenia:”; zmiana stosowana
      tylko, gdy to dokładnie „Ogłoszenie o zamówieniu” (inaczej pominięcie
      `not_contract_notice_change`). Zmiana terminu = blok po nagłówku „3.4.1.)” z etykietą
      „8.1. Termin składania ofert”; nowa wartość = tekst po „Po zmianie:” w formacie
      `YYYY-MM-DD HH:MM` czasu Europe/Warsaw, przeliczony na UTC (`src/sources/normalize/warsaw-time.ts`, od PR-03C; wcześniej
      `src/sources/warsaw-time.ts`).
      Brak takiego bloku → pominięcie `no_deadline_change`; dwa bloki → odrzucenie
      `ambiguous deadline change`; wartość brakująca, powtórzona, w innym formacie, niemożliwa
      w kalendarzu albo niejednoznaczna przy zmianie czasu (godzina pominięta lub powtórzona)
      → odrzucenie `invalid value: deadline`; brak lub powtórzenie sekcji 3.1 →
      `invalid source fields: htmlBody`. Nic nie jest zgadywane.
    - **Powiązanie tylko przez `tenderId`.** Sekcja 3.2 („Numer zmienianego ogłoszenia w
      BZP”) nie jest używana. Ogłoszenie o zmianie bez `tenderId` → pominięcie
      `no_tender_id`; bez zapisanego oryginału → pominięcie `no_original` (nie tworzy
      oferty). Ogłoszenia o zmianie nigdy nie są zapisywane jako osobne oferty.
      **Pominięcie `no_original` nie jest zapamiętywane ani ponawiane** (bez kolejki i
      mechanizmu ponowień): jeśli oryginał trafi do bazy później — backfill jego dnia
      (`--from/--to`) albo dzień zmiany pobrany przed dniem oryginału — zostaje zapisany z
      nieaktualnym terminem. Operator musi wtedy ponownie pobrać dni następujące po dniu
      oryginału, aż do ostatniego pokrytego dnia, rosnąco (D-021, „Uwagi dla operatora”).
    - **Który wiersz:** gdy kilka wierszy jednego źródła ma ten sam `tender_id`, zmiana trafia
      do **starszego** — kolejność `published_at ASC NULLS LAST, first_seen_at ASC, id ASC`.
    - **Co się zmienia:** `deadline`, `status` (`open`, gdy nowy termin > czas pobrania
      ogłoszenia o zmianie, inaczej `closed`), `updated_at` i pochodzenie terminu:
      `deadline_update_notice` (numer ogłoszenia o zmianie) i `deadline_update_published_at`
      (jego publikacja; migracja `0004_notice_updates`, obie kolumny `NULL` albo obie
      ustawione). `fetched_at`, `content_hash` i `fingerprint` zostają bez zmian. Jedna
      instrukcja `UPDATE` (atomowa).
    - **Kolejność zmian:** wygrywa najpóźniej opublikowana — zmiana jest zapisywana tylko, gdy
      `(deadline_update_published_at, deadline_update_notice)` wiersza jest puste albo mniejsze
      niż w nowej zmianie (remis publikacji rozstrzyga numer). Starsza zmiana przeczytana
      później → pominięcie `superseded`; ta sama zmiana ponownie → `unchanged`.
    - **Ponowne pobranie oryginału** (np. nadrabianie dni) nie cofa terminu z ogłoszenia o
      zmianie: gdy wiersz ma `deadline_update_published_at`, zmieniona treść aktualizuje
      pozostałe pola, ale `deadline` zostaje, a `status` jest liczony z tego terminu i czasu
      pobrania.
    - **Liczniki:** `ingestion_runs.skipped` (migracja `0004`, domyślnie 0) liczy rekordy
      przeczytane, ale celowo niezastosowane; zawsze
      `extracted = inserted + updated + unchanged + rejected + skipped`. Pominięcie jest
      logowane (info `notice update skipped`: `sourceId`, `externalId`, `tenderId`, stały
      powód). Raport `ingest` podaje też `runs[].skippedReasons` — `skipped` według powodu
      (tylko powody, które wystąpiły, jak `rejectionReasons` w `source:preview`; suma =
      `skipped`); tylko w pamięci i raporcie, bez kolumny w bazie (przegląd właściciela
      PR #6).
    - **Nie obsługujemy (jeszcze):** zmian innych pól niż termin składania ofert; ogłoszeń o
      unieważnieniu postępowania (otwarte pytanie N6, `docs/STATE.md`); zmian małych zamówień
      (`SmallContractNotice`) — ich oryginały w zarejestrowanych danych nie mają `tenderId`
      (więc nie ma powiązania), a zmiana z sekcją 3.1 innej niż „Ogłoszenie o zamówieniu”
      jest pomijana (`not_contract_notice_change`). Czy oryginały małych zamówień kiedykolwiek
      mają `tenderId` i co zawiera sekcja 3.1 ich zmian — do sprawdzenia na żywo
      (`docs/STATE.md`, „Next action”).
- **API (zweryfikowane prawdziwymi zapytaniami):**
  `GET https://ezamowienia.gov.pl/mo-board/api/v1/notice?NoticeType=…&PublicationDateFrom=YYYY-MM-DD&PublicationDateTo=YYYY-MM-DD&PageSize=N[&SearchAfter=<objectId>]`.
  Wymagane: `PageSize` (1–500), `NoticeType`, obie daty; błędy to 400
  `application/problem+json`. Paginacja keyset: `SearchAfter` = `objectId` ostatniego rekordu
  poprzedniej strony, wyniki rosnąco; pusta tablica albo strona krótsza niż `PageSize` = koniec
  (`PageNumber` jest ignorowany, brak nagłówków paginacji). Odpowiedź: tablica JSON
  (`application/json; charset=utf-8`, bez kompresji, z `Content-Length`) — działa ze stałymi
  nagłówkami SafeHttpClient (`Accept: */*`, GET), więc D-014 nie wymaga zmian.
- **Mapowanie** (`src/sources/bzp/adapter.ts`):
  `externalId` = `noticeNumber` (np. `2026/BZP 00507107/01`); `tenderId` = `tenderId`
  (identyfikator OCDS całego postępowania, `ocds-148610-…`; brak, pusty, nie-tekst, dłuższy
  niż 200 znaków, z niepoprawnym Unicode albo ze znakami sterującymi (np. NUL) → `null`, bez
  odrzucania rekordu — dodane w PR-03A, kolumna `tender_id`, migracja `0003`); `sourceUrl` = strona ogłoszenia
  `https://ezamowienia.gov.pl/mo-client-board/bzp/notice-details/id/{objectId}` (`objectId` to
  identyfikator ogłoszenia — zweryfikowane `Board/GetNoticeDetailsById`; walidowany wyrażeniem
  `^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`); `title` = `orderObject`
  ze zwiniętymi białymi znakami; `issuerName` = `organizationName`; `publishedAt` =
  `publicationDate`; `deadline` = `submittingOffersDate` (lub `null`); `categories` = kody CPV
  wyciągnięte z `cpvCode` (`"37520000-9 (Zabawki),…"` → `["37520000-9", …]`, `""` → `[]`);
  `location` = **siedziba zamawiającego** (`organizationCity` + województwo ze statycznej mapy
  kodów `organizationProvince` `PL02`…`PL32` zgodnej z oficjalnym słownikiem
  `/mo-board/api/v1/glossary?glossaryType=province`; nieznany kod → brak województwa), a nie
  miejsce realizacji — lista API go nie podaje; `location.county` zostaje puste (BZP nie
  podaje powiatu, D-022). `description`, `contact`, `estimatedValue`, `currency` — lista API
  nie ma dla nich pól strukturalnych; do PR-03C były `null`, **od PR-03C pochodzą z `htmlBody`**
  ogłoszenia (D-022; brak lub nieczytelny `htmlBody` → `null`, bez odrzucania rekordu).
  `status`: `open`, gdy termin > `fetchedAt`; `closed`, gdy termin minął;
  `unknown` bez terminu. Rekord z niepoprawnym polem jest odrzucany z powodem — nic nie jest
  zgadywane ani przycinane.
- **Odrzucone alternatywy:** Baza Konkurencyjności (funduszeeuropejskie) — aplikacja SPA z
  wewnętrznym API (`/api/announcements/search`), bez udokumentowanego publicznego API w
  regulaminie, Keycloak; kandydat na kolejne źródło. Wewnętrzny endpoint e-Zamówień
  `Board/Search` — nieudokumentowany, a jego rekordy zawierają `userId`.
- **Konsekwencje:**
  - jedno żądanie na stronę (25 rekordów): rekord ma do ~100 KB (pomiar 2026-10-28: maks.
    95,6 KB, p99 75,7 KB, mediana 31 KB), więc typowa strona ma < 1 MB, a najgorszy przypadek
    ~2,4 MB, czyli ~2× zapasu względem limitu 5 MB (nie zwiększać `PageSize` bez ponownego
    sprawdzenia); max 40 stron i limit rekordów — oba **osobno dla każdego typu ogłoszenia**,
    żeby liczne `ContractNotice` nie wyparły małych zamówień (`SmallContractNotice` pobierane
    jako drugie, `NoticeUpdateNotice` jako trzecie); przebieg zwraca więc najwyżej 3 × limit
    rekordów (do PR-03B: 2 ×). Osiągnięcie limitu jest
    raportowane, nie ciche. Przebieg ma limit czasu (`AbortSignal`, `source:preview`: 5 min);
  - przerwanie przebiegu w trakcie żądania zużywa jednostkę budżetu błędów SafeHttpClient, a
    przerwanie w kolejce/czekaniu — nie. Zostawiamy bez zmian: klient = jeden przebieg, a
    przerwanie kończy przebieg, więc budżet po nim nie ma znaczenia;
  - adapter nie pobiera żadnych linków z treści źródła (link do ogłoszenia budujemy z
    walidowanego `objectId` i tylko go zapisujemy), więc wstępne sprawdzanie linków
    `parseRequestUrl` nie jest potrzebne;
  - w kontenerze sesji ruch wychodzi tylko przez proxy, a SafeHttpClient celowo ignoruje proxy
    (D-014): prawdziwe `source:preview` (PR-02 AC1) uruchamia właściciel na maszynie z
    bezpośrednim wyjściem HTTPS;
  - dzień publikacji jest przekazywany do API jako data `YYYY-MM-DD`; domyślnie „wczoraj” wg
    UTC. Czy API liczy granice dnia w UTC, czy w czasie polskim — niezweryfikowane (do
    sprawdzenia przy cronie w PR-03).

## D-016 — Fingerprint i `content_hash`: SHA-256 z kanonicznego JSON-a

- **Status:** Accepted (PR-03A)
- **Kontekst:** deduplikacja w obrębie źródła i wykrywanie zmian treści muszą być
  deterministyczne, niezależne od kolejności kluczy i odporne na niejednoznaczne sklejanie
  części. Adapter nie zna tych reguł (D-015, ARCHITECTURE §4.1).
- **Decyzja:** `src/ingestion/fingerprint.ts`, tylko `node:crypto`.
  - `fingerprint` = SHA-256 (hex) z `JSON.stringify([sourceId, "external", externalId])`, a
    bez `externalId` — z `[sourceId, "url", sourceUrl]` (URL już kanoniczny). Tablica JSON
    zamiast separatora: brak „przesunięć” między częściami, identyfikator nigdy nie zrówna się
    z URL-em o tym samym tekście.
  - `contentHash` = SHA-256 (hex) z JSON-a par `[pole, wartość]` w stałej kolejności
    (`issuerName`, `title`, `description`, `location`, `publishedAt`, `deadline`,
    `estimatedValue`, `currency`, `categories`, `contact`, `status`, `sourceUrl`,
    `externalId`, `tenderId`); daty jako ISO 8601 UTC, obiekty z posortowanymi kluczami, tablice w
    kolejności źródła; `null`, `""` i brak pola rozróżnione. Bez `fetchedAt` i `sourceId`.
  - Oba liczone z kandydata po ponownej walidacji schematem domenowym.
  - `tenderId` (D-015) dopisany na końcu listy `contentHash` jeszcze w PR-03A, przed pierwszym
    wdrożeniem — żaden zapisany hash nie istnieje, więc nie ma jednorazowej fali `updated`.
    Fingerprint się nie zmienia: kluczem deduplikacji pozostaje `externalId`.
- **Odłożone:** wariant fingerprintu dla źródeł bez identyfikatora i bez stabilnego URL-a,
  `(sourceId, issuerName, title, publishedAt)` (ARCHITECTURE §5 przed PR-03). Żadne obecne
  źródło go nie potrzebuje (BZP ma `noticeNumber`); powstanie z pierwszym takim adapterem,
  który będzie musiał jawnie zadeklarować, że jego URL nie jest stabilny.
- **Konsekwencje:** zmiana listy pól lub kodowania `contentHash` zmienia hash każdego wiersza,
  ale jako `updated` (jednorazowo; bez utraty danych) zapisane zostaną tylko wiersze pobrane
  ponownie. Codzienny cron pobiera tylko wczorajszy dzień, więc starsze wiersze nie są ani
  oznaczane, ani uzupełniane, dopóki operator nie uruchomi `ingest --date …` dla tych dni.
  Zmiana formatu fingerprintu jest poważniejsza (nowe wiersze obok starych; `UNIQUE
(source_id, external_id)` odrzuci je jako `duplicate`) i wymaga migracji danych.
  `status` jest częścią `contentHash`, a BZP wylicza go z `fetchedAt` (termin minął →
  `closed`): ponowne pobranie ogłoszenia po upływie terminu da jednorazowo `updated`. To
  zamierzone — zmienił się zapisany stan oferty.
- **Uzupełnienie (PR-03C, D-022):** lista pól i kodowanie `contentHash` się nie zmieniają, ale
  oferty BZP mają teraz wartości w `description`, `contact`, `estimatedValue` i `currency`
  (z `htmlBody`). Wiersze zapisane przed PR-03C, pobrane ponownie (nadrabianie, backfill,
  `--date`), dostają nowy hash i stają się **jednorazowo `updated`** (uzupełnione o te pola);
  kolejne pobranie bez zmian → `unchanged`. Termin ustawiony przez ogłoszenie o zmianie
  zostaje (D-015, PR-03B AC4) — test integracyjny
  `updates a row once when its notice gains htmlBody details, keeping an applied deadline`.
  Wierszy niepobranych ponownie to nie dotyczy — zostają z `null`.

## D-017 — `unchanged` nie zapisuje niczego; brak `last_seen_at`

- **Status:** Accepted (PR-03A)
- **Kontekst:** codzienny `ingest` będzie wielokrotnie widział te same ogłoszenia. Nadpisanie
  niezmienionego wiersza tylko po to, by odświeżyć `fetched_at`, oznacza martwe krotki i WAL
  przy każdym przebiegu, a `updated_at` przestaje znaczyć „treść się zmieniła”.
- **Decyzja:** `ingestOpportunity` to `INSERT … ON CONFLICT (fingerprint) DO UPDATE … WHERE
opportunities.source_id = excluded.source_id AND opportunities.content_hash IS DISTINCT FROM
excluded.content_hash RETURNING (xmax = 0)`; brak zwróconego wiersza rozstrzyga `SELECT` po
  fingerprincie (to samo źródło → `unchanged`, inne → `DomainError duplicate`, brak wiersza →
  błąd — równoległe usunięcie). `upsertOpportunity` (PR-01) zostaje bez zmian.
- **Konsekwencje:** przy `unchanged` `fetched_at` i `updated_at` się nie zmieniają —
  `fetched_at` to pobranie, przy którym treść ostatnio zapisano. „Kiedy ostatnio widziany”
  wynika z `ingestion_runs`; kolumnę `last_seen_at` dodamy, gdy będzie jej potrzebować
  konkretna funkcja (np. wykrywanie ogłoszeń, które zniknęły ze źródła). Zmiana samego
  `status` (np. `closed` po terminie, D-016) to zmiana treści, więc zapisuje wiersz jako
  `updated` — zamierzenie, nie wyjątek od reguły.
  Równoległe zapisy tego samego fingerprintu (AC3) dają jeden wiersz i wyniki `inserted` +
  `unchanged`/`updated`: `ON CONFLICT` rozstrzyga konflikt tylko na swoim indeksie
  (`fingerprint`), więc gdy równoległy `INSERT` trafi najpierw na `UNIQUE (source_id,
external_id)` (błąd po zatwierdzeniu tamtego zapisu), `ingestOpportunity` ponawia zapis
  jeden raz i wchodzi w ścieżkę konfliktu. Prawdziwy konflikt (ten sam `externalId` pod innym
  fingerprintem) kończy się tym samym `duplicate` także po ponowieniu.

## D-018 — `ingest`: limit 1000 rekordów na typ, timeout 10 min na źródło, przetwarzanie strumieniowe

- **Status:** Accepted (PR-03A)
- **Kontekst:** cron musi się kończyć w przewidywalnym czasie i pamięci, nawet gdy źródło
  zwalnia; jeden wolny/zawieszony przebieg nie może zablokować pozostałych źródeł ani
  kolejnego dnia.
- **Decyzja:** `--limit` domyślnie i maks. 1000 rekordów na typ ogłoszenia. Dla BZP to
  1000 / 25 = 40 stron na typ — tyle samo co `BZP_MAX_PAGES_PER_TYPE` — czyli najwyżej 80
  żądań. Przy odstępie 2 s (`DEFAULT_MIN_INTERVAL_MS`) to ≥ 160 s samych przerw; timeout źródła
  10 min (`INGEST_SOURCE_TIMEOUT_MS`) daje średnio ~7 s na żądanie (odstęp + odpowiedź), z
  zapasem na pojedyncze ponowienia, a jednocześnie ogranicza najgorszy przypadek (30 s timeout
  żądania × ponowienia). Timeout to `AbortSignal.timeout` połączony z sygnałem całego
  przebiegu; po nim przebieg źródła jest `failed` (`source_timeout`), zapisane rekordy
  zostają, następne źródło startuje. `source:preview` zachowuje 5 min (D-015). Dokumenty są
  przetwarzane strumieniowo (`FetchContext.onDocument`): w pamięci jest najwyżej jedna strona.
  Timeout źródła nie przerywa trwającego zapisu do bazy: pojedynczy zapis w `onDocument`
  ogranicza `statement_timeout` (30 s) i timeout klienta `pg` (35 s). Po przerwaniu sygnału
  `runIngestion` nie zaczyna kolejnego zapisu, a adapter sprawdza sygnał przed kolejnym
  żądaniem — przekroczenie timeoutu źródła jest więc ograniczone do jednego zapisu.
- **Konsekwencje:** dzień z > 1000 ogłoszeniami jednego typu daje przebieg `incomplete`
  (`max_records`) — widoczny w JSON-ie, logu i `ingestion_runs`, kod wyjścia 0. Podniesienie
  limitu wymaga przeliczenia timeoutu.
- **Uzupełnienie (PR-03B):** od PR-03B BZP pobiera 3 typy ogłoszeń (D-015), więc to najwyżej
  120 żądań na dzień, ≥ 240 s samych przerw i średnio ~5 s na żądanie w limicie 10 min;
  timeout dotyczy jednego przebiegu źródła i dnia (D-021). Tytuł decyzji zostaje bez zmian.

## D-019 — Jedno `ingest` naraz: sesyjny advisory lock PostgreSQL

- **Status:** Accepted (PR-03A)
- **Kontekst:** cron, ręczne uruchomienie albo przeciągnięty przebieg mogą się nałożyć. Bez
  zewnętrznego lockera (D-001).
- **Decyzja:** `withIngestLock` (`src/ingestion/lock.ts`): `pg_try_advisory_lock(7206120309001)`
  na jednym połączeniu z puli trzymanym przez cały przebieg (`db.connection().execute`),
  `pg_advisory_unlock` w `finally`. Blokada sesyjna, nie transakcyjna — przebieg nie jest
  jedną transakcją (każdy rekord zapisywany osobno, żeby błąd nie cofał zapisanych). Zajęta
  blokada → nic nie jest pobierane ani zapisywane (bez wiersza w `ingestion_runs`), log
  `ingest lock busy` (warn), na stdout
  `{"status":"skipped","reason":"lock_busy","mode":…,"from":…,"to":…,"limit":…,"runs":[],"notRun":[],"clipped":[]}`
  (od PR-03B; w trybie nadrabiania `from`/`to` = `null`, bo dni są znane dopiero pod blokadą), na
  stderr „Ingest skipped: another ingest run holds the lock; nothing was fetched.” i **kod 0**.
  Zmiana po przeglądzie właściciela (PR-03A; wcześniej kod 1): nałożenie się crona na trwający
  przebieg to oczekiwany stan, nie awaria — kod 1 dawałby fałszywe alarmy monitoringu.
  Utrata blokady w trakcie przebiegu pozostaje błędem (kod 1, niżej).
  - **Utrata blokady:** zerwane połączenie (zakończona sesja, restart serwera, awaria sieci)
    zwalnia blokadę po stronie serwera, więc przebieg nie może po cichu trwać dalej. Każde
    połączenie z puli ma listener `error` (`createDatabase`), więc zerwanie nie zabija
    procesu, a połączenie z blokadą jest sprawdzane co 5 s (`SELECT 1`,
    `INGEST_LOCK_HEARTBEAT_MS`; przy zawieszonej sieci najpóźniej po timeoucie zapytania,
    35 s). Nieudane sprawdzenie → log `ingest lock lost` (tylko kod), przerwanie sygnału
    przebiegu: bieżące źródło kończy się `failed` z kodem `lock_lost` (bez kolejnego żądania
    ani zapisu; zapis w toku ogranicza timeout zapytania), kolejne źródła nie startują. CLI
    wypisuje podsumowanie JSON ze statusem `failed`, komunikat „Ingest aborted: the ingest
    lock was lost during the run (lock_lost).” i kończy się kodem 1 — także gdy utratę
    wykryto dopiero po ostatnim źródle. Pula ma TCP keepalive.
  - **Błąd zwolnienia:** nieudany `pg_advisory_unlock` jest logowany (`ingest lock release
failed`, tylko kod) i nie zastępuje gotowego wyniku; sesja kończy się, gdy pula zamyka
    połączenie (koniec komendy albo 10 s bezczynności), a serwer zwalnia wtedy blokadę.
- **Konsekwencje:** advisory locki są wspólne dla całej bazy (nie dla schematu) — dwa
  środowiska na jednej bazie blokują się wzajemnie, a testy biorące tę blokadę są w jednym
  pliku (`tests/integration/ingest-cli.test.ts`). Pula ma 5 połączeń: jedno trzyma blokadę,
  zapisy idą pozostałymi.

## D-020 — `ingest`: wybór źródeł i błędy konfiguracji

- **Status:** Accepted (PR-03A)
- **Kontekst:** lista źródeł jest w bazie (`sources.enabled`), adaptery — w kodzie
  (`src/sources/registry.ts`); obie strony mogą się rozjechać.
- **Decyzja:**
  - bez argumentów: wszystkie źródła włączone w bazie; włączone bez adaptera → przebieg
    `failed` z kodem `no_adapter` (zapisany i zalogowany, kod wyjścia 1), pozostałe źródła
    działają — błąd konfiguracji jest widoczny, ale nie blokuje reszty;
  - jawne `sourceId`: nieznany adapter → kod 2 już przy parsowaniu argumentów; źródło
    niewłączone w bazie → kod 2 po odczycie bazy, przed pobraniem;
  - niewykonana którakolwiek migracja (wg rejestru `kysely_migration`, `pendingMigrations` —
    odczyt bez tworzenia tabel i bez blokady migracji) → kod 1 z komunikatem „run `migrate`
    first”, przed pobraniem; `ingest` nigdy nie migruje sam (migracja to świadoma operacja
    wdrożeniowa). Ten sam test gotowości wykonuje `health` (pole `schema`). Wcześniej
    sprawdzana była tylko obecność tabeli `ingestion_runs` — po `0003` przepuściłaby bazę bez
    kolumny `tender_id`. Ręcznie usunięta tabela przy wpisie w rejestrze nie jest wykrywana
    (rejestr jest źródłem prawdy, jak dla `migrate`);
  - migracja `0002_ingestion_runs` dodaje `bzp` (`ON CONFLICT (id) DO NOTHING`), żeby świeża
    instalacja działała po `migrate` bez ręcznego SQL; istniejący wiersz (np. wyłączony) nie
    jest nadpisywany.
- **Konsekwencje:** wyłączenie źródła = `UPDATE sources SET enabled = false` (bez wdrożenia).

## D-021 — `ingest`: zakresy dni i automatyczne nadrabianie pominiętych dni

- **Status:** Accepted (PR-03B, decyzja właściciela); nadrabianie wg różnicy zbiorów i limit kolejnych
  nieudanych dni — przegląd właściciela PR #6; limit liczy tylko nieudane pierwsze próby —
  przegląd C&S tej rundy
- **Kontekst:** cron pobiera „wczoraj”; nieudany albo pominięty przebieg (awaria, przerwa w
  działaniu hosta) zostawiał dziurę, którą trzeba było łatać ręcznie `--date` dzień po dniu.
  Ogłoszenia o zmianie (D-015) dają ten sam problem: pominięty dzień = pominięte zmiany
  terminów.
- **Decyzja:**
  - `ingest [sourceId...] [--date D | --from A --to B] [--limit N]`. `--date D` = jeden dzień;
    `--from/--to` = zakres (oba wymagane, `A ≤ B`, najwyżej 31 dni, `INGEST_MAX_DAYS`); bez
    opcji dnia — **nadrabianie** (domyślne, także dla crona). Dni tylko z lat 2000–2999
    (`INGEST_MIN_DAY`/`INGEST_MAX_DAY` w `src/ingestion/catch-up.ts`; inaczej błąd użycia, kod
    2): daleko poza realnymi dniami publikacji, a od roku 10000 zapis dnia przestaje być
    `YYYY-MM-DD`. Długość zakresu jest liczona arytmetycznie, zanim powstanie lista dni, a
    lista nigdy nie przekracza 31 dni.
  - **Nadrabianie** (per źródło, pod blokadą `ingest`, D-019 — odczyt i przebieg nie mogą się
    przeplatać z innym `ingest`; zmienione w przeglądzie właściciela PR #6 z „od dnia po
    najnowszym pokrytym dniu” na różnicę zbiorów): **okno** = 31 dni kończących się wczoraj
    (UTC); pobierane są dni okna, które **nie są pokryte**, od najwcześniejszego dnia
    dowolnego przebiegu źródła (każdy status) — rosnąco. Dzień jest pokryty, gdy ma przebieg
    `succeeded` albo `incomplete` (limit nie jest ponawiany przez nadrabianie — jest widoczny
    w raporcie), który wystartował **po końcu tego dnia** (UTC): przebieg dnia jeszcze
    trwającego (np. ręczne `--date` dzisiaj) mógł nie widzieć ogłoszeń opublikowanych
    później, więc nie ukrywa dnia. `failed` nigdy nie pokrywa. Źródło bez przebiegów (świeża
    instalacja) → tylko wczoraj (bez pobierania historii); niepokryte wczoraj jest zawsze
    pobierane. **Każdy** przebieg starszego dnia — backfill `--from/--to`, ale też ręczne
    `--date` starego dnia, nawet nieudane — przesuwa dolną granicę wcześniej, nigdy jednak
    przed okno: następne nadrabianie pobiera wtedy **każdy** niepokryty dzień okna od tego
    dnia. Jedno zapytanie na źródło (`catchUpHistory`: pokryte i próbowane dni w oknie,
    najnowszy pokryty dzień, najwcześniejszy dzień przebiegu; dni jako `to_char(…,
'YYYY-MM-DD')`, niezależnie od `DateStyle` sesji; wynik ograniczony do okna, zapytanie
    przegląda wiersze źródła dla min/max), bez nowej tabeli i migracji.
  - **Dni starsze niż okno** nie są nigdy pobierane automatycznie. Raport `clipped[]`
    (`from`/`to`, oba włącznie; log warn `catch-up clipped, older missing days not run`):
    gdy najnowszy pokryty dzień jest przed `początek okna − 1` → od dnia po nim do dnia przed
    oknem; gdy źródło nie ma pokrytego dnia, a jego najwcześniejszy przebieg jest przed oknem
    → od tego dnia do dnia przed oknem. Starsze dziury przed pokrytym dniem nie są
    raportowane. Takie dni można pobrać ręcznie `--from/--to`.
  - **Przebieg:** źródło po źródle, w każdym dni rosnąco; jeden wiersz `ingestion_runs` na
    źródło i dzień. Nieudany dzień **nie zatrzymuje** kolejnych dni tego źródła (wszystkie
    tryby: `--date`, `--from/--to`, nadrabianie). Żeby ograniczyć czas przy awarii źródła,
    po **2 kolejnych nieudanych pierwszych próbach w tym przebiegu**
    (`INGEST_MAX_CONSECUTIVE_FAILED_DAYS`, `failureStreak`) pozostałe dni źródła są `notRun` z
    powodem `consecutive_failures` (log warn `days not run after consecutive failed days`).
    Pierwsza próba = dzień, który przed tym `ingest` nie miał żadnego przebiegu tego źródła
    (dowolny status; to samo zapytanie `catchUpHistory` w każdym trybie, dla `--date`/
    `--from/--to` ograniczone do zakresu). Nieudana pierwsza próba (także przebieg, którego nie
    udało się zapisać) zwiększa licznik; **nieudane ponowienie** dnia, który miał już przebieg,
    licznika ani nie zwiększa, ani nie zeruje; dzień udany (`succeeded`/`incomplete`,
    zapisany) — pierwsza próba czy ponowienie — zeruje go. Dzięki
    temu dzień, który zawsze kończy się `failed` (np. strona ponad limit odpowiedzi), nie
    blokuje nowszych dni, a awaria i tak zatrzymuje źródło po 2 nowych dniach. Jeden nieudany
    dzień bywa przejściowy, dwa z rzędu to najpewniej awaria — każdy kolejny dzień mógłby
    kosztować pełny timeout. Nieudane i niewykonane dni zostają niepokryte, więc nadrabianie
    ponawia je, dopóki są w oknie. Inne źródła działają dalej. Przerwanie (utracona
    blokada) → pozostałe dni `notRun` z powodem `aborted`.
  - **Raport JSON:** `mode` (`date` / `range` / `catch_up`), `from`/`to` (zaplanowane dni;
    `null`, gdy nie ma czego nadrabiać), `runs[]` z `publicationDate` i `skippedReasons`
    (D-015), `notRun[]`, `clipped[]`. Kod wyjścia jak dotąd (D-019, D-020).
  - **Uwagi dla operatora** (bez dodatkowego mechanizmu):
    - **Pierwsze wdrożenie:** przed pierwszym cronem jednorazowo
      `ingest --from <wczoraj−30> --to <wczoraj>` (README, „Cron”): oryginały zmian są zwykle
      sprzed tygodni, więc bez tego prawie wszystkie zmiany byłyby `no_original`. Ten
      backfill wyznacza też dolną granicę nadrabiania.
    - **Ręczny przebieg starego dnia przesuwa dolną granicę:** także jedno `--date` dnia
      sprzed tygodni (nawet nieudane) sprawia, że następne nadrabianie pobierze każdy
      niepokryty dzień okna od tego dnia (do 31 dni naraz).
    - **Backfill i zmiany ogłoszeń:** pobranie starszych dni (`--from/--to`) zapisuje
      oryginały z terminem z dnia publikacji. Zmiany tych ogłoszeń z późniejszych dni,
      pominięte wcześniej jako `no_original` (D-015), nie są ponawiane same — po backfillu
      trzeba ponownie pobrać dni **następujące po nim aż do ostatniego pokrytego dnia**,
      rosnąco, porcjami po najwyżej 31 dni (`--from/--to`). To samo, gdy dzień zmiany był
      pobrany przed dniem oryginału — także po automatycznym ponowieniu nieudanego dnia, gdy
      nowsze dni pobrano już wcześniej.
    - **Ręczne `--date` późniejszego dnia** nie przeskakuje już nieudanego dnia (nadrabianie
      liczy każdy niepokryty dzień okna). **Dzień, który zawsze kończy się `failed`,** nie
      blokuje nowszych dni (jego nieudane ponowienia nie liczą się do limitu 2) — jest
      ponawiany, dopóki jest w oknie; potem przestaje być
      pobierany (bez wpisu w `clipped`, jeśli nowsze dni są pokryte). Taki dzień zapisać
      jako utracony (np. w `docs/STATE.md`) i zgłosić problem ze źródłem.
- **Konsekwencje:** timeout 10 min (D-018) dotyczy jednego przebiegu, czyli źródła i dnia;
  najgorszy czas jednego `ingest` = 31 dni × 10 min
  × liczba źródeł — dla BZP ~5 h 10 min; w praktyce dzień trwa ~2–3 min (3 typy × kilka
  stron, odstęp 2 s). Przy całkowitej awarii źródła limit 2 kolejnych nieudanych pierwszych
  prób ogranicza nowe dni do 2 na przebieg (~20 min), ale dni już próbowane i nieudane są
  ponawiane wszystkie: przy awarii trwającej wiele dni każdy cron dokłada najwyżej 2 takie dni (przy codziennym
  cronie zwykle 1), więc
  najgorszy czas rośnie z czasem awarii (do 31 dni × timeout, jak wyżej). W praktyce awaria
  zwykle kończy się szybkim błędem HTTP, nie pełnym timeoutem. Kolejny cron w trakcie długiego nadrabiania kończy się `skipped`
  (`lock_busy`, kod 0). Granica dnia to UTC, jak dotąd (D-015, otwarte pytanie o granicę dnia
  w API).

## D-022 — Helpery normalizacji i szczegóły ofert BZP z `htmlBody`

- **Status:** Accepted (PR-03C, decyzje koordynatora na podstawie fixture'ów 2026-10-29)
- **Kontekst:** lista API BZP nie ma pól strukturalnych dla opisu, kontaktu i wartości
  zamówienia (D-015) — są tylko w `htmlBody` ogłoszenia (pełny HTML formularza). Matching
  (PR-04) potrzebuje też wspólnych reguł porównywania tekstu, województw/powiatów i słownika
  kategorii.
- **Decyzja:**
  - **Moduł `src/sources/normalize/`** — czyste funkcje, bez I/O:
    - `whitespace.ts`: `collapseWhitespace` (każdy ciąg białych znaków Unicode, także NBSP i
      wąska NBSP → jedna spacja, przycięte) i `cleanText` (tekst do zapisu; dodatkowo:
      znaki sterujące `\p{Cc}` — C0, DEL i C1, także NEL U+0085 — → spacja, a znaki
      sterujące kierunkiem tekstu U+061C, U+200E, U+200F, U+202A–U+202E, U+2066–U+2069 oraz
      znaki zerowej szerokości U+200B–U+200D, U+2060, U+FEFF usuwane bez śladu, więc słowo
      ich zawierające zostaje jednym słowem; U+FEFF jest już w skanerze zamieniany na spację,
      jak każdy biały znak `\s`);
    - `html-text.ts`: liniowy skaner HTML → segmenty tekstu, przeniesiony bez zmian
      zachowania z `bzp/notice-update.ts` (PR-03B, D-015) — każdy znacznik kończy segment,
      komentarze i `<script>`/`<style>` pomijane, kilka encji dekodowanych, NFC tylko dla
      segmentów ≤ 256 znaków, niedomknięta konstrukcja → `complete = false`;
    - `comparable.ts`: `comparableText` — tekst **tylko do porównań** (nigdy do zapisu):
      małe litery, bez diakrytyków (także `ł` → `l`), zwinięte białe znaki; znaki łączące
      usuwane przed NFD (liniowo także dla wrogiego wejścia);
    - `regions.ts`: 16 kanonicznych nazw województw (`VOIVODESHIPS`, jak w mapie
      `bzpProvinces`) i `normalizeVoivodeship` — wielkość liter, prefiks „woj.”/„województwo”,
      brak polskich znaków, spacje wokół łącznika → nazwa kanoniczna, inaczej `null` (bez
      dopasowania przybliżonego); `normalizeCounty` — usuwa prefiks „powiat”/„pow.”, zwija
      białe znaki, małe litery (polskie znaki zostają), pusty lub dłuższy niż 100 → `null`.
      **Bez słownika 380 powiatów** (YAGNI): wynik służy tylko porównaniu profilu z zapisaną
      lokalizacją w PR-04. BZP nie podaje powiatu (NUTS 3 to podregion), więc
      `location.county` ofert BZP zostaje puste — nie wyprowadzamy go. **Reguła porównania
      (PR-04):** powiat porównywany wyłącznie jako `comparableText(normalizeCounty(x))` po
      obu stronach (profil i oferta). Wynik `normalizeCounty` ma kształt tekstu do
      wyświetlenia/zapisu i zachowuje polskie znaki: „Powiat Łódzki Wschodni” → „łódzki
      wschodni”, a „lodzki wschodni” zostaje bez zmian — równe dopiero po `comparableText`.
      Helper nie ujednolica wariantów nazw: „m. st. Warszawa” → „m. st. warszawa”, a
      „m.st. Warszawa” → „m.st. warszawa” (różne także po `comparableText`, który nie rusza
      kropek ani spacji między nimi); dopisek „miasto na prawach powiatu” zostaje w wyniku
      („Kraków (miasto na prawach powiatu)” → „kraków (miasto na prawach powiatu)”). PR-04
      decyduje, jak je traktować (np. usunięcie „m. st.”/„m.st.” albo jawny alias), zapisuje
      decyzję i pokrywa ją testami;
    - `cpv-categories.ts`: `mvpCategoriesForCpv(codes)` — kody CPV → zamknięta lista
      kategorii MVP (`bhp`, `elektryka`, `instalacje`, `it`, `ppoz`, `remonty`, `serwis`,
      `sprzatanie`, `szkolenia`, `wyposazenie`), posortowane, bez powtórzeń; tylko kody
      `^\d{8}-\d$`; kod może należeć do kilku kategorii; nieznany → `[]`;
    - `warsaw-time.ts`: przeniesiony z `src/sources/` bez zmian.
  - **Słownik CPV → MVP** (prefiksy 8 cyfr kodu; **punkt startowy do kalibracji** na
    prawdziwych ofertach i profilach, zmiana nie wymaga migracji ani ponownego ingestu):

    | Kategoria   | Prefiksy CPV                                       |
    | ----------- | -------------------------------------------------- |
    | elektryka   | 4531, 31, 50532, 50711, 50232                      |
    | instalacje  | 4530, 4533, 4535                                   |
    | ppoz        | 453121, 45343, 3511, 316252, 44480, 504132, 713171 |
    | szkolenia   | 804, 805                                           |
    | bhp         | 713172, 80550, 181, 351134                         |
    | sprzatanie  | 909, 9061                                          |
    | it          | 72, 48, 302, 50312, 5032                           |
    | remonty     | 454                                                |
    | serwis      | 50                                                 |
    | wyposazenie | 391, 392                                           |

    `4530` obejmuje tylko kod nadrzędny 45300000 (roboty instalacyjne w budynkach); `50232`
    (konserwacja oświetlenia publicznego i sygnalizacji świetlnej) należy też do `serwis` przez `50`. Celowo poza
    słownikiem: `0931` (dostawy energii elektrycznej — zakup energii, nie prace elektryczne;
    test) oraz szersze prefiksy robót budowlanych (`45`, `452`).

  - **`categories` dalej przechowuje kody CPV ze źródła** (weryfikowalne). Słownik jest
    stosowany w czasie dopasowania (PR-04), nie przy zapisie: strojenie słownika działa od
    razu i nie zmienia `content_hash`. Bez zmiany schematu i bez migracji.
  - **BZP `htmlBody` ofert** (`ContractNotice`, `SmallContractNotice`;
    `src/sources/bzp/notice-body.ts`): czytany raz w ekstrakcji (po walidacji pól listy);
    `BzpNotice` niesie tylko wyciągnięte wartości (`details`), nigdy HTML; nic z `htmlBody`
    nie jest zapisywane ani logowane poza tymi wartościami. Brakujący, nie-tekst, dłuższy niż
    1 000 000 znaków albo niedomknięty (`complete = false`) `htmlBody` **nie odrzuca
    oferty**: pola z `htmlBody` są `null`, reszta mapowania bez zmian. Powód nie jest
    logowany (świadomie — bez nowych pól raportu; treść nigdy nie trafia do logów).
    - **Etykiety** (dokładny segment, z dwukropkiem lub bez): opis „4.2.2.) Krótki opis
      przedmiotu zamówienia” / „3.3.)”; telefon „1.5.7.) Numer telefonu” / „1.4.7.)”; e-mail
      „1.5.9.) Adres poczty elektronicznej” / „1.4.9.)”; wartość „4.1.5.) Wartość zamówienia”
      / „3.4.) Wartość”; waluta osobno tylko w małych zamówieniach „3.5) Kod waluty”. Pole
      kończy się na nagłówku „SEKCJA …” albo na następnej numerowanej etykiecie formularza
      (`^(\d{1,3}(?:\.\d{1,3})+)\.?\)(?:\s|$)` na prefiksie 40 znaków, np. „4.2.6.)”,
      „3.5)”) o numerze **równym lub wyższym** niż numer etykiety pola (porównanie
      leksykograficzne liczb: 4.2.2 → kończy 4.2.3, 4.2.10, 4.3, 5.1, 4.2.2.1 i ponowne
      4.2.2 — kolejna część; 3.3 → 3.4 i wyżej). W obrębie czytanych pól formularz numeruje
      etykiety rosnąco (po 4.2.2 jest 4.2.6, po 3.3 jest 3.4/3.5), więc linia opisu o niższym
      numerze („1.1) roboty ziemne”, „2.1.) …”, „1.1.1.) …” w 4.2.2) jest treścią pola, nie
      etykietą. Linie „1. …”, „2.1 …”, „1) …”, „14.1.Wykonawca…” w ogóle nie pasują do
      wzorca. **Znane ograniczenie:** linia opisu numerowana równo lub
      wyżej niż etykieta (np. „5.1) …” albo „4.2.3) …” w 4.2.2) nadal kończy pole — opis jest
      wtedy krótszy, bez treści innego pola. Odwrotnie: etykieta o niższym numerze tuż po
      polu (w zarejestrowanym formularzu nie występuje — po 4.2.2 jest 4.2.6, po 3.3 jest
      3.4 albo 3.5) zostałaby linią opisu.
    - **Opis:** wszystkie wystąpienia etykiety (np. części) w kolejności, rozdzielone pustą
      linią; w jednym wystąpieniu każdy segment tekstu to linia (`\n`), białe znaki zwinięte,
      tekst oczyszczony przez `cleanText` (znaki `\p{Cc}` → spacja, znaki kierunku tekstu i
      zerowej szerokości usunięte — lista wyżej; tak samo e-mail, telefon i `raw`). Dłuższy
      niż 10 000 znaków → ucięty na granicy słowa (bez rozcinania pary surogatów; pojedyncze
      słowo dłuższe od limitu — twardo) z „…”, razem ≤ 10 000. Brak, pusty albo niepoprawny
      dla `text(10_000)` → `null`.
    - **Kontakt:** tylko **pierwsze** wystąpienie etykiety e-maila i telefonu (przy wspólnym
      zamówieniu kolejni zamawiający są dalej; pierwszy prowadzi postępowanie). Poprawny
      e-mail (`emailSchema`) → `email` małymi literami, telefon ≤ 50 znaków → `phone`; inna
      treść (np. kilka adresów, „(at)”, długi telefon) → `raw` (łączone „; ”, ≤ 500 —
      wartość, która by się nie zmieściła, jest pomijana, nie przycinana). Pole telefonu bez
      ani jednej cyfry („-”, „brak”) nie niesie numeru i jest pomijane (także w `raw`). Bez
      imienia i nazwiska, bez wzbogacania. Brak obu → `contact = null`.
    - **Wartość:** dokładnie jedno wystąpienie etykiety wartości; blok (≤ 100 znaków) w ścisłym
      formacie: cyfry albo grupy po 3 cyfry rozdzielone spacją/NBSP (pierwsza grupa bez zera
      wiodącego), opcjonalna część ułamkowa po „,” lub „.” z **1, 2 albo 4** cyframi,
      opcjonalny 3-literowy kod waluty w tym samym bloku. Waluta = kod z bloku i/lub
      „Kod waluty” (tylko przy dokładnie jednym wystąpieniu, wartość `^[A-Z]{3}$`); oba
      muszą się zgadzać. Zera wiodące usuwane, wynik musi przejść `decimalAmountSchema` i
      `currencySchema`. **Opublikowane zero** („0”, „0,00”, „000”, „0,00 PLN”) →
      `estimatedValue = currency = null`: szacunkowa wartość 0 nie niesie informacji i może
      być wypełniaczem, więc jest traktowana jak niepodana (brak wartości nigdy nie jest
      zerem — MASTER_PROMPT §9; decyzja koordynatora w PR-03C). Cokolwiek innego (brak, kilka,
      niejednoznaczne, poza zakresem, brak waluty) → `estimatedValue = currency = null`.
      **Doprecyzowanie względem AC3:** część ułamkowa z dokładnie 3 cyframi („1.500”,
      „1,500”) jest odrzucana — może być separatorem tysięcy, a błędny odczyt dałby wartość
      1000 razy za małą; więcej niż 4 cyfry też → `null` (bez zaokrąglania).
    - **Liniowość:** jeden skaner (`html-text.ts`), potem jedno przejście po segmentach na
      pole, zbierające ograniczoną ilość tekstu; wyrażenia regularne tylko na ograniczonych
      ciągach (prefiks 40 znaków, blok wartości). Testy na 1 000 000 znaków wrogiego wejścia.
- **Odrzucone alternatywy:** zapis kategorii MVP w bazie (zmiana słownika wymagałaby
  ponownego ingestu i zmieniałaby `content_hash`); słownik powiatów (BZP go nie potrzebuje);
  parser DOM/biblioteka HTML (nowa zależność; liniowy skaner wystarcza dla formularza BZP);
  przechowywanie `htmlBody` (rozmiar, dane osobowe, brak potrzeby).
- **Konsekwencje:**
  - `content_hash` ofert BZP się zmienia: ponownie pobrane wiersze stają się jednorazowo
    `updated` (D-016, uzupełnienie); terminy ustawione przez ogłoszenia o zmianie zostają
    (PR-03B AC4).
  - Etykiety muszą być osobnym segmentem (tak jest w zarejestrowanym formularzu); zmiana
    szablonu BZP (inna numeracja, etykieta i wartość w jednym elemencie) da `null` wartości i
    kontaktu, nigdy błędną wartość. Opis może wtedy być niepełny albo za długi: bez
    numerowanych etykiet ciągnie się do następnego nagłówka „SEKCJA …” albo do limitu
    10 000 znaków. Znacznik wewnątrz akapitu (np. `<strong>`) dzieli linię opisu na kilka
    linii — znane ograniczenie skanera.
  - Miejsce realizacji zamówienia (inne niż siedziba zamawiającego) i ogłoszenia o
    unieważnieniu pozostają poza zakresem.
  - **Wymagania dla PR-04** (przegląd właściciela PR #7; kryteria w `PR_PLAN.md`, PR-04):
    - powiat w profilu nigdy nie pasuje do oferty BZP (`location.county` zawsze puste), więc
      matching podaje w `reasons` jawny powód („źródło nie podaje powiatu”) — nie cichy brak
      dopasowania; inaczej klient z profilem tylko z powiatami nie dostaje alertów i nie wie
      dlaczego;
    - małe zamówienia (`SmallContractNotice`) nie mają CPV, więc słownik MVP daje dla nich
      zero kategorii (dane właściciela: 0 z 86 ogłoszeń z CPV, opis w 76 z 86) — matching
      musi dla nich używać słów kluczowych z tytułu i opisu (`comparableText`).
