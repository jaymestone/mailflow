/**
 * Venue Choices v2 for [MASTER] Tour Dates (Jayme, Nov 19 2026).
 *
 * On any "<Artist> <year> Workbook" day row, pick a venue in the Venue Name
 * dropdown (column C) and this fills Status, City, State, Fee and Notes with
 * that venue's offer. Whatever was showing is saved first, so picking it
 * again brings it back exactly. Typing a venue that isn't an option leaves
 * the row alone.
 *
 * v2: remembers which venue each row is showing (hidden "Venue Choices
 * (showing)" tab) instead of trusting Google's old value, and handles one
 * switch at a time, so quick back-and-forth picks can't leave a venue next
 * to another venue's city. Mailflow also checks every 15 minutes and refills
 * any row whose city belongs to a different option.
 *
 * Install: Extensions > Apps Script, select everything, paste this, Save.
 */
var CHOICES = 'Venue Choices';
var KEPT = 'Venue Choices (kept)';
var SHOWING = 'Venue Choices (showing)';
var HEAD = ['Tab', 'Row', 'Venue', 'Status', 'City', 'State', 'Fee', 'Notes'];

function onEdit(e) {
  if (!e || !e.range || e.range.getNumRows() !== 1 || e.range.getNumColumns() !== 1 || e.range.getColumn() !== 3) return;
  var sh = e.range.getSheet();
  var tab = sh.getName();
  if (!/ \d{4} Workbook$/.test(tab)) return;
  var row = e.range.getRow();
  var a = sh.getRange(row, 1).getValue();
  if (!(a instanceof Date) && !(typeof a === 'number' && a > 40000)) return; // day rows only

  var lock = LockService.getDocumentLock();
  if (!lock.tryLock(20000)) return;
  try {
    var ss = e.source;
    var picked = String(sh.getRange(row, 3).getValue()).trim(); // what the cell says now
    var kept = tabOf_(ss, KEPT, HEAD);
    var showing = tabOf_(ss, SHOWING, ['Tab', 'Row', 'Venue']);
    var shown = showingFor_(showing, tab, row);
    if (shown === null) shown = String(e.oldValue == null ? '' : e.oldValue).trim();
    if (!picked || picked === shown) return;

    var rec = takeKept_(kept, tab, row, picked) || findChoice_(ss.getSheetByName(CHOICES), tab, row, picked);
    if (!rec) return; // not an option for this day: his own edit, leave it

    if (shown) {
      var cur = sh.getRange(row, 2, 1, 6).getValues()[0]; // B:G as they are now
      takeKept_(kept, tab, row, shown); // keep one copy only
      kept.appendRow([tab, row, shown, cur[0], cur[2], cur[3], cur[4], cur[5]]);
    }
    sh.getRange(row, 2).setValue(rec[3]);
    sh.getRange(row, 4, 1, 4).setValues([[rec[4], rec[5], rec[6], rec[7]]]);
    setShowing_(showing, tab, row, picked);
    SpreadsheetApp.flush();
  } finally {
    lock.releaseLock();
  }
}

function tabOf_(ss, name, head) {
  var t = ss.getSheetByName(name);
  if (!t) {
    t = ss.insertSheet(name);
    t.appendRow(head);
    t.hideSheet();
  }
  return t;
}

function showingFor_(showing, tab, row) {
  var v = showing.getDataRange().getValues();
  for (var i = 1; i < v.length; i++) if (v[i][0] === tab && Number(v[i][1]) === row) return String(v[i][2]).trim();
  return null;
}

function setShowing_(showing, tab, row, venue) {
  var v = showing.getDataRange().getValues();
  for (var i = 1; i < v.length; i++) {
    if (v[i][0] === tab && Number(v[i][1]) === row) {
      showing.getRange(i + 1, 3).setValue(venue);
      return;
    }
  }
  showing.appendRow([tab, row, venue]);
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
