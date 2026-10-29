# Produkt — Radar Zamówień

## Obietnica

> Użytkownik dostaje kilka właściwych okazji zamiast przeglądać setki nieistotnych ogłoszeń.

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
- dlaczego pasuje (np. „kategoria: elektryka; słowo: oświetlenie; region: mazowieckie”).

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
