import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  extractNoticeDetails,
  NO_DETAILS,
  type BzpNoticeDetails,
} from "../src/sources/bzp/notice-body.js";

/**
 * Captured, pseudonymised notices (tests/fixtures/bzp/README.md). Edge cases
 * are built from these bodies by replacing one exact piece of markup, so every
 * case keeps the real form layout around it.
 */
const PAGE1 = "contract-notice-2026-10-29-page1.json";
const PAGE2 = "contract-notice-2026-10-29-page2.json";
const SMALL = "small-contract-notice-2026-10-29.json";

const bodiesSchema = z.array(z.object({ noticeNumber: z.string(), htmlBody: z.string() }));

function bodyOf(name: string, noticeNumber: string): string {
  const records = bodiesSchema.parse(
    JSON.parse(readFileSync(new URL(`./fixtures/bzp/${name}`, import.meta.url), "utf8")),
  );
  const record = records.find((r) => r.noticeNumber === noticeNumber);
  if (record === undefined) throw new Error(`no fixture record ${noticeNumber}`);
  return record.htmlBody;
}

/** 2026/BZP 00507107/01: value "181300 PLN", e-mail, no phone. */
const CN_WITH_VALUE = bodyOf(PAGE1, "2026/BZP 00507107/01");
/** 2026/BZP 00507109/01: no value. */
const CN_WITHOUT_VALUE = bodyOf(PAGE1, "2026/BZP 00507109/01");
/** 2026/BZP 00507114/01: e-mail and phone. */
const CN_WITH_PHONE = bodyOf(PAGE2, "2026/BZP 00507114/01");
/** 2026/BZP 00507115/01: description with "2.1 …" lines that are not form labels. */
const CN_NUMBERED_LINES = bodyOf(PAGE2, "2026/BZP 00507115/01");
/** 2026/BZP 00507754/01: value "153812,40" + "Kod waluty" "PLN", e-mail and phone. */
const SCN_WITH_VALUE = bodyOf(SMALL, "2026/BZP 00507754/01");
/** 2026/BZP 00507787/01: "Kod waluty" but no value, e-mail only. */
const SCN_WITHOUT_VALUE = bodyOf(SMALL, "2026/BZP 00507787/01");

/** `body` with `from` (which must occur exactly once) replaced by `to`. */
function replaceOnce(body: string, from: string, to: string): string {
  expect(body.split(from)).toHaveLength(2);
  return body.replace(from, () => to);
}

const CN_EMAIL =
  '1.5.9.) Adres poczty elektronicznej: <span class="normal">kontakt@example.invalid</span>';
const CN_VALUE =
  '4.1.5.) Wartość zamówienia:            <span class="normal">                181300                    PLN            </span>';
const CN_DESCRIPTION_LABEL = "4.2.2.) Krótki opis przedmiotu zamówienia</h3>";
const CN_CPV_LABEL = '<h3 class="mb-0">4.2.6.) Główny kod CPV:';
const SCN_PHONE = '1.4.7.) Numer telefonu: <span class="normal">000 000 000</span>';
const SCN_EMAIL =
  '1.4.9.) Adres poczty elektronicznej: <span class="normal">kontakt@example.invalid</span>';
const SCN_VALUE = '3.4.) Wartość: <span class="normal">153812,40</span>';
const SCN_CURRENCY = '3.5) Kod waluty: <span class="normal">PLN</span>';
const SCN_DESCRIPTION =
  '3.3.) Krótki opis przedmiotu zamówienia: <span class="normal">dostawa środków piorących i dezynfekujących na potrzeby pralni</span>';

const cn = (body: string): BzpNoticeDetails => extractNoticeDetails("ContractNotice", body);
const scn = (body: string): BzpNoticeDetails => extractNoticeDetails("SmallContractNotice", body);

describe("extractNoticeDetails on captured notices", () => {
  it("reads a contract notice with value, e-mail and no phone", () => {
    const details = cn(CN_WITH_VALUE);
    expect(details.estimatedValue).toBe("181300");
    expect(details.currency).toBe("PLN");
    expect(details.contact).toEqual({ email: "kontakt@example.invalid" });
    expect(details.description?.split("\n")).toHaveLength(8);
    expect(details.description).toMatch(/^1\. Przedmiotem zamówienia jest dostawa zabawek/u);
    // The paragraphs end at the next form label (4.2.6.) Główny kod CPV).
    expect(details.description).toMatch(/rodzaju wyrobów\.$/u);
  });

  it("reads a contract notice without value: both value fields stay null", () => {
    const details = cn(CN_WITHOUT_VALUE);
    expect(details.estimatedValue).toBeNull();
    expect(details.currency).toBeNull();
    expect(details.contact).toEqual({ email: "kontakt@example.invalid" });
    expect(details.description).toMatch(/^Przedmiot zamówienia obejmuje wykonanie remontu/u);
    expect(details.description).toMatch(
      /\n14\. Wymiana zniszczonych desek odbojowych przy rampie\.$/u,
    );
  });

  it("reads e-mail and phone of a contract notice", () => {
    expect(cn(CN_WITH_PHONE).contact).toEqual({
      email: "kontakt@example.invalid",
      phone: "000 000 000",
    });
  });

  it("keeps numbered description lines that are not form labels", () => {
    const description = cn(CN_NUMBERED_LINES).description ?? "";
    expect(description).toContain("\n2.1 Projekt połączenia komunikacyjnego");
    expect(description).toContain("\n2.9 Tabele równoważności materiałów\n");
    expect(description).not.toContain("4.2.6.)");
  });

  it("reads a small contract with value, separate currency, e-mail and phone", () => {
    expect(scn(SCN_WITH_VALUE)).toEqual({
      description: "dostawa środków piorących i dezynfekujących na potrzeby pralni",
      contact: { email: "kontakt@example.invalid", phone: "000 000 000" },
      estimatedValue: "153812.40",
      currency: "PLN",
    });
  });

  it("reads a small contract without value: a currency alone is not a value", () => {
    const details = scn(SCN_WITHOUT_VALUE);
    expect(details.estimatedValue).toBeNull();
    expect(details.currency).toBeNull();
    expect(details.contact).toEqual({ email: "kontakt@example.invalid" });
    const lines = details.description?.split("\n") ?? [];
    expect(lines[0]).toBe(
      "1. Przedmiotem Zamówienia jest dostawa elektromechanicznego sprzętu warsztatowego.",
    );
    // Ends before "3.5) Kod waluty:", a label with a single dot.
    expect(lines.at(-1)).toBe("2) Wzorem Umowy- załącznik nr 2 do SIWP;");
  });

  it("never returns markup or entities from any captured notice", () => {
    const all = [
      cn(CN_WITH_VALUE),
      cn(CN_WITHOUT_VALUE),
      cn(CN_WITH_PHONE),
      cn(CN_NUMBERED_LINES),
      scn(SCN_WITH_VALUE),
      scn(SCN_WITHOUT_VALUE),
    ];
    const json = JSON.stringify(all);
    expect(json).not.toMatch(/[<>]|&[a-z]+;|&#/u);
    for (const details of all) expect(details.description).not.toBeNull();
  });

  it("uses the labels of the notice's own type only", () => {
    // A small contract read with contract notice labels finds nothing, and vice versa.
    expect(cn(SCN_WITH_VALUE)).toEqual(NO_DETAILS);
    expect(scn(CN_WITH_VALUE)).toEqual(NO_DETAILS);
  });
});

describe("extractNoticeDetails: description", () => {
  it("is null without the label, or when the label has no text before the next label", () => {
    expect(
      cn(replaceOnce(CN_WITH_VALUE, CN_DESCRIPTION_LABEL, "4.2.2.) Coś innego</h3>")),
    ).toHaveProperty("description", null);
    const empty = replaceOnce(
      SCN_WITH_VALUE,
      SCN_DESCRIPTION,
      '3.3.) Krótki opis przedmiotu zamówienia: <span class="normal"> &nbsp; </span>',
    );
    expect(scn(empty).description).toBeNull();
  });

  it("joins several occurrences (parts) in order, separated by a blank line", () => {
    // As the form lays out parts: each part's 4.2.x labels again, from 4.2.1.).
    const body = replaceOnce(
      CN_WITH_VALUE,
      CN_CPV_LABEL,
      `${CN_CPV_LABEL} 00000000-0</h3><h3 class="mb-0">4.2.1.) Numer części: 2</h3><h3 class="mb-0">${CN_DESCRIPTION_LABEL}<p>Część 2:<br/>  druga   część</p>${CN_CPV_LABEL}`,
    );
    const description = cn(body).description ?? "";
    expect(description).toMatch(/rodzaju wyrobów\.\n\nCzęść 2:\ndruga część$/u);
  });

  it("ends at a section heading", () => {
    const body = replaceOnce(
      SCN_WITH_VALUE,
      SCN_DESCRIPTION,
      `${SCN_DESCRIPTION}<h2>SEKCJA IV – ZAŁĄCZNIKI</h2><p>nie opis</p>`,
    );
    expect(scn(body).description).toBe(
      "dostawa środków piorących i dezynfekujących na potrzeby pralni",
    );
  });

  it("keeps description lines numbered lower than its label (1.1), 1.1.1.), 4.2.1.))", () => {
    const body = replaceOnce(
      CN_WITH_VALUE,
      CN_DESCRIPTION_LABEL,
      `${CN_DESCRIPTION_LABEL}<p>Zakres:<br/>1.1) roboty ziemne<br/>1.2) fundamenty<br/>1.1.1.) wykopy<br/>2.3) instalacje<br/>4.2.1.) etap I</p>`,
    );
    const description = cn(body).description ?? "";
    expect(description).toMatch(
      /^Zakres:\n1\.1\) roboty ziemne\n1\.2\) fundamenty\n1\.1\.1\.\) wykopy\n2\.3\) instalacje\n4\.2\.1\.\) etap I\n1\. Przedmiotem zamówienia/u,
    );
    // Still ends at the real next label, 4.2.6.) Główny kod CPV.
    expect(description).toMatch(/rodzaju wyrobów\.$/u);
  });

  it("keeps 1.1) and 2.1.) lines of a small contract's 3.3.) description", () => {
    const body = replaceOnce(
      SCN_WITH_VALUE,
      SCN_DESCRIPTION,
      `${SCN_DESCRIPTION}<p>1.1) proszki</p><p>2.1.) płyny</p><p>3.2.) dozowniki</p>`,
    );
    expect(scn(body)).toMatchObject({
      description:
        "dostawa środków piorących i dezynfekujących na potrzeby pralni\n1.1) proszki\n2.1.) płyny\n3.2.) dozowniki",
      // Ended at 3.4.) Wartość, which is still read.
      estimatedValue: "153812.40",
      currency: "PLN",
    });
  });

  it.each([
    ["the next label", "4.2.3.) Coś"],
    ["a label compared by number, not text (10 > 2)", "4.2.10.) Okres realizacji"],
    ["a label of a later group", "4.3.) Kryteria oceny ofert"],
    ["a label of a later section", "5.1.) Zamawiający przewiduje"],
    ["a two-digit section", "10.1) Coś"],
    ["a sub-label of the field's label", "4.2.2.1.) Coś"],
  ])("ends at %s", (_case, label) => {
    const body = replaceOnce(
      CN_WITH_VALUE,
      CN_DESCRIPTION_LABEL,
      `${CN_DESCRIPTION_LABEL}<p>Zakres:</p><h3>${label}</h3><p>nie opis</p>`,
    );
    expect(cn(body).description).toBe("Zakres:");
  });

  it("ends at the same label repeated, which starts the next part", () => {
    const body = replaceOnce(
      CN_WITH_VALUE,
      CN_DESCRIPTION_LABEL,
      `${CN_DESCRIPTION_LABEL}<p>Zakres:</p><h3>${CN_DESCRIPTION_LABEL}<p>część 2</p><h3>4.2.6.) Główny kod CPV:</h3>`,
    );
    expect(cn(body).description).toBe("Zakres:\n\nczęść 2");
  });

  it("removes bidi controls, zero-width and C1 control characters from the description", () => {
    const body = replaceOnce(
      SCN_WITH_VALUE,
      SCN_DESCRIPTION,
      '3.3.) Krótki opis przedmiotu zamówienia: <span class="normal">&#x202E;dostawa&#x202C; z&#x200B;est&#x200D;awów &#x2066;IT&#x2069;&#x85;i&#x9F;mebli&#x200F;</span>',
    );
    expect(scn(body).description).toBe("dostawa zestawów IT i mebli");
  });

  it("drops script/style content and comments, decodes entities, removes control characters", () => {
    const body = replaceOnce(
      SCN_WITH_VALUE,
      SCN_DESCRIPTION,
      '3.3.) Krótki opis przedmiotu zamówienia: <span class="normal">Mycie&#7;okien &amp; drzwi<!-- x --><script>alert(1)</script><style>p{}</style></span><p>&#x141;azienki</p>',
    );
    expect(scn(body).description).toBe("Mycie okien & drzwi\nŁazienki");
  });

  it("cuts a description over 10 000 characters at a word boundary with an ellipsis", () => {
    const long = "słowo ".repeat(4_000);
    const body = replaceOnce(
      SCN_WITH_VALUE,
      SCN_DESCRIPTION,
      `3.3.) Krótki opis przedmiotu zamówienia: <span class="normal">${long}</span>`,
    );
    const description = scn(body).description ?? "";
    expect(description.length).toBeLessThanOrEqual(10_000);
    expect(description.length).toBeGreaterThan(9_900);
    expect(description).toMatch(/^(?:słowo )+słowo…$/u);
  });

  it("cuts across parts and lines the same way", () => {
    const paragraph = `<p>${"zdanie opisu. ".repeat(100)}</p>`;
    const body = replaceOnce(
      CN_WITH_VALUE,
      CN_CPV_LABEL,
      `<h3>${CN_DESCRIPTION_LABEL}${paragraph.repeat(20)}${CN_CPV_LABEL}`,
    );
    const description = cn(body).description ?? "";
    expect(description.length).toBeLessThanOrEqual(10_000);
    expect(description).toMatch(/^1\. Przedmiotem zamówienia/u);
    expect(description).toMatch(/\n\nzdanie opisu\./u);
    expect(description).toMatch(/opisu\.…$|zdanie…$/u);
  });

  it("hard-cuts a single word longer than the bound", () => {
    const body = replaceOnce(
      SCN_WITH_VALUE,
      SCN_DESCRIPTION,
      `3.3.) Krótki opis przedmiotu zamówienia: <span class="normal">${"ż".repeat(20_000)}</span>`,
    );
    expect(scn(body).description).toBe(`${"ż".repeat(9_999)}…`);
  });

  it("never splits a surrogate pair when cutting", () => {
    const body = replaceOnce(
      SCN_WITH_VALUE,
      SCN_DESCRIPTION,
      `3.3.) Krótki opis przedmiotu zamówienia: <span class="normal">${"😀".repeat(6_000)}</span>`,
    );
    // 9 999 code units would end in the middle of the 5 000th pair: it is dropped.
    expect(scn(body).description).toBe(`${"😀".repeat(4_999)}…`);
  });

  it("is null when the text cannot be stored (lone surrogate), never a rejection", () => {
    const body = replaceOnce(
      SCN_WITH_VALUE,
      SCN_DESCRIPTION,
      '3.3.) Krótki opis przedmiotu zamówienia: <span class="normal">opis \ud800 zły</span>',
    );
    const details = scn(body);
    expect(details.description).toBeNull();
    expect(details.estimatedValue).toBe("153812.40");
  });
});

describe("extractNoticeDetails: contact", () => {
  it("lower-cases a valid e-mail", () => {
    const body = replaceOnce(
      CN_WITH_VALUE,
      CN_EMAIL,
      '1.5.9.) Adres poczty elektronicznej: <span class="normal"> Kontakt@Example.INVALID </span>',
    );
    expect(cn(body).contact).toEqual({ email: "kontakt@example.invalid" });
  });

  it("keeps an invalid e-mail in contact.raw instead of rejecting the offer", () => {
    const body = replaceOnce(
      SCN_WITH_VALUE,
      SCN_EMAIL,
      '1.4.9.) Adres poczty elektronicznej: <span class="normal">kontakt(at)example.invalid</span>',
    );
    expect(scn(body).contact).toEqual({ phone: "000 000 000", raw: "kontakt(at)example.invalid" });
  });

  it("keeps several e-mails in one field in contact.raw", () => {
    const body = replaceOnce(
      CN_WITH_VALUE,
      CN_EMAIL,
      '1.5.9.) Adres poczty elektronicznej: <span class="normal">a@example.invalid; b@example.invalid</span>',
    );
    expect(cn(body).contact).toEqual({ raw: "a@example.invalid; b@example.invalid" });
  });

  it("keeps a phone over 50 characters in contact.raw, joined after an invalid e-mail", () => {
    const phone = "000 000 000 wew. 1, 000 000 000 wew. 2, 000 000 000 wew. 3";
    let body = replaceOnce(
      SCN_WITH_VALUE,
      SCN_PHONE,
      `1.4.7.) Numer telefonu: <span class="normal">${phone}</span>`,
    );
    body = replaceOnce(
      body,
      SCN_EMAIL,
      '1.4.9.) Adres poczty elektronicznej: <span class="normal">brak</span>',
    );
    expect(phone.length).toBeGreaterThan(50);
    expect(scn(body).contact).toEqual({ raw: `brak; ${phone}` });
  });

  it.each(["-", "brak", "nie dotyczy", "—"])("drops a phone without a digit (%j)", (phone) => {
    const body = replaceOnce(
      SCN_WITH_VALUE,
      SCN_PHONE,
      `1.4.7.) Numer telefonu: <span class="normal">${phone}</span>`,
    );
    expect(scn(body).contact).toEqual({ email: "kontakt@example.invalid" });
    const alone = replaceOnce(body, SCN_EMAIL, "");
    expect(scn(alone).contact).toBeNull();
  });

  it("removes bidi controls and zero-width characters from phone and contact.raw", () => {
    let body = replaceOnce(
      SCN_WITH_VALUE,
      SCN_PHONE,
      '1.4.7.) Numer telefonu: <span class="normal">&#x200E;000&#x200B; 000 000&#x202C;</span>',
    );
    body = replaceOnce(
      body,
      SCN_EMAIL,
      '1.4.9.) Adres poczty elektronicznej: <span class="normal">&#x202E;kontakt(at)&#x2060;example.invalid&#x85;</span>',
    );
    expect(scn(body).contact).toEqual({ phone: "000 000 000", raw: "kontakt(at)example.invalid" });
  });

  it("leaves out a value too long for contact.raw rather than cutting it", () => {
    const body = replaceOnce(
      CN_WITH_VALUE,
      CN_EMAIL,
      `1.5.9.) Adres poczty elektronicznej: <span class="normal">${"x".repeat(501)}</span>`,
    );
    expect(cn(body).contact).toBeNull();
  });

  it("is null when neither e-mail nor phone is published", () => {
    const body = replaceOnce(
      CN_WITH_VALUE,
      CN_EMAIL,
      '1.5.9.) Adres poczty elektronicznej: <span class="normal"></span>',
    );
    expect(cn(body).contact).toBeNull();
    expect(cn(replaceOnce(CN_WITH_VALUE, CN_EMAIL, "")).contact).toBeNull();
  });

  it("reads the first occurrence of each label only", () => {
    const body = replaceOnce(
      CN_WITH_VALUE,
      CN_CPV_LABEL,
      `<h3>1.5.9.) Adres poczty elektronicznej: <span>drugi@example.invalid</span></h3>${CN_CPV_LABEL}`,
    );
    expect(cn(body).contact).toEqual({ email: "kontakt@example.invalid" });
  });

  it("never reads e-mail addresses from the description or other text", () => {
    // 2026/BZP 00507113/01 mentions addresses in its free text; only 1.5.9.) counts.
    const body = bodyOf(PAGE2, "2026/BZP 00507113/01");
    expect(cn(replaceOnce(body, CN_EMAIL, "")).contact).toBeNull();
  });
});

describe("extractNoticeDetails: estimated value", () => {
  function smallValue(value: string, currency: string | null = "PLN"): BzpNoticeDetails {
    let body = replaceOnce(
      SCN_WITH_VALUE,
      SCN_VALUE,
      `3.4.) Wartość: <span class="normal">${value}</span>`,
    );
    body = replaceOnce(
      body,
      SCN_CURRENCY,
      currency === null ? "" : `3.5) Kod waluty: <span class="normal">${currency}</span>`,
    );
    return scn(body);
  }

  it.each([
    ["153812,40", "153812.40"],
    ["153812.40", "153812.40"],
    ["153 812,40", "153812.40"],
    ["153 812,40", "153812.40"],
    ["153&nbsp;812,40", "153812.40"],
    ["153 812,40", "153812.40"],
    ["1 234 567.5", "1234567.5"],
    ["153812", "153812"],
    ["153812,4012", "153812.4012"],
    ["000153812,40", "153812.40"],
    ["0,01", "0.01"],
    ["123456789012345", "123456789012345"],
    ["153812,40 PLN", "153812.40"],
  ])("reads %j as %j", (value, expected) => {
    expect(smallValue(value)).toMatchObject({ estimatedValue: expected, currency: "PLN" });
  });

  it.each([
    ["empty", ""],
    ["a word", "brak"],
    ["a negative amount", "-153812,40"],
    ["an approximation", "ok. 150 000"],
    ["a local currency word", "153812,40 zł"],
    ["an exponent", "1e5"],
    ["a three-digit fraction (may be a thousands separator)", "1.500"],
    ["a three-digit fraction after a comma", "153812,400"],
    ["a five-digit fraction (never rounded)", "153812,40123"],
    ["mixed separators", "153,812.40"],
    ["dots as thousands separators", "1.234.567,00"],
    ["a malformed group", "153 81,40"],
    ["a group after a long head", "1 5000"],
    ["a leading zero group", "0 153 812"],
    ["more than 15 integer digits", "1234567890123456"],
    ["more than 15 grouped digits", "1 234 567 890 123 456"],
    ["two amounts", "100 PLN 200 PLN"],
    ["a range", "100-200"],
    ["a lower-case code", "153812,40 pln"],
    // D-022: BZP forms publish 0 as a placeholder; a missing value is never 0.
    ["zero", "0"],
    ["zero with a fraction", "0,00"],
    ["zero with a four-digit fraction", "0.0000"],
    ["zero with leading zeros", "000"],
    ["zero with a currency code", "0,00 PLN"],
  ])("refuses %s: both null", (_case, value) => {
    expect(smallValue(value)).toMatchObject({ estimatedValue: null, currency: null });
  });

  it("reads a contract notice's value with the code in the same block", () => {
    const value = (text: string) =>
      cn(
        replaceOnce(
          CN_WITH_VALUE,
          CN_VALUE,
          `4.1.5.) Wartość zamówienia: <span class="normal">${text}</span>`,
        ),
      );
    expect(value("181 300,00 PLN")).toMatchObject({ estimatedValue: "181300.00", currency: "PLN" });
    expect(value("181300 EUR")).toMatchObject({ estimatedValue: "181300", currency: "EUR" });
    // A contract notice has no separate currency field: no code → no value.
    expect(value("181300")).toMatchObject({ estimatedValue: null, currency: null });
  });

  it("needs exactly one, unambiguous currency", () => {
    expect(smallValue("153812,40", null)).toMatchObject({ estimatedValue: null, currency: null });
    expect(smallValue("153812,40 PLN", null)).toMatchObject({
      estimatedValue: "153812.40",
      currency: "PLN",
    });
    expect(smallValue("153812,40 EUR", "PLN")).toMatchObject({
      estimatedValue: null,
      currency: null,
    });
    for (const currency of ["pln", "PLN EUR", "złoty", "", "PL"]) {
      expect(smallValue("153812,40", currency), currency).toMatchObject({
        estimatedValue: null,
        currency: null,
      });
    }
    const twice = replaceOnce(SCN_WITH_VALUE, SCN_CURRENCY, `${SCN_CURRENCY}<h3>${SCN_CURRENCY}`);
    expect(scn(twice)).toMatchObject({ estimatedValue: null, currency: null });
  });

  it("refuses a value label published more than once", () => {
    const twice = replaceOnce(
      SCN_WITH_VALUE,
      SCN_VALUE,
      `${SCN_VALUE}<h3>3.4.) Wartość: <span>153812,40</span>`,
    );
    expect(scn(twice)).toMatchObject({ estimatedValue: null, currency: null });
    const cnTwice = replaceOnce(CN_WITH_VALUE, CN_VALUE, `${CN_VALUE}<h3>${CN_VALUE}`);
    expect(cn(cnTwice)).toMatchObject({ estimatedValue: null, currency: null });
  });

  it("refuses an overlong value block", () => {
    const overlong = replaceOnce(
      SCN_WITH_VALUE,
      SCN_VALUE,
      `3.4.) Wartość: <span class="normal">${"1".repeat(200)}</span>`,
    );
    expect(scn(overlong)).toMatchObject({ estimatedValue: null, currency: null });
  });
});

describe("extractNoticeDetails: unreadable and hostile bodies", () => {
  it("gives no details for an unclosed tag, comment or script, never a partial read", () => {
    for (const suffix of ["<h3", "<!-- unclosed", "<script>x", "<style>"]) {
      expect(cn(`${CN_WITH_VALUE}${suffix}`), suffix).toEqual(NO_DETAILS);
      expect(scn(`${SCN_WITH_VALUE}${suffix}`), suffix).toEqual(NO_DETAILS);
    }
  });

  it("gives no details for an empty or label-less body", () => {
    expect(cn("")).toEqual(NO_DETAILS);
    expect(scn("zwykły tekst bez etykiet")).toEqual(NO_DETAILS);
  });

  function hostileBodies(length: number): [string, string][] {
    const patterns: [string, string][] = [
      ["'<' repeated", "<"],
      ["nested tags", "<b><i><span>"],
      ["unclosed comments", "<!--"],
      ["entity starts", "&#1"],
      ["description labels", `<h3>${CN_DESCRIPTION_LABEL}<p>tekst opisu</p>`],
      ["value labels", `<h3>${CN_VALUE}</h3>`],
      ["e-mail labels", `<h3>${CN_EMAIL}</h3>`],
      ["empty labels", "<h3>4.2.2.) Krótki opis przedmiotu zamówienia</h3>"],
      ["numbered lines", "<p>1.1.1.) x</p>"],
      ["combining marks in one element", "̖́"],
    ];
    // Whole repetitions padded with spaces: a repeated well-formed pattern stays
    // well-formed, so the whole body is scanned and every label is seen.
    return patterns.map(([name, pattern]) => {
      const count = Math.floor(length / pattern.length);
      return [name, pattern.repeat(count) + " ".repeat(length - count * pattern.length)];
    });
  }

  // The adapter's bound (MAX_HTML_BODY_LENGTH); a quadratic pass would take minutes.
  it.each(hostileBodies(1_000_000))(
    "handles 1 000 000 characters of %s in linear time",
    (_case, html) => {
      expect(html).toHaveLength(1_000_000);
      const started = performance.now();
      const details = cn(html);
      const small = scn(html);
      expect(performance.now() - started).toBeLessThan(2_000);
      expect(details.description?.length ?? 0).toBeLessThanOrEqual(10_000);
      expect(small.description?.length ?? 0).toBeLessThanOrEqual(10_000);
      expect(JSON.stringify([details, small])).not.toContain("<");
    },
  );

  it("bounds a description field of a million combining marks", () => {
    const html = `<h3>${CN_DESCRIPTION_LABEL}<p>${"\u0316\u0301".repeat(499_980)}</p>`;
    const started = performance.now();
    const description = cn(html).description ?? "";
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(description).toHaveLength(10_000);
    expect(description.endsWith("…")).toBe(true);
  });

  it("bounds a description of a million repeated labels", () => {
    const [, html = ""] = hostileBodies(1_000_000)[4] ?? [];
    const description = cn(html).description ?? "";
    expect(description.length).toBeLessThanOrEqual(10_000);
    expect(description).toMatch(/^tekst opisu\n\ntekst opisu\n\n/u);
    expect(description.endsWith("…")).toBe(true);
  });

  it("refuses a million repeated value labels and reads the first of a million e-mail labels", () => {
    const bodies = hostileBodies(1_000_000);
    expect(cn(bodies[5]?.[1] ?? "")).toMatchObject({ estimatedValue: null, currency: null });
    // Whatever the last (cut) repetition holds, the first label is read.
    expect(cn(bodies[6]?.[1] ?? "").contact).toEqual({ email: "kontakt@example.invalid" });
  });
});
