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
