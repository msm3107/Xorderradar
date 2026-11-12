# PR Plan — Radar Zamówień

Każdy PR: jeden główny cel, kryteria akceptacji, lista „poza zakresem”, testy, Code & Safety
Review (PASS), Quality Review (ACCEPT), aktualizacja `docs/STATE.md`. Workflow:
`docs/AGENTS.md`. Definition of Done: `docs/MASTER_PROMPT.md` §13.

Jeżeli w trakcie PR okaże się, że zakres jest za duży — dzielimy go (PR-0xA, PR-0xB) i
zapisujemy podział tutaj, zamiast rozszerzać PR.

---

## PR-00 — Project Bootstrap

**Cel:** przygotowanie repozytorium i zasad developmentu.

**Zakres:**

- `package.json`, pnpm, Node ≥ 22.13, TypeScript (strict), ESLint (strictTypeChecked),
  Prettier, Vitest;
- `.env.example`, `.gitignore`, `.nvmrc`;
- minimalne CLI z komendą `health` + walidacja konfiguracji (zod) + logger JSON;
- testy jednostkowe i smoke test uruchamiający prawdziwy entry point;
- `CLAUDE.md`, `README.md`, `docs/*` (MASTER_PROMPT, PRODUCT, ARCHITECTURE, ROADMAP,
  PR_PLAN, AGENTS, SECURITY, DECISIONS, STATE);
- 3 definicje agentów w `.claude/agents/`.

**Kryteria akceptacji:**

1. `pnpm install` na czystym checkoucie działa; `pnpm audit` nie zgłasza podatności.
2. `pnpm check` (format:check, lint, typecheck, test) przechodzi.
3. `pnpm health` i `pnpm build && node dist/main.js health` zwracają `{"status":"ok",...}`
   z kodem 0; nieznana komenda → kod 2; błędna konfiguracja → kod 1 bez ujawnienia wartości.
4. Istnieją dokładnie 3 definicje agentów, a `docs/AGENTS.md` opisuje ich użycie.
5. Struktura katalogów odpowiada istniejącemu kodowi (brak pustych katalogów).
6. Dokumentacja odróżnia stan obecny od planu.

**Poza zakresem:** baza danych, adaptery źródeł, HTTP client, matching, e-mail, UI, CI,
deployment.

---

## PR-01 — Core Domain & Database

**Cel:** minimalny model danych i trwały zapis.

**Zakres:**

- decyzja ORM/migracje (D-007) i jej realizacja;
- `DATABASE_URL` w konfiguracji; pula połączeń z limitem i timeoutem;
- typy domenowe: `Source`, `Opportunity`, `CompanyProfile` (+ walidacja schematem);
- migracje: `sources`, `opportunities`, `company_profiles` z ograniczeniami z
  `docs/ARCHITECTURE.md` §5;
- repozytoria: zapis/odczyt źródeł, upsert opportunity po kluczu deduplikacji (sam
  mechanizm; reguły fingerprintu w PR-03), CRUD profilu;
- `health` sprawdza połączenie z bazą;
- lokalny PostgreSQL do testów (docker compose lub instrukcja) i testy integracyjne.

**Kryteria akceptacji:**

1. Migracje uruchamiają się na pustej bazie i są idempotentne przy ponownym uruchomieniu.
2. Brak wartości jest zapisywany jako `NULL` (test: `estimatedValue` nieobecna ≠ 0).
3. Naruszenie unikalności / CHECK jest zwracane jako jawny błąd domenowy, nie wyjątek SQL.
4. Wszystkie zapytania parametryzowane (review).
5. Testy modelu i repozytoriów przechodzą na prawdziwym PostgreSQL.
6. `health` zwraca błąd (kod 1) przy niedostępnej bazie, bez ujawnienia hasła z URL.

**Poza zakresem:** scraping, HTTP, fingerprint/normalizacja, matching, e-mail, UI.

---

## PR-02 — First Source Adapter

**Cel:** pobrać prawdziwe zamówienia z **jednego** publicznego źródła.

**Podział:**

- PR-02A: SafeHttpClient (kryterium akceptacji 3).
- PR-02B: wybór źródła + adapter (kryteria akceptacji 1, 2, 4).

**Krok 0 (przed kodem):** wybór źródła i zapis w DECISIONS: weryfikacja regulaminu,
`robots.txt`, dostępności API/feedu, licencji danych, częstotliwości publikacji i tego, czy
źródło faktycznie zawiera małe zamówienia. Kandydaci (wymagają weryfikacji, niczego nie
zakładamy): Baza Konkurencyjności (zapytania ofertowe w projektach UE), Biuletyn Zamówień
Publicznych / platforma e-Zamówienia, publiczne platformy zakupowe jednostek, wybrane BIP-y
z RSS. Preferencja: API → feed → dane strukturalne → HTML.

**Zakres:**

- `infrastructure/http` — SafeHttpClient (timeout, User-Agent, rate limit, retry z limitem,
  limit rozmiaru, allowlista hostów, SSRF, walidacja redirectów);
- jeden adapter `fetch → extract → normalize`;
- fixtures z prawdziwych odpowiedzi (bez danych osobowych spoza ogłoszeń);
- testy parsera (w tym: brakujące pola, zmieniony format, pusta lista, uszkodzony dokument);
- komenda diagnostyczna CLI (np. `source:preview <id>`) wypisująca znormalizowane rekordy
  bez zapisu do bazy;
- logi z `sourceId`, czasem, statusem, liczbą rekordów.

**Kryteria akceptacji:**

1. Adapter pobiera rzeczywiste ogłoszenia (ręczna weryfikacja `source:preview`).
2. Parser przechodzi testy na fixture'ach; nie jest „dopasowany” do jednego pliku.
3. Testy SafeHttpClient: timeout, przekroczenie rozmiaru, host spoza allowlisty, adres
   prywatny, redirect poza allowlistę, retry tylko dla błędów przejściowych.
4. Brak zapisu wartości nieobecnych w źródle.

**Poza zakresem:** zapis do bazy, deduplikacja, kolejne źródła, matching.

---

## PR-03 — Ingestion, Normalization & Deduplication

**Cel:** zapisywać dane ze źródła w ujednoliconym formacie, bez duplikatów.

**Podział:**

- **PR-03A — rdzeń ingestu:** fingerprint + `content_hash`, deduplikacja i wykrywanie zmian
  (`inserted/updated/unchanged/rejected`), komenda `ingest` z advisory lockiem, tabela
  `ingestion_runs`, testy integracyjne. Kryteria akceptacji 1–4.
- **PR-03B — zmiany ogłoszeń BZP i nadrabianie pominiętych dni** (podział decyzją właściciela;
  helpery normalizacji przeniesione bez zmian do PR-03C, w PR-03B tylko przeliczenie czasu
  Europe/Warsaw → UTC potrzebne dla terminu ze zmiany):
  - **zmiany ogłoszeń (`NoticeUpdateNotice`, D-015):** pobieranie typu `NoticeUpdateNotice`
    (z tym samym limitem rekordów/stron na typ co pozostałe); powiązanie z pierwotnym
    ogłoszeniem wyłącznie przez `tenderId` (kolumna `tender_id`, PR-03A); wyciągnięcie nowego
    terminu składania ofert z `htmlBody` — HTML jest niezaufany: wyciągamy tylko tę jedną
    wartość, nie przechowujemy HTML-a; brak albo nieparsowalna wartość → brak zmiany (nigdy
    zgadywanie); aktualizacja `deadline` pierwotnego ogłoszenia, wykryta jako `updated`;
    rekordy `NoticeUpdateNotice` **nie są zapisywane jako osobne oferty** w `opportunities`
    (byłyby szumem w matchingu i digeście) — służą wyłącznie do aktualizacji pierwotnego
    ogłoszenia;
  - **termin ze zmiany jest trwały:** ponowny ingest pierwotnego ogłoszenia (backfill
    `ingest --date …` albo każde ponowne pobranie) mapuje znowu jego pierwotne
    `submittingOffersDate`, więc bez dodatkowej reguły `content_hash` się różni, wiersz staje
    się `updated` i przedłużony termin wraca do pierwotnego. PR-03B musi temu zapobiec (sposób
    — np. zapamiętanie, które ogłoszenie ustawiło termin — do decyzji w PR-03B, zapisanej w
    D-015);
  - **kolejność zmian:** gdy dla jednego `tenderId` jest kilka `NoticeUpdateNotice`, wygrywa
    zmiana o najpóźniejszej dacie publikacji; starsza zmiana (np. pobrana później przy
    backfillu) nie nadpisuje nowszej;
  - **który wiersz** (rozstrzygnięte przez właściciela): gdy kilka wierszy ma ten sam
    `(source_id, tender_id)`, zmiana trafia do starszego —
    `published_at ASC NULLS LAST, first_seen_at ASC, id ASC` (D-015);
  - **Kryteria akceptacji PR-03B (zmiany ogłoszeń):**
    1. `NoticeUpdateNotice` z nowym terminem zmienia `deadline` pierwotnego ogłoszenia
       (znalezionego po `source_id` + `tender_id`); przebieg liczy to jako `updated`.
    2. Brak pierwotnego ogłoszenia, brak `tenderId`, brak lub nieparsowalny termin w
       `htmlBody` → zapisany wiersz bez zmian, powód zalogowany (bez treści HTML), nic nie jest
       zgadywane.
    3. Testy na pseudonimizowanych fixture'ach prawdziwych `NoticeUpdateNotice` (także z
       `htmlBody` dotyczącym czegoś innego niż termin) i na wrogim/niepoprawnym HTML-u.
    4. Ponowny ingest pierwotnego ogłoszenia (także backfill jego dnia publikacji po dniu
       zmiany) nie przywraca terminu sprzed `NoticeUpdateNotice` — z testem.
    5. Przy kilku `NoticeUpdateNotice` jednego `tenderId` obowiązuje termin z najpóźniej
       opublikowanej, niezależnie od kolejności ingestu — z testem.
    6. `NoticeUpdateNotice` nie tworzy własnego wiersza w `opportunities` (test: liczba ofert
       po ingeście dnia z samymi zmianami się nie zmienia).
  - **nadrabianie pominiętych dni (decyzja właściciela, D-021):**
    `ingest --from YYYY-MM-DD --to YYYY-MM-DD`; bez opcji dnia — automatycznie niepokryte dni
    źródła w `ingestion_runs` z ostatnich 31 dni do wczoraj (cron, który nie ruszył przez
    kilka dni, dziś gubi te dni; to samo dotyczy zmian ogłoszeń z tych dni).
  - **Kryteria akceptacji PR-03B (nadrabianie):**

    7. `ingest --from A --to B` pobiera każdy dzień zakresu (jeden przebieg na źródło i dzień);
       niepoprawny zakres (`A > B`, ponad 31 dni, tylko jedna z opcji, razem z `--date`) →
       błąd użycia bez pobierania.
    8. Bez opcji dnia `ingest` pobiera niepokryte dni (pokryty = przebieg `succeeded` albo
       `incomplete` rozpoczęty po końcu dnia) z 31 dni kończących się wczoraj, od
       najwcześniejszego dnia dowolnego przebiegu źródła; źródło bez przebiegów — tylko
       wczoraj; nic do nadrobienia — nic nie jest pobierane; brakujące dni starsze niż okno nie
       są pobierane, te po najnowszym pokrytym dniu (albo od pierwszego przebiegu, gdy nic nie
       jest pokryte) są raportowane jako przycięte.
    9. Nieudany dzień nie zatrzymuje kolejnych dni tego źródła i jest ponawiany przez
       następne nadrabianie, dopóki jest w oknie; po 2 kolejnych nieudanych pierwszych próbach
       w tym przebiegu (pierwsza próba = dzień bez żadnego wcześniejszego przebiegu źródła;
       nieudane ponowienie nie zwiększa ani nie zeruje licznika, udany dzień go zeruje)
       pozostałe dni źródła są raportowane jako niewykonane (`consecutive_failures`), we
       wszystkich trybach — z testami integracyjnymi.

    _Zmiana AC8–AC9 w przeglądzie właściciela PR #6:_ wcześniej nadrabianie liczyło od dnia po
    najnowszym pokrytym dniu, a nieudany dzień zatrzymywał kolejne dni źródła; różnica zbiorów
    sprawia, że ręczne `--date` późniejszego dnia nie przeskakuje nieudanego dnia, a dzień,
    który zawsze się nie udaje, nie blokuje nowszych (D-021). W tej samej rundzie: limit
    `htmlBody` podniesiony do 1 000 000 znaków (zaobserwowano 255 562) i
    `runs[].skippedReasons` w raporcie `ingest`. W przeglądzie C&S tej rundy limit AC9
    zawężony do pierwszych prób: dwa dni, które stale się nie udają, nie blokują nowszych.

- **PR-03C — helpery normalizacji** (przeniesione bez zmian z PR-03B):
  - **helpery normalizacji:** białe znaki, HTML → tekst (`htmlBody`: opis, kontakt, wartość),
    daty Europe/Warsaw, województwa/powiaty, słownik kategorii (CPV → kategorie MVP), fallback
    niepoprawnego e-maila do `contact.raw`, pseudonimizowane fixture'y HTML.
  - **Doprecyzowanie zakresu (koordynator, na podstawie fixture'ów 2026-10-29):**
    - wspólny moduł `src/sources/normalize/` (czyste funkcje, bez I/O): białe znaki, HTML →
      segmenty tekstu (przeniesiony liniowy skaner z `bzp/notice-update.ts`, zachowanie
      bez zmian), tekst do porównań (małe litery, bez diakrytyków, także `ł` → `l`; tylko do
      porównań, nigdy do zapisu), województwa (16 kanonicznych nazw, np. `mazowieckie`; wejście
      z wielkimi literami, „woj.”, „województwo”, bez polskich znaków), słownik CPV → kategorie
      MVP; daty Europe/Warsaw — istniejący `warsaw-time.ts` przeniesiony do modułu, bez zmian
      zachowania;
    - **powiaty:** BZP nie podaje powiatu (NUTS 3 to podregion, nie powiat), więc
      `location.county` zostaje puste — nie wyprowadzamy go (byłoby zgadywaniem); helper tylko
      normalizuje zapis (`powiat`/`pow.`, białe znaki, wielkość liter) dla profilu w PR-04,
      bez słownika 380 powiatów (YAGNI);
    - **kategorie (decyzja do D-022):** `categories` dalej przechowuje kody CPV ze źródła
      (weryfikowalne, bez zmiany `content_hash` przy strojeniu słownika); słownik CPV →
      kategorie MVP jest czystą funkcją (`mvpCategoriesForCpv`) używaną przez matching w
      PR-04 — zmiana słownika działa od razu, bez ponownego ingestu;
    - **BZP `htmlBody` ofert** (`ContractNotice` i `SmallContractNotice`, ≤ 1 000 000 znaków):
      odczyt w ekstrakcji, w ofercie zostają tylko wyciągnięte wartości (HTML nie jest
      przechowywany ani logowany); etykiety w obu numeracjach: opis 4.2.2.) / 3.3.), e-mail
      1.5.9.) / 1.4.9.), telefon 1.5.7.) / 1.4.7.), wartość 4.1.5.) (`181300 PLN`) / 3.4.) +
      3.5) Kod waluty (`153812,40` + `PLN`);
  - **Kryteria akceptacji PR-03C:**
    1. Opis ofert BZP pochodzi z `htmlBody` (segmenty po etykiecie do następnej numerowanej
       etykiety sekcji formularza; kilka wystąpień — np. części — łączone w kolejności), białe
       znaki znormalizowane z zachowaniem podziału na akapity; dłuższy niż 10 000 znaków →
       skrócony na granicy słowa z „…”; brak etykiety → `null`.
    2. Kontakt: opublikowany e-mail (poprawny → `contact.email` w małych literach) i telefon;
       niepoprawny e-mail (albo telefon dłuższy niż limit) → `contact.raw`, nigdy odrzucenie
       oferty; brak obu → `contact = null`. Bez wzbogacania z innych źródeł.
    3. Wartość: tylko przy dokładnie jednym wystąpieniu etykiety wartości i ścisłym formacie
       (cyfry, opcjonalne separatory tysięcy spacją/NBSP, część ułamkowa przecinkiem lub
       kropką) z jednoznaczną walutą ISO z tego samego bloku albo z „Kod waluty”; cokolwiek
       innego (brak, kilka, niejednoznaczne, poza zakresem `decimalAmountSchema`) →
       `estimatedValue = currency = null`, nigdy zgadywanie ani `0`.
    4. `htmlBody` brakujący, za długi, niedomknięty lub wrogi nie odrzuca oferty: pola z
       `htmlBody` zostają `null` (pozostałe mapowanie bez zmian); czas liniowy względem długości
       (test na złośliwym wejściu); HTML nie trafia do logów ani do bazy.
    5. Helpery normalizacji (białe znaki, tekst do porównań, województwa, powiaty, CPV →
       kategorie MVP) mają testy jednostkowe z polskimi znakami i przypadkami brzegowymi;
       nieznana wartość → `null`/pusta lista, nigdy zgadywanie.
    6. Testy na pseudonimizowanych fixture'ach HTML obu typów (z wartością i bez, z
       telefonem i bez, z niepoprawnym e-mailem); dotychczasowe testy PR-03A/B przechodzą bez
       osłabiania.
    7. Dokumentacja: konsekwencja dla `content_hash` (ponownie pobrane wiersze stają się
       `updated` raz; terminy ze zmian zostają — PR-03B AC4) w D-016/D-022, README,
       ARCHITECTURE.
  - **Poza zakresem PR-03C:** matching (PR-04), zapis kategorii MVP w bazie, słownik powiatów,
    ogłoszenia o unieważnieniu (Next action), miejsce realizacji zamówienia (inne niż
    siedziba zamawiającego), drugie źródło.

**Zakres:**

- wspólne helpery normalizacji (daty w strefie Europe/Warsaw, białe znaki, HTML → tekst,
  województwa/powiaty, kategorie słownikowe);
- fingerprint i `content_hash` (ARCHITECTURE §5);
- deduplikacja i wykrywanie zmian (`inserted/updated/unchanged/rejected`);
- komenda `ingest` (wszystkie włączone źródła lub wskazane), advisory lock;
- tabela `ingestion_runs`;
- testy integracyjne: dwa przebiegi na tym samym fixture → brak duplikatów; zmiana treści →
  `updated`; błąd jednego źródła nie przerywa reszty.

**Kryteria akceptacji:**

1. Dwukrotne uruchomienie `ingest` na tych samych danych nie tworzy duplikatów.
2. Zmiana terminu/treści jest wykryta jako aktualizacja.
   _Uwaga (przegląd właściciela PR-03A, zapytanie na żywo 2026-10-28):_ kryterium jest
   spełnione mechanicznie (ponowne pobranie zmienionego ogłoszenia → `updated`, testy), ale
   dla BZP w produkcji nie wystąpi: zmiany są osobnymi ogłoszeniami `NoticeUpdateNotice`
   (nowy termin tylko w `htmlBody`), których PR-03A nie pobiera. Dla BZP zależy od PR-03B.
3. Równoległe uruchomienia nie psują danych (lock + ograniczenia unikalności).
4. Podsumowanie przebiegu jest zapisane i zalogowane.

**Poza zakresem:** matching, e-mail, UI, deduplikacja między różnymi źródłami.

---

## PR-04 — Matching Engine

**Cel:** dopasować zamówienie do prostego profilu firmy.

**Zakres:**

- profil: kategorie, include/exclude keywords, województwa/powiaty;
- scoring (ARCHITECTURE §4.4), próg dopasowania;
- wyjaśnienie dopasowania (`reasons`);
- komenda operatorska do zakładania/podglądu profilu i `match:preview <profileId>`;
- tabela przypadków testowych (pozytywne, negatywne, wykluczenia, polskie znaki, odmiana
  przez przypadki w zakresie prostych reguł).

**Kryteria akceptacji:**

1. Wynik deterministyczny i w pełni wyjaśniony przez `reasons`.
2. Słowo wykluczające zawsze wyklucza.
3. Brak lokalizacji w ogłoszeniu nie jest traktowany jako zgodność regionu.
4. Brak LLM i zależności sieciowych w matchingu.
5. Profil z powiatami a oferta z pustym `location.county` (BZP): `reasons` jawnie podaje, że
   źródło nie podaje powiatu — nie cichy brak dopasowania i nie zgodność (D-022).
6. Oferty bez CPV (małe zamówienia BZP) są dopasowywane po słowach kluczowych z tytułu i
   opisu (`comparableText`); pokryte testami.
7. Powiaty porównywane jako `comparableText(normalizeCounty(…))` po obu stronach; testy
   obejmują warianty typu „m. st. Warszawa”/„m.st. Warszawa”, a decyzja o nich jest zapisana.

**Poza zakresem:** e-mail, UI, LLM, uczenie maszynowe.

---

## PR-05 — Alert / Daily Digest

**Cel:** dostarczyć wartość użytkownikowi.

**Zakres:**

- decyzja o providerze (D-010) — preferencja: SMTP przez dowolnego dostawcę;
- digest: jeden e-mail na profil dziennie, tylko gdy są nowe dopasowania;
- prosty szablon tekst + HTML (escapowanie wszystkich danych ze źródeł);
- idempotencja (`deliveries`), retry z limitem;
- tryb `test` (domyślny) — brak prawdziwej wysyłki;
- komenda `digest` (+ `--dry-run`).

**Kryteria akceptacji:**

1. Ponowne uruchomienie `digest` tego samego dnia nie wysyła duplikatów.
2. E-mail zawiera tylko istotne pola i link do źródła; ogłoszenia po terminie są pomijane.
   _Uwaga:_ przed PR-03B zapisany `deadline` ogłoszeń BZP może być nieaktualny (przedłużenia
   terminu przychodzą jako `NoticeUpdateNotice`, D-015) — pomijanie po terminie nie może
   wtedy polegać na nim dla BZP, bo odrzucałoby przetargi z przedłużonym terminem.
3. Dane ze źródeł są escapowane w HTML (test z wrogim tytułem).
4. Tryb `smtp` wymaga jawnej konfiguracji; testy nie wysyłają prawdziwych maili.

**Poza zakresem:** UI, kolejne kanały, rezygnacja przez UI (link wypisu z tokenem — tak,
jeśli wymagany prawnie; inaczej PR-06).

---

## PR-06 — Minimal User Interface

**Cel:** użytkownik konfiguruje profil, widzi dopasowane zamówienia, otwiera źródło.

**Wstępny podział (aby nie mieszać auth z UI):**

- **PR-06A — Dostęp do profilu:** dostęp przez jednorazowy link z e-maila (token losowy,
  przechowywany jako hash, z wygaśnięciem), sesja w ciasteczku `HttpOnly; Secure;
SameSite=Lax`, CSRF dla formularzy. Bez haseł w MVP.
- **PR-06B — Ekrany:** formularz profilu, lista dopasowań z wyjaśnieniem, link do źródła.
  Renderowanie po stronie serwera, dostępne formularze, czytelne stany puste/błędu.
  Kryteria z review PR-06A (właściciel):
  - przycisk „Włącz ponownie powiadomienia” na `/profil` (POST + CSRF), aby przypadkowy
    wypis (np. przez skaner bezpieczeństwa poczty) nie wymagał operatora;
  - ochrona przed login-CSRF na `POST /dostep`: odrzucać `Sec-Fetch-Site: cross-site` albo
    wymagać `Origin`/`Sec-Fetch-Site` na tej trasie — zanim formularz profilu zacznie
    przyjmować dane;
  - zmiana e-maila w profilu unieważnia pozostałe sesje i tokeny profilu (ponowne użycie
    `revokeProfileAccess`, z zachowaniem bieżącej sesji).

  **Stan PR-06B:** zaimplementowane, w review (D-027). Trasy `/profil/ustawienia` (formularz,
  ciało ≤ 64 KB tylko tutaj), `/dopasowania` (reguły i kandydaci digestu, najbliższy termin
  pierwszy, najwyżej 50 pozycji), `POST /profil/wlacz`; login-CSRF przez `Origin` albo
  `Sec-Fetch-Site`; zmiana e-maila w jednej transakcji z unieważnieniem tokenów i innych
  sesji. Uwagi:
  - `Referrer-Policy` zmieniona z `no-referrer` na `strict-origin` — przy `no-referrer`
    przeglądarki wysyłają `Origin: null` i kontrola `Origin` z PR-06A odrzucała formularze;
  - nowy adres e-mail nie jest potwierdzany wiadomością (brak wysyłki z procesu web), a błąd
    „adres zajęty” ujawnia, że adres jest w systemie;
  - `/dopasowania` liczy dopasowanie w procesie `serve` (ok. 0,8 s przy 5 000 kandydatach i typowym
    profilu, kilkanaście sekund w najgorszym przypadku), oddając pętlę zdarzeń po każdych ok. 20 ms
    pracy; najwyżej jedno liczenie naraz (kolejne czeka w kolejce FIFO — najwyżej 8 żądań i 3 s —
    a przy pełnej kolejce albo po czasie dostaje 503 z `Retry-After`) — limit żądań tej trasy na
    proxy w PR-07, optymalizacja dopiero po pomiarze na danych pilota;
  - poprawki po review: kolejność blokad zmiany e-maila bez cyklu z logowaniem (było 40P01)
    i jedna ponowna próba po 40P01, ponowne sprawdzenie sesji w transakcji, CSRF przed
    walidacją formularza, digest bez linków na adres zmieniony w trakcie
    (`address_changed`);
  - po review właściciela: krótka kolejka FIFO zamiast natychmiastowego 503 na `/dopasowania`
    (bez cache wyników — D-027), zwarte karty dopasowań (lokalizacja widoczna, reszta pól w
    `<details>`), adres powiadomień na `/profil`;
  - do zrobienia później: powiadomienie na stary adres po zmianie (wymaga wysyłki z procesu
    web);
  - bez zmian (otwarte decyzje właściciela): ważność 7/60/30 dni, brak formularza „wyślij mi
    link”, ścisły multipart RFC 2046 na `/wypis`, linki w digeście jak w PR-06A.

**Kryteria akceptacji (łącznie):** użytkownik bez instrukcji ustawia profil i widzi wyniki;
autoryzacja po stronie serwera dla każdego zasobu; brak dashboardu analitycznego.

**Poza zakresem:** panel administracyjny, statystyki, płatności, SPA.

---

## PR-07 — MVP Hardening

**Cel:** działająca wersja pilotażowa.

**Zakres:** poprawki bezpieczeństwa z review, przegląd retry/timeoutów, raportowanie błędów,
deployment (jeden host/kontener + zarządzany PostgreSQL), cron, strategia backupu z
**przetestowanym odtworzeniem**, smoke testy po deployu, CI (format/lint/typecheck/test),
dokumentacja operacyjna (runbook: dodanie źródła, wyłączenie źródła, ponowna wysyłka, restore).

**Kryteria akceptacji:** pełny przepływ działa na środowisku pilotażowym; backup odtworzony
testowo; błąd źródła widoczny dla operatora w ciągu jednego cyklu.

**Poza zakresem:** płatności, nowe funkcje produktu.

**Podział (koordynator, po merge'u PR-06B):** część repozytoryjna, którą da się w pełni
przetestować bez hosta pilotażowego, i część wdrożeniowa, która zależy od wyboru hostingu
przez właściciela (otwarte pytanie z „Blockers” w `docs/STATE.md`: czy host crona ma
bezpośredni wychodzący HTTPS — D-014).

- **PR-07A — Gotowość operacyjna (repozytorium):**
  - **CI** (GitHub Actions): `pnpm install --frozen-lockfile` i `pnpm check` na Node 22 z
    PostgreSQL 16 (`CI`, `REQUIRE_DB_TESTS=1`, `TEST_DATABASE_URL`), minimalne uprawnienia
    (`contents: read`), akcje przypięte do wersji;
  - **raport operatora** `status [--notify]`: ostatni przebieg każdego włączonego źródła
    (status, `errorCode`, czas), źródło bez udanego przebiegu w oczekiwanym oknie, niepewne
    (`pending`) i nieudane doręczenia; kod 1 przy problemie; `--notify` wysyła przy problemie
    e-mail na `OPERATOR_EMAIL` istniejącym transportem (`test`/`smtp`) — bez adresów klientów
    i treści ofert. Uruchamiany z crona po `ingest`/`digest`, więc błąd źródła dociera do
    operatora w tym samym cyklu;
  - **kopia i odtworzenie**: komendy `backup` (`pg_dump`, format custom, plik `0600`, hasło
    nigdy w argumentach procesu ani w logach) i `restore` (`pg_restore` tylko do pustej bazy,
    potem kontrola jak w `health`); test integracyjny kopia → odtworzenie → porównanie
    liczby wierszy w każdej tabeli (w CI);
  - **poprawki bezpieczeństwa z review:** limit równoległych żądań `/dopasowania` na sesję
    (C&S L-b z PR-06B), odrzucanie znaków sterujących `\p{Cc}` we wpisach profilu na wejściu
    (formularz i `profile:create`; C&S L-c), `Strict-Transport-Security` przy `https`
    w `PUBLIC_BASE_URL`;
  - **przegląd retry/timeoutów**: jedna tabela (źródła, baza, SMTP, serwer web) w
    `docs/ARCHITECTURE.md`, poprawki tylko dla wykazanych luk;
  - **runbook** `docs/RUNBOOK.md`: dodanie i wyłączenie źródła, ponowna wysyłka i niepewne
    doręczenia, kopia i odtworzenie, unieważnienie dostępu (`access:revoke`) po przekazanym
    e-mailu lub zmianie właściciela, obsługa skrzynki odpowiedzi, reakcja na alert `status`.

  **Kryteria akceptacji PR-07A:** CI uruchamia pełny `pnpm check` z testami bazy; test
  kopia → odtworzenie przechodzi i porównuje dane; nieudany przebieg źródła daje `status`
  z kodem 1 i (z `--notify`) e-mail do operatora w trybie `test`; jedna sesja nie zajmie
  więcej niż ustalony limit miejsc w kolejce `/dopasowania`; runbook pokrywa procedury z
  zakresu PR-07.

  **Poza zakresem PR-07A:** konfiguracja hosta, kontenera i reverse proxy, prawdziwe
  wdrożenie, nowe źródła, zmiany matchingu i treści digestu.

- **PR-07B — Wdrożenie pilotażowe** (po decyzji właściciela o hostingu): artefakty
  uruchomieniowe (obraz albo unit systemd), reverse proxy (TLS, limity żądań, bez logowania
  ścieżek `/dostep` i `/wypis`), crontab z `ingest`/`digest`/`status --notify`/`backup`,
  smoke test po wdrożeniu, kopia poza hostem, zewnętrzny heartbeat („dead man's switch”) dla
  `status` (ping po kodzie `0`, alarm przy braku pingu — cisza przy martwym hoście, cronie lub
  SMTP; albo drugi kanał, np. `MAILTO` crona przez inny serwer pocztowy), `status`
  sprawdzający wiek najnowszego `radar-*.dump` w katalogu kopii z env (brakująca kopia
  przestaje być cicha), pierwsze wdrożenie i odtworzenie kopii na środowisku pilotażowym
  (kryteria akceptacji całego PR-07).

  **Decyzja właściciela (2026-11-03):** VPS; `serve` jako unit systemd, komendy z crona na
  hoście; PostgreSQL 16 na tym samym VPS; Caddy jako reverse proxy z TLS; heartbeat przez
  URL pingu z env. VPS ma bezpośredni wychodzący HTTPS (bez proxy, D-014).

  **Zakres PR-07B (repozytorium):**
  - **artefakty w `deploy/`:** unit systemd dla `serve` (dedykowany użytkownik, hardening
    systemd, `Restart=on-failure`), plik crona (`ingest`, `status --notify`, `digest`,
    `backup`, retencja kopii), `Caddyfile` (TLS, nagłówki, limit rozmiaru żądania, timeouty,
    log dostępu bez ścieżek `/dostep/…` i `/wypis/…`), logrotate dla `/var/log/radar`,
    przykładowy plik env (`/etc/radar/radar.env`, `0640`, czytany przez systemd i
    `node --env-file`), skrypt smoke testu po wdrożeniu;
  - **`status`:** opcjonalny `BACKUP_DIR` → problem, gdy najnowszy `radar-*.dump` jest
    starszy niż ustalone okno albo go brak; opcjonalny `HEARTBEAT_URL` → po `status` z kodem
    `0` jeden ping (https, timeout, bez przekierowań, bez sekretów w logach); nieudany ping
    nie zmienia kodu wyjścia, tylko log;
  - **`docs/DEPLOY.md`:** instalacja od zera na VPS (Node 22, PostgreSQL 16 z PGDG, Caddy,
    użytkownik i katalogi, build, `migrate`, systemd, cron, heartbeat, kopia poza hostem
    zaszyfrowana `age`, aktualizacja wersji i powrót do poprzedniej), lista kontrolna
    pierwszego wdrożenia, ćwiczenie odtworzenia na VPS, weryfikacja AC1 z PR-02;
  - D-029 (hosting), aktualizacja RUNBOOK (ścieżki z `deploy/`, heartbeat, wiek kopii),
    README, `.env.example`, SECURITY.

  **Kryteria akceptacji PR-07B (repozytorium):** `status` zgłasza brak/przeterminowaną kopię i
  pinguje heartbeat tylko przy kodzie `0` (testy); artefakty `deploy/` są spójne z RUNBOOK i
  DEPLOY (ścieżki, użytkownik, zmienne); smoke test sprawdza `health`, `status` i stronę przez
  proxy; nic nie loguje tokenów ani sekretów. **Po merge'u, ręcznie przez właściciela na VPS**
  (wg `docs/DEPLOY.md`): pierwsze wdrożenie, smoke test, odtworzenie kopii, błąd źródła
  widoczny w jednym cyklu (kryteria całego PR-07).

  **Poza zakresem PR-07B:** kontenery, zarządzana baza, rate limiting w Caddy (wymaga
  modułu spoza dystrybucji — limit `/dopasowania` na sesję zostaje w aplikacji), nowe
  źródła, zmiany produktu.

---

## PR-08 — Drugie źródło: Baza Konkurencyjności (adapter `bk`)

**Cel:** zapytania ofertowe z projektów UE (zasada konkurencyjności, często poniżej 130 tys.
zł) jako drugie źródło (ROADMAP Phase 4, D-015: BZP ma niewiele małych zamówień). Wybór
właściciela 2026-11-04.

**Krok 0 (koordynator, 2026-11-04, curl przez proxy kontenera; zapis w D-030):**

- Strona `https://bazakonkurencyjnosci.funduszeeuropejskie.gov.pl` to SPA; `/robots.txt`
  zwraca HTML aplikacji (200 `text/html`), więc pliku `robots.txt` nie ma.
- Regulamin (`/api/regulations`, publikacja 2026-05-13): dostęp bezpłatny; ponowne
  wykorzystanie treści dozwolone pod warunkami MFiPR: podać źródło pełną nazwą ministerstwa
  („Ministerstwo Funduszy i Polityki Regionalnej”), datę pozyskania i informację o
  przetworzeniu. Brak zakazu odczytu automatycznego.
- Brak oficjalnego, opisanego API ani feedu. Publiczne JSON-y aplikacji działają bez
  logowania: `GET /api/announcements/search?page=&limit=(≤100)&sort=publicationDate&status[]=PUBLISHED&publicationDateRange[from]=D&publicationDateRange[to]=D`
  (`meta.total`; opis ucięty do 220 znaków) oraz `GET /api/announcements/{id}` (pełna
  treść: zamówienia, CPV, `estimated_value` „50000,00”, miejsca realizacji z województwem,
  termin, zamawiający, osoby kontaktowe). Bez `status[]` lub `sort` serwer zwraca 500.
- Wolumen: 180 (2026-11-03), 155 (2026-11-02), 10 (sobota 2026-10-31) opublikowanych
  ogłoszeń dziennie; `publication_date` na liście to data bieżącej wersji (zmiana ogłoszenia
  wraca z nową datą).
- Ryzyko: nieudokumentowane API aplikacji może się zmienić bez zapowiedzi → zmieniony format
  musi dawać czytelny błąd źródła (`status`), nigdy cichych zer.

**Zakres:**

- adapter `src/sources/bk/` (`fetch → extract → normalize`), allowlista
  `["bazakonkurencyjnosci.funduszeeuropejskie.gov.pl"]`, tylko `https`, SafeHttpClient
  (rate limit, limity rozmiaru): lista dnia (jedna strona 250; powyżej 250 strony w dwóch
  porządkach — przegląd właściciela PR #14) + szczegół każdego ogłoszenia;
  budżet `maxRecords` i niedokończony odczyt zgłaszany w `incomplete`;
- normalizacja: `externalId` = id ogłoszenia, `sourceUrl` = `/ogloszenia/{id}`, tytuł,
  zamawiający, opis, termin, data publikacji, CPV/kategorie, wartość (suma lub jedna
  wartość — reguła w D-030, nigdy zgadywana), waluta, lokalizacja (województwo), kontakt
  wg reguły D-022 (e-mail/telefon z ogłoszenia, bez imienia i nazwiska); brak = `null`;
- migracja: wiersz `sources` dla `bk`;
- **atrybucja** (warunek ponownego wykorzystania): przy ofertach `bk` w digeście i na
  `/dopasowania` — źródło z pełną nazwą ministerstwa, data pozyskania, informacja o
  przetworzeniu;
- czasy: dzień `bk` (~180 szczegółów × ≥ 2 s) musi mieścić się w limicie czasu źródła, a
  cały `ingest` przed `status` z crona (06:30) — albo zmiana harmonogramu z uzasadnieniem;
- fixtures z prawdziwych odpowiedzi, spseudonimizowane; testy parsera (brakujące pola,
  zmieniony format, pusta lista, uszkodzony dokument, limity); `source:preview bk`;
- D-030, README, ARCHITECTURE, SECURITY, RUNBOOK (dodanie źródła), DEPLOY (pierwsze dane
  `bk`), STATE.

**Kryteria akceptacji:**

1. `source:preview bk --date <dzień>` pobiera rzeczywiste ogłoszenia (ręcznie przez
   właściciela poza kontenerem, jak AC1 PR-02).
2. Parser przechodzi testy na kilku fixture'ach; zmieniony/uszkodzony format → błąd źródła
   z kodem, nie puste wyniki.
3. `ingest` zapisuje oferty `bk` z deduplikacją i aktualizacją zmienionej wersji
   (`updated`), a `status` widzi błąd `bk` w tym samym cyklu.
4. Brak zapisu wartości nieobecnych w źródle; brak imion i nazwisk osób kontaktowych.
5. Oferta `bk` w digeście i na `/dopasowania` ma atrybucję wymaganą przez regulamin.

**Poza zakresem:** załączniki (`/api/files/…`), archiwalna wersja Bazy, logowanie, wersje
historyczne ogłoszeń, zmiany matchingu, kolejne źródła.

---

## PR-09 — Kalibracja dopasowań i narzędzia operatora (przed pilotażem)

**Cel:** etap 3a `docs/LAUNCH_ROADMAP.md`. Mniej fałszywych dopasowań z samego opisu, koniec
ręcznego SQL przy niepewnych wysyłkach, czytelne etykiety w digeście i głośny sygnał o
powtarzanym `incomplete`. Zakres: wybór właściciela 2026-11-06 (wszystkie 4 punkty).

**Zakres:**

1. **Kalibracja scoringu (zmiana D-023):**
   - słowo kluczowe daje +30, gdy co najmniej jedno liczone słowo ma przydzielone trafienie
     w tytule; gdy wszystkie przydzielone trafienia są w opisie — +15 (`POINTS`); próg 50 i
     pozostałe punkty bez zmian. Skutek: samo słowo z opisu + zgodny region = 35 (nie
     przechodzi); kategoria + słowo z opisu przy nieznanym regionie = 55 (przechodzi);
     powód w `match:preview`/digeście pokazuje pole i punkty jak dziś;
   - `profile:create`: gdy profil ma słowa kluczowe, a nie ma słów wykluczających — jedna
     linia podpowiedzi na stderr (wąskie przykłady: „ciągnik”, „koparka”, „dostawa
     paliwa”, z uwagą, że wykluczenie działa też na opis — sprawdzić w `match:preview`), kod
     wyjścia bez zmian; profil nie jest zmieniany;
   - `match:preview`: licznik dopasowań bez żadnego słowa kluczowego („tylko kategoria”,
     czyli kategoria + region), obok dotychczasowych liczników.
2. **Komendy operatora (D-024):**
   - `deliveries:pending` — lista wierszy `pending`: `profileId`, `digestDate`, liczba ofert,
     najstarszy `created_at`; tylko identyfikatory i liczby, bez e-maili i tytułów (JSON);
   - `deliveries:resolve <profileId> --sent|--failed [--date YYYY-MM-DD]` — to samo co SQL z
     README „Wynik niepewny” (`--sent`: `sent`, `sent_at`, `attempts + 1`; `--failed`:
     usunięcie wierszy `pending`, kolejny digest wyśle oferty jak nowe), w jednej
     transakcji, tylko wiersze `pending`; odmowa (kod 1, bez zmian), gdy działa `digest`
     (ten sam advisory lock co `digest`) albo gdy profil nie ma wierszy `pending`; błędne
     wywołanie (oba lub żaden przełącznik, zły uuid lub data) → kod 2 jak w innych
     komendach, przed otwarciem bazy; wynik: liczba zmienionych wierszy;
   - README „Wynik niepewny” i RUNBOOK używają komend zamiast SQL.
3. **Etykiety i stopka:** powód kategorii w digeście i na `/dopasowania` z etykietą
   (`CATEGORY_LABELS`, „kategoria: „Sprzątanie””, etykiety w cudzysłowach, bez kodów CPV),
   nie z kluczem; linia „Kategoria:” — etykiety i „ · CPV: ” z kodami; stopka digestu mówi,
   co daje strona profilu („Na stronie profilu możesz zmienić kategorie, regiony i słowa
   kluczowe oraz zobaczyć wszystkie pasujące zamówienia.”).
4. **`source_incomplete` w `status` (C&S L-R2-1 z PR-08):** nowy problem, gdy dwa
   najnowsze nie-`failed` przebiegi źródła (dwa różne dni publikacji) są oba `incomplete`;
   pojedynczy `incomplete` nie alarmuje. Alert operatora podaje powody (`part`, `reason`)
   bez treści ofert; RUNBOOK „Alert statusu” — co zrobić. Nadrabianie (D-021) bez zmian.

**Przegląd właściciela (PR #15, PASS z uwagami):** (a) słowo kluczowe ≥ 6 znaków na
„-nie”/„-cie” pasuje też do dopełniacza l. mn. („szkoleń”, „zajęć”; tylko równe słowo, nie
prefiks; D-023); (b) `deliveries:resolve … [--transport test|smtp]` zmienia tylko wiersze
tego transportu, domyślnie transportu z `EMAIL_MODE` (czytane samo `EMAIL_MODE`), wynik
z polem `transport` (D-024); (c) RUNBOOK: kiedy oferta wraca po `--failed` (warunki
kandydata digestu).

**Kryteria akceptacji:**

1. Oferta dopasowana dziś tylko słowem z opisu przy zgodnym regionie (50) nie przechodzi;
   słowo w tytule + region (50) i kategoria + region (60) przechodzą jak dotąd (testy z
   przypadkami z pilota: ciągnik/koparka przez „oświetlenie”/„elektryczne”).
2. `deliveries:resolve` zmienia wyłącznie wiersze `pending` wskazanego profilu i dnia,
   atomowo; odmawia przy działającym `digest` (test DB z trzymanym lockiem).
3. Digest i `/dopasowania` nie pokazują surowego klucza kategorii.
4. `status` zgłasza `source_incomplete` przy dwóch kolejnych `incomplete`, nie przy jednym;
   `--notify` wysyła alert z kodami; istniejące problemy bez zmian.
5. D-023 i D-024 zaktualizowane; README, RUNBOOK, STATE.

**Poza zakresem:** „wartość części”, etykieta netto/brutto, `region_unknown` dla wielu
województw, wczesne przerwanie dnia z samymi odrzuceniami (follow-upy PR-08), tokenizacja
raz na ofertę, zmiany progu 50, słownik wykluczeń w produkcie, nowe źródła.

---

## Seria UX/QOL (PR-10 – PR-13): narzędzie, któremu klient może zaufać

Źródło: niezależny audyt UX (2026-11-06), persony Marek (elektryk), Agnieszka (oferty) i
Tomasz (kierownik, ocena w 2 minuty). Tezy audytu sprawdzone w kodzie:

- `estimated_value` jest zapisywana, ale nigdzie nie pokazywana;
- link logowania jest jednorazowy (D-026), a nowy przychodzi tylko w digeście;
- serwis nie podaje adresu kontaktowego;
- pole „Powiaty” nie zawęża dopasowań (`COUNTIES_HINT`);
- README obiecuje BIP-y, szkoły i szpitale, a źródła to BZP i BK;
- temat maila zawiera nazwę firmy odbiorcy.

Kolejność według priorytetu audytu. Każdy PR przechodzi osobno ten sam przepływ 3 agentów.

**Zasady wspólne serii:**

- bez nowych zależności i bez JS po stronie klienta (CSP `default-src 'none'` zostaje);
- brak wartości = „nie podano”, nigdy 0;
- GET nigdy nie zmienia stanu (skanery poczty, D-026);
- logi bez e-maili i tokenów — tylko identyfikatory, liczby i kody.

---

## PR-10 — Wejście bez pułapek

**Cel:** klient, który zgubił albo zużył link, sam dostaje nowy. Literówka przy zmianie
adresu nie odcina digestu. Strona główna mówi, czym jest serwis i skąd ma dane. Zamyka
punkty 2 i 3 etapu 5 `docs/LAUNCH_ROADMAP.md`. To decyzja właściciela z 2026-11-06 (seria
UX); TTL tokenów zostają bez zmian (7 / 60 / 30 dni).

**Zakres:**

1. **„Wyślij mi link”** — formularz z jednym polem e-mail na `/` i na stronie nieważnego
   linku (zastępuje „odpowiedz na ostatnią wiadomość — operator wyśle nowy link”).
   - `POST` z ochroną login-CSRF (ta sama ścisła kontrola `Origin`/`Sec-Fetch-Site` co
     logowanie, PR-06B) i małym limitem ciała (1 KiB).
   - **Zawsze ta sama odpowiedź** dla adresu istniejącego, nieistniejącego, wyłączonego i
     przy wyczerpanym limicie profilu: status, treść i nagłówki identyczne. Treść: „Jeśli
     adres jest w bazie, link przyjdzie w ciągu kilku minut. Sprawdź też folder spam.”
     Błędna składnia adresu daje błąd formularza, niezależny od bazy.
   - **Bez wyroczni czasowej:** odpowiedź nie czeka na bazę ani na wysyłkę. Wyszukanie
     profilu i wysyłka idą po odpowiedzi, w procesie `serve`, przez ograniczony łańcuch
     zadań w pamięci (np. jedno zadanie naraz, najwyżej 20 oczekujących; nadmiar odrzucony
     z kodem w logu). Błąd wysyłki trafia do logu jako kod z `profileId`, bez adresu.
   - **Limity:**
     - ≤ 3 linki na profil w ciągu 24 h, liczone w bazie, atomowo przy współbieżnych
       żądaniach (np. blokada wiersza profilu albo zapis warunkowy);
     - ≤ 10 żądań na IP na godzinę, w pamięci procesu, z ograniczoną liczbą wpisów i
       usuwaniem starych. IP klienta: za Caddy (gniazdo z loopback) z `X-Forwarded-For`
       ustawianego przez Caddy, w innym razie adres gniazda. Przekroczenie daje 429 po
       ludzku. Ten limit zależy tylko od IP, nie od adresu e-mail.
   - Link jak w digeście: login, jednorazowy, 7 dni (D-026). Wydawany tylko, gdy profil
     istnieje. Profil z wyłączonymi e-mailami (`active = false`) też dostaje link, bo sam o
     niego prosi i bez niego nie włączy e-maili. Wysyłka przez istniejący sender (`test` /
     `smtp`, D-024) z tymi samymi nagłówkami nadawcy. Temat: „Radar Zamówień: link do
     profilu”. Treść: link, informacja, że działa raz przez 7 dni, i „Jeśli to nie Ty —
     zignoruj tę wiadomość”.
2. **Link logowania zostaje jednorazowy.** Strona `GET /dostep/<token>` mówi wprost: „Link
   działa raz. Na innym urządzeniu poproś o nowy na stronie głównej.”
3. **Zmiana e-maila z potwierdzeniem** (zmiana D-027):
   - pole `email_confirm` znika z formularza;
   - nowy adres trafia do `pending_email`, a profil i sesje pozostają bez zmian;
   - na nowy adres idzie link potwierdzający: nowy cel tokenu `email_change`, jednorazowy,
     24 h, związany z adresem z `pending_email`;
   - na stary adres idzie powiadomienie bez linków i bez nowego adresu: „Poproszono o zmianę
     adresu… Jeśli to nie Ty, zaloguj się i anuluj zmianę.”;
   - do potwierdzenia digest, linki i logowanie idą na stary adres;
   - `/profil` i formularz pokazują „Oczekuje na potwierdzenie: <nowy adres>” z przyciskiem
     „Anuluj zmianę” (POST + CSRF);
   - kolejna zmiana zastępuje oczekującą: stary token `email_change` zostaje usunięty;
   - ≤ 3 e-maile potwierdzające na profil w ciągu 24 h. Ponad limit formularz pokazuje
     błąd; to sesja właściciela, więc komunikat niczego nie ujawnia.
   - **Potwierdzenie:**
     - `GET /potwierdz-email/<token>` pokazuje stronę z przyciskiem, `POST` zużywa token;
     - w jednej transakcji: `email = pending_email`, `pending_email = NULL`, zużycie
       tokenu i to samo unieważnienie innych tokenów i sesji co dziś przy zmianie adresu
       (`revokeOtherAccess`, ta sama kolejność blokad, D-027);
     - wyścig dwóch potwierdzeń: wygrywa dokładnie jedno, drugie dostaje neutralną stronę
       nieważnego linku;
     - adres zajęty w chwili potwierdzenia: neutralny komunikat i brak zmiany. Przy
       zapisie formularza nie ma wyroczni „adres zajęty”: każdy poprawny adres przechodzi
       do potwierdzenia.
4. **Strona główna `/`:**
   - co to jest: codzienny e-mail z zamówieniami dopasowanymi do profilu firmy;
   - skąd dane: Biuletyn Zamówień Publicznych (e-Zamówienia) i Baza Konkurencyjności;
   - jak zacząć: obecnie przez operatora;
   - formularz „Wyślij mi link”;
   - link do `/przyklad`;
   - kontakt.
     **`/przyklad`:** przykładowy digest renderowany tym samym widokiem co
     `/dopasowania`, ze stałych danych pseudonimizowanych w kodzie (Jan Kowalski,
     `*.invalid`), bez bazy. **`CONTACT_EMAIL`:** opcjonalny w env, walidowany przy starcie;
     bez niego adres kontaktowy nie jest pokazywany.
5. **README i `docs/PRODUCT.md`:** obietnica zgodna ze źródłami (BZP + BK), bez BIP-ów,
   szkół i szpitali jako kanału.

**Kryteria akceptacji:**

1. Odpowiedź na „Wyślij mi link” jest identyczna (status, treść, nagłówki) dla adresu
   istniejącego, nieistniejącego, wyłączonego i z wyczerpanym limitem profilu (test).
2. 4. żądanie dla profilu w 24 h nie wysyła e-maila; 11. żądanie z IP w godzinie daje 429.
      Test DB pokazuje, że dwa równoległe żądania przy 2 wysłanych linkach wysyłają razem ≤ 1.
3. Zmiana adresu nie zmienia `email` do potwierdzenia: digest i login idą na stary adres.
   Stary adres dostaje powiadomienie. Anulowanie usuwa `pending_email` i token.
4. Test DB: dwa równoległe potwierdzenia zmieniają adres raz, a drugi `POST` dostaje stronę
   nieważnego linku. `GET` linku potwierdzającego niczego nie zmienia.
5. Brak e-maili i tokenów w logach (test na zapisanych liniach logu). CSP bez zmian.
6. D-031 (samoobsługowe wejście, potwierdzanie adresu). Zmiany D-026 (cel `email_change`) i
   D-027 (koniec natychmiastowej zmiany e-maila). Aktualizacja RUNBOOK (`CONTACT_EMAIL`,
   limity, „klient nie dostaje linku”), SECURITY, README, PRODUCT i STATE.

**Poza zakresem:**

- samodzielna rejestracja nowej firmy;
- zmiana TTL;
- limit żądań na proxy dla całej aplikacji (etap 5 pkt 1);
- CAPTCHA;
- drugi odbiorca;
- wygląd kart (PR-11).

---

## PR-11 — Karta oferty do oceny w 20 sekund

**Cel:** z karty w mailu i na `/dopasowania` widać od razu, czy oferta jest warta czasu:
ile, do kiedy, co i dlaczego.

**Zakres:**

1. **Wartość:**
   - „Wartość szacunkowa: 120 000,00 PLN (źródło nie podaje, netto czy brutto)”, zgodnie z
     D-030;
   - brak wartości → „nie podano”.
2. **Termin:**
   - format „18.11.2026 (śr) 10:00 — za 12 dni” zamiast ISO;
   - „dziś” i „jutro”;
   - termin ≤ 2 dni wyróżniony słowem „PILNE”;
   - termin, który minął, oznaczony słowem „minął”;
   - liczone w dniach kalendarzowych czasu polskiego od chwili renderowania;
   - przykład `/przyklad` (`src/web/example.ts`) ma dziś stałe daty, już w przeszłości: z
     tym stanem terminu liczyć je względem chwili renderowania (wymaga wstrzykiwanego zegara
     w `WebServerOptions`; odłożone z przeglądu jakości PR-10, NIT 1).
3. **Opis:** widoczne pierwsze ~300 znaków, cały opis w `<details>`. Kody CPV i techniczne
   powody (region nieznany, CPV spoza słownika) w `<details>` „Szczegóły dopasowania”.
   Po review właściciela PR #17 kolejność i zwinięta sekcja „Więcej szczegółów” wg D-030
   („Kolejność karty oferty”).
4. **„Dlaczego pasuje”:** jedno ludzkie zdanie, np. „Elektryka · słowo „oświetlenie” w
   tytule · mazowieckie”.
5. **Wygląd:**
   - karty z ramką i tłem;
   - jeden wyraźny przycisk „Otwórz ogłoszenie”;
   - nagłówek i stopka serwisu;
   - kolor akcentu;
   - `dl` w gridzie;
   - `prefers-color-scheme: dark` na stronach;
   - w mailu inline style bez sztywnych szarości.
6. **Temat:** „Radar Zamówień: 3 nowe, najbliższy termin 18.11”, bez nazwy firmy odbiorcy.

**Kryteria akceptacji:**

1. Oferta bez wartości pokazuje „nie podano”.
2. Testy graniczne terminu: zmiana czasu (DST), północ, termin minął, brak terminu.
3. Mail i `/dopasowania` mają tę samą treść karty (jeden widok).
4. Zrzuty 390 px i 1280 px w opisie PR. D-030 i README zaktualizowane.

**Poza zakresem:** ocena trafności (PR-12), ustawienia (PR-13), zmiany scoringu.

---

## PR-12 — Ocena trafności i eksport

**Cel:** trafność mierzona w produkcie zamiast w arkuszu (etap 4) oraz lista do Excela dla
osoby przygotowującej oferty.

**Zakres:**

1. **Ocena w mailu:**
   - przyciski „Trafne” i „Nietrafne” w każdej karcie;
   - `GET /ocena/<token>/<oppId>/<werdykt>` pokazuje stronę z przyciskiem, a `POST`
     zapisuje ocenę;
   - token: cel `feedback`, wielorazowy, 60 dni, jeden na digest;
   - ocena przyjmowana tylko dla oferty wysłanej temu profilowi (`deliveries`).
2. **Ocena na `/dopasowania`:**
   - te same przyciski (sesja + CSRF);
   - oferty ocenione „nietrafne” są wyszarzone i trafiają na koniec listy.
3. **Przechowywanie:** `match_feedback (profile_id, opportunity_id, verdict, created_at,
updated_at)`, unikalna para, upsert, `ON DELETE CASCADE`.
4. **Raport:** `feedback:report [--since YYYY-MM-DD]` zwraca JSON z liczbami per profil i
   kategoria oraz trafnością. Bez e-maili i tytułów.
5. **Eksport `GET /dopasowania.csv`** (sesja):
   - separator `;`, UTF-8 z BOM pod polski Excel;
   - neutralizacja formuł: komórki zaczynające się od `=`, `+`, `-`, `@`, tabulatora lub
     CR;
   - limit wierszy jak na liście.
6. **Etap 4 roadmapy:** oceny w produkcie zastępują arkusz; ankieta zostaje tylko dla „co
   przegapiliśmy”.

**Kryteria akceptacji:**

1. `GET` (skaner poczty) nie zapisuje oceny.
2. Obcy `oppId` daje 404.
3. Podwójny `POST` zostawia jedną ocenę.
4. Komórka `=1+1` w CSV jest tekstem.
5. D-031 albo nowa decyzja, RUNBOOK, STATE i LAUNCH_ROADMAP zaktualizowane.

**Poza zakresem:** uczenie scoringu z ocen, oceny w `match:preview`, eksport XLSX.

---

## PR-13 — Ustawienia bez pułapek

**Cel:** formularz, którego nie da się przypadkiem źle zapisać, i lista, która nie straszy
błędem 503.

**Zakres:**

1. **Województwa:**
   - jawny wybór „Cała Polska” / „Wybrane województwa”;
   - „wybrane” bez zaznaczenia → błąd formularza.
2. **Pole „Powiaty”** znika z formularza. Zapis zachowuje powiaty ustawione przez CLI.
3. **Formularz:**
   - checkboxy w siatce 2–3 kolumn z celem dotyku ≥ 44 px;
   - krótsze podpowiedzi;
   - wyraźny przycisk „Zapisz”.
4. **Po zapisie:** komunikat „Lista dopasowań pokazuje zmiany od razu, e-mail — od jutra”
   z linkiem do `/dopasowania`.
5. **`/dopasowania`:**
   - zamiast 503 strona z `<meta http-equiv="refresh" content="3">`;
   - 429 po ludzku;
   - stronicowanie `?strona=N` po 50, z limitem stron.

**Kryteria akceptacji:**

1. Przy „Cała Polska” nie da się przypadkiem zawęzić wyboru.
2. Zapis formularza nie kasuje powiatów z CLI.
3. Formularz na 390 px jest co najmniej o 40% niższy (zrzuty przed i po).
4. D-027 zaktualizowana.

**Poza zakresem:**

- przycisk „zaznacz wszystkie” (wymaga JS i zmiany CSP);
- drugi odbiorca na profil (zmienia klucz D-024; po pilotażu, jeśli firmy poproszą).
