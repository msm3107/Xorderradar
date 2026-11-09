import { describe, expect, it } from "vitest";
import type { Opportunity } from "../src/domain/opportunity.js";
import { CSV_HEADER, csvCell, matchesCsv } from "../src/web/csv.js";

/** GET /dopasowania.csv's file (PR-12, D-032). Pseudonymised data only. */

function offer(overrides: Partial<Opportunity> = {}): Opportunity {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    sourceId: "bzp",
    sourceUrl: "https://ezamowienia.gov.pl/mo-client-board/bzp/notice-details/id/1",
    externalId: "2026/BZP 1",
    tenderId: null,
    issuerName: "Gmina Przykładowa",
    title: "Modernizacja oświetlenia ulicznego",
    description: "Wymiana opraw na LED.",
    location: { city: "Przykładowo", county: "przykładowy", voivodeship: "mazowieckie" },
    publishedAt: new Date("2026-10-30T08:00:00.000Z"),
    deadline: new Date("2026-11-05T11:00:00.000Z"),
    estimatedValue: "125000.50",
    currency: "PLN",
    categories: ["45310000-3", "50232000-0"],
    contact: { name: "Jan Kowalski", email: "kontakt@example.invalid" },
    fetchedAt: new Date("2026-10-30T09:00:00.000Z"),
    fingerprint: "fp-1",
    contentHash: "hash-1",
    status: "open",
    firstSeenAt: new Date("2026-10-30T09:00:00.000Z"),
    updatedAt: new Date("2026-10-30T09:00:00.000Z"),
    ...overrides,
  };
}

/** The file's lines without the BOM and the final CRLF. */
function lines(file: string): string[] {
  expect(file.startsWith("\uFEFF")).toBe(true);
  expect(file.endsWith("\r\n")).toBe(true);
  return file.slice(1, -2).split("\r\n");
}

describe("csvCell", () => {
  it("keeps plain text as it is", () => {
    expect(csvCell("Gmina Przykładowa")).toBe("Gmina Przykładowa");
    expect(csvCell("")).toBe("");
    expect(csvCell("a,b")).toBe("a,b");
  });

  it("makes a cell a spreadsheet would run as a formula plain text with a leading '", () => {
    expect(csvCell("=1+1")).toBe("'=1+1");
    expect(csvCell("+48 000 000 000")).toBe("'+48 000 000 000");
    expect(csvCell("-5")).toBe("'-5");
    expect(csvCell("@SUM(A1)")).toBe("'@SUM(A1)");
    expect(csvCell("\t=1+1")).toBe("'\t=1+1");
    // A CR needs quotes as well.
    expect(csvCell("\r=1+1")).toBe('"\'\r=1+1"');
    // Only the first character counts.
    expect(csvCell("1=1")).toBe("1=1");
  });

  it("quotes a cell with the separator, a quote or a line break, doubling the quotes", () => {
    expect(csvCell("a;b")).toBe('"a;b"');
    expect(csvCell('Remont „Szkoły” "nr 1"')).toBe('"Remont „Szkoły” ""nr 1"""');
    expect(csvCell("a\r\nb")).toBe('"a\r\nb"');
    expect(csvCell("a\nb")).toBe('"a\nb"');
    expect(csvCell('=HYPERLINK("https://example.invalid";"x")')).toBe(
      '"\'=HYPERLINK(""https://example.invalid"";""x"")"',
    );
  });
});

describe("matchesCsv", () => {
  it("starts with a BOM and the header, `;` between cells, CRLF lines", () => {
    const file = matchesCsv([]);
    expect(file).toBe(`\uFEFF${CSV_HEADER.join(";")}\r\n`);
    expect(lines(file)).toEqual([
      "Tytuł;Zamawiający;Termin składania ofert (czas polski);Data publikacji;" +
        "Wartość szacunkowa;Waluta;Lokalizacja;Kategorie;Kody CPV;Link;Źródło;Ocena",
    ]);
  });

  it("writes one line per offer, in the given order, with every field the source gave", () => {
    const first = offer();
    const second = offer({
      id: "00000000-0000-4000-8000-000000000002",
      title: "Sprzątanie biura",
      categories: ["90910000-9"],
    });
    const rows = lines(
      matchesCsv([
        { offer: first, verdict: "relevant" },
        { offer: second, verdict: "not_relevant" },
      ]),
    ).slice(1);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.split(";")).toEqual([
      "Modernizacja oświetlenia ulicznego",
      "Gmina Przykładowa",
      // 11:00 UTC is 12:00 in Poland in November.
      "2026-11-05 12:00",
      "2026-10-30",
      "125000,50",
      "PLN",
      "Przykładowo, powiat przykładowy, woj. mazowieckie",
      // Two categories, joined with "; " — so the cell is quoted.
      '"Elektryka',
      ' Serwis, naprawy i konserwacja"',
      "45310000-3, 50232000-0",
      first.sourceUrl,
      "Biuletyn Zamówień Publicznych",
      "trafne",
    ]);
    expect(rows[0]).toContain('"Elektryka; Serwis, naprawy i konserwacja"');
    expect(rows[1]?.startsWith("Sprzątanie biura;")).toBe(true);
    expect(rows[1]?.endsWith(";nietrafne")).toBe(true);
  });

  it("leaves what the source did not give empty — never 0 — and an unrated offer's rating empty", () => {
    const [, row] = lines(
      matchesCsv([
        {
          offer: offer({
            deadline: null,
            publishedAt: null,
            estimatedValue: null,
            currency: null,
            location: null,
            categories: [],
          }),
          verdict: null,
        },
      ]),
    );
    expect(row?.split(";")).toEqual([
      "Modernizacja oświetlenia ulicznego",
      "Gmina Przykładowa",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      offer().sourceUrl,
      "Biuletyn Zamówień Publicznych",
      "",
    ]);
  });

  it("uses the published location text when it was not split", () => {
    const [, row] = lines(
      matchesCsv([{ offer: offer({ location: { raw: "teren gminy" } }), verdict: null }]),
    );
    expect(row?.split(";")[6]).toBe("teren gminy");
  });

  it("neutralises formulas in source text: `=1+1` stays text", () => {
    const [, row] = lines(
      matchesCsv([
        {
          offer: offer({ title: "=1+1", issuerName: "@Gmina", location: { raw: "-teren" } }),
          verdict: null,
        },
      ]),
    );
    const cells = row?.split(";") ?? [];
    expect(cells[0]).toBe("'=1+1");
    expect(cells[1]).toBe("'@Gmina");
    expect(cells[6]).toBe("'-teren");
  });

  it("quotes a title with the separator, quotes or a line break, so the row keeps its columns", () => {
    const file = matchesCsv([
      { offer: offer({ title: 'Remont; etap "II"\r\nczęść 1' }), verdict: null },
    ]);
    expect(file).toContain('\r\n"Remont; etap ""II""\r\nczęść 1";Gmina Przykładowa;');
  });

  it("leaves out a link that is not http(s)", () => {
    const [, row] = lines(
      matchesCsv([
        {
          offer: offer({ sourceUrl: "javascript:alert(1)", categories: ["45310000-3"] }),
          verdict: null,
        },
      ]),
    );
    expect(row?.split(";")[9]).toBe("");
  });

  it("gives a Baza Konkurencyjności offer its required attribution", () => {
    const [, row] = lines(
      matchesCsv([
        {
          offer: offer({
            sourceId: "bk",
            sourceUrl: "https://bazakonkurencyjnosci.funduszeeuropejskie.gov.pl/ogloszenia/1",
          }),
          verdict: null,
        },
      ]),
    );
    expect(row).toContain(
      '"Baza Konkurencyjności, Ministerstwo Funduszy i Polityki Regionalnej; ' +
        'pobrano 2026-10-30; dane przetworzone: skrócone i ujednolicone";',
    );
  });

  it("names BZP as the source of a BZP offer and leaves an unknown source empty", () => {
    const cell = (sourceId: string) =>
      lines(
        matchesCsv([{ offer: offer({ sourceId, categories: ["45310000-3"] }), verdict: null }]),
      )[1]?.split(";")[10];
    expect(cell("bzp")).toBe("Biuletyn Zamówień Publicznych");
    expect(cell("inne")).toBe("");
  });
});
