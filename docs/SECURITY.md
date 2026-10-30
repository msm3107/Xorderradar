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
  `node dist/main.js` uruchomione bezpośrednio nie czyta `.env`.
- `.env.example` zawiera tylko nazwy zmiennych i bezpieczne przykłady.
- Konfiguracja jest walidowana schematem (`src/infrastructure/config.ts`); komunikat błędu
  podaje **nazwę** zmiennej, nigdy jej wartości.
- Sekrety nie trafiają do logów, URL-i, komunikatów błędów, fixture'ów ani snapshotów testów.
- Poświadczenia z minimalnymi uprawnieniami (osobny użytkownik DB dla aplikacji, bez praw
  superusera).

## 2. SSRF protection _(egzekwowane od PR-02)_

Cały ruch wychodzący adapterów idzie przez `SafeHttpClient`:

- allowlista hostów zdefiniowana statycznie w adapterze; URL-e z treści dokumentów (linki do
  szczegółów) też muszą trafić na allowlistę;
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
  5 min, `ingest` 10 min na źródło (D-018); po nim przebieg źródła jest `failed`
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

## 8. Safe HTML parsing _(od PR-02)_

- Parser HTML bez wykonywania skryptów (żadnych przeglądarek headless do parsowania).
- Treść ze źródeł konwertowana do czystego tekstu przy normalizacji; w bazie nie trzymamy
  HTML ze źródeł.
- XML: wyłączone encje zewnętrzne i DTD (ochrona przed XXE / billion laughs).
- Unikamy wyrażeń regularnych podatnych na ReDoS na danych zewnętrznych; ograniczamy długość
  wejścia przed dopasowaniem.

## 9. SQL injection protection _(od PR-01)_

- Wyłącznie zapytania parametryzowane / query builder. Zakaz sklejania SQL z danymi.
- Dynamiczne identyfikatory (kolumny sortowania) tylko z allowlisty.
- Ograniczenia integralności (unique, FK, CHECK) w bazie, nie tylko w kodzie.

## 10. Output encoding & e-mail safety _(od PR-05/06)_

- Wszystkie dane ze źródeł escapowane kontekstowo w HTML e-maili i UI.
- Nagłówki e-mail budowane przez bibliotekę (ochrona przed header injection); temat bez
  surowych danych ze źródła lub po sanityzacji znaków nowej linii.
- Domyślny tryb wysyłki: `test`. Wysyłka do prawdziwych odbiorców tylko w jawnie
  skonfigurowanym trybie `smtp` **i po potwierdzeniu właściciela projektu**.
- Każdy e-mail zawiera informację, dlaczego odbiorca go dostaje, i sposób rezygnacji.

## 11. Authentication & authorization _(od PR-06)_

- Autoryzacja po stronie serwera dla każdego profilu/zasobu; deny by default.
- Tokeny dostępu losowe (CSPRNG), przechowywane jako hash, z wygaśnięciem i unieważnieniem.
- Ciasteczka `HttpOnly; Secure; SameSite=Lax`; ochrona CSRF dla formularzy.

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
