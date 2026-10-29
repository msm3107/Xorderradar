# Radar Zamówień

Radar Zamówień pomaga małym i średnim firmom znajdować **niewielkie zamówienia i zapytania
ofertowe** publikowane przez BIP-y, szkoły, szpitale, urzędy i inne jednostki publiczne —
i informuje firmę tylko o tych, które faktycznie do niej pasują.

```
źródła → pobranie → normalizacja → deduplikacja → dopasowanie → alert
```

> Status: **PR-00 (bootstrap)**. Repozytorium zawiera szkielet projektu, narzędzia i
> dokumentację. Funkcje produktu (źródła, baza danych, matching, e-mail) powstają w kolejnych
> PR-ach — patrz [`docs/PR_PLAN.md`](docs/PR_PLAN.md) i [`docs/STATE.md`](docs/STATE.md).

## Wymagania

- Node.js **≥ 22.13** (`.nvmrc`)
- pnpm **10** (wersja przypięta w `package.json` → `packageManager`; najprościej `corepack enable`)
- PostgreSQL 16 — dopiero od PR-01

## Szybki start

```bash
corepack enable          # jednorazowo, udostępnia przypiętą wersję pnpm
pnpm install
cp .env.example .env     # opcjonalnie; aplikacja ma bezpieczne wartości domyślne (patrz „Konfiguracja”)
pnpm check               # format, lint, typecheck, testy
pnpm health              # {"status":"ok","service":"radar-zamowien","environment":"development"}
```

Wersja produkcyjna:

```bash
pnpm build
node dist/main.js health
```

Kody wyjścia CLI: `0` — OK, `1` — błąd konfiguracji/wykonania, `2` — błędne użycie
(komenda i argumenty są sprawdzane przed konfiguracją, więc błędne użycie zawsze daje `2`).

## Konfiguracja

Aplikacja czyta konfigurację **wyłącznie ze zmiennych środowiskowych** procesu
(`src/infrastructure/config.ts`); sam kod nie otwiera żadnego pliku.

- **`.env` służy do lokalnego developmentu.** Skrypty `pnpm dev`, `pnpm health` i `pnpm start`
  uruchamiają Node z wbudowaną flagą `--env-file-if-exists=.env` (bez dodatkowej zależności),
  więc wczytują `.env` z katalogu głównego projektu, jeśli istnieje. Gdy pliku nie ma, Node
  wypisuje na stderr jedną linię `.env not found. Continuing without it.` i działa dalej.
- **Zmienne ustawione w środowisku mają pierwszeństwo przed plikiem** — także ustawione na
  pustą wartość (np. `LOG_LEVEL=warn pnpm health` nadpisuje `LOG_LEVEL` z `.env`).
- **Pusta wartość oznacza „nie ustawiono”** i używana jest wartość domyślna
  (`NODE_ENV=development`, `LOG_LEVEL=info`).
- **Produkcja / cron:** bezpośrednie `node dist/main.js …` **nie czyta** `.env`. Zmienne
  eksportuje środowisko uruchomieniowe (crontab, unit systemd, panel hostingu). Kto chce
  użyć pliku, podaje go jawnie: `node --env-file=/ścieżka/do/pliku dist/main.js health`.
- Testy (`pnpm test`) nie czytają `.env` — przekazują jawne, minimalne środowisko.

## Dokumentacja

| Plik                                             | Zawartość                                     |
| ------------------------------------------------ | --------------------------------------------- |
| [`docs/MASTER_PROMPT.md`](docs/MASTER_PROMPT.md) | Konstytucja projektu — zacznij tutaj          |
| [`docs/PRODUCT.md`](docs/PRODUCT.md)             | Produkt, użytkownik, MVP, non-goals           |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)   | Architektura, moduły, kontrakty, model danych |
| [`docs/ROADMAP.md`](docs/ROADMAP.md)             | Fazy rozwoju                                  |
| [`docs/PR_PLAN.md`](docs/PR_PLAN.md)             | Plan PR-ów z kryteriami akceptacji            |
| [`docs/AGENTS.md`](docs/AGENTS.md)               | 3 role agentów i workflow review              |
| [`docs/SECURITY.md`](docs/SECURITY.md)           | Zasady bezpieczeństwa i pozyskiwania danych   |
| [`docs/DECISIONS.md`](docs/DECISIONS.md)         | Rejestr decyzji (ADR)                         |
| [`docs/STATE.md`](docs/STATE.md)                 | Aktualny stan prac                            |
