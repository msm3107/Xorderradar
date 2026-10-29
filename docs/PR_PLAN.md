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
