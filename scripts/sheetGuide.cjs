// Builds the "How this works" tab at the front of [MASTER] Tour Dates: a
// guide for Jayme's assistant or anyone helping with booking. Re-run after
// changing how the sheet automation behaves, so the guide stays true.
//   node scripts/sheetGuide.cjs
// Uses Contract Engine's Google credentials (jayme@jaymestone.com).
const {sheets,MASTER}=require("./sheetGoogle.cjs");
const TITLE="How this works";
// Each entry: ["bar", text] section header | ["h", text] sub-heading | ["row", label, text] | ["note", text] | ["swatch", label, text, color, extra]
const G=[0.718,0.882,0.804];
const C=(r,g,b)=>({red:r,green:g,blue:b});
const S=[
  ["title","How this spreadsheet works"],
  ["note","All booking for the roster in one place. Much of it fills itself in from email and signed contracts."],
  ["blank"],
  ["bar","QUICK START"],
  ["row","1. Routing","Find open days near booked shows. Pitch the venues marked \"If routing nearby\" in green."],
  ["row","2. Leads","Green chip + ✓ date nearby = strongest lead. \"Bring into\" (column K) sends a lead to an artist's workbook."],
  ["row","3. Workbooks","When a date firms up, put it on its date row and set the Status. Check the artist's Availability first."],
  ["row","4. Contracts","Send agreements through contracts.jaymestone.com. Signed ones reach Master and the workbook within the hour."],
  ["blank"],
  ["bar","THE TABS"],
  ["row","Master","Every confirmed show. Signed contracts land here automatically. Don't change its columns."],
  ["row","<Artist> 2027 Workbook","Each artist's year: one row per day, then \"no date yet\" at the bottom. Type here freely."],
  ["row","<Artist>","That artist's confirmed shows, pulled from Master. Past shows are faded. Edit Master, not these."],
  ["row","Leads","Interested venues with no artist yet, grouped by region. Rebuilt every 15 minutes."],
  ["row","Routing","Interested venues near each booked date, with the open days around it. Rebuilt every 15 minutes."],
  ["row","Djékady · Biribá Union · Kavita Shah","Former or inactive artists. Not updated."],
  ["blank"],
  ["bar","WHAT FILLS ITSELF IN"],
  ["row","Email replies","Within about 20 minutes, a reply lands on the artist's date row (artist and free date named), in \"no date yet\" (artist only), or on Leads (no artist). Only empty rows, never a duplicate, never a venue already booked in Master. If the venue writes again, its note updates, unless someone has edited it."],
  ["row","Signed contracts","Hourly, confirmed shows in Master appear on the workbook, marked \"✓ Confirmed in Master\". Cancelled in Master = removed."],
  ["row","Artists","Their availability and notes appear in your workbook, columns H–J."],
  ["row","You","Anything you type on a workbook is never overwritten."],
  ["blank"],
  ["bar","COLORS AND SYMBOLS"],
  ["swatch","Confirmed","Booked.",C(...G)],
  ["row","Hold","Interest expressed and the date is held. There may or may not be an official offer yet."],
  ["row","Inquiry","Interest expressed. Still an exploration or conversation. Leads filled in from email start here."],
  ["row","Prospective","A possibility Jayme has identified. No interest in a date expressed yet. Set by hand only."],
  ["swatch","Faded","The show already happened (Master and the artist tabs).",C(0.97,0.97,0.97)],
  ["swatch","If routing nearby","Only interested if an artist is in their area.",C(0.8,0.92,0.8)],
  ["swatch","Date on the table","A specific date has come up.",C(0.8,0.88,0.98)],
  ["swatch","Talk later","Reconnect at a set time, e.g. January.",C(0.99,0.92,0.75)],
  ["swatch","General roster interest","Liked the roster, nothing specific.",C(0.93,0.93,0.93)],
  ["row","✓  /  ○","In \"Near a booked date\": a confirmed / prospective show within ~150 miles."],
  ["swatch","Unavailable","An artist can't play that day. Never offered as an open day.",C(0.85,0.85,0.85)],
  ["swatch","Booked (own show)","An artist booked it themselves. Counts as a stop on Routing.",C(0.85,0.8,0.95)],
  ["row","Routing bar colors","One per artist."],
  ["blank"],
  ["bar","WHAT ARTISTS SEE"],
  ["row","Their own file only","\"<Artist> / Tour Dates\" in their Artist Resources folder."],
  ["row","Confirmed Dates","Their confirmed shows. Read-only."],
  ["row","Offers & Inquiries","A live copy of their workbook, read-only, plus three columns they fill in: Availability, Where, Artist notes."],
  ["blank"],
  ["bar","PLEASE DON'T"],
  ["row","Rename tabs, add or move columns","The automation finds them by name and position."],
  ["row","Type on Leads or Routing","They're rebuilt every 15 minutes. Only \"Bring into\" is safe."],
  ["row","Touch column L on Leads","It's hidden and makes \"Bring into\" work."],
  ["note","New artist, 2028 workbooks, or something not working as described? Ask Jayme."],
];
(async()=>{
  const meta=await sheets.spreadsheets.get({spreadsheetId:MASTER,fields:"sheets.properties(title,sheetId)"});
  let sid=(meta.data.sheets.find(s=>s.properties.title===TITLE)||{}).properties?.sheetId;
  if (sid===undefined) {
    const r=await sheets.spreadsheets.batchUpdate({spreadsheetId:MASTER,requestBody:{requests:[{addSheet:{properties:{title:TITLE,index:0,gridProperties:{rowCount:150,columnCount:4,hideGridlines:true}}}}]}});
    sid=r.data.replies[0].addSheet.properties.sheetId;
  }
  const values=S.map(e=>e[0]==="row"||e[0]==="swatch"?[e[1],e[2]]:e[0]==="blank"?[""]:[e[1]]);
  await sheets.spreadsheets.values.clear({spreadsheetId:MASTER,range:`'${TITLE}'!A1:D200`});
  await sheets.spreadsheets.values.update({spreadsheetId:MASTER,range:`'${TITLE}'!A1`,valueInputOption:"RAW",requestBody:{values}});
  const rr=(i,c0=0,c1=2)=>({sheetId:sid,startRowIndex:i,endRowIndex:i+1,startColumnIndex:c0,endColumnIndex:c1});
  const reqs=[
    {unmergeCells:{range:{sheetId:sid,startRowIndex:0,endRowIndex:200,startColumnIndex:0,endColumnIndex:4}}},
    {repeatCell:{range:{sheetId:sid,startRowIndex:0,endRowIndex:200,startColumnIndex:0,endColumnIndex:4},cell:{userEnteredFormat:{wrapStrategy:"WRAP",verticalAlignment:"TOP",padding:{top:4,bottom:4,left:8,right:8},textFormat:{fontFamily:"Arial",fontSize:10}}},fields:"userEnteredFormat"}},
    {updateDimensionProperties:{range:{sheetId:sid,dimension:"COLUMNS",startIndex:0,endIndex:1},properties:{pixelSize:240},fields:"pixelSize"}},
    {updateDimensionProperties:{range:{sheetId:sid,dimension:"COLUMNS",startIndex:1,endIndex:2},properties:{pixelSize:760},fields:"pixelSize"}},
    {updateSheetProperties:{properties:{sheetId:sid,index:0,gridProperties:{hideGridlines:true,frozenRowCount:0}},fields:"index,gridProperties.hideGridlines,gridProperties.frozenRowCount"}},
  ];
  S.forEach((e,i)=>{
    if (e[0]==="title") reqs.push({mergeCells:{range:rr(i),mergeType:"MERGE_ALL"}},{repeatCell:{range:rr(i),cell:{userEnteredFormat:{textFormat:{bold:true,fontSize:16,foregroundColor:C(0.11,0.27,0.53)},padding:{top:10,bottom:6,left:8,right:8}}},fields:"userEnteredFormat(textFormat,padding)"}});
    if (e[0]==="note") reqs.push({mergeCells:{range:rr(i),mergeType:"MERGE_ALL"}},{repeatCell:{range:rr(i),cell:{userEnteredFormat:{textFormat:{fontSize:10,italic:i>2,foregroundColor:C(0.25,0.25,0.25)},wrapStrategy:"WRAP"}},fields:"userEnteredFormat(textFormat,wrapStrategy)"}});
    if (e[0]==="bar") reqs.push({mergeCells:{range:rr(i),mergeType:"MERGE_ALL"}},{repeatCell:{range:rr(i),cell:{userEnteredFormat:{backgroundColor:C(0.11,0.27,0.53),textFormat:{bold:true,fontSize:11,foregroundColor:C(1,1,1)},padding:{top:6,bottom:6,left:8,right:8},verticalAlignment:"MIDDLE"}},fields:"userEnteredFormat(backgroundColor,textFormat,padding,verticalAlignment)"}});
    if (e[0]==="row"||e[0]==="swatch") reqs.push({repeatCell:{range:rr(i,0,1),cell:{userEnteredFormat:{textFormat:{bold:true,fontSize:10},...(e[0]==="swatch"?{backgroundColor:e[3]}:{})}},fields:"userEnteredFormat(textFormat"+(e[0]==="swatch"?",backgroundColor)":")")}},{updateBorders:{range:rr(i),bottom:{style:"SOLID",color:C(0.88,0.88,0.88)}}});
  });
  // Row heights fit this version's text; only its own spacer rows are short.
  reqs.push({autoResizeDimensions:{dimensions:{sheetId:sid,dimension:"ROWS",startIndex:0,endIndex:200}}});
  S.forEach((e,i)=>{ if (e[0]==="blank") reqs.push({updateDimensionProperties:{range:{sheetId:sid,dimension:"ROWS",startIndex:i,endIndex:i+1},properties:{pixelSize:12},fields:"pixelSize"}}); });
  await sheets.spreadsheets.batchUpdate({spreadsheetId:MASTER,requestBody:{requests:reqs}});
  console.log("guide written:",S.length,"rows, sheetId",sid);
})().catch(e=>console.error("ERR",e.message));
