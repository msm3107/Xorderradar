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
- **Konsekwencje:** brak nieużywanych zależności i otwartych portów do PR-06. Rozstrzygnięte
  w PR-06A: `node:http` bez frameworka (D-025).

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

- **Status:** Accepted (PR-05)
- **Decyzja:** wysyłka przez SMTP (niezależnie od dostawcy), domyślny tryb `test` bez
  prawdziwej wysyłki (`EMAIL_MODE=test`: plik `.eml` + kopia `.json` w `EMAIL_OUTBOX_DIR`).
  Tryb `smtp` tylko jawnie (`EMAIL_MODE=smtp` + `EMAIL_FROM` + `SMTP_URL`) i — wobec
  prawdziwych odbiorców — po potwierdzeniu właściciela (SECURITY §10, §14).
- **Biblioteka:** `nodemailer` 10.1.7 (przypięta; opublikowana 2026-10-18, typy w pakiecie,
  bez zależności runtime). Uzasadnienie: klient SMTP (STARTTLS, AUTH, timeouty, kody
  odpowiedzi) i budowa MIME z kodowaniem nagłówków (ochrona przed header injection,
  SECURITY §10) to za dużo, żeby pisać samemu. 10.1.7 zamiast starszej: wersje `< 10.1.4`
  mają trzy podatności moderate w `addressparser` (GHSA-m943-m63m-w62w, GHSA-85x2-q946-cp5h,
  GHSA-8c8m-p3m8-cjg8); żadna wersja bez nich nie miała w chwili wyboru pełnych 2 tygodni
  (SECURITY §13 — „preferowane”), więc wybrana najnowsza poprawkowa. Adres odbiorcy i
  nadawcy przekazujemy jako obiekty `{name, address}` (bez parsowania tekstu adresu).
- **Konfiguracja transportu:** `smtps://` = TLS od początku (domyślny port 465), `smtp://` =
  STARTTLS **wymagany** (`requireTLS`, domyślny port 587; serwer bez STARTTLS → błąd przed
  AUTH i kopertą). TLS ≥ 1.2, weryfikacja certyfikatu zawsze włączona; `SMTP_URL` bez
  ścieżki, zapytania i fragmentu (nodemailer czytałby z zapytania opcje, np.
  `tls.rejectUnauthorized`), dane logowania tylko jako para. Logger i debug nodemailera
  wyłączone, dostęp do plików i URL-i w treści wyłączony, jeden odbiorca na wiadomość.
  Timeouty: połączenie 10 s, powitanie 10 s, gniazdo 30 s, DNS 10 s. Szczegóły i
  idempotencja — D-024.

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
    przestawiać IPv4 na początek — wybór adresu robimy sami); odrzucamy host, jeśli **którykolwiek**
    adres jest zablokowany; łączymy się
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
    do PR-03B nie pobierał. Tego dnia było ich co najmniej 100 (`PageSize=100` zwróciło pełną
    stronę; dla
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
      wspólny — `src/sources/normalize/html-text.ts`, zachowanie bez zmian, D-022): liniowy przegląd
      tekstu
      między znacznikami (komentarze, `<script>`, `<style>` i atrybuty pomijane; kilka encji
      dekodowanych; normalizacja NFC tylko segmentów ≤ 256 znaków — jest kwadratowa w ciągu
      znaków łączących, a dłuższy segment nie może być etykietą ani datą, więc zostaje
      nieznormalizowany i przegląd pozostaje liniowy). Niedomknięty znacznik, komentarz, `<script>`
      albo `<style>` w dowolnym
      miejscu → odrzucenie `invalid source fields: htmlBody` (treść ucięta lub zepsuta — nie
      wiadomo, czy przeczytano całe ogłoszenie, więc nie ma też pominięcia „brak zmiany”).
      Rodzaj zmienianego
      ogłoszenia = tekst po etykiecie „3.1.) Nazwa zmienianego ogłoszenia:”; zmiana stosowana
      tylko, gdy to dokładnie „Ogłoszenie o zamówieniu” (inaczej pominięcie
      `not_contract_notice_change`). Zmiana terminu = blok po nagłówku „3.4.1.)” z etykietą
      „8.1. Termin składania ofert”; nowa wartość = tekst po „Po zmianie:” w formacie
      `YYYY-MM-DD HH:MM` czasu Europe/Warsaw, przeliczony na UTC
      (`src/sources/normalize/warsaw-time.ts`, od PR-03C; wcześniej
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
- **Uzupełnienie (PR-08, D-030):** timeout źródła i dnia wynosi **15 min**: Baza
  Konkurencyjności czyta jedno ogłoszenie na żądanie (do 254 żądań na dzień, ~12,5 min). Dla
  BZP to średnio ~7 s na żądanie. Limit 1000 dotyczy w `bk` ogłoszeń na dzień i jest dodatkowo
  ograniczony do 250 (`BK_MAX_DETAILS_PER_DAY`).

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
  w API). Od PR-08 timeout wynosi 15 min (D-030): najgorszy przypadek to 31 × 15 min na
  źródło.

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
    (konserwacja oświetlenia publicznego i sygnalizacji świetlnej) należy też do `serwis` przez
    `50`. Celowo poza
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

## D-023 — Matching: reguły dopasowania, profil i `match:preview`

- **Status:** Accepted (PR-04, decyzje koordynatora z briefu PR-04)
- **Kontekst:** ARCHITECTURE §4.4 dawała punkty startowe i pytanie o zależność `matching` od
  helperów `src/sources/normalize/` (D-022). PR_PLAN PR-04 wymaga wyniku deterministycznego
  i w pełni wyjaśnionego (AC1), wykluczeń (AC2), braku lokalizacji ≠ zgodność (AC3), braku
  LLM/sieci (AC4), jawnego „źródło nie podaje powiatu” (AC5), dopasowania ofert bez CPV po
  słowach kluczowych (AC6) i porównania powiatów z decyzją o wariantach „m. st.” (AC7).
- **Decyzja:**
  - **Moduł `src/matching/`**: `matchOpportunity(offer, profile): MatchResult` (`match.ts`,
    czyste, bez I/O, zegara, sieci i LLM), tokenizacja i reguła odmiany (`text.ts`), polskie
    opisy powodów (`format.ts`). Wejście to `Pick` z `Opportunity` (`title`, `description`,
    `categories`, `location`) i `CompanyProfile` (kategorie, słowa, województwa, powiaty).
    Wyniki nie są zapisywane (bez tabeli `matches`; zapis dopiero z doręczeniami w PR-05).
  - **Zasada zależności (wyjątek od §2):** `matching` importuje tylko własne moduły,
    `domain` i czyste helpery `src/sources/normalize/` — nic z `infrastructure`, adapterów
    źródeł, wbudowanych modułów Node ani pakietów. Pilnuje tego blok `no-restricted-imports`
    w `eslint.config.js` (allowlista ścieżek jednego segmentu, więc
    `../sources/normalize/../bzp/…` nie przechodzi; dynamiczny `import()` zostaje dla code
    review), przypięty testem `tests/matching-dependency-guard.test.ts`. Listy
    `MVP_CATEGORIES` i `VOIVODESHIPS` przeniesione do `src/domain/vocabulary.ts` (domena
    waliduje nimi profil i nie importuje nic ze `sources`); `cpv-categories.ts` i
    `regions.ts` re-eksportują je bez zmian dla dotychczasowych importów.
  - **Profil (schemat domeny):** `categories` wymagane, co najmniej jedna, wyłącznie z
    `MVP_CATEGORIES`; `voivodeships` wyłącznie kanoniczne nazwy 16 województw (front, np.
    `profile:create`, zamienia inne zapisy przez `normalizeVoivodeship`; nieznany zapis —
    odrzucony, ścieżka pola bez wartości); słowa kluczowe i wykluczające — każde musi
    zawierać literę lub cyfrę (inaczej nigdy nic nie dopasuje) i mieć najwyżej 10 tokenów
    (`MAX_KEYWORD_TOKENS`, liczone tą samą regułą co tokenizer — `keywordTokenCount`,
    test przypina zgodność z `tokenize`); `counties` zapisane jak
    podane (bez słownika powiatów, D-022), a `profile:create` odrzuca wpis, który nie jest
    nazwą powiatu (`countyKey` = `null`, np. „powiat”). Wiersz z bazy, który nie spełnia
    schematu (np. edytowany ręcznie), repozytorium odrzuca jako `DomainError`
    `invalid_stored_row` ze ścieżkami pól (bez wartości).
  - **`comparableText`** usuwa też znaki formatujące `\p{Cf}` (miękki łącznik U+00AD,
    zerowej szerokości, kierunku tekstu, U+FEFF) bez śladu, przed resztą kroków — słowo z
    miękkim łącznikiem U+00AD w środku („oświe-tlenie” z niewidocznym łącznikiem) zostaje
    jednym słowem; nadal liniowo (test).
    Uzupełnia D-022: U+FEFF i U+200B nie dają już spacji w tekście do porównań.
  - **Tekst:** obie strony przez `comparableText`, podział na tokeny po każdym znaku, który
    nie jest literą ani cyfrą (`[^\p{L}\p{N}]+`). Fraza z k tokenów pasuje do k kolejnych
    tokenów tekstu. Szukane w tytule, potem w opisie (może być `null`); powód podaje pole
    (słowa kluczowe: tytuł ma pierwszeństwo, chyba że trafienie w tytule przydzielono innemu
    słowu — wtedy opis; wykluczenia: zawsze najpierw tytuł). **Odmiana (prosta reguła):**
    token tekstu pasuje do tokenu
    słowa kluczowego, gdy jest równy albo — dla tokenu słowa kluczowego o długości ≥ 4 —
    zaczyna się od tematu = token bez jednej końcowej samogłoski (`aeiouy`, po
    `comparableText`). Token słowa kluczowego o długości ≥ 6 kończący się na „nie”/„cie” (po
    `comparableText`) pasuje też do tokenu tekstu równego mu bez końcowego „ie” — dopełniacz
    liczby mnogiej „-eń”/„-ęć”, w którym znika ostatnia samogłoska tematu: „szkolenie” →
    „szkoleń”, „oświetlenie” → „oświetleń”, „sprzątanie” → „sprzątań”, „zajęcie” → „zajęć”.
    Tylko równość, nigdy prefiks: jako prefiks „malowan” łapałby też imiesłów „malowane”, a
    „zarzadzan” — „zarządzanego”. Tokeny krótsze niż 4 („bhp”, „it”, „gaz”) i tokeny bez litery
    (liczby: „2024” ≠ „20245”) — tylko równe. Wykluczenia — ta sama reguła. Słowa o tym samym
    ciągu tokenów („Oświetlenie”, „oswietlenie”) liczą się raz, w kolejności profilu; tak
    samo słowo bez własnego dowodu: każde liczone słowo dostaje trafienie (ciąg tokenów tekstu),
    którego nie ma żadne inne liczone słowo — przydział jako maksymalne skojarzenie (ścieżki
    powiększające, słowa w kolejności profilu, trafienia: tytuł, potem opis, w kolejności
    tekstu; deterministyczne). „oświetlenie” i „oświetlenia” na jednym „Oświetlenie” dzielą
    jedyne trafienie — liczy się pierwsze, bez drugiego powodu i bez +10; „sala” i „salon” na
    „Remont salonu i sali” liczą się oba („salon” → „salonu”, „sala” → „sali”), tak samo „auto”
    i „automatyka” na „Automatyka i auto”. Trafienia na słowo są ograniczone do liczby słów
    profilu (słowo z tyloma trafieniami zawsze ma wolne, więc limit nie zmienia wyniku; ≤ 100 ×
    100). Pole w powodzie to pole przydzielonego trafienia. Wykluczenia bez tego: każde
    znalezione −100. **Znane ograniczenia:** temat zmieniający się wewnątrz słowa nie jest
    rozpoznawany („kabel” ≠ „kable”/„kabli”, „żłobek” ≠ „żłobka”, „węgiel” ≠ „węgla”);
    temat może zaczynać inne słowo („sala” → „salon”, „lampa” → „lampart”) — dotyczy to też
    słów wykluczających, gdzie skutkiem jest cichy brak alertu (wykluczenie „auto” usuwa
    też „Automatyka budynkowa”); dopełniacz liczby mnogiej powstaje tylko z formy „-nie”/„-cie”
    samego słowa kluczowego — słowo „szkolenia” nie pasuje do „szkoleń”, a „danie” (5 znaków)
    do „dań”; rzeczowniki na „-cie”, których bezokolicznik ma tę samą postać co dopełniacz
    liczby mnogiej (np. „-ycie”, „-icie”, „-ucie”, „-ście”: pokrycie/pokryć, zatrucie/zatruć,
    przejście/przejść, szycie/szyć), pasują też do bezokolicznika — „pokrycie” do „pokryć
    (koszty)”, „przejście” do „przejść (weryfikację)”. Dla słowa kluczowego to wąskie, pokrewne
    nadmiarowe dopasowanie, akceptowane; dla słowa wykluczającego (np. „pokrycie”,
    „przejście”) opis z „pokryć koszty” albo „przejść weryfikację” po cichu usuwa trafną
    ofertę — ten sam cichy brak alertu co przy tematach wyżej — więc takich słów jako
    wykluczeń używać ostrożnie. **Koszt:** tokeny tekstu × tokeny słowa na każde słowo,
    ograniczone schematami (tytuł ≤ 1 000, opis ≤ 10 000 znaków, słowo ≤ 100 znaków i ≤ 10
    tokenów, ≤ 100 słów kluczowych i ≤ 100 wykluczających). Bez wzorców z nawrotami, więc
    tekst ze źródła sam niczego nie wydłuża; najgorszy przypadek wymaga też spreparowanego
    profilu: 200 słów po 10 tokenów („a a … b”) na opisie „a a a …” z 10 000 znaków —
    zmierzone ok. 50 ms na parę oferta × profil, czyli ok. 50 s dla `match:preview` z 1 000
    ofert; realny maksymalny profil (200 słów po 2 tokeny) × 1 000 ofert maksymalnej
    długości — ok. 3 s. **Uwaga dla PR-05:** digest liczy klienci × oferty, więc ten koszt
    mnoży się przez liczbę klientów — zmierzyć na danych pilota, zanim doda się
    optymalizację (np. tokenizacja oferty raz na ofertę zamiast raz na parę).
  - **Punkty i próg** (`POINTS`, `MATCH_THRESHOLD`): kategoria +40 (raz, nawet przy kilku
    kategoriach), słowo kluczowe +30, gdy co najmniej jedno liczone słowo ma przydzielone
    trafienie w tytule, a +15 (`keywordInDescription`), gdy wszystkie przydzielone trafienia
    są w opisie (punkty dostaje pierwsze słowo z trafieniem w tytule, a bez takiego —
    pierwsze liczone słowo; pozostałe mają powód z 0 pkt; **zmiana PR-09**, niżej), więcej
    niż jedno różne słowo +10, region +20, każde słowo wykluczające −100.
    `matched = score ≥ 50 && brak wykluczenia && region ≠ niezgodny`. Uzasadnienie:
    kategoria + region = 60 przechodzi; przy nieznanym regionie potrzeba kategorii i słowa
    (70 z tytułu, 55 z opisu); słowo w tytule + zgodny region = 50 przechodzi; samo słowo z
    opisu + zgodny region (35) — nie; dwa różne słowa tylko z opisu + zgodny region
    (15 + 10 + 20 = 45) — nie; samo słowo przy nieznanym regionie (30 / 15) — nie.
    **Zmiana PR-09 (2026-11-06, kalibracja na danych pilota):** wcześniej słowo dawało +30
    niezależnie od pola, więc samo słowo z opisu + zgodny region (50) przechodziło. W
    przeglądzie pilota ciągnik i koparka trafiały do profilu elektrycznego przez
    „oświetlenie”/„elektryczne” w opisie wyposażenia. Opis wymienia wiele rzeczy pobocznych,
    tytuł mówi, czego dotyczy zamówienie — stąd niższa waga opisu, bez zmiany progu.
    Przykłady: „Dostawa ciągnika” z „oświetlenie” w opisie, zgodny region → 35, brak
    dopasowania; „Modernizacja oświetlenia ulicznego”, zgodny region → 50, dopasowanie;
    kategoria + słowo z opisu, region nieznany → 55, dopasowanie; kategoria + region → 60;
    kategoria + słowo w tytule, region nieznany → 70. Powód podaje pole jak wcześniej
    („słowo: oświetlenie (opis)”), `match:preview` — wynik w punktach. Do tego dwie pomoce
    operatora: `profile:create` z słowami kluczowymi i bez słów wykluczających wypisuje
    podpowiedź (niżej), a podsumowanie `match:preview` liczy dopasowania bez słowa
    kluczowego (niżej). **Koszt:** oferta bez CPV (np. małe zamówienie BZP) nie ma punktów
    za kategorię, więc słowo tylko z opisu nie przechodzi nawet przy zgodnym regionie (35,
    z drugim słowem 45) — dla ofert bez CPV słowo kluczowe musi być w tytule; wybieraj słowa,
    które pojawiają się w tytułach.
  - **Kategorie:** `mvpCategoriesForCpv(offer.categories)` ∩ kategorie profilu → +40 z listą
    kategorii i kodów CPV, które je dały. Oferta z kategoriami MVP spoza profilu → „kategoria:
    niezgodna” (0). Brak kodu dającego kategorię MVP → „kategoria: ogłoszenie nie podaje
    kodu CPV” (do PR-05: „brak CPV — kategoria niesprawdzalna”) albo „CPV spoza słownika
    (…) — kategoria niesprawdzalna” (0): o wyniku decydują słowa kluczowe (AC6).
  - **Region (trzy stany):** profil bez województw i powiatów → +20 „region: bez
    ograniczeń”. Kolejność: (1) profil ma województwa, a znane województwo oferty jest
    spoza nich → niezgodny (0, nigdy dopasowanie), **niezależnie od powiatu** — powiaty
    nigdy nie poszerzają profilu z województwami („region: poza profilem (oferta:
    śląskie)”); (2) znany powiat oferty na liście powiatów profilu → zgodny (+20) przez
    powiat; (3) województwo oferty na liście → zgodny przez województwo. W obrębie
    województwa z listy decyduje więc województwo: **zawężanie powiatem nie jest
    zaimplementowane** (żadne źródło nie podaje jeszcze powiatu; decyzja właściciela, gdy
    się pojawi) — powiat profilu działa sam tylko przy nieznanym województwie oferty albo w
    profilu z samymi powiatami (wtedy znany powiat spoza listy → niezgodny). Inaczej
    nieznany (0) z brakującą częścią: brak `location` → „oferta nie podaje lokalizacji”
    (AC3); profil z samymi powiatami i oferta bez powiatu → „źródło nie podaje powiatu”
    (AC5; BZP); profil z województwami i oferta bez województwa → „źródło nie podaje
    województwa” (albo „… województwa ani powiatu”). Znany powiat spoza profilu przy
    nieznanym województwie powód też wymienia: „region: nieznany — powiat gliwicki poza
    profilem, źródło nie podaje województwa” (wewnątrz powodu przecinek, bo „; ” rozdziela
    powody). **Konsekwencja dla BZP** (BZP nie podaje powiatu): profil z województwami (z
    powiatami lub bez) dostaje tylko oferty BZP ze swoich województw; profil z samymi
    powiatami dostaje oferty BZP z całego kraju jako „nieznane” (kategoria i słowo, 70 pkt,
    wystarczą) — dlatego `profile:create` ostrzega przed takim profilem. Województwo oferty
    przez `normalizeVoivodeship`; nierozpoznany zapis liczy się jak niepodany. Wpis profilu,
    który się nie normalizuje (stary wiersz), nigdy niczego nie dopasowuje, ale nadal liczy
    się jako używany wymiar: profil nie staje się przez to „bez ograniczeń”, a oferta z
    podanym tym wymiarem nie jest przez ten wpis zgodna.
    **Zmiana 2026-10-31** (przegląd właściciela na żywych danych BZP: 586 ofert × 6
    profili): wcześniej województwa i powiaty łączyło czyste **LUB**, a znane województwo
    spoza profilu przy braku powiatu dawało „nieznany”. Dodanie jednego powiatu poszerzało
    więc profil na cały kraj (mazowieckie + powiat warszawski zachodni: 36 dopasowań, w tym
    20 spoza mazowieckiego, wobec 16/0 dla samego mazowieckiego). Decyzja właściciela:
    znane województwo spoza profilu → niezgodny niezależnie od powiatu. Bez danych powiat →
    województwo (żadne źródło nie podaje dziś powiatu).
  - **Powiaty (AC7):** po obu stronach `countyKey(x)` = `comparableText(normalizeCounty(x))`,
    następnie spacje po kropce usunięte („m. st.” = „m.st.”), prefiks „m.st.” / „miasto
    stołeczne” i sufiks „(miasto na prawach powiatu)” usunięte. Czyli „m. st. Warszawa” =
    „m.st. Warszawa” = „miasto stołeczne Warszawa” = „Warszawa” oraz „Kraków (miasto na
    prawach powiatu)” = „Kraków”; powiat ziemski „krakowski” ≠ miasto „Kraków”.
  - **Status i termin** nie są sprawą matchingu: `match:preview` pomija oferty `closed` i
    `cancelled`, a oferty po terminie tylko przesuwa na koniec (z dopiskiem); termin
    filtruje digest (PR-05).
  - **Komendy operatorskie** (`src/profile-commands.ts`, routing w `src/cli.ts`):
    - `profile:create <file.json>`: plik zwykły (otwarty z `O_NONBLOCK`, `fstat`), ≤ 64 KiB
      sprawdzone przed parsowaniem (i ograniczony odczyt limit + 1 B), UTF-8 (`fatal`),
      `JSON.parse` ze stałym komunikatem (komunikaty V8 cytują wejście), walidacja
      `companyProfileInputSchema`. Błąd pliku lub profilu → exit 2 (część wywołania,
      sprawdzana przed konfiguracją i bez otwierania bazy) ze ścieżkami pól (najwyżej 5,
      reszta policzona) i opisem błędu: „missing” dla brakującego pola, „not an allowed
      value” dla spoza słownika (z listą dozwolonych kategorii / przykładem województw tylko
      przy tych polach), „expected <typ>” (tylko typ ze schematu) dla złego typu, stały
      komunikat zoda dla długości i e-maila oraz własne
      komunikaty schematu — nigdy z wartościami; nieznany klucz → „unknown field” z nazwą
      klucza (z pliku operatora; przez `cleanText`, ≤ 40 znaków, najwyżej 5 kluczy) i listą
      dozwolonych pól; e-mail już użyty → exit 1; błąd bazy →
      stały powód. Wypisuje `{"status":"ok","id":…}`. Po utworzeniu (kod 0, profil
      zapisany) ostrzeżenia po polsku na stderr (stdout zostaje jedną linią JSON;
      `profileWarnings`, od 2026-10-31 po przeglądzie właściciela): powiaty bez województw
      (BZP nie podaje powiatu → oferty z całego kraju; dodaj województwo); słowa, których
      wszystkie tokeny to słowa krótsze niż `MIN_INFLECTED_TOKEN_LENGTH` (4) — pasuje tylko
      dokładna forma („gaz” ≠ „gazowy”/„gazu”; rada: jeśli słowo się odmienia, dodać obok
      dłuższy temat, „gaz” + „gazow”), wymienione przez `cleanText`, ≤ 40 znaków,
      najwyżej 5; brak słów kluczowych (małe zamówienia BZP bez CPV nigdy nie pasują). Reguła
      tematu bez zmian (najpierw kalibracja). Od PR-09: słowa kluczowe bez słów
      wykluczających → jedna linia „Wskazówka: …” z wąskimi przykładami („ciągnik”,
      „koparka”, „dostawa paliwa”) i uwagą, że wykluczenie działa też na opis (sprawdzić
      wynik w `match:preview`) — profil nie jest zmieniany, kod wyjścia bez zmian. Bez
      szerokich przykładów („pojazd”, „dostawa”): wykluczenie pasuje po temacie w tytule i
      opisie, więc usunęłoby własne przetargi elektryka („dostawą i montażem”, „40
      pojazdów”).
    - `profile:show <id>`: profil jako JSON; nieznany id → exit 1.
    - `match:preview <profileId> [--limit N]`: oferty nie `closed`/`cancelled`, od
      najnowszych (`published_at DESC NULLS LAST, id`; domyślnie 100, maks. 1000,
      parametryzowane zapytanie `listMatchCandidates`), dopasowane posortowane po terminie
      (rosnąco, brak na końcu), potem wyniku; oferty z terminem przed „teraz” (zegar
      wstrzykiwany, `matchOpportunity` zostaje czyste) — za wszystkimi pozostałymi, w tej
      samej kolejności, z dopiskiem „(po terminie)”: status w bazie może nie nadążać za
      terminem, więc oferta nie znika z podglądu. Każda z wynikiem, tytułem, zamawiającym,
      terminem (czas Europe/Warsaw), linkiem i powodami; na końcu „dopasowane X z Y”, a od
      PR-09, gdy są, „…, w tym N bez słowa kluczowego (tylko kategoria i region)” (dopasowane
      bez żadnego powodu słowa kluczowego — pokazuje, ile daje sama kategoria). Powody w
      podglądzie zostają z kluczami kategorii (narzędzie operatora); etykiety
      (`CATEGORY_LABELS`, przeniesione do `src/domain/vocabulary.ts`) widzi klient w
      digeście i na `/dopasowania` (`formatReasons(…, { categoryLabels })`). Bez
      danych kontaktowych; tekst ze źródła przez `cleanText` (znaki sterujące nie trafiają
      do terminala). Profil nieaktywny też, z informacją, że jest nieaktywny. Zapisany
      wiersz oferty niezgodny ze schematem (`invalid_stored_row`) jest pomijany: ostrzeżenie
      w logu (id wiersza i ścieżki pól, bez wartości), w podsumowaniu „…, pominięto N
      nieprawidłowy wiersz / nieprawidłowe wiersze / nieprawidłowych wierszy”, kod 0.
      Pominięte wiersze liczą się do `--limit` (limit dotyczy odczytanych wierszy), więc
      podgląd może pokazać mniej ofert niż N — ile pominięto, mówi podsumowanie.
      Nieprawidłowy wiersz profilu nadal kończy komendę kodem 1.
- **Odrzucone alternatywy:** stemmer/słownik odmiany (nowa zależność, nadmiar dla MVP);
  dopasowanie podciągów (fałszywe trafienia w środku słów); przeniesienie helperów
  normalizacji do wspólnego katalogu (więcej zmian niż przeniesienie dwóch list); region
  nieznany traktowany jak zgodny (łamie AC3) albo jak niezgodny (cichy brak alertów przy
  BZP, AC5); tabela wyników dopasowania (PR-05).
- **Konsekwencje:** progi i punkty są punktem startowym do kalibracji w pilocie (zmiana bez
  migracji). Profile zapisane wcześniej z pustymi kategoriami, niekanonicznymi
  województwami lub słowem dłuższym niż 10 tokenów są odrzucane przy odczycie
  (`invalid_stored_row`) — do poprawienia ręcznie. `updateCompanyProfile` waliduje wynik w
  tej samej transakcji co `UPDATE … RETURNING`, więc nieudana zmiana takiego wiersza jest
  wycofana i niczego nie zmienia.

## D-024 — `digest`: wybór ofert, idempotencja i niepewne wysyłki

- **Status:** Accepted (PR-05, decyzje koordynatora z briefu PR-05)
- **Kontekst:** PR_PLAN PR-05: jeden e-mail na profil dziennie, tylko z nowymi dopasowaniami
  (AC1: bez duplikatów przy ponownym uruchomieniu), bez ofert po terminie (AC2), dane ze
  źródeł escapowane (AC3), tryb `smtp` tylko jawnie, testy bez prawdziwych maili (AC4).
  Jeden proces + PostgreSQL + cron (D-001) — bez kolejki.
- **Decyzja:**
  - **Komenda** `digest [--dry-run] [--profile <profileId>]` (`src/notifications/run.ts`,
    routing w `src/cli.ts`). Kolejność kontroli: argumenty (kod 2) → konfiguracja, w tym
    e-mail (`loadEmailConfig`, kod 1 przed otwarciem bazy i przed jakąkolwiek wysyłką; błąd
    wymienia tylko nazwy zmiennych) → baza (oczekujące migracje → kod 1) → blokada. „Dziś” =
    dzień kalendarzowy w Polsce w chwili `now` (`warsawDay`), zapisywany jako
    `deliveries.digest_date`.
  - **Kandydaci** (`listDigestCandidates`, jedno zapytanie na przebieg, wspólne dla
    profili): status nie `closed`/`cancelled`, `deadline IS NULL OR deadline >= now` (termin
    nieznany zostaje i w e-mailu jest „nie podano”), `first_seen_at` w ostatnich 7 dniach
    (`DIGEST_NEW_DAYS`), `deadline ASC NULLS LAST, id`, najwyżej 10 000
    (`DIGEST_CANDIDATE_LIMIT`; osiągnięty → `candidatesTruncated` i ostrzeżenie w logu).
    Status w bazie może nie nadążać za terminem (STATE), więc o „po terminie” decyduje
    `deadline` wobec `now`. Wiersz niezgodny ze schematem jest pomijany (log: id i ścieżki
    pól; licznik `skippedInvalidRows`).
  - **Profile:** wszystkie aktywne (`created_at, id`); nieprawidłowy wiersz profilu →
    `invalid_profile` (kod 1, pozostałe profile obsłużone). Nieaktywny profil nie dostaje
    niczego (`--profile` nieaktywnego → `inactive`, kod 0; nieznany → `not_found`, kod 1). E-mail
    jest w profilu wymagany (schemat), więc profil bez adresu nie istnieje.
  - **Wybór na profil:** `matchOpportunity` (D-023) na każdym kandydacie; z dopasowanych
    odpadają oferty z wierszem `deliveries` tego profilu i transportu — chyba że `failed` z
    `attempts < 3` (`DIGEST_MAX_ATTEMPTS`). Do e-maila trafia najwyżej 50
    (`DIGEST_MAX_ITEMS`) o najbliższym terminie; reszta (`overflow`) nie jest rezerwowana,
    e-mail podaje jej liczbę, a kolejne dni ją wyślą, jeśli dalej spełnia warunki (7 dni,
    termin). Nic do wysłania → `nothing_new`, bez e-maila.
  - **Tabela `deliveries`** (migracja `0005_deliveries`, ARCHITECTURE §5): jeden wiersz na
    (profil, oferta, transport), `status` `pending`/`sent`/`failed`, `attempts`, `error_code`
    (tylko kod), `digest_date`, `sent_at`. Transport (`test`/`smtp`) jest częścią klucza, więc
    próby w trybie `test` nie blokują późniejszej prawdziwej wysyłki.
  - **Idempotencja (AC1), najwyżej raz:**
    1. Profil, który ma dziś wiersz `sent` → `already_sent_today` (nic nie jest liczone ani
       wysyłane); dziś `pending` → `pending_today` (wynik dzisiejszej wysyłki nieznany).
    2. **Rezerwacja przed wysyłką** (`claimDeliveries`, jedna transakcja, zatwierdzona przed
       połączeniem z serwerem): dla nowych ofert `INSERT … status 'pending'` z
       `ON CONFLICT ON CONSTRAINT deliveries_profile_opportunity_transport_key DO NOTHING`
       i `RETURNING`, dla ponawianych
       `UPDATE … SET status = 'pending' WHERE status = 'failed' AND attempts < 3 RETURNING`.
       E-mail zawiera tylko oferty, które ta transakcja zwróciła.
    3. Wysyłka, potem `markDeliveries`: `sent` (`sent_at`, `attempts + 1`) albo `failed` z
       kodem (`attempts + 1`; przy błędzie konfiguracji lub nieosiągalnym serwerze bez
       zwiększania `attempts`, niżej) — tylko wiersze nadal `pending`.
    4. Wynik **niepewny** (zerwane połączenie lub timeout gniazda po rozpoczęciu sesji —
       serwer mógł przyjąć wiadomość) albo awaria procesu/bazy między wysyłką a zapisem →
       wiersze zostają `pending` i **nigdy nie są wysyłane ponownie** automatycznie (status
       `uncertain`, kod 1, licznik `uncertain` w kolejnych przebiegach i linia
       `Digest: N deliveries are pending …` na stderr w każdym przebiegu, który je widzi — bez
       zmiany kodu wyjścia), a przebieg się zatrzymuje (niżej). Wolimy zgubić jeden e-mail
       niż wysłać go dwa razy.
    5. Jeden `digest` naraz: sesyjny advisory lock `7206120309002` (`DIGEST_LOCK_KEY`, wzór
       D-019, wspólny helper `src/infrastructure/db/advisory-lock.ts`); zajęta → `skipped`,
       kod 0, nic nie wysłano; utrata → kolejne profile `not_run`, kod 1. Także `--dry-run`
       bierze blokadę (spójny odczyt).
  - **Klasy błędów wysyłki** (`classifySmtpError`, `src/notifications/sender.ts`; tylko z
    `responseCode`, `code`, `originalCode`, `timeoutType` i `command` nodemailera — etap SMTP —
    nigdy z treści komunikatu ani odpowiedzi serwera):
    - `transient` — odpowiedź 4xx (poza 421) na `MAIL FROM`, `RCPT TO`, `DATA`, odpowiedź
      pozostała przy zamknięciu połączenia (`ECONNECTION` z `command` `CONN`) lub nieznany
      etap: do 2 ponowień w przebiegu po 2 s i 10 s, potem `failed` (`attempts + 1`);
    - `permanent` — 5xx na `RCPT TO`/`DATA` lub pozostała przy zamknięciu połączenia,
      odrzucenie koperty przez nodemailera przed wysłaniem (`EENVELOPE` z `command` `API` —
      nie da się go odróżnić od złego nadawcy, ale `EMAIL_FROM` jest walidowany przy starcie)
      i inne nierozpoznane: `failed` (`attempts + 1`) od razu;
    - `unreachable` — serwer nieosiągalny, nic nie wysłano: DNS, odmowa połączenia, timeout
      połączenia, powitania lub STARTTLS, odpowiedź 4xx na powitanie (`EPROTOCOL` z `CONN`)
      albo na `EHLO`/`HELO`/`LHLO` (z każdym kodem nodemailera — przy wymaganym STARTTLS
      odrzucony `EHLO` przychodzi jako `ECONNECTION`); albo serwer zamyka
      sesję — 421 na dowolnym etapie (RFC 5321 4.2): ponawiane w przebiegu jak `transient`;
      gdy nadal → jak `setup`;
    - `setup` — konfiguracja lub serwer odrzuca każdą wiadomość: `EAUTH` (każda odpowiedź
      na `AUTH`, brak danych logowania), `ETLS` (w tym odmowa STARTTLS 454/530), błędy
      certyfikatu/uzgadniania TLS przy `smtps`, 5xx na powitanie (`EPROTOCOL` z `CONN`), na
      `EHLO`/`HELO`/`LHLO` (każdy kod nodemailera) lub na `MAIL FROM` (odrzucony
      `EMAIL_FROM`), niezapisywalny outbox (tryb `test`): **bez ponawiania**;
    - `uncertain` — zerwane połączenie bez odpowiedzi (`ESOCKET`, `ECONNECTION`,
      `ECONNRESET`, `EPIPE`, timeout gniazda; także `EHOSTUNREACH`/`ENETUNREACH`, które
      nodemailer zgłasza tak samo przy połączeniu i w trakcie sesji): punkt 4. `ECONNECTION`
      bez kodu odpowiedzi zostaje `uncertain` także wtedy, gdy zdarzył się przed wysłaniem
      wiadomości (strona ostrożna) — operator rozstrzyga według procedury dla `pending`
      poniżej.
    - Odpowiedź 4xx/5xx pozostała przy zamknięciu połączenia (`ECONNECTION` z `command`
      `CONN`) jest klasyfikowana po kodzie (`transient`/`permanent`), nie jako `setup` —
      celowo: może być odpowiedzią na treść wiadomości, której nie wolno wziąć za błąd
      konfiguracji. Koszt: serwer, który przy powitaniu zamyka połączenie z odpowiedzią
      błędu, zużywa próby (421 nadal → `unreachable`).
  - **Zatrzymanie przebiegu:** błąd `setup`, `unreachable` (po ponowieniach) lub `uncertain`
    nie dotyczy jednej wiadomości — powtórzyłby się dla każdego profilu (np. złe hasło: N
    nieudanych logowań na przebieg) albo zostawiłby każdy profil z nieznanym wynikiem.
    Przebieg kończy się na pierwszym takim błędzie: wiersze bieżącego profilu → `failed` z
    kodem **bez zwiększania `attempts`** (przy `uncertain` zostają `pending`), pozostałe
    profile → `not_run` (bez wierszy i bez prób), `errorCode` podsumowania
    `send_setup_failed` / `send_server_unreachable` / `send_outcome_unknown`, komunikat
    `Digest stopped (…)`, kod 1. Po naprawie konfiguracji kolejny przebieg (także tego samego
    dnia) wyśle wszystkie oferty — zepsuta konfiguracja nie zużywa limitu prób.
    `transporter.verify()` przed przebiegiem nie jest potrzebne: pierwsza wysyłka pełni tę
    rolę i nie dodaje osobnego logowania.
  - **Ponawianie w kolejnych przebiegach:** `failed` jest ponawiany przez kolejne przebiegi
    (także tego samego dnia — dzisiejszy `failed` nie blokuje profilu), aż `attempts` = 3
    (liczone na przebieg, nie na próbę w przebiegu); potem oferta nie jest już wysyłana temu
    profilowi.
  - **Procedura operatora dla `pending`** (`uncertain`/`pending_today`; od PR-09 komendy
    zamiast ręcznego SQL, `src/cli.ts` + `deliveries-repository.ts`):
    `deliveries:pending` wypisuje jedną linię JSON `{"status":"ok","pending":[…],
"truncated":…}` — grupy wierszy `pending` na profil, transport i dzień (`profileId`,
    `transport`, `digestDate`, `offers`, `oldestCreatedAt`), od najstarszego dnia, najwyżej
    1 000 grup (`PENDING_DELIVERIES_MAX_GROUPS`, więcej → `truncated: true`); tylko
    identyfikatory, daty i liczby, bez adresów i tytułów; bez blokady (sam odczyt). Operator
    sprawdza log serwera SMTP / skrzynkę wysłanych (tryb `test`: `EMAIL_OUTBOX_DIR`) dla
    profilu i daty, potem `deliveries:resolve <profileId> --sent|--failed [--date
YYYY-MM-DD] [--transport test|smtp]`: `--sent` (doręczono) → wiersze `sent`, `sent_at = now()`,
    `attempts + 1`, `error_code` pusty; `--failed` (nie doręczono) → wiersze usunięte, więc
    kolejny digest tym samym transportem wyśle te oferty jak nowe, jeśli nadal się kwalifikują
    (warunki kandydata: RUNBOOK → „Wysyłki niepewne”).
    Zmieniane są wyłącznie wiersze `pending` wskazanego profilu w jednym transporcie i — z
    `--date` — tego dnia. Transport: `--transport`, domyślnie transport bieżącego `EMAIL_MODE`
    (jak `digest`); czytane jest samo `EMAIL_MODE` (`loadEmailMode`, ten sam schemat), bez
    `EMAIL_FROM`/`SMTP_URL`, błędne → kod 1 przed otwarciem bazy. (Przegląd właściciela PR-09:
    wcześniej wszystkich transportów, jak dawny SQL — wiersze innego transportu to osobne
    doręczenia, a decyzja dotyczy jednego z nich.) Jedna transakcja, która najpierw bierze bez
    czekania blokadę digestu (`pg_try_advisory_xact_lock(DIGEST_LOCK_KEY)`, zwalniana przy
    zatwierdzeniu): trwający `digest` (jego zarezerwowane wiersze są `pending` do zapisu
    wyniku) albo inne `deliveries:resolve` → odmowa, kod 1, nic nie zmienione („a digest run
    or another deliveries:resolve holds the lock”); `digest` startujący w tej chwili jest
    pomijany (`skipped`) — RUNBOOK: nie uruchamiać o minucie crona `digest`. Brak pasujących wierszy `pending` → kod 1, nic nie zmienione; komunikat podaje transport (wiersze drugiego mogą nadal czekać, np. po zmianie `EMAIL_MODE`).
    Wynik: `{"status":"ok","outcome",…,"transport",…,"digestDate",…,"changed":N}`. Oba
    przełączniki, żaden, powtórzony, zły uuid lub data, `--transport` powtórzony, bez wartości
    lub inny niż `test`/`smtp` → kod 2 (błąd wywołania jak w pozostałych komendach,
    sprawdzany przed konfiguracją i bez otwierania bazy). Bez decyzji operatora oferty nie
    trafią do tego profilu, a profil z dzisiejszym `pending` nic dziś nie dostanie.
  - **Treść** (`buildDigest`, czyste, `src/notifications/digest.ts`; D-013 — po polsku;
    **zmienione w PR-11:** karta oferty z `src/notifications/card.ts`, temat bez nazwy firmy —
    opis w README → „Digest (e-mail)” i ARCHITECTURE §4.5; niżej stan z PR-05–PR-10): temat
    tylko z liczby ofert i nazwy profilu (≤ 80 znaków, bez znaków sterujących i CR/LF), nigdy z
    danych źródła. Dla każdej oferty: tytuł, zamawiający, lokalizacja, termin (czas polski) i
    data publikacji („nie podano”, gdy brak), kategoria (MVP + CPV, gdy są; od PR-09
    etykiety `CATEGORY_LABELS`, np. „Sprzątanie”, także w powodach dopasowania — nigdy surowy
    klucz; tak samo `/dopasowania`, D-027. Linia „Kategoria:” — etykiety rozdzielone „; ”,
    bo same zawierają przecinki, potem „ · CPV: ” i kody: „Elektryka; Serwis, naprawy i
    konserwacja · CPV: 45310000-3, 50700000-2”; bez kategorii MVP samo „CPV: …”. W „Dlaczego
    pasuje” powód kategorii to same etykiety w cudzysłowach „…”, rozdzielone „, ”, bez kodów
    (kody są w linii „Kategoria:”): „kategoria: „Elektryka”, „Serwis, naprawy i
    konserwacja”; słowo: oświetlenie (tytuł); region: mazowieckie” — „; ” rozdziela tylko
    powody), opis (≤ 300
    znaków, cięty na granicy słowa) i kontakt publiczny — tylko gdy są, powody dopasowania,
    link tylko `http(s)` (`url.href`; inny → „Link: nie podano”). Tekst i HTML z tymi samymi
    wartościami; w HTML każda wartość przez `escapeHtml` (`&`, `<`, `>`, `"`, `'` i grawis),
    także `href` w cudzysłowie (AC3). Tuż pod nagłówkiem: ile pasujących ofert się nie
    zmieściło („N kolejnych pasujących zamówień wyślemy w następnych dniach…”, polska odmiana).
    Stopka: stan na chwilę przebiegu, ostrzeżenie, że termin mógł się zmienić, a postępowanie
    zostać odwołane (odwołania BZP nie są pobierane), dlaczego odbiorca dostaje e-mail, jak
    zrezygnować
    (odpowiedź na wiadomość / kontakt z operatorem — operator ustawia `active = false`; link
    z tokenem — PR-06). Nagłówek `List-Unsubscribe: <mailto:…?subject=wypis> (Wypisz)` (RFC
    2369; opcja `list` nodemailera, wspólne `mailOptions` obu senderów, więc `.eml` w trybie
    `test` pokazuje ten sam nagłówek): sam adres z `EMAIL_FROM` (w trybie `test` bez
    `EMAIL_FROM` — ten sam zastępczy `radar@example.invalid` co w `From`), kodowany
    procentowo; adres, który nie jest jednym zwykłym adresem → bez nagłówka. Przycisk
    wypisu w programie pocztowym wysyła więc e-mail na skrzynkę operatora, obsługiwany jak
    odpowiedź. Stopka nie wspomina przycisku: Gmail i Outlook pokazują go według własnych
    reguł, a w trybie `test` nic nie dociera. Wypis jednym kliknięciem (RFC 8058,
    `List-Unsubscribe-Post`) wymaga endpointu HTTP — PR-06.
  - **Linki web (zmiana w PR-06A, D-026):** gdy ustawiono `PUBLIC_BASE_URL`, każdy e-mail
    dostaje dwa nowe tokeny profilu, wydawane po `--dry-run` i **przed** rezerwacją
    (`claimDeliveries`) — błąd bazy przy wydawaniu nie zostawia więc wierszy `pending`.
    Stopka zamiast akapitu „odpowiedz na wiadomość” ma dwa akapity z linkami: „Twój profil”
    (od PR-09 poprzedzony zdaniem, co daje strona: „Na stronie profilu możesz zmienić
    kategorie, regiony i słowa kluczowe oraz zobaczyć wszystkie pasujące zamówienia.”)
    (`/dostep/<token>`, jednorazowy, 7 dni, z ostrzeżeniem, żeby nie przekazywać wiadomości
    dalej) i wypis (`/wypis/<token>`, 60 dni, „albo odpowiedz na tę wiadomość”); link tylko
    `http(s)`, w HTML przez `escapeHtml`. Nagłówki:
    `List-Unsubscribe: <https://…/wypis/<token>>, <mailto:…?subject=wypis> (Wypisz)` i
    `List-Unsubscribe-Post: List-Unsubscribe=One-Click` (RFC 8058). URL wypisu trafia do
    nagłówka tylko w postaci kanonicznej (`https://host[:port]/wypis/<43 znaki>`, `http`
    tylko loopback; `oneClickUnsubscribeUrl` w `sender.ts`) — inaczej sam `mailto`, bez
    `List-Unsubscribe-Post`. Host IDN przechodzi: `PUBLIC_BASE_URL` jest sprowadzany do
    originu, a więc do punycode (`xn--…`); sam `mailto` zostaje tylko przy hoście będącym
    literałem IPv6 (`https://[…]`). Bez `PUBLIC_BASE_URL` treść i nagłówki są jak wyżej
    (tylko `mailto`). W trybie `test` plik `.eml` to cały e-mail, więc zawiera linki z
    tokenami (sekrety, jak skrzynka odbiorcy); czytelna kopia `.json` ma je zredagowane —
    token zastąpiony `[token]` (`redactTokenLinks` w `sender.ts`: stały prefiks
    `/dostep/` lub `/wypis/` i dokładnie 43 znaki tokenu). DKIM musi podpisywać oba
    nagłówki (SECURITY §10).
  - **Wynik:** jedna linia JSON na stdout (`status` `ok`/`failed`, `digestDate`,
    `transport`, `dryRun`, `candidates`, `candidatesTruncated`, `skippedInvalidRows`,
    `errorCode` — powód zatrzymania albo `null`, `profiles[]` z `profileId`, `status`,
    `matched`, `claimed`, `sent`, `failed`, `uncertain`, `overflow`, `errorCode`). Kod 1, gdy
    przebieg się zatrzymał albo któryś profil jest `failed`, `uncertain`, `not_found`,
    `invalid_profile` lub `not_run`. Logi i stdout: identyfikatory,
    statusy, liczniki i kody — nigdy adresy, tytuły ani treść e-maila.
  - **`--dry-run`:** to samo liczenie bez sendera (nie jest tworzony), bez zapisu do
    `deliveries` i bez plików w outboxie; `claimed` = ile byłoby zarezerwowanych.
- **AC2 — zastrzeżenie (STATE „Next action” 5 i 6, D-015):** „po terminie” opiera się na
  zapisanym `deadline`. Dla ogłoszeń `ContractNotice` pobieranych dzień po dniu jest on
  aktualizowany przez `NoticeUpdateNotice` (PR-03B), ale może być nieaktualny dla małych
  zamówień (`SmallContractNotice` bez `tenderId` — zmiany ich nie dosięgają), dni obciętych
  (`clipped`) lub niepobranych w oknie 31 dni oraz zmian pominiętych jako `no_original` po
  nadrabianiu poza kolejnością. Skutek: przetarg z przedłużonym terminem może zostać pominięty
  jako „po terminie”. E-mail ostrzega, że termin mógł się zmienić. Odwołania postępowań BZP nie
  są pobierane, więc odwołany przetarg może trafić do digestu jako otwarty (STATE punkt 5).
- **Koszt:** dopasowanie liczy profile × kandydaci. Zmierzone (2026-11-01, lokalnie)
  ok. 120 µs na parę przy opisie ok. 1,4 tys. znaków: 100 profili × 5 000 ofert ≈ 60 s,
  przy limicie 10 000 ofert ≈ 2 min — akceptowalne dla dziennego crona. Tokenizacja oferty raz
  na przebieg wymagałaby zmiany API `matching` (D-023) — odłożona, dopóki pomiar na danych
  pilota tego nie uzasadni.
- **Odrzucone alternatywy:** wysyłka, potem zapis (awaria między nimi → duplikat następnego
  dnia); automatyczne ponawianie `pending` (możliwy duplikat); zapis wyników dopasowania
  (tabela `matches` — niepotrzebna, liczone na bieżąco); kolejka/worker (D-001).
- **Konsekwencje:** zmiana profilu (np. nowe słowo) nie wyśle ofert już wysłanych, a oferty
  starsze niż 7 dni nie trafią do profilu założonego później. Usunięcie profilu usuwa jego
  historię doręczeń (`ON DELETE CASCADE`); usunięcie oferty z doręczeniami jest blokowane
  (FK bez kaskady). Advisory lock jest wspólny dla bazy: testy biorące blokadę digestu są w
  jednym pliku (`tests/integration/digest.test.ts`).

## D-025 — Serwer web: `node:http` bez frameworka

- **Status:** Accepted (PR-06A; rozstrzyga D-006)
- **Kontekst:** PR-06A potrzebuje kilku stron HTML renderowanych po stronie serwera (strona
  główna, potwierdzenie logowania, profil, wypis), formularzy POST i ciasteczka sesji. Bez
  JavaScriptu w przeglądarce i bez SPA (PR_PLAN). 10–100 klientów.
- **Decyzja:** komenda `serve` (`src/web/server.ts`) na `node:http` z Node 22, **bez nowej
  zależności**. Routing to stała tabela ścieżek (`/`, `/styl.css`, `/dostep`,
  `/dostep/<token>`, `/profil`, `/profil/wypisz`, `/wyloguj`, `/wypis/<token>`); nieznana
  ścieżka → 404, zła metoda → 405 z `Allow`. Strony to funkcje zwracające HTML
  (`src/web/pages.ts`), każda wartość przez wspólny `escapeHtml`
  (`src/infrastructure/html.ts`, ten sam co w e-mailu). Formularze tylko
  `application/x-www-form-urlencoded` (opcjonalnie `charset=utf-8`), czytane przez
  `URLSearchParams` z dokładnie oczekiwanymi polami (bez duplikatów, UTF-8 ścisłe). Jedyny
  wyjątek: POST wypisu RFC 8058 przyjmuje też `multipart/form-data` (D-026), czytany własnym
  minimalnym parserem (`src/web/multipart.ts`, bez zależności).
  Nasłuch domyślnie `127.0.0.1:3000` (`WEB_HOST`, `WEB_PORT`); TLS, HSTS i dostęp z internetu
  zapewnia reverse proxy (PR-07). `PUBLIC_BASE_URL` (wymagany, `https://`; `http://` tylko
  loopback poza produkcją, sam origin) jest źródłem linków i dozwolonego `Origin`.
  Zatrzymanie: SIGINT/SIGTERM → `server.close()` + zamknięcie bezczynnych połączeń,
  wymuszone po 10 s.
- **Limity (SECURITY §11):** ciało ≤ 8 KB (`Content-Length` i strumień; inaczej 413), inny typ
  treści → 415 (poza wyjątkiem wyżej), nagłówki ≤ 8 KB i ≤ 50, `headersTimeout` 10 s,
  `requestTimeout` 15 s (sprawdzane co 1 s — `connectionsCheckingInterval`; domyślne 30 s
  rozciągałoby oba limity do ok. 30 s), `keepAliveTimeout` 5 s, bezczynne gniazdo 30 s,
  ≤ 100 żądań na połączenie, wymagany `Host`. Każda odpowiedź: CSP
  `default-src 'none'; style-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`,
  `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin` (w PR-06A
  `no-referrer`, zmienione w PR-06B — D-027), `Cache-Control: no-store` (poza arkuszem
  stylów).
- **Odrzucone alternatywy:** Next.js (SSR + bundler + duża powierzchnia zależności dla kilku
  stron i formularzy); Fastify/Express/Hono (routing i parsowanie, których potrzebujemy
  w kilkudziesięciu liniach; każda zależność to aktualizacje i audyt — SECURITY §13);
  silnik szablonów (szablony to funkcje TypeScript ze sprawdzanymi typami).
- **Konsekwencje:** więcej kodu własnego w warstwie HTTP (parsowanie, limity, nagłówki), w
  całości pokryty testami na prawdziwym serwerze (`tests/web-server.test.ts`,
  `tests/integration/web.test.ts`). Jeśli PR-06B lub późniejsze ekrany realnie przerosną ten
  model (wiele formularzy, walidacja pól, upload), wybór frameworka wraca jako nowa decyzja.

## D-026 — Dostęp do profilu: tokeny z e-maila, sesja w ciasteczku, CSRF, wypis jednym kliknięciem

- **Status:** Accepted (PR-06A; uzupełniona w PR-10 — D-031)
- **Kontekst:** klient nie ma hasła ani konta; dostęp do profilu i wypis muszą działać z
  e-maila (PR_PLAN PR-06A). Skanery poczty otwierają linki z wiadomości (GET), więc GET nie
  może niczego zużywać ani zmieniać.
- **Decyzja:**
  - **Tokeny** (`access_tokens`, migracja `0006_access`; `src/infrastructure/db/access-repository.ts`):
    32 bajty z CSPRNG (256 bitów), base64url (43 znaki); w bazie wyłącznie SHA-256 (hex,
    unikalny). Szybki hash wystarcza — wejście jest losowe, nie jest hasłem. Ważność zawsze
    według zegara bazy (`now()`) w tym samym zapytaniu, które token czyta lub zużywa.
    - `login` — jednorazowy, 7 dni. GET `/dostep/<token>` tylko sprawdza (bez zapisu) i
      pokazuje stronę z przyciskiem „Zaloguj się” (formularz POST `/dostep` z tokenem w polu
      ukrytym). POST zużywa token jednym warunkowym
      `UPDATE … SET used_at = now() WHERE used_at IS NULL AND expires_at > now() RETURNING`
      i w tej samej transakcji tworzy sesję → 303 na `/profil`. Dwa równoległe POST-y: wygrywa
      jeden.
    - `unsubscribe` — wielokrotny (idempotentny), 60 dni, jeden na e-mail. GET `/wypis/<token>`
      pokazuje tylko stronę z przyciskiem; POST z ciałem dokładnie
      `List-Unsubscribe=One-Click` (RFC 8058; ten sam formularz wysyła przycisk na stronie)
      albo `multipart/form-data` z dokładnie jedną częścią `name="List-Unsubscribe"` o treści
      `One-Click` (RFC 8058 §3.2: dostawca poczty SHOULD wysłać multipart, MAY urlencoded)
      ustawia `active = false` jednym `UPDATE` bez ciasteczka i bez CSRF — token w ścieżce jest
      uwierzytelnieniem. Ponowny wypis niczego nie zmienia (także `updated_at`).
    - Każdy nieważny token (nieznany, zużyty, wygasły, zły kształt, zły cel) → ta sama
      neutralna strona 404, bez wskazania powodu.
    - Wydawane w każdym e-mailu `digest` (D-024, przy ustawionym `PUBLIC_BASE_URL`) i przez
      `access:link <profileId>` (link na stdout — dla operatora, np. pierwszego dostępu).
      Link jest sekretem: kto ma e-mail lub wydruk, ma dostęp do profilu (jednorazowo, 7 dni).
  - **Sesja** (`sessions`): identyfikator 256-bitowy, w bazie SHA-256; wygasa po 30 dniach od
    utworzenia (bez przedłużania), sprawdzane po stronie serwera przy każdym żądaniu.
    Ciasteczko `__Host-radar_sesja=<id>; Path=/; Max-Age=2592000; HttpOnly; Secure; SameSite=Lax`.
    Profil pochodzi **wyłącznie** z sesji (żadnego identyfikatora profilu w URL ani formularzu).
    Wyloguj (POST `/wyloguj`) usuwa wiersz i czyści ciasteczko. Nowe logowanie usuwa
    poprzednią sesję tej przeglądarki.
  - **CSRF:** token synchronizujący na każdym POST z sesją (`/wyloguj`, `/profil/wypisz`):
    `HMAC-SHA256(id sesji, "radar-csrf-v1")`, base64url — wyprowadzany z sekretu sesji, więc
    bez osobnego stanu i bez klucza w konfiguracji; porównanie `timingSafeEqual`. Brak lub
    zły token → 403. POST logowania chroni sam token logowania; POST wypisu RFC 8058 — token w
    ścieżce. Dodatkowo każdy POST poza wypisem z nagłówkiem `Origin` innym niż origin
    `PUBLIC_BASE_URL` → 403 (wypis RFC 8058 wysyła serwer poczty, który może podać dowolny
    `Origin`; nic poza dezaktywacją nie robi). `SameSite=Lax` jest trzecią warstwą.
  - **Sprzątanie:** `serve` przy starcie i co godzinę (timer w tym samym procesie, bez
    nakładania się przebiegów) usuwa do 1000 wygasłych tokenów i do 1000 wygasłych sesji
    (`deleteExpiredAccess`). Bez crona i bez osobnego procesu; zaległości schodzą w kolejnych
    godzinach. Bez `serve` wiersze rosną o dwa tokeny na e-mail — pomijalne.
  - **Ograniczenia w bazie:** `profile_id` z `ON DELETE CASCADE` (usunięcie profilu usuwa jego
    tokeny i sesje), unikalny hash, `CHECK` na kształt hasha, cel (`login`/`unsubscribe`),
    `expires_at > created_at` i górną granicę ważności (7 / 60 / 30 dni), `used_at` tylko
    dla `login`; indeksy na `profile_id` i `expires_at`.
  - **Logi** (`http request`): metoda, nazwa trasy, status i czas — nigdy URL, token,
    ciasteczko, nagłówki ani dane profilu (SECURITY §12).
- **Brak limitu żądań:** zgadywanie 256-bitowego tokenu jest niewykonalne, a każde żądanie
  jest ograniczone rozmiarem i czasem (D-025). Ochrona przed zalewem żądań należy do reverse
  proxy (PR-07). Wrócić do tego, gdy pojawi się „wyślij mi link e-mailem” (wysyłka na
  żądanie wymaga limitu) — decyzja właściciela, poza PR-06A.
- **Uzupełnienie (PR-10, D-031):**
  - nowy cel tokenu `email_change` (migracja `0008_self_service_access`): jednorazowy, 24 h,
    związany z adresem w nowej kolumnie `access_tokens.email` (`access_tokens_email_check`:
    adres ⇔ cel `email_change`); zużywany przez usunięcie, więc `used_at` zostaje kolumną
    tylko dla `login`. GET `/potwierdz-email/<token>` niczego nie zmienia, zmienia POST;
  - token logowania wydaje też „Wyślij mi link” (na bieżący adres profilu, także
    nieaktywnego); TTL bez zmian (7 / 60 / 30 dni);
  - „Brak limitu żądań” nie obowiązuje już dla „Wyślij mi link”: najwyżej 3 linki na profil w
    24 h (w bazie) i 10 żądań na IP na godzinę (w pamięci) — D-031. Pozostałe trasy dalej
    bez limitu w aplikacji;
  - login-CSRF (D-027) obejmuje też `/wyslij-link` i `POST /potwierdz-email/<token>`;
  - sprzątanie `serve` usuwa też wpisy `access_emails` starsze niż 24 h.
- **Odrzucone alternatywy:** hasła/konta (poza zakresem MVP); JWT lub podpisane ciasteczko
  bez tabeli (brak natychmiastowego wylogowania i unieważnienia); token zużywany na GET
  (zużyłby go skaner poczty); token CSRF w osobnym ciasteczku (double submit — więcej stanu,
  bez zysku przy sesji po stronie serwera); bcrypt/argon2 dla tokenów (zbędny koszt dla
  losowych sekretów).
- **Konsekwencje:** przekazanie e-maila dalej daje dostęp do profilu (ostrzeżenie w stopce).
  Reakcja na przekazany e-mail albo zgubione urządzenie: `access:revoke <profileId>` (usuwa
  naraz wszystkie tokeny i sesje profilu; profil bez zmian).
  Token w ścieżce URL trafia do logów dostępu reverse proxy — proxy nie może logować ścieżek
  tych tras albo musi je przycinać (PR-07, SECURITY §11).
- **Multipart w wypisie (RFC 8058 §3.2):** dostawca poczty SHOULD wysłać ciało jako
  `multipart/form-data`, więc `/wypis/<token>` przyjmuje oba typy; pozostałe trasy dalej tylko
  urlencoded (inny typ → 415). Parser (`src/web/multipart.ts`) jest własny, bo potrzebne jest
  jedno krótkie pole w ciele ≤ 8 KB: boundary z parametru `Content-Type` (może być w
  cudzysłowie) według RFC 2046 (1–70 dozwolonych znaków, bez spacji na końcu), ramki
  `--boundary` ze zdjętymi CRLF, preambuła, epilog i inne części ignorowane, każda część musi
  mieć dokładnie jeden `Content-Disposition: form-data` z `name`. Wszystko, czego nie da się
  sparsować (brak lub zły boundary, brak ramki zamykającej, nagłówek bez dwukropka lub
  zawinięty), brak pola, pole dwa razy albo inna wartość → 400, tak samo jak w urlencoded.
  Bez wyrażeń regularnych na ciele (tylko `indexOf`). Odpowiedź to zawsze 200 ze stroną (albo
  neutralne 404), nigdy przekierowanie (RFC 8058 §3.2 MUST NOT). Uwaga: przykład w RFC 8058
  §8.3 drukuje linie ramek jako sam boundary, bez prefiksu `--` z RFC 2046 — dosłownie wzięty
  nie jest poprawnym multipart i dostaje 400; przyjmujemy jego poprawną postać
  (`--` + boundary), którą wysyłają biblioteki multipart.

## D-027 — Ekrany klienta: formularz profilu, zmiana e-maila, dopasowania, login-CSRF

- **Status:** Accepted (PR-06B; rozwija D-025 i D-026; zmiana e-maila zastąpiona przez D-031)
- **Kontekst:** po PR-06A klient widzi tylko stan profilu i może się wypisać. PR-06B dodaje
  edycję profilu, podgląd dopasowań i ponowne włączenie powiadomień — nadal bez JavaScriptu,
  na `node:http` (D-025), z profilem wyłącznie z sesji (D-026). Przegląd PR-06A wskazał też
  brak ochrony logowania przed login-CSRF.
- **Decyzja:**
  - **Trasy:** `GET/HEAD/POST /profil/ustawienia` (formularz), `GET/HEAD /dopasowania`,
    `POST /profil/wlacz`. `/profil` zostaje stroną stanu (z linkami do obu nowych stron), a
    formularz ma osobną ścieżkę — stan i zapis się nie mieszają, a strona stanu działa nawet
    przy wierszu profilu, którego schemat nie przyjmuje.
  - **Formularz profilu** (`src/web/profile-form.ts`, `settingsPage` w `pages.ts`): nazwa, e-mail i
    jego powtórzenie, kategorie i województwa (pola wyboru z zamkniętych list), powiaty i słowa
    kluczowe (`<textarea>`, wpis w wierszu). Ciało `urlencoded` ≤ 64 KB — **tylko ta trasa**, reszta
    dalej 8 KB — i ≤ 64 pary; pola pojedyncze dokładnie raz, pola wyboru dowolnie wiele razy,
    nieznane pole → 400. Kolejność: sesja → CSRF (+ `Origin`) → schemat domeny
    (`companyProfileSettingsSchema` = schemat profilu bez `active`) i ta sama kontrola nazwy powiatu
    co w `profile:create` (`countyKey`; samo „powiat” → błąd). Błąd → 400 i ten sam formularz z
    wysłanymi wartościami, podsumowaniem błędów i komunikatem po polsku przy polu (`aria-invalid`,
    `aria-describedby`; wpisy list z numerem wiersza, najwyżej 5 komunikatów na pole). Sukces → 303
    na `/profil` z komunikatem „Zapisano” (albo o zmianie e-maila). Równoległe zapisy: wygrywa
    ostatni.
  - **Komunikat po przekierowaniu:** ciasteczko `__Host-radar_komunikat` (60 s,
    `HttpOnly; Secure; SameSite=Lax`) z jednym słowem z zamkniętej listy; `/profil` pokazuje
    je raz i czyści. Bez parametru w URL (nie zostaje w historii i zakładkach) i bez stanu w
    bazie. Ciasteczko nigdy nie niesie adresu ani innej treści.
  - **Adres powiadomień na `/profil`:** strona stanu zawsze pokazuje bieżący adres („Adres
    powiadomień”, zescapowany), czytany z bazy razem z nazwą profilu sesji
    (`getProfileStatus`), więc literówka po zmianie adresu jest widoczna od razu; komunikat o
    zmianie prosi o jego sprawdzenie. Dawny adres nie jest nigdzie pokazywany.
  - **Zmiana e-maila** (`updateProfileSettings`): jedna transakcja — wiersz profilu
    `FOR NO KEY UPDATE`, ponowne sprawdzenie bieżącej sesji (`FOR KEY SHARE`; sesja usunięta
    albo wygasła w międzyczasie → wycofanie i 401), a gdy adres (po normalizacji) się zmienił:
    usunięcie wszystkich tokenów profilu i wszystkich jego sesji poza bieżącą
    (`revokeOtherAccess`); `UPDATE` profilu na końcu. Linki z e-maili wysłanych na stary adres
    przestają działać; inne urządzenia są wylogowane.
  - **Kolejność blokad bez cyklu:** pierwsza wersja (`FOR UPDATE`, `UPDATE` adresu, potem
    tokeny) zakleszczała się z logowaniem (logowanie trzyma wiersz tokenu i czeka na
    `KEY SHARE` profilu dla klucza obcego sesji; 40P01, HTTP 500). Teraz logowanie nigdy nie
    czeka na zmianę adresu przed jej końcowym `UPDATE` (`KEY SHARE` przechodzi obok
    `NO KEY UPDATE`), a zmiana czeka na logowanie przy usuwaniu tokenów i usuwa też sesję,
    którą ono utworzyło. `access:revoke` blokuje najpierw wiersz profilu (jak zmiana adresu),
    więc obie operacje idą po kolei. Wylogowanie trzyma jeden wiersz sesji i na nic nie czeka.
    Digest wydaje tokeny z `FOR SHARE` profilu i warunkiem `email = adres wysyłki`: czeka na
    zmianę i po niej nie wydaje linków na stary adres (status `address_changed`, nic nie
    wysłane ani zajęte; następny przebieg wysyła na nowy adres). Godzinne sprzątanie usuwa
    wiele wierszy we własnej kolejności — na wypadek takiego rzadkiego cyklu zmiana adresu
    ponawia transakcję raz po 40P01. Test integracyjny odtwarza przeplot z logowaniem.
    `active` się nie zmienia. **Nowy adres nie jest potwierdzany** (brak wysyłki z procesu
    web — PR_PLAN); powtórzenie adresu chroni tylko przed literówką. Adres zajęty przez inny
    profil → błąd przy polu (ujawnia, że adres jest w systemie — świadomy koszt; inaczej
    zapis musiałby po cichu zawieść).
  - **Dopasowania** (`/dopasowania`): liczone na żądanie tymi samymi regułami co digest — wspólny
    moduł `src/notifications/candidates.ts` (okno 7 dni, limit 10 000 kandydatów, `matchingItems`) i
    widok pozycji (do PR-10 `digestItemView` z `digest.ts`; **od PR-11 ta sama karta `offerCard`
    z `src/notifications/card.ts` co e-mail, bez „Szczegółów ogłoszenia” — ARCHITECTURE §4.6**);
    kolejność: najbliższy termin pierwszy. _Historyczne (stan do PR-10, zastąpione przez PR-11):_
    karta oferty była zwarta: od razu tytuł, zamawiający, lokalizacja (przy profilu na całą Polskę
    „Dlaczego pasuje” jej nie podaje), termin składania ofert, „Dlaczego pasuje” i link do źródła;
    data publikacji, kategoria, opis i kontakt w natywnym `<details>` („Szczegóły ogłoszenia”, bez
    JavaScriptu); brakujące pola jak w digeście. Najwyżej 50 pozycji i „I N kolejnych”; puste —
    wyjaśnienie okna 7 dni; profil wyłączony — informacja, że e-maile nie są wysyłane. Strona
    pokazuje także oferty już wysłane e-mailem (to podgląd, nie historia doręczeń) i mówi o tym.
    Wiersz profilu odrzucony przez schemat → strona z prośbą o poprawienie w formularzu.
  - **Ponowne włączenie:** `POST /profil/wlacz` (sesja, CSRF, `Origin`) ustawia
    `active = true`; ponowne kliknięcie niczego nie zmienia (także `updated_at`).
  - **Login-CSRF:** `POST /dostep` wymaga `Origin` równego originowi `PUBLIC_BASE_URL`, a gdy
    `Origin` brak — nagłówka `Sec-Fetch-Site` o wartości `same-origin`; wszystko inne (także
    `Origin` równy `null` i brak obu nagłówków) → 403 bez zużycia tokenu.
  - **`Referrer-Policy: strict-origin`** (było `no-referrer`): przy `no-referrer` przeglądarki
    wysyłają w formularzach `Origin: null` (specyfikacja Fetch), więc kontrola `Origin` z
    D-026 odrzucała każdy formularz w prawdziwej przeglądarce, a nowa reguła logowania by go
    nie przepuściła. `strict-origin` daje prawdziwy `Origin`, a `Referer` niesie tylko
    origin, więc tokeny ze ścieżek nie wyciekają (także w żądaniach do własnego serwera,
    np. `/styl.css`).
  - **Zależności warstw:** `web` używa repozytorium profili, `notifications/candidates.ts`, czystego
    `digest.ts` i `countyKey` z `matching`, nigdy `sender.ts` ani `run.ts` — proces web nie wysyła
    e-maili.
- **Koszt `/dopasowania`:** dopasowanie to praca CPU w wątku procesu `serve`. Zmierzone (2026-11-02,
  lokalnie, opisy ok. 1,4 tys. znaków): 5 000 kandydatów — odczyt ok. 0,1 s, dopasowanie ok. 0,7 s
  przy typowym profilu i ok. 5,5 s przy maksymalnym (100 + 100 ośmiowyrazowych słów, 4 kategorie);
  przy limicie 10 000 — ok. 2 s typowo i 13–14 s maksymalnie. Dlatego `matchingItems` oddaje pętlę
  zdarzeń, gdy od poprzedniego oddania minęło ponad 20 ms (`MATCH_YIELD_AFTER_MS`; liczba ofert nie
  wystarcza — 200 ofert przy maksymalnym profilu to ok. 0,4 s; wynik i digest bez zmian), więc inne
  żądania są obsługiwane w trakcie, a proces liczy najwyżej jedną listę naraz
  (`src/web/matches-slot.ts`). Równoległe żądanie `/dopasowania` czeka w kolejce FIFO najwyżej 3 s
  (`MATCHES_MAX_WAIT_MS`), w kolejce najwyżej 8 żądań (`MATCHES_MAX_WAITERS`); po zwolnieniu
  miejsce przechodzi wprost na najstarsze czekające (bez wyścigu wszystkich czekających). Pełna
  kolejka (od razu) albo upływ czasu → 503 z `Retry-After: 5` i stroną „Trwa przygotowanie listy
  dopasowań — spróbuj za kilka sekund” z odnośnikiem „Spróbuj ponownie”. Klient, który rozłączy się
  w kolejce, wypada z niej (timer i nasłuch `close` odpinane) i nic nie jest dla niego liczone;
  rozłączenie w trakcie liczenia go nie przerywa. Miejsce zwalniane w `finally`, także po błędzie.
  To jedno miejsce jest wspólne dla wszystkich klientów. **Kolejka, a nie cache wyników:** krótkie
  oczekiwanie zamienia większość 503 przy jednoczesnych wejściach (np. kilku pracowników po tym
  samym e-mailu) w zwykłą odpowiedź, nie wprowadzając stanu; cache na profil musiałby być
  unieważniany przy każdej zmianie ustawień i każdym `ingest`, a pokazywałby stan sprzed tych
  zmian. Dostępne tylko z sesją; limit żądań tej trasy na reverse proxy (PR-07).
  Jeśli pomiar na danych pilota pokaże problem: jednokrotna tokenizacja ofert (zmiana API
  `matching`, D-023).
- **Odrzucone alternatywy:** formularz na `/profil` (miesza stan i zapis; strona stanu
  musiałaby walidować profil); komunikat w parametrze URL (zostaje w historii, łatwy do
  podrobienia w linku) albo w bazie (stan dla jednej wiadomości); potwierdzanie nowego adresu
  e-mailem (wymaga wysyłki z procesu web — poza zakresem; decyzja właściciela); zapis wyników
  dopasowania lub cache (tabela i unieważnianie bez zmierzonej potrzeby); framework web
  (D-025 — kilka pól i jedna walidacja nie przerosły modelu); `Referrer-Policy: same-origin`
  (pełny `Referer` z tokenem w żądaniach do własnego serwera, czyli w logach proxy); pokazywanie
  dawnego adresu po zmianie (prośba właściciela) — musiałby trafić do ciasteczka, URL-a albo nowej
  kolumny; literówkę wychwytuje bieżący adres, zawsze widoczny na `/profil`.
- **Konsekwencje:** kto ma sesję (np. z przekazanego e-maila), może zmienić adres i przejąć
  powiadomienia; dawny właściciel traci dostęp (reakcja: operator, `access:revoke` i poprawka
  adresu). Digest działający w chwili zmiany adresu bez `PUBLIC_BASE_URL` może jeszcze wysłać jeden
  e-mail (bez linków) na stary adres; z linkami — nie. Pełne listy (100 + 100 + 100 długich wpisów z
  polskimi znakami) mogą przekroczyć 64 KB → 413. Klient bez `Origin` i bez `Sec-Fetch-Site` nie
  zaloguje się.
- **Zmiana (PR-10, D-031)** — część „Zmiana e-maila” zastąpiona:
  - koniec natychmiastowej zmiany adresu: nowy adres czeka w `pending_email` na potwierdzenie
    linkiem wysłanym na niego; `email`, sesje i linki zostają do potwierdzenia. Unieważnienie
    tokenów i sesji oraz kolejność blokad z tej decyzji wykonuje teraz potwierdzenie
    (`confirmEmailChange`), z jedną ponowną próbą po 40P01;
  - pole powtórzenia adresu (`email_confirm`) usunięte — literówkę wyłapuje potwierdzenie;
  - błąd „adres zajęty” przy polu usunięty (brak wyroczni): zajętość wychodzi dopiero przy
    potwierdzeniu, neutralną stroną bez zmiany;
  - „Zależności warstw”: `web` używa interfejsu nadawcy z `notifications/sender.ts` i czystego
    `notifications/access-emails.ts` — `serve` wysyła e-maile dostępu (nadal nigdy `run.ts`);
  - odrzucona tu alternatywa „potwierdzanie nowego adresu e-mailem” jest przyjęta;
  - konsekwencja „kto ma sesję, może przejąć powiadomienia” zostaje (sesja + nowa skrzynka
    wystarczą), ale stary adres dostaje powiadomienie i może anulować zmianę przed
    potwierdzeniem.

## D-028 — Gotowość operacyjna: `status`, alert operatora, backup/restore, CI, twardnienie web

- **Status:** Accepted (PR-07A; wdrożenie, retencja i kopia poza hostem — PR-07B)
- **Kontekst:** przed pilotem operator musi się dowiedzieć, że coś nie działa (źródło się nie
  pobrało, wysyłki czekają na decyzję), umieć odtworzyć bazę i mieć powtarzalną weryfikację
  każdej zmiany. Przegląd PR-06B zostawił też drobne twardnienie web: jedna sesja mogła zająć
  całą kolejkę `/dopasowania`, brak HSTS i znaki sterujące przechodziły do profilu.
- **Decyzja:**
  - **`status [--notify]`** — osobna, krótka komenda (cron po `ingest` i po `digest`), tylko
    odczyt, bez blokady, jedna linia JSON. Reguły (`src/operations/status.ts`):
    - źródło: `source_failed`, gdy ostatni przebieg jest `failed` albo nieudany dzień z
      ostatnich 36 h nie został później pokryty przebiegiem `succeeded`/`incomplete` tego
      źródła (nadrabianie ponawia nieudane dni, D-021 — pokryty dzień przestaje być problemem);
      `source_stale`, gdy od 36 h (`STATUS_STALE_AFTER_MS`) żaden przebieg nie zakończył się
      `succeeded`/`incomplete` — `ingest` biegnie codziennie, więc jeden opóźniony cykl to
      jeszcze nie alarm, dwa pominięte już tak; `source_incomplete` (od PR-09, C&S L-R2-1 z
      PR-08), gdy dwa najnowsze nie-`failed` przebiegi źródła z dwóch różnych dni publikacji
      (na dzień liczy się najnowszy przebieg, kolejność po `started_at`;
      `listRecentCompletedRuns`) są oba `incomplete` — pojedynczy `incomplete` nie alarmuje
      (jeden dzień z limitem stron/rekordów albo brakującym szczegółem bywa), dwa z rzędu to
      wzór (np. limit za niski albo zmiana w źródle). Raport i alert podają każdy z nich:
      dzień, `runId`, start i powody z podsumowania (`part: reason`, np. `announcements: max_records`;
      zapis nieczytelny → „nieczytelne”) — bez treści ofert. Nadrabianie (D-021) nie
      ponawia dni `incomplete` i się nie zmienia; `source_never_run`; `no_enabled_sources`;
    - wysyłki: `deliveries_pending` — każdy wiersz `pending` (wynik niepewny, decyzja
      operatora, D-024), **chyba że trwa `digest`** (jego zarezerwowane wiersze są `pending` do
      zapisu wyniku): advisory lock `DIGEST_LOCK_KEY` trzymany przez inną sesję, odczytany z
      `pg_locks` (`classid` = górne, `objid` = dolne 32 bity, `objsubid = 1`), bez blokowania;
      `deliveries_failed` — wiersze `failed` z dniem digestu od wczoraj (kalendarz Polski,
      czyli dwa ostatnie przebiegi), osobno ponawiane (`attempts` < 3) i wyczerpane, z
      kodami błędów; starsze `failed` (oferta już nie kwalifikuje się — zostaje `failed` na
      zawsze, D-024) nie alarmują w nieskończoność;
    - baza nieczytelna → `database_unavailable` (stały powód + kod), oczekujące migracje →
      `schema_not_ready` — raportowane i alertowane jak każdy problem, bo właśnie wtedy
      operator musi wiedzieć; nieoczekiwany błąd samego `status` → stały komunikat, kod 1, a z
      `--notify` alert z samym kodem `status_internal_error` (bez treści błędu — może
      zawierać konfigurację).
      Kod 0 bez problemu, 1 przy problemie (cron i monitoring widzą kod).
  - **Alert operatora (`--notify`):** przy problemie jeden e-mail na `OPERATOR_EMAIL` (nowa
    zmienna, czytana tylko przez `status --notify`) tym samym transportem i z tymi samymi
    ponowieniami co `digest` (`EMAIL_MODE=test` → outbox). Zwykły tekst po polsku bez HTML i
    bez `List-Unsubscribe` (wiadomość do operatora, nie do klienta); treść i temat tylko z
    identyfikatorów, statusów, kodów, czasów i liczb; kończy się odesłaniem do
    `docs/RUNBOOK.md` → „Alert statusu”. Alert **powtarza się przy każdym uruchomieniu**, dopóki
    problem trwa — bez tabeli „już zgłoszono” (dwa uruchomienia dziennie to dwa e-maile; stan
    deduplikacji byłby nową tabelą i nowym sposobem na przegapienie problemu). Nieudana wysyłka
    → kod 1 i `notification: "failed"` na stdout (cron loguje wynik).
  - **`backup <dir>` / `restore <file>`:** `pg_dump`/`pg_restore` (klient PostgreSQL ≥ 16)
    jako procesy potomne — bez nowej zależności i bez własnego formatu. Zakres = bieżący
    schemat połączenia (jak migracje; z tabelą migracji), format custom, `--no-owner
--no-acl` (odtworzenie innym użytkownikiem). Połączenie: `DATABASE_URL` sparsowany tak jak
    `pg` (parametry zapytania wygrywają, domyślnie `localhost:5432`) → conninfo libpq **bez
    hasła** w `--dbname`, hasło tylko w `PGPASSWORD` środowiska dziecka, budowanego od zera
    — wszystkie ustawienia połączenia muszą być w URL: `pg` uzupełnia brakujące z `PG*`
    procesu, narzędzia w czystym środowisku nie, więc niepusta zmienna `PGHOST`, `PGHOSTADDR`,
    `PGPORT`, `PGUSER`, `PGPASSWORD`, `PGDATABASE`, `PGOPTIONS`, `PGSSLMODE` lub
    `PGSSLNEGOTIATION` → odmowa `unsupported_database_url` z samą nazwą zmiennej (fail-closed;
    inaczej inny serwer albo słabszy TLS niż w aplikacji). TLS: `pg` weryfikuje certyfikat i
    host dla `prefer`/`require`/`verify-ca`/`verify-full`, więc narzędzia dostają
    `verify-full` (z `sslrootcert=system`, gdy nie podano pliku); `no-verify` → `require`;
    parametr bez dokładnego odpowiednika → odmowa (`unsupported_database_url`). Plik: zapis do
    pliku tymczasowego `0600` (`wx`), `fsync`, `link` do `radar-<czas UTC>.dump` — nigdy nie
    zastępuje istniejącego pliku, przy błędzie nic nie zostaje. `restore` tylko do istniejącego
    schematu **bez żadnej relacji** (nigdy na dane), `--single-transaction --exit-on-error`,
    potem kontrola migracji jak `health` i liczby wierszy. Limit 30 min na narzędzie (SIGTERM,
    po 5 s SIGKILL), `PGCONNECT_TIMEOUT=10`. stderr narzędzi nigdy nie jest wypisywany — stały
    powód + kod wyjścia. Restore jest testowany w CI (backup → pusty schemat → restore →
    identyczne dane). Retencja i szyfrowana kopia poza hostem: PR-07B (do tego czasu — ręcznie,
    `docs/RUNBOOK.md`).
  - **`/dopasowania`: najwyżej 2 żądania jednej sesji naraz** (w toku lub w kolejce,
    `MATCHES_MAX_PER_SESSION`); trzecie → od razu 429 z `Retry-After: 5` i stroną „Lista
    dopasowań już się przygotowuje (np. w innej karcie albo po odświeżeniu strony) — poczekaj
    kilka sekund i spróbuj ponownie.”, bez wejścia do kolejki. Licznik po **id sesji z
    bazy** (po sprawdzeniu sesji), nigdy po wartości ciasteczka — losowe ciasteczka nie tworzą
    wpisów, a mapa ma najwyżej tyle wpisów, ile żądań jest w toku. Dwa, nie jedno: odświeżenie
    strony w trakcie liczenia nie kończy się błędem. Wiele sesji nadal może zapełnić kolejkę —
    to limit na proxy (PR-07B).
  - **HSTS:** `Strict-Transport-Security: max-age=31536000` na każdej odpowiedzi, gdy
    `PUBLIC_BASE_URL` to `https://`; **bez `includeSubDomains`** (nie znamy subdomen domeny
    pilota) i **bez `preload`** (trudne do cofnięcia). Przy `http://` (loopback, development)
    brak nagłówka — HSTS na `localhost` psułby inne lokalne serwisy.
  - **Znaki sterujące (`\p{Cc}`) odrzucane tylko na wejściu:** formularz profilu i
    `profile:create` odrzucają nazwę i wpisy list ze znakiem sterującym wewnątrz (np. wklejony
    tabulator; brzegi są przycinane jak dotąd), z komunikatem przy polu / ścieżką pola.
    Schematy zapisanych wierszy się nie zmieniają: stary wiersz ze znakiem sterującym dalej
    się wczytuje, digest i strona go pokazują (wyjście i tak przez `escapeHtml`/`cleanText`).
    Zmiana schematu odczytu zamieniłaby istniejące profile w `invalid_stored_row`. Skutek dla
    testów: test ostrzeżeń `profile:create` o czyszczeniu ESC w słowach sprawdza teraz
    `profileWarnings` bezpośrednio, bo `profile:create` takiego słowa już nie przyjmie.
  - **CI (`.github/workflows/ci.yml`):** `pnpm check` na pull request i na push tylko do
    gałęzi domyślnej (PR z tego samego repozytorium — jeden przebieg, nie dwa), z usługą
    PostgreSQL 16 i `REQUIRE_DB_TESTS=1` (pominięte testy z bazą = błąd). Akcje przypięte do
    pełnych SHA commitów (komentarz z wersją), `permissions: contents: read`,
    `persist-credentials: false`, `pnpm install --frozen-lockfile`, potem `pnpm audit --prod`
    (znana podatność zależności produkcyjnej = błąd; zależności tylko deweloperskie nie
    blokują CI — obejmuje je dalej pełny `pnpm audit` w Code & Safety Review,
    `docs/SECURITY.md` §13), wersja pnpm z `packageManager`. Klient `pg_dump`/`pg_restore`
    przypięty do wersji głównej serwera: `postgresql-client-16` z repozytorium PGDG
    (apt.postgresql.org, dodanego skryptem z `postgresql-common`, bo Ubuntu 26.04 ma tylko
    klienta 18; nie meta-pakiet `postgresql-client`, który daje najnowszego klienta),
    `/usr/lib/postgresql/16/bin` na początku `PATH` i kontrola, że wersja główna to dokładnie
    16 — `pg_dump` ≥ 17 zapisuje `SET transaction_timeout`, którego serwer 16 nie zna, więc
    `pg_restore --exit-on-error --single-transaction` kończy się błędem; test backup/restore
    nie może się też po cichu pominąć w CI. Ten test działa w osobnym projekcie Vitest po wszystkich pozostałych
    (`groupOrder`), bo introspekcja katalogu przez Migrator Kysely w innych plikach ściga się
    z relacjami usuwanymi przez restore w tej samej bazie.
- **Odrzucone alternatywy:** alert z procesu `ingest`/`digest` (każda komenda musiałaby znać
  e-mail operatora i stan innych; `status` widzi też komendę, która w ogóle nie ruszyła);
  zewnętrzny monitoring/kolejka (sprzeczne z D-001); deduplikacja alertów w bazie (wyżej);
  własny eksport SQL/JSON zamiast `pg_dump` (niekompletny, nietestowany format); hasło w
  `--dbname` albo pliku `.pgpass` (widoczne w `ps` / plik z sekretem na dysku); restore z
  `--clean` do niepustego schematu (nadpisanie danych jednym poleceniem); limit żądań na IP
  w aplikacji (za proxy adres klienta to proxy — zadanie dla proxy, PR-07B); zaostrzenie
  schematu zapisanych wierszy (wyżej).
- **Konsekwencje:** operator dostaje e-mail przy każdym uruchomieniu `status --notify`, dopóki
  nie usunie przyczyny (np. nie zdecyduje o wierszach `pending`); `status` nie zastępuje
  monitoringu procesu `serve` (tylko cron — dostępność strony sprawdza PR-07B). Backup
  wymaga klienta PostgreSQL ≥ 16 na hoście i zawiera dane osobowe — do PR-07B kopia poza
  hostem jest ręczna. Do PR-07B nie ma „dead man's switch”: alert idzie tym samym SMTP i z
  tego samego crona, więc przy martwym hoście, cronie lub SMTP operator nie dostaje nic (cisza
  ≠ wszystko w porządku; ręczna kontrola — `docs/RUNBOOK.md`). Dwa żądania `/dopasowania`
  jednej sesji to nadal dwa miejsca w kolejce. Profil zapisany wcześniej ze znakiem sterującym
  trzeba poprawić przy następnym zapisie formularza (formularz pokaże błąd przy polu).

## D-029 — Hosting pilotażu: VPS, systemd, cron, Caddy; wiek kopii i heartbeat w `status`

- **Status:** Accepted (PR-07B; decyzja właściciela z 2026-11-03)
- **Kontekst:** pilot potrzebuje powtarzalnego wdrożenia na jednym hoście, a D-028 zostawił
  dwie luki: nieudany albo nieuruchomiony backup nie dawał alertu, a przy martwym hoście,
  cronie lub SMTP operator nie dostawał nic (cisza ≠ wszystko w porządku).
- **Decyzja:**
  - **Hosting:** jeden VPS (Debian 12 albo Ubuntu 24.04), PostgreSQL 16 z PGDG na tym samym
    hoście (tylko `localhost`), Node 22 (NodeSource), Caddy z repozytorium Caddy jako reverse
    proxy z TLS (automatyczne certyfikaty i przekierowanie HTTP → HTTPS). `serve` — unit
    systemd `deploy/systemd/radar-serve.service` (użytkownik `radar`, hardening, bez zapisu na
    dysk, ruch IP tylko z/do loopbacka, `Restart=on-failure`); pozostałe komendy — cron hosta
    `deploy/cron/radar` (format `/etc/cron.d`, użytkownik `radar`). Konfiguracja w jednym
    pliku `/etc/radar/radar.env` (`root:radar 0640`), czytanym przez `node --env-file` w unicie
    i w cronie — ta sama ścieżka i te same flagi wszędzie; plik zgodny też z `EnvironmentFile=`
    systemd (bez cudzysłowów, `#`, `$`, `\` w wartościach — `deploy/radar.env.example`).
    Kod w `/opt/radar-zamowien` należy do konta administratora, nie do `radar`: proces nie może
    zmienić własnego kodu.
  - **Strefa czasowa crona:** cron Debiana/Ubuntu (vixie cron 3.0pl1) nie obsługuje `CRON_TZ`
    (przykład w RUNBOOK z PR-07A działałby w strefie hosta). Host ma strefę `Europe/Warsaw`
    (`timedatectl`), a godziny w pliku crona są czasem lokalnym. Aplikacja liczy dni Polski
    sama (jawna strefa) — od strefy hosta zależą tylko godziny startu. Żadne zadanie nie
    startuje między 2:00 a 3:00, więc zmiana czasu nic nie pomija ani nie powtarza.
  - **Retencja kopii:** linia crona zostawia **14 najnowszych** plików `radar-<czas>.dump`
    (po nazwie = po czasie), zamiast kasować starsze niż N dni (`find -mtime`): gdy backup
    przestaje działać, ostatnie dobre kopie nigdy nie znikają.
  - **Wiek kopii w `status`:** opcjonalny `BACKUP_DIR` (ścieżka bezwzględna). Jeden `readdir`
    i filtr nazw — liczą się tylko zwykłe pliki o nazwie dokładnie takiej, jaką daje
    `backup` (`radar-RRRRMMDDTGGMMSSZ.dump`, ścisłe parsowanie z kontrolą w obie strony; pliki
    `.partial`, kopie, katalogi, dowiązania i niemożliwe daty są pomijane), a czas pochodzi z
    nazwy, nie z `mtime` (kopiowanie i odtwarzanie katalogu zmienia `mtime`; bez `stat`
    każdego pliku). Nazwy ponad 5 min w przyszłości są pomijane (ukryłyby starą kopię).
    Problemy (na końcu stałej kolejności): `backup_dir_unreadable` (kod errno, np. `ENOENT`,
    `EACCES` — nigdy ścieżka), `backup_missing`, `backup_stale` — najnowsza kopia starsza niż
    26 h (`BACKUP_STALE_AFTER_MS`), dobrane do harmonogramu (backup 5:30, `status` 6:30 i
    7:45, czas polski): jedna nieudana noc wychodzi w `status` z 7:45 (najnowsza kopia ma wtedy
    26 h 15 min; o 6:30 — 25 h, jeszcze bez alertu); bez awarii żaden `status`, także ręczny
    tuż przed kolejnym 5:30 albo w dniu jesiennej zmiany czasu, nie widzi więcej niż ok.
    24–25 h, więc nie ma fałszywego alarmu; dwie nieudane noce — już o 6:30 (49 h). Znana luka:
    w dniu wiosennej zmiany czasu (doba 23 h) `status` z 7:45 widzi 25 h 15 min, więc gdy nie uda
    się tylko backup z tej nocy, a następny się uda, awaria **nie zostanie zgłoszona wcale**;
    dopiero druga nieudana noc z rzędu wychodzi następnego dnia o 6:30 (48 h). Nie 36 h jak dla źródeł — 36 h przepuściłoby
    jedną nieudaną noc bez alertu. Przy codziennych kopiach utrata danych to zwykle najwyżej
    ok. 1 dzień (ok. 2 dni, gdy w dniu wiosennej zmiany czasu nie udadzą się dwie noce z rzędu). Sprawdzane także przy nieczytelnej bazie; bez
    `BACKUP_DIR` zachowanie bez zmian (`backup: null`).
  - **Heartbeat („dead man's switch”):** opcjonalny `HEARTBEAT_URL` (tylko `https:`, z hostem,
    bez danych logowania i fragmentu; **sekret** — usługi trzymają token w ścieżce, więc nigdy
    nie trafia do logu, stdout ani komunikatu błędu konfiguracji). Po `status` z kodem `0`
    (bez problemu i bez nieudanego alertu) jeden `GET` — także bez `--notify`: brak pingu jest
    alarmem, a ping zależy od wyniku, nie od flagi. Kod `1` → brak pingu (`heartbeat:
"skipped"`). GET, bo przyjmuje go każda usługa heartbeat i nie ma treści do wysłania.
    `node:https` bezpośrednio (`src/operations/heartbeat.ts`), **nie SafeHttpClient** — D-014
    dotyczy stron źródeł (allowlista hostów, limity tempa, budżet błędów); tu jest jedno żądanie
    do jednego adresu podanego przez operatora, ograniczone w miejscu: 10 s na całość
    (`HEARTBEAT_TIMEOUT_MS`; ogranicza wynik, nie czas życia procesu — trwającego zapytania DNS
    `getaddrinfo` nie da się przerwać, więc proces może poczekać do limitu resolvera; kod
    wyjścia i logi są wtedy już ustalone), żadne przekierowanie nie jest śledzone (3xx = `http_3xx`),
    treść odpowiedzi nie jest czytana, nowe połączenie bez keep-alive, **bez ponowienia** —
    `status` biegnie dwa razy rano, a okres karencji usługi pokrywa jeden zgubiony ping;
    ponowienie wydłużałoby `status` bez zysku. Nieudany ping nie zmienia kodu wyjścia
    (system działa, a brak pingu i tak zaalarmuje): log `warn` z `errorCode:
"heartbeat_failed"` i stałym powodem (`timeout`, `http_<status>`, `network[_<errno>]`),
    linia na stderr, `heartbeat: "failed"` w JSON. Pole `heartbeat`: `sent`, `failed`,
    `disabled` (bez URL), `skipped`.
  - **`GET`/`HEAD /zdrowie` w `serve`:** `200 ok` tylko, gdy proces `serve` — w swoim
    sandboxie systemd — dostał odpowiedź z bazy (`select 1` przez istniejącą pulę) w 2 s,
    inaczej `503`; zwykły tekst, `no-store`, bez sesji, bez danych i treści błędu (w logu
    stały kod `health_check_failed` i powód). Jedno zapytanie naraz, wspólne dla równoległych
    żądań — zalew `/zdrowie` zajmuje najwyżej jedno połączenie z puli, także przy zawieszonej
    bazie. Cel: zewnętrzny monitoring dostępności i smoke test — heartbeat `status` nie
    obejmuje `serve`. Ograniczanie liczby żądań na proxy — poza PR-07B.
  - **Kopia poza hostem:** zaszyfrowana `age` kluczem publicznym (klucz prywatny poza VPS)
    i wysyłana zadaniem crona użytkownika `radar` w osobnym pliku `/etc/cron.d/radar-offsite`
    (aktualizacja zastępuje `/etc/cron.d/radar`) — przykład w `docs/DEPLOY.md`, bez kodu w
    aplikacji. Wysyłka bez `--delete`, na serwerze kopii `rrsync -wo -no-del`, retencja według
    wieku po stronie serwera kopii: przejęty VPS nie usunie kopii poza hostem.
- **Odrzucone alternatywy:** kontenery i zarządzana baza (poza zakresem, więcej elementów
  przy 10–100 klientach); `CRON_TZ` (nieobsługiwany przez cron Debiana); systemd timers
  zamiast crona (decyzja właściciela: cron; RUNBOOK już go opisuje); `EnvironmentFile=` w
  unicie (dwie drogi wczytania tego samego pliku — cron i tak używa `--env-file`);
  `copytruncate` w logrotate (zbędne: każde zadanie otwiera log od nowa); wiek kopii z
  `mtime`; heartbeat przez SafeHttpClient (allowlista i limity źródeł nie pasują do jednego
  adresu operatora, a jego seamy testowe są zakazane w `src/`); ponowienie pingu (wyżej);
  ping także przy problemie z innym statusem (usługi `/fail`) — alert e-mail już to robi, a
  brak pingu wystarcza; `MAILTO` crona jako drugi kanał (wymaga drugiego serwera poczty);
  rate limiting w Caddy (moduł spoza dystrybucji — limit `/dopasowania` zostaje w aplikacji).
- **Konsekwencje:** brak albo stara kopia daje alert jak każdy problem (także kod `1`
  i brak heartbeatu). Heartbeat alarmuje, gdy host, cron, baza albo `status` nie działa,
  także przy martwym SMTP — o ile operator skonfiguruje usługę (okres 1 dzień, karencja ok.
  1 h). Pierwszy `status` przed pierwszym backupem zgłasza `backup_missing`. Ręczne
  `status` z ustawionym `HEARTBEAT_URL` też pinguje. Pierwsze wdrożenie, smoke test i
  odtworzenie kopii na VPS robi właściciel ręcznie według `docs/DEPLOY.md`.

## D-030 — Drugie źródło: Baza Konkurencyjności przez publiczne API aplikacji (adapter `bk`)

- **Status:** Accepted (PR-08)
- **Kontekst:** BZP obejmuje niewiele małych zamówień (D-015, „Znane ograniczenie pokrycia”).
  Zamówienia beneficjentów funduszy europejskich publikowane w trybie zasady
  konkurencyjności trafiają do Bazy Konkurencyjności
  (`https://bazakonkurencyjnosci.funduszeeuropejskie.gov.pl`). Badanie wykonano 2026-11-03 i
  2026-11-04 zapytaniami przez proxy kontenera (curl, łącznie ok. 15 żądań, odstęp ≥ 2 s,
  User-Agent bez danych osobowych). SafeHttpClient nie był używany, bo ignoruje proxy (D-014).
  Nie pobierano załączników (`/api/files/…`).
- **Decyzja:** drugim źródłem jest **Baza Konkurencyjności (Ministerstwo Funduszy i Polityki
  Regionalnej)**, czytana przez JSON API, z którego korzysta jej publiczna aplikacja.
  - Adapter: `bk` (`src/sources/bk/adapter.ts`).
  - Allowlista: `["bazakonkurencyjnosci.funduszeeuropejskie.gov.pl"]`, wyłącznie `https`.
  - Ruch: SafeHttpClient z rate limitem (min. 2 s między żądaniami).
  - Bez logowania, bez CAPTCHA, bez wersji archiwalnej Bazy i bez historycznych wersji ogłoszeń.
  - **Podstawa korzystania:** regulamin Bazy (`/api/regulations`, wersja opublikowana
    2026-05-13):
    - rozdz. II pkt 1: „Dostęp do Bazy jest bezpłatny.”;
    - pkt 4 — celem Bazy jest „…zapewnienie oferentom dostępu do oferowanych ogłoszeń …
      poprzez powszechnie dostępny sposób ich odszukiwania i odczytu.”;
    - pkt 5 — „Internauta, który wykorzystuje treści umieszczane w Bazie w celu innym niż
      wskazany w punkcie 3., obowiązany jest przestrzegać polityki Ministerstwa zawartej w
      dokumencie „Warunki ponownego wykorzystania informacji sektora publicznego”…:
      - 5.1. należy poinformować o źródle pozyskania informacji poprzez podanie pełnej nazwy
        Ministerstwa,
      - 5.2. należy podać datę pozyskania informacji,
      - 5.3. należy poinformować o przetworzeniu informacji, jeżeli miało to miejsce.

      Brak zastosowania się do powyższych warunków jest działaniem bezprawnym…”;

    - rozdz. VIII pkt 5: „Internauta ponosi pełną odpowiedzialność … za ponowne
      wykorzystanie danych dostępnych na portalu.”

    Radar ponownie wykorzystuje treści ogłoszeń. Robi to tylko z atrybucją z pkt 5.1–5.3
    (punkt **Atrybucja** niżej). Regulamin nie zakazuje automatycznego odczytu i nie opisuje API.

  - **`robots.txt`:** `/robots.txt` zwraca HTML aplikacji (200 `text/html`), a nie plik
    reguł. Nie ma więc żadnych reguł dla robotów. Nie sprawdzamy go w runtime. Operator
    sprawdza `robots.txt` i regulamin ponownie przy przeglądzie źródła, przed włączeniem `bk`
    i przy każdej zmianie adaptera (jak w D-015).
  - **Ryzyko nieudokumentowanego API:** API nie ma opisu ani gwarancji stabilności. Może się
    zmienić bez zapowiedzi. Zabezpieczenia:
    - każda odpowiedź przechodzi przez ścisłe schematy zod na granicy;
    - inna struktura, inny status albo nieczytelny JSON/UTF-8 strony listy dają
      `SourceFormatError`. Wtedy przebieg dnia jest `failed` z kodem `invalid_document`,
      nigdy z pustym wynikiem (PR-08 AC2). To samo dotyczy strony listy krótszej niż
      żądana przed końcem listy (`(strona−1) × rozmiar + liczba rekordów < meta.total`) i
      rekordu listy z innym `publication_date` niż żądany dzień (zignorowany lub
      przemianowany filtr daty). Lista podaje dzień jako `RRRR-MM-DD` (fixture 2026-11-03),
      więc porównanie jest dokładne;
    - szczegóły ogłoszeń: zasada niżej („Nieczytelne szczegóły”);
    - `status` zgłasza to w tym samym cyklu (`source_failed`, 6:30);
    - wyłączenie źródła opisuje `docs/RUNBOOK.md`.

    Obserwacje z badania:
    - API odpowiada JSON-em z `Content-Type: text/html`, więc adapter nie polega na
      nagłówku;
    - bez `status[]` albo `sort` serwer zwraca 500, dlatego oba są zawsze wysyłane;
    - nieznane ogłoszenie daje 404 z kopertą `{"status":"Error",…}`.

  - **Odczyt (dwa etapy):**
    - **Lista:** `GET /api/announcements/search?page=N&limit=250&sort=…&status[]=PUBLISHED&publicationDateRange[from]=D&publicationDateRange[to]=D`.
      Zwraca strony po 250 rekordów oraz `meta.total`. Filtr dnia dotyczy publikacji
      **bieżącej wersji** ogłoszenia (fixture: 296132 opublikowane 2026-10-27 jest na liście
      2026-11-03, bo tego dnia wyszła jego nowa wersja). Nowa wersja trafia więc na listę dnia
      swojej publikacji i daje `updated` (PR-08 AC3).
    - **Szczegóły:** `GET /api/announcements/{id}` dla każdego ogłoszenia z listy, po kolei.
      Szczegóły zawierają bieżącą wersję z zamówieniami („częściami”), pozycjami, CPV,
      miejscami realizacji i osobami kontaktowymi. Lista ich nie ma.

    `RawDocument` to tylko szczegóły. Strony listy są walidowane i odrzucane.

  - **Nieczytelne szczegóły:** jedno ogłoszenie nie zatrzymuje dnia, zmiana formatu tak.
    - Szczegóły z odpowiedzią 404 (`http_status` 404; np. ogłoszenie wycofane między listą a
      szczegółami albo widoczne na liście bez dostępnych szczegółów) są pomijane z powodem
      `detail_missing`. Szczegóły, które nie są użytecznym rekordem, są pomijane z powodem
      `detail_invalid`: poza kopertą (inny status, inna struktura, nieczytelny JSON/UTF-8)
      albo bez pól wymaganych przez mapowanie (np. przemianowany `title` albo
      `advertiser_address_details.name`, pole w innym typie JSON). Adapter sprawdza każdy
      dokument, zanim przekaże go dalej, tym samym czystym `extract` (koperta i
      `bkRecordSchema`), który potem uruchamia ingest. Reguły nie są powielone. Log
      `source detail fields invalid` ma id ogłoszenia i ścieżki pól schematu, nigdy wartości.
    - Każde pominięcie ma w logu `source detail skipped` (id ogłoszenia, powód, licznik).
      Przebieg jest `incomplete` z tym powodem (nowe powody w `incompleteReasons`), więc
      `lastRun.status` w `status` i wynik `ingest` to pokazują. Pozostałe ogłoszenia dnia są
      zapisywane, a dzień jest pokryty, więc nadrabianie nie czyta go ponownie co rano.
    - **Granica:** najwyżej 2 pominięcia na dzień (`BK_MAX_SKIPPED_DETAILS_PER_DAY`). Trzecie
      nieczytelne szczegóły kończą dzień jako `failed` z własnym kodem (`invalid_document`
      albo `http_status`). Dzień, w którym wszystkie szczegóły są nieczytelne, też jest
      `failed`, nawet poniżej granicy.
    - Uzasadnienie granicy: zmiana formatu albo przeniesiony endpoint psuje wszystkie
      szczegóły. Taki dzień kończy się więc po 3 szczegółach (albo po wszystkich, gdy jest
      ich mniej) błędem z kodem i `status` zgłasza `source_failed` w tym samym cyklu.
      Pojedyncze, trwale wadliwe ogłoszenie nie blokuje dnia przez 31 dni nadrabiania.
      Stała liczba jest prostsza niż odsetek i działa tak samo w dniu z 10 i ze 180
      ogłoszeniami.
    - **Dzień samych odrzuceń:** rekord poprawny według schematu, ale z wartością, której
      `normalize` nie przyjmuje (np. termin w innym formacie, pusty tytuł), jest jak dotąd
      odrzuceniem (`rejected`). Adapter liczy takie rekordy tym samym `normalize`. Gdy dzień
      ma **więcej niż 2** przeczytane szczegóły (`BK_MAX_SKIPPED_DETAILS_PER_DAY`), a
      **każdy** rekord jest odrzucony, dzień kończy się jako `failed` (`invalid_document`,
      „every record of the day was rejected”), po zapisaniu liczników odrzuceń. Bez tej
      reguły zmiana formatu wartości dałaby `succeeded` z zerem ofert, którego `status` nie
      widzi.
      - Uzasadnienie progu: ta sama granica co dla pominięć. Do 2 złych rekordów na dzień
        jest tolerowanych, więc mały dzień (np. sobota z jednym ogłoszeniem) z prawdziwym
        odrzuceniem nie kończy się `failed` co rano przez 31 dni nadrabiania i nie prowadzi
        do wyłączenia `bk` przez RUNBOOK. Prawdziwa zmiana formatu wartości psuje wszystkie
        rekordy, więc i tak jest wykryta w każdym dniu z co najmniej 3 ogłoszeniami (dni
        robocze mają ich ok. 150–180). Stała liczba jest prostsza niż odsetek.
      - Koszt: mały dzień (1–2 ogłoszenia), w którym wszystkie rekordy są odrzucone, jest
        `succeeded` (albo `incomplete`, gdy były pominięcia) bez alertu. Widać go tylko
        w licznikach (`rejected`) i w logu `source record rejected`.
      - Pojedyncze odrzucenia w dniu z innymi zapisanymi rekordami nie zmieniają statusu.
        Widać je w licznikach (`rejected`) i w logu `source record rejected`.
    - Inne błędy HTTP (5xx po ponowieniach, timeout, budżet błędów) nadal kończą dzień jako
      `failed`.

  - **Niestabilna paginacja, więc lista dnia to jedna strona:** rekordy z tą samą datą
    publikacji nie mają stałej kolejności między żądaniami.
    - Pomiar 2026-11-03 (`meta.total` 180, strony po 100): strony 1 i 2 przy
      `sort=publicationDate` zachodziły na siebie o 14 rekordów i pomijały 14 innych. Porządek
      `default` pomijał inne 14, oba razem dały 180.
    - Pomiar właściciela 2026-11-04 (`meta.total` 130, strony po 100): 111 różnych id
      w każdym porządku i **111 także w sumie obu**, więc 19 ogłoszeń (15%) nie było
      widocznych wcale. Jedno żądanie z `limit=200` albo `limit=500` dało wszystkie 130
      (ok. 94 KB).
    - **Dlatego strona ma 250 rekordów (`BK_PAGE_SIZE` = `BK_MAX_DETAILS_PER_DAY`), niezależnie
      od `--limit`.** Dzień do 250 ogłoszeń (każdy dotąd zmierzony) to jedno żądanie listy,
      bez paginacji, także w `source:preview` z małym `--limit`; po sprawdzeniu listy (niżej)
      adapter bierze z niej pierwsze `budżet` id. Strona 250 rekordów to ok. 180 KB, daleko
      poniżej limitu odpowiedzi SafeHttpClient (`DEFAULT_LIMITS.maxBytes`, 5 MiB).
    - **Rezerwa, gdy `meta.total` > 250:** paginacja stronami po 250 w dwóch porządkach
      (`publicationDate`, potem `default`), aż suma różnych id osiągnie
      `min(meta.total, budżet)`. Najwyżej 2 strony na porządek (`BK_MAX_PAGES_PER_ORDER`, 500
      pozycji, dwa razy więcej niż budżet). Lista mieszcząca się na jednej stronie nie jest
      czytana w drugim porządku: to te same rekordy (pomiar 2026-11-04).
    - Porządek kończy się na ostatniej, krótszej stronie albo po `meta.total` pozycjach.
      Pozycje są pełne aż do `meta.total` także wtedy, gdy rekordy się powtarzają (strona 2
      dnia 2026-11-03: 80, 100 + 80 = 180). Krótsza strona przed końcem listy zakończyłaby
      porządek po cichu, więc jest błędem formatu (`invalid_document`).
    - **Lista poniżej własnego `meta.total` kończy dzień jako `failed`:** adapter rzuca
      `SourceFormatError` („listing has fewer distinct records than its total”,
      `invalid_document`), gdy różnych id jest mniej niż cel. W logu jest `source listing short`
      z liczbami (strony, rekordy, `total`).
      - Lista mieszcząca się na jednej stronie (`meta.total` ≤ 250) jest zawsze sprawdzana
        względem całego `meta.total`, także w podglądzie z małym `--limit`: strona i tak jest
        pobrana, więc sprawdzenie nie kosztuje żądania.
      - Powyżej 250 (rezerwa) celem jest `min(meta.total, budżet)`, także po limicie stron.
      - Lista jest czytana przed szczegółami, więc nic nie jest zapisywane. `status` zgłasza
        `source_failed`, a nadrabianie ponawia dzień według D-021 (z istniejącym limitem
        kolejnych błędów).
      - Uzasadnienie: dotąd taki dzień był `incomplete` (`listing_mismatch`), czyli pokryty.
        Nadrabianie go nie ponawiało, a `status` nie alarmował, więc brakujące ogłoszenia
        przepadały po cichu (przegląd właściciela PR #14). Bez nowego kodu ani reguł
        nadrabiania: istniejące `failed` daje alert i ponowienie.
      - Koszt: lista, która pozostaje krótka, traci ofertę `bk` całego dnia (nie tylko
        brakujące), aż do poprawki adaptera; przyjęte, bo jest to głośne i ponawiane.
        Odrzucone: zapis częściowej listy z jednoczesnym `failed`, bo każde ponowienie
        czytałoby znów wszystkie szczegóły (ok. 6–9 min) i opóźniało BZP (jak przy L-R3-1).
      - Powód `listing_mismatch` usunięty z `incompleteReasons` (dodany w PR-08, nie zapisuje
        go żadna wydana wersja; zapisane wartości nie są odczytywane z powrotem). `max_pages`
        dla `bk` nie występuje: wyczerpany limit stron rezerwy bez osiągnięcia celu to ta sama
        lista poniżej `meta.total`, więc też `failed`. Inaczej byłby to znów pokryty dzień
        z brakami. `max_pages` zostaje dla BZP.
  - **Wolumen i budżet:** dni robocze to ok. 150–180 ogłoszeń w bieżącej wersji (180 dnia
    2026-11-03, 155 dnia 2026-11-02), sobota ok. 10. Starsze dni maleją, bo ogłoszenia dostają
    nowsze wersje albo przestają być `PUBLISHED` (pomiar 2026-11-04: 70 dla 2026-10-27, 4 dla
    2026-09-30, 0 dla 2026-06-30).
    - Budżet dnia: `min(--limit, BK_MAX_DETAILS_PER_DAY = 250)` szczegółów. Więcej daje
      `incomplete` z powodem `max_records`.
    - Dzień to zwykle 1 + liczba ogłoszeń żądań, najwyżej 250 + 4 = 254 (rezerwa: 2 porządki
      × 2 strony). Przy zmierzonych ~2,9 s na żądanie (odstęp 2 s + odpowiedź) daje to ok.
      12,5 min.
    - Dlatego **timeout źródła i dnia w `ingest` rośnie z 10 do 15 min**
      (`INGEST_SOURCE_TIMEOUT_MS`, uzupełnienie D-018). Przekroczenie to `failed`
      (`source_timeout`), nigdy cisza.
    - `--limit` znaczy dla `bk` „najwyżej tyle ogłoszeń na dzień”.
    - `source:preview bk` (domyślnie 20 rekordów, 21 żądań, ok. 1 min) mieści w swoich
      5 min ok. 100 rekordów. Dla większego `--limit` kończy się `source_timeout`.
  - **Harmonogram (bez zmian w `deploy/cron/radar`):**
    - `ingest` o 6:00 czyta źródła w kolejności id (`listEnabledSources`, `ORDER BY id`), czyli
      **najpierw `bk`, potem BZP**. Typowy dzień `bk` (~180) trwa ok. 9 min, BZP kilka minut,
      więc całość kończy się ok. 6:15.
    - Nawet oba źródła na swoich limitach żądań (`bk` 254, BZP 120) kończą się ok. 6:20.
      `status` o 6:30 widzi więc błąd `bk` z tego samego cyklu (PR-08 AC3).
    - Nadrabianie wielu dni (D-021) może trwać dłużej. Najgorszy przypadek to
      31 × 15 min na źródło. Tak było dotąd dla BZP przy 10 min.
    - Każde źródło czyta wszystkie swoje dni, zanim zacznie następne. **BZP startuje więc
      dopiero po wszystkich dniach `bk`: w najgorszym razie po 15 min × liczba dni `bk` do
      nadrobienia.** Każdy dzień `bk` ponawiany po błędzie opóźnia BZP do 15 min i może
      przesunąć koniec `ingest` poza 6:30. Gdy ten sam dzień `bk` wraca jako `failed` kolejne
      ranki, wyłącz `bk` (`docs/RUNBOOK.md`); BZP wtedy zaczyna o 6:00.
  - **Normalizacja (czyste `extract`/`normalize`, nic nie jest zgadywane; brak = `null`):**
    - `externalId` to id **ogłoszenia** (`advertisement.advertisement.id`), a nie id wersji.
      Jest stałe między wersjami. `sourceUrl` = `https://…/ogloszenia/{id}`. `tenderId` =
      `null`.
    - `issuerName` = `advertiser_address_details.name`. Jego brak to szczegóły
      `detail_invalid` (patrz „Nieczytelne szczegóły”).
    - `title` jest oczyszczony z białych znaków i przycięty do 1000 znaków na granicy słowa
      z „…”. Pusty tytuł daje odrzucenie `invalid value: title`.
    - `description` to opisy pozycji wszystkich zamówień: linie zachowane, puste usunięte,
      pozycje rozdzielone pustą linią, całość do 10 000 znaków. Gdy nie ma opisu, jest `null`.
    - `publishedAt` to dzień **pierwszej** publikacji ogłoszenia
      (`advertisement.publication_date`, `YYYY-MM-DD`) jako północ czasu polskiego.
    - `deadline` = `submission_deadline` (`YYYY-MM-DD HH:MM:SS`, czas polski → UTC,
      `warsawLocalToUtc`). Zła albo niejednoznaczna data (zmiana czasu) daje odrzucenie
      `invalid value: deadline` / `publishedAt`. Brak daty to `null`.
    - **Wartość:** `estimated_value` zamówienia jest tekstem w formacie formularza (cyfry,
      przecinek, dwa miejsca, np. `"50000,00"`).
      - Jedno zamówienie daje jego wartość.
      - Kilka zamówień („części”) daje **sumę tylko wtedy, gdy każde ma wartość**. Inaczej
        `null`, bo częściowa suma zaniżałaby wartość.
      - `"0,00"`, pusta wartość, inny tekst albo wartość poza zakresem kolumny (15 cyfr
        całkowitych) dają `null`, nigdy 0.
      - Wartość w innym typie JSON (np. liczba) to zmiana formatu: szczegóły
        `detail_invalid` (log ze ścieżką `orders.N.estimated_value`).
      - Netto czy brutto: API tego nie mówi. Zapisujemy liczbę tak, jak ją podano.
    - **Waluta:** `PLN` **tylko, gdy jest wartość**. Uzasadnienie:
      - rekord nie ma pola waluty;
      - Baza służy zamówieniom beneficjentów programów w Polsce;
      - regulamin wyraża progi w złotych („50 tys. PLN netto/80 tys PLN netto”, załącznik
        pkt 6);
      - kwoty mają polski format.

      Bez wartości waluta to `null`.

    - **Kategorie:** różne kody CPV (`NNNNNNNN-N`) ze wszystkich pozycji, najwyżej 100. Błędny
      kod jest pomijany. Kategorie MVP z CPV wylicza matching, jak dla BZP (D-023). Brak CPV
      daje `[]`.
    - **Lokalizacja (miejsca realizacji, nie siedziba zamawiającego):**
      - Gdy **wszystkie** miejsca mają to samo województwo rozpoznane przez
        `normalizeVoivodeship`, zapisujemy `voivodeship` (istniejące etykiety). Do tego
        `county`/`city`, gdy są wspólne dla wszystkich miejsc.
      - Kilka województw, „cała Polska”, zagranica albo nierozpoznane województwo dają **brak
        województwa**. Wybór jednego ukryłby ofertę przed profilami z pozostałych województw.
        Wtedy `raw` zawiera listę różnych miejsc (województwo, kraj inny niż Polska, typ
        miejsca inny niż „adres”, w ostateczności miejscowość), do 500 znaków.
      - Brak miejsc daje `null`.
      - Matching traktuje ofertę bez województwa jak dotąd (`region_unknown`).
    - **Kontakt (D-022):** pierwsza osoba z poprawnym e-mailem (`email`, małe litery) i/lub
      telefonem złożonym z cyfr i separatorów (`phone`).
      - `-`, pusty tekst, tekst z literami i błędny e-mail są **pomijane**, a nie zapisywane
        w `raw`, bo mogą zawierać nazwisko.
      - **Imion i nazwisk (`forename`/`surname`) nie zapisujemy nigdy.**
      - Brak danych daje `null`.
    - **Status** wynika z etykiety statusu ogłoszenia:
      - `PUBLISHED` → `open` do terminu, potem `closed`; bez terminu `unknown`;
      - `CANCELLED` → `cancelled`;
      - `CLOSED`/`RESOLVED` → `closed`;
      - inna etykieta → `unknown`.
  - **Dane osobowe:**
    - zapisujemy tylko e-mail/telefon kontaktowy, jak w BZP. E-mail bywa imienny, ale jest
      publikowany do kontaktu w sprawie ogłoszenia;
    - nazwiska osób kontaktowych i autorów załączników nie są zapisywane ani logowane;
    - opisy pozycji są tekstem zamawiającego i mogą wymieniać osoby, jak opisy BZP;
    - logi zawierają tylko id, liczby i kody;
    - fixtures są spseudonimizowane (`tests/fixtures/bk/README.md`).
  - **Atrybucja (pkt 5 regulaminu):** każda oferta `bk` ma w e-mailu (tekst i HTML) i na
    `/dopasowania` (w widocznej części karty, przed linkiem) pole
    „Źródło: Baza Konkurencyjności, Ministerstwo Funduszy i Polityki Regionalnej;
    pobrano RRRR-MM-DD; dane przetworzone: skrócone i ujednolicone”.
    - **Data pozyskania** to `fetched_at` jako dzień w Polsce. Jest ustawiana przy wstawieniu
      i przy zmianie treści. Ponowny odczyt bez zmian (`unchanged`, D-017) jej nie zmienia, bo
      pokazana treść pochodzi z tamtego odczytu.
    - „Przetworzone” oznacza przycięty tytuł i opis, ujednolicone daty, wartość, lokalizację
      i kategorie.
    - Wyjście BZP się nie zmienia (D-015 nie wymaga atrybucji).
  - **Migracja `0007_bk_source`:** dodaje wiersz `sources`
    (`bk`, „Baza Konkurencyjności”, `https://bazakonkurencyjnosci.funduszeeuropejskie.gov.pl/`)
    jako **wyłączony** (`enabled = false`). Istniejącego wiersza nie zmienia.
    - Powód: odczyt nieudokumentowanego API zaczyna się dopiero po prawdziwym
      `source:preview bk` u właściciela (PR-08 AC1), a nie przy deployu. Do tego czasu `status`
      nie zgłasza `source_never_run` dla `bk`.
    - Włączenie i backfill opisują `docs/DEPLOY.md` i `docs/RUNBOOK.md`:
      `UPDATE sources SET enabled = true …`, potem jednorazowo
      `ingest bk --from <wczoraj−30> --to <wczoraj>` poza godzinami crona (szacunkowo 1–2 h;
      starsze dni są mniejsze). Lista zawiera
      tylko ogłoszenia nadal `PUBLISHED` w bieżącej wersji, więc backfill daje oferty wciąż
      aktualne, a nie archiwum.
- **Odrzucone alternatywy:**
  - parsowanie HTML strony: to aplikacja SPA, której treść i tak pochodzi z tego API;
  - sama lista bez szczegółów: nie ma w niej zamówień, wartości, CPV ani kontaktu;
  - strony po 100 w dwóch porządkach jako główna ścieżka: zmierzone braki, których suma
    porządków nie zamyka (2026-11-04);
  - lista poniżej `meta.total` jako `incomplete`: dzień pokryty, braki bez alertu i bez
    ponowienia;
  - pobieranie załączników: poza zakresem, a do tego większe ryzyko i dane osobowe;
  - wybór „pierwszego” województwa przy kilku;
  - częściowa suma wartości;
  - włączenie `bk` migracją: przed AC1 oznaczałoby automatyczny odczyt nieprzejrzanego API;
  - wyższy timeout bez limitu szczegółów: wydłużyłby najgorszy przypadek bez granicy.
- **Konsekwencje i znane ograniczenia:**
  - Ogłoszenie, którego szczegóły dają 404, jest pominięte (`detail_missing`). Nie jest czytane
    ponownie, bo dzień jest pokryty. Jeśli wróci w nowej wersji, trafi na listę jej dnia.
  - Ogłoszenie anulowane albo zamknięte po odczycie nie jest już na liście
    (`status[]=PUBLISHED`), a nowa wersja nie powstaje. Zapisany status zostaje wtedy `open`.
    Digest i tak pomija oferty po terminie.
  - Granica dnia: filtr `publicationDateRange` przyjmuje daty bez strefy. Nadrabianie liczy
    dni UTC (D-021). To otwarte pytanie, jak w D-015.
  - Zmiana struktury API zatrzymuje `bk` (`invalid_document`) do czasu poprawki adaptera. BZP
    działa dalej. Procedurę opisuje `docs/RUNBOOK.md`.
  - Pierwszy digest po backfillu może pokazać więcej ofert (`first_seen_at` w oknie 7 dni,
    najwyżej 50 w e-mailu, D-024).
  - `source:preview` ma zastosowanie praktyczne do ok. 100 rekordów.
  - Przemianowanie pola **opcjonalnego** jest niewidoczne: `submission_deadline`,
    `contact_persons`, `fulfillment_places`, `cpv_items` i opisy pozycji, `estimated_value`
    stają się po cichu `null`/`[]` (brak terminu, kontaktu, lokalizacji, wartości,
    kategorii). Schemat nie odróżni braku pola od zmiany nazwy. `status` wykrywa tylko
    zmianę pól wymaganych (`detail_invalid`) i wartości odrzucanych przez `normalize` (dzień
    samych odrzuceń). Zmianę pola opcjonalnego widać tylko w danych (np. same `null`
    w terminach).
  - Oferty z kilku województw albo „cała Polska” nie mają województwa i pasują jako
    `region_unknown`, jak oferty BZP bez województwa. Profil z województwem, który pasuje
    tylko kategorią (40 pkt), nie dostanie takiej oferty, bo próg to 50 pkt (potrzebna jest
    też fraza kluczowa, 70 pkt). Świadomie bez zmian w matchingu w PR-08.
  - Przy takiej ofercie powód „źródło nie podaje województwa” stoi obok linii
    „Lokalizacja: mazowieckie, śląskie” (z `raw`). To prawda o polu `voivodeship`, ale
    może dziwić. Do poprawy w tekstach matchingu, poza PR-08.
  - Wartość `bk` nie mówi, czy jest netto, czy brutto. **Od PR-11 wartość jest pokazywana**
    (karta oferty, `src/notifications/card.ts`, `formatValue`): wiersz „Wartość szacunkowa:
    120 000,00 PLN (źródło nie podaje, netto czy brutto)”. Kwota powstaje z zapisanego
    tekstu (`numeric` jako string), nigdy przez liczbę zmiennoprzecinkową: grupy tysięcy
    oddziela twarda spacja (U+00A0), część dziesiętna po przecinku ma co najmniej 2 cyfry,
    dalsze cyfry znaczące zostają (bez zaokrąglania). Dopisek o netto/brutto stoi przy
    każdej wartości — także BZP, bo ani BZP, ani Baza tego nie podaje (gdy źródło kiedyś
    poda, dopisek trzeba zastąpić tą informacją). Brak wartości → „Wartość szacunkowa: nie
    podano”, nigdy 0. Atrybucja „Źródło:” (dzień `fetched_at` RRRR-MM-DD) bez zmian.
  - **Kolejność karty oferty (PR-11, decyzja właściciela po przeglądzie PR #17):** cel to
    ocena w 20 sekund na telefonie 390 px — pierwszy ekran ma odpowiedzieć „ile, do kiedy,
    dlaczego ja”. `offerCard` (`src/notifications/card.ts`) dzieli wiersze na grupy, a
    wszystkie widoki (tekst i HTML e-maila, `/dopasowania`, `/przyklad`) pokazują je w tej
    samej kolejności: tytuł → `lead` (wartość, termin, „Dlaczego pasuje”) → przycisk
    „Otwórz ogłoszenie” (tekst e-maila: linia „Otwórz ogłoszenie: …”; bez linku `http(s)`
    w tym miejscu „Link: nie podano”) → `body` (zamawiający, lokalizacja, wyciąg opisu i na
    stronach „Pełny opis”, atrybucja „Źródło:” Bazy) → `more` (data publikacji, kontakt,
    gdy jest) → „Szczegóły dopasowania”. Atrybucja zostaje **widoczna** (regulamin, pkt
    5.1–5.3), nigdy pod `<details>`. Na stronach `more` i „Szczegóły dopasowania” są w jednym
    natywnym `<details>` „Więcej szczegółów (data publikacji, kontakt, szczegóły
    dopasowania)” — podsumowanie wymienia tylko to, co jest w środku; bez skryptu i bez
    zagnieżdżania `<details>`. W e-mailu wszystko jest widoczne (programy pocztowe nie
    wszystkie obsługują `<details>`), `more` i szczegóły mniejszym drukiem na końcu karty.
    Brakujące wartości bez zmian: „nie podano”, nigdy zgadywane. Przykład `/przyklad` ma
    kontakt tylko z e-mailem i telefonem, jak prawdziwe karty (D-022: adaptery nie
    zapisują imion i nazwisk).

## D-031 — Samoobsługowe wejście („Wyślij mi link”) i potwierdzanie zmiany adresu

- **Status:** Accepted (PR-10; decyzja właściciela z 2026-11-06; zmienia D-026 i D-027)
- **Kontekst:** klient, który zgubił albo zużył link (działa raz, D-026), musiał prosić
  operatora o nowy. Zmiana adresu działała od razu (D-027): literówka odcinała digest i
  wszystkie linki, a formularz mówił, że adres jest zajęty przez inny profil (wyrocznia).
  Strona główna nie mówiła, czym jest serwis i skąd ma dane.
- **Decyzja:**
  - **„Wyślij mi link”** (`POST /wyslij-link`, formularz z jednym polem na `/` i na stronie
    nieważnego linku): login-CSRF jak `/dostep` (D-027), ciało ≤ 1 KiB, adres walidowany tym
    samym schematem co profil (niepoprawny → 400 z błędem przy polu, bez bazy). Każdy
    poprawny adres dostaje od razu tę samą odpowiedź (status, treść, nagłówki): „Jeśli adres
    jest w bazie, link przyjdzie w ciągu kilku minut. Sprawdź też folder spam.” — dla adresu
    istniejącego, nieistniejącego, profilu nieaktywnego i po wyczerpaniu limitu.
  - **Bez wyroczni czasowej:** odpowiedź nie czeka na bazę ani na wysyłkę. Wyszukanie profilu,
    limit i wysyłka biegną po odpowiedzi w kolejce w pamięci procesu `serve`
    (`src/web/mail-queue.ts`): jedno zadanie naraz, najwyżej 20 czekających; nadmiar jest
    odrzucany z kodem `access_mail_queue_full` w logu; przy zamknięciu serwera czekające
    zadania wypadają (`access_mail_shutdown`, ten sam kod dla żądania odrzuconego przez
    zamkniętą kolejkę), a na bieżące serwer czeka najwyżej 5 s: potem je porzuca
    (`access_mail_shutdown_timeout`; nie zaczyna kolejnej wysyłki), żeby zatrzymanie (≤ 10 s
    na żądania + 5 s) zmieściło się w `TimeoutStopSec=20`. Kolejka, a nie wysyłka w
    żądaniu: czas odpowiedzi nie zależy od tego, czy adres ma profil, a SMTP nie blokuje
    pętli zdarzeń. Jedna próba wysyłki, bez ponawiania (klient może poprosić znowu; ponowienie
    mogłoby zdublować wiadomość przyjętą przez serwer).
  - **Link:** zwykły token logowania (jednorazowy, 7 dni, D-026), także dla profilu z
    `active = false` (sam o niego prosi i bez niego nie włączy e-maili). Idzie wyłącznie na
    bieżący adres profilu; adres oczekujący na potwierdzenie nie jest wyszukiwany. Temat
    „Radar Zamówień: link do profilu”, treść: link, „działa raz przez 7 dni”, „Jeśli to nie
    Ty — zignoruj tę wiadomość”. Ten sam nadawca (`EMAIL_FROM`) i transport (`EMAIL_MODE`)
    co digest (D-024), bez nagłówków wypisu (to nie lista mailingowa).
  - **Limity:**
    - na profil: najwyżej 3 linki w 24 h (`ACCESS_EMAILS_PER_DAY`), liczone w bazie w tabeli
      `access_emails` (profil, rodzaj, czas — nigdy adres ani token). Licznik i wpis biegną w
      jednej transakcji pod blokadą wiersza profilu (`FOR NO KEY UPDATE`), więc równoległe
      żądania są liczone po kolei (atomowo). Wpis powstaje przed wysyłką: nieudana wysyłka też
      się liczy (ochrona skrzynki ważniejsza niż jeden zgubiony link);
    - na IP: najwyżej 10 żądań na godzinę (okno stałe), w pamięci, najwyżej 10 000 kluczy,
      przy pełnej mapie wypada klucz z najstarszym oknem. Liczone przed walidacją formularza,
      tylko po IP (nie po adresie e-mail). Przekroczenie → 429 ze stroną po polsku;
    - **klucz limitu:** IPv4 — adres (także IPv4 zapisany jako IPv6, `::ffff:a.b.c.d`); IPv6
      — prefiks /64 (pierwsze 4 grupy po pełnym rozwinięciu, więc `::`, zera wiodące,
      wielkość liter i identyfikator strefy nie zmieniają klucza). /64 to najmniejszy blok,
      jaki dostawca daje jednemu klientowi: klient zmieniający adresy w swojej sieci nie obejdzie
      limitu, nie wypełni mapy i nie zapcha kolejki e-maili (odrzucając wiadomości innych);
    - **źródło IP:** gdy rozmówca TCP to loopback (Caddy na tym samym hoście) — ostatni wpis
      `X-Forwarded-For` (ten, który dopisał Caddy; Caddy bez `trusted_proxies` zastępuje
      nagłówek klienta); inaczej adres gniazda, a nagłówek klienta jest ignorowany. Brak lub
      niepoprawny nagłówek za loopbackiem → adres gniazda (wspólny licznik).
  - **Zmiana adresu z potwierdzeniem** (zastępuje część D-027): pole `email_confirm` znika.
    Nowy adres trafia do `company_profiles.pending_email` (znormalizowany, bez UNIQUE); profil,
    sesje i linki zostają, a digest, linki i logowanie idą na stary adres do potwierdzenia. Na
    nowy adres idzie link `/potwierdz-email/<token>` (cel `email_change`, jednorazowy, 24 h,
    związany z adresem), na stary — powiadomienie bez linków i bez nowego adresu („Jeśli to
    nie Ty, zaloguj się i anuluj zmianę”; drogą do profilu jest link „Twój profil” z digestu
    albo „Wyślij mi link”, a po potwierdzeniu — operator, z `CONTACT_EMAIL`, gdy ustawiony).
    Powiadomienie idzie pierwsze, potem link (także gdy powiadomienie nie wyszło): błąd
    wysyłki linku ani zatrzymanie `serve` w jej trakcie nie odbiera staremu adresowi
    ostrzeżenia; zadanie porzucone przy powiadomieniu nie wysyła już linku. Kolejna zmiana zastępuje oczekującą (stary token
    usunięty); zapis z niezmienionym adresem zostawia oczekującą zmianę. Najwyżej 3
    potwierdzenia na profil w 24 h (ten sam licznik `access_emails`, rodzaj `email_change`);
    ponad limit formularz pokazuje błąd i niczego nie zapisuje (sesja właściciela — nic nie
    ujawnia). `/profil` i formularz pokazują „Oczekuje na potwierdzenie: <adres>” (po
    wygaśnięciu linku — że link wygasł i jak dostać nowy) z
    przyciskiem „Anuluj zmianę” (`POST /profil/anuluj-email`, sesja + CSRF; czyści
    `pending_email` i usuwa token; idempotentne).
  - **Brak wyroczni przy zmianie:** zapis formularza nie sprawdza, czy inny profil ma adres —
    każdy poprawny adres przechodzi do potwierdzenia.
  - **Potwierdzenie:** GET (i HEAD) tylko sprawdza token i pokazuje stronę z przyciskiem
    (skaner poczty niczego nie zmienia); POST (login-CSRF) w jednej transakcji: wiersz
    profilu `FOR NO KEY UPDATE` → ponowny odczyt tokenu pod blokadą (musi wskazywać bieżący
    `pending_email`) → sesja przeglądarki `FOR KEY SHARE`, gdy należy do profilu → usunięcie
    wszystkich tokenów profilu (także tego — zużycie) i wszystkich jego sesji poza tą →
    `UPDATE email = pending_email, pending_email = NULL` na końcu. Kolejność blokad z D-027;
    `UPDATE` klucza unikalnego bierze blokadę siły `FOR UPDATE`, ale logowanie, które mogłoby
    na nią czekać, trzyma już tylko wiersz tokenu, na który usuwanie tokenów zaczekało
    wcześniej. Po 40P01 jedna ponowna próba. Wyścig dwóch potwierdzeń: drugie czeka na
    wiersz profilu i znajduje token usunięty → neutralna strona nieważnego linku (404).
    Adres zajęty w chwili potwierdzenia (`company_profiles_email_key`) → wycofanie i
    neutralna strona 409, bez zmiany. Przeglądarka z sesją profilu zostaje zalogowana (303
    na `/profil` z komunikatem), inna dostaje stronę „Adres zmieniony” bez sesji.
  - **Strona główna `/`:** czym jest serwis (codzienny e-mail z zamówieniami dopasowanymi do
    profilu firmy), skąd dane (BZP — e-Zamówienia — i Baza Konkurencyjności), jak zacząć
    (obecnie przez operatora), formularz „Wyślij mi link”, link do `/przyklad`, kontakt.
    `/przyklad` renderuje przykładowy digest widokiem `/dopasowania` ze stałych,
    pseudonimizowanych danych w kodzie (`src/web/example.ts`), bez bazy. `CONTACT_EMAIL` —
    opcjonalny, walidowany przy starcie `serve` (niepoprawny → kod 1); pokazywany na `/`, na
    stronach 409 i 429 i w powiadomieniu na stary adres, bez niego kontakt nie jest
    pokazywany.
  - **Logi:** każdy wynik e-maila dostępu to jedna linia „access mail” z rodzajem
    (`login_link`, `email_change`, `email_change_notice`), wynikiem (`sent`, `no_profile`,
    `limit_reached`, `send_failed`, `dropped`, `failed`, `not_sent`) i najwyżej id profilu i
    kodem błędu — nigdy adres, token, link ani IP.
  - **Wdrożenie:** `serve` czyta konfigurację e-maila (`EMAIL_MODE`, `EMAIL_FROM`, `SMTP_URL`,
    `EMAIL_OUTBOX_DIR`); `radar-serve.service` dostaje `ReadWritePaths=` na outbox i zachowuje
    filtr IP tylko na loopback (`IPAddressDeny=any`, `IPAddressAllow=localhost`) — domyślny
    `EMAIL_MODE=test` nie potrzebuje wyjścia. Dla `EMAIL_MODE=smtp` obowiązkowy drop-in
    `deploy/systemd/radar-serve.service.d/smtp.conf` zeruje `IPAddressDeny=` (adresy dostawcy
    SMTP są zmienne); systemd nie ogranicza wtedy wcale ruchu wychodzącego `serve` (dowolny
    host i port), jak dla digestu i alertów z crona, które działają bez sandboksu systemd —
    ograniczyć go może tylko firewall hosta z regułami wyjścia. Caddy pomija i redaguje ścieżki
    `/potwierdz-email/…` jak `/dostep/…`.
- **Odrzucone alternatywy:**
  - wysyłka w obsłudze żądania (czas odpowiedzi zdradza, czy adres ma profil; SMTP trzyma
    żądanie);
  - kolejka w bazie albo osobny proces wysyłki (więcej ruchomych części bez potrzeby przy
    10–100 klientach; utrata kilku czekających zadań przy restarcie jest akceptowalna — klient
    poprosi znowu);
  - limit na IP w bazie (zapis przy każdym żądaniu anonimowym; limit chroniący skrzynkę i tak
    jest w bazie) albo na reverse proxy (moduł spoza dystrybucji Caddy — etap 5 pkt 1);
  - licznik limitu przez warunkowy `INSERT … SELECT` bez blokady profilu (dwa równoległe
    żądania w READ COMMITTED widzą ten sam stan); blokada wiersza, którą i tak biorą
    wszystkie zapisy dostępu profilu, jest prostsza;
  - token potwierdzenia z `used_at` (unieważnienie i tak usuwa wszystkie tokeny profilu);
  - UNIQUE na `pending_email` (byłby wyrocznią przy zapisie formularza);
  - CAPTCHA (poza zakresem; zasady zbierania danych i UX), samodzielna rejestracja (poza
    zakresem PR-10).
- **Konsekwencje i znane ograniczenia:**
  - limit na IP i kolejka żyją w pamięci: restart `serve` je zeruje, a czekające e-maile
    przepadają (log `dropped`); limit na profil w bazie zostaje;
  - wiele firm za jednym NAT-em (albo w jednej sieci IPv6 /64) dzieli limit 10 na godzinę;
  - nieudana wysyłka zużywa jedno z 3 dziennych miejsc profilu;
  - po wygaśnięciu tokenu `email_change` (albo `access:revoke`) `pending_email` zostaje, aż
    klient anuluje albo zapisze adres ponownie (nowy link); `/profil` i ustawienia mówią
    wtedy, że link wygasł (podzapytanie `EXISTS` w tym samym odczycie profilu), zamiast
    „Oczekuje na potwierdzenie”;
  - `email_change` odrzucony z pełnej kolejki albo przy zatrzymaniu liczy się do limitu 3
    potwierdzeń na dobę (zapis i licznik są przed kolejką), choć e-mail nie wyszedł;
  - kto ma sesję i dostęp do innej skrzynki, nadal może przenieść powiadomienia (D-027), ale
    stary adres dostaje powiadomienie;
  - `serve` potrzebuje wyjścia do SMTP w trybie `smtp` (drop-in `smtp.conf`); porzucona przy
    zatrzymaniu wysyłka może jeszcze trzymać proces do zamknięcia gniazda SMTP, najdłużej do
    `TimeoutStopSec` (serwer HTTP, transport SMTP i pula połączeń z bazą są już zamknięte);
  - teoretyczny cykl blokad z godzinnym sprzątaniem: zapis i potwierdzenie ponawiają raz,
    „Wyślij mi link” nie (błąd → log `failed`, klient prosi znowu).
