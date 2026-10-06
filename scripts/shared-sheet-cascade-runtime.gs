// Bundled with config generated from supplier-input-sheet-spec.v1.json.
// Only native validation changes. No vehicle values, source facts or formatting writes.
function fpCascadeIndex(rows) {
  var index = Object.create(null);
  rows.forEach(function(row) {
    var key = String(row[0] || '');
    if (!key) return;
    if (Object.prototype.hasOwnProperty.call(index, key)) throw new Error('HOLD: duplicate lookup key');
    index[key] = row.slice(1).filter(function(v) { return v !== '' && v !== null; }).map(String);
  });
  if (!index['M|*'] || !index['M|*'].length) throw new Error('HOLD: maker list missing');
  return index;
}

function fpCascadeChoices(values, index) {
  var maker = values[0], model = values[1], detail = values[2];
  var models = index['M|*'].indexOf(maker) >= 0 ? index['D|' + maker] || [] : [];
  var details = models.indexOf(model) >= 0 ? index['S|' + maker + '|' + model] || [] : [];
  var trims = details.indexOf(detail) >= 0 ? index['T|' + maker + '|' + model + '|' + detail] || [] : [];
  return [index['M|*'], models, details, trims];
}

function fpCascadeContext(book, sheet) {
  var config = FREEPASS_CASCADE_CONFIG;
  if (book.getId() !== config.spreadsheetId) throw new Error('HOLD: exact workbook binding required');
  var binding = config.suppliers.filter(function(s) { return s.title === sheet.getName(); })[0];
  if (!binding) return null; // Summary, archive and other tabs are never edited.
  if (sheet.getSheetId() !== binding.sheetId) throw new Error('HOLD: supplier sheet ID changed');
  var header = sheet.getRange(1, config.firstColumn, 1, 4).getDisplayValues()[0];
  if (JSON.stringify(header) !== JSON.stringify(config.headers)) throw new Error('HOLD: vehicle headers changed');
  return config;
}

function fpCascadeRule(list, row, column) {
  var builder = SpreadsheetApp.newDataValidation().setAllowInvalid(true);
  if (list.length) return builder.requireValueInList(list, true).setHelpText('앞 항목에 맞는 차종 목록입니다. 기존 값은 지우지 않습니다.').build();
  // No invented options or fallback to another maker. Non-empty unmatched values remain visible with a warning.
  var letter = String.fromCharCode(64 + column);
  return builder.requireFormulaSatisfied('=LEN(' + letter + row + ')=0').setHelpText('앞 단계가 비었거나 목록과 맞지 않습니다. 원문을 확인하세요. 입력값은 보존됩니다.').build();
}

function fpCascadeRefresh(book, sheet, startRow, rowCount) {
  var config = fpCascadeContext(book, sheet);
  if (!config) return {status: 'IGNORED'};
  if (!Number.isInteger(startRow) || !Number.isInteger(rowCount) || startRow < 2 || rowCount < 1 || startRow + rowCount - 1 > sheet.getMaxRows()) throw new Error('HOLD: bounded data rows required');
  var lookup = book.getSheetByName(config.lookupTab);
  if (!lookup || lookup.getSheetId() !== config.lookupSheetId) throw new Error('HOLD: lookup binding changed');
  var lock = LockService.getDocumentLock();
  if (!lock.tryLock(1000)) throw new Error('HOLD: another dropdown update is running; select the row again');
  try {
    // One bounded lookup read and one row block read. No per-cell service calls or persistent helper formulas.
    var index = fpCascadeIndex(lookup.getRange(1, 1, lookup.getLastRow(), lookup.getLastColumn()).getDisplayValues());
    var range = sheet.getRange(startRow, config.firstColumn, rowCount, 4);
    var values = range.getDisplayValues();
    var rules = values.map(function(row, i) {
      return fpCascadeChoices(row, index).map(function(list, j) { return fpCascadeRule(list, startRow + i, config.firstColumn + j); });
    });
    if (JSON.stringify(range.getDisplayValues()) !== JSON.stringify(values)) throw new Error('HOLD: row changed while preparing dropdowns');
    range.setDataValidations(rules);
    return {status: 'UPDATED', rowCount: rowCount};
  } finally { lock.releaseLock(); }
}

function onEdit(e) {
  if (!e || !e.range || !e.source) return;
  var sheet = e.range.getSheet(), config = fpCascadeContext(e.source, sheet);
  if (!config || e.range.getLastColumn() < config.firstColumn || e.range.getColumn() > config.firstColumn + 3) return;
  var first = Math.max(2, e.range.getRow()), end = e.range.getLastRow();
  if (end < first) return;
  // Whole pasted row rectangles are processed, not just e.value (which is absent on multi-cell edits).
  fpCascadeRefresh(e.source, sheet, first, end - first + 1);
}

function onSelectionChange(e) {
  if (!e || !e.range || !e.source || e.range.getNumRows() !== 1) return;
  var sheet = e.range.getSheet(), config = fpCascadeContext(e.source, sheet);
  if (!config || e.range.getRow() < 2 || e.range.getLastColumn() < config.firstColumn || e.range.getColumn() > config.firstColumn + 3) return;
  // Repair the selected row after a skipped edit event or API write. Selection events may also be skipped by Sheets.
  fpCascadeRefresh(e.source, sheet, e.range.getRow(), 1);
}

function fpRefreshSelectedVehicleRows() {
  var book = SpreadsheetApp.getActiveSpreadsheet(), range = book.getActiveRange();
  if (!range) throw new Error('차량 행을 먼저 선택하세요.');
  var first = Math.max(2, range.getRow()), end = range.getLastRow();
  if (end >= first) return fpCascadeRefresh(book, range.getSheet(), first, end - first + 1);
}

function fpRefreshSupplierVehicleRows(tab, startRow, rowCount) {
  // Explicit repair in the bound editor context. API publishers use planCascadeValidationRefresh
  // from build-shared-sheet-cascade.mjs: API edits do not emit onEdit, and API executions
  // cannot rely on the bound editor's active spreadsheet context.
  var book = SpreadsheetApp.getActiveSpreadsheet(), sheet = book.getSheetByName(tab);
  if (!sheet) throw new Error('HOLD: supplier tab missing');
  return fpCascadeRefresh(book, sheet, startRow, rowCount);
}

function onOpen(e) {
  var book = e && e.source || SpreadsheetApp.getActiveSpreadsheet();
  if (book.getId() !== FREEPASS_CASCADE_CONFIG.spreadsheetId) return;
  SpreadsheetApp.getUi().createMenu('차종 목록').addItem('선택한 행 드롭다운 갱신', 'fpRefreshSelectedVehicleRows').addToUi();
}
