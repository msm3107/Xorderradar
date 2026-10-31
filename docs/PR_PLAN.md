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
