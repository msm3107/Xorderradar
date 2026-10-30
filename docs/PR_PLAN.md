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
    `ingest --from YYYY-MM-DD --to YYYY-MM-DD`; bez opcji dnia — automatycznie dni od
    ostatniego pokrytego dnia źródła w `ingestion_runs` do wczoraj (cron, który nie ruszył przez
    kilka dni, dziś gubi te dni; to samo dotyczy zmian ogłoszeń z tych dni).
  - **Kryteria akceptacji PR-03B (nadrabianie):**

    7. `ingest --from A --to B` pobiera każdy dzień zakresu (jeden przebieg na źródło i dzień);
       niepoprawny zakres (`A > B`, ponad 31 dni, tylko jedna z opcji, razem z `--date`) →
       błąd użycia bez pobierania.
    8. Bez opcji dnia `ingest` pobiera dni od dnia po ostatnim pokrytym (przebieg `succeeded`
       albo `incomplete` rozpoczęty po końcu dnia) do wczoraj; świeże źródło — tylko wczoraj;
       nic do nadrobienia — nic nie jest pobierane; ponad 31 dni → 31 najnowszych, reszta
       raportowana jako przycięta.
    9. Nieudany dzień zatrzymuje kolejne dni tego źródła (raportowane jako niewykonane), a
       następne nadrabianie zaczyna od niego — z testami integracyjnymi.

- **PR-03C — helpery normalizacji** (przeniesione bez zmian z PR-03B):
  - **helpery normalizacji:** białe znaki, HTML → tekst (`htmlBody`: opis, kontakt, wartość),
    daty Europe/Warsaw, województwa/powiaty, słownik kategorii (CPV → kategorie MVP), fallback
    niepoprawnego e-maila do `contact.raw`, pseudonimizowane fixture'y HTML.

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
