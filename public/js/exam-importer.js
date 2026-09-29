/**
 * exam-importer.js — Bộ phân tích và trích xuất câu hỏi trắc nghiệm thông minh
 * Hỗ trợ định dạng: Word (.docx), Excel (.xlsx, .xls), CSV, Text/Aiken, JSON
 * Tương thích tốt với các định dạng đề thi phổ biến tại Việt Nam.
 */
(function(root) {
  'use strict';

  const ExamImporter = {
    /**
     * Phân tích văn bản tiếng Việt sang danh sách câu hỏi
     * @param {string} rawText
     * @returns {{ title: string, subject: string, questions: Array<{text: string, choices: string[], correct: number}> }}
     */
    parseVnText: function(rawText) {
      if (!rawText || !rawText.trim()) {
        return { title: '', subject: '', questions: [], error: 'Nội dung văn bản trống!' };
      }

      // Chuẩn hóa ký tự xuống dòng
      const normalized = rawText.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
      const lines = normalized.split('\n');

      let examTitle = '';
      let examSubject = '';

      // Tìm tên đề hoặc môn học ở phần đầu (nếu có)
      for (let i = 0; i < Math.min(lines.length, 10); i++) {
        const l = lines[i].trim();
        if (!l) continue;
        const lower = l.toLowerCase();
        if (lower.startsWith('đề thi:') || lower.startsWith('tên đề:') || lower.startsWith('đề kiểm tra:')) {
          examTitle = l.replace(/^[^:]+:\s*/, '').trim();
        } else if (lower.startsWith('môn:') || lower.startsWith('môn học:') || lower.startsWith('khối:')) {
          examSubject = l.replace(/^[^:]+:\s*/, '').trim();
        } else if (!examTitle && (lower.includes('đề thi') || lower.includes('kiểm tra') || lower.includes('trắc nghiệm'))) {
          examTitle = l.replace(/^[#*=-]+\s*/, '').replace(/\s*[#*=-]+$/, '').trim();
        }
      }

      // 1. Kiểm tra xem có bảng đáp án ở cuối văn bản không (VD: BẢNG ĐÁP ÁN: 1.A 2.B 3.C hoặc 1-A 2-B)
      const answerKeyMap = {};
      const answerKeyRegex = /(?:bảng\s+đáp\s+án|đáp\s+án\s+các\s+câu|key\s*đáp\s*án)[\s\S]*$/i;
      const keyMatch = normalized.match(answerKeyRegex);
      if (keyMatch) {
        const keySection = keyMatch[0];
        // Tìm các cặp số và chữ cái đáp án: 1.A, 1-A, 1:A, 1A
        const pairRegex = /(\d+)\s*[:.\-–]?\s*([A-Ha-h])/g;
        let pMatch;
        while ((pMatch = pairRegex.exec(keySection)) !== null) {
          const qNum = parseInt(pMatch[1], 10);
          const ansLetter = pMatch[2].toUpperCase();
          const letterIdx = ansLetter.charCodeAt(0) - 65; // A=0, B=1, C=2, D=3
          answerKeyMap[qNum] = letterIdx;
        }
      }

      // 2. Tách các câu hỏi
      // Nhận diện dòng bắt đầu câu hỏi: "Câu 1:", "Câu 1.", "Câu 1 -", "Bài 1:", "Question 1:", "Q1:"
      const qStartRegex = /^\s*(?:câu|bài|question|q)\s*(\d+)[\s.:\-–)]\s*(.*)$/i;
      const parsedQuestions = [];

      let currentQ = null;
      let questionCounter = 0;

      function finalizeCurrentQuestion() {
        if (!currentQ) return;
        // Kiểm tra xem câu hỏi có đủ nội dung và lựa chọn không
        if (currentQ.choices.length >= 2 && currentQ.text.trim()) {
          // Nếu chưa có đáp án đúng, kiểm tra bảng đáp án ở cuối đề
          if (currentQ.correct === -1 && currentQ.qNumber && typeof answerKeyMap[currentQ.qNumber] === 'number') {
            currentQ.correct = answerKeyMap[currentQ.qNumber];
          }
          // Nếu vẫn chưa có đáp án đúng, mặc định là 0 (A)
          if (currentQ.correct === -1 || currentQ.correct >= currentQ.choices.length) {
            currentQ.correct = 0;
          }
          parsedQuestions.push({
            text: currentQ.text.trim(),
            choices: currentQ.choices.map(c => c.trim()),
            correct: currentQ.correct
          });
        }
        currentQ = null;
      }

      for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
        let line = lines[lineIndex].trim();
        if (!line) continue;

        // Bỏ qua phần bảng đáp án ở cuối văn bản khi đã tách câu hỏi
        if (answerKeyRegex.test(line) && parsedQuestions.length > 0) {
          break;
        }

        // Kiểm tra xem dòng này có phải bắt đầu câu hỏi mới không
        const qMatch = line.match(qStartRegex);
        if (qMatch) {
          finalizeCurrentQuestion();
          questionCounter++;
          const qNum = parseInt(qMatch[1], 10) || questionCounter;
          const qText = qMatch[2] || '';
          currentQ = {
            qNumber: qNum,
            text: qText,
            choices: [],
            correct: -1
          };
          continue;
        }

        // Nếu chưa gặp "Câu 1:", nhưng gặp định dạng Aiken (câu hỏi là dòng bình thường, tiếp theo là A. B. C. D. ANSWER:)
        if (!currentQ) {
          // Bỏ qua các dòng tiêu đề chung
          const lower = line.toLowerCase();
          if (lower.startsWith('đề thi') || lower.startsWith('môn') || lower.startsWith('thời gian') || lower.startsWith('họ và tên') || lower.startsWith('trường')) {
            continue;
          }
          // Bắt đầu một câu hỏi mới không đánh số
          questionCounter++;
          currentQ = {
            qNumber: questionCounter,
            text: line,
            choices: [],
            correct: -1
          };
          continue;
        }

        // Kiểm tra xem dòng có phải là đáp án riêng: "Đáp án: A", "ANSWER: B", "Key: C", "Đ/a: D"
        const ansMatch = line.match(/^\s*(?:đáp\s*án(?:\s*đúng)?|answer|key|đ\/a|da)\s*[:.\-–]?\s*([A-Ha-h])\b/i);
        if (ansMatch) {
          const letter = ansMatch[1].toUpperCase();
          currentQ.correct = letter.charCodeAt(0) - 65;
          continue;
        }

        // Kiểm tra lựa chọn trắc nghiệm nằm trên một dòng riêng:
        // A. Nội dung, B) Nội dung, *A. Nội dung (dấu * biểu thị đáp án đúng)
        const singleChoiceRegex = /^\s*([*]?)[\s]*([A-Ha-h])[\s]*[.:\-–)]\s*(.+)$/;
        const scMatch = line.match(singleChoiceRegex);

        // Hoặc kiểm tra các lựa chọn nằm cùng 1 dòng (inline choices):
        // "A. 4    B. 8    C. 16    D. 32"
        const inlineChoiceRegex = /(?:^|\s+)([*]?)([A-Ha-h])[\s]*[.:\-–)]\s*([^\n\r]+?)(?=(?:\s+[*]?([A-Ha-h])[\s]*[.:\-–)])|$)/g;

        // Nếu dòng chứa ít nhất 2 lựa chọn (ví dụ A. ... B. ...)
        const inlineMatches = [];
        let m;
        while ((m = inlineChoiceRegex.exec(line)) !== null) {
          if (m[3] && m[3].trim()) {
            inlineMatches.push({
              isMarked: m[1] === '*',
              letter: m[2].toUpperCase(),
              val: m[3].trim()
            });
          }
        }

        if (inlineMatches.length >= 2) {
          inlineMatches.forEach(item => {
            const cIdx = currentQ.choices.length;
            currentQ.choices.push(item.val);
            if (item.isMarked) {
              currentQ.correct = cIdx;
            }
          });
          continue;
        }

        if (scMatch) {
          const isMarked = scMatch[1] === '*';
          const choiceVal = scMatch[3].trim();
          const cIdx = currentQ.choices.length;
          currentQ.choices.push(choiceVal);
          if (isMarked) {
            currentQ.correct = cIdx;
          }
          continue;
        }

        // Nếu dòng hiện tại chưa có choices và không phải choice, nối tiếp vào câu hỏi
        if (currentQ.choices.length === 0) {
          currentQ.text += (currentQ.text ? '\n' : '') + line;
        } else {
          // Nếu đã có choices, nối vào choice cuối cùng (trường hợp lựa chọn xuống dòng)
          const lastIdx = currentQ.choices.length - 1;
          currentQ.choices[lastIdx] += ' ' + line;
        }
      }

      finalizeCurrentQuestion();

      return {
        title: examTitle || '',
        subject: examSubject || '',
        questions: parsedQuestions
      };
    },

    /**
     * Phân tích tệp tải lên (Word, Excel, CSV, TXT, JSON)
     * @param {File} file
     * @returns {Promise<{ title: string, subject: string, questions: Array<{text: string, choices: string[], correct: number}> }>}
     */
    parseFile: async function(file) {
      if (!file) throw new Error('Không có tệp nào được chọn!');

      const ext = (file.name.split('.').pop() || '').toLowerCase();
      const defaultTitle = file.name.replace(/\.[^/.]+$/, '').replace(/[-_]/g, ' ');

      // ── 1. ĐỊNH DẠNG JSON ──
      if (ext === 'json') {
        const text = await file.text();
        try {
          const data = JSON.parse(text);
          let questions = [];
          let title = defaultTitle;
          let subject = 'Tổng hợp';

          if (Array.isArray(data)) {
            questions = data;
          } else if (data && Array.isArray(data.questions)) {
            questions = data.questions;
            if (data.title) title = data.title;
            if (data.subject) subject = data.subject;
          }

          // Chuẩn hóa câu hỏi
          const cleanQuestions = questions.map((q, idx) => {
            let correct = typeof q.correct === 'number' ? q.correct : 0;
            if (typeof q.correct === 'string') {
              const upper = q.correct.trim().toUpperCase();
              if (upper.length === 1 && upper >= 'A' && upper <= 'Z') {
                correct = upper.charCodeAt(0) - 65;
              } else {
                correct = parseInt(q.correct, 10) || 0;
              }
            }
            return {
              text: q.text || q.question || ('Câu ' + (idx + 1)),
              choices: Array.isArray(q.choices) ? q.choices : (q.options || []),
              correct: correct
            };
          }).filter(q => q.choices.length >= 2);

          return { title, subject, questions: cleanQuestions };
        } catch (e) {
          throw new Error('Tệp JSON không hợp lệ: ' + e.message);
        }
      }

      // ── 2. ĐỊNH DẠNG TEXT (.txt) / CSV ──
      if (ext === 'txt' || ext === 'csv') {
        const text = await file.text();
        if (ext === 'csv') {
          return ExamImporter.parseCsv(text, defaultTitle);
        }
        const result = ExamImporter.parseVnText(text);
        if (!result.title) result.title = defaultTitle;
        return result;
      }

      // ── 3. ĐỊNH DẠNG WORD (.docx) ──
      if (ext === 'docx') {
        if (typeof mammoth === 'undefined') {
          // Thử nạp động nếu chưa có
          await ExamImporter._loadScript('https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.6.0/mammoth.browser.min.js');
        }
        if (typeof mammoth === 'undefined') {
          throw new Error('Thư viện đọc Word (Mammoth) chưa sẵn sàng!');
        }

        const arrayBuffer = await file.arrayBuffer();
        const mammothResult = await mammoth.extractRawText({ arrayBuffer: arrayBuffer });
        const rawText = mammothResult.value;
        const result = ExamImporter.parseVnText(rawText);
        if (!result.title) result.title = defaultTitle;
        return result;
      }

      // ── 4. ĐỊNH DẠNG EXCEL (.xlsx, .xls) ──
      if (ext === 'xlsx' || ext === 'xls') {
        if (typeof XLSX === 'undefined') {
          await ExamImporter._loadScript('https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js');
        }
        if (typeof XLSX === 'undefined') {
          throw new Error('Thư viện đọc Excel (SheetJS) chưa sẵn sàng!');
        }

        const arrayBuffer = await file.arrayBuffer();
        const workbook = XLSX.read(arrayBuffer, { type: 'array' });
        const firstSheetName = workbook.SheetNames[0];
        if (!firstSheetName) throw new Error('Tập tin Excel không có dữ liệu bảng tính!');
        
        const worksheet = workbook.Sheets[firstSheetName];
        const rows = XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: '' });
        return ExamImporter.parseExcelRows(rows, defaultTitle);
      }

      throw new Error('Định dạng tệp .' + ext + ' chưa được hỗ trợ. Vui lòng chọn .docx, .xlsx, .xls, .csv, .txt hoặc .json!');
    },

    /**
     * Phân tích các hàng Excel sang câu hỏi trắc nghiệm
     * Cấu trúc: [Câu hỏi, Đáp án A, Đáp án B, Đáp án C, Đáp án D, Đáp án đúng]
     */
    parseExcelRows: function(rows, defaultTitle) {
      if (!rows || rows.length < 2) {
        throw new Error('Tập tin Excel không có đủ dữ liệu hàng!');
      }

      // Bỏ qua dòng tiêu đề nếu dòng đầu chứa chữ "Câu hỏi" hoặc "Question"
      let startIndex = 0;
      const firstRowStr = (rows[0] || []).join(' ').toLowerCase();
      if (firstRowStr.includes('câu hỏi') || firstRowStr.includes('question') || firstRowStr.includes('đáp án')) {
        startIndex = 1;
      }

      const questions = [];
      for (let r = startIndex; r < rows.length; r++) {
        const row = rows[r];
        if (!row || row.length === 0) continue;

        const qText = String(row[0] || '').trim();
        if (!qText) continue;

        const choices = [];
        // Lấy các đáp án từ cột 1 trở đi
        for (let c = 1; c < Math.min(row.length, 6); c++) {
          const val = String(row[c] || '').trim();
          if (val) choices.push(val);
        }

        if (choices.length < 2) continue;

        // Đáp án đúng nằm ở cột cuối cùng (thường là cột 5 hoặc 6)
        let correctIdx = 0;
        const correctRaw = String(row[5] || row[choices.length] || row[row.length - 1] || '').trim().toUpperCase();
        if (correctRaw.length === 1 && correctRaw >= 'A' && correctRaw <= 'H') {
          correctIdx = correctRaw.charCodeAt(0) - 65;
        } else if (/^\d+$/.test(correctRaw)) {
          const parsed = parseInt(correctRaw, 10);
          correctIdx = (parsed >= 1 && parsed <= choices.length) ? parsed - 1 : 0;
        }

        if (correctIdx < 0 || correctIdx >= choices.length) {
          correctIdx = 0;
        }

        questions.push({
          text: qText,
          choices: choices,
          correct: correctIdx
        });
      }

      return {
        title: defaultTitle || 'Đề thi từ Excel',
        subject: 'Tổng hợp',
        questions: questions
      };
    },

    /**
     * Phân tích tệp CSV
     */
    parseCsv: function(csvText, defaultTitle) {
      const lines = csvText.split(/\r?\n/).filter(l => l.trim());
      const rows = lines.map(line => {
        // Tách dấu phẩy hoặc tab hoặc chấm phẩy
        const separator = line.includes('\t') ? '\t' : (line.includes(';') ? ';' : ',');
        return line.split(separator).map(col => col.replace(/^"(.*)"$/, '$1').trim());
      });
      return ExamImporter.parseExcelRows(rows, defaultTitle);
    },

    /**
     * Tải script CDN động khi cần
     */
    _loadScript: function(src) {
      return new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = src;
        script.onload = () => resolve();
        script.onerror = () => reject(new Error('Không thể tải tài nguyên từ ' + src));
        document.head.appendChild(script);
      });
    }
  };

  root.ExamImporter = ExamImporter;
})(typeof window !== 'undefined' ? window : this);
