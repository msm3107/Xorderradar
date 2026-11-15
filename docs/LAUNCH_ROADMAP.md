# Launch roadmap — od teraz do wdrożenia i testu rynkowego

Stan na 2026-11-04. PR-00 … PR-07B są zmergowane, a PR-08 (Baza Konkurencyjności) jest
w toku. Ten dokument uzupełnia `docs/ROADMAP.md`, który określa fazy produktu, o
konkretne kroki do pilotażu i testu rynkowego. Zakres i kryteria akceptacji każdego PR-a
nadal ustala `docs/PR_PLAN.md`. Bieżący stan prac jest w `docs/STATE.md`.

**Oznaczenia odpowiedzialności:**

- **[A]**: agenci (PR w repo).
- **[W]**: właściciel (VPS, poczta, decyzje, kontakt z firmami).
- **[P]**: prawnik lub zewnętrzny specjalista.

**Status liczb.** Czasy i progi poniżej to szacunki i hipotezy. Każdy próg, od którego
zależy decyzja, zatwierdza właściciel i zapisuje w `docs/DECISIONS.md`.

**Kolejność:**

```text
Etap 1 (PR-08) ─┬─► Etap 2 (VPS) ─► Etap 4 (pilotaż) ─► Etap 5 (sprzedaż) ─► Etap 6 (test rynkowy)
                └─► Etap 3 (PR-09 + poczta + prawo) ─┘
```

Etapy 2 i 3 mogą biec równolegle. Etap 4 zaczyna się dopiero po zamknięciu obu.

---

## Etap 1: Drugie źródło (PR-08)

Szacunek: około 1 tygodnia.

**Zadania:**

- [A] Adapter `bk` dla Bazy Konkurencyjności (krok 0 i zakres: `docs/PR_PLAN.md` → PR-08).
  Obejmuje parser, normalizację, migrację wiersza `sources`, przypisanie źródła („Źródło: Baza
  Konkurencyjności, Ministerstwo Funduszy i Polityki Regionalnej; pobrano {data}; dane
  przetworzone: skrócone i ujednolicone”) w digeście i na `/dopasowania`, `source:preview bk` oraz decyzję D-030.
- [A] Budżet czasu: ingest BZP i BK musi skończyć się przed `status --notify` o 06:30.
  Jeśli się nie zmieści, zmiana limitu albo harmonogramu z uzasadnieniem w D-030.
- [W] Review PR-a i merge.

**Kryterium wyjścia:**

- PR-08 jest zmergowany.
- `pnpm check` przechodzi w CI.

---

## Etap 2: Pierwsze wdrożenie na VPS

Szacunek: 1–2 dni pracy właściciela. Wykonuje właściciel [W], według listy kontrolnej
`docs/DEPLOY.md` §13.

**Zadania:**

1. Host, Node 22, PostgreSQL 16, Caddy, użytkownik i katalogi (§1–§5).
2. Build, konfiguracja i migracje (§6).
3. Pierwsze dane: **AC1 z PR-02** (`source:preview bzp`) i **AC1 z PR-08** (`source:preview bk`) na
   VPS z bezpośrednim HTTPS. Wynik i liczby trafiają do `docs/STATE.md` → Blockers.
4. `serve` pod systemd, Caddy z TLS i sprawdzenie maskowania tokenów w logach (§7–§8).
5. Cron i logrotate (§9), heartbeat (§10), kopia poza hostem zaszyfrowana `age` (§11).
6. `smoke.sh` (§12), zewnętrzny monitoring dostępności `/zdrowie` (§10).
7. Ćwiczenia: odtworzenie kopii (§14), ścieżka alertu (§13, poz. 13), błąd źródła
   (§13, poz. 17).

**Kryterium wyjścia:**

- Wszystkie pozycje §13 są odhaczone.
- Trzy kolejne dni robocze dają zielone `status`.
- Heartbeat przychodzi codziennie.

---

## Etap 3: Gotowość do pilotażu

Szacunek: 2–3 tygodnie. Etap ma trzy niezależne ścieżki: kod, pocztę i prawo.

### 3a. PR-09: kalibracja dopasowań i narzędzia operatora [A]

Zakres wymaga decyzji właściciela przy otwarciu PR-a. Kandydaci z `docs/STATE.md` → Next
action:

- **Kalibracja scoringu.** W teście właściciela na realnych danych 7 z 26 ofert pasowało
  tylko po słowie z opisu, z fałszywymi trafieniami. Do rozważenia:
  - mniej punktów za trafienie tylko w opisie;
  - podpowiedź słów wykluczających w `profile:create`;
  - licznik „dopasowane tylko po CPV” w `match:preview` (uwaga z review PR #8).

  Każda zmiana scoringu wymaga poprawki D-023.

- **Komendy operatora** `deliveries:pending` i `deliveries:resolve` zamiast ręcznego SQL.
- **Etykiety kategorii** w uzasadnieniu dopasowania („Sprzątanie” zamiast `sprzatanie`) i
  czytelniejsza stopka digestu.

### 3b. Poczta [W]

- Domena nadawcy z SPF, DKIM i DMARC. Bez tego digest trafia do spamu.
- Wyraźna zgoda właściciela na tryb `smtp` (`docs/SECURITY.md` §10/§14).
- Pierwszy digest na własną skrzynkę. Sprawdzić: nagłówki, `List-Unsubscribe`, linki,
  wyświetlanie w Gmailu i Outlooku.

### 3c. Minimum prawne [W] + [P]

Operator przetwarza adresy e-mail klientów oraz dane kontaktowe z ogłoszeń. Te dane to
tylko e-mail i telefon, bez nazwisk (D-022).

Dokumenty do przygotowania:

- polityka prywatności z informacją z art. 13 RODO;
- obowiązek informacyjny z art. 14 RODO wobec osób, których dane kontaktowe pochodzą z
  ogłoszeń (BZP, BK): decyzja właściciela, czy powołać się na wyjątek z art. 14 ust. 5
  lit. b (niewspółmierny wysiłek) — wymaga oceny prawnie uzasadnionego interesu (LIA) i
  publicznie dostępnej informacji o przetwarzaniu (np. na stronie usługi);
- regulamin pilotażu (usługa bezpłatna, bez gwarancji kompletności, prawo rezygnacji);
- rejestr czynności przetwarzania;
- umowa powierzenia z dostawcą VPS i z dostawcą poczty.

Przypisanie źródła BK według regulaminu Bazy Konkurencyjności (Rozdział II pkt 5) jest w
zakresie PR-08.

Teksty sprawdza prawnik. Agenci mogą przygotować szkic, ale nie stanowi on porady prawnej.

### 3d. Seria UX/QOL: PR-10 – PR-13 [A]

Odpowiedź na niezależny audyt UX z 2026-11-06. Plan każdego PR-a jest w `docs/PR_PLAN.md`.

| PR    | Cel                               | Co rozwiązuje                                                                |
| ----- | --------------------------------- | ---------------------------------------------------------------------------- |
| PR-10 | Wejście bez pułapek               | „wyślij mi link”, potwierdzenie zmiany e-maila, strona główna i `/przyklad`  |
| PR-11 | Karta oferty do oceny w 20 sekund | wartość, termin po ludzku, opis, czytelne „dlaczego”, temat bez nazwy firmy  |
| PR-12 | Ocena trafności i eksport         | „Trafne/Nietrafne” w mailu i na liście, `feedback:report`, CSV               |
| PR-13 | Ustawienia bez pułapek            | „Cała Polska” / wybrane, bez pola „Powiaty”, siatka, odświeżanie zamiast 503 |

Kolejność jest stała: PR-10 → PR-13. Każdy PR jest otwierany dopiero wtedy, gdy jest gotowy
do review właściciela.

### Kryterium wyjścia etapu 3

- PR-09 i PR-10 – PR-13 są zmergowane.
- Digest testowy dotarł do skrzynki odbiorczej, a nie do spamu.
- Dokumenty prawne są gotowe do przekazania firmom pilotażowym.

---

## Etap 4: Zamknięty pilotaż

Szacunek: 4–8 tygodni.

### Rekrutacja [W]

- 5–10 firm z sieci kontaktów właściciela.
- Branże zgodne ze słownikiem kategorii (D-022/D-023), np. sprzątanie, remonty, elektryka, IT, meble i wyposażenie.
- Region: 1–2 województwa.
- Warunek: 30 dni za darmo w zamian za ocenę każdego digestu.

### Onboarding [W]

- Profil przez `profile:create` razem z firmą: kategorie, regiony, słowa kluczowe i
  wykluczające.
- Zgoda na regulamin i politykę prywatności, zanim pójdzie pierwszy digest.

### Zbieranie danych

Oceny „trafne” i „nietrafne” zbiera produkt: przyciski w mailu i na `/dopasowania` (PR-12,
D-032). Link w mailu działa bez logowania przez 60 dni i ocenia tylko zamówienia wysłane tej
firmie; ocenę można zmienić. Właściciel czyta je z `feedback:report` (liczby na profil i na
kategorię oraz precyzja; RUNBOOK).
Precyzja `null` oznacza brak ocen, nie zero trafnych. Klient może pobrać swoją listę jako CSV
(`/dopasowania.csv`). Przy wdrażaniu firmy poleć ocenianie hurtem na `/dopasowania` (jedno
kliknięcie na zamówienie, cała lista na jednej stronie). Do decyzji go/no-go patrz też na
precyzję poszczególnych profili albo jej medianę, nie tylko na łączną `total.precision`, i
zawsze razem z pokryciem (`coverage` = ocenione / wysłane zamówienia; oceniają nieliczni i
częściej te nietrafione). Decyzję go/no-go podejmuj na raporcie z całego pilotażu
(`feedback:report --since <dzień po przejściu na smtp>`); z profilu z mniej niż ok. 20 ocenami
w tym raporcie nie wyciągaj wniosków. Cotygodniowy `feedback:report --since <poniedziałek>`
służy tylko do śledzenia postępu — raportów tygodniowych nie sumuj (`ratedDelivered` liczy
oceny z dowolnego czasu).

Tygodniowa ankieta ma 2 pytania:

1. Co przegapiliśmy?
2. Czy coś z tego realnie złożysz?

### Metryki

Wszystkie progi to hipotezy do zatwierdzenia przez właściciela.

| Metryka                                     | Źródło danych                | Hipoteza progu |
| ------------------------------------------- | ---------------------------- | -------------- |
| Trafność (trafne / wszystkie ocenione)      | `feedback:report` (PR-12)    | ≥ 60%          |
| Dni z dostarczonym digestem (bez awarii)    | `status`, `deliveries`       | ≥ 95%          |
| Firmy aktywne po 4 tygodniach (bez wypisu)  | `company_profiles`, `/wypis` | ≥ 70%          |
| Firmy, które złożyły ofertę z digestu       | ankieta                      | ≥ 2 firmy      |
| Deklarowana gotowość płacenia (2 progi cen) | rozmowa na koniec pilotażu   | ≥ 40% firm     |

### Iteracja [A]

Najwyżej 1–2 małe PR-y z wnioskami: kalibracja scoringu albo trzecie źródło. Trzecie źródło
wchodzi tylko wtedy, gdy ankiety pokazują konkretne luki w pokryciu (zasada z
`docs/ROADMAP.md` Phase 4).

### Kryterium wyjścia: decyzja „idziemy dalej / pivot / stop”

Właściciel podejmuje decyzję na podstawie metryk i zapisuje ją w `docs/DECISIONS.md`.

---

## Etap 5: Gotowość do sprzedaży

Szacunek: 3–5 tygodni. Etap zaczyna się dopiero po pozytywnej decyzji z etapu 4.

Każdy punkt to osobny PR z wpisem w `docs/DECISIONS.md` (Phase 5 w `docs/ROADMAP.md`):

1. **[A] Ograniczanie liczby żądań** na proxy albo w aplikacji. Obejmuje `/dopasowania`
   między sesjami (PR-06B C&S L-2). To warunek konieczny każdego publicznego linku.
2. **[A] Samoobsługowe wejście** — przeniesione do PR-10 (etap 3d). TTL tokenów zostają
   bez zmian (7/60/30 dni). W etapie 5 zostaje samodzielna rejestracja nowej firmy.
3. **[A] Powiadomienie starego adresu po zmianie e-maila** — przeniesione do PR-10 (etap 3d),
   razem z potwierdzaniem nowego adresu.
4. **[A] Pomiar `/dopasowania` na danych z pilotażu.** Optymalizacja tylko wtedy, gdy pomiar
   ją uzasadnia.
5. **[W] Płatności.** Na start przelew i faktura ręczna, bez kodu. Integracja płatności
   dopiero wtedy, gdy ręczne faktury przestaną wystarczać (osobna decyzja).
6. **[W] + [P] Regulamin usługi płatnej**, aktualizacja polityki prywatności.
7. **[W] Strona produktu (landing):**
   - komunikat;
   - przykładowy digest na danych pseudonimizowanych (`/przyklad` od PR-10);
   - cennik;
   - regulamin;
   - polityka prywatności;
   - kontakt.

   Zakres i hosting strony wymagają decyzji, bo dziś aplikacja serwuje tylko ekrany klienta.

**Kryterium wyjścia:**

- Firma spoza sieci kontaktów może sama dołączyć, zapłacić i zrezygnować, bez udziału
  operatora poza wystawieniem faktury.

---

## Etap 6: Test rynkowy

Szacunek: 8–12 tygodni.

### Grupa docelowa

Małe firmy z 1–2 województw, które dziś nie śledzą zapytań ofertowych.

### Komunikat

„Codziennie rano zapytania ofertowe z Twojej branży i regionu — z BZP i Bazy
Konkurencyjności, także małe zlecenia. Bez przeglądania portali.”

### Kanały

- **Partnerzy:** biura rachunkowe, izby gospodarcze, cechy rzemiosł, punkty wsparcia
  przedsiębiorców.
- **Społeczności:** grupy branżowe, webinar „jak wygrać zapytanie ofertowe z Bazy
  Konkurencyjności”, treści na LinkedIn.
- **Polecenia** od firm z pilotażu, które wyrażą zgodę na referencję.
- **Płatne kampanie** (wyszukiwarka, frazy „zapytania ofertowe + branża”) tylko z małym,
  stałym budżetem testowym i mierzeniem kosztu pozyskania klienta.

### Ograniczenie prawne

Nie wysyłamy zimnych e-maili i nie dzwonimy do firm bez ich zgody. Prawo komunikacji
elektronicznej wymaga uprzedniej zgody na marketing bezpośredni, także wobec firm. Dane
kontaktowe z ogłoszeń służą wyłącznie do realizacji usługi i nie mogą być używane w
marketingu.

### Test ceny

Dwa progi cenowe ustalone po pilotażu, mierzone konwersją z okresu próbnego na płatny.

### Metryki

Hipotezy do zatwierdzenia przez właściciela:

- konwersja z okresu próbnego na płatny;
- churn miesięczny;
- koszt pozyskania klienta (CAC) a przychód z klienta;
- trafność digestu (`feedback:report`, oceny w produkcie od PR-12).

### Kryterium wyjścia

Decyzja o skali, zapisana w `docs/DECISIONS.md`:

- kolejne regiony i źródła;
- dodatkowe kanały alertów;
- LLM jako warstwa pomocnicza (Phase 5).

---

## Ryzyka

| Ryzyko                                                              | Skutek                       | Zabezpieczenie                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------- | ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| API Bazy Konkurencyjności jest nieudokumentowane i może się zmienić | brak ofert BK                | zmiana struktury: `SourceFormatError` → `invalid_document`, alert z `status` (także lista krótsza niż jej `meta.total`); pojedyncze pominięcia (`detail_*`) widoczne tylko w podsumowaniu `ingest` i `ingest.log` — operator sprawdza je po backfillu (DEPLOY §6); próba błędu źródła (§13); szybki PR poprawki |
| Niska trafność dopasowań                                            | odejście firm w 1. tygodniu  | PR-09 przed pilotażem, oceny w produkcie (PR-12), kalibracja na profilach pilotażowych                                                                                                                                                                                                                          |
| Digest w spamie                                                     | brak wartości mimo działania | SPF/DKIM/DMARC, test na własnej skrzynce, monitoring zwrotów                                                                                                                                                                                                                                                    |
| Pojedynczy VPS                                                      | przerwa w dostawach          | kopia poza hostem, ćwiczenie odtworzenia, heartbeat, zewnętrzny monitoring dostępności                                                                                                                                                                                                                          |
| Wąskie gardło operatora (profile przez CLI)                         | limit kilkunastu firm        | samoobsługowe wejście w etapie 5, nie wcześniej                                                                                                                                                                                                                                                                 |

## Otwarte decyzje właściciela

Lista obejmuje tylko punkty blokujące kolejne etapy:

1. Zakres PR-09: które punkty z etapu 3a (przed etapem 4).
2. Zgoda na `smtp` i domena nadawcy (przed etapem 4).
3. Progi metryk pilotażu z tabeli w etapie 4 (przed etapem 4).
4. ~~TTL tokenów i formularz „wyślij mi link”~~ — rozstrzygnięte 2026-11-06: TTL bez zmian, formularz w PR-10.
5. Model płatności, cennik i hosting landingu (przed etapem 5).
6. RODO art. 14 dla danych kontaktowych z ogłoszeń: wyjątek z art. 14 ust. 5 lit. b z LIA
   i informacją publiczną albo inny sposób (etap 3c, przed etapem 4).
