# Security — Radar Zamówień

Zasady obowiązują od PR-00. Sekcje oznaczone _(egzekwowane od PR-xx)_ opisują wymagania dla
kodu, który jeszcze nie istnieje — reviewer sprawdza je w tym PR, który ten kod wprowadza.
Punkt odniesienia weryfikacji: OWASP ASVS i OWASP API Security Top 10 (w zakresie, w jakim
dotyczą projektu).

## 1. Secret management

- Sekrety wyłącznie w zmiennych środowiskowych. Lokalnie można je trzymać w `.env`
  (ignorowany przez git), który skrypty `pnpm dev|health|start` wczytują wbudowaną flagą Node
  `--env-file-if-exists=.env`; zmienne ustawione w środowisku procesu mają pierwszeństwo przed
  plikiem. Na produkcji / w cronie zmienne eksportuje środowisko uruchomieniowe —
  `node dist/main.js` uruchomione bezpośrednio nie czyta `.env`. Wdrożenie pilotażowe (PR-07B,
  D-029, `docs/DEPLOY.md`): jeden plik `/etc/radar/radar.env` (`root:radar 0640`, katalog
  `/etc/radar` `root:radar 0750`) czytany jawnie przez `node --env-file=…` w unicie systemd i
  w cronie; aplikacja działa jako użytkownik `radar` bez powłoki, który nie może zmienić
  pliku ani kodu (`/opt/radar-zamowien` należy do administratora).
- `HEARTBEAT_URL` (PR-07B): usługi heartbeat mają token checka w ścieżce, więc kto zna URL,
  może podrabiać pingi i wyciszyć alarm — dlatego jest sekretem. Nigdy nie jest logowany ani
  wypisywany (także w powodzie błędu pingu).
- `.env.example` zawiera tylko nazwy zmiennych i bezpieczne przykłady.
- Konfiguracja jest walidowana schematem (`src/infrastructure/config.ts`); komunikat błędu
  podaje **nazwę** zmiennej, nigdy jej wartości.
- Sekrety nie trafiają do logów, URL-i, komunikatów błędów, fixture'ów ani snapshotów testów.
- Poświadczenia z minimalnymi uprawnieniami (osobny użytkownik DB dla aplikacji, bez praw
  superusera).
- `backup`/`restore` (PR-07A, D-028): hasło z `DATABASE_URL` trafia do `pg_dump`/`pg_restore`
  wyłącznie przez zmienną `PGPASSWORD` w środowisku procesu potomnego — nigdy w argumentach
  (widocznych w `ps`), na stdout/stderr ani w logu; `--dbname` dostaje conninfo libpq bez
  hasła. Środowisko dziecka jest budowane od zera (`PATH`, `HOME`, `PGPASSWORD`,
  `PGCONNECT_TIMEOUT`, `PGAPPNAME`, `LC_ALL`), więc żadna inna zmienna procesu (np. `SMTP_URL`)
  do niego nie trafia. Wszystkie ustawienia połączenia muszą być w `DATABASE_URL`: `pg` sięga
  po `PGHOST`, `PGHOSTADDR`, `PGPORT`, `PGUSER`, `PGPASSWORD`, `PGDATABASE`, `PGOPTIONS` (i
  `PGSSLMODE`, gdy URL nie ustawia TLS), czego narzędzia w czystym środowisku by nie zrobiły —
  inny serwer albo słabszy TLS. Dlatego niepusta zmienna z tej listy (lub
  `PGSSLNEGOTIATION`) → odmowa `unsupported_database_url` (fail-closed) z samą nazwą zmiennej,
  nigdy jej wartością. TLS narzędzi nigdy nie jest słabszy niż TLS
  aplikacji (`pg` weryfikuje certyfikat od `sslmode=require` → narzędzia `verify-full`,
  domyślnie z systemowymi CA); parametr bez dokładnego odpowiednika → odmowa z nazwą
  parametru. stderr narzędzi nie jest wypisywany (może zawierać host, użytkownika, nazwy
  obiektów) — tylko stały powód i kod wyjścia. Testy sprawdzają, że hasło nie pojawia się w
  argumentach ani na wyjściu.
- **Pliki backupu zawierają dane osobowe** (adresy e-mail i ustawienia profili, historia
  doręczeń, skróty tokenów i sesji): tworzone z prawami `0600` w katalogu wskazanym przez
  operatora (zalecany `0700`), nigdy nie nadpisują istniejącego pliku, przy błędzie nic nie
  zostaje. Kopia poza hostem musi być **zaszyfrowana**: na pilocie (PR-07B, D-029) kluczem
  publicznym `age`, klucz prywatny tylko u właściciela, poza VPS (`docs/DEPLOY.md` punkt 11).
  Retencja: 14 najnowszych kopii na hoście (`deploy/cron/radar`, katalog `/var/backups/radar`
  `0700`); poza hostem 14 dni według wieku pliku, po stronie serwera kopii — wysyłka z VPS
  nie może ich usuwać (`rrsync -wo -no-del`; z rsync ≥ 3.3.0 także nadpisywać, `-no-overwrite`). Backup jest objęty prawem do usunięcia danych: usunięty
  profil zostaje w starszych plikach do końca ich retencji (najwyżej ok. 14 dni).

## 2. SSRF protection _(egzekwowane od PR-02)_

Cały ruch wychodzący adapterów idzie przez `SafeHttpClient`:

- allowlista hostów zdefiniowana statycznie w adapterze; URL-e z treści dokumentów (linki do
  szczegółów) też muszą trafić na allowlistę. Obecne allowlisty:
  - `bzp` — `["ezamowienia.gov.pl"]` (D-015);
  - `bk` — `["bazakonkurencyjnosci.funduszeeuropejskie.gov.pl"]` (PR-08, D-030). Adresy
    szczegółów `bk` (`/api/announcements/{id}`) adapter buduje sam z liczbowego id z listy
    (walidowanego schematem), a nie z URL-i z treści. Załączniki (`/api/files/…`) nie są
    pobierane;
- po rozwiązaniu DNS sprawdzane są **wszystkie** adresy hosta; jeśli którykolwiek jest
  zablokowany, żądanie jest odrzucane (`blocked_address`, bez retry). Zablokowane (PR-02,
  `src/infrastructure/http/address-policy.ts`):
  - IPv4: `0.0.0.0/8`, `10.0.0.0/8`, `100.64.0.0/10` (CGNAT), `127.0.0.0/8`,
    `169.254.0.0/16` (link-local, w tym `169.254.169.254`), `172.16.0.0/12`, `192.0.0.0/24`,
    `192.0.2.0/24`, `192.88.99.0/24`, `192.168.0.0/16`, `198.18.0.0/15`, `198.51.100.0/24`,
    `203.0.113.0/24`, `224.0.0.0/4` (multicast), `240.0.0.0/4` (w tym broadcast);
  - IPv6: dozwolony jest wyłącznie global unicast `2000::/3`, bez `2001::/23`,
    `2001:db8::/32`, `2002::/16` (6to4) i `3fff::/20` — czyli zablokowane są m.in. `::`,
    `::1`, IPv4-mapped `::ffff:0:0/96` (każdy, także z publicznym IPv4), `64:ff9b::/96`,
    `100::/64`, ULA `fc00::/7`, link-local `fe80::/10`, multicast `ff00::/8`;
  - wszystko, co nie jest poprawnym adresem IP (w tym IPv6 z indeksem strefy `%`);
- połączenie jest nawiązywane z **zweryfikowanym** adresem: `node:https` dostaje własny
  `lookup`, który zwraca adres sprawdzony wcześniej, więc ponowne zapytanie DNS (rebinding)
  nie może go podmienić; SNI, weryfikacja certyfikatu i `Host` używają nazwy hosta. Nowe
  połączenie na każde żądanie (bez puli keep-alive), bez proxy ze zmiennych środowiskowych;
- przekierowania (301/302/303/307/308) obsługiwane ręcznie, każdy hop walidowany jak nowe
  żądanie (schemat, allowlista, port, DNS/IP), max 3;
- allowlista: dokładne nazwy hostów (bez rozróżniania wielkości liter), bez wildcardów, portów
  i adresów IP; nie ma flagi ani zmiennej środowiskowej dopuszczającej adresy prywatne;
- seamy testowe klienta (`SafeHttpClientDeps`: transport, resolver, zegar, sleep) mogłyby
  ominąć przypinanie adresu i rate limit, dlatego kod w `src/` nie może ich przekazać — reguła
  ESLint (`no-restricted-syntax`) plus review;
- brak możliwości przekazania dowolnego URL-a przez użytkownika do fetchera.

Jedyny inny ruch wychodzący HTTP to ping heartbeat `status` (PR-07B, D-029): jeden `GET` na
`HEARTBEAT_URL` z konfiguracji operatora (nie z danych źródeł ani od użytkowników), więc nie
idzie przez `SafeHttpClient` (allowlista i rate limit dotyczą stron źródeł). Ograniczony
osobno: tylko `https://` z weryfikacją certyfikatu, bez danych logowania w URL, 10 s na
całość, bez przekierowań, bez czytania treści odpowiedzi, bez ponowień.

## 3. URL validation

- Parsowanie przez WHATWG `URL`; akceptowane schematy: `https:` (wyjątek `http:` tylko dla
  konkretnego źródła, z wpisem w DECISIONS).
- Odrzucane: dane uwierzytelniające w URL (`user:pass@`), niestandardowe porty (chyba że
  źródło ich wymaga — wpis w adapterze), hosty IP literalne.
- Zapisywane linki (od PR-01, `httpUrlSchema`): białe znaki, znaki sterujące i samotne
  surogaty wewnątrz URL-a są odrzucane, a do bazy trafia kanoniczny `url.href` (zwalidowana
  postać, nie surowy tekst wejściowy), z limitem długości także po normalizacji.
- Linki do źródła pokazywane użytkownikowi (e-mail, UI) muszą mieć schemat `https:`/`http:`;
  inne (`javascript:`, `data:`) są odrzucane przy normalizacji.

## 4. HTTP timeouts _(od PR-02)_

- Timeout połączenia (TCP + TLS) 10 s i całkowity timeout jednej wymiany (DNS, połączenie,
  nagłówki, cała treść) 30 s, przerwanie przez `AbortSignal` (PR-02). Wywołujący może podać
  własny `AbortSignal`, który przerywa też czekanie na rate limit i backoff.
- Timeout całego przebiegu źródła, aby jedno źródło nie blokowało crona: `source:preview`
  5 min, `ingest` 15 min na źródło i dzień (D-018, D-021, D-030); po nim przebieg jest `failed`
  (`source_timeout`), a następne źródło startuje.
- `ingest` nie nakłada się sam na siebie (advisory lock w PostgreSQL, D-019): drugie
  uruchomienie nic nie pobiera, więc nakładające się crony nie podwajają ruchu do źródeł.
  Utrata blokady w trakcie (zerwane połączenie) przerywa przebieg (`lock_lost`, kod 1) —
  bez blokady `ingest` nie pobiera ani nie zapisuje dalej.

## 5. Response size limits _(od PR-02)_

- Limit odczytu strumieniowego (5 MB na odpowiedź), przerwanie po przekroczeniu — nie
  ufamy nagłówkowi `Content-Length` (służy tylko do wcześniejszego odrzucenia).
- Limit liczby stron/paginacji na przebieg i liczby rekordów na dokument.
- Dekompresja z limitem rozmiaru po rozpakowaniu (ochrona przed zip bomb): `gzip`, `deflate`,
  `br` rozpakowywane z `maxOutputLength` = 5 MB (przerwanie bez rozpakowania całości; dla
  `deflate` także surowy DEFLATE bez nagłówka zlib); inne lub łączone `Content-Encoding` są
  odrzucane.

## 6. Rate limiting & retry _(od PR-02)_

- Max 1 żądanie na ~2 s na host (konfigurowalne per adapter, nigdy szybciej niż pozwala
  regulamin źródła, a w kodzie nigdy częściej niż raz na 1 s); żądania do źródła
  sekwencyjne. Odstęp liczony od końca poprzedniego żądania do hosta.
- Retry tylko dla błędów przejściowych (timeout, zerwane/odrzucone połączenie, 429,
  502–504), max 2 ponowienia, wykładniczy backoff z jitterem, respektowanie `Retry-After`
  (sekundy lub HTTP-date) do 60 s — dłuższy `Retry-After` kończy żądanie błędem bez czekania.
  Każdy `Retry-After` staje się terminem dla hosta (także po wyczerpaniu ponowień): kolejne
  żądania do hosta czekają do niego, a gdy zostało > 60 s — kończą się błędem bez ruchu
  sieciowego. Odstępy i terminy liczone zegarem monotonicznym.
  Brak retry dla pozostałych 4xx/5xx, błędów polityki (URL, allowlista, adres) i błędów TLS.
- Brak „retry storm”: każdy klient (= przebieg źródła) ma budżet błędów (domyślnie 10
  nieudanych prób, licząc też ponowienia); po jego wyczerpaniu odmawia kolejnych żądań
  (`budget_exhausted`), więc źródło jest pomijane do następnego cyklu.

## 7. Responsible data collection (public data policy)

**Nigdy:** omijanie CAPTCHA, mechanizmów antybotowych, uwierzytelnienia, paywalli ani rate
limitów; rotacja IP/User-Agentów w celu ukrycia ruchu; pobieranie danych niepublicznych;
masowe zbieranie danych osobowych.

**Zawsze:** stały User-Agent identyfikujący projekt z kontaktem
(`RadarZamowien/0.1 (+<CRAWLER_CONTACT>)`; bez ustawionego `CRAWLER_CONTACT` klient HTTP się
nie uruchamia — kontaktu nie wymyślamy); respektowanie `robots.txt`
i regulaminu źródła; preferencja API → oficjalny feed → dane strukturalne → HTML; zapis w
DECISIONS podstawy korzystania z każdego źródła.

Dane kontaktowe: przechowujemy wyłącznie dane opublikowane **przy danym zamówieniu** jako
kontakt w sprawie zamówienia. Nie budujemy bazy osób, nie łączymy danych z innych źródeł.
Usunięte/wycofane ogłoszenia oznaczamy statusem; polityka retencji — PR-07.

Baza Konkurencyjności (`bk`, PR-08, D-030):

- Szczegóły ogłoszenia zawierają imiona i nazwiska osób kontaktowych i autorów załączników.
  Adapter waliduje z osób tylko `email` i `phone_number`, więc imię i nazwisko nie trafia do
  bazy, logu ani wyniku `source:preview`.
- Zapisywany jest tylko poprawny e-mail i telefon złożony z cyfr i separatorów. Inne
  wartości (`-`, tekst z literami, błędny e-mail) są pomijane, a nie zapisywane jako
  `contact.raw`, bo mogą zawierać nazwisko.
- Opisy pozycji to tekst zamawiającego (jak opisy BZP).
- Ponowne wykorzystanie wymaga atrybucji zgodnie z regulaminem Bazy (źródło z pełną nazwą
  ministerstwa, data pozyskania, informacja o przetworzeniu). Pokazują ją e-mail i
  `/dopasowania`.
- `robots.txt` nie istnieje (ścieżka zwraca HTML aplikacji).
- API jest nieudokumentowane. Zmiana struktury listy, koperty szczegółów albo pól wymaganych
  (np. przemianowany `title`, `advertiser_address_details.name`) kończy dzień kodem
  `invalid_document` po co najwyżej 3 takich szczegółach; pojedyncze (do 2 na dzień) są
  pomijane jako `detail_invalid` (`incomplete`). Dzień z więcej niż 2 przeczytanymi rekordami,
  z których `normalize` odrzuca każdy (np. termin w nowym formacie), też jest
  `invalid_document`. Oba wychodzą w `status`. Dzień z 1–2 rekordami, wszystkimi odrzuconymi,
  nie jest alertowany, tylko liczony (`rejected`); odrzucony rekord nie jest zapisywany.
  Rekordy niezgodne ze schematem nie są zapisywane. Lista dnia z mniejszą liczbą różnych
  ogłoszeń niż jej własne `meta.total` (przy ponad 250 ogłoszeniach: niż budżet) też kończy
  dzień kodem `invalid_document`, zanim cokolwiek zostanie zapisane, więc braki nie są cichym,
  pokrytym dniem. Zmiana nazwy pola
  **opcjonalnego** (termin, kontakt, miejsca realizacji, wartość, CPV) nie jest wykrywana:
  pole staje się `null`, nigdy zgadywaną wartością (D-030).

## 8. Safe HTML parsing _(od PR-02)_

- Parser HTML bez wykonywania skryptów (żadnych przeglądarek headless do parsowania).
- Treść ze źródeł konwertowana do czystego tekstu przy normalizacji; w bazie nie trzymamy
  HTML ze źródeł.
- XML: wyłączone encje zewnętrzne i DTD (ochrona przed XXE / billion laughs).
- Unikamy wyrażeń regularnych podatnych na ReDoS na danych zewnętrznych; ograniczamy długość
  wejścia przed dopasowaniem.
- `htmlBody` ogłoszeń o zmianie BZP (od PR-03B, D-015): długość ograniczona przed parsowaniem
  (1 000 000 znaków, dłuższy → odrzucenie rekordu; zaobserwowane do 255 562), jeden liniowy przegląd tekstu między
  znacznikami bez parsera DOM (wyrażenia regularne tylko literalne albo bez zagnieżdżonych
  kwantyfikatorów; komentarze, `<script>`, `<style>` i atrybuty pomijane; niedomknięty
  znacznik, komentarz, `<script>` lub `<style>` → odrzucenie rekordu); normalizacja Unicode
  NFC (kwadratowa w ciągu znaków łączących o różnych klasach) tylko dla segmentów
  ≤ 256 znaków — dłuższy segment nie może być równy żadnej etykiecie ani dacie i zostaje
  nieznormalizowany, więc koszt jest liniowy w długości treści; z treści wychodzi wyłącznie jedna data; HTML nie jest zapisywany ani logowany, powody
  odrzuceń/pominięć są stałe. Testy: wrogie treści i przypadki 1 000 000 znaków (w tym długie
  ciągi znaków łączących U+0316/U+0301).
- `htmlBody` ofert BZP (`ContractNotice`, `SmallContractNotice`; od PR-03C, D-022): ten sam
  skaner (`src/sources/normalize/html-text.ts`) i ten sam limit 1 000 000 znaków, ale
  brakujący, za długi lub niedomknięty `htmlBody` **nie odrzuca oferty** — opis, kontakt i
  wartość są wtedy `null`. Po skanie jedno przejście po segmentach na pole, zbierające
  ograniczoną ilość tekstu (opis ≤ 10 000, kontakt ≤ 500, wartość ≤ 100 znaków); wyrażenia
  regularne tylko na ograniczonych ciągach. Z treści wychodzą wyłącznie te trzy pola (tekst
  bez HTML; znaki sterujące `\p{Cc}` — C0, DEL, C1 z NEL U+0085 — zamienione na spację,
  znaki sterujące kierunkiem tekstu U+061C, U+200E, U+200F, U+202A–U+202E, U+2066–U+2069 i
  znaki zerowej szerokości U+200B–U+200D, U+2060, U+FEFF usunięte) — HTML nie jest zapisywany ani logowany, powód braku
  szczegółów nie jest logowany. Kontakt: tylko e-mail i telefon z pól kontaktowych
  formularza (pierwszy zamawiający), bez imion i nazwisk, bez wzbogacania (§7). Testy:
  wrogie treści po 1 000 000 znaków (`tests/bzp-notice-body.test.ts`).
- JSON Bazy Konkurencyjności (`bk`, PR-08, D-030): ścisły UTF-8 i `JSON.parse` w limicie
  5 MB odpowiedzi (strona listy 250 rekordów to ok. 180 KB; zwykle jedno żądanie listy na
  dzień, najwyżej 4); schematy zod tylko dla używanych pól, każde tekstowe pole ≤ 20 000 znaków
  (opis pozycji ≤ 200 000), listy ≤ 1 000 elementów; HTML w danych nie jest parsowany —
  tekst przechodzi przez `cleanText`, wyrażenia regularne (kwota, CPV, telefon, daty) są
  zakotwiczone, bez zagnieżdżonych kwantyfikatorów i działają na ograniczonych ciągach.
  Pominięte szczegóły ogłoszenia (404, inna koperta) są logowane tylko z id ogłoszenia, kodem
  powodu i licznikiem; najwyżej 2 na dzień, potem dzień jest `failed` (D-030).

## 9. SQL injection protection _(od PR-01)_

- Wyłącznie zapytania parametryzowane / query builder. Zakaz sklejania SQL z danymi.
- Dynamiczne identyfikatory (kolumny sortowania) tylko z allowlisty.
- Ograniczenia integralności (unique, FK, CHECK) w bazie, nie tylko w kodzie.

## 10. Output encoding & e-mail safety _(e-mail od PR-05, UI od PR-06)_

- Wszystkie dane ze źródeł escapowane kontekstowo w HTML e-maili i UI. E-mail (PR-05,
  `src/notifications/digest.ts`): każda wartość przez `escapeHtml` (`&`, `<`, `>`, `"`, `'`
  i grawis), także w atrybucie `href` (zawsze w cudzysłowie); link tylko `http:`/`https:` po
  `new URL` (inne schematy, np. `javascript:`, `data:`, i adresy względne → „Link: nie
  podano”, bez `href`); znaki sterujące usunięte (`cleanText`). Test z wrogim tytułem i opisem (`tests/digest.test.ts`).
- Nagłówki e-mail budowane przez bibliotekę (nodemailer, D-010; ochrona przed header
  injection); temat bez surowych danych ze źródła lub po sanityzacji znaków nowej linii. PR-05:
  temat zawiera tylko liczbę ofert i nazwę profilu (bez znaków sterujących, ≤ 80 znaków);
  adresy przekazywane jako obiekty `{name, address}`, `EMAIL_FROM` walidowany (bez `"<>\` i
  znaków sterujących w nazwie), jeden odbiorca na wiadomość, dostęp nodemailera do plików i
  URL-i w treści wyłączony.
- Domyślny tryb wysyłki: `test`. Wysyłka do prawdziwych odbiorców tylko w jawnie
  skonfigurowanym trybie `smtp` **i po potwierdzeniu właściciela projektu**.
- SMTP (PR-05): TLS zawsze — `smtps://` albo `smtp://` z wymaganym STARTTLS (serwer bez
  STARTTLS → błąd przed AUTH i kopertą, test z lokalnym serwerem), TLS ≥ 1.2, weryfikacja
  certyfikatu włączona, timeouty połączenia, powitania, gniazda i DNS; `SMTP_URL` bez
  parametrów zapytania (nodemailer czytałby z nich opcje TLS). Odrzucone logowanie, błąd
  TLS/STARTTLS lub certyfikatu nie są ponawiane i zatrzymują przebieg po pierwszej próbie —
  jedno nieudane logowanie na przebieg, nie jedno na profil (D-024).
- Każdy e-mail zawiera informację, dlaczego odbiorca go dostaje, i sposób rezygnacji. PR-05:
  stopka (odpowiedź / kontakt z operatorem) i nagłówek `List-Unsubscribe` z `mailto:` na sam
  adres `EMAIL_FROM` (bez nazwy, `?subject=wypis`; `unsubscribeMailto` w
  `src/notifications/sender.ts` przyjmuje tylko jeden zwykły adres — bez białych znaków, CR/LF,
  nawiasów i cudzysłowów — i koduje go procentowo, inaczej nagłówka nie ma; nodemailer
  dodatkowo usuwa znaki sterujące z URL-a; testy z próbą header injection). Wypis jednym
  kliknięciem (RFC 8058) — od PR-06A, gdy ustawiono `PUBLIC_BASE_URL`:
  `List-Unsubscribe: <https://…/wypis/<token>>, <mailto:…>` i
  `List-Unsubscribe-Post: List-Unsubscribe=One-Click`; URL tylko w postaci kanonicznej
  (`oneClickUnsubscribeUrl`, inaczej sam `mailto` bez `List-Unsubscribe-Post`); stopka ma ten
  sam link `https` (D-024, D-026). **DKIM musi podpisywać oba nagłówki**
  (`List-Unsubscribe` i `List-Unsubscribe-Post`) — wymaganie RFC 8058 i dużych skrzynek;
  do sprawdzenia w konfiguracji serwera SMTP przed wysyłką do prawdziwych odbiorców (PR-07).
- UI (PR-06A, `src/web/pages.ts`): każda wartość przez ten sam `escapeHtml`
  (`src/infrastructure/html.ts`), bez inline JS i stylów (CSP niżej, §11). PR-06B: strona
  `/dopasowania` pokazuje oferty przez tę samą kartę co e-mail (od PR-11 `offerCard`
  z `notifications/card.ts`; link tylko `http(s)`, `rel="noopener noreferrer"`), a formularz profilu odsyła wysłane wartości
  escapowane (także w `<textarea>`); wartości pól wyboru spoza zamkniętych list nie są
  odsyłane. Testy z wrogim tytułem, URL-em `javascript:` i wartościami formularza.
- Alert operatora (`status --notify`, PR-07A, D-028): tylko na `OPERATOR_EMAIL` (adres
  operatora, walidowany jak inne adresy; błąd → nazwa zmiennej, bez wartości), tym samym
  transportem co `digest` (`EMAIL_MODE=test` → outbox). Zwykły tekst bez HTML i bez
  `List-Unsubscribe` (to nie jest wiadomość do klienta). Treść i temat zawierają wyłącznie
  identyfikatory (`sourceId`, `runId`), statusy, kody błędów, czasy i liczby — nigdy adresów
  e-mail, tytułów ofert, nazw firm, treści profili, URL-i z tokenami ani komunikatów serwera
  (test: brak `@`, `<`, `>` w treści).
- E-maile dostępu z `serve` (PR-10, D-031; `src/notifications/access-emails.ts`): link
  logowania na prośbę („Wyślij mi link”), potwierdzenie nowego adresu i powiadomienie na stary
  adres — tym samym transportem i nadawcą co `digest`, zwykły tekst bez HTML, bez
  `List-Unsubscribe` (nikt ich nie subskrybuje), stałe tematy, bez nazwy firmy i danych profilu
  (dwa pierwsze mogą trafić pod wpisany z błędem adres). Powiadomienie na stary adres nie ma
  linku ani nowego adresu. Wysyłane po odpowiedzi HTTP, każde raz (bez ponawiania).
- Testy nie wysyłają prawdziwych e-maili: fałszywy sender, outbox w katalogu tymczasowym albo
  lokalny serwer na `127.0.0.1`; adresy wyłącznie pseudonimizowane (`*.invalid`).

## 11. Authentication & authorization _(od PR-06)_

- Autoryzacja po stronie serwera dla każdego profilu/zasobu; deny by default.
- Tokeny dostępu losowe (CSPRNG), przechowywane jako hash, z wygaśnięciem i unieważnieniem.
- Ciasteczka `HttpOnly; Secure; SameSite=Lax`; ochrona CSRF dla formularzy.

Stan od PR-06A (`serve`, `src/web/`, D-025, D-026):

- **Bez haseł.** Dostęp przez link z e-maila `digest`, z „Wyślij mi link” (PR-10) albo z
  `access:link <profileId>` (operator). Link jest sekretem: kto ma e-mail lub wydruk komendy,
  ma dostęp do profilu.
- **Tokeny:** 256 bitów z CSPRNG, base64url; w bazie tylko SHA-256 (`access_tokens`,
  `sessions`), ważność według zegara bazy. Logowanie: jednorazowe, 7 dni, GET niczego nie
  zużywa (strona z przyciskiem), POST zużywa atomowo (warunkowy `UPDATE … RETURNING`) i
  otwiera sesję. Wypis: wielokrotny, 60 dni. Potwierdzenie adresu (`email_change`, PR-10):
  jednorazowe, 24 h, związane z adresem z `pending_email`. Ocena trafności (`feedback`,
  PR-12, D-032): wielokrotny, 60 dni, jeden na digest, ważny tylko dla ofert z `deliveries`
  tego profilu (`pending`/`sent`); `GET /ocena/<token>/<oppId>/<werdykt>` niczego nie zapisuje
  (strona z przyciskiem), POST robi atomowy upsert jednej oceny (para profil–oferta unikalna).
  Każdy nieważny token → ta sama
  neutralna strona 404 (na `/ocena/…` także zły kształt ścieżki, cudza lub nieistniejąca
  oferta i nieznany werdykt — bez wyroczni; zdanie o ocenie po zalogowaniu zależy tylko od
  trasy). Usunięcie profilu usuwa tokeny i sesje (`ON DELETE CASCADE`). Unieważnienie
  na żądanie: `access:revoke <profileId>` usuwa w jednej transakcji wszystkie tokeny i sesje
  profilu (przekazany e-mail, zgubione urządzenie); profil bez zmian, na stdout tylko liczby.
- **Sesja:** `__Host-radar_sesja`, `HttpOnly; Secure; SameSite=Lax; Path=/`, 30 dni od
  logowania bez przedłużania, sprawdzana w bazie przy każdym żądaniu; wylogowanie usuwa
  wiersz. Profil wyłącznie z sesji — w URL-ach i formularzach nie ma identyfikatora profilu.
  Nieznana ścieżka → 404, zła metoda → 405.
- **CSRF:** token synchronizujący (HMAC-SHA256 z id sesji) na każdym POST z sesją,
  porównanie w stałym czasie; POST wypisu RFC 8058 chroni token w ścieżce (bez ciasteczka,
  robi tylko `active = false`). `Origin` różny od origin `PUBLIC_BASE_URL` → 403 (poza
  wypisem RFC 8058).
- **Login-CSRF (PR-06B, D-027):** `POST /dostep` nie ma sesji, więc nie ma tokenu CSRF —
  obca strona mogłaby zalogować przeglądarkę ofiary na profil atakującego (a ofiara wpisałaby
  w nim swoje dane). Dlatego ta trasa wymaga dowodu, że formularz pochodzi z naszej strony:
  `Origin` równy origin `PUBLIC_BASE_URL`, albo — gdy `Origin` brak — nagłówek
  `Sec-Fetch-Site` o wartości `same-origin`. Wartości `cross-site`, `same-site` i `none`,
  `Origin` równy `null`, obcy `Origin` oraz brak obu nagłówków → 403, token nie jest
  zużywany. Klient bez obu nagłówków (bardzo stara przeglądarka, skrypt) nie zaloguje się —
  świadomy koszt. Od PR-10 tę samą kontrolę mają pozostałe formularze bez sesji:
  `POST /wyslij-link` i `POST /potwierdz-email/<token>` (obca strona nie wyśle w imieniu
  przeglądarki ofiary prośby o link ani potwierdzenia), od PR-12 też
  `POST /ocena/<token>/<oppId>/<werdykt>` (obca strona nie zapisze oceny za ofiarę).
- **„Wyślij mi link” (PR-10, D-031):** `POST /wyslij-link`, jedno pole `email`, ciało ≤ 1 KiB.
  Bez wyroczni: każdy poprawny adres dostaje od razu identyczną odpowiedź (status, treść,
  nagłówki) — adres z profilem, bez profilu, profil wyłączony i po limicie; zły zapis adresu →
  400 z błędem formularza, bez bazy. Wyszukanie profilu, limit i wysyłka idą po odpowiedzi
  (`src/web/access-mail.ts`, `src/web/mail-queue.ts`: jedno zadanie naraz, najwyżej 20
  czekających, nadmiar odrzucony z kodem w logu), więc czas odpowiedzi też niczego nie mówi.
  Link idzie wyłącznie na **bieżący** adres profilu (nigdy na adres z żądania ani na
  oczekujący). Limity: ≤ 3 e-maile na profil w 24 h (`access_emails`, licznik i zapis pod
  blokadą wiersza profilu — współbieżne żądania nie przekroczą limitu) i ≤ 10 żądań na adres
  IP na godzinę (`src/web/rate-limit.ts`, w pamięci, stałe okno, najwyżej 10 000 kluczy,
  najstarsze usuwane) → 429. Adres IP: z gniazda; gdy połączenie przychodzi z loopback
  (Caddy na tym samym hoście) — ostatni wpis `X-Forwarded-For` (ten, który dopisało nasze
  proxy; wpisy od klienta są wcześniej). Klucz limitu: IPv4 — adres (także IPv4 zapisany jako
  IPv6, `::ffff:a.b.c.d`); IPv6 — prefiks **/64** (pierwsze 4 grupy po pełnym rozwinięciu,
  więc każdy zapis adresu daje ten sam klucz): klient z całą siecią /64 nie obejdzie limitu
  zmianą adresu ani nie zapełni nimi mapy limitu i kolejki e-maili. Limit na IP chroni przed zalewem, nie
  przed rozproszonym atakiem — ten zatrzymuje limit profilu (najwyżej 3 e-maile na dobę na
  adres).
- **Zmiana e-maila (PR-06B, D-027; od PR-10 z potwierdzeniem, D-031):** zapis formularza z
  nowym adresem nie zmienia `email`: adres trafia do `pending_email`, a na niego link
  potwierdzający (`/potwierdz-email/<token>`, 24 h, jednorazowy); na stary adres idzie
  powiadomienie bez linków i bez nowego adresu. Do potwierdzenia digest, linki i logowanie
  używają starego adresu, tokeny i sesje zostają. Kolejna zmiana usuwa poprzedni link; ≤ 3
  linki potwierdzające na profil w 24 h (potem błąd formularza — to sesja właściciela);
  „Anuluj zmianę” (`POST /profil/anuluj-email`, sesja + CSRF) usuwa `pending_email` i link.
  `GET` linku pokazuje tylko przycisk (skaner poczty niczego nie zmienia); `POST` (login-CSRF
  jak wyżej) w jednej transakcji ustawia `email = pending_email` i usuwa wszystkie tokeny
  profilu oraz wszystkie jego sesje poza sesją potwierdzającej przeglądarki, jeśli należy do
  tego profilu. Dwa równoległe potwierdzenia: zmienia jedno, drugie dostaje stronę nieważnego
  linku. **Bez wyroczni „adres zajęty”** w formularzu: każdy poprawny adres przechodzi do
  potwierdzenia; adres zajęty w chwili potwierdzenia → neutralna strona (409) bez zmian i bez
  danych innego profilu. Przejęcie powiadomień wymaga teraz dostępu do nowej skrzynki **i**
  sesji, a właściciel starego adresu dostaje powiadomienie. W transakcji zapisu bieżąca sesja
  jest sprawdzana ponownie (usunięta lub wygasła w międzyczasie → nic nie zapisane, 401).
  Digest wydaje linki tylko, gdy profil wciąż ma adres, na który wysyła (inaczej status
  `address_changed` i brak e-maila), więc po zmianie nie wyśle na stary adres nowych tokenów;
  bez `PUBLIC_BASE_URL` (e-mail bez linków) przebieg trwający w chwili potwierdzenia może
  jeszcze wysłać jeden e-mail na stary adres. Kolejność blokad zapisu, potwierdzenia,
  anulowania i „Wyślij mi link” jest bez cyklu względem logowania, wylogowania,
  `access:revoke` i digestu (D-027, D-031). `/profil` pokazuje
  bieżący adres powiadomień (zescapowany, z bazy dla profilu sesji), nigdy dawnego.
- **Formularz profilu (PR-06B):** sesja + CSRF + `Origin`, ciało ≤ 64 KB (tylko ta trasa) i
  ≤ 64 pary pól, tylko znane pola (pola pojedyncze dokładnie raz), walidacja schematem domeny;
  profil wyłącznie z sesji. `active` nie jest polem formularza (osobne przyciski
  `/profil/wypisz` i `/profil/wlacz`, oba idempotentne). Komunikat po zapisie:
  `__Host-radar_komunikat` (`HttpOnly; Secure; SameSite=Lax`, 60 s), jedno słowo z
  zamkniętej listy — nigdy dane (także adres e-mail); podrobione ciasteczko może najwyżej
  wyświetlić „Zapisano”.
- **Oceny trafności i eksport (PR-12, D-032):** `POST /dopasowania/ocena` — sesja + CSRF +
  `Origin`, pola `csrf`, `oferta` (UUID), `werdykt` (`trafne`/`nietrafne`) i opcjonalne
  `nastepna` (wybiera tylko kotwicę przekierowania; do `Location` trafia tylko po sprawdzeniu
  wzorca uuid, inaczej jest ignorowane), nic więcej (400);
  ocenić można tylko ofertę wysłaną do profilu sesji albo pasującą do niego teraz (regułami profilu,
  niezależnie od wieku oferty — D-032) — inna
  (także cudza) → 404. Zapis to jeden atomowy upsert (`match_feedback`, para profil–oferta
  unikalna, `ON DELETE CASCADE` z obu stron); w bazie tylko id, werdykt i czasy. Oceny są
  czytane wyłącznie dla profilu sesji. `GET /dopasowania.csv`: tylko z sesją, ta sama lista,
  ten sam limit wierszy (`MATCHES_SHOWN`) i ten sam slot co `/dopasowania`,
  `Content-Disposition: attachment`, `Cache-Control: no-store`; komórka zaczynająca się od
  `=`, `+`, `-`, `@`, tabulatora lub CR dostaje prefiks `'` (OWASP CSV injection — `=1+1`
  zostaje tekstem), cudzysłowy według RFC 4180, brak wartości → pusta komórka (nigdy `0`),
  link tylko `http(s)`. `feedback:report` wypisuje wyłącznie id profili, klucze kategorii i liczby
  (precyzja `null` przy zerze ocen, pokrycie `null` przy zerze wysłanych).
- **Twardnienie HTTP:** ciało ≤ 8 KB (413), tylko `application/x-www-form-urlencoded`
  (inaczej 415); wyjątek: POST wypisu RFC 8058 przyjmuje też `multipart/form-data` (RFC 8058
  §3.2 — SHOULD), czytany własnym ścisłym parserem bez zależności (`src/web/multipart.ts`:
  boundary według RFC 2046, dokładnie jedna część `List-Unsubscribe` = `One-Click`, wszystko
  niepoprawne → 400, bez regexów na ciele; D-026). Wypis odpowiada 200 ze stroną, nigdy
  przekierowaniem (RFC 8058 MUST NOT). Nagłówki ≤ 8 KB / 50, timeouty nagłówków 10 s,
  żądania 15 s (Node sprawdza je co 1 s — `connectionsCheckingInterval`), keep-alive 5 s,
  gniazda 30 s. Nagłówki odpowiedzi: CSP
  `default-src 'none'; style-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`,
  `nosniff`, `Referrer-Policy: strict-origin` (`Referer` niesie tylko origin, więc token z
  URL nie wycieka w `Referer`, także do logów własnego proxy; PR-06A miał `no-referrer`, przy
  którym przeglądarki wysyłają w formularzach `Origin: null` i kontrola `Origin` odrzucała
  każdy formularz — poprawione w PR-06B), `Cache-Control: no-store`. Od PR-07A (D-028) przy
  `PUBLIC_BASE_URL` `https://` każda odpowiedź ma też
  `Strict-Transport-Security: max-age=31536000` — rok, tylko ten host: **bez**
  `includeSubDomains` (nie wiemy, czy wszystkie subdomeny domeny mają TLS) i bez `preload`
  (wpis na listę preload jest trudny do cofnięcia). Przy `http://` (tylko loopback poza
  produkcją) nagłówka nie ma. Proxy nie powinno dodawać drugiego nagłówka HSTS.
- **Znaki sterujące na wejściu (PR-07A, D-028):** nazwa firmy i wpisy list (powiaty, słowa)
  ze znakiem sterującym `\p{Cc}` wewnątrz (np. wklejony tabulator) są odrzucane — w formularzu
  (błąd przy polu) i w `profile:create` (ścieżka pola, bez wartości); znaki na brzegach są
  przycinane jak dotąd. Schematy wierszy zapisanych w bazie się nie zmieniają (stary wiersz
  dalej się wczytuje); wyjście i tak przechodzi przez `escapeHtml`/`cleanText`.
- **Bez ogólnego limitu żądań w aplikacji:** tokenów 256-bitowych nie da się zgadnąć, a każde
  żądanie jest ograniczone rozmiarem i czasem; zalew żądań zatrzymuje reverse proxy (PR-07).
  Wyjątki: „Wyślij mi link” (limit na IP i na profil, wyżej) i niżej `/dopasowania`. Wyjątek
  kosztowy (PR-06B, D-027): `/dopasowania` liczy dopasowanie na żądanie w wątku procesu `serve`
  (zmierzone lokalnie: ok. 0,8 s przy 5 000 kandydatów i typowym profilu, do kilkunastu sekund przy
  limicie 10 000 i maksymalnym profilu). Liczenie oddaje pętlę zdarzeń po każdych ok. 20 ms pracy,
  więc pozostałe żądania są obsługiwane, a proces liczy najwyżej jedną listę naraz. Kolejne żądanie
  czeka w ograniczonej kolejce FIFO (najwyżej 8 żądań i 3 s; rozłączony klient wypada z niej bez
  liczenia, bez pozostawionych timerów i nasłuchów); pełna kolejka albo upływ czasu → 503 z
  `Retry-After`. To jedno miejsce jest **wspólne dla wszystkich klientów**: posiadacz sesji
  ponawiający żądania może je zajmować i inni klienci czekają wtedy albo dostają 503 (reszta stron
  działa). Od PR-07A jedna sesja ma naraz najwyżej 2 żądania `/dopasowania` w toku lub w kolejce;
  trzecie → od razu 429 z `Retry-After` (licznik po id sesji z bazy, nigdy po wartości ciasteczka;
  D-028) — jeden klient nie zajmie całej kolejki, ale wiele sesji nadal może. Dostępne tylko z
  sesją. Limitu na proxy pilot nie ma (Caddy wymaga do tego zewnętrznego modułu — poza zakresem
  PR-07B, D-029).
- **Reverse proxy (PR-07):** `serve` słucha domyślnie na `127.0.0.1:3000` czystym HTTP; TLS, HSTS i
  przekierowanie z `http` robi proxy. Tokeny są w ścieżkach `/dostep/…`, `/wypis/…`,
  `/potwierdz-email/…` (PR-10) i `/ocena/…` (PR-12) — proxy **nie może** zapisywać tych ścieżek w logach dostępu
  (wyłączony log albo ścieżka przycięta). Pilot (PR-07B): `deploy/caddy/Caddyfile` — `log_skip` dla
  tych czterech ścieżek w logu dostępu, a ponieważ `log_skip` nie obejmuje innych logów (log błędów w
  journalu, np. 502 z `reverse_proxy` przy restarcie `serve`; serwer przekierowania HTTP → HTTPS),
  **każdy** log Caddy (domyślny i dostępu) ma `format filter`, który w `request>uri` i
  `request>headers>Referer` zamienia `/dostep/<token>`, `/wypis/<token>`,
  `/potwierdz-email/<token>` i `/ocena/<token>` na `…/REDACTED` (obrona w głąb; aplikacja wysyła też
  `Referrer-Policy: strict-origin`, więc przeglądarki nie podają ścieżki). Po instalacji i każdej zmianie Caddyfile
  obowiązkowa kontrola z `docs/DEPLOY.md` punkt 8 (`grep -c` testowego tokenu w journalu i logu
  dostępu = 0). Nagłówki `Cookie`/`Authorization` maskowane przez Caddy, limit ciała żądania 128 KB
  i timeouty odczytu; HSTS tylko z aplikacji. Caddy ustawia `X-Forwarded-For` sam (bez
  `trusted_proxies` nagłówek od klienta jest zastępowany), a `serve` bierze z niego ostatni wpis
  tylko przy połączeniu z loopback — nie dodawaj `trusted_proxies` bez proxy przed Caddy. `serve`
  jako unit systemd z hardeningiem (bez uprawnień, tylko odczyt systemu plików poza outboxem
  `EMAIL_MODE=test`) i z filtrem IP tylko na loopback (`IPAddressDeny=any`,
  `IPAddressAllow=localhost`) — w domyślnym `EMAIL_MODE=test` `serve` nie ma żadnego wyjścia. Od
  PR-10 `serve` wysyła e-maile dostępu; w `EMAIL_MODE=smtp` obowiązkowy drop-in
  `deploy/systemd/radar-serve.service.d/smtp.conf` zeruje `IPAddressDeny=` (adresy dostawcy SMTP
  się zmieniają): systemd nie ogranicza wtedy wcale ruchu wychodzącego `serve` (dowolny host i
  port) — jak dla digestu i alertów z crona, które działają bez filtra systemd; ograniczyć go
  może tylko firewall hosta z regułami wyjścia. Jedyne połączenia wychodzące `serve` to PostgreSQL i `SMTP_URL` —
  nie pobiera źródeł ani żadnych URL-i. Firewall hosta: z zewnątrz tylko 22/80/443; PostgreSQL
  tylko na `localhost`.
- **`/zdrowie` (PR-07B, D-029):** bez uwierzytelnienia — `GET`/`HEAD`,
  stała treść (`ok` / `niedostępne`), bez danych, bez sesji i CSRF, `no-store`. Jedno sprawdzenie
  bazy naraz, wspólne dla równoległych żądań (zalew zajmuje najwyżej jedno połączenie z puli);
  zawieszone zostaje wspólne do ok. 40 s (5 s na połączenie z puli + 35 s `query_timeout`),
  a żądania dostają w tym czasie `503` po 2 s. Limit żądań na proxy — poza PR-07B.
- **Sprzątanie:** `serve` co godzinę usuwa wygasłe tokeny i sesje oraz zapisy limitu e-maili
  dostępu (`access_emails`) starsze niż doba (po 1000 na przebieg i tabelę).

## 12. Logging policy

- JSON-lines na stderr; stdout tylko na wynik komendy.
- Logger **nie redaguje** pól — odpowiedzialność za ich treść ma wywołujący. Serializacja pól
  nigdy nie rzuca: `Error` → `{name, message}` (bez stack trace — ścieżki plików i szum; jeśli
  stack jest potrzebny, wywołujący przekazuje go jawnie), `bigint` → string, cykle →
  `"[Circular]"`; gdy pola nie da się odczytać, wpis zawiera `logError` zamiast pól.
- Logujemy: `sourceId`, host, status, czas, liczniki, klasy błędów.
- Nie logujemy: sekretów, pełnych `DATABASE_URL`/`SMTP_URL`, treści e-maili, adresów e-mail
  użytkowników (najwyżej identyfikator profilu), pełnych odpowiedzi źródeł, URL-i pobieranych
  dokumentów (ścieżka/zapytanie mogą zawierać tokeny — `SafeHttpClient` loguje tylko host) ani
  nagłówków HTTP.
- `ingest` (od PR-03A) loguje i zapisuje w `ingestion_runs` wyłącznie: `sourceId`,
  identyfikatory (`runId`, `externalId` ogłoszenia — publiczny numer), statusy, liczniki,
  czas, `incomplete` (`part`, `reason`), kod błędu (`errorCode`, w bazie tylko
  `^[a-z][a-z0-9_]{0,63}$`), status HTTP i nazwę naruszonego constraintu. Nigdy treści
  dokumentów, tytułów, danych kontaktowych z ogłoszeń, komunikatów błędów ani adresu bazy.
  Powody odrzuceń z `normalize` to stałe teksty z nazwami pól (bez wartości).
  Pominięte ogłoszenia o zmianie (od PR-03B) — tylko `sourceId`, `externalId`, `tenderId`
  (publiczne identyfikatory) i stały powód; nigdy treść `htmlBody`.
- `digest` (od PR-05) loguje, wypisuje i zapisuje w `deliveries` wyłącznie identyfikatory
  (`profileId`, `opportunityId`), statusy, liczniki, ścieżki pól i kody błędów wysyłki
  (`smtp_<kod odpowiedzi lub błędu>`, `^[a-z][a-z0-9_]{0,63}$` — nigdy komunikat ani odpowiedź
  serwera, które mogą zawierać adres). Nigdy adresów e-mail, tytułów, treści e-maili ani
  `SMTP_URL`. Pliki outboxu (tryb `test`) zawierają adres i treść — katalog `0700`, pliki
  `0600`, `outbox/` w `.gitignore`. Linki z tokenami (PR-06A) nie trafiają do logów. Plik
  `.eml` to cały e-mail, więc **zawiera sekretne linki** (`/dostep/<token>`,
  `/wypis/<token>`, od PR-10 też `/potwierdz-email/<token>` z e-maili dostępu `serve`, od
  PR-12 `/ocena/<token>/…` z digestu); czytelna kopia `.json` ma je zredagowane
  (`/dostep/[token]`, `/wypis/[token]`, `/potwierdz-email/[token]`, `/ocena/[token]/…` — id
  oferty i werdykt zostają).
- `serve` (od PR-06A) loguje jedno zdarzenie na żądanie (`http request`): metoda (znana albo
  `OTHER`), nazwa trasy (`home`, `login_link`, `unsubscribe`, `not_found`…), status i czas.
  Nigdy URL, ścieżki ani zapytania (zawierają tokeny), ciasteczek, nagłówków, treści
  formularzy, adresu klienta, identyfikatora ani danych profilu. Błąd obsługi →
  `http request failed` z nazwą trasy i kodem błędu bazy (bez komunikatu). Klient, który
  przerwał połączenie w trakcie wysyłania ciała (albo został odcięty przez timeout), →
  `http request aborted` (poziom `info`, tylko `route` i `reason: "aborted"`) — nie jest
  błędem bazy ani odpowiedzią 500. `access:link` wypisuje link
  wyłącznie na stdout (ostrzeżenie na stderr), nigdy do logu. E-maile dostępu (PR-10,
  D-031) — jedna linia `access mail` na zadanie: `kind` (`login_link`, `email_change`,
  `email_change_notice`), `outcome`, najwyżej `profileId` i kod błędu (wysyłki jak w `digest`,
  bazy jak wyżej, `access_mail_queue_full`, `access_mail_shutdown`,
  `access_mail_shutdown_timeout`). Nigdy adresu e-mail
  (także z żądania „Wyślij mi link”), tokenu, linku ani adresu IP klienta (test na zapisanych
  liniach logu).
- `status` (od PR-07A) wypisuje i loguje wyłącznie identyfikatory źródeł i przebiegów,
  statusy, kody błędów, czasy i liczby (wysyłki — tylko liczniki i kody, bez `profileId`);
  `backup`/`restore` — ścieżkę pliku, rozmiar, schemat, liczby tabel/wierszy i stały powód
  błędu z kodem wyjścia narzędzia; nigdy conninfo, hasła ani stderr narzędzia. Od PR-07B
  `status` dodaje stan kopii (status, czas najnowszej, liczba plików, kod errno — bez ścieżki
  katalogu w alercie) i wynik heartbeatu (`sent`/`failed`/`skipped`/`disabled`, powód błędu
  jak `timeout`, `http_503`, `network_enotfound`) — nigdy `HEARTBEAT_URL`.
- Komunikaty błędów dla użytkownika są bezpieczne; szczegóły tylko w logu.
- Błędy bazy danych (od PR-01): CLI pokazuje tylko stały powód + kod SQLSTATE/errno, nigdy
  komunikatu sterownika/serwera; repozytoria zamieniają naruszenia ograniczeń na
  `DomainError` bez `detail` serwera (zawiera wartości, np. adres e-mail).

## 13. Dependency policy

- Nowa zależność tylko z uzasadnieniem w PR (czego nie da się rozsądnie zrobić bez niej).
- Wersje przypięte dokładnie, lockfile (`pnpm-lock.yaml`) w repo.
- Preferowane wersje opublikowane co najmniej 2 tygodnie wcześniej.
- `pnpm audit` przed każdym PR. Podatność **high/critical w dowolnej zależności** (runtime lub
  dev) blokuje PR. Podatności moderate/low są naprawiane albo wymienione w Code & Safety
  Review z uzasadnieniem, dlaczego PR może przejść.
- Skrypty instalacyjne zależności domyślnie zablokowane (pnpm 10); dopuszczenie wymaga
  wpisu w `package.json` i uzasadnienia.

## 14. Destructive operation policy

Wymagają jawnego potwierdzenia właściciela: force push, `git reset --hard`, usuwanie
branchy, przepisywanie historii, usuwanie danych/tabel, migracje nieodwracalne na danych
produkcyjnych, zmiany infrastruktury produkcyjnej, deployment produkcyjny, wysyłka do
prawdziwych użytkowników. Zakaz `--no-verify`. Migracje: wersjonowane, testowane na kopii,
z opisaną strategią odtworzenia (nie każda migracja jest odwracalna).

`restore` (PR-07A) nigdy nie nadpisuje danych: działa tylko do istniejącego schematu bez
żadnej relacji i w jednej transakcji (błąd → schemat pusty jak przed). Usunięcie i ponowne
utworzenie schematu produkcyjnego przed odtworzeniem jest usuwaniem danych — wymaga
potwierdzenia właściciela (procedura: `docs/RUNBOOK.md`).
