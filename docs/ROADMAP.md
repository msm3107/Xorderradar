# Roadmap — Radar Zamówień

Zasada nadrzędna: każda faza kończy się czymś, co można zweryfikować uruchomieniem, a nie
slajdem. Szczegóły PR-ów: `docs/PR_PLAN.md`.

## PHASE 0 — FOUNDATION

**PR-00 — Project Bootstrap.**

Rezultat: repozytorium z działającym toolchainem (TypeScript, lint, formatter, testy, smoke
test), dokumentacją sterującą i definicjami 3 agentów. Zero funkcji produktu.

## PHASE 1 — DATA PIPELINE

**PR-01 → PR-02 → PR-03.**

- PR-01 — Core Domain & Database
- PR-02 — First Source Adapter
- PR-03 — Ingestion, Normalization & Deduplication

Rezultat: **system potrafi znaleźć i zapisać nowe zamówienie z jednego prawdziwego źródła**,
bez duplikatów, z wykrywaniem zmian.

## PHASE 2 — VALUE DELIVERY

**PR-04 → PR-05.**

- PR-04 — Matching Engine
- PR-05 — Alert / Daily Digest

Rezultat: system potrafi określić „to zamówienie pasuje do tej firmy” (z wyjaśnieniem) i
wysłać alert.

**To jest pierwszy moment, w którym istnieje realny produkt** (MVP success criterion z
`docs/MASTER_PROMPT.md` §5). Do tego czasu profile są zakładane przez operatora (CLI/seed).

## PHASE 3 — SELF SERVICE

**PR-06 — Minimal User Interface** (może zostać podzielony na PR-06A/PR-06B — patrz plan).

Rezultat: użytkownik sam konfiguruje prosty profil, widzi dopasowane zamówienia i otwiera
źródło.

## PHASE 4 — PILOT

**PR-07 — MVP Hardening** + kolejne źródła.

Rezultat: wersja pilotażowa działająca u pierwszych firm: deployment, backup, monitoring
błędów, dokumentacja operacyjna.

Źródła dodajemy **tylko wtedy, gdy zwiększają pokrycie potrzebne realnym klientom**
(jeden adapter = jeden PR). Nie dodajemy źródeł „bo możemy”.

## PHASE 5 — VALIDATION

Dopiero po realnym pilotażu i na podstawie danych z niego rozważamy:

- płatności i plany,
- dodatkowe kanały alertów,
- LLM enrichment (jako warstwa pomocnicza, nie rdzeń matchingu),
- bardziej zaawansowany matching,
- scoring jakości zamówienia,
- kolejne regiony.

Każdy z tych punktów wymaga nowego wpisu w `docs/DECISIONS.md` z uzasadnieniem z pilotażu.
