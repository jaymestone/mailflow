/**
 * Venue Choices for [MASTER] Tour Dates (Jayme, Nov 19 2026).
 *
 * On any "<Artist> <year> Workbook" day row, pick a venue in the Venue Name
 * dropdown (column C) and this fills Status, City, State, Fee and Notes with
 * that venue's offer, so you can compare the options one by one. Whatever
 * was showing is saved first, so picking it again brings it back exactly.
 * Typing a venue that isn't in the list leaves the row alone.
 *
 * Mailflow keeps the hidden "Venue Choices" tab up to date; this script keeps
 * what you switch away from in the hidden "Venue Choices (kept)" tab.
 *
 * Install once: Extensions > Apps Script, paste this over everything, Save.
 */
var CHOICES = 'Venue Choices';
var KEPT = 'Venue Choices (kept)';

function onEdit(e) {
  if (!e || !e.range || e.range.getNumRows() !== 1 || e.range.getNumColumns() !== 1 || e.range.getColumn() !== 3) return;
  var sh = e.range.getSheet();
  var tab = sh.getName();
  if (!/ \d{4} Workbook$/.test(tab)) return;
  var row = e.range.getRow();
  var a = sh.getRange(row, 1).getValue();
  if (!(a instanceof Date) && !(typeof a === "number" && a > 40000)) return; // day rows only
  var picked = String(e.value == null ? '' : e.value).trim();
  var before = String(e.oldValue == null ? '' : e.oldValue).trim();
  if (!picked || picked === before) return;

  var ss = e.source;
  var kept = ss.getSheetByName(KEPT);
  if (!kept) {
    kept = ss.insertSheet(KEPT);
    kept.appendRow(['Tab', 'Row', 'Venue', 'Status', 'City', 'State', 'Fee', 'Notes']);
    kept.hideSheet();
  }
  var rec = takeKept_(kept, tab, row, picked) || findChoice_(ss.getSheetByName(CHOICES), tab, row, picked);
  if (!rec) return;

  if (before) {
    var cur = sh.getRange(row, 2, 1, 6).getValues()[0]; // B:G as they were
    takeKept_(kept, tab, row, before); // keep one copy only
    kept.appendRow([tab, row, before, cur[0], cur[2], cur[3], cur[4], cur[5]]);
  }
  sh.getRange(row, 2).setValue(rec[3]);
  sh.getRange(row, 4, 1, 4).setValues([[rec[4], rec[5], rec[6], rec[7]]]);
}

function findChoice_(sheet, tab, row, venue) {
  if (!sheet) return null;
  var v = sheet.getDataRange().getValues();
  for (var i = 1; i < v.length; i++) if (v[i][0] === tab && Number(v[i][1]) === row && String(v[i][2]).trim() === venue) return v[i];
  return null;
}

/** Finds a kept row and removes it (it's back on the calendar now). */
function takeKept_(kept, tab, row, venue) {
  var v = kept.getDataRange().getValues();
  for (var i = 1; i < v.length; i++) {
    if (v[i][0] === tab && Number(v[i][1]) === row && String(v[i][2]).trim() === venue) {
      kept.deleteRow(i + 1);
      return v[i];
    }
  }
  return null;
}
