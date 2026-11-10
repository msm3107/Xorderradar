# Produkt — Radar Zamówień

## Obietnica

> Użytkownik dostaje kilka właściwych okazji zamiast przeglądać setki nieistotnych ogłoszeń.

Codzienny e-mail z zamówieniami dopasowanymi do profilu firmy.

## Źródła

Dziś dwa: Biuletyn Zamówień Publicznych (platforma e-Zamówienia, oficjalne API) i Baza
Konkurencyjności. Obietnica obejmuje tylko ogłoszenia z tych źródeł — nie obiecujemy BIP-ów
urzędów, szkół, szpitali ani innych stron jako kanału, dopóki nie ma dla nich adaptera.

## Użytkownik

Właściciel lub pracownik małej/średniej firmy (1–50 osób) świadczącej usługi lub dostawy dla
sektora publicznego lokalnie lub regionalnie. Nie jest specjalistą od zamówień publicznych.
Czyta e-mail na telefonie. Chce wiedzieć: _co_, _kto zamawia_, _gdzie_, _do kiedy_, _link_.

Pytanie kontrolne dla każdej funkcji: **„Czy mała firma będzie wiedziała, co z tym zrobić?”**

## Profil firmy (MVP)

| Pole                  | Wymagane | Przykład                                    |
| --------------------- | -------- | ------------------------------------------- |
| e-mail odbiorcy       | tak      | `biuro@firma.pl`                            |
| kategorie             | tak (≥1) | `elektryka`, `ppoz`                         |
| województwa / powiaty | nie      | `mazowieckie`; powiat `warszawski zachodni` |
| słowa kluczowe        | nie      | `oświetlenie`, `instalacja odgromowa`       |
| słowa wykluczające    | nie      | `dostawa paliwa`                            |

Kategorie MVP (zamknięta lista, rozszerzana na podstawie realnych potrzeb klientów):
`elektryka`, `instalacje`, `ppoz`, `szkolenia`, `bhp`, `sprzatanie`, `it`, `remonty`,
`serwis`, `wyposazenie`.

## Pojedynczy wynik w alercie

Pokazujemy tylko pola obecne w źródle (brak = nie pokazujemy lub „nie podano”, nigdy zmyślona
wartość):

- nazwa zamówienia,
- zamawiający,
- lokalizacja,
- termin składania ofert (najważniejszy — sortujemy po nim),
- data publikacji,
- krótki opis,
- kategoria,
- link do źródła,
- publiczne dane kontaktowe opublikowane przy zamówieniu,
- dlaczego pasuje (np. kategoria: „Elektryka”; słowo: oświetlenie (tytuł); region: mazowieckie).

## Dostęp

- Bez haseł: do profilu wchodzi się linkiem z e-maila (digest albo „Wyślij mi link” na stronie
  głównej). Link działa raz przez 7 dni; na innym urządzeniu prosi się o nowy.
- „Wyślij mi link” zawsze odpowiada tak samo („Jeśli adres jest w bazie, link przyjdzie w ciągu
  kilku minut”), więc nie zdradza, czy adres ma profil. Najwyżej 3 linki dziennie na profil.
- Zmiana adresu e-mail wymaga potwierdzenia z nowej skrzynki; do potwierdzenia digest i linki
  idą na stary adres, który dostaje też powiadomienie. Literówka nie odcina digestu.
- Nową firmę zakłada na razie operator; strona główna to mówi i podaje kontakt
  (`CONTACT_EMAIL`), a `/przyklad` pokazuje przykładowy digest.

## Digest

- Jeden e-mail dziennie na profil, tylko jeśli są nowe dopasowania (brak maili „nic nie ma”).
- Nagłówek: „Znaleźliśmy dziś N nowych zamówień pasujących do Twojej firmy.”
- To samo zamówienie nie jest wysyłane temu samemu profilowi dwa razy.
- Ogłoszenia z upływającym terminem nie są wysyłane.

## MVP — zakres

Zakres i kolejność: `docs/ROADMAP.md`, `docs/PR_PLAN.md`.

## Non-goals

Patrz `docs/MASTER_PROMPT.md` §6. W szczególności: brak CRM, brak zarządzania ofertami, brak
analityki, brak chatbota, brak płatności w MVP.

## Otwarte pytania produktowe (do pilotażu)

1. Które źródła dają największe pokrycie dla pierwszych klientów? (decyzja w PR-02 i fazie 4)
2. Jaki próg dopasowania minimalizuje szum bez gubienia okazji? (kalibracja w PR-04/pilocie)
3. Czy digest dzienny wystarcza, czy potrzebne są natychmiastowe alerty? (po pilotażu)
