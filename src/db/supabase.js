// Adapter kết nối Supabase cho Mini Quiz Classroom
const { createClient } = require('@supabase/supabase-js');

let rawUrl = (process.env.SUPABASE_URL || '').trim();
rawUrl = rawUrl.replace(/\/rest\/v1\/?$/i, '').replace(/\/+$/, '');
const supabaseUrl = rawUrl;
const supabaseKey = (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY || process.env.SUPABASE_ANON_KEY || '').trim();

let client = null;
if (supabaseUrl && supabaseKey) {
  try {
    client = createClient(supabaseUrl, supabaseKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      }
    });
  } catch (err) {
    console.error('Lỗi khởi tạo Supabase client:', err.message);
  }
}

function isConfigured() {
  return !!(client && supabaseUrl && supabaseKey);
}

// ── Users ──
async function findUserByUsername(username) {
  if (!isConfigured()) return null;
  const lower = String(username || '').toLowerCase();
  try {
    const { data, error } = await client
      .from('users')
      .select('*')
      .eq('username_lower', lower)
      .maybeSingle();

    if (error) {
      console.error('Supabase findUser error:', error.message);
      return null;
    }
    if (!data) return null;

    return {
      id: data.id,
      username: data.username,
      usernameLower: data.username_lower,
      displayName: data.display_name,
      passwordHash: data.password_hash,
      salt: data.salt,
      createdAt: Number(data.created_at),
      lastNameChangeAt: Number(data.last_name_change_at || 0),
      lastPasswordChangeAt: Number(data.last_password_change_at || 0),
    };
  } catch (err) {
    console.error('Supabase findUser exception:', err.message);
    return null;
  }
}

async function createUser(user) {
  if (!isConfigured()) return null;
  try {
    const record = {
      username: user.username,
      username_lower: user.username.toLowerCase(),
      display_name: user.displayName,
      password_hash: user.passwordHash,
      salt: user.salt,
      created_at: user.createdAt || Date.now(),
      last_name_change_at: user.lastNameChangeAt || 0,
      last_password_change_at: user.lastPasswordChangeAt || 0,
    };
    const { data, error } = await client
      .from('users')
      .insert(record)
      .select()
      .single();

    if (error) {
      console.error('Supabase createUser error:', error.message);
      return null;
    }
    return user;
  } catch (err) {
    console.error('Supabase createUser exception:', err.message);
    return null;
  }
}

async function updateUser(username, patch) {
  if (!isConfigured()) return null;
  const lower = String(username || '').toLowerCase();
  try {
    const updateData = {};
    if (patch.displayName !== undefined) updateData.display_name = patch.displayName;
    if (patch.passwordHash !== undefined) updateData.password_hash = patch.passwordHash;
    if (patch.salt !== undefined) updateData.salt = patch.salt;
    if (patch.lastNameChangeAt !== undefined) updateData.last_name_change_at = patch.lastNameChangeAt;
    if (patch.lastPasswordChangeAt !== undefined) updateData.last_password_change_at = patch.lastPasswordChangeAt;

    const { data, error } = await client
      .from('users')
      .update(updateData)
      .eq('username_lower', lower)
      .select()
      .maybeSingle();

    if (error) {
      console.error('Supabase updateUser error:', error.message);
      return null;
    }
    return data;
  } catch (err) {
    console.error('Supabase updateUser exception:', err.message);
    return null;
  }
}

// ── Exams ──
async function getPublicExams() {
  if (!isConfigured()) return null;
  try {
    const { data, error } = await client
      .from('exams')
      .select('*')
      .eq('is_public', true)
      .order('created_timestamp', { ascending: false });

    if (error) {
      console.error('Supabase getPublicExams error:', error.message);
      return null;
    }
    return (data || []).map(formatExamRow);
  } catch (err) {
    console.error('Supabase getPublicExams exception:', err.message);
    return null;
  }
}

async function getPrivateExams(ownerUsername) {
  if (!isConfigured()) return null;
  const owner = String(ownerUsername || '0').toLowerCase();
  try {
    const { data, error } = await client
      .from('exams')
      .select('*')
      .eq('owner_username', owner)
      .order('created_timestamp', { ascending: false });

    if (error) {
      console.error('Supabase getPrivateExams error:', error.message);
      return null;
    }
    return (data || []).map(formatExamRow);
  } catch (err) {
    console.error('Supabase getPrivateExams exception:', err.message);
    return null;
  }
}

async function saveExam(exam, ownerUsername, isPublic = false) {
  if (!isConfigured()) return null;
  try {
    const row = {
      id: exam.id,
      code: exam.code,
      title: exam.title,
      subject: exam.subject || '',
      author: exam.author || '',
      time_per_q: exam.timePerQ || 15,
      points_per_q: exam.pointsPerQ || 100,
      description: exam.desc || exam.description || '',
      questions: exam.questions || [],
      is_public: !!isPublic,
      owner_username: String(ownerUsername || '').toLowerCase(),
      parent_code: exam.parentCode || '',
      copies_issued: exam.copiesIssued || 0,
      shared_by: exam.sharedBy || '',
      shared_at: exam.sharedAt || '',
      created_at: exam.createdAt || '',
      updated_at: exam.updatedAt || '',
      created_timestamp: Date.now(),
    };

    const { error } = await client
      .from('exams')
      .upsert(row, { onConflict: 'id' });

    if (error) {
      console.error('Supabase saveExam error:', error.message);
      return null;
    }
    return exam;
  } catch (err) {
    console.error('Supabase saveExam exception:', err.message);
    return null;
  }
}

async function deleteExam(examId) {
  if (!isConfigured()) return null;
  try {
    const { error } = await client
      .from('exams')
      .delete()
      .eq('id', examId);

    if (error) {
      console.error('Supabase deleteExam error:', error.message);
      return false;
    }
    return true;
  } catch (err) {
    console.error('Supabase deleteExam exception:', err.message);
    return false;
  }
}

function formatExamRow(row) {
  return {
    id: row.id,
    code: row.code,
    title: row.title,
    subject: row.subject,
    author: row.author,
    timePerQ: row.time_per_q,
    pointsPerQ: row.points_per_q,
    desc: row.description,
    questions: row.questions,
    parentCode: row.parent_code,
    copiesIssued: row.copies_issued,
    sharedBy: row.shared_by,
    sharedAt: row.shared_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ── User History ──
async function getUserHistory(username) {
  if (!isConfigured()) return null;
  try {
    const { data, error } = await client
      .from('user_history')
      .select('*')
      .eq('username', String(username).toLowerCase())
      .order('created_at', { ascending: false });

    if (error) {
      console.error('Supabase getUserHistory error:', error.message);
      return null;
    }
    return (data || []).map(row => ({
      id: row.id,
      pin: row.pin,
      roomTitle: row.room_title,
      examTitle: row.exam_title,
      score: row.score,
      correctCount: row.correct_count,
      totalQuestions: row.total_questions,
      ratioPct: row.ratio_pct,
      formattedTime: row.formatted_time,
      createdAt: Number(row.created_at),
      answersDetail: row.answers_detail
    }));
  } catch (err) {
    console.error('Supabase getUserHistory exception:', err.message);
    return null;
  }
}

async function appendUserHistory(username, historyItem) {
  if (!isConfigured()) return null;
  try {
    const row = {
      id: historyItem.id || ('hist-' + Date.now() + '-' + Math.random().toString(36).substring(2, 6)),
      username: String(username).toLowerCase(),
      pin: historyItem.pin || '',
      room_title: historyItem.roomTitle || '',
      exam_title: historyItem.examTitle || historyItem.roomTitle || '',
      score: historyItem.score || 0,
      correct_count: historyItem.correctCount || 0,
      total_questions: historyItem.totalQuestions || 0,
      ratio_pct: historyItem.ratioPct !== undefined ? historyItem.ratioPct : (historyItem.accuracyPct || 0),
      formatted_time: historyItem.formattedTime || (historyItem.finishedAt ? new Date(historyItem.finishedAt).toLocaleString('vi-VN') : ''),
      created_at: historyItem.createdAt || historyItem.finishedAt || Date.now(),
      answers_detail: historyItem.answersDetail || historyItem.details || []
    };

    const { error } = await client
      .from('user_history')
      .insert(row);

    if (error) {
      console.error('Supabase appendUserHistory error:', error.message);
      return null;
    }
    return row;
  } catch (err) {
    console.error('Supabase appendUserHistory exception:', err.message);
    return null;
  }
}

// ── Hosted Rooms ──
async function getHostedRooms(hostUsername) {
  if (!isConfigured()) return null;
  try {
    const { data, error } = await client
      .from('hosted_rooms')
      .select('*')
      .eq('host_username', String(hostUsername).toLowerCase())
      .order('finished_at', { ascending: false })
      .limit(20);

    if (error) {
      console.error('Supabase getHostedRooms error:', error.message);
      return null;
    }
    return (data || []).map(row => ({
      id: row.id,
      pin: row.pin,
      roomTitle: row.room_title,
      createdAt: Number(row.created_at),
      finishedAt: Number(row.finished_at),
      formattedTime: row.formatted_time,
      stats: row.stats
    }));
  } catch (err) {
    console.error('Supabase getHostedRooms exception:', err.message);
    return null;
  }
}

async function saveHostedRoom(hostUsername, record) {
  if (!isConfigured()) return null;
  try {
    const row = {
      id: record.id || ('hosted-' + Date.now() + '-' + Math.random().toString(36).substring(2, 6)),
      pin: record.pin || '',
      host_username: String(hostUsername).toLowerCase(),
      room_title: record.roomTitle || record.title || 'Phòng thi trực tuyến',
      created_at: record.createdAt || Date.now(),
      finished_at: record.finishedAt || Date.now(),
      formatted_time: record.formattedTime || (record.finishedAt ? new Date(record.finishedAt).toLocaleString('vi-VN') : ''),
      stats: record.stats || {}
    };

    const { error } = await client
      .from('hosted_rooms')
      .upsert(row, { onConflict: 'id' });

    if (error) {
      console.error('Supabase saveHostedRoom error:', error.message);
      return null;
    }
    return record;
  } catch (err) {
    console.error('Supabase saveHostedRoom exception:', err.message);
    return null;
  }
}

module.exports = {
  isConfigured,
  findUserByUsername,
  createUser,
  updateUser,
  getPublicExams,
  getPrivateExams,
  saveExam,
  deleteExam,
  getUserHistory,
  appendUserHistory,
  getHostedRooms,
  saveHostedRoom,
};
