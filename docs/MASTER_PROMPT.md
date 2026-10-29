# MASTER PROMPT — Radar Zamówień

Ten dokument jest konstytucją projektu. W razie konfliktu z innym dokumentem wygrywa ten plik,
chyba że decyzja zapisana w `docs/DECISIONS.md` jawnie go zmienia.

Każda sesja rozpoczyna pracę od przeczytania: `CLAUDE.md`, `docs/MASTER_PROMPT.md`,
`docs/STATE.md`, `docs/ROADMAP.md`, `docs/PR_PLAN.md` oraz `git log`.

---

## 1. Czym jest Radar Zamówień

Narzędzie, które monitoruje publiczne źródła ogłoszeń o **niewielkich zamówieniach i
zapytaniach ofertowych** (BIP-y, szkoły, szpitale, urzędy, jednostki samorządowe, inne
instytucje publiczne), zapisuje nowe ogłoszenia w ujednoliconym formacie, dopasowuje je do
prostego profilu firmy i wysyła krótki alert.

Nie budujemy kolejnej wielkiej wyszukiwarki przetargów. Budujemy:

```
źródła → pobranie → normalizacja → deduplikacja → dopasowanie → alert
```

## 2. Dla kogo

Małe i średnie firmy usługowe i wykonawcze (np. elektryka, instalacje, PPOŻ, szkolenia, BHP,
sprzątanie, IT, remonty, serwis, wyposażenie), które:

- nie mają działu przetargowego,
- realizują zlecenia lokalnie lub regionalnie,
- nie mają czasu codziennie przeglądać dziesiątek stron BIP.

## 3. Problem

Małe zamówienia (często poniżej progów ustawowych) są rozproszone po setkach stron jednostek,
publikowane w różnych formatach i nie trafiają wygodnie do systemów monitorujących duże
przetargi. Firma albo traci okazje, albo marnuje czas na ręczne przeglądanie.

Produkt odpowiada na jedno pytanie:

> „Czy pojawiło się nowe zamówienie, które faktycznie może zainteresować moją firmę?”

## 4. Główny user flow

1. Firma definiuje prosty profil: kategorie, opcjonalnie region (województwo/powiat), słowa
   kluczowe i słowa wykluczające, adres e-mail.
2. System cyklicznie (cron) pobiera dane z obsługiwanych źródeł.
3. Nowe ogłoszenia są normalizowane, deduplikowane i zapisywane jako `Opportunity`.
4. Każde nowe ogłoszenie jest dopasowywane do profili (deterministyczny scoring z
   wyjaśnieniem).
5. Firma dostaje krótki digest: „Znaleźliśmy dziś 3 nowe zamówienia pasujące do Twojej firmy.”
6. Firma otwiera link do źródła i sama decyduje, czy składa ofertę.

## 5. MVP

MVP robi jedną rzecz bardzo dobrze: **znajduje nowe zamówienie i informuje właściwą firmę.**

Kryterium sukcesu MVP core:

> System automatycznie znajduje nowe zamówienie z rzeczywistego publicznego źródła, zapisuje je
> bez duplikatów, dopasowuje je do profilu przykładowej firmy i generuje poprawny alert.

Każdy wynik w alercie zawiera (o ile źródło to podaje): nazwę zamówienia, zamawiającego,
lokalizację, termin składania ofert, datę publikacji, krótki opis, kategorię, link do źródła,
publiczne dane kontaktowe opublikowane przy zamówieniu oraz dowód dopasowania.

## 6. Non-goals

Produkt **nie jest**: CRM-em, ERP-em, systemem księgowym, platformą analityczną, chatbotem,
siecią społecznościową, kombajnem do zarządzania przetargami, narzędziem do składania ofert.

Poza MVP (rozważane dopiero po pilotażu): płatności i plany, dodatkowe kanały alertów,
wzbogacanie LLM, zaawansowany matching, scoring jakości zamówień, masowe dodawanie źródeł.

Test każdej funkcji:

> Czy jest absolutnie potrzebna, aby użytkownik znalazł interesujące zamówienie?
> Jeżeli nie — nie należy do MVP.

## 7. Architektura

- **Modularny monolit** w TypeScript na Node.js 22, jeden kod, jeden proces na komendę.
- **PostgreSQL** jako jedyny magazyn danych.
- **Cron** uruchamia komendy CLI (`ingest`, `digest`); bez kolejek i systemów workflow.
- **Adaptery źródeł**: każde źródło = jeden adapter `fetch → extract → normalize`.
- **E-mail** jako pierwszy i jedyny kanał powiadomień w MVP.
- Szczegóły, kontrakty modułów i model danych: `docs/ARCHITECTURE.md`.
- Zakazane bez udokumentowanej, realnej potrzeby: mikroserwisy, Kafka, Kubernetes, Redis,
  ElasticSearch, event sourcing, CQRS.

## 8. Zasady minimalizmu

- PROSTOTA > LICZBA FUNKCJI.
- Projektujemy dla pierwszych **10–100 klientów**, nie dla miliona.
- Jedna tabela zamiast czterech, jeden proces zamiast kolejki, cron zamiast workflow engine,
  prosty adapter zamiast frameworka pluginów.
- Bez abstrakcji dla hipotetycznych funkcji. Bez pustych katalogów „na zapas”.
- Każde odstępstwo od preferowanego stacku — wpis w `docs/DECISIONS.md`.

## 9. Zasady danych

- Pobieramy wyłącznie **dane publicznie opublikowane**.
- **Nie wymyślamy wartości.** Brak w źródle = `null`. Brak wartości nigdy nie jest `0`.
  `estimatedValue` tylko jeśli źródło ją podaje.
- `contactData` — wyłącznie dane kontaktowe opublikowane przy danym zamówieniu (np. adres
  e-mail/telefon osoby wskazanej do kontaktu w ogłoszeniu). Nie wzbogacamy ich z innych źródeł.
- Przechowujemy link do źródła — użytkownik zawsze może zweryfikować oryginał.
- Minimalizujemy dane osobowe użytkowników (profil = e-mail + preferencje).
- Deduplikacja i dopasowanie są deterministyczne i testowalne.

## 10. Zasady bezpieczeństwa

Pełne zasady: `docs/SECURITY.md`. Minimum nienegocjowalne:

- Nigdy nie omijamy CAPTCHA, zabezpieczeń antybotowych, uwierzytelnienia ani rate limitów.
- Crawler: timeout, rozpoznawalny User-Agent, rate limiting per host, ograniczony retry,
  limit rozmiaru odpowiedzi, allowlista hostów, ochrona SSRF, logowanie źródła.
- Każde wejście z zewnątrz (HTTP, env, formularze) jest walidowane schematem w runtime.
- Zapytania SQL wyłącznie parametryzowane.
- Sekrety tylko w zmiennych środowiskowych, nigdy w repo ani w logach.
- Wysyłka do prawdziwych odbiorców wymaga jawnego trybu i potwierdzenia.

## 11. Workflow agentów

Dokładnie **3 role** (definicje w `.claude/agents/`, zasady w `docs/AGENTS.md`):

1. **Coder** — implementacja, migracje, testy, poprawki, dokumentacja techniczna.
2. **Code & Safety Reviewer** — code review + security + bezpieczeństwo pozyskiwania danych.
   Nie implementuje.
3. **Quality Reviewer** — perspektywa użytkownika i celu PR. Nie robi code review.

Główna sesja jest koordynatorem i nie jest liczona jako agent. Nie tworzymy czwartego agenta.
Oba review wykonują różni agenci.

## 12. Workflow PR

```
PR scope → CODER → testy → CODE & SAFETY REVIEWER → (poprawki: CODER → CODE & SAFETY REVIEWER)*
        → PASS → QUALITY REVIEWER → ACCEPT → PR READY
```

Każdy PR ma: jeden główny cel, kryteria akceptacji, listę „poza zakresem”, testy, oba review,
aktualizację `docs/STATE.md`. Nie mieszamy w jednym PR crawlera, UI, auth, mailingu, billingu
ani refaktoru całości. Za duży feature dzielimy. Plan: `docs/PR_PLAN.md`.

## 13. Definition of Done (PR)

PR jest gotowy dopiero, gdy:

- [ ] kryteria akceptacji są spełnione,
- [ ] `pnpm check` przechodzi (format, lint, typecheck, testy),
- [ ] Coder zakończył implementację raportem IMPLEMENTATION REPORT,
- [ ] Code & Safety Reviewer dał **PASS** (zero otwartych Critical/High),
- [ ] Quality Reviewer dał **ACCEPT**,
- [ ] dokumentacja mówi prawdę o stanie kodu,
- [ ] `docs/STATE.md` jest aktualny,
- [ ] scope nie został niepotrzebnie rozszerzony.
