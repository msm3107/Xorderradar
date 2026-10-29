# Agents — Radar Zamówień

Projekt używa **dokładnie trzech** wyspecjalizowanych ról. Definicje (natywny mechanizm
subagentów Claude Code, katalog projektowy):

| Agent                      | Plik                                         | Narzędzia                           | Zadanie                                |
| -------------------------- | -------------------------------------------- | ----------------------------------- | -------------------------------------- |
| `coder`                    | `.claude/agents/coder.md`                    | Read, Edit, Write, Bash, Grep, Glob | implementacja w zakresie aktywnego PR  |
| `code-and-safety-reviewer` | `.claude/agents/code-and-safety-reviewer.md` | Read, Grep, Glob, Bash              | code review + security + data safety   |
| `quality-reviewer`         | `.claude/agents/quality-reviewer.md`         | Read, Grep, Glob, Bash              | ocena produktowa i zgodność z celem PR |

**Główna sesja Claude Code** jest koordynatorem: wybiera aktywny PR, przekazuje zakres,
uruchamia agentów w kolejności workflow, przekazuje raporty między nimi, aktualizuje
`docs/STATE.md`, tworzy commit. Koordynator nie jest liczony jako agent.

## Twarde zasady

1. Nie tworzymy czwartego agenta ani dodatkowych definicji w `.claude/agents/`.
2. Code & Safety Review i Quality Review wykonują **różni** agenci, w osobnych wywołaniach.
   Quality Reviewer nie zastępuje Code Reviewera i odwrotnie.
3. Reviewerzy **nie modyfikują** plików (mogą uruchamiać testy, lint, typecheck, audit,
   `git diff`). Poprawki wykonuje wyłącznie Coder.
4. „Critical” i „High” z Code & Safety Review blokują PR.
5. Quality Review uruchamiamy dopiero po PASS z Code & Safety Review.
6. Każdy agent dostaje: identyfikator PR, cel, kryteria akceptacji, „poza zakresem”, listę
   zmienionych plików / zakres diffu oraz poprzednie raporty (jeśli są).
7. Koordynator przed **i** po każdym uruchomieniu reviewera zapisuje odcisk drzewa roboczego
   (patrz „Kontrola read-only reviewerów”). Każda różnica = review nieudane: zmiany są
   odrzucane/wyjaśniane, a review powtarzane od nowa.

## Co jest egzekwowane technicznie, a co procesowo

Uczciwie: zasady 1–3 **nie są wymuszone technicznie**.

- **Read-only reviewerów** wynika tylko z instrukcji. Ich definicje nie zawierają narzędzi
  Edit/Write, ale mają `Bash`, którym da się zapisać plik (`>`, `sed -i`, `git checkout`, a
  nawet `pnpm format`). Claude Code nie ogranicza tu poleceń Bash.
- **„Dokładnie 3 agentów”** to reguła procesu: nic nie blokuje dodania pliku w
  `.claude/agents/`. Pilnują tego koordynator i reviewerzy (zmiana w `.claude/agents/` jest
  widoczna w diffie PR).
- Rozdzielenie ról (różni agenci, osobne wywołania) zapewnia koordynator.

Kontrolą wykrywającą (nie zapobiegającą) jest odcisk drzewa roboczego opisany niżej.

## Kontrola read-only reviewerów

Przed uruchomieniem reviewera i zaraz po jego zakończeniu koordynator liczy w katalogu
głównym repo:

```bash
{ git status --porcelain=v1 --untracked-files=all
  git ls-files -z --cached --others --exclude-standard | xargs -0 -r sha256sum 2>/dev/null
} | sha256sum
```

Odcisk obejmuje status oraz **treść** wszystkich śledzonych i nieśledzonych
(nieignorowanych) plików, więc wykrywa także zmianę w pliku, który już wcześniej był
zmodyfikowany (samo `git status` by tego nie pokazało). Nie obejmuje plików ignorowanych
przez git (`dist/` z `pnpm build`, `node_modules/`, `.env`) ani katalogu `.git/` — wykrywa
zmiany w tym, co trafiłoby do commita, a nie każdy zapis na dysku. Jeśli odciski się różnią, review jest **nieudane**, niezależnie od werdyktu:
koordynator sprawdza różnicę, nie przyjmuje jej bez Codera i uruchamia review ponownie.

## Workflow PR

```
PR scope (koordynator, z docs/PR_PLAN.md)
   ↓
CODER ── implementacja + testy ── IMPLEMENTATION REPORT
   ↓
CODE & SAFETY REVIEWER ── CODE & SAFETY REVIEW   (odcisk drzewa przed/po)
   ↓ CHANGES REQUIRED?
   ├─ tak → CODER (tylko wymagane zmiany) → CODE & SAFETY REVIEWER (ponownie) → …
   └─ PASS
   ↓
QUALITY REVIEWER ── QUALITY REVIEW               (odcisk drzewa przed/po)
   ↓ REJECT? → CODER → CODE & SAFETY REVIEWER → QUALITY REVIEWER
   ↓ ACCEPT
PR READY → koordynator: STATE.md, commit, push
```

## Jak wywołać

W Claude Code: poproś koordynatora o uruchomienie agenta po nazwie (np. „uruchom
`code-and-safety-reviewer` dla PR-01”) albo użyj `/agents`, aby sprawdzić, że wszystkie trzy
są załadowane. Definicje z `.claude/agents/` są wczytywane przy starcie sesji — po ich
zmianie uruchom nową sesję.

Szablon zlecenia od koordynatora:

```
PR: PR-0X — <nazwa>
Goal: <cel z PR_PLAN>
Acceptance criteria: <lista>
Out of scope: <lista>
Changed files / diff range: <git diff <base>...HEAD lub lista>
Previous reports: <wklejone raporty lub "none">
Task: <implement | review | re-review after fixes>
```

## Formaty raportów

### IMPLEMENTATION REPORT (Coder)

```
IMPLEMENTATION REPORT

Scope:
Files changed:
Tests added:
Tests executed:
Known limitations:
Security-sensitive changes:
Ready for review: YES/NO
```

### CODE & SAFETY REVIEW (Code & Safety Reviewer)

```
CODE & SAFETY REVIEW

Verdict:
PASS / CHANGES REQUIRED

Critical:
High:
Medium:
Low:

Security:
Data handling:
Tests:
Architecture:

Required changes:
Optional improvements:
```

### QUALITY REVIEW (Quality Reviewer)

```
QUALITY REVIEW

Verdict:
ACCEPT / REJECT

Acceptance criteria:
Usability:
Clarity:
Product usefulness:
Unnecessary complexity:
Regression risk:

Blocking issues:
Non-blocking observations:
```

Raporty końcowe (po PASS/ACCEPT) koordynator streszcza w `docs/STATE.md` → „Last
verification”.
