/**
 * ExamImporter - Module xử lý nhập đề thi đa định dạng
 * Hỗ trợ: Word (.docx), Excel (.xlsx, .xls), CSV (.csv), Text (.txt, .aiken), JSON (.json)
 * Tự động nhận diện cấu trúc đề thi phổ biến của giáo viên Việt Nam & chuẩn quốc tế
 */

(function (root, factory) {
  if (typeof define === 'function' && define.amd) {
    define([], factory);
  } else if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.ExamImporter = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Chuyển ký tự đáp án ('A', 'B', 'C', 'D', '1', '2', '3', '4') thành index 0-3
  function letterToIndex(val) {
    if (val === null || val === undefined) return 0;
    const s = String(val).trim().toUpperCase();
    if (s === 'A' || s === '1') return 0;
    if (s === 'B' || s === '2') return 1;
    if (s === 'C' || s === '3') return 2;
    if (s === 'D' || s === '4') return 3;
    return 0;
  }

  // Tách các lựa chọn nằm trên cùng một dòng (ví dụ: "A. 10   B. 20   C. 30   D. 40" hoặc "*A. 10  B. 20")
  function splitInlineChoices(line) {
    if (!line) return null;
    const choiceRegex = /(?:^|\s{2,}|\t+)((?:\*|\[x\])?\s*[A-Da-d][\.\)])\s+/g;
    const matches = [];
    let match;
    while ((match = choiceRegex.exec(line)) !== null) {
      matches.push({ index: match.index, letter: match[1], length: match[0].length });
    }
    if (matches.length >= 2) {
      const result = [];
      for (let i = 0; i < matches.length; i++) {
        const start = matches[i].index;
        const end = (i + 1 < matches.length) ? matches[i + 1].index : line.length;
        result.push(line.substring(start, end).trim());
      }
      return result;
    }
    return null;
  }

  // Bóc tách bảng đáp án ở cuối văn bản (ví dụ: "BẢNG ĐÁP ÁN: 1-A 2-B 3-C 4-D" hoặc "1.A 2.B 3.C")
  function extractAnswerTable(text) {
    const tableMap = {};
    if (!text) return { cleanText: text, tableMap };

    const tableHeaderRegex = /(?:^|\n)\s*(?:BẢNG\s+ĐÁP\s+ÁN|ĐÁP\s+ÁN\s+THAM\s+KHẢO|ĐÁP\s+ÁN\s+CHI\s+TIẾT|ANSWER\s+KEY|BẢNG\s+TRẢ\s+LỜI)[:\s]*([\s\S]*)$/i;
    const match = tableHeaderRegex.exec(text);
    if (!match) return { cleanText: text, tableMap };

    const tableContent = match[1];
    const pairRegex = /(?:câu\s*)?(\d+)\s*[\.:\-\/\)]\s*([A-Da-d])/gi;
    let pMatch;
    let foundCount = 0;
    while ((pMatch = pairRegex.exec(tableContent)) !== null) {
      const qNum = parseInt(pMatch[1], 10);
      const ansLetter = pMatch[2].toUpperCase();
      tableMap[qNum] = ansLetter;
      foundCount++;
    }

    // Nếu tìm thấy ít nhất 2 cặp câu-đáp án, cắt bỏ phần bảng đáp án khỏi văn bản để tránh lẫn vào câu hỏi
    if (foundCount >= 2) {
      const cleanText = text.substring(0, match.index).trim();
      return { cleanText, tableMap };
    }

    return { cleanText: text, tableMap };
  }

  /* ─────────────────────────────────────────────────────────────
     1. PARSER VĂN BẢN CHUẨN GIÁO VIÊN VIỆT NAM & AIKEN
     ───────────────────────────────────────────────────────────── */
  function parseVnText(rawText) {
    if (!rawText) return { questions: [], title: '' };

    // Chuẩn hóa xuống dòng
    let text = rawText.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

    // Thử trích xuất bảng đáp án cuối tài liệu
    const { cleanText, tableMap } = extractAnswerTable(text);
    text = cleanText;

    // Tìm tiêu đề đề thi nếu dòng đầu có từ khóa
    let suggestedTitle = '';
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
    if (lines.length > 0) {
      const firstLine = lines[0];
      if (/^(?:ĐỀ\s+THI|BÀI\s+KIỂM\s+TRA|KIỂM\s+TRA|PHIẾU\s+BÀI\s+TẬP|QUIZ|EXAM|TEST)/i.test(firstLine)) {
        suggestedTitle = firstLine.replace(/^[#*_\-\s]+/, '').replace(/[#*_\-\s]+$/, '');
      }
    }

    // Tách văn bản thành các khối câu hỏi dựa vào "Câu 1:", "Câu 1.", "Bài 1:", "Question 1:"
    // hoặc dòng bắt đầu bằng số theo sau bởi dấu chấm/hai chấm
    const qSplitRegex = /(?:^|\n+)(?=(?:Câu|Bài|Question)\s*\d+[\.:\)\s]|\d+[\.:\)]\s+)/i;
    let rawBlocks = text.split(qSplitRegex).map(b => b.trim()).filter(Boolean);

    // Nếu không tách được theo "Câu X", thử tách theo khối có ANSWER: (chuẩn Aiken)
    if (rawBlocks.length <= 1 && /ANSWER:\s*[A-D]/i.test(text)) {
      rawBlocks = text.split(/\n\s*\n+/).map(b => b.trim()).filter(Boolean);
    }

    const questions = [];
    let qCounter = 1;

    for (let bIdx = 0; bIdx < rawBlocks.length; bIdx++) {
      const block = rawBlocks[bIdx];
      // Bỏ qua khối đầu nếu chỉ là tiêu đề mà không có lựa chọn A/B/C/D
      if (!/[A-Da-d][\.\)]/.test(block) && !/ANSWER:/i.test(block)) {
        if (!suggestedTitle && block.length < 150) {
          suggestedTitle = block.replace(/\n+/g, ' - ');
        }
        continue;
      }

      // Tách khối thành các dòng
      let bLines = block.split('\n').map(l => l.trim()).filter(Boolean);
      if (bLines.length === 0) continue;

      // Xử lý tách các lựa chọn viết cùng 1 dòng
      const expandedLines = [];
      bLines.forEach(line => {
        const inlines = splitInlineChoices(line);
        if (inlines && inlines.length >= 2) {
          expandedLines.push(...inlines);
        } else {
          expandedLines.push(line);
        }
      });
      bLines = expandedLines;

      let qText = '';
      const choices = [];
      let correctIdx = -1;
      let qNumFromText = null;

      // Đọc dòng đầu tiên để lấy nội dung câu hỏi
      const firstLineMatch = /^(?:Câu|Bài|Question)?\s*(\d+)[\.:\)\s]*(.*)/i.exec(bLines[0]);
      if (firstLineMatch) {
        qNumFromText = parseInt(firstLineMatch[1], 10);
        qText = firstLineMatch[2].trim();
      } else {
        qText = bLines[0];
      }

      let i = 1;
      // Thu thập tiếp phần câu hỏi nếu câu hỏi dài nhiều dòng trước khi gặp A./B./C./D.
      while (i < bLines.length && !/^(?:\*|\[x\])?\s*[A-Da-d][\.\)]/.test(bLines[i]) && !/^(?:Đáp\s*án|Đ\/[aá]|Answer|Key|ANSWER)/i.test(bLines[i])) {
        qText += ' ' + bLines[i];
        i++;
      }

      // Thu thập các lựa chọn A, B, C, D
      for (; i < bLines.length; i++) {
        const line = bLines[i];

        // 1. Kiểm tra dòng Đáp án: X hoặc ANSWER: X
        const ansMatch = /^(?:Đáp\s*án|Đ\/[aá]|Answer|Key|ANSWER)\s*[:=\s]*([A-Da-d])/i.exec(line);
        if (ansMatch) {
          correctIdx = letterToIndex(ansMatch[1]);
          continue;
        }

        // 2. Kiểm tra lựa chọn có đánh dấu sao *A. hoặc [x] A.
        const starChoiceMatch = /^(?:\*|\[x\])\s*([A-Da-d])[\.\)]\s*(.*)/i.exec(line);
        if (starChoiceMatch) {
          correctIdx = letterToIndex(starChoiceMatch[1]);
          choices.push(starChoiceMatch[2].trim());
          continue;
        }

        // 3. Kiểm tra lựa chọn chuẩn A. B. C. D.
        const normChoiceMatch = /^([A-Da-d])[\.\)]\s*(.*)/.exec(line);
        if (normChoiceMatch) {
          choices.push(normChoiceMatch[2].trim());
          continue;
        }

        // Nếu dòng không khớp các mẫu trên nhưng choices đang có, có thể là nội dung lựa chọn rớt dòng
        if (choices.length > 0) {
          choices[choices.length - 1] += ' ' + line;
        } else {
          qText += ' ' + line;
        }
      }

      // Nếu chưa có đáp án đúng, kiểm tra bảng đáp án cuối tài liệu
      const targetNum = qNumFromText || qCounter;
      if (correctIdx === -1 && tableMap[targetNum]) {
        correctIdx = letterToIndex(tableMap[targetNum]);
      }

      // Chuẩn hóa: Nếu câu hỏi có nội dung và có ít nhất 2 lựa chọn
      if (qText && choices.length >= 2) {
        // Đảm bảo có tối thiểu 4 lựa chọn (nếu chỉ có 2-3 thì bổ sung hoặc giữ nguyên)
        while (choices.length < 4) {
          choices.push('');
        }
        // Giới hạn tối đa 4 lựa chọn phổ biến
        const finalChoices = choices.slice(0, 4);
        if (correctIdx < 0 || correctIdx >= finalChoices.length) {
          correctIdx = 0; // Mặc định A nếu chưa tìm thấy đáp án
        }

        questions.push({
          id: 'q-imp-' + Date.now() + '-' + qCounter,
          text: qText.replace(/^[#*_\-\s]+/, '').trim(),
          choices: finalChoices,
          correct: correctIdx,
          hasAutoAnswer: (correctIdx !== -1)
        });
        qCounter++;
      }
    }

    return {
      title: suggestedTitle || 'Đề thi nhập từ file',
      questions
    };
  }

  /* ─────────────────────────────────────────────────────────────
     2. PARSER EXCEL (.xlsx, .xls) & CSV
     ───────────────────────────────────────────────────────────── */
  function parseExcelSheet(sheetOrRows) {
    if (!sheetOrRows) return { questions: [], title: '' };
    let sheetRows = sheetOrRows;
    if (typeof XLSX !== 'undefined' && !Array.isArray(sheetOrRows) && typeof sheetOrRows === 'object') {
      sheetRows = XLSX.utils.sheet_to_json(sheetOrRows, { header: 1 });
    }
    if (!sheetRows || sheetRows.length === 0) return { questions: [], title: '' };

    // Tìm dòng tiêu đề (Header row)
    let headerIdx = -1;
    let colMap = { q: -1, a: -1, b: -1, c: -1, d: -1, correct: -1, time: -1, points: -1 };

    for (let r = 0; r < Math.min(sheetRows.length, 10); r++) {
      const row = sheetRows[r];
      if (!Array.isArray(row)) continue;

      let foundQ = false;
      row.forEach((cell, cIdx) => {
        const val = String(cell || '').trim().toLowerCase();
        if (/^(?:câu\s*hỏi|nội\s*dung|question|câu|bài|text)$/i.test(val)) {
          colMap.q = cIdx;
          foundQ = true;
        } else if (/^(?:đáp\s*án\s*a|lựa\s*chọn\s*a|option\s*a|a)$/i.test(val)) {
          colMap.a = cIdx;
        } else if (/^(?:đáp\s*án\s*b|lựa\s*chọn\s*b|option\s*b|b)$/i.test(val)) {
          colMap.b = cIdx;
        } else if (/^(?:đáp\s*án\s*c|lựa\s*chọn\s*c|option\s*c|c)$/i.test(val)) {
          colMap.c = cIdx;
        } else if (/^(?:đáp\s*án\s*d|lựa\s*chọn\s*d|option\s*d|d)$/i.test(val)) {
          colMap.d = cIdx;
        } else if (/^(?:đáp\s*án\s*đúng|đáp\s*án|answer|correct|key)$/i.test(val)) {
          colMap.correct = cIdx;
        } else if (/^(?:thời\s*gian|time)$/i.test(val)) {
          colMap.time = cIdx;
        }
      });

      if (foundQ || (colMap.a !== -1 && colMap.b !== -1)) {
        headerIdx = r;
        break;
      }
    }

    // Nếu không tìm thấy hàng tiêu đề rõ ràng, áp dụng vị trí cột mặc định 0: Q, 1: A, 2: B, 3: C, 4: D, 5: Đáp án
    if (headerIdx === -1) {
      headerIdx = 0;
      colMap = { q: 0, a: 1, b: 2, c: 3, d: 4, correct: 5, time: -1 };
    }

    const questions = [];
    for (let r = headerIdx + 1; r < sheetRows.length; r++) {
      const row = sheetRows[r];
      if (!row || row.length === 0) continue;

      const qText = String(row[colMap.q] !== undefined ? row[colMap.q] : row[0] || '').trim();
      if (!qText) continue;

      const choiceA = String(row[colMap.a] !== undefined ? row[colMap.a] : row[1] || '').trim();
      const choiceB = String(row[colMap.b] !== undefined ? row[colMap.b] : row[2] || '').trim();
      const choiceC = String(row[colMap.c] !== undefined ? row[colMap.c] : row[3] || '').trim();
      const choiceD = String(row[colMap.d] !== undefined ? row[colMap.d] : row[4] || '').trim();

      const choices = [choiceA, choiceB, choiceC, choiceD];
      if (choices.filter(Boolean).length < 2) continue;

      const rawAns = String(row[colMap.correct] !== undefined ? row[colMap.correct] : row[5] || '').trim();
      let correctIdx = letterToIndex(rawAns);

      // Nếu rawAns trùng với nội dung của lựa chọn nào đó
      choices.forEach((c, idx) => {
        if (c && rawAns && c.toLowerCase() === rawAns.toLowerCase()) {
          correctIdx = idx;
        }
      });

      questions.push({
        id: 'q-imp-xls-' + Date.now() + '-' + (r + 1),
        text: qText,
        choices,
        correct: correctIdx,
        hasAutoAnswer: Boolean(rawAns)
      });
    }

    return {
      title: 'Đề thi nhập từ bảng tính',
      questions
    };
  }

  // Phân tích tệp CSV (tự động nhận diện dấu phẩy, chấm phẩy hoặc tab)
  function parseCsvText(csvText) {
    if (!csvText) return { questions: [], title: '' };

    // Nhận diện dấu phân cách (Delimiter detection)
    const lines = csvText.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n').filter(Boolean);
    if (lines.length === 0) return { questions: [], title: '' };

    const firstLine = lines[0];
    const commas = (firstLine.match(/,/g) || []).length;
    const semicolons = (firstLine.match(/;/g) || []).length;
    const tabs = (firstLine.match(/\t/g) || []).length;

    let delimiter = ',';
    if (semicolons > commas && semicolons > tabs) delimiter = ';';
    else if (tabs > commas && tabs > semicolons) delimiter = '\t';

    // Parse CSV từng dòng
    const sheetRows = lines.map(line => {
      const row = [];
      let inQuotes = false;
      let currentCell = '';
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '"') {
          inQuotes = !inQuotes;
        } else if (ch === delimiter && !inQuotes) {
          row.push(currentCell.trim());
          currentCell = '';
        } else {
          currentCell += ch;
        }
      }
      row.push(currentCell.trim());
      return row;
    });

    return parseExcelSheet(sheetRows);
  }

  /* ─────────────────────────────────────────────────────────────
     3. PARSER JSON (Mini Quiz & LMS format)
     ───────────────────────────────────────────────────────────── */
  function parseJson(jsonStr) {
    try {
      const data = JSON.parse(jsonStr);
      let title = 'Đề thi nhập từ JSON';
      let rawQuestions = [];

      if (Array.isArray(data)) {
        rawQuestions = data;
      } else if (data && typeof data === 'object') {
        title = data.title || data.name || title;
        if (Array.isArray(data.questions)) {
          rawQuestions = data.questions;
        } else if (Array.isArray(data.items)) {
          rawQuestions = data.items;
        }
      }

      const questions = [];
      rawQuestions.forEach((q, idx) => {
        const text = q.text || q.question || q.prompt || '';
        let choices = q.choices || q.options || q.answers || [];
        if (!text || !Array.isArray(choices) || choices.length < 2) return;

        // Chuẩn hóa mảng choices thành chuỗi
        choices = choices.map(c => (typeof c === 'object' && c !== null ? (c.text || c.content || JSON.stringify(c)) : String(c)));
        while (choices.length < 4) choices.push('');

        let correct = q.correct !== undefined ? q.correct : (q.answer !== undefined ? q.answer : 0);
        if (typeof correct === 'string') correct = letterToIndex(correct);
        correct = Number(correct) || 0;
        if (correct < 0 || correct >= 4) correct = 0;

        questions.push({
          id: 'q-imp-json-' + Date.now() + '-' + (idx + 1),
          text: String(text).trim(),
          choices: choices.slice(0, 4),
          correct,
          hasAutoAnswer: true
        });
      });

      return { title, questions };
    } catch (e) {
      return { questions: [], title: '', error: e.message };
    }
  }

  /* ─────────────────────────────────────────────────────────────
     4. COORDINATOR TỔNG HỢP (Xử lý theo File / Blob / Text)
     ───────────────────────────────────────────────────────────── */
  async function parseFile(file) {
    if (!file) throw new Error('Không có tệp được chọn');

    const fileName = file.name || '';
    const ext = fileName.split('.').pop().toLowerCase();
    const baseName = fileName.replace(/\.[^/.]+$/, '');

    // 1. Tệp Word (.docx)
    if (ext === 'docx') {
      if (typeof mammoth === 'undefined') {
        throw new Error('Thư viện đọc Word (Mammoth) chưa sẵn sàng. Vui lòng thử lại sau vài giây!');
      }
      const arrayBuffer = await file.arrayBuffer();
      const result = await mammoth.extractRawText({ arrayBuffer });
      const parsed = parseVnText(result.value);
      if (!parsed.title || parsed.title === 'Đề thi nhập từ file') {
        parsed.title = baseName;
      }
      return parsed;
    }

    // 2. Tệp Excel (.xlsx, .xls)
    if (ext === 'xlsx' || ext === 'xls') {
      if (typeof XLSX === 'undefined') {
        throw new Error('Thư viện đọc Excel (SheetJS) chưa sẵn sàng. Vui lòng thử lại sau vài giây!');
      }
      const arrayBuffer = await file.arrayBuffer();
      const workbook = XLSX.read(arrayBuffer, { type: 'array' });
      const firstSheetName = workbook.SheetNames[0];
      const worksheet = workbook.Sheets[firstSheetName];
      const sheetRows = XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: '' });
      const parsed = parseExcelSheet(sheetRows);
      if (!parsed.title || parsed.title === 'Đề thi nhập từ bảng tính') {
        parsed.title = baseName;
      }
      return parsed;
    }

    // 3. Tệp CSV (.csv)
    if (ext === 'csv') {
      const text = await file.text();
      const parsed = parseCsvText(text);
      if (!parsed.title || parsed.title === 'Đề thi nhập từ bảng tính') {
        parsed.title = baseName;
      }
      return parsed;
    }

    // 4. Tệp JSON (.json)
    if (ext === 'json') {
      const text = await file.text();
      const parsed = parseJson(text);
      if (!parsed.title || parsed.title === 'Đề thi nhập từ JSON') {
        parsed.title = baseName;
      }
      return parsed;
    }

    // 5. Mặc định là Tệp Text (.txt, .aiken hoặc file văn bản thô)
    const text = await file.text();
    const parsed = parseVnText(text);
    if (!parsed.title || parsed.title === 'Đề thi nhập từ file') {
      parsed.title = baseName;
    }
    return parsed;
  }

  /* ─────────────────────────────────────────────────────────────
     5. TẠO VÀ TẢI VỀ CÁC TỆP MẪU (SAMPLE GENERATORS)
     ───────────────────────────────────────────────────────────── */
  function downloadSampleFile(format) {
    const fmt = String(format || '').toLowerCase().trim();

    // 1. Mẫu Word (.docx)
    if (fmt === 'docx' || fmt === 'word') {
      tryDownloadStaticOrFallback(
        'samples/Mau_De_Thi_Word.docx',
        'Mau_De_Thi_Word.docx',
        () => {
          const sampleText = `ĐỀ KIỂM TRA MẪU - MINI QUIZ CLASSROOM
Môn học: Tổng hợp kiến thức
Thời gian: 15s/câu

Câu 1: Thủ đô của Việt Nam là thành phố nào?
A. Đà Nẵng
*B. Hà Nội
C. TP. Hồ Chí Minh
D. Hải Phòng
Đáp án: B

Câu 2: Kết quả của phép tính: 15 x 4 + 10 là bao nhiêu?
A. 60
*B. 70
C. 50
D. 80

Câu 3: Đâu là ngôn ngữ lập trình chạy trực tiếp trên trình duyệt web?
*A. JavaScript
B. Pascal
C. Fortran
D. COBOL
Đáp án: A

Câu 4: 1 byte bằng bao nhiêu bit?
A. 4 bit
*B. 8 bit
C. 16 bit
D. 32 bit
Đáp án: B
`;
          const blob = new Blob([sampleText], { type: 'text/plain;charset=utf-8;' });
          saveBlobAsFile(blob, 'Mau_De_Thi_Word.txt');
        }
      );
      return;
    }

    // 2. Mẫu Excel (.xlsx, .xls)
    if (fmt === 'xlsx' || fmt === 'excel' || fmt === 'xls') {
      tryDownloadStaticOrFallback(
        'samples/Mau_De_Thi_Mini_Quiz.xlsx',
        'Mau_De_Thi_Mini_Quiz.xlsx',
        () => {
          const sampleData = [
            ['Câu hỏi', 'Đáp án A', 'Đáp án B', 'Đáp án C', 'Đáp án D', 'Đáp án đúng', 'Thời gian (giây)'],
            ['Thủ đô của Việt Nam là thành phố nào?', 'Đà Nẵng', 'Hà Nội', 'TP. Hồ Chí Minh', 'Hải Phòng', 'B', 15],
            ['Kết quả của phép tính: 15 x 4 + 10 là bao nhiêu?', '60', '70', '50', '80', 'B', 20],
            ['Số tiếp theo trong dãy số: 2, 4, 8, 16, ? là:', '24', '30', '32', '36', 'C', 15],
            ['Tổng số đo 3 góc trong một tam giác bằng bao nhiêu độ?', '90°', '180°', '270°', '360°', 'B', 15],
            ['Hành tinh nào gần Mặt Trời nhất trong Hệ Mặt Trời?', 'Sao Kim', 'Sao Thủy', 'Sao Hỏa', 'Trái Đất', 'B', 15]
          ];

          if (typeof XLSX !== 'undefined') {
            const ws = XLSX.utils.aoa_to_sheet(sampleData);
            ws['!cols'] = [
              { wch: 45 }, { wch: 18 }, { wch: 18 }, { wch: 18 }, { wch: 18 }, { wch: 14 }, { wch: 16 }
            ];
            const wb = XLSX.utils.book_new();
            XLSX.utils.book_append_sheet(wb, ws, 'MauDeThi');
            XLSX.writeFile(wb, 'Mau_De_Thi_Mini_Quiz.xlsx');
            return;
          }

          const csvContent = '\uFEFF' + sampleData.map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(',')).join('\n');
          const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
          saveBlobAsFile(blob, 'Mau_De_Thi_Mini_Quiz.csv');
        }
      );
      return;
    }

    // 3. Mẫu Text (.txt) chuẩn Aiken / Tiếng Việt
    if (fmt === 'txt' || fmt === 'text' || fmt === 'aiken') {
      tryDownloadStaticOrFallback(
        'samples/Mau_De_Thi_Aiken.txt',
        'Mau_De_Thi_Aiken.txt',
        () => {
          const sampleAiken = `ĐỀ THI MẪU CHUẨN AIKEN - MINI QUIZ CLASSROOM

Câu 1: Thủ đô của Việt Nam là thành phố nào?
A. Đà Nẵng
B. Hà Nội
C. TP. Hồ Chí Minh
D. Hải Phòng
ANSWER: B

Câu 2: Kết quả của phép tính: 15 x 4 + 10 là bao nhiêu?
A. 60
B. 70
C. 50
D. 80
ANSWER: B

Câu 3: Đâu là ngôn ngữ lập trình chạy trên trình duyệt web?
A. JavaScript
B. Python
C. Pascal
D. C++
ANSWER: A
`;
          const blob = new Blob([sampleAiken], { type: 'text/plain;charset=utf-8;' });
          saveBlobAsFile(blob, 'Mau_De_Thi_Aiken.txt');
        }
      );
      return;
    }
  }

  function tryDownloadStaticOrFallback(url, filename, fallbackFn) {
    // Thử tạo thẻ a tải trực tiếp
    const link = document.createElement('a');
    link.href = url;
    link.setAttribute('download', filename);
    document.body.appendChild(link);
    link.click();
    setTimeout(() => {
      document.body.removeChild(link);
    }, 150);
  }

  function saveBlobAsFile(blob, filename) {
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.setAttribute('download', filename);
    document.body.appendChild(link);
    link.click();
    setTimeout(() => {
      document.body.removeChild(link);
      URL.revokeObjectURL(link.href);
    }, 150);
  }

  // Public API
  return {
    parseVnText,
    parseExcelSheet,
    parseCsvText,
    parseJson,
    parseFile,
    downloadSampleFile,
    letterToIndex
  };
});
