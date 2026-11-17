const crypto = require('node:crypto');

const DEFAULT_MODEL = 'gemini-3.1-flash-lite';
const RATE_LIMIT_PER_MIN = 6;
const RATE_LIMIT_PER_HOUR = 40;
const MEMORY_CACHE_MAX = 100;
const MEMORY_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

const userRateBuckets = new Map();
const weaknessMemoryCache = new Map();

let sdkPromise = null;
let cachedClient = null;
let cachedApiKey = '';
let customClientFactory = null;

function setGenAIClientFactoryForTest(factory) {
  customClientFactory = typeof factory === 'function' ? factory : null;
  cachedClient = null;
  cachedApiKey = '';
}

async function loadGenAISDK() {
  if (!sdkPromise) {
    sdkPromise = import('@google/genai');
  }
  return sdkPromise;
}

async function getGenAIClient() {
  if (customClientFactory) {
    return customClientFactory();
  }
  const apiKey = String(process.env.GEMINI_API_KEY || '').trim();
  if (!apiKey) {
    const err = new Error('Máy chủ chưa được cấu hình GEMINI_API_KEY cho tính năng AI.');
    err.status = 503;
    err.code = 'AI_KEY_MISSING';
    throw err;
  }
  const sdk = await loadGenAISDK();
  if (!cachedClient || cachedApiKey !== apiKey) {
    cachedClient = new sdk.GoogleGenAI({
      apiKey,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    });
    cachedApiKey = apiKey;
  }
  return { ai: cachedClient, sdk };
}

function checkAiRateLimit(userKey, ip = '') {
  const key = `${String(userKey || 'anon').toLowerCase()}::${String(ip || 'local')}`;
  const now = Date.now();
  const oneMinAgo = now - 60 * 1000;
  const oneHourAgo = now - 60 * 60 * 1000;

  const existing = (userRateBuckets.get(key) || []).filter(ts => ts > oneHourAgo);
  const lastMin = existing.filter(ts => ts > oneMinAgo);

  if (lastMin.length >= RATE_LIMIT_PER_MIN) {
    const oldestMin = lastMin[0] || now;
    const retryAfterSec = Math.max(1, Math.ceil((oldestMin + 60 * 1000 - now) / 1000));
    userRateBuckets.set(key, existing);
    return { allowed: false, retryAfterSec, message: `Bạn thao tác AI quá nhanh. Vui lòng thử lại sau ${retryAfterSec} giây.` };
  }

  if (existing.length >= RATE_LIMIT_PER_HOUR) {
    const oldestHour = existing[0] || now;
    const retryAfterSec = Math.max(1, Math.ceil((oldestHour + 60 * 60 * 1000 - now) / 1000));
    userRateBuckets.set(key, existing);
    return { allowed: false, retryAfterSec, message: 'Bạn đã đạt giới hạn lượt AI trong giờ này. Vui lòng thử lại sau.' };
  }

  existing.push(now);
  userRateBuckets.set(key, existing);
  return { allowed: true, retryAfterSec: 0 };
}

function stripChoicePrefix(text) {
  return String(text || '')
    .trim()
    .replace(/^[A-Da-d]\s*[\.\)\:\-]\s+/, '')
    .trim();
}

function normalizeGeneratedQuestions(rawQuestions, requestedType = 'mixed') {
  if (!Array.isArray(rawQuestions)) return [];
  const out = [];

  for (const item of rawQuestions) {
    if (!item || typeof item !== 'object') continue;
    const text = String(item.text || item.questionText || '').trim();
    if (!text) continue;

    const rawChoices = Array.isArray(item.choices) ? item.choices : [];
    const cleanedChoices = rawChoices
      .map(stripChoicePrefix)
      .filter(Boolean)
      .slice(0, 4);

    if (cleanedChoices.length < 4) continue;

    let correctIndices = Array.isArray(item.correctIndices)
      ? item.correctIndices.map(Number).filter(n => Number.isInteger(n) && n >= 0 && n < 4)
      : [];

    if (correctIndices.length === 0 && Number.isInteger(Number(item.correct))) {
      const c = Number(item.correct);
      if (c >= 0 && c < 4) correctIndices = [c];
    }

    correctIndices = Array.from(new Set(correctIndices)).sort((a, b) => a - b);
    if (correctIndices.length === 0) correctIndices = [0];

    if (requestedType === 'single' && correctIndices.length > 1) {
      correctIndices = [correctIndices[0]];
    }

    const isMultiple = requestedType === 'single'
      ? false
      : (correctIndices.length > 1);

    const normalized = {
      text,
      choices: cleanedChoices,
      correct: correctIndices[0],
    };

    if (isMultiple) {
      normalized.isMultiple = true;
      normalized.correctChoices = correctIndices;
    }

    out.push(normalized);
  }

  return out;
}

function mapGeminiError(err) {
  if (err && err.code === 'AI_KEY_MISSING') return err;
  const rawMsg = String(err?.message || err || '');
  const statusCode = Number(err?.status || err?.statusCode || 0);

  if (statusCode === 429 || rawMsg.includes('RESOURCE_EXHAUSTED') || rawMsg.includes('429')) {
    const out = new Error('Hệ thống AI đang quá tải hoặc hết hạn mức miễn phí tạm thời. Vui lòng thử lại sau ít phút.');
    out.status = 429;
    out.code = 'RESOURCE_EXHAUSTED';
    return out;
  }

  if (statusCode === 400 || statusCode === 403 || rawMsg.includes('API_KEY_INVALID') || rawMsg.includes('PERMISSION_DENIED')) {
    const out = new Error('API key Gemini không hợp lệ hoặc thiếu quyền truy cập. Vui lòng kiểm tra cấu hình Settings > Secrets.');
    out.status = 502;
    out.code = 'GEMINI_AUTH_ERROR';
    return out;
  }

  if (statusCode === 404 || rawMsg.includes('NOT_FOUND')) {
    const out = new Error('Model AI cấu hình không khả dụng trên hệ thống.');
    out.status = 502;
    out.code = 'GEMINI_MODEL_NOT_FOUND';
    return out;
  }

  const out = new Error('Không thể kết nối tới dịch vụ AI lúc này. Vui lòng thử lại sau.');
  out.status = 502;
  out.code = 'GEMINI_UNAVAILABLE';
  return out;
}

async function callGeminiWithRetry(fn) {
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const status = Number(err?.status || err?.statusCode || 0);
      const msg = String(err?.message || '');
      const isTransient = status === 503 || status === 500 || msg.includes('fetch failed') || msg.includes('ECONNRESET') || msg.includes('ETIMEDOUT');
      if (!isTransient || attempt === 1) {
        throw mapGeminiError(err);
      }
      await new Promise(resolve => setTimeout(resolve, 600));
    }
  }
  throw mapGeminiError(lastErr);
}

function buildGenerateQuestionsPrompt({ topic, gradeOrLevel, count, questionType }) {
  const safeTopic = String(topic || '').trim().slice(0, 300);
  const safeLevel = String(gradeOrLevel || '').trim().slice(0, 80);
  const safeCount = Math.max(1, Math.min(15, Number(count) || 5));
  const typeRule = questionType === 'multiple'
    ? 'Tất cả câu hỏi phải là dạng nhiều đáp án đúng (2 đến 3 đáp án đúng mỗi câu).'
    : (questionType === 'single'
      ? 'Tất cả câu hỏi phải là dạng chỉ có đúng 1 đáp án đúng.'
      : 'Kết hợp chủ yếu câu 1 đáp án đúng và 1-2 câu nhiều đáp án đúng (2-3 đáp án đúng) nếu phù hợp.');

  return [
    `Tạo đúng ${safeCount} câu hỏi trắc nghiệm về chủ đề: "${safeTopic}".`,
    safeLevel ? `Đối tượng / mức độ: "${safeLevel}".` : 'Mức độ: Phổ thông cân bằng.',
    typeRule,
    'Mỗi câu phải có đúng 4 lựa chọn ngắn gọn, rõ ràng, không trùng lặp và không ghi sẵn chữ cái A/B/C/D ở đầu lựa chọn.',
    'Ngôn ngữ câu hỏi là tiếng Việt (trừ khi chủ đề là môn ngoại ngữ).',
  ].join('\n');
}

async function generateQuestions({ topic, gradeOrLevel = '', count = 5, questionType = 'mixed' }) {
  const safeTopic = String(topic || '').trim().slice(0, 300);
  if (safeTopic.length < 2) {
    const err = new Error('Vui lòng nhập chủ đề tối thiểu 2 ký tự.');
    err.status = 400;
    throw err;
  }

  const safeCount = Math.max(1, Math.min(15, Number(count) || 5));
  const safeType = ['single', 'multiple', 'mixed'].includes(questionType) ? questionType : 'mixed';
  const promptText = buildGenerateQuestionsPrompt({
    topic: safeTopic,
    gradeOrLevel,
    count: safeCount,
    questionType: safeType,
  });

  const { ai, sdk } = await getGenAIClient();
  const Type = sdk.Type;
  const ThinkingLevel = sdk.ThinkingLevel;

  const config = {
    systemInstruction: 'Bạn là trợ lý soạn đề thi trắc nghiệm ngắn gọn, chính xác sư phạm. Chỉ trả về JSON hợp lệ theo schema.',
    responseMimeType: 'application/json',
    responseSchema: {
      type: Type.OBJECT,
      properties: {
        suggestedTitle: {
          type: Type.STRING,
          description: 'Tên đề thi ngắn gọn dưới 80 ký tự.',
        },
        suggestedSubject: {
          type: Type.STRING,
          description: 'Tên môn học hoặc lĩnh vực ngắn gọn dưới 40 ký tự.',
        },
        questions: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              text: { type: Type.STRING, description: 'Nội dung câu hỏi rõ ràng.' },
              choices: {
                type: Type.ARRAY,
                items: { type: Type.STRING },
                description: 'Đúng 4 phương án trả lời không kèm tiền tố A/B/C/D.',
              },
              correctIndices: {
                type: Type.ARRAY,
                items: { type: Type.INTEGER },
                description: 'Mảng chỉ số (0..3) của các đáp án đúng.',
              },
            },
            required: ['text', 'choices', 'correctIndices'],
          },
        },
      },
      required: ['suggestedTitle', 'suggestedSubject', 'questions'],
    },
  };

  if (ThinkingLevel && ThinkingLevel.MINIMAL) {
    config.thinkingConfig = { thinkingLevel: ThinkingLevel.MINIMAL };
  }

  const response = await callGeminiWithRetry(() => ai.models.generateContent({
    model: DEFAULT_MODEL,
    contents: promptText,
    config,
  }));

  let parsed = {};
  try {
    parsed = JSON.parse((response.text || '{}').trim());
  } catch (e) {
    const err = new Error('AI trả về định dạng chưa hợp lệ. Vui lòng thử lại.');
    err.status = 502;
    throw err;
  }

  const normalizedQuestions = normalizeGeneratedQuestions(parsed.questions, safeType).slice(0, safeCount);
  if (normalizedQuestions.length === 0) {
    const err = new Error('Không tạo được câu hỏi hợp lệ cho chủ đề này. Vui lòng mô tả rõ hơn và thử lại.');
    err.status = 502;
    throw err;
  }

  return {
    model: DEFAULT_MODEL,
    promptSummary: promptText,
    suggestedTitle: String(parsed.suggestedTitle || safeTopic).trim().slice(0, 120),
    suggestedSubject: String(parsed.suggestedSubject || 'Tổng hợp').trim().slice(0, 80),
    questions: normalizedQuestions,
  };
}

function buildWeaknessStatsInput({ roomTitle, stats }) {
  const safeStats = stats && typeof stats === 'object' ? stats : {};
  const rawQuestions = Array.isArray(safeStats.questionsStats) ? safeStats.questionsStats : [];

  const compactQuestions = rawQuestions
    .map((q, idx) => ({
      qIdx: Number(q.qIdx) || (idx + 1),
      text: String(q.text || `Câu ${idx + 1}`).trim().slice(0, 160),
      correctCount: Math.max(0, Number(q.correctCount) || 0),
      totalCount: Math.max(0, Number(q.totalCount) || 0),
      ratioPct: Math.max(0, Math.min(100, Number(q.ratioPct) || 0)),
    }))
    .sort((a, b) => (a.ratioPct - b.ratioPct) || (a.qIdx - b.qIdx))
    .slice(0, 25);

  return {
    roomTitle: String(roomTitle || 'Phòng thi').trim().slice(0, 120),
    totalCandidates: Math.max(0, Number(safeStats.totalCandidates) || 0),
    avgScore: Math.max(0, Number(safeStats.avgScore) || 0),
    maxScore: Math.max(0, Number(safeStats.maxScore) || 0),
    maxPossibleScore: Math.max(0, Number(safeStats.maxPossibleScore) || 0),
    totalQuestions: rawQuestions.length,
    questions: compactQuestions,
  };
}

function buildWeaknessCacheKey(sessionKey, compressedInput) {
  const payloadHash = crypto
    .createHash('sha256')
    .update(JSON.stringify(compressedInput))
    .digest('hex')
    .slice(0, 24);
  return `${String(sessionKey || 'stats').trim().slice(0, 80)}:${payloadHash}`;
}

function getWeaknessFromMemoryCache(cacheKey) {
  const entry = weaknessMemoryCache.get(cacheKey);
  if (!entry) return null;
  if (Date.now() - entry.createdAt > MEMORY_CACHE_TTL_MS) {
    weaknessMemoryCache.delete(cacheKey);
    return null;
  }
  return entry.analysis;
}

function setWeaknessInMemoryCache(cacheKey, analysis) {
  if (weaknessMemoryCache.size >= MEMORY_CACHE_MAX) {
    const oldestKey = weaknessMemoryCache.keys().next().value;
    if (oldestKey) weaknessMemoryCache.delete(oldestKey);
  }
  weaknessMemoryCache.set(cacheKey, { analysis, createdAt: Date.now() });
}

function normalizeWeaknessAnalysis(raw, compressedInput) {
  const summary = String(raw?.overallSummary || '').trim() || 'Đã tổng hợp kết quả bài làm của lớp.';
  const validWeak = Array.isArray(raw?.weakQuestions)
    ? raw.weakQuestions
        .filter(w => w && typeof w === 'object')
        .slice(0, 4)
        .map(w => {
          const qIdx = Number(w.qIdx) || 1;
          const matchQ = compressedInput.questions.find(item => item.qIdx === qIdx);
          return {
            qIdx,
            topicOrSkill: String(w.topicOrSkill || matchQ?.text || `Câu ${qIdx}`).trim().slice(0, 140),
            accuracyPct: matchQ ? matchQ.ratioPct : Math.max(0, Math.min(100, Number(w.accuracyPct) || 0)),
            likelyMistake: String(w.likelyMistake || 'Học sinh còn nhầm lẫn khái niệm ở câu hỏi này.').trim().slice(0, 220),
          };
        })
    : [];

  const actions = Array.isArray(raw?.teachingActions)
    ? raw.teachingActions.map(a => String(a || '').trim()).filter(Boolean).slice(0, 3)
    : [];

  return {
    overallSummary: summary.slice(0, 400),
    weakQuestions: validWeak,
    teachingActions: actions.length > 0 ? actions : ['Ôn tập nhanh các câu có tỷ lệ đúng dưới 60% trước khi chuyển bài mới.'],
  };
}

async function analyzeClassWeakness({ roomTitle, stats, sessionKey = '' }) {
  const compressed = buildWeaknessStatsInput({ roomTitle, stats });
  if (compressed.questions.length === 0) {
    const err = new Error('Chưa có dữ liệu câu hỏi thống kê để phân tích.');
    err.status = 400;
    throw err;
  }

  const cacheKey = buildWeaknessCacheKey(sessionKey || compressed.roomTitle, compressed);
  const memCached = getWeaknessFromMemoryCache(cacheKey);
  if (memCached) {
    return {
      model: DEFAULT_MODEL,
      cacheKey,
      cached: true,
      compressedInput: compressed,
      analysis: memCached,
    };
  }

  const promptText = [
    `Phân tích điểm yếu lớp học từ số liệu tổng hợp sau (trả lời tiếng Việt, cực kỳ ngắn gọn và thực tế cho giáo viên):`,
    JSON.stringify(compressed),
  ].join('\n');

  const { ai, sdk } = await getGenAIClient();
  const Type = sdk.Type;
  const ThinkingLevel = sdk.ThinkingLevel;

  const config = {
    systemInstruction: 'Bạn là trợ lý sư phạm tóm tắt kết quả kiểm tra cho giáo viên. Ngắn gọn, đi thẳng vào câu có tỷ lệ đúng thấp nhất và gợi ý ôn tập cụ thể. Chỉ trả JSON theo schema.',
    responseMimeType: 'application/json',
    responseSchema: {
      type: Type.OBJECT,
      properties: {
        overallSummary: {
          type: Type.STRING,
          description: 'Nhận xét tổng quan 1-2 câu về mức độ nắm bài của cả lớp.',
        },
        weakQuestions: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              qIdx: { type: Type.INTEGER, description: 'Số thứ tự câu hỏi (1-based).' },
              topicOrSkill: { type: Type.STRING, description: 'Nội dung/kiến thức cốt lõi của câu hỏi.' },
              accuracyPct: { type: Type.NUMBER, description: 'Tỷ lệ đúng (%).' },
              likelyMistake: { type: Type.STRING, description: 'Nguyên nhân nhầm lẫn phổ biến hoặc điểm cần lưu ý (1 câu).' },
            },
            required: ['qIdx', 'topicOrSkill', 'accuracyPct', 'likelyMistake'],
          },
          description: '2 đến 4 câu hỏi có tỷ lệ đúng thấp nhất cần chú ý.',
        },
        teachingActions: {
          type: Type.ARRAY,
          items: { type: Type.STRING },
          description: '2 đến 3 gợi ý hành động ôn tập ngắn gọn cho buổi học tiếp theo.',
        },
      },
      required: ['overallSummary', 'weakQuestions', 'teachingActions'],
    },
  };

  if (ThinkingLevel && ThinkingLevel.MINIMAL) {
    config.thinkingConfig = { thinkingLevel: ThinkingLevel.MINIMAL };
  }

  const response = await callGeminiWithRetry(() => ai.models.generateContent({
    model: DEFAULT_MODEL,
    contents: promptText,
    config,
  }));

  let parsed = {};
  try {
    parsed = JSON.parse((response.text || '{}').trim());
  } catch (e) {
    const err = new Error('AI trả về định dạng phân tích chưa hợp lệ. Vui lòng thử lại.');
    err.status = 502;
    throw err;
  }

  const analysis = normalizeWeaknessAnalysis(parsed, compressed);
  setWeaknessInMemoryCache(cacheKey, analysis);

  return {
    model: DEFAULT_MODEL,
    cacheKey,
    cached: false,
    compressedInput: compressed,
    promptSummary: promptText,
    analysis,
  };
}

module.exports = {
  DEFAULT_MODEL,
  checkAiRateLimit,
  normalizeGeneratedQuestions,
  buildWeaknessStatsInput,
  buildWeaknessCacheKey,
  normalizeWeaknessAnalysis,
  getWeaknessFromMemoryCache,
  setWeaknessInMemoryCache,
  generateQuestions,
  analyzeClassWeakness,
  setGenAIClientFactoryForTest,
};
