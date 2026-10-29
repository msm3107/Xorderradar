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
- po rozwiązaniu DNS blokowane są adresy: loopback, prywatne (RFC 1918, ULA `fc00::/7`),
  link-local (w tym `169.254.169.254`), `0.0.0.0/8`, CGNAT `100.64.0.0/10`, multicast,
  IPv4-mapped IPv6; połączenie jest nawiązywane z **zweryfikowanym** adresem (ochrona przed
  DNS rebinding);
- przekierowania obsługiwane ręcznie, każdy hop walidowany jak nowe żądanie, max 3;
- brak możliwości przekazania dowolnego URL-a przez użytkownika do fetchera.

## 3. URL validation

- Parsowanie przez WHATWG `URL`; akceptowane schematy: `https:` (wyjątek `http:` tylko dla
  konkretnego źródła, z wpisem w DECISIONS).
- Odrzucane: dane uwierzytelniające w URL (`user:pass@`), niestandardowe porty (chyba że
  źródło ich wymaga — wpis w adapterze), hosty IP literalne.
- Linki do źródła pokazywane użytkownikowi (e-mail, UI) muszą mieć schemat `https:`/`http:`;
  inne (`javascript:`, `data:`) są odrzucane przy normalizacji.

## 4. HTTP timeouts _(od PR-02)_

- Timeout połączenia i całkowity timeout żądania (wartości startowe: 10 s / 30 s), przerwanie
  przez `AbortSignal`.
- Timeout całego przebiegu źródła, aby jedno źródło nie blokowało crona.

## 5. Response size limits _(od PR-02)_

- Limit odczytu strumieniowego (start: 5 MB na odpowiedź), przerwanie po przekroczeniu — nie
  ufamy nagłówkowi `Content-Length`.
- Limit liczby stron/paginacji na przebieg i liczby rekordów na dokument.
- Dekompresja z limitem rozmiaru po rozpakowaniu (ochrona przed zip bomb).

## 6. Rate limiting & retry _(od PR-02)_

- Max 1 żądanie na ~2 s na host (konfigurowalne per adapter, nigdy szybciej niż pozwala
  regulamin źródła); żądania do źródła sekwencyjne.
- Retry tylko dla błędów przejściowych (timeout, 429, 502–504), max 2 ponowienia,
  wykładniczy backoff z jitterem, respektowanie `Retry-After`. Brak retry dla 4xx.
- Brak „retry storm”: przebieg ma budżet błędów, po którego przekroczeniu źródło jest
  pomijane do następnego cyklu.

## 7. Responsible data collection (public data policy)

**Nigdy:** omijanie CAPTCHA, mechanizmów antybotowych, uwierzytelnienia, paywalli ani rate
limitów; rotacja IP/User-Agentów w celu ukrycia ruchu; pobieranie danych niepublicznych;
masowe zbieranie danych osobowych.

**Zawsze:** stały User-Agent identyfikujący projekt z kontaktem; respektowanie `robots.txt`
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
  użytkowników (najwyżej identyfikator profilu), pełnych odpowiedzi źródeł.
- Komunikaty błędów dla użytkownika są bezpieczne; szczegóły tylko w logu.

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
