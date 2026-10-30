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
    pokazywała 966 ogłoszeń od 2026-10-29 do rana 2026-10-30). Pobieramy dwa typy:
    `ContractNotice` (krajowe ogłoszenia o zamówieniu poniżej progów UE, od 130 tys. zł) i
    `SmallContractNotice` („Ogłoszenie dotyczące zamówienia, dla którego nie ma obowiązku
    stosowania ustawy Pzp” — małe zamówienia, które zamawiający dobrowolnie publikują w BZP).
    Planowany przebieg: raz dziennie (cron w kolejnym PR), dzień publikacji = wczoraj.
- **API (zweryfikowane prawdziwymi zapytaniami):**
  `GET https://ezamowienia.gov.pl/mo-board/api/v1/notice?NoticeType=…&PublicationDateFrom=YYYY-MM-DD&PublicationDateTo=YYYY-MM-DD&PageSize=N[&SearchAfter=<objectId>]`.
  Wymagane: `PageSize` (1–500), `NoticeType`, obie daty; błędy to 400
  `application/problem+json`. Paginacja keyset: `SearchAfter` = `objectId` ostatniego rekordu
  poprzedniej strony, wyniki rosnąco; pusta tablica albo strona krótsza niż `PageSize` = koniec
  (`PageNumber` jest ignorowany, brak nagłówków paginacji). Odpowiedź: tablica JSON
  (`application/json; charset=utf-8`, bez kompresji, z `Content-Length`) — działa ze stałymi
  nagłówkami SafeHttpClient (`Accept: */*`, GET), więc D-014 nie wymaga zmian.
- **Mapowanie** (`src/sources/bzp/adapter.ts`):
  `externalId` = `noticeNumber` (np. `2026/BZP 00507107/01`); `sourceUrl` = strona ogłoszenia
  `https://ezamowienia.gov.pl/mo-client-board/bzp/notice-details/id/{objectId}` (`objectId` to
  identyfikator ogłoszenia — zweryfikowane `Board/GetNoticeDetailsById`; walidowany wyrażeniem
  `^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`); `title` = `orderObject`
  ze zwiniętymi białymi znakami; `issuerName` = `organizationName`; `publishedAt` =
  `publicationDate`; `deadline` = `submittingOffersDate` (lub `null`); `categories` = kody CPV
  wyciągnięte z `cpvCode` (`"37520000-9 (Zabawki),…"` → `["37520000-9", …]`, `""` → `[]`);
  `location` = **siedziba zamawiającego** (`organizationCity` + województwo ze statycznej mapy
  kodów `organizationProvince` `PL02`…`PL32` zgodnej z oficjalnym słownikiem
  `/mo-board/api/v1/glossary?glossaryType=province`; nieznany kod → brak województwa), a nie
  miejsce realizacji — lista API go nie podaje. `description`, `contact`, `estimatedValue`,
  `currency` = `null`: lista API nie ma dla nich pól strukturalnych; opis i kontakt (np.
  e-mail zamawiającego), a czasem wartość zamówienia (np. „Wartość zamówienia: 181300 PLN”)
  bywają tylko w `htmlBody` (pełny HTML ogłoszenia, którego parsowanie jest poza zakresem
  PR-02 — nie przechowujemy go; kandydat na „HTML → tekst” w PR-03). `status`: `open`, gdy termin > `fetchedAt`; `closed`, gdy termin minął;
  `unknown` bez terminu. Rekord z niepoprawnym polem jest odrzucany z powodem — nic nie jest
  zgadywane ani przycinane.
- **Odrzucone alternatywy:** Baza Konkurencyjności (funduszeeuropejskie) — aplikacja SPA z
  wewnętrznym API (`/api/announcements/search`), bez udokumentowanego publicznego API w
  regulaminie, Keycloak; kandydat na kolejne źródło. Wewnętrzny endpoint e-Zamówień
  `Board/Search` — nieudokumentowany, a jego rekordy zawierają `userId`.
- **Konsekwencje:**
  - jedno żądanie na stronę (25 rekordów, `htmlBody` ma ~5–45 KB, więc odpowiedź jest daleko
    poniżej limitu 5 MB), max 40 stron i limit rekordów — oba **osobno dla każdego typu
    ogłoszenia**, żeby liczne `ContractNotice` nie wyparły małych zamówień
    (`SmallContractNotice` pobierane jako drugie); przebieg zwraca więc najwyżej 2 × limit
    rekordów. Osiągnięcie limitu jest raportowane, nie ciche. Przebieg ma limit czasu (`AbortSignal`,
    `source:preview`: 5 min);
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
