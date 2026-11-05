# Baza Konkurencyjności fixtures

Real responses of the public, undocumented JSON API behind the Baza Konkurencyjności web
application (`docs/DECISIONS.md` D-030), captured on **2026-11-04** (PR-08). Nothing was
downloaded from `/api/files/…`, which holds attachments.

The files are pseudonymised. Unlike the BZP fixtures (a string-level replacement on the raw
text), each file was parsed, changed in its string values, and serialised again with
`json.dumps(…, ensure_ascii=True, separators=(",", ":"))`. Before the substitution, this
serialisation was checked to be **byte-identical** to the server's own output: the server
sends compact JSON with `\uXXXX` escapes. So the only bytes that differ from the capture are
the substituted values. The JSON files are excluded from Prettier.

Substitutions:

- **Names of natural persons** are replaced with `Jan Kowalski`, `Anna Nowak` and
  `Piotr Zieliński`. In these captures they occur only in `forename`/`surname` fields:
  - of contact persons;
  - of attachment authors (`created_by`).
- **E-mail addresses** become `kontakt@example.invalid` (`kontakt2@…`, `kontakt3@…` for a second
  and third distinct address), also inside free text.
- **Phone numbers** become `000 000 000` (`000 000 001`, `000 000 002` for further distinct numbers). A non-number such as `-` or `""` is kept as it is, because the parser tests rely on it.
- These stay unchanged:
  - institution and company names;
  - NIP/REGON;
  - addresses;
  - amounts, dates, CPV codes;
  - the ids of announcements, versions and orders.

| File                         | forename / surname | phone | e-mail | other                                                    |
| ---------------------------- | ------------------ | ----- | ------ | -------------------------------------------------------- |
| `detail-296036.json`         | 5 each             | 0     | 1      | 1 description text (an e-mail in a participation clause) |
| `detail-296132.json`         | 6 each             | 1     | 1      | –                                                        |
| `detail-296622.json`         | 7 each             | 0     | 1      | –                                                        |
| `detail-296667.json`         | 13 each            | 8     | 8      | –                                                        |
| `detail-296920.json`         | 11 each            | 1     | 1      | –                                                        |
| `list-2026-11-03.json`       | –                  | –     | –      | reduced (see below)                                      |
| `list-empty-2026-06-30.json` | –                  | –     | –      | –                                                        |

## Requests

Host: `https://bazakonkurencyjnosci.funduszeeuropejskie.gov.pl`. The API answers JSON with
`Content-Type: text/html`.

| File                         | Request                                                                                                                                                            |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `list-2026-11-03.json`       | `GET /api/announcements/search?page=1&limit=100&sort=publicationDate&status[]=PUBLISHED&publicationDateRange[from]=2026-11-03&publicationDateRange[to]=2026-11-03` |
| `list-empty-2026-06-30.json` | the same for 2026-06-30 with `limit=1`. This is the real response, `{"status":"OK","data":{"advertisements":[],"meta":{"total":0}}}`.                              |
| `detail-<id>.json`           | `GET /api/announcements/<id>`. The response holds the newest version of the announcement with its orders.                                                          |

The real first page of 2026-11-03 had 100 records and `meta.total` 180. The list fixture
keeps only the four records whose details are captured, in their original order (296132,
296920, 296667, 296622), and sets `meta.total` to **4**. Nothing else in it was changed.

## Shapes covered

- `296036`:
  - the announcement's second version (version id 393920);
  - one order with `estimated_value` `"50000,00"` and 13 distinct CPV codes;
  - contact phone `"-"`.
    This one is not on the list fixture.
- `296132` has the place type "cała Polska" with no voivodeship, and no value.
- `296622`:
  - two orders ("części"), neither with a value;
  - a title spanning a line break;
  - contact phone `""`.
- `296667` has places in two voivodeships and two contact persons.
- `296920` has two places in one voivodeship and county, in different localities.

These were left out on purpose:

- `296896`, because the buyer is a sole trader, so the name of a natural person is the institution name;
- `296329`, because it is about 100 KB.

The expected values of every captured announcement are asserted in `tests/bk-adapter.test.ts`. Edge cases are built there by changing a parsed copy of a real detail, never by hand-crafting whole announcements. Two exceptions are the error envelope `{"status":"Error",…,"message":"errors.not_found_generic"}`, which has the shape of the real 404 body, and the synthetic listing pages built from a real list item.

The rule for future fixtures is the same as for BZP:

- pseudonymise before committing;
- keep no unredacted copy in the repository;
- record the substitutions here.
