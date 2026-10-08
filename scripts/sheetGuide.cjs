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
  ["title","[MASTER] Tour Dates: how this spreadsheet works"],
  ["note","Everything for booking Jayme's roster lives here: confirmed shows, offers and inquiries for each artist, interested venues that haven't picked an artist yet, and routing ideas. Much of it updates itself from email and from signed contracts. This page explains what each tab is, what fills it in, and how to use it well."],
  ["blank"],
  ["bar","THE TABS"],
  ["row","Master","Every confirmed show, one row each. Contract Engine adds a row here automatically when a venue signs. This is the record of what is booked. Keep its columns exactly as they are."],
  ["row","Leads","Venues interested in the roster where no specific artist has come up yet. Grouped by region, rebuilt every 15 minutes from email. See \"Using Leads\" below."],
  ["row","Routing","For every date on an artist's calendar, the interested venues within about 150 miles and the open days around it. Rebuilt every 15 minutes. See \"Using Routing\" below."],
  ["row","<Artist> 2027 Workbook","One per artist. A row for every day of 2027 (Date, Status, Venue, City, State, Fee, Notes), then an \"INTERESTED VENUES — NO DATE YET\" section at the bottom. This is where each artist's year takes shape. Type here freely."],
  ["row","<Artist> (no year)","Each artist's confirmed shows, pulled from Master by formula. Don't edit these; edit Master instead."],
  ["row","Djékady, Biribá Union, Kavita Shah","Inactive or former artists, kept for their existing dates. Not updated automatically."],
  ["blank"],
  ["bar","STATUSES"],
  ["swatch","Confirmed","Contracted or agreed. Shows from Master appear on the workbook with the note \"✓ Confirmed in Master\".",C(...G)],
  ["row","Hold","A date is being held for this venue but not yet agreed."],
  ["row","Inquiry","The venue asked about a date, or we offered one."],
  ["row","Prospective","Interested, no date yet. Usually in the bottom section of a workbook."],
  ["blank"],
  ["bar","WHO FILLS IN WHAT"],
  ["row","You","Anything on the artist workbooks: add, edit, move or delete rows. Nothing automatic overwrites what you type."],
  ["row","Email (Mailflow)","When a venue replies to a pitch, Mailflow reads the thread and, within about 15–20 minutes, places it: on its date row in the artist's workbook if an artist and a free date are named; in the workbook's \"no date yet\" section if only the artist is named; or on Leads if no artist is named. It only ever fills empty rows, never re-adds a venue that's already there, and skips venues already booked in Master. If the venue writes again, it updates the note on the row it wrote, unless someone has edited that note."],
  ["row","Contracts (Contract Engine)","Every hour, each Confirmed show in Master is copied onto its date row in the artist's workbook. If that day already has the same venue, only the Status changes to Confirmed. A show cancelled in Master is removed from the workbook on the next run."],
  ["row","Artists","Through their own files (see \"What artists see\"). Their availability and notes appear in your workbook in the last three columns."],
  ["blank"],
  ["bar","USING ROUTING"],
  ["note","Each colored bar is one stop on an artist's calendar (shows a few days and ~100 miles apart are grouped into one run). The bar shows the artist, dates, venue and status, city, and \"Open nearby\": free days within three days either side. Under it are the interested venues nearby, closest and most relevant first."],
  ["row","Look for","Venues marked \"If routing nearby\" in bold green. They asked to hear when an artist is in their area. Pitch them one of the open days on the bar."],
  ["row","Each artist","Has their own bar color, so you can see where one artist's dates end and the next begin."],
  ["blank"],
  ["bar","USING LEADS"],
  ["note","Leads are grouped by region, each a colored block with a summary bar (e.g. MIDWEST · 46 venues · 11 if routing nearby). Within a region, \"If routing nearby\" comes first."],
  ["swatch","If routing nearby","Interested only if an artist tours their way.",C(0.8,0.92,0.8)],
  ["swatch","Date on the table","A specific date has come up.",C(0.8,0.88,0.98)],
  ["swatch","Talk later","Asked to reconnect at a certain time (e.g. \"in January\").",C(0.99,0.92,0.75)],
  ["swatch","General roster interest","Liked the roster, nothing specific yet.",C(0.93,0.93,0.93)],
  ["row","Near a booked date","The nearest dates already on any artist's calendar. ✓ in green = confirmed show. ○ in grey = prospective (inquiry or hold). A green chip next to a ✓ date is the strongest lead."],
  ["row","Bring into","Column K. Pick an artist and, within 15 minutes, the lead moves into that artist's workbook (onto its date if it has one) and leaves Leads."],
  ["row","Email","Opens the original email thread in the right mailbox."],
  ["note","Don't type anywhere else on Leads or Routing. Both are rebuilt every 15 minutes and anything typed there is lost. Notes belong on the artist workbooks."],
  ["blank"],
  ["bar","WHAT ARTISTS SEE"],
  ["note","Each artist has their own file, \"<Artist> / Tour Dates\", in their Artist Resources folder. They only ever see their own."],
  ["row","Confirmed Dates","Their confirmed shows, from Master. Read-only."],
  ["row","Offers & Inquiries","A live copy of their 2027 Workbook, same colors. Read-only, plus three columns of their own:"],
  ["swatch","Availability: Unavailable","A day they can't play. Greyed out and struck through, here and in your workbook, and never suggested as an open day on Routing.",C(0.85,0.85,0.85)],
  ["swatch","Availability: Booked (own show)","A show they booked themselves. Lavender. With a city in \"Where\", it becomes a stop on Routing, so nearby venues show up around it.",C(0.85,0.8,0.95)],
  ["row","Artist notes","Anything they want you to know about a date or offer."],
  ["note","Their three columns appear in your workbook as \"Artist availability\", \"Where (artist)\" and \"Artist notes\" (columns H–J)."],
  ["blank"],
  ["bar","A GOOD ROUTINE"],
  ["row","1. Routing","Scan the bars for green \"If routing nearby\" venues and open days. Pitch those dates."],
  ["row","2. Leads","Skim each region for green chips with a ✓ nearby date. Use Bring into when a lead belongs with an artist."],
  ["row","3. Workbooks","When a date firms up, put it on its date row (moving it up from \"no date yet\") and set the Status. Check the artist's Availability column before offering a date."],
  ["row","4. Contracts","When terms are agreed, send the agreement through Contract Engine (contracts.jaymestone.com). Once signed, it lands in Master and on the workbook within the hour."],
  ["blank"],
  ["bar","PLEASE DON'T"],
  ["row","Rename tabs","The automation finds tabs by name: \"Master\", \"Leads\", \"Routing\", \"<Artist> 2027 Workbook\"."],
  ["row","Add or move columns","On the workbooks or Master. Rows are fine; columns are matched by position."],
  ["row","Type in Leads or Routing","Except the Bring into dropdown. Everything else is rebuilt every 15 minutes."],
  ["row","Unhide or edit column L on Leads","It holds the IDs that make Bring into work."],
  ["note","New artist, a 2028 workbook, or something not behaving as described here? Ask Jayme, who can have the automation updated."],
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
    if (e[0]==="blank") reqs.push({updateDimensionProperties:{range:{sheetId:sid,dimension:"ROWS",startIndex:i,endIndex:i+1},properties:{pixelSize:12},fields:"pixelSize"}});
  });
  await sheets.spreadsheets.batchUpdate({spreadsheetId:MASTER,requestBody:{requests:reqs}});
  console.log("guide written:",S.length,"rows, sheetId",sid);
})().catch(e=>console.error("ERR",e.message));
