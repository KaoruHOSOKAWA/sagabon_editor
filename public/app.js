const PAGE_ROWS = 18;
const PAGE_COLUMNS = 9;
const FULLWIDTH_SPACE = "\u3000";

const state = {
  metadata: null,
  rows: [],
  shapedRows: [],
  pages: []
};

const editorBody = document.getElementById("editor-body");
const previewRoot = document.getElementById("preview-root");
const statusText = document.getElementById("status-text");
const rowCount = document.getElementById("row-count");
const pageCount = document.getElementById("page-count");
const fileInput = document.getElementById("file-input");

document.getElementById("add-row-button").addEventListener("click", () => {
  state.rows.push(createRow());
  syncView();
});

document.getElementById("save-button").addEventListener("click", saveCsv);
document.getElementById("load-button").addEventListener("click", () => fileInput.click());
document.getElementById("print-button").addEventListener("click", () => window.print());
fileInput.addEventListener("change", handleFileSelect);

boot();

async function boot() {
  const response = await fetch("./font-metadata.json");
  state.metadata = await response.json();
  state.rows = buildSampleRows();
  syncView();
}

function createRow(overrides = {}) {
  return {
    char: "",
    ligatureChoice: "",
    variantGlyph: "",
    ...overrides
  };
}

function buildSampleRows() {
  return ["さ", "が", "ぼ", "ん", "\\n", "あ", "め", "つ", "ち"].map((char) => createRow({ char }));
}

function syncView() {
  const shaped = shapeRows(state.rows, state.metadata);
  state.shapedRows = shaped.rowState;
  state.pages = shaped.pages;

  renderTable();
  renderPreview();

  rowCount.textContent = `${state.rows.length} 行`;
  pageCount.textContent = `${state.pages.length || 1} ページ`;
  const baseAdvance = state.metadata.baseVerticalAdvance || state.metadata.unitsPerEm;
  statusText.textContent = shaped.errors.length
    ? `未対応文字あり: ${shaped.errors.join(" / ")}`
    : `プレビュー更新済み。縦送り基準 ${baseAdvance} units。Chrome の印刷ダイアログで A4 出力できます。`;
}

function shapeRows(rows, metadata) {
  const rowState = rows.map((row) => ({
    ...row,
    status: row.char ? "未処理" : "空白",
    ligatureCandidates: [],
    selectionOptions: [],
    selectedOptionKey: "",
    selectedGlyph: "",
    outputGlyph: "",
    outputChar: "",
    mergedInto: null
  }));
  const errors = [];
  const output = [];

  let index = 0;
  while (index < rows.length) {
    const row = rows[index];
    const normalized = normalizeInput(row.char);

    if (normalized === "\\n") {
      rowState[index].status = "改行";
      output.push({ type: "newline", sourceIndex: index });
      index += 1;
      continue;
    }

    if (normalized === FULLWIDTH_SPACE) {
      rowState[index].status = "空白";
    }

    if (String(row.char).length > 1) {
      rowState[index].status = "複数入力: 先頭のみ使用";
    }

    const baseGlyph = metadata.charToGlyph[normalized];
    if (!baseGlyph) {
      rowState[index].status = "未対応文字";
      rowState[index].outputChar = normalized;
      errors.push(normalized);
      output.push({ type: "glyph", glyph: "", fallbackChar: normalized, sourceIndex: index });
      index += 1;
      continue;
    }

    const ligatureCandidates = findLigatureCandidates(rows, index, metadata);
    const ligature = selectLigature(row, ligatureCandidates);
    const consumedLength = ligature ? ligature.length : 1;
    const selectionOptions = buildSelectionOptions(normalized, baseGlyph, ligatureCandidates, metadata);
    const selectedOption = selectOutputOption(row, selectionOptions);
    const selectedGlyph = selectedOption?.glyph || (ligature ? buildVariantOptions(ligature.output, metadata)[0] : buildVariantOptions(baseGlyph, metadata)[0]);

    rowState[index].ligatureCandidates = ligatureCandidates;
    rowState[index].selectionOptions = selectionOptions;
    rowState[index].selectedOptionKey = selectedOption?.key || "";
    rowState[index].selectedGlyph = selectedGlyph;
    rowState[index].outputGlyph = selectedGlyph;
    rowState[index].outputChar = normalized;
    const ligatureMode = describeLigatureMode(selectedOption);
    if (rowState[index].status === "複数入力: 先頭のみ使用") {
      rowState[index].status += ligatureMode ? ` / ${ligatureMode}` : "";
    } else {
      rowState[index].status = ligatureMode || "通常";
    }

    output.push({ type: "glyph", glyph: selectedGlyph, fallbackChar: normalized, sourceIndex: index });

    for (let offset = 1; offset < consumedLength; offset += 1) {
      rowState[index + offset].status = `連字に吸収`;
      rowState[index + offset].mergedInto = index;
      rowState[index + offset].selectionOptions = [];
    }

    index += consumedLength;
  }

  const pages = paginateOutput(output, metadata);
  return { rowState, pages, errors: [...new Set(errors)] };
}

function normalizeInput(value) {
  if (value === undefined || value === null) {
    return FULLWIDTH_SPACE;
  }

  const raw = String(value).replaceAll("\r", "");
  if (raw === "") {
    return FULLWIDTH_SPACE;
  }

  if (raw === "\\n") {
    return "\\n";
  }

  const first = [...raw][0] || FULLWIDTH_SPACE;
  if (first === " ") {
    return FULLWIDTH_SPACE;
  }

  return first;
}

function findLigatureCandidates(rows, startIndex, metadata) {
  let node = metadata.ligatureTrie;
  const sequence = [];
  const matches = [];

  for (let cursor = startIndex; cursor < rows.length; cursor += 1) {
    const current = normalizeInput(rows[cursor].char);
    if (!current || current === "\\n") {
      break;
    }

    const glyph = metadata.charToGlyph[current];
    if (!glyph) {
      break;
    }

    node = node[glyph];
    if (!node) {
      break;
    }

    sequence.push(glyph);
    if (node.$ && sequence.length > 1) {
      matches.push({
        key: sequence.map((_, offset) => normalizeInput(rows[startIndex + offset].char)).join(""),
        text: sequence.map((_, offset) => normalizeInput(rows[startIndex + offset].char)).join(""),
        length: sequence.length,
        output: node.$
      });
    }
  }

  return matches;
}

function selectLigature(row, ligatureCandidates) {
  if (!ligatureCandidates.length) {
    return null;
  }
  if (row.ligatureChoice === "__single__") {
    return null;
  }
  if (row.ligatureChoice) {
    const selected = ligatureCandidates.find((candidate) => candidate.key === row.ligatureChoice);
    if (selected) {
      return selected;
    }
  }
  return ligatureCandidates[ligatureCandidates.length - 1];
}

function buildSelectionOptions(baseChar, baseGlyph, ligatureCandidates, metadata) {
  const candidates = [{ key: "__single__", text: baseChar, length: 1, output: baseGlyph }, ...ligatureCandidates];
  const options = [];

  candidates.forEach((candidate) => {
    const glyphs = buildVariantOptions(candidate.output, metadata);
    glyphs.forEach((glyph, index) => {
      options.push({
        key: `${candidate.key}::${glyph}`,
        ligatureKey: candidate.key,
        text: candidate.text,
        length: candidate.length,
        glyph,
        variantIndex: index
      });
    });
  });

  return options;
}

function selectOutputOption(row, selectionOptions) {
  if (!selectionOptions.length) {
    return null;
  }

  const exactKey = row.variantGlyph && selectionOptions.find((option) => option.key === row.variantGlyph);
  if (exactKey) {
    return exactKey;
  }

  if (row.ligatureChoice === "__single__") {
    const single = selectionOptions.find((option) => option.ligatureKey === "__single__");
    if (single) {
      return single;
    }
  }

  if (row.ligatureChoice) {
    const ligatureMatch = selectionOptions.find((option) => option.ligatureKey === row.ligatureChoice);
    if (ligatureMatch) {
      return ligatureMatch;
    }
  }

  const oldGlyphMatch = row.variantGlyph && selectionOptions.find((option) => option.glyph === row.variantGlyph);
  if (oldGlyphMatch) {
    return oldGlyphMatch;
  }

  const maxLength = Math.max(...selectionOptions.map((option) => option.length));
  return selectionOptions.find((option) => option.length === maxLength) || selectionOptions[0];
}

function describeLigatureMode(selectedOption) {
  if (!selectedOption) {
    return "";
  }
  if (selectedOption.ligatureKey === "__single__") {
    return "単字";
  }
  if (selectedOption.variantIndex > 0) {
    return `異体字 ${selectedOption.length}字`;
  }
  return `連字 ${selectedOption.length}字`;
}

function buildVariantOptions(baseGlyph, metadata) {
  const seen = new Set();
  const queue = [baseGlyph, metadata.verticalMap[baseGlyph] || baseGlyph];
  const options = [];

  while (queue.length) {
    const glyph = queue.shift();
    if (!glyph || seen.has(glyph)) {
      continue;
    }

    seen.add(glyph);
    const verticalGlyph = metadata.verticalMap[glyph] || glyph;
    if (!seen.has(verticalGlyph)) {
      queue.push(verticalGlyph);
    }

    options.push(verticalGlyph);

    for (const alternate of metadata.alternateMap[glyph] || []) {
      if (!seen.has(alternate)) {
        queue.push(alternate);
      }
      const verticalAlternate = metadata.verticalMap[alternate] || alternate;
      if (!seen.has(verticalAlternate)) {
        queue.push(verticalAlternate);
      }
    }
  }

  return [...new Set(options)];
}

function paginateOutput(output, metadata) {
  const pages = [];
  let page = createPage();
  let column = 0;
  let advance = 0;
  const baseAdvance = metadata.baseVerticalAdvance || metadata.unitsPerEm;
  const columnCapacity = baseAdvance * PAGE_ROWS;

  const ensureCapacity = () => {
    if (advance >= columnCapacity) {
      advance = 0;
      column += 1;
    }

    if (column >= PAGE_COLUMNS) {
      pages.push(page);
      page = createPage();
      column = 0;
      advance = 0;
    }
  };

  for (const item of output) {
    if (item.type === "newline") {
      column += 1;
      advance = 0;
      ensureCapacity();
      continue;
    }

    const glyphMetrics = getAdvanceMetrics(item, metadata);
    if (advance > 0 && advance + glyphMetrics.advanceHeight > columnCapacity) {
      advance = columnCapacity;
      ensureCapacity();
    }

    ensureCapacity();
    page.columns[column].push(buildRenderableGlyph(item, metadata, advance, glyphMetrics, columnCapacity));
    advance += glyphMetrics.advanceHeight;
  }

  if (!isPageEmpty(page) || pages.length === 0) {
    pages.push(page);
  }
  return pages;
}

function createPage() {
  return {
    columns: Array.from({ length: PAGE_COLUMNS }, () => [])
  };
}

function getAdvanceMetrics(item, metadata) {
  if (!item.glyph) {
    return {
      advanceHeight: metadata.baseVerticalAdvance || metadata.unitsPerEm,
      advanceWidth: metadata.unitsPerEm
    };
  }

  const glyphData = metadata.glyphData[item.glyph];
  return {
    advanceHeight: glyphData?.advanceHeight || metadata.unitsPerEm,
    advanceWidth: glyphData?.advanceWidth || metadata.unitsPerEm
  };
}

function buildRenderableGlyph(
  item,
  metadata,
  advanceOffset = 0,
  glyphMetrics = null,
  columnCapacity = (metadata.baseVerticalAdvance || metadata.unitsPerEm) * PAGE_ROWS
) {
  if (!item.glyph) {
    return {
      type: "fallback",
      text: item.fallbackChar,
      top: (advanceOffset / columnCapacity) * 100,
      height: ((glyphMetrics?.advanceHeight || metadata.baseVerticalAdvance || metadata.unitsPerEm) / columnCapacity) * 100
    };
  }

  const glyphData = metadata.glyphData[item.glyph];
  if (!glyphData || !glyphData.path) {
    return {
      type: "fallback",
      text: item.fallbackChar,
      top: (advanceOffset / columnCapacity) * 100,
      height: ((glyphMetrics?.advanceHeight || metadata.baseVerticalAdvance || metadata.unitsPerEm) / columnCapacity) * 100
    };
  }

  const bounds = glyphData.bounds;
  const viewBoxX = Math.min(0, bounds.xMin);
  const viewBoxWidth = Math.max(glyphData.advanceWidth, bounds.xMax) - viewBoxX;

  return {
    type: "svg",
    glyph: item.glyph,
    path: glyphData.path,
    top: (advanceOffset / columnCapacity) * 100,
    height: ((glyphData.advanceHeight || metadata.unitsPerEm) / columnCapacity) * 100,
    viewBox: `${viewBoxX} 0 ${viewBoxWidth} ${glyphData.advanceHeight}`,
    transform: `translate(0 ${glyphData.vertOriginY}) scale(1 -1)`
  };
}

function renderTable() {
  editorBody.innerHTML = "";

  state.rows.forEach((row, index) => {
    const shaped = state.shapedRows[index];
    const tr = document.createElement("tr");

    tr.innerHTML = `
      <td>${index + 1}</td>
      <td></td>
      <td></td>
      <td class="row-status"></td>
      <td><button type="button" class="insert-row">＋</button></td>
      <td><button type="button" class="delete-row">－</button></td>
    `;

    const charInput = document.createElement("input");
    charInput.type = "text";
    charInput.className = "char-input";
    charInput.value = row.char;
    charInput.placeholder = "例: あ / \\n";
    charInput.addEventListener("input", (event) => {
      state.rows[index].char = event.target.value;
    });
    charInput.addEventListener("change", (event) => {
      state.rows[index].char = event.target.value;
      syncView();
    });
    charInput.addEventListener("blur", (event) => {
      state.rows[index].char = event.target.value;
      syncView();
    });
    charInput.addEventListener("compositionend", (event) => {
      state.rows[index].char = event.target.value;
      syncView();
    });

    const options = shaped?.selectionOptions || [];
    const isVariantDisabled = !options.length || shaped?.mergedInto !== null;
    const variantCell = tr.children[2];
    variantCell.appendChild(renderVariantPicker(index, shaped, options, isVariantDisabled));

    const statusCell = tr.children[3];
    statusCell.textContent = shaped?.status || "未処理";
    if (shaped?.mergedInto !== null) {
      statusCell.classList.add("status-merged");
    }
    if (shaped?.status === "未対応文字") {
      statusCell.classList.add("status-error");
    }

    tr.children[1].appendChild(charInput);
    tr.querySelector(".insert-row").addEventListener("click", () => {
      state.rows.splice(index + 1, 0, createRow());
      syncView();
    });
    tr.querySelector(".delete-row").addEventListener("click", () => {
      state.rows.splice(index, 1);
      syncView();
    });

    editorBody.appendChild(tr);
  });
}

function describeGlyph(glyph, metadata) {
  const chars = metadata.glyphData[glyph]?.chars || [];
  if (chars.length) {
    return chars.join("");
  }
  return glyph;
}

function renderVariantPicker(rowIndex, shaped, options, disabled) {
  if (!options.length) {
    const empty = document.createElement("span");
    empty.className = "variant-empty";
    empty.textContent = "-";
    return empty;
  }

  const wrapper = document.createElement("details");
  wrapper.className = "variant-picker";
  if (disabled) {
    wrapper.classList.add("is-disabled");
  }

  const summary = document.createElement("summary");
  summary.className = "variant-summary";
  const selectedOption = options.find((option) => option.key === shaped.selectedOptionKey) || options[options.length - 1];
  summary.appendChild(buildGlyphPreview(selectedOption.glyph, state.metadata, "summary"));

  const label = document.createElement("span");
  label.className = "variant-summary-label";
  label.textContent = describeSelectionOption(selectedOption);
  summary.appendChild(label);
  wrapper.appendChild(summary);

  if (disabled) {
    wrapper.open = false;
    return wrapper;
  }

  const panel = document.createElement("div");
  panel.className = "variant-panel";

  options.forEach((option) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "variant-option";
    if (option.key === shaped.selectedOptionKey) {
      button.classList.add("is-selected");
    }

    button.appendChild(buildGlyphPreview(option.glyph, state.metadata, "option"));

    const text = document.createElement("span");
    text.className = "variant-option-label";
    text.textContent = describeSelectionOption(option);
    button.appendChild(text);

    button.addEventListener("click", () => {
      state.rows[rowIndex].ligatureChoice = option.ligatureKey;
      state.rows[rowIndex].variantGlyph = option.key;
      syncView();
    });

    panel.appendChild(button);
  });

  wrapper.appendChild(panel);
  return wrapper;
}

function describeSelectionOption(option) {
  if (!option) {
    return "-";
  }
  if (option.ligatureKey === "__single__") {
    return option.text;
  }
  return `${option.text} (${option.length}字)`;
}

function buildGlyphPreview(glyph, metadata, size = "option") {
  const holder = document.createElement("span");
  holder.className = `variant-preview variant-preview-${size}`;

  const glyphData = metadata.glyphData[glyph];
  if (!glyphData?.path) {
    holder.textContent = describeGlyph(glyph, metadata) || glyph;
    return holder;
  }

  const bounds = glyphData.bounds;
  const viewBoxX = Math.min(0, bounds.xMin);
  const viewBoxWidth = Math.max(glyphData.advanceWidth, bounds.xMax) - viewBoxX;
  holder.innerHTML = `
    <svg viewBox="${viewBoxX} 0 ${viewBoxWidth} ${glyphData.advanceHeight}" aria-hidden="true" focusable="false" preserveAspectRatio="xMidYMid meet">
      <path d="${glyphData.path}" transform="translate(0 ${glyphData.vertOriginY}) scale(1 -1)"></path>
    </svg>
  `;
  return holder;
}

function renderPreview() {
  previewRoot.innerHTML = "";

  if (!state.pages.length || isPageEmpty(state.pages[0])) {
    const emptyPage = document.createElement("section");
    emptyPage.className = "page";
    emptyPage.innerHTML = `<div class="empty-page">左の表に文字を入力するとここに組版されます。</div>`;
    previewRoot.appendChild(emptyPage);
    return;
  }

  state.pages.forEach((page) => {
    const pageEl = document.createElement("section");
    pageEl.className = "page";

    const grid = document.createElement("div");
    grid.className = "page-grid";

    page.columns.forEach((column) => {
      const columnEl = document.createElement("div");
      columnEl.className = "column";

      column.forEach((cell) => {
        const cellEl = document.createElement("div");
        cellEl.className = "glyph-cell";
        cellEl.style.top = `${cell.top}%`;
        cellEl.style.height = `${cell.height}%`;
        const frame = document.createElement("div");
        frame.className = "glyph-frame";

        if (cell?.type === "svg") {
          frame.innerHTML = `
            <svg viewBox="${cell.viewBox}" aria-hidden="true" focusable="false" preserveAspectRatio="xMidYMid meet">
              <path d="${cell.path}" transform="${cell.transform}"></path>
            </svg>
          `;
        } else if (cell?.type === "fallback") {
          frame.innerHTML = `<div class="fallback-char">${escapeHtml(cell.text)}</div>`;
        }

        cellEl.appendChild(frame);
        columnEl.appendChild(cellEl);
      });

      grid.appendChild(columnEl);
    });

    pageEl.appendChild(grid);
    previewRoot.appendChild(pageEl);
  });
}

function isPageEmpty(page) {
  return page.columns.every((column) => column.length === 0);
}

function saveCsv() {
  const lines = [
    ["char", "ligatureChoice", "variantGlyph"].join(","),
    ...state.rows.map((row) =>
      [row.char, row.ligatureChoice || "", row.variantGlyph || ""].map(csvEscape).join(",")
    )
  ];
  const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "sagabon-layout.csv";
  anchor.click();
  URL.revokeObjectURL(url);
}

async function handleFileSelect(event) {
  const [file] = event.target.files || [];
  if (!file) {
    return;
  }

  const text = await file.text();
  if (isTextFile(file)) {
    state.rows = parsePlainText(text);
  } else {
    state.rows = parseCsv(text).map((row) =>
      createRow({
        char: row.char || "",
        ligatureChoice: row.ligatureChoice || "",
        variantGlyph: row.variantGlyph || ""
      })
    );
  }
  syncView();
  fileInput.value = "";
}

function isTextFile(file) {
  const name = file.name.toLowerCase();
  return name.endsWith(".txt") || file.type === "text/plain";
}

function csvEscape(value) {
  const stringValue = String(value ?? "");
  if (!/[",\n]/.test(stringValue)) {
    return stringValue;
  }
  return `"${stringValue.replace(/"/g, '""')}"`;
}

function parseCsv(text) {
  const rows = [];
  let current = "";
  let record = [];
  let inQuotes = false;

  const pushCell = () => {
    record.push(current);
    current = "";
  };

  const pushRecord = () => {
    if (record.length > 1 || record[0] !== "") {
      rows.push(record);
    }
    record = [];
  };

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];

    if (inQuotes) {
      if (char === '"' && next === '"') {
        current += '"';
        i += 1;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        current += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      pushCell();
    } else if (char === "\n") {
      pushCell();
      pushRecord();
    } else if (char !== "\r") {
      current += char;
    }
  }

  pushCell();
  pushRecord();

  const [header, ...dataRows] = rows;
  return dataRows.map((values) =>
    Object.fromEntries(header.map((column, index) => [column, values[index] || ""]))
  );
}

function parsePlainText(text) {
  const rows = [];
  const normalizedText = text.replaceAll("\r\n", "\n").replaceAll("\r", "\n");

  for (const char of [...normalizedText]) {
    if (char === "\n") {
      rows.push(createRow({ char: "\\n" }));
    } else {
      rows.push(createRow({ char }));
    }
  }

  return rows;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
