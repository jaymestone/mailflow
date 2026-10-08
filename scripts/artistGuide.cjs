// Puts a "Start here" guide tab at the front of each artist's
// "<Artist> / Tour Dates" file: how to read Confirmed Dates and Offers &
// Inquiries, and how to add blackout dates and shows they booked
// themselves. Locked so only Jayme and Anya can edit it.
//   node scripts/artistGuide.cjs
const { sheets } = require("./sheetGoogle.cjs");

const FILES = {
  "The Little Mercies": "1zsQW0WO3_xkMfCz6Lhgya5pa0hOAmtRNOOy7sNAtB_w",
  Rakish: "1LJOOpCNRn4m4rMWVj1MXoiTBdQSzX76D7pb9RC6M7n8",
  "Amanda Pascali": "1Xy86N5ct-dD4BGOGsug3hmRfrv39LRmqAGDWveRUuSE",
  "Sam Reider": "1ruGBXfqIM20rBhd4fIIAjG57L-J1s2Be2rlJelaPSD8",
  "Jorge Glem & Sam Reider": "194eQFDZcG1gWUa7IzLxn9MgsuJKERK8ddkcxgC6C3rk",
  "Lily Henley": "1MSEUF4L6dINI5q4TsFSEY_03PATPLFoqS9b82UzdjXk",
  "Samir Langus": "1_1FTIj6TE14KSjKK4-_j0I4m3UdGv-9JWg_cykLsRDc",
  "Charlie & The Tropicales": "1LD-coW8p4JmgRmg0M6KiZftwy56VBQug3tbc37uBouM",
  "Summer Camargo": "1BK1K2iPX_N7WN5MpSoVdOzJs-ATfMuefvztW9PTuuBM",
};
const TITLE = "Start here";
const C = (r, g, b) => ({ red: r, green: g, blue: b });

const content = (artist) => [
  ["title", `${artist}: your tour dates`],
  ["note", "This file stays up to date from Jayme's booking sheet. You'll find two tabs, plus three columns that are yours to fill in."],
  ["blank"],
  ["bar", "CONFIRMED DATES"],
  ["row", "What it is", "Every show that's contracted, with venue, fee, schedule and contacts."],
  ["swatch", "Green", "Upcoming show.", C(0.718, 0.882, 0.804)],
  ["swatch", "Faded grey", "Already happened.", C(0.97, 0.97, 0.97)],
  ["row", "Editing", "Read-only. If something looks wrong, let Jayme know."],
  ["blank"],
  ["bar", "OFFERS & INQUIRIES"],
  ["row", "What it is", "Your 2027 calendar, one row per day, followed by a list of venues that don't have a date yet. These are possibilities in progress, and many of them won't pan out. Nothing here is booked until it says Confirmed."],
  ["swatch", "Confirmed", "Booked.", C(0.718, 0.882, 0.804)],
  ["row", "Hold", "Interest has been expressed and the date is being held. There may or may not be an official offer yet."],
  ["row", "Inquiry", "Interest has been expressed. For now it's an exploration or a conversation."],
  ["row", "Prospective", "Jayme has identified it as a possibility. No interest in a date has been expressed yet."],
  ["blank"],
  ["bar", "YOUR THREE COLUMNS (H, I, J ON OFFERS & INQUIRIES)"],
  ["swatch", "Availability: Unavailable", "A day you can't play. The row turns grey and Jayme won't offer it.", C(0.85, 0.85, 0.85)],
  ["swatch", "Availability: Booked (own show)", "A pre-existing show, booked before we started working together. The row turns lavender, and Jayme can look for dates nearby.", C(0.85, 0.8, 0.95)],
  ["row", "Where (city, state)", "For your own shows, e.g. Asheville, NC."],
  ["row", "Artist notes", "Anything Jayme should know: the venue of your own show, travel limits, a preference about an offer."],
  ["blank"],
  ["bar", "HOW TO ADD DATES"],
  ["row", "A blackout date", "Go to Offers & Inquiries, find the date, and choose Unavailable in the Availability column. For a run of days, mark each day."],
  ["row", "A pre-existing show", "Find the date, choose Booked (own show), type the city and state under Where, and the venue under Artist notes."],
  ["row", "Outside 2027", "This calendar covers 2027. We'll add a 2028 tab once offers come in. Until then, email any other dates to Jayme."],
  ["row", "Everything else", "Columns A to G are filled in by Jayme's sheet and are locked. Your changes show up for Jayme right away."],
  ["blank"],
  ["note", "Questions? Email Jayme at jayme@jaymestone.com."],
];

async function build(artist, id) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId: id, fields: "sheets(properties(title,sheetId),protectedRanges(protectedRangeId))" });
  let tab = meta.data.sheets.find((s) => s.properties.title === TITLE);
  let sid = tab?.properties.sheetId;
  if (sid === undefined) {
    const r = await sheets.spreadsheets.batchUpdate({ spreadsheetId: id, requestBody: { requests: [{ addSheet: { properties: { title: TITLE, index: 0, gridProperties: { rowCount: 60, columnCount: 3, hideGridlines: true } } } }] } });
    sid = r.data.replies[0].addSheet.properties.sheetId;
  }
  const S = content(artist);
  const values = S.map((e) => (e[0] === "row" || e[0] === "swatch" ? [e[1], e[2]] : e[0] === "blank" ? [""] : [e[1]]));
  await sheets.spreadsheets.values.clear({ spreadsheetId: id, range: `'${TITLE}'!A1:C60` });
  await sheets.spreadsheets.values.update({ spreadsheetId: id, range: `'${TITLE}'!A1`, valueInputOption: "RAW", requestBody: { values } });
  const rr = (i, c0 = 0, c1 = 2) => ({ sheetId: sid, startRowIndex: i, endRowIndex: i + 1, startColumnIndex: c0, endColumnIndex: c1 });
  const all = { sheetId: sid, startRowIndex: 0, endRowIndex: 60, startColumnIndex: 0, endColumnIndex: 3 };
  const reqs = [
    ...((tab && tab.protectedRanges) || []).map((p) => ({ deleteProtectedRange: { protectedRangeId: p.protectedRangeId } })),
    { unmergeCells: { range: all } },
    { repeatCell: { range: all, cell: { userEnteredFormat: { wrapStrategy: "WRAP", verticalAlignment: "TOP", padding: { top: 4, bottom: 4, left: 8, right: 8 }, textFormat: { fontFamily: "Arial", fontSize: 10 } } }, fields: "userEnteredFormat" } },
    { updateDimensionProperties: { range: { sheetId: sid, dimension: "COLUMNS", startIndex: 0, endIndex: 1 }, properties: { pixelSize: 250 }, fields: "pixelSize" } },
    { updateDimensionProperties: { range: { sheetId: sid, dimension: "COLUMNS", startIndex: 1, endIndex: 2 }, properties: { pixelSize: 680 }, fields: "pixelSize" } },
    { updateSheetProperties: { properties: { sheetId: sid, index: 0, gridProperties: { hideGridlines: true } }, fields: "index,gridProperties.hideGridlines" } },
  ];
  S.forEach((e, i) => {
    if (e[0] === "title") reqs.push({ mergeCells: { range: rr(i), mergeType: "MERGE_ALL" } }, { repeatCell: { range: rr(i), cell: { userEnteredFormat: { textFormat: { bold: true, fontSize: 16, foregroundColor: C(0.11, 0.27, 0.53) }, padding: { top: 10, bottom: 6, left: 8, right: 8 } } }, fields: "userEnteredFormat(textFormat,padding)" } });
    if (e[0] === "note") reqs.push({ mergeCells: { range: rr(i), mergeType: "MERGE_ALL" } }, { repeatCell: { range: rr(i), cell: { userEnteredFormat: { textFormat: { fontSize: 10, foregroundColor: C(0.25, 0.25, 0.25) } } }, fields: "userEnteredFormat.textFormat" } });
    if (e[0] === "bar") reqs.push({ mergeCells: { range: rr(i), mergeType: "MERGE_ALL" } }, { repeatCell: { range: rr(i), cell: { userEnteredFormat: { backgroundColor: C(0.11, 0.27, 0.53), textFormat: { bold: true, fontSize: 11, foregroundColor: C(1, 1, 1) }, padding: { top: 6, bottom: 6, left: 8, right: 8 }, verticalAlignment: "MIDDLE" } }, fields: "userEnteredFormat(backgroundColor,textFormat,padding,verticalAlignment)" } });
    if (e[0] === "row" || e[0] === "swatch")
      reqs.push(
        { repeatCell: { range: rr(i, 0, 1), cell: { userEnteredFormat: { textFormat: { bold: true, fontSize: 10 }, ...(e[0] === "swatch" ? { backgroundColor: e[3] } : {}) } }, fields: "userEnteredFormat(textFormat" + (e[0] === "swatch" ? ",backgroundColor)" : ")") } },
        { updateBorders: { range: rr(i), bottom: { style: "SOLID", color: C(0.88, 0.88, 0.88) } } },
      );
  });
  reqs.push({ autoResizeDimensions: { dimensions: { sheetId: sid, dimension: "ROWS", startIndex: 0, endIndex: 60 } } });
  S.forEach((e, i) => { if (e[0] === "blank") reqs.push({ updateDimensionProperties: { range: { sheetId: sid, dimension: "ROWS", startIndex: i, endIndex: i + 1 }, properties: { pixelSize: 12 }, fields: "pixelSize" } }); });
  reqs.push({ addProtectedRange: { protectedRange: { range: { sheetId: sid }, description: "Guide -- edited by Jayme", editors: { users: ["jayme@jaymestone.com", "admin@jaymestone.com"] } } } });
  await sheets.spreadsheets.batchUpdate({ spreadsheetId: id, requestBody: { requests: reqs } });
}

(async () => {
  for (const [artist, id] of Object.entries(FILES)) {
    await build(artist, id);
    console.log(artist, "done");
    await new Promise((r) => setTimeout(r, 2500));
  }
})().catch((e) => {
  console.error("ERR", e.message);
  process.exit(1);
});
